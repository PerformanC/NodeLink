import type { Worker as ClusterWorkerBase } from 'node:cluster'
import cluster from 'node:cluster'
import crypto from 'node:crypto'
import fs from 'node:fs'
import type { Socket } from 'node:net'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import v8 from 'node:v8'

import type {
  WorkerMetricsEntry,
  WorkerStatsPayload
} from '../typings/api/stats.types.ts'
import type { NodelinkConfig } from '../typings/config/config.types.ts'
import type { WorkerCommandPayload } from '../typings/workers/worker.types.ts'
import { logger } from '../utils.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * Cluster worker with NodeLink playback metadata.
 * @internal
 */
interface PlaybackWorker extends ClusterWorkerBase {
  workerType?: 'playback'
  ready: boolean
}

/**
 * Socket used by the worker command channel.
 * @internal
 */
interface CommandSocket extends Socket {
  _workerId?: number
}

interface EventSocket extends Socket {
  _workerId?: number
}

/**
 * Runtime worker stats payload received from playback workers.
 * @internal
 */
interface WorkerRuntimeStats extends WorkerStatsPayload {
  isHibernating?: boolean
}

/**
 * Worker stats packet including source worker id.
 * @internal
 */
interface WorkerStatsPacket extends WorkerRuntimeStats {
  workerId: number
}

/**
 * Single failure sample for a worker process.
 * @internal
 */
interface WorkerFailureSample {
  timestamp: number
  code: number | null
  signal: string | null
}

/**
 * Failure history for a worker used to prevent crash loops.
 * @internal
 */
interface WorkerFailureHistoryEntry {
  count: number
  lastFailure: number | null
  recentFailures: WorkerFailureSample[]
}

/**
 * Active command request tracked for retries/timeouts.
 * @internal
 */
interface PendingCommandRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
  workerId: number
  type: string
  payload: WorkerCommandPayload
  retryCount: number
  isFast: boolean
  startTime: number
}

/**
 * Minimal stream delegate request shape.
 * @internal
 */
interface DelegatedRequest {
  url?: string
}

/**
 * Minimal stream delegate response shape.
 * @internal
 */
interface DelegatedResponse {
  headersSent: boolean
  on(event: 'close', listener: () => void): void
  writeHead(statusCode: number, headers?: Record<string, string>): void
  setHeader(name: string, value: string): void
  write(chunk: Buffer): void
  end(chunk?: string): void
  send?(chunk: Buffer): void
}

/**
 * Optional HTTP settings to apply before sending stream chunks.
 * @example { statusCode: 206, headers: { 'Content-Type': 'audio/mpeg' } }
 * @internal
 */
interface StreamDelegateOptions {
  statusCode?: number
  headers?: Record<string, string>
  isWebSocket?: boolean
}

/**
 * Active delegated stream request.
 * @internal
 */
interface StreamRequestEntry {
  id: string
  req: DelegatedRequest
  res: DelegatedResponse
  workerId: number
  options: StreamDelegateOptions
  timeout: NodeJS.Timeout | null
  cleaned: boolean
}

/**
 * Runtime scaling settings used by the worker manager.
 * @internal
 */
interface WorkerScalingConfig {
  maxPlayersPerWorker: number
  targetUtilization: number
  scaleUpThreshold: number
  scaleDownThreshold: number
  idleWorkerTimeoutMs: number
  checkIntervalMs: number
  lagPenaltyLimit: number
  cpuPenaltyLimit: number
}

/**
 * Command execution options.
 * @example { fast: true, timeoutMs: 5000 }
 * @internal
 */
interface ExecuteOptions {
  fast?: boolean
  timeoutMs?: number
}

/**
 * Stream command dispatched to playback workers.
 * @internal
 */
interface StreamWorkerCommand {
  type: string
  requestId: string
  payload: Record<string, unknown>
}

/**
 * Cached live YouTube credentials propagated to workers.
 * @example { refreshToken: 'yt-refresh-token', visitorData: null }
 * @internal
 */
interface LiveYoutubeConfig {
  refreshToken: string | null
  visitorData: string | null
}

/**
 * Minimal global NodeLink shape accessed by WorkerManager.
 * @internal
 */
interface GlobalNodelinkLike {
  sessions: {
    get: (sessionId: string) =>
      | {
          id: string
          players: {
            players: Map<string, unknown>
          }
        }
      | undefined
  }
  handleIPCMessage: (msg: unknown) => void
  handleVoiceFrame?: (payload: Buffer) => void
  statsManager?: {
    incrementWorkerFailure?: (
      workerId: number,
      exitCode?: number | null
    ) => void
    incrementWorkerRestart?: (workerId: number) => void
    incrementCommandTimeout?: (commandType: string) => void
    incrementCommandRetry?: (commandType: string) => void
    recordCommandExecutionTime?: (
      commandType: string,
      workerId: number,
      durationMs: number
    ) => void
  }
}

const getGlobalNodelink = (): GlobalNodelinkLike | undefined =>
  (globalThis as { nodelink?: GlobalNodelinkLike }).nodelink

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const isWorkerStatsPacket = (value: unknown): value is WorkerStatsPacket =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { workerId?: unknown }).workerId === 'number'

const isPidPacket = (value: unknown): value is { pid: number } =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { pid?: unknown }).pid === 'number'

const createSocketPath = (name: string): string =>
  os.platform() === 'win32'
    ? `\\\\.\\pipe\\nodelink-${name}-${crypto.randomBytes(8).toString('hex')}`
    : `/tmp/nodelink-${name}-${crypto.randomBytes(8).toString('hex')}.sock`

const resolveExecPath = (): string => {
  const distIndex = path.resolve(__dirname, '../index.js')
  if (fs.existsSync(distIndex)) return distIndex
  return path.resolve(process.cwd(), 'src/index.ts')
}

const parseBool = (value: unknown): boolean => {
  if (value === true) return true
  if (value === false) return false
  return (
    typeof value === 'string' &&
    ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
  )
}

const parsePositiveInt = (value: unknown): number => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

const parseExecArgv = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean)
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
  }
  return []
}

interface WorkerRuntimeEnv {
  NODELINK_WORKER_MAX_OLD_SPACE_MB?: string
  NODELINK_WORKER_EXPOSE_GC?: string
  NODELINK_WORKER_EXEC_ARGV?: string
}

const buildWorkerExecArgv = (
  config: NodelinkConfig | null = null
): string[] => {
  const args = new Set(process.execArgv || [])
  const runtime: {
    workerMaxOldSpaceMb?: unknown
    workerExposeGc?: unknown
    workerExecArgv?: unknown
  } = config?.cluster?.runtime ?? {}
  const env = process.env as NodeJS.ProcessEnv & WorkerRuntimeEnv

  for (const arg of Array.from(args)) {
    if (arg.startsWith('--max-old-space-size=')) args.delete(arg)
  }

  const maxOldSpaceMb = parsePositiveInt(
    env.NODELINK_WORKER_MAX_OLD_SPACE_MB ?? runtime.workerMaxOldSpaceMb ?? 0
  )
  if (maxOldSpaceMb > 0) {
    args.add(`--max-old-space-size=${maxOldSpaceMb}`)
  }

  const exposeGc =
    parseBool(env.NODELINK_WORKER_EXPOSE_GC) ||
    parseBool(runtime.workerExposeGc)
  if (exposeGc) {
    args.add('--expose-gc')
  }

  const configExtraArgs = parseExecArgv(runtime.workerExecArgv)
  for (const arg of configExtraArgs) {
    args.add(arg)
  }

  const envExtraArgs = parseExecArgv(env.NODELINK_WORKER_EXEC_ARGV)
  for (const arg of envExtraArgs) {
    args.add(arg)
  }

  return Array.from(args)
}

export default class WorkerManager {
  private config: NodelinkConfig
  workers: PlaybackWorker[]
  private workersById: Map<number, PlaybackWorker>
  private guildToWorker: Map<string, number>
  private workerToGuilds: Map<number, Set<string>>
  private nextStatelessWorkerIndex: number
  private pendingRequests: Map<string, PendingCommandRequest>
  private streamRequests: Map<string, StreamRequestEntry>
  private maxWorkers: number
  private minWorkers: number
  workerLoad: Map<number, number>
  workerStats: Map<number, WorkerRuntimeStats>
  private idleWorkers: Map<number, number>
  private scaleCheckInterval: NodeJS.Timeout | null
  private healthCheckInterval: NodeJS.Timeout | null
  private workerFailureHistory: Map<number, WorkerFailureHistoryEntry>
  private statsUpdateBatch: Map<number, WorkerRuntimeStats>
  private statsUpdateTimer: NodeJS.Timeout | null
  private workerHealth: Map<number, number>
  private workerStartTime: Map<number, number>
  private workerUniqueId: Map<number, number>
  private workerReady: Set<number>
  private nextWorkerId: number
  private liveYoutubeConfig: LiveYoutubeConfig
  isDestroying: boolean
  private commandTimeout: number
  private fastCommandTimeout: number
  private maxRetries: number
  private scalingConfig: WorkerScalingConfig
  private socketPath: string
  private server: net.Server | null
  private commandSocketPath: string
  private commandServer: net.Server | null
  private commandSockets: Map<number, CommandSocket>
  private eventSockets: Map<number, EventSocket>
  private socketRotateInProgress: boolean
  private lastSocketRotateAt: number

  constructor(config: NodelinkConfig) {
    this.config = config
    this.workers = []
    this.workersById = new Map()
    this.guildToWorker = new Map()
    this.workerToGuilds = new Map()
    this.nextStatelessWorkerIndex = 0
    this.pendingRequests = new Map()
    this.streamRequests = new Map()
    this.maxWorkers =
      config.cluster.workers === 0
        ? os.cpus().length
        : Math.max(1, config.cluster.workers || 0)
    this.minWorkers = Math.max(1, config.cluster?.minWorkers || 1)
    this.workerLoad = new Map()
    this.workerStats = new Map()
    this.idleWorkers = new Map()
    this.scaleCheckInterval = null
    this.healthCheckInterval = null
    this.workerFailureHistory = new Map()
    this.statsUpdateBatch = new Map()
    this.statsUpdateTimer = null
    this.workerHealth = new Map()
    this.workerStartTime = new Map()
    this.workerUniqueId = new Map()
    this.workerReady = new Set()
    this.nextWorkerId = 1
    this.liveYoutubeConfig = { refreshToken: null, visitorData: null }
    this.isDestroying = false
    this.commandTimeout = config.cluster?.commandTimeout || 45000
    this.fastCommandTimeout = config.cluster?.fastCommandTimeout || 10000
    this.maxRetries = config.cluster?.maxRetries || 2
    this.scalingConfig = {
      maxPlayersPerWorker:
        config.cluster.scaling?.maxPlayersPerWorker ||
        config.cluster.workers ||
        20,
      targetUtilization: config.cluster.scaling?.targetUtilization || 0.7,
      scaleUpThreshold: config.cluster.scaling?.scaleUpThreshold || 0.75,
      scaleDownThreshold: config.cluster.scaling?.scaleDownThreshold || 0.3,
      idleWorkerTimeoutMs: config.cluster.scaling?.idleWorkerTimeoutMs || 60000,
      checkIntervalMs: config.cluster.scaling?.checkIntervalMs || 5000,
      lagPenaltyLimit: config.cluster.scaling?.lagPenaltyLimit || 60,
      cpuPenaltyLimit: config.cluster.scaling?.cpuPenaltyLimit || 0.85
    }

    this.socketPath = createSocketPath('events')
    this.server = null
    this.commandSocketPath = createSocketPath('commands')
    this.commandServer = null
    this.commandSockets = new Map()
    this.eventSockets = new Map()
    this.socketRotateInProgress = false
    this.lastSocketRotateAt = 0

    logger(
      'info',
      'Cluster',
      `Primary PID ${process.pid} - WorkerManager initialized. Min: ${this.minWorkers}, Max: ${this.maxWorkers} workers`
    )

    this._startSocketServer()
    this._startCommandSocketServer()
    this._ensureWorkerAvailability()
    this._startScalingCheck()
    this._startHealthCheck()

    cluster.on('exit', (worker, code, signal) => {
      const playbackWorker = worker as PlaybackWorker
      if (playbackWorker.workerType !== 'playback') return

      const isSystemSignal =
        signal === 'SIGINT' ||
        signal === 'SIGTERM' ||
        code === 130 ||
        code === 143
      if (this.isDestroying || isSystemSignal) {
        const index = this.workers.indexOf(playbackWorker)
        if (index !== -1) this.workers.splice(index, 1)
        this.workersById.delete(playbackWorker.id)
        return
      }

      this._updateWorkerFailureHistory(playbackWorker.id, code, signal)

      const nodelink = getGlobalNodelink()
      if (nodelink?.statsManager?.incrementWorkerFailure) {
        nodelink.statsManager.incrementWorkerFailure(playbackWorker.id, code)
      }

      const affectedGuilds = Array.from(
        this.workerToGuilds.get(playbackWorker.id) || []
      )

      this._retryPendingRequestsForWorker(playbackWorker.id)
      this.removeWorker(playbackWorker.id)

      const shouldRespawn = this._shouldRespawnWorker(
        playbackWorker.id,
        code,
        affectedGuilds.length
      )

      if (shouldRespawn) {
        logger('info', 'Cluster', 'Respawning worker...')
        const history = this.workerFailureHistory.get(playbackWorker.id)
        const delay = history ? Math.min(history.count * 1000, 30000) : 500

        setTimeout(() => {
          this.forkWorker()
          if (nodelink?.statsManager?.incrementWorkerRestart) {
            nodelink.statsManager.incrementWorkerRestart(playbackWorker.id)
          }
        }, delay)
      }
    })
  }

  private _shouldRespawnWorker(
    workerId: number,
    _exitCode: number | null,
    affectedGuildsCount: number
  ): boolean {
    if (this.isDestroying) return false
    if (this.workers.length < this.minWorkers) return true
    if (affectedGuildsCount > 0) return true

    const history = this.workerFailureHistory.get(workerId)
    if (history) {
      const recentFailures = history.recentFailures.filter(
        (f) => Date.now() - f.timestamp < 30000
      )

      if (recentFailures.length >= 3) {
        logger(
          'error',
          'Cluster',
          `Worker ${workerId} crashed ${recentFailures.length} times in 30s. Preventing crash loop.`
        )
        return false
      }
    }

    return true
  }

  private _startHealthCheck(): void {
    this.healthCheckInterval = setInterval(() => {
      const now = Date.now()
      for (const worker of this.workers) {
        if (worker.isConnected()) {
          const lastSeen = this.workerHealth.get(worker.id) || 0
          if (now - lastSeen > 30000) {
            logger(
              'warn',
              'Cluster',
              `Worker ${worker.id} unresponsive (${Math.floor((now - lastSeen) / 1000)}s)`
            )
          }
          worker.send({ type: 'ping', timestamp: now })
        }
      }
    }, 10000)
  }

  private _stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval)
      this.healthCheckInterval = null
      logger('info', 'Cluster', 'Health check stopped')
    }
  }

  private _retryPendingRequestsForWorker(workerId: number): void {
    for (const [requestId, request] of this.pendingRequests.entries()) {
      if (request.workerId === workerId) {
        clearTimeout(request.timeout)
        this.pendingRequests.delete(requestId)

        if (request.retryCount < this.maxRetries) {
          logger(
            'debug',
            'Cluster',
            `Retrying command after worker ${workerId} exit (attempt ${request.retryCount + 1})`
          )

          setTimeout(
            () => {
              const newWorker = this.getBestWorker()
              if (newWorker) {
                this._executeCommand(
                  newWorker,
                  request.type,
                  request.payload,
                  request.resolve,
                  request.reject,
                  request.retryCount + 1,
                  request.isFast,
                  undefined
                )
              } else {
                request.reject(new Error('No workers available for retry'))
              }
            },
            500 * 2 ** request.retryCount
          )
        } else {
          request.reject(
            new Error(`Worker ${workerId} exited before completing request`)
          )
        }
      }
    }
  }

  private _startScalingCheck(): void {
    if (this.scaleCheckInterval) return

    this.scaleCheckInterval = setInterval(
      () => this._scaleWorkers(),
      this.scalingConfig.checkIntervalMs
    )

    logger(
      'info',
      'Cluster',
      `Scaling check started with interval: ${this.scalingConfig.checkIntervalMs}ms`
    )
  }

  private _stopScalingCheck(): void {
    if (this.scaleCheckInterval) {
      clearInterval(this.scaleCheckInterval)
      this.scaleCheckInterval = null
      logger('info', 'Cluster', 'Scaling check stopped')
    }
  }

  private _scaleWorkers(): void {
    let activeCount = 0
    let totalCost = 0
    const metrics: Array<{ worker: PlaybackWorker; cost: number }> = []

    for (const worker of this.workers) {
      if (worker.isConnected()) {
        activeCount++
        const cost = this._calculateWorkerCost(worker.id)
        totalCost += cost
        metrics.push({ worker, cost })
      }
    }

    const averageCost = activeCount > 0 ? totalCost / activeCount : 0
    const { idleWorkerTimeoutMs, maxPlayersPerWorker, scaleUpThreshold } =
      this.scalingConfig

    if (
      averageCost >= maxPlayersPerWorker * scaleUpThreshold &&
      activeCount < this.maxWorkers
    ) {
      logger(
        'info',
        'Cluster',
        `Scaling up: Average cost ${averageCost.toFixed(2)} reached threshold ${(maxPlayersPerWorker * scaleUpThreshold).toFixed(2)} (${scaleUpThreshold * 100}%). Forking new worker.`
      )
      this.forkWorker()
      return
    }

    if (averageCost < 2 && activeCount > this.minWorkers) {
      const now = Date.now()

      for (const { worker, cost } of metrics) {
        if (cost === 0 && activeCount > this.minWorkers) {
          const idleTime = this.idleWorkers.get(worker.id)

          if (!idleTime) {
            this.idleWorkers.set(worker.id, now)
          } else if (now - idleTime > idleWorkerTimeoutMs) {
            logger(
              'info',
              'Cluster',
              `Scaling down: Worker ${worker.id} idle for > ${idleWorkerTimeoutMs}ms. Removing worker.`
            )
            this.removeWorker(worker.id)
            activeCount--
            break
          }
        } else if (cost > 0) {
          this.idleWorkers.delete(worker.id)
        }
      }
    }
  }

  private _calculateWorkerCost(workerId: number): number {
    const stats = this.workerStats.get(workerId)
    if (!stats) return 0

    const playingWeight = 1.0
    const pausedWeight = 0.01

    const playingCount = stats.playingPlayers || 0
    const pausedCount = Math.max(0, (stats.players || 0) - playingCount)

    let cost = playingCount * playingWeight + pausedCount * pausedWeight

    if (stats.isHibernating) return cost

    if ((stats.cpu?.nodelinkLoad ?? 0) > this.scalingConfig.cpuPenaltyLimit) {
      cost += this.scalingConfig.maxPlayersPerWorker + 5
    }

    if ((stats.eventLoopLag ?? 0) > this.scalingConfig.lagPenaltyLimit) {
      cost += this.scalingConfig.maxPlayersPerWorker / 2
    }

    return cost
  }

  private _updateWorkerFailureHistory(
    workerId: number,
    code: number | null,
    signal: string | null
  ): void {
    let history = this.workerFailureHistory.get(workerId)

    if (!history) {
      history = {
        count: 0,
        lastFailure: null,
        recentFailures: []
      }
      this.workerFailureHistory.set(workerId, history)
    }

    history.count++
    history.lastFailure = Date.now()
    history.recentFailures.push({ timestamp: Date.now(), code, signal })

    if (history.recentFailures.length > 5) {
      history.recentFailures = history.recentFailures.slice(-5)
    }

    logger(
      'debug',
      'Cluster',
      `Worker ${workerId} failure history updated: ${JSON.stringify(history)}`
    )
  }

  private _registerEventSocket(pid: number, eventSocket: EventSocket): void {
    const worker = this.workers.find((w) => w.process.pid === pid)
    if (!worker) return
    const existing = this.eventSockets.get(worker.id)
    if (existing && existing !== eventSocket) {
      try {
        existing.destroy()
      } catch {}
    }
    eventSocket._workerId = worker.id
    this.eventSockets.set(worker.id, eventSocket)
  }

  private _removeEventSocket(eventSocket: EventSocket): void {
    const workerId = eventSocket?._workerId
    if (!workerId) return
    if (this.eventSockets.get(workerId) === eventSocket) {
      this.eventSockets.delete(workerId)
    }
  }

  private _startSocketServer(): void {
    this._safeUnlinkSocketPath(this.socketPath)
    this.server = net.createServer((socket) => {
      const eventSocket = socket as EventSocket
      const frameChunks: Buffer[] = []
      let frameBytes = 0

      socket.on('error', () => {
        // Ignore per-connection transport errors (EPIPE/ECONNRESET).
      })
      socket.on('close', () => this._removeEventSocket(eventSocket))

      const peekBytes = (count: number): Buffer => {
        const first = frameChunks[0]
        if (first && first.length >= count) return first.subarray(0, count)

        const out = Buffer.allocUnsafe(count)
        let offset = 0
        for (const piece of frameChunks) {
          const take = Math.min(piece.length, count - offset)
          piece.copy(out, offset, 0, take)
          offset += take
          if (offset >= count) break
        }
        return out
      }

      const readBytes = (count: number): Buffer => {
        const out = Buffer.allocUnsafe(count)
        let offset = 0

        while (offset < count) {
          const piece = frameChunks[0]
          if (!piece) break

          const take = Math.min(piece.length, count - offset)
          piece.copy(out, offset, 0, take)
          offset += take

          if (take === piece.length) frameChunks.shift()
          else frameChunks[0] = piece.subarray(take)
        }

        frameBytes = Math.max(0, frameBytes - count)
        return out
      }

      socket.on('data', (chunk) => {
        const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (!chunkBuffer.length) return
        frameChunks.push(chunkBuffer)
        frameBytes += chunkBuffer.length

        while (frameBytes >= 6) {
          const header = peekBytes(6)
          const idSize = header.readUInt8(0)
          const type = header.readUInt8(1)
          const payloadSize = header.readUInt32BE(2)
          const totalSize = 6 + idSize + payloadSize

          if (frameBytes < totalSize) break

          const frame = readBytes(totalSize)
          const id = frame.toString('utf8', 6, 6 + idSize)
          const payload = frame.subarray(6 + idSize)

          if (type === 5) {
            this._handleStreamChunk(id, payload)
            continue
          }
          if (type === 6) {
            this._handleStreamEnd(id)
            continue
          }
          if (type === 7) {
            this._handleStreamError(id, payload.toString('utf8'))
            continue
          }
          if (type === 8) {
            const nodelink = getGlobalNodelink()
            if (nodelink?.handleVoiceFrame) {
              try {
                nodelink.handleVoiceFrame(payload)
              } catch {}
            }
            continue
          }

          try {
            const data = v8.deserialize(payload)
            if (type === 0) {
              // Event socket hello - register socket to worker by PID
              if (isPidPacket(data))
                this._registerEventSocket(data.pid, eventSocket)
            } else if (type === 3) {
              // playerEvent
              const nodelink = getGlobalNodelink()
              if (nodelink)
                nodelink.handleIPCMessage({
                  type: 'playerEvent',
                  payload: data
                })
            } else if (type === 4) {
              // workerStats - prefer socket-mapped worker ID over payload workerId
              if (isWorkerStatsPacket(data)) {
                const { workerId: payloadWorkerId, ...stats } = data
                const resolvedWorkerId =
                  eventSocket._workerId ?? payloadWorkerId
                this.statsUpdateBatch.set(resolvedWorkerId, stats)
                if (!this.statsUpdateTimer) {
                  this.statsUpdateTimer = setTimeout(
                    () => this._flushStatsUpdates(),
                    100
                  )
                }
              }
            } else if (type === 9) {
              const nodelink = getGlobalNodelink()
              if (nodelink)
                nodelink.handleIPCMessage({
                  type: 'liveChatAction',
                  payload: data
                })
            }
          } catch (e: unknown) {
            logger(
              'error',
              'Cluster',
              `Socket event parse error: ${getErrorMessage(e)}`
            )
          }
        }
      })
    })

    this.server.on('error', (err: Error) => {
      logger('error', 'Cluster', `Event socket server error: ${err.message}`)
    })

    this.server.listen(this.socketPath, () => {
      logger(
        'info',
        'Cluster',
        `Event socket server listening at ${this.socketPath}`
      )
    })
  }

  private _startCommandSocketServer(): void {
    this._safeUnlinkSocketPath(this.commandSocketPath)
    this.commandServer = net.createServer((socket) => {
      const commandSocket = socket as CommandSocket
      const frameChunks: Buffer[] = []
      let frameBytes = 0

      const peekBytes = (count: number): Buffer => {
        const first = frameChunks[0]
        if (first && first.length >= count) return first.subarray(0, count)

        const out = Buffer.allocUnsafe(count)
        let offset = 0
        for (const piece of frameChunks) {
          const take = Math.min(piece.length, count - offset)
          piece.copy(out, offset, 0, take)
          offset += take
          if (offset >= count) break
        }
        return out
      }

      const readBytes = (count: number): Buffer => {
        const out = Buffer.allocUnsafe(count)
        let offset = 0

        while (offset < count) {
          const piece = frameChunks[0]
          if (!piece) break

          const take = Math.min(piece.length, count - offset)
          piece.copy(out, offset, 0, take)
          offset += take

          if (take === piece.length) frameChunks.shift()
          else frameChunks[0] = piece.subarray(take)
        }

        frameBytes = Math.max(0, frameBytes - count)
        return out
      }

      socket.on('data', (chunk) => {
        const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (!chunkBuffer.length) return
        frameChunks.push(chunkBuffer)
        frameBytes += chunkBuffer.length

        while (frameBytes >= 6) {
          const header = peekBytes(6)
          const idSize = header.readUInt8(0)
          const type = header.readUInt8(1)
          const payloadSize = header.readUInt32BE(2)
          const totalSize = 6 + idSize + payloadSize

          if (frameBytes < totalSize) break

          const frame = readBytes(totalSize)
          const id = frame.toString('utf8', 6, 6 + idSize)
          const payload = frame.subarray(6 + idSize)

          if (type === 0) {
            try {
              const data = v8.deserialize(payload)
              if (isPidPacket(data))
                this._registerCommandSocket(data.pid, commandSocket)
            } catch (e: unknown) {
              logger(
                'error',
                'Cluster',
                `Command socket hello parse error: ${getErrorMessage(e)}`
              )
            }
            continue
          }

          if (type === 2) {
            let result: unknown
            try {
              result = v8.deserialize(payload)
            } catch {
              result = payload.toString('utf8')
            }
            this._handleCommandResponse(id, result)
            continue
          }

          if (type === 3) {
            let errorMsg: unknown
            try {
              errorMsg = v8.deserialize(payload)
            } catch {
              errorMsg = payload.toString('utf8')
            }
            this._handleCommandResponse(id, null, errorMsg)
          }
        }
      })

      commandSocket.on('close', () => this._removeCommandSocket(commandSocket))
      commandSocket.on('error', () => this._removeCommandSocket(commandSocket))
    })

    this.commandServer.on('error', (err: Error) => {
      logger('error', 'Cluster', `Command socket server error: ${err.message}`)
    })

    this.commandServer.listen(this.commandSocketPath, () => {
      logger(
        'info',
        'Cluster',
        `Command socket server listening at ${this.commandSocketPath}`
      )
    })
  }

  private _safeUnlinkSocketPath(socketPath: string): void {
    if (!socketPath || os.platform() === 'win32') return
    try {
      if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath)
    } catch {}
  }

  private _rotateSocketServers(
    reason = 'unknown',
    sourceWorkerId: number | string = 'unknown'
  ): void {
    const now = Date.now()
    if (this.socketRotateInProgress) return
    if (now - this.lastSocketRotateAt < 5000) return
    this.socketRotateInProgress = true
    this.lastSocketRotateAt = now

    const oldEventPath = this.socketPath
    const oldCommandPath = this.commandSocketPath

    logger(
      'warn',
      'Cluster',
      `Rotating internal sockets after ${reason} (worker ${sourceWorkerId})`
    )

    for (const socket of this.eventSockets.values()) {
      try {
        socket.destroy()
      } catch {}
    }
    this.eventSockets.clear()

    for (const socket of this.commandSockets.values()) {
      try {
        socket.destroy()
      } catch {}
    }
    this.commandSockets.clear()

    try {
      this.server?.close()
    } catch {}
    this.server = null

    try {
      this.commandServer?.close()
    } catch {}
    this.commandServer = null

    this._safeUnlinkSocketPath(oldEventPath)
    this._safeUnlinkSocketPath(oldCommandPath)

    this.socketPath = createSocketPath('events')
    this.commandSocketPath = createSocketPath('commands')

    this._startSocketServer()
    this._startCommandSocketServer()

    for (const worker of this.workers) {
      if (!worker?.isConnected()) continue
      try {
        worker.send({
          type: 'rotateSocketPaths',
          eventSocketPath: this.socketPath,
          commandSocketPath: this.commandSocketPath
        })
      } catch {}
    }

    setTimeout(() => {
      this.socketRotateInProgress = false
    }, 1000)
  }

  private _registerCommandSocket(pid: number, socket: CommandSocket): void {
    const worker = this.workers.find((w) => w.process.pid === pid)
    if (!worker) return

    const existing = this.commandSockets.get(worker.id)
    if (existing && existing !== socket) {
      try {
        existing.destroy()
      } catch {}
    }

    socket._workerId = worker.id
    this.commandSockets.set(worker.id, socket)
  }

  private _removeCommandSocket(socket: CommandSocket): void {
    const workerId = socket?._workerId
    if (!workerId) return
    if (this.commandSockets.get(workerId) === socket) {
      this.commandSockets.delete(workerId)
    }
  }

  private _sendCommandSocketFrame(
    workerId: number,
    type: number,
    requestId: string,
    payloadBuf: Buffer
  ): boolean {
    const socket = this.commandSockets.get(workerId)
    if (!socket || socket.destroyed || socket.writable === false) return false

    const idBuf = Buffer.from(requestId, 'utf8')
    const header = Buffer.alloc(6)
    header.writeUInt8(idBuf.length, 0)
    header.writeUInt8(type, 1)
    header.writeUInt32BE(payloadBuf.length, 2)

    try {
      socket.cork()
      const okHeader = socket.write(header)
      const okId = socket.write(idBuf)
      const okPayload = socket.write(payloadBuf)
      socket.uncork()
      return okHeader && okId && okPayload
    } catch {
      this._removeCommandSocket(socket)
      try {
        socket.destroy()
      } catch {}
      return false
    }
  }

  private _handleStreamChunk(streamId: string, payload: Buffer): void {
    const request = this.streamRequests.get(streamId)
    if (!request) return

    if (request.timeout) {
      clearTimeout(request.timeout)
      request.timeout = null
    }

    if (!request.res.headersSent) {
      const headers = request.options?.headers
      if (headers) {
        for (const [key, value] of Object.entries(headers)) {
          request.res.setHeader(key, value)
        }
      }
      request.res.writeHead(request.options?.statusCode || 200)
    }

    try {
      request.res.write(payload)
    } catch {
      this._cleanupStreamRequest(streamId, true)
    }
  }

  private _handleStreamEnd(streamId: string): void {
    const request = this.streamRequests.get(streamId)
    if (!request) return
    try {
      request.res.end()
    } catch {
      this._cleanupStreamRequest(streamId, true)
      return
    }
    this._cleanupStreamRequest(streamId, false)
  }

  private _handleStreamError(streamId: string, errorMsg: string): void {
    const request = this.streamRequests.get(streamId)
    if (!request) return

    if (!request.res.headersSent) {
      request.res.writeHead(500, { 'Content-Type': 'application/json' })
      request.res.end(
        JSON.stringify({
          timestamp: Date.now(),
          status: 500,
          error: 'Worker Error',
          message: errorMsg,
          path: request.req.url
        })
      )
    } else {
      try {
        request.res.end()
      } catch {}
    }

    this._cleanupStreamRequest(streamId, false)
  }

  private _cleanupStreamRequest(streamId: string, sendCancel: boolean): void {
    const request = this.streamRequests.get(streamId)
    if (!request || request.cleaned) return
    request.cleaned = true

    if (request.timeout) clearTimeout(request.timeout)
    this.streamRequests.delete(streamId)

    if (sendCancel) {
      const worker = this.workersById.get(request.workerId)
      if (worker?.isConnected()) {
        this._sendStreamCommand(worker, {
          type: 'cancelStream',
          requestId: streamId,
          payload: { streamId }
        })
      }
    }
  }

  private _failStreamsForWorker(
    workerId: number,
    reason = 'Worker exited'
  ): void {
    const streamIds: string[] = []
    for (const [streamId, request] of this.streamRequests) {
      if (request.workerId !== workerId) continue
      streamIds.push(streamId)

      if (!request.res.headersSent) {
        request.res.writeHead(500, { 'Content-Type': 'application/json' })
        request.res.end(
          JSON.stringify({
            timestamp: Date.now(),
            status: 500,
            error: 'Worker Error',
            message: reason,
            path: request.req.url
          })
        )
      } else {
        request.res.end()
      }
    }

    for (const streamId of streamIds) {
      this._cleanupStreamRequest(streamId, false)
    }
  }

  private _sendWorkerCommand(
    worker: PlaybackWorker,
    type: string,
    requestId: string,
    payload: WorkerCommandPayload
  ): boolean {
    const message = v8.serialize({ type, payload })
    if (this._sendCommandSocketFrame(worker.id, 1, requestId, message)) {
      return true
    }
    if (!worker?.isConnected()) return false
    worker.send({ type, requestId, payload })
    return true
  }

  private _sendStreamCommand(
    worker: PlaybackWorker,
    msg: StreamWorkerCommand
  ): boolean {
    if (!worker?.isConnected() && !this.commandSockets.has(worker.id))
      return false
    if (this.workerReady.has(worker.id)) {
      return this._sendWorkerCommand(
        worker,
        msg.type,
        msg.requestId,
        msg.payload
      )
    }

    let attempts = 0
    const checkReady = setInterval(() => {
      attempts++
      if (!worker.isConnected() && !this.commandSockets.has(worker.id)) {
        clearInterval(checkReady)
        return
      }
      if (this.workerReady.has(worker.id)) {
        clearInterval(checkReady)
        this._sendWorkerCommand(worker, msg.type, msg.requestId, msg.payload)
      } else if (attempts > 50) {
        clearInterval(checkReady)
      }
    }, 100)
    return true
  }

  forkWorker(): PlaybackWorker | null {
    if (this.workers.length >= this.maxWorkers) {
      logger(
        'warn',
        'Cluster',
        `Cannot fork new worker: maximum worker limit (${this.maxWorkers}) reached.`
      )
      return null
    }

    const execArgv = buildWorkerExecArgv(this.config)
    cluster.setupPrimary({
      exec: resolveExecPath(),
      ...(execArgv.length > 0 ? { execArgv } : {})
    })
    const worker = cluster.fork({
      EVENT_SOCKET_PATH: this.socketPath,
      COMMAND_SOCKET_PATH: this.commandSocketPath,
      WORKER_TYPE: 'playback'
    }) as PlaybackWorker
    worker.workerType = 'playback'
    worker.send({ type: 'clusterId', clusterId: worker.id })
    worker.ready = false

    this.workers.push(worker)
    this.workersById.set(worker.id, worker)
    this.workerLoad.set(worker.id, 0)

    this.workerStats.set(worker.id, { players: 0, playingPlayers: 0 })

    this.workerToGuilds.set(worker.id, new Set())
    this.workerHealth.set(worker.id, Date.now())
    this.workerStartTime.set(worker.id, Date.now())
    this.workerUniqueId.set(worker.id, this.nextWorkerId++)
    this.workerFailureHistory.set(worker.id, {
      count: 0,
      lastFailure: null,
      recentFailures: []
    })

    logger(
      'info',
      'Cluster',
      `Spawned worker ${worker.process.pid} (id: ${worker.id})`
    )

    worker.on('message', (msg: unknown) =>
      this._handleWorkerMessage(worker, msg)
    )

    worker.on('error', (error) => {
      logger('error', 'Cluster', `Worker ${worker.id} error: ${error.message}`)
    })

    return worker
  }

  removeWorker(workerId: number): void {
    const worker = this.workersById.get(workerId)
    if (!worker) return

    this._failStreamsForWorker(workerId)
    this._removeCommandSocketByWorkerId(workerId)

    const index = this.workers.indexOf(worker)
    if (index !== -1) this.workers.splice(index, 1)

    this.workersById.delete(workerId)
    this.workerReady.delete(workerId)
    this.workerLoad.delete(workerId)
    this.workerStats.delete(workerId)
    this.idleWorkers.delete(workerId)
    this.workerStartTime.delete(workerId)
    this.workerUniqueId.delete(workerId)

    const affectedGuilds = Array.from(this.workerToGuilds.get(workerId) || [])
    this.workerToGuilds.delete(workerId)

    for (const playerKey of affectedGuilds) {
      this.guildToWorker.delete(playerKey)
      logger(
        'warn',
        'Cluster',
        `Player ${playerKey} unassigned due to worker ${workerId} exit. Will be reassigned on next request.`
      )
    }

    if (affectedGuilds.length > 0) {
      const nodelink = getGlobalNodelink()
      if (nodelink) {
        for (const playerKey of affectedGuilds) {
          const [sessionId] = playerKey.split(':')
          if (!sessionId) continue
          const session = nodelink.sessions.get(sessionId)
          if (session?.players.players.delete(playerKey)) {
            logger(
              'debug',
              'Cluster',
              `Removed stale player placeholder for ${playerKey} from session ${session.id}`
            )
          }
        }

        nodelink.handleIPCMessage({
          type: 'workerFailed',
          payload: { workerId: worker.id, affectedGuilds }
        })
      }
    }

    try {
      worker.process.kill()
      logger(
        'info',
        'Cluster',
        `Terminated worker ${worker.process.pid} (id: ${worker.id})`
      )
    } catch (e: unknown) {
      logger(
        'error',
        'Cluster',
        `Failed to kill worker ${worker.process.pid}: ${getErrorMessage(e)}`
      )
    }
  }

  private _removeCommandSocketByWorkerId(workerId: number): void {
    const socket = this.commandSockets.get(workerId)
    if (!socket) return
    this.commandSockets.delete(workerId)
    try {
      socket.destroy()
    } catch {}
  }

  private _handleWorkerMessage(worker: PlaybackWorker, msg: unknown): void {
    if (!msg || typeof msg !== 'object') return
    const message = msg as {
      type?: unknown
      requestId?: unknown
      payload?: unknown
      error?: unknown
      stats?: unknown
      socketType?: unknown
    }
    if (
      message.type === 'commandResult' &&
      typeof message.requestId === 'string'
    ) {
      this._handleCommandResponse(
        message.requestId,
        message.payload,
        message.error
      )
    } else if (message.type === 'workerStats' && message.stats) {
      this.statsUpdateBatch.set(worker.id, message.stats as WorkerRuntimeStats)

      if (!this.statsUpdateTimer) {
        this.statsUpdateTimer = setTimeout(() => {
          this._flushStatsUpdates()
        }, 100)
      }
    } else if (message.type === 'pong') {
      this.workerHealth.set(worker.id, Date.now())
    } else if (message.type === 'ready') {
      worker.ready = true
      this.workerHealth.set(worker.id, Date.now())
      this.workerReady.add(worker.id)
      logger(
        'info',
        'Cluster',
        `Worker ${worker.id} (PID ${worker.process.pid}) ready`
      )

      if (
        this.liveYoutubeConfig.refreshToken ||
        this.liveYoutubeConfig.visitorData
      ) {
        logger(
          'info',
          'Cluster',
          `Syncing live YouTube config to new worker ${worker.id}`
        )
        this.execute(worker, 'updateYoutubeConfig', {
          ...this.liveYoutubeConfig
        }).catch((err: unknown) =>
          logger(
            'error',
            'Cluster',
            `Failed to sync config to worker ${worker.id}: ${getErrorMessage(err)}`
          )
        )
      }
    } else if (message.type === 'workerSocketDisconnected') {
      const socketType =
        typeof message.socketType === 'string' ? message.socketType : 'unknown'
      this._rotateSocketServers(socketType, worker.id)
    } else {
      const nodelink = getGlobalNodelink()
      nodelink?.handleIPCMessage(message)
    }
  }

  private _handleCommandResponse(
    requestId: string,
    payload: unknown,
    error?: unknown
  ): void {
    const callback = this.pendingRequests.get(requestId)
    if (!callback) return
    clearTimeout(callback.timeout)
    this.pendingRequests.delete(requestId)
    if (error) callback.reject(new Error(String(error)))
    else callback.resolve(payload)
  }

  setLiveYoutubeConfig(config: Partial<LiveYoutubeConfig>): void {
    if (config.refreshToken)
      this.liveYoutubeConfig.refreshToken = config.refreshToken
    if (config.visitorData)
      this.liveYoutubeConfig.visitorData = config.visitorData
  }

  private _flushStatsUpdates(): void {
    for (const [workerId, stats] of this.statsUpdateBatch) {
      const players = stats.players ?? 0
      this.workerLoad.set(workerId, players)
      this.workerStats.set(workerId, stats)

      if (players === 0 && !this.idleWorkers.has(workerId)) {
        this.idleWorkers.set(workerId, Date.now())
      } else if (players > 0) {
        this.idleWorkers.delete(workerId)
      }
    }

    this.statsUpdateBatch.clear()
    this.statsUpdateTimer = null
  }

  getWorkerForGuild(playerKey: string): PlaybackWorker {
    if (this.guildToWorker.has(playerKey)) {
      const workerId = this.guildToWorker.get(playerKey)
      if (workerId === undefined) {
        this.guildToWorker.delete(playerKey)
      }
      if (workerId === undefined) {
        return this.getBestWorker()
      }
      const worker = this.workersById.get(workerId)

      if (worker?.isConnected()) return worker

      this.guildToWorker.delete(playerKey)
      this.workerToGuilds.get(workerId)?.delete(playerKey)
    }

    if (this.workers.length === 0 && this.maxWorkers > 0) {
      const worker = this.forkWorker()
      if (!worker) {
        throw new Error('No workers available and cannot fork new ones.')
      }
      this.assignGuildToWorker(playerKey, worker)
      return worker
    }

    let bestWorker: PlaybackWorker | null = null
    let minCost = Number.POSITIVE_INFINITY

    for (const worker of this.workers) {
      if (worker.isConnected()) {
        const cost = this._calculateWorkerCost(worker.id)
        if (cost < minCost) {
          minCost = cost
          bestWorker = worker
        }
      }
    }

    const threshold = this.scalingConfig.maxPlayersPerWorker
    const hasConnectedWorker = !!bestWorker

    if (
      hasConnectedWorker &&
      minCost >= threshold &&
      this.workers.length < this.maxWorkers
    ) {
      logger(
        'debug',
        'Cluster',
        `Best worker is saturated (Cost: ${minCost.toFixed(2)}). Forking new worker.`
      )
      const newWorker = this.forkWorker()
      if (newWorker) {
        this.assignGuildToWorker(playerKey, newWorker)
        return newWorker
      }
    }

    if (!hasConnectedWorker && this.workers.length > 0) {
      const bootstrappingWorker = this.workers[0]
      if (!bootstrappingWorker) {
        throw new Error('No workers available and cannot fork new ones.')
      }
      this.assignGuildToWorker(playerKey, bootstrappingWorker)
      return bootstrappingWorker
    }

    if (!bestWorker) {
      bestWorker = this.forkWorker()
      if (!bestWorker) {
        throw new Error('No workers available and cannot fork new ones.')
      }
    }

    // Warning logs if system is squeezed
    if (minCost >= threshold) {
      if (this.workers.length >= this.maxWorkers) {
        logger(
          'warn',
          'Cluster',
          '\x1b[31m! THIS SERVER IS OPERATING AT CRITICAL CAPACITY !\x1b[0m'
        )
        logger(
          'warn',
          'Cluster',
          '\x1b[31mIt is EXTREMELY RECOMMENDED that you scale your instance.\x1b[0m'
        )
        logger(
          'warn',
          'Cluster',
          '\x1b[31mIf this client serves a large volume of users or multiple bots, it is time to implement a server mesh for better performance.\x1b[0m'
        )
      } else {
        logger(
          'warn',
          'Cluster',
          `Worker #${bestWorker.id} is operating under heavy load (squeezed) :p`
        )
      }
    }

    this.assignGuildToWorker(playerKey, bestWorker)
    return bestWorker
  }

  getBestWorker(): PlaybackWorker {
    if (this.workers.length === 0) {
      const worker = this.forkWorker()
      if (!worker) {
        throw new Error('No workers available and cannot fork new ones.')
      }
      return worker
    }

    let bestWorker: PlaybackWorker | null = null
    let minLoad = Number.POSITIVE_INFINITY

    for (const worker of this.workers) {
      if (worker.isConnected()) {
        const load = this.workerLoad.get(worker.id) || 0
        if (load < minLoad) {
          minLoad = load
          bestWorker = worker
        }
      }
    }

    if (bestWorker) return bestWorker

    if (this.workers.length > 0) {
      // Reuse already spawned workers during startup to avoid over-forking.
      const firstWorker = this.workers[0]
      if (firstWorker) return firstWorker
    }

    const worker = this.forkWorker()
    if (!worker) {
      throw new Error('No workers available and cannot fork new ones.')
    }
    return worker
  }

  assignGuildToWorker(playerKey: string, worker: PlaybackWorker): void {
    this.guildToWorker.set(playerKey, worker.id)

    if (!this.workerToGuilds.has(worker.id)) {
      this.workerToGuilds.set(worker.id, new Set())
    }
    this.workerToGuilds.get(worker.id)?.add(playerKey)

    logger(
      'debug',
      'Cluster',
      `Assigned player ${playerKey} to worker ${worker.id}`
    )
  }

  unassignGuild(playerKey: string): void {
    const workerId = this.guildToWorker.get(playerKey)
    this.guildToWorker.delete(playerKey)

    if (workerId && this.workerToGuilds.has(workerId)) {
      this.workerToGuilds.get(workerId)?.delete(playerKey)
    }
  }

  isGuildAssigned(playerKey: string): boolean {
    return this.guildToWorker.has(playerKey)
  }

  private _ensureWorkerAvailability(): void {
    const neededWorkers = Math.max(this.minWorkers - this.workers.length, 0)

    for (
      let i = 0;
      i < neededWorkers && this.workers.length < this.maxWorkers;
      i++
    ) {
      logger(
        'info',
        'Cluster',
        `Forking worker ${this.workers.length + 1}/${this.minWorkers}`
      )
      this.forkWorker()
    }
  }

  /**
   * Gets worker metrics for all active workers.
   * @returns {Record<string, import('../typings/api/stats.types.ts').WorkerMetricsEntry>}
   */
  getWorkerMetrics(): Record<string, WorkerMetricsEntry> {
    const workerMetrics: Record<string, WorkerMetricsEntry> = {}
    const now = Date.now()

    for (const worker of this.workers) {
      if (!worker.isConnected()) continue

      const workerId = worker.id
      const uniqueId = this.workerUniqueId.get(workerId) || workerId
      const pid = worker.process.pid
      const stats: WorkerRuntimeStats = this.workerStats.get(workerId) || {}
      const lastHealthCheck = this.workerHealth.get(workerId) || 0
      const startTime = this.workerStartTime.get(workerId) || now
      const uptimeSeconds = Math.floor((now - startTime) / 1000)
      const isHealthy = now - lastHealthCheck < 30000

      workerMetrics[String(uniqueId)] = {
        clusterId: workerId,
        pid,
        stats,
        health: isHealthy,
        uptime: uptimeSeconds
      }
    }

    return workerMetrics
  }

  destroy(): void {
    this.isDestroying = true
    this._stopScalingCheck()
    this._stopHealthCheck()

    if (this.statsUpdateTimer) {
      clearTimeout(this.statsUpdateTimer)
      this._flushStatsUpdates()
    }

    this.pendingRequests.clear()
    this.workerFailureHistory.clear()
    this.statsUpdateBatch.clear()
    this.workerHealth.clear()
    this.workerStartTime.clear()
    this.workerUniqueId.clear()
    this.idleWorkers.clear()

    for (const worker of this.workers) {
      if (worker.isConnected()) {
        worker.process.kill()
      } else {
        logger(
          'debug',
          'Cluster',
          `Worker ${worker.id} is not connected, skipping kill.`
        )
      }
    }

    const streamIds: string[] = []
    for (const [streamId, request] of this.streamRequests) {
      streamIds.push(streamId)
      if (!request.res.headersSent) {
        request.res.writeHead(503, { 'Content-Type': 'application/json' })
        request.res.end(
          JSON.stringify({
            timestamp: Date.now(),
            status: 503,
            error: 'Service Unavailable',
            message: 'Server shutting down.',
            path: request.req.url
          })
        )
      } else {
        request.res.end()
      }
    }

    for (const streamId of streamIds) {
      this._cleanupStreamRequest(streamId, false)
    }

    for (const socket of this.commandSockets.values()) {
      try {
        socket.destroy()
      } catch {}
    }
    this.commandSockets.clear()

    for (const socket of this.eventSockets.values()) {
      try {
        socket.destroy()
      } catch {}
    }
    this.eventSockets.clear()

    if (this.server) {
      try {
        this.server.close()
      } catch {}
      this.server = null
    }

    if (this.commandServer) {
      try {
        this.commandServer.close()
      } catch {}
      this.commandServer = null
    }

    this._safeUnlinkSocketPath(this.socketPath)
    this._safeUnlinkSocketPath(this.commandSocketPath)

    logger(
      'info',
      'Cluster',
      'WorkerManager destroyed. All workers terminated.'
    )
  }

  delegateStream(
    req: DelegatedRequest,
    res: DelegatedResponse,
    payload: Record<string, unknown>,
    options: StreamDelegateOptions = {}
  ): boolean {
    const worker = this.getBestWorker()
    if (!worker) return false

    const streamId = crypto.randomBytes(16).toString('hex')
    const request: StreamRequestEntry = {
      id: streamId,
      req,
      res,
      workerId: worker.id,
      options,
      timeout: null,
      cleaned: false
    }

    request.timeout = setTimeout(() => {
      const activeRequest = this.streamRequests.get(streamId)
      if (activeRequest) {
        res.writeHead(504, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            error: 'Gateway Timeout',
            message: 'Stream worker timed out'
          })
        )
        this._cleanupStreamRequest(streamId, true)
      }
    }, 60000)

    this.streamRequests.set(streamId, request)

    res.on('close', () => {
      this._cleanupStreamRequest(streamId, true)
    })

    this._sendStreamCommand(worker, {
      type: 'loadStream',
      requestId: streamId,
      payload: {
        ...payload,
        streamId
      }
    })

    return true
  }

  execute<T = unknown>(
    worker: PlaybackWorker,
    type: string,
    payload: WorkerCommandPayload,
    options: ExecuteOptions = {}
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this._executeCommand(
        worker,
        type,
        payload,
        (result) => resolve(result as T),
        reject,
        0,
        options.fast || false,
        options.timeoutMs
      )
    })
  }

  private _executeCommand(
    worker: PlaybackWorker,
    type: string,
    payload: WorkerCommandPayload,
    resolve: (result: unknown) => void,
    reject: (error: Error) => void,
    retryCount: number,
    isFast: boolean,
    timeoutOverride?: number
  ): void {
    const requestId = crypto.randomBytes(16).toString('hex')
    const timeoutMs =
      typeof timeoutOverride === 'number' &&
      Number.isFinite(timeoutOverride) &&
      timeoutOverride > 0
        ? timeoutOverride
        : isFast
          ? this.fastCommandTimeout
          : this.commandTimeout
    const startTime = Date.now()

    const timeout = setTimeout(() => {
      this.pendingRequests.delete(requestId)

      const nodelink = getGlobalNodelink()
      if (nodelink?.statsManager?.incrementCommandTimeout) {
        nodelink.statsManager.incrementCommandTimeout(type)
      }

      if (
        retryCount < this.maxRetries &&
        (worker.isConnected() || this.commandSockets.has(worker.id))
      ) {
        logger(
          'warn',
          'Cluster',
          `Command timeout (${timeoutMs}ms) for command '${type}' with payload:`,
          payload,
          `, retrying... (${retryCount + 1}/${this.maxRetries})`
        )

        if (nodelink?.statsManager?.incrementCommandRetry) {
          nodelink.statsManager.incrementCommandRetry(type)
        }

        setTimeout(() => {
          const newWorker = this.getBestWorker() || worker
          this._executeCommand(
            newWorker,
            type,
            payload,
            resolve,
            reject,
            retryCount + 1,
            isFast,
            timeoutOverride
          )
        }, 500)
      } else {
        reject(
          new Error(`Worker command timeout after ${retryCount + 1} attempts`)
        )
      }
    }, timeoutMs)

    this.pendingRequests.set(requestId, {
      resolve: (result) => {
        const duration = Date.now() - startTime
        const nodelink = getGlobalNodelink()
        if (nodelink?.statsManager?.recordCommandExecutionTime) {
          nodelink.statsManager.recordCommandExecutionTime(
            type,
            worker.id,
            duration
          )
        }
        resolve(result)
      },
      reject,
      timeout,
      workerId: worker.id,
      type,
      payload,
      retryCount,
      isFast,
      startTime
    })

    try {
      if (!worker.isConnected() && !this.commandSockets.has(worker.id)) {
        clearTimeout(timeout)
        this.pendingRequests.delete(requestId)

        if (retryCount < this.maxRetries) {
          const newWorker = this.getBestWorker()
          if (newWorker) {
            this._executeCommand(
              newWorker,
              type,
              payload,
              resolve,
              reject,
              retryCount + 1,
              isFast,
              timeoutOverride
            )
          } else {
            reject(new Error('No workers available for retry'))
          }
        } else {
          reject(new Error('Worker disconnected and max retries reached'))
        }
        return
      }

      if (!this.workerReady.has(worker.id)) {
        logger(
          'debug',
          'Cluster',
          `Waiting for worker ${worker.id} to be ready before sending ${type}`
        )
        let attempts = 0
        const checkReady = setInterval(() => {
          attempts++
          if (
            this.workerReady.has(worker.id) ||
            (!worker.isConnected() && !this.commandSockets.has(worker.id))
          ) {
            clearInterval(checkReady)
            if (
              this.workerReady.has(worker.id) &&
              (worker.isConnected() || this.commandSockets.has(worker.id))
            ) {
              if (!this._sendWorkerCommand(worker, type, requestId, payload)) {
                clearTimeout(timeout)
                this.pendingRequests.delete(requestId)
                reject(new Error('No transport available for worker command'))
              }
            }
          } else if (attempts > 50) {
            clearInterval(checkReady)
            clearTimeout(timeout)
            this.pendingRequests.delete(requestId)

            if (retryCount < this.maxRetries) {
              logger(
                'warn',
                'Cluster',
                `Worker ${worker.id} did not become ready in time for '${type}', retrying... (${retryCount + 1}/${this.maxRetries})`
              )
              const nodelink = getGlobalNodelink()
              if (nodelink?.statsManager?.incrementCommandRetry) {
                nodelink.statsManager.incrementCommandRetry(type)
              }
              setTimeout(() => {
                const newWorker = this.getBestWorker() || worker
                this._executeCommand(
                  newWorker,
                  type,
                  payload,
                  resolve,
                  reject,
                  retryCount + 1,
                  isFast,
                  timeoutOverride
                )
              }, 500)
            } else {
              reject(
                new Error(
                  `Worker did not become ready for command '${type}' after ${this.maxRetries + 1} attempts`
                )
              )
            }
          }
        }, 100)
        return
      }

      if (!this._sendWorkerCommand(worker, type, requestId, payload)) {
        throw new Error('No transport available for worker command')
      }
    } catch (error: unknown) {
      clearTimeout(timeout)
      this.pendingRequests.delete(requestId)

      if (retryCount < this.maxRetries) {
        logger(
          'error',
          'Cluster',
          `Send error: ${getErrorMessage(error)}, retrying...`
        )
        const nodelink = getGlobalNodelink()
        if (nodelink?.statsManager?.incrementCommandRetry) {
          nodelink.statsManager.incrementCommandRetry(type)
        }
        setTimeout(() => {
          const newWorker = this.getBestWorker()
          if (newWorker) {
            this._executeCommand(
              newWorker,
              type,
              payload,
              resolve,
              reject,
              retryCount + 1,
              isFast,
              timeoutOverride
            )
          } else {
            reject(
              error instanceof Error ? error : new Error(getErrorMessage(error))
            )
          }
        }, 500)
      } else {
        reject(
          error instanceof Error ? error : new Error(getErrorMessage(error))
        )
      }
    }
  }
}
