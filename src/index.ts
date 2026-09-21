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
import { getGitInfo, getVersion, logger } from './utils.ts'
import { createVoiceRelay, VoiceRouter } from './voice/voiceRelay.ts'

const isBun = typeof Bun !== 'undefined'

class NodelinkServer extends EventEmitter {
  readonly options: NodelinkConfig
  readonly logger: typeof logger
  server: NodelinkServerType
  socket: NodelinkSocketType
  readonly usingBunServer: boolean
  readonly sessions: SessionManager
  sources: SourcesManager | null
  lyrics: LyricsManager | null
  meanings: MeaningManager | null
  readonly routePlanner: RoutePlannerManager
  credentialManager: CredentialManager | null
  trackCacheManager: TrackCacheManager | null
  connectionManager: ConnectionManager | null
  readonly statsManager: StatsManager
  readonly rateLimitManager: RateLimitManager
  readonly dosProtectionManager: DosProtectionManager
  readonly pluginManager: PluginManager
  sourceWorkerManager: SourceWorkerManager | null
  workerManager: WorkerManager | null
  readonly version: string
  readonly gitInfo: GitInfo
  statistics: NodelinkStatistics
  readonly extensions: NodelinkExtensions
  readonly voiceRouter: VoiceRouter
  voiceRelay: VoiceRelay | null

  get voiceSockets(): Map<string, Set<SessionSocket>> {
    return this.voiceRouter.sockets
  }

  constructor(
    options: NodelinkConfig,
    PlayerManagerClass: PlayerManagerConstructor
  ) {
    super()

    if (!options || Object.keys(options).length === 0) {
      throw new Error('Configuration file not found or empty')
    }

    memoryTrace('constructor:start')

    this.options = options
    this.logger = logger
    this.version = String(getVersion())
    this.gitInfo = getGitInfo()

    this.usingBunServer = Boolean(isBun && options.server?.useBunServer)
    this.server = null
    this.socket = this.usingBunServer
      ? new EventEmitter()
      : new WebSocketServer()

    this.sessions = new SessionManager(this, PlayerManagerClass)
    this.routePlanner = new RoutePlannerManager(this)
    this.statsManager = new StatsManager(this)
    this.rateLimitManager = new RateLimitManager(this)
    this.dosProtectionManager = new DosProtectionManager(this)
    this.pluginManager = new PluginManager(this)

    this.sources = null
    this.lyrics = null
    this.meanings = null
    this.credentialManager = null
    this.trackCacheManager = null
    this.connectionManager = null
    this.sourceWorkerManager = null
    this.workerManager = null

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

    this.voiceRouter = new VoiceRouter()
    this.voiceRelay = createVoiceRelay({
      enabled: options.playback.voiceReceive?.enabled || false,
      format: options.playback.voiceReceive?.format || 'pcm',
      sendFrame: (frame: Buffer) => this.voiceRouter.handleFrame(frame),
      logger
    })

    memoryTrace('constructor:end')
  }

  handleVoiceFrame(frame: Buffer): void {
    this.voiceRouter.handleFrame(frame)
  }

  registerVoiceSocket(guildId: string, socket: SessionSocket): void {
    this.voiceRouter.registerSocket(guildId, socket)
  }

  async getSourcesFromWorker(): Promise<string[]> {
    return this.workerManager ? this.workerManager.getSources() : []
  }

  _createServer(): void {
    this.server = this.usingBunServer
      ? createBunServer(this, getRequestHandler)
      : createHttpServer(this, getRequestHandler)
  }

  async _cleanupWebSocketServer(): Promise<void> {
    if (this.usingBunServer && this.server) {
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
        this.sessions
          .get(message.payload.sessionId)
          ?.queueOrSend(message.payload.data)
        break

      case 'workerStats':
        this.workerManager?.updateWorkerLoad(message.pid, message.stats.players)
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

  async start(options: StartOptions = {}): Promise<this> {
    await this._initialize(options)
    this._startServer(options)
    this._startMonitors(options)

    memoryTrace('start:ready')
    return this
  }

  private async _initialize({ isClusterPrimary }: StartOptions): Promise<void> {
    logger('info', 'Server', `version ${this.version}`)
    logger(
      'info',
      'Server',
      `git branch: ${this.gitInfo.branch}, commit: ${this.gitInfo.commit}, committed on: ${new Date(this.gitInfo.commitTime).toISOString()}`
    )

    const [CredentialManagerClass, TrackCacheManagerClass] = await Promise.all([
      getCredentialManagerClass(),
      getTrackCacheManagerClass()
    ])

    this.credentialManager = new CredentialManagerClass({
      options: this.options
    })
    this.trackCacheManager = new TrackCacheManagerClass({
      options: this.options
    })

    await this.credentialManager.load()
    await validateRuntime(this.credentialManager)

    memoryTrace('start:enter')
    new ConfigValidationManager(this.options).validate()

    if (!isClusterPrimary) {
      await this.trackCacheManager.load()
      memoryTrace('start:after-trackcache-load')
    }

    await this.statsManager.initialize()
    await this.pluginManager.load('master')

    if (
      isClusterPrimary &&
      this.options.cluster?.specializedSourceWorker?.enabled
    ) {
      const SourceWorkerManagerClass = await getSourceWorkerManagerClass()
      this.sourceWorkerManager = new SourceWorkerManagerClass(this)
      await this.sourceWorkerManager.start()
    }

    const ConnectionManagerClass = await getConnectionManagerClass()
    this.connectionManager = new ConnectionManagerClass(this)

    const specializedSources = Boolean(
      this.options.cluster?.specializedSourceWorker?.enabled
    )
    if (!isClusterPrimary || !specializedSources) {
      if (!isClusterPrimary) {
        await this.pluginManager.load('worker')
      }

      const [SourcesManagerClass, LyricsManagerClass, MeaningManagerClass] =
        await Promise.all([
          getSourcesManagerClass(),
          getLyricsManagerClass(),
          getMeaningManagerClass()
        ])

      this.sources = new SourcesManagerClass(this)
      this.lyrics = new LyricsManagerClass(this)
      this.meanings = new MeaningManagerClass(this)

      await this.sources.loadFolder()
      await this.lyrics.loadFolder()
      await this.meanings.loadFolder()
    }
  }

  private _startServer(options: StartOptions): void {
    setupWebSocketEvents(this)
    this._createServer()

    if (options.isClusterWorker) {
      setupClusterWorkerSocket(this.server)
    } else {
      const port = this.options.server.port
      const host = this.options.server.host || '0.0.0.0'
      logger(
        'info',
        'Server',
        `Attempting to listen on host: ${host}, port: ${port}`
      )
      listenHttpServer(this.server as http.Server, host, port)
    }

    this.connectionManager?.start()
  }

  private _startMonitors(options: StartOptions): void {
    startServerMonitor(this, Boolean(options.isClusterPrimary))

    if (!options.isClusterPrimary || cluster.isPrimary) {
      startHeartbeat(this)
    }
  }

  async stop(): Promise<void> {
    stopHeartbeat(this)
    stopServerMonitor(this)

    await this.credentialManager?.forceSave()
    await this.trackCacheManager?.forceSave()

    this.sourceWorkerManager?.destroy()
    this.workerManager?.destroy()
    this.connectionManager?.destroy()
    this.routePlanner.dispose()
    this.rateLimitManager.destroy()
    this.dosProtectionManager.destroy()
    this.credentialManager?.destroy()
    this.trackCacheManager?.destroy()

    await this._cleanupWebSocketServer()

    const httpServer = this.server as http.Server | undefined
    if (httpServer?.listening) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
      logger('info', 'Server', 'HTTP server closed.')
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

  const nserver = new NodelinkServer(config, PlayerManagerClass)

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
