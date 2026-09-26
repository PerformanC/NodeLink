import { getGitInfo, getVersion, logger } from '../../utils.js';
import { UpdateManager } from './updater.js';
function getActivePlayerCount(server) {
    let count = 0;
    const sessions = server.sessions?.activeSessions;
    if (!sessions)
        return 0;
    for (const session of sessions.values()) {
        count += session.players?.players?.size ?? 0;
    }
    return count;
}
export function setupPeriodicUpdateCheck(server, config) {
    const autoUpdate = config.server.autoUpdate;
    if (!autoUpdate?.enabled ||
        !autoUpdate.checkInterval ||
        autoUpdate.checkInterval <= 0) {
        return null;
    }
    const updater = new UpdateManager(process.cwd());
    const intervalMs = autoUpdate.checkInterval;
    const channel = autoUpdate.channel ?? 'dev';
    const forceRestart = Boolean(autoUpdate.forceRestart);
    const drainTimeout = autoUpdate.drainTimeout ?? 2000;
    logger('info', 'Updater', `Periodic update check scheduled every ${Math.round(intervalMs / 1000 / 60)} minute(s) [channel: ${channel}, forceRestart: ${forceRestart}]`);
    const timer = setInterval(async () => {
        try {
            if (await updater.isLocked()) {
                logger('debug', 'Updater', 'Periodic check skipped: updater is currently locked');
                return;
            }
            const gitInfo = getGitInfo();
            const currentVersion = String(getVersion());
            const result = await updater.check(currentVersion, gitInfo.commit, channel);
            if (!result.available || !result.latest) {
                if (result.reason) {
                    logger('debug', 'Updater', `Periodic check: ${result.reason}`);
                }
                return;
            }
            const activePlayers = getActivePlayerCount(server);
            const activeSessions = server.sessions?.activeSessions.size ?? 0;
            if (activePlayers > 0) {
                if (forceRestart) {
                    logger('warn', 'Updater', `Update ${result.latest.version} available. forceRestart enabled: disconnecting ${activePlayers} active player(s) with code 5002...`);
                    await updater.applyUpdate(result.latest, server, drainTimeout);
                }
                else {
                    logger('info', 'Updater', `Update ${result.latest.version} is ready, but ${activePlayers} player(s) are active across ${activeSessions} session(s). Postponing until idle.`);
                }
                return;
            }
            logger('info', 'Updater', `Applying background update ${result.current.version} -> ${result.latest.version} (${result.latest.commit.slice(0, 7)})...`);
            await updater.applyUpdate(result.latest, server, drainTimeout);
        }
        catch (error) {
            logger('error', 'Updater', `Periodic update check failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }, intervalMs);
    server.once('shutdown', () => {
        clearInterval(timer);
        logger('debug', 'Updater', 'Periodic update check timer cleared on server shutdown');
    });
    return timer;
}
