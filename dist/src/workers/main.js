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
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import v8 from 'node:v8';
import { GatewayEvents } from '../constants.js';
import ConnectionManager from '../managers/connectionManager.js';
import CredentialManager from '../managers/credentialManager.js';
import PluginManager from '../managers/pluginManager.js';
import RoutePlannerManager from '../managers/routePlannerManager.js';
import SourceManager from '../managers/sourceManager.js';
import StatsManager from '../managers/statsManager.js';
import TrackCacheManager from '../managers/trackCacheManager.js';
import { migrateConfig } from '../modules/config/configMigration.js';
import { getWebmOpusProfilerStats } from '../playback/demuxers/WebmOpus.js';
import { bufferPool } from '../playback/structs/BufferPool.js';
import { applyEnvOverrides, cleanupHttpAgents, initLogger, logger } from '../utils.js';
import { createVoiceRelay } from '../voice/voiceRelay.js';
import { createHeadQueue, dequeueHeadQueue, enqueueHeadQueue, getHeadQueueLength } from './headQueue.js';
let playerClassPromise = null;
let createPCMStreamPromise = null;
const getPlayerClass = async () => {
    if (!playerClassPromise) {
        playerClassPromise = import('../playback/player.js').then((module) => module.Player);
    }
    return playerClassPromise;
};
const getCreatePCMStream = async () => {
    if (!createPCMStreamPromise) {
        createPCMStreamPromise = import('../playback/processing/streamProcessor.js').then((module) => module.createPCMStream);
    }
    return createPCMStreamPromise;
};
let lastCpuUsage = process.cpuUsage();
let lastCpuTime = Date.now();
let lastActivityTime = Date.now();
let isHibernating = false;
let playerUpdateTimer = null;
let statsUpdateTimer = null;
const getErrorMessage = (error) => error instanceof Error ? error.message : String(error);
const hndl = monitorEventLoopDelay({ resolution: 10 });
hndl.enable();
try {
    os.setPriority(os.constants.priority.PRIORITY_HIGH);
}
catch (_e) { }
let config;
const resolveRootConfigUrl = (fileName) => pathToFileURL(resolvePath(process.cwd(), fileName)).href;
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
const loadConfig = async () => {
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
};
config = await loadConfig();
applyEnvOverrides(config);
const HIBERNATION_ENABLED = config.cluster?.hibernation?.enabled !== false;
const HIBERNATION_TIMEOUT = config.cluster?.hibernation?.timeoutMs || 20 * 60 * 1000;
const logging = config.logging;
initLogger({ logging });
const players = new Map();
const guildQueues = new Map();
const activeStreams = new Map();
const streamLifecycle = {
    created: 0,
    ended: 0,
    errored: 0,
    cancelled: 0,
    cleaned: 0
};
const PARALLEL_COMMANDS = new Set([
    'loadTracks',
    'loadLyrics',
    'loadMeaning',
    'loadChapters',
    'getSources',
    'getTrackUrl',
    'loadStream',
    'cancelStream',
    'updateYoutubeConfig',
    'profilerCommand'
]);
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
    if (!getter._getActiveHandles)
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
const getHostFromUrl = (value) => {
    if (!value || typeof value !== 'string')
        return null;
    try {
        return new URL(value).host || null;
    }
    catch {
        return null;
    }
};
const inferSourceName = (sourceName, uri) => {
    if (sourceName && sourceName.length > 0)
        return sourceName;
    const host = getHostFromUrl(uri);
    if (!host)
        return sourceName;
    const h = host.toLowerCase();
    if (h.includes('youtube') || h.includes('youtu.be'))
        return 'youtube';
    if (h.includes('spotify'))
        return 'spotify';
    if (h.includes('soundcloud'))
        return 'soundcloud';
    if (h.includes('googlevideo'))
        return 'youtube-cdn';
    if (h.includes('discord'))
        return 'discord';
    return `http:${h}`;
};
const getCodecAndContainer = (format) => {
    if (!format)
        return { codec: null, container: null, formatLabel: null };
    if (typeof format === 'string') {
        const raw = format.trim();
        if (!raw)
            return { codec: null, container: null, formatLabel: null };
        const parts = raw.split('/');
        if (parts.length >= 2) {
            return {
                codec: parts[1] || null,
                container: parts[0] || null,
                formatLabel: raw
            };
        }
        return { codec: null, container: raw, formatLabel: raw };
    }
    if (typeof format !== 'object') {
        return { codec: null, container: null, formatLabel: null };
    }
    const info = format;
    const mimeType = typeof info.mimeType === 'string'
        ? info.mimeType
        : typeof info.type === 'string'
            ? info.type
            : null;
    let codec = typeof info.codecs === 'string'
        ? info.codecs
        : typeof info.codec === 'string'
            ? info.codec
            : null;
    let container = typeof info.container === 'string'
        ? info.container
        : typeof info.ext === 'string'
            ? info.ext
            : null;
    if (mimeType) {
        const [kind, rest] = mimeType.split(';', 2);
        if (!container && kind?.includes('/')) {
            container = kind.split('/')[1] || null;
        }
        if (!codec && rest) {
            const m = /codecs?="?([^";]+)"?/i.exec(rest);
            if (m?.[1])
                codec = m[1];
        }
    }
    const formatLabel = mimeType ||
        (typeof info.format === 'string' ? info.format : null) ||
        (typeof info.label === 'string' ? info.label : null) ||
        container;
    return {
        codec: codec || null,
        container: container || null,
        formatLabel: formatLabel || null
    };
};
const profilerBaseDir = process.env.NODELINK_PROFILER_DIR || '.profiles';
let activeCpuProfiler = null;
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
    return `${profilerBaseDir}/worker-${process.pid}-${kind}-${stamp}${suffix}.${extension}`;
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
    if (!action) {
        return { success: false, error: 'Missing profiler action' };
    }
    if (action === 'status') {
        const playersSummary = Array.from(players.values()).map((player) => {
            const track = player.track;
            const internal = player;
            const uri = track?.info?.uri || null;
            const inferredSource = inferSourceName(track?.info?.sourceName || null, uri);
            const streamProtocol = internal.streamInfo?.protocol || null;
            const formatInfo = getCodecAndContainer(internal.streamInfo?.format);
            const durationMsRaw = typeof track?.endTime === 'number' &&
                Number.isFinite(track.endTime) &&
                track.endTime > 0
                ? track.endTime
                : typeof track?.info?.length === 'number' &&
                    Number.isFinite(track.info.length)
                    ? track.info.length
                    : 0;
            const positionMsRaw = internal._realPosition?.() ?? (internal.position || 0);
            const durationMs = Math.max(0, Number(durationMsRaw) || 0);
            const positionMs = Math.max(0, Number(positionMsRaw) || 0);
            const clampedPosition = durationMs > 0 ? Math.min(positionMs, durationMs) : positionMs;
            const remainingMs = durationMs > 0 ? Math.max(0, durationMs - clampedPosition) : null;
            const progressPercent = durationMs > 0
                ? Number(((clampedPosition / durationMs) * 100).toFixed(2))
                : null;
            const contentLengthRaw = internal.streamInfo?.additionalData?.contentLength;
            const contentLength = Number(contentLengthRaw);
            const totalBytes = Number.isFinite(contentLength) && contentLength > 0
                ? contentLength
                : null;
            const downloadedRaw = Number(player?.profilerStreamStats?.downloadedBytes || 0);
            const seekOffsetBytes = totalBytes && durationMs > 0
                ? Math.max(0, Math.min(totalBytes, (totalBytes *
                    Number(internal.streamInfo?.additionalData?.startTime || 0)) /
                    durationMs))
                : 0;
            const decodedBytes = totalBytes && durationMs > 0
                ? Math.max(0, Math.min(totalBytes, (totalBytes * clampedPosition) / durationMs))
                : null;
            const downloadedBytes = totalBytes
                ? Math.max(decodedBytes || 0, Math.min(totalBytes, downloadedRaw + seekOffsetBytes))
                : null;
            const missingBytes = totalBytes && downloadedBytes !== null
                ? Math.max(0, totalBytes - downloadedBytes)
                : null;
            const hasTrack = !!track?.info;
            const status = !hasTrack
                ? 'idle'
                : player.isPaused
                    ? 'paused'
                    : internal.connStatus === 'connected'
                        ? 'working'
                        : internal.connStatus || 'connecting';
            return {
                guildId: player.guildId,
                isPaused: !!player.isPaused,
                status,
                sourceName: inferredSource,
                title: track?.info?.title || null,
                author: track?.info?.author || null,
                artworkUrl: track?.info?.artworkUrl || null,
                uri,
                uriHost: getHostFromUrl(uri),
                protocol: streamProtocol ||
                    (uri?.startsWith('https://')
                        ? 'https'
                        : uri?.startsWith('http://')
                            ? 'http'
                            : null),
                format: internal.streamInfo?.format || null,
                formatLabel: formatInfo.formatLabel,
                codec: formatInfo.codec,
                container: formatInfo.container,
                isStream: !!track?.info?.isStream,
                isSeekable: track?.info?.isSeekable !== false,
                streamUrlHost: getHostFromUrl(internal.streamInfo?.url ||
                    internal.streamInfo?.hlsUrl ||
                    null),
                position: clampedPosition,
                duration: durationMs,
                remaining: remainingMs,
                progressPercent,
                streamBytesTotal: totalBytes,
                streamBytesDownloaded: downloadedBytes,
                streamBytesDecoded: decodedBytes,
                streamBytesMissing: missingBytes,
                ping: Number(internal.connection?.ping || 0)
            };
        });
        let queuedCommands = 0;
        for (const entry of guildQueues.values()) {
            queuedCommands += getHeadQueueLength(entry.queue);
        }
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
        const statsDebug = nodelink.statsManager &&
            typeof nodelink.statsManager.getSnapshot === 'function'
            ? nodelink.statsManager.getSnapshot()
            : null;
        const connectionDebug = nodelink.connectionManager
            ? {
                status: nodelink.connectionManager
                    .status ?? null,
                isChecking: nodelink.connectionManager
                    .isChecking ?? null,
                hasInterval: !!nodelink.connectionManager.interval
            }
            : null;
        const pluginDebug = nodelink.pluginManager
            ? {
                loadedPlugins: nodelink.pluginManager
                    .loadedPlugins ?? null
            }
            : null;
        const extensionsDebug = {
            workerInterceptors: nodelink.extensions?.workerInterceptors?.length ?? 0,
            audioInterceptors: nodelink.extensions?.audioInterceptors?.length ?? 0,
            customFilters: nodelink.extensions?.filters?.size ?? 0,
            customFilterNames: nodelink.extensions?.filters
                ? Array.from(nodelink.extensions.filters.keys())
                : []
        };
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
            cpuProfiling: !!activeCpuProfiler,
            cpuStartedAt: activeCpuProfiler?.startedAt || null,
            heapSamplingActive: !!activeHeapSampling,
            heapSamplingStartedAt: activeHeapSampling?.startedAt || null,
            profileDir: profilerBaseDir,
            memory: process.memoryUsage(),
            heapSpaces: getHeapSpaces(),
            uptimeSec: Math.floor(process.uptime()),
            eventLoop: {
                minMs: Number((hndl.min / 1e6).toFixed(3)),
                maxMs: Number((hndl.max / 1e6).toFixed(3)),
                meanMs: Number((hndl.mean / 1e6).toFixed(3)),
                stddevMs: Number((hndl.stddev / 1e6).toFixed(3))
            },
            activeResources: getActiveResourcesBreakdown(),
            activeHandles: getActiveHandlesBreakdown(),
            workersContext: {
                playersCount: players.size,
                playersSummary,
                queuesCount: guildQueues.size,
                queuedCommands,
                activeStreams: activeStreams.size,
                isHibernating,
                streamLifecycle,
                mapSizes: {
                    players: players.size,
                    guildQueues: guildQueues.size,
                    activeStreams: activeStreams.size
                },
                bufferPool: bufferPool.getStats?.() ?? null,
                demuxers: {
                    webmOpus: getWebmOpusProfilerStats()
                }
            },
            debugInternals: {
                sourceManager: sourceManagerDebug,
                trackCache: trackCacheDebug,
                credentials: credentialDebug,
                stats: statsDebug,
                connection: connectionDebug,
                plugins: pluginDebug,
                extensions: extensionsDebug,
                httpAgents: httpAgentsDebug,
                ipcTracker: ipcMessageTracker.getStats()
            }
        };
    }
    if (action === 'openInspector') {
        const host = typeof payload.host === 'string' ? payload.host : '127.0.0.1';
        const port = typeof payload.port === 'number' && Number.isInteger(payload.port)
            ? payload.port
            : 0;
        const wait = payload.exposeWait === true;
        inspector.open(port, host, wait);
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
        const memory = process.memoryUsage();
        return {
            success: true,
            pid: process.pid,
            memory
        };
    }
    if (action === 'cpuStart') {
        if (activeCpuProfiler) {
            return {
                success: true,
                alreadyActive: true,
                pid: process.pid,
                startedAt: activeCpuProfiler.startedAt
            };
        }
        const session = new inspector.Session();
        session.connect();
        await inspectorPost(session, 'Profiler.enable');
        await inspectorPost(session, 'Profiler.start');
        activeCpuProfiler = {
            session,
            startedAt: Date.now(),
            name: sanitizeProfileName(payload.name) || null
        };
        return {
            success: true,
            pid: process.pid,
            startedAt: activeCpuProfiler.startedAt
        };
    }
    if (action === 'cpuStop') {
        if (!activeCpuProfiler) {
            return { success: false, error: 'CPU profiler is not active' };
        }
        const { session, startedAt, name } = activeCpuProfiler;
        const result = await inspectorPost(session, 'Profiler.stop');
        const outputPath = await buildProfilerFilePath('cpu', 'cpuprofile', sanitizeProfileName(payload.name) || name || undefined);
        const profile = result.profile;
        await fsPromises.writeFile(outputPath, JSON.stringify(profile));
        try {
            session.disconnect();
        }
        catch { }
        activeCpuProfiler = null;
        return {
            success: true,
            pid: process.pid,
            startedAt,
            endedAt: Date.now(),
            outputPath
        };
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
            name: sanitizeProfileName(payload.name) || null,
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
        const outputPath = await buildProfilerFilePath('heap-sampling', 'heapsampling.json', sanitizeProfileName(payload.name) || name || undefined);
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
    if (action === 'heapSnapshot') {
        const outputPath = await buildProfilerFilePath('heap', 'heapsnapshot', payload.name);
        const session = new inspector.Session();
        let fd = null;
        try {
            fd = fs.openSync(outputPath, 'w');
            session.connect();
            session.on('HeapProfiler.addHeapSnapshotChunk', (message) => {
                const chunk = message?.params?.chunk;
                if (typeof chunk === 'string' && fd !== null) {
                    fs.writeSync(fd, chunk);
                }
            });
            await inspectorPost(session, 'HeapProfiler.enable');
            await inspectorPost(session, 'HeapProfiler.takeHeapSnapshot', {
                reportProgress: false
            });
            return {
                success: true,
                pid: process.pid,
                outputPath
            };
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
    return { success: false, error: `Unsupported profiler action: ${action}` };
};
const ipcMessageTracker = {
    sent: new Map(),
    received: new Map(),
    enabled: true,
    trackSent(type, payload) {
        if (!this.enabled)
            return;
        try {
            const size = Buffer.byteLength(JSON.stringify(payload));
            const entry = this.sent.get(type) || {
                count: 0,
                totalBytes: 0,
                maxBytes: 0
            };
            entry.count++;
            entry.totalBytes += size;
            entry.maxBytes = Math.max(entry.maxBytes, size);
            this.sent.set(type, entry);
        }
        catch { }
    },
    trackReceived(type, payload) {
        if (!this.enabled)
            return;
        try {
            const size = Buffer.byteLength(JSON.stringify(payload));
            const entry = this.received.get(type) || {
                count: 0,
                totalBytes: 0,
                maxBytes: 0
            };
            entry.count++;
            entry.totalBytes += size;
            entry.maxBytes = Math.max(entry.maxBytes, size);
            this.received.set(type, entry);
        }
        catch { }
    },
    getStats() {
        const toSorted = (map) => Array.from(map.entries())
            .map(([type, data]) => ({
            type,
            count: data.count,
            totalBytes: data.totalBytes,
            maxBytes: data.maxBytes,
            avgBytes: Math.round(data.totalBytes / Math.max(data.count, 1))
        }))
            .sort((a, b) => b.totalBytes - a.totalBytes);
        return {
            sent: toSorted(this.sent),
            received: toSorted(this.received)
        };
    }
};
const sendProcessMessage = (payload, onError) => {
    if (typeof process.send !== 'function')
        return false;
    try {
        const msg = payload;
        if (msg?.type)
            ipcMessageTracker.trackSent(msg.type, payload);
        return process.send(payload) ?? false;
    }
    catch (error) {
        onError?.(error);
        return false;
    }
};
const { EVENT_SOCKET_PATH, COMMAND_SOCKET_PATH, WORKER_CLUSTER_ID } = process.env;
let WORKER_CLUSTER_ID_OVERRIDE = '';
let eventSocket = null;
let eventSocketPath = EVENT_SOCKET_PATH;
let eventReconnectTimer = null;
let eventReconnectScheduled = false;
let commandSocket = null;
let commandSocketPath = COMMAND_SOCKET_PATH;
let commandReconnectTimer = null;
let commandReconnectScheduled = false;
let suppressSocketNotifyUntil = 0;
const clearReconnectTimer = (kind) => {
    if (kind === 'event') {
        if (eventReconnectTimer)
            clearTimeout(eventReconnectTimer);
        eventReconnectTimer = null;
        eventReconnectScheduled = false;
        return;
    }
    if (commandReconnectTimer)
        clearTimeout(commandReconnectTimer);
    commandReconnectTimer = null;
    commandReconnectScheduled = false;
};
const scheduleReconnect = (kind) => {
    if (kind === 'event') {
        if (eventReconnectScheduled || !eventSocketPath)
            return;
        eventReconnectScheduled = true;
        eventReconnectTimer = setTimeout(() => {
            clearReconnectTimer('event');
            connectEventSocket();
        }, 1000);
        return;
    }
    if (commandReconnectScheduled || !commandSocketPath)
        return;
    commandReconnectScheduled = true;
    commandReconnectTimer = setTimeout(() => {
        clearReconnectTimer('command');
        connectCommandSocket();
    }, 1000);
};
const notifySocketDisconnected = (socketType) => {
    if (!process.connected)
        return;
    if (Date.now() < suppressSocketNotifyUntil)
        return;
    sendProcessMessage({
        type: 'workerSocketDisconnected',
        socketType,
        pid: process.pid
    }, () => { });
};
const handleSocketDisconnect = (socketType, socket) => {
    if (socketType === 'event') {
        if (eventSocket === socket)
            eventSocket = null;
    }
    else if (commandSocket === socket) {
        commandSocket = null;
    }
    notifySocketDisconnected(socketType);
    scheduleReconnect(socketType);
};
const sendEventHello = () => {
    if (!eventSocket || eventSocket.destroyed)
        return false;
    const payload = v8.serialize({ pid: process.pid });
    const header = Buffer.alloc(6);
    header.writeUInt8(0, 0);
    header.writeUInt8(0, 1);
    header.writeUInt32BE(payload.length, 2);
    try {
        eventSocket.cork();
        const okHeader = eventSocket.write(header);
        const okPayload = eventSocket.write(payload);
        eventSocket.uncork();
        return okHeader && okPayload;
    }
    catch {
        return false;
    }
};
const connectEventSocket = () => {
    if (!eventSocketPath)
        return;
    const socket = net.createConnection(eventSocketPath, () => {
        eventSocket = socket;
        clearReconnectTimer('event');
        sendEventHello();
        logger('info', 'Worker', 'Connected to Master event socket');
    });
    socket.on('error', () => {
        handleSocketDisconnect('event', socket);
    });
    socket.on('close', () => {
        handleSocketDisconnect('event', socket);
    });
};
const connectCommandSocket = () => {
    if (!commandSocketPath)
        return;
    const socket = net.createConnection(commandSocketPath, () => {
        commandSocket = socket;
        clearReconnectTimer('command');
        sendCommandHello();
        logger('info', 'Worker', 'Connected to Master command socket');
    });
    const frameChunks = [];
    let frameBytes = 0;
    const peekBytes = (count) => {
        const first = frameChunks[0];
        if (first && first.length >= count)
            return first.subarray(0, count);
        const out = Buffer.allocUnsafe(count);
        let offset = 0;
        for (const piece of frameChunks) {
            const take = Math.min(piece.length, count - offset);
            piece.copy(out, offset, 0, take);
            offset += take;
            if (offset >= count)
                break;
        }
        return out;
    };
    const readBytes = (count) => {
        const out = Buffer.allocUnsafe(count);
        let offset = 0;
        while (offset < count) {
            const piece = frameChunks[0];
            if (!piece)
                break;
            const take = Math.min(piece.length, count - offset);
            piece.copy(out, offset, 0, take);
            offset += take;
            if (take === piece.length)
                frameChunks.shift();
            else
                frameChunks[0] = piece.subarray(take);
        }
        frameBytes = Math.max(0, frameBytes - count);
        return out;
    };
    socket.on('data', (chunk) => {
        if (!chunk.length)
            return;
        frameChunks.push(chunk);
        frameBytes += chunk.length;
        while (frameBytes >= 6) {
            const header = peekBytes(6);
            const idSize = header.readUInt8(0);
            const type = header.readUInt8(1);
            const payloadSize = header.readUInt32BE(2);
            const totalSize = 6 + idSize + payloadSize;
            if (frameBytes < totalSize)
                break;
            const frame = readBytes(totalSize);
            const id = frame.toString('utf8', 6, 6 + idSize);
            const payload = frame.subarray(6 + idSize);
            if (type === 1) {
                try {
                    const data = v8.deserialize(payload);
                    enqueueCommand(data?.type, id, data?.payload);
                }
                catch (e) {
                    logger('error', 'Worker', `Command socket parse error: ${getErrorMessage(e)}`);
                }
            }
        }
    });
    socket.on('error', () => {
        handleSocketDisconnect('command', socket);
    });
    socket.on('close', () => {
        handleSocketDisconnect('command', socket);
    });
};
if (eventSocketPath)
    connectEventSocket();
if (commandSocketPath)
    connectCommandSocket();
/**
 * Send a V8-serialized event frame to the master process.
 */
function sendEventFrame(type, data) {
    if (!eventSocket || eventSocket.destroyed)
        return false;
    const payloadBuf = v8.serialize(data);
    const header = Buffer.alloc(6);
    header.writeUInt8(0, 0); // No ID needed for these events
    header.writeUInt8(type, 1);
    header.writeUInt32BE(payloadBuf.length, 2);
    try {
        eventSocket.cork();
        const okHeader = eventSocket.write(header);
        const okPayload = eventSocket.write(payloadBuf);
        eventSocket.uncork();
        return okHeader && okPayload;
    }
    catch {
        return false;
    }
}
/**
 * Send a binary event frame to the master process.
 */
function sendEventBinaryFrame(type, payloadBuf) {
    if (!eventSocket || eventSocket.destroyed)
        return false;
    const header = Buffer.alloc(6);
    header.writeUInt8(0, 0);
    header.writeUInt8(type, 1);
    header.writeUInt32BE(payloadBuf.length, 2);
    try {
        eventSocket.cork();
        const okHeader = eventSocket.write(header);
        const okPayload = eventSocket.write(payloadBuf);
        eventSocket.uncork();
        return okHeader && okPayload;
    }
    catch {
        return false;
    }
}
/**
 * Send a stream-scoped frame to the master process.
 */
function sendStreamFrame(streamId, type, payloadBuf) {
    if (!eventSocket || eventSocket.destroyed)
        return false;
    const idBuf = Buffer.from(streamId, 'utf8');
    const header = Buffer.alloc(6);
    header.writeUInt8(idBuf.length, 0);
    header.writeUInt8(type, 1);
    header.writeUInt32BE(payloadBuf.length, 2);
    try {
        eventSocket.cork();
        const okHeader = eventSocket.write(header);
        const okId = eventSocket.write(idBuf);
        const okPayload = eventSocket.write(payloadBuf);
        eventSocket.uncork();
        return okHeader && okId && okPayload;
    }
    catch {
        return false;
    }
}
/**
 * Send a PCM chunk over the stream socket.
 */
function sendStreamChunk(streamId, chunk) {
    const payload = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    sendStreamFrame(streamId, 5, payload);
}
function sendStreamEnd(streamId) {
    sendStreamFrame(streamId, 6, Buffer.alloc(0));
}
function sendStreamError(streamId, error) {
    const payload = Buffer.from(String(error || 'Unknown error'), 'utf8');
    sendStreamFrame(streamId, 7, payload);
}
/**
 * Send a binary command frame to the master process.
 */
function sendCommandFrame(type, requestId, payloadBuf) {
    if (!commandSocket || commandSocket.destroyed)
        return false;
    const idBuf = Buffer.from(requestId || '', 'utf8');
    const header = Buffer.alloc(6);
    header.writeUInt8(idBuf.length, 0);
    header.writeUInt8(type, 1);
    header.writeUInt32BE(payloadBuf.length, 2);
    try {
        commandSocket.cork();
        const okHeader = commandSocket.write(header);
        const okId = commandSocket.write(idBuf);
        const okPayload = commandSocket.write(payloadBuf);
        commandSocket.uncork();
        return okHeader && okId && okPayload;
    }
    catch {
        return false;
    }
}
function sendCommandHello() {
    if (!commandSocket || commandSocket.destroyed)
        return false;
    const payload = v8.serialize({ pid: process.pid });
    return sendCommandFrame(0, '', payload);
}
function sendCommandResult(requestId, payload) {
    const payloadBuf = v8.serialize(payload);
    if (sendCommandFrame(2, requestId, payloadBuf))
        return true;
    if (process.connected) {
        const sent = sendProcessMessage({ type: 'commandResult', requestId, payload }, (e) => {
            logger('error', 'Worker-IPC', `Failed to send commandResult for ${requestId}: ${getErrorMessage(e)}`);
        });
        if (sent)
            return true;
    }
    return false;
}
function sendCommandError(requestId, error) {
    const payloadBuf = v8.serialize(String(error || 'Unknown error'));
    if (sendCommandFrame(3, requestId, payloadBuf))
        return true;
    if (process.connected) {
        const sent = sendProcessMessage({ type: 'commandResult', requestId, error: String(error) }, (e) => {
            logger('error', 'Worker-IPC', `Failed to send commandResult (error) for ${requestId}: ${getErrorMessage(e)}`);
        });
        if (sent)
            return true;
    }
    return false;
}
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
const nodelink = {
    options: config,
    logger,
    voiceRelay: undefined,
    statsManager: null,
    credentialManager: null,
    trackCacheManager: null,
    sources: null,
    lyrics: null,
    meanings: null,
    routePlanner: null,
    connectionManager: null,
    pluginManager: null,
    extensions: {
        workerInterceptors: [],
        audioInterceptors: []
    },
    registerWorkerInterceptor: (fn) => {
        nodelink.extensions.workerInterceptors.push(fn);
        logger('info', 'Worker', 'Registered worker command interceptor');
    },
    registerSource: (name, source) => {
        if (!nodelink.sources) {
            logger('warn', 'Worker', 'Cannot register source (sources manager not ready).');
            return;
        }
        nodelink.sources.sources.set(name, source);
        logger('info', 'Worker', `Registered custom source: ${name}`);
    },
    registerFilter: (name, filter) => {
        if (!nodelink.extensions.filters)
            nodelink.extensions.filters = new Map();
        nodelink.extensions.filters.set(name, filter);
        logger('info', 'Worker', `Registered custom filter: ${name}`);
    },
    registerAudioInterceptor: (interceptor) => {
        if (!nodelink.extensions.audioInterceptors)
            nodelink.extensions.audioInterceptors = [];
        nodelink.extensions.audioInterceptors.push(interceptor);
        logger('info', 'Worker', 'Registered custom audio interceptor');
    },
    getLyricsManager,
    getMeaningManager
};
const createdVoiceRelay = createVoiceRelay({
    enabled: config.playback.voiceReceive?.enabled,
    format: config.playback.voiceReceive?.format,
    sendFrame: (frame) => sendEventBinaryFrame(8, frame),
    logger
});
if (createdVoiceRelay) {
    nodelink.voiceRelay = createdVoiceRelay;
}
nodelink.statsManager = new StatsManager(nodelink);
nodelink.credentialManager = new CredentialManager(nodelink);
nodelink.trackCacheManager = new TrackCacheManager(nodelink);
await nodelink.trackCacheManager.load();
nodelink.sources = new SourceManager(nodelink);
nodelink.routePlanner = new RoutePlannerManager(nodelink);
nodelink.connectionManager = new ConnectionManager(nodelink);
nodelink.pluginManager = new PluginManager(nodelink);
function setEfficiencyMode(enabled) {
    try {
        os.setPriority(process.pid, enabled
            ? os.constants.priority.PRIORITY_LOW
            : os.constants.priority.PRIORITY_HIGH);
        if (enabled) {
            v8.setFlagsFromString('--optimize-for-size');
        }
        else {
            v8.setFlagsFromString('--no-optimize-for-size');
        }
    }
    catch (_e) { }
}
function startTimers(hibernating = false) {
    if (playerUpdateTimer)
        clearInterval(playerUpdateTimer);
    if (statsUpdateTimer)
        clearInterval(statsUpdateTimer);
    const updateInterval = hibernating
        ? 60000
        : (config?.playback.playerUpdateInterval ?? 5000);
    const statsInterval = hibernating
        ? 120000
        : config?.api.metrics?.enabled
            ? 5000
            : (config?.playback.statsUpdateInterval ?? 30000);
    const zombieThreshold = config?.playback.zombieThresholdMs ?? 60000;
    playerUpdateTimer = setInterval(() => {
        if (!process.connected)
            return;
        for (const player of players.values()) {
            if (player?.track && !player.isPaused && player.connection) {
                if (player.connStatus === 'connected' &&
                    player._lastStreamDataTime &&
                    player._lastStreamDataTime > 0 &&
                    Date.now() - player._lastStreamDataTime >= zombieThreshold) {
                    logger('warn', 'Player', `Player for guild ${player.guildId} detected as zombie (no stream data).`);
                    player.emitEvent(GatewayEvents.TRACK_STUCK, {
                        guildId: player.guildId,
                        track: player.track,
                        reason: 'no_stream_data',
                        thresholdMs: zombieThreshold
                    });
                }
                try {
                    player._sendUpdate();
                }
                catch (updateError) {
                    logger('error', 'Worker', `Error during player update for guild ${player.guildId}: ${getErrorMessage(updateError)}`, updateError);
                }
            }
        }
    }, updateInterval);
    statsUpdateTimer = setInterval(() => {
        if (!process.connected)
            return;
        let localPlayers = 0;
        let localPlayingPlayers = 0;
        const localFrameStats = { sent: 0, nulled: 0, deficit: 0, expected: 0 };
        for (const player of players.values()) {
            localPlayers++;
            if (!player.isPaused && player.track) {
                localPlayingPlayers++;
            }
            if (player?.track && !player.isPaused && player.connection) {
                if (player.connection.statistics) {
                    const stats = player.connection.statistics;
                    localFrameStats.sent += stats?.packetsSent ?? 0;
                    localFrameStats.nulled += stats?.packetsLost ?? 0;
                    localFrameStats.expected += stats?.packetsExpected ?? 0;
                }
            }
        }
        localFrameStats.deficit += Math.max(0, localFrameStats.expected - localFrameStats.sent);
        if (localPlayers === 0 && HIBERNATION_ENABLED) {
            if (!isHibernating &&
                Date.now() - lastActivityTime > HIBERNATION_TIMEOUT) {
                logger('info', 'Worker', 'Worker entering hibernation mode (Efficiency Mode).');
                isHibernating = true;
                bufferPool.clear();
                cleanupHttpAgents();
                nodelink.connectionManager.stop();
                setEfficiencyMode(true);
                startTimers(true);
                const gcFn = global.gc;
                if (gcFn) {
                    let cycles = 0;
                    const aggressiveGC = setInterval(() => {
                        try {
                            gcFn();
                            cycles++;
                            if (cycles >= 3)
                                clearInterval(aggressiveGC);
                        }
                        catch (_e) {
                            clearInterval(aggressiveGC);
                        }
                    }, 1000);
                }
            }
        }
        else {
            lastActivityTime = Date.now();
            if (isHibernating) {
                isHibernating = false;
                setEfficiencyMode(false);
                nodelink.connectionManager.start();
                startTimers(false);
            }
        }
        try {
            const now = Date.now();
            const elapsedMs = now - lastCpuTime;
            const cpuUsage = process.cpuUsage(lastCpuUsage);
            lastCpuTime = now;
            lastCpuUsage = process.cpuUsage();
            const nodelinkLoad = elapsedMs > 0 ? (cpuUsage.user + cpuUsage.system) / 1000 / elapsedMs : 0;
            const mem = process.memoryUsage();
            const resolvedClusterId = WORKER_CLUSTER_ID_OVERRIDE || WORKER_CLUSTER_ID;
            const eluP50 = hndl.percentile(50) / 1e6;
            const eluP95 = hndl.percentile(95) / 1e6;
            const eluP99 = hndl.percentile(99) / 1e6;
            let totalStuckRecoveries = 0;
            for (const player of players.values()) {
                const count = player
                    .stuckRecoveryCount;
                if (typeof count === 'number') {
                    totalStuckRecoveries += count;
                    player.stuckRecoveryCount = 0;
                }
            }
            const stats = {
                workerId: resolvedClusterId ? parseInt(resolvedClusterId, 10) : 0,
                isHibernating,
                players: localPlayers,
                playingPlayers: localPlayingPlayers,
                commandQueueLength: Array.from(guildQueues.values()).reduce((acc, curr) => acc + getHeadQueueLength(curr.queue), 0),
                cpu: { nodelinkLoad },
                eventLoopLag: eluP50,
                eventLoopLagP95: eluP95,
                eventLoopLagP99: eluP99,
                memory: {
                    used: mem.heapUsed,
                    allocated: mem.heapTotal
                },
                frameStats: localFrameStats,
                stuckRecoveries: totalStuckRecoveries
            };
            if (eventSocket && !eventSocket.destroyed) {
                sendEventFrame(4, stats);
            }
            else if (process.connected) {
                const success = sendProcessMessage({
                    type: 'workerStats',
                    pid: process.pid,
                    stats
                });
                if (!success) {
                    logger('warn', 'Worker-IPC', 'IPC channel saturated, skipping non-critical workerStats update.');
                }
            }
        }
        catch (e) {
            if (process.connected) {
                logger('error', 'Worker-IPC', `Failed to send workerStats: ${getErrorMessage(e)}`);
            }
        }
    }, statsInterval);
}
async function initialize() {
    await nodelink.credentialManager.load();
    await nodelink.sources.loadFolder();
    await nodelink.statsManager.initialize();
    await nodelink.pluginManager.load('voice-worker');
    lastActivityTime = Date.now();
    logger('info', 'Worker', `Worker process ${process.pid} started and initialized.`);
}
initialize();
startTimers(false);
process.on('uncaughtException', (err) => {
    const error = err;
    const isStreamAbort = error.message === 'aborted' ||
        error.code === 'ECONNRESET' ||
        error.code === 'ERR_STREAM_PREMATURE_CLOSE';
    if (isStreamAbort) {
        logger('debug', 'Worker', `Stream disconnected: ${error.message}`);
        return;
    }
    logger('error', 'Worker–Crash', `Uncaught Exception: ${error.stack || error.message}`);
    process.stderr.write('', () => process.exit(1));
});
process.on('unhandledRejection', (reason, promise) => {
    logger('error', 'Worker-Crash', `Unhandled Rejection at: ${promise}, reason: ${reason}`);
});
/**
 * Dispose of an active PCM stream entry and remove it from the registry.
 */
function cleanupActiveStream(streamId, entry) {
    const current = entry || activeStreams.get(streamId);
    if (!current)
        return;
    if (current.pcmStream && !current.pcmStream.destroyed) {
        current.pcmStream.destroy();
    }
    if (current.fetched?.stream && !current.fetched.stream.destroyed) {
        current.fetched.stream.destroy();
    }
    activeStreams.delete(streamId);
    streamLifecycle.cleaned++;
}
/**
 * Resolve and fetch a PCM stream, forwarding chunks through the event socket.
 */
async function startLoadStream(streamId, payload) {
    if (!eventSocket || eventSocket.destroyed) {
        throw new Error('Event socket unavailable');
    }
    const trackInfo = payload?.decodedTrackInfo;
    if (!trackInfo) {
        throw new Error('Invalid encoded track');
    }
    const urlResult = (await nodelink.sources.getTrackUrl(trackInfo));
    if (urlResult.exception) {
        throw new Error(urlResult.exception.message || 'Failed to get track URL');
    }
    const additionalData = {
        ...(urlResult.additionalData || {}),
        startTime: payload?.position || 0,
        position: payload?.position || 0
    };
    const fetched = (await nodelink.sources.getTrackStream(urlResult.newTrack?.info || trackInfo, urlResult.url, urlResult.protocol, additionalData));
    if (fetched.exception) {
        throw new Error(fetched.exception.message || 'Failed to load stream');
    }
    const createPCMStream = await getCreatePCMStream();
    const pcmStream = createPCMStream(payload?.guildId ?? 'worker-stream', fetched.stream, fetched.type || urlResult.format || 'unknown', nodelink, (payload?.volume ?? 100) / 100, payload?.filters || {});
    const entry = { pcmStream, fetched, cancelled: false };
    activeStreams.set(streamId, entry);
    streamLifecycle.created++;
    const finish = (err) => {
        if (entry.cancelled) {
            streamLifecycle.cancelled++;
            cleanupActiveStream(streamId, entry);
            return;
        }
        if (err) {
            streamLifecycle.errored++;
            sendStreamError(streamId, getErrorMessage(err));
        }
        else {
            streamLifecycle.ended++;
            sendStreamEnd(streamId);
        }
        cleanupActiveStream(streamId, entry);
    };
    pcmStream.on('data', (chunk) => {
        if (!entry.cancelled)
            sendStreamChunk(streamId, chunk);
    });
    pcmStream.once('end', () => finish());
    pcmStream.once('error', (err) => finish(err));
    pcmStream.once('close', () => finish());
}
function cancelStream(streamId) {
    const entry = activeStreams.get(streamId);
    if (!entry)
        return false;
    entry.cancelled = true;
    cleanupActiveStream(streamId, entry);
    return true;
}
/**
 * Process queued commands for a guild key sequentially.
 */
async function processQueue(queueKey) {
    const queueEntry = guildQueues.get(queueKey);
    if (!queueEntry || getHeadQueueLength(queueEntry.queue) === 0) {
        if (queueEntry) {
            queueEntry.processing = false;
            if (getHeadQueueLength(queueEntry.queue) === 0) {
                guildQueues.delete(queueKey);
            }
        }
        return;
    }
    queueEntry.processing = true;
    const queued = dequeueHeadQueue(queueEntry.queue);
    if (!queued) {
        queueEntry.processing = false;
        return;
    }
    const { type, requestId, payload } = queued;
    lastActivityTime = Date.now();
    if (isHibernating) {
        logger('info', 'Worker', 'Worker waking up from hibernation.');
        isHibernating = false;
        setEfficiencyMode(false);
        nodelink.connectionManager.start();
        startTimers(false);
    }
    const interceptors = nodelink.extensions.workerInterceptors;
    if (interceptors && interceptors.length > 0) {
        for (const interceptor of interceptors) {
            try {
                const shouldBlock = await interceptor(type, payload);
                if (shouldBlock === true) {
                    if (requestId)
                        sendCommandResult(requestId, { intercepted: true });
                    setImmediate(() => processQueue(queueKey));
                    return;
                }
            }
            catch (e) {
                logger('error', 'Worker', `Interceptor error: ${getErrorMessage(e)}`);
            }
        }
    }
    try {
        let result;
        switch (type) {
            case 'createPlayer': {
                const createPayload = payload;
                const { sessionId, guildId, userId, voice } = createPayload;
                if (!sessionId || !guildId || !userId) {
                    result = { created: false, reason: 'Invalid createPlayer payload' };
                    break;
                }
                const playerKey = `${sessionId}:${guildId}`;
                if (players.has(playerKey)) {
                    result = { created: false, reason: 'Player already exists' };
                    break;
                }
                const mockSession = {
                    id: sessionId,
                    userId,
                    isPaused: false,
                    eventQueue: [],
                    socket: {
                        send: (data) => {
                            if (eventSocket && !eventSocket.destroyed) {
                                sendEventFrame(3, { sessionId, guildId, data });
                            }
                            else if (process.connected) {
                                sendProcessMessage({
                                    type: 'playerEvent',
                                    payload: { sessionId, guildId, data }
                                }, (e) => {
                                    logger('error', 'Worker-IPC', `Failed to send playerEvent for guild ${guildId}: ${getErrorMessage(e)}`);
                                });
                            }
                        }
                    }
                };
                const PlayerClass = await getPlayerClass();
                const player = new PlayerClass({
                    nodelink: nodelink,
                    session: mockSession,
                    guildId
                });
                players.set(playerKey, player);
                if (voice)
                    player.updateVoice(voice);
                result = { created: true };
                break;
            }
            case 'destroyPlayer': {
                const { sessionId, guildId } = (payload ?? {});
                const playerKey = `${sessionId}:${guildId}`;
                const player = players.get(playerKey);
                if (player) {
                    player.destroy(false);
                    players.delete(playerKey);
                    if (process.connected) {
                        sendProcessMessage({
                            type: 'playerDestroyed',
                            payload: {
                                guildId,
                                userId: player.session?.userId,
                                sessionId
                            }
                        }, (e) => {
                            logger('error', 'Worker-IPC', `Failed to send playerDestroyed for guild ${guildId}: ${getErrorMessage(e)}`);
                        });
                    }
                    result = { destroyed: true };
                }
                else {
                    result = { destroyed: false, reason: 'Player not found in worker' };
                }
                break;
            }
            case 'restorePlayer': {
                const { snapshot } = (payload ?? {});
                if (!snapshot) {
                    result = { restored: false, reason: 'Missing snapshot payload' };
                    break;
                }
                const { guildId, sessionId, userId, track, position, isPaused, volume, filters, voice } = snapshot;
                const playerKey = `${sessionId}:${guildId}`;
                logger('info', 'Worker', `Restoring player for guild ${guildId} (session: ${sessionId}) (position: ${position}ms, paused: ${isPaused})`);
                const mockSession = {
                    id: sessionId,
                    userId,
                    isPaused: false,
                    eventQueue: [],
                    socket: {
                        send: (data) => {
                            if (eventSocket && !eventSocket.destroyed) {
                                sendEventFrame(3, { sessionId, guildId, data });
                            }
                            else if (process.connected) {
                                sendProcessMessage({
                                    type: 'playerEvent',
                                    payload: { sessionId, guildId, data }
                                }, (e) => {
                                    logger('error', 'Worker-IPC', `Failed to send playerEvent for guild ${guildId}: ${getErrorMessage(e)}`);
                                });
                            }
                        }
                    }
                };
                const PlayerClass = await getPlayerClass();
                const player = new PlayerClass({
                    nodelink: nodelink,
                    session: mockSession,
                    guildId
                });
                player._isRestoring = true;
                players.set(playerKey, player);
                if (voice)
                    player.updateVoice(voice);
                if (volume)
                    player.volume(volume);
                if (filters && Object.keys(filters).length > 0)
                    player.setFilters(filters);
                if (track) {
                    await player.play({ ...track, startTime: position });
                    if (isPaused) {
                        player.pause(true);
                    }
                }
                player._isRestoring = false;
                result = { restored: true };
                break;
            }
            case 'playerCommand': {
                const { sessionId, guildId, command, args } = (payload ?? {});
                const playerKey = `${sessionId}:${guildId}`;
                const player = players.get(playerKey);
                const target = player;
                const callable = target?.[command];
                if (player && callable instanceof Function) {
                    result = await callable.apply(player, args ?? []);
                }
                else if (command === 'forceUpdate' &&
                    player &&
                    player._sendUpdate) {
                    ;
                    player._sendUpdate();
                    result = { updated: true };
                }
                else {
                    result = {
                        error: `Player or command '${command}' not found for guild ${guildId} (session: ${sessionId})`,
                        playerNotFound: true
                    };
                }
                break;
            }
            case 'loadTracks': {
                const { identifier } = (payload ?? {});
                const re = /^(?:(?<url>(?:https?|ftts):\/\/\S+)|(?<source>[A-Za-z0-9]+):(?<query>[^/\s].*))$/i;
                const match = re.exec(identifier);
                if (!match)
                    throw new Error('Invalid identifier');
                const { url, source, query } = (match.groups ?? {});
                if (url)
                    result = await nodelink.sources.resolve(url);
                else if (source === 'search') {
                    if (!query)
                        throw new Error('Missing search query');
                    result = await nodelink.sources.unifiedSearch(query);
                }
                else {
                    if (!source || !query)
                        throw new Error('Missing source or query');
                    result = await nodelink.sources.search(source, query);
                }
                break;
            }
            case 'loadLyrics': {
                const { decodedTrackInfo, language } = (payload ?? {});
                const trackInfo = {
                    ...decodedTrackInfo,
                    artworkUrl: decodedTrackInfo.artworkUrl ?? null,
                    isrc: decodedTrackInfo.isrc ?? null,
                    uri: decodedTrackInfo.uri
                };
                const lyrics = await getLyricsManager();
                result = await lyrics.loadLyrics({ info: trackInfo }, language);
                break;
            }
            case 'loadMeaning': {
                const { decodedTrackInfo, language } = (payload ?? {});
                const trackInfo = {
                    ...decodedTrackInfo,
                    artworkUrl: decodedTrackInfo.artworkUrl ?? null,
                    isrc: decodedTrackInfo.isrc ?? null,
                    uri: decodedTrackInfo.uri
                };
                const meanings = await getMeaningManager();
                result = await meanings.loadMeaning({ info: trackInfo }, language);
                break;
            }
            case 'loadChapters': {
                const { decodedTrackInfo } = (payload ?? {});
                result = await nodelink.sources.getChapters({ info: decodedTrackInfo });
                break;
            }
            case 'getSources': {
                result = nodelink.sources.getEnabledSourceNames();
                break;
            }
            case 'getTrackUrl': {
                const { decodedTrackInfo, itag } = (payload ?? {});
                result = await nodelink.sources.getTrackUrl(decodedTrackInfo, itag);
                break;
            }
            case 'loadStream': {
                const streamId = (payload ?? {})?.streamId || requestId;
                try {
                    await startLoadStream(streamId, payload);
                    result = { streaming: true, streamId };
                }
                catch (e) {
                    const errorMessage = getErrorMessage(e);
                    sendStreamError(streamId, errorMessage);
                    result = { streaming: false, error: errorMessage };
                }
                break;
            }
            case 'cancelStream': {
                const streamId = (payload ?? {})?.streamId || requestId;
                result = { cancelled: cancelStream(streamId) };
                break;
            }
            case 'updateYoutubeConfig': {
                try {
                    const { refreshToken, visitorData } = (payload ?? {});
                    const youtube = nodelink.sources.sources.get('youtube');
                    if (!youtube) {
                        result = {
                            success: false,
                            reason: 'YouTube source not loaded on this worker'
                        };
                        break;
                    }
                    if (refreshToken) {
                        if (youtube.oauth) {
                            youtube.oauth.refreshToken = refreshToken;
                            youtube.oauth.accessToken = null;
                            youtube.oauth.tokenExpiry = 0;
                            logger('info', 'Worker', 'YouTube OAuth refresh token updated via API.');
                        }
                        else {
                            logger('warn', 'Worker', 'Cannot update refreshToken: youtube.oauth is undefined.');
                        }
                    }
                    if (visitorData) {
                        if (youtube.ytContext?.client) {
                            youtube.ytContext.client.visitorData = visitorData;
                            logger('info', 'Worker', 'YouTube visitorData updated via API.');
                        }
                        else {
                            logger('warn', 'Worker', 'Cannot update visitorData: youtube.ytContext.client is undefined.');
                        }
                    }
                    result = { success: true };
                }
                catch (err) {
                    logger('error', 'Worker', `Error updating YouTube config: ${getErrorMessage(err)}`);
                    result = { success: false, error: getErrorMessage(err) };
                }
                break;
            }
            case 'profilerCommand': {
                result = await handleProfilerCommand((payload ?? {}));
                break;
            }
            default:
                throw new Error(`Unknown command type: ${type}`);
        }
        if (requestId)
            sendCommandResult(requestId, result);
    }
    catch (e) {
        if (requestId)
            sendCommandError(requestId, getErrorMessage(e));
    }
    finally {
        const queueEntry = guildQueues.get(queueKey);
        if (queueEntry && getHeadQueueLength(queueEntry.queue) > 0) {
            setImmediate(() => processQueue(queueKey));
        }
        else {
            if (queueEntry) {
                queueEntry.processing = false;
                if (getHeadQueueLength(queueEntry.queue) === 0)
                    guildQueues.delete(queueKey);
            }
        }
    }
}
/**
 * Add a command to a guild queue and trigger processing.
 */
function enqueueCommand(type, requestId, payload) {
    if (!type || !requestId)
        return;
    const guildIdFromPayload = payload && typeof payload === 'object' && 'guildId' in payload
        ? payload.guildId || 'global'
        : 'global';
    const queueKey = PARALLEL_COMMANDS.has(type)
        ? `parallel:${requestId}`
        : guildIdFromPayload;
    if (!guildQueues.has(queueKey)) {
        guildQueues.set(queueKey, {
            queue: createHeadQueue(),
            processing: false
        });
    }
    const queueEntry = guildQueues.get(queueKey);
    if (queueEntry) {
        enqueueHeadQueue(queueEntry.queue, { type, requestId, payload });
    }
    if (!queueEntry?.processing)
        setImmediate(() => processQueue(queueKey));
}
process.on('message', (msg) => {
    nodelink.pluginManager?.callHook('onIPCMessage', msg);
    if (!msg || typeof msg !== 'object')
        return;
    const message = msg;
    if (message.type) {
        ipcMessageTracker.trackReceived(message.type, message);
    }
    if (message.type === 'clusterId') {
        WORKER_CLUSTER_ID_OVERRIDE = String(message.clusterId ?? '');
        return;
    }
    if (message.type === 'ping') {
        if (process.connected) {
            try {
                sendProcessMessage({ type: 'pong', timestamp: message.timestamp });
            }
            catch (e) {
                logger('error', 'Worker-IPC', `Failed to send pong: ${getErrorMessage(e)}`);
            }
        }
        return;
    }
    if (message.type === 'rotateSocketPaths') {
        suppressSocketNotifyUntil = Date.now() + 3000;
        const nextEventPath = typeof message.eventSocketPath ===
            'string'
            ? (message.eventSocketPath ?? null)
            : null;
        const nextCommandPath = typeof message.commandSocketPath ===
            'string'
            ? (message.commandSocketPath ??
                null)
            : null;
        if (nextEventPath) {
            eventSocketPath = nextEventPath;
            clearReconnectTimer('event');
            try {
                eventSocket?.destroy();
            }
            catch { }
            eventSocket = null;
            connectEventSocket();
        }
        if (nextCommandPath) {
            commandSocketPath = nextCommandPath;
            clearReconnectTimer('command');
            try {
                commandSocket?.destroy();
            }
            catch { }
            commandSocket = null;
            connectCommandSocket();
        }
        return;
    }
    if (!message.type || !message.requestId)
        return;
    enqueueCommand(message.type, message.requestId, message.payload);
});
setTimeout(() => {
    if (process.connected) {
        try {
            sendProcessMessage({ type: 'ready', pid: process.pid });
        }
        catch (e) {
            logger('error', 'Worker-IPC', `Failed to send ready: ${getErrorMessage(e)}`);
        }
    }
}, 1000);
