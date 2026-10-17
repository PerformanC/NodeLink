import process from 'node:process'

import discordVoice, {
  type VoiceConnectionState,
  type VoicePlayerState
} from '@performanc/voice'

import { EndReasons } from '../constants.ts'
import type { Player } from '../playback/player.ts'
import type {
  ExtendedAudioStream,
  ExtendedVoiceConnection,
  NodeLink,
  PlayerVoiceState,
  Session
} from '../typings/playback/player.types.ts'
import { logger } from '../utils.ts'

interface PlayerConnectionCallbacks {
  cleanupAudioStream: (context: string) => void
  startPendingTrack: () => Promise<boolean>
  onConnectionState: (state: VoiceConnectionState) => void
  onPlaybackState: (state: VoicePlayerState & { reason?: string }) => void
  onError: (error: Error) => void
}

/**
 * Connects a player to the existing voice library.
 * @internal
 */
export class PlayerConnection {
  private readonly player: Pick<
    Player,
    | 'updateVoice'
    | 'connection'
    | 'connStatus'
    | 'destroying'
    | 'voice'
    | 'guildId'
    | 'duckingController'
    | 'isPaused'
    | 'track'
    | 'isUpdatingTrack'
  >
  private readonly session: Session
  private readonly nodelink: NodeLink
  private readonly callbacks: PlayerConnectionCallbacks
  private _connStateHandler: (
    _: VoiceConnectionState | null,
    s: VoiceConnectionState
  ) => void = () => {}
  private _connPlayHandler: (
    _: VoicePlayerState | null,
    s: VoicePlayerState & { reason?: string }
  ) => void = () => {}
  private _connErrorHandler: (err: Error) => void = () => {}
  private _connStuckHandler: () => void = () => {}
  private _connSpeakStartHandler: (userId: string, ssrc: number) => void =
    () => {}
  public waitEvent: Player['waitEvent']

  constructor(
    player: PlayerConnection['player'],
    session: Session,
    nodelink: NodeLink,
    callbacks: PlayerConnectionCallbacks
  ) {
    this.player = player
    this.session = session
    this.nodelink = nodelink
    this.callbacks = callbacks

    this.waitEvent = (
      event,
      filter,
      timeout = this.nodelink.options.playback.eventTimeoutMs ?? 15000
    ) =>
      new Promise((resolve, reject) => {
        logger(
          'debug',
          'Player',
          `waitEvent: Started waiting for '${event}' on guild ${this.player.guildId} (timeout: ${timeout}ms)`
        )
        const conn = this.player.connection
        if (!conn) {
          logger(
            'warn',
            'Player',
            `waitEvent: Aborted waiting for '${event}' on guild ${this.player.guildId} (no connection)`
          )
          return reject(new Error('No connection available for waitEvent'))
        }

        const handler = (_: unknown, payload: unknown) => {
          const typedPayload = payload as unknown as Record<string, unknown>
          if (!filter || filter(typedPayload as never)) {
            clearTimeout(timeoutId)
            conn.off(event, handler)
            logger(
              'debug',
              'Player',
              `waitEvent: Resolved '${event}' for guild ${this.player.guildId}`
            )
            resolve(typedPayload as never)
          }
        }

        const timeoutId = setTimeout(() => {
          conn.off(event, handler)
          logger(
            'warn',
            'Player',
            `waitEvent: Timeout waiting for '${event}' on guild ${this.player.guildId}`
          )
          reject(
            new Error(
              `Event ${event} timed out after ${timeout}ms for guild ${this.player.guildId}`,
              event === 'playerStateChange'
                ? { cause: 'VOICE_STATE_TIMEOUT' }
                : undefined
            )
          )
        }, timeout)

        conn.on(event, handler)
      })
  }

  public destroy(): void {
    if (this.player.connection) {
      try {
        this.player.connection.removeListener(
          'stateChange',
          this._connStateHandler
        )
        this.player.connection.removeListener(
          'playerStateChange',
          this._connPlayHandler
        )
        this.player.connection.removeListener('error', this._connErrorHandler)
        this.player.connection.removeListener('stuck', this._connStuckHandler)
        this.player.connection.removeListener(
          'speakStart',
          this._connSpeakStartHandler
        )
        if (this.nodelink.voiceRelay?.detach) {
          this.nodelink.voiceRelay.detach(this.player.connection)
        }
        if (this.player.connection.audioStream) {
          this.player.connection.stop(EndReasons.CLEANUP)
          this.callbacks.cleanupAudioStream('destroy')
        }
        this._cleanupSSRCStreams(this.player.connection)
        this.player.connection.destroy()

        if (this.player.duckingController) {
          this.player.duckingController.destroy()
          this.player.duckingController = null
        }

        this.player.connection = null
      } catch (err) {
        const error = err as Error
        logger(
          'error',
          'internal',
          `Failed to destroy connection for guild ${this.player.guildId}: ${error.message} `
        )
      }
    }
  }

  public clearPendingKeyPackage(): void {
    const session = this.player.connection?.mlsSession
    if (session?._pendingKeyPackage) session._pendingKeyPackage = null
  }

  public flush(connection: ExtendedVoiceConnection | null): void {
    connection?.udp?.flush?.()
  }

  public _getAudioStream(): ExtendedAudioStream | null {
    return (
      (this.player.connection?.audioStream as ExtendedAudioStream | null) ??
      null
    )
  }

  public _isVoiceReady(): boolean {
    return (
      this.player.connStatus === 'connected' &&
      !!this.player.connection?.udpInfo?.secretKey
    )
  }

  public _isConnectionReady(state: VoiceConnectionState): boolean {
    return (
      state.status === 'connected' &&
      !!this.player.connection?.udpInfo?.secretKey
    )
  }

  public _ensureVoiceConnection(): void {
    if (this.player.destroying || this._isVoiceReady()) return
    if (
      !this.player.voice.sessionId ||
      !this.player.voice.token ||
      !this.player.voice.endpoint
    )
      return
    try {
      this.player.updateVoice(this.player.voice, true)
    } catch {}
  }

  /**
   * Establishes the voice connection and attaches event listeners.
   */
  public _initConnection(): void {
    if (this.player.connection || this.player.destroying) return
    logger(
      'debug',
      'Player',
      `[Connection] Initializing voice connection for guild ${this.player.guildId} (Session: ${this.session.id})`
    )
    this.player.connection = discordVoice.joinVoiceChannel({
      guildId: this.player.guildId,
      userId: this.session.userId,
      channelId: this.player.voice.channelId || this.player.guildId,
      encryption: this.nodelink.options?.playback.audio?.encryption ?? null
    })
    this.player.connection.stuckTimeout =
      Math.max(
        this.nodelink.options.playback.trackStuckThresholdMs ?? 10000,
        30000
      ) + 5000
    this._connStateHandler = (
      _: VoiceConnectionState | null,
      s: VoiceConnectionState
    ) => {
      logger(
        'debug',
        'Player',
        `Voice connection state change for guild ${this.player.guildId} in session ${this.session.id}: ${s.status}`
      )
      this.callbacks.onConnectionState(s)
    }
    this.player.connection.on('stateChange', this._connStateHandler)
    this._connPlayHandler = (
      _: VoicePlayerState | null,
      s: VoicePlayerState & { reason?: string }
    ) => this.callbacks.onPlaybackState(s)
    this.player.connection.on('playerStateChange', this._connPlayHandler)
    this._connErrorHandler = (err: Error) => {
      const daveRecoveryStarted = err.cause === 'DAVE_RECOVERY_STARTED'
      logger(
        daveRecoveryStarted ? 'warn' : 'error',
        'Player',
        `Voice connection error for guild ${this.player.guildId} in session ${this.session.id}:`,
        err
      )
      if (daveRecoveryStarted) return

      process.nextTick(() => {
        if (this.player.destroying) return

        const playerReason = this.player.connection?.playerState?.reason
        if (playerReason === 'reconnecting') {
          logger(
            'warn',
            'Player',
            `Voice connection error for guild ${this.player.guildId} is a recoverable reconnection (playerState.reason=${playerReason}). Deferring to library.`
          )
          return
        }

        this.callbacks.onError(err)
      })
    }
    this.player.connection.on('error', this._connErrorHandler)
    this._connStuckHandler = () => {
      if (this.player.destroying) return
      logger(
        'warn',
        'Player',
        `Voice library detected stuck stream for guild ${this.player.guildId}`
      )
    }
    this.player.connection.on('stuck', this._connStuckHandler)

    // Automatically drain incoming voice streams to prevent memory leaks
    this._connSpeakStartHandler = (_userId: string, ssrc: number) => {
      if (this.player.destroying || !this.player.connection) return
      const stream = this.player.connection.getSpeakStream?.(ssrc)
      if (stream && !stream.destroyed) {
        stream.resume()
      }
    }
    this.player.connection.on('speakStart', this._connSpeakStartHandler)

    if (this.nodelink.voiceRelay?.attach) {
      this.nodelink.voiceRelay.attach(
        this.player.connection,
        this.player.guildId
      )
    }

    // Attach ducking controller to the voice connection
    if (this.player.duckingController && this.player.connection) {
      this.player.duckingController.attach(this.player.connection)
    }
  }

  /**
   * Tears down a dead voice connection and builds a fresh one.
   *
   * The voice library keeps per-connection reconnect counters, so reusing a
   * connection that hit the circuit breaker would trip it again instantly.
   * A new connection object resets those counters.
   */
  public _resetVoiceConnection(): void {
    const conn = this.player.connection
    if (!conn || this.player.destroying) return
    logger(
      'warn',
      'Player',
      `Resetting dead voice connection for guild ${this.player.guildId}`
    )
    try {
      conn.removeListener('stateChange', this._connStateHandler)
      conn.removeListener('playerStateChange', this._connPlayHandler)
      conn.removeListener('error', this._connErrorHandler)
      conn.removeListener('stuck', this._connStuckHandler)
      conn.removeListener('speakStart', this._connSpeakStartHandler)
      if (this.nodelink.voiceRelay?.detach) {
        this.nodelink.voiceRelay.detach(conn)
      }
      conn.destroy()
    } catch {}
    this.player.connection = null
    this.player.connStatus = 'disconnected'
    this._initConnection()
  }

  private _cleanupSSRCStreams(conn: ExtendedVoiceConnection | null): void {
    if (!conn?.ssrcs) return
    for (const entry of conn.ssrcs.values()) {
      const s = entry?.stream as import('node:stream').Readable & {
        destroyed?: boolean
        destroy?: () => void
      }
      if (s && !s.destroyed) {
        s.resume()
        s.destroy?.()
      }
    }
  }

  /**
   * Updates the voice state for this player.
   *
   * @param voicePayload - Session/token/endpoint/channel updates.
   * @param force - Forces reconnect even when unchanged.
   */
  public updateVoice(
    voicePayload: Partial<PlayerVoiceState> = {},
    force = false
  ): void {
    logger(
      'debug',
      'Player',
      `[Action: updateVoice] Method invoked for guild ${this.player.guildId} with force=${force}`
    )
    if (this.player.destroying) return

    const { sessionId, token, endpoint, channelId } = voicePayload

    let changed = false
    if (sessionId !== undefined && this.player.voice.sessionId !== sessionId) {
      this.player.voice.sessionId = sessionId
      changed = true
    }
    if (token !== undefined && this.player.voice.token !== token) {
      this.player.voice.token = token
      changed = true
    }
    if (endpoint !== undefined && this.player.voice.endpoint !== endpoint) {
      this.player.voice.endpoint = endpoint
      changed = true
    }
    if (channelId !== undefined && this.player.voice.channelId !== channelId) {
      this.player.voice.channelId = channelId
      changed = true
    }

    if (
      this.player.voice.sessionId &&
      this.player.voice.token &&
      this.player.voice.endpoint
    ) {
      // The voice library wipes voiceServer/udpInfo when the connection dies
      // (e.g. reconnect circuit breaker) but keeps matching payload values on
      // our side, so an identical Discord re-send would hit the early return
      // below and never reconnect. Bypass the skip when the connection is
      // down and re-supply state plus an explicit connect instead.
      // Note: `connecting` is deliberately not dead - a handshake is already
      // in flight and re-calling connect() would tear it down and restart it.
      const connectionDead =
        !this.player.connection ||
        this.player.connStatus === 'disconnected' ||
        this.player.connStatus === 'destroyed' ||
        !this.player.connection.voiceServer ||
        (this.player.connStatus === 'connected' &&
          !this.player.connection.udpInfo?.secretKey)

      if (!changed && !force && !connectionDead) {
        logger(
          'debug',
          'Player',
          `Voice state for guild ${this.player.guildId} is unchanged. Skipping update.`
        )
        return
      }
      // null here means the connection is still connecting, so its not "dead".
      if (connectionDead && this.player.connection !== null) {
        logger(
          'warn',
          'Player',
          `Voice connection is down for guild ${this.player.guildId} (status: ${this.player.connStatus}). Re-supplying voice state and reconnecting.`
        )
      } else {
        logger(
          'debug',
          'Player',
          `Updating voice state for guild ${this.player.guildId}`
        )
      }
      if (!this.player.connection) this._initConnection()
      this.player.connection?.voiceStateUpdate({
        session_id: this.player.voice.sessionId,
        channel_id: this.player.voice.channelId ?? undefined
      })
      if (force && this.player.connection?.voiceServer) {
        this.player.connection.voiceServer = null
      }
      this.player.connection?.voiceServerUpdate({
        token: this.player.voice.token,
        endpoint: this.player.voice.endpoint,
        channel_id: this.player.voice.channelId ?? undefined
      })
      this.player.connection?.connect(async () => {
        if (this.player.destroying) return
        if (this.player.connection?.audioStream && !this.player.isPaused) {
          this.player.connection.unpause?.('reconnected')
        }

        if (
          this.player.track &&
          !this.player.connection?.audioStream &&
          !this.player.isUpdatingTrack
        ) {
          logger(
            'debug',
            'Player',
            `Voice state updated for guild ${this.player.guildId}, starting pending track.`
          )
          await this.callbacks.startPendingTrack().catch((err) => {
            logger(
              'error',
              'Player',
              `Failed to start pending track during voice update for guild ${this.player.guildId}:`,
              err
            )
          })
        }
      })
    } else {
      logger(
        'warn',
        'Player',
        `Incomplete voice update for guild ${this.player.guildId}. Missing sessionId, token, or endpoint.`
      )
    }
  }
}
