import { Buffer } from 'node:buffer';
import cluster from 'node:cluster';
import process from 'node:process';
import { GatewayEvents } from '../constants.js';
import { getStats, logger } from '../utils.js';
function _countActiveMetrics(sessions) {
    let totalPlayers = 0;
    let playingPlayers = 0;
    let voiceConnections = 0;
    for (const session of sessions) {
        const players = session.players?.players;
        if (!players)
            continue;
        for (const player of players.values()) {
            totalPlayers++;
            if (!player.isPaused && player.track) {
                playingPlayers++;
            }
            if (player.connection) {
                voiceConnections++;
            }
        }
    }
    return { totalPlayers, playingPlayers, voiceConnections };
}
function _broadcastStatsPayload(sessions, payload) {
    for (const session of sessions) {
        try {
            session.socket?.send(payload);
        }
        catch { }
    }
}
function _checkSessionPlayers(session, now, zombieThresholdMs) {
    const players = session.players?.players;
    if (!players)
        return;
    for (const player of players.values()) {
        const isPlaying = Boolean(player.track && !player.isPaused && player.connection);
        if (!isPlaying)
            continue;
        const hasStalledStream = player.connStatus === 'connected' &&
            player._lastStreamDataTime > 0 &&
            now - player._lastStreamDataTime >= zombieThresholdMs;
        if (hasStalledStream) {
            logger('warn', 'Player', `Playback for guild ${player.guildId} appears stuck (no audio frames for ${zombieThresholdMs}ms).`);
            player.emitEvent(GatewayEvents.TRACK_STUCK, {
                guildId: player.guildId,
                track: player.track,
                reason: 'no_stream_data',
                thresholdMs: zombieThresholdMs
            });
        }
        player._sendUpdate();
    }
}
function _updateAndBroadcastStats(server, lastBroadcastAt, intervalMs) {
    const now = Date.now();
    const stats = getStats(server);
    const workerMetrics = server.workerManager?.getWorkerMetrics();
    server.statsManager.updateStatsMetrics(stats, workerMetrics);
    if (now - lastBroadcastAt >= intervalMs) {
        const payload = JSON.stringify({ op: 'stats', ...stats });
        _broadcastStatsPayload(server.sessions.values(), payload);
        return now;
    }
    return lastBroadcastAt;
}
function startServerMonitor(server, isClusterPrimary = false) {
    if (server._globalUpdater)
        return;
    const playbackConfig = server.options.playback;
    const playerUpdateInterval = Math.max(1, playbackConfig.playerUpdateInterval ?? 5000);
    const statsSendInterval = Math.max(1, playbackConfig.statsUpdateInterval ?? 30000);
    const metricsInterval = server.options.api?.metrics?.enabled
        ? 5000
        : statsSendInterval;
    const zombieThresholdMs = playbackConfig.zombieThresholdMs ?? 60000;
    if (isClusterPrimary) {
        let lastBroadcastAt = 0;
        server._globalUpdater = setInterval(() => {
            server.statsManager.setWebsocketConnections(server.sessions.activeSessions.size);
            lastBroadcastAt = _updateAndBroadcastStats(server, lastBroadcastAt, statsSendInterval);
        }, metricsInterval);
        return;
    }
    server._globalUpdater = setInterval(() => {
        const now = Date.now();
        for (const session of server.sessions.values()) {
            _checkSessionPlayers(session, now, zombieThresholdMs);
        }
    }, playerUpdateInterval);
    let lastBroadcastAt = 0;
    server._statsUpdater = setInterval(() => {
        const { totalPlayers, playingPlayers, voiceConnections } = _countActiveMetrics(server.sessions.values());
        server.statsManager.setVoiceConnections(voiceConnections);
        if (cluster.isWorker) {
            process.send?.({
                type: 'workerStats',
                stats: {
                    players: totalPlayers,
                    playingPlayers
                }
            });
        }
        else {
            server.statistics.players = totalPlayers;
            server.statistics.playingPlayers = playingPlayers;
        }
        lastBroadcastAt = _updateAndBroadcastStats(server, lastBroadcastAt, statsSendInterval);
    }, metricsInterval);
}
function stopServerMonitor(server) {
    if (server._globalUpdater) {
        clearInterval(server._globalUpdater);
        server._globalUpdater = null;
    }
    if (server._statsUpdater) {
        clearInterval(server._statsUpdater);
        server._statsUpdater = null;
    }
}
function startHeartbeat(server) {
    if (server._heartbeatInterval || server._usingBunServer)
        return;
    server._heartbeatInterval = setInterval(() => {
        for (const session of server.sessions.activeSessions.values()) {
            if (session.socket && !session.isPaused) {
                try {
                    if (session.socket.sendFrame) {
                        session.socket.sendFrame(Buffer.alloc(0), {
                            len: 0,
                            fin: true,
                            opcode: 0x09
                        });
                    }
                    else if (session.socket.ping) {
                        session.socket.ping();
                    }
                }
                catch {
                    logger('debug', 'Server', `Failed to send heartbeat to session ${session.id}`);
                }
            }
        }
    }, 45000);
}
function stopHeartbeat(server) {
    if (server._heartbeatInterval) {
        clearInterval(server._heartbeatInterval);
        server._heartbeatInterval = null;
    }
}
export { startHeartbeat, startServerMonitor, stopHeartbeat, stopServerMonitor };
