import process from 'node:process';
import { GatewayEvents } from '../constants.js';
import { logger } from '../utils.js';
function setupClusterWorkerSocket(server) {
    logger('info', 'Server', 'Running as cluster worker — waiting for sockets from master.');
    process.on('message', (msg, handle) => {
        if (msg?.type !== 'sticky-session' || !handle)
            return;
        try {
            try {
                handle.pause?.();
            }
            catch { }
            ;
            server.emit('connection', handle);
        }
        catch (err) {
            const error = err;
            logger('error', 'Server', `Failed to inject socket from master: ${error.message}`);
            try {
                handle.destroy?.();
            }
            catch { }
        }
    });
}
function _groupAffectedGuilds(affectedGuilds) {
    const grouped = new Map();
    for (const playerKey of affectedGuilds) {
        const [sessionId, guildId] = playerKey.split(':');
        if (!sessionId || !guildId)
            continue;
        const guilds = grouped.get(sessionId);
        if (guilds) {
            guilds.push(guildId);
        }
        else {
            grouped.set(sessionId, [guildId]);
        }
    }
    return grouped;
}
function broadcastWorkerFailure(sessions, workerId, affectedGuilds) {
    logger('warn', 'Cluster', `Worker ${workerId} failed. Notifying affected guilds: ${affectedGuilds.join(', ')}`);
    for (const [sessionId, guilds] of _groupAffectedGuilds(affectedGuilds)) {
        const socket = sessions.get(sessionId)?.socket;
        if (!socket)
            continue;
        socket.send(JSON.stringify({
            op: 'event',
            type: 'WorkerFailedEvent',
            affectedGuilds: guilds,
            message: `Players for guilds ${guilds.join(', ')} lost due to worker failure.`
        }));
        for (const guildId of guilds) {
            socket.send(JSON.stringify({
                op: 'event',
                type: GatewayEvents.WEBSOCKET_CLOSED,
                guildId,
                code: 5001,
                reason: 'worker_failed',
                byRemote: false
            }));
        }
    }
}
export { broadcastWorkerFailure, setupClusterWorkerSocket };
