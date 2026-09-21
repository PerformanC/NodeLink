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
        await nserver.stop();
        cleanupHttpAgents();
        cleanupLogger();
        process.exit(0);
    };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
}
export { setupGracefulShutdown };
