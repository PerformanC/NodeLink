import cluster from 'node:cluster';
import { EventEmitter } from 'node:events';
import process from 'node:process';
import WebSocketServer from '@performanc/pwsl-server';
import { checkUpdates, printStartupBanner, printSupportGuidelines } from './bootstrap/branding.js';
import { broadcastWorkerFailure, handleYouTubeOAuthCLI, setupClusterWorkerSocket, setupProcessGuards } from './bootstrap/cluster.js';
import { loadBootstrapConfig } from './bootstrap/config.js';
import { memoryTrace, validateRuntime } from './bootstrap/runtime.js';
import { setupGracefulShutdown } from './bootstrap/shutdown.js';
import ConfigValidationManager from './managers/configValidationManager.js';
import DosProtectionManager from './managers/dosProtectionManager.js';
import PluginManager from './managers/pluginManager.js';
import RateLimitManager from './managers/rateLimitManager.js';
import RoutePlannerManager from './managers/routePlannerManager.js';
import SessionManager from './managers/sessionManager.js';
import StatsManager from './managers/statsManager.js';
import { cleanupBunServer, createBunServer } from './server/bunServer.js';
import { createHttpServer, listenHttpServer } from './server/httpServer.js';
import { getConnectionManagerClass, getCredentialManagerClass, getLyricsManagerClass, getMeaningManagerClass, getPlayerManagerClass, getRequestHandler, getSourcesManagerClass, getSourceWorkerManagerClass, getTrackCacheManagerClass, getWorkerManagerClass } from './server/loaders.js';
import { startHeartbeat, startServerMonitor, stopHeartbeat, stopServerMonitor } from './server/serverMonitor.js';
import { cleanupWebSocketServer, setupWebSocketEvents } from './server/wsRouter.js';
import { getGitInfo, getVersion, logger } from './utils.js';
import { parseVoiceFrameHeader } from './voice/voiceFrames.js';
import { createVoiceRelay } from './voice/voiceRelay.js';
const isBun = typeof Bun !== 'undefined';
class NodelinkServer extends EventEmitter {
    options;
    logger;
    server;
    socket;
    _usingBunServer;
    sessions;
    sources;
    lyrics;
    meanings;
    _sourceInitPromise;
    proxyManager;
    routePlanner;
    credentialManager;
    trackCacheManager;
    connectionManager;
    statsManager;
    rateLimitManager;
    dosProtectionManager;
    pluginManager;
    sourceWorkerManager;
    workerManager;
    version;
    gitInfo;
    statistics;
    extensions;
    voiceSockets;
    voiceRelay;
    _globalUpdater;
    _statsUpdater;
    supportedSourcesCache;
    _heartbeatInterval;
    constructor(options, PlayerManagerClass, isClusterPrimary = false) {
        super();
        if (!options || Object.keys(options).length === 0) {
            throw new Error('Configuration file not found or empty');
        }
        this.options = options;
        this.logger = logger;
        this.server = null;
        this.socket = null;
        this._usingBunServer = Boolean(isBun && options.server?.useBunServer);
        memoryTrace('constructor:start');
        this.sessions = new SessionManager(this, PlayerManagerClass);
        this.sources = null;
        this.lyrics = null;
        this.meanings = null;
        this._sourceInitPromise = this._initSources(isClusterPrimary);
        this.routePlanner = new RoutePlannerManager(this);
        this.proxyManager = null;
        this.credentialManager = null;
        this.trackCacheManager = null;
        this.connectionManager = null;
        this.statsManager = new StatsManager(this);
        this.rateLimitManager = new RateLimitManager(this);
        this.dosProtectionManager = new DosProtectionManager(this);
        this.pluginManager = new PluginManager(this);
        this.sourceWorkerManager = null;
        this.workerManager = null;
        this.version = String(getVersion());
        this.gitInfo = getGitInfo();
        this.statistics = {
            players: 0,
            playingPlayers: 0
        };
        this.extensions = {
            sources: new Map(),
            filters: new Map(),
            routes: [],
            middlewares: [],
            trackModifiers: [],
            wsInterceptors: [],
            audioInterceptors: [],
            playerInterceptors: []
        };
        this.voiceSockets = new Map();
        this.voiceRelay = createVoiceRelay({
            enabled: options.playback.voiceReceive?.enabled || false,
            format: options.playback.voiceReceive?.format || 'pcm',
            sendFrame: (frame) => this.handleVoiceFrame(frame),
            logger
        });
        this._globalUpdater = null;
        this._statsUpdater = null;
        this.supportedSourcesCache = null;
        this._heartbeatInterval = null;
        if (this._usingBunServer) {
            this.socket = new EventEmitter();
        }
        else {
            this.socket = new WebSocketServer();
        }
        memoryTrace('constructor:end');
        logger('info', 'Server', `version ${this.version}`);
        logger('info', 'Server', `git branch: ${this.gitInfo.branch}, commit: ${this.gitInfo.commit}, committed on: ${new Date(this.gitInfo.commitTime).toISOString()}`);
    }
    async _initSources(isClusterPrimary) {
        if (isClusterPrimary)
            return;
        const [SourceMan, LyricsMan, MeaningMan] = await Promise.all([
            getSourcesManagerClass(),
            getLyricsManagerClass(),
            getMeaningManagerClass()
        ]);
        this.sources = new SourceMan(this);
        this.lyrics = new LyricsMan(this);
        this.meanings = new MeaningMan(this);
    }
    async _ensureConnectionManager() {
        if (this.connectionManager)
            return;
        const ConnectionManagerClass = await getConnectionManagerClass();
        if (!this.connectionManager) {
            this.connectionManager = new ConnectionManagerClass(this);
        }
    }
    async _ensurePersistenceManagers() {
        if (this.credentialManager && this.trackCacheManager)
            return;
        const [CredentialManagerClass, TrackCacheManagerClass] = await Promise.all([
            getCredentialManagerClass(),
            getTrackCacheManagerClass()
        ]);
        if (!this.credentialManager) {
            this.credentialManager = new CredentialManagerClass({
                options: this.options
            });
        }
        if (!this.trackCacheManager) {
            this.trackCacheManager = new TrackCacheManagerClass({
                options: this.options
            });
        }
    }
    _startHeartbeat() {
        startHeartbeat(this);
    }
    _stopHeartbeat() {
        stopHeartbeat(this);
    }
    handleVoiceFrame(frame) {
        const header = parseVoiceFrameHeader(frame);
        if (!header?.guildId)
            return;
        const sockets = this.voiceSockets.get(header.guildId);
        if (!sockets || sockets.size === 0)
            return;
        for (const socket of sockets) {
            try {
                socket.send(frame);
            }
            catch { }
        }
    }
    registerVoiceSocket(guildId, socket) {
        if (!guildId || !socket)
            return;
        let sockets = this.voiceSockets.get(guildId);
        if (!sockets) {
            sockets = new Set();
            this.voiceSockets.set(guildId, sockets);
        }
        sockets.add(socket);
        const cleanup = () => {
            const set = this.voiceSockets.get(guildId);
            if (!set)
                return;
            set.delete(socket);
            if (set.size === 0)
                this.voiceSockets.delete(guildId);
        };
        socket.on('close', cleanup);
        socket.on('error', cleanup);
    }
    async getSourcesFromWorker() {
        if (!this.workerManager)
            return [];
        const worker = this.workerManager.getBestWorker();
        if (!worker) {
            logger('warn', 'Server', 'No worker available to get sources from.');
            return [];
        }
        return (await this.workerManager.execute(worker, 'getSources', {}));
    }
    _validateConfig() {
        const manager = new ConfigValidationManager(this.options);
        manager.validate();
    }
    _setupSocketEvents() {
        setupWebSocketEvents(this);
    }
    _createBunServer() {
        this.server = createBunServer(this, getRequestHandler);
    }
    _createServer() {
        if (this._usingBunServer) {
            this._createBunServer();
            return;
        }
        this.server = createHttpServer(this, getRequestHandler);
    }
    _listen() {
        if (!this.server)
            return;
        const port = this.options.server.port;
        const host = this.options.server.host || '0.0.0.0';
        logger('info', 'Server', `Attempting to listen on host: ${host}, port: ${port}`);
        listenHttpServer(this.server, host, port);
    }
    _startGlobalUpdater() {
        startServerMonitor(this, false);
    }
    _startMasterMetricsUpdater() {
        startServerMonitor(this, true);
    }
    _stopGlobalPlayerUpdater() {
        stopServerMonitor(this);
    }
    async _cleanupWebSocketServer() {
        if (this._usingBunServer && this.server) {
            await cleanupBunServer(this, this.server);
            return;
        }
        await cleanupWebSocketServer(this);
    }
    handleIPCMessage(message) {
        this.pluginManager.callHook('onIPCMessage', message);
        switch (message.type) {
            case 'playerEvent':
                this._handlePlayerEvent(message.payload);
                break;
            case 'workerStats':
                this._handleWorkerStats(message);
                break;
            case 'workerFailed':
                broadcastWorkerFailure(this.sessions, message.payload.workerId, message.payload.affectedGuilds);
                break;
        }
    }
    _handlePlayerEvent({ sessionId, data }) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return;
        if (session.isPaused && session.resuming) {
            session.eventQueue.push(data);
            return;
        }
        session.socket?.send(data);
    }
    _handleWorkerStats(message) {
        const manager = this.workerManager;
        if (!manager)
            return;
        const worker = manager.workers.find(({ process }) => process.pid === message.pid);
        if (!worker)
            return;
        manager.workerLoad.set(worker.id, message.stats.players);
    }
    async start(options = {}) {
        await this._initialize(options);
        this._startServer(options);
        this._startMonitors(options);
        memoryTrace('start:ready');
        return this;
    }
    async _initialize({ isClusterPrimary }) {
        await this._ensurePersistenceManagers();
        await this.credentialManager?.load();
        await validateRuntime(this.credentialManager);
        memoryTrace('start:enter');
        this._validateConfig();
        if (!isClusterPrimary) {
            await this.trackCacheManager?.load();
            memoryTrace('start:after-trackcache-load');
        }
        await this.statsManager.initialize();
        if (this._sourceInitPromise)
            await this._sourceInitPromise;
        await this.pluginManager.load('master');
        if (isClusterPrimary &&
            this.options.cluster?.specializedSourceWorker?.enabled &&
            !this.sourceWorkerManager) {
            const SourceWorkerManagerClass = await getSourceWorkerManagerClass();
            this.sourceWorkerManager = new SourceWorkerManagerClass(this);
        }
        if (this.sourceWorkerManager) {
            await this.sourceWorkerManager.start();
        }
        await this._ensureConnectionManager();
        if (!isClusterPrimary) {
            await this.pluginManager.load('worker');
        }
        const specEnabled = this.options.cluster?.specializedSourceWorker?.enabled;
        if (this.sources && (!isClusterPrimary || !specEnabled)) {
            await this.sources.loadFolder();
            await this.lyrics?.loadFolder();
            await this.meanings?.loadFolder();
        }
    }
    _startServer(options) {
        this._setupSocketEvents();
        this._createServer();
        if (options.isClusterWorker) {
            setupClusterWorkerSocket(this.server);
        }
        else {
            this._listen();
        }
        this.connectionManager?.start();
    }
    _startMonitors(options) {
        if (options.isClusterPrimary) {
            this._startMasterMetricsUpdater();
        }
        else {
            this._startGlobalUpdater();
        }
        if (!options.isClusterPrimary || cluster.isPrimary) {
            this._startHeartbeat();
        }
    }
    registerSource(name, source) {
        if (!this.sources) {
            logger('warn', 'Server', 'Cannot register source (source manager not available).');
            return;
        }
        this.sources.sources.set(name, source);
        logger('info', 'Server', `Registered custom source: ${name}`);
    }
    registerFilter(name, filter) {
        this.extensions.filters.set(name, filter);
        logger('info', 'Server', `Registered custom filter: ${name}`);
    }
    registerRoute(method, path, handler) {
        this.extensions.routes.push({ method, path, handler });
        logger('info', 'Server', `Registered custom route: ${method} ${path}`);
    }
    registerMiddleware(fn) {
        this.extensions.middlewares.push(fn);
        logger('info', 'Server', 'Registered custom REST interceptor (middleware)');
    }
    registerTrackModifier(fn) {
        this.extensions.trackModifiers.push(fn);
        logger('info', 'Server', 'Registered custom track info modifier');
    }
    registerWebSocketInterceptor(fn) {
        this.extensions.wsInterceptors.push(fn);
        logger('info', 'Server', 'Registered custom WebSocket interceptor');
    }
    registerAudioInterceptor(interceptor) {
        this.extensions.audioInterceptors.push(interceptor);
        logger('info', 'Server', 'Registered custom audio interceptor');
    }
    registerPlayerInterceptor(interceptor) {
        this.extensions.playerInterceptors.push(interceptor);
        logger('info', 'Server', 'Registered custom player interceptor');
    }
}
setupProcessGuards();
const { config, clusterEnabled } = await loadBootstrapConfig();
if (!cluster.isWorker) {
    printSupportGuidelines();
    printStartupBanner(String(getVersion()), clusterEnabled);
    await checkUpdates();
}
await startNodeLink({ config, clusterEnabled });
async function startNodeLink({ config, clusterEnabled }) {
    if (clusterEnabled && cluster.isWorker) {
        await import('./workers/main.js');
        return;
    }
    if (clusterEnabled && config.sources?.youtube?.getOAuthToken) {
        await handleYouTubeOAuthCLI(config, getCredentialManagerClass);
    }
    const PlayerManagerClass = await getPlayerManagerClass();
    const isPrimary = Boolean(clusterEnabled && cluster.isPrimary);
    const nserver = new NodelinkServer(config, PlayerManagerClass, isPrimary);
    if (isPrimary) {
        const WorkerManagerClass = await getWorkerManagerClass();
        nserver.workerManager = new WorkerManagerClass(config);
        await nserver.start({ isClusterPrimary: true });
    }
    else {
        await nserver.start();
        logger('info', 'Server', `Single-process server running (PID ${process.pid})`);
    }
    ;
    globalThis.nodelink =
        nserver;
    setupGracefulShutdown(nserver);
}
export default NodelinkServer;
export { NodelinkServer };
