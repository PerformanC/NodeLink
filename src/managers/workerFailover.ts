import type {
  PlayerHandoffSnapshot,
  WorkerCommandPayload
} from '../typings/workers/worker.types.ts'
import { logger } from '../utils.ts'

export interface PlayerHandoffRecord {
  playerKey: string
  workerId: number
  displaced: boolean
  state: PlayerHandoffSnapshot
}

export interface WorkerFailoverHooks {
  getLiveWorkerIds: () => number[]
  getBestTargetWorkerId: (excludeWorkerId?: number) => number | null
  isWorkerHealthyForHandback: (workerId: number) => boolean
  assignGuild: (playerKey: string, workerId: number) => void
  unassignGuild: (playerKey: string) => void
  executeOnWorker: <T = unknown>(
    workerId: number,
    type: string,
    payload: WorkerCommandPayload
  ) => Promise<T>
  onUnrecoverablePlayers: (deadWorkerId: number, playerKeys: string[]) => void
}

const FAILOVER_BATCH_SIZE = 5
const FAILOVER_INTERVAL_MS = 150
const HANDBACK_BATCH_SIZE = 5
const HANDBACK_INTERVAL_MS = 500

function getMigrationPriority(
  state: PlayerHandoffSnapshot,
  preferIdle: boolean
): number {
  const hasTrack = Boolean(state.track)
  const isPlaying = hasTrack && !state.isPaused
  if (preferIdle) {
    if (!hasTrack) return 0
    if (state.isPaused) return 1
    return 2
  }
  if (isPlaying) return 0
  if (hasTrack) return 1
  return 2
}

function withAdjustedPosition(
  state: PlayerHandoffSnapshot
): PlayerHandoffSnapshot {
  if (!state.track || state.isPaused || !state.capturedAt) {
    return { ...state }
  }
  const elapsed = Math.max(0, Date.now() - state.capturedAt)
  return {
    ...state,
    position: Math.max(0, (state.position ?? 0) + elapsed),
    capturedAt: Date.now()
  }
}

/**
 * Coordinates paced player failover when a playback worker crashes and
 * gradual PREPARE -> ACK -> COMMIT handback when a worker respawns.
 */
export class WorkerFailoverCoordinator {
  private readonly records = new Map<string, PlayerHandoffRecord>()
  private readonly failoverTimers = new Set<NodeJS.Timeout>()
  private readonly handbackTimers = new Map<number, NodeJS.Timeout>()
  private readonly hooks: WorkerFailoverHooks
  private destroyed = false

  constructor(hooks: WorkerFailoverHooks) {
    this.hooks = hooks
  }

  public updateState(workerId: number, state: PlayerHandoffSnapshot): void {
    if (this.destroyed || !state.sessionId || !state.guildId) return
    const playerKey = `${state.sessionId}:${state.guildId}`
    const existing = this.records.get(playerKey)
    this.records.set(playerKey, {
      playerKey,
      workerId,
      displaced: existing?.workerId === workerId ? existing.displaced : false,
      state
    })
  }

  public removeState(playerKey: string): void {
    this.records.delete(playerKey)
  }

  public scheduleFailover(deadWorkerId: number, affectedGuilds: string[]): void {
    if (this.destroyed || affectedGuilds.length === 0) return

    const liveWorkers = this.hooks
      .getLiveWorkerIds()
      .filter((id) => id !== deadWorkerId)

    if (liveWorkers.length === 0) {
      for (const key of affectedGuilds) this.records.delete(key)
      this.hooks.onUnrecoverablePlayers(deadWorkerId, affectedGuilds)
      return
    }

    const recoverable: PlayerHandoffRecord[] = []
    const unrecoverable: string[] = []

    for (const playerKey of affectedGuilds) {
      const record = this.records.get(playerKey)
      if (record && (record.state.track || record.state.voice)) {
        recoverable.push(record)
      } else {
        this.records.delete(playerKey)
        unrecoverable.push(playerKey)
      }
    }

    if (unrecoverable.length > 0) {
      this.hooks.onUnrecoverablePlayers(deadWorkerId, unrecoverable)
    }

    if (recoverable.length === 0) return

    recoverable.sort(
      (a, b) =>
        getMigrationPriority(a.state, false) -
        getMigrationPriority(b.state, false)
    )

    logger(
      'info',
      'Cluster',
      `Starting paced failover of ${recoverable.length} player(s) from worker ${deadWorkerId}`
    )

    this._runFailoverBatches(deadWorkerId, recoverable, 0)
  }

  private _runFailoverBatches(
    deadWorkerId: number,
    queue: PlayerHandoffRecord[],
    offset: number
  ): void {
    if (this.destroyed || offset >= queue.length) return

    const batch = queue.slice(offset, offset + FAILOVER_BATCH_SIZE)
    void Promise.all(
      batch.map(async (record) => {
        const targetId = this.hooks.getBestTargetWorkerId(deadWorkerId)
        if (targetId === null) {
          this.records.delete(record.playerKey)
          this.hooks.onUnrecoverablePlayers(deadWorkerId, [record.playerKey])
          return
        }

        const snapshot = withAdjustedPosition(record.state)
        try {
          const res = await this.hooks.executeOnWorker<{ restored?: boolean }>(
            targetId,
            'restorePlayer',
            { snapshot }
          )
          if (!res?.restored) {
            throw new Error('restorePlayer returned restored=false')
          }
          this.hooks.assignGuild(record.playerKey, targetId)
          this.records.set(record.playerKey, {
            playerKey: record.playerKey,
            workerId: targetId,
            displaced: true,
            state: snapshot
          })
        } catch (err) {
          logger(
            'warn',
            'Cluster',
            `Failover failed for ${record.playerKey} -> worker ${targetId}: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
          this.records.delete(record.playerKey)
          this.hooks.onUnrecoverablePlayers(deadWorkerId, [record.playerKey])
        }
      })
    ).finally(() => {
      if (this.destroyed || offset + FAILOVER_BATCH_SIZE >= queue.length) return
      const timer = setTimeout(() => {
        this.failoverTimers.delete(timer)
        this._runFailoverBatches(
          deadWorkerId,
          queue,
          offset + FAILOVER_BATCH_SIZE
        )
      }, FAILOVER_INTERVAL_MS)
      timer.unref?.()
      this.failoverTimers.add(timer)
    })
  }

  public scheduleGradualHandback(targetWorkerId: number): void {
    if (this.destroyed || this.handbackTimers.has(targetWorkerId)) return

    const displaced = Array.from(this.records.values()).filter(
      (record) => record.displaced && record.workerId !== targetWorkerId
    )
    if (displaced.length === 0) return

    displaced.sort(
      (a, b) =>
        getMigrationPriority(a.state, true) -
        getMigrationPriority(b.state, true)
    )

    logger(
      'info',
      'Cluster',
      `Scheduling gradual handback of ${displaced.length} displaced player(s) to worker ${targetWorkerId}`
    )

    this._runHandbackBatch(targetWorkerId, displaced, 0)
  }

  private _runHandbackBatch(
    targetWorkerId: number,
    queue: PlayerHandoffRecord[],
    offset: number
  ): void {
    if (this.destroyed || offset >= queue.length) {
      this.handbackTimers.delete(targetWorkerId)
      return
    }

    if (!this.hooks.isWorkerHealthyForHandback(targetWorkerId)) {
      logger(
        'debug',
        'Cluster',
        `Pausing gradual handback to worker ${targetWorkerId}: worker busy or unavailable`
      )
      this.handbackTimers.delete(targetWorkerId)
      return
    }

    const batch = queue.slice(offset, offset + HANDBACK_BATCH_SIZE)
    void Promise.all(
      batch.map(async (record) => {
        const current = this.records.get(record.playerKey)
        if (!current || current.workerId === targetWorkerId) return

        const donorWorkerId = current.workerId
        const { sessionId, guildId } = current.state

        try {
          const liveRes = await this.hooks.executeOnWorker<{
            found?: boolean
            snapshot?: PlayerHandoffSnapshot
          }>(donorWorkerId, 'getPlayerHandoffState', { sessionId, guildId })

          if (!liveRes?.found || !liveRes.snapshot) return

          const restoreRes = await this.hooks.executeOnWorker<{
            restored?: boolean
          }>(targetWorkerId, 'restorePlayer', { snapshot: liveRes.snapshot })

          if (!restoreRes?.restored) return

          this.hooks.unassignGuild(current.playerKey)
          this.hooks.assignGuild(current.playerKey, targetWorkerId)
          this.records.set(current.playerKey, {
            playerKey: current.playerKey,
            workerId: targetWorkerId,
            displaced: false,
            state: liveRes.snapshot
          })

          await this.hooks.executeOnWorker(donorWorkerId, 'destroyPlayer', {
            sessionId,
            guildId,
            silent: true
          })
        } catch (err) {
          logger(
            'warn',
            'Cluster',
            `Handback skipped for ${current.playerKey} (${donorWorkerId} -> ${targetWorkerId}): ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        }
      })
    ).finally(() => {
      if (this.destroyed || offset + HANDBACK_BATCH_SIZE >= queue.length) {
        this.handbackTimers.delete(targetWorkerId)
        return
      }
      const timer = setTimeout(() => {
        this.handbackTimers.delete(targetWorkerId)
        this._runHandbackBatch(
          targetWorkerId,
          queue,
          offset + HANDBACK_BATCH_SIZE
        )
      }, HANDBACK_INTERVAL_MS)
      timer.unref?.()
      this.handbackTimers.set(targetWorkerId, timer)
    })
  }

  public destroy(): void {
    this.destroyed = true
    for (const timer of this.failoverTimers) clearTimeout(timer)
    this.failoverTimers.clear()
    for (const timer of this.handbackTimers.values()) clearTimeout(timer)
    this.handbackTimers.clear()
    this.records.clear()
  }
}
