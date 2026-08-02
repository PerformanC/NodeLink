var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATH_VERSION } from '../constants.js';
import { logger, sendErrorResponse, sendResponse, verifyMethod } from '../utils.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const defaultMethods = ['GET'];
const TRACE_BUFFER_MAX = 600;
const getTraceStore = () => {
    const g = globalThis;
    if (!g.__nodelinkTraceStore) {
        g.__nodelinkTraceStore = {
            requests: [],
            events: []
        };
    }
    return g.__nodelinkTraceStore;
};
const pushTrace = (key, entry) => {
    const store = getTraceStore();
    const target = store[key];
    target.push(entry);
    if (target.length > TRACE_BUFFER_MAX) {
        target.splice(0, target.length - TRACE_BUFFER_MAX);
    }
};
const getHeaderValue = (value) => (Array.isArray(value) ? value[0] : value);
const resolveRouteModule = (module) => {
    if ('default' in module && module.default) {
        return module.default;
    }
    return module;
};
const parseContentLength = (value) => {
    if (Array.isArray(value)) {
        return Number.parseInt(value[0] ?? '', 10);
    }
    if (typeof value === 'string') {
        return Number.parseInt(value, 10);
    }
    return Number.NaN;
};
/**
 * Loads and normalizes API route modules from the filesystem.
 * @remarks Static routes are stored by pathname, while dynamic routes use RegExp
 * matching to support parameterized paths like `/sessions/:id`.
 * @example
 * ```ts
 * const { staticRoutes } = await loadRoutes()
 * const route = staticRoutes.get('/v4/version')
 * ```
 * @internal
 */
async function loadRoutes() {
    const staticRoutes = new Map();
    const dynamicRoutes = [];
    try {
        const routeFiles = await fs.readdir(__dirname);
        for (const file of routeFiles) {
            if (file !== 'index.js' &&
                file !== 'index.ts' &&
                (file.endsWith('.js') || file.endsWith('.ts'))) {
                const filePath = join(__dirname, file);
                const fileUrl = new URL(`file://${filePath.replace(/\\/g, '/')}`);
                const routeModule = (await import(__rewriteRelativeImportExtension(fileUrl.href)));
                const module = resolveRouteModule(routeModule);
                const routeName = file.replace(/\.(js|ts)$/, '').toLowerCase();
                let pathname;
                if (routeName === 'version') {
                    pathname = '/version';
                }
                else if (routeName.includes('.')) {
                    const parts = routeName.split('.');
                    const basePattern = parts
                        .map((part) => (part === 'id' ? '(?:id|[A-Za-z0-9_-]+)' : part))
                        .join('/');
                    pathname = new RegExp(`^/${PATH_VERSION}/${basePattern}(?:/[A-Za-z0-9_-]+)?/?$`);
                }
                else {
                    pathname = `/${PATH_VERSION}/${routeName}`;
                }
                const routeData = {
                    handler: module.handler,
                    methods: module.methods ?? defaultMethods
                };
                if (pathname instanceof RegExp) {
                    dynamicRoutes.push([pathname, routeData]);
                }
                else {
                    staticRoutes.set(pathname, routeData);
                }
            }
        }
    }
    catch { }
    dynamicRoutes.sort((a, b) => b[0].source.length - a[0].source.length);
    return { staticRoutes, dynamicRoutes };
}
const routesPromise = loadRoutes();
/**
 * Main HTTP request handler for the NodeLink REST API.
 * @param nodelink - NodeLink server instance.
 * @param req - Incoming request (Node.js or Bun shim).
 * @param res - Response object (Node.js or Bun shim).
 * @example
 * ```ts
 * import http from 'node:http'
 * import RequestHandler from './api/index.ts'
 *
 * http.createServer((req, res) => RequestHandler(nodelink, req, res))
 * ```
 * @public
 */
async function requestHandler(nodelink, req, res) {
    const originalWriteHead = res.writeHead;
    res.writeHead = (status, headers) => {
        res.setHeader('Nodelink-Api-Version', '4');
        res.setHeader('IamNodelink', 'true');
        return originalWriteHead.call(res, status, headers);
    };
    const startTime = Date.now();
    const requestUrl = req.url ?? '/';
    const headerAccess = req.headers;
    const hostHeader = getHeaderValue(headerAccess.host);
    const parsedUrl = new URL(requestUrl, `http://${hostHeader ?? 'localhost'}`);
    const middlewares = nodelink.extensions?.middlewares;
    if (middlewares && Array.isArray(middlewares)) {
        for (const middleware of middlewares) {
            const result = await middleware(nodelink, req, res, parsedUrl);
            if (result === true)
                return;
        }
    }
    nodelink.statsManager.incrementApiRequest(parsedUrl.pathname);
    const trace = parsedUrl.searchParams.get('trace') === 'true';
    const remoteAddress = req.socket?.remoteAddress ?? 'unknown';
    const remotePort = req.socket?.remotePort;
    const isInternal = ['127.0.0.1', '::1', 'localhost'].includes(remoteAddress);
    const clientAddress = `${isInternal ? '[Internal]' : '[External]'} (${remoteAddress}:${remotePort ?? 'unknown'})`;
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const originalEnd = res.end.bind(res);
    res.end = (...args) => {
        const duration = Date.now() - startTime;
        nodelink.statsManager.recordHttpRequestDuration(parsedUrl.pathname, req.method, res.statusCode, duration);
        const meta = res;
        pushTrace('requests', {
            id: requestId,
            ts: Date.now(),
            method: req.method ?? 'GET',
            path: parsedUrl.pathname,
            status: res.statusCode,
            durationMs: duration,
            remoteAddress,
            remotePort: remotePort ?? null,
            userAgent: getHeaderValue(headerAccess['user-agent']) || null,
            reason: meta.__traceReason || null
        });
        originalEnd(...args);
    };
    const isMetricsEndpoint = parsedUrl.pathname === `/${PATH_VERSION}/metrics`;
    const isProfilerEndpoint = parsedUrl.pathname === `/${PATH_VERSION}/profiler` ||
        parsedUrl.pathname === `/${PATH_VERSION}/profiler/ui` ||
        parsedUrl.pathname === `/${PATH_VERSION}/profiler/file`;
    if (isMetricsEndpoint) {
        const metricsConfig = nodelink.options.api.metrics || {};
        if (!metricsConfig.enabled) {
            logger('warn', 'Metrics', `Metrics endpoint disabled - ${clientAddress} attempted to access ${parsedUrl.pathname}`);
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
            return;
        }
        const authConfig = metricsConfig.authorization || {};
        let authType = authConfig.type;
        if (authType !== 'Bearer' && authType !== 'Basic') {
            logger('warn', `Config: metrics authorization.type SHOULD BE one of 'Bearer', 'Basic'.... Defaulting to 'Bearer'!`);
            authType = 'Bearer';
        }
        const metricsUsername = authConfig.username || 'admin';
        const metricsPassword = authConfig.password || nodelink.options.server.password;
        const authHeader = getHeaderValue(headerAccess.authorization);
        const isValidAuth = authHeader === metricsPassword ||
            (authType === 'Bearer' && authHeader === `Bearer ${metricsPassword}`) ||
            (authType === 'Basic' &&
                typeof authHeader === 'string' &&
                authHeader.startsWith('Basic ') &&
                (() => {
                    try {
                        // 1. Decode the "user:pass" string
                        const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
                        // 2. Split by the first colon (passwords can contain colons!)
                        const colonIndex = decoded.indexOf(':');
                        if (colonIndex === -1)
                            return false; // Invalid format
                        const user = decoded.slice(0, colonIndex);
                        const pass = decoded.slice(colonIndex + 1);
                        return user === metricsUsername && pass === metricsPassword; // verify both
                    }
                    catch {
                        return false;
                    }
                })());
        if (!isValidAuth) {
            logger('warn', 'Metrics', `Unauthorized metrics access attempt from ${clientAddress} - Invalid password provided: ${authHeader || 'None'}`);
            res.__traceReason =
                'metrics_unauthorized';
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            res.end('Unauthorized');
            return;
        }
    }
    const dosCheck = nodelink.dosProtectionManager.check(req);
    if (!dosCheck.allowed) {
        logger('warn', 'DosProtection', `DoS protection triggered for ${clientAddress} on ${parsedUrl.pathname}`);
        res.__traceReason =
            'dos_protection';
        nodelink.statsManager.incrementDosProtectionBlock(remoteAddress, dosCheck.message);
        sendErrorResponse(req, res, dosCheck.status ?? 403, dosCheck.message ?? 'Forbidden', dosCheck.message ?? 'Forbidden', parsedUrl.pathname, trace);
        return;
    }
    if (dosCheck.delay) {
        await new Promise((resolve) => setTimeout(resolve, dosCheck.delay));
    }
    const rateLimitCheck = nodelink.rateLimitManager.check(req, parsedUrl);
    if (rateLimitCheck.limit !== undefined &&
        rateLimitCheck.remaining !== undefined &&
        rateLimitCheck.reset !== undefined) {
        res.setHeader('X-RateLimit-Limit', rateLimitCheck.limit);
        res.setHeader('X-RateLimit-Remaining', rateLimitCheck.remaining);
        res.setHeader('X-RateLimit-Reset', Math.ceil(rateLimitCheck.reset / 1000));
    }
    if (!rateLimitCheck.allowed) {
        logger('warn', 'RateLimit', `Rate limit exceeded for ${clientAddress} on ${parsedUrl.pathname}`);
        res.__traceReason =
            'rate_limited';
        nodelink.statsManager.incrementRateLimitHit(parsedUrl.pathname, remoteAddress);
        const resetTime = rateLimitCheck.reset ?? Date.now();
        const retryAfter = Math.ceil((resetTime - Date.now()) / 1000);
        res.setHeader('Retry-After', retryAfter);
        sendErrorResponse(req, res, 429, 'Too Many Requests', 'You are sending too many requests. Please try again later.', parsedUrl.pathname, trace);
        return;
    }
    if (!isMetricsEndpoint && !isProfilerEndpoint) {
        const authHeader = getHeaderValue(headerAccess.authorization);
        if (!authHeader ||
            (authHeader !== nodelink.options.server.password &&
                authHeader !== `Bearer ${nodelink.options.server.password}`)) {
            logger('warn', 'Server', `Unauthorized connection attempt from ${clientAddress} - Invalid password provided: ${authHeader || 'None'}`);
            res.__traceReason =
                'api_unauthorized';
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            res.end('Unauthorized');
            return;
        }
    }
    const MAX_BODY_SIZE = nodelink.options.server?.maxBodySize || 10 * 1024 * 1024;
    let body = '';
    let parsedBody = body;
    if (req.method !== 'GET') {
        const contentLength = parseContentLength(headerAccess['content-length']);
        if (!Number.isNaN(contentLength) && contentLength > MAX_BODY_SIZE) {
            logger('warn', 'Server', `Request rejected: Content-Length ${contentLength} exceeds limit of ${MAX_BODY_SIZE}`);
            res.__traceReason =
                'payload_too_large';
            sendErrorResponse(req, res, 413, 'Payload Too Large', 'Request body is too large.', parsedUrl.pathname, trace);
            req.destroy?.();
            return;
        }
        await new Promise((resolve) => {
            if (typeof req.on !== 'function') {
                resolve();
                return;
            }
            let receivedSize = 0;
            const onData = (chunk) => {
                receivedSize += chunk.length;
                if (receivedSize > MAX_BODY_SIZE) {
                    logger('warn', 'Server', `Request rejected: Body size exceeded limit of ${MAX_BODY_SIZE}`);
                    res.__traceReason =
                        'payload_too_large';
                    req.removeListener?.('data', onData);
                    req.removeListener?.('end', onEnd);
                    sendErrorResponse(req, res, 413, 'Payload Too Large', 'Request body is too large.', parsedUrl.pathname, trace);
                    req.destroy?.();
                    resolve();
                }
                body += chunk.toString();
            };
            const onEnd = () => {
                try {
                    const contentType = getHeaderValue(headerAccess['content-type']);
                    if (contentType?.includes('application/json') && body) {
                        parsedBody = JSON.parse(body);
                    }
                }
                catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    logger('error', 'Server', `Failed to parse JSON body: ${errorMessage}. Path: ${parsedUrl.pathname}, Content-Type: ${getHeaderValue(headerAccess['content-type']) || 'N/A'}, Raw Body: '${body}', Headers: ${JSON.stringify(req.headers)}`);
                    pushTrace('events', {
                        ts: Date.now(),
                        type: 'json_parse_error',
                        path: parsedUrl.pathname,
                        method: req.method ?? 'UNKNOWN',
                        message: errorMessage
                    });
                    res.__traceReason =
                        'invalid_json';
                    sendErrorResponse(req, res, 400, 'Invalid JSON', errorMessage || 'Failed to parse JSON body', parsedUrl.pathname, trace);
                    return;
                }
                resolve();
            };
            req.on('data', onData);
            req.on('end', onEnd);
        });
    }
    req.body = parsedBody;
    headerAccess.authorization = '[REDACTED]';
    headerAccess.host = '[REDACTED]';
    if (!isMetricsEndpoint) {
        logger('info', 'Request', `${req.method} | ${clientAddress} [${getHeaderValue(headerAccess['user-agent'])}] - ${parsedUrl.pathname} ${JSON.stringify(req.headers)}${req.body ? `\nBody: ${JSON.stringify(req.body)}` : ''}`);
    }
    const { staticRoutes, dynamicRoutes } = await routesPromise;
    const staticRoute = staticRoutes.get(parsedUrl.pathname);
    if (staticRoute) {
        if (!verifyMethod(parsedUrl, req, res, staticRoute.methods, clientAddress, trace))
            return;
        staticRoute.handler(nodelink, req, res, sendResponse, parsedUrl);
        return;
    }
    const customRoutes = nodelink.extensions?.routes;
    if (customRoutes && Array.isArray(customRoutes)) {
        const customRoute = customRoutes.find((r) => r.path === parsedUrl.pathname);
        if (customRoute) {
            if (!verifyMethod(parsedUrl, req, res, customRoute.method ? [customRoute.method] : defaultMethods, clientAddress, trace))
                return;
            customRoute.handler(nodelink, req, res, sendResponse, parsedUrl);
            return;
        }
    }
    for (const [regex, route] of dynamicRoutes) {
        if (regex.test(parsedUrl.pathname)) {
            if (!verifyMethod(parsedUrl, req, res, route.methods, clientAddress, trace))
                return;
            route.handler(nodelink, req, res, sendResponse, parsedUrl);
            return;
        }
    }
    logger('warn', 'Request', `${req.method} | ${clientAddress} - ${parsedUrl.pathname} not found (response 404)`);
    res.__traceReason = 'not_found';
    sendErrorResponse(req, res, 404, 'Not Found', 'The requested route was not found.', parsedUrl.pathname, trace);
}
export default requestHandler;
