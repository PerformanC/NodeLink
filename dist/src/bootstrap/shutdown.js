import process from 'node:process';
import { cleanupHttpAgents, cleanupLogger, logger } from '../utils.js';
import { printShutdownMessage } from './branding.js';
function setupGracefulShutdown(nserver) {
    let isShuttingDown = false;
    const shutdown = async () => {
        if (isShuttingDown)
            return;
        isShuttingDown = true;
        if (nserver.workerManager) {
            nserver.workerManager.isDestroying = true;
        }
        nserver.emit('shutdown');
        printShutdownMessage();
        logger('info', 'Server', 'Shutdown signal received. Releasing resources...');
        nserver._stopHeartbeat();
        await nserver.credentialManager?.forceSave();
        await nserver.trackCacheManager?.forceSave();
        nserver.sourceWorkerManager?.destroy();
        nserver.workerManager?.destroy();
        nserver.connectionManager?.destroy();
        nserver.proxyManager?.destroy();
        nserver.routePlanner?.dispose();
        nserver.credentialManager?.destroy();
        nserver.trackCacheManager?.destroy();
        await nserver._cleanupWebSocketServer();
        const httpServer = nserver.server;
        if (httpServer?.listening) {
            await new Promise((resolve) => httpServer.close(() => resolve()));
            logger('info', 'Server', 'HTTP server closed.');
        }
        cleanupHttpAgents();
        nserver.rateLimitManager.destroy();
        nserver.dosProtectionManager.destroy();
        cleanupLogger();
        process.exit(0);
    };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
}
export { setupGracefulShutdown };
