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
const monitorStates = new WeakMap();
function _getMonitorState(server) {
    let state = monitorStates.get(server);
    if (!state) {
        state = {
            globalUpdater: null,
            statsUpdater: null,
            heartbeatInterval: null
        };
        monitorStates.set(server, state);
    }
    return state;
}
function startServerMonitor(server, isClusterPrimary = false) {
    const state = _getMonitorState(server);
    if (state.globalUpdater)
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
        state.globalUpdater = setInterval(() => {
            server.statsManager.setWebsocketConnections(server.sessions.activeSessions.size);
            lastBroadcastAt = _updateAndBroadcastStats(server, lastBroadcastAt, statsSendInterval);
        }, metricsInterval);
        return;
    }
    state.globalUpdater = setInterval(() => {
        const now = Date.now();
        for (const session of server.sessions.values()) {
            _checkSessionPlayers(session, now, zombieThresholdMs);
        }
    }, playerUpdateInterval);
    let lastBroadcastAt = 0;
    state.statsUpdater = setInterval(() => {
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
    const state = _getMonitorState(server);
    if (state.globalUpdater) {
        clearInterval(state.globalUpdater);
        state.globalUpdater = null;
    }
    if (state.statsUpdater) {
        clearInterval(state.statsUpdater);
        state.statsUpdater = null;
    }
}
function startHeartbeat(server) {
    const state = _getMonitorState(server);
    if (state.heartbeatInterval || server.usingBunServer)
        return;
    state.heartbeatInterval = setInterval(() => {
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
    const state = _getMonitorState(server);
    if (state.heartbeatInterval) {
        clearInterval(state.heartbeatInterval);
        state.heartbeatInterval = null;
    }
}
export { startHeartbeat, startServerMonitor, stopHeartbeat, stopServerMonitor };
