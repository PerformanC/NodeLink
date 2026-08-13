import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import inspector from 'node:inspector'
import type { Socket } from 'node:net'
import net from 'node:net'
import os from 'node:os'
import { resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import v8 from 'node:v8'
import type { MessagePort } from 'node:worker_threads'
import {
  isMainThread,
  parentPort,
  workerData as rawWorkerData,
  Worker
} from 'node:worker_threads'

import type PluginManager from '../managers/pluginManager.ts'
import type { PluginManagerContext } from '../managers/pluginManager.ts'
import { migrateConfig } from '../modules/config/configMigration.ts'

import type {
  JsonValue,
  NodelinkConfig
} from '../typings/config/config.types.ts'
import type { NodeLink } from '../typings/playback/player.types.ts'
import type {
  FrameType,
  LiveChatPayload,
  LiveChatPollResult,
  MicroWorker,
  SourceWorkerConfig,
  TaskData,
  TrackInfo,
  WorkerData,
  WorkerMessageType,
  WorkerNodeLink
} from '../typings/sources/source.types.ts'
import type {
  LoadStreamPayload,
  PCMStream
} from '../typings/workers/worker.types.ts'
import * as utils from '../utils.ts'
import {
  createHeadQueue,
  dequeueHeadQueue,
  enqueueHeadQueue,
  getHeadQueueLength
} from './headQueue.ts'

const __filename = fileURLToPath(import.meta.url)

const getActiveResourcesBreakdown = (): Record<string, number> => {
  const list = process.getActiveResourcesInfo?.() ?? []
  const counters: Record<string, number> = {}
  for (const item of list) {
    counters[item] = (counters[item] || 0) + 1
  }
  return counters
}

const getActiveHandlesBreakdown = (): Record<string, number> => {
  const getter = process as unknown as {
    _getActiveHandles?: () => Array<{ constructor?: { name?: string } }>
  }
  if (typeof getter._getActiveHandles !== 'function') return {}
  const handles = getter._getActiveHandles()
  const counters: Record<string, number> = {}
  for (const handle of handles) {
    const name = handle?.constructor?.name || 'UnknownHandle'
    counters[name] = (counters[name] || 0) + 1
  }
  return counters
}

const getHeapSpaces = (): Array<{
  spaceName: string
  spaceSize: number
  spaceUsedSize: number
  spaceAvailableSize: number
  physicalSpaceSize: number
}> =>
  v8.getHeapSpaceStatistics().map((space) => ({
    spaceName: space.space_name,
    spaceSize: space.space_size,
    spaceUsedSize: space.space_used_size,
    spaceAvailableSize: space.space_available_size,
    physicalSpaceSize: space.physical_space_size
  }))

/**
 * Main thread - Source Worker Manager
 * Spawns and manages a pool of micro-workers for handling source API tasks
 */
if (isMainThread) {
  const resolveRootConfigUrl = (fileName: string): string =>
    pathToFileURL(resolvePath(process.cwd(), fileName)).href

  /**
   * Loads NodeLink configuration
   * @returns Configuration object
   * @internal
   */
  async function loadConfig(): Promise<Record<string, unknown>> {
    const resolveConfigExport = (
      importedModule: Record<string, unknown>,
      fileName: string
    ): Record<string, unknown> => {
      const candidate =
        (
          importedModule as {
            default?: unknown
            config?: unknown
          }
        ).default ??
        (
          importedModule as {
            default?: unknown
            config?: unknown
          }
        ).config

      if (
        candidate &&
        typeof candidate === 'object' &&
        Object.keys(candidate as Record<string, unknown>).length > 0
      ) {
        return candidate as Record<string, unknown>
      }

      throw new Error(
        `[ERROR] Config: ${fileName} must export a non-empty configuration object (default export or named "config").`
      )
    }

    const candidates = [
      'config.ts',
      'config.js',
      'config.default.ts',
      'config.default.js'
    ]
    for (const fileName of candidates) {
      try {
        const module = await import(resolveRootConfigUrl(fileName))
        const raw = resolveConfigExport(
          module as Record<string, unknown>,
          fileName
        )
        return migrateConfig(raw as Record<string, JsonValue>)
      } catch (error) {
        const err = error as { code?: string; message?: string }
        const isNotFound =
          err.code === 'ERR_MODULE_NOT_FOUND' ||
          err.code === 'ENOENT' ||
          err.message?.includes('Cannot find module')
        if (isNotFound) continue
        throw error
      }
    }

    throw new Error(
      '[ERROR] Config: Failed to load configuration (config.ts/config.js/config.default.ts/config.default.js).'
    )
  }

  const config = await loadConfig()
  utils.applyEnvOverrides(config)
  const specConfig: SourceWorkerConfig =
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index signature access
    (config['cluster'] as Record<string, SourceWorkerConfig> | undefined)?.[
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index signature access
      'specializedSourceWorker'
    ] || {}

  utils.initLogger(config)

  const nodelink: Pick<WorkerNodeLink, 'options' | 'logger' | 'pluginManager'> =
    {
      options: config as unknown as NodelinkConfig,
      logger: utils.logger,
      pluginManager: null as unknown as PluginManager
    }

  const { default: PluginManagerClass } = await import(
    '../managers/pluginManager.ts'
  )
  nodelink.pluginManager = new PluginManagerClass(
    nodelink as unknown as PluginManagerContext
  )
  await nodelink.pluginManager.load('source-worker')

  const maxThreadCount = Math.max(
    1,
    specConfig.microWorkers ?? Math.min(2, os.cpus().length)
  )
  const initialThreadCount = 1
  const TASKS_PER_WORKER = specConfig.tasksPerWorker ?? 32
  const SCALE_UP_THRESHOLD = specConfig.scaleUpThreshold ?? 30
  const SCALE_UP_COOLDOWN_MS = specConfig.scaleCooldownMs ?? 1000
  const workerPool: MicroWorker[] = []
  const taskQueue = createHeadQueue<TaskData>()
  let lastScaleUpAt = 0
  let nextThreadId = initialThreadCount + 1
  const inheritedExecArgv = process.execArgv || []

  nodelink.logger(
    'info',
    'SourceWorker',
    `Starting ${initialThreadCount}/${maxThreadCount} micro-worker(s) for API tasks...`
  )

  const createMicroWorker = (threadNumber: number): void => {
    const worker = new Worker(__filename, {
      workerData: {
        config,
        silentLogs: specConfig.silentLogs ?? false,
        threadId: threadNumber
      } satisfies WorkerData,
      ...(inheritedExecArgv.length > 0 ? { execArgv: inheritedExecArgv } : {})
    }) as MicroWorker

    worker.ready = false
    worker.load = 0

    worker.on('message', (msg: WorkerMessageType) => {
      if (msg.type === 'ready') {
        worker.ready = true
        nodelink.logger(
          'info',
          'SourceWorker',
          `Micro-worker ${threadNumber} is ready.`
        )
        processNextTask()
      } else if (msg.type === 'result') {
        const { socketPath, id, result, error } = msg
        finishTask(socketPath, id, result, error)

        worker.load = Math.max(0, worker.load - 1)
        processNextTask()
      } else if (msg.type === 'stream') {
        sendStreamChunk(msg.socketPath, msg.id, msg.chunk)
      } else if (msg.type === 'chatAction') {
        sendChatAction(msg.socketPath, msg.id, msg.data)
      } else if (msg.type === 'end') {
        sendStreamEnd(msg.socketPath, msg.id)
        worker.load = Math.max(0, worker.load - 1)
        processNextTask()
      } else if (msg.type === 'error') {
        sendStreamError(msg.socketPath, msg.id, msg.error)
        worker.load = Math.max(0, worker.load - 1)
        processNextTask()
      }
    })

    worker.on('exit', (code) => {
      const idx = workerPool.indexOf(worker)
      if (idx !== -1) workerPool.splice(idx, 1)

      const loadInfo =
        worker.load > 0 ? ` (had ${worker.load} pending tasks)` : ''
      nodelink.logger(
        'warn',
        'SourceWorker',
        `Micro-worker ${threadNumber} exited with code ${code}${loadInfo}`
      )

      if (workerPool.length < initialThreadCount && !process.exitCode) {
        setTimeout(() => {
          if (workerPool.length < maxThreadCount) {
            const newThreadNumber = nextThreadId++
            nodelink.logger(
              'info',
              'SourceWorker',
              `Respawning micro-worker ${newThreadNumber}...`
            )
            createMicroWorker(newThreadNumber)
          }
        }, 100)
      }
    })

    worker.on('error', (err: Error) => {
      nodelink.logger(
        'error',
        'SourceWorker',
        `Micro-worker ${threadNumber} error: ${err.message}`
      )
    })

    workerPool.push(worker)
  }

  const getTotalLoad = (): number => {
    let total = 0
    for (const worker of workerPool) total += worker.load || 0
    return total
  }

  const maybeScaleUpMicroWorkers = (): void => {
    if (workerPool.length >= maxThreadCount) return

    const now = Date.now()
    if (now - lastScaleUpAt < SCALE_UP_COOLDOWN_MS) return

    const totalLoad = getTotalLoad() + getHeadQueueLength(taskQueue)
    const threshold = workerPool.length * SCALE_UP_THRESHOLD
    if (totalLoad <= threshold) return

    const nextThreadNumber = nextThreadId++
    createMicroWorker(nextThreadNumber)
    lastScaleUpAt = now

    nodelink.logger(
      'info',
      'SourceWorker',
      `Scaling micro-workers: ${workerPool.length}/${maxThreadCount} (load=${totalLoad}, threshold=${threshold})`
    )
  }

  for (let i = 0; i < initialThreadCount; i++) {
    createMicroWorker(i + 1)
  }

  const sockets: Map<string, Socket> = new Map()

  /**
   * Gets or creates a Unix socket connection to the specified path
   * @param path - Unix socket path
   * @returns Promise resolving to connected socket
   * @internal
   */
  async function getSocket(path: string): Promise<Socket> {
    const existing = sockets.get(path)
    if (existing) {
      socketLastUsed.set(path, Date.now())
      return existing
    }

    return new Promise((resolve, reject) => {
      let settled = false
      const socket = net.createConnection(path, () => {
        settled = true
        socket.off('error', onConnectError)
        socket.on('error', () => {
          sockets.delete(path)
          socketLastUsed.delete(path)
        })
        sockets.set(path, socket)
        socketLastUsed.set(path, Date.now())
        resolve(socket)
      })
      const onConnectError = (err: Error): void => {
        if (settled) return
        settled = true
        reject(err)
      }
      socket.on('error', onConnectError)
      socket.on('close', () => {
        sockets.delete(path)
        socketLastUsed.delete(path)
      })
    })
  }

  /**
   * Executes handler with socket, creating connection if needed
   * @param path - Unix socket path
   * @param handler - Function to execute with socket
   * @internal
   */
  function withSocket(path: string, handler: (socket: Socket) => void): void {
    const socket = sockets.get(path)
    if (socket) {
      socketLastUsed.set(path, Date.now())
      handler(socket)
      return
    }
    getSocket(path)
      .then((s) => {
        socketLastUsed.set(path, Date.now())
        handler(s)
      })
      .catch((e: Error) => {
        utils.logger(
          'error',
          'SourceWorker',
          `Failed to send data back: ${e.message}`
        )
      })
  }

  /**
   * Sends task completion result or error back through socket
   * @param socketPath - Unix socket path
   * @param id - Task identifier
   * @param result - Result data (JSON string)
   * @param error - Error message if task failed
   * @internal
   */
  function finishTask(
    socketPath: string,
    id: string,
    result: string | undefined,
    error: string | undefined
  ): void {
    getSocket(socketPath)
      .then((socket) => {
        socketLastUsed.set(socketPath, Date.now())
        if (error) {
          sendFrame(socket, id, 2, Buffer.from(error, 'utf8'))
        } else if (result) {
          sendFrame(socket, id, 0, Buffer.from(result, 'utf8'))
          sendFrame(socket, id, 1, Buffer.alloc(0))
        }
      })
      .catch((e: Error) => {
        utils.logger(
          'error',
          'SourceWorker',
          `Failed to send result back: ${e.message}`
        )
      })
  }

  /**
   * Sends a stream data chunk through socket
   * @param socketPath - Unix socket path
   * @param id - Stream identifier
   * @param chunk - Data chunk (Buffer or string)
   * @internal
   */
  function sendStreamChunk(
    socketPath: string,
    id: string,
    chunk: Buffer | string
  ): void {
    const payload = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    withSocket(socketPath, (socket) => sendFrame(socket, id, 0, payload))
  }

  /**
   * Sends live chat action data through socket
   * @param socketPath - Unix socket path
   * @param id - Chat session identifier
   * @param data - Chat action data
   * @internal
   */
  function sendChatAction(
    socketPath: string,
    id: string,
    data: { op: 'actions'; actions: Array<Record<string, unknown>> }
  ): void {
    const payload = Buffer.from(JSON.stringify(data), 'utf8')
    withSocket(socketPath, (socket) => sendFrame(socket, id, 3, payload))
  }

  /**
   * Sends stream end signal through socket
   * @param socketPath - Unix socket path
   * @param id - Stream identifier
   * @internal
   */
  function sendStreamEnd(socketPath: string, id: string): void {
    withSocket(socketPath, (socket) =>
      sendFrame(socket, id, 1, Buffer.alloc(0))
    )
  }

  /**
   * Sends stream error through socket
   * @param socketPath - Unix socket path
   * @param id - Stream identifier
   * @param error - Error message
   * @internal
   */
  function sendStreamError(
    socketPath: string,
    id: string,
    error: string
  ): void {
    const errorBuf = Buffer.from(String(error || 'Unknown error'), 'utf8')
    withSocket(socketPath, (socket) => sendFrame(socket, id, 2, errorBuf))
  }

  /**
   * Sends a framed message through socket
   *
   * Frame format:
   * - Byte 0: ID length (1 byte)
   * - Byte 1: Frame type (1 byte) - 0=data, 1=end, 2=error, 3=chat
   * - Bytes 2-5: Payload length (4 bytes, big-endian)
   * - Following bytes: ID string (variable length)
   * - Following bytes: Payload data (variable length)
   *
   * @param socket - Connected socket
   * @param id - Message/stream identifier
   * @param type - Frame type (0=data, 1=end, 2=error, 3=chat)
   * @param payloadBuf - Payload buffer
   * @internal
   */
  function sendFrame(
    socket: Socket,
    id: string,
    type: FrameType,
    payloadBuf: Buffer
  ): void {
    if (socket.destroyed || socket.writable === false) return

    const idBuf = Buffer.from(id, 'utf8')

    const header = Buffer.alloc(6)
    header.writeUInt8(idBuf.length, 0)
    header.writeUInt8(type, 1)
    header.writeUInt32BE(payloadBuf.length, 2)

    try {
      socket.cork()
      socket.write(header)
      socket.write(idBuf)
      socket.write(payloadBuf)
      socket.uncork()
    } catch {
      try {
        socket.destroy()
      } catch {}
    }
  }

  /**
   * Processes next task in queue by assigning to least-loaded worker
   * @internal
   */
  function processNextTask(): void {
    if (getHeadQueueLength(taskQueue) === 0) return

    maybeScaleUpMicroWorkers()

    let bestWorker: MicroWorker | null = null
    let minLoad = Number.POSITIVE_INFINITY

    for (const worker of workerPool) {
      if (
        worker.ready &&
        worker.load < TASKS_PER_WORKER &&
        worker.load < minLoad
      ) {
        bestWorker = worker
        minLoad = worker.load
      }
    }

    if (bestWorker) {
      const task = dequeueHeadQueue(taskQueue)
      if (task) {
        bestWorker.load++
        bestWorker.postMessage(task)

        if (getHeadQueueLength(taskQueue) > 0) setImmediate(processNextTask)
      }
    }
  }

  /**
   * Handles incoming IPC messages from parent process
   */
  process.on('message', (msg: { type: string; payload?: TaskData }) => {
    nodelink.pluginManager?.callHook('onIPCMessage', msg)

    if (msg.type !== 'sourceTask') return
    if (msg.payload) {
      enqueueHeadQueue(taskQueue, msg.payload)
      maybeScaleUpMicroWorkers()
      processNextTask()
    }
  })

  /**
   * Notify parent that worker is ready
   */
  try {
    process.send?.({ type: 'ready', pid: process.pid })
  } catch {}

  const CLEANUP_INTERVAL = 60000
  const SOCKET_IDLE_MS = 120000
  const socketLastUsed: Map<string, number> = new Map()

  setInterval(() => {
    const now = Date.now()

    for (const [path, lastUsed] of socketLastUsed) {
      if (now - lastUsed > SOCKET_IDLE_MS) {
        const socket = sockets.get(path)
        if (socket) {
          try {
            socket.destroy()
          } catch {}
        }
        sockets.delete(path)
        socketLastUsed.delete(path)
      }
    }

    if (global.gc) {
      const mem = process.memoryUsage()
      const heapPressure = mem.heapUsed / mem.heapTotal
      if (heapPressure > 0.85) {
        global.gc()
      }
    }
  }, CLEANUP_INTERVAL).unref()
} else {
  /**
   * Worker thread - Micro-worker for executing source API tasks
   * Each micro-worker initializes its own source managers and processes tasks
   */

  const workerData = rawWorkerData as WorkerData
  const { config, silentLogs } = workerData

  if (silentLogs) {
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index signature access
    config['logging'] = {
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index signature access
      ...(config['logging'] as Record<string, unknown>),
      level: 'warn'
    }
  }
  utils.initLogger(config)

  const nodelink: WorkerNodeLink = {
    options: config,
    logger: utils.logger,
    pluginManager: null as unknown as PluginManager
  } as unknown as WorkerNodeLink

  const { default: PluginManagerClass } = await import(
    '../managers/pluginManager.ts'
  )
  nodelink.pluginManager = new PluginManagerClass(
    nodelink as unknown as PluginManagerContext
  )
  await nodelink.pluginManager.load('micro-worker')

  /**
   * Dynamically imports and initializes all required managers
   * @internal
   */
  const [
    { createPCMStream, createSeekeableAudioResource },
    { default: SourceManager },
    { default: CredentialManager },
    { default: TrackCacheManager },
    { default: RoutePlannerManager },
    { default: StatsManager }
  ] = await Promise.all([
    import('../playback/processing/streamProcessor.ts'),
    import('../managers/sourceManager.ts'),
    import('../managers/credentialManager.ts'),
    import('../managers/trackCacheManager.ts'),
    import('../managers/routePlannerManager.ts'),
    import('../managers/statsManager.ts')
  ])

  nodelink.statsManager = new StatsManager(
    nodelink as unknown as import('../managers/statsManager.ts').StatsManagerContext
  ) as unknown as WorkerNodeLink['statsManager']
  nodelink.credentialManager = new CredentialManager(nodelink)
  nodelink.trackCacheManager = new TrackCacheManager(nodelink)
  nodelink.routePlanner = new RoutePlannerManager(
    nodelink
  ) as unknown as WorkerNodeLink['routePlanner']
  nodelink.sources = new SourceManager(
    nodelink as unknown as import('../managers/sourceManager.ts').SourcesManagerContext
  )

  await nodelink.credentialManager.load()
  await nodelink.trackCacheManager.load()
  await nodelink.sources.loadFolder()

  type LyricsManagerType = InstanceType<
    typeof import('../managers/lyricsManager.ts').default
  >
  type MeaningManagerType = InstanceType<
    typeof import('../managers/meaningManager.ts').default
  >

  let lyricsManagerPromise: Promise<LyricsManagerType> | null = null
  let meaningManagerPromise: Promise<MeaningManagerType> | null = null

  const getLyricsManager = async (): Promise<LyricsManagerType> => {
    if (!lyricsManagerPromise) {
      lyricsManagerPromise = import('../managers/lyricsManager.ts').then(
        async (module) => {
          const manager = new module.default(nodelink)
          await manager.loadFolder()
          nodelink.lyrics = manager as unknown as WorkerNodeLink['lyrics']
          return manager
        }
      )
    }
    return lyricsManagerPromise
  }

  const getMeaningManager = async (): Promise<MeaningManagerType> => {
    if (!meaningManagerPromise) {
      meaningManagerPromise = import('../managers/meaningManager.ts').then(
        async (module) => {
          const manager = new module.default(nodelink)
          await manager.loadFolder()
          nodelink.meanings = manager as unknown as WorkerNodeLink['meanings']
          return manager
        }
      )
    }
    return meaningManagerPromise
  }

  nodelink.getLyricsManager =
    getLyricsManager as unknown as WorkerNodeLink['getLyricsManager']
  nodelink.getMeaningManager =
    getMeaningManager as unknown as WorkerNodeLink['getMeaningManager']

  /**
   * Active live chat sessions (session ID -> active flag)
   * @internal
   */
  const activeChats = new Map<string, boolean>()
  const profilerBaseDir = process.env.NODELINK_PROFILER_DIR || '.profiles'
  let activeCpuSession: {
    session: inspector.Session
    startedAt: number
    name: string | null
  } | null = null
  let activeHeapSampling: {
    session: inspector.Session
    startedAt: number
    name: string | null
    samplingInterval: number
  } | null = null

  const sanitizeProfileName = (value: string | undefined): string => {
    if (!value) return ''
    return value
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80)
  }

  const buildProfilerFilePath = async (
    kind: 'cpu' | 'heap' | 'heap-sampling',
    extension: string,
    label?: string
  ): Promise<string> => {
    await fsPromises.mkdir(profilerBaseDir, { recursive: true })
    const safeLabel = sanitizeProfileName(label)
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace('T', '_')
      .replace('Z', '')
    const suffix = safeLabel ? `-${safeLabel}` : ''
    return `${profilerBaseDir}/source-micro-${process.pid}-${kind}-${stamp}${suffix}.${extension}`
  }

  const inspectorPost = (
    session: inspector.Session,
    method: string,
    params?: Record<string, unknown>
  ): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      session.post(method, params ?? {}, (error, result) => {
        if (error) reject(error)
        else resolve((result ?? {}) as Record<string, unknown>)
      })
    })

  const summarizeHeapSamplingProfile = (
    profile: Record<string, unknown>,
    limit: number | null = null
  ): Array<{
    functionName: string
    url: string
    line: number
    column: number
    bytes: number
    hits: number
  }> => {
    const head = profile.head as
      | {
          callFrame?: {
            functionName?: string
            url?: string
            lineNumber?: number
            columnNumber?: number
          }
          selfSize?: number
          children?: unknown[]
        }
      | undefined
    if (!head) return []

    const aggregates = new Map<
      string,
      {
        functionName: string
        url: string
        line: number
        column: number
        bytes: number
        hits: number
      }
    >()

    const visit = (node: {
      callFrame?: {
        functionName?: string
        url?: string
        lineNumber?: number
        columnNumber?: number
      }
      selfSize?: number
      children?: unknown[]
    }): void => {
      const frame = node.callFrame || {}
      const functionName = frame.functionName || '(anonymous)'
      const url = frame.url || '(internal)'
      const line = Number(frame.lineNumber || 0) + 1
      const column = Number(frame.columnNumber || 0) + 1
      const selfSize = Number(node.selfSize || 0)

      if (selfSize > 0) {
        const key = `${functionName}|${url}|${line}|${column}`
        const current = aggregates.get(key)
        if (current) {
          current.bytes += selfSize
          current.hits++
        } else {
          aggregates.set(key, {
            functionName,
            url,
            line,
            column,
            bytes: selfSize,
            hits: 1
          })
        }
      }

      const children = Array.isArray(node.children) ? node.children : []
      for (const child of children) {
        visit(child as typeof node)
      }
    }

    visit(head)

    const entries = Array.from(aggregates.values()).sort(
      (a, b) => b.bytes - a.bytes
    )
    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
      return entries.slice(0, limit)
    }
    return entries
  }

  const handleProfilerCommand = async (
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> => {
    const action = payload?.action
    if (typeof action !== 'string' || action.length === 0) {
      return { success: false, error: 'Missing profiler action' }
    }

    if (action === 'status') {
      const sourceManagerDebug = nodelink.sources
        ? {
            enabledSources: Array.from(nodelink.sources.sources.keys()),
            sourceMapSize:
              (
                nodelink.sources as unknown as {
                  sourceMap?: Map<string, unknown>
                }
              ).sourceMap?.size ?? null,
            searchAliasMapSize:
              (
                nodelink.sources as unknown as {
                  searchAliasMap?: Map<string, unknown>
                }
              ).searchAliasMap?.size ?? null,
            patternMapLength:
              (nodelink.sources as unknown as { patternMap?: unknown[] })
                .patternMap?.length ?? null
          }
        : null

      const trackCacheDebug = nodelink.trackCacheManager
        ? {
            size:
              (
                nodelink.trackCacheManager as unknown as {
                  cache?: Map<string, unknown>
                }
              ).cache?.size ?? null,
            maxEntries:
              (nodelink.trackCacheManager as unknown as { maxEntries?: number })
                .maxEntries ?? null
          }
        : null

      const credentialDebug =
        nodelink.credentialManager &&
        typeof (
          nodelink.credentialManager as unknown as { getStats?: () => unknown }
        ).getStats === 'function'
          ? (
              nodelink.credentialManager as unknown as {
                getStats: () => unknown
              }
            ).getStats()
          : null

      const httpAgentsDebug = (() => {
        try {
          const http = require('node:http')
          const https = require('node:https')
          const httpAgent = http.globalAgent
          const httpsAgent = https.globalAgent
          return {
            http: {
              sockets: Object.keys(httpAgent.sockets || {}).length,
              requests: Object.keys(httpAgent.requests || {}).length,
              freeSockets: Object.keys(httpAgent.freeSockets || {}).length
            },
            https: {
              sockets: Object.keys(httpsAgent.sockets || {}).length,
              requests: Object.keys(httpsAgent.requests || {}).length,
              freeSockets: Object.keys(httpsAgent.freeSockets || {}).length
            }
          }
        } catch {
          return null
        }
      })()

      return {
        success: true,
        pid: process.pid,
        inspectorUrl: inspector.url() || null,
        cpuProfiling: !!activeCpuSession,
        cpuStartedAt: activeCpuSession?.startedAt || null,
        heapSamplingActive: !!activeHeapSampling,
        heapSamplingStartedAt: activeHeapSampling?.startedAt || null,
        profileDir: profilerBaseDir,
        memory: process.memoryUsage(),
        heapSpaces: getHeapSpaces(),
        uptimeSec: Math.floor(process.uptime()),
        activeResources: getActiveResourcesBreakdown(),
        activeHandles: getActiveHandlesBreakdown(),
        sourceContext: {
          activeChats: activeChats.size,
          mapSizes: {
            activeChats: activeChats.size
          }
        },
        debugInternals: {
          sourceManager: sourceManagerDebug,
          trackCache: trackCacheDebug,
          credentials: credentialDebug,
          httpAgents: httpAgentsDebug
        }
      }
    }

    if (action === 'openInspector') {
      const host = typeof payload.host === 'string' ? payload.host : '127.0.0.1'
      const port =
        typeof payload.port === 'number' && Number.isInteger(payload.port)
          ? payload.port
          : 0
      inspector.open(port, host, payload.exposeWait === true)
      return {
        success: true,
        pid: process.pid,
        inspectorUrl: inspector.url() || null
      }
    }

    if (action === 'closeInspector') {
      inspector.close()
      return { success: true, pid: process.pid, inspectorUrl: null }
    }

    if (action === 'forceGc') {
      const gcFn = global.gc
      if (typeof gcFn !== 'function') {
        return {
          success: false,
          error:
            'GC not exposed. Start NodeLink with --expose-gc to enable forceGc.'
        }
      }
      gcFn()
      gcFn()
      return { success: true, pid: process.pid, memory: process.memoryUsage() }
    }

    if (action === 'cpuStart') {
      if (activeCpuSession) {
        return {
          success: true,
          alreadyActive: true,
          pid: process.pid,
          startedAt: activeCpuSession.startedAt
        }
      }

      const session = new inspector.Session()
      session.connect()
      await inspectorPost(session, 'Profiler.enable')
      await inspectorPost(session, 'Profiler.start')
      activeCpuSession = {
        session,
        startedAt: Date.now(),
        name:
          sanitizeProfileName(
            typeof payload.name === 'string' ? payload.name : undefined
          ) || null
      }
      return {
        success: true,
        pid: process.pid,
        startedAt: activeCpuSession.startedAt
      }
    }

    if (action === 'cpuStop') {
      if (!activeCpuSession) {
        return { success: false, error: 'CPU profiler is not active' }
      }
      const { session, startedAt, name } = activeCpuSession
      const result = await inspectorPost(session, 'Profiler.stop')
      const outputPath = await buildProfilerFilePath(
        'cpu',
        'cpuprofile',
        (typeof payload.name === 'string'
          ? sanitizeProfileName(payload.name)
          : '') ||
          name ||
          undefined
      )
      await fsPromises.writeFile(outputPath, JSON.stringify(result.profile))
      try {
        session.disconnect()
      } catch {}
      activeCpuSession = null
      return {
        success: true,
        pid: process.pid,
        startedAt,
        endedAt: Date.now(),
        outputPath
      }
    }

    if (action === 'heapSnapshot') {
      const outputPath = await buildProfilerFilePath(
        'heap',
        'heapsnapshot',
        typeof payload.name === 'string' ? payload.name : undefined
      )
      const session = new inspector.Session()
      let fd: number | null = null

      try {
        fd = fs.openSync(outputPath, 'w')
        session.connect()
        session.on('HeapProfiler.addHeapSnapshotChunk', (message) => {
          const chunk = message?.params?.chunk
          if (typeof chunk === 'string' && fd !== null) fs.writeSync(fd, chunk)
        })
        await inspectorPost(session, 'HeapProfiler.enable')
        await inspectorPost(session, 'HeapProfiler.takeHeapSnapshot', {
          reportProgress: false
        })
        return { success: true, pid: process.pid, outputPath }
      } finally {
        try {
          session.disconnect()
        } catch {}
        if (fd !== null) {
          try {
            fs.closeSync(fd)
          } catch {}
        }
      }
    }

    if (action === 'heapSamplingStart') {
      if (activeHeapSampling) {
        return {
          success: true,
          alreadyActive: true,
          pid: process.pid,
          startedAt: activeHeapSampling.startedAt
        }
      }

      const samplingInterval =
        typeof payload.samplingInterval === 'number' &&
        Number.isFinite(payload.samplingInterval) &&
        payload.samplingInterval > 0
          ? Math.floor(payload.samplingInterval)
          : 32768

      const session = new inspector.Session()
      session.connect()
      await inspectorPost(session, 'HeapProfiler.enable')
      await inspectorPost(session, 'HeapProfiler.startSampling', {
        samplingInterval
      })
      activeHeapSampling = {
        session,
        startedAt: Date.now(),
        name:
          sanitizeProfileName(
            typeof payload.name === 'string' ? payload.name : undefined
          ) || null,
        samplingInterval
      }
      return {
        success: true,
        pid: process.pid,
        startedAt: activeHeapSampling.startedAt,
        samplingInterval
      }
    }

    if (action === 'heapSamplingStop') {
      if (!activeHeapSampling) {
        return { success: false, error: 'Heap sampling is not active' }
      }

      const { session, startedAt, name } = activeHeapSampling
      const result = await inspectorPost(session, 'HeapProfiler.stopSampling')
      const outputPath = await buildProfilerFilePath(
        'heap-sampling',
        'heapsampling.json',
        (typeof payload.name === 'string'
          ? sanitizeProfileName(payload.name)
          : '') ||
          name ||
          undefined
      )
      await fsPromises.writeFile(outputPath, JSON.stringify(result))
      try {
        session.disconnect()
      } catch {}
      activeHeapSampling = null

      const profile = (result.profile as Record<string, unknown>) || {}
      const topSites = summarizeHeapSamplingProfile(profile)

      return {
        success: true,
        pid: process.pid,
        startedAt,
        endedAt: Date.now(),
        outputPath,
        topSites
      }
    }

    return { success: false, error: `Unsupported profiler action: ${action}` }
  }

  ;(parentPort as MessagePort).postMessage({ type: 'ready' })

  /**
   * Sends stream data chunk to parent thread
   * @param id - Stream identifier
   * @param socketPath - Unix socket path
   * @param chunk - Data chunk
   * @internal
   */
  const sendStreamChunkFromWorker = (
    id: string,
    socketPath: string,
    chunk: Buffer
  ): void => {
    const ab = new ArrayBuffer(chunk.byteLength)
    new Uint8Array(ab).set(
      new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    )
    ;(parentPort as MessagePort).postMessage(
      {
        type: 'stream',
        id,
        socketPath,
        chunk: ab
      },
      [ab]
    )
  }

  /**
   * Sends stream end signal to parent thread
   * @param id - Stream identifier
   * @param socketPath - Unix socket path
   * @internal
   */
  const sendStreamEndFromWorker = (id: string, socketPath: string): void => {
    ;(parentPort as MessagePort).postMessage({
      type: 'end',
      id,
      socketPath
    })
  }

  /**
   * Sends stream error to parent thread
   * @param id - Stream identifier
   * @param socketPath - Unix socket path
   * @param error - Error message or object
   * @internal
   */
  const sendStreamErrorFromWorker = (
    id: string,
    socketPath: string,
    error: string | Error
  ): void => {
    ;(parentPort as MessagePort).postMessage({
      type: 'error',
      id,
      socketPath,
      error: String(error || 'Unknown error')
    })
  }

  /**
   * Handles YouTube live chat streaming task
   *
   * Continuously polls for new chat messages and sends them back
   * to the parent thread until the chat is cancelled or an error occurs.
   *
   * @param id - Chat session identifier
   * @param socketPath - Unix socket path for responses
   * @param payload - Live chat task payload
   * @internal
   */
  const handleLiveChat = async (
    id: string,
    socketPath: string,
    payload: LiveChatPayload
  ): Promise<void> => {
    const videoId = payload.videoId
    const yt = nodelink.sources?.getSource('youtube')
    if (!yt?.liveChat)
      throw new Error('YouTube source or live chat not available in worker')

    activeChats.set(id, true)

    try {
      const chat = await yt.liveChat.getLiveChat(videoId)
      if (!chat) throw new Error('Could not initialize live chat')

      const pollLoop = async (): Promise<void> => {
        while (activeChats.has(id)) {
          try {
            const result: LiveChatPollResult | null = await chat.poll()
            if (!result) break

            const { actions, timeoutMs } = result

            if (actions.length > 0 && activeChats.has(id)) {
              utils.logger(
                'debug',
                'SourceWorker',
                `[${id}] Sending ${actions.length} actions for ${videoId}`
              )
              ;(parentPort as MessagePort).postMessage({
                type: 'chatAction',
                id,
                socketPath,
                data: { op: 'actions', actions }
              })
            }

            await new Promise((resolve) =>
              setTimeout(resolve, timeoutMs || 5000)
            )
          } catch (e) {
            const err = e as Error
            utils.logger(
              'error',
              'SourceWorker',
              `[${id}] Polling exception for ${videoId}: ${err.message}`
            )
            break
          }
        }
      }

      await pollLoop()
      ;(parentPort as MessagePort).postMessage({ type: 'end', id, socketPath })
    } catch (e) {
      const err = e as Error
      sendStreamErrorFromWorker(id, socketPath, err.message)
    } finally {
      activeChats.delete(id)
    }
  }

  /**
   * Handles track stream loading and PCM conversion
   *
   * Resolves track URL, fetches the stream, converts to PCM audio,
   * and streams chunks back to the parent thread.
   *
   * @param id - Stream identifier
   * @param socketPath - Unix socket path for streaming
   * @param payload - Load stream task payload
   * @internal
   */
  const handleLoadStream = async (
    id: string,
    socketPath: string,
    payload: LoadStreamPayload
  ): Promise<void> => {
    let fetched: Awaited<
      ReturnType<typeof nodelink.sources.getTrackStream>
    > | null = null
    let pcmStream: PCMStream | null = null
    let finished = false

    const cleanup = (): void => {
      if (pcmStream && !pcmStream.destroyed) pcmStream.destroy()
      if (fetched?.stream && !fetched.stream.destroyed) fetched.stream.destroy()
    }

    const finish = (err?: Error | string | null): void => {
      if (finished) return
      finished = true
      if (err) {
        const errMsg = typeof err === 'string' ? err : err.message
        sendStreamErrorFromWorker(id, socketPath, errMsg)
      } else {
        sendStreamEndFromWorker(id, socketPath)
      }
      cleanup()
    }

    try {
      const trackInfo = payload?.decodedTrackInfo
      if (!trackInfo) {
        throw new Error('Invalid encoded track')
      }

      const urlResult = await nodelink.sources?.getTrackUrl(trackInfo)
      if (!urlResult || urlResult.exception) {
        throw new Error(
          urlResult?.exception?.message || 'Failed to get track URL'
        )
      }

      const sourceName =
        urlResult.newTrack?.info?.sourceName || trackInfo.sourceName
      const isHls = urlResult.protocol === 'hls'
      const isSabr = urlResult.protocol === 'sabr'
      const isLocal = sourceName === 'local'

      if (urlResult.url && !isHls && !isLocal && !isSabr) {
        const resource = await createSeekeableAudioResource(
          id,
          urlResult.url,
          payload?.position || 0,
          undefined,
          nodelink as unknown as NodeLink,
          {},
          {
            streamInfo: urlResult,
            loudnessNormalizer: (
              nodelink.options as unknown as {
                audio?: { loudnessNormalizer?: boolean }
              }
            ).audio?.loudnessNormalizer
          },
          (payload?.volume ?? 100) / 100,
          null,
          true
        )

        if ('exception' in resource) {
          throw new Error(resource.exception.message)
        }

        pcmStream = resource.stream as unknown as PCMStream
      } else {
        const additionalData = {
          ...(urlResult.additionalData || {}),
          startTime: payload?.position || 0,
          position: payload?.position || 0
        }

        fetched =
          (await nodelink.sources?.getTrackStream(
            urlResult.newTrack?.info || trackInfo,
            urlResult.url as string,
            urlResult.protocol as string,
            additionalData
          )) || null

        if (!fetched || fetched.exception) {
          throw new Error(
            fetched?.exception?.message || 'Failed to load stream'
          )
        }

        pcmStream = createPCMStream(
          id,
          fetched.stream as NonNullable<typeof fetched.stream>,
          fetched.type || (urlResult.format as string) || 'unknown',
          nodelink as unknown as NodeLink,
          (payload?.volume ?? 100) / 100,
          payload?.filters || {}
        ) as unknown as PCMStream
      }

      pcmStream.on('data', (chunk: Buffer) => {
        if (!finished) sendStreamChunkFromWorker(id, socketPath, chunk)
      })

      pcmStream.once('end', () => finish())
      pcmStream.once('error', (err: Error) => finish(err))
      pcmStream.once('close', () => finish())
    } catch (err) {
      finish(err as Error)
    }
  }

  /**
   * Handles incoming task messages from parent thread
   */
  ;(parentPort as MessagePort).on('message', async (taskData: TaskData) => {
    nodelink.pluginManager?.callHook('onIPCMessage', taskData)

    const { id, task, payload, socketPath } = taskData

    if (task === 'loadStream') {
      try {
        await handleLoadStream(id, socketPath, payload as LoadStreamPayload)
      } catch (e) {
        const err = e as Error
        sendStreamErrorFromWorker(id, socketPath, err.message || err)
      }
      return
    }

    if (task === 'loadLiveChat') {
      try {
        await handleLiveChat(id, socketPath, payload as LiveChatPayload)
      } catch (e) {
        const err = e as Error
        sendStreamErrorFromWorker(id, socketPath, err.message || err)
      }
      return
    }

    if (task === 'cancelLiveChat') {
      activeChats.delete((payload as { id: string }).id)
      return
    }

    try {
      let result: unknown
      switch (task) {
        case 'resolve':
          result = await nodelink.sources?.resolve(
            (payload as { url: string }).url
          )
          break
        case 'search':
          result = await nodelink.sources?.search(
            (payload as { source: string; query: string }).source,
            (payload as { source: string; query: string }).query
          )
          break
        case 'unifiedSearch':
          result = await nodelink.sources?.unifiedSearch(
            (payload as { query: string }).query
          )
          break
        case 'loadLyrics': {
          const lyrics = await getLyricsManager()
          result = await lyrics.loadLyrics(
            {
              info: (payload as { decodedTrackInfo: TrackInfo })
                .decodedTrackInfo
            },
            (payload as { language?: string }).language
          )
          break
        }
        case 'loadMeaning': {
          const meanings = await getMeaningManager()
          result = await meanings.loadMeaning(
            {
              info: (payload as { decodedTrackInfo: TrackInfo })
                .decodedTrackInfo
            },
            (payload as { language?: string }).language
          )
          break
        }
        case 'loadChapters':
          result = await nodelink.sources?.getChapters({
            info: (payload as { decodedTrackInfo: TrackInfo }).decodedTrackInfo
          })
          break
        case 'profilerCommand':
          result = await handleProfilerCommand(
            (payload as Record<string, unknown>) || {}
          )
          break
      }
      ;(parentPort as MessagePort).postMessage({
        type: 'result',
        id,
        socketPath,
        result: JSON.stringify(result)
      })
    } catch (e) {
      const err = e as Error
      ;(parentPort as MessagePort).postMessage({
        type: 'result',
        id,
        socketPath,
        error: err.message
      })
    }
  })
}
