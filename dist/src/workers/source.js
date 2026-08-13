var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import inspector from 'node:inspector';
import net from 'node:net';
import os from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import v8 from 'node:v8';
import { isMainThread, parentPort, workerData as rawWorkerData, Worker } from 'node:worker_threads';
import { migrateConfig } from '../modules/config/configMigration.js';
import * as utils from '../utils.js';
import { createHeadQueue, dequeueHeadQueue, enqueueHeadQueue, getHeadQueueLength } from './headQueue.js';
const __filename = fileURLToPath(import.meta.url);
const getActiveResourcesBreakdown = () => {
    const list = process.getActiveResourcesInfo?.() ?? [];
    const counters = {};
    for (const item of list) {
        counters[item] = (counters[item] || 0) + 1;
    }
    return counters;
};
const getActiveHandlesBreakdown = () => {
    const getter = process;
    if (typeof getter._getActiveHandles !== 'function')
        return {};
    const handles = getter._getActiveHandles();
    const counters = {};
    for (const handle of handles) {
        const name = handle?.constructor?.name || 'UnknownHandle';
        counters[name] = (counters[name] || 0) + 1;
    }
    return counters;
};
const getHeapSpaces = () => v8.getHeapSpaceStatistics().map((space) => ({
    spaceName: space.space_name,
    spaceSize: space.space_size,
    spaceUsedSize: space.space_used_size,
    spaceAvailableSize: space.space_available_size,
    physicalSpaceSize: space.physical_space_size
}));
/**
 * Main thread - Source Worker Manager
 * Spawns and manages a pool of micro-workers for handling source API tasks
 */
if (isMainThread) {
    const resolveRootConfigUrl = (fileName) => pathToFileURL(resolvePath(process.cwd(), fileName)).href;
    /**
     * Loads NodeLink configuration
     * @returns Configuration object
     * @internal
     */
    async function loadConfig() {
        const resolveConfigExport = (importedModule, fileName) => {
            const candidate = importedModule.default ??
                importedModule.config;
            if (candidate &&
                typeof candidate === 'object' &&
                Object.keys(candidate).length > 0) {
                return candidate;
            }
            throw new Error(`[ERROR] Config: ${fileName} must export a non-empty configuration object (default export or named "config").`);
        };
        const candidates = [
            'config.ts',
            'config.js',
            'config.default.ts',
            'config.default.js'
        ];
        for (const fileName of candidates) {
            try {
                const module = await import(__rewriteRelativeImportExtension(resolveRootConfigUrl(fileName)));
                const raw = resolveConfigExport(module, fileName);
                return migrateConfig(raw);
            }
            catch (error) {
                const err = error;
                const isNotFound = err.code === 'ERR_MODULE_NOT_FOUND' ||
                    err.code === 'ENOENT' ||
                    err.message?.includes('Cannot find module');
                if (isNotFound)
                    continue;
                throw error;
            }
        }
        throw new Error('[ERROR] Config: Failed to load configuration (config.ts/config.js/config.default.ts/config.default.js).');
    }
    const config = await loadConfig();
    utils.applyEnvOverrides(config);
    const specConfig = 
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index signature access
    config['cluster']?.[
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index signature access
    'specializedSourceWorker'] || {};
    utils.initLogger(config);
    const nodelink = {
        options: config,
        logger: utils.logger,
        pluginManager: null
    };
    const { default: PluginManagerClass } = await import('../managers/pluginManager.js');
    nodelink.pluginManager = new PluginManagerClass(nodelink);
    await nodelink.pluginManager.load('source-worker');
    const maxThreadCount = Math.max(1, specConfig.microWorkers ?? Math.min(2, os.cpus().length));
    const initialThreadCount = 1;
    const TASKS_PER_WORKER = specConfig.tasksPerWorker ?? 32;
    const SCALE_UP_THRESHOLD = specConfig.scaleUpThreshold ?? 30;
    const SCALE_UP_COOLDOWN_MS = specConfig.scaleCooldownMs ?? 1000;
    const workerPool = [];
    const taskQueue = createHeadQueue();
    let lastScaleUpAt = 0;
    let nextThreadId = initialThreadCount + 1;
    const inheritedExecArgv = process.execArgv || [];
    nodelink.logger('info', 'SourceWorker', `Starting ${initialThreadCount}/${maxThreadCount} micro-worker(s) for API tasks...`);
    const createMicroWorker = (threadNumber) => {
        const worker = new Worker(__filename, {
            workerData: {
                config,
                silentLogs: specConfig.silentLogs ?? false,
                threadId: threadNumber
            },
            ...(inheritedExecArgv.length > 0 ? { execArgv: inheritedExecArgv } : {})
        });
        worker.ready = false;
        worker.load = 0;
        worker.on('message', (msg) => {
            if (msg.type === 'ready') {
                worker.ready = true;
                nodelink.logger('info', 'SourceWorker', `Micro-worker ${threadNumber} is ready.`);
                processNextTask();
            }
            else if (msg.type === 'result') {
                const { socketPath, id, result, error } = msg;
                finishTask(socketPath, id, result, error);
                worker.load = Math.max(0, worker.load - 1);
                processNextTask();
            }
            else if (msg.type === 'stream') {
                sendStreamChunk(msg.socketPath, msg.id, msg.chunk);
            }
            else if (msg.type === 'chatAction') {
                sendChatAction(msg.socketPath, msg.id, msg.data);
            }
            else if (msg.type === 'end') {
                sendStreamEnd(msg.socketPath, msg.id);
                worker.load = Math.max(0, worker.load - 1);
                processNextTask();
            }
            else if (msg.type === 'error') {
                sendStreamError(msg.socketPath, msg.id, msg.error);
                worker.load = Math.max(0, worker.load - 1);
                processNextTask();
            }
        });
        worker.on('exit', (code) => {
            const idx = workerPool.indexOf(worker);
            if (idx !== -1)
                workerPool.splice(idx, 1);
            const loadInfo = worker.load > 0 ? ` (had ${worker.load} pending tasks)` : '';
            nodelink.logger('warn', 'SourceWorker', `Micro-worker ${threadNumber} exited with code ${code}${loadInfo}`);
            if (workerPool.length < initialThreadCount && !process.exitCode) {
                setTimeout(() => {
                    if (workerPool.length < maxThreadCount) {
                        const newThreadNumber = nextThreadId++;
                        nodelink.logger('info', 'SourceWorker', `Respawning micro-worker ${newThreadNumber}...`);
                        createMicroWorker(newThreadNumber);
                    }
                }, 100);
            }
        });
        worker.on('error', (err) => {
            nodelink.logger('error', 'SourceWorker', `Micro-worker ${threadNumber} error: ${err.message}`);
        });
        workerPool.push(worker);
    };
    const getTotalLoad = () => {
        let total = 0;
        for (const worker of workerPool)
            total += worker.load || 0;
        return total;
    };
    const maybeScaleUpMicroWorkers = () => {
        if (workerPool.length >= maxThreadCount)
            return;
        const now = Date.now();
        if (now - lastScaleUpAt < SCALE_UP_COOLDOWN_MS)
            return;
        const totalLoad = getTotalLoad() + getHeadQueueLength(taskQueue);
        const threshold = workerPool.length * SCALE_UP_THRESHOLD;
        if (totalLoad <= threshold)
            return;
        const nextThreadNumber = nextThreadId++;
        createMicroWorker(nextThreadNumber);
        lastScaleUpAt = now;
        nodelink.logger('info', 'SourceWorker', `Scaling micro-workers: ${workerPool.length}/${maxThreadCount} (load=${totalLoad}, threshold=${threshold})`);
    };
    for (let i = 0; i < initialThreadCount; i++) {
        createMicroWorker(i + 1);
    }
    const sockets = new Map();
    /**
     * Gets or creates a Unix socket connection to the specified path
     * @param path - Unix socket path
     * @returns Promise resolving to connected socket
     * @internal
     */
    async function getSocket(path) {
        const existing = sockets.get(path);
        if (existing) {
            socketLastUsed.set(path, Date.now());
            return existing;
        }
        return new Promise((resolve, reject) => {
            let settled = false;
            const socket = net.createConnection(path, () => {
                settled = true;
                socket.off('error', onConnectError);
                socket.on('error', () => {
                    sockets.delete(path);
                    socketLastUsed.delete(path);
                });
                sockets.set(path, socket);
                socketLastUsed.set(path, Date.now());
                resolve(socket);
            });
            const onConnectError = (err) => {
                if (settled)
                    return;
                settled = true;
                reject(err);
            };
            socket.on('error', onConnectError);
            socket.on('close', () => {
                sockets.delete(path);
                socketLastUsed.delete(path);
            });
        });
    }
    /**
     * Executes handler with socket, creating connection if needed
     * @param path - Unix socket path
     * @param handler - Function to execute with socket
     * @internal
     */
    function withSocket(path, handler) {
        const socket = sockets.get(path);
        if (socket) {
            socketLastUsed.set(path, Date.now());
            handler(socket);
            return;
        }
        getSocket(path)
            .then((s) => {
            socketLastUsed.set(path, Date.now());
            handler(s);
        })
            .catch((e) => {
            utils.logger('error', 'SourceWorker', `Failed to send data back: ${e.message}`);
        });
    }
    /**
     * Sends task completion result or error back through socket
     * @param socketPath - Unix socket path
     * @param id - Task identifier
     * @param result - Result data (JSON string)
     * @param error - Error message if task failed
     * @internal
     */
    function finishTask(socketPath, id, result, error) {
        getSocket(socketPath)
            .then((socket) => {
            socketLastUsed.set(socketPath, Date.now());
            if (error) {
                sendFrame(socket, id, 2, Buffer.from(error, 'utf8'));
            }
            else if (result) {
                sendFrame(socket, id, 0, Buffer.from(result, 'utf8'));
                sendFrame(socket, id, 1, Buffer.alloc(0));
            }
        })
            .catch((e) => {
            utils.logger('error', 'SourceWorker', `Failed to send result back: ${e.message}`);
        });
    }
    /**
     * Sends a stream data chunk through socket
     * @param socketPath - Unix socket path
     * @param id - Stream identifier
     * @param chunk - Data chunk (Buffer or string)
     * @internal
     */
    function sendStreamChunk(socketPath, id, chunk) {
        const payload = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        withSocket(socketPath, (socket) => sendFrame(socket, id, 0, payload));
    }
    /**
     * Sends live chat action data through socket
     * @param socketPath - Unix socket path
     * @param id - Chat session identifier
     * @param data - Chat action data
     * @internal
     */
    function sendChatAction(socketPath, id, data) {
        const payload = Buffer.from(JSON.stringify(data), 'utf8');
        withSocket(socketPath, (socket) => sendFrame(socket, id, 3, payload));
    }
    /**
     * Sends stream end signal through socket
     * @param socketPath - Unix socket path
     * @param id - Stream identifier
     * @internal
     */
    function sendStreamEnd(socketPath, id) {
        withSocket(socketPath, (socket) => sendFrame(socket, id, 1, Buffer.alloc(0)));
    }
    /**
     * Sends stream error through socket
     * @param socketPath - Unix socket path
     * @param id - Stream identifier
     * @param error - Error message
     * @internal
     */
    function sendStreamError(socketPath, id, error) {
        const errorBuf = Buffer.from(String(error || 'Unknown error'), 'utf8');
        withSocket(socketPath, (socket) => sendFrame(socket, id, 2, errorBuf));
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
    function sendFrame(socket, id, type, payloadBuf) {
        if (socket.destroyed || socket.writable === false)
            return;
        const idBuf = Buffer.from(id, 'utf8');
        const header = Buffer.alloc(6);
        header.writeUInt8(idBuf.length, 0);
        header.writeUInt8(type, 1);
        header.writeUInt32BE(payloadBuf.length, 2);
        try {
            socket.cork();
            socket.write(header);
            socket.write(idBuf);
            socket.write(payloadBuf);
            socket.uncork();
        }
        catch {
            try {
                socket.destroy();
            }
            catch { }
        }
    }
    /**
     * Processes next task in queue by assigning to least-loaded worker
     * @internal
     */
    function processNextTask() {
        if (getHeadQueueLength(taskQueue) === 0)
            return;
        maybeScaleUpMicroWorkers();
        let bestWorker = null;
        let minLoad = Number.POSITIVE_INFINITY;
        for (const worker of workerPool) {
            if (worker.ready &&
                worker.load < TASKS_PER_WORKER &&
                worker.load < minLoad) {
                bestWorker = worker;
                minLoad = worker.load;
            }
        }
        if (bestWorker) {
            const task = dequeueHeadQueue(taskQueue);
            if (task) {
                bestWorker.load++;
                bestWorker.postMessage(task);
                if (getHeadQueueLength(taskQueue) > 0)
                    setImmediate(processNextTask);
            }
        }
    }
    /**
     * Handles incoming IPC messages from parent process
     */
    process.on('message', (msg) => {
        nodelink.pluginManager?.callHook('onIPCMessage', msg);
        if (msg.type !== 'sourceTask')
            return;
        if (msg.payload) {
            enqueueHeadQueue(taskQueue, msg.payload);
            maybeScaleUpMicroWorkers();
            processNextTask();
        }
    });
    /**
     * Notify parent that worker is ready
     */
    try {
        process.send?.({ type: 'ready', pid: process.pid });
    }
    catch { }
    const CLEANUP_INTERVAL = 60000;
    const SOCKET_IDLE_MS = 120000;
    const socketLastUsed = new Map();
    setInterval(() => {
        const now = Date.now();
        for (const [path, lastUsed] of socketLastUsed) {
            if (now - lastUsed > SOCKET_IDLE_MS) {
                const socket = sockets.get(path);
                if (socket) {
                    try {
                        socket.destroy();
                    }
                    catch { }
                }
                sockets.delete(path);
                socketLastUsed.delete(path);
            }
        }
        if (global.gc) {
            const mem = process.memoryUsage();
            const heapPressure = mem.heapUsed / mem.heapTotal;
            if (heapPressure > 0.85) {
                global.gc();
            }
        }
    }, CLEANUP_INTERVAL).unref();
}
else {
    /**
     * Worker thread - Micro-worker for executing source API tasks
     * Each micro-worker initializes its own source managers and processes tasks
     */
    const workerData = rawWorkerData;
    const { config, silentLogs } = workerData;
    if (silentLogs) {
        // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index signature access
        config['logging'] = {
            // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index signature access
            ...config['logging'],
            level: 'warn'
        };
    }
    utils.initLogger(config);
    const nodelink = {
        options: config,
        logger: utils.logger,
        pluginManager: null
    };
    const { default: PluginManagerClass } = await import('../managers/pluginManager.js');
    nodelink.pluginManager = new PluginManagerClass(nodelink);
    await nodelink.pluginManager.load('micro-worker');
    /**
     * Dynamically imports and initializes all required managers
     * @internal
     */
    const [{ createPCMStream, createSeekeableAudioResource }, { default: SourceManager }, { default: CredentialManager }, { default: TrackCacheManager }, { default: RoutePlannerManager }, { default: StatsManager }] = await Promise.all([
        import('../playback/processing/streamProcessor.js'),
        import('../managers/sourceManager.js'),
        import('../managers/credentialManager.js'),
        import('../managers/trackCacheManager.js'),
        import('../managers/routePlannerManager.js'),
        import('../managers/statsManager.js')
    ]);
    nodelink.statsManager = new StatsManager(nodelink);
    nodelink.credentialManager = new CredentialManager(nodelink);
    nodelink.trackCacheManager = new TrackCacheManager(nodelink);
    nodelink.routePlanner = new RoutePlannerManager(nodelink);
    nodelink.sources = new SourceManager(nodelink);
    await nodelink.credentialManager.load();
    await nodelink.trackCacheManager.load();
    await nodelink.sources.loadFolder();
    let lyricsManagerPromise = null;
    let meaningManagerPromise = null;
    const getLyricsManager = async () => {
        if (!lyricsManagerPromise) {
            lyricsManagerPromise = import('../managers/lyricsManager.js').then(async (module) => {
                const manager = new module.default(nodelink);
                await manager.loadFolder();
                nodelink.lyrics = manager;
                return manager;
            });
        }
        return lyricsManagerPromise;
    };
    const getMeaningManager = async () => {
        if (!meaningManagerPromise) {
            meaningManagerPromise = import('../managers/meaningManager.js').then(async (module) => {
                const manager = new module.default(nodelink);
                await manager.loadFolder();
                nodelink.meanings = manager;
                return manager;
            });
        }
        return meaningManagerPromise;
    };
    nodelink.getLyricsManager =
        getLyricsManager;
    nodelink.getMeaningManager =
        getMeaningManager;
    /**
     * Active live chat sessions (session ID -> active flag)
     * @internal
     */
    const activeChats = new Map();
    const profilerBaseDir = process.env.NODELINK_PROFILER_DIR || '.profiles';
    let activeCpuSession = null;
    let activeHeapSampling = null;
    const sanitizeProfileName = (value) => {
        if (!value)
            return '';
        return value
            .trim()
            .replace(/[^a-zA-Z0-9._-]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 80);
    };
    const buildProfilerFilePath = async (kind, extension, label) => {
        await fsPromises.mkdir(profilerBaseDir, { recursive: true });
        const safeLabel = sanitizeProfileName(label);
        const stamp = new Date()
            .toISOString()
            .replace(/[:.]/g, '-')
            .replace('T', '_')
            .replace('Z', '');
        const suffix = safeLabel ? `-${safeLabel}` : '';
        return `${profilerBaseDir}/source-micro-${process.pid}-${kind}-${stamp}${suffix}.${extension}`;
    };
    const inspectorPost = (session, method, params) => new Promise((resolve, reject) => {
        session.post(method, params ?? {}, (error, result) => {
            if (error)
                reject(error);
            else
                resolve((result ?? {}));
        });
    });
    const summarizeHeapSamplingProfile = (profile, limit = null) => {
        const head = profile.head;
        if (!head)
            return [];
        const aggregates = new Map();
        const visit = (node) => {
            const frame = node.callFrame || {};
            const functionName = frame.functionName || '(anonymous)';
            const url = frame.url || '(internal)';
            const line = Number(frame.lineNumber || 0) + 1;
            const column = Number(frame.columnNumber || 0) + 1;
            const selfSize = Number(node.selfSize || 0);
            if (selfSize > 0) {
                const key = `${functionName}|${url}|${line}|${column}`;
                const current = aggregates.get(key);
                if (current) {
                    current.bytes += selfSize;
                    current.hits++;
                }
                else {
                    aggregates.set(key, {
                        functionName,
                        url,
                        line,
                        column,
                        bytes: selfSize,
                        hits: 1
                    });
                }
            }
            const children = Array.isArray(node.children) ? node.children : [];
            for (const child of children) {
                visit(child);
            }
        };
        visit(head);
        const entries = Array.from(aggregates.values()).sort((a, b) => b.bytes - a.bytes);
        if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
            return entries.slice(0, limit);
        }
        return entries;
    };
    const handleProfilerCommand = async (payload) => {
        const action = payload?.action;
        if (typeof action !== 'string' || action.length === 0) {
            return { success: false, error: 'Missing profiler action' };
        }
        if (action === 'status') {
            const sourceManagerDebug = nodelink.sources
                ? {
                    enabledSources: Array.from(nodelink.sources.sources.keys()),
                    sourceMapSize: nodelink.sources.sourceMap?.size ?? null,
                    searchAliasMapSize: nodelink.sources.searchAliasMap?.size ?? null,
                    patternMapLength: nodelink.sources
                        .patternMap?.length ?? null
                }
                : null;
            const trackCacheDebug = nodelink.trackCacheManager
                ? {
                    size: nodelink.trackCacheManager.cache?.size ?? null,
                    maxEntries: nodelink.trackCacheManager
                        .maxEntries ?? null
                }
                : null;
            const credentialDebug = nodelink.credentialManager &&
                typeof nodelink.credentialManager.getStats === 'function'
                ? nodelink.credentialManager.getStats()
                : null;
            const httpAgentsDebug = (() => {
                try {
                    const http = require('node:http');
                    const https = require('node:https');
                    const httpAgent = http.globalAgent;
                    const httpsAgent = https.globalAgent;
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
                    };
                }
                catch {
                    return null;
                }
            })();
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
            };
        }
        if (action === 'openInspector') {
            const host = typeof payload.host === 'string' ? payload.host : '127.0.0.1';
            const port = typeof payload.port === 'number' && Number.isInteger(payload.port)
                ? payload.port
                : 0;
            inspector.open(port, host, payload.exposeWait === true);
            return {
                success: true,
                pid: process.pid,
                inspectorUrl: inspector.url() || null
            };
        }
        if (action === 'closeInspector') {
            inspector.close();
            return { success: true, pid: process.pid, inspectorUrl: null };
        }
        if (action === 'forceGc') {
            const gcFn = global.gc;
            if (typeof gcFn !== 'function') {
                return {
                    success: false,
                    error: 'GC not exposed. Start NodeLink with --expose-gc to enable forceGc.'
                };
            }
            gcFn();
            gcFn();
            return { success: true, pid: process.pid, memory: process.memoryUsage() };
        }
        if (action === 'cpuStart') {
            if (activeCpuSession) {
                return {
                    success: true,
                    alreadyActive: true,
                    pid: process.pid,
                    startedAt: activeCpuSession.startedAt
                };
            }
            const session = new inspector.Session();
            session.connect();
            await inspectorPost(session, 'Profiler.enable');
            await inspectorPost(session, 'Profiler.start');
            activeCpuSession = {
                session,
                startedAt: Date.now(),
                name: sanitizeProfileName(typeof payload.name === 'string' ? payload.name : undefined) || null
            };
            return {
                success: true,
                pid: process.pid,
                startedAt: activeCpuSession.startedAt
            };
        }
        if (action === 'cpuStop') {
            if (!activeCpuSession) {
                return { success: false, error: 'CPU profiler is not active' };
            }
            const { session, startedAt, name } = activeCpuSession;
            const result = await inspectorPost(session, 'Profiler.stop');
            const outputPath = await buildProfilerFilePath('cpu', 'cpuprofile', (typeof payload.name === 'string'
                ? sanitizeProfileName(payload.name)
                : '') ||
                name ||
                undefined);
            await fsPromises.writeFile(outputPath, JSON.stringify(result.profile));
            try {
                session.disconnect();
            }
            catch { }
            activeCpuSession = null;
            return {
                success: true,
                pid: process.pid,
                startedAt,
                endedAt: Date.now(),
                outputPath
            };
        }
        if (action === 'heapSnapshot') {
            const outputPath = await buildProfilerFilePath('heap', 'heapsnapshot', typeof payload.name === 'string' ? payload.name : undefined);
            const session = new inspector.Session();
            let fd = null;
            try {
                fd = fs.openSync(outputPath, 'w');
                session.connect();
                session.on('HeapProfiler.addHeapSnapshotChunk', (message) => {
                    const chunk = message?.params?.chunk;
                    if (typeof chunk === 'string' && fd !== null)
                        fs.writeSync(fd, chunk);
                });
                await inspectorPost(session, 'HeapProfiler.enable');
                await inspectorPost(session, 'HeapProfiler.takeHeapSnapshot', {
                    reportProgress: false
                });
                return { success: true, pid: process.pid, outputPath };
            }
            finally {
                try {
                    session.disconnect();
                }
                catch { }
                if (fd !== null) {
                    try {
                        fs.closeSync(fd);
                    }
                    catch { }
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
                };
            }
            const samplingInterval = typeof payload.samplingInterval === 'number' &&
                Number.isFinite(payload.samplingInterval) &&
                payload.samplingInterval > 0
                ? Math.floor(payload.samplingInterval)
                : 32768;
            const session = new inspector.Session();
            session.connect();
            await inspectorPost(session, 'HeapProfiler.enable');
            await inspectorPost(session, 'HeapProfiler.startSampling', {
                samplingInterval
            });
            activeHeapSampling = {
                session,
                startedAt: Date.now(),
                name: sanitizeProfileName(typeof payload.name === 'string' ? payload.name : undefined) || null,
                samplingInterval
            };
            return {
                success: true,
                pid: process.pid,
                startedAt: activeHeapSampling.startedAt,
                samplingInterval
            };
        }
        if (action === 'heapSamplingStop') {
            if (!activeHeapSampling) {
                return { success: false, error: 'Heap sampling is not active' };
            }
            const { session, startedAt, name } = activeHeapSampling;
            const result = await inspectorPost(session, 'HeapProfiler.stopSampling');
            const outputPath = await buildProfilerFilePath('heap-sampling', 'heapsampling.json', (typeof payload.name === 'string'
                ? sanitizeProfileName(payload.name)
                : '') ||
                name ||
                undefined);
            await fsPromises.writeFile(outputPath, JSON.stringify(result));
            try {
                session.disconnect();
            }
            catch { }
            activeHeapSampling = null;
            const profile = result.profile || {};
            const topSites = summarizeHeapSamplingProfile(profile);
            return {
                success: true,
                pid: process.pid,
                startedAt,
                endedAt: Date.now(),
                outputPath,
                topSites
            };
        }
        return { success: false, error: `Unsupported profiler action: ${action}` };
    };
    parentPort.postMessage({ type: 'ready' });
    /**
     * Sends stream data chunk to parent thread
     * @param id - Stream identifier
     * @param socketPath - Unix socket path
     * @param chunk - Data chunk
     * @internal
     */
    const sendStreamChunkFromWorker = (id, socketPath, chunk) => {
        const ab = new ArrayBuffer(chunk.byteLength);
        new Uint8Array(ab).set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        parentPort.postMessage({
            type: 'stream',
            id,
            socketPath,
            chunk: ab
        }, [ab]);
    };
    /**
     * Sends stream end signal to parent thread
     * @param id - Stream identifier
     * @param socketPath - Unix socket path
     * @internal
     */
    const sendStreamEndFromWorker = (id, socketPath) => {
        ;
        parentPort.postMessage({
            type: 'end',
            id,
            socketPath
        });
    };
    /**
     * Sends stream error to parent thread
     * @param id - Stream identifier
     * @param socketPath - Unix socket path
     * @param error - Error message or object
     * @internal
     */
    const sendStreamErrorFromWorker = (id, socketPath, error) => {
        ;
        parentPort.postMessage({
            type: 'error',
            id,
            socketPath,
            error: String(error || 'Unknown error')
        });
    };
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
    const handleLiveChat = async (id, socketPath, payload) => {
        const videoId = payload.videoId;
        const yt = nodelink.sources?.getSource('youtube');
        if (!yt?.liveChat)
            throw new Error('YouTube source or live chat not available in worker');
        activeChats.set(id, true);
        try {
            const chat = await yt.liveChat.getLiveChat(videoId);
            if (!chat)
                throw new Error('Could not initialize live chat');
            const pollLoop = async () => {
                while (activeChats.has(id)) {
                    try {
                        const result = await chat.poll();
                        if (!result)
                            break;
                        const { actions, timeoutMs } = result;
                        if (actions.length > 0 && activeChats.has(id)) {
                            utils.logger('debug', 'SourceWorker', `[${id}] Sending ${actions.length} actions for ${videoId}`);
                            parentPort.postMessage({
                                type: 'chatAction',
                                id,
                                socketPath,
                                data: { op: 'actions', actions }
                            });
                        }
                        await new Promise((resolve) => setTimeout(resolve, timeoutMs || 5000));
                    }
                    catch (e) {
                        const err = e;
                        utils.logger('error', 'SourceWorker', `[${id}] Polling exception for ${videoId}: ${err.message}`);
                        break;
                    }
                }
            };
            await pollLoop();
            parentPort.postMessage({ type: 'end', id, socketPath });
        }
        catch (e) {
            const err = e;
            sendStreamErrorFromWorker(id, socketPath, err.message);
        }
        finally {
            activeChats.delete(id);
        }
    };
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
    const handleLoadStream = async (id, socketPath, payload) => {
        let fetched = null;
        let pcmStream = null;
        let finished = false;
        const cleanup = () => {
            if (pcmStream && !pcmStream.destroyed)
                pcmStream.destroy();
            if (fetched?.stream && !fetched.stream.destroyed)
                fetched.stream.destroy();
        };
        const finish = (err) => {
            if (finished)
                return;
            finished = true;
            if (err) {
                const errMsg = typeof err === 'string' ? err : err.message;
                sendStreamErrorFromWorker(id, socketPath, errMsg);
            }
            else {
                sendStreamEndFromWorker(id, socketPath);
            }
            cleanup();
        };
        try {
            const trackInfo = payload?.decodedTrackInfo;
            if (!trackInfo) {
                throw new Error('Invalid encoded track');
            }
            const urlResult = await nodelink.sources?.getTrackUrl(trackInfo);
            if (!urlResult || urlResult.exception) {
                throw new Error(urlResult?.exception?.message || 'Failed to get track URL');
            }
            const sourceName = urlResult.newTrack?.info?.sourceName || trackInfo.sourceName;
            const isHls = urlResult.protocol === 'hls';
            const isSabr = urlResult.protocol === 'sabr';
            const isLocal = sourceName === 'local';
            if (urlResult.url && !isHls && !isLocal && !isSabr) {
                const resource = await createSeekeableAudioResource(id, urlResult.url, payload?.position || 0, undefined, nodelink, {}, {
                    streamInfo: urlResult,
                    loudnessNormalizer: nodelink.options.audio?.loudnessNormalizer
                }, (payload?.volume ?? 100) / 100, null, true);
                if ('exception' in resource) {
                    throw new Error(resource.exception.message);
                }
                pcmStream = resource.stream;
            }
            else {
                const additionalData = {
                    ...(urlResult.additionalData || {}),
                    startTime: payload?.position || 0,
                    position: payload?.position || 0
                };
                fetched =
                    (await nodelink.sources?.getTrackStream(urlResult.newTrack?.info || trackInfo, urlResult.url, urlResult.protocol, additionalData)) || null;
                if (!fetched || fetched.exception) {
                    throw new Error(fetched?.exception?.message || 'Failed to load stream');
                }
                pcmStream = createPCMStream(id, fetched.stream, fetched.type || urlResult.format || 'unknown', nodelink, (payload?.volume ?? 100) / 100, payload?.filters || {});
            }
            pcmStream.on('data', (chunk) => {
                if (!finished)
                    sendStreamChunkFromWorker(id, socketPath, chunk);
            });
            pcmStream.once('end', () => finish());
            pcmStream.once('error', (err) => finish(err));
            pcmStream.once('close', () => finish());
        }
        catch (err) {
            finish(err);
        }
    };
    parentPort.on('message', async (taskData) => {
        nodelink.pluginManager?.callHook('onIPCMessage', taskData);
        const { id, task, payload, socketPath } = taskData;
        if (task === 'loadStream') {
            try {
                await handleLoadStream(id, socketPath, payload);
            }
            catch (e) {
                const err = e;
                sendStreamErrorFromWorker(id, socketPath, err.message || err);
            }
            return;
        }
        if (task === 'loadLiveChat') {
            try {
                await handleLiveChat(id, socketPath, payload);
            }
            catch (e) {
                const err = e;
                sendStreamErrorFromWorker(id, socketPath, err.message || err);
            }
            return;
        }
        if (task === 'cancelLiveChat') {
            activeChats.delete(payload.id);
            return;
        }
        try {
            let result;
            switch (task) {
                case 'resolve':
                    result = await nodelink.sources?.resolve(payload.url);
                    break;
                case 'search':
                    result = await nodelink.sources?.search(payload.source, payload.query);
                    break;
                case 'unifiedSearch':
                    result = await nodelink.sources?.unifiedSearch(payload.query);
                    break;
                case 'loadLyrics': {
                    const lyrics = await getLyricsManager();
                    result = await lyrics.loadLyrics({
                        info: payload
                            .decodedTrackInfo
                    }, payload.language);
                    break;
                }
                case 'loadMeaning': {
                    const meanings = await getMeaningManager();
                    result = await meanings.loadMeaning({
                        info: payload
                            .decodedTrackInfo
                    }, payload.language);
                    break;
                }
                case 'loadChapters':
                    result = await nodelink.sources?.getChapters({
                        info: payload.decodedTrackInfo
                    });
                    break;
                case 'profilerCommand':
                    result = await handleProfilerCommand(payload || {});
                    break;
            }
            ;
            parentPort.postMessage({
                type: 'result',
                id,
                socketPath,
                result: JSON.stringify(result)
            });
        }
        catch (e) {
            const err = e;
            parentPort.postMessage({
                type: 'result',
                id,
                socketPath,
                error: err.message
            });
        }
    });
}
