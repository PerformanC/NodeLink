import { GatewayEvents } from '../../../constants.ts'
import type { DuckingConfig } from '../../../typings/playback/ducking.types.ts'
import type {
  AudioOptionsWithTransitions,
  FilterStateEntry,
  FiltersState,
  FilterTransitionsConfig,
  NodeLink
} from '../../../typings/playback/player.types.ts'
import { logger } from '../../../utils.ts'
import type { Player } from '../../player.ts'
import { DuckingController } from '../../processing/DuckingController.ts'
import type { PlaybackClock } from '../base/clock.ts'
import type { PlayerQueue } from '../playback/queue.ts'
import type { PlayerTransitions } from './transitions.ts'

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
interface PlayerAudioDependencies {
  queue: PlayerQueue
  clock: PlaybackClock
  transitions: PlayerTransitions
}

/**
 * Applies player volume, filters, normalization, and ducking.
 * @internal
 */
export class PlayerAudio {
  private readonly player: Pick<
    Player,
    | 'guildId'
    | 'destroying'
    | 'volumePercent'
    | 'connection'
    | 'emitEvent'
    | 'loudnessNormalizer'
    | 'fading'
    | 'duckingController'
    | 'track'
    | 'filters'
  >
  private readonly nodelink: NodeLink
  private readonly dependencies: PlayerAudioDependencies

  constructor(
    player: PlayerAudio['player'],
    nodelink: NodeLink,
    dependencies: PlayerAudioDependencies
  ) {
    this.player = player
    this.nodelink = nodelink
    this.dependencies = dependencies
  }

  private _getAudioOptions(): AudioOptionsWithTransitions | undefined {
    return this.nodelink.options.playback.audio as
      | AudioOptionsWithTransitions
      | undefined
  }

  private _getFilterTransitions(): FilterTransitionsConfig | undefined {
    return this._getAudioOptions()?.filterTransitions
  }

  /**
   * Adjusts playback volume (0-1000).
   *
   * @param level - Volume percentage (0-1000).
   * @returns True when volume was updated.
   */
  public volume(level: number): boolean {
    logger(
      'debug',
      'Player',
      `[Action: volume] Method invoked for guild ${this.player.guildId} with target: ${level}`
    )
    if (this.player.destroying) {
      logger(
        'debug',
        'Player',
        `[Action: volume] Aborted for guild ${this.player.guildId}: player is destroying`
      )
      return false
    }
    logger(
      'debug',
      'Player',
      `Setting volume to ${level} for guild ${this.player.guildId}`
    )
    this.player.volumePercent = Math.max(0, Math.min(1000, level))
    this.player.connection?.audioStream?.setVolume(
      this.player.volumePercent / 100
    )
    if (!this.dependencies.queue.nextResourceIsCrossfade) {
      this.dependencies.queue.nextResource?.setVolume(
        this.player.volumePercent / 100
      )
    }
    this.player.emitEvent(GatewayEvents.VOLUME_CHANGED, {
      volume: this.player.volumePercent
    })
    return true
  }

  /**
   * Toggles loudness normalization.
   *
   * @param enabled - Whether to enable loudness normalization.
   * @returns True when updated.
   */
  public setLoudnessNormalizer(enabled: boolean): boolean {
    logger(
      'debug',
      'Player',
      `[Action: setLoudnessNormalizer] Method invoked for guild ${this.player.guildId} to ${enabled}`
    )
    this.player.loudnessNormalizer = !!enabled
    if (this.player.connection?.audioStream) {
      this.player.connection.audioStream.setLoudnessNormalizer?.(
        this.player.loudnessNormalizer
      )
    }
    return true
  }

  /**
   * Resolves the ducking configuration from the fading config or global config.
   *
   * @returns Resolved ducking configuration.
   */
  public _resolveDuckingConfig(): DuckingConfig {
    const fadingDucking = this.player.fading?.ducking
    const configDucking =
      this.nodelink.options?.playback?.audio?.fading?.ducking

    const source = fadingDucking ?? configDucking

    return {
      enabled: source?.enabled ?? false,
      duration: source?.duration ?? 500,
      targetVolume: source?.targetVolume ?? 0.15,
      curve: source?.curve ?? 'linear'
    }
  }

  /**
   * Toggles auto-ducking (lowers music volume when users speak).
   *
   * @param enabled - Whether to enable auto-ducking.
   * @returns True when updated.
   */
  public setDucking(enabled: boolean): boolean {
    logger(
      'debug',
      'Player',
      `[Action: setDucking] Method invoked for guild ${this.player.guildId} to ${enabled}`
    )

    if (enabled) {
      const duckingCfg = this._resolveDuckingConfig()
      duckingCfg.enabled = true

      if (!this.player.duckingController) {
        this.player.duckingController = new DuckingController(
          this.player.guildId,
          duckingCfg
        )
      } else {
        this.player.duckingController.updateConfig(duckingCfg)
      }

      // Attach to current connection if available
      if (this.player.connection) {
        this.player.duckingController.attach(this.player.connection)
      }

      // Connect to current audio stream if available
      if (this.player.connection?.audioStream?.fadeTo) {
        const stream = this.player.connection.audioStream
        this.player.duckingController.setStreamControl({
          fadeTo: (volume: number, durationMs: number, curve?: string) =>
            stream.fadeTo?.(volume, durationMs, curve)
        })
      }
    } else {
      if (this.player.duckingController) {
        this.player.duckingController.detach()
        this.player.duckingController.destroy()
        this.player.duckingController = null
      }
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
    logger(
      'debug',
      'Player',
      `[Action: setFilters] Method invoked for guild ${this.player.guildId}`
    )
    if (this.player.destroying || !this.player.track) {
      logger(
        'debug',
        'Player',
        `[Action: setFilters] Aborted for guild ${this.player.guildId}: destroying=${this.player.destroying}, hasTrack=${!!this.player.track}`
      )
      return false
    }
    logger(
      'debug',
      'Player',
      `Applying filters for guild ${this.player.guildId}:`,
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
            this.player.filters.filters as Record<string, unknown> | undefined
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
      (this.player.filters.filters as Record<string, unknown> | undefined) || {}
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

    this.player.filters = { ...this.player.filters, filters: newFilterSettings }

    if (this.player.connection?.audioStream) {
      this.dependencies.clock._snapshotPosition()
      this.player.connection.audioStream.setFilters(this.player.filters)
      this.dependencies.transitions._fading('trackEndSchedule', {
        startPosition: this.dependencies.clock._realPosition()
      })
    }
    if (!this.dependencies.queue.nextResourceIsCrossfade) {
      this.dependencies.queue.nextResource?.setFilters(this.player.filters)
    }
    if (this.dependencies.queue.nextResourceIsCrossfade)
      this.dependencies.queue._rescheduleCrossfade()

    const disabledKeys: string[] = []
    for (const key in newFilterSettings) {
      const val = newFilterSettings[key]
      if (val?._disabled === true) {
        disabledKeys.push(key)
      }
    }
    if (disabledKeys.length > 0) {
      const cleanupDisabledFilters = () => {
        const current = { ...(this.player.filters.filters ?? {}) } as Record<
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
          this.player.filters = { ...this.player.filters, filters: current }
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

    this.player.emitEvent(GatewayEvents.FILTERS_CHANGED, {
      filters: this.player.filters
    })

    return true
  }
}
