import cluster from 'node:cluster'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import process from 'node:process'

import WebSocketServer from '@performanc/pwsl-server'

import {
  checkUpdates,
  printStartupBanner,
  printSupportGuidelines
} from './bootstrap/branding.ts'
import {
  broadcastWorkerFailure,
  handleYouTubeOAuthCLI,
  setupClusterWorkerSocket,
  setupProcessGuards
} from './bootstrap/cluster.ts'
import { loadBootstrapConfig } from './bootstrap/config.ts'
import { memoryTrace, validateRuntime } from './bootstrap/runtime.ts'
import { setupGracefulShutdown } from './bootstrap/shutdown.ts'
import ConfigValidationManager from './managers/configValidationManager.ts'
import type ConnectionManager from './managers/connectionManager.ts'
import type CredentialManager from './managers/credentialManager.ts'
import DosProtectionManager from './managers/dosProtectionManager.ts'
import type LyricsManager from './managers/lyricsManager.ts'
import type MeaningManager from './managers/meaningManager.ts'
import PluginManager from './managers/pluginManager.ts'
import type ProxyManager from './managers/proxyManager.ts'
import RateLimitManager from './managers/rateLimitManager.ts'
import RoutePlannerManager from './managers/routePlannerManager.ts'
import SessionManager from './managers/sessionManager.ts'
import type SourcesManager from './managers/sourceManager.ts'
import type SourceWorkerManager from './managers/sourceWorkerManager.ts'
import StatsManager from './managers/statsManager.ts'
import type TrackCacheManager from './managers/trackCacheManager.ts'
import type WorkerManager from './managers/workerManager.ts'
import { cleanupBunServer, createBunServer } from './server/bunServer.ts'
import { createHttpServer, listenHttpServer } from './server/httpServer.ts'
import {
  getConnectionManagerClass,
  getCredentialManagerClass,
  getLyricsManagerClass,
  getMeaningManagerClass,
  getPlayerManagerClass,
  getRequestHandler,
  getSourcesManagerClass,
  getSourceWorkerManagerClass,
  getTrackCacheManagerClass,
  getWorkerManagerClass
} from './server/loaders.ts'
import {
  startHeartbeat,
  startServerMonitor,
  stopHeartbeat,
  stopServerMonitor
} from './server/serverMonitor.ts'
import {
  cleanupWebSocketServer,
  setupWebSocketEvents
} from './server/wsRouter.ts'
import type { ApiMiddlewareExtension } from './typings/api/api.types.ts'
import type { NodelinkConfig } from './typings/config/config.types.ts'
import type {
  AudioInterceptorExtension,
  FilterExtension,
  GitInfo,
  NodelinkExtensions,
  NodelinkServerType,
  NodelinkSocketType,
  NodelinkStatistics,
  PlayerInterceptorExtension,
  PlayerManagerConstructor,
  RouteExtension,
  SessionSocket,
  SourceExtension,
  StartOptions,
  TrackModifierExtension,
  WebSocketInterceptorExtension
} from './typings/index.types.ts'
import type { IPCMessage } from './typings/shared.types.ts'
import type { SourceInstance } from './typings/sources/source.types.ts'
import type { VoiceRelay } from './typings/voice/voice.types.ts'
import {
  getGitInfo,
  getVersion,
  logger,
  queueSessionEvent
} from './utils.ts'
import { parseVoiceFrameHeader } from './voice/voiceFrames.ts'
import { createVoiceRelay } from './voice/voiceRelay.ts'

const isBun = typeof Bun !== 'undefined'

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
  connectionManager: ConnectionManager | null
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
  voiceRelay: VoiceRelay | null
  _globalUpdater: NodeJS.Timeout | null
  _statsUpdater: NodeJS.Timeout | null
  supportedSourcesCache: string[] | null
  _heartbeatInterval: NodeJS.Timeout | null

  constructor(
    options: NodelinkConfig,
    PlayerManagerClass: PlayerManagerConstructor,
    isClusterPrimary = false
  ) {
    super()

    if (!options || Object.keys(options).length === 0) {
      throw new Error('Configuration file not found or empty')
    }

    this.options = options
    this.logger = logger
    this.server = null
    this.socket = null

    this._usingBunServer = Boolean(isBun && options.server?.useBunServer)

    memoryTrace('constructor:start')

    this.sessions = new SessionManager(this, PlayerManagerClass)
    this.sources = null
    this.lyrics = null
    this.meanings = null

    this._sourceInitPromise = this._initSources(isClusterPrimary)

    this.routePlanner = new RoutePlannerManager(this)
    this.proxyManager = null
    this.credentialManager = null
    this.trackCacheManager = null
    this.connectionManager = null
    this.statsManager = new StatsManager(this)
    this.rateLimitManager = new RateLimitManager(this)
    this.dosProtectionManager = new DosProtectionManager(this)
    this.pluginManager = new PluginManager(this)
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
    })

    this._globalUpdater = null
    this._statsUpdater = null
    this.supportedSourcesCache = null
    this._heartbeatInterval = null

    if (this._usingBunServer) {
      this.socket = new EventEmitter()
    } else {
      this.socket = new WebSocketServer()
    }

    memoryTrace('constructor:end')

    logger('info', 'Server', `version ${this.version}`)
    logger(
      'info',
      'Server',
      `git branch: ${this.gitInfo.branch}, commit: ${this.gitInfo.commit}, committed on: ${new Date(this.gitInfo.commitTime).toISOString()}`
    )
  }

  async _initSources(isClusterPrimary: boolean): Promise<void> {
    if (isClusterPrimary) return

    const [SourceMan, LyricsMan, MeaningMan] = await Promise.all([
      getSourcesManagerClass(),
      getLyricsManagerClass(),
      getMeaningManagerClass()
    ])

    this.sources = new SourceMan(this)
    this.lyrics = new LyricsMan(this)
    this.meanings = new MeaningMan(this)
  }

  async _ensureConnectionManager(): Promise<void> {
    if (this.connectionManager) return

    const ConnectionManagerClass = await getConnectionManagerClass()
    if (!this.connectionManager) {
      this.connectionManager = new ConnectionManagerClass(this)
    }
  }

  async _ensurePersistenceManagers(): Promise<void> {
    if (this.credentialManager && this.trackCacheManager) return

    const [CredentialManagerClass, TrackCacheManagerClass] = await Promise.all([
      getCredentialManagerClass(),
      getTrackCacheManagerClass()
    ])

    if (!this.credentialManager) {
      this.credentialManager = new CredentialManagerClass({
        options: this.options
      })
    }

    if (!this.trackCacheManager) {
      this.trackCacheManager = new TrackCacheManagerClass({
        options: this.options
      })
    }
  }

  _startHeartbeat(): void {
    startHeartbeat(this)
  }

  _stopHeartbeat(): void {
    stopHeartbeat(this)
  }

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

  registerVoiceSocket(guildId: string, socket: SessionSocket): void {
    if (!guildId || !socket) return

    let sockets = this.voiceSockets.get(guildId)
    if (!sockets) {
      sockets = new Set()
      this.voiceSockets.set(guildId, sockets)
    }

    sockets.add(socket)

    const cleanup = (): void => {
      const set = this.voiceSockets.get(guildId)
      if (!set) return
      set.delete(socket)
      if (set.size === 0) this.voiceSockets.delete(guildId)
    }

    socket.on('close', cleanup)
    socket.on('error', cleanup)
  }

  async getSourcesFromWorker(): Promise<string[]> {
    if (!this.workerManager) return []
    const worker = this.workerManager.getBestWorker()
    if (!worker) {
      logger('warn', 'Server', 'No worker available to get sources from.')
      return []
    }
    return (await this.workerManager.execute(
      worker,
      'getSources',
      {}
    )) as string[]
  }

  _validateConfig(): void {
    const manager = new ConfigValidationManager(this.options)
    manager.validate()
  }

  _setupSocketEvents(): void {
    setupWebSocketEvents(this)
  }

  _createBunServer(): void {
    this.server = createBunServer(this, getRequestHandler)
  }

  _createServer(): void {
    if (this._usingBunServer) {
      this._createBunServer()
      return
    }

    this.server = createHttpServer(this, getRequestHandler)
  }

  _listen(): void {
    if (!this.server) return

    const port = this.options.server.port
    const host = this.options.server.host || '0.0.0.0'
    logger(
      'info',
      'Server',
      `Attempting to listen on host: ${host}, port: ${port}`
    )

    listenHttpServer(this.server as http.Server, host, port)
  }

  _startGlobalUpdater(): void {
    startServerMonitor(this, false)
  }

  _startMasterMetricsUpdater(): void {
    startServerMonitor(this, true)
  }

  _stopGlobalPlayerUpdater(): void {
    stopServerMonitor(this)
  }

  async _cleanupWebSocketServer(): Promise<void> {
    if (this._usingBunServer && this.server) {
      await cleanupBunServer(
        this,
        this.server as {
          stop: (force?: boolean) => Promise<void>
          unref: () => void
        }
      )
      return
    }

    await cleanupWebSocketServer(this)
  }

  handleIPCMessage(message: IPCMessage): void {
    this.pluginManager.callHook('onIPCMessage', message)

    switch (message.type) {
      case 'playerEvent':
        this._handlePlayerEvent(message.payload)
        break

      case 'workerStats':
        this._handleWorkerStats(message)
        break

      case 'workerFailed':
        broadcastWorkerFailure(
          this.sessions,
          message.payload.workerId,
          message.payload.affectedGuilds
        )
        break
    }
  }

  private _handlePlayerEvent({
    sessionId,
    data
  }: {
    sessionId: string
    data: string
  }): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const queued = queueSessionEvent(session, data)
    if (!queued && !session.socket?.destroyed) {
      session.socket?.send(data)
    }
  }

  private _handleWorkerStats(
    message: Extract<IPCMessage, { type: 'workerStats' }>
  ): void {
    const manager = this.workerManager
    if (!manager) return

    const worker = manager.workers.find(
      ({ process }) => process.pid === message.pid
    )
    if (!worker) return

    manager.workerLoad.set(worker.id, message.stats.players)
  }

  async start(options: StartOptions = {}): Promise<this> {
    await this._initialize(options)
    this._startServer(options)
    this._startMonitors(options)

    memoryTrace('start:ready')
    return this
  }

  private async _initialize({ isClusterPrimary }: StartOptions): Promise<void> {
    await this._ensurePersistenceManagers()
    await this.credentialManager?.load()
    await validateRuntime(this.credentialManager)

    memoryTrace('start:enter')
    this._validateConfig()

    if (!isClusterPrimary) {
      await this.trackCacheManager?.load()
      memoryTrace('start:after-trackcache-load')
    }

    await this.statsManager.initialize()
    if (this._sourceInitPromise) await this._sourceInitPromise

    await this.pluginManager.load('master')

    if (
      isClusterPrimary &&
      this.options.cluster?.specializedSourceWorker?.enabled &&
      !this.sourceWorkerManager
    ) {
      const SourceWorkerManagerClass = await getSourceWorkerManagerClass()
      this.sourceWorkerManager = new SourceWorkerManagerClass(this)
    }

    if (this.sourceWorkerManager) {
      await this.sourceWorkerManager.start()
    }

    await this._ensureConnectionManager()

    if (!isClusterPrimary) {
      await this.pluginManager.load('worker')
    }

    const specEnabled = this.options.cluster?.specializedSourceWorker?.enabled
    if (this.sources && (!isClusterPrimary || !specEnabled)) {
      await this.sources.loadFolder()
      await this.lyrics?.loadFolder()
      await this.meanings?.loadFolder()
    }
  }

  private _startServer(options: StartOptions): void {
    this._setupSocketEvents()
    this._createServer()

    if (options.isClusterWorker) {
      setupClusterWorkerSocket(this.server)
    } else {
      this._listen()
    }

    this.connectionManager?.start()
  }

  private _startMonitors(options: StartOptions): void {
    if (options.isClusterPrimary) {
      this._startMasterMetricsUpdater()
    } else {
      this._startGlobalUpdater()
    }

    if (!options.isClusterPrimary || cluster.isPrimary) {
      this._startHeartbeat()
    }
  }

  registerSource(name: string, source: SourceExtension | SourceInstance): void {
    if (!this.sources) {
      logger(
        'warn',
        'Server',
        'Cannot register source (source manager not available).'
      )
      return
    }
    this.sources.sources.set(name, source as SourceInstance)
    logger('info', 'Server', `Registered custom source: ${name}`)
  }

  registerFilter(name: string, filter: FilterExtension): void {
    this.extensions.filters.set(name, filter)
    logger('info', 'Server', `Registered custom filter: ${name}`)
  }

  registerRoute(
    method: string,
    path: string,
    handler: RouteExtension['handler']
  ): void {
    this.extensions.routes.push({ method, path, handler })
    logger('info', 'Server', `Registered custom route: ${method} ${path}`)
  }

  registerMiddleware(fn: ApiMiddlewareExtension): void {
    this.extensions.middlewares.push(fn)
    logger('info', 'Server', 'Registered custom REST interceptor (middleware)')
  }

  registerTrackModifier(fn: TrackModifierExtension): void {
    this.extensions.trackModifiers.push(fn)
    logger('info', 'Server', 'Registered custom track info modifier')
  }

  registerWebSocketInterceptor(fn: WebSocketInterceptorExtension): void {
    this.extensions.wsInterceptors.push(fn)
    logger('info', 'Server', 'Registered custom WebSocket interceptor')
  }

  registerAudioInterceptor(interceptor: AudioInterceptorExtension): void {
    this.extensions.audioInterceptors.push(interceptor)
    logger('info', 'Server', 'Registered custom audio interceptor')
  }

  registerPlayerInterceptor(interceptor: PlayerInterceptorExtension): void {
    this.extensions.playerInterceptors.push(interceptor)
    logger('info', 'Server', 'Registered custom player interceptor')
  }
}

setupProcessGuards()

const { config, clusterEnabled } = await loadBootstrapConfig()

if (!cluster.isWorker) {
  printSupportGuidelines()
  printStartupBanner(String(getVersion()), clusterEnabled)
  await checkUpdates()
}

await startNodeLink({ config, clusterEnabled })

async function startNodeLink({
  config,
  clusterEnabled
}: {
  config: NodelinkConfig
  clusterEnabled: boolean
}): Promise<void> {
  if (clusterEnabled && cluster.isWorker) {
    await import('./workers/main.ts')
    return
  }

  if (clusterEnabled && config.sources?.youtube?.getOAuthToken) {
    await handleYouTubeOAuthCLI(config, getCredentialManagerClass)
  }

  const PlayerManagerClass = await getPlayerManagerClass()
  const isPrimary = Boolean(clusterEnabled && cluster.isPrimary)

  const nserver = new NodelinkServer(config, PlayerManagerClass, isPrimary)

  if (isPrimary) {
    const WorkerManagerClass = await getWorkerManagerClass()
    nserver.workerManager = new WorkerManagerClass(config)
    await nserver.start({ isClusterPrimary: true })
  } else {
    await nserver.start()
    logger(
      'info',
      'Server',
      `Single-process server running (PID ${process.pid})`
    )
  }

  ;(globalThis as typeof globalThis & { nodelink?: NodelinkServer }).nodelink =
    nserver

  setupGracefulShutdown(nserver)
}

export default NodelinkServer
export { NodelinkServer }
