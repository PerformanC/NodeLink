import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import { attachProfilerSocket } from '../api/profiler.socket.js';
import { decodeTrack, logger, parseClient, verifyDiscordID } from '../utils.js';
import { handleClientWebSocket } from './wsSession.js';
const VOICE_PATH_RE = /^\/v4\/websocket\/voice\/([A-Za-z0-9]+)\/?$/;
const LIVE_PATH_RE = /^\/v4\/websocket\/youtube\/live\/([^/]+)\/?$/;
const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/;
const INTERNAL_IPS = new Set([
    '127.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    'localhost'
]);
function _getHeader(headers, name) {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
}
function _isAuthorized(provided, expected) {
    if (!provided || expected.length === 0)
        return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function _rejectUpgrade(socket, status, statusText, body) {
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
}
class WebSocketStreamAdapter {
    headersSent = false;
    socket;
    constructor(socket) {
        this.socket = socket;
    }
    writeHead(status) {
        if (status !== 200) {
            this.socket.close(1011, 'Worker stream failed');
        }
    }
    write(data) {
        this._sendFrame(data);
    }
    send(data) {
        this._sendFrame(data);
    }
    end() {
        this.socket.close(1000, 'Stream finished');
    }
    on(event, cb) {
        this.socket.on(event, cb);
    }
    _sendFrame(data) {
        const isBinary = Buffer.isBuffer(data);
        const payload = isBinary ? data : Buffer.from(String(data));
        this.socket.sendFrame?.(payload, {
            len: payload.length,
            fin: true,
            opcode: isBinary ? 0x02 : 0x01
        });
    }
}
function _resolveYouTubeVideoId(context, rawIdentifier) {
    if (DISCORD_SNOWFLAKE_RE.test(rawIdentifier)) {
        const player = context.sessions.getPlayer(rawIdentifier);
        if (player?.track?.info?.sourceName?.includes('youtube')) {
            return player.track.info.identifier;
        }
    }
    else if (rawIdentifier.length > 50) {
        try {
            const decoded = decodeTrack(rawIdentifier);
            if (decoded?.info?.sourceName?.includes('youtube')) {
                return decoded.info.identifier;
            }
        }
        catch { }
    }
    return rawIdentifier;
}
function _handleProfilerUpgrade(context, request, socket, head, clientAddress, isInternal) {
    const reject = (reason) => {
        _rejectUpgrade(socket, 403, 'Forbidden', reason);
    };
    const url = new URL(request.url || '/', 'http://localhost');
    const endpoint = context.options.cluster?.endpoint || {};
    const patchEnabled = endpoint.patchEnabled === true;
    const allowExternal = endpoint.allowExternalPatch === true;
    const expectedCode = endpoint.code || 'CAPYBARA';
    const providedCode = url.searchParams.get('code') ||
        _getHeader(request.headers, 'x-nodelink-code') ||
        _getHeader(request.headers, 'x-worker-code');
    if (!patchEnabled) {
        reject('Profiler socket endpoint is disabled.');
        return;
    }
    if (!allowExternal && !isInternal) {
        reject('External profiler socket access is blocked.');
        return;
    }
    if (!_isAuthorized(providedCode, expectedCode)) {
        reject('Invalid or missing profiler authentication code.');
        return;
    }
    logger('info', 'ProfilerSocket', `Profiler socket connected from ${clientAddress} | URL: ${request.url}`);
    const wsServer = context.socket;
    wsServer?.handleUpgrade(request, socket, head, null, (ws) => {
        context.socket?.emit('/v4/profiler/socket', ws, request, { name: 'ProfilerUI', version: '1' }, null, null);
    });
}
function _handleGatewayUpgrade(context, request, socket, head, pathname, clientAddress) {
    const reject = (status, title, reason) => {
        logger('warn', 'Server', `Connection from ${clientAddress} rejected: ${reason}`);
        _rejectUpgrade(socket, status, title, reason);
    };
    const authHeader = _getHeader(request.headers, 'authorization');
    if (!_isAuthorized(authHeader, context.options.server?.password ?? '')) {
        reject(401, 'Unauthorized', 'Invalid password provided.');
        return;
    }
    const clientName = _getHeader(request.headers, 'client-name');
    const clientInfo = parseClient(clientName);
    if (!clientInfo) {
        reject(400, 'Bad Request', 'Invalid or missing Client-Name header.');
        return;
    }
    let sessionId = _getHeader(request.headers, 'session-id');
    if (sessionId && !context.sessions.resumableSessions.has(sessionId)) {
        logger('warn', 'Server', `Session-ID ${sessionId} from ${clientAddress} does not exist or expired. Creating new session.`);
        sessionId = undefined;
    }
    const voiceMatch = pathname.match(VOICE_PATH_RE);
    const liveMatch = pathname.match(LIVE_PATH_RE);
    const isGateway = pathname === '/v4/websocket' || Boolean(voiceMatch) || Boolean(liveMatch);
    if (!isGateway) {
        reject(404, 'Not Found', 'Invalid path for WebSocket upgrade.');
        return;
    }
    const userId = _getHeader(request.headers, 'user-id');
    if (!userId || !verifyDiscordID(userId)) {
        reject(400, 'Bad Request', 'Missing or invalid User-Id header.');
        return;
    }
    if (voiceMatch && !context.options.playback.voiceReceive?.enabled) {
        reject(404, 'Not Found', 'Voice receive is disabled on this server.');
        return;
    }
    const clientTag = `${clientInfo.name}${clientInfo.version ? ` v${clientInfo.version}` : ''}`;
    logger('info', 'Server', `${clientTag} connected from ${clientAddress}`);
    let eventName = '/v4/websocket';
    let routeId = null;
    if (voiceMatch) {
        eventName = '/v4/websocket/voice';
        routeId = voiceMatch[1] ?? null;
    }
    else if (liveMatch) {
        eventName = '/v4/websocket/youtube/live';
        routeId = liveMatch[1] ?? null;
    }
    const wsServer = context.socket;
    wsServer?.handleUpgrade(request, socket, head, null, (ws) => {
        context.socket?.emit(eventName, ws, request, clientInfo, sessionId, routeId);
    });
}
function handleHttpUpgrade(context, request, socket, head) {
    socket.on('error', (err) => {
        if (err?.code === 'EPIPE' || err?.code === 'ECONNRESET')
            return;
        logger('debug', 'Server', `Upgrade socket error: ${err.message}`);
    });
    const remoteAddress = request.socket.remoteAddress || 'unknown';
    const remotePort = request.socket.remotePort || 0;
    const isInternal = INTERNAL_IPS.has(remoteAddress);
    const clientAddress = `${isInternal ? '[Internal]' : '[External]'} (${remoteAddress}:${remotePort})`;
    const url = new URL(request.url || '/', 'http://localhost');
    const pathname = url.pathname;
    if (pathname === '/v4/profiler/socket') {
        _handleProfilerUpgrade(context, request, socket, head, clientAddress, isInternal);
        return;
    }
    _handleGatewayUpgrade(context, request, socket, head, pathname, clientAddress);
}
function setupWebSocketEvents(context) {
    if (!context.socket)
        return;
    context.socket.on('error', (error) => {
        logger('error', 'WebSocket', `WebSocket server error: ${error.message}`);
    });
    context.socket.on('/v4/websocket', (socket, request, clientInfo, sessionId) => {
        handleClientWebSocket(context, socket, request, clientInfo, sessionId);
    });
    context.socket.on('/v4/profiler/socket', (socket, request) => {
        attachProfilerSocket(context, socket, request);
    });
    context.socket.on('/v4/websocket/voice', (socket, _request, _client, _sessionId, guildId) => {
        logger('info', 'Voice', `Voice socket linked for guild ${guildId}`);
        context.registerVoiceSocket(guildId, socket);
    });
    context.socket.on('/v4/websocket/youtube/live', (socket, request, _client, _sessionId, id) => {
        const videoId = _resolveYouTubeVideoId(context, id);
        socket.guildId = id;
        if (!context.sourceWorkerManager) {
            const yt = context.sources?.getSource('youtube');
            if (yt?.handleLiveChat) {
                yt.handleLiveChat(socket, videoId);
            }
            else {
                socket.close(1008, 'YouTube live chat not supported');
            }
            return;
        }
        logger('info', 'YouTube-LiveChat', `Streaming live chat for video: ${videoId}`);
        const streamAdapter = new WebSocketStreamAdapter(socket);
        context.sourceWorkerManager.delegate(request, streamAdapter, 'loadLiveChat', { videoId }, { isWebSocket: true });
    });
}
async function cleanupWebSocketServer(server) {
    if (!server.socket)
        return;
    try {
        let closedCount = 0;
        for (const session of server.sessions.activeSessions.values()) {
            const socket = session.socket;
            if (!socket)
                continue;
            try {
                socket.close(1000, 'Server shutdown');
                closedCount++;
            }
            catch {
                try {
                    socket.destroy?.();
                }
                catch {
                    logger('debug', 'WebSocket', `Failed to close socket for session ${session.id}`);
                }
            }
        }
        server.sessions.activeSessions.clear();
        server.sessions.resumableSessions.clear();
        logger('info', 'WebSocket', `Closed ${closedCount} WebSocket connection(s) successfully`);
    }
    catch (error) {
        const err = error;
        logger('error', 'WebSocket', `Error closing WebSocket connections: ${err.message}`);
    }
}
export { cleanupWebSocketServer, handleHttpUpgrade, setupWebSocketEvents };
