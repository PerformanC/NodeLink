import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { UpdateState } from '../../typings/updater.types.ts'
import { logger } from '../../utils.ts'
import {
  MAX_CONSECUTIVE_CRASHES,
  RAPID_CRASH_THRESHOLD_MS,
  UPDATER_PATHS
} from './constants.ts'

export class UpdateStateStore {
  private readonly root: string

  public constructor(root: string) {
    this.root = root
  }

  private get statePath(): string {
    return path.join(this.root, UPDATER_PATHS.state)
  }

  public async read(): Promise<UpdateState | null> {
    try {
      const content = await readFile(this.statePath, 'utf8')
      const state = JSON.parse(content) as Partial<UpdateState>

      if (!state.version || !state.commit) {
        logger('warn', 'UpdateStateStore', 'Invalid state.json format')
        return null
      }

      return {
        version: state.version,
        commit: state.commit,
        channel: state.channel ?? 'dev',
        updatedAt: state.updatedAt ?? new Date().toISOString(),
        previousVersion: state.previousVersion,
        previousCommit: state.previousCommit,
        quarantinedCommits: state.quarantinedCommits ?? {},
        consecutiveCrashCount: state.consecutiveCrashCount ?? 0,
        lastBootTimestamp: state.lastBootTimestamp,
        justUpdated: state.justUpdated,
        lastAcknowledgedCommit: state.lastAcknowledgedCommit
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger(
          'warn',
          'UpdateStateStore',
          `Failed to read state.json: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      return null
    }
  }

  public async write(state: UpdateState): Promise<void> {
    try {
      const directory = path.dirname(this.statePath)
      await mkdir(directory, { recursive: true })

      const temporaryPath = `${this.statePath}.${Date.now()}.tmp`
      await writeFile(
        temporaryPath,
        `${JSON.stringify(state, null, 2)}\n`,
        'utf8'
      )
      await rename(temporaryPath, this.statePath)
    } catch (error) {
      logger(
        'error',
        'UpdateStateStore',
        `Failed to persist state.json: ${error instanceof Error ? error.message : String(error)}`
      )
      throw error
    }
  }

  public async quarantineCommit(commit: string, reason: string): Promise<void> {
    const current = (await this.read()) ?? {
      version: 'unknown',
      commit: 'unknown',
      channel: 'dev' as const,
      updatedAt: new Date().toISOString()
    }

    const quarantined = current.quarantinedCommits ?? {}
    const existing = quarantined[commit]
    const attempts = (existing?.attempts ?? 0) + 1

    const updatedState: UpdateState = {
      ...current,
      quarantinedCommits: {
        ...quarantined,
        [commit]: {
          failedAt: new Date().toISOString(),
          reason,
          attempts
        }
      }
    }

    await this.write(updatedState)
    logger(
      'warn',
      'UpdateStateStore',
      `Commit ${commit.slice(0, 7)} quarantined (attempts: ${attempts}): ${reason}`
    )
  }

  public async checkCrashLoop(): Promise<boolean> {
    const current = await this.read()
    if (!current) return false

    const now = Date.now()
    const lastBoot = current.lastBootTimestamp ?? 0
    const crashCount = current.consecutiveCrashCount ?? 0

    if (
      now - lastBoot < RAPID_CRASH_THRESHOLD_MS &&
      crashCount >= MAX_CONSECUTIVE_CRASHES
    ) {
      logger(
        'error',
        'UpdateStateStore',
        `Crash loop detected! ${crashCount} rapid crashes in sequence. Auto-update disabled temporarily.`
      )
      return true
    }

    return false
  }

  public async recordBoot(version: string, commit: string): Promise<void> {
    const current = (await this.read()) ?? {
      version,
      commit,
      channel: 'dev' as const,
      updatedAt: new Date().toISOString()
    }

    const now = Date.now()
    const lastBoot = current.lastBootTimestamp ?? 0
    const isRapid = now - lastBoot < RAPID_CRASH_THRESHOLD_MS
    const consecutiveCrashCount = isRapid
      ? (current.consecutiveCrashCount ?? 0) + 1
      : 0

    await this.write({
      ...current,
      version,
      commit,
      lastBootTimestamp: now,
      consecutiveCrashCount
    })
  }

  public async recordBootSuccess(): Promise<void> {
    const current = await this.read()
    if (!current || (current.consecutiveCrashCount ?? 0) === 0) return

    await this.write({
      ...current,
      consecutiveCrashCount: 0
    })
  }
}
