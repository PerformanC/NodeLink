import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { URL } from 'node:url';
import util from 'node:util';
import zlib from 'node:zlib';
import packageJson from '../package.json' with { type: 'json' };
import { DEFAULT_MAX_REDIRECTS, DISCORD_ID_REGEX, REDIRECT_STATUS_CODES, SEMVER_PATTERN } from './constants.js';
/**
 * Reference to the runtime NodeLink instance stored on the global object.
 *
 * This indirection keeps the utilities decoupled from the main bootstrap
 * logic while still allowing optional access to route planner and extensions.
 * @internal
 */
const runtime = globalThis;
/**
 * Indicates whether zstd compression support is available at runtime.
 *
 * Node.js adds `zstd` helpers in newer releases, so we feature-detect it
 * to avoid hard dependencies.
 * @internal
 */
const hasZstd = Boolean(zlib.createZstdDecompress);
const DEFAULT_MAX_RESPONSE_BODY_BYTES = 32 * 1024 * 1024;
let ProxyAgent = null;
let proxyAgentInitAttempted = false;
const getProxyAgent = async () => {
    if (proxyAgentInitAttempted)
        return ProxyAgent;
    proxyAgentInitAttempted = true;
    try {
        const mod = await import('proxy-agent');
        const candidate = mod.ProxyAgent ||
            mod.default?.ProxyAgent ||
            mod.default;
        ProxyAgent =
            candidate instanceof Function
                ? candidate
                : null;
    }
    catch {
        ProxyAgent = null;
    }
    return ProxyAgent;
};
const hasExplicitPort = (rawUrl) => {
    try {
        const url = new URL(rawUrl);
        if (url.port.length > 0)
            return true;
        return (rawUrl.match(/:(\d+)(?:\/|$)/)?.[1]?.length ?? 0) > 0;
    }
    catch {
        return false;
    }
};
const shouldUseReverseProxy = (proxy) => {
    if (!proxy)
        return false;
    if (proxy.type === 'reverse')
        return true;
    return (proxy.type === undefined &&
        !!proxy.url &&
        !proxy.username &&
        !proxy.password &&
        !hasExplicitPort(proxy.url));
};
/**
 * Numeric ordering for log levels.
 *
 * Lower numbers mean more verbose output.
 * @internal
 */
const logLevels = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3
};
let loggingConfig = {};
let currentLogLevel = logLevels.info;
let logStream = null;
let gitInfoCache = null;
let currentLogFile = null;
let logRotationInterval = null;
let logCleanupInterval = null;
/**
 * Builds the log file name used by file logging.
 *
 * The rotation strategy controls the filename pattern:
 * - `session`: unique timestamp + random suffix
 * - `hourly`: ISO date + hour
 * - `daily`: ISO date only
 *
 * @returns Log file name (without directory).
 * @internal
 */
function getLogFileName() {
    const now = new Date();
    const rotation = loggingConfig.file?.rotation || 'session';
    if (rotation === 'hourly') {
        const date = now.toISOString().slice(0, 13).replace(/[:.]/g, '-');
        return `nodelink-${date}.log`;
    }
    if (rotation === 'daily') {
        const date = now.toISOString().slice(0, 10);
        return `nodelink-${date}.log`;
    }
    const timestamp = now.toISOString().replace(/[:.]/g, '-');
    const randomId = crypto.randomBytes(4).toString('hex');
    return `nodelink-${timestamp}-${randomId}.log`;
}
/**
 * Deletes expired log files based on the configured TTL.
 *
 * Log files are identified using the `nodelink-*.log` naming pattern.
 * Failures are reported to stderr but do not crash the process.
 * @internal
 */
async function cleanOldLogs() {
    if (!loggingConfig.file?.enabled)
        return;
    const logDir = loggingConfig.file.path || 'logs';
    const ttlDays = loggingConfig.file.ttlDays || 7;
    const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    try {
        const fsPromises = await import('node:fs/promises');
        try {
            await fsPromises.access(logDir);
        }
        catch {
            return;
        }
        const files = await fsPromises.readdir(logDir);
        let cleanedCount = 0;
        for (const file of files) {
            if (!file.startsWith('nodelink-') || !file.endsWith('.log'))
                continue;
            const filePath = path.join(logDir, file);
            const stats = await fsPromises.stat(filePath);
            const fileAge = now - stats.mtimeMs;
            if (fileAge > ttlMs) {
                await fsPromises.unlink(filePath);
                cleanedCount++;
            }
        }
        if (cleanedCount > 0) {
            console.log(`[${new Date().toISOString().slice(11, 23)}] \x1b[1m\x1b[3;42m[INFO] >\x1b[0m: Logs > Cleaned ${cleanedCount} old log files`);
        }
    }
    catch (error) {
        console.error(`[${new Date().toISOString().slice(11, 23)}] \x1b[1m\x1b[3;41m[ERROR] >\x1b[0m: Logs > Failed to clean old logs: ${error instanceof Error ? error.message : String(error)}`);
    }
}
/**
 * Rotates the current log file if the naming policy changes.
 *
 * This closes the previous stream, creates the target directory,
 * and writes a header with build metadata to the new log file.
 * @internal
 */
function rotateLogFile() {
    if (!loggingConfig.file?.enabled)
        return;
    const logDir = loggingConfig.file.path || 'logs';
    const newLogFileName = getLogFileName();
    const newLogFilePath = path.join(logDir, newLogFileName);
    if (currentLogFile === newLogFilePath)
        return;
    if (logStream) {
        logStream.end();
        logStream = null;
    }
    fs.mkdirSync(logDir, { recursive: true });
    currentLogFile = newLogFilePath;
    logStream = fs.createWriteStream(currentLogFile, { flags: 'a' });
    const gitInfo = getGitInfo();
    const version = getVersion();
    const initialInfo = `\n--- NodeLink Log ---\nTimestamp: ${new Date().toISOString()}\nVersion: ${version}\nGit Branch: ${gitInfo.branch}\nGit Commit: ${gitInfo.commit}\nOS: ${os.platform()} ${os.release()}\nNode.js: ${process.version}\n--------------------\n`;
    logStream.write(initialInfo);
}
/**
 * Initializes file logging rotation and cleanup timers.
 *
 * If file logging is disabled, this function is a no-op.
 * @internal
 */
function initFileLogger() {
    if (!loggingConfig.file?.enabled)
        return;
    rotateLogFile();
    const rotation = loggingConfig.file?.rotation || 'session';
    if (rotation === 'hourly') {
        logRotationInterval = setInterval(rotateLogFile, 60 * 60 * 1000);
    }
    else if (rotation === 'daily') {
        logRotationInterval = setInterval(rotateLogFile, 24 * 60 * 60 * 1000);
    }
    cleanOldLogs();
    logCleanupInterval = setInterval(cleanOldLogs, 60 * 60 * 1000);
}
/**
 * Initializes logger configuration.
 *
 * This sets the active log level, debug toggles, and file logging policy.
 * @param config - NodeLink configuration object.
 * @example
 * ```ts
 * initLogger(config)
 * ```
 * @public
 */
function initLogger(config) {
    loggingConfig = config.logging || {};
    currentLogLevel = logLevels[loggingConfig.level || 'info'];
    initFileLogger();
}
/**
 * Writes a formatted log entry to stdout and the log file.
 *
 * Debug logs are filtered by `loggingConfig.debug` unless `debug.all` is
 * enabled. Special levels (`sources`, `started`, `network`) are treated as
 * informational to preserve existing UX.
 * @param level - Log severity.
 * @param args - Category followed by message content.
 * @example
 * ```ts
 * logger('info', 'Server', 'Listening on %s', address)
 * ```
 * @public
 */
function logger(level, ...args) {
    const effectiveLevel = level === 'sources' || level === 'started' || level === 'network'
        ? 'info'
        : level;
    const levelIndex = logLevels[effectiveLevel];
    if (levelIndex === undefined || levelIndex < currentLogLevel)
        return;
    const category = args.length > 1 ? args[0] : '';
    if (level === 'debug') {
        const debugConfig = loggingConfig.debug || {};
        const categoryKey = typeof category === 'string' ? category.toLowerCase() : category;
        const categoryEnabled = debugConfig[category] ??
            (categoryKey ? debugConfig[categoryKey] : undefined);
        if (debugConfig.all) {
            if (categoryEnabled === false)
                return;
        }
        else if (!categoryEnabled) {
            return;
        }
    }
    const levels = {
        info: { label: 'INFO', color: '\x1b[1m\x1b[3;42m' },
        warn: { label: 'WARN', color: '\x1b[1m\x1b[3;43m' },
        error: { label: 'ERROR', color: '\x1b[1m\x1b[3;41m' },
        debug: { label: 'DEBUG', color: '\x1b[1m\x1b[3;45m' },
        sources: { label: 'SOURCES', color: '\x1b[1m\x1b[3;46m' },
        started: { label: 'STARTED', color: '\x1b[1m\x1b[3;44m' },
        network: { label: 'NETWORK', color: '\x1b[1m\x1b[3;44m' }
    };
    const resetColor = '\x1b[0m';
    const time = new Date().toISOString().slice(11, 23);
    const lvl = levels[level] || {
        label: level.toUpperCase(),
        color: ''
    };
    const formattedCategory = category ? `: ${category} >` : '';
    const messageArgs = args.length > 1 ? args.slice(1) : args;
    const formattedArgs = messageArgs.map((arg) => {
        if (arg instanceof Error) {
            return `${arg.stack || arg.message}`;
        }
        if (typeof arg === 'object' && arg !== null) {
            return util.inspect(arg, { depth: null, colors: false });
        }
        return arg;
    });
    const msg = util.format(...formattedArgs);
    const consoleOutput = `[${time}] ${lvl.color}[${lvl.label}] >${resetColor}${formattedCategory} ${msg}`;
    console.log(consoleOutput);
    if (logStream) {
        const fileOutput = `[${new Date().toISOString()}] [${lvl.label}] ${formattedCategory} ${msg}\n`;
        logStream.write(fileOutput);
    }
}
/**
 * Validates a Discord snowflake ID format.
 *
 * This only checks formatting; it does not guarantee the ID exists.
 * @param id - Candidate ID value.
 * @returns True when the ID matches the snowflake regex.
 * @public
 */
const verifyDiscordID = (id) => DISCORD_ID_REGEX.test(String(id));
/**
 * Validates a configuration property.
 *
 * Throws an error with a user-friendly message when validation fails.
 * @param value - Value to validate.
 * @param path - Config path label for error messaging.
 * @param expected - Expected type or description.
 * @param validator - Predicate that returns true when the value is valid.
 * @throws Error when missing or invalid.
 * @public
 */
function validateProperty(value, path, expected, validator) {
    const received = value === undefined
        ? 'undefined'
        : value === null
            ? 'null'
            : `${JSON.stringify(value)} (${typeof value})`;
    if (value === undefined || value === null) {
        throw new Error(`Configuration error:\n` +
            `- Property: ${path}\n` +
            `- Received: ${received}\n` +
            `- Problem: missing required value\n` +
            `- Expected: ${expected}\n\n` +
            `Please define ${path} in your config.js file.`);
    }
    if (!validator(value)) {
        throw new Error(`Configuration error:\n` +
            `- Property: ${path}\n` +
            `- Received: ${received}\n` +
            `- Expected: ${expected}`);
    }
}
/**
 * Parses a semantic version string into structured fields.
 *
 * Returns `null` for invalid strings. The `prerelease` and `build` arrays
 * are split on dots for easier comparison.
 * @param version - Semver string (e.g., "1.2.3").
 * @returns Parsed version components or null when invalid.
 * @example
 * ```ts
 * const parsed = parseSemver('1.2.3-beta.1+build')
 * console.log(parsed?.major)
 * ```
 * @public
 */
function parseSemver(version) {
    const match = SEMVER_PATTERN.exec(version);
    if (!match?.groups)
        return null;
    const { major, minor, patch, prerelease, build } = match.groups;
    return {
        major: Number(major),
        minor: Number(minor),
        patch: Number(patch),
        prerelease: prerelease ? prerelease.split('.') : [],
        build: build ? build.split('.') : []
    };
}
/**
 * Returns the current NodeLink version.
 *
 * Use the `object` form when you need numeric components for comparisons.
 * @param type - Return format selector.
 * @returns Version string or parsed object.
 * @public
 */
function getVersion(type = 'string') {
    if (type === 'object') {
        return parseSemver(packageJson.version) ?? undefined;
    }
    if (type === 'string') {
        return packageJson.version;
    }
    return undefined;
}
/**
 * Applies track modifiers to payloads before serialization.
 *
 * Modifiers are executed only for payloads that include `info` and `encoded`.
 * Nested objects (excluding `info`) are traversed recursively.
 * @param nodelink - Active NodeLink runtime instance.
 * @param data - Payload data to modify.
 * @returns Modified payload data.
 * @internal
 */
function modifyPayload(nodelink, data) {
    if (!data || typeof data !== 'object')
        return data;
    const modifiers = nodelink.extensions?.trackModifiers;
    if (!modifiers || modifiers.length === 0)
        return data;
    if (Array.isArray(data)) {
        return data.map((item) => modifyPayload(nodelink, item));
    }
    const modifiedData = { ...data };
    if ('info' in modifiedData && modifiedData.encoded !== undefined) {
        for (const modifier of modifiers) {
            try {
                modifier(modifiedData);
            }
            catch (e) {
                logger('error', 'PluginManager', `Track modifier error: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }
    for (const key in modifiedData) {
        if (typeof modifiedData[key] === 'object' && key !== 'info') {
            modifiedData[key] = modifyPayload(nodelink, modifiedData[key]);
        }
    }
    return modifiedData;
}
/**
 * Sends a JSON response with optional compression.
 *
 * The payload is passed through track modifiers when a runtime instance
 * is available. If a `trace` field exists and `trace` is false, it is removed.
 * @param req - API request object.
 * @param res - API response object.
 * @param data - Payload data to send.
 * @param status - HTTP status code.
 * @param trace - Whether to include stack trace in the payload.
 * @example
 * ```ts
 * sendResponse(req, res, { ok: true }, 200)
 * ```
 * @public
 */
function sendResponse(req, res, data, status, trace = false) {
    const headers = {
        'Nodelink-Api-Version': '4',
        IamNodelink: 'true'
    };
    if (!data) {
        res.writeHead(status, headers);
        res.end();
        return;
    }
    const nodelink = runtime.nodelink;
    let finalData = nodelink ? modifyPayload(nodelink, data) : data;
    if (finalData &&
        typeof finalData === 'object' &&
        'trace' in finalData &&
        finalData.trace &&
        !trace) {
        const { trace: _trace, ...rest } = finalData;
        finalData = rest;
    }
    headers['Content-Type'] = 'application/json';
    const jsonData = JSON.stringify(finalData);
    const buffer = Buffer.from(jsonData);
    const rawEncoding = req.headers['accept-encoding'];
    const encoding = Array.isArray(rawEncoding)
        ? rawEncoding.join(',')
        : rawEncoding || '';
    const compressions = [
        { type: 'br', method: zlib.brotliCompress },
        { type: 'gzip', method: zlib.gzip },
        { type: 'deflate', method: zlib.deflate }
    ];
    if (hasZstd) {
        compressions.unshift({ type: 'zstd', method: zlib.zstdCompress });
    }
    for (const { type, method } of compressions) {
        if (encoding.includes(type)) {
            headers['Content-Encoding'] = type;
            method(buffer, (err, result) => {
                if (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Compression failed' }));
                    return;
                }
                headers['Content-Length'] = result.byteLength;
                res.writeHead(status, headers);
                res.end(result);
            });
            return;
        }
    }
    headers['Content-Length'] = buffer.byteLength;
    res.writeHead(status, headers);
    res.end(buffer);
}
/**
 * Fetches git metadata for the running build.
 *
 * Uses the injected `__BUILD_GIT_INFO__` when present, otherwise shells out
 * to git and caches the result.
 * @returns Cached git metadata.
 * @public
 */
function getGitInfo() {
    const buildInfo = typeof __BUILD_GIT_INFO__ !== 'undefined' ? __BUILD_GIT_INFO__ : undefined;
    if (buildInfo) {
        return buildInfo;
    }
    if (gitInfoCache)
        return gitInfoCache;
    try {
        const output = execSync('git log -1 --format=%D%n%h%n%ct', {
            encoding: 'utf8'
        }).trim();
        const lines = output.split('\n');
        const refsLine = lines[0] || '';
        const commit = (lines[1] || 'unknown').trim();
        const commitTime = Number.parseInt((lines[2] || '0').trim(), 10) * 1000;
        let branch = 'unknown';
        const headMatch = refsLine.match(/HEAD -> ([^,]+)/);
        if (headMatch) {
            branch = headMatch[1]?.trim() ?? 'unknown';
        }
        else {
            try {
                branch = execSync('git rev-parse --abbrev-ref HEAD', {
                    encoding: 'utf8'
                }).trim();
            }
            catch { }
        }
        gitInfoCache = {
            branch,
            commit,
            commitTime
        };
        return gitInfoCache;
    }
    catch (error) {
        logger('warn', 'Git', 'Unable to retrieve git information. %s', error instanceof Error ? error.message : String(error));
        gitInfoCache = {
            branch: 'unknown',
            commit: 'unknown',
            commitTime: -1
        };
        return gitInfoCache;
    }
}
/**
 * Builds a server stats snapshot for the API.
 *
 * Aggregates player counts, memory usage, CPU load, and frame stats across
 * workers or the main process. Also updates route planner IP counters when
 * a stats manager is available.
 * @param nodelink - Active NodeLink runtime instance.
 * @returns Aggregated stats payload.
 * @public
 */
function getStats(nodelink) {
    let players = 0;
    let playingPlayers = 0;
    let aggregatedNodelinkLoad = 0;
    const memory = {
        free: os.freemem(),
        used: 0,
        allocated: 0,
        reservable: os.totalmem()
    };
    if (nodelink.workerManager) {
        for (const stats of nodelink.workerManager.workerStats.values()) {
            players += stats.players || 0;
            playingPlayers += stats.playingPlayers || 0;
            if (stats.memory) {
                memory.used += stats.memory.used || 0;
                memory.allocated += stats.memory.allocated || 0;
            }
            if (stats.cpu) {
                aggregatedNodelinkLoad += stats.cpu.nodelinkLoad || 0;
            }
        }
        const primaryMem = process.memoryUsage();
        memory.used += primaryMem.heapUsed;
        memory.allocated += primaryMem.heapTotal;
    }
    else {
        players = nodelink.statistics.players;
        playingPlayers = nodelink.statistics.playingPlayers;
        const mem = process.memoryUsage();
        memory.used = mem.heapUsed;
        memory.allocated = mem.heapTotal;
    }
    let frameStats = null;
    if (players > 0) {
        frameStats = { sent: 0, nulled: 0, deficit: 0, expected: 0 };
        if (nodelink.workerManager) {
            for (const workerStats of nodelink.workerManager.workerStats.values()) {
                if (workerStats.frameStats) {
                    frameStats.sent += workerStats.frameStats.sent || 0;
                    frameStats.nulled += workerStats.frameStats.nulled || 0;
                    frameStats.expected += workerStats.frameStats.expected || 0;
                }
            }
            frameStats.deficit = Math.max(0, frameStats.expected - frameStats.sent);
        }
        else {
            for (const session of nodelink.sessions.values()) {
                for (const player of session.players.players.values()) {
                    if (!player.connection)
                        continue;
                    const stats = player.connection.statistics;
                    if (!stats)
                        continue;
                    const sent = stats.packetsSent || 0;
                    const nulled = stats.packetsLost || 0;
                    const expectedFrames = stats.packetsExpected || 0;
                    frameStats.sent += sent;
                    frameStats.nulled += nulled;
                    frameStats.expected += expectedFrames;
                }
            }
            frameStats.deficit = Math.max(0, frameStats.expected - frameStats.sent);
        }
    }
    const uptime = Math.floor(process.uptime() * 1000);
    const cores = os.cpus().length;
    const load = os.loadavg()[0] ?? 0;
    const cpu = {
        cores,
        systemLoad: load,
        nodelinkLoad: Number.parseFloat((aggregatedNodelinkLoad / cores).toFixed(2))
    };
    if (nodelink.routePlanner && nodelink.statsManager) {
        const availableIps = nodelink.routePlanner.ipBlocks?.length || 0;
        const bannedIps = nodelink.routePlanner.bannedIps?.size || 0;
        nodelink.statsManager.setRoutePlannerIps?.(availableIps, bannedIps);
    }
    return {
        players,
        playingPlayers,
        uptime,
        memory,
        cpu,
        frameStats
    };
}
/**
 * Validates that a request uses an expected HTTP method.
 *
 * Sends a standard 405 response when the method is not allowed.
 * @param parsedUrl - Parsed URL of the request.
 * @param req - API request object.
 * @param res - API response object.
 * @param expected - Allowed method(s).
 * @param clientAddress - Client IP address for logging.
 * @param trace - Whether to include stack traces in error payloads.
 * @returns True when the request is allowed.
 * @public
 */
function verifyMethod(parsedUrl, req, res, expected, clientAddress, trace = false) {
    const methods = Array.isArray(expected) ? expected : [expected];
    if (!req.method || !methods.includes(req.method)) {
        logger('warn', 'Server', `Method not allowed: ${req.method} ${parsedUrl.pathname} from ${clientAddress}`);
        sendResponse(req, res, {
            timestamp: Date.now(),
            status: 405,
            error: 'Method Not Allowed',
            message: `Method must be one of ${methods.join(', ')}`,
            path: parsedUrl.pathname,
            trace: new Error().stack
        }, 405, trace);
        return false;
    }
    return true;
}
/**
 * Decodes a Lavalink-style base64 track string.
 *
 * This trims legacy NLK seekable trailers and derives `isSeekable` directly
 * from `isStream` to keep the payload compact.
 * @param encoded - Base64 encoded track.
 * @returns Parsed track payload.
 * @throws Error when the payload is malformed.
 * @example
 * ```ts
 * const decoded = decodeTrack(encoded)
 * console.log(decoded.info.title)
 * ```
 * @public
 */
function decodeTrack(encoded) {
    if (!encoded)
        throw new Error('Decode Error: Input string is null or empty');
    const buffer = Buffer.from(encoded, 'base64');
    let position = 0;
    let step = 'init';
    const ensure = (n) => {
        if (position + n > buffer.length)
            throw new Error(`Unexpected end of buffer (need ${n} bytes)`);
    };
    const readModifiedUTF8From = (buf, pRef) => {
        if (pRef.value + 2 > buf.length)
            throw new Error('Unexpected end of buffer (need 2 bytes)');
        const utflen = buf.readUInt16BE(pRef.value);
        pRef.value += 2;
        if (pRef.value + utflen > buf.length)
            throw new Error(`Unexpected end of buffer (need ${utflen} bytes)`);
        const end = pRef.value + utflen;
        const chars = [];
        let i = pRef.value;
        while (i < end) {
            const c = buf[i];
            if (c === undefined)
                throw new Error('Malformed utf');
            if (c < 0x80) {
                i += 1;
                chars.push(String.fromCharCode(c));
                continue;
            }
            if ((c & 0xe0) === 0xc0) {
                if (i + 1 >= end)
                    throw new Error('Malformed utf');
                const c2 = buf[i + 1];
                if (c2 === undefined)
                    throw new Error('Malformed utf');
                if ((c2 & 0xc0) !== 0x80)
                    throw new Error('Malformed utf');
                const ch = ((c & 0x1f) << 6) | (c2 & 0x3f);
                i += 2;
                chars.push(String.fromCharCode(ch));
                continue;
            }
            if ((c & 0xf0) === 0xe0) {
                if (i + 2 >= end)
                    throw new Error('Malformed utf');
                const c2 = buf[i + 1];
                const c3 = buf[i + 2];
                if (c2 === undefined || c3 === undefined)
                    throw new Error('Malformed utf');
                if ((c2 & 0xc0) !== 0x80 || (c3 & 0xc0) !== 0x80)
                    throw new Error('Malformed utf');
                const ch = ((c & 0x0f) << 12) | ((c2 & 0x3f) << 6) | (c3 & 0x3f);
                i += 3;
                chars.push(String.fromCharCode(ch));
                continue;
            }
            throw new Error('Malformed utf');
        }
        pRef.value = end;
        return chars.join('');
    };
    const readNullableTextFrom = (buf, pRef) => {
        if (pRef.value + 1 > buf.length)
            throw new Error('Unexpected end of buffer (need 1 byte)');
        const present = buf[pRef.value++] !== 0;
        return present ? readModifiedUTF8From(buf, pRef) : null;
    };
    const decodeDetailsAsList = (detailsBuf) => {
        let p = 0;
        const ensure2 = (n) => {
            if (p + n > detailsBuf.length)
                throw new Error('Unexpected end of details');
        };
        const readUTF2 = () => {
            ensure2(2);
            const utflen = detailsBuf.readUInt16BE(p);
            p += 2;
            ensure2(utflen);
            const end = p + utflen;
            const chars = [];
            let i = p;
            while (i < end) {
                const c = detailsBuf[i];
                if (c === undefined)
                    throw new Error('Malformed utf');
                if (c < 0x80) {
                    i += 1;
                    chars.push(String.fromCharCode(c));
                    continue;
                }
                if ((c & 0xe0) === 0xc0) {
                    if (i + 1 >= end)
                        throw new Error('Malformed utf');
                    const c2 = detailsBuf[i + 1];
                    if (c2 === undefined)
                        throw new Error('Malformed utf');
                    if ((c2 & 0xc0) !== 0x80)
                        throw new Error('Malformed utf');
                    const ch = ((c & 0x1f) << 6) | (c2 & 0x3f);
                    i += 2;
                    chars.push(String.fromCharCode(ch));
                    continue;
                }
                if ((c & 0xf0) === 0xe0) {
                    if (i + 2 >= end)
                        throw new Error('Malformed utf');
                    const c2 = detailsBuf[i + 1];
                    const c3 = detailsBuf[i + 2];
                    if (c2 === undefined || c3 === undefined)
                        throw new Error('Malformed utf');
                    if ((c2 & 0xc0) !== 0x80 || (c3 & 0xc0) !== 0x80)
                        throw new Error('Malformed utf');
                    const ch = ((c & 0x0f) << 12) | ((c2 & 0x3f) << 6) | (c3 & 0x3f);
                    i += 3;
                    chars.push(String.fromCharCode(ch));
                    continue;
                }
                throw new Error('Malformed utf');
            }
            p = end;
            return chars.join('');
        };
        const readNullable2 = () => {
            ensure2(1);
            const present = detailsBuf[p++] !== 0;
            return present ? readUTF2() : null;
        };
        const out = [];
        while (p < detailsBuf.length)
            out.push(readNullable2());
        while (out.length && out[out.length - 1] === null)
            out.pop();
        return out;
    };
    const tryParseLegacySeekableTrailer = (buf) => {
        let p = 0;
        try {
            if (buf.length < 1)
                return false;
            const present = buf[p++] !== 0;
            if (!present)
                return false;
            const pRef = { value: p };
            const s = readModifiedUTF8From(buf, pRef);
            if (pRef.value !== buf.length)
                return false;
            return s === 'NLK:seekableY' || s === 'NLK:seekableN';
        }
        catch {
            return false;
        }
    };
    try {
        step = 'messageHeader';
        ensure(4);
        const header = buffer.readInt32BE(position);
        position += 4;
        const flags = (header >>> 30) & 0x3;
        const messageSize = header & 0x3fffffff;
        if (messageSize === 0)
            throw new Error('message size: 0');
        step = 'messageBody';
        ensure(messageSize);
        let messageBuf = buffer.subarray(position, position + messageSize);
        position += messageSize;
        const tailTryMax = Math.min(messageBuf.length, 512);
        for (let cut = 1; cut <= tailTryMax; cut++) {
            const tail = messageBuf.subarray(messageBuf.length - cut);
            if (tryParseLegacySeekableTrailer(tail)) {
                messageBuf = messageBuf.subarray(0, messageBuf.length - cut);
                break;
            }
        }
        step = 'payload';
        const pRef = { value: 0 };
        if (pRef.value + 1 > messageBuf.length)
            throw new Error('Unexpected end of message (need 1 byte)');
        const versionByte = messageBuf[pRef.value++];
        if (versionByte === undefined)
            throw new Error('Unexpected end of message (need 1 byte)');
        const version = versionByte & 0xff;
        const title = readModifiedUTF8From(messageBuf, pRef);
        const author = readModifiedUTF8From(messageBuf, pRef);
        if (pRef.value + 8 > messageBuf.length)
            throw new Error('Unexpected end of message (need 8 bytes)');
        const length = Number(messageBuf.readBigInt64BE(pRef.value));
        pRef.value += 8;
        const identifier = readModifiedUTF8From(messageBuf, pRef);
        if (pRef.value + 1 > messageBuf.length)
            throw new Error('Unexpected end of message (need 1 byte)');
        const isStream = messageBuf[pRef.value++] !== 0;
        const uri = version >= 2 ? readNullableTextFrom(messageBuf, pRef) : null;
        const artworkUrl = version >= 3 ? readNullableTextFrom(messageBuf, pRef) : null;
        const isrc = version >= 3 ? readNullableTextFrom(messageBuf, pRef) : null;
        const sourceName = readModifiedUTF8From(messageBuf, pRef);
        const positionOffset = messageBuf.length - 8;
        const detailsBuf = messageBuf.subarray(pRef.value, positionOffset);
        const trackPosition = Number(messageBuf.readBigInt64BE(positionOffset));
        let details = [];
        if (detailsBuf.length > 0) {
            try {
                details = decodeDetailsAsList(detailsBuf);
            }
            catch {
                details = [];
            }
        }
        return {
            encoded,
            info: {
                title,
                author,
                length,
                identifier,
                isSeekable: !isStream,
                isStream,
                uri,
                artworkUrl,
                isrc,
                sourceName,
                position: trackPosition
            },
            details,
            pluginInfo: {},
            userData: {},
            messageFlags: flags
        };
    }
    catch (err) {
        throw new Error(`Decode Error at [${step}]: ${err instanceof Error ? err.message : String(err)} (Buffer pos: ${position}/${buffer.length})`);
    }
}
/**
 * Encodes a track payload into a base64 string.
 *
 * The payload version is derived from the presence of `uri`, `artworkUrl`, and
 * `isrc` fields. Legacy NLK seekable trailers are no longer emitted.
 * @param track - Track payload to encode.
 * @returns Base64 encoded track string.
 * @throws Error when the payload is invalid.
 * @example
 * ```ts
 * const encoded = encodeTrack(trackInfo)
 * ```
 * @public
 */
function encodeTrack(track) {
    if (!track || typeof track !== 'object') {
        throw new Error('Encode Error: Input track must be a valid object');
    }
    const encodeModifiedUTF8 = (value) => {
        const str = String(value);
        const bytes = [];
        for (let i = 0; i < str.length; i++) {
            const ch = str.charCodeAt(i);
            if (ch >= 0x0001 && ch <= 0x007f) {
                bytes.push(ch);
            }
            else if (ch === 0x0000 || (ch >= 0x0080 && ch <= 0x07ff)) {
                bytes.push(0xc0 | ((ch >> 6) & 0x1f));
                bytes.push(0x80 | (ch & 0x3f));
            }
            else {
                bytes.push(0xe0 | ((ch >> 12) & 0x0f));
                bytes.push(0x80 | ((ch >> 6) & 0x3f));
                bytes.push(0x80 | (ch & 0x3f));
            }
        }
        if (bytes.length > 65535)
            throw new Error('Encode Error: UTF string too long');
        const lenBuf = Buffer.alloc(2);
        lenBuf.writeUInt16BE(bytes.length);
        return Buffer.concat([lenBuf, Buffer.from(bytes)]);
    };
    const chunks = [];
    const push = (b) => {
        chunks.push(b);
    };
    const writeByte = (v) => push(Buffer.from([v & 0xff]));
    const writeLong = (v) => {
        const b = Buffer.alloc(8);
        b.writeBigInt64BE(BigInt(v));
        push(b);
    };
    const writeUTF = (v) => push(encodeModifiedUTF8(v));
    const writeNullableText = (v) => {
        if (v === undefined || v === null) {
            writeByte(0);
        }
        else {
            writeByte(1);
            writeUTF(String(v));
        }
    };
    const version = track.artworkUrl || track.isrc ? 3 : track.uri ? 2 : 1;
    const flags = 1;
    writeByte(version);
    writeUTF(track.title);
    writeUTF(track.author);
    writeLong(track.length);
    writeUTF(track.identifier);
    writeByte(track.isStream ? 1 : 0);
    if (version >= 2)
        writeNullableText(track.uri ?? null);
    if (version >= 3) {
        writeNullableText(track.artworkUrl ?? null);
        writeNullableText(track.isrc ?? null);
    }
    writeUTF(track.sourceName);
    if (Array.isArray(track.details)) {
        for (const detail of track.details)
            writeNullableText(detail);
    }
    writeLong(track.position ?? 0);
    const messageBuf = Buffer.concat(chunks);
    const header = (messageBuf.length & 0x3fffffff) | ((flags & 0x3) << 30);
    const headerBuf = Buffer.alloc(4);
    headerBuf.writeInt32BE(header);
    return Buffer.concat([headerBuf, messageBuf]).toString('base64');
}
/**
 * Generates a random alphabetic string.
 *
 * Uses uppercase and lowercase ASCII letters only.
 * @param length - Length of the string to generate.
 * @returns Random string of letters.
 * @public
 */
const generateRandomLetters = (length) => Array.from(crypto.randomBytes(length), (b) => String.fromCharCode((b % 52) + (b % 52 < 26 ? 65 : 71))).join('');
/**
 * Parses the `Client-Name` header into a structured object.
 *
 * Supported formats:
 * - `Name/Version`
 * - `Name/Version (Tag/2024-01-01)`
 * - `Name/Version (https:
 * @param agent - Client-Name header value.
 * @returns Parsed client info or null when invalid.
 * @public
 */
function parseClient(agent) {
    if (typeof agent !== 'string' || !agent.trim())
        return null;
    const [core = '', metaPart] = agent.trim().split(' ', 2);
    const [name, version] = core.split('/');
    if (!name)
        return null;
    const info = { name };
    if (version)
        info.version = version;
    if (metaPart?.startsWith('(') && metaPart.endsWith(')')) {
        const meta = metaPart.slice(1, -1);
        if (meta.startsWith('http')) {
            info.url = meta;
        }
        else {
            const [tag, date] = meta.split('/');
            if (tag)
                info.codename = tag;
            if (date)
                info.releaseDate = date;
        }
    }
    return info;
}
/**
 * Shared HTTP agent with keep-alive enabled for HTTP requests.
 * @internal
 */
const httpAgent = new http.Agent({
    keepAlive: true,
    maxFreeSockets: 32,
    maxSockets: Infinity,
    timeout: 60000
});
/**
 * Shared HTTPS agent with keep-alive enabled for HTTPS requests.
 * @internal
 */
const httpsAgent = new https.Agent({
    keepAlive: true,
    maxFreeSockets: 32,
    maxSockets: Infinity,
    timeout: 60000
});
/**
 * Cache of hosts that failed HTTP/2 negotiation.
 *
 * Prevents repeated HTTP/2 attempts for hosts that only support HTTP/1.
 * @internal
 */
const http2FailedHosts = new Set();
setInterval(() => {
    if (http2FailedHosts.size > 0) {
        http2FailedHosts.clear();
    }
}, 6 * 60 * 60 * 1000).unref();
/**
 * Internal HTTP/1 request handler with redirect and decompression support.
 *
 * This method performs the actual HTTP/1 request and handles response
 * decompression, redirects, and stream-only responses.
 * @param urlString - URL to request.
 * @param options - Request options.
 * @returns HTTP response payload.
 * @internal
 */
async function _internalHttp1Request(urlString, options = {}) {
    const { method = 'GET', headers: customHeaders = {}, body, timeout = Math.max(1, options.timeout ?? 30000), streamOnly = false, disableBodyCompression = false, maxRedirects = DEFAULT_MAX_REDIRECTS, maxResponseBodyBytes = DEFAULT_MAX_RESPONSE_BODY_BYTES, localAddress, agent: customAgent, _redirectsFollowed = 0 } = options;
    const actualLocalAddress = localAddress ?? runtime.nodelink?.routePlanner?.getIP?.() ?? undefined;
    if (_redirectsFollowed >= maxRedirects) {
        throw new Error(`Too many redirects (${maxRedirects}) for ${urlString}`);
    }
    const currentUrl = new URL(urlString);
    const isHttps = currentUrl.protocol === 'https:';
    const lib = isHttps ? https : http;
    const agent = customAgent || (isHttps ? httpsAgent : httpAgent);
    const acceptEncoding = ['br', 'gzip', 'deflate'];
    if (hasZstd)
        acceptEncoding.unshift('zstd');
    const reqHeaders = {
        'Accept-Encoding': acceptEncoding.join(', '),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        ...customHeaders
    };
    let payloadBuffer = null;
    if (body != null && !['GET', 'HEAD'].includes(method)) {
        if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
            payloadBuffer = Buffer.from(body);
        }
        else {
            const isFormUrlEncoded = reqHeaders['Content-Type'] === 'application/x-www-form-urlencoded';
            let rawPayload;
            if (isFormUrlEncoded && typeof body === 'string') {
                rawPayload = body;
            }
            else {
                reqHeaders['Content-Type'] =
                    reqHeaders['Content-Type'] || 'application/json';
                rawPayload = typeof body === 'string' ? body : JSON.stringify(body);
            }
            if (disableBodyCompression) {
                payloadBuffer = Buffer.from(rawPayload);
            }
            else {
                reqHeaders['Content-Encoding'] = 'gzip';
                payloadBuffer = zlib.gzipSync(rawPayload);
            }
        }
    }
    const reqOptions = {
        method,
        agent,
        timeout,
        hostname: currentUrl.hostname,
        port: currentUrl.port || (isHttps ? 443 : 80),
        path: currentUrl.pathname + currentUrl.search,
        headers: reqHeaders,
        localAddress: actualLocalAddress
    };
    return new Promise((resolve, reject) => {
        const req = lib.request(reqOptions, (res) => {
            const { statusCode, headers: respHeaders } = res;
            const responseStatus = statusCode ?? 0;
            const locationHeader = respHeaders.location;
            const location = Array.isArray(locationHeader)
                ? locationHeader[0]
                : locationHeader;
            if (REDIRECT_STATUS_CODES.includes(responseStatus) &&
                location) {
                res.resume();
                const nextUrl = new URL(location, currentUrl).href;
                const isGetRedirect = [301, 302, 303].includes(responseStatus);
                let nextMethod = method;
                let nextBody = body;
                if (method === 'HEAD') {
                    nextMethod = 'HEAD';
                    nextBody = undefined;
                }
                else if (isGetRedirect) {
                    nextMethod = 'GET';
                    nextBody = undefined;
                }
                const nextHeaders = { ...customHeaders };
                const setCookie = respHeaders['set-cookie'];
                if (setCookie) {
                    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
                    const existingCookie = String(nextHeaders.cookie || nextHeaders.Cookie || '');
                    const newCookies = cookies.map((c) => c.split(';')[0]).join('; ');
                    nextHeaders.cookie = existingCookie
                        ? `${existingCookie}; ${newCookies}`
                        : newCookies;
                }
                const nextOptions = {
                    ...options,
                    _redirectsFollowed: _redirectsFollowed + 1,
                    method: nextMethod,
                    body: nextBody,
                    headers: nextHeaders
                };
                resolve(http1makeRequest(nextUrl, nextOptions));
                return;
            }
            let finalStream = res;
            const encodingHeader = respHeaders['content-encoding'];
            const encoding = Array.isArray(encodingHeader)
                ? encodingHeader.join(',')
                : String(encodingHeader || '').toLowerCase();
            if (encoding === 'zstd' && hasZstd) {
                finalStream = res.pipe(zlib.createZstdDecompress());
            }
            else if (encoding === 'br') {
                finalStream = res.pipe(zlib.createBrotliDecompress());
            }
            else if (encoding === 'gzip') {
                finalStream = res.pipe(zlib.createGunzip());
            }
            else if (encoding === 'deflate') {
                finalStream = res.pipe(zlib.createInflate());
            }
            let cleanupBody;
            res.on('error', (err) => {
                cleanupBody?.();
                cleanupReq();
                reject(new Error(`Response error for ${urlString}: ${err.message}`));
            });
            if (finalStream !== res) {
                finalStream.on('error', (err) => {
                    cleanupBody?.();
                    cleanupReq();
                    reject(new Error(`Decompression error for ${urlString}: ${err.message}`));
                });
            }
            if (streamOnly) {
                resolve({
                    statusCode,
                    headers: respHeaders,
                    stream: finalStream,
                    finalUrl: urlString
                });
                return;
            }
            const chunks = [];
            let bufferedBytes = 0;
            const onData = (chunk) => {
                bufferedBytes += chunk.length;
                if (bufferedBytes > maxResponseBodyBytes) {
                    ;
                    finalStream.destroy?.(new Error(`Response body too large for ${urlString} (${bufferedBytes} bytes > ${maxResponseBodyBytes} bytes)`));
                    return;
                }
                chunks.push(chunk);
            };
            const onEnd = () => {
                try {
                    const responseBuffer = Buffer.concat(chunks);
                    cleanupBody?.();
                    if (options.responseType === 'buffer') {
                        resolve({
                            statusCode,
                            headers: respHeaders,
                            body: responseBuffer,
                            finalUrl: urlString
                        });
                        return;
                    }
                    const text = responseBuffer.toString('utf8');
                    const contentTypeHeader = respHeaders['content-type'];
                    const contentType = Array.isArray(contentTypeHeader)
                        ? contentTypeHeader[0]
                        : contentTypeHeader || '';
                    const isJson = contentType
                        .toLowerCase()
                        .startsWith('application/json');
                    const responseBody = isJson && text ? JSON.parse(text) : text;
                    resolve({
                        statusCode,
                        headers: respHeaders,
                        body: responseBody,
                        finalUrl: urlString
                    });
                }
                catch (err) {
                    reject(new Error(`Error processing response body for ${urlString}: ${err instanceof Error ? err.message : String(err)}`));
                }
                finally {
                    cleanupBody?.();
                    cleanupReq();
                }
            };
            cleanupBody = () => {
                finalStream.removeListener('data', onData);
                finalStream.removeListener('end', onEnd);
                chunks.length = 0;
                cleanupBody = undefined;
            };
            finalStream.on('data', onData);
            finalStream.once('end', onEnd);
        });
        const reqErrorHandler = (err) => {
            cleanupReq();
            reject(err);
        };
        const reqTimeoutHandler = () => {
            req.destroy(new Error(`Request timed out after ${timeout}ms for ${urlString}`));
        };
        const cleanupReq = () => {
            req.removeListener('error', reqErrorHandler);
            req.removeListener('timeout', reqTimeoutHandler);
        };
        req.on('error', reqErrorHandler);
        req.on('timeout', reqTimeoutHandler);
        if (payloadBuffer) {
            req.end(payloadBuffer);
        }
        else {
            req.end();
        }
    });
}
/**
 * Performs an HTTP/1 request with retry logic and proxy support.
 *
 * This wraps the internal request handler to provide retry/backoff behavior
 * for transient network errors.
 * @param urlString - URL to request.
 * @param options - Request options.
 * @returns HTTP response payload.
 * @public
 */
async function http1makeRequest(urlString, options = {}) {
    const { maxRetries = 3, proxy } = options;
    let attempt = 0;
    while (true) {
        try {
            let finalUrl = urlString;
            const useReverseProxy = shouldUseReverseProxy(proxy);
            if (useReverseProxy && proxy?.url) {
                finalUrl = `${proxy.url.replace(/\/+$/, '')}/${urlString}`;
                logger('debug', 'Network', `Using reverse proxy: ${proxy.url} for ${urlString}`);
            }
            const url = new URL(finalUrl);
            const isHttps = url.protocol === 'https:';
            let agent = options.agent;
            if (!agent && proxy?.url && !useReverseProxy) {
                if (proxy?.url) {
                    const proxyAgent = await getProxyAgent();
                    if (proxyAgent) {
                        const proxyUrl = new URL(proxy.url);
                        if (proxy.username && proxy.password) {
                            proxyUrl.username = proxy.username;
                            proxyUrl.password = proxy.password;
                        }
                        agent = new proxyAgent({ getProxyForUrl: () => proxyUrl.href });
                        logger('debug', 'Network', `Using proxy for ${url.hostname}: ${proxy.url}`);
                    }
                    else {
                        logger('warn', 'Network', 'Proxy configured but proxy-agent not installed.');
                    }
                }
                if (!agent) {
                    const useKeepAlive = !options.streamOnly;
                    agent = useKeepAlive
                        ? isHttps
                            ? httpsAgent
                            : httpAgent
                        : new (isHttps ? https : http).Agent({ keepAlive: false });
                }
            }
            const newOptions = { ...options, agent };
            return await _internalHttp1Request(finalUrl, newOptions);
        }
        catch (err) {
            const error = err;
            const code = error.code ? String(error.code) : '';
            const isRetryable = [
                'ECONNRESET',
                'ETIMEDOUT',
                'EPIPE',
                'ENETUNREACH',
                'EHOSTUNREACH'
            ].includes(code);
            if (isRetryable && attempt < maxRetries) {
                attempt++;
                const delay = 100 * 2 ** attempt;
                logger('warn', 'Network', `Request for ${urlString} failed with ${code}. Retrying in ${delay}ms... (Attempt ${attempt}/${maxRetries})`);
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
            else {
                throw error;
            }
        }
    }
}
/**
 * Performs an HTTP request with HTTP/2 fallback and logging.
 *
 * Uses HTTP/2 by default, falling back to HTTP/1 when a host fails negotiation.
 * Optional proxy settings force HTTP/1 usage.
 * @param urlString - URL to request.
 * @param options - Request options.
 * @param nodelink - Optional NodeLink instance override.
 * @returns HTTP response payload.
 * @example
 * ```ts
 * const res = await makeRequest('https://example.com', { method: 'GET' })
 * ```
 * @public
 */
async function makeRequest(urlString, options, nodelink) {
    const { method = 'GET', headers: customHeaders = {}, body, timeout = Math.max(1, options.timeout ?? 30000), streamOnly = false, disableBodyCompression = false, maxRedirects = DEFAULT_MAX_REDIRECTS, maxResponseBodyBytes = DEFAULT_MAX_RESPONSE_BODY_BYTES, _redirectsFollowed = 0 } = options;
    const finalNodeLink = nodelink || runtime.nodelink;
    const logId = crypto.randomBytes(4).toString('hex');
    if (loggingConfig.debug?.network) {
        logger('debug', 'Network', `[${logId}] Request: ${method} ${urlString}`);
        logger('debug', 'Network', `[${logId}] Headers: ${JSON.stringify(customHeaders, (key, value) => key.toLowerCase().includes('authorization') ||
            key.toLowerCase().includes('cookie')
            ? '[REDACTED]'
            : value)}`);
        if (body) {
            const bodySnippet = typeof body === 'string'
                ? body.substring(0, 200)
                : JSON.stringify(body).substring(0, 200);
            logger('debug', 'Network', `[${logId}] Body: ${bodySnippet}${bodySnippet.length === 200 ? '...' : ''}`);
        }
    }
    if (_redirectsFollowed >= maxRedirects) {
        return Promise.reject(new Error(`Too many redirects (${maxRedirects}) for ${urlString}`));
    }
    if (options.network?.proxy) {
        return http1makeRequest(urlString, options);
    }
    const localAddress = finalNodeLink?.routePlanner?.getIP?.() ?? undefined;
    try {
        const url = new URL(urlString);
        if (http2FailedHosts.has(url.host)) {
            return http1makeRequest(urlString, { ...options, localAddress });
        }
    }
    catch {
        return http1makeRequest(urlString, { ...options, localAddress });
    }
    return new Promise((resolve, reject) => {
        let session;
        let sessionClosed = false;
        let currentUrl;
        const fallbackToHttp1 = () => {
            if (!sessionClosed && session) {
                sessionClosed = true;
                session.close();
            }
            try {
                const url = new URL(urlString);
                http2FailedHosts.add(url.host);
            }
            catch { }
            resolve(http1makeRequest(urlString, { ...options, localAddress }));
        };
        try {
            currentUrl = new URL(urlString);
            session = http2.connect(currentUrl.origin, {
                localAddress
            });
            const closeSessionGracefully = () => {
                if (session &&
                    !session.closed &&
                    !session.destroyed &&
                    !sessionClosed) {
                    sessionClosed = true;
                    session.close();
                }
            };
            session.on('error', fallbackToHttp1);
            session.on('goaway', closeSessionGracefully);
            const h2Headers = {
                ':method': method,
                ':path': currentUrl.pathname + currentUrl.search,
                ':scheme': currentUrl.protocol.slice(0, -1),
                ':authority': currentUrl.host,
                'accept-encoding': hasZstd
                    ? 'zstd, br, gzip, deflate'
                    : 'br, gzip, deflate',
                'user-agent': 'Mozilla/5.0 (Node.js Http2Client)',
                dnt: '1',
                ...customHeaders
            };
            if (body && !['GET', 'HEAD'].includes(method)) {
                h2Headers['Content-Type'] =
                    typeof body === 'object'
                        ? 'application/json'
                        : h2Headers['Content-Type'];
                if (!disableBodyCompression)
                    h2Headers['content-encoding'] = 'gzip';
            }
            const req = session.request(h2Headers);
            let reqClosed = false;
            if (timeout) {
                req.setTimeout(timeout, () => {
                    if (!reqClosed) {
                        reqClosed = true;
                        req.close(http2.constants.NGHTTP2_CANCEL);
                    }
                    closeSessionGracefully();
                    fallbackToHttp1();
                    reject(new Error(`HTTP/2 request timeout for ${urlString}`));
                });
            }
            req.on('error', (err) => {
                if (!reqClosed)
                    reqClosed = true;
                closeSessionGracefully();
                fallbackToHttp1();
                reject(new Error(`HTTP/2 request error for ${urlString}: ${err.message}`));
            });
            req.on('response', async (headers) => {
                const statusHeader = headers[':status'];
                const rawStatus = typeof statusHeader === 'number' ? statusHeader : Number(statusHeader);
                const statusCode = Number.isNaN(rawStatus) ? undefined : rawStatus;
                if (statusCode === 429) {
                    finalNodeLink?.routePlanner?.banIP?.(localAddress);
                }
                const locationHeader = headers.location;
                const location = Array.isArray(locationHeader)
                    ? locationHeader[0]
                    : locationHeader;
                if (REDIRECT_STATUS_CODES.includes((statusCode ?? 0)) &&
                    location) {
                    const newLocation = new URL(location, urlString).href;
                    let nextMethod = method;
                    let nextBody = body;
                    if (method === 'HEAD') {
                        nextMethod = 'HEAD';
                        nextBody = undefined;
                    }
                    else if ((statusCode === 301 || statusCode === 302) &&
                        ['POST', 'PUT', 'DELETE'].includes(method)) {
                        nextMethod = 'GET';
                        nextBody = undefined;
                    }
                    else if (statusCode === 303) {
                        nextMethod = 'GET';
                        nextBody = undefined;
                    }
                    if (!reqClosed) {
                        reqClosed = true;
                        req.close(http2.constants.NGHTTP2_NO_ERROR);
                    }
                    closeSessionGracefully();
                    return resolve(makeRequest(newLocation, {
                        ...options,
                        method: nextMethod,
                        body: nextBody,
                        _redirectsFollowed: _redirectsFollowed + 1,
                        disableBodyCompression: nextBody
                            ? disableBodyCompression
                            : undefined
                    }, finalNodeLink));
                }
                let responseStream = req;
                const encodingHeader = headers['content-encoding'];
                const encoding = Array.isArray(encodingHeader)
                    ? encodingHeader.join(',')
                    : String(encodingHeader || '');
                if (encoding === 'zstd' && hasZstd)
                    responseStream = req.pipe(zlib.createZstdDecompress());
                else if (encoding === 'br')
                    responseStream = req.pipe(zlib.createBrotliDecompress());
                else if (encoding === 'gzip')
                    responseStream = req.pipe(zlib.createGunzip());
                else if (encoding === 'deflate')
                    responseStream = req.pipe(zlib.createInflate());
                if (method === 'HEAD') {
                    closeSessionGracefully();
                    return resolve({ statusCode, headers });
                }
                if (streamOnly) {
                    responseStream.on('end', closeSessionGracefully);
                    responseStream.on('error', closeSessionGracefully);
                    responseStream.on('close', closeSessionGracefully);
                    return resolve({ statusCode, headers, stream: responseStream });
                }
                try {
                    const chunks = [];
                    let bufferedBytes = 0;
                    for await (const chunk of responseStream) {
                        const bufferChunk = chunk;
                        bufferedBytes += bufferChunk.length;
                        if (bufferedBytes > maxResponseBodyBytes) {
                            throw new Error(`Response body too large for ${urlString} (${bufferedBytes} bytes > ${maxResponseBodyBytes} bytes)`);
                        }
                        chunks.push(bufferChunk);
                    }
                    const text = Buffer.concat(chunks).toString();
                    const contentTypeHeader = headers['content-type'];
                    const contentType = Array.isArray(contentTypeHeader)
                        ? contentTypeHeader[0]
                        : contentTypeHeader || '';
                    const isJson = contentType
                        .toLowerCase()
                        .startsWith('application/json');
                    const responseBody = isJson && text ? JSON.parse(text) : text;
                    if (loggingConfig.debug?.network) {
                        const bodySnippet = typeof responseBody === 'string'
                            ? responseBody.substring(0, 200)
                            : JSON.stringify(responseBody).substring(0, 200);
                        logger('debug', 'Network', `[${logId}] Response Status: ${statusCode}`);
                        logger('debug', 'Network', `[${logId}] Response Body: ${bodySnippet}${bodySnippet.length === 200 ? '...' : ''}`);
                    }
                    resolve({
                        statusCode,
                        headers,
                        body: responseBody
                    });
                }
                catch (err) {
                    resolve({
                        statusCode,
                        headers,
                        error: err instanceof Error ? err.message : String(err)
                    });
                }
                finally {
                    if (!streamOnly)
                        closeSessionGracefully();
                }
            });
            if (body && !['GET', 'HEAD'].includes(method)) {
                if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
                    req.end(Buffer.from(body));
                }
                else {
                    const payload = JSON.stringify(body);
                    if (disableBodyCompression ||
                        h2Headers['content-encoding'] !== 'gzip') {
                        req.end(payload);
                    }
                    else {
                        zlib.gzip(payload, (err, data) => {
                            if (err) {
                                req.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
                                closeSessionGracefully();
                                return reject(new Error(`Gzip error for ${urlString}: ${err.message}`));
                            }
                            req.end(data);
                        });
                    }
                }
            }
            else {
                req.end();
            }
        }
        catch {
            if (session && !session.closed && !session.destroyed && !sessionClosed) {
                session.close();
            }
            fallbackToHttp1();
        }
    });
}
/**
 * Checks for updates of core dependencies against the NPM registry.
 *
 * Logs a warning if an update is available for critical packages.
 * @public
 */
/**
 * Checks for updates of core dependencies against the NPM registry and GitHub.
 *
 * Logs a warning if an update is available for critical packages.
 * @param credentialManager - Persistence manager to rate-limit checks.
 * @public
 */
async function checkDependencyUpdates(credentialManager) {
    const coreDeps = [
        '@performanc/voice',
        '@performanc/pwsl-server',
        '@toddynnn/symphonia-decoder',
        '@toddynnn/voice-opus',
        '@ecliptia/faad2-wasm',
        '@alexanderolsen/libsamplerate-js',
        '@ecliptia/seekable-stream',
        'mp4box'
    ];
    const localVersions = [];
    for (const dep of coreDeps) {
        try {
            const depPath = path.join(process.cwd(), 'node_modules', dep, 'package.json');
            const version = JSON.parse(fs.readFileSync(depPath, 'utf8')).version;
            localVersions.push({ name: dep, version });
        }
        catch {
            // Ignore if package not found
        }
    }
    if (localVersions.length > 0) {
        logger('info', 'Server', `Installed core packages: ${localVersions.map((v) => `${v.name}@${v.version}`).join(', ')}`);
    }
    const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
    const now = Date.now();
    let latestVersions = {};
    let isCacheValid = false;
    if (credentialManager) {
        const cache = credentialManager.get('runtime.dependencies.latest');
        if (cache && now - cache.ts < CHECK_INTERVAL_MS) {
            latestVersions = cache.versions;
            isCacheValid = true;
        }
    }
    if (!isCacheValid) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        try {
            const deps = packageJson
                .dependencies || {};
            await Promise.all(coreDeps.map(async (dep) => {
                try {
                    const declaredVersion = deps[dep] || '';
                    let latestVersionStr = '';
                    let source = 'NPM';
                    if (declaredVersion.startsWith('github:') ||
                        (declaredVersion.includes('/') && !declaredVersion.includes(':'))) {
                        source = 'GitHub';
                        const repo = declaredVersion.replace('github:', '').split('#')[0];
                        const branch = declaredVersion.split('#')[1] || 'main';
                        const response = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/package.json`, { signal: controller.signal });
                        if (response.ok) {
                            const data = (await response.json());
                            latestVersionStr = data.version;
                        }
                    }
                    else if (!declaredVersion.includes(':') &&
                        !declaredVersion.includes('/')) {
                        const response = await fetch(`https://registry.npmjs.org/${dep}/latest`, {
                            signal: controller.signal
                        });
                        if (response.ok) {
                            const data = (await response.json());
                            latestVersionStr = data.version;
                        }
                    }
                    if (latestVersionStr) {
                        latestVersions[dep] = { version: latestVersionStr, source };
                    }
                }
                catch {
                    // Ignore individual failures
                }
            }));
            if (credentialManager && Object.keys(latestVersions).length > 0) {
                credentialManager.set('runtime.dependencies.latest', { ts: now, versions: latestVersions }, 24 * 60 * 60 * 1000);
            }
        }
        catch (error) {
            logger('debug', 'Server', `Failed to check dependency updates: ${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
            clearTimeout(timeout);
        }
    }
    const updates = [];
    for (const local of localVersions) {
        const latest = latestVersions[local.name];
        if (!latest || local.version === latest.version)
            continue;
        const currentSemver = parseSemver(local.version);
        const latestSemver = parseSemver(latest.version);
        if (currentSemver && latestSemver) {
            const isNewer = latestSemver.major > currentSemver.major ||
                (latestSemver.major === currentSemver.major &&
                    latestSemver.minor > currentSemver.minor) ||
                (latestSemver.major === currentSemver.major &&
                    latestSemver.minor === currentSemver.minor &&
                    latestSemver.patch > currentSemver.patch);
            if (isNewer) {
                updates.push({
                    name: local.name,
                    current: local.version,
                    latest: latest.version,
                    source: latest.source
                });
            }
        }
    }
    if (updates.length > 0) {
        logger('warn', 'Server', 'The following core dependencies have updates available and will be automatically updated:');
        for (const update of updates) {
            logger('warn', 'Server', ` - ${update.name}: ${update.current} -> \x1b[1m\x1b[32m${update.latest}\x1b[0m (${update.source})`);
        }
        try {
            logger('info', 'Server', `Running automatic update for core packages...`);
            // pnpm and bun can be on the same path, so we check both
            // (referring to myself, im lazy to delete the pnpm lock file)
            const isBun = process.versions.bun &&
                fs.existsSync(path.resolve(process.cwd(), 'bun.lock'));
            const isPnpm = fs.existsSync(path.resolve(process.cwd(), 'pnpm-lock.yaml')) && !isBun;
            const pkgTargets = updates.map((u) => `"${u.name}@^${u.latest}"`).join(' ');
            const cmd = isPnpm
                ? `pnpm add ${pkgTargets}`
                : isBun
                    ? `bun add ${pkgTargets}`
                    : `npm install ${pkgTargets} --save`;
            execSync(cmd, { stdio: 'inherit' });
            // Verify that installed version actually changed to prevent infinite reboot loops
            const versionChanged = updates.some((update) => {
                try {
                    const depPath = path.join(process.cwd(), 'node_modules', update.name, 'package.json');
                    const newVer = JSON.parse(fs.readFileSync(depPath, 'utf8')).version;
                    return newVer !== update.current;
                }
                catch {
                    return false;
                }
            });
            if (!versionChanged) {
                logger('warn', 'Server', 'Dependency update did not change installed version. Skipping automatic restart to prevent boot loop.');
                return;
            }
            logger('info', 'Server', 'Dependencies updated successfully. Restarting process to apply changes...');
            const { spawn } = await import('node:child_process');
            const child = spawn(process.argv[0], process.argv.slice(1), {
                stdio: 'inherit',
                env: process.env
            });
            child.on('exit', (code) => {
                process.exit(code ?? 0);
            });
            // Halt execution of the parent process forever while the child runs
            await new Promise(() => { });
        }
        catch (error) {
            logger('error', 'Server', `Failed to auto-update dependencies: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    else if (Object.keys(latestVersions).length > 0) {
        logger('info', 'Server', 'All core packages are up to date.');
    }
}
/**
 * Checks for git updates against the upstream branch.
 *
 * Logs messages to the console without altering the working tree.
 * @public
 */
async function checkForUpdates() {
    logger('info', 'Git', 'Checking for updates...');
    try {
        const { exec } = await import('node:child_process');
        const util = await import('node:util');
        const execAsync = util.promisify(exec);
        await execAsync('git fetch', {
            stdio: 'ignore'
        });
        const { stdout: local } = await execAsync('git rev-parse HEAD', {
            encoding: 'utf8'
        });
        const { stdout: remote } = await execAsync('git rev-parse @{u}', {
            encoding: 'utf8'
        });
        if (local.trim() !== remote.trim()) {
            const { stdout: behind } = await execAsync('git rev-list --right-only --count HEAD...@{u}', {
                encoding: 'utf8'
            });
            const { stdout: remoteCommit } = await execAsync('git log -1 --pretty=format:"%h - %s (%cr)" @{u}', { encoding: 'utf8' });
            logger('warn', 'Git', `Your version is ${behind.trim()} commits behind the remote.`);
            logger('warn', 'Git', `Latest commit: ${remoteCommit.trim()}`);
            logger('warn', 'Git', 'Please run "git pull" to update.');
        }
        else {
            logger('info', 'Git', 'You are running the latest version.');
        }
    }
    catch (error) {
        logger('warn', 'Git', `Failed to check for updates: ${error instanceof Error ? error.message : String(error)}`);
    }
}
/**
 * Sends a standardized error response payload.
 *
 * The response payload includes timestamp, status, error label, and
 * optional stack trace.
 * @param req - API request object.
 * @param res - API response object.
 * @param status - HTTP status code.
 * @param error - Error label.
 * @param message - Error message.
 * @param path - Request path.
 * @param trace - Whether to include stack traces.
 * @public
 */
function sendErrorResponse(req, res, status, error, message, path, trace = false) {
    const errorPayload = {
        timestamp: Date.now(),
        status,
        error,
        trace: trace ? new Error().stack : undefined,
        message,
        path
    };
    sendResponse(req, res, errorPayload, status, trace);
}
/**
 * Destroys HTTP agents and clears cached HTTP/2 hosts.
 *
 * Useful during shutdown to free open sockets.
 * @public
 */
function cleanupHttpAgents() {
    try {
        httpAgent.destroy();
        httpsAgent.destroy();
        http2FailedHosts.clear();
        logger('info', 'Utils', 'HTTP agents cleaned up successfully');
    }
    catch (error) {
        logger('error', 'Utils', `Error cleaning up HTTP agents: ${error instanceof Error ? error.message : String(error)}`);
    }
}
/**
 * Applies environment variable overrides onto a config object.
 *
 * Values are coerced based on the existing config entry type. Arrays can be
 * provided as JSON or comma-separated strings.
 * @param config - Mutable configuration object.
 * @param prefix - Prefix for environment variable names.
 * @public
 */
function applyEnvOverrides(config, prefix = 'NODELINK') {
    for (const key in config) {
        if (!Object.hasOwn(config, key))
            continue;
        const envVarName = `${prefix}_${key.toUpperCase()}`;
        const envValue = process.env[envVarName];
        const currentValue = config[key];
        if (envValue !== undefined) {
            if (typeof currentValue === 'boolean') {
                config[key] = envValue.toLowerCase() === 'true';
            }
            else if (typeof currentValue === 'number') {
                const numValue = Number(envValue);
                if (!Number.isNaN(numValue)) {
                    config[key] = numValue;
                }
                else {
                    logger('warn', 'Config', `Environment variable ${envVarName} has non-numeric value "${envValue}"; expected a number, keeping default.`);
                }
            }
            else if (typeof currentValue === 'string') {
                config[key] = envValue;
            }
            else if (Array.isArray(currentValue)) {
                let newValue = null;
                try {
                    const parsedArray = JSON.parse(envValue);
                    if (Array.isArray(parsedArray))
                        newValue = parsedArray;
                }
                catch { }
                if (!newValue) {
                    const splitValue = envValue
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean);
                    if (splitValue.length > 0)
                        newValue = splitValue;
                }
                if (newValue) {
                    config[key] = newValue;
                }
                else {
                    logger('warn', 'Config', `Environment variable ${envVarName} has invalid array value "${envValue}"; keeping default.`);
                }
            }
        }
        else if (typeof currentValue === 'object' &&
            currentValue !== null &&
            !Array.isArray(currentValue)) {
            applyEnvOverrides(currentValue, envVarName);
        }
    }
}
/**
 * Selects the best match from a list of track candidates.
 *
 * Scoring factors include word overlap, spec keywords, author similarity,
 * duration tolerance, and explicit content handling.
 * @param list - Candidate list to score.
 * @param original - Original track metadata.
 * @param options - Scoring options.
 * @returns Best matching candidate or null.
 * @public
 */
export function getBestMatch(list, original, options = {}) {
    const { durationTolerance = 0.15, allowExplicit = true } = options;
    const normalize = (str) => {
        if (!str)
            return '';
        return str
            .toLowerCase()
            .replace(/feat\.?/g, '')
            .replace(/ft\.?/g, '')
            .replace(/\s*\([^)]*(official|video|audio|mv|visualizer|color\s*coded|hd|4k|prod\.)[^)]*\)/gi, '')
            .replace(/\s*\[[^\]]*(official|video|audio|mv|visualizer|color\s*coded|hd|4k|prod\.)[^\]]*\]/gi, '')
            .replace(/[^\w\s]/g, '')
            .trim();
    };
    const specKeywords = [
        'remix',
        'orchestral',
        'live',
        'cover',
        'acoustic',
        'instrumental',
        'karaoke',
        'radio',
        'edit',
        'extended',
        'slowed',
        'reverb'
    ];
    const findSpec = (str) => specKeywords.filter((k) => str.toLowerCase().includes(k));
    const originalTitle = original.title.toLowerCase();
    const originalSpec = findSpec(originalTitle);
    const isOriginalExplicit = original.uri?.includes('explicit=true') ||
        originalTitle.includes('explicit');
    const targetDuration = original.length;
    const allowedDiff = targetDuration * durationTolerance;
    const normOriginalAuthor = normalize(original.author);
    const originalWords = new Set(normalize(original.title)
        .split(' ')
        .filter((w) => w.length > 1));
    const scored = list.map((item) => {
        const itemTitle = item.info.title.toLowerCase();
        const normItemTitle = normalize(itemTitle);
        const normItemAuthor = normalize(item.info.author);
        const itemSpec = findSpec(itemTitle);
        const isItemClean = itemTitle.includes('clean') || itemTitle.includes('radio edit');
        let score = 0;
        const itemWords = normItemTitle.split(' ').filter((w) => w.length > 1);
        const itemWordsSet = new Set(itemWords);
        let overlap = 0;
        for (const word of originalWords) {
            if (itemWordsSet.has(word))
                overlap++;
        }
        score += (overlap / Math.max(originalWords.size, 1)) * 300;
        for (const spec of specKeywords) {
            const inOriginal = originalSpec.includes(spec);
            const inItem = itemSpec.includes(spec);
            if (inOriginal && inItem)
                score += 200;
            if (inOriginal !== inItem)
                score -= 300;
        }
        if (isOriginalExplicit && !allowExplicit) {
            if (isItemClean)
                score += 500;
        }
        if (normItemAuthor.includes(normOriginalAuthor) ||
            normOriginalAuthor.includes(normItemAuthor)) {
            score += 150;
        }
        else {
            const longer = normOriginalAuthor.length > normItemAuthor.length
                ? normOriginalAuthor
                : normItemAuthor;
            const shorter = normOriginalAuthor.length > normItemAuthor.length
                ? normItemAuthor
                : normOriginalAuthor;
            if (shorter.length > 2 && longer.includes(shorter))
                score += 100;
        }
        if (targetDuration > 0) {
            const diff = Math.abs(item.info.length - targetDuration);
            if (diff <= allowedDiff) {
                score += (1 - diff / allowedDiff) * 100;
            }
            else {
                score -= 100;
            }
        }
        if (itemTitle.includes('official audio') || itemTitle.includes('topic'))
            score += 50;
        return { item, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.item || list[0] || null;
}
/**
 * Cleans up logger resources and intervals.
 *
 * Stops rotation timers and closes the file stream if it is open.
 * @public
 */
function cleanupLogger() {
    if (logRotationInterval) {
        clearInterval(logRotationInterval);
        logRotationInterval = null;
    }
    if (logCleanupInterval) {
        clearInterval(logCleanupInterval);
        logCleanupInterval = null;
    }
    if (logStream) {
        logStream.end();
        logStream = null;
    }
}
/**
 * Fetches SponsorBlock segments for a YouTube video with privacy prefixing.
 *
 * Calculates the SHA256 prefix and queries the public SponsorBlock API,
 * then filters results for the exact video ID and maps them to the
 * local segment interface with milliseconds timestamps.
 *
 * @param videoId - Target YouTube video identifier.
 * @param categories - Array of categories to retrieve.
 * @param actionTypes - Array of action types to retrieve.
 * @param apiBase - Optional API base URL override.
 * @param proxy - Optional proxy for the request.
 * @returns Promise resolving to the list of segments found.
 * @public
 */
async function fetchSponsorBlockSegments(videoId, categories, actionTypes, apiBase = 'https://sponsor.ajay.app', proxy) {
    const hash = crypto.createHash('sha256').update(videoId).digest('hex');
    const prefix = hash.substring(0, 4);
    const params = new URLSearchParams();
    for (const cat of categories)
        params.append('category', cat);
    for (const action of actionTypes)
        params.append('actionType', action);
    const url = `${apiBase.replace(/\/+$/, '')}/api/skipSegments/${prefix}?${params.toString()}`;
    logger('debug', 'SponsorBlock', `Fetching segments for video ${videoId} (prefix: ${prefix}) from ${url}`);
    try {
        const startTime = Date.now();
        const result = await makeRequest(url, { method: 'GET', proxy });
        const duration = Date.now() - startTime;
        if (result.statusCode !== 200) {
            logger('warn', 'SponsorBlock', `API returned status ${result.statusCode} for video ${videoId} after ${duration}ms`);
            return [];
        }
        if (!Array.isArray(result.body)) {
            logger('debug', 'SponsorBlock', `No segments found for prefix ${prefix} (Status: ${result.statusCode}, Duration: ${duration}ms)`);
            return [];
        }
        const videoMatch = result.body.find((entry) => entry.videoID === videoId);
        if (!videoMatch?.segments) {
            logger('debug', 'SponsorBlock', `No exact match for video ${videoId} in prefix results (Results: ${result.body.length}, Duration: ${duration}ms)`);
            return [];
        }
        logger('debug', 'SponsorBlock', `Successfully loaded ${videoMatch.segments.length} segments for video ${videoId} in ${duration}ms`);
        return videoMatch.segments.map((s) => ({
            uuid: s.uuid,
            start: Math.round(s.start * 1000),
            end: Math.round(s.end * 1000),
            category: s.category,
            actionType: s.actionType,
            votes: s.votes,
            locked: s.locked,
            videoDuration: Math.round(s.videoDuration * 1000),
            description: s.description || ''
        }));
    }
    catch (error) {
        logger('warn', 'SponsorBlock', `Failed to fetch segments for video ${videoId}:`, error);
        return [];
    }
}
export { applyEnvOverrides, checkDependencyUpdates, checkForUpdates, cleanupHttpAgents, cleanupLogger, decodeTrack, encodeTrack, fetchSponsorBlockSegments, generateRandomLetters, getGitInfo, getStats, getVersion, http1makeRequest, initLogger, logger, makeRequest, parseClient, parseSemver, sendErrorResponse, sendResponse, validateProperty, verifyDiscordID, verifyMethod };
