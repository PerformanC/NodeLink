import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type {
  UpdateChannel,
  UpdateDownloadResult,
  UpdateManifest,
  UpdateProvider
} from '../../../typings/updater.types.ts'
import { logger } from '../../../utils.ts'

const execFileAsync = promisify(execFile)

export class GitProvider implements UpdateProvider {
  public readonly type = 'git' as const
  private readonly root: string

  public constructor(root: string) {
    this.root = root
  }

  private async git(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd: this.root,
      encoding: 'utf8'
    })
    return stdout.trim()
  }

  public async isAvailable(): Promise<boolean> {
    try {
      await access(path.join(this.root, '.git'))
      await this.git('--version')
      return true
    } catch (error) {
      logger(
        'debug',
        'GitProvider',
        `Git provider unavailable: ${error instanceof Error ? error.message : String(error)}`
      )
      return false
    }
  }

  public async isWorkingTreeClean(): Promise<boolean> {
    try {
      const status = await this.git('status', '--porcelain', '-uno')
      return status.length === 0
    } catch (error) {
      logger(
        'warn',
        'GitProvider',
        `Failed to check working tree cleanliness: ${error instanceof Error ? error.message : String(error)}`
      )
      return true
    }
  }

  private async resolveRemoteAndBranch(
    channel: UpdateChannel
  ): Promise<{ remote: string; branch: string }> {
    try {
      const upstream = await this.git(
        'rev-parse',
        '--abbrev-ref',
        '--symbolic-full-name',
        '@{u}'
      )
      const separator = upstream.indexOf('/')
      if (separator !== -1) {
        return {
          remote: upstream.slice(0, separator),
          branch: upstream.slice(separator + 1)
        }
      }
    } catch (error) {
      logger(
        'debug',
        'GitProvider',
        `Could not resolve git upstream: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    const branch = channel === 'stable' ? 'v3' : 'dev'
    return { remote: 'origin', branch }
  }

  public async getLatest(
    channel: UpdateChannel
  ): Promise<UpdateManifest | null> {
    try {
      const { remote, branch } = await this.resolveRemoteAndBranch(channel)
      await this.git('fetch', '--quiet', remote, branch)

      const commit = await this.git('rev-parse', 'FETCH_HEAD')
      let version = 'unknown'

      try {
        const packageJsonRaw = await this.git('show', 'FETCH_HEAD:package.json')
        const packageData = JSON.parse(packageJsonRaw) as { version?: string }
        if (typeof packageData.version === 'string') {
          version = packageData.version
        }
      } catch (error) {
        logger(
          'warn',
          'GitProvider',
          `Failed to read package.json at FETCH_HEAD: ${error instanceof Error ? error.message : String(error)}`
        )
      }

      return {
        channel,
        version,
        commit,
        url: `git://${remote}/${branch}`
      }
    } catch (error) {
      logger(
        'error',
        'GitProvider',
        `Failed to get latest git revision: ${error instanceof Error ? error.message : String(error)}`
      )
      return null
    }
  }

  public async download(
    manifest: UpdateManifest,
    destination: string
  ): Promise<UpdateDownloadResult> {
    await this.git(
      'archive',
      '--format=tar.gz',
      `--output=${destination}`,
      manifest.commit
    )

    const hash = createHash('sha256')
    const fileStream = createReadStream(destination)

    for await (const chunk of fileStream) {
      hash.update(chunk as Buffer)
    }

    const sha256 = hash.digest('hex')
    const fileStat = await stat(destination)

    return {
      path: destination,
      sha256,
      size: fileStat.size
    }
  }

  public async isAhead(
    localCommit: string,
    remoteCommit: string
  ): Promise<boolean> {
    try {
      await this.git('merge-base', '--is-ancestor', remoteCommit, localCommit)
      return true
    } catch {
      return false
    }
  }

  public async isBehind(
    localCommit: string,
    remoteCommit: string
  ): Promise<boolean> {
    try {
      await this.git('merge-base', '--is-ancestor', localCommit, remoteCommit)
      return true
    } catch {
      return false
    }
  }
}
