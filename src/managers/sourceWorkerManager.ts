import cluster from 'node:cluster'
import crypto from 'node:crypto'
import fs from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { logger } from '../utils.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * Minimal NodeLink context consumed by SourceWorkerManager.
 */
interface SourceWorkerManagerContext {
  options: {
    cluster?: {
      runtime?: {
        sourceWorkerMaxOldSpaceMb?: unknown
        sourceWorkerExposeGc?: unknown
        sourceWorkerExecArgv?: unknown
      }
      specializedSourceWorker?: {
        count?: number
        scaleUpThreshold?: number
        scaleCooldownMs?: number
      }
    }
  }
}

/**
 * Cluster worker extended with source-worker metadata.
 */
interface SourceClusterWorker extends cluster.Worker {
  workerType?: 'source'
}

type SourceTaskType =
  | 'resolve'
  | 'search'
  | 'unifiedSearch'
  | 'loadLyrics'
  | 'loadMeaning'
  | 'loadChapters'
  | 'loadStream'
  | 'loadLiveChat'
  | 'cancelLiveChat'
  | 'profilerCommand'

/**
 * HTTP-like request shape accepted by delegate methods.
 */
interface DelegatedRequest {
  url?: string
}

/**
 * HTTP-like response shape accepted by delegate methods.
 */
interface DelegatedResponse {
  headersSent: boolean
  setHeader?(name: string, value: string): void
  writeHead(statusCode: number, headers?: Record<string, string>): void
  write(chunk: Buffer): void
  end(chunk?: string | Buffer): void
  send?(chunk: Buffer): void
  on?(event: 'close', listener: () => void): void
}

/**
 * Delegation options for HTTP/websocket behavior.
 */
interface DelegateOptions {
  statusCode?: number
  headers?: Record<string, string>
  isWebSocket?: boolean
}

/**
 * Internal options used by execute-on-worker helpers.
 */
interface ExecuteOptions extends DelegateOptions {
  timeoutMs?: number
  parseJson?: boolean
}

/**
 * Tracked request state while a source task is active.
 */
interface SourceRequestEntry {
  req: IncomingMessage | DelegatedRequest
  res: ServerResponse | DelegatedResponse
  task: SourceTaskType | string
  timeout: NodeJS.Timeout | null
  workerId: number
  options: DelegateOptions
  cleaned: boolean
}

type ExecuteAllResultEntry =
  | { clusterId: number; pid: number | null; response: unknown }
  | { clusterId: number; pid: number | null; error: string }

const hasSocketSend = (
  res: ServerResponse | DelegatedResponse
): res is DelegatedResponse & { send: (chunk: Buffer) => void } =>
  !!(res as DelegatedResponse).send

type InternalResponse = {
  headersSent: boolean
  setHeader: (_name: string, _value: string) => void
  writeHead: (code: number) => void
  write: (chunk?: Buffer | string) => void
  end: (chunk?: Buffer | string) => void
  on: (_event: string, _listener?: (...args: unknown[]) => void) => void
}

interface SourceWorkerEnv {
  NODELINK_SOURCE_WORKER_MAX_OLD_SPACE_MB?: string
  NODELINK_SOURCE_WORKER_EXPOSE_GC?: string
  NODELINK_SOURCE_WORKER_EXEC_ARGV?: string
}

const resolvePlaybackExecPath = () => {
  const distIndex = path.resolve(__dirname, '../index.js')
  if (fs.existsSync(distIndex)) return distIndex
  return path.resolve(process.cwd(), 'src/index.ts')
}

const resolveSourceExecPath = () => {
  const distSourceWorker = path.resolve(__dirname, '../workers/source.js')
  if (fs.existsSync(distSourceWorker)) return distSourceWorker
  return path.resolve(process.cwd(), 'src/workers/source.ts')
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

const buildSourceWorkerExecArgv = (
  options: SourceWorkerManagerContext['options'] | null = null
): string[] => {
  const args = new Set(process.execArgv || [])
  const runtime = options?.cluster?.runtime || {}
  const env = process.env as NodeJS.ProcessEnv & SourceWorkerEnv

  for (const arg of Array.from(args)) {
    if (arg.startsWith('--max-old-space-size=') || arg === '--expose-gc')
      args.delete(arg)
  }

  const maxOldSpaceMb = parsePositiveInt(
    env.NODELINK_SOURCE_WORKER_MAX_OLD_SPACE_MB ??
      runtime.sourceWorkerMaxOldSpaceMb ??
      0
  )
  if (maxOldSpaceMb > 0) {
    args.add(`--max-old-space-size=${maxOldSpaceMb}`)
  }

  const exposeGc =
    parseBool(env.NODELINK_SOURCE_WORKER_EXPOSE_GC) ||
    parseBool(runtime.sourceWorkerExposeGc)
  if (exposeGc) {
    args.add('--expose-gc')
  }

  const configExtraArgs = parseExecArgv(runtime.sourceWorkerExecArgv)
  for (const arg of configExtraArgs) {
    args.add(arg)
  }

  const envExtraArgs = parseExecArgv(env.NODELINK_SOURCE_WORKER_EXEC_ARGV)
  for (const arg of envExtraArgs) {
    args.add(arg)
  }

  return Array.from(args)
}

class SourceWorkerManager {
  private nodelink: SourceWorkerManagerContext
  private workers: SourceClusterWorker[]
  private requests: Map<string, SourceRequestEntry>
  private workerLoads: Map<number, number>
  private maxWorkers: number
  private scaleUpThreshold: number
  private scaleCooldownMs: number
  private lastScaleUpAt: number
  private socketPath: string
  private server: net.Server | null
  private isDestroying: boolean
  private _onClusterExit:
    | ((
        worker: SourceClusterWorker,
        _code: number | null,
        _signal: string | null
      ) => void)
    | null
  private clientSockets: Set<net.Socket>

  constructor(nodelink: SourceWorkerManagerContext) {
    this.nodelink = nodelink
    this.workers = []
    this.requests = new Map()
    this.workerLoads = new Map() // worker.id -> pending count
    this.maxWorkers = Math.max(
      1,
      nodelink.options.cluster?.specializedSourceWorker?.count || 1
    )
    this.scaleUpThreshold =
      nodelink.options.cluster?.specializedSourceWorker?.scaleUpThreshold || 30
    this.scaleCooldownMs =
      nodelink.options.cluster?.specializedSourceWorker?.scaleCooldownMs || 1500
    this.lastScaleUpAt = 0
    this.socketPath =
      os.platform() === 'win32'
        ? `\\\\.\\pipe\\nodelink-source-${crypto.randomBytes(8).toString('hex')}`
        : `/tmp/nodelink-source-${crypto.randomBytes(8).toString('hex')}.sock`
    this.server = null
    this.isDestroying = false
    this._onClusterExit = null
    this.clientSockets = new Set()
  }

  private _safeUnlinkSocketPath(): void {
    if (!this.socketPath || os.platform() === 'win32') return
    try {
      if (fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath)
    } catch {}
  }

  async start(): Promise<void> {
    this._safeUnlinkSocketPath()
    this.server = net.createServer((socket) => {
      this.clientSockets.add(socket)
      const frameChunks: Buffer[] = []
      let frameBytes = 0

      socket.on('error', () => {
        // Ignore per-connection transport errors (EPIPE/ECONNRESET).
      })
      socket.on('close', () => {
        this.clientSockets.delete(socket)
      })

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

      socket.on('data', (chunk: Buffer) => {
        if (!chunk.length) return
        frameChunks.push(chunk)
        frameBytes += chunk.length

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

          const request = this.requests.get(id)
          if (request) {
            if (type === 0) {
              if (request.timeout) {
                clearTimeout(request.timeout)
                request.timeout = null
              }

              if (!request.res.headersSent) {
                const headers = request.options?.headers
                if (headers) {
                  for (const [key, value] of Object.entries(headers)) {
                    request.res.setHeader?.(key, value)
                  }
                } else {
                  request.res.setHeader?.('Content-Type', 'application/json')
                }
                request.res.writeHead(request.options?.statusCode || 200)
              }
              try {
                request.res.write(payload)
              } catch {
                this._cleanupRequest(id, request)
              }
            } else if (type === 1) {
              try {
                request.res.end()
              } catch {}
              this._cleanupRequest(id, request)
            } else if (type === 3) {
              if (request.timeout) {
                clearTimeout(request.timeout)
                request.timeout = null
              }

              if (!request.res.headersSent && request.options?.isWebSocket) {
                if (hasSocketSend(request.res)) {
                  request.res.send(payload)
                } else {
                  request.res.write(payload)
                }
              } else if (!request.res.headersSent) {
                request.res.setHeader?.('Content-Type', 'application/json')
                request.res.writeHead(200)
                try {
                  request.res.write(payload)
                } catch {
                  this._cleanupRequest(id, request)
                }
              } else {
                try {
                  request.res.write(payload)
                } catch {
                  this._cleanupRequest(id, request)
                }
              }
            } else if (type === 2) {
              const errorMsg = payload.toString('utf8')
              if (!request.res.headersSent) {
                request.res.writeHead(500, {
                  'Content-Type': 'application/json'
                })
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
                request.res.end()
              }
              this._cleanupRequest(id, request)
            }
          }
        }
      })
    })

    await new Promise<void>((resolve, reject) => {
      const server = this.server
      if (!server) {
        reject(new Error('Source socket server was not initialized'))
        return
      }

      server.on('error', (err: Error) => {
        logger('error', 'SourceCluster', `Server error: ${err.message}`)
        reject(err)
      })
      server.listen(this.socketPath, () => {
        logger(
          'info',
          'SourceCluster',
          `Source server listening at ${this.socketPath}`
        )
        resolve()
      })
    })

    const sourceExecArgv = buildSourceWorkerExecArgv(this.nodelink.options)
    cluster.setupPrimary({
      exec: resolveSourceExecPath(),
      ...(sourceExecArgv.length > 0 ? { execArgv: sourceExecArgv } : {})
    })
    // Start with one source worker and scale up based on demand.
    this._forkWorker()

    cluster.setupPrimary({ exec: resolvePlaybackExecPath() })

    this._onClusterExit = (worker, _code, _signal) => {
      if (worker.workerType !== 'source') return
      if (this.isDestroying) return

      logger(
        'warn',
        'SourceCluster',
        `Source worker manager ${worker.process.pid} exited. Respawning...`
      )
      const index = this.workers.indexOf(worker)
      this.workers.splice(index, 1)
      this.workerLoads.delete(worker.id)

      // Keep at least one source worker alive.
      if (this.workers.length === 0) {
        cluster.setupPrimary({
          exec: resolveSourceExecPath(),
          ...(sourceExecArgv.length > 0 ? { execArgv: sourceExecArgv } : {})
        })
        this._forkWorker()
        cluster.setupPrimary({ exec: resolvePlaybackExecPath() })
      } else {
        this._tryScaleUp(true)
      }
    }
    cluster.on('exit', this._onClusterExit)
  }

  private _forkWorker(): void {
    const worker = cluster.fork({
      WORKER_TYPE: 'source'
    }) as SourceClusterWorker

    worker.workerType = 'source'
    worker.on('message', (msg: { type?: string; pid?: number }) => {
      if (msg.type === 'ready')
        logger(
          'info',
          'SourceCluster',
          `Source worker manager ${msg.pid} ready`
        )
    })
    worker.on('error', (err: Error) => {
      logger(
        'error',
        'SourceCluster',
        `Source worker ${worker.id} error: ${err.message}`
      )
    })
    this.workers.push(worker)
    this.workerLoads.set(worker.id, 0)
  }

  private _decrementLoad(workerId: number): void {
    const load = this.workerLoads.get(workerId) || 0
    this.workerLoads.set(workerId, Math.max(0, load - 1))
    this._tryScaleUp(false)
  }

  private _getTotalLoad(): number {
    let total = 0
    for (const load of this.workerLoads.values()) {
      total += load || 0
    }
    return total
  }

  private _tryScaleUp(force = false): boolean {
    if (this.isDestroying) return false
    if (this.workers.length >= this.maxWorkers) return false

    const now = Date.now()
    if (!force && now - this.lastScaleUpAt < this.scaleCooldownMs) return false

    const totalLoad = this._getTotalLoad()
    const threshold = this.workers.length * this.scaleUpThreshold

    if (!force && totalLoad <= threshold) return false

    const sourceExecArgv = buildSourceWorkerExecArgv(this.nodelink.options)
    cluster.setupPrimary({
      exec: resolveSourceExecPath(),
      ...(sourceExecArgv.length > 0 ? { execArgv: sourceExecArgv } : {})
    })
    this._forkWorker()
    cluster.setupPrimary({ exec: resolvePlaybackExecPath() })
    this.lastScaleUpAt = now

    logger(
      'info',
      'SourceCluster',
      `Scaling up source workers: ${this.workers.length}/${this.maxWorkers} (load=${totalLoad}, threshold=${threshold})`
    )
    return true
  }

  destroy(): void {
    this.isDestroying = true

    if (this._onClusterExit) {
      try {
        cluster.off('exit', this._onClusterExit)
      } catch {}
      this._onClusterExit = null
    }

    for (const request of this.requests.values()) {
      try {
        if (request.timeout) clearTimeout(request.timeout)
      } catch {}
      try {
        if (!request.res.headersSent) {
          request.res.writeHead(503, { 'Content-Type': 'application/json' })
          request.res.end(
            JSON.stringify({
              timestamp: Date.now(),
              status: 503,
              error: 'Service Unavailable',
              message: 'Source worker manager shutting down.',
              path: request.req?.url
            })
          )
        } else {
          request.res.end()
        }
      } catch {}
    }
    this.requests.clear()
    this.workerLoads.clear()

    for (const socket of this.clientSockets) {
      try {
        socket.destroy()
      } catch {}
    }
    this.clientSockets.clear()

    if (this.server) {
      try {
        this.server.close()
      } catch {}
      this.server = null
    }

    this._safeUnlinkSocketPath()

    for (const worker of this.workers) {
      try {
        if (worker?.isConnected()) worker.process.kill()
      } catch {}
    }
    this.workers = []
  }

  private _cleanupRequest(id: string, request: SourceRequestEntry): void {
    if (!request || request.cleaned) return
    request.cleaned = true
    if (request.timeout) clearTimeout(request.timeout)

    if (request.task === 'loadLiveChat') {
      const worker = this.workers.find((w) => w.id === request.workerId)
      if (worker) {
        worker.send({
          type: 'sourceTask',
          payload: {
            task: 'cancelLiveChat',
            payload: { id }
          }
        })
      }
    }

    this._decrementLoad(request.workerId)
    this.requests.delete(id)
  }

  delegate(
    req: IncomingMessage | DelegatedRequest,
    res: ServerResponse | DelegatedResponse,
    task: SourceTaskType | string,
    payload: unknown,
    options: DelegateOptions = {}
  ): boolean {
    const id = crypto.randomBytes(16).toString('hex')

    let bestWorker: SourceClusterWorker | null = null
    let minLoad = Number.POSITIVE_INFINITY

    for (const worker of this.workers) {
      const load = this.workerLoads.get(worker.id) || 0
      if (load < minLoad) {
        minLoad = load
        bestWorker = worker
      }
    }

    if (!bestWorker) return false

    const request: SourceRequestEntry = {
      req,
      res,
      task,
      timeout: null,
      workerId: bestWorker.id,
      options,
      cleaned: false
    }

    request.timeout = setTimeout(() => {
      const activeRequest = this.requests.get(id)
      if (activeRequest) {
        res.writeHead(504, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            error: 'Gateway Timeout',
            message: 'Source worker timed out'
          })
        )
        this._cleanupRequest(id, activeRequest)
      }
    }, 60000)

    this.requests.set(id, request)
    this.workerLoads.set(bestWorker.id, minLoad + 1)
    this._tryScaleUp(false)

    res.on?.('close', () => {
      this._cleanupRequest(id, request)
    })

    bestWorker.send({
      type: 'sourceTask',
      payload: {
        id,
        task,
        payload,
        socketPath: this.socketPath
      }
    })

    return true
  }

  private _createInternalResponse(
    resolve: (value: unknown) => void,
    reject: (reason: Error) => void,
    parseJson: boolean
  ): InternalResponse {
    let statusCode = 200
    const chunks: Buffer[] = []

    return {
      headersSent: false,
      setHeader() {},
      writeHead(code: number) {
        statusCode = code
        this.headersSent = true
      },
      write(chunk?: Buffer | string) {
        if (chunk)
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      },
      end(chunk?: Buffer | string) {
        if (chunk)
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        const raw = Buffer.concat(chunks).toString('utf8')
        if (statusCode >= 400) {
          reject(
            new Error(raw || `Source worker returned status ${statusCode}`)
          )
          return
        }

        if (!parseJson) {
          resolve(raw)
          return
        }

        if (!raw) {
          resolve(null)
          return
        }

        try {
          resolve(JSON.parse(raw))
        } catch {
          resolve(raw)
        }
      },
      on() {}
    }
  }

  private _executeOnWorker(
    worker: SourceClusterWorker,
    task: SourceTaskType | string,
    payload: unknown,
    options: ExecuteOptions = {}
  ): Promise<unknown> {
    const id = crypto.randomBytes(16).toString('hex')
    const timeoutCandidate = options.timeoutMs
    const timeoutMs =
      typeof timeoutCandidate === 'number' &&
      Number.isFinite(timeoutCandidate) &&
      timeoutCandidate > 0
        ? timeoutCandidate
        : 60000
    const parseJson = options.parseJson !== false

    return new Promise((resolve, reject) => {
      const res = this._createInternalResponse(resolve, reject, parseJson)
      const req = { url: '/internal/source-worker-task' }
      const request: SourceRequestEntry = {
        req,
        res,
        task,
        timeout: null,
        workerId: worker.id,
        options,
        cleaned: false
      }

      request.timeout = setTimeout(() => {
        const activeRequest = this.requests.get(id)
        if (!activeRequest) return
        this._cleanupRequest(id, activeRequest)
        reject(new Error(`Source worker task '${task}' timed out`))
      }, timeoutMs)

      this.requests.set(id, request)
      const currentLoad = this.workerLoads.get(worker.id) || 0
      this.workerLoads.set(worker.id, currentLoad + 1)
      this._tryScaleUp(false)

      worker.send({
        type: 'sourceTask',
        payload: {
          id,
          task,
          payload,
          socketPath: this.socketPath
        }
      })
    })
  }

  async executeAll(
    task: SourceTaskType | string,
    payload: unknown,
    options: ExecuteOptions = {}
  ): Promise<ExecuteAllResultEntry[]> {
    const targets = this.workers.filter((worker) => worker?.isConnected?.())
    const settled = await Promise.allSettled(
      targets.map((worker) =>
        this._executeOnWorker(worker, task, payload, options).then(
          (response) => ({
            clusterId: worker.id,
            pid: worker.process?.pid || null,
            response
          })
        )
      )
    )

    return settled.map((entry, index) => {
      const worker = targets[index]
      if (!worker) {
        return {
          clusterId: -1,
          pid: null,
          error: 'Unknown source worker'
        }
      }

      if (entry.status === 'fulfilled') return entry.value
      return {
        clusterId: worker.id,
        pid: worker.process?.pid || null,
        error:
          entry.reason instanceof Error
            ? entry.reason.message
            : String(entry.reason)
      }
    })
  }
}

export default SourceWorkerManager
