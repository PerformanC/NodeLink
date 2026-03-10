var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import cluster from 'node:cluster';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocketServer from '@performanc/pwsl-server';
import RoutePlannerManager from "./managers/routePlannerManager.js";
import SessionManager from "./managers/sessionManager.js";
import StatsManager from "./managers/statsManager.js";
import { applyEnvOverrides, checkForUpdates, cleanupHttpAgents, cleanupLogger, decodeTrack, getGitInfo, getStats, getVersion, initLogger, logger, parseClient, verifyDiscordID } from "./utils.js";
import 'dotenv/config';
import { GatewayEvents } from "./constants.js";
import ConfigValidationManager from "./managers/configValidationManager.js";
import DosProtectionManager from "./managers/dosProtectionManager.js";
import PluginManager from "./managers/pluginManager.js";
import RateLimitManager from "./managers/rateLimitManager.js";
import { parseVoiceFrameHeader } from "./voice/voiceFrames.js";
import { createVoiceRelay } from "./voice/voiceRelay.js";
let requestHandlerPromise = null;
let profilerApiPromise = null;
const getRequestHandler = async () => {
    if (!requestHandlerPromise) {
        requestHandlerPromise = import("./api/index.js").then((module) => module.default);
    }
    return requestHandlerPromise;
};
const getProfilerApi = async () => {
    if (!profilerApiPromise) {
        profilerApiPromise = import('./api/profiler.js');
    }
    return profilerApiPromise;
};
const { NODELINK_MEMORY_TRACE: memoryTraceEnv } = process.env;
const memoryTraceEnabled = memoryTraceEnv?.toLowerCase() === 'true';
const PROFILER_HISTORY_MAX = 240;
const getProfilerRealtimeStore = () => {
    const g = globalThis;
    if (!g.__nodelinkProfilerRealtimeStore) {
        g.__nodelinkProfilerRealtimeStore = {
            snapshots: [],
            lastAllocTop: null,
            updatedAt: Date.now()
        };
    }
    return g.__nodelinkProfilerRealtimeStore;
};
const memoryTrace = (stage) => {
    if (!memoryTraceEnabled)
        return;
    const m = process.memoryUsage();
    const toMB = (value) => (value / 1024 / 1024).toFixed(2);
    process.stdout.write(`[MEM] ${stage} rss=${toMB(m.rss)}MB heapUsed=${toMB(m.heapUsed)}MB heapTotal=${toMB(m.heapTotal)}MB external=${toMB(m.external)}MB\n`);
};
let playerManagerClassPromise = null;
const getPlayerManagerClass = async () => {
    if (!playerManagerClassPromise) {
        playerManagerClassPromise = import("./managers/playerManager.js").then((module) => module.default);
    }
    return playerManagerClassPromise;
};
let workerManagerClassPromise = null;
const getWorkerManagerClass = async () => {
    if (!workerManagerClassPromise) {
        workerManagerClassPromise = import("./managers/workerManager.js").then((module) => module.default);
    }
    return workerManagerClassPromise;
};
let sourceWorkerManagerClassPromise = null;
const getSourceWorkerManagerClass = async () => {
    if (!sourceWorkerManagerClassPromise) {
        sourceWorkerManagerClassPromise = import("./managers/sourceWorkerManager.js").then((module) => module.default);
    }
    return sourceWorkerManagerClassPromise;
};
let credentialManagerClassPromise = null;
const getCredentialManagerClass = async () => {
    if (!credentialManagerClassPromise) {
        credentialManagerClassPromise = import("./managers/credentialManager.js").then((module) => module.default);
    }
    return credentialManagerClassPromise;
};
let trackCacheManagerClassPromise = null;
const getTrackCacheManagerClass = async () => {
    if (!trackCacheManagerClassPromise) {
        trackCacheManagerClassPromise = import("./managers/trackCacheManager.js").then((module) => module.default);
    }
    return trackCacheManagerClassPromise;
};
let config;
const resolveRootConfigUrl = (fileName) => pathToFileURL(resolvePath(process.cwd(), fileName)).href;
try {
    config = (await import(__rewriteRelativeImportExtension(resolveRootConfigUrl('config.js'))))
        .default;
}
catch (e) {
    const error = e;
    if (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'ENOENT') {
        try {
            config = (await import(__rewriteRelativeImportExtension(resolveRootConfigUrl('config.default.js'))))
                .default;
            console.log('[WARN] Config: config.js not found, using config.default.js. It is recommended to create a config.js file for your own configuration.');
        }
        catch (e2) {
            console.error('[ERROR] Config: Failed to load config.default.js. Please make sure it exists.');
            throw e2;
        }
    }
    else {
        throw e;
    }
}
// Apply environment variable overrides after config is loaded
applyEnvOverrides(config);
const clusterEnabled = 
// biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index signature access
process.env['CLUSTER_ENABLED']?.toLowerCase() === 'true' ||
    (typeof config.cluster?.enabled === 'boolean' && config.cluster.enabled) ||
    false;
let _configuredWorkers = 0;
// biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index signature access
if (process.env['CLUSTER_WORKERS'])
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index signature access
    _configuredWorkers = Number(process.env['CLUSTER_WORKERS']);
else if (typeof config.cluster?.workers === 'number')
    _configuredWorkers = config.cluster.workers;
initLogger(config);
const isBun = typeof Bun !== 'undefined';
if (!cluster.isWorker) {
    const ascii = `
   ▄   ████▄ ██▄   ▄███▄   █    ▄█    ▄   █  █▀
    █  █   █ █  █  █▀   ▀  █    ██     █  █▄█
██   █ █   █ █   █ ██▄▄    █    ██ ██   █ █▀▄   ${clusterEnabled ? 'Cluster Mode' : 'Single Process'}
█ █  █ ▀████ █  █  █▄   ▄▀ ███▄ ▐█ █ █  █ █  █  v${getVersion()}
█  █ █       ███▀  ▀███▀       ▀ ▐ █  █ █   █   Powered by PerformanC;
█   ██                             █   ██  ▀    rewritten by 1Lucas1.apk;
`;
    process.stdout.write(`\x1b[32m${ascii}\x1b[0m\n`);
}
await checkForUpdates();
memoryTrace('bootstrap:after-check-for-updates');
/**
 * Wrapper for Bun's ServerWebSocket that implements EventEmitter
 * Provides compatibility with Node.js WebSocket implementations
 */
class BunSocketWrapper extends EventEmitter {
    ws;
    remoteAddress;
    /**
     * Creates a new BunSocketWrapper
     * @param ws - Bun ServerWebSocket instance
     */
    constructor(ws) {
        super();
        this.ws = ws;
        this.remoteAddress = ws?.data?.remoteAddress || 'unknown';
    }
    /**
     * Sends data through the WebSocket connection
     * @param data - Data to send
     * @returns True if sent successfully
     */
    /**
     * Sends data through the WebSocket connection
     * @param data - Data to send
     * @returns True if sent successfully
     * @public
     */
    send(data) {
        try {
            const r = this.ws.send(data);
            return r !== 0;
        }
        catch {
            return false;
        }
    }
    /**
     * Sends a WebSocket ping frame
     * @param data - Optional ping data
     * @returns True if sent successfully
     * @public
     */
    ping(data) {
        try {
            this.ws.ping?.(data);
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * Closes the connection.
     *
     * Here is a list of close codes:
     * - `1000` means "normal closure" **(default)**
     * - `1009` means a message was too big and was rejected
     * - `1011` means the server encountered an error
     * - `1012` means the server is restarting
     * - `1013` means the server is too busy or the client is rate-limited
     * - `4000` through `4999` are reserved for applications (you can use it!)
     *
     * To close the connection abruptly, use `terminate()`.
     *
     * @param code The close code to send
     * @param reason The close reason to send
     * @public
     */
    close(code, reason) {
        this.ws.close(code, reason);
    }
    /**
     * Terminates the connection immediately
     * @public
     */
    terminate() {
        this.ws.close(1000, 'Terminated');
    }
    /**
     * Internal handler for received messages
     * @param message - Message data
     * @internal
     */
    _handleMessage(message) {
        this.emit('message', message);
    }
    /**
     * Internal handler for connection close events
     * @param code - Close code
     * @param reason - Close reason
     * @internal
     */
    _handleClose(code, reason) {
        this.emit('close', code, reason);
    }
}
/**
 * Main NodeLink server class
 * Handles WebSocket connections, audio sources, and player management
 */
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
    routePlanner;
    credentialManager;
    trackCacheManager;
    _persistenceManagersInitPromise;
    connectionManager;
    _connectionManagerInitPromise;
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
    /**
     * Creates a new NodeLink server instance
     * @param options - Server configuration
     * @param PlayerManagerClass - Player manager constructor
     * @param isClusterPrimary - Whether this is the cluster primary
     */
    constructor(options, PlayerManagerClass, isClusterPrimary = false) {
        super();
        if (!options || Object.keys(options).length === 0)
            throw new Error('Configuration file not found or empty');
        this.options = options;
        this.logger = logger;
        this.server = null;
        this.socket = null;
        this._usingBunServer = Boolean(isBun && options?.server?.useBunServer);
        memoryTrace('constructor:start');
        this.sessions = new SessionManager(this, PlayerManagerClass);
        memoryTrace('constructor:after-session-manager');
        this.sources = null;
        this.lyrics = null;
        this.meanings = null;
        this._sourceInitPromise = this._initSources(isClusterPrimary, options);
        this.routePlanner = new RoutePlannerManager(this);
        memoryTrace('constructor:after-route-planner');
        this.credentialManager = null;
        memoryTrace('constructor:after-credential-manager');
        this.trackCacheManager = null;
        memoryTrace('constructor:after-track-cache-manager');
        this._persistenceManagersInitPromise = null;
        this.connectionManager = null;
        this._connectionManagerInitPromise = null;
        this.statsManager = new StatsManager(this);
        memoryTrace('constructor:after-stats-manager');
        this.rateLimitManager = new RateLimitManager(this);
        memoryTrace('constructor:after-rate-limit-manager');
        this.dosProtectionManager = new DosProtectionManager(this);
        memoryTrace('constructor:after-dos-protection-manager');
        this.pluginManager = new PluginManager(this);
        memoryTrace('constructor:after-plugin-manager');
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
            enabled: options.voiceReceive?.enabled || false,
            format: options.voiceReceive?.format || 'pcm',
            sendFrame: (frame) => this.handleVoiceFrame(frame),
            logger
        });
        memoryTrace('constructor:after-voice-relay');
        this._globalUpdater = null;
        this._statsUpdater = null;
        this.supportedSourcesCache = null;
        this._heartbeatInterval = null;
        if (this._usingBunServer) {
            // EventEmitter used as WebSocket server shim for Bun
            this.socket = new EventEmitter();
        }
        else {
            this.socket = new WebSocketServer();
        }
        memoryTrace('constructor:after-socket-server');
        memoryTrace('constructor:end');
        logger('info', 'Server', `version ${this.version}`);
        logger('info', 'Server', `git branch: ${this.gitInfo.branch}, commit: ${this.gitInfo.commit}, committed on: ${new Date(this.gitInfo.commitTime).toISOString()}`);
    }
    /**
     * Initializes source managers
     * @param isClusterPrimary - Whether this is the cluster primary
     * @param _options - Server configuration
     * @internal
     */
    async _initSources(isClusterPrimary, _options) {
        if (!isClusterPrimary) {
            const [{ default: sourceMan }, { default: lyricsMan }, { default: meaningMan }] = await Promise.all([
                import("./managers/sourceManager.js"),
                import("./managers/lyricsManager.js"),
                import("./managers/meaningManager.js")
            ]);
            this.sources = new sourceMan(this);
            this.lyrics = new lyricsMan(this);
            this.meanings = new meaningMan(this);
        }
    }
    async _ensureConnectionManager() {
        if (this.connectionManager)
            return;
        if (this._connectionManagerInitPromise) {
            await this._connectionManagerInitPromise;
            return;
        }
        this._connectionManagerInitPromise = import("./managers/connectionManager.js")
            .then(({ default: ConnectionManagerClass }) => {
            if (!this.connectionManager) {
                this.connectionManager = new ConnectionManagerClass(this);
            }
        })
            .finally(() => {
            this._connectionManagerInitPromise = null;
        });
        await this._connectionManagerInitPromise;
    }
    async _ensurePersistenceManagers() {
        if (this.credentialManager && this.trackCacheManager)
            return;
        if (this._persistenceManagersInitPromise) {
            await this._persistenceManagersInitPromise;
            return;
        }
        this._persistenceManagersInitPromise = Promise.all([
            getCredentialManagerClass(),
            getTrackCacheManagerClass()
        ])
            .then(([CredentialManagerClass, TrackCacheManagerClass]) => {
            if (!this.credentialManager) {
                this.credentialManager = new CredentialManagerClass(this);
            }
            if (!this.trackCacheManager) {
                this.trackCacheManager = new TrackCacheManagerClass(this);
            }
        })
            .finally(() => {
            this._persistenceManagersInitPromise = null;
        });
        await this._persistenceManagersInitPromise;
    }
    /**
     * Starts the heartbeat interval to keep WebSocket connections alive
     * @internal
     */
    _startHeartbeat() {
        if (this._heartbeatInterval)
            return;
        this._heartbeatInterval = setInterval(() => {
            for (const session of this.sessions.activeSessions.values()) {
                if (session.socket && !session.isPaused) {
                    try {
                        if (typeof session.socket.sendFrame === 'function') {
                            session.socket.sendFrame(Buffer.alloc(0), {
                                len: 0,
                                fin: true,
                                opcode: 0x09
                            });
                        }
                        else if (typeof session.socket.ping === 'function') {
                            session.socket.ping();
                        }
                    }
                    catch (_e) {
                        logger('debug', 'Server', `Failed to send heartbeat to session ${session.id}`);
                    }
                }
            }
        }, 45000);
    }
    /**
     * Stops the heartbeat interval
     * @internal
     */
    _stopHeartbeat() {
        if (this._heartbeatInterval) {
            clearInterval(this._heartbeatInterval);
            this._heartbeatInterval = null;
        }
    }
    /**
     * Handles incoming voice frames and distributes them to registered sockets
     * @param frame - Voice frame buffer
     * @public
     */
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
    /**
     * Registers a WebSocket to receive voice frames for a guild
     * @param guildId - Discord guild ID
     * @param socket - WebSocket connection
     * @public
     */
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
    /**
     * Gets list of available sources from a worker
     * @returns Array of source names
     * @public
     */
    async getSourcesFromWorker() {
        if (!this.workerManager) {
            return [];
        }
        const worker = this.workerManager.getBestWorker();
        if (!worker) {
            logger('warn', 'Server', 'No worker available to get sources from.');
            return [];
        }
        const sources = await this.workerManager.execute(worker, 'getSources', {});
        return sources;
    }
    /**
     * Validates the server configuration
     * @throws Error if configuration is invalid
     * @internal
     */
    _validateConfig() {
        const manager = new ConfigValidationManager(this.options);
        manager.validate();
    }
    /**
     * Sets up WebSocket server event handlers
     * @internal
     */
    _setupSocketEvents() {
        if (!this.socket)
            return;
        this.socket.on('error', (error) => {
            logger('error', 'WebSocket', `WebSocket server error: ${error.message}`);
        });
        this.socket.on('/v4/websocket', (socket, request, clientInfo, oldSessionId) => {
            const originalOn = socket.on.bind(socket);
            socket.on = (event, listener) => {
                if (event === 'message') {
                    return originalOn(event, async (...args) => {
                        const data = args[0];
                        const interceptors = this.extensions?.wsInterceptors;
                        if (interceptors && Array.isArray(interceptors)) {
                            let parsedData;
                            try {
                                const dataStr = typeof data === 'string'
                                    ? data
                                    : data.toString();
                                parsedData = JSON.parse(dataStr);
                            }
                            catch {
                                parsedData = data;
                            }
                            for (const interceptor of interceptors) {
                                const handled = await interceptor(this, socket, parsedData, clientInfo);
                                if (handled === true)
                                    return;
                            }
                        }
                        listener(...args);
                    });
                }
                return originalOn(event, listener);
            };
            logger('debug', 'Resume', `Processing websocket connection. oldSessionId: ${oldSessionId}`);
            if (oldSessionId) {
                const session = this.sessions.resume(oldSessionId, socket);
                if (session) {
                    logger('info', 'Server', `\x1b[36m${clientInfo.name}\x1b[0m${clientInfo.version
                        ? `/\x1b[32mv${clientInfo.version}\x1b[0m`
                        : ''} resumed session with ID: ${oldSessionId}`);
                    this.statsManager.incrementSessionResume(clientInfo.name, true);
                    socket.on('close', (...args) => {
                        const code = args[0];
                        const reason = args[1];
                        if (!this.sessions.has(oldSessionId))
                            return;
                        const session = this.sessions.get(oldSessionId);
                        if (!session)
                            return;
                        logger('info', 'Server', `\x1b[36m${clientInfo.name}\x1b[0m/\x1b[32mv${clientInfo.version}\x1b[0m disconnected with code ${code} and reason: ${reason || 'without reason'}`);
                        if (session.resuming) {
                            this.sessions.pause(oldSessionId);
                        }
                        else {
                            this.sessions.shutdown(oldSessionId);
                        }
                        const sessionCount = this.sessions.activeSessions?.size || 0;
                        this.statsManager.setWebsocketConnections(sessionCount);
                    });
                    socket.send(JSON.stringify({
                        op: 'ready',
                        resumed: true,
                        sessionId: oldSessionId
                    }));
                    while (session.eventQueue.length > 0) {
                        const event = session.eventQueue.shift();
                        if (event)
                            socket.send(event);
                    }
                    for (const [playerKey, playerInfo] of session.players.players.entries()) {
                        if (this.workerManager) {
                            const worker = this.workerManager.getWorkerForGuild(playerKey);
                            if (worker) {
                                this.workerManager.execute(worker, 'playerCommand', {
                                    sessionId: session.id,
                                    guildId: playerInfo.guildId,
                                    command: 'forceUpdate',
                                    args: []
                                });
                            }
                        }
                        else {
                            playerInfo._sendUpdate();
                        }
                    }
                    const sessionCount = this.sessions.activeSessions?.size || 0;
                    this.statsManager.setWebsocketConnections(sessionCount);
                }
            }
            else {
                const sessionId = this.sessions.create(request, socket, clientInfo);
                const sessionCount = this.sessions.activeSessions?.size || 0;
                this.statsManager.setWebsocketConnections(sessionCount);
                socket.on('close', (...args) => {
                    const code = args[0];
                    const reason = args[1];
                    if (!this.sessions.has(sessionId))
                        return;
                    const session = this.sessions.get(sessionId);
                    if (!session)
                        return;
                    logger('info', 'Server', `\x1b[36m${clientInfo.name}\x1b[0m${clientInfo.version
                        ? `/\x1b[32mv${clientInfo.version}\x1b[0m`
                        : ''} disconnected with code ${code} and reason: ${reason || 'without reason'}`);
                    if (session.resuming) {
                        this.sessions.pause(sessionId);
                    }
                    else {
                        this.sessions.shutdown(sessionId);
                    }
                    const sessionCount = this.sessions.activeSessions?.size || 0;
                    this.statsManager.setWebsocketConnections(sessionCount);
                });
                socket.send(JSON.stringify({
                    op: 'ready',
                    resumed: false,
                    sessionId
                }));
            }
        });
        this.socket.on('/v4/profiler/socket', async (socket, request) => {
            let streamTimer = null;
            let allocTimer = null;
            let stopped = false;
            let tickInFlight = false;
            let allocInFlight = false;
            let lastAllocAt = 0;
            let lastAllocReport = null;
            const realtimeStore = getProfilerRealtimeStore();
            if (realtimeStore.lastAllocTop && !lastAllocReport) {
                lastAllocReport = realtimeStore.lastAllocTop;
            }
            const prevById = new Map();
            const requestHeaders = request.headers;
            const requestHost = Array.isArray(requestHeaders?.host)
                ? requestHeaders.host[0]
                : requestHeaders?.host;
            const url = new URL(request.url || '/v4/profiler/socket', `http://${requestHost || 'localhost'}`);
            const intervalMs = Math.min(15000, Math.max(700, Number(url.searchParams.get('intervalMs') || 2000)));
            const allocDurationMs = Math.min(15000, Math.max(1000, Number(url.searchParams.get('allocDurationMs') || 3000)));
            const allocEveryRaw = Number(url.searchParams.get('allocEveryMs') || 0);
            const allocEveryMs = Number.isFinite(allocEveryRaw) && allocEveryRaw > 0
                ? Math.min(120000, Math.max(5000, Math.floor(allocEveryRaw)))
                : 0;
            const payload = {
                scope: url.searchParams.get('scope') || 'all'
            };
            const cleanup = () => {
                stopped = true;
                if (streamTimer)
                    clearInterval(streamTimer);
                if (allocTimer)
                    clearInterval(allocTimer);
                streamTimer = null;
                allocTimer = null;
            };
            const send = (obj) => {
                try {
                    socket.send(JSON.stringify(obj));
                }
                catch {
                    cleanup();
                }
            };
            const refreshAllocTop = async () => {
                if (stopped || allocInFlight)
                    return;
                const now = Date.now();
                if (lastAllocReport && now - lastAllocAt < allocEveryMs)
                    return;
                allocInFlight = true;
                try {
                    const profilerApi = await getProfilerApi();
                    lastAllocReport = await profilerApi.collectAllocationTopSites(this, {
                        ...payload,
                        durationMs: allocDurationMs,
                        name: 'ws-alloc'
                    });
                    lastAllocAt = Date.now();
                    realtimeStore.lastAllocTop = lastAllocReport;
                    realtimeStore.updatedAt = lastAllocAt;
                }
                catch (error) {
                    lastAllocReport = {
                        action: 'allocTop',
                        failed: true,
                        error: error instanceof Error ? error.message : String(error),
                        timestamp: Date.now()
                    };
                    lastAllocAt = Date.now();
                    realtimeStore.lastAllocTop = lastAllocReport;
                    realtimeStore.updatedAt = lastAllocAt;
                }
                finally {
                    allocInFlight = false;
                }
            };
            const tick = async () => {
                if (stopped || tickInFlight)
                    return;
                tickInFlight = true;
                try {
                    const profilerApi = await getProfilerApi();
                    const snapshot = await profilerApi.collectActionSnapshot(this, 'status', payload);
                    const warnings = profilerApi.detectAnomalies(snapshot, prevById);
                    send({
                        op: 'profilerSnapshot',
                        timestamp: Date.now(),
                        snapshot,
                        warnings,
                        allocTop: lastAllocReport
                    });
                    realtimeStore.snapshots.push({
                        timestamp: Date.now(),
                        snapshot,
                        warnings,
                        allocTop: lastAllocReport
                    });
                    if (realtimeStore.snapshots.length > PROFILER_HISTORY_MAX) {
                        realtimeStore.snapshots.splice(0, realtimeStore.snapshots.length - PROFILER_HISTORY_MAX);
                    }
                    realtimeStore.updatedAt = Date.now();
                }
                catch (error) {
                    send({
                        op: 'profilerError',
                        timestamp: Date.now(),
                        error: error instanceof Error ? error.message : String(error)
                    });
                }
                finally {
                    tickInFlight = false;
                }
            };
            socket.on('close', cleanup);
            socket.on('error', cleanup);
            send({
                op: 'profilerReady',
                timestamp: Date.now(),
                intervalMs,
                allocEveryMs,
                allocDurationMs
            });
            send({
                op: 'profilerBootstrap',
                timestamp: Date.now(),
                history: realtimeStore.snapshots,
                lastAllocTop: realtimeStore.lastAllocTop,
                updatedAt: realtimeStore.updatedAt
            });
            if (allocEveryMs > 0)
                void refreshAllocTop();
            await tick();
            streamTimer = setInterval(() => {
                void tick();
            }, intervalMs);
            if (allocEveryMs > 0) {
                allocTimer = setInterval(() => {
                    void refreshAllocTop();
                }, allocEveryMs);
            }
        });
    }
    /**
     * Creates and configures Bun HTTP server with WebSocket support
     * @internal
     */
    _createBunServer() {
        const port = this.options.server.port;
        const host = this.options.server.host || '0.0.0.0';
        const password = this.options.server.password;
        const self = this;
        logger('warn', 'Server', 'Running with Bun.serve, remember this is experimental!');
        this.server = Bun.serve({
            port,
            hostname: host,
            maxRequestBodySize: 1024 * 1024 * 50,
            async fetch(req, server) {
                const url = new URL(req.url);
                const pathname = url.pathname.endsWith('/')
                    ? url.pathname.slice(0, -1)
                    : url.pathname;
                if (pathname === '/v4/profiler/socket') {
                    const remoteAddress = server.requestIP(req)?.address || 'unknown';
                    const isInternal = /^(::1|localhost|127\.0\.0\.1)/.test(remoteAddress);
                    const endpoint = self.options.cluster?.endpoint || {};
                    const patchEnabled = endpoint.patchEnabled === true;
                    const allowExternalPatch = endpoint.allowExternalPatch === true;
                    const expectedCode = typeof endpoint.code === 'string' && endpoint.code.length > 0
                        ? endpoint.code
                        : 'CAPYBARA';
                    const providedCode = url.searchParams.get('code') ||
                        req.headers.get('x-nodelink-code') ||
                        req.headers.get('x-worker-code');
                    if (!patchEnabled) {
                        return new Response('Profiler socket endpoint is disabled.', {
                            status: 403,
                            statusText: 'Forbidden'
                        });
                    }
                    if (!allowExternalPatch && !isInternal) {
                        return new Response('External profiler socket access is blocked.', {
                            status: 403,
                            statusText: 'Forbidden'
                        });
                    }
                    if (!providedCode || providedCode !== expectedCode) {
                        return new Response('Invalid or missing profiler code.', {
                            status: 403,
                            statusText: 'Forbidden'
                        });
                    }
                    const success = server.upgrade(req, {
                        data: {
                            clientInfo: { name: 'ProfilerUI', version: '1' },
                            sessionId: null,
                            reqHeaders: Object.fromEntries(req.headers),
                            remoteAddress,
                            url: req.url
                        }
                    });
                    if (success)
                        return undefined;
                    return new Response('WebSocket upgrade failed', { status: 400 });
                }
                if (pathname === '/v4/websocket') {
                    const remoteAddress = server.requestIP(req)?.address || 'unknown';
                    const clientAddress = `[External] (${remoteAddress})`;
                    const clientName = req.headers.get('client-name');
                    const auth = req.headers.get('authorization');
                    const userId = req.headers.get('user-id');
                    const sessionId = req.headers.get('session-id');
                    if (auth !== password) {
                        logger('warn', 'Server', `Unauthorized connection attempt from ${clientAddress} - Invalid password provided: ${auth || 'None'}`);
                        return new Response('Invalid password provided.', {
                            status: 401,
                            statusText: 'Unauthorized',
                            headers: {
                                'Nodelink-Api-Version': '4',
                                IamNodelink: 'true'
                            }
                        });
                    }
                    if (!clientName) {
                        logger('warn', 'Server', `Missing client-name from ${clientAddress}`);
                        return new Response('Invalid or missing Client-Name header.', {
                            status: 400,
                            statusText: 'Bad Request',
                            headers: {
                                'Nodelink-Api-Version': '4',
                                IamNodelink: 'true'
                            }
                        });
                    }
                    if (!userId || !verifyDiscordID(userId)) {
                        logger('warn', 'Server', `Invalid user ID from ${clientAddress}`);
                        return new Response('Invalid or missing User-Id header.', {
                            status: 400,
                            statusText: 'Bad Request',
                            headers: {
                                'Nodelink-Api-Version': '4',
                                IamNodelink: 'true'
                            }
                        });
                    }
                    const clientInfo = parseClient(clientName);
                    if (!clientInfo) {
                        logger('warn', 'Server', `Invalid client-name from ${clientAddress}`);
                        return new Response('Invalid or missing Client-Name header.', {
                            status: 400,
                            statusText: 'Bad Request',
                            headers: {
                                'Nodelink-Api-Version': '4',
                                IamNodelink: 'true'
                            }
                        });
                    }
                    const success = server.upgrade(req, {
                        data: {
                            clientInfo,
                            sessionId,
                            reqHeaders: Object.fromEntries(req.headers),
                            remoteAddress,
                            url: req.url
                        }
                    });
                    if (success)
                        return undefined;
                    return new Response('WebSocket upgrade failed', {
                        status: 400,
                        headers: {
                            'Nodelink-Api-Version': '4',
                            IamNodelink: 'true'
                        }
                    });
                }
                return new Promise((resolve) => {
                    const reqShim = {
                        method: req.method,
                        url: url.pathname + url.search,
                        headers: Object.fromEntries(req.headers),
                        socket: { remoteAddress: server.requestIP(req)?.address },
                        on: (event, cb) => {
                            if (event === 'data') {
                                req
                                    .arrayBuffer()
                                    .then((buf) => {
                                    cb(Buffer.from(buf));
                                    if (reqShim._endCb)
                                        reqShim._endCb();
                                })
                                    .catch(() => { });
                            }
                            if (event === 'end') {
                                reqShim._endCb = cb;
                            }
                        }
                    };
                    const resShim = {
                        _status: 200,
                        _headers: {},
                        _body: [],
                        writeHead(status, headers) {
                            this._status = status;
                            if (headers)
                                Object.assign(this._headers, headers);
                        },
                        setHeader(name, value) {
                            this._headers[name] = value;
                        },
                        getHeader(name) {
                            return this._headers[name];
                        },
                        end(data) {
                            if (data)
                                this._body.push(data);
                            const finalBody = Buffer.concat(this._body.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
                            const headers = new Headers();
                            for (const [key, value] of Object.entries(this._headers)) {
                                if (Array.isArray(value)) {
                                    for (const v of value)
                                        headers.append(key, v);
                                }
                                else if (value !== undefined) {
                                    headers.set(key, String(value));
                                }
                            }
                            const response = new Response(finalBody, {
                                status: this._status,
                                headers
                            });
                            resolve(response);
                        },
                        write(data) {
                            if (data)
                                this._body.push(data);
                        }
                    };
                    void getRequestHandler()
                        .then((handler) => handler(self, reqShim, resShim))
                        .catch((error) => {
                        logger('error', 'Server', `Failed to handle Bun request: ${error.message}`);
                        if (!resShim._status || resShim._status < 400) {
                            resShim.writeHead(500, { 'Content-Type': 'text/plain' });
                        }
                        resShim.end('Internal Server Error');
                    });
                });
            },
            websocket: {
                sendPings: true,
                data: {},
                open(ws) {
                    if (!ws.data)
                        return;
                    const wrapper = new BunSocketWrapper(ws);
                    ws.data.wrapper = wrapper;
                    const { clientInfo, sessionId, reqHeaders } = ws.data;
                    const reqShim = {
                        headers: reqHeaders,
                        url: ws.data.url,
                        socket: { remoteAddress: ws.data.remoteAddress }
                    };
                    let pathname = '/v4/websocket';
                    try {
                        pathname = new URL(ws.data.url).pathname;
                    }
                    catch { }
                    if (pathname === '/v4/profiler/socket') {
                        logger('info', 'ProfilerSocket', `Profiler socket connected from [External] (${ws.data.remoteAddress})`);
                        self.socket?.emit('/v4/profiler/socket', wrapper, reqShim, null, null);
                        return;
                    }
                    logger('info', 'Server', `\x1b[36m${clientInfo.name}\x1b[0m${clientInfo.version ? `/\x1b[32mv${clientInfo.version}\x1b[0m` : ''} connected from [External] (${ws.data.remoteAddress}) | \x1b[33mURL:\x1b[0m ${ws.data.url}`);
                    let eventName = '/v4/websocket';
                    let guildId = null;
                    let liveId = null;
                    try {
                        const url = new URL(ws.data.url);
                        const voiceMatch = url.pathname.match(/^\/v4\/websocket\/voice\/([A-Za-z0-9]+)\/?$/);
                        const liveMatch = url.pathname.match(/^\/v4\/websocket\/youtube\/live\/([^/]+)\/?$/);
                        if (voiceMatch) {
                            if (!self.options.voiceReceive?.enabled) {
                                try {
                                    wrapper.close(1008, 'Voice receive disabled');
                                }
                                catch { }
                                return;
                            }
                            eventName = '/v4/websocket/voice';
                            guildId = voiceMatch[1];
                        }
                        else if (liveMatch) {
                            eventName = '/v4/websocket/youtube/live';
                            liveId = liveMatch[1];
                        }
                    }
                    catch { }
                    if (self.socket) {
                        self.socket.emit(eventName, wrapper, reqShim, clientInfo, sessionId, guildId || liveId);
                    }
                },
                message(ws, message) {
                    ws.data?.wrapper?._handleMessage(message);
                },
                close(ws, code, reason) {
                    ws.data?.wrapper?._handleClose(code, reason);
                }
            }
        });
        logger('started', 'Server', `Successfully listening on ${host}:${port} (Bun Native)`);
    }
    /**
     * Creates HTTP server (Node.js or Bun)
     * @internal
     */
    _createServer() {
        if (this._usingBunServer) {
            this._createBunServer();
            return;
        }
        this.server = http.createServer((req, res) => {
            void getRequestHandler()
                .then((handler) => handler(this, req, res))
                .catch((error) => {
                logger('error', 'Server', `Failed to handle HTTP request: ${error.message}`);
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                }
                res.end('Internal Server Error');
            });
        });
        this.server.keepAliveTimeout = 65000;
        this.server.headersTimeout = 66000;
        this.server.on('connection', (socket) => {
            // Guard all HTTP sockets (including plain GET /v4/profiler/ui) against
            // abrupt client disconnect races that can surface as EPIPE/ECONNRESET.
            socket.on('error', (err) => {
                if (err?.code === 'EPIPE' || err?.code === 'ECONNRESET')
                    return;
                logger('debug', 'Server', `HTTP socket error: ${err.message}`);
            });
        });
        this.server.on('clientError', (err, socket) => {
            if (err?.code !== 'EPIPE' && err?.code !== 'ECONNRESET') {
                logger('debug', 'Server', `HTTP client error: ${err.message}`);
            }
            try {
                if (!socket.destroyed)
                    socket.destroy();
            }
            catch { }
        });
        this.server.on('upgrade', (request, socket, head) => {
            // Guard upgrade sockets against EPIPE/ECONNRESET races when clients disconnect mid-upgrade.
            socket.on('error', (err) => {
                if (err?.code === 'EPIPE' || err?.code === 'ECONNRESET')
                    return;
                logger('debug', 'Server', `Upgrade socket error: ${err.message}`);
            });
            const { remoteAddress, remotePort } = request.socket;
            const isInternal = /^(::1|localhost|127\.0\.0\.1)/.test(remoteAddress || '') ||
                /^::ffff:127\.0\.0\.1/.test(remoteAddress || '');
            const clientAddress = `${isInternal ? '[Internal]' : '[External]'} (${remoteAddress}:${remotePort})`;
            const rejectUpgrade = (status, statusText, body) => {
                if (socket.destroyed || !socket.writable) {
                    try {
                        socket.destroy();
                    }
                    catch { }
                    return;
                }
                const payload = `HTTP/1.1 ${status} ${statusText}\r\n` +
                    'Nodelink-Api-Version: 4\r\n' +
                    'IamNodelink: true\r\n' +
                    'Content-Type: text/plain\r\n' +
                    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
                    body;
                socket.end(payload, () => {
                    try {
                        socket.destroy();
                    }
                    catch { }
                });
            };
            const originalHeaders = request.headers;
            const headers = {};
            for (const key in originalHeaders) {
                const value = originalHeaders[key];
                if (value !== undefined) {
                    headers[key.toLowerCase()] = value;
                }
            }
            logger('debug', 'Resume', `Received headers (lowercased): ${JSON.stringify(headers)}`);
            const parsedUpgradeUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
            const { pathname } = parsedUpgradeUrl;
            if (pathname === '/v4/profiler/socket') {
                const endpoint = this.options.cluster?.endpoint || {};
                const patchEnabled = endpoint.patchEnabled === true;
                const allowExternalPatch = endpoint.allowExternalPatch === true;
                const expectedCode = typeof endpoint.code === 'string' && endpoint.code.length > 0
                    ? endpoint.code
                    : 'CAPYBARA';
                const queryCode = parsedUpgradeUrl.searchParams.get('code');
                const headerCode = headers['x-nodelink-code'] || headers['x-worker-code'];
                const providedCode = queryCode ||
                    (Array.isArray(headerCode) ? headerCode[0] : headerCode);
                if (!patchEnabled) {
                    return rejectUpgrade(403, 'Forbidden', 'Profiler socket endpoint is disabled.');
                }
                if (!allowExternalPatch && !isInternal) {
                    return rejectUpgrade(403, 'Forbidden', 'External profiler socket access is blocked.');
                }
                if (!providedCode || providedCode !== expectedCode) {
                    return rejectUpgrade(403, 'Forbidden', 'Invalid or missing profiler code.');
                }
                for (const key in headers) {
                    const value = headers[key];
                    if (typeof value === 'string') {
                        request.headers[key] = value;
                    }
                }
                logger('info', 'ProfilerSocket', `Profiler socket connected from ${clientAddress} | \x1b[33mURL:\x1b[0m ${request.url}`);
                this.socket?.handleUpgrade(request, socket, head, null, (ws) => this.socket?.emit('/v4/profiler/socket', ws, request, { name: 'ProfilerUI', version: '1' }, null, null));
                return;
            }
            // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index signature access
            const authorization = headers['authorization'];
            const authValue = Array.isArray(authorization)
                ? authorization[0]
                : authorization;
            if (authValue !== this.options.server.password) {
                logger('warn', 'Server', `Unauthorized connection attempt from ${clientAddress} - Invalid password provided: ${authValue || 'None'}`);
                return rejectUpgrade(401, 'Unauthorized', 'Invalid password provided.');
            }
            const clientNameHeader = headers['client-name'];
            const clientInfo = parseClient(Array.isArray(clientNameHeader)
                ? clientNameHeader[0]
                : clientNameHeader);
            if (!clientInfo) {
                logger('warn', 'Server', `Unauthorized connection attempt from ${clientAddress} - Invalid client-name provided`);
                return rejectUpgrade(400, 'Bad Request', 'Invalid or missing Client-Name header.');
            }
            let sessionId = headers['session-id'];
            if (Array.isArray(sessionId))
                sessionId = sessionId[0];
            logger('debug', 'Resume', `Received session-id header: ${sessionId}`);
            if (sessionId && !this.sessions.resumableSessions.has(sessionId)) {
                logger('warn', 'Server', `Session-ID provided by ${clientAddress} does not exist or is not resumable: ${sessionId}, creating a new session`);
                sessionId = undefined;
            }
            const voiceMatch = pathname.match(/^\/v4\/websocket\/voice\/([A-Za-z0-9]+)\/?$/);
            const liveMatch = pathname.match(/^\/v4\/websocket\/youtube\/live\/([^/]+)\/?$/);
            if (pathname === '/v4/websocket' || voiceMatch || liveMatch) {
                if (!headers['user-id']) {
                    logger('warn', 'Server', `Unauthorized connection attempt from ${clientAddress} - Missing user ID`);
                    return rejectUpgrade(400, 'Bad Request', 'User-Id header is missing.');
                }
                const userIdHeader = headers['user-id'];
                const userId = Array.isArray(userIdHeader)
                    ? userIdHeader[0]
                    : userIdHeader;
                if (!userId || !verifyDiscordID(userId)) {
                    logger('warn', 'Server', `Unauthorized connection attempt from ${clientAddress} - Invalid user ID provided`);
                    return rejectUpgrade(400, 'Bad Request', 'Invalid User-Id header.');
                }
                if (voiceMatch && !this.options.voiceReceive?.enabled) {
                    return rejectUpgrade(404, 'Not Found', 'Voice websocket endpoint is disabled.');
                }
                for (const key in headers) {
                    const value = headers[key];
                    if (typeof value === 'string') {
                        request.headers[key] = value;
                    }
                }
                logger('info', 'Server', `\x1b[36m${clientInfo.name}\x1b[0m${clientInfo.version ? `/\x1b[32mv${clientInfo.version}\x1b[0m` : ''} connected from ${clientAddress} | \x1b[33mURL:\x1b[0m ${request.url}`);
                let eventName = '/v4/websocket';
                let routeId = null;
                if (voiceMatch) {
                    eventName = '/v4/websocket/voice';
                    routeId = voiceMatch[1];
                }
                else if (liveMatch) {
                    eventName = '/v4/websocket/youtube/live';
                    routeId = liveMatch[1];
                }
                if (isBun && !this._usingBunServer && this.socket) {
                    ;
                    this.socket.handleUpgrade(request, socket, head, null, (ws) => {
                        this.socket?.emit(eventName, ws, request, clientInfo, sessionId, routeId);
                    });
                }
                else {
                    ;
                    this.socket?.handleUpgrade(request, socket, head, null, (ws) => this.socket?.emit(eventName, ws, request, clientInfo, sessionId, routeId));
                }
            }
            else {
                logger('warn', 'Server', `Unauthorized connection attempt from ${clientAddress} - Invalid path provided`);
                return rejectUpgrade(404, 'Not Found', 'Invalid path for WebSocket upgrade.');
            }
        });
        this.socket?.on('/v4/websocket/voice', (socket, request, _clientInfo, _sessionId, guildId) => {
            if (!this.options.voiceReceive?.enabled) {
                try {
                    socket.close(1008, 'Voice receive disabled');
                }
                catch { }
                return;
            }
            logger('info', 'Voice', `Voice websocket connected from ${request.socket?.remoteAddress || 'unknown'} | guild ${guildId}`);
            this.registerVoiceSocket(guildId, socket);
        });
        this.socket?.on('/v4/websocket/youtube/live', (socket, request, _clientInfo, _sessionId, id) => {
            let videoId = id;
            if (/^\d{17,20}$/.test(id)) {
                const player = this.sessions.getPlayer(id);
                if (player?.track?.info?.sourceName?.includes('youtube')) {
                    videoId = player.track.info.identifier;
                }
            }
            else if (id.length > 50) {
                try {
                    const decoded = decodeTrack(id);
                    if (decoded?.info?.sourceName?.includes('youtube')) {
                        videoId = decoded.info.identifier;
                    }
                }
                catch (_e) { }
            }
            if (!this.sourceWorkerManager) {
                const yt = this.sources?.getSource('youtube');
                if (!yt) {
                    socket.close(1008, 'YouTube source not enabled');
                    return;
                }
                const liveChatFn = yt.handleLiveChat;
                if (typeof liveChatFn === 'function') {
                    liveChatFn.call(yt, socket, videoId);
                }
                else {
                    socket.close(1008, 'YouTube live chat not supported');
                }
                return;
            }
            logger('info', 'YouTube-LiveChat', `Delegating live chat for video: ${videoId} to worker`);
            const resShim = {
                headersSent: false,
                send: (data) => {
                    const payload = Buffer.isBuffer(data)
                        ? data
                        : Buffer.from(String(data));
                    socket.sendFrame?.(payload, {
                        len: payload.length,
                        fin: true,
                        opcode: Buffer.isBuffer(data) ? 0x02 : 0x01
                    });
                },
                writeHead: (status) => {
                    if (status !== 200)
                        socket.close(1011, 'Worker failed');
                },
                write: (data) => {
                    const payload = Buffer.isBuffer(data)
                        ? data
                        : Buffer.from(String(data));
                    socket.sendFrame?.(payload, {
                        len: payload.length,
                        fin: true,
                        opcode: Buffer.isBuffer(data) ? 0x02 : 0x01
                    });
                },
                end: () => socket.close(1000, 'Finished'),
                on: (event, cb) => socket.on(event, cb)
            };
            this.sourceWorkerManager.delegate(request, resShim, 'loadLiveChat', { videoId }, { isWebSocket: true });
        });
    }
    /**
     * Starts listening on configured port and host
     * @internal
     */
    _listen() {
        if (!this.server ||
            typeof this.server.listen !== 'function')
            return;
        const port = this.options.server.port;
        const host = this.options.server.host || '0.0.0.0';
        logger('info', 'Server', `Attempting to listen on host: ${host}, port: ${port}`);
        this.server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                logger('error', 'Server', `Port ${port} is already in use.`);
            }
            else if (err.code === 'EADDRNOTAVAIL') {
                logger('error', 'Server', `The address ${host} is not available on this machine.`);
                logger('error', 'Server', 'Please check your `host` configuration. Use "0.0.0.0" to listen on all available interfaces.');
            }
            else {
                logger('error', 'Server', `Failed to start server: ${err.message}`);
            }
            process.exit(1);
        });
        this.server.listen(port, host, () => {
            logger('started', 'Server', `Successfully listening on host ${host}, port ${port}`);
        });
    }
    /**
     * Starts global player state updater interval
     * @internal
     */
    _startGlobalUpdater() {
        if (this._globalUpdater)
            return;
        const updateInterval = Math.max(1, this.options?.playerUpdateInterval ?? 5000);
        const statsSendInterval = Math.max(1, this.options?.statsUpdateInterval ?? 30000);
        const metricsInterval = this.options?.metrics?.enabled
            ? 5000
            : statsSendInterval;
        const zombieThreshold = this.options?.zombieThresholdMs ?? 60000;
        this._globalUpdater = setInterval(() => {
            for (const session of this.sessions.values()) {
                if (!session.players)
                    continue;
                for (const player of session.players.players.values()) {
                    if (player?.track && !player.isPaused && player.connection) {
                        if (player._lastStreamDataTime > 0 &&
                            Date.now() - player._lastStreamDataTime >= zombieThreshold) {
                            logger('warn', 'Player', `Player for guild ${player.guildId} detected as zombie (no stream data).`);
                            player.emitEvent(GatewayEvents.TRACK_STUCK, {
                                guildId: player.guildId,
                                track: player.track,
                                reason: 'no_stream_data',
                                thresholdMs: zombieThreshold
                            });
                        }
                        player._sendUpdate();
                    }
                }
            }
        }, updateInterval);
        let lastStatsSendTime = 0;
        this._statsUpdater = setInterval(() => {
            const now = Date.now();
            let localPlayers = 0;
            let localPlayingPlayers = 0;
            let voiceConnections = 0;
            for (const session of this.sessions.values()) {
                if (!session.players)
                    continue;
                for (const player of session.players.players.values()) {
                    localPlayers++;
                    if (!player.isPaused && player.track) {
                        localPlayingPlayers++;
                    }
                    if (player.connection) {
                        voiceConnections++;
                    }
                }
            }
            this.statsManager.setVoiceConnections(voiceConnections);
            if (clusterEnabled && cluster.isWorker) {
                // fishy ports to typescript 🙃
                process.send?.({
                    type: 'workerStats',
                    stats: {
                        players: localPlayers,
                        playingPlayers: localPlayingPlayers
                    }
                });
            }
            else if (!clusterEnabled) {
                this.statistics.players = localPlayers;
                this.statistics.playingPlayers = localPlayingPlayers;
            }
            const stats = getStats(this);
            const workerMetrics = this.workerManager
                ? this.workerManager.getWorkerMetrics()
                : null;
            this.statsManager.updateStatsMetrics(stats, (workerMetrics ?? undefined));
            if (now - lastStatsSendTime >= statsSendInterval) {
                lastStatsSendTime = now;
                const statsPayload = JSON.stringify({ op: 'stats', ...stats });
                for (const session of this.sessions.values()) {
                    if (session.socket) {
                        session.socket.send(statsPayload);
                    }
                }
            }
        }, metricsInterval);
    }
    /**
     * Stops global player updater interval
     * @internal
     */
    _stopGlobalPlayerUpdater() {
        if (this._globalUpdater) {
            clearInterval(this._globalUpdater);
            this._globalUpdater = null;
        }
        if (this._statsUpdater) {
            clearInterval(this._statsUpdater);
            this._statsUpdater = null;
        }
    }
    /**
     * Cleans up WebSocket server resources
     * @internal
     */
    async _cleanupWebSocketServer() {
        if (this._usingBunServer && this.server) {
            try {
                logger('info', 'WebSocket', 'Stopping Bun server...');
                await this.server.stop(true);
                this.server.unref();
                logger('info', 'WebSocket', 'Bun server stopped successfully');
            }
            catch (e) {
                const error = e;
                logger('error', 'WebSocket', `Error stopping Bun server: ${error?.message ?? String(e)}`);
            }
            return;
        }
        if (this.socket) {
            try {
                let closedCount = 0;
                for (const session of this.sessions.activeSessions.values()) {
                    if (session.socket) {
                        try {
                            session.socket.close(1000, 'Server shutdown');
                            closedCount++;
                        }
                        catch (_e) {
                            try {
                                session.socket.destroy?.();
                            }
                            catch (_destroyErr) {
                                logger('debug', 'WebSocket', `Failed to close/destroy socket for session ${session.id}`);
                            }
                        }
                    }
                }
                this.sessions.activeSessions.clear();
                this.sessions.resumableSessions.clear();
                logger('info', 'WebSocket', `Closed ${closedCount} WebSocket connection(s) successfully`);
            }
            catch (error) {
                const err = error;
                logger('error', 'WebSocket', `Error closing WebSocket connections: ${err.message}`);
            }
        }
    }
    /**
     * Handles IPC messages from workers
     * @param msg - IPC message
     * @public
     */
    handleIPCMessage(msg) {
        if (msg.type === 'playerEvent') {
            const { sessionId, data } = msg.payload;
            const session = this.sessions.get(sessionId);
            session?.socket?.send(data);
        }
        else if (msg.type === 'workerStats') {
            if (this.workerManager) {
                const worker = this.workerManager.workers.find((w) => w.process.pid === msg.pid);
                if (worker) {
                    this.workerManager.workerLoad.set(worker.id, msg.stats.players);
                }
            }
        }
        else if (msg.type === 'workerFailed') {
            const { workerId, affectedGuilds } = msg.payload;
            logger('warn', 'Cluster', `Worker ${workerId} failed. Notifying clients for affected players: ${affectedGuilds.join(', ')}`);
            const sessionsToNotify = new Map();
            for (const playerKey of affectedGuilds) {
                const [sessionId, guildId] = playerKey.split(':');
                if (!sessionsToNotify.has(sessionId)) {
                    sessionsToNotify.set(sessionId, new Set());
                }
                sessionsToNotify.get(sessionId).add(guildId);
            }
            for (const [sessionId, guildsInSession] of sessionsToNotify.entries()) {
                const session = this.sessions.get(sessionId);
                if (session?.socket) {
                    const affected = Array.from(guildsInSession);
                    session.socket.send(JSON.stringify({
                        op: 'event',
                        type: 'WorkerFailedEvent',
                        affectedGuilds: affected,
                        message: `Players for guilds ${affected.join(', ')} lost due to worker failure.`
                    }));
                    for (const guildId of affected) {
                        session.socket.send(JSON.stringify({
                            op: 'event',
                            type: GatewayEvents.WEBSOCKET_CLOSED,
                            guildId,
                            code: 5001,
                            reason: 'worker_failed',
                            byRemote: false
                        }));
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
    async start(startOptions = {}) {
        memoryTrace('start:enter');
        this._validateConfig();
        if (!startOptions.isClusterPrimary) {
            await this._ensurePersistenceManagers();
            await this.credentialManager?.load();
            memoryTrace('start:after-credential-load');
            await this.trackCacheManager?.load();
            memoryTrace('start:after-trackcache-load');
        }
        else {
            memoryTrace('start:skip-persistence-load-primary');
        }
        await this.statsManager.initialize();
        memoryTrace(startOptions.isClusterPrimary
            ? 'start:after-stats-init-primary'
            : 'start:after-stats-init');
        // Ensure sources are initialized before proceeding
        if (this._sourceInitPromise)
            await this._sourceInitPromise;
        memoryTrace('start:after-source-init');
        await this.pluginManager.load('master');
        memoryTrace('start:after-master-plugin-load');
        if (startOptions.isClusterPrimary &&
            this.options.cluster?.specializedSourceWorker?.enabled &&
            !this.sourceWorkerManager) {
            const SourceWorkerManagerClass = await getSourceWorkerManagerClass();
            this.sourceWorkerManager = new SourceWorkerManagerClass(this);
            memoryTrace('start:after-source-worker-manager-ctor');
        }
        if (this.sourceWorkerManager) {
            await this.sourceWorkerManager.start();
            memoryTrace('start:after-source-worker-manager-start');
        }
        const specEnabled = this.options.cluster?.specializedSourceWorker?.enabled;
        await this._ensureConnectionManager();
        memoryTrace('start:after-connection-manager');
        if (!startOptions.isClusterPrimary) {
            await this.pluginManager.load('worker');
            memoryTrace('start:after-worker-plugin-load');
        }
        if (this.sources && (!startOptions.isClusterPrimary || !specEnabled)) {
            await this.sources?.loadFolder();
            await this.lyrics?.loadFolder();
            await this.meanings?.loadFolder();
            memoryTrace('start:after-sources-load');
        }
        this._setupSocketEvents();
        memoryTrace('start:after-setup-socket-events');
        this._createServer();
        memoryTrace('start:after-create-server');
        if (startOptions.isClusterWorker) {
            logger('info', 'Server', 'Running as cluster worker — waiting for sockets from master.');
            process.on('message', (msg, handle) => {
                if (!msg || msg.type !== 'sticky-session')
                    return;
                if (!handle)
                    return;
                try {
                    try {
                        // @ts-expect-error - handle.pause is from Node.js internal
                        handle.pause?.();
                    }
                    catch (_e) { }
                    ;
                    this.server.emit('connection', handle);
                }
                catch (err) {
                    const error = err;
                    logger('error', 'Server', `Failed to inject socket from master: ${error.message}`);
                    try {
                        // @ts-expect-error - handle.destroy is from Node.js internal
                        handle.destroy?.();
                    }
                    catch (_e) { }
                }
            });
        }
        else {
            this._listen();
        }
        if (startOptions.isClusterPrimary) {
            this._startMasterMetricsUpdater();
        }
        else {
            this._startGlobalUpdater();
        }
        if (!startOptions.isClusterPrimary || clusterEnabled) {
            this._startHeartbeat();
        }
        this.connectionManager?.start();
        memoryTrace('start:ready');
        return this;
    }
    /**
     * Starts metrics updater for cluster master process
     * @internal
     */
    _startMasterMetricsUpdater() {
        if (this._globalUpdater)
            return;
        const statsSendInterval = Math.max(1, this.options?.statsUpdateInterval ?? 30000);
        const metricsInterval = this.options?.metrics?.enabled
            ? 5000
            : statsSendInterval;
        let lastStatsSendTime = 0;
        this._globalUpdater = setInterval(() => {
            const now = Date.now();
            const stats = getStats(this);
            const workerMetrics = this.workerManager
                ? this.workerManager.getWorkerMetrics()
                : null;
            this.statsManager.updateStatsMetrics(stats, (workerMetrics ?? undefined));
            const sessionCount = this.sessions.activeSessions?.size || 0;
            this.statsManager.setWebsocketConnections(sessionCount);
            if (now - lastStatsSendTime >= statsSendInterval) {
                lastStatsSendTime = now;
                const statsPayload = JSON.stringify({ op: 'stats', ...stats });
                for (const session of this.sessions.values()) {
                    if (session.socket) {
                        session.socket.send(statsPayload);
                    }
                }
            }
        }, metricsInterval);
    }
    /**
     * Registers a custom source extension
     * @param name - Source name
     * @param source - Source extension implementation
     * @public
     */
    registerSource(name, source) {
        if (!this.sources) {
            logger('warn', 'Server', 'Cannot register source in this context (sources manager not available).');
            return;
        }
        this.sources.sources.set(name, source);
        logger('info', 'Server', `Registered custom source: ${name}`);
    }
    /**
     * Registers a custom filter extension
     * @param name - Filter name
     * @param filter - Filter extension implementation
     * @public
     */
    registerFilter(name, filter) {
        this.extensions.filters.set(name, filter);
        logger('info', 'Server', `Registered custom filter: ${name}`);
    }
    /**
     * Registers a custom HTTP route
     * @param method - HTTP method
     * @param path - Route path
     * @param handler - Route handler function
     * @public
     */
    registerRoute(method, path, handler) {
        this.extensions.routes.push({ method, path, handler });
        logger('info', 'Server', `Registered custom route: ${method} ${path}`);
    }
    /**
     * Registers a middleware extension
     * @param fn - Middleware function
     * @public
     */
    registerMiddleware(fn) {
        this.extensions.middlewares.push(fn);
        logger('info', 'Server', 'Registered custom REST interceptor (middleware)');
    }
    /**
     * Registers a track modifier extension
     * @param fn - Track modifier function
     * @public
     */
    registerTrackModifier(fn) {
        this.extensions.trackModifiers.push(fn);
        logger('info', 'Server', 'Registered custom track info modifier');
    }
    /**
     * Registers a WebSocket interceptor extension
     * @param fn - WebSocket interceptor function
     * @public
     */
    registerWebSocketInterceptor(fn) {
        this.extensions.wsInterceptors.push(fn);
        logger('info', 'Server', 'Registered custom WebSocket interceptor');
    }
    /**
     * Registers an audio interceptor extension
     * @param interceptor - Audio interceptor function
     * @public
     */
    registerAudioInterceptor(interceptor) {
        if (!this.extensions.audioInterceptors)
            this.extensions.audioInterceptors = [];
        this.extensions.audioInterceptors.push(interceptor);
        logger('info', 'Server', 'Registered custom audio interceptor');
    }
    /**
     * Registers a player interceptor extension
     * @param interceptor - Player interceptor function
     * @public
     */
    registerPlayerInterceptor(interceptor) {
        this.extensions.playerInterceptors.push(interceptor);
        logger('info', 'Server', 'Registered custom player interceptor');
    }
}
if (clusterEnabled && cluster.isPrimary) {
    if (config.sources?.youtube?.getOAuthToken) {
        // dynamicly import OAuth (if enabled)
        const OAuth = (await import('./sources/youtube/OAuth.js').catch((e) => {
            logger('error', 'youtube', `\x1b[1m\x1b[31mOAuth class not found Error: ${e.message}\x1b[0m`);
            process.exit(1);
        })).default;
        const CredentialManagerClass = await getCredentialManagerClass();
        const mockNodelink = {
            options: config,
            credentialManager: null
        };
        mockNodelink.credentialManager = new CredentialManagerClass(mockNodelink);
        const validator = new OAuth(mockNodelink);
        await validator.validateCurrentTokens();
        try {
            await OAuth.acquireRefreshToken();
            process.exit(0);
        }
        catch (error) {
            const err = error;
            logger('error', 'OAuth', `YouTube OAuth token acquisition failed: ${err.message}`);
            process.exit(1);
        }
    }
    const WorkerManagerClass = await getWorkerManagerClass();
    memoryTrace('primary:after-worker-manager-class-import');
    const PlayerManagerClass = await getPlayerManagerClass();
    memoryTrace('primary:after-player-manager-class-import');
    const workerManager = new WorkerManagerClass(config);
    memoryTrace('primary:after-worker-manager-ctor');
    const serverInstancePromise = (async () => {
        const nserver = new NodelinkServer(config, PlayerManagerClass, true);
        memoryTrace('primary:after-server-ctor');
        nserver.workerManager = workerManager;
        await nserver.start({ isClusterPrimary: true });
        global.nodelink =
            nserver;
        let isShuttingDown = false;
        const shutdown = async () => {
            if (isShuttingDown)
                return;
            isShuttingDown = true;
            if (nserver.workerManager)
                nserver.workerManager.isDestroying = true;
            nserver.emit('shutdown');
            process.stdout.write('\n  \x1b[32m💚 Thank you for using NodeLink!\x1b[0m\n');
            process.stdout.write('  \x1b[37mIf you have ideas, suggestions or want to report bugs, join us on Discord:\x1b[0m\n');
            process.stdout.write('  \x1b[1m\x1b[34m➜\x1b[0m \x1b[36mhttps://discord.gg/fzjksWS65v\x1b[0m\n\n');
            logger('info', 'Server', 'Shutdown signal received. Cleaning up resources...');
            nserver._stopHeartbeat();
            await nserver.credentialManager?.forceSave();
            await nserver.trackCacheManager?.forceSave();
            nserver.sourceWorkerManager?.destroy?.();
            workerManager.destroy();
            await nserver._cleanupWebSocketServer();
            if (nserver.server?.listening) {
                await new Promise((resolve) => nserver.server.close(resolve));
                logger('info', 'Server', 'HTTP server closed.');
            }
            cleanupHttpAgents();
            nserver.rateLimitManager.destroy();
            nserver.dosProtectionManager.destroy();
            cleanupLogger();
            process.exit(0);
        };
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
        return nserver;
    })();
    await serverInstancePromise.catch((err) => {
        logger('error', 'Server', `Fatal error during primary startup: ${err.message}`, err);
        process.exit(1);
    });
}
else if (clusterEnabled && cluster.isWorker) {
    await import("./workers/main.js");
}
else {
    const serverInstancePromise = (async () => {
        const PlayerManagerClass = await getPlayerManagerClass();
        const nserver = new NodelinkServer(config, PlayerManagerClass, false);
        await nserver.start();
        global.nodelink =
            nserver;
        logger('info', 'Server', `Single-process server running (PID ${process.pid})`);
        let isShuttingDown = false;
        const shutdown = async () => {
            if (isShuttingDown)
                return;
            isShuttingDown = true;
            logger('info', 'Server', 'Shutdown signal received. Cleaning up resources...');
            nserver._stopHeartbeat();
            await nserver.credentialManager?.forceSave();
            await nserver.trackCacheManager?.forceSave();
            nserver.sourceWorkerManager?.destroy?.();
            await nserver._cleanupWebSocketServer();
            if (nserver.server?.listening) {
                await new Promise((resolve) => nserver.server.close(resolve));
                logger('info', 'Server', 'HTTP server closed.');
            }
            cleanupHttpAgents();
            nserver.rateLimitManager.destroy();
            nserver.dosProtectionManager.destroy();
            cleanupLogger();
            process.stdout.write('\n  \x1b[32m💚 Thank you for using NodeLink!\x1b[0m\n');
            process.stdout.write('  \x1b[37mIf you have ideas, suggestions or want to report bugs, join us on Discord:\x1b[0m\n');
            process.stdout.write('  \x1b[1m\x1b[34m➜\x1b[0m \x1b[36mhttps://discord.gg/fzjksWS65v\x1b[0m\n\n');
            process.exit(0);
        };
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
        return nserver;
    })();
    await serverInstancePromise.catch((err) => {
        logger('error', 'Server', `Fatal error during single-process startup: ${err.message}`, err);
        process.exit(1);
    });
}
