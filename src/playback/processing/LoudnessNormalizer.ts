import type { LoudnessNormalizerOptions } from '../../typings/playback/processing.types.ts'

const INT16_MAX = 32767
const INT16_MIN = -32768
const MIN_ENERGY = 1e-12
const fround = Math.fround
const INV_32768 = 1 / 32768

/**
 * Implements a standard Biquad filter for audio processing.
 */
class BiquadFilter {
  private readonly b0: number
  private readonly b1: number
  private readonly b2: number
  private readonly a1: number
  private readonly a2: number
  private x1: number
  private x2: number
  private y1: number
  private y2: number

  /**
   * Creates a Biquad filter with specific coefficients.
   */
  constructor(b0: number, b1: number, b2: number, a1: number, a2: number) {
    this.b0 = fround(b0)
    this.b1 = fround(b1)
    this.b2 = fround(b2)
    this.a1 = fround(a1)
    this.a2 = fround(a2)
    this.x1 = 0.0
    this.x2 = 0.0
    this.y1 = 0.0
    this.y2 = 0.0
  }

  /**
   * Processes a single audio sample through the filter.
   * @param sample - Input sample.
   * @returns Filtered sample.
   */
  public process(sample: number): number {
    const x0 = fround(sample)
    const y0 = fround(
      this.b0 * x0 +
        this.b1 * this.x1 +
        this.b2 * this.x2 -
        this.a1 * this.y1 -
        this.a2 * this.y2
    )

    this.x2 = this.x1
    this.x1 = x0
    this.y2 = this.y1
    this.y1 = y0

    return y0
  }

  /**
   * Resets the filter state.
   */
  public reset(): void {
    this.x1 = 0.0
    this.x2 = 0.0
    this.y1 = 0.0
    this.y2 = 0.0
  }
}

/**
 * Implements K-weighting filtering for loudness estimation.
 */
class KWeightingFilter {
  private readonly pre: BiquadFilter
  private readonly rlb: BiquadFilter

  constructor() {
    this.pre = new BiquadFilter(
      1.53512485958697,
      -2.69169618940638,
      1.19839281085285,
      -1.69065929318241,
      0.73248077421585
    )
    this.rlb = new BiquadFilter(
      1.0,
      -2.0,
      1.0,
      -1.99004745483398,
      0.99007225036621
    )
  }

  /**
   * Processes a sample through pre-filter and RLB filter.
   * @param sample - Input sample.
   * @returns Filtered sample.
   */
  public process(sample: number): number {
    return this.rlb.process(this.pre.process(sample))
  }

  /**
   * Resets the filters.
   */
  public reset(): void {
    this.pre.reset()
    this.rlb.reset()
  }
}

/**
 * Normalizes audio loudness dynamically based on the EBU R128 standard principles.
 */
export class LoudnessNormalizer {
  private readonly sampleRate: number
  private channels: number
  private readonly targetLoudness: number
  private readonly attackTime: number
  private readonly releaseTime: number
  private readonly shortTermTime: number
  private readonly gateThresholdLUFS: number
  private filters: KWeightingFilter[]
  private readonly _gateThresholdEnergy: number
  private readonly _initialEnergy: number
  private _energyState: number
  private _currentGain: number
  private _attackAlpha = 0
  private _releaseAlpha = 0
  private _energyAlpha = 0
  private _channelBuffer: Float32Array

  /**
   * Creates a new LoudnessNormalizer.
   * @param options - Configuration options.
   */
  constructor(options: LoudnessNormalizerOptions = {}) {
    this.sampleRate = options.sampleRate ?? 48000
    this.channels = options.channels ?? 2
    this.targetLoudness = options.targetLoudness ?? -14
    this.attackTime = options.attackTime ?? 0.1
    this.releaseTime = options.releaseTime ?? 5.0
    this.shortTermTime = options.shortTermTime ?? 3.0
    this.gateThresholdLUFS = options.gateThresholdLUFS ?? -60

    this.filters = []
    this._ensureFilters()

    this._gateThresholdEnergy = fround(
      10 ** ((this.gateThresholdLUFS + 0.691) / 10)
    )
    this._initialEnergy = fround(10 ** ((this.targetLoudness + 0.691) / 10))
    this._energyState = this._initialEnergy
    this._currentGain = 1.0
    this._channelBuffer = new Float32Array(this.channels)

    this._updateSmoothingCoefficients()
  }

  /**
   * Updates the number of channels supported by the normalizer.
   * @param count - Number of channels.
   */
  public setChannels(count: number): void {
    if (!Number.isInteger(count) || count <= 0) return
    if (this.channels === count) return
    this.channels = count
    this._channelBuffer = new Float32Array(count)
    this._ensureFilters()
  }

  /**
   * Resets the internal state of the normalizer.
   */
  public reset(): void {
    this._energyState = this._initialEnergy
    this._currentGain = 1.0
    for (const filter of this.filters) {
      filter.reset()
    }
  }

  /**
   * Processes an Int16Array of PCM samples in-place.
   * @param inputView - View of the PCM buffer.
   */
  public process(inputView: Int16Array): void {
    if (inputView.length === 0) return

    const frameCount = inputView.length / this.channels
    const channelBuffer = this._channelBuffer

    let energyState = this._energyState
    let gainState = this._currentGain
    const attackAlpha = this._attackAlpha
    const releaseAlpha = this._releaseAlpha
    const energyAlpha = this._energyAlpha
    const target = this.targetLoudness

    const filters = this.filters
    const numChannels = this.channels

    for (
      let frameIndex = 0, sampleIndex = 0;
      frameIndex < frameCount;
      frameIndex++
    ) {
      let energySum = 0.0

      for (let ch = 0; ch < numChannels; ch += 1, sampleIndex += 1) {
        const sample = fround((inputView[sampleIndex] ?? 0) * INV_32768)
        const filter = filters[ch]
        if (filter) {
          const filtered = filter.process(sample)
          channelBuffer[ch] = filtered
          energySum += filtered * filtered
        }
      }

      energySum = fround(energySum / numChannels)

      if (energySum > this._gateThresholdEnergy) {
        energyState = fround(
          energyState * energyAlpha + (1 - energyAlpha) * energySum
        )
      }

      const loudness =
        -0.691 + 10 * Math.log10(Math.max(energyState, MIN_ENERGY))
      const desiredGainDB = target - loudness
      const desiredGainLinear = 10 ** (desiredGainDB / 20)

      const smoothingAlpha =
        desiredGainLinear < gainState ? attackAlpha : releaseAlpha
      gainState = fround(
        smoothingAlpha * gainState + (1 - smoothingAlpha) * desiredGainLinear
      )

      if (gainState > 4.0) gainState = 4.0

      for (
        let ch = 0, outIndex = frameIndex * this.channels;
        ch < this.channels;
        ch += 1, outIndex += 1
      ) {
        const scaled = (inputView[outIndex] ?? 0) * gainState
        inputView[outIndex] =
          scaled < INT16_MIN
            ? INT16_MIN
            : scaled > INT16_MAX
              ? INT16_MAX
              : Math.round(scaled)
      }
    }

    this._energyState = energyState
    this._currentGain = gainState
  }

  private _ensureFilters(): void {
    while (this.filters.length < this.channels) {
      this.filters.push(new KWeightingFilter())
    }
    if (this.filters.length > this.channels) {
      this.filters.length = this.channels
    }
  }

  private _updateSmoothingCoefficients(): void {
    const sr = this.sampleRate
    const attackTime = Math.max(1e-3, this.attackTime)
    const releaseTime = Math.max(1e-3, this.releaseTime)
    const shortTermTime = Math.max(1e-3, this.shortTermTime)

    this._attackAlpha = fround(Math.exp(-1 / (attackTime * sr)))
    this._releaseAlpha = fround(Math.exp(-1 / (releaseTime * sr)))
    this._energyAlpha = fround(Math.exp(-1 / (shortTermTime * sr)))
  }
}
