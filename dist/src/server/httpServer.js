import http from 'node:http';
import process from 'node:process';
import { logger } from '../utils.js';
import { handleHttpUpgrade } from './wsRouter.js';
/* INFO: Creates and configures native Node.js HTTP server with socket error guards and upgrade routing */
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
    /* INFO: Tune keep-alive settings for high-throughput gateway traffic */
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;
    /* INFO: Guard all incoming sockets against EPIPE and ECONNRESET races */
    server.on('connection', (socket) => {
        socket.on('error', (err) => {
            if (err?.code === 'EPIPE' || err?.code === 'ECONNRESET')
                return;
            logger('debug', 'Server', `HTTP socket error: ${err.message}`);
        });
    });
    server.on('clientError', (err, socket) => {
        if (err?.code !== 'EPIPE' && err?.code !== 'ECONNRESET') {
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
        if (err.code === 'EADDRINUSE') {
            logger('error', 'Server', `Port ${port} is already in use.`);
        }
        else if (err.code === 'EADDRNOTAVAIL') {
            logger('error', 'Server', `The address ${host} is not available on this machine.`);
            logger('error', 'Server', 'Please check your "host" configuration. Use "0.0.0.0" to listen on all interfaces.');
        }
        else {
            logger('error', 'Server', `Failed to start server: ${err.message}`);
        }
        process.exit(1);
    });
    server.listen(port, host, () => {
        logger('started', 'Server', `Successfully listening on host ${host}, port ${port}`);
    });
}
export { createHttpServer, listenHttpServer };
