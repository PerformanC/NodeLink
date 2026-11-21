/** Audio pipeline mode. Sample representation is selected independently. */
export type AudioProcessingMode = 'legacy' | 'protected'

/** PCM sample representation used by an audio stream or block. */
export type AudioSampleFormat = 's16le' | 'f32le'
export type AudioChannelLayout = string

/**
 * Immutable, generic format metadata shared by blocks in a stream.
 * The initial Protected internal format is validated separately below.
 */
export interface AudioFormat {
  readonly sampleFormat: AudioSampleFormat
  readonly sampleRate: number
  readonly channels: number
  readonly channelLayout: AudioChannelLayout
  readonly interleaved: boolean
}

/** Per-block metadata. Callers may pass this separately from the PCM Buffer. */
export interface AudioBlockMetadata {
  readonly frames: number
}

/** Logical audio block; implementations need not allocate this object per chunk. */
export interface AudioBlock extends AudioBlockMetadata {
  readonly data: Buffer
}

export type AudioAmplitudeBehavior =
  | 'preserves-headroom'
  | 'bounded'
  | 'unknown'

export type AudioAmplitudeProcessing = 'linear' | 'nonlinear'

export interface AudioAmplitudeBounds {
  readonly min: number
  readonly max: number
  readonly method: 'hard-clamp' | 'soft-clip' | 'waveshaper' | 'other'
  readonly intentional: boolean
}

/** Format support and amplitude behavior are independent capabilities. */
export type AudioCapabilities =
  | {
      readonly sampleFormats: readonly AudioSampleFormat[]
      readonly amplitudeBehavior: 'bounded'
      readonly amplitudeProcessing: AudioAmplitudeProcessing
      readonly amplitudeBounds: AudioAmplitudeBounds
    }
  | {
      readonly sampleFormats: readonly AudioSampleFormat[]
      readonly amplitudeBehavior: 'preserves-headroom' | 'unknown'
      readonly amplitudeProcessing: AudioAmplitudeProcessing
      readonly amplitudeBounds?: never
    }

/** Snapshot accumulated from the start of one audio resource. */
export interface AudioProcessingTelemetrySnapshot {
  /** Requested linear multiplier at the most recently recorded block. */
  readonly requested_gain: number
  /** Effective linear multiplier at the most recently recorded block. */
  readonly applied_gain: number
  /** Duration-weighted mean of effective linear multipliers for this resource. */
  readonly average_applied_gain: number
  /** Largest positive-magnitude reduction observed in this resource. */
  readonly max_gain_reduction_db: number
  /** Duration-weighted reduction mean across all blocks in this resource. */
  readonly average_gain_reduction_db: number
  /** Duration-weighted reduction mean over active blocks only. */
  readonly average_gain_reduction_active_db: number
  /** Sum of durations classified active in this resource. */
  readonly limiter_active_duration_ms: number
}

/** Per-block limiter statistics; reduction values are positive magnitudes. */
export interface AudioBlockGainReductionMetrics {
  readonly peak_gain_reduction_db: number
  readonly average_gain_reduction_db: number
  readonly average_applied_gain: number
  readonly duration_ms: number
  readonly active: boolean
}

/** Finalized statistics for one fixed-duration aggregation window. */
export interface AudioTelemetryWindowSnapshot
  extends AudioProcessingTelemetrySnapshot {
  readonly duration_ms: number
  readonly complete: boolean
}

/** One duration-bearing observation from the gain envelope. */
export interface AudioTelemetryBlockInput {
  readonly requested_gain: number
  readonly applied_gain: number
  readonly peak_gain_reduction_db: number
  readonly average_gain_reduction_db: number
  /** Mean of effective linear multipliers, calculated directly from the envelope. */
  readonly average_applied_gain: number
  readonly duration_ms: number
}

export interface AudioFormatOptions {
  sampleFormat: AudioSampleFormat
  sampleRate: number
  channels?: number
  channelLayout?: AudioChannelLayout
  interleaved?: boolean
}

export const LEGACY_AUDIO_PROCESSING_MODE: AudioProcessingMode = 'legacy'
export const PROTECTED_AUDIO_SAMPLE_RATE = 48000
export const PROTECTED_AUDIO_CHANNELS = 2
export const PROTECTED_AUDIO_CHANNEL_LAYOUT = 'stereo'
export const FLOAT32_HEADROOM_CAPABILITIES = Object.freeze({
  sampleFormats: ['f32le'] as const,
  amplitudeBehavior: 'preserves-headroom' as const,
  amplitudeProcessing: 'linear' as const
})
export const AUDIO_TELEMETRY_WINDOW_MS = 100
export const LIMITER_ACTIVE_THRESHOLD_DB = 0.1

export const createAudioFormat = ({
  sampleFormat,
  sampleRate,
  channels = PROTECTED_AUDIO_CHANNELS,
  channelLayout,
  interleaved = true
}: AudioFormatOptions): AudioFormat => {
  assertAudioSampleFormat(sampleFormat)
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new RangeError('Audio sampleRate must be a positive integer')
  }
  if (!Number.isInteger(channels) || channels <= 0) {
    throw new RangeError('Audio channel count must be a positive integer')
  }
  const resolvedLayout =
    channelLayout ??
    (channels === 1
      ? 'mono'
      : channels === 2
        ? PROTECTED_AUDIO_CHANNEL_LAYOUT
        : '')
  if (!resolvedLayout.trim()) {
    throw new TypeError(
      'Audio channelLayout is required for this channel count'
    )
  }

  return Object.freeze({
    sampleFormat,
    sampleRate,
    channels,
    channelLayout: resolvedLayout,
    interleaved
  })
}

export function assertAudioSampleFormat(
  sampleFormat: string
): asserts sampleFormat is AudioSampleFormat {
  if (sampleFormat !== 's16le' && sampleFormat !== 'f32le') {
    throw new TypeError(`Unsupported PCM sample format: ${sampleFormat}`)
  }
}

export function assertAudioFormat(format: AudioFormat): void {
  assertAudioSampleFormat(format.sampleFormat)
  if (!Number.isInteger(format.sampleRate) || format.sampleRate <= 0) {
    throw new RangeError('Audio sampleRate must be a positive integer')
  }
  if (!Number.isInteger(format.channels) || format.channels <= 0) {
    throw new RangeError('Audio channel count must be a positive integer')
  }
  if (
    typeof format.channelLayout !== 'string' ||
    !format.channelLayout.trim()
  ) {
    throw new TypeError('Audio channelLayout must be a non-empty string')
  }
  if (typeof format.interleaved !== 'boolean') {
    throw new TypeError('Audio interleaved must be a boolean')
  }
}

/** Validates the internal PCM format supported by the initial Protected path. */
export function assertProtectedInternalAudioFormat(format: AudioFormat): void {
  assertAudioFormat(format)
  if (format.sampleRate !== PROTECTED_AUDIO_SAMPLE_RATE) {
    throw new RangeError(
      `Protected internal audio requires ${PROTECTED_AUDIO_SAMPLE_RATE} Hz`
    )
  }
  if (format.sampleFormat !== 'f32le') {
    throw new TypeError('Protected internal audio requires f32le samples')
  }
  if (
    format.channels !== PROTECTED_AUDIO_CHANNELS ||
    format.channelLayout !== PROTECTED_AUDIO_CHANNEL_LAYOUT
  ) {
    throw new RangeError(
      'Protected internal audio requires stereo layout with 2 channels'
    )
  }
  if (!format.interleaved) {
    throw new TypeError('Protected internal audio requires interleaved samples')
  }
}

/** Validates the declared amplitude semantics of an audio component. */
export function assertAudioCapabilities(capabilities: AudioCapabilities): void {
  if (
    !Array.isArray(capabilities.sampleFormats) ||
    capabilities.sampleFormats.length === 0
  ) {
    throw new TypeError(
      'Audio capabilities must declare at least one sample format'
    )
  }
  for (const format of capabilities.sampleFormats)
    assertAudioSampleFormat(format)

  if (
    capabilities.amplitudeBehavior !== 'bounded' &&
    capabilities.amplitudeBehavior !== 'preserves-headroom' &&
    capabilities.amplitudeBehavior !== 'unknown'
  ) {
    throw new TypeError(
      `Unsupported amplitude behavior: ${String(capabilities.amplitudeBehavior)}`
    )
  }
  if (
    capabilities.amplitudeProcessing !== 'linear' &&
    capabilities.amplitudeProcessing !== 'nonlinear'
  ) {
    throw new TypeError(
      `Unsupported amplitude processing: ${String(capabilities.amplitudeProcessing)}`
    )
  }

  if (capabilities.amplitudeBehavior === 'bounded') {
    const bounds = capabilities.amplitudeBounds
    if (!bounds) {
      throw new TypeError(
        'Bounded audio capabilities must declare amplitudeBounds'
      )
    }
    if (
      !Number.isFinite(bounds.min) ||
      !Number.isFinite(bounds.max) ||
      bounds.min >= bounds.max
    ) {
      throw new RangeError(
        'Amplitude bounds must be finite and min must be less than max'
      )
    }
    if (
      bounds.method !== 'hard-clamp' &&
      bounds.method !== 'soft-clip' &&
      bounds.method !== 'waveshaper' &&
      bounds.method !== 'other'
    ) {
      throw new TypeError(
        `Unsupported amplitude limit method: ${String(bounds.method)}`
      )
    }
    if (typeof bounds.intentional !== 'boolean') {
      throw new TypeError(
        'Amplitude bounds must declare whether limiting is intentional'
      )
    }
  } else if ('amplitudeBounds' in capabilities) {
    throw new TypeError(
      'amplitudeBounds may only be declared when amplitudeBehavior is bounded'
    )
  }
}

export const getAudioBlockFrameCount = (
  data: Buffer,
  format: AudioFormat
): number => {
  assertAudioFormat(format)
  const bytesPerSample = format.sampleFormat === 's16le' ? 2 : 4
  const bytesPerFrame = bytesPerSample * format.channels
  if (data.length % bytesPerFrame !== 0) {
    throw new RangeError(
      `PCM buffer length ${data.length} is not aligned to ${bytesPerFrame}-byte frames`
    )
  }
  return data.length / bytesPerFrame
}

export const isAudioProcessingMode = (
  mode: unknown
): mode is AudioProcessingMode => mode === 'legacy' || mode === 'protected'

export const isLimiterTelemetryActive = (
  peakGainReductionDb: number
): boolean => peakGainReductionDb > LIMITER_ACTIVE_THRESHOLD_DB

interface MutableWindow {
  durationMs: number
  weightedAppliedGain: number
  weightedReduction: number
  weightedActiveReduction: number
  activeDurationMs: number
  maxReduction: number
  requestedGain: number
  appliedGain: number
}

const emptyWindow = (): MutableWindow => ({
  durationMs: 0,
  weightedAppliedGain: 0,
  weightedReduction: 0,
  weightedActiveReduction: 0,
  activeDurationMs: 0,
  maxReduction: 0,
  requestedGain: 1,
  appliedGain: 1
})

/**
 * Aggregates block-level limiter observations into fixed windows and resource-
 * lifetime snapshots. Call flushPartialWindow() on normal resource completion.
 */
export class AudioProcessingTelemetryAccumulator {
  private readonly windowMs: number
  private currentWindow = emptyWindow()
  private totalDurationMs = 0
  private totalWeightedAppliedGain = 0
  private totalWeightedReduction = 0
  private totalWeightedActiveReduction = 0
  private totalActiveDurationMs = 0
  private maxReduction = 0
  private requestedGain = 1
  private appliedGain = 1
  private closed = false

  constructor(windowMs = AUDIO_TELEMETRY_WINDOW_MS) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError(
        'Telemetry window duration must be a positive number'
      )
    }
    this.windowMs = windowMs
  }

  /** Adds one limiter observation and returns any complete windows it closes. */
  recordBlock(input: AudioTelemetryBlockInput): AudioTelemetryWindowSnapshot[] {
    if (this.closed) {
      throw new Error(
        'Telemetry accumulator is closed; reset it before recording'
      )
    }
    this._validateBlock(input)

    this.requestedGain = input.requested_gain
    this.appliedGain = input.applied_gain
    const active = isLimiterTelemetryActive(input.peak_gain_reduction_db)
    let remainingMs = input.duration_ms
    const closedWindows: AudioTelemetryWindowSnapshot[] = []
    const epsilon = 1e-9

    while (remainingMs > epsilon) {
      const capacityMs = this.windowMs - this.currentWindow.durationMs
      const durationMs = Math.min(remainingMs, capacityMs)
      this._accumulate(input, durationMs, active)
      remainingMs -= durationMs

      if (this.currentWindow.durationMs >= this.windowMs - epsilon) {
        closedWindows.push(this._closeWindow(true))
      }
    }

    return closedWindows
  }

  /** Closes the final partial window at normal resource completion. */
  flushPartialWindow(): AudioTelemetryWindowSnapshot | null {
    if (this.closed) return null
    this.closed = true
    if (this.currentWindow.durationMs <= 0) return null
    return this._closeWindow(false)
  }

  /** Returns cumulative metrics, including observations in the current window. */
  snapshot(): AudioProcessingTelemetrySnapshot {
    const durationMs = this.totalDurationMs
    return {
      requested_gain: this.requestedGain,
      applied_gain: this.appliedGain,
      average_applied_gain:
        durationMs > 0 ? this.totalWeightedAppliedGain / durationMs : 1,
      max_gain_reduction_db: this.maxReduction,
      average_gain_reduction_db:
        durationMs > 0 ? this.totalWeightedReduction / durationMs : 0,
      average_gain_reduction_active_db:
        this.totalActiveDurationMs > 0
          ? this.totalWeightedActiveReduction / this.totalActiveDurationMs
          : 0,
      limiter_active_duration_ms: this.totalActiveDurationMs
    }
  }

  /** Resets all state for a new audio resource. */
  reset(): void {
    this.currentWindow = emptyWindow()
    this.totalDurationMs = 0
    this.totalWeightedAppliedGain = 0
    this.totalWeightedReduction = 0
    this.totalWeightedActiveReduction = 0
    this.totalActiveDurationMs = 0
    this.maxReduction = 0
    this.requestedGain = 1
    this.appliedGain = 1
    this.closed = false
  }

  private _validateBlock(input: AudioTelemetryBlockInput): void {
    const nonNegativeValues = [
      input.requested_gain,
      input.applied_gain,
      input.peak_gain_reduction_db,
      input.average_gain_reduction_db,
      input.average_applied_gain
    ]
    if (
      !nonNegativeValues.every(Number.isFinite) ||
      nonNegativeValues.some((value) => value < 0)
    ) {
      throw new RangeError(
        'Audio telemetry gains and reductions must be finite and non-negative'
      )
    }
    if (!Number.isFinite(input.duration_ms) || input.duration_ms <= 0) {
      throw new RangeError(
        'Audio telemetry block duration must be positive and finite'
      )
    }
    if (input.average_gain_reduction_db > input.peak_gain_reduction_db + 1e-9) {
      throw new RangeError(
        'Average gain reduction cannot exceed the block peak reduction'
      )
    }
  }

  private _accumulate(
    input: AudioTelemetryBlockInput,
    durationMs: number,
    active: boolean
  ): void {
    const window = this.currentWindow
    window.durationMs += durationMs
    window.weightedAppliedGain += input.average_applied_gain * durationMs
    window.weightedReduction += input.average_gain_reduction_db * durationMs
    window.maxReduction = Math.max(
      window.maxReduction,
      input.peak_gain_reduction_db
    )
    window.requestedGain = input.requested_gain
    window.appliedGain = input.applied_gain
    this.totalDurationMs += durationMs
    this.totalWeightedAppliedGain += input.average_applied_gain * durationMs
    this.totalWeightedReduction += input.average_gain_reduction_db * durationMs
    this.maxReduction = Math.max(
      this.maxReduction,
      input.peak_gain_reduction_db
    )

    if (active) {
      window.activeDurationMs += durationMs
      window.weightedActiveReduction +=
        input.average_gain_reduction_db * durationMs
      this.totalActiveDurationMs += durationMs
      this.totalWeightedActiveReduction +=
        input.average_gain_reduction_db * durationMs
    }
  }

  private _closeWindow(complete: boolean): AudioTelemetryWindowSnapshot {
    const window = this.currentWindow
    const snapshot: AudioTelemetryWindowSnapshot = {
      requested_gain: window.requestedGain,
      applied_gain: window.appliedGain,
      average_applied_gain:
        window.durationMs > 0
          ? window.weightedAppliedGain / window.durationMs
          : 1,
      max_gain_reduction_db: window.maxReduction,
      average_gain_reduction_db:
        window.durationMs > 0
          ? window.weightedReduction / window.durationMs
          : 0,
      average_gain_reduction_active_db:
        window.activeDurationMs > 0
          ? window.weightedActiveReduction / window.activeDurationMs
          : 0,
      limiter_active_duration_ms: window.activeDurationMs,
      duration_ms: window.durationMs,
      complete
    }
    this.currentWindow = emptyWindow()
    return snapshot
  }
}

export const resolveAudioProcessingMode = (
  globalMode?: AudioProcessingMode | null,
  playerOverride?: AudioProcessingMode | null
): AudioProcessingMode => {
  const resolved = playerOverride ?? globalMode ?? LEGACY_AUDIO_PROCESSING_MODE
  if (!isAudioProcessingMode(resolved)) {
    throw new TypeError(`Invalid audio processing mode: ${String(resolved)}`)
  }
  return resolved
}
