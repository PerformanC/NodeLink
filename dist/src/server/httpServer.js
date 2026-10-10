import http from 'node:http';
import process from 'node:process';
import { logger } from '../utils.js';
import { trackSocketRelease } from './socketRelease.js';
import { handleHttpUpgrade } from './wsRouter.js';
/* INFO: Creates and configures native Node.js HTTP server with socket pool guards, DoS defense, and upgrade routing */
function createHttpServer(nodelink, getRequestHandler) {
    const server = http.createServer((req, res) => {
        nodelink.pluginManager.callHook('onRESTRequest', req, res);
        if (res.writableEnded)
            return;
        void getRequestHandler()
            .then((handler) => handler(nodelink, req, res))
            .catch((error) => {
            logger('error', 'Server', `Failed to handle HTTP request: ${error.message}`);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
            }
            res.end('Internal Server Error');
        });
    });
    /* INFO: Anti-Slowloris and high-throughput timeout calibration */
    server.keepAliveTimeout = nodelink.options.server?.keepAliveTimeout ?? 15000;
    server.headersTimeout = nodelink.options.server?.headersTimeout ?? 15000;
    server.requestTimeout = nodelink.options.server?.bodyTimeout ?? 30000;
    /* INFO: Guard all incoming sockets against DoS blocks, connection floods, and reset errors */
    server.on('connection', (socket) => {
        const remoteAddress = socket.remoteAddress;
        const connectionAllowed = nodelink.admissionManager.admitConnection(remoteAddress);
        if (!connectionAllowed) {
            socket.destroy();
            return;
        }
        trackSocketRelease(socket, () => nodelink.admissionManager.releaseConnection(remoteAddress));
        socket.on('error', (err) => {
            const isBenign = err?.code === 'EPIPE' || err?.code === 'ECONNRESET';
            if (isBenign)
                return;
            logger('debug', 'Server', `HTTP socket error: ${err.message}`);
        });
    });
    server.on('clientError', (err, socket) => {
        const isBenign = err?.code === 'EPIPE' || err?.code === 'ECONNRESET';
        if (!isBenign) {
            logger('debug', 'Server', `HTTP client error: ${err.message}`);
        }
        try {
            if (!socket.destroyed)
                socket.destroy();
        }
        catch { }
    });
    server.on('upgrade', (request, socket, head) => {
        handleHttpUpgrade(nodelink, request, socket, head);
    });
    return server;
}
/* INFO: Starts listening on configured port and host with descriptive network error diagnostics */
function listenHttpServer(server, host, port) {
    server.on('error', (err) => {
        switch (err.code) {
            case 'EADDRINUSE':
                logger('error', 'Server', `Port ${port} is already in use.`);
                break;
            case 'EADDRNOTAVAIL':
                logger('error', 'Server', `The address ${host} is not available on this machine.`);
                logger('error', 'Server', 'Please check your "host" configuration. Use "0.0.0.0" to listen on all interfaces.');
                break;
            default:
                logger('error', 'Server', `Failed to start server: ${err.message}`);
                break;
        }
        process.exit(1);
    });
    server.listen(port, host, () => {
        logger('started', 'Server', `Successfully listening on host ${host}, port ${port}`);
    });
}
export { createHttpServer, listenHttpServer };
