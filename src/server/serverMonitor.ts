import { Buffer } from 'node:buffer'
import cluster from 'node:cluster'
import process from 'node:process'

import { GatewayEvents } from '../constants.ts'
import type NodelinkServer from '../index.ts'
import type { WorkerMetricsEntry } from '../typings/api/stats.types.ts'
import type { Session } from '../typings/index.types.ts'
import { getStats, logger } from '../utils.ts'

interface MonitorState {
  playerUpdateTimer: NodeJS.Timeout | null
  statsBroadcastTimer: NodeJS.Timeout | null
}

const monitorStates = new WeakMap<NodelinkServer, MonitorState>()
const heartbeatTimers = new WeakMap<NodelinkServer, NodeJS.Timeout>()

function _getMonitorState(server: NodelinkServer): MonitorState {
  let state = monitorStates.get(server)
  if (!state) {
    state = {
      playerUpdateTimer: null,
      statsBroadcastTimer: null
    }
    monitorStates.set(server, state)
  }
  return state
}

function _checkSessionPlayers(
  session: Session,
  now: number,
  zombieThresholdMs: number
): void {
  const players = session.players?.players
  if (!players) return

  for (const player of players.values()) {
    const isPlaying = Boolean(
      player.track && !player.isPaused && player.connection
    )
    if (!isPlaying) continue

    const hasStalledStream =
      player.connStatus === 'connected' &&
      player._lastStreamDataTime > 0 &&
      now - player._lastStreamDataTime >= zombieThresholdMs

    if (hasStalledStream) {
      logger(
        'warn',
        'Player',
        `Playback for guild ${player.guildId} appears stuck (no audio frames for ${zombieThresholdMs}ms).`
      )
      player.emitEvent(GatewayEvents.TRACK_STUCK, {
        guildId: player.guildId,
        track: player.track,
        reason: 'no_stream_data',
        thresholdMs: zombieThresholdMs
      })
    }

    player._sendUpdate()
  }
}

interface LocalPlayerMetrics {
  totalPlayers: number
  playingPlayers: number
  voiceConnections: number
}

function _countActiveMetrics(
  sessions: IterableIterator<Session>
): LocalPlayerMetrics {
  let totalPlayers = 0
  let playingPlayers = 0
  let voiceConnections = 0

  for (const session of sessions) {
    const players = session.players?.players
    if (!players) continue

    for (const player of players.values()) {
      totalPlayers++
      if (!player.isPaused && player.track) {
        playingPlayers++
      }
      if (player.connection) {
        voiceConnections++
      }
    }
  }

  return { totalPlayers, playingPlayers, voiceConnections }
}

function _broadcastStatsPayload(
  sessions: Iterable<Session>,
  payload: string
): void {
  for (const session of sessions) {
    try {
      session.socket?.send(payload)
    } catch {}
  }
}

function _updateAndBroadcastStats(
  server: NodelinkServer,
  lastBroadcastAt: number,
  intervalMs: number
): number {
  const now = Date.now()
  const stats = getStats(server)
  const workerMetrics = server.workerManager?.getWorkerMetrics() as
    | Record<string, WorkerMetricsEntry>
    | undefined

  server.statsManager.updateStatsMetrics(stats, workerMetrics)

  if (now - lastBroadcastAt >= intervalMs) {
    const payload = JSON.stringify({ op: 'stats', ...stats })
    _broadcastStatsPayload(server.sessions.values(), payload)
    return now
  }

  return lastBroadcastAt
}

function startServerMonitor(
  server: NodelinkServer,
  isClusterPrimary = false
): void {
  const state = _getMonitorState(server)
  if (state.statsBroadcastTimer || state.playerUpdateTimer) return

  const playbackConfig = server.options.playback
  const playerUpdateInterval = Math.max(
    1,
    playbackConfig.playerUpdateInterval ?? 5000
  )
  const statsSendInterval = Math.max(
    1,
    playbackConfig.statsUpdateInterval ?? 30000
  )
  const metricsInterval = server.options.api?.metrics?.enabled
    ? 5000
    : statsSendInterval
  const zombieThresholdMs = playbackConfig.zombieThresholdMs ?? 60000

  if (isClusterPrimary) {
    let lastBroadcastAt = 0

    state.statsBroadcastTimer = setInterval(() => {
      server.statsManager.setWebsocketConnections(
        server.sessions.activeSessions.size
      )
      lastBroadcastAt = _updateAndBroadcastStats(
        server,
        lastBroadcastAt,
        statsSendInterval
      )
    }, metricsInterval)

    return
  }

  state.playerUpdateTimer = setInterval(() => {
    const now = Date.now()
    for (const session of server.sessions.values()) {
      _checkSessionPlayers(session, now, zombieThresholdMs)
    }
  }, playerUpdateInterval)

  let lastBroadcastAt = 0

  state.statsBroadcastTimer = setInterval(() => {
    const { totalPlayers, playingPlayers, voiceConnections } =
      _countActiveMetrics(server.sessions.values())

    server.statsManager.setVoiceConnections(voiceConnections)

    if (cluster.isWorker) {
      process.send?.({
        type: 'workerStats',
        stats: {
          players: totalPlayers,
          playingPlayers
        }
      })
    } else {
      server.statistics.players = totalPlayers
      server.statistics.playingPlayers = playingPlayers
    }

    lastBroadcastAt = _updateAndBroadcastStats(
      server,
      lastBroadcastAt,
      statsSendInterval
    )
  }, metricsInterval)
}

function stopServerMonitor(server: NodelinkServer): void {
  const state = _getMonitorState(server)

  if (state.playerUpdateTimer) {
    clearInterval(state.playerUpdateTimer)
    state.playerUpdateTimer = null
  }

  if (state.statsBroadcastTimer) {
    clearInterval(state.statsBroadcastTimer)
    state.statsBroadcastTimer = null
  }
}

function startHeartbeat(server: NodelinkServer): void {
  if (heartbeatTimers.has(server) || server.usingBunServer) return

  const timer = setInterval(() => {
    for (const session of server.sessions.activeSessions.values()) {
      if (session.socket && !session.isPaused) {
        try {
          if (session.socket.sendFrame) {
            session.socket.sendFrame(Buffer.alloc(0), {
              len: 0,
              fin: true,
              opcode: 0x09
            })
          } else if (session.socket.ping) {
            session.socket.ping()
          }
        } catch {
          logger(
            'debug',
            'Server',
            `Failed to send heartbeat to session ${session.id}`
          )
        }
      }
    }
  }, 45000)

  heartbeatTimers.set(server, timer)
}

function stopHeartbeat(server: NodelinkServer): void {
  const timer = heartbeatTimers.get(server)
  if (timer) {
    clearInterval(timer)
    heartbeatTimers.delete(server)
  }
}

export { startHeartbeat, startServerMonitor, stopHeartbeat, stopServerMonitor }
