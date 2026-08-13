import cluster from 'node:cluster'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import WebSocketServer from '@performanc/pwsl-server'
import type ProxyManager from './managers/proxyManager.ts'
import RoutePlannerManager from './managers/routePlannerManager.ts'
import SessionManager from './managers/sessionManager.ts'
import StatsManager from './managers/statsManager.ts'
import {
  migrateConfig,
  persistConfig
} from './modules/config/configMigration.ts'
import { cleanupBunServer, createBunServer } from './server/bunServer.ts'
import {
  applyEnvOverrides,
  checkDependencyUpdates,
  checkForUpdates,
  cleanupHttpAgents,
  cleanupLogger,
  decodeTrack,
  getGitInfo,
  getStats,
  getVersion,
  initLogger,
  logger,
  parseClient,
  verifyDiscordID
} from './utils.ts'
import 'dotenv/config'
import { GatewayEvents, MINIMUM_NODE_VERSION } from './constants.ts'
import ConfigValidationManager from './managers/configValidationManager.ts'
import type ConnectionManager from './managers/connectionManager.ts'
import type CredentialManager from './managers/credentialManager.ts'
import DosProtectionManager from './managers/dosProtectionManager.ts'
import type LyricsManager from './managers/lyricsManager.ts'
import type MeaningManager from './managers/meaningManager.ts'
import PluginManager from './managers/pluginManager.ts'
import RateLimitManager from './managers/rateLimitManager.ts'
import type SourcesManager from './managers/sourceManager.ts'
import type SourceWorkerManager from './managers/sourceWorkerManager.ts'
import type TrackCacheManager from './managers/trackCacheManager.ts'
import type WorkerManager from './managers/workerManager.ts'
import type { ApiMiddlewareExtension } from './typings/api/api.types.ts'
import type {
  JsonValue,
  NodelinkConfig
} from './typings/config/config.types.ts'
import type {
  AudioInterceptorExtension,
  ConfigLoadError,
  FilterExtension,
  GitInfo,
  NodelinkServer as INodelinkServer,
  NodelinkExtensions,
  NodelinkServerType,
  NodelinkSocketType,
  NodelinkStatistics,
  ParsedWebSocketData,
  PlayerInterceptorExtension,
  PlayerManagerConstructor,
  RequestShim,
  RouteExtension,
  SessionSocket,
  SourceExtension,
  TrackModifierExtension,
  VoiceRelay,
  WebSocketInterceptorExtension
} from './typings/index.types.ts'
import type { ClientInfo, IPCMessage } from './typings/shared.types.ts'
import { parseVoiceFrameHeader } from './voice/voiceFrames.ts'
import { createVoiceRelay } from './voice/voiceRelay.ts'

type RequestHandlerType = typeof import('./api/index.ts').default
let requestHandlerPromise: Promise<RequestHandlerType> | null = null
type ProfilerApiModule = typeof import('./api/profiler.ts')
let profilerApiPromise: Promise<ProfilerApiModule> | null = null

const isRuntimeAtLeast = (current: string, minimum: string): boolean =>
  current
    .replace(/^v/, '')
    .localeCompare(minimum.replace(/^v/, ''), undefined, {
      numeric: true
    }) >= 0

type NodeLtsCacheEntry = {
  version: string
  fetchedAt: number
}

const NODE_LTS_CREDENTIAL_KEY = 'runtime.node.latestLts'
const NODE_LTS_CREDENTIAL_TTL_MS = 24 * 60 * 60 * 1000
const NODE_LTS_MEMORY_TTL_MS = 10 * 60 * 1000
let latestNodeLtsCache: { value: string | null; expiresAt: number } | null =
  null

const getLatestNodeLtsVersion = async (
  credentialManager: CredentialManager | null
): Promise<string | null> => {
  const now = Date.now()
  if (latestNodeLtsCache && latestNodeLtsCache.expiresAt > now) {
    return latestNodeLtsCache.value
  }

  const diskCache = credentialManager?.get<NodeLtsCacheEntry>(
    NODE_LTS_CREDENTIAL_KEY
  )
  if (
    diskCache &&
    typeof diskCache.version === 'string' &&
    diskCache.version.length > 0
  ) {
    latestNodeLtsCache = {
      value: diskCache.version,
      expiresAt: now + NODE_LTS_MEMORY_TTL_MS
    }
    return diskCache.version
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 2000)

  try {
    const response = await fetch('https://nodejs.org/dist/index.json', {
      signal: controller.signal
    })
    if (!response.ok) {
      latestNodeLtsCache = { value: null, expiresAt: now + 10 * 60 * 1000 }
      return null
    }

    const releases = (await response.json()) as Array<{
      version?: string
      lts?: string | boolean
    }>
    const latestLts = releases.find(
      (release) =>
        typeof release.version === 'string' &&
        release.version.length > 0 &&
        Boolean(release.lts)
    )

    latestNodeLtsCache = {
      value: latestLts?.version ?? null,
      expiresAt: now + 60 * 60 * 1000
    }

    if (latestNodeLtsCache.value && credentialManager) {
      credentialManager.set(
        NODE_LTS_CREDENTIAL_KEY,
        {
          version: latestNodeLtsCache.value,
          fetchedAt: now
        } satisfies NodeLtsCacheEntry,
        NODE_LTS_CREDENTIAL_TTL_MS
      )
    }

    return latestNodeLtsCache.value
  } catch (error) {
    logger(
      'warn',
      'Server',
      `Failed to fetch latest Node.js LTS version: ${error instanceof Error ? error.message : String(error)}`
    )
    latestNodeLtsCache = { value: null, expiresAt: now + 10 * 60 * 1000 }
    return null
  } finally {
    clearTimeout(timeout)
  }
}

const getRequestHandler = async (): Promise<RequestHandlerType> => {
  if (!requestHandlerPromise) {
    requestHandlerPromise = import('./api/index.ts').then(
      (module) => module.default
    )
  }
  return requestHandlerPromise
}

const getProfilerApi = async (): Promise<ProfilerApiModule> => {
  if (!profilerApiPromise) {
    profilerApiPromise = import('./api/profiler.ts')
  }
  return profilerApiPromise
}

const { NODELINK_MEMORY_TRACE: memoryTraceEnv } = process.env
const memoryTraceEnabled = memoryTraceEnv?.toLowerCase() === 'true'

type ProfilerRealtimeStore = {
  snapshots: Array<Record<string, unknown>>
  lastAllocTop: object | null
  updatedAt: number
}

const PROFILER_HISTORY_MAX = 240
const getProfilerRealtimeStore = (): ProfilerRealtimeStore => {
  const g = globalThis as unknown as {
    __nodelinkProfilerRealtimeStore?: ProfilerRealtimeStore
  }
  if (!g.__nodelinkProfilerRealtimeStore) {
    g.__nodelinkProfilerRealtimeStore = {
      snapshots: [],
      lastAllocTop: null,
      updatedAt: Date.now()
    }
  }
  return g.__nodelinkProfilerRealtimeStore
}

const memoryTrace = (stage: string): void => {
  if (!memoryTraceEnabled) return

  const m = process.memoryUsage()
  const toMB = (value: number): string => (value / 1024 / 1024).toFixed(2)
  process.stdout.write(
    `[MEM] ${stage} rss=${toMB(m.rss)}MB heapUsed=${toMB(m.heapUsed)}MB heapTotal=${toMB(m.heapTotal)}MB external=${toMB(m.external)}MB\n`
  )
}

let playerManagerClassPromise: Promise<PlayerManagerConstructor> | null = null
const getPlayerManagerClass = async (): Promise<PlayerManagerConstructor> => {
  if (!playerManagerClassPromise) {
    playerManagerClassPromise = import('./managers/playerManager.ts').then(
      (module) => module.default as unknown as PlayerManagerConstructor
    )
  }

  return playerManagerClassPromise
}

let workerManagerClassPromise: Promise<
  typeof import('./managers/workerManager.ts').default
> | null = null
const getWorkerManagerClass = async (): Promise<
  typeof import('./managers/workerManager.ts').default
> => {
  if (!workerManagerClassPromise) {
    workerManagerClassPromise = import('./managers/workerManager.ts').then(
      (module) => module.default
    )
  }

  return workerManagerClassPromise
}

let sourceWorkerManagerClassPromise: Promise<
  typeof import('./managers/sourceWorkerManager.ts').default
> | null = null
const getSourceWorkerManagerClass = async (): Promise<
  typeof import('./managers/sourceWorkerManager.ts').default
> => {
  if (!sourceWorkerManagerClassPromise) {
    sourceWorkerManagerClassPromise = import(
      './managers/sourceWorkerManager.ts'
    ).then((module) => module.default)
  }

  return sourceWorkerManagerClassPromise
}

let credentialManagerClassPromise: Promise<
  typeof import('./managers/credentialManager.ts').default
> | null = null
const getCredentialManagerClass = async (): Promise<
  typeof import('./managers/credentialManager.ts').default
> => {
  if (!credentialManagerClassPromise) {
    credentialManagerClassPromise = import(
      './managers/credentialManager.ts'
    ).then((module) => module.default)
  }

  return credentialManagerClassPromise
}

let trackCacheManagerClassPromise: Promise<
  typeof import('./managers/trackCacheManager.ts').default
> | null = null
const getTrackCacheManagerClass = async (): Promise<
  typeof import('./managers/trackCacheManager.ts').default
> => {
  if (!trackCacheManagerClassPromise) {
    trackCacheManagerClassPromise = import(
      './managers/trackCacheManager.ts'
    ).then((module) => module.default)
  }

  return trackCacheManagerClassPromise
}

let config: NodelinkConfig

const loadConfig = async (): Promise<NodelinkConfig> => {
  const resolveRootConfigUrl = (fileName: string): string =>
    pathToFileURL(resolvePath(process.cwd(), fileName)).href
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

  /**
   * Loads and merges configuration files.
   * Prioritizes config.ts/js, falls back to config.default.ts/js.
   * @returns Migrated and merged configuration object.
   */
  const loadAndMerge = async (): Promise<NodelinkConfig> => {
    // 1. Load defaults (Mandatory)
    let baseConfig: Record<string, unknown> = {}
    let defaultFileName = 'config.default.ts'
    try {
      const module = await import(resolveRootConfigUrl('config.default.ts'))
      baseConfig = resolveConfigExport(
        module as Record<string, unknown>,
        'config.default.ts'
      )
    } catch {
      try {
        const module = await import(resolveRootConfigUrl('config.default.js'))
        baseConfig = resolveConfigExport(
          module as Record<string, unknown>,
          'config.default.js'
        )
        defaultFileName = 'config.default.js'
      } catch {
        throw new Error(
          '[ERROR] Config: Base configuration (config.default.ts/js) not found.'
        )
      }
    }

    // 2. Try to load user configuration
    let userConfig: Record<string, unknown> = {}
    let userFileName: string | null = null
    const userCandidates = ['config.ts', 'config.js']

    for (const fileName of userCandidates) {
      try {
        const module = await import(resolveRootConfigUrl(fileName))
        userConfig = resolveConfigExport(
          module as Record<string, unknown>,
          fileName
        )
        userFileName = fileName
        console.log(`[INFO] Config: Loaded user configuration from ${fileName}`)
        break
      } catch (e) {
        const error = e as ConfigLoadError
        const isNotFound =
          error.code === 'ERR_MODULE_NOT_FOUND' ||
          error.code === 'ENOENT' ||
          error.message?.includes('Cannot find module')
        if (isNotFound) continue
        throw e
      }
    }

    if (!userFileName) {
      console.log(`[INFO] Config: No user configuration found. Using defaults.`)
    }

    // 3. Merge user config over defaults
    // We do a deep merge for 'sources', 'lyrics', 'meanings', 'pluginConfig'
    // and a shallow merge for the rest to keep it simple but functional.
    const merged = { ...baseConfig }
    for (const [key, value] of Object.entries(userConfig)) {
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        baseConfig[key] &&
        typeof baseConfig[key] === 'object' &&
        !Array.isArray(baseConfig[key])
      ) {
        merged[key] = {
          ...(baseConfig[key] as Record<string, unknown>),
          ...(value as Record<string, unknown>)
        }
      } else {
        merged[key] = value
      }
    }

    const migrated = migrateConfig(merged as Record<string, JsonValue>)
    await persistConfig(migrated, userFileName ?? defaultFileName)

    return migrated as unknown as NodelinkConfig
  }

  return await loadAndMerge()
}

config = await loadConfig()

// Apply environment variable overrides after config is loaded
applyEnvOverrides(config as unknown as Record<string, unknown>)

const clusterEnabled =
  // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index signature access
  process.env['CLUSTER_ENABLED']?.toLowerCase() === 'true' ||
  (typeof config.cluster?.enabled === 'boolean' && config.cluster.enabled) ||
  false

let _configuredWorkers = 0
// biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index signature access
if (process.env['CLUSTER_WORKERS'])
  // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index signature access
  _configuredWorkers = Number(process.env['CLUSTER_WORKERS'])
else if (typeof config.cluster?.workers === 'number')
  _configuredWorkers = config.cluster.workers

initLogger(
  config as unknown as {
    logging?: import('./typings/utils.types.ts').LoggingConfig
  }
)

const isBun = typeof Bun !== 'undefined'

if (!cluster.isWorker) {
  const supportGuidelines = `\x1b[35m
╭──────────────────────────────────────────────────────────────────────────────╮
│                            SUPPORT GUIDELINES                                │
│                                                                              │
│  1. Turn on debugging in config.ts before asking for help.                   │
│  2. Test the 'dev' branch (git checkout dev) to ensure it's not fixed yet.   │
│  3. If providing logs, start copying EXACTLY from this box onwards.          │
│  4. Cut logs or missing Node.js version will result in an ignored ticket.    │
│  5. FAQ and Rules: https://discord.gg/bVz6ppZ3SP                             │
│                    https://discord.gg/z4ayqfeBdB                             │
╰──────────────────────────────────────────────────────────────────────────────╯\x1b[0m

  *
`
  process.stdout.write(supportGuidelines)

  const ascii = `
   ▄   ████▄ ██▄   ▄███▄   █    ▄█    ▄   █  █▀
    █  █   █ █  █  █▀   ▀  █    ██     █  █▄█
██   █ █   █ █   █ ██▄▄    █    ██ ██   █ █▀▄   ${clusterEnabled ? 'Cluster Mode' : 'Single Process'}
█ █  █ ▀████ █  █  █▄   ▄▀ ███▄ ▐█ █ █  █ █  █  v${getVersion()}
█  █ █       ███▀  ▀███▀       ▀ ▐ █  █ █   █   Powered by PerformanC;
█   ██                             █   ██  ▀    rewritten by 1Lucas1.apk;
                                                maintained by 1Lucas1.apk & ToddyTheNoobDud
`
  process.stdout.write(`\x1b[32m${ascii}\x1b[0m\n`)
  try {
    await checkForUpdates()
  } catch (e: unknown) {
    logger('error', 'Git', `Update check failed: ${(e as Error).message}`)
  }

  try {
    await checkDependencyUpdates()
  } catch (e: unknown) {
    logger('error', 'Git', `Dependency check failed: ${(e as Error).message}`)
  }
}

memoryTrace('bootstrap:after-check-for-updates')

/**
 * Main NodeLink server class
 * Handles WebSocket connections, audio sources, and player management
 */
class NodelinkServer extends EventEmitter {
  options: NodelinkConfig
  logger: typeof logger
  server: NodelinkServerType
  socket: NodelinkSocketType
  _usingBunServer: boolean
  sessions: SessionManager
  sources: SourcesManager | null
  lyrics: LyricsManager | null
  meanings: MeaningManager | null
  _sourceInitPromise: Promise<void>
  proxyManager: ProxyManager | null
  routePlanner: RoutePlannerManager
  credentialManager: CredentialManager | null
  trackCacheManager: TrackCacheManager | null
  _persistenceManagersInitPromise: Promise<void> | null
  connectionManager: ConnectionManager | null
  _connectionManagerInitPromise: Promise<void> | null
  statsManager: StatsManager
  rateLimitManager: RateLimitManager
  dosProtectionManager: DosProtectionManager
  pluginManager: PluginManager
  sourceWorkerManager: SourceWorkerManager | null
  workerManager: WorkerManager | null
  version: string
  gitInfo: GitInfo
  statistics: NodelinkStatistics
  extensions: NodelinkExtensions
  voiceSockets: Map<string, Set<SessionSocket>>
  voiceRelay: VoiceRelay
  _globalUpdater: NodeJS.Timeout | null
  _statsUpdater: NodeJS.Timeout | null
  supportedSourcesCache: string[] | null
  _heartbeatInterval: NodeJS.Timeout | null;
  [key: string]: unknown

  /**
   * Creates a new NodeLink server instance
   * @param options - Server configuration
   * @param PlayerManagerClass - Player manager constructor
   * @param isClusterPrimary - Whether this is the cluster primary
   */
  constructor(
    options: NodelinkConfig,
    PlayerManagerClass: PlayerManagerConstructor,
    isClusterPrimary = false
  ) {
    super()
    if (!options || Object.keys(options).length === 0)
      throw new Error('Configuration file not found or empty')
    this.options = options
    this.logger = logger
    this.server = null
    this.socket = null

    this._usingBunServer = Boolean(isBun && options?.server?.useBunServer) as
      | true
      | false

    memoryTrace('constructor:start')

    this.sessions = new SessionManager(
      this as unknown as INodelinkServer,
      PlayerManagerClass
    )
    memoryTrace('constructor:after-session-manager')
    this.sources = null
    this.lyrics = null
    this.meanings = null

    this._sourceInitPromise = this._initSources(isClusterPrimary, options)

    this.routePlanner = new RoutePlannerManager(this)
    memoryTrace('constructor:after-route-planner')
    this.proxyManager = null
    this.credentialManager = null
    memoryTrace('constructor:after-credential-manager')
    this.trackCacheManager = null
    memoryTrace('constructor:after-track-cache-manager')
    this._persistenceManagersInitPromise = null
    this.connectionManager = null
    this._connectionManagerInitPromise = null
    this.statsManager = new StatsManager(this)
    memoryTrace('constructor:after-stats-manager')
    this.rateLimitManager = new RateLimitManager(this)
    memoryTrace('constructor:after-rate-limit-manager')
    this.dosProtectionManager = new DosProtectionManager(this)
    memoryTrace('constructor:after-dos-protection-manager')
    this.pluginManager = new PluginManager(this)
    memoryTrace('constructor:after-plugin-manager')
    this.sourceWorkerManager = null
    this.workerManager = null
    this.version = String(getVersion())
    this.gitInfo = getGitInfo()
    this.statistics = {
      players: 0,
      playingPlayers: 0
    }

    this.extensions = {
      sources: new Map(),
      filters: new Map(),
      routes: [],
      middlewares: [],
      trackModifiers: [],
      wsInterceptors: [],
      audioInterceptors: [],
      playerInterceptors: []
    }

    this.voiceSockets = new Map()
    this.voiceRelay = createVoiceRelay({
      enabled: options.playback.voiceReceive?.enabled || false,
      format: options.playback.voiceReceive?.format || 'pcm',
      sendFrame: (frame: Buffer) => this.handleVoiceFrame(frame),
      logger
    }) as unknown as VoiceRelay
    memoryTrace('constructor:after-voice-relay')

    this._globalUpdater = null
    this._statsUpdater = null
    this.supportedSourcesCache = null
    this._heartbeatInterval = null

    if (this._usingBunServer) {
      // EventEmitter used as WebSocket server shim for Bun
      this.socket = new EventEmitter()
    } else {
      this.socket = new WebSocketServer()
    }
    memoryTrace('constructor:after-socket-server')

    memoryTrace('constructor:end')

    logger('info', 'Server', `version ${this.version}`)
    logger(
      'info',
      'Server',
      `git branch: ${this.gitInfo.branch}, commit: ${this.gitInfo.commit}, committed on: ${new Date(this.gitInfo.commitTime).toISOString()}`
    )
  }

  /**
   * Initializes source managers
   * @param isClusterPrimary - Whether this is the cluster primary
   * @param _options - Server configuration
   * @internal
   */
  async _initSources(
    isClusterPrimary: boolean,
    _options: NodelinkConfig
  ): Promise<void> {
    if (!isClusterPrimary) {
      const [
        { default: sourceMan },
        { default: lyricsMan },
        { default: meaningMan }
      ] = await Promise.all([
        import('./managers/sourceManager.ts'),
        import('./managers/lyricsManager.ts'),
        import('./managers/meaningManager.ts')
      ])
      this.sources = new sourceMan(this)
      this.lyrics = new lyricsMan(this)
      this.meanings = new meaningMan(this)
    }
  }

  async _ensureConnectionManager(): Promise<void> {
    if (this.connectionManager) return
    if (this._connectionManagerInitPromise) {
      await this._connectionManagerInitPromise
      return
    }

    this._connectionManagerInitPromise = import(
      './managers/connectionManager.ts'
    )
      .then(({ default: ConnectionManagerClass }) => {
        if (!this.connectionManager) {
          this.connectionManager = new ConnectionManagerClass(this)
        }
      })
      .finally(() => {
        this._connectionManagerInitPromise = null
      })

    await this._connectionManagerInitPromise
  }

  async _ensurePersistenceManagers(): Promise<void> {
    if (this.credentialManager && this.trackCacheManager) return
    if (this._persistenceManagersInitPromise) {
      await this._persistenceManagersInitPromise
      return
    }

    this._persistenceManagersInitPromise = Promise.all([
      getCredentialManagerClass(),
      getTrackCacheManagerClass()
    ])
      .then(([CredentialManagerClass, TrackCacheManagerClass]) => {
        if (!this.credentialManager) {
          this.credentialManager = new CredentialManagerClass(
            this as unknown as { options: NodelinkConfig }
          ) as unknown as CredentialManager
        }

        if (!this.trackCacheManager) {
          this.trackCacheManager = new TrackCacheManagerClass(
            this as unknown as { options: NodelinkConfig }
          ) as unknown as TrackCacheManager
        }
      })
      .finally(() => {
        this._persistenceManagersInitPromise = null
      })

    await this._persistenceManagersInitPromise
  }

  /**
   * Starts the heartbeat interval to keep WebSocket connections alive.
   *
   * No-op when running under `Bun.serve` because Bun handles WebSocket pings
   * natively via `websocket.sendPings: true`. Running both would double the
   * keepalive traffic.
   * @internal
   */
  _startHeartbeat() {
    if (this._heartbeatInterval) return
    if (this._usingBunServer) return

    this._heartbeatInterval = setInterval(() => {
      for (const session of this.sessions.activeSessions.values()) {
        if (session.socket && !session.isPaused) {
          try {
            if (session.socket.sendFrame) {
              session.socket.sendFrame(Buffer.alloc(0), {
                len: 0,
                fin: true,
                opcode: 0x09
              })
            } else if (session.socket.ping) {
              session.socket.ping()
            }
          } catch (_e) {
            logger(
              'debug',
              'Server',
              `Failed to send heartbeat to session ${session.id}`
            )
          }
        }
      }
    }, 45000)
  }

  /**
   * Stops the heartbeat interval
   * @internal
   */
  _stopHeartbeat() {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval)
      this._heartbeatInterval = null
    }
  }

  /**
   * Handles incoming voice frames and distributes them to registered sockets
   * @param frame - Voice frame buffer
   * @public
   */
  handleVoiceFrame(frame: Buffer): void {
    const header = parseVoiceFrameHeader(frame)
    if (!header?.guildId) return

    const sockets = this.voiceSockets.get(header.guildId)
    if (!sockets || sockets.size === 0) return

    for (const socket of sockets) {
      try {
        socket.send(frame)
      } catch {}
    }
  }

  /**
   * Registers a WebSocket to receive voice frames for a guild
   * @param guildId - Discord guild ID
   * @param socket - WebSocket connection
   * @public
   */
  registerVoiceSocket(guildId: string, socket: SessionSocket): void {
    if (!guildId || !socket) return

    let sockets = this.voiceSockets.get(guildId)
    if (!sockets) {
      sockets = new Set()
      this.voiceSockets.set(guildId, sockets)
    }

    sockets.add(socket)

    const cleanup = () => {
      const set = this.voiceSockets.get(guildId)
      if (!set) return
      set.delete(socket)
      if (set.size === 0) this.voiceSockets.delete(guildId)
    }

    socket.on('close', cleanup)
    socket.on('error', cleanup)
  }

  /**
   * Gets list of available sources from a worker
   * @returns Array of source names
   * @public
   */
  async getSourcesFromWorker() {
    if (!this.workerManager) {
      return []
    }
    const worker = this.workerManager.getBestWorker()
    if (!worker) {
      logger('warn', 'Server', 'No worker available to get sources from.')
      return []
    }
    const sources = await this.workerManager.execute(worker, 'getSources', {})
    return sources
  }

  /**
   * Validates the server configuration
   * @throws Error if configuration is invalid
   * @internal
   */
  _validateConfig(): void {
    const manager = new ConfigValidationManager(this.options)
    manager.validate()
  }

  /**
   * Sets up WebSocket server event handlers
   * @internal
   */
  _setupSocketEvents() {
    if (!this.socket) return

    this.socket.on('error', (error: Error) => {
      logger('error', 'WebSocket', `WebSocket server error: ${error.message}`)
    })

    this.socket.on(
      '/v4/websocket',
      (
        socket: SessionSocket,
        request: http.IncomingMessage,
        clientInfo: ClientInfo,
        oldSessionId: string
      ) => {
        this.pluginManager?.callHook(
          'onWebSocketConnect',
          socket,
          clientInfo,
          oldSessionId
        )

        const originalOn = socket.on.bind(socket)
        socket.on = (
          event: string,
          listener: (...args: (string | number | Buffer)[]) => void
        ) => {
          if (event === 'message') {
            return originalOn(
              event,
              async (...args: (string | number | Buffer)[]) => {
                const data = args[0]

                let parsedData: ParsedWebSocketData
                try {
                  const dataStr =
                    typeof data === 'string'
                      ? data
                      : (data as Buffer).toString()
                  parsedData = JSON.parse(dataStr)
                } catch {
                  parsedData = data as string | Buffer
                }

                const interceptors = this.extensions?.wsInterceptors
                if (interceptors && Array.isArray(interceptors)) {
                  for (const interceptor of interceptors) {
                    const handled = await interceptor(
                      this as INodelinkServer,
                      socket,
                      parsedData,
                      clientInfo
                    )
                    if (handled === true) return
                  }
                }

                this.pluginManager?.callHook(
                  'onWebSocketMessage',
                  socket,
                  parsedData,
                  socket.guildId
                )

                listener(...args)
              }
            )
          }

          if (event === 'close') {
            return originalOn(
              event,
              (...args: (string | number | Buffer)[]) => {
                this.pluginManager?.callHook(
                  'onWebSocketClose',
                  socket,
                  args[0], // code
                  args[1] // reason
                )

                listener(...args)
              }
            )
          }

          return originalOn(event, listener)
        }

        logger(
          'debug',
          'Resume',
          `Processing websocket connection. oldSessionId: ${oldSessionId}`
        )
        let session = null
        if (oldSessionId) {
          session = this.sessions.resume(oldSessionId, socket)

          if (!session) {
            logger(
              'warn',
              'Server',
              `Session-ID provided by ${clientInfo.name} does not exist or is not resumable: ${oldSessionId}, creating a new session`
            )
          }
        }

        if (session) {
          logger(
            'info',
            'Server',
            `\x1b[36m${clientInfo.name}\x1b[0m${
              clientInfo.version ? `/\x1b[32mv${clientInfo.version}\x1b[0m` : ''
            } resumed session with ID: ${oldSessionId}`
          )
          this.statsManager.incrementSessionResume(clientInfo.name, true)

          socket.on('close', (...args: (string | number | Buffer)[]) => {
            const code = args[0] as number
            const reason = args[1] as string
            if (!this.sessions.has(oldSessionId)) return

            const session = this.sessions.get(oldSessionId)
            if (!session) return

            logger(
              'info',
              'Server',
              `\x1b[36m${clientInfo.name}\x1b[0m/\x1b[32mv${
                clientInfo.version
              }\x1b[0m disconnected with code ${code} and reason: ${
                reason || 'without reason'
              }`
            )

            if (session.resuming) {
              this.sessions.pause(oldSessionId)
            } else {
              this.sessions.shutdown(oldSessionId)
            }

            const sessionCount = this.sessions.activeSessions?.size || 0
            this.statsManager.setWebsocketConnections(sessionCount)
          })

          socket.send(
            JSON.stringify({
              op: 'ready',
              resumed: true,
              sessionId: oldSessionId
            })
          )

          while (session.eventQueue.length > 0) {
            const event = session.eventQueue.shift()
            if (event) socket.send(event)
          }

          for (const [
            playerKey,
            playerInfo
          ] of session.players.players.entries()) {
            if (this.workerManager) {
              const worker = this.workerManager.getWorkerForGuild(playerKey)
              if (worker) {
                this.workerManager.execute(worker, 'playerCommand', {
                  sessionId: session.id,
                  guildId: playerInfo.guildId,
                  command: 'forceUpdate',
                  args: []
                })
              }
            } else {
              playerInfo._sendUpdate()
            }
          }

          const sessionCount = this.sessions.activeSessions?.size || 0
          this.statsManager.setWebsocketConnections(sessionCount)
        } else {
          const sessionId = this.sessions.create(
            request as unknown as RequestShim,
            socket,
            clientInfo
          )

          const sessionCount = this.sessions.activeSessions?.size || 0
          this.statsManager.setWebsocketConnections(sessionCount)

          socket.on('close', (...args: (string | number | Buffer)[]) => {
            const code = args[0] as number
            const reason = args[1] as string
            if (!this.sessions.has(sessionId)) return

            const session = this.sessions.get(sessionId)
            if (!session) return

            logger(
              'info',
              'Server',
              `\x1b[36m${clientInfo.name}\x1b[0m${
                clientInfo.version
                  ? `/\x1b[32mv${clientInfo.version}\x1b[0m`
                  : ''
              } disconnected with code ${code} and reason: ${
                reason || 'without reason'
              }`
            )

            if (session.resuming) {
              this.sessions.pause(sessionId)
            } else {
              this.sessions.shutdown(sessionId)
            }

            const sessionCount = this.sessions.activeSessions?.size || 0
            this.statsManager.setWebsocketConnections(sessionCount)
          })

          socket.send(
            JSON.stringify({
              op: 'ready',
              resumed: false,
              sessionId
            })
          )
        }
      }
    )

    this.socket.on(
      '/v4/profiler/socket',
      async (socket: SessionSocket, request: RequestShim) => {
        let streamTimer: NodeJS.Timeout | null = null
        let allocTimer: NodeJS.Timeout | null = null
        let stopped = false
        let tickInFlight = false
        let allocInFlight = false
        let lastAllocAt = 0
        let lastAllocReport: object | null = null
        const realtimeStore = getProfilerRealtimeStore()
        if (realtimeStore.lastAllocTop && !lastAllocReport) {
          lastAllocReport = realtimeStore.lastAllocTop
        }
        const prevById = new Map<
          string,
          {
            time: number
            heapUsed: number
            rss: number
            oldUsed?: number
            playersCount?: number
          }
        >()

        const requestHeaders = request.headers as
          | { host?: string | string[] }
          | undefined
        const requestHost = Array.isArray(requestHeaders?.host)
          ? requestHeaders.host[0]
          : requestHeaders?.host
        const url = new URL(
          request.url || '/v4/profiler/socket',
          `http://${requestHost || 'localhost'}`
        )
        const intervalMs = Math.min(
          15000,
          Math.max(700, Number(url.searchParams.get('intervalMs') || 2000))
        )
        const allocDurationMs = Math.min(
          15000,
          Math.max(
            1000,
            Number(url.searchParams.get('allocDurationMs') || 3000)
          )
        )
        const allocEveryRaw = Number(url.searchParams.get('allocEveryMs') || 0)
        const allocEveryMs =
          Number.isFinite(allocEveryRaw) && allocEveryRaw > 0
            ? Math.min(120000, Math.max(5000, Math.floor(allocEveryRaw)))
            : 0
        const payload: Record<string, unknown> = {
          scope: url.searchParams.get('scope') || 'all'
        }

        const cleanup = () => {
          stopped = true
          if (streamTimer) clearInterval(streamTimer)
          if (allocTimer) clearInterval(allocTimer)
          streamTimer = null
          allocTimer = null
        }

        const send = (obj: Record<string, unknown>) => {
          if (stopped) return
          try {
            socket.send(JSON.stringify(obj))
          } catch {
            cleanup()
          }
        }

        const refreshAllocTop = async () => {
          if (stopped || allocInFlight) return
          const now = Date.now()
          if (lastAllocReport && now - lastAllocAt < allocEveryMs) return

          allocInFlight = true
          try {
            const profilerApi = await getProfilerApi()
            lastAllocReport = await profilerApi.collectAllocationTopSites(
              this as unknown as Parameters<
                ProfilerApiModule['collectAllocationTopSites']
              >[0],
              {
                ...payload,
                durationMs: allocDurationMs,
                name: 'ws-alloc'
              }
            )
            lastAllocAt = Date.now()
            realtimeStore.lastAllocTop = lastAllocReport
            realtimeStore.updatedAt = lastAllocAt
          } catch (error) {
            lastAllocReport = {
              action: 'allocTop',
              failed: true,
              error: error instanceof Error ? error.message : String(error),
              timestamp: Date.now()
            }
            lastAllocAt = Date.now()
            realtimeStore.lastAllocTop = lastAllocReport
            realtimeStore.updatedAt = lastAllocAt
          } finally {
            allocInFlight = false
          }
        }

        const tick = async () => {
          if (stopped || tickInFlight) return
          tickInFlight = true
          try {
            const profilerApi = await getProfilerApi()
            const snapshot = await profilerApi.collectActionSnapshot(
              this as unknown as Parameters<
                ProfilerApiModule['collectActionSnapshot']
              >[0],
              'status',
              payload
            )
            const warnings = profilerApi.detectAnomalies(snapshot, prevById)
            send({
              op: 'profilerSnapshot',
              timestamp: Date.now(),
              snapshot,
              warnings,
              allocTop: lastAllocReport
            })
            realtimeStore.snapshots.push({
              timestamp: Date.now(),
              snapshot,
              warnings,
              allocTop: lastAllocReport
            })
            if (realtimeStore.snapshots.length > PROFILER_HISTORY_MAX) {
              realtimeStore.snapshots.shift()
            }
            realtimeStore.updatedAt = Date.now()
          } catch (error) {
            send({
              op: 'profilerError',
              timestamp: Date.now(),
              error: error instanceof Error ? error.message : String(error)
            })
          } finally {
            tickInFlight = false
          }
        }

        socket.on('close', cleanup)
        socket.on('error', cleanup)

        send({
          op: 'profilerReady',
          timestamp: Date.now(),
          intervalMs,
          allocEveryMs,
          allocDurationMs
        })
        send({
          op: 'profilerBootstrap',
          timestamp: Date.now(),
          history: realtimeStore.snapshots,
          lastAllocTop: realtimeStore.lastAllocTop,
          updatedAt: realtimeStore.updatedAt
        })

        if (allocEveryMs > 0) void refreshAllocTop()
        await tick()
        streamTimer = setInterval(() => {
          void tick()
        }, intervalMs)
        if (allocEveryMs > 0) {
          allocTimer = setInterval(() => {
            void refreshAllocTop()
          }, allocEveryMs)
        }
      }
    )

    this.socket?.on(
      '/v4/websocket/voice',
      (
        socket: SessionSocket,
        request: RequestShim,
        _clientInfo: ClientInfo,
        _sessionId: string,
        guildId: string
      ) => {
        socket.guildId = guildId

        if (!this.options.playback.voiceReceive?.enabled) {
          try {
            socket.close(1008, 'Voice receive disabled')
          } catch {}
          return
        }

        logger(
          'info',
          'Voice',
          `Voice websocket connected from ${request.socket?.remoteAddress || 'unknown'} | guild ${guildId}`
        )

        this.registerVoiceSocket(guildId, socket)
      }
    )

    this.socket?.on(
      '/v4/websocket/youtube/live',
      (
        socket: SessionSocket,
        request: RequestShim,
        _clientInfo: ClientInfo,
        _sessionId: string,
        id: string
      ) => {
        let videoId = id
        socket.guildId = id // Tag it with videoId or guildId equivalent

        if (/^\d{17,20}$/.test(id)) {
          const player = this.sessions.getPlayer(id)
          if (player?.track?.info?.sourceName?.includes('youtube')) {
            videoId = player.track.info.identifier
          }
        } else if (id.length > 50) {
          try {
            const decoded = decodeTrack(id)
            if (decoded?.info?.sourceName?.includes('youtube')) {
              videoId = decoded.info.identifier
            }
          } catch (_e) {}
        }

        if (!this.sourceWorkerManager) {
          const yt = this.sources?.getSource('youtube')
          if (!yt) {
            socket.close(1008, 'YouTube source not enabled')
            return
          }
          const liveChatFn = yt.handleLiveChat
          if (liveChatFn) {
            liveChatFn.call(yt, socket, videoId)
          } else {
            socket.close(1008, 'YouTube live chat not supported')
          }
          return
        }

        logger(
          'info',
          'YouTube-LiveChat',
          `Delegating live chat for video: ${videoId} to worker`
        )

        const resShim = {
          headersSent: false,
          send: (data: string | Buffer) => {
            const payload = Buffer.isBuffer(data)
              ? data
              : Buffer.from(String(data))
            socket.sendFrame?.(payload, {
              len: payload.length,
              fin: true,
              opcode: Buffer.isBuffer(data) ? 0x02 : 0x01
            })
          },
          writeHead: (status: number) => {
            if (status !== 200) socket.close(1011, 'Worker failed')
          },
          write: (data: string | Buffer) => {
            const payload = Buffer.isBuffer(data)
              ? data
              : Buffer.from(String(data))
            socket.sendFrame?.(payload, {
              len: payload.length,
              fin: true,
              opcode: Buffer.isBuffer(data) ? 0x02 : 0x01
            })
          },
          end: () => socket.close(1000, 'Finished'),
          on: (
            event: string,
            cb: (...args: (string | Buffer | number)[]) => void
          ) => socket.on(event, cb)
        }

        this.sourceWorkerManager.delegate(
          request,
          resShim,
          'loadLiveChat',
          { videoId },
          { isWebSocket: true }
        )
      }
    )
  }

  /**
   * Creates and configures Bun HTTP server with WebSocket support
   * @internal
   */
  _createBunServer() {
    this.server = createBunServer(
      this as unknown as import('./server/bunServer.ts').BunServerContext,
      getRequestHandler
    )
  }

  /**
   * Creates HTTP server (Node.js or Bun)
   * @internal
   */
  _createServer() {
    if (this._usingBunServer) {
      this._createBunServer()
      return
    }

    this.server = http.createServer(
      (req: http.IncomingMessage, res: http.ServerResponse) => {
        this.pluginManager?.callHook('onRESTRequest', req, res)

        if (res.writableEnded) return

        void getRequestHandler()
          .then((handler) =>
            handler(
              this as unknown as Parameters<RequestHandlerType>[0],
              req,
              res
            )
          )
          .catch((error: Error) => {
            logger(
              'error',
              'Server',
              `Failed to handle HTTP request: ${error.message}`
            )
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'text/plain' })
            }
            res.end('Internal Server Error')
          })
      }
    )

    ;(this.server as http.Server).keepAliveTimeout = 65000
    ;(this.server as http.Server).headersTimeout = 66000

    ;(this.server as http.Server).on(
      'connection',
      (socket: import('net').Socket) => {
        // Guard all HTTP sockets (including plain GET /v4/profiler/ui) against
        // abrupt client disconnect races that can surface as EPIPE/ECONNRESET.
        socket.on('error', (err: NodeJS.ErrnoException) => {
          if (err?.code === 'EPIPE' || err?.code === 'ECONNRESET') return
          logger('debug', 'Server', `HTTP socket error: ${err.message}`)
        })
      }
    )

    ;(this.server as http.Server).on(
      'clientError',
      (err: NodeJS.ErrnoException, socket: import('net').Socket): void => {
        if (err?.code !== 'EPIPE' && err?.code !== 'ECONNRESET') {
          logger('debug', 'Server', `HTTP client error: ${err.message}`)
        }
        try {
          if (!socket.destroyed) socket.destroy()
        } catch {}
      }
    )

    ;(this.server as http.Server).on(
      'upgrade',
      (
        request: http.IncomingMessage,
        socket: import('net').Socket,
        head: Buffer
      ) => {
        // Guard upgrade sockets against EPIPE/ECONNRESET races when clients disconnect mid-upgrade.
        socket.on('error', (err: NodeJS.ErrnoException) => {
          if (err?.code === 'EPIPE' || err?.code === 'ECONNRESET') return
          logger('debug', 'Server', `Upgrade socket error: ${err.message}`)
        })

        const { remoteAddress, remotePort } = request.socket
        const isInternal =
          /^(::1|localhost|127\.0\.0\.1)/.test(remoteAddress || '') ||
          /^::ffff:127\.0\.0\.1/.test(remoteAddress || '')
        const clientAddress = `${isInternal ? '[Internal]' : '[External]'} (${remoteAddress}:${remotePort})`

        const rejectUpgrade = (
          status: number,
          statusText: string,
          body: string
        ) => {
          if (socket.destroyed || !socket.writable) {
            try {
              socket.destroy()
            } catch {}
            return
          }

          const payload =
            `HTTP/1.1 ${status} ${statusText}\r\n` +
            'Nodelink-Api-Version: 4\r\n' +
            'IamNodelink: true\r\n' +
            'Content-Type: text/plain\r\n' +
            `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
            body

          socket.end(payload, () => {
            try {
              socket.destroy()
            } catch {}
          })
        }

        const originalHeaders = request.headers
        const headers: Record<string, string | string[]> = {}
        for (const key in originalHeaders) {
          const value = originalHeaders[key]
          if (value !== undefined) {
            headers[key.toLowerCase()] = value
          }
        }

        logger(
          'debug',
          'Resume',
          `Received headers (lowercased): ${JSON.stringify(headers)}`
        )

        const parsedUpgradeUrl = new URL(
          request.url || '/',
          `http://${request.headers.host || 'localhost'}`
        )
        const { pathname } = parsedUpgradeUrl

        if (pathname === '/v4/profiler/socket') {
          const endpoint = this.options.cluster?.endpoint || {}
          const patchEnabled = endpoint.patchEnabled === true
          const allowExternalPatch = endpoint.allowExternalPatch === true
          const expectedCode =
            typeof endpoint.code === 'string' && endpoint.code.length > 0
              ? endpoint.code
              : 'CAPYBARA'

          const queryCode = parsedUpgradeUrl.searchParams.get('code')
          const headerCode =
            headers['x-nodelink-code'] || headers['x-worker-code']
          const providedCode =
            queryCode ||
            (Array.isArray(headerCode) ? headerCode[0] : headerCode)

          if (!patchEnabled) {
            return rejectUpgrade(
              403,
              'Forbidden',
              'Profiler socket endpoint is disabled.'
            )
          }

          if (!allowExternalPatch && !isInternal) {
            return rejectUpgrade(
              403,
              'Forbidden',
              'External profiler socket access is blocked.'
            )
          }

          if (!providedCode || providedCode !== expectedCode) {
            return rejectUpgrade(
              403,
              'Forbidden',
              'Invalid or missing profiler code.'
            )
          }

          for (const key in headers) {
            const value = headers[key]
            if (typeof value === 'string') {
              request.headers[key] = value
            }
          }

          logger(
            'info',
            'ProfilerSocket',
            `Profiler socket connected from ${clientAddress} | \x1b[33mURL:\x1b[0m ${request.url}`
          )

          ;(this.socket as WebSocketServer | undefined)?.handleUpgrade(
            request,
            socket,
            head,
            null,
            (ws) =>
              this.socket?.emit(
                '/v4/profiler/socket',
                ws as SessionSocket,
                request,
                { name: 'ProfilerUI', version: '1' },
                null,
                null
              )
          )
          return
        }

        // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index signature access
        const authorization = headers['authorization']
        const authValue = Array.isArray(authorization)
          ? authorization[0]
          : authorization
        if (authValue !== this.options.server.password) {
          logger(
            'warn',
            'Server',
            `Unauthorized connection attempt from ${clientAddress} - Invalid password provided: ${authValue || 'None'}`
          )
          return rejectUpgrade(
            401,
            'Unauthorized',
            'Invalid password provided.'
          )
        }
        const clientNameHeader = headers['client-name']
        const clientInfo = parseClient(
          Array.isArray(clientNameHeader)
            ? clientNameHeader[0]
            : clientNameHeader
        ) as {
          name: string
          version: string | undefined
        }
        if (!clientInfo) {
          logger(
            'warn',
            'Server',
            `Unauthorized connection attempt from ${clientAddress} - Invalid client-name provided`
          )
          return rejectUpgrade(
            400,
            'Bad Request',
            'Invalid or missing Client-Name header.'
          )
        }

        let sessionId = headers['session-id']
        if (Array.isArray(sessionId)) sessionId = sessionId[0]

        logger('debug', 'Resume', `Received session-id header: ${sessionId}`)
        if (sessionId && !this.sessions.resumableSessions.has(sessionId)) {
          logger(
            'warn',
            'Server',
            `Session-ID provided by ${clientAddress} does not exist or is not resumable: ${sessionId}, creating a new session`
          )
          sessionId = undefined
        }

        const voiceMatch = pathname.match(
          /^\/v4\/websocket\/voice\/([A-Za-z0-9]+)\/?$/
        )
        const liveMatch = pathname.match(
          /^\/v4\/websocket\/youtube\/live\/([^/]+)\/?$/
        )

        if (pathname === '/v4/websocket' || voiceMatch || liveMatch) {
          if (!headers['user-id']) {
            logger(
              'warn',
              'Server',
              `Unauthorized connection attempt from ${clientAddress} - Missing user ID`
            )
            return rejectUpgrade(
              400,
              'Bad Request',
              'User-Id header is missing.'
            )
          }
          const userIdHeader = headers['user-id']
          const userId = Array.isArray(userIdHeader)
            ? userIdHeader[0]
            : userIdHeader
          if (!userId || !verifyDiscordID(userId)) {
            logger(
              'warn',
              'Server',
              `Unauthorized connection attempt from ${clientAddress} - Invalid user ID provided`
            )
            return rejectUpgrade(400, 'Bad Request', 'Invalid User-Id header.')
          }

          if (voiceMatch && !this.options.playback.voiceReceive?.enabled) {
            return rejectUpgrade(
              404,
              'Not Found',
              'Voice websocket endpoint is disabled.'
            )
          }

          for (const key in headers) {
            const value = headers[key]
            if (typeof value === 'string') {
              request.headers[key] = value
            }
          }

          logger(
            'info',
            'Server',
            `\x1b[36m${clientInfo.name}\x1b[0m${
              clientInfo.version ? `/\x1b[32mv${clientInfo.version}\x1b[0m` : ''
            } connected from ${clientAddress} | \x1b[33mURL:\x1b[0m ${request.url}`
          )

          let eventName = '/v4/websocket'
          let routeId = null

          if (voiceMatch) {
            eventName = '/v4/websocket/voice'
            routeId = voiceMatch[1]
          } else if (liveMatch) {
            eventName = '/v4/websocket/youtube/live'
            routeId = liveMatch[1]
          }

          if (isBun && !this._usingBunServer && this.socket) {
            ;(this.socket as WebSocketServer).handleUpgrade(
              request,
              socket,
              head,
              null,
              (ws) => {
                this.socket?.emit(
                  eventName,
                  ws as SessionSocket,
                  request,
                  clientInfo,
                  sessionId,
                  routeId
                )
              }
            )
          } else {
            ;(this.socket as WebSocketServer | undefined)?.handleUpgrade(
              request,
              socket,
              head,
              null,
              (ws) =>
                this.socket?.emit(
                  eventName,
                  ws as SessionSocket,
                  request,
                  clientInfo,
                  sessionId,
                  routeId
                )
            )
          }
        } else {
          logger(
            'warn',
            'Server',
            `Unauthorized connection attempt from ${clientAddress} - Invalid path provided`
          )
          return rejectUpgrade(
            404,
            'Not Found',
            'Invalid path for WebSocket upgrade.'
          )
        }
      }
    )
  }

  /**
   * Starts listening on configured port and host
   * @internal
   */
  _listen(): void {
    if (
      !this.server ||
      typeof (this.server as http.Server).listen !== 'function'
    )
      return

    const port = this.options.server.port
    const host = this.options.server.host || '0.0.0.0'

    logger(
      'info',
      'Server',
      `Attempting to listen on host: ${host}, port: ${port}`
    )

    ;(this.server as http.Server).on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        logger('error', 'Server', `Port ${port} is already in use.`)
      } else if (err.code === 'EADDRNOTAVAIL') {
        logger(
          'error',
          'Server',
          `The address ${host} is not available on this machine.`
        )
        logger(
          'error',
          'Server',
          'Please check your `host` configuration. Use "0.0.0.0" to listen on all available interfaces.'
        )
      } else {
        logger('error', 'Server', `Failed to start server: ${err.message}`)
      }
      process.exit(1)
    })

    ;(this.server as http.Server).listen(port, host, () => {
      logger(
        'started',
        'Server',
        `Successfully listening on host ${host}, port ${port}`
      )
    })
  }

  /**
   * Starts global player state updater interval
   * @internal
   */
  _startGlobalUpdater() {
    if (this._globalUpdater) return
    const updateInterval = Math.max(
      1,
      this.options?.playback.playerUpdateInterval ?? 5000
    )
    const statsSendInterval = Math.max(
      1,
      this.options?.playback.statsUpdateInterval ?? 30000
    )
    const metricsInterval = this.options?.api.metrics?.enabled
      ? 5000
      : statsSendInterval
    const zombieThreshold = this.options?.playback.zombieThresholdMs ?? 60000

    this._globalUpdater = setInterval(() => {
      for (const session of this.sessions.values()) {
        if (!session.players) continue
        for (const player of session.players.players.values()) {
          if (player?.track && !player.isPaused && player.connection) {
            if (
              player.connStatus === 'connected' &&
              player._lastStreamDataTime > 0 &&
              Date.now() - player._lastStreamDataTime >= zombieThreshold
            ) {
              logger(
                'warn',
                'Player',
                `Player for guild ${player.guildId} detected as zombie (no stream data).`
              )
              player.emitEvent(GatewayEvents.TRACK_STUCK, {
                guildId: player.guildId,
                track: player.track,
                reason: 'no_stream_data',
                thresholdMs: zombieThreshold
              })
            }
            player._sendUpdate()
          }
        }
      }
    }, updateInterval)

    let lastStatsSendTime = 0
    this._statsUpdater = setInterval(() => {
      const now = Date.now()
      let localPlayers = 0
      let localPlayingPlayers = 0
      let voiceConnections = 0

      for (const session of this.sessions.values()) {
        if (!session.players) continue
        for (const player of session.players.players.values()) {
          localPlayers++
          if (!player.isPaused && player.track) {
            localPlayingPlayers++
          }
          if (player.connection) {
            voiceConnections++
          }
        }
      }

      this.statsManager.setVoiceConnections(voiceConnections)

      if (clusterEnabled && cluster.isWorker) {
        // fishy ports to typescript 🙃
        process.send?.({
          type: 'workerStats',
          stats: {
            players: localPlayers,
            playingPlayers: localPlayingPlayers
          }
        })
      } else if (!clusterEnabled) {
        this.statistics.players = localPlayers
        this.statistics.playingPlayers = localPlayingPlayers
      }

      const stats = getStats(this)
      const workerMetrics = this.workerManager
        ? (this.workerManager.getWorkerMetrics() as Record<
            string,
            import('./typings/api/stats.types.ts').WorkerMetricsEntry
          >)
        : null
      this.statsManager.updateStatsMetrics(
        stats,
        (workerMetrics ?? undefined) as null | undefined
      )

      if (now - lastStatsSendTime >= statsSendInterval) {
        lastStatsSendTime = now
        const statsPayload = JSON.stringify({ op: 'stats', ...stats })

        for (const session of this.sessions.values()) {
          if (session.socket) {
            session.socket.send(statsPayload)
          }
        }
      }
    }, metricsInterval)
  }

  /**
   * Stops global player updater interval
   * @internal
   */
  _stopGlobalPlayerUpdater() {
    if (this._globalUpdater) {
      clearInterval(this._globalUpdater)
      this._globalUpdater = null
    }
    if (this._statsUpdater) {
      clearInterval(this._statsUpdater)
      this._statsUpdater = null
    }
  }

  /**
   * Cleans up WebSocket server resources
   * @internal
   */
  async _cleanupWebSocketServer(): Promise<void> {
    if (this._usingBunServer && this.server) {
      await cleanupBunServer(
        this as unknown as import('./server/bunServer.ts').BunServerContext,
        this.server as {
          stop: (force?: boolean) => Promise<void>
          unref: () => void
        }
      )
      return
    }

    if (this.socket) {
      try {
        let closedCount = 0

        for (const session of this.sessions.activeSessions.values()) {
          if (session.socket) {
            try {
              session.socket.close(1000, 'Server shutdown')
              closedCount++
            } catch (_e) {
              try {
                session.socket.destroy?.()
              } catch (_destroyErr) {
                logger(
                  'debug',
                  'WebSocket',
                  `Failed to close/destroy socket for session ${session.id}`
                )
              }
            }
          }
        }

        this.sessions.activeSessions.clear()
        this.sessions.resumableSessions.clear()

        logger(
          'info',
          'WebSocket',
          `Closed ${closedCount} WebSocket connection(s) successfully`
        )
      } catch (error) {
        const err = error as Error
        logger(
          'error',
          'WebSocket',
          `Error closing WebSocket connections: ${err.message}`
        )
      }
    }
  }

  /**
   * Handles IPC messages from workers
   * @param msg - IPC message
   * @public
   */
  handleIPCMessage(msg: IPCMessage): void {
    this.pluginManager?.callHook('onIPCMessage', msg)

    if (msg.type === 'playerEvent') {
      const { sessionId, data } = msg.payload
      const session = this.sessions.get(sessionId)
      // [feat] session-resuming-queue: queue events when session is paused with resuming enabled
      if (session?.isPaused && session.resuming) {
        session.eventQueue.push(data)
      } else {
        session?.socket?.send(data)
      }
    } else if (msg.type === 'workerStats') {
      if (this.workerManager) {
        const worker = this.workerManager.workers.find(
          (w) => w.process.pid === msg.pid
        )
        if (worker) {
          this.workerManager.workerLoad.set(worker.id, msg.stats.players)
        }
      }
    } else if (msg.type === 'workerFailed') {
      const { workerId, affectedGuilds } = msg.payload
      logger(
        'warn',
        'Cluster',
        `Worker ${workerId} failed. Notifying clients for affected players: ${affectedGuilds.join(', ')}`
      )

      const sessionsToNotify = new Map()

      for (const playerKey of affectedGuilds) {
        const [sessionId, guildId] = playerKey.split(':')
        if (!sessionsToNotify.has(sessionId)) {
          sessionsToNotify.set(sessionId, new Set())
        }
        sessionsToNotify.get(sessionId).add(guildId)
      }

      for (const [sessionId, guildsInSession] of sessionsToNotify.entries()) {
        const session = this.sessions.get(sessionId)
        if (session?.socket) {
          const affected = Array.from(guildsInSession)
          session.socket.send(
            JSON.stringify({
              op: 'event',
              type: 'WorkerFailedEvent',
              affectedGuilds: affected,
              message: `Players for guilds ${affected.join(', ')} lost due to worker failure.`
            })
          )
          for (const guildId of affected) {
            session.socket.send(
              JSON.stringify({
                op: 'event',
                type: GatewayEvents.WEBSOCKET_CLOSED,
                guildId,
                code: 5001,
                reason: 'worker_failed',
                byRemote: false
              })
            )
          }
        }
      }
    }
  }

  /**
   * Starts the NodeLink server
   * @param startOptions - Cluster start options
   * @returns Server instance
   * @public
   */
  async start(
    startOptions: { isClusterPrimary?: boolean; isClusterWorker?: boolean } = {}
  ): Promise<NodelinkServer> {
    const runningNonLts = !process.release?.lts
    const unsupportedRuntime = !isRuntimeAtLeast(
      process.version,
      MINIMUM_NODE_VERSION
    )
    let latestLts: string | null = null

    await this._ensurePersistenceManagers()
    await this.credentialManager?.load()
    latestLts = await getLatestNodeLtsVersion(this.credentialManager)

    if (unsupportedRuntime) {
      throw new Error(
        `Unsupported Node.js runtime (${process.version}). This version is below the stable baseline (v${MINIMUM_NODE_VERSION}), so functionality is not guaranteed. Latest LTS: ${latestLts ?? 'unavailable'}. If errors occur, update Node.js to LTS.`
      )
    }

    const belowLatestLts = latestLts
      ? !isRuntimeAtLeast(process.version, latestLts)
      : false
    const aboveOrEqualLatestLts = latestLts
      ? isRuntimeAtLeast(process.version, latestLts)
      : false

    if (runningNonLts && aboveOrEqualLatestLts) {
      logger(
        'warn',
        'Server',
        `Non-LTS preview runtime detected (${process.version}), at or above latest LTS (${latestLts ?? 'unavailable'}). Accepted, but behavior may change between releases.`
      )
    } else if (runningNonLts) {
      logger(
        'warn',
        'Server',
        `Non-LTS runtime detected (${process.version}) between stable baseline (v${MINIMUM_NODE_VERSION}) and latest LTS (${latestLts ?? 'unavailable'}). Accepted, but stability is lower than LTS.`
      )
    } else if (belowLatestLts) {
      logger(
        'info',
        'Server',
        `Runtime ${process.version} is supported (>= v${MINIMUM_NODE_VERSION}) but below latest LTS (${latestLts ?? 'unavailable'}). If issues appear, consider updating to LTS.`
      )
    }

    memoryTrace('start:enter')
    this._validateConfig()

    if (!startOptions.isClusterPrimary) {
      await this._ensurePersistenceManagers()
      await this.credentialManager?.load()
      memoryTrace('start:after-credential-load')
      await this.trackCacheManager?.load()
      memoryTrace('start:after-trackcache-load')
    } else {
      memoryTrace('start:skip-persistence-load-primary')
    }
    await this.statsManager.initialize()
    memoryTrace(
      startOptions.isClusterPrimary
        ? 'start:after-stats-init-primary'
        : 'start:after-stats-init'
    )

    // Ensure sources are initialized before proceeding
    if (this._sourceInitPromise) await this._sourceInitPromise
    memoryTrace('start:after-source-init')

    await this.pluginManager.load('master')
    memoryTrace('start:after-master-plugin-load')

    if (
      startOptions.isClusterPrimary &&
      this.options.cluster?.specializedSourceWorker?.enabled &&
      !this.sourceWorkerManager
    ) {
      const SourceWorkerManagerClass = await getSourceWorkerManagerClass()
      this.sourceWorkerManager = new SourceWorkerManagerClass(this)
      memoryTrace('start:after-source-worker-manager-ctor')
    }

    if (this.sourceWorkerManager) {
      await this.sourceWorkerManager.start()
      memoryTrace('start:after-source-worker-manager-start')
    }

    const specEnabled = this.options.cluster?.specializedSourceWorker?.enabled

    await this._ensureConnectionManager()
    memoryTrace('start:after-connection-manager')

    if (!startOptions.isClusterPrimary) {
      await this.pluginManager.load('worker')
      memoryTrace('start:after-worker-plugin-load')
    }

    if (this.sources && (!startOptions.isClusterPrimary || !specEnabled)) {
      await this.sources?.loadFolder()
      await this.lyrics?.loadFolder()
      await this.meanings?.loadFolder()
      memoryTrace('start:after-sources-load')
    }

    this._setupSocketEvents()
    memoryTrace('start:after-setup-socket-events')
    this._createServer()
    memoryTrace('start:after-create-server')

    if (startOptions.isClusterWorker) {
      logger(
        'info',
        'Server',
        'Running as cluster worker — waiting for sockets from master.'
      )
      process.on('message', (msg: IPCMessage | { type: string }, handle) => {
        if (msg?.type !== 'sticky-session') return
        if (!handle) return
        try {
          try {
            // @ts-expect-error - handle.pause is from Node.js internal
            handle.pause?.()
          } catch (_e) {}
          ;(this.server as http.Server).emit('connection', handle)
        } catch (err) {
          const error = err as Error
          logger(
            'error',
            'Server',
            `Failed to inject socket from master: ${error.message}`
          )
          try {
            // @ts-expect-error - handle.destroy is from Node.js internal
            handle.destroy?.()
          } catch (_e) {}
        }
      })
    } else {
      this._listen()
    }

    if (startOptions.isClusterPrimary) {
      this._startMasterMetricsUpdater()
    } else {
      this._startGlobalUpdater()
    }

    if (!startOptions.isClusterPrimary || clusterEnabled) {
      this._startHeartbeat()
    }

    this.connectionManager?.start()
    memoryTrace('start:ready')

    return this
  }

  /**
   * Starts metrics updater for cluster master process
   * @internal
   */
  _startMasterMetricsUpdater() {
    if (this._globalUpdater) return
    const statsSendInterval = Math.max(
      1,
      this.options?.playback.statsUpdateInterval ?? 30000
    )
    const metricsInterval = this.options?.api.metrics?.enabled
      ? 5000
      : statsSendInterval

    let lastStatsSendTime = 0

    this._globalUpdater = setInterval(() => {
      const now = Date.now()
      const stats = getStats(this)
      const workerMetrics = this.workerManager
        ? (this.workerManager.getWorkerMetrics() as Record<
            string,
            import('./typings/api/stats.types.ts').WorkerMetricsEntry
          >)
        : null
      this.statsManager.updateStatsMetrics(
        stats,
        (workerMetrics ?? undefined) as null | undefined
      )

      const sessionCount = this.sessions.activeSessions?.size || 0
      this.statsManager.setWebsocketConnections(sessionCount)

      if (now - lastStatsSendTime >= statsSendInterval) {
        lastStatsSendTime = now
        const statsPayload = JSON.stringify({ op: 'stats', ...stats })
        for (const session of this.sessions.values()) {
          if (session.socket) {
            session.socket.send(statsPayload)
          }
        }
      }
    }, metricsInterval)
  }

  /**
   * Registers a custom source extension
   * @param name - Source name
   * @param source - Source extension implementation
   * @public
   */
  registerSource(name: string, source: SourceExtension): void {
    if (!this.sources) {
      logger(
        'warn',
        'Server',
        'Cannot register source in this context (sources manager not available).'
      )
      return
    }
    this.sources.sources.set(
      name,
      source as unknown as import('./typings/sources/source.types.ts').SourceInstance
    )
    logger('info', 'Server', `Registered custom source: ${name}`)
  }

  /**
   * Registers a custom filter extension
   * @param name - Filter name
   * @param filter - Filter extension implementation
   * @public
   */
  registerFilter(name: string, filter: FilterExtension): void {
    this.extensions.filters.set(name, filter)
    logger('info', 'Server', `Registered custom filter: ${name}`)
  }

  /**
   * Registers a custom HTTP route
   * @param method - HTTP method
   * @param path - Route path
   * @param handler - Route handler function
   * @public
   */
  registerRoute(
    method: string,
    path: string,
    handler: RouteExtension['handler']
  ): void {
    this.extensions.routes.push({ method, path, handler })
    logger('info', 'Server', `Registered custom route: ${method} ${path}`)
  }

  /**
   * Registers a middleware extension
   * @param fn - Middleware function
   * @public
   */
  registerMiddleware(fn: ApiMiddlewareExtension): void {
    this.extensions.middlewares.push(fn)
    logger('info', 'Server', 'Registered custom REST interceptor (middleware)')
  }

  /**
   * Registers a track modifier extension
   * @param fn - Track modifier function
   * @public
   */
  registerTrackModifier(fn: TrackModifierExtension): void {
    this.extensions.trackModifiers.push(fn)
    logger('info', 'Server', 'Registered custom track info modifier')
  }

  /**
   * Registers a WebSocket interceptor extension
   * @param fn - WebSocket interceptor function
   * @public
   */
  registerWebSocketInterceptor(fn: WebSocketInterceptorExtension): void {
    this.extensions.wsInterceptors.push(fn)
    logger('info', 'Server', 'Registered custom WebSocket interceptor')
  }

  /**
   * Registers an audio interceptor extension
   * @param interceptor - Audio interceptor function
   * @public
   */
  registerAudioInterceptor(interceptor: AudioInterceptorExtension): void {
    if (!this.extensions.audioInterceptors)
      this.extensions.audioInterceptors = []
    this.extensions.audioInterceptors.push(interceptor)
    logger('info', 'Server', 'Registered custom audio interceptor')
  }

  /**
   * Registers a player interceptor extension
   * @param interceptor - Player interceptor function
   * @public
   */
  registerPlayerInterceptor(interceptor: PlayerInterceptorExtension): void {
    this.extensions.playerInterceptors.push(interceptor)
    logger('info', 'Server', 'Registered custom player interceptor')
  }
}

// Guard the master / single-process against unhandled socket errors (EPIPE,
// ECONNRESET) that surface when a WebSocket client disconnects mid-write and
// the underlying library has already removed listeners via removeAllListeners().
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err?.code === 'EPIPE' || err?.code === 'ECONNRESET') {
    logger('debug', 'Server', `Suppressed uncaught socket error: ${err.code}`)
    return
  }

  logger('error', 'Server', `Uncaught Exception: ${err.stack || err.message}`)
  process.stderr.write('', () => process.exit(1))
})

process.on('unhandledRejection', (reason, promise) => {
  logger(
    'error',
    'Server',
    `Unhandled Rejection at: ${promise}, reason: ${reason}`
  )
})

if (clusterEnabled && cluster.isPrimary) {
  if (config.sources?.youtube?.getOAuthToken) {
    // dynamically import OAuth (if enabled)
    const OAuth = (
      await import('./sources/youtube/OAuth.ts').catch((e) => {
        logger(
          'error',
          'youtube',
          `\x1b[1m\x1b[31mOAuth class not found Error: ${e.message}\x1b[0m`
        )
        process.exit(1)
      })
    ).default

    const CredentialManagerClass = await getCredentialManagerClass()
    const mockNodelink: {
      options: NodelinkConfig
      credentialManager: CredentialManager
    } = {
      options: config,
      credentialManager: null as unknown as CredentialManager
    }
    mockNodelink.credentialManager = new CredentialManagerClass(
      mockNodelink as unknown as INodelinkServer
    ) as unknown as CredentialManager
    const validator = new OAuth(mockNodelink as unknown as INodelinkServer)
    await validator.validateCurrentTokens()

    try {
      await OAuth.acquireRefreshToken()
      process.exit(0)
    } catch (error) {
      const err = error as Error
      logger(
        'error',
        'OAuth',
        `YouTube OAuth token acquisition failed: ${err.message}`
      )
      process.exit(1)
    }
  }

  const WorkerManagerClass = await getWorkerManagerClass()
  memoryTrace('primary:after-worker-manager-class-import')
  const PlayerManagerClass = await getPlayerManagerClass()
  memoryTrace('primary:after-player-manager-class-import')
  const workerManager = new WorkerManagerClass(config)
  memoryTrace('primary:after-worker-manager-ctor')

  const serverInstancePromise = (async () => {
    const nserver = new NodelinkServer(config, PlayerManagerClass, true)
    memoryTrace('primary:after-server-ctor')
    nserver.workerManager = workerManager

    await nserver.start({ isClusterPrimary: true })
    ;(global as typeof globalThis & { nodelink?: NodelinkServer }).nodelink =
      nserver

    let isShuttingDown = false
    const shutdown = async () => {
      if (isShuttingDown) return
      isShuttingDown = true

      if (nserver.workerManager) nserver.workerManager.isDestroying = true
      nserver.emit('shutdown')

      process.stdout.write(
        '\n  \x1b[32m💚 Thank you for using NodeLink!\x1b[0m\n'
      )
      process.stdout.write(
        '  \x1b[37mIf you have ideas, suggestions or want to report bugs, join us on Discord:\x1b[0m\n'
      )
      process.stdout.write(
        '  \x1b[1m\x1b[34m➜\x1b[0m \x1b[36mhttps://discord.gg/fzjksWS65v\x1b[0m\n\n'
      )
      process.stdout.write(
        '  \x1b[1m\x1b[35m➜\x1b[0m \x1b[35mHaving issues? Use "git checkout dev" to see if it\'s fixed.\x1b[0m\n'
      )
      process.stdout.write(
        '  \x1b[1m\x1b[35m➜\x1b[0m \x1b[35mRead the FAQ & follow the support template in our Discord.\x1b[0m\n\n'
      )

      logger(
        'info',
        'Server',
        'Shutdown signal received. Cleaning up resources...'
      )

      nserver._stopHeartbeat()

      await nserver.credentialManager?.forceSave()
      await nserver.trackCacheManager?.forceSave()

      nserver.sourceWorkerManager?.destroy?.()
      workerManager.destroy()

      await nserver._cleanupWebSocketServer()

      if ((nserver.server as http.Server)?.listening) {
        await new Promise((resolve) =>
          (nserver.server as http.Server).close(resolve)
        )
        logger('info', 'Server', 'HTTP server closed.')
      }

      cleanupHttpAgents()
      nserver.rateLimitManager.destroy()
      nserver.dosProtectionManager.destroy()
      cleanupLogger()

      process.exit(0)
    }

    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)

    return nserver
  })()

  await serverInstancePromise.catch((err) => {
    logger(
      'error',
      'Server',
      `Fatal error during primary startup: ${err.message}`,
      err
    )
    process.exit(1)
  })
} else if (clusterEnabled && cluster.isWorker) {
  await import('./workers/main.ts')
} else {
  const serverInstancePromise = (async () => {
    const PlayerManagerClass = await getPlayerManagerClass()
    const nserver = new NodelinkServer(config, PlayerManagerClass, false)
    await nserver.start()
    ;(global as typeof globalThis & { nodelink?: NodelinkServer }).nodelink =
      nserver

    logger(
      'info',
      'Server',
      `Single-process server running (PID ${process.pid})`
    )

    let isShuttingDown = false
    const shutdown = async () => {
      if (isShuttingDown) return
      isShuttingDown = true

      logger(
        'info',
        'Server',
        'Shutdown signal received. Cleaning up resources...'
      )

      nserver._stopHeartbeat()

      await nserver.credentialManager?.forceSave()
      await nserver.trackCacheManager?.forceSave()

      nserver.sourceWorkerManager?.destroy?.()
      nserver.workerManager?.destroy?.()
      nserver.connectionManager?.destroy?.()
      nserver.proxyManager?.destroy?.()
      nserver.routePlanner?.dispose?.()
      nserver.credentialManager?.destroy?.()
      nserver.trackCacheManager?.destroy?.()

      await nserver._cleanupWebSocketServer()

      if ((nserver.server as http.Server)?.listening) {
        await new Promise((resolve) =>
          (nserver.server as http.Server).close(resolve)
        )
        logger('info', 'Server', 'HTTP server closed.')
      }

      cleanupHttpAgents()
      nserver.rateLimitManager.destroy()
      nserver.dosProtectionManager.destroy()
      cleanupLogger()

      process.stdout.write(
        '\n  \x1b[32m💚 Thank you for using NodeLink!\x1b[0m\n'
      )
      process.stdout.write(
        '  \x1b[37mIf you have ideas, suggestions or want to report bugs, join us on Discord:\x1b[0m\n'
      )
      process.stdout.write(
        '  \x1b[1m\x1b[34m➜\x1b[0m \x1b[36mhttps://discord.gg/fzjksWS65v\x1b[0m\n\n'
      )
      process.stdout.write(
        '  \x1b[1m\x1b[35m➜\x1b[0m \x1b[35mHaving issues? Use "git checkout dev" to see if it\'s fixed.\x1b[0m\n'
      )
      process.stdout.write(
        '  \x1b[1m\x1b[35m➜\x1b[0m \x1b[35mRead the FAQ & follow the support template in our Discord.\x1b[0m\n\n'
      )

      process.exit(0)
    }

    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)

    return nserver
  })()

  await serverInstancePromise.catch((err) => {
    logger(
      'error',
      'Server',
      `Fatal error during single-process startup: ${err.message}`,
      err
    )
    process.exit(1)
  })
}
