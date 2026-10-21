import { EndReasons } from '../../../constants.ts'
import type {
  AudioResource,
  ExtendedVoiceConnection,
  FadeTimers,
  FadingConfig,
  FadingSection
} from '../../../typings/playback/player.types.ts'
import type { ScratchStyle } from '../../../typings/playback/processing.types.ts'
import { logger } from '../../../utils.ts'
import type { PlayerConnection } from '../../../voice/playerConnection.ts'
import type { Player } from '../../player.ts'
import type { PlaybackClock } from '../tracks/clock.ts'

interface PlayerFadingDependencies {
  voiceConnection: PlayerConnection
  clock: PlaybackClock
}

/**
 * Owns fades, tape and scratch effects, and their timers.
 * @internal
 */
export class PlayerFading {
  private readonly player: Pick<
    Player,
    | 'guildId'
    | 'fading'
    | 'track'
    | 'connection'
    | 'isUpdatingTrack'
    | 'duckingController'
  >
  private readonly dependencies: PlayerFadingDependencies
  private _pendingTrackStartFade = false
  private _isStopping = false
  private _fadeTimers: FadeTimers = { trackEnd: null, pause: null, stop: null }

  constructor(
    player: PlayerFading['player'],
    dependencies: PlayerFadingDependencies
  ) {
    this.player = player
    this.dependencies = dependencies
  }

  public get hasPendingTrackStartFade(): boolean {
    return this._pendingTrackStartFade
  }

  public get isStopping(): boolean {
    return this._isStopping
  }

  /**
   * Stops an active connection immediately or after its configured fade.
   * The track lifecycle checks that the connection exists before calling.
   */
  public _stopPlayback(): void {
    this._isStopping = true
    if (this._fading('trackStop')) return
    this._isStopping = false
    const connection = this.player.connection as ExtendedVoiceConnection
    connection.stop(EndReasons.STOPPED)
  }

  public _resetStopping(): void {
    this._isStopping = false
  }

  public get isPauseFadeActive(): boolean {
    return !!this._fadeTimers.pause
  }

  public _clearTrackEndTimer(): void {
    if (this._fadeTimers.trackEnd) {
      clearTimeout(this._fadeTimers.trackEnd)
      this._fadeTimers.trackEnd = null
    }
  }

  /**
   * Sets fading configuration.
   *
   * @param config - New fading config; disables fading when undefined.
   * @returns Always true.
   */
  public setFading(config?: FadingConfig): boolean {
    logger(
      'debug',
      'Player',
      `[Action: setFading] Method invoked for guild ${this.player.guildId}`
    )
    this.player.fading = config
    return true
  }

  /**
   * Handles fading, tape, and scratch actions for start/stop/seek/pause events.
   */
  public _fading(
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
      `[Fading] Executing fading action '${action}' for guild ${this.player.guildId}`
    )
    if (!this._fadeTimers) return false
    if (action === 'reset') return this._resetFades()
    if (action === 'trackEndSchedule') {
      this._clearTrackEndTimer()
      return this._scheduleTrackEnd(payload)
    }
    if (this.player.fading?.enabled !== true) return false

    let section: FadingSection | undefined | null = null
    switch (action) {
      case 'trackStart':
      case 'trackStartArm':
        section = this.player.fading.trackStart
        break
      case 'trackStop':
        section = this.player.fading.trackStop
        break
      case 'seek':
      case 'seekPrepare':
        section = this.player.fading.seek
        break
      case 'pause':
        section = this.player.fading.pause
        break
      case 'resume':
        section = this.player.fading.resume
        break
      default:
        return false
    }
    if (!section || !Number.isFinite(section.duration) || section.duration <= 0)
      return false

    const fadeType = section.type || 'volume'
    const scratchStyle = (section.curve as ScratchStyle) || 'random'
    if (fadeType === 'tape' || fadeType === 'scratch') {
      this.dependencies.clock._snapshotPosition()
    }

    switch (action) {
      case 'trackStartArm': {
        const prepared = this._prepareResource(payload.resource, fadeType)
        if (prepared) this._pendingTrackStartFade = true
        return prepared
      }
      case 'trackStart':
        return this._fadeTrackStart(
          payload.resource,
          section,
          fadeType,
          scratchStyle
        )
      case 'seekPrepare':
        return this._prepareResource(payload.resource, fadeType)
      case 'seek':
        return this._fadeAfterSeek(section, fadeType)
      case 'pause':
        return this._fadePause(section, fadeType, scratchStyle)
      case 'resume':
        return this._fadeResume(section, fadeType)
      case 'trackStop':
        return this._fadeStop(section, fadeType, scratchStyle)
      default:
        return false
    }
  }

  private _resetFades(): boolean {
    const timers = this._fadeTimers
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

  private _scheduleTrackEnd(payload: { startPosition?: number }): boolean {
    const timers = this._fadeTimers
    if (!this.player.track?.info) return false
    const total =
      this.player.track.endTime && this.player.track.endTime > 0
        ? this.player.track.endTime
        : this.player.track.info.length || 0
    if (!Number.isFinite(total) || total <= 0) return false

    const startPosition = payload.startPosition || 0
    const playbackSpeed =
      this.dependencies.voiceConnection
        ._getAudioStream()
        ?.getEffectiveRate?.() ?? this.dependencies.clock._getTimescaleSpeed()
    const remaining =
      Math.max(0, total - startPosition) /
      (playbackSpeed > 0 ? playbackSpeed : 1)
    const teSection = this.player.fading?.trackEnd as FadingSection | undefined
    const hasFade =
      teSection && Number.isFinite(teSection.duration) && teSection.duration > 0
    const fadeDuration = hasFade ? Math.min(teSection.duration, remaining) : 0
    const fadeType = hasFade ? teSection.type || 'volume' : 'volume'
    const delay = Math.max(0, remaining - fadeDuration)
    const scratchStyle = (hasFade ? teSection.curve : undefined) as
      | import('../../../typings/playback/processing.types.ts').ScratchStyle
      | undefined

    if (fadeType === 'tape' || fadeType === 'scratch') {
      this.dependencies.clock._snapshotPosition()
    }

    timers.trackEnd = setTimeout(() => {
      const stream = this.player.connection?.audioStream as
        | AudioResource
        | undefined
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
            ? (scratchStyle as import('../../../typings/playback/processing.types.ts').ScratchStyle)
            : 'wash'
          if (fadeType === 'scratch') {
            stream.scratchTo?.(fadeDuration, effectiveScratchStyle)
          }
        }

        if (fadeType !== 'volume' && hasFade) {
          const safetyTimeout = fadeDuration * 2 + 1500
          const trackId = this.player.track?.info.identifier
          setTimeout(() => {
            if (
              this.player.track?.info.identifier === trackId &&
              !this.player.isUpdatingTrack &&
              !this._isStopping
            ) {
              logger(
                'debug',
                'Player',
                `Safety stop triggered for guild ${this.player.guildId} after long fade-out ramp.`
              )
              this.player.connection?.stop(EndReasons.FINISHED)
            }
          }, safetyTimeout).unref?.()
        } else if (fadeDuration === 0) {
          if (
            this.player.track &&
            !this.player.isUpdatingTrack &&
            !this._isStopping
          ) {
            logger(
              'debug',
              'Player',
              `Scheduled track end for guild ${this.player.guildId} at ${this.player.track.info.length}ms`
            )
            this.player.connection?.stop(EndReasons.FINISHED)
          }
        } else {
          const trackId = this.player.track?.info.identifier
          setTimeout(() => {
            if (
              this.player.track?.info.identifier === trackId &&
              !this.player.isUpdatingTrack &&
              !this._isStopping
            ) {
              logger(
                'debug',
                'Player',
                `Track end after volume fade for guild ${this.player.guildId}`
              )
              this.player.connection?.stop(EndReasons.FINISHED)
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

  private _prepareResource(
    resource: AudioResource | undefined,
    fadeType: string
  ): boolean {
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

  private _fadeTrackStart(
    resource: AudioResource | undefined,
    section: FadingSection,
    fadeType: string,
    scratchStyle: ScratchStyle
  ): boolean {
    if (!this._pendingTrackStartFade) return false
    const stream = resource?.stream || this.player.connection?.audioStream
    if (!stream) return false
    this._pendingTrackStartFade = false

    if (fadeType === 'volume' || fadeType === 'both') {
      const targetVol = this.player.duckingController?.getTargetVolume(1) ?? 1
      if ((stream as AudioResource).fadeTo)
        (stream as AudioResource).fadeTo?.(
          targetVol,
          section.duration,
          section.curve
        )
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

  private _fadeAfterSeek(section: FadingSection, fadeType: string): boolean {
    const stream = this.player.connection?.audioStream as
      | AudioResource
      | undefined
    if (!stream) return false

    if (fadeType === 'volume' || fadeType === 'both') {
      const targetVol = this.player.duckingController?.getTargetVolume(1) ?? 1
      if (stream.setFadeVolume) stream.setFadeVolume(0)
      stream.fadeTo?.(targetVol, section.duration, section.curve)
    }
    if (fadeType === 'tape' || fadeType === 'both') {
      stream.tapeTo?.(section.duration, 'start', section.curve)
    }
    if (fadeType === 'scratch') {
      stream.scratchTo?.(section.duration, 'start')
    }
    return true
  }

  private _fadePause(
    section: FadingSection,
    fadeType: string,
    scratchStyle: ScratchStyle
  ): boolean {
    const timers = this._fadeTimers
    const stream = this.player.connection?.audioStream as
      | AudioResource
      | undefined
    if (!stream) return false
    logger(
      'debug',
      'Player',
      `Pause fade triggered for guild ${this.player.guildId}`
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
      const style = ['wash', 'backspin', 'baby', 'stop'].includes(scratchStyle)
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
        (fadeType !== 'both' || (isTapeDone === true && isScratchDone === true))
      const isRampDone = elapsed >= section.duration && effectsDone
      const isTimeUp = elapsed > section.duration + 500 // Safety timeout

      if (isRampDone || isTimeUp) {
        clearInterval(checkInterval)

        const drainTimeout = setTimeout(() => {
          this.player.connection?.pause?.('requested')
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

  private _fadeResume(section: FadingSection, fadeType: string): boolean {
    const stream = this.player.connection?.audioStream as
      | AudioResource
      | undefined
    if (!stream) return false
    logger(
      'debug',
      'Player',
      `Resume fade triggered for guild ${this.player.guildId}`
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

  private _fadeStop(
    section: FadingSection,
    fadeType: string,
    scratchStyle: ScratchStyle
  ): boolean {
    const timers = this._fadeTimers
    const stream = this.player.connection?.audioStream as
      | AudioResource
      | undefined
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
      const style = ['wash', 'backspin', 'baby', 'stop'].includes(scratchStyle)
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
          this.player.connection?.stop(EndReasons.STOPPED)
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
}
