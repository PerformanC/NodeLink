/**
 * Configuration for the Channel Mix filter.
 * @public
 */
export interface ChannelMixSettings {
  leftToLeft?: number
  leftToRight?: number
  rightToLeft?: number
  rightToRight?: number
  transition?: AnimationTransition
}

/**
 * Configuration for the Timescale filter.
 * @public
 */
export interface TimescaleSettings {
  speed?: number
  pitch?: number
  rate?: number
  transition?: AnimationTransition
}

/**
 * Configuration for the Tremolo filter.
 * @public
 */
export interface TremoloSettings {
  frequency?: number
  depth?: number
  transition?: AnimationTransition
  alpha?: number
}

/**
 * Configuration for the Vibrato filter.
 * @public
 */
export interface VibratoSettings {
  frequency?: number
  depth?: number
  transition?: AnimationTransition
  alpha?: number
}

/**
 * Individual band configuration for the Equalizer.
 * @public
 */
export interface EqualizerBand {
  band: number
  gain: number
}

/**
 * Filter animation transitions.
 * @public
 */
export interface AnimationTransition {
  durationMs: number
  curve?: string
}

/**
 * Configuration for the Equalizer filter.
 * @public
 */
export interface EqualizerSettings {
  bands?: EqualizerBand[]
  transition?: AnimationTransition
}

/**
 * Configuration for the Karaoke filter.
 * @public
 */
export interface KaraokeSettings {
  level?: number
  monoLevel?: number
  filterBand?: number
  filterWidth?: number
  transition?: AnimationTransition
  alpha?: number
}

/**
 * Configuration for the Echo filter.
 * @public
 */
export interface EchoSettings {
  delay?: number
  feedback?: number
  mix?: number
  transition?: AnimationTransition
  alpha?: number
}

/**
 * Configuration for the Reverb filter.
 * @public
 */
export interface ReverbSettings {
  roomSize?: number
  damping?: number
  wetLevel?: number
  dryLevel?: number
  width?: number
  mix?: number
  transition?: AnimationTransition
  alpha?: number
}

/**
 * Configuration for the Distortion filter.
 * @public
 */
export interface DistortionSettings {
  sinOffset?: number
  sinScale?: number
  cosOffset?: number
  cosScale?: number
  tanOffset?: number
  tanScale?: number
  offset?: number
  scale?: number
  transition?: AnimationTransition
  alpha?: number
}

/**
 * Configuration for the Rotation filter.
 * @public
 */
export interface RotationSettings {
  rotationHz?: number
  transition?: AnimationTransition
  alpha?: number
}

/**
 * Configuration for the Tesseract (4D Rotation) filter.
 * @public
 */
export interface TesseractSettings {
  rotationHz?: number
  transition?: AnimationTransition
  alpha?: number
}

/**
 * Configuration for the LowPass filter.
 * @public
 */
export interface LowPassSettings {
  smoothing?: number
  targetAlpha?: number
  logSmoothing?: number
  transition?: AnimationTransition
}

/**
 * Configuration for the HighPass filter.
 * @public
 */
export interface HighPassSettings {
  smoothing?: number
  targetAlpha?: number
  transition?: AnimationTransition
}

/**
 * Configuration for the Chorus filter.
 * @public
 */
export interface ChorusSettings {
  rate?: number
  depth?: number
  feedback?: number
  delay?: number
  mix?: number
  transition?: AnimationTransition
  alpha?: number
}

/**
 * Configuration for the Phaser filter.
 * @public
 */
export interface PhaserSettings {
  rate?: number
  depth?: number
  feedback?: number
  delay?: number
  mix?: number
  stages?: number
  minFrequency?: number
  maxFrequency?: number
  transition?: AnimationTransition
  alpha?: number
}

/**
 * Configuration for the Flanger filter.
 * @public
 */
export interface FlangerSettings {
  rate?: number
  depth?: number
  feedback?: number
  delay?: number
  mix?: number
  transition?: AnimationTransition
  alpha?: number
}

/**
 * Configuration for the Spatial filter.
 * @public
 */
export interface SpatialSettings {
  x?: number
  y?: number
  z?: number
  depth?: number
  rate?: number
  transition?: AnimationTransition
  alpha?: number
}

/**
 * Configuration for the Compressor filter.
 * @public
 */
export interface CompressorSettings {
  threshold?: number
  ratio?: number
  attack?: number
  release?: number
  gain?: number
  makeupGain?: number
  transition?: AnimationTransition
  alpha?: number
}

/**
 * Configuration for the Tape filter.
 * @public
 */
export interface TapeSettings {
  /**
   * Ramp duration in milliseconds.
   */
  duration?: number
  /**
   * Ramp type.
   */
  type?: 'start' | 'stop'
  /**
   * Fading curve.
   */
  curve?: string
}

/**
 * Configuration for the Phonograph filter.
 * @public
 */
export interface PhonographSettings {
  /**
   * Frequency of the pitch modulation (wow).
   * @defaultValue 0.8
   */
  frequency?: number
  /**
   * Intensity of the pitch modulation (wow).
   * @defaultValue 0.25
   */
  depth?: number
  /**
   * Amount of surface noise and crackle.
   * @defaultValue 0.18
   */
  crackle?: number
  /**
   * Intensity of rapid pitch jitter (flutter).
   * @defaultValue 0.18
   */
  flutter?: number
  /**
   * Room ambiance / early reflections simulation.
   * @defaultValue 0.22
   */
  room?: number
  /**
   * Microphone Automatic Gain Control / Compression simulation.
   * @defaultValue 0.25
   */
  micAgc?: number
  /**
   * Mechanical saturation / drive.
   * @defaultValue 0.25
   */
  drive?: number
  /**
   * Filter parameter transition configuration.
   */
  transition?: AnimationTransition
  /**
   * Internal fade.
   */
  alpha?: number
}

/**
 * Shape of filter settings accepted by filter instances.
 * @public
 */
export interface FilterSettings {
  channelMix?: ChannelMixSettings
  timescale?: TimescaleSettings
  tremolo?: TremoloSettings
  vibrato?: VibratoSettings
  equalizer?: EqualizerSettings
  karaoke?: KaraokeSettings
  echo?: EchoSettings
  reverb?: ReverbSettings
  distortion?: DistortionSettings
  rotation?: RotationSettings
  lowpass?: LowPassSettings
  highpass?: HighPassSettings
  chorus?: ChorusSettings
  phaser?: PhaserSettings
  flanger?: FlangerSettings
  spatial?: SpatialSettings
  compressor?: CompressorSettings
  phonograph?: PhonographSettings
  tape?: TapeSettings
  tesseract?: TesseractSettings
  [key: string]: unknown
}

/**
 * Runtime audio filter instance used by the filter pipeline.
 * @remarks Filters can optionally expose update/flush hooks for stateful logic.
 * @example
 * ```ts
 * const filter: FilterInstance = {
 *   priority: 5,
 *   process: (chunk) => chunk,
 *   update: (settings) => console.log(settings)
 * }
 * ```
 * @public
 */
export interface FilterInstance {
  /**
   * Optional sort priority (lower runs first).
   */
  priority?: number

  /**
   * Processes PCM audio buffers.
   */
  process: (chunk: Buffer) => Buffer

  /**
   * Updates filter settings from the full filter payload.
   */
  update?: (settings: FilterSettings) => void

  /**
   * Flushes any pending buffered data.
   */
  flush?: () => Buffer

  /**
   * Returns true if the filter is currently active or animating back to its disabled state.
   */
  isActive?: () => boolean

  /**
   * Releases any internal resources.
   */
  destroy?: () => void
}

/**
 * Constructor signature for built-in filter classes.
 * @public
 */
export type FilterClass = new () => FilterInstance

/**
 * NodeLink context required by the FiltersManager.
 * @public
 */
export interface FiltersManagerContext {
  /**
   * Optional extension map for custom filters.
   */
  extensions?: {
    filters?: Map<string, FilterInstance>
  } & Record<string, unknown>
}
