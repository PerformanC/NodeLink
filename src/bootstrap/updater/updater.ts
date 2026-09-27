import { execFile, spawn } from 'node:child_process'
import { access, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import type NodelinkServer from '../../index.ts'
import type {
  UpdateChannel,
  UpdateCheckResult,
  UpdateDownloadResult,
  UpdateManifest,
  UpdateProvider,
  UpdateState
} from '../../typings/updater.types.ts'
import { logger } from '../../utils.ts'
import {
  DEFAULT_UPDATE_CHANNEL,
  MANIFEST_FILE_NAME,
  UPDATER_PATHS
} from './constants.ts'
import { drainAndShutdown } from './drain.ts'
import { ArchiveExtractor } from './extractor.ts'
import { parseUpdateManifest } from './manifest.ts'
import { DockerProvider } from './providers/dockerProvider.ts'
import { GitProvider } from './providers/gitProvider.ts'
import { HttpProvider } from './providers/httpProvider.ts'
import { UpdateStateStore } from './state.ts'
import { FileSwapper } from './swapper.ts'

const execFileAsync = promisify(execFile)

function areCommitsEqual(a?: string, b?: string): boolean {
  if (!a || !b || a === 'unknown' || b === 'unknown') return false
  const cleanA = a.trim().toLowerCase()
  const cleanB = b.trim().toLowerCase()
  return (
    cleanA === cleanB ||
    cleanA.startsWith(cleanB) ||
    cleanB.startsWith(cleanA)
  )
}

export class UpdateManager {
  public readonly root: string
  private readonly stateStore: UpdateStateStore
  private readonly providers: readonly UpdateProvider[]
  private readonly extractor = new ArchiveExtractor()

  public constructor(root: string) {
    this.root = root
    this.stateStore = new UpdateStateStore(root)
    this.providers = Object.freeze([
      new DockerProvider(),
      new GitProvider(root),
      new HttpProvider()
    ])
  }

  public async selectProvider(): Promise<UpdateProvider> {
    for (const provider of this.providers) {
      if (await provider.isAvailable()) {
        return provider
      }
    }

    throw new Error('No update provider available for this environment')
  }

  public async isLocked(): Promise<boolean> {
    const lockPath = path.join(this.root, UPDATER_PATHS.lock)
    try {
      const content = await readFile(lockPath, 'utf8')
      const lockData = JSON.parse(content) as { pid?: number; timestamp?: number }
      const age = Date.now() - (lockData.timestamp ?? 0)

      let isAlive = false
      if (lockData.pid) {
        try {
          process.kill(lockData.pid, 0)
          isAlive = true
        } catch {
          isAlive = false
        }
      }

      if (isAlive && age < 10 * 60 * 1000) {
        return true
      }

      await unlink(lockPath).catch((err) => {
        logger(
          'debug',
          'UpdateManager',
          `Failed to remove stale lockfile: ${err instanceof Error ? err.message : String(err)}`
        )
      })
      return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger(
          'debug',
          'UpdateManager',
          `Lockfile read error: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      return false
    }
  }

  public async acquireLock(): Promise<boolean> {
    if (await this.isLocked()) {
      return false
    }
    const lockPath = path.join(this.root, UPDATER_PATHS.lock)
    try {
      await writeFile(
        lockPath,
        JSON.stringify({ pid: process.pid, timestamp: Date.now() }),
        'utf8'
      )
      return true
    } catch (error) {
      logger(
        'warn',
        'UpdateManager',
        `Failed to write lockfile: ${error instanceof Error ? error.message : String(error)}`
      )
      return false
    }
  }

  public async releaseLock(): Promise<void> {
    const lockPath = path.join(this.root, UPDATER_PATHS.lock)
    await unlink(lockPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger(
          'debug',
          'UpdateManager',
          `Failed to delete lockfile: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    })
  }

  public async getCurrentState(
    fallbackVersion: string,
    fallbackCommit = 'unknown',
    channel: UpdateChannel = DEFAULT_UPDATE_CHANNEL
  ): Promise<UpdateState> {
    const savedState = await this.stateStore.read()
    const activeCommit =
      fallbackCommit !== 'unknown'
        ? fallbackCommit
        : (savedState?.commit ?? 'unknown')
    const activeVersion =
      fallbackVersion !== 'unknown'
        ? fallbackVersion
        : (savedState?.version ?? 'unknown')

    if (savedState) {
      return {
        ...savedState,
        commit: activeCommit,
        version: activeVersion
      }
    }

    return {
      version: fallbackVersion,
      commit: fallbackCommit,
      channel,
      updatedAt: new Date().toISOString()
    }
  }

  private async getLocalManifestCommit(): Promise<string | null> {
    const manifestPath = path.join(this.root, MANIFEST_FILE_NAME)
    try {
      const content = await readFile(manifestPath, 'utf8')
      const parsed = parseUpdateManifest(JSON.parse(content))
      return parsed?.commit ?? null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger(
          'debug',
          'UpdateManager',
          `Could not read local manifest: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      return null
    }
  }

  public async check(
    fallbackVersion: string,
    fallbackCommit = 'unknown',
    channel: UpdateChannel = DEFAULT_UPDATE_CHANNEL
  ): Promise<UpdateCheckResult> {
    const current = await this.getCurrentState(
      fallbackVersion,
      fallbackCommit,
      channel
    )

    if (await this.stateStore.checkCrashLoop()) {
      return {
        available: false,
        current,
        provider: 'http',
        reason: 'Auto-update suspended due to rapid boot crash loop detection'
      }
    }

    if (await this.isLocked()) {
      return {
        available: false,
        current,
        provider: 'http',
        reason: 'Update operation currently locked by another process'
      }
    }

    const provider = await this.selectProvider()

    if (provider.type === 'docker') {
      return {
        available: false,
        current,
        provider: provider.type,
        reason:
          'Running inside Docker container. Updates must be applied by updating the container image.'
      }
    }

    const latest = await provider.getLatest(channel)
    if (!latest) {
      return {
        available: false,
        current,
        provider: provider.type,
        reason: 'Unable to fetch latest release metadata'
      }
    }

    const quarantined = current.quarantinedCommits?.[latest.commit]
    if (quarantined) {
      logger(
        'warn',
        'UpdateManager',
        `Ignoring commit ${latest.commit.slice(0, 7)}: quarantined on ${quarantined.failedAt} (${quarantined.reason})`
      )
      return {
        available: false,
        current,
        latest,
        provider: provider.type,
        reason: `Commit ${latest.commit.slice(0, 7)} is quarantined due to startup failure`
      }
    }

    if (provider.type === 'git') {
      const isClean = await (provider as GitProvider).isWorkingTreeClean()
      if (!isClean) {
        logger(
          'warn',
          'UpdateManager',
          'Local modifications detected in tracked files. Skipping automatic update.'
        )
        return {
          available: false,
          current,
          latest,
          provider: provider.type,
          reason: 'Tracked files have uncommitted local modifications'
        }
      }
    }

    const isSameCommit = areCommitsEqual(current.commit, latest.commit)
    if (isSameCommit) {
      return {
        available: false,
        current: { ...current, commit: latest.commit, version: latest.version },
        latest,
        provider: provider.type,
        reason: 'Local installation is already running the latest commit'
      }
    }

    if (provider.type === 'git') {
      const gitProvider = provider as GitProvider
      const isAhead = await gitProvider.isAhead(current.commit, latest.commit)
      if (isAhead) {
        return {
          available: false,
          current,
          latest,
          provider: provider.type,
          reason: 'Local installation is ahead of upstream commit'
        }
      }
    }

    const localManifestCommit = await this.getLocalManifestCommit()
    if (
      localManifestCommit &&
      areCommitsEqual(localManifestCommit, latest.commit)
    ) {
      if (!areCommitsEqual(current.commit, latest.commit)) {
        await this.stateStore.write({
          ...current,
          commit: latest.commit,
          version: latest.version
        })
      }
      return {
        available: false,
        current: { ...current, commit: latest.commit, version: latest.version },
        latest,
        provider: provider.type,
        reason: 'Local installation is already running the latest commit'
      }
    }

    let available =
      !isSameCommit &&
      current.commit !== 'unknown' &&
      latest.commit.length > 0

    if (provider.type === 'git') {
      const gitProvider = provider as GitProvider
      const isBehind = await gitProvider.isBehind(current.commit, latest.commit)
      available = isBehind
    }

    return {
      available,
      current,
      latest,
      provider: provider.type
    }
  }

  public async download(
    manifest: UpdateManifest,
    destination: string
  ): Promise<UpdateDownloadResult> {
    const provider = await this.selectProvider()
    return provider.download(manifest, destination)
  }

  public async applyUpdate(
    manifest: UpdateManifest,
    server?: NodelinkServer,
    drainTimeout = 2000
  ): Promise<boolean> {
    const acquired = await this.acquireLock()
    if (!acquired) {
      logger(
        'warn',
        'UpdateManager',
        'Update locked by another running task, aborting'
      )
      return false
    }

    try {
      const provider = await this.selectProvider()

      if (provider.type === 'git') {
        logger(
          'info',
          'UpdateManager',
          `Syncing repository to commit ${manifest.commit.slice(0, 7)}...`
        )
        await execFileAsync('git', ['reset', '--hard', manifest.commit], {
          cwd: this.root
        })
      } else {
        const downloadDir = path.join(this.root, UPDATER_PATHS.download)
        await mkdir(downloadDir, { recursive: true })

        const archivePath = path.join(downloadDir, `${manifest.commit}.tar.gz`)
        logger(
          'info',
          'UpdateManager',
          `Downloading update package for ${manifest.commit.slice(0, 7)}...`
        )
        await this.download(manifest, archivePath)

        const stagingDir = path.join(
          this.root,
          UPDATER_PATHS.staging,
          manifest.commit
        )
        logger('info', 'UpdateManager', 'Unpacking update archive to staging...')
        await this.extractor.extract(archivePath, stagingDir)

        const backupDir = path.join(this.root, UPDATER_PATHS.backup)
        const swapper = new FileSwapper(this.root)
        await swapper.createBackup(backupDir)
        await swapper.applyStaging(stagingDir)

        await rm(stagingDir, { recursive: true, force: true }).catch((error) => {
          logger(
            'debug',
            'UpdateManager',
            `Failed to remove staging directory: ${error instanceof Error ? error.message : String(error)}`
          )
        })
        await rm(downloadDir, { recursive: true, force: true }).catch((error) => {
          logger(
            'debug',
            'UpdateManager',
            `Failed to remove download directory: ${error instanceof Error ? error.message : String(error)}`
          )
        })
      }

      const previousState = await this.stateStore.read()
      await this.stateStore.write({
        version: manifest.version,
        commit: manifest.commit,
        channel: manifest.channel,
        updatedAt: new Date().toISOString(),
        previousVersion: previousState?.version,
        previousCommit: previousState?.commit,
        quarantinedCommits: previousState?.quarantinedCommits ?? {},
        consecutiveCrashCount: 0,
        justUpdated: true,
        lastAcknowledgedCommit: manifest.commit
      })

      if (server) {
        await drainAndShutdown(
          server,
          'Server restarting for update',
          drainTimeout
        )
      }

      await this.releaseLock()

      logger(
        'info',
        'UpdateManager',
        'Update applied successfully. Restarting process to apply changes...'
      )

      const child = spawn(process.argv[0] as string, process.argv.slice(1), {
        stdio: 'inherit',
        env: process.env
      } as import('node:child_process').SpawnOptions)

      child.on('exit', (code: number | null) => {
        process.exit(code ?? 0)
      })

      // Halt execution of the parent process forever while the child runs
      await new Promise(() => {})

      return true
    } catch (error) {
      await this.releaseLock()
      logger(
        'error',
        'UpdateManager',
        `Failed to execute update pipeline: ${error instanceof Error ? error.message : String(error)}`
      )
      return false
    }
  }

  public async saveState(state: UpdateState): Promise<void> {
    await this.stateStore.write(state)
  }

  public async quarantine(commit: string, reason: string): Promise<void> {
    await this.stateStore.quarantineCommit(commit, reason)
  }
}
