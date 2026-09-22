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
import { createVoiceRelay, VoiceRouter } from './voice/voiceRelay.js';
const isBun = typeof Bun !== 'undefined';
class NodelinkServer extends EventEmitter {
    options;
    logger;
    version;
    gitInfo;
    usingBunServer;
    server;
    socket;
    sessions;
    routePlanner;
    statsManager;
    rateLimitManager;
    dosProtectionManager;
    pluginManager;
    voiceRouter;
    voiceRelay;
    statistics;
    extensions;
    credentialManager;
    trackCacheManager;
    connectionManager;
    sourceWorkerManager;
    workerManager;
    sources;
    lyrics;
    meanings;
    constructor(options, PlayerManagerClass) {
        super();
        if (!options || Object.keys(options).length === 0) {
            throw new Error('Configuration file not found or empty');
        }
        memoryTrace('constructor:start');
        this.options = options;
        this.logger = logger;
        this.version = String(getVersion());
        this.gitInfo = getGitInfo();
        this.usingBunServer = Boolean(isBun && options.server?.useBunServer);
        this.server = null;
        this.socket = this.usingBunServer
            ? new EventEmitter()
            : new WebSocketServer();
        this.sessions = new SessionManager(this, PlayerManagerClass);
        this.routePlanner = new RoutePlannerManager(this);
        this.statsManager = new StatsManager(this);
        this.rateLimitManager = new RateLimitManager(this);
        this.dosProtectionManager = new DosProtectionManager(this);
        this.pluginManager = new PluginManager(this);
        this.voiceRouter = new VoiceRouter();
        this.voiceRelay = createVoiceRelay({
            enabled: Boolean(options.playback.voiceReceive?.enabled),
            format: options.playback.voiceReceive?.format || 'pcm',
            sendFrame: (frame) => this.voiceRouter.handleFrame(frame),
            logger
        });
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
        this.credentialManager = null;
        this.trackCacheManager = null;
        this.connectionManager = null;
        this.sourceWorkerManager = null;
        this.workerManager = null;
        this.sources = null;
        this.lyrics = null;
        this.meanings = null;
        memoryTrace('constructor:end');
    }
    async start(options = {}) {
        await this._initialize(options);
        this._startServer(options);
        this._startMonitors(options);
        memoryTrace('start:ready');
        return this;
    }
    async stop() {
        stopHeartbeat(this);
        stopServerMonitor(this);
        await this.credentialManager?.forceSave();
        this.credentialManager?.destroy();
        await this.trackCacheManager?.forceSave();
        this.trackCacheManager?.destroy();
        this.sourceWorkerManager?.destroy();
        this.workerManager?.destroy();
        this.connectionManager?.destroy();
        this.routePlanner.dispose();
        this.rateLimitManager.destroy();
        this.dosProtectionManager.destroy();
        await this._cleanupWebSocketServer();
        const httpServer = this.server;
        if (httpServer?.listening) {
            await new Promise((resolve) => httpServer.close(() => resolve()));
            logger('info', 'Server', 'HTTP server closed.');
        }
    }
    async _initialize({ isClusterPrimary }) {
        logger('info', 'Server', `version ${this.version}`);
        logger('info', 'Server', `git branch: ${this.gitInfo.branch}, commit: ${this.gitInfo.commit}, committed on: ${new Date(this.gitInfo.commitTime).toISOString()}`);
        const [CredentialManagerClass, TrackCacheManagerClass] = await Promise.all([
            getCredentialManagerClass(),
            getTrackCacheManagerClass()
        ]);
        const credentialManager = new CredentialManagerClass({
            options: this.options
        });
        const trackCacheManager = new TrackCacheManagerClass({
            options: this.options
        });
        this.credentialManager = credentialManager;
        this.trackCacheManager = trackCacheManager;
        await credentialManager.load();
        await validateRuntime(credentialManager);
        memoryTrace('start:enter');
        new ConfigValidationManager(this.options).validate();
        if (!isClusterPrimary) {
            await trackCacheManager.load();
            memoryTrace('start:after-trackcache-load');
        }
        await this.statsManager.initialize();
        await this.pluginManager.load('master');
        const shouldStartSpecializedWorker = Boolean(isClusterPrimary && this.options.cluster?.specializedSourceWorker?.enabled);
        if (shouldStartSpecializedWorker) {
            const SourceWorkerManagerClass = await getSourceWorkerManagerClass();
            const sourceWorkerManager = new SourceWorkerManagerClass(this);
            this.sourceWorkerManager = sourceWorkerManager;
            await sourceWorkerManager.start();
        }
        const ConnectionManagerClass = await getConnectionManagerClass();
        this.connectionManager = new ConnectionManagerClass(this);
        if (!shouldStartSpecializedWorker) {
            if (!isClusterPrimary) {
                await this.pluginManager.load('worker');
            }
            const [SourcesManagerClass, LyricsManagerClass, MeaningManagerClass] = await Promise.all([
                getSourcesManagerClass(),
                getLyricsManagerClass(),
                getMeaningManagerClass()
            ]);
            const sources = new SourcesManagerClass(this);
            const lyrics = new LyricsManagerClass(this);
            const meanings = new MeaningManagerClass(this);
            this.sources = sources;
            this.lyrics = lyrics;
            this.meanings = meanings;
            await sources.loadFolder();
            await lyrics.loadFolder();
            await meanings.loadFolder();
        }
    }
    _startServer(options) {
        setupWebSocketEvents(this);
        this._createServer();
        if (options.isClusterWorker) {
            setupClusterWorkerSocket(this.server);
        }
        else {
            const port = this.options.server.port;
            const host = this.options.server.host || '0.0.0.0';
            logger('info', 'Server', `Attempting to listen on host: ${host}, port: ${port}`);
            listenHttpServer(this.server, host, port);
        }
        this.connectionManager?.start();
    }
    _startMonitors(options) {
        startServerMonitor(this, Boolean(options.isClusterPrimary));
        if (!options.isClusterPrimary || cluster.isPrimary) {
            startHeartbeat(this);
        }
    }
    _createServer() {
        this.server = this.usingBunServer
            ? createBunServer(this, getRequestHandler)
            : createHttpServer(this, getRequestHandler);
    }
    async _cleanupWebSocketServer() {
        if (this.usingBunServer && this.server) {
            await cleanupBunServer(this, this.server);
            return;
        }
        await cleanupWebSocketServer(this);
    }
    handleIPCMessage(message) {
        this.pluginManager.callHook('onIPCMessage', message);
        switch (message.type) {
            case 'playerEvent':
                this.sessions
                    .get(message.payload.sessionId)
                    ?.queueOrSend(message.payload.data);
                break;
            case 'workerStats':
                this.workerManager?.updateWorkerLoad(message.pid, message.stats.players);
                break;
            case 'workerFailed':
                broadcastWorkerFailure(this.sessions, message.payload.workerId, message.payload.affectedGuilds);
                break;
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
    get voiceSockets() {
        return this.voiceRouter.sockets;
    }
    handleVoiceFrame(frame) {
        this.voiceRouter.handleFrame(frame);
    }
    registerVoiceSocket(guildId, socket) {
        this.voiceRouter.registerSocket(guildId, socket);
    }
    async getSourcesFromWorker() {
        return this.workerManager ? this.workerManager.getSources() : [];
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
    const nserver = new NodelinkServer(config, PlayerManagerClass);
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
