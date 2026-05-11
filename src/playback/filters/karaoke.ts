import { SAMPLE_RATE } from '../../constants.ts'
import type { FilterSettings } from '../../typings/playback/filters.types.ts'
import { AnimatableFilter } from './AnimatableFilter.ts'
import { clamp16Bit } from './dsp/clamp16Bit.ts'

const MAX_OUTPUT_GAIN = 0.98
const SCALE_16 = 32768
const INV_16 = 1 / SCALE_16

/**
 * Applies a karaoke effect by vocal removal/suppression.
 * @public
 */
export default class Karaoke extends AnimatableFilter {
  public priority = 10
  private level = 0
  private monoLevel = 0
  private filterBand = 0
  private filterWidth = 0

  private lp_b0 = 0
  private lp_b1 = 0
  private lp_b2 = 0
  private lp_a1 = 0
  private lp_a2 = 0
  private hp_b0 = 0
  private hp_b1 = 0
  private hp_b2 = 0
  private hp_a1 = 0
  private hp_a2 = 0

  private _prevGain = MAX_OUTPUT_GAIN
  private _bufL: Float32Array | null = null
  private _bufR: Float32Array | null = null
  private _bufFrames = 0

  private lp_left_x1 = 0
  private lp_left_x2 = 0
  private lp_left_y1 = 0
  private lp_left_y2 = 0
  private lp_right_x1 = 0
  private lp_right_x2 = 0
  private lp_right_y1 = 0
  private lp_right_y2 = 0
  private hp_left_x1 = 0
  private hp_left_x2 = 0
  private hp_left_y1 = 0
  private hp_left_y2 = 0
  private hp_right_x1 = 0
  private hp_right_x2 = 0
  private hp_right_y1 = 0
  private hp_right_y2 = 0

  constructor() {
    super()
    this._resetFilterState()
    this.updateCoefficients()
  }

  /**
   * Resets the internal IIR filter state.
   */
  private _resetFilterState(): void {
    this.lp_left_x1 = this.lp_left_x2 = this.lp_left_y1 = this.lp_left_y2 = 0
    this.lp_right_x1 =
      this.lp_right_x2 =
      this.lp_right_y1 =
      this.lp_right_y2 =
        0
    this.hp_left_x1 = this.hp_left_x2 = this.hp_left_y1 = this.hp_left_y2 = 0
    this.hp_right_x1 =
      this.hp_right_x2 =
      this.hp_right_y1 =
      this.hp_right_y2 =
        0
  }

  /**
   * Ensures internal buffers are large enough for the given number of frames.
   * @param frames - Required number of frames.
   */
  private _ensureBuffers(frames: number): void {
    if (frames <= this._bufFrames && this._bufL && this._bufR) return
    this._bufFrames = frames
    this._bufL = new Float32Array(frames)
    this._bufR = new Float32Array(frames)
  }

  /**
   * Updates the filter coefficients based on the current band and width.
   */
  private updateCoefficients(): void {
    const band = this.filterBand
    const widthIn = this.filterWidth

    if (!band || !widthIn) {
      this.lp_b0 = this.hp_b0 = 1
      this.lp_b1 = this.lp_b2 = this.lp_a1 = this.lp_a2 = 0
      this.hp_b1 = this.hp_b2 = this.hp_a1 = this.hp_a2 = 0
      return
    }

    const fc = Math.max(1, Math.min(SAMPLE_RATE * 0.49, band))
    const width = Math.max(1e-6, widthIn)
    const Q = Math.max(1e-4, fc / width)

    const omega0 = (2 * Math.PI * fc) / SAMPLE_RATE
    const cos0 = Math.cos(omega0)
    const sin0 = Math.sin(omega0)
    const alpha = sin0 / (2 * Q)

    const a0 = 1 + alpha
    const invA0 = 1 / a0
    const a1 = -2 * cos0 * invA0
    const a2 = (1 - alpha) * invA0

    const lpB0 = (1 - cos0) * 0.5 * invA0
    const lpB1 = (1 - cos0) * invA0
    const lpB2 = lpB0

    this.lp_b0 = lpB0
    this.lp_b1 = lpB1
    this.lp_b2 = lpB2
    this.lp_a1 = a1
    this.lp_a2 = a2

    const hpB0 = (1 + cos0) * 0.5 * invA0
    const hpB1 = -(1 + cos0) * invA0
    const hpB2 = hpB0

    this.hp_b0 = hpB0
    this.hp_b1 = hpB1
    this.hp_b2 = hpB2
    this.hp_a1 = a1
    this.hp_a2 = a2
  }

  private targetLevel = 0
  private targetMonoLevel = 0
  private alpha = 1.0

  /**
   * Updates the karaoke settings.
   * @param settings - Filter settings containing `karaoke`.
   */
  public override update(settings: FilterSettings): void {
    const k = settings?.karaoke || {}
    const isDisabled = (k as Record<string, unknown>)._disabled === true

    this.targetLevel = k.level ?? 1.0
    this.targetMonoLevel = k.monoLevel ?? 1.0
    this.filterBand = k.filterBand ?? 220.0
    this.filterWidth = k.filterWidth ?? 100.0

    this.updateCoefficients()

    const targetAlpha = isDisabled ? 0.0 : 1.0

    super.applyAnimatedUpdate(
      {
        karaoke: {
          alpha: targetAlpha
        }
      },
      'karaoke',
      { alpha: 0.0 }
    )
  }

  protected override onConfigChanged(config: Record<string, number>): void {
    this.alpha = config.alpha ?? 1.0

    const level = this.targetLevel
    const monoLevel = this.targetMonoLevel

    this.level = level <= 0 ? 0 : level >= 1 ? 1 : level
    this.monoLevel = monoLevel <= 0 ? 0 : monoLevel >= 1 ? 1 : monoLevel
  }

  protected override isConfigActive(config?: Record<string, number>): boolean {
    const a = config ? config.alpha : this.alpha
    return (a ?? 1.0) > 0.001
  }

  /**
   * Processes a PCM audio buffer.
   * @param chunk - PCM audio chunk.
   * @returns The processed PCM audio chunk.
   */
  public override process(chunk: Buffer): Buffer {
    super.processAnimation(SAMPLE_RATE, chunk.length, 2)

    if (this.alpha <= 0.001) {
      return chunk
    }

    const level = this.level
    const monoLevel = this.monoLevel
    if (!level && !monoLevel) return chunk

    const frames = chunk.length >> 2
    if (!frames) return chunk

    this._ensureBuffers(frames)
    const outLBuf = this._bufL
    const outRBuf = this._bufR

    if (!outLBuf || !outRBuf) return chunk

    const doFilter = !!(level && this.filterBand && this.filterWidth)

    const lp_b0 = this.lp_b0,
      lp_b1 = this.lp_b1,
      lp_b2 = this.lp_b2,
      lp_a1 = this.lp_a1,
      lp_a2 = this.lp_a2
    const hp_b0 = this.hp_b0,
      hp_b1 = this.hp_b1,
      hp_b2 = this.hp_b2,
      hp_a1 = this.hp_a1,
      hp_a2 = this.hp_a2

    let lpLx1 = this.lp_left_x1,
      lpLx2 = this.lp_left_x2,
      lpLy1 = this.lp_left_y1,
      lpLy2 = this.lp_left_y2
    let lpRx1 = this.lp_right_x1,
      lpRx2 = this.lp_right_x2,
      lpRy1 = this.lp_right_y1,
      lpRy2 = this.lp_right_y2
    let hpLx1 = this.hp_left_x1,
      hpLx2 = this.hp_left_x2,
      hpLy1 = this.hp_left_y1,
      hpLy2 = this.hp_left_y2
    let hpRx1 = this.hp_right_x1,
      hpRx2 = this.hp_right_x2,
      hpRy1 = this.hp_right_y1,
      hpRy2 = this.hp_right_y2

    let originalEnergy = 0
    let processedEnergy = 0

    for (let f = 0, bi = 0; f < frames; f++, bi += 4) {
      let left = chunk.readInt16LE(bi) * INV_16
      let right = chunk.readInt16LE(bi + 2) * INV_16

      originalEnergy += left * left + right * right

      if (monoLevel) {
        const mid = (left + right) * 0.5
        const sub = mid * monoLevel * this.alpha
        left -= sub
        right -= sub
      }

      if (doFilter) {
        const lowLeft =
          lp_b0 * left +
          lp_b1 * lpLx1 +
          lp_b2 * lpLx2 -
          lp_a1 * lpLy1 -
          lp_a2 * lpLy2
        lpLx2 = lpLx1
        lpLx1 = left
        lpLy2 = lpLy1
        lpLy1 = lowLeft

        const lowRight =
          lp_b0 * right +
          lp_b1 * lpRx1 +
          lp_b2 * lpRx2 -
          lp_a1 * lpRy1 -
          lp_a2 * lpRy2
        lpRx2 = lpRx1
        lpRx1 = right
        lpRy2 = lpRy1
        lpRy1 = lowRight

        const highLeft =
          hp_b0 * left +
          hp_b1 * hpLx1 +
          hp_b2 * hpLx2 -
          hp_a1 * hpLy1 -
          hp_a2 * hpLy2
        hpLx2 = hpLx1
        hpLx1 = left
        hpLy2 = hpLy1
        hpLy1 = highLeft

        const highRight =
          hp_b0 * right +
          hp_b1 * hpRx1 +
          hp_b2 * hpRx2 -
          hp_a1 * hpRy1 -
          hp_a2 * hpRy2
        hpRx2 = hpRx1
        hpRx1 = right
        hpRy2 = hpRy1
        hpRy1 = highRight

        const cancelled = highLeft - highRight
        const outHighL = highLeft + (cancelled * level - highLeft) * this.alpha
        const outHighR =
          highRight + (cancelled * level - highRight) * this.alpha

        left = lowLeft + outHighL
        right = lowRight + outHighR
      }

      outLBuf[f] = left
      outRBuf[f] = right
      processedEnergy += left * left + right * right
    }

    const denom = frames * 2
    originalEnergy /= denom
    processedEnergy /= denom

    let gain = 1
    if (processedEnergy > 1e-15) {
      gain = Math.sqrt(Math.max(1e-12, originalEnergy) / processedEnergy)
      if (gain > MAX_OUTPUT_GAIN) gain = MAX_OUTPUT_GAIN
    } else {
      gain = MAX_OUTPUT_GAIN
    }

    const prev = this._prevGain || MAX_OUTPUT_GAIN
    const smooth = gain > prev ? 0.06 : 0.3
    const target = prev + (gain - prev) * smooth
    let current = prev
    const step = (target - prev) / frames

    for (let f = 0, bi = 0; f < frames; f++, bi += 4) {
      current += step

      let outL = (outLBuf[f] ?? 0) * current
      let outR = (outRBuf[f] ?? 0) * current

      const peak = Math.max(Math.abs(outL), Math.abs(outR))
      if (peak > 0.9999) {
        const s = 0.9999 / peak
        outL *= s
        outR *= s
      }

      chunk.writeInt16LE(clamp16Bit(outL * SCALE_16), bi)
      chunk.writeInt16LE(clamp16Bit(outR * SCALE_16), bi + 2)
    }

    this.lp_left_x1 = lpLx1
    this.lp_left_x2 = lpLx2
    this.lp_left_y1 = lpLy1
    this.lp_left_y2 = lpLy2
    this.lp_right_x1 = lpRx1
    this.lp_right_x2 = lpRx2
    this.lp_right_y1 = lpRy1
    this.lp_right_y2 = lpRy2

    this.hp_left_x1 = hpLx1
    this.hp_left_x2 = hpLx2
    this.hp_left_y1 = hpLy1
    this.hp_left_y2 = hpLy2
    this.hp_right_x1 = hpRx1
    this.hp_right_x2 = hpRx2
    this.hp_right_y1 = hpRy1
    this.hp_right_y2 = hpRy2

    this._prevGain = target
    return chunk
  }

  /**
   * Clears the karaoke state.
   */
  public override flush(): Buffer {
    this._resetFilterState()
    this._prevGain = MAX_OUTPUT_GAIN
    return Buffer.alloc(0)
  }

  public destroy(): void {
    this._bufL = null
    this._bufR = null
  }
}
