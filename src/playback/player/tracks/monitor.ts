import { EndReasons, GatewayEvents } from '../../../constants.ts'
import type {
  NodeLink,
  Session
} from '../../../typings/playback/player.types.ts'
import { logger } from '../../../utils.ts'
import type { PlayerConnection } from '../../../voice/playerConnection.ts'
import type { Player } from '../../player.ts'
import type { PlayerFading } from '../audio/fading.ts'
import type { PlayerLyrics } from '../features/lyrics.ts'
import type { PlayerSponsorBlock } from '../features/sponsorBlock.ts'
import type { PlaybackClock } from './clock.ts'

interface PlayerPlaybackMonitorDependencies {
  sponsorBlockFeature: PlayerSponsorBlock
  fadingEffects: PlayerFading
  clock: PlaybackClock
  isResuming: () => boolean
  voiceConnection: PlayerConnection
  isSeeking: () => boolean
  lyrics: PlayerLyrics
}

/**
 * Checks playback progress and recovers stuck tracks.
 * @internal
 */
export class PlayerPlaybackMonitor {
  private readonly player: Pick<
    Player,
    | 'seek'
    | 'stop'
    | 'connection'
    | 'isPaused'
    | 'connStatus'
    | 'destroying'
    | 'sponsorBlock'
    | 'track'
    | 'guildId'
    | 'isUpdatingTrack'
    | 'streamInfo'
    | 'emitEvent'
    | 'profilerStreamStats'
    | 'stuckRecoveryCount'
    | '_lastStreamDataTime'
  >
  private readonly nodelink: NodeLink
  private readonly session: Session
  private readonly dependencies: PlayerPlaybackMonitorDependencies
  private _lastPosition = 0
  private _stuckTime = 0
  private _isRecovering = false
  private _positionAtRecoveryStart = 0
  private static MAX_STUCK_RECOVERY_ATTEMPTS = 3

  constructor(
    player: PlayerPlaybackMonitor['player'],
    nodelink: NodeLink,
    session: Session,
    dependencies: PlayerPlaybackMonitorDependencies
  ) {
    this.player = player
    this.nodelink = nodelink
    this.session = session
    this.dependencies = dependencies
  }

  public get isRecovering(): boolean {
    return this._isRecovering
  }

  public _resetStuckTime(): void {
    this._stuckTime = 0
  }

  public _onConnectionBoundary(): void {
    this._stuckTime = 0
    this._positionAtRecoveryStart = this.dependencies.clock._realPosition()
  }

  public _markStuck(): void {
    this._stuckTime =
      (this.nodelink.options.playback.trackStuckThresholdMs ?? 0) + 1
  }

  public _recordPosition(position: number): void {
    this._lastPosition = position
  }

  /**
   * Checks progress, synchronizes features, and sends the client state update.
   */
  public _sendUpdate(): boolean {
    if (
      !this.player.connection ||
      (this.player.isPaused &&
        !this.dependencies.fadingEffects.isPauseFadeActive) ||
      this.player.connStatus === 'destroyed' ||
      this.player.destroying
    )
      return false

    const position = this.dependencies.clock._realPosition()

    this.dependencies.sponsorBlockFeature.logPosition(
      position,
      this._lastPosition
    )

    const threshold = this.nodelink.options.playback.trackStuckThresholdMs ?? 0
    if (
      threshold > 0 &&
      !this.player.isUpdatingTrack &&
      !this.dependencies.fadingEffects.isStopping &&
      this.player.track &&
      !this.dependencies.isResuming() &&
      !this.player.isPaused &&
      this.player.connStatus === 'connected'
    ) {
      if (this._lastPosition === position) {
        this._stuckTime +=
          this.nodelink.options.playback.playerUpdateInterval ?? 0
        if (this._stuckTime >= threshold && !this._isRecovering) {
          const stuckTime = this._stuckTime
          this._stuckTime = 0

          const pipelineStream =
            this.dependencies.voiceConnection._getAudioStream()
          if (pipelineStream?.isPipelineFinished?.()) {
            logger(
              'debug',
              'Player',
              `Player for guild ${this.player.guildId} is starving but the network stream has finished. Treating as natural trackEnd.`
            )
            this.player.connection.stop(EndReasons.FINISHED)
            return false
          }

          if (this.player.streamInfo?.format === 'mp4') {
            logger(
              'error',
              'Player',
              `Player for guild ${this.player.guildId} is stuck on an MP4 track. Emitting TRACK_STUCK without recovery.`
            )
            this.player.emitEvent(GatewayEvents.TRACK_STUCK, {
              guildId: this.player.guildId,
              track: this.player.track,
              thresholdMs: threshold,
              reason: 'Playback of MP4 track is stuck'
            })

            this.nodelink.pluginManager?.callHook(
              'onTrackStuck',
              this.player.guildId,
              this.player.track,
              threshold,
              'Playback of MP4 track is stuck'
            )
            this.player.stop()
            return false
          }

          if (!this.player.track.info.isSeekable) {
            if (
              this.player.profilerStreamStats.lastChunkAt &&
              Date.now() - this.player.profilerStreamStats.lastChunkAt <
                threshold
            ) {
              this._stuckTime = 0
              return true
            }

            logger(
              'warn',
              'Player',
              `Player for guild ${this.player.guildId} is stuck on a non-seekable track. Stopping track.`
            )
            this.player.emitEvent(GatewayEvents.TRACK_STUCK, {
              guildId: this.player.guildId,
              track: this.player.track,
              thresholdMs: threshold,
              reason: 'Track is not seekable'
            })
            this.player.stop()
            return false
          }
          // reason for this special check:
          // monochrome does not send 200ms of the final segment (or tidal, idk) so the player thinks its gonna be a recovery
          // this fixes it by treating as a natural "trackEnd"
          // for example: an audio is 200000ms long, it will only play until 199800ms before triggering a recovery
          const trackLength = this.player.track.info.length
          const audioStream =
            this.dependencies.voiceConnection._getAudioStream()
          const playbackSpeed =
            audioStream?.getEffectiveRate?.() ??
            this.dependencies.clock._getTimescaleSpeed()
          const endThreshold = playbackSpeed < 1.0 ? 5000 : 2000

          if (trackLength > 0 && position >= trackLength - endThreshold) {
            logger(
              'debug',
              'Player',
              `Player for guild ${this.player.guildId} is near track end (${position}/${trackLength}ms). Treating as natural finish instead of stuck.`
            )
            this.player.connection.stop(EndReasons.FINISHED)
            return false
          }

          if (
            this.player.stuckRecoveryCount >=
            PlayerPlaybackMonitor.MAX_STUCK_RECOVERY_ATTEMPTS
          ) {
            logger(
              'error',
              'Player',
              `Player for guild ${this.player.guildId} exceeded max recovery attempts (${PlayerPlaybackMonitor.MAX_STUCK_RECOVERY_ATTEMPTS}). Stopping track.`
            )
            this.player.emitEvent(GatewayEvents.TRACK_STUCK, {
              guildId: this.player.guildId,
              track: this.player.track,
              thresholdMs: threshold,
              reason: 'Max recovery attempts exceeded'
            })
            this.player.stop()
            return false
          }

          logger(
            'warn',
            'Player',
            `Player for guild ${this.player.guildId} is stuck. Attempting to recover... (attempt ${this.player.stuckRecoveryCount + 1}/${PlayerPlaybackMonitor.MAX_STUCK_RECOVERY_ATTEMPTS})`,
            {
              lastPosition: this._lastPosition,
              currentPosition: position,
              stuckTime: stuckTime,
              threshold: threshold,
              connStatus: this.player.connStatus,
              lastStreamDataTime:
                this.player._lastStreamDataTime > 0
                  ? new Date(this.player._lastStreamDataTime).toISOString()
                  : 'never',
              statistics: this.player.connection?.statistics
            }
          )
          this._isRecovering = true
          this.player.stuckRecoveryCount++
          this._positionAtRecoveryStart = position

          if (
            this.player.track.info.identifier &&
            this.player.track.info.sourceName
          ) {
            this.nodelink.trackCacheManager?.delete(
              this.player.track.info.sourceName,
              this.player.track.info.identifier
            )
          }

          const isStream = this.player.track.info.isStream
          const recoveryPosition = isStream ? 0 : this._lastPosition

          this.player
            .seek(recoveryPosition, this.player.track.endTime, true)
            .then((success) => {
              if (success) {
                logger(
                  'info',
                  'Player',
                  `Player for guild ${this.player.guildId} recovered successfully.`
                )
              } else {
                logger(
                  'error',
                  'Player',
                  `Player for guild ${this.player.guildId} recovery failed. Stopping track.`
                )
                this.player.emitEvent(GatewayEvents.TRACK_STUCK, {
                  guildId: this.player.guildId,
                  track: this.player.track,
                  thresholdMs: threshold,
                  reason: 'Recovery attempt failed'
                })
                this.player.stop()
              }
              this._isRecovering = false
            })
            .catch((err: Error) => {
              logger(
                'error',
                'Player',
                `Player for guild ${this.player.guildId} recovery attempt threw an error: ${err.message}. Stopping track.`
              )
              this.player.emitEvent(GatewayEvents.TRACK_STUCK, {
                guildId: this.player.guildId,
                track: this.player.track,
                thresholdMs: threshold,
                reason: `Recovery attempt failed: ${err.message}`
              })
              this.player.stop()
              this._isRecovering = false
            })
        }
      } else {
        this._stuckTime = 0
        this._isRecovering = false
      }
    }

    if (position !== this._lastPosition) {
      this.player._lastStreamDataTime = Date.now()
      if (this.player.stuckRecoveryCount > 0) {
        const meaningfulAdvance = 2000
        if (position - this._positionAtRecoveryStart >= meaningfulAdvance) {
          this.player.stuckRecoveryCount = 0
        }
      }
    }

    this._lastPosition = position
    this.dependencies.lyrics._syncLyrics()

    if (
      this.dependencies.sponsorBlockFeature.skipSegment(
        position,
        this.dependencies.isResuming(),
        this._isRecovering,
        this.dependencies.isSeeking()
      )
    )
      return true

    if (this.dependencies.isSeeking()) return true

    this.session.socket.send(
      JSON.stringify({
        op: GatewayEvents.PLAYER_UPDATE,
        guildId: this.player.guildId,
        state: {
          time: Date.now(),
          position,
          connected: this.player.connStatus === 'connected',
          ping:
            this.player.connection && this.player.connection.ping >= 0
              ? this.player.connection.ping
              : 0
        }
      })
    )
    return true
  }
}
