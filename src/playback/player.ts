import type { Readable } from 'node:stream'
import { PassThrough } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { SeekError } from '@ecliptia/seekable-stream'
import discordVoice, {
  type VoiceAudioStream,
  type VoiceConnection,
  type VoiceConnectionState,
  type VoicePlayerState
} from '@performanc/voice'
import { EndReasons, GatewayEvents } from '../constants.ts'
import type {
  AudioMixer,
  AudioOptionsWithTransitions,
  AudioResource,
  CreateAudioResource,
  CreateSeekeableAudioResource,
  ExtendedAudioStream,
  ExtendedVoiceConnection,
  FadeTimers,
  FadingConfig,
  FadingSection,
  FilterStateEntry,
  FiltersState,
  FilterTransitionsConfig,
  LyricsLine,
  LyricsPayload,
  NodeLink,
  PlayerOptions,
  PlayerSponsorBlockState,
  PlayerStateJSON,
  PlayerTrack,
  PlayerVoiceState,
  PlayPayload,
  Session,
  SponsorBlockSegment,
  StreamInfo,
  TrackFormat,
  TrackInfoExtended
} from '../typings/playback/player.types.ts'
import type { TrackUrlResult } from '../typings/sources/source.types.ts'
import { logger } from '../utils.ts'

export type GatewayEventName =
  (typeof GatewayEvents)[keyof typeof GatewayEvents]
export type EndReason = (typeof EndReasons)[keyof typeof EndReasons]

let createAudioResource: CreateAudioResource | null = null
let createSeekeableAudioResource: CreateSeekeableAudioResource | null = null
const trackFinishMemoryTraceEnabled =
  process.env.NODELINK_TRACK_FINISH_MEMORY_TRACE?.toLowerCase() === 'true'

async function getStreamProcessor(): Promise<void> {
  if (createAudioResource && createSeekeableAudioResource) return

  const processor = await import('./processing/streamProcessor.ts')
  createAudioResource = processor.createAudioResource as CreateAudioResource
  createSeekeableAudioResource =
    processor.createSeekeableAudioResource as CreateSeekeableAudioResource
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Core audio player responsible for voice connection management, stream handling,
 * filter application, fading, lyrics synchronization, mix layers, and stuck-track recovery.
 *
 * @remarks
 * - Establishes and monitors the Discord voice connection via @performanc/voice.
 * - Fetches stream URLs from sources, builds audio resources, and handles gapless playback.
 * - Applies filters, fading, loudness normalization, and PCM mixing through AudioMixer.
 * - Manages lyrics subscription, timing, and drift correction for synced events.
 * - Emits gateway events for all lifecycle transitions (start, end, pause, seek, exceptions).
 */
export class Player {
  private readonly nodelink: NodeLink
  private readonly session: Session
  public readonly guildId: string

  private track: PlayerTrack | null = null
  private holoTrack: PlayerTrack | null = null
  private nextTrack: PlayerTrack | null = null
  private nextResource: AudioResource | null = null
  private nextStreamInfo: StreamInfo = null
  public isPaused = false
  public volumePercent: number
  public filters: FiltersState = {}
  public position = 0
  public connStatus: VoiceConnectionState['status'] = 'disconnected'
  public connection: ExtendedVoiceConnection | null = null
  public voice: PlayerVoiceState = {
    sessionId: null,
    token: null,
    endpoint: null,
    channelId: null
  }
  public streamInfo: StreamInfo = null
  public sponsorBlock: PlayerSponsorBlockState
  public profilerStreamStats: {
    downloadedBytes: number
    totalBytes: number | null
    lastChunkAt: number | null
  } = {
    downloadedBytes: 0,
    totalBytes: null,
    lastChunkAt: null
  }
  public lastManualReconnect = 0
  public audioMixer: AudioMixer | null = null
  public fading?: FadingConfig
  public loudnessNormalizer: boolean
  private _fadeTimers: FadeTimers = { trackEnd: null, pause: null, stop: null }
  private _isResuming = false
  private _pendingTrackStartFade = false
  private _ignoreIdleStoppedUntil = 0
  private _lyricsBasePosition = 0
  private _lyricsBasePackets = 0
  private _lyricsMarkerTimer: NodeJS.Timeout | null = null
  private _audioMixerInitPromise: Promise<void> | null = null

  public isLyricsSubscribed = false
  public currentLyrics: LyricsPayload | null = null
  public lyricsLineIndex = -1
  public skipTrackSource = false

  public emitEvent: (
    type: GatewayEventName | string,
    payload?: Record<string, unknown>
  ) => void
  public waitEvent: <T>(
    event: string,
    filter?: (payload: T) => boolean,
    timeout?: number
  ) => Promise<T>

  private _lastPosition = 0
  private _stuckTime = 0
  private _lastStreamDataTime = 0
  private _isRecovering = false
  public destroying = false
  public isUpdatingTrack = false
  private _isRestoring = false
  private _isSeeking = false
  private _isStopping = false
  private _pausedAtPosition: number | undefined = undefined
  public stuckRecoveryCount = 0
  private _positionAtRecoveryStart = 0
  private static MAX_STUCK_RECOVERY_ATTEMPTS = 3

  constructor(options: PlayerOptions) {
    if (
      !options.nodelink ||
      !options.session?.socket ||
      !options.session.userId ||
      !options.guildId
    ) {
      throw new Error('Missing required options')
    }

    this.nodelink = options.nodelink
    this.session = options.session
    this.guildId = options.guildId
    this.volumePercent = this.nodelink.options?.defaultVolume ?? 100
    this.fading = this.nodelink.options?.playback.audio?.fading
    this.loudnessNormalizer =
      this.nodelink.options?.playback.audio?.loudnessNormalizer ?? false

    this.sponsorBlock = {
      enabled: this.nodelink.options.playback.sponsorblock?.enabled ?? false,
      categories: this.nodelink.options.playback.sponsorblock?.categories ?? [
        'sponsor',
        'selfpromo',
        'interaction',
        'intro',
        'outro',
        'preview',
        'music_offtopic',
        'filler'
      ],
      actionTypes: this.nodelink.options.playback.sponsorblock?.actionTypes ?? [
        'skip'
      ],
      segments: [],
      lastSkippedUuid: null,
      skipMarginMs:
        this.nodelink.options.playback.sponsorblock?.skipMarginMs ?? 150
    }

    logger(
      'debug',
      'Player',
      `New player created for guild ${this.guildId} in session ${this.session.id}`
    )

    this.emitEvent = (type, payload = {}) => {
      this.nodelink.statsManager.incrementPlaybackEvent(type)
      const eventData = JSON.stringify({
        op: 'event',
        type,
        guildId: this.guildId,
        ...payload
      })

      if (this.session.isPaused) {
        this.session.eventQueue.push(eventData)
        logger(
          'debug',
          'Player',
          `Queued event ${type} for paused session ${this.session.id}`
        )
        return
      }

      try {
        this.session.socket.send(eventData)
      } catch {}
    }

    this.emitEvent(GatewayEvents.PLAYER_CREATED, {
      guildId: this.guildId,
      player: this.toJSON()
    })

    this.waitEvent = (
      event,
      filter,
      timeout = this.nodelink.options.playback.eventTimeoutMs ?? 15000
    ) =>
      new Promise((resolve, reject) => {
        logger('debug', 'Player', `waitEvent: Started waiting for '${event}' on guild ${this.guildId} (timeout: ${timeout}ms)`)
        const conn = this.connection
        if (!conn) {
          logger('warn', 'Player', `waitEvent: Aborted waiting for '${event}' on guild ${this.guildId} (no connection)`)
          return reject(new Error('No connection available for waitEvent'))
        }

        const handler = (_: unknown, payload: unknown) => {
          const typedPayload = payload as unknown as Record<string, unknown>
          if (!filter || filter(typedPayload as never)) {
            clearTimeout(timeoutId)
            conn.off(event, handler)
            logger('debug', 'Player', `waitEvent: Resolved '${event}' for guild ${this.guildId}`)
            resolve(typedPayload as never)
          }
        }

        const timeoutId = setTimeout(() => {
          conn.off(event, handler)
          logger('warn', 'Player', `waitEvent: Timeout waiting for '${event}' on guild ${this.guildId}`)
          reject(
            new Error(
              `Event ${event} timed out after ${timeout}ms for guild ${this.guildId}`
            )
          )
        }, timeout)

        conn.on(event, handler)
      })
  }

  private _getAudioOptions(): AudioOptionsWithTransitions | undefined {
    return this.nodelink.options.playback.audio as
      | AudioOptionsWithTransitions
      | undefined
  }

  private _getFilterTransitions(): FilterTransitionsConfig | undefined {
    return this._getAudioOptions()?.filterTransitions
  }

  private _getAudioStream(): ExtendedAudioStream | null {
    return (this.connection?.audioStream as ExtendedAudioStream | null) ?? null
  }

  /**
   * Initializes the audio mixer instance used for mix layers and fading.
   */
  private async _initAudioMixer(): Promise<void> {
    if (this.audioMixer) return

    const { AudioMixer: Mixer } = await import('./processing/AudioMixer.ts')
    this.audioMixer = new Mixer(
      this.nodelink.options?.playback.mix ?? {
        enabled: true,
        defaultVolume: 0.8,
        maxLayersMix: 5,
        autoCleanup: true
      }
    ) as AudioMixer

    this.audioMixer.on('mixStarted', (data) => {
      this.emitEvent(GatewayEvents.MIX_STARTED, {
        mixId: data.id,
        track: data.track,
        volume: data.volume
      })
    })

    this.audioMixer.on('mixEnded', (data) => {
      this.emitEvent(GatewayEvents.MIX_ENDED, {
        mixId: data.id,
        reason: data.reason
      })
    })

    this.audioMixer.on('mixError', (data) => {
      const errorMessage = data.error ? data.error.message : 'Unknown mix error'
      logger('error', 'Player', `Mix error for ${data.id}: ${errorMessage}`)
    })
  }

  /**
   * Ensures the audio mixer is initialized only once on demand.
   */
  private async _ensureAudioMixer(): Promise<void> {
    if (this.audioMixer) return
    if (!this._audioMixerInitPromise) {
      this._audioMixerInitPromise = this._initAudioMixer()
        .catch((err) => {
          this._audioMixerInitPromise = null
          throw err
        })
        .then(() => {
          this._audioMixerInitPromise = null
        })
    }
    await this._audioMixerInitPromise
  }

  /**
   * Establishes the voice connection and attaches event listeners.
   */
  private _initConnection(): void {
    if (this.connection || this.destroying) return
    logger('debug', 'Player', `[Connection] Initializing voice connection for guild ${this.guildId} (Session: ${this.session.id})`)
    this.connection = discordVoice.joinVoiceChannel({
      guildId: this.guildId,
      userId: this.session.userId,
      channelId: this.voice.channelId || this.guildId,
      encryption: this.nodelink.options?.playback.audio?.encryption ?? null
    })
    this.connection.stuckTimeout =
      Math.max(
        this.nodelink.options.playback.trackStuckThresholdMs ?? 10000,
        30000
      ) + 5000
    this.connection.on(
      'stateChange',
      (_: VoiceConnectionState | null, s: VoiceConnectionState) => {
        logger(
          'debug',
          'Player',
          `Voice connection state change for guild ${this.guildId} in session ${this.session.id}: ${s.status}`
        )
        this._onConn(s)
      }
    )
    this.connection.on(
      'playerStateChange',
      (_: VoicePlayerState | null, s: VoicePlayerState & { reason?: string }) =>
        this._onPlay(s)
    )
    this.connection.on('error', (err) => {
      logger(
        'error',
        'Player',
        `Voice connection error for guild ${this.guildId} in session ${this.session.id}:`,
        err
      )

      process.nextTick(() => {
        if (this.destroying) return

        const playerReason = this.connection?.playerState?.reason
        if (playerReason === 'reconnecting') {
          logger(
            'warn',
            'Player',
            `Voice connection error for guild ${this.guildId} is a recoverable reconnection (playerState.reason=${playerReason}). Deferring to library.`
          )
          return
        }

        this._onError(err)
      })
    })
    this.connection.on('stuck', () => {
      if (this.destroying) return
      logger(
        'warn',
        'Player',
        `Voice library detected stuck stream for guild ${this.guildId}`
      )
    })

    if (this.nodelink.voiceRelay?.attach) {
      this.nodelink.voiceRelay.attach(this.connection, this.guildId)
    }
  }

  /**
   * Handles connection state transitions.
   */
  private _onConn(state: VoiceConnectionState): void {
    if (this.destroying) return
    const previousStatus = this.connStatus
    this.connStatus = state.status
    if (state.status === 'connected') {
      logger(
        'info',
        'Player',
        `Voice connection established for guild ${this.guildId} in session ${this.session.id}`
      )
      this.emitEvent(GatewayEvents.PLAYER_CONNECTED, {
        guildId: this.guildId,
        voice: structuredClone(this.voice)
      })
      if (this.track && this.isPaused && this.connection?.audioStream) {
        this.isPaused = false
        this.connection.unpause?.('reconnected')
        logger(
          'debug',
          'Player',
          `Unpaused track on reconnection for guild ${this.guildId}`
        )
      }
    } else if (state.status === 'connecting') {
      if (previousStatus !== 'disconnected' || this.connection?.audioStream) {
        logger(
          'info',
          'Player',
          `Voice connection is reconnecting for guild ${this.guildId}`
        )
        this.emitEvent(GatewayEvents.PLAYER_RECONNECTING, {
          guildId: this.guildId,
          voice: structuredClone(this.voice)
        })
      }
    } else if (state.status === 'disconnected') {
      const reason = state.reason
      if (reason === 'reconnect_circuit_breaker') {
        logger(
          'error',
          'Player',
          `Voice connection circuit breaker triggered for guild ${this.guildId}. Too many reconnection attempts.`
        )
        this.emitEvent(GatewayEvents.TRACK_EXCEPTION, {
          track: this.track,
          exception: {
            message: 'Voice reconnection circuit breaker triggered',
            severity: 'fault',
            cause: 'RECONNECT_CIRCUIT_BREAKER'
          }
        })
      }
      this.emitEvent(GatewayEvents.WEBSOCKET_CLOSED, {
        code: state.code,
        reason: state.closeReason ?? state.reason,
        byRemote: true
      })
    } else if (state.status === 'destroyed') {
      logger(
        'warn',
        'Player',
        `Voice connection destroyed for guild ${this.guildId}`
      )
    }
    this._sendUpdate()
  }

  /**
   * Handles player state changes emitted by the voice connection.
   */
  private _onPlay(state: VoicePlayerState & { reason?: string }): void {
    if (this.destroying) return
    logger(
      'debug',
      'Player',
      `Player state change for guild ${this.guildId} in session ${this.session.id}: ${state.status} (reason: ${state.reason})`
    )

    const endReason = state.reason as EndReason | undefined
    const endingReasons: EndReason[] = [
      EndReasons.STOPPED,
      EndReasons.FINISHED,
      EndReasons.LOAD_FAILED
    ]

    if (
      state.status === 'idle' &&
      endReason === EndReasons.STOPPED &&
      Date.now() < this._ignoreIdleStoppedUntil &&
      this._isResuming
    ) {
      logger(
        'debug',
        'Player',
        `Ignoring internal idle/stopped during stream swap for guild ${this.guildId}`
      )
      return
    }

    if (state.status === 'idle' && state.reason === 'stuck') {
      logger(
        'warn',
        'Player',
        `Track became stuck for guild ${this.guildId}. Triggering immediate recovery.`
      )
      this._stuckTime =
        (this.nodelink.options.playback.trackStuckThresholdMs ?? 0) + 1
      this._sendUpdate()
      return
    }

    if (state.status === 'idle' && this.isUpdatingTrack) {
      if (endReason === EndReasons.STOPPED) {
        logger(
          'debug',
          'Player',
          `Processing stop completion during track update for guild ${this.guildId}`
        )
      } else {
        logger(
          'debug',
          'Player',
          `Ignoring idle event during track replacement for guild ${this.guildId}. Reason: ${state.reason}`
        )
        return
      }
    }

    if (
      state.status === 'idle' &&
      this.track &&
      endReason &&
      endingReasons.includes(endReason)
    ) {
      if (
        state.reason === EndReasons.FINISHED &&
        this.nextResource &&
        this.nextTrack
      ) {
        const resource = this.nextResource

        const nextTrack = this.nextTrack
        const nextStreamInfo = this.nextStreamInfo

        this._emitTrackEnd(EndReasons.GAPLESS)

        this.track = nextTrack
        this.nextTrack = null
        this.nextResource = null
        this.streamInfo = nextStreamInfo
        this.nextStreamInfo = null

        this.position = 0
        this._lyricsBasePosition = 0
        this._lyricsBasePackets =
          this.connection?.statistics?.packetsExpected ?? 0

        this.connection?.play(resource as unknown)

        return
      }

      if (
        (this.isUpdatingTrack || this._isSeeking) &&
        state.reason === 'finished'
      ) {
        logger(
          'debug',
          'Player',
          `Ignoring spurious idle/finished event during track replacement/seek for guild ${this.guildId}.`
        )
        return
      }

      logger(
        'debug',
        'Player',
        `Track ended for guild ${this.guildId}. Reason: ${state.reason}. Current position: ${this._realPosition()}`
      )
      this._traceTrackFinishMemory('before-cleanup')
      this._cleanupCurrentAudioStream('track-end')

      this._emitTrackEnd(endReason)
      this._resetTrack()
      this._traceTrackFinishMemory('after-reset')
    } else if (
      state.status === 'playing' &&
      this.track &&
      !this._isSeeking &&
      (['requested', 'reconnected', 'unpaused'].includes(state.reason ?? '') ||
        this._pendingTrackStartFade)
    ) {
      const wasResuming = this._isResuming
      this._isResuming = false
      this.isPaused = false
      this._lastStreamDataTime = Date.now()

      if (wasResuming) {
        this._fading('trackEndSchedule', {
          startPosition: this._pausedAtPosition ?? this._realPosition()
        })
        this._pausedAtPosition = undefined
      } else if (!this._isRestoring) {
        this._lyricsBasePackets =
          this.connection?.statistics?.packetsExpected ?? 0
        this._fading('trackStart')
        this._emitTrackStart().catch((err) => this._onError(err))
      }
    } else if (state.status === 'idle' && state.reason === 'paused') {
      this.isPaused = true
    } else if (state.status === 'idle' && state.reason === 'reconnecting') {
      logger(
        'info',
        'Player',
        `Voice library reports reconnecting for guild ${this.guildId}`
      )
      this.emitEvent(GatewayEvents.PLAYER_RECONNECTING, {
        guildId: this.guildId,
        voice: structuredClone(this.voice)
      })
    }
  }

  /**
   * Handles playback errors and emits exception events.
   */
  private _onError(error: Error): void {
    if (this.destroying) return
    if (this.track) {
      let severity: string = 'fault'
      let cause = 'UNKNOWN_ERROR'
      let shouldStop = true
      logger(
        'debug',
        'Player',
        `Handling player error for guild ${this.guildId}: ${error.message}`
      )

      if (error.message.includes('ECONNRESET')) {
        const now = Date.now()
        const reconnectCooldown = 5000

        if (now - (this.lastManualReconnect || 0) < reconnectCooldown) {
          logger(
            'warn',
            'Player',
            `Voice connection reset for guild ${this.guildId}. Manual reconnect on cooldown. Relying on library.`
          )
        } else {
          this.lastManualReconnect = now
          logger(
            'warn',
            'Player',
            `Voice connection reset for guild ${this.guildId}. Attempting to manually reconnect.`
          )
          this.updateVoice(this.voice, true)
        }

        severity = 'suspicious'
        cause = 'VOICE_CONNECTION_RESET'
        shouldStop = false
      } else if (
        error.message.includes('stream') ||
        error.message.includes('timeout') ||
        error.name === 'AbortError'
      ) {
        logger(
          'warn',
          'Player',
          `Stream error detected for guild ${this.guildId}. Stopping playback.`
        )
        severity = 'common'
        cause = 'STREAM_ERROR'
        shouldStop = true
      } else if (error instanceof SeekError) {
        logger(
          'error',
          'Player',
          `Seek error for guild ${this.guildId}: ${error.message}. Stopping playback.`
        )
        severity = 'fault'
        cause = 'SEEK_ERROR'
        shouldStop = true
      } else {
        logger(
          'error',
          'Player',
          `Unhandled player error for guild ${this.guildId}:`,
          error
        )
        severity = 'fault'
        cause = `${error.name || 'Error'}: ${error.message}`
        shouldStop = true
      }

      this.emitEvent(GatewayEvents.TRACK_EXCEPTION, {
        track: this.track,
        exception: {
          message: error.message,
          severity: severity,
          cause: cause
        }
      })

      this.nodelink.pluginManager?.callHook(
        'onTrackException',
        this.guildId,
        this.track,
        { message: error.message, severity, cause }
      )

      if (shouldStop) {
        this._emitTrackEnd(EndReasons.LOAD_FAILED)
        this.stop()
      }
    }
  }

  /**
   * Resets track and lyric state after a track ends.
   */
  private _resetTrack(): void {
    this._isStopping = false
    if (this.nextResource) {
      this.nextResource.destroy()
      this.nextResource = null
      this.nextTrack = null
      this.nextStreamInfo = null
    }

    this.track = null
    this.holoTrack = null
    this.isPaused = false
    this.position = 0
    this._pausedAtPosition = undefined
    this._lastStreamDataTime = 0
    this.currentLyrics = null
    this.lyricsLineIndex = -1
    this._fading('reset')
    this._lyricsBasePosition = 0
    this._lyricsBasePackets = this.connection?.statistics?.packetsExpected ?? 0
    if (this._lyricsMarkerTimer) {
      clearTimeout(this._lyricsMarkerTimer)
      this._lyricsMarkerTimer = null
    }
  }

  /**
   * Logs memory snapshot for track-finish diagnostics when enabled.
   */
  private _traceTrackFinishMemory(stage: string): void {
    if (!trackFinishMemoryTraceEnabled) return
    const m = process.memoryUsage()
    const toMB = (value: number): string => (value / 1024 / 1024).toFixed(2)
    logger(
      'debug',
      'Player',
      `[MEM][TrackFinish][${this.guildId}] ${stage} rss=${toMB(m.rss)}MB heapUsed=${toMB(
        m.heapUsed
      )}MB heapTotal=${toMB(m.heapTotal)}MB external=${toMB(m.external)}MB arrayBuffers=${toMB(
        m.arrayBuffers
      )}MB`
    )
  }

  /**
   * Destroys and dereferences current audio stream to avoid lingering references.
   */
  private _cleanupCurrentAudioStream(context: string): void {
    logger(
      'debug',
      'Player',
      `[Cleanup] Triggering stream cleanup for guild ${this.guildId}. Context: ${context}`
    )
    const conn = this.connection
    const audioStream = conn?.audioStream as ExtendedAudioStream | undefined | null

    if (!audioStream) return

    try {
      audioStream._cleanupListeners?.()
    } catch {
      // Ignore cleanup errors
    }

    if (audioStream.destroyed) {
      if (conn) conn.audioStream = null
      return
    }

    try {
      audioStream.destroy?.()

      if (Array.isArray(audioStream.pipes)) {
        for (const pipe of audioStream.pipes) {
          pipe.destroy?.()
        }
      }

      conn?.udp?.flush?.()
    } catch (err) {
      logger(
        'debug',
        'Player',
        `Failed to destroy audio stream during ${context} for guild ${this.guildId}: ${
          (err as Error)?.message ?? String(err)
        }`
      )
    } finally {
      if (conn) conn.audioStream = null
    }
  }

  /**
   * Emits TRACK_START and related events after resolving Holo tracks.
   */
  private async _emitTrackStart(): Promise<void> {
    const trackToEmit = await this._resolveTrackForEvent(this.track)
    this.holoTrack = trackToEmit

    const format = this.streamInfo?.format
    const playingQuality =
      format && typeof format === 'object' && 'itag' in format
        ? ((format as { itag?: number }).itag ?? null)
        : null

    this.emitEvent(GatewayEvents.TRACK_START, {
      track: trackToEmit,
      playingQuality
    })

    this.nodelink.pluginManager?.callHook(
      'onTrackStart',
      this.guildId,
      trackToEmit
    )

    if (trackToEmit?.info?.sourceName === 'eternalbox') {
      const info = trackToEmit.info
      const pluginInfo = (trackToEmit.pluginInfo ?? {}) as {
        spotify?: { url?: string }
        analysisUrl?: string | null
        streamUrl?: string | null
        ogAudioSource?: string | null
        service?: string | null
        analysisSummary?: string | null
      }
      const spotify = pluginInfo.spotify
      const links = {
        jukeboxPage: info.uri,
        analysisUrl: pluginInfo.analysisUrl || null,
        streamUrl: pluginInfo.streamUrl || null,
        ogAudioSource: pluginInfo.ogAudioSource || null,
        spotifyUrl: spotify?.url || info.uri || null
      }

      this.emitEvent(GatewayEvents.ETERNALBOX_INFO, {
        track: trackToEmit,
        eternalbox: {
          id: info.identifier,
          service: pluginInfo.service || null,
          analysisSummary: pluginInfo.analysisSummary || null,
          spotify: pluginInfo.spotify || null,
          links
        }
      })
    }

    if (this.isLyricsSubscribed) {
      await this._loadLyrics()
    }
  }

  /**
   * Emits TRACK_END event and cleans up mixer layers.
   */
  private _emitTrackEnd(
    reason: EndReason,
    extra: Record<string, unknown> = {}
  ): void {
    const trackToEmit = this.holoTrack || this.track
    this.emitEvent(GatewayEvents.TRACK_END, {
      track: trackToEmit,
      reason: reason,
      ...extra
    })

    this.nodelink.pluginManager?.callHook(
      'onTrackEnd',
      this.guildId,
      trackToEmit,
      reason
    )

    if (this.audioMixer?.autoCleanup) {
      this.audioMixer.clearLayers('MAIN_ENDED')
    }
  }

  /**
   * Resolves optional Holo track data for events.
   */
  private async _resolveTrackForEvent(
    track: PlayerTrack | null
  ): Promise<PlayerTrack | null> {
    if (!track) return null
    if (!this.nodelink.options.experimental.enableHoloTracks) {
      return track
    }

    try {
      const source = this.nodelink.sources.getSource(track.info.sourceName)
      const resolveHoloTrack = (
        source as {
          resolveHoloTrack?: (
            trackPayload: PlayerTrack,
            options: {
              fetchChannelInfo?: boolean
              resolveExternalLinks?: boolean
            }
          ) => Promise<PlayerTrack | null>
        } | null
      )?.resolveHoloTrack
      if (typeof resolveHoloTrack === 'function') {
        const holoTrack = await resolveHoloTrack.call(source, track, {
          fetchChannelInfo: this.nodelink.options.search.fetchChannelInfo,
          resolveExternalLinks:
            this.nodelink.options.search.resolveExternalLinks
        })
        return holoTrack || track
      }
    } catch (err) {
      const error = err as Error
      logger('warn', 'Player', `Failed to resolve Holo track: ${error.message}`)
    }

    return track
  }

  /**
   * Calculates the real playback position considering timescale filters.
   */
  private _getTimescale(): { speed: number; rate: number } {
    const filterSettings = this.filters.filters as
      | { timescale?: { speed?: number; rate?: number } }
      | undefined
    const timescale = filterSettings?.timescale || {}
    return {
      speed: typeof timescale.speed === 'number' ? timescale.speed : 1.0,
      rate: typeof timescale.rate === 'number' ? timescale.rate : 1.0
    }
  }

  private _realPosition(): number {
    const audioStream = this._getAudioStream()

    const playbackSpeed =
      audioStream?.getEffectiveRate?.() ?? this._getTimescaleSpeed()

    const packets =
      this.connection?.statistics?.packetsExpected ?? this._lyricsBasePackets
    const deltaPackets = Math.max(0, packets - this._lyricsBasePackets)
    return this._lyricsBasePosition + deltaPackets * 20 * playbackSpeed
  }

  private _getTimescaleSpeed(): number {
    const settings = (this.filters.filters ?? this.filters) as {
      timescale?: { speed?: number; rate?: number }
    }
    const timescale = settings.timescale || {}
    return (timescale.speed ?? 1.0) * (timescale.rate ?? 1.0)
  }

  /**
   * Captures current position and packet count as a new baseline.
   * Call whenever playback speed changes (filters, tape, scratch).
   */
  private _snapshotPosition(): void {
    if (!this.connection?.audioStream) return
    this._lyricsBasePosition = this._realPosition()
    this._lyricsBasePackets = this.connection.statistics?.packetsExpected ?? 0
  }

  /**
   * Fetches an audio resource for playback.
   */
  private async _fetchResource(
    info: TrackInfoExtended,
    urlData: TrackUrlResult & { protocol?: string; format?: TrackFormat },
    startTime?: number
  ): Promise<{ stream: AudioResource } | { exception: { message: string } }> {
    if (this.nodelink.options?.playback.mix?.enabled !== false) {
      await this._ensureAudioMixer()
    }

    await getStreamProcessor()
    const audioResourceFactory = createAudioResource
    if (!audioResourceFactory) {
      return { exception: { message: 'Stream processor not initialized' } }
    }

    const additionalData: Record<string, unknown> & {
      startTime?: number
      position?: number
      positionCallback?: (positionMs: number) => void
    } = {
      ...urlData.additionalData
    }
    if (startTime !== undefined) {
      additionalData.startTime = startTime
      // Keep both keys for source compatibility while seek handling is unified.
      additionalData.position = startTime
    }
    additionalData.guildId = this.guildId
    additionalData.positionCallback = (positionMs: number) => {
      if (!Number.isFinite(positionMs) || positionMs < 0) return
      this.position = positionMs
    }

    urlData.additionalData = additionalData

    const track = urlData?.newTrack
      ? (urlData?.newTrack?.info as TrackInfoExtended)
      : info
      
    logger('debug', 'Player', `Fetching stream resource from source for guild ${this.guildId}`, { 
      source: track.sourceName,
      url: urlData.url
    })
      
    const fetched = await this.nodelink.sources.getTrackStream(
      track,
      urlData.url as string,
      urlData.protocol as string,
      additionalData
    )
    if (fetched.exception) {
      logger('error', 'Player', `Stream resource fetch failed for guild ${this.guildId}`, fetched.exception)
      return fetched as { exception: { message: string } }
    }
    logger('debug', 'Player', `Successfully fetched stream resource for guild ${this.guildId}`)
    const fetchedStream = fetched.stream as NonNullable<typeof fetched.stream>
    const totalBytesRaw =
      (
        urlData.additionalData as
          | { contentLength?: number | string }
          | null
          | undefined
      )?.contentLength ?? null
    const totalBytesNum = Number(totalBytesRaw)
    this.profilerStreamStats = {
      downloadedBytes: 0,
      totalBytes:
        Number.isFinite(totalBytesNum) && totalBytesNum > 0
          ? totalBytesNum
          : null,
      lastChunkAt: null
    }
    let streamForResource: Readable = fetchedStream as Readable

    if (typeof (fetchedStream as { on?: unknown }).on === 'function') {
      const eventStream = fetchedStream as unknown as VoiceAudioStream
      const profilerTap = new PassThrough()
      const profilerHandler = (chunk: Buffer | Uint8Array | string) => {
        const size =
          typeof chunk === 'string'
            ? Buffer.byteLength(chunk)
            : Number((chunk as { length?: number })?.length || 0)
        if (size > 0) this.profilerStreamStats.downloadedBytes += size
        this.profilerStreamStats.lastChunkAt = Date.now()
      }
      profilerTap.on('data', profilerHandler)
      streamForResource = (fetchedStream as Readable).pipe(profilerTap)
      ;(profilerTap as unknown as Record<string, unknown>)._sourceStream =
        fetchedStream

      const eternalboxHandler = (data: unknown) => {
        this.emitEvent(GatewayEvents.ETERNALBOX_JUMP, {
          track: this.holoTrack || this.track,
          eternalbox: data
        })
      }
      const icyHandler = (data: unknown) => {
        this.emitEvent(GatewayEvents.STREAM_METADATA, {
          track: this.holoTrack || this.track,
          stream: data
        })
      }
      eventStream.on?.('eternalboxJump', eternalboxHandler)
      eventStream.on?.('icyMetadata', icyHandler)

      const cleanupListeners = () => {
        eventStream.off?.('eternalboxJump', eternalboxHandler)
        eventStream.off?.('icyMetadata', icyHandler)
        profilerTap.off('data', profilerHandler)
        profilerTap.destroy()
      }

      streamForResource.on('close', cleanupListeners)
      streamForResource.on('error', cleanupListeners)
      streamForResource.on('end', cleanupListeners)
      ;(
        streamForResource as unknown as {
          _cleanupListeners?: () => void
        }
      )._cleanupListeners = cleanupListeners
    }
    const resource = audioResourceFactory(
      this.guildId,
      streamForResource,
      fetched.type || urlData.format,
      this.nodelink,
      this.filters,
      this.volumePercent / 100,
      this.audioMixer,
      false,
      this.loudnessNormalizer
    )
    return { stream: resource }
  }

  /**
   * Sends player state updates to the client.
   */
  private _sendUpdate(): boolean {
    if (
      !this.connection ||
      (this.isPaused && !this._fadeTimers.pause) ||
      this.connStatus === 'destroyed' ||
      this.destroying
    )
      return false

    const position = this._realPosition()

    if (this.sponsorBlock.enabled && this.track) {
      // Periodic log to verify position and sb state
      if (
        Math.abs(position - this._lastPosition) > 1000 ||
        this._lastPosition === 0
      ) {
        logger(
          'debug',
          'Player',
          `[SponsorBlock][${this.guildId}] Current position: ${Math.round(position)}ms, Segments: ${this.sponsorBlock.segments.length}, LastSkipped: ${this.sponsorBlock.lastSkippedUuid}`
        )
      }
    }

    const threshold = this.nodelink.options.playback.trackStuckThresholdMs ?? 0
    if (
      threshold > 0 &&
      !this.isUpdatingTrack &&
      !this._isStopping &&
      this.track &&
      !this._isResuming &&
      !this.isPaused
    ) {
      if (this._lastPosition === position) {
        this._stuckTime +=
          this.nodelink.options.playback.playerUpdateInterval ?? 0
        if (
          this._stuckTime >= threshold &&
          !this._isRecovering &&
          this.connStatus === 'connected'
        ) {
          const stuckTime = this._stuckTime
          this._stuckTime = 0

          if (this.streamInfo?.format === 'mp4') {
            logger(
              'error',
              'Player',
              `Player for guild ${this.guildId} is stuck on an MP4 track. Emitting TRACK_STUCK without recovery.`
            )
            this.emitEvent(GatewayEvents.TRACK_STUCK, {
              guildId: this.guildId,
              track: this.track,
              thresholdMs: threshold,
              reason: 'Playback of MP4 track is stuck'
            })

            this.nodelink.pluginManager?.callHook(
              'onTrackStuck',
              this.guildId,
              this.track,
              threshold,
              'Playback of MP4 track is stuck'
            )
            this.stop()
            return false
          }

          if (!this.track.info.isSeekable) {
            if (
              this.profilerStreamStats.lastChunkAt &&
              Date.now() - this.profilerStreamStats.lastChunkAt < threshold
            ) {
              this._stuckTime = 0
              return true
            }

            logger(
              'warn',
              'Player',
              `Player for guild ${this.guildId} is stuck on a non-seekable track. Stopping track.`
            )
            this.emitEvent(GatewayEvents.TRACK_STUCK, {
              guildId: this.guildId,
              track: this.track,
              thresholdMs: threshold,
              reason: 'Track is not seekable'
            })
            this.stop()
            return false
          }
          // reason for this special check:
          // monochrome does not send 200ms of the final segment (or tidal, idk) so the player thinks its gonna be a recovery
          // this fixes it by treating as a natural "trackEnd"
          // for example: an audio is 200000ms long, it will only play until 199800ms before triggering a recovery
          const trackLength = this.track.info.length
          const audioStream = this._getAudioStream()
          const playbackSpeed =
            audioStream?.getEffectiveRate?.() ?? this._getTimescaleSpeed()
          const endThreshold = playbackSpeed < 1.0 ? 5000 : 2000

          if (trackLength > 0 && position >= trackLength - endThreshold) {
            logger(
              'debug',
              'Player',
              `Player for guild ${this.guildId} is near track end (${position}/${trackLength}ms). Treating as natural finish instead of stuck.`
            )
            this._emitTrackEnd(EndReasons.FINISHED)
            this._resetTrack()
            return false
          }

          if (this.stuckRecoveryCount >= Player.MAX_STUCK_RECOVERY_ATTEMPTS) {
            logger(
              'error',
              'Player',
              `Player for guild ${this.guildId} exceeded max recovery attempts (${Player.MAX_STUCK_RECOVERY_ATTEMPTS}). Stopping track.`
            )
            this.emitEvent(GatewayEvents.TRACK_STUCK, {
              guildId: this.guildId,
              track: this.track,
              thresholdMs: threshold,
              reason: 'Max recovery attempts exceeded'
            })
            this.stop()
            return false
          }

          logger(
            'warn',
            'Player',
            `Player for guild ${this.guildId} is stuck. Attempting to recover... (attempt ${this.stuckRecoveryCount + 1}/${Player.MAX_STUCK_RECOVERY_ATTEMPTS})`,
            {
              lastPosition: this._lastPosition,
              currentPosition: position,
              stuckTime: stuckTime,
              threshold: threshold,
              connStatus: this.connStatus,
              lastStreamDataTime:
                this._lastStreamDataTime > 0
                  ? new Date(this._lastStreamDataTime).toISOString()
                  : 'never',
              statistics: this.connection?.statistics
            }
          )
          this._isRecovering = true
          this.stuckRecoveryCount++
          this._positionAtRecoveryStart = position

          if (this.track.info.identifier && this.track.info.sourceName) {
            this.nodelink.trackCacheManager?.delete(
              this.track.info.sourceName,
              this.track.info.identifier
            )
          }

          const isStream = this.track.info.isStream
          const recoveryPosition = isStream ? 0 : this._lastPosition

          this.seek(recoveryPosition, this.track.endTime, true)
            .then((success) => {
              if (success) {
                logger(
                  'info',
                  'Player',
                  `Player for guild ${this.guildId} recovered successfully.`
                )
              } else {
                logger(
                  'error',
                  'Player',
                  `Player for guild ${this.guildId} recovery failed. Stopping track.`
                )
                this.emitEvent(GatewayEvents.TRACK_STUCK, {
                  guildId: this.guildId,
                  track: this.track,
                  thresholdMs: threshold,
                  reason: 'Recovery attempt failed'
                })
                this.stop()
              }
              this._isRecovering = false
            })
            .catch((err: Error) => {
              logger(
                'error',
                'Player',
                `Player for guild ${this.guildId} recovery attempt threw an error: ${err.message}. Stopping track.`
              )
              this.emitEvent(GatewayEvents.TRACK_STUCK, {
                guildId: this.guildId,
                track: this.track,
                thresholdMs: threshold,
                reason: `Recovery attempt failed: ${err.message}`
              })
              this.stop()
              this._isRecovering = false
            })
        }
      } else {
        this._stuckTime = 0
        this._isRecovering = false
      }
    }

    if (position !== this._lastPosition) {
      this._lastStreamDataTime = Date.now()
      if (this.stuckRecoveryCount > 0) {
        const meaningfulAdvance = 2000
        if (position - this._positionAtRecoveryStart >= meaningfulAdvance) {
          this.stuckRecoveryCount = 0
        }
      }
    }

    this._lastPosition = position
    this._syncLyrics()

    if (
      this.sponsorBlock.enabled &&
      !this.isPaused &&
      this.track &&
      !this._isResuming &&
      !this._isRecovering &&
      !this._isSeeking
    ) {
      const segment = this.sponsorBlock.segments.find(
        (s: SponsorBlockSegment) =>
          this.sponsorBlock.categories.includes(s.category) &&
          this.sponsorBlock.actionTypes.includes(s.actionType) &&
          position + this.sponsorBlock.skipMarginMs >= s.start &&
          position < s.end &&
          this.sponsorBlock.lastSkippedUuid !== s.uuid
      )

      if (segment) {
        this.sponsorBlock.lastSkippedUuid = segment.uuid
        const skippedMs = segment.end - position
        logger(
          'info',
          'Player',
          `[SponsorBlock][${this.guildId}] Skipping segment: uuid=${segment.uuid} category=${segment.category} start=${segment.start}ms end=${segment.end}ms (Skipped: ${skippedMs}ms) for video ${this.track.info.identifier}`
        )
        this.seek(segment.end)
          .then((success) => {
            if (success) {
              logger(
                'debug',
                'Player',
                `[SponsorBlock][${this.guildId}] Successfully jumped to ${segment.end}ms`
              )
              this.emitEvent(GatewayEvents.SPONSORBLOCK_SEGMENT_SKIPPED, {
                track: this.track,
                segment
              })
            } else {
              logger(
                'warn',
                'Player',
                `[SponsorBlock][${this.guildId}] Failed to jump to ${segment.end}ms for segment ${segment.uuid}`
              )
              // fallback: temporarily mute or un-stick if it fails
              this.sponsorBlock.lastSkippedUuid = null
            }
          })
          .catch((err) => {
            logger(
              'error',
              'Player',
              `[SponsorBlock][${this.guildId}] Error while seeking to segment end:`,
              err
            )
            this.sponsorBlock.lastSkippedUuid = null
          })
        return true
      }
    }

    if (this._isSeeking) return true

    this.session.socket.send(
      JSON.stringify({
        op: GatewayEvents.PLAYER_UPDATE,
        guildId: this.guildId,
        state: {
          time: Date.now(),
          position,
          connected: this.connStatus === 'connected',
          ping:
            this.connection && this.connection.ping >= 0
              ? this.connection.ping
              : 0
        }
      })
    )
    return true
  }

  /**
   * Starts playback for the current track.
   */
  private async _connectAndPlayStream(
    urlData: TrackUrlResult,
    position: number,
    cleanupReason: string,
    fadingAction: 'trackStartArm' | 'seekPrepare',
    playLogMessage: string
  ): Promise<boolean> {
    if (!this.track) return false

    if (!this.connection) {
      this._initConnection()
    }

    if (!this.connection?.udpInfo?.secretKey) {
      logger(
        'debug',
        'Player',
        `Waiting for voice connection to be ready for guild ${this.guildId}`
      )
      try {
        await this.waitEvent(
          'stateChange',
          (s: VoiceConnectionState) =>
            s.status === 'connected' && !!this.connection?.udpInfo?.secretKey
        )
      } catch (err) {
        logger('warn', 'Player', `Timeout or error while waiting for voice connection on guild ${this.guildId}:`, err)
      }
    }

    if (!this.connection?.udpInfo?.secretKey) {
      const errorMessage = `Voice connection for guild ${this.guildId} is not ready (missing UDP info). Aborting playback.`
      logger('error', 'Player', errorMessage)
      this._onError(new Error(errorMessage))
      return false
    }

    const fetched = await this._fetchResource(
      this.track.info,
      urlData,
      position
    )
    if ('exception' in fetched) {
      const err = new Error(fetched.exception.message)
      this._onError(err)
      return false
    }

    this._cleanupCurrentAudioStream(cleanupReason)

    const resource = fetched.stream
    if (this.volumePercent !== 100) {
      resource.setVolume(this.volumePercent / 100)
    }

    this._fading(fadingAction, { resource })
    this.setFilters(this.filters)

    logger('debug', 'Player', playLogMessage)
    this.connection.play(resource as unknown)

    await this.waitEvent(
      'playerStateChange',
      (s: VoicePlayerState) => s.status === 'playing'
    )

    this._lyricsBasePosition = position
    this._lyricsBasePackets = this.connection?.statistics?.packetsExpected ?? 0

    return true
  }

  private async _startPlayback(startTime = 0): Promise<boolean> {
    if (!this.track) return false

    const trackInfo: TrackInfoExtended = {
      ...this.track.info,
      audioTrackId: this.track.audioTrackId
    }

    const urlData = await this.nodelink.sources.getTrackUrl(
      trackInfo,
      undefined,
      this._isRecovering
    )
    const urlDataWithFormats = urlData as TrackUrlResult & {
      formats?: unknown[]
    }
    if (!this.track) return false
    this.streamInfo = { ...urlData, trackInfo: this.track.info }
    logger('debug', 'Player', `Got track URL for guild ${this.guildId}`, {
      urlData
    })

    if (urlData.exception) {
      const err = new Error(urlData.exception.message)
      this._onError(err)
      return false
    }

    const result = await this._connectAndPlayStream(
      urlData,
      startTime,
      'start-playback',
      'trackStartArm',
      `Playing resource for guild ${this.guildId}`
    )
    if (!result) return false

    this._fading('trackEndSchedule', { startPosition: startTime || 0 })
    this._stuckTime = 0
    if (
      this.track.info.sourceName === 'youtube' ||
      this.track.info.sourceName === 'ytmusic'
    ) {
      this.sponsorBlock.segments = []
      this.sponsorBlock.lastSkippedUuid = null

      const videoId = this.track.info.identifier
      const sbConfig = this.nodelink.options.playback.sponsorblock

      if (this.sponsorBlock.enabled) {
        logger(
          'debug',
          'Player',
          `[SponsorBlock][${this.guildId}] Initiating segment fetch for video ${videoId}`
        )
        const { fetchSponsorBlockSegments } = await import('../utils.ts')
        fetchSponsorBlockSegments(
          videoId,
          this.sponsorBlock.categories,
          this.sponsorBlock.actionTypes,
          sbConfig?.api
        )
          .then((segments) => {
            if (
              this.destroying ||
              !this.track ||
              this.track.info.identifier !== videoId
            ) {
              logger(
                'debug',
                'Player',
                `[SponsorBlock][${this.guildId}] Ignoring fetched segments for ${videoId} (track changed or player destroyed)`
              )
              return
            }
            this.sponsorBlock.segments = segments
            logger(
              'info',
              'Player',
              `[SponsorBlock][${this.guildId}] Applied ${segments.length} segments for video ${videoId}`
            )
            if (segments.length > 0) {
              this.emitEvent(GatewayEvents.SPONSORBLOCK_SEGMENTS_LOADED, {
                segments
              })

              // Immediate check after load
              this._sendUpdate()
            }
          })
          .catch((err) => {
            logger(
              'error',
              'Player',
              `[SponsorBlock][${this.guildId}] Error fetching segments for ${videoId}:`,
              err
            )
          })
      } else {
        logger(
          'debug',
          'Player',
          `[SponsorBlock][${this.guildId}] Auto-skip disabled, skipping segment fetch for ${videoId}`
        )
      }
    }

    return true
  }

  /**
   * Starts playback for the provided track payload.
   *
   * @param payload - Track data plus playback options.
   * @param payload.noReplace - When true, keeps current track if already playing.
   * @param payload.startTime - Initial seek position in milliseconds.
   * @param payload.endTime - Optional end time to truncate playback.
   * @returns True when the request is accepted (actual start is async).
   */
  public async play({
    encoded,
    info,
    userData,
    audioTrackId,
    noReplace = false,
    startTime,
    endTime = 0
  }: PlayPayload): Promise<boolean> {
    logger('debug', 'Player', `[Action: play] Method invoked for guild ${this.guildId} with track ${info.identifier}`)
    return new Promise((resolve) => {
      this.isUpdatingTrack = true

      try {
        if (this.destroying) {
          logger(
            'debug',
            'Player',
            `play() aborted for guild ${this.guildId} because player is destroying`
          )
          this.isUpdatingTrack = false
          return resolve(false)
        }
        logger('debug', 'Player', `play() called for guild ${this.guildId}`, {
          encoded,
          noReplace,
          startTime,
          endTime,
          track: info
        })

        if (noReplace && this.track && this.connection?.audioStream) {
          const isAlreadyPlaying =
            this.track?.info.identifier === info.identifier

          if (isAlreadyPlaying) {
            logger(
              'info',
              'Player',
              `play() for guild ${this.guildId} adopted (already playing/transitioning ${info.identifier})`
            )
            this.isUpdatingTrack = false
            return resolve(true)
          }

          logger(
            'debug',
            'Player',
            `play() aborted for guild ${this.guildId} due to noReplace=true and player is active`
          )
          this.isUpdatingTrack = false
          return resolve(false)
        }

        if (this.track) {
          this._emitTrackEnd(EndReasons.REPLACED)
          this._cleanupCurrentAudioStream('track-replaced')
        }

        this._lastStreamDataTime = 0
        this.track = { encoded, info, endTime, userData, audioTrackId }
        this._fading('reset')

        if (!this.voice.endpoint || !this.voice.token) {
          logger(
            'debug',
            'Player',
            `No voice state for guild ${this.guildId}, track is enqueued and will play when voice state is provided.`
          )
          this.isUpdatingTrack = false
          return resolve(true)
        }

        this._startPlayback(
          startTime !== undefined
            ? startTime === 0 && this.position < 1000
              ? 0
              : startTime
            : 0
        )
          .catch((err) => this._onError(err))
          .finally(() => {
            this.isUpdatingTrack = false
          })

        return resolve(true)
      } catch (e) {
        this.isUpdatingTrack = false
        this._onError(e as Error)
        return resolve(false)
      }
    })
  }

  /**
   * Performs a seek operation to the requested position.
   *
   * @param position - Target position in milliseconds. Uses current position when omitted.
   * @param endTime - Optional end time to enforce after the seek.
   * @returns True when the seek succeeds; false otherwise.
   */
  public async seek(
    position?: number,
    endTime?: number,
    forceLegacy = false
  ): Promise<boolean> {
    logger('debug', 'Player', `[Action: seek] Method invoked for guild ${this.guildId} with target position: ${position}ms`)
    if (this.destroying || !this.track) {
      logger('debug', 'Player', `[Action: seek] Aborted for guild ${this.guildId}: destroying=${this.destroying}, hasTrack=${!!this.track}`)
      return false
    }
    if (!this.track.info.isSeekable && !this.track.info.isStream) return false

    const streamFormat =
      typeof this.streamInfo?.format === 'string'
        ? this.streamInfo.format.toLowerCase()
        : ''
    if (streamFormat.includes('flac')) {
      logger(
        'warn',
        'Player',
        `Seeking not supported for FLAC stream on guild ${this.guildId}`
      )
      return false
    }

    const seekPosition = position ?? this._realPosition()

    if (
      seekPosition === 0 &&
      !this._isRecovering &&
      this._realPosition() < 2000
    ) {
      logger('debug', 'Player', 'Ignoring seek to 0 as track has just started.')

      return false
    }

    if (
      seekPosition < 0 ||
      (this.track.info.length > 0 && seekPosition > this.track.info.length)
    )
      return false
    this._isSeeking = true
    try {
      const sourceName = this.track.info.sourceName
      const resolvedSourceName =
        (this.streamInfo?.newTrack as { info?: { sourceName?: string } } | null)
          ?.info?.sourceName ?? sourceName
      const unsupportedSources = ['local', 'deezer']

      let seekPromise: Promise<boolean>
      if (!this.streamInfo?.url) {
        logger(
          'debug',
          'Player',
          'No stream info URL available for seek. awaiting getTrackUrl.'
        )
        await sleep(1600)
        if (!this.streamInfo?.url) {
          logger(
            'debug',
            'Player',
            'Still no stream info URL available for seek.'
          )
          if (this.track) {
            const trackInfo = {
              ...this.track.info,
              audioTrackId: this.track.audioTrackId
            }
            const urlData = await this.nodelink.sources.getTrackUrl(trackInfo)
            if (!this.track) return false
            this.streamInfo = { ...urlData, trackInfo: this.track.info }
            logger(
              'debug',
              'Player',
              'Fetched stream info URL for seek after wait.'
            )
          }
        } else {
          logger(
            'debug',
            'Player',
            'Stream info URL became available during wait.'
          )
        }
      }

      const source = this.nodelink.sources.getSource(sourceName)
      const hasSourceLoader = source && typeof source.loadStream === 'function'
      const canNativeSeek =
        !!hasSourceLoader &&
        (this.streamInfo?.protocol === 'sabr' ||
          (sourceName === 'deezer' && resolvedSourceName === 'deezer'))

      if (forceLegacy) {
        seekPromise = this._legacySeek(
          seekPosition,
          endTime !== undefined ? endTime : this.track.endTime
        )
      } else if (canNativeSeek) {
        seekPromise = this._seekUsingSource(
          seekPosition,
          endTime !== undefined ? endTime : this.track.endTime
        )
      } else if (
        !unsupportedSources.includes(resolvedSourceName) &&
        this.streamInfo?.url &&
        this.streamInfo.protocol !== 'hls' &&
        this.streamInfo.protocol !== 'dash'
      ) {
        seekPromise = this._seekeableSeek(
          seekPosition,
          endTime !== undefined ? endTime : this.track.endTime
        )
      } else {
        seekPromise = this._legacySeek(
          seekPosition,
          endTime !== undefined ? endTime : this.track.endTime
        )
      }

      const startPosition = this._realPosition()
      const result = await seekPromise
      if (result) {
        this.emitEvent(GatewayEvents.SEEK, {
          position: this.position,
          duration: this.position - startPosition
        })
        if (this._lyricsMarkerTimer) {
          clearTimeout(this._lyricsMarkerTimer)
          this._lyricsMarkerTimer = null
        }
        if (this.isLyricsSubscribed)
          this._recalculateLyricsIndex(undefined, undefined, true)
        this._fading('seek')
        this._fading('trackEndSchedule', { startPosition: this.position })
      }
      return result
    } catch (e) {
      logger('error', 'Player', `Seek failed for guild ${this.guildId}`, e)
      this._onError(e as Error)
      return false
    } finally {
      this._isSeeking = false
    }
  }

  /**
   * Seeks using source-native capabilities (e.g., SABR/Deezer).
   */
  private async _seekUsingSource(
    position: number,
    endTime?: number
  ): Promise<boolean> {
    if (!this.track) return false

    logger(
      'debug',
      'Player',
      `Seeking using source (native) to ${position}ms for guild ${this.guildId}`
    )

    this.position = position
    this.track.endTime = endTime
    let previousSession: unknown = null
    let reuseUrlData: TrackUrlResult | null = null

    if (this.streamInfo?.protocol === 'sabr' && this.connection?.audioStream) {
      const inputStream = (
        this.connection.audioStream as { pipes?: Array<{ getSessionState?: () => unknown }> }
      )?.pipes?.[0]
      
      const previousSession = inputStream?.getSessionState?.()
      if (previousSession) {
          logger(
            'debug',
            'Player',
            `Extracted SABR session state: rn=${
              (previousSession as { requestNumber?: number }).requestNumber
            }, hasCookie=${!!(
              previousSession as {
                nextRequestPolicy?: { playbackCookie?: unknown }
              }
            ).nextRequestPolicy?.playbackCookie}`
          )

          reuseUrlData = {
            protocol: this.streamInfo.protocol,
            url: this.streamInfo.url,
            additionalData: {
              ...this.streamInfo.additionalData,
              previousSession,
              startTime: position
            }
          } as TrackUrlResult

          logger(
            'debug',
            'Player',
            `Reusing existing SABR streaming URL for seek to maintain session`
          )
        }
      }

    const trackInfo = {
      ...this.track.info,
      audioTrackId: this.track.audioTrackId
    }

    const urlData =
      reuseUrlData || (await this.nodelink.sources.getTrackUrl(trackInfo))
    this.streamInfo = { ...urlData, trackInfo: this.track.info }

    if (urlData.exception) {
      const err = new Error(urlData.exception.message)
      this._onError(err)
      return false
    }

    const result = await this._connectAndPlayStream(
      urlData,
      position,
      'source-seek',
      'seekPrepare',
      `Playing resource for guild ${this.guildId} after source seek`
    )
    if (!result) return false

    return true
  }

  /**
   * Seeks using seekable-stream helper for compatible sources.
   */
  private async _seekeableSeek(
    position: number,
    endTime?: number
  ): Promise<boolean> {
    if (this.nodelink.options?.playback.mix?.enabled !== false) {
      await this._ensureAudioMixer()
    }

    await getStreamProcessor()
    const seekResourceFactory = createSeekeableAudioResource
    if (!seekResourceFactory) {
      return this._legacySeek(position, endTime)
    }

    logger(
      'debug',
      'Player',
      `Seeking with Seekeable to ${position}ms for guild ${this.guildId}`
    )
    this.position = position

    try {
      const url = this.streamInfo?.url
      if (!url) return false

      const resourceResult = await seekResourceFactory(
        this.guildId,
        url,
        position,
        endTime,
        this.nodelink,
        this.filters,
        this,
        this.volumePercent / 100,
        this.audioMixer
      )

      if (
        (
          resourceResult as {
            exception?: { message: string; severity?: string }
          }
        ).exception
      ) {
        const exception = (
          resourceResult as {
            exception: { message: string; severity?: string }
          }
        ).exception
        logger(
          'error',
          'Player',
          `Seekeable resource creation failed for guild ${this.guildId}: ${exception.message}. Falling back to old method.`
        )
        this.emitEvent(GatewayEvents.TRACK_EXCEPTION, {
          track: this.track,
          exception
        })
        this._emitTrackEnd(EndReasons.LOAD_FAILED)
        return this._legacySeek(position, endTime)
      }

      const resource = resourceResult as AudioResource

      if (this.volumePercent !== 100) {
        resource.setVolume(this.volumePercent / 100)
      }
      this._fading('seekPrepare', { resource })
      resource.setFilters(this.filters)

      const oldStream = this.connection?.play(resource as unknown)
      await this.waitEvent(
        'playerStateChange',
        (s: VoicePlayerState) => s.status === 'playing'
      )
      if (oldStream) {
        oldStream.destroy()
      }

      this._lyricsBasePosition = position
      this._lyricsBasePackets =
        this.connection?.statistics?.packetsExpected ?? 0

      return true
    } catch (e) {
      const err = e as Error
      logger(
        'error',
        'Player',
        `An unexpected error occurred during seekeable seek for guild ${this.guildId}: ${err.message}. Falling back to old method.`
      )
      this.emitEvent(GatewayEvents.TRACK_EXCEPTION, {
        track: this.track,
        exception: {
          message: err.message,
          severity: 'fault',
          cause: 'UNKNOWN_ERROR'
        }
      })
      this._emitTrackEnd(EndReasons.LOAD_FAILED)
      return this._legacySeek(position, endTime)
    }
  }

  /**
   * Seeks using legacy re-fetch strategy.
   */
  private async _legacySeek(
    position: number,
    endTime?: number
  ): Promise<boolean> {
    if (!this.track) return false
    if (
      position < 0 ||
      (this.track.info.length > 0 && position > this.track.info.length)
    )
      return false

    logger(
      'debug',
      'Player',
      `Seeking with legacy method to ${position}ms for guild ${this.guildId}`
    )

    this.position = position
    this.track.endTime = endTime

    const trackInfo = {
      ...this.track.info,
      audioTrackId: this.track.audioTrackId
    }

    const urlData = await this.nodelink.sources.getTrackUrl(
      trackInfo,
      undefined,
      this._isRecovering
    )
    if (!this.track) return false
    this.streamInfo = { ...urlData, trackInfo: this.track.info }

    if (urlData.exception) {
      const err = new Error(urlData.exception.message)
      this._onError(err)
      return false
    }

    if (!this.connection) {
      this._initConnection()
    }

    if (!this.connection?.udpInfo?.secretKey) {
      logger(
        'debug',
        'Player',
        `Waiting for voice connection to be ready for guild ${this.guildId}`
      )
      await this.waitEvent(
        'stateChange',
        (s: VoiceConnectionState) =>
          s.status === 'connected' && !!this.connection?.udpInfo?.secretKey
      )
    }

    if (!this.connection?.udpInfo?.secretKey) {
      const errorMessage = `Voice connection for guild ${this.guildId} is not ready (missing UDP info). Aborting playback.`
      logger('error', 'Player', errorMessage)
      this._onError(new Error(errorMessage))
      return false
    }

    const fetched = await this._fetchResource(
      this.track.info,
      urlData,
      position
    )
    if ('exception' in fetched) {
      const err = new Error(fetched.exception.message)
      this._onError(err)
      return false
    }

    this._cleanupCurrentAudioStream('legacy-seek')

    const resource = fetched.stream
    if (this.volumePercent !== 100) {
      resource.setVolume(this.volumePercent / 100)
    }
    this._fading('seekPrepare', { resource })

    this.setFilters(this.filters)

    logger(
      'debug',
      'Player',
      `Playing resource for guild ${this.guildId} after legacy seek`
    )
    this.connection.play(resource as unknown)
    await this.waitEvent(
      'playerStateChange',
      (s: VoicePlayerState) => s.status === 'playing'
    )

    this._lyricsBasePosition = position
    this._lyricsBasePackets = this.connection?.statistics?.packetsExpected ?? 0

    return true
  }

  /**
   * Stops playback and emits STOPPED if applicable.
   *
   * @returns True when stop was executed; false when no active track.
   */
  public stop(): boolean {
    logger('debug', 'Player', `[Action: stop] Executing stop for guild ${this.guildId}`)
    this.isUpdatingTrack = true
    try {
      if (this.destroying || !this.track) {
        logger('debug', 'Player', `[Action: stop] Aborted for guild ${this.guildId}: destroying=${this.destroying}, hasTrack=${!!this.track}`)
        return false
      }

      if (this.nextResource) {
        this.nextResource.destroy()
        this.nextResource = null
        this.nextTrack = null
        this.nextStreamInfo = null
      }

      if (this.connection && this.connStatus !== 'destroyed') {
        if (this.connection.audioStream) {
          this._isStopping = true
          if (this._fading('trackStop')) return true
          this._isStopping = false
          this.connection.stop(EndReasons.STOPPED)
        } else {
          this._emitTrackEnd(EndReasons.STOPPED)
          this._resetTrack()
        }
      } else {
        this._emitTrackEnd(EndReasons.STOPPED)
        this._resetTrack()
      }
      return true
    } finally {
      this.isUpdatingTrack = false
    }
  }

  /**
   * Preloads the next track for gapless playback.
   *
   * @param payload - Track to prepare in advance.
   * @returns True when preload succeeded.
   */
  public async preload(payload: PlayerTrack): Promise<boolean> {
    logger('debug', 'Player', `[Action: preload] Method invoked for guild ${this.guildId} with track ${payload.info.identifier}`)
    if (this.destroying) {
      logger('debug', 'Player', `[Action: preload] Aborted for guild ${this.guildId}: player is destroying`)
      return false
    }

    const sameEncoded =
      !!payload.encoded &&
      !!this.nextTrack?.encoded &&
      this.nextTrack.encoded === payload.encoded
    const sameIdentifier =
      !!payload.info?.identifier &&
      !!this.nextTrack?.info?.identifier &&
      this.nextTrack.info.identifier === payload.info.identifier
    const isDuplicatePreload =
      (sameEncoded || sameIdentifier) && !!this.nextResource

    if (isDuplicatePreload) {
      logger(
        'debug',
        'Player',
        `Skipping duplicate preload for ${this.guildId}`,
        {
          identifier: payload.info?.identifier,
          encodedMatch: sameEncoded,
          identifierMatch: sameIdentifier
        }
      )
      return true
    }

    if (this.nextResource) {
      this.nextResource.destroy()
      this.nextResource = null
      this.nextTrack = null
      this.nextStreamInfo = null
    }

    try {
      const trackInfo = {
        ...payload.info,
        audioTrackId: payload.audioTrackId
      }

      const urlData = await this.nodelink.sources.getTrackUrl(trackInfo)
      if (urlData.exception) return false

      const fetched = await this._fetchResource(payload.info, urlData, 0)
      if ('exception' in fetched) return false

      this.nextTrack = payload
      this.nextResource = fetched.stream
      this.nextStreamInfo = { ...urlData, trackInfo: payload.info }

      if (this.volumePercent !== 100) {
        this.nextResource.setVolume(this.volumePercent / 100)
      }
      this.nextResource.setFilters(this.filters)

      return true
    } catch (err) {
      const error = err as Error
      logger(
        'error',
        'Player',
        `Preload failed for guild ${this.guildId}: ${error.message}`
      )
      return false
    }
  }

  /**
   * Clears any queued/preloaded next track.
   *
   * @returns True when state was cleared.
   */
  public clearNextTrack(): boolean {
    logger('debug', 'Player', `[Action: clearNextTrack] Method invoked for guild ${this.guildId}`)
    if (this.destroying) return false

    if (this.nextResource) {
      this.nextResource.destroy()
      this.nextResource = null
    }

    this.nextTrack = null
    this.nextStreamInfo = null

    return true
  }

  /**
   * Pauses or resumes playback.
   *
   * @param shouldPause - True to pause, false to resume.
   * @returns True when state changed; false otherwise.
   */
  public pause(shouldPause: boolean): boolean {
    logger('debug', 'Player', `[Action: pause] Method invoked for guild ${this.guildId} with target: ${shouldPause}`)
    if (this.destroying || this.isPaused === shouldPause) {
      logger('debug', 'Player', `[Action: pause] Aborted for guild ${this.guildId}: destroying=${this.destroying}, alreadyPaused=${this.isPaused === shouldPause}`)
      return false
    }
    logger(
      'debug',
      'Player',
      `Setting pause to ${shouldPause} for guild ${this.guildId}`
    )

    if (shouldPause) {
      this._pausedAtPosition = this._realPosition()

      if (this._fadeTimers?.trackEnd) {
        clearTimeout(this._fadeTimers.trackEnd)
        this._fadeTimers.trackEnd = null
      }

      if (this._fading('pause')) {
        this.isPaused = true
        this.emitEvent(GatewayEvents.PAUSE, { paused: true })
        return true
      }

      this.isPaused = true
      this.connection?.pause?.('requested')
    } else {
      this.isPaused = false
      this._isResuming = true
      this._fading('resume')
      this.connection?.unpause?.('requested')
    }

    this.emitEvent(GatewayEvents.PAUSE, { paused: this.isPaused })
    return true
  }

  /**
   * Adjusts playback volume (0-1000).
   *
   * @param level - Volume percentage (0-1000).
   * @returns True when volume was updated.
   */
  public volume(level: number): boolean {
    logger('debug', 'Player', `[Action: volume] Method invoked for guild ${this.guildId} with target: ${level}`)
    if (this.destroying) {
      logger('debug', 'Player', `[Action: volume] Aborted for guild ${this.guildId}: player is destroying`)
      return false
    }
    logger(
      'debug',
      'Player',
      `Setting volume to ${level} for guild ${this.guildId}`
    )
    this.volumePercent = Math.max(0, Math.min(1000, level))
    this.connection?.audioStream?.setVolume(this.volumePercent / 100)
    this.nextResource?.setVolume(this.volumePercent / 100)
    this.emitEvent(GatewayEvents.VOLUME_CHANGED, { volume: this.volumePercent })
    return true
  }

  /**
   * Sets fading configuration.
   *
   * @param config - New fading config; disables fading when undefined.
   * @returns Always true.
   */
  public setFading(config?: FadingConfig): boolean {
    logger('debug', 'Player', `[Action: setFading] Method invoked for guild ${this.guildId}`)
    this.fading = config
    return true
  }

  /**
   * Toggles loudness normalization.
   *
   * @param enabled - Whether to enable loudness normalization.
   * @returns True when updated.
   */
  public setLoudnessNormalizer(enabled: boolean): boolean {
    logger('debug', 'Player', `[Action: setLoudnessNormalizer] Method invoked for guild ${this.guildId} to ${enabled}`)
    this.loudnessNormalizer = !!enabled
    if (this.connection?.audioStream) {
      this.connection.audioStream.setLoudnessNormalizer?.(
        this.loudnessNormalizer
      )
    }
    return true
  }

  /**
   * Applies audio filters to the active stream.
   *
   * @param filters - Filter payload that replaces the active filter set.
   * @returns True when filters applied; false if player inactive.
   */
  public setFilters(filters: FiltersState): boolean {
    logger('debug', 'Player', `[Action: setFilters] Method invoked for guild ${this.guildId}`)
    if (this.destroying || !this.track) {
      logger('debug', 'Player', `[Action: setFilters] Aborted for guild ${this.guildId}: destroying=${this.destroying}, hasTrack=${!!this.track}`)
      return false
    }
    logger(
      'debug',
      'Player',
      `Applying filters for guild ${this.guildId}:`,
      filters
    )

    const payload =
      (filters.filters as Record<string, unknown> | undefined) ??
      (filters as Record<string, unknown> | undefined)
    const filterTransitions = this._getFilterTransitions()

    const newFilterSettings: Record<string, FilterStateEntry> = {}

    if (payload && Object.keys(payload).length > 0) {
      for (const key in payload) {
        const value = payload[key]
        if (value === null || value === undefined) {
          continue
        }

        if (key === 'equalizer') {
          if (Array.isArray(value)) {
            newFilterSettings[key] = { bands: value }
          } else {
            newFilterSettings[key] = isObjectRecord(value)
              ? (value as FilterStateEntry)
              : { value }
          }
        } else {
          const existing = (
            this.filters.filters as Record<string, unknown> | undefined
          )?.[key]
          if (
            existing &&
            typeof existing === 'object' &&
            !Array.isArray(existing) &&
            typeof value === 'object' &&
            !Array.isArray(value)
          ) {
            const merged: Record<string, unknown> = {
              ...(existing as Record<string, unknown>),
              ...(value as Record<string, unknown>)
            }
            const mergedFilter = merged as FilterStateEntry
            if (mergedFilter._disabled) {
              delete mergedFilter._disabled
            }
            newFilterSettings[key] = mergedFilter
          } else {
            newFilterSettings[key] = {
              ...(value as Record<string, unknown>)
            }
            const newFilter = newFilterSettings[key]
            if (isObjectRecord(newFilter) && newFilter._disabled) {
              delete newFilter._disabled
            }
          }
        }

        const filterBlock = newFilterSettings[key]
        if (
          filterBlock &&
          typeof filterBlock === 'object' &&
          !filterBlock.transition &&
          filterTransitions?.enabled
        ) {
          filterBlock.transition = {
            durationMs: filterTransitions.durationMs ?? 4000,
            curve: filterTransitions.curve ?? 'sinusoidal'
          }
        }
      }
    }

    const oldFilters =
      (this.filters.filters as Record<string, unknown> | undefined) || {}
    for (const key in oldFilters) {
      if (!(key in newFilterSettings)) {
        const existingFilter = oldFilters[key] as FilterStateEntry | undefined
        if (existingFilter?._disabled === true) continue

        newFilterSettings[key] = {
          _disabled: true,
          ...(filterTransitions?.enabled
            ? {
                transition: {
                  durationMs: filterTransitions.durationMs ?? 4000,
                  curve: filterTransitions.curve ?? 'sinusoidal'
                }
              }
            : {})
        }
      }
    }

    this.filters = { ...this.filters, filters: newFilterSettings }

    if (this.connection?.audioStream) {
      this._snapshotPosition()
      this.connection.audioStream.setFilters(this.filters)
    }
    this.nextResource?.setFilters(this.filters)

    const disabledKeys: string[] = []
    for (const key in newFilterSettings) {
      const val = newFilterSettings[key]
      if (val?._disabled === true) {
        disabledKeys.push(key)
      }
    }
    if (disabledKeys.length > 0) {
      const cleanupDisabledFilters = () => {
        const current = { ...(this.filters.filters ?? {}) } as Record<
          string,
          unknown
        >
        let changed = false
        for (const key of disabledKeys) {
          const entry = current[key] as FilterStateEntry | undefined
          if (entry?._disabled === true) {
            delete current[key]
            changed = true
          }
        }
        if (changed) {
          this.filters = { ...this.filters, filters: current }
        }
      }

      const maxTransitionMs = Math.max(
        ...disabledKeys.map((key) => {
          const val = newFilterSettings[key]
          const tr = val?.transition
          return tr?.durationMs ?? 0
        })
      )
      if (maxTransitionMs <= 0) {
        cleanupDisabledFilters()
      } else {
        const cleanupTimer = setTimeout(() => {
          cleanupDisabledFilters()
        }, maxTransitionMs + 500)
        cleanupTimer.unref?.()
      }
    }

    this.emitEvent(GatewayEvents.FILTERS_CHANGED, { filters: this.filters })

    return true
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
    logger('debug', 'Player', `[Action: updateVoice] Method invoked for guild ${this.guildId} with force=${force}`)
    if (this.destroying) return

    const { sessionId, token, endpoint, channelId } = voicePayload

    let changed = false
    if (sessionId !== undefined && this.voice.sessionId !== sessionId) {
      this.voice.sessionId = sessionId
      changed = true
    }
    if (token !== undefined && this.voice.token !== token) {
      this.voice.token = token
      changed = true
    }
    if (endpoint !== undefined && this.voice.endpoint !== endpoint) {
      this.voice.endpoint = endpoint
      changed = true
    }
    if (channelId !== undefined && this.voice.channelId !== channelId) {
      this.voice.channelId = channelId
      changed = true
    }

    if (this.voice.sessionId && this.voice.token && this.voice.endpoint) {
      if (!changed && !force) {
        logger(
          'debug',
          'Player',
          `Voice state for guild ${this.guildId} is unchanged. Skipping update.`
        )
        return
      }

      logger(
        'debug',
        'Player',
        `Updating voice state for guild ${this.guildId}`
      )
      if (!this.connection) this._initConnection()
      if (this.voice.channelId && this.connection) {
        this.connection.channelId = this.voice.channelId
      }
      this.connection?.voiceStateUpdate({ session_id: this.voice.sessionId })
      if (force && this.connection?.voiceServer) {
        this.connection.voiceServer = null
      }
      this.connection?.voiceServerUpdate({
        token: this.voice.token,
        endpoint: this.voice.endpoint
      })
      this.connection?.connect(async () => {
        if (this.destroying) return
        if (this.connection?.audioStream && !this.isPaused) {
          this.connection.unpause?.('reconnected')
        }

        if (
          this.track &&
          !this.connection?.audioStream &&
          !this.isUpdatingTrack
        ) {
          logger(
            'debug',
            'Player',
            `Voice state updated for guild ${this.guildId}, starting pending track.`
          )
          await this._startPlayback().catch((err) => {
            logger(
              'error',
              'Player',
              `Failed to start pending track during voice update for guild ${this.guildId}:`,
              err
            )
          })
        }
      })
    } else {
      logger(
        'warn',
        'Player',
        `Incomplete voice update for guild ${this.guildId}. Missing sessionId, token, or endpoint.`
      )
    }
  }

  /**
   * Destroys the player and cleans up the voice connection.
   *
   * @param emitClose - Whether to emit WEBSOCKET_CLOSED to the client.
   */
  public destroy(emitClose = true): void {
    logger('debug', 'Player', `[Action: destroy] Method invoked for guild ${this.guildId} with emitClose=${emitClose}`)
    if (this.destroying) return
    this.destroying = true
    if (this.connection) {
      try {
        if (this.connection.audioStream) {
          this.connection.stop(EndReasons.CLEANUP)
          this._cleanupCurrentAudioStream('destroy')
        }
        this.connection.destroy()
        this.connection = null
      } catch (err) {
        const error = err as Error
        logger(
          'error',
          'internal',
          `Failed to destroy connection for guild ${this.guildId}: ${error.message} `
        )
      }
    }
    if (emitClose) {
      this.emitEvent(GatewayEvents.WEBSOCKET_CLOSED, {
        code: 1000,
        reason: 'destroyed by client',
        byRemote: false
      })
    }
    this.emitEvent(GatewayEvents.PLAYER_DESTROYED, {
      guildId: this.guildId
    })

    if (this.audioMixer) {
      this.audioMixer.destroy()
      this.audioMixer = null
    }
    this._audioMixerInitPromise = null

    this._resetTrack()
    this.connStatus = 'destroyed'
    this.volumePercent = this.nodelink.options?.defaultVolume ?? 100
  }

  /**
   * Adds an additional mix layer over the main stream.
   *
   * @param trackPayload - Track to mix in PCM form.
   * @param volume - Optional mix volume (0-1). Defaults to mix config.
   * @throws Error when no active main stream or mixer limits exceeded.
   */
  public async addMix(
    trackPayload: PlayerTrack,
    volume: number | null = null
  ): Promise<{
    id: string
    track: PlayerTrack
    volume: number
  }> {
    logger('debug', 'Player', `[Action: addMix] Method invoked for guild ${this.guildId}`)
    if (!this.track || this.isPaused) {
      throw new Error('Cannot add mix without an active stream')
    }

    await this._ensureAudioMixer()
    if (!this.audioMixer) throw new Error('AudioMixer not initialized')

    const mixConfig = this.nodelink?.options?.playback.mix ?? {
      enabled: true,
      defaultVolume: 0.8,
      maxLayersMix: 5
    }

    if (this.audioMixer.mixLayers.size >= (mixConfig.maxLayersMix ?? 5)) {
      throw new Error(
        `Maximum number of mix layers(${mixConfig.maxLayersMix}) reached`
      )
    }

    const mixVolume = volume ?? mixConfig.defaultVolume ?? 0.8

    const { createAudioResource: createResource } = await import(
      './processing/streamProcessor.ts'
    )

    const urlData = await this.nodelink.sources.getTrackUrl(trackPayload.info)
    if (!urlData?.url) {
      throw new Error('Failed to get stream URL for mix track')
    }

    const fetched = await this.nodelink.sources.getTrackStream(
      (urlData.newTrack?.info as TrackInfoExtended) || trackPayload.info,
      urlData.url as string,
      urlData.protocol as string,
      urlData.additionalData
    )

    if (fetched.exception) {
      throw new Error(fetched.exception.message)
    }

    const pcmResource = createResource(
      this.guildId,
      fetched.stream as NonNullable<typeof fetched.stream>,
      fetched.type || (urlData.format as string) || 'unknown',
      this.nodelink,
      {},
      mixVolume,
      null,
      true
    ) as AudioResource & { stream: VoiceAudioStream }

    const mixId = this.audioMixer.addLayer(
      pcmResource.stream,
      trackPayload,
      mixVolume
    )

    return {
      id: mixId,
      track: trackPayload,
      volume: mixVolume
    }
  }

  /**
   * Removes a mix layer by id.
   *
   * @param mixId - Identifier returned by addMix.
   * @returns True when removed.
   */
  public removeMix(mixId: string): boolean {
    logger('debug', 'Player', `[Action: removeMix] Method invoked for guild ${this.guildId} mixId=${mixId}`)
    if (!this.audioMixer) {
      return false
    }
    return this.audioMixer.removeLayer(mixId)
  }

  /**
   * Updates the volume of a mix layer.
   *
   * @param mixId - Identifier of the mix layer.
   * @param volume - New volume (0-1).
   * @returns True when updated; false if layer missing.
   */
  public updateMix(mixId: string, volume: number): boolean {
    logger('debug', 'Player', `[Action: updateMix] Method invoked for guild ${this.guildId} mixId=${mixId} volume=${volume}`)
    if (!this.audioMixer) {
      return false
    }
    return this.audioMixer.updateLayerVolume(mixId, volume)
  }

  /**
   * Lists active mix layers.
   *
   * @returns Current mix layers with track and volume.
   */
  public getMixes(): Array<{
    id: string
    track: PlayerTrack
    volume: number
    position: number
    startTime: number
  }> {
    logger('debug', 'Player', `[Action: getMixes] Method invoked for guild ${this.guildId}`)
    if (!this.audioMixer) {
      return []
    }
    return this.audioMixer.getLayers()
  }

  /**
   * Subscribes to lyrics events for the current track.
   *
   * @param skipTrackSource - When true, skips track source provider before fetching lyrics.
   */
  public async subscribeLyrics(
    skipTrackSource: boolean | string | undefined
  ): Promise<void> {
    logger('debug', 'Player', `[Action: subscribeLyrics] Method invoked for guild ${this.guildId}`)
    return new Promise((resolve) => {
      if (this.isLyricsSubscribed) {
        return resolve()
      }

      this.isLyricsSubscribed = true
      this.skipTrackSource =
        skipTrackSource === 'true' || skipTrackSource === true

      if (this.track && !this.isPaused) {
        this._loadLyrics().catch((error: unknown) => {
          const errorMessage =
            error instanceof Error ? error.message : String(error)
          logger(
            'warn',
            'Lyrics',
            `Failed to load lyrics for guild ${this.guildId}: ${errorMessage} `
          )
        })
      }

      return resolve()
    })
  }

  /**
   * Unsubscribes from lyrics events.
   */
  public unsubscribeLyrics(): Promise<void> {
    logger('debug', 'Player', `[Action: unsubscribeLyrics] Method invoked for guild ${this.guildId}`)
    return new Promise((resolve) => {
      this.isLyricsSubscribed = false
      this.skipTrackSource = false
      this.currentLyrics = null
      this.lyricsLineIndex = -1
      if (this._lyricsMarkerTimer) {
        clearTimeout(this._lyricsMarkerTimer)
        this._lyricsMarkerTimer = null
      }
      return resolve()
    })
  }

  /**
   * Returns current SponsorBlock state for the player.
   *
   * @returns Current segments and configuration.
   */
  public getSponsorBlock(): PlayerSponsorBlockState {
    logger('debug', 'Player', `[Action: getSponsorBlock] Method invoked for guild ${this.guildId}`)
    return this.sponsorBlock
  }

  /**
   * Updates SponsorBlock settings for the player.
   *
   * @param updates - Configuration updates.
   */
  public updateSponsorBlock(
    updates: Partial<
      Omit<PlayerSponsorBlockState, 'segments' | 'lastSkippedUuid'>
    >
  ): void {
    logger('debug', 'Player', `[Action: updateSponsorBlock] Method invoked for guild ${this.guildId}`)
    if (updates.enabled !== undefined)
      this.sponsorBlock.enabled = updates.enabled
    if (updates.categories !== undefined)
      this.sponsorBlock.categories = updates.categories
    if (updates.actionTypes !== undefined)
      this.sponsorBlock.actionTypes = updates.actionTypes
  }

  /**
   * Overrides SponsorBlock segments for the current track.
   *
   * @param segments - Array of segments to apply.
   */
  public setSponsorBlockSegments(segments: SponsorBlockSegment[]): void {
    logger('debug', 'Player', `[Action: setSponsorBlockSegments] Method invoked for guild ${this.guildId}`)
    this.sponsorBlock.segments = segments
    this.sponsorBlock.lastSkippedUuid = null
  }

  /**
   * Clears SponsorBlock state for the player.
   */
  public clearSponsorBlock(): void {
    logger('debug', 'Player', `[Action: clearSponsorBlock] Method invoked for guild ${this.guildId}`)
    this.sponsorBlock.segments = []
    this.sponsorBlock.lastSkippedUuid = null
  }

  /**
   * Loads lyrics for the current track and emits events.
   */
  private async _loadLyrics(): Promise<void> {
    if (!this.track) return

    const lyricsManager =
      this.nodelink.lyrics ?? (await this.nodelink.getLyricsManager?.())
    if (!lyricsManager) return

    const lyricsData = await lyricsManager.loadLyrics(
      { info: this.track.info },
      undefined,
      this.skipTrackSource
    )

    if (lyricsData && lyricsData.loadType === 'lyrics') {
      const lines: LyricsLine[] = lyricsData.data.lines.map((line) => ({
        timestamp: line.time,
        duration: line.duration || 0,
        line: line.text,
        words: line.words || [],
        plugin: {}
      }))

      for (let i = 0; i < lines.length - 1; i++) {
        const current = lines[i]
        const next = lines[i + 1]
        if (!current || !next) continue
        if (current.duration === 0) {
          current.duration = next.timestamp - current.timestamp
        }
      }

      const payload: LyricsPayload = {
        sourceName: this.track.info.sourceName,
        provider: lyricsData.data.provider,
        text: lyricsData.data.lines.map((l) => l.text).join('\n'),
        lines,
        plugin: {}
      }

      this.currentLyrics = payload
      this.lyricsLineIndex = -1
      this.emitEvent('LyricsFoundEvent', { lyrics: this.currentLyrics })
      if (this._lyricsMarkerTimer) {
        clearTimeout(this._lyricsMarkerTimer)
        this._lyricsMarkerTimer = null
      }
      this._recalculateLyricsIndex(undefined, undefined, true)
      this._syncLyrics(true)
    } else {
      this.currentLyrics = null
      this.emitEvent('LyricsNotFoundEvent')
    }
  }

  /**
   * Synchronizes lyrics with current playback position.
   */
  private _syncLyrics(force = false): void {
    if (!this.isLyricsSubscribed || !this.currentLyrics?.lines) return
    if (this._lyricsMarkerTimer && !force) return

    const timescale = this._getTimescale()
    const playbackSpeed = timescale.speed * timescale.rate
    const position = this._getLyricsPosition(playbackSpeed)
    const lines = this.currentLyrics.lines
    this._recalculateLyricsIndex(position, lines)

    const nextIndex = this.lyricsLineIndex + 1
    const nextLine = lines[nextIndex]
    if (!nextLine) return

    const nextTimestamp = nextLine.timestamp
    const delayMs = Math.max(0, (nextTimestamp - position) / playbackSpeed)

    this._lyricsMarkerTimer = setTimeout(() => {
      this._lyricsMarkerTimer = null
      if (!this.isLyricsSubscribed || !this.currentLyrics?.lines) return
      const timedLine = this.currentLyrics.lines[nextIndex]
      if (!timedLine) return
      const nowPosition = this._getLyricsPosition(playbackSpeed)
      const drift = nowPosition - nextTimestamp

      if (drift < -15) {
        this._syncLyrics(true)
        return
      }

      if (Math.abs(drift) > 100) {
        this._lyricsBasePosition -= drift * 0.25
      }

      this.lyricsLineIndex = nextIndex
      this.emitEvent('LyricsLineEvent', {
        lineIndex: nextIndex,
        line: timedLine,
        skipped: drift > 60
      })
      this._syncLyrics(true)
    }, delayMs)
  }

  /**
   * Computes current lyrics position based on packets received.
   */
  private _getLyricsPosition(playbackSpeed: number): number {
    const stats = this.connection?.statistics
    const packets = stats?.packetsExpected ?? this._lyricsBasePackets
    const deltaPackets = Math.max(0, packets - this._lyricsBasePackets)

    return this._lyricsBasePosition + deltaPackets * 20 * playbackSpeed
  }

  /**
   * Recalculates the current lyric line index.
   */
  private _recalculateLyricsIndex(
    positionOverride?: number,
    linesOverride?: LyricsLine[],
    allowBackward = false
  ): void {
    if (!this.currentLyrics?.lines) return

    const lines = linesOverride || this.currentLyrics.lines
    let position = positionOverride

    if (position === undefined) {
      const timescale = this._getTimescale()
      const playbackSpeed = timescale.speed * timescale.rate
      position = this._getLyricsPosition(playbackSpeed)
    }

    let foundIndex = -1
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue
      if (line.timestamp <= position) {
        foundIndex = i
      } else {
        break
      }
    }

    if (!allowBackward && foundIndex < this.lyricsLineIndex) {
      return
    }

    if (foundIndex !== this.lyricsLineIndex) {
      const skipped = foundIndex > this.lyricsLineIndex + 1
      this.lyricsLineIndex = foundIndex

      if (foundIndex !== -1) {
        const line = lines[foundIndex]
        if (!line) return
        this.emitEvent('LyricsLineEvent', {
          lineIndex: foundIndex,
          line: line,
          skipped
        })
      }
    }
  }

  /**
   * Serializes player state to JSON-safe object.
   */
  public toJSON(): PlayerStateJSON {
    logger('debug', 'Player', `[Action: toJSON] Method invoked for guild ${this.guildId}`)
    return {
      guildId: this.guildId,
      track: this.track,
      volume: this.volumePercent,
      fading: this.fading,
      loudnessNormalizer: this.loudnessNormalizer,
      paused: this.isPaused,
      filters: this.filters,
      state: {
        time: Date.now(),
        position: this._realPosition(),
        connected: this.connStatus === 'connected',
        ping:
          this.connection && this.connection.ping >= 0
            ? this.connection.ping
            : 0
      },
      voice: structuredClone(this.voice)
    }
  }

  /**
   * Handles fading, tape, and scratch actions for start/stop/seek/pause events.
   */
  private _fading(
    action:
      | 'reset'
      | 'trackStart'
      | 'trackStartArm'
      | 'trackEndSchedule'
      | 'trackStop'
      | 'seek'
      | 'seekPrepare'
      | 'pause'
      | 'resume',
    payload: { resource?: AudioResource; startPosition?: number } = {}
  ): boolean {
    logger(
      'debug',
      'Player',
      `[Fading] Executing fading action '${action}' for guild ${this.guildId}`
    )
    const timers = this._fadeTimers
    if (!timers) return false

    if (action === 'reset') {
      if (timers.trackEnd) clearTimeout(timers.trackEnd)
      if (timers.pause) {
        if (timers.pause instanceof Object && 'interval' in timers.pause) {
          clearInterval(timers.pause.interval)
          if (timers.pause.timeout) clearTimeout(timers.pause.timeout)
        } else {
          clearTimeout(timers.pause as NodeJS.Timeout)
        }
      }
      if (timers.stop) {
        if (typeof timers.stop === 'object' && 'interval' in timers.stop) {
          clearInterval(timers.stop.interval)
          if (timers.stop.timeout) clearTimeout(timers.stop.timeout)
        } else {
          clearTimeout(timers.stop)
        }
      }
      timers.trackEnd = null
      timers.pause = null
      timers.stop = null
      this._pendingTrackStartFade = false
      return false
    }

    if (action === 'trackEndSchedule' && timers.trackEnd) {
      clearTimeout(timers.trackEnd)
      timers.trackEnd = null
    }

    if (action === 'trackEndSchedule') {
      if (!this.track?.info) return false
      const total =
        this.track.endTime && this.track.endTime > 0
          ? this.track.endTime
          : this.track.info.length || 0
      if (!Number.isFinite(total) || total <= 0) return false

      const startPosition = payload.startPosition || 0
      const remaining = Math.max(0, total - startPosition)
      const teSection = this.fading?.trackEnd as FadingSection | undefined
      const hasFade =
        teSection &&
        Number.isFinite(teSection.duration) &&
        teSection.duration > 0
      const fadeDuration = hasFade ? Math.min(teSection.duration, remaining) : 0
      const fadeType = hasFade ? teSection.type || 'volume' : 'volume'
      const delay = Math.max(0, remaining - fadeDuration)
      const scratchStyle = (hasFade ? teSection.curve : undefined) as
        | import('../typings/playback/processing.types.ts').ScratchStyle
        | undefined

      if (fadeType === 'tape' || fadeType === 'scratch') {
        this._snapshotPosition()
      }

      timers.trackEnd = setTimeout(() => {
        const stream = this.connection?.audioStream as AudioResource | undefined
        if (stream) {
          if (hasFade && teSection) {
            if (fadeType === 'volume' || fadeType === 'both') {
              stream.fadeTo?.(0, fadeDuration, teSection.curve)
            }
            if (fadeType === 'tape' || fadeType === 'both') {
              stream.tapeTo?.(fadeDuration, 'stop', teSection.curve)
            }
            const effectiveScratchStyle = [
              'wash',
              'backspin',
              'baby',
              'stop'
            ].includes(scratchStyle ?? '')
              ? (scratchStyle as import('../typings/playback/processing.types.ts').ScratchStyle)
              : 'wash'
            if (fadeType === 'scratch') {
              stream.scratchTo?.(fadeDuration, effectiveScratchStyle)
            }
          }

          if (fadeType !== 'volume' && hasFade) {
            const safetyTimeout = fadeDuration * 2 + 1500
            const trackId = this.track?.info.identifier
            setTimeout(() => {
              if (
                this.track?.info.identifier === trackId &&
                !this.isUpdatingTrack &&
                !this._isStopping
              ) {
                logger(
                  'debug',
                  'Player',
                  `Safety stop triggered for guild ${this.guildId} after long fade-out ramp.`
                )
                this.connection?.stop(EndReasons.FINISHED)
              }
            }, safetyTimeout).unref?.()
          } else if (fadeDuration === 0) {
            if (this.track && !this.isUpdatingTrack && !this._isStopping) {
              logger(
                'debug',
                'Player',
                `Scheduled track end for guild ${this.guildId} at ${this.track.info.length}ms`
              )
              this.connection?.stop(EndReasons.FINISHED)
            }
          } else {
            const trackId = this.track?.info.identifier
            setTimeout(() => {
              if (
                this.track?.info.identifier === trackId &&
                !this.isUpdatingTrack &&
                !this._isStopping
              ) {
                logger(
                  'debug',
                  'Player',
                  `Track end after volume fade for guild ${this.guildId}`
                )
                this.connection?.stop(EndReasons.FINISHED)
              }
            }, fadeDuration + 100).unref?.()
          }
        }
        if (timers.trackEnd) {
          clearTimeout(timers.trackEnd)
          timers.trackEnd = null
        }
      }, delay)
      return true
    }

    if (!this.fading || this.fading.enabled !== true) return false

    let section: FadingSection | undefined | null = null
    if (action === 'trackStart' || action === 'trackStartArm')
      section = this.fading.trackStart
    else if (action === 'trackStop') section = this.fading.trackStop
    else if (action === 'seek' || action === 'seekPrepare')
      section = this.fading.seek
    else if (action === 'pause') section = this.fading.pause
    else if (action === 'resume') section = this.fading.resume
    else return false

    if (!section || !Number.isFinite(section.duration) || section.duration <= 0)
      return false

    const fadeType = section.type || 'volume'
    const scratchStyle =
      (section.curve as import('../typings/playback/processing.types.ts').ScratchStyle) ||
      'random'

    if (fadeType === 'tape' || fadeType === 'scratch') {
      this._snapshotPosition()
    }

    if (action === 'trackStartArm') {
      const resource = payload.resource
      if (!resource) return false
      if (fadeType === 'volume' || fadeType === 'both') {
        if (resource.setFadeVolume) resource.setFadeVolume(0)
      }
      if (fadeType === 'tape' || fadeType === 'both') {
        if (resource.tapeTo) resource.tapeTo(0, 'stop')
      }
      if (fadeType === 'scratch') {
        if (resource.scratchTo) resource.scratchTo(0, 'stop')
      }
      this._pendingTrackStartFade = true
      return true
    }

    if (action === 'trackStart') {
      if (!this._pendingTrackStartFade) return false
      const stream =
        (payload.resource as AudioResource | undefined)?.stream ||
        this.connection?.audioStream
      if (!stream) return false
      this._pendingTrackStartFade = false

      if (fadeType === 'volume' || fadeType === 'both') {
        if ((stream as AudioResource).fadeTo)
          (stream as AudioResource).fadeTo?.(1, section.duration, section.curve)
      }
      if (fadeType === 'tape' || fadeType === 'both') {
        if ((stream as AudioResource).tapeTo)
          (stream as AudioResource).tapeTo?.(
            section.duration,
            'start',
            section.curve
          )
      }
      if (fadeType === 'scratch') {
        if ((stream as AudioResource).scratchTo)
          (stream as AudioResource).scratchTo?.(section.duration, scratchStyle)
      }
      return true
    }

    if (action === 'seekPrepare') {
      const resource = payload.resource
      if (!resource) return false
      if (fadeType === 'volume' || fadeType === 'both') {
        if (resource.setFadeVolume) resource.setFadeVolume(0)
      }
      if (fadeType === 'tape' || fadeType === 'both') {
        if (resource.tapeTo) resource.tapeTo(0, 'stop')
      }
      if (fadeType === 'scratch') {
        if (resource.scratchTo) resource.scratchTo(0, 'stop')
      }
      return true
    }

    if (action === 'seek') {
      const stream = this.connection?.audioStream as AudioResource | undefined
      if (!stream) return false

      if (fadeType === 'volume' || fadeType === 'both') {
        if (stream.setFadeVolume) stream.setFadeVolume(0)
        stream.fadeTo?.(1, section.duration, section.curve)
      }
      if (fadeType === 'tape' || fadeType === 'both') {
        stream.tapeTo?.(section.duration, 'start', section.curve)
      }
      if (fadeType === 'scratch') {
        stream.scratchTo?.(section.duration, 'start')
      }
      return true
    }

    if (action === 'pause') {
      const stream = this.connection?.audioStream as AudioResource | undefined
      if (!stream) return false
      logger(
        'debug',
        'Player',
        `Pause fade triggered for guild ${this.guildId}`
      )
      if (timers.trackEnd) {
        clearTimeout(timers.trackEnd)
        timers.trackEnd = null
      }
      if (timers.pause) {
        if (timers.pause instanceof Object && 'interval' in timers.pause) {
          const pauseTimer = timers.pause as {
            interval: NodeJS.Timeout
            timeout?: NodeJS.Timeout
          }
          clearInterval(pauseTimer.interval)
          if (pauseTimer.timeout) clearTimeout(pauseTimer.timeout)
        } else {
          clearTimeout(timers.pause as NodeJS.Timeout)
        }
      }

      if (fadeType === 'volume' || fadeType === 'both') {
        stream.fadeTo?.(0, section.duration, section.curve)
      }
      if (fadeType === 'tape' || fadeType === 'both') {
        stream.tapeTo?.(section.duration, 'stop', section.curve)
      }
      if (fadeType === 'scratch') {
        const style = ['wash', 'backspin', 'baby', 'stop'].includes(
          scratchStyle
        )
          ? scratchStyle
          : 'wash'
        stream.scratchTo?.(section.duration, style)
      }

      const startTime = Date.now()
      const checkInterval = setInterval(() => {
        const elapsed = Date.now() - startTime
        const isTapeDone = stream.checkTapeRampCompleted?.()
        const isScratchDone = stream.checkScratchEffectCompleted?.()
        const effectsDone =
          (fadeType !== 'tape' || isTapeDone === true) &&
          (fadeType !== 'scratch' || isScratchDone === true) &&
          (fadeType !== 'both' ||
            (isTapeDone === true && isScratchDone === true))
        const isRampDone = elapsed >= section.duration && effectsDone
        const isTimeUp = elapsed > section.duration + 500 // Safety timeout

        if (isRampDone || isTimeUp) {
          clearInterval(checkInterval)

          const drainTimeout = setTimeout(() => {
            this.connection?.pause?.('requested')
            timers.pause = null
          }, 750)

          const pauseTimer = timers.pause
          if (
            pauseTimer &&
            typeof pauseTimer === 'object' &&
            'interval' in pauseTimer
          ) {
            pauseTimer.timeout = drainTimeout
          }
        }
      }, 10)

      timers.pause = { interval: checkInterval }
      return true
    }

    if (action === 'resume') {
      const stream = this.connection?.audioStream as AudioResource | undefined
      if (!stream) return false
      logger(
        'debug',
        'Player',
        `Resume fade triggered for guild ${this.guildId}`
      )

      if (fadeType === 'volume' || fadeType === 'both') {
        if (stream.setFadeVolume) stream.setFadeVolume(0)
        stream.fadeTo?.(1, section.duration, section.curve)
      }
      if (fadeType === 'tape' || fadeType === 'both') {
        stream.tapeTo?.(0, 'stop')
        stream.tapeTo?.(section.duration, 'start', section.curve)
      }
      if (fadeType === 'scratch') {
        stream.scratchTo?.(0, 'stop')
        stream.scratchTo?.(section.duration, 'start')
      }
      return true
    }

    if (action === 'trackStop') {
      const stream = this.connection?.audioStream as AudioResource | undefined
      if (!stream) return false
      if (timers.stop) {
        if (typeof timers.stop === 'object' && 'interval' in timers.stop) {
          clearInterval(timers.stop.interval)
          if (timers.stop.timeout) clearTimeout(timers.stop.timeout)
        } else {
          clearTimeout(timers.stop)
        }
      }

      if (fadeType === 'volume' || fadeType === 'both') {
        stream.fadeTo?.(0, section.duration, section.curve)
      }
      if (fadeType === 'tape' || fadeType === 'both') {
        stream.tapeTo?.(section.duration, 'stop', section.curve)
      }
      if (fadeType === 'scratch') {
        const style = ['wash', 'backspin', 'baby', 'stop'].includes(
          scratchStyle
        )
          ? scratchStyle
          : 'stop'
        stream.scratchTo?.(section.duration, style)
      }

      const startTime = Date.now()
      const checkInterval = setInterval(() => {
        const elapsed = Date.now() - startTime
        const isRampDone = elapsed >= section.duration
        const isTimeUp = elapsed > section.duration + 500 // Safety timeout

        if (isRampDone || isTimeUp) {
          clearInterval(checkInterval)

          const drainTimeout = setTimeout(() => {
            this._isStopping = false
            this.connection?.stop(EndReasons.STOPPED)
            timers.stop = null
          }, 750)

          if (
            timers.stop &&
            typeof timers.stop === 'object' &&
            'interval' in timers.stop
          ) {
            timers.stop.timeout = drainTimeout
          }
        }
      }, 10)

      timers.stop = { interval: checkInterval }
      return true
    }

    return false
  }
}
