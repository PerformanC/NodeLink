import type {
  AnimationTransition,
  FilterSettings
} from '../../typings/playback/filters.types.ts'
import { BaseFilter } from './BaseFilter.ts'

export type AnimationCurve = 'linear' | 'exponential' | 'sinusoidal'

const SUPPORTED_CURVES = new Set<AnimationCurve>([
  'linear',
  'exponential',
  'sinusoidal'
])

interface AnimationState {
  elapsedMs: number
  durationMs: number
  curve: AnimationCurve
}

/**
 * Base class for filters that support animated parameter transitions.
 * Smoothly interpolates numeric properties over audio chunks.
 */
export abstract class AnimatableFilter extends BaseFilter {
  private animation: AnimationState | null = null
  private startConfig: Record<string, number> = {}
  private targetConfig: Record<string, number> = {}
  protected currentConfig: Record<string, number> = {}

  /**
   * Updates the filter's target configuration.
   * If a `transition` object is provided, the parameters will be smoothly animated.
   *
   * @param settings - The raw filter settings payload.
   * @param configKey - The key where this filter's settings reside (e.g. 'lowpass').
   * @param defaults - The default values to use if absent.
   */
  protected applyAnimatedUpdate(
    settings: FilterSettings,
    configKey: string,
    defaults: Record<string, number>
  ): void {
    const rawConfig = (settings[configKey] as Record<string, unknown>) || {}
    const newTarget: Record<string, number> = {}

    for (const key of Object.keys(defaults)) {
      if (typeof rawConfig[key] === 'number') {
        newTarget[key] = rawConfig[key] as number
      } else if (this.currentConfig[key] !== undefined) {
        // Carry over existing instead of resetting to default
        newTarget[key] = this.currentConfig[key]
      } else {
        newTarget[key] = defaults[key] as number
      }
    }

    const transition = rawConfig.transition as AnimationTransition | undefined

    // If disabled via auto-injection hook, make sure transition executes properly but to default states
    // and if there's no transition, snap instantly to defaults
    if (rawConfig._disabled === true) {
      for (const key of Object.keys(defaults)) {
        newTarget[key] = defaults[key] as number
      }
    }

    if (
      transition &&
      typeof transition.durationMs === 'number' &&
      transition.durationMs > 0
    ) {
      this.animation = {
        durationMs: transition.durationMs,
        elapsedMs: 0,
        curve: SUPPORTED_CURVES.has(transition.curve as AnimationCurve)
          ? (transition.curve as AnimationCurve)
          : 'sinusoidal'
      }
      this.startConfig = { ...this.currentConfig }
      // Initialize if empty
      for (const key of Object.keys(defaults)) {
        if (this.startConfig[key] === undefined) {
          this.startConfig[key] = defaults[key] as number
          this.currentConfig[key] = defaults[key] as number
        }
      }
      this.targetConfig = newTarget
    } else {
      // Instant update
      this.animation = null
      this.currentConfig = { ...newTarget }
      this.targetConfig = { ...newTarget }
      this.onConfigChanged(this.currentConfig)
    }
  }

  /**
   * Processes the animation progression for an incoming chunk of audio.
   * Modifies the internal configuration based on the elapsed time.
   *
   * @param sampleRate - The current audio sample rate (e.g. 48000).
   * @param chunkLength - The byte length of the incoming PCM buffer.
   * @param channels - The number of audio channels (e.g. 2).
   */
  protected processAnimation(
    sampleRate: number,
    chunkLength: number,
    channels: number,
    sampleFormat: 's16le' | 'f32le' = 's16le'
  ): void {
    if (!this.animation) return

    // Calculate how many milliseconds this chunk represents
    const numSamples = chunkLength / (sampleFormat === 'f32le' ? 4 : 2)
    const numFrames = numSamples / channels
    const chunkDurationMs = (numFrames / sampleRate) * 1000

    this.animation.elapsedMs += chunkDurationMs

    if (this.animation.elapsedMs >= this.animation.durationMs) {
      // Animation finished
      this.animation = null
      this.currentConfig = { ...this.targetConfig }
      this.onConfigChanged(this.currentConfig)
      return
    }

    const t = this.animation.elapsedMs / this.animation.durationMs
    const curveT = this._getCurveValue(t, this.animation.curve)

    for (const key of Object.keys(this.targetConfig)) {
      const start = this.startConfig[key] ?? 0
      const target = this.targetConfig[key] ?? 0
      this.currentConfig[key] = start + (target - start) * curveT
    }

    this.onConfigChanged(this.currentConfig)
  }

  /**
   * Computes the interpolation curve.
   */
  private _getCurveValue(t: number, curve: AnimationCurve): number {
    switch (curve) {
      case 'linear':
        return t
      case 'exponential':
        return t * t
      case 'sinusoidal':
        return (1 - Math.cos(t * Math.PI)) / 2
      default:
        return t
    }
  }

  /**
   * Hook called immediately when the configuration changes.
   * Subclasses should use this to recalculate their internal coefficients.
   */
  protected abstract onConfigChanged(config: Record<string, number>): void

  /**
   * Checks if the filter is actively animating or if its static target configuration
   * expects modifications to the audio stream.
   * Return false to instruct the manager that the filter can be bypassed.
   */
  protected abstract isConfigActive(config: Record<string, number>): boolean

  /**
   * Reports whether this filter is actively doing anything or fading out.
   */
  public isActive(): boolean {
    if (this.animation) return true
    // Need to explicitly check if target is also active so that when animation finishes at 0,
    // it returns false the next tick, but not while it's actively holding the static 0.
    return this.isConfigActive(this.currentConfig)
  }
}
