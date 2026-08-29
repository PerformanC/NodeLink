import { EventEmitter } from 'node:events';
import { logger, parseClient, verifyDiscordID } from '../utils.js';
const VOICE_PATH_RE = /^\/v4\/websocket\/voice\/([A-Za-z0-9]+)\/?$/;
const LIVE_PATH_RE = /^\/v4\/websocket\/youtube\/live\/([^/]+)\/?$/;
/**
 * Wrapper for Bun's ServerWebSocket that implements EventEmitter
 * Provides compatibility with Node.js WebSocket implementations
 */
export class BunSocketWrapper extends EventEmitter {
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
 * Creates and configures Bun HTTP server with WebSocket support
 * @param context - Server context (NodelinkServer subset)
 * @param getRequestHandler - Lazy loader for the API request handler
 * @returns The created Bun server instance
 * @internal
 */
export function createBunServer(context, getRequestHandler) {
    const port = context.options.server.port;
    const host = context.options.server.host || '0.0.0.0';
    const password = context.options.server.password;
    logger('warn', 'Server', 'Running with Bun.serve, remember this is experimental!');
    const server = Bun.serve({
        port,
        hostname: host,
        maxRequestBodySize: 1024 * 1024 * 50,
        idleTimeout: 60,
        error(error) {
            logger('error', 'Server', `HTTP server error: ${error instanceof Error ? error.message : String(error)}`);
            return new Response('Internal Server Error', { status: 500 });
        },
        async fetch(req, server) {
            const url = new URL(req.url);
            const pathname = url.pathname.endsWith('/')
                ? url.pathname.slice(0, -1)
                : url.pathname;
            if (pathname === '/v4/profiler/socket') {
                const remoteAddress = server.requestIP(req)?.address || 'unknown';
                const isInternal = /^(::1|localhost|127\.0\.0\.1)/.test(remoteAddress);
                const endpoint = context.options.cluster?.endpoint || {};
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
                        url: req.url,
                        pathname,
                        eventName: '/v4/profiler/socket',
                        routeId: null
                    }
                });
                if (success)
                    return undefined;
                return new Response('WebSocket upgrade failed', { status: 400 });
            }
            const voiceMatch = pathname.match(VOICE_PATH_RE);
            const liveMatch = pathname.match(LIVE_PATH_RE);
            const isMainWs = pathname === '/v4/websocket';
            if (isMainWs || voiceMatch || liveMatch) {
                const remoteAddress = server.requestIP(req)?.address || 'unknown';
                const clientAddress = `[External] (${remoteAddress})`;
                const clientName = req.headers.get('client-name');
                const auth = req.headers.get('authorization');
                const userId = req.headers.get('user-id');
                let sessionId = req.headers.get('session-id');
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
                let eventName = '/v4/websocket';
                let routeId = null;
                if (voiceMatch) {
                    if (!context.options.playback.voiceReceive?.enabled) {
                        return new Response('Voice receive disabled.', {
                            status: 404,
                            statusText: 'Not Found',
                            headers: {
                                'Nodelink-Api-Version': '4',
                                IamNodelink: 'true'
                            }
                        });
                    }
                    eventName = '/v4/websocket/voice';
                    routeId = voiceMatch[1] ?? null;
                }
                else if (liveMatch) {
                    eventName = '/v4/websocket/youtube/live';
                    routeId = liveMatch[1] ?? null;
                }
                if (sessionId && !context.sessions.resumableSessions.has(sessionId)) {
                    logger('warn', 'Server', `Session-ID provided by ${clientAddress} does not exist or is not resumable: ${sessionId}, creating a new session`);
                    sessionId = null;
                }
                const success = server.upgrade(req, {
                    data: {
                        clientInfo,
                        sessionId,
                        reqHeaders: Object.fromEntries(req.headers),
                        remoteAddress,
                        url: req.url,
                        pathname,
                        eventName,
                        routeId
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
                const data = [];
                const end = [];
                const err = [];
                let triggered = false;
                const emitEnd = () => {
                    for (const f of end)
                        try {
                            f();
                        }
                        catch { }
                };
                const trigger = () => {
                    if (triggered)
                        return;
                    triggered = true;
                    const len = Number(req.headers.get('content-length'));
                    const hasBody = (Number.isFinite(len) && len > 0) ||
                        !!req.headers.get('transfer-encoding');
                    if (!hasBody || !req.body) {
                        queueMicrotask(emitEnd);
                        return;
                    }
                    req
                        .arrayBuffer()
                        .then((buf) => {
                        if (buf.byteLength) {
                            const chunk = Buffer.from(buf);
                            for (const f of data)
                                try {
                                    f(chunk);
                                }
                                catch { }
                        }
                        emitEnd();
                    })
                        .catch((e) => {
                        const er = e instanceof Error ? e : new Error(String(e));
                        if (err.length)
                            for (const f of err)
                                try {
                                    f(er);
                                }
                                catch { }
                        else
                            logger('debug', 'Server', `Bun request body read failed: ${er.message}`);
                        emitEnd();
                    });
                };
                const reqShim = {
                    method: req.method,
                    url: url.pathname + url.search,
                    headers: Object.fromEntries(req.headers),
                    socket: { remoteAddress: server.requestIP(req)?.address },
                    on: (ev, cb) => {
                        if (ev === 'data') {
                            data.push(cb);
                            trigger();
                        }
                        else if (ev === 'end') {
                            end.push(cb);
                            trigger();
                        }
                        else if (ev === 'error')
                            err.push(cb);
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
                        let finalBody;
                        if (this._body.length === 0) {
                            finalBody = '';
                        }
                        else if (this._body.length === 1 &&
                            Buffer.isBuffer(this._body[0])) {
                            finalBody = this._body[0];
                        }
                        else {
                            finalBody = Buffer.concat(this._body.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
                        }
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
                    .then((handler) => handler(context, reqShim, resShim))
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
            idleTimeout: 120,
            maxPayloadLength: 1024 * 1024 * 16,
            data: {},
            open(ws) {
                if (!ws.data) {
                    try {
                        ws.close(1011, 'Missing socket data');
                    }
                    catch { }
                    return;
                }
                const wrapper = new BunSocketWrapper(ws);
                ws.data.wrapper = wrapper;
                const { clientInfo, sessionId, reqHeaders, pathname, eventName, routeId } = ws.data;
                const reqShim = {
                    headers: reqHeaders,
                    url: ws.data.url,
                    socket: { remoteAddress: ws.data.remoteAddress }
                };
                if (pathname === '/v4/profiler/socket') {
                    logger('info', 'ProfilerSocket', `Profiler socket connected from [External] (${ws.data.remoteAddress})`);
                    context.socket?.emit('/v4/profiler/socket', wrapper, reqShim, null, null);
                    return;
                }
                logger('info', 'Server', `\x1b[36m${clientInfo.name}\x1b[0m${clientInfo.version ? `/\x1b[32mv${clientInfo.version}\x1b[0m` : ''} connected from [External] (${ws.data.remoteAddress}) | \x1b[33mURL:\x1b[0m ${ws.data.url}`);
                if (context.socket) {
                    context.socket.emit(eventName ?? '/v4/websocket', wrapper, reqShim, clientInfo, sessionId, routeId ?? null);
                }
            },
            message(ws, message) {
                const wrapper = ws.data?.wrapper;
                if (!wrapper) {
                    logger('debug', 'WebSocket', `Bun message received without wrapper (remote: ${ws.data?.remoteAddress || 'unknown'})`);
                    return;
                }
                wrapper._handleMessage(message);
            },
            close(ws, code, reason) {
                const wrapper = ws.data?.wrapper;
                if (!wrapper) {
                    logger('debug', 'WebSocket', `Bun close received without wrapper (code: ${code}, remote: ${ws.data?.remoteAddress || 'unknown'})`);
                    return;
                }
                wrapper._handleClose(code, reason);
            },
            // `error` is documented in Bun.serve docs but missing from
            // bun-types@1.3.14 typings; cast keeps runtime behaviour while
            // satisfying the type checker.
            ...{
                error(ws, err) {
                    logger('error', 'WebSocket', `Bun WebSocket error from ${ws.data?.remoteAddress || 'unknown'}: ${err.message}`);
                    const wrapper = ws.data?.wrapper;
                    if (wrapper && wrapper.listenerCount('error') > 0) {
                        try {
                            wrapper.emit('error', err);
                        }
                        catch { }
                    }
                }
            }
        }
    });
    logger('started', 'Server', `Successfully listening on ${host}:${port} (Bun Native)`);
    return server;
}
/**
 * Cleans up Bun WebSocket server resources
 * @param context - Server context
 * @param server - The Bun server instance to clean up
 * @internal
 */
export async function cleanupBunServer(context, server) {
    try {
        logger('info', 'WebSocket', 'Stopping Bun server...');
        // Gracefully close every active session with the same code Node uses,
        // so clients see a clean 1000 close frame and reconnect normally.
        // Without this, Bun.stop(true) tears TCP connections down without
        // sending close frames, surfacing as ECONNRESET on the client.
        let closedCount = 0;
        for (const session of context.sessions.activeSessions.values()) {
            if (!session.socket)
                continue;
            try {
                session.socket.close(1000, 'Server shutdown');
                closedCount++;
            }
            catch (_e) {
                try {
                    ;
                    session.socket.destroy?.();
                }
                catch (_destroyErr) {
                    logger('debug', 'WebSocket', `Failed to close/destroy socket for session ${session.id}`);
                }
            }
        }
        context.sessions.activeSessions.clear();
        context.sessions.resumableSessions.clear();
        logger('info', 'WebSocket', `Signalled close to ${closedCount} WebSocket connection(s)`);
        // Prefer graceful stop so the close frames above flush. If clients
        // don't drain within 1.5s (slow networks, half-open peers), fall
        // back to force-stop so shutdown still completes promptly.
        await new Promise((resolveStop) => {
            let settled = false;
            const finish = () => {
                if (settled)
                    return;
                settled = true;
                resolveStop();
            };
            const forceTimer = setTimeout(() => {
                server.stop(true).then(finish, finish);
            }, 1500);
            server.stop(false).then(() => {
                clearTimeout(forceTimer);
                finish();
            }, () => {
                clearTimeout(forceTimer);
                server.stop(true).then(finish, finish);
            });
        });
        try {
            server.unref();
        }
        catch { }
        logger('info', 'WebSocket', 'Bun server stopped successfully');
    }
    catch (e) {
        const error = e;
        logger('error', 'WebSocket', `Error stopping Bun server: ${error?.message ?? String(e)}`);
    }
}
