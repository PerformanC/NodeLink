import { setTimeout as sleep } from 'node:timers/promises';
import { logger } from '../../utils.js';
export async function drainAndShutdown(server, reason = 'Server restarting for update', drainTimeout = 2000) {
    if (!server)
        return;
    const sessions = server.sessions?.activeSessions;
    const count = sessions?.size ?? 0;
    if (count > 0) {
        logger('info', 'Updater', `Gracefully disconnecting ${count} client session(s) with code 5002...`);
        for (const session of sessions.values()) {
            try {
                session.socket?.close(5002, reason);
            }
            catch (error) {
                logger('warn', 'Updater', `Error closing session socket: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        await sleep(drainTimeout);
    }
    try {
        await server.stop();
    }
    catch (error) {
        logger('warn', 'Updater', `Error stopping server: ${error instanceof Error ? error.message : String(error)}`);
    }
}
