import { SAMPLE_RATE } from '../../constants.ts'
import type { FilterSettings } from '../../typings/playback/filters.types.ts'
import { AnimatableFilter } from './AnimatableFilter.ts'
import { clamp16Bit } from './dsp/clamp16Bit.ts'

const CHANNELS = 2

const BUTTERWORTH_Q = Math.SQRT1_2
const SUB_BLOCK_FRAMES = 64
const TWO_PI = 2 * Math.PI

export default class Highpass extends AnimatableFilter {
  public priority = 10

  private s1L = 0
  private s2L = 0
  private s1R = 0
  private s2R = 0

  private b0 = 1
  private b1 = 0
  private b2 = 0
  private a1 = 0
  private a2 = 0

  private _currentAlpha = 0

  public override update(settings: FilterSettings): void {
    const rawConfig = settings.highpass || {}
    const smoothing = rawConfig.smoothing ?? 0

    const targetAlpha =
      smoothing > 1.0
        ? Math.min(0.5, (0.5 * Math.log10(smoothing)) / Math.log10(1000))
        : 0.0

    super.applyAnimatedUpdate(
      {
        highpass: {
          targetAlpha: targetAlpha,
          transition: rawConfig.transition
        }
      },
      'highpass',
      { targetAlpha: 0.0 }
    )
  }

  protected override onConfigChanged(config: Record<string, number>): void {
    const alpha = config.targetAlpha ?? 0.0
    this._currentAlpha = alpha
    this._computeCoefficients(alpha)
  }

  protected override isConfigActive(config?: Record<string, number>): boolean {
    const alpha = config ? config.targetAlpha : this._currentAlpha
    return (alpha ?? 0) > 0.001
  }

  /**
   * Computes Butterworth biquad highpass coefficients from the animated alpha.
   * Maps alpha to cutoff: preserves the frequency correspondence of the old
   * 1-pole filter but upgrades to 12 dB/oct slope.
   *
   * The exact mapping: cutoff = -fs/(2π) × ln(1 − alpha)
   * This gives the same -3dB frequency as the old 1-pole at any alpha,
   * but the biquad's steeper slope makes the effect much more audible.
   */
  private _computeCoefficients(alpha: number): void {
    if (alpha <= 0.001) {
      this.b0 = 1
      this.b1 = 0
      this.b2 = 0
      this.a1 = 0
      this.a2 = 0
      return
    }

    const cutoff = Math.max(
      20,
      Math.min(
        23000,
        (-SAMPLE_RATE / TWO_PI) * Math.log(1 - Math.min(alpha, 0.499))
      )
    )

    const omega0 = (TWO_PI * cutoff) / SAMPLE_RATE
    const cos0 = Math.cos(omega0)
    const sin0 = Math.sin(omega0)
    const a = sin0 / (2 * BUTTERWORTH_Q)

    const a0inv = 1 / (1 + a)

    this.b0 = (1 + cos0) * 0.5 * a0inv
    this.b1 = -(1 + cos0) * a0inv
    this.b2 = this.b0
    this.a1 = -2 * cos0 * a0inv
    this.a2 = (1 - a) * a0inv
  }

  public override process(chunk: Buffer): Buffer {
    const startAlpha = this._currentAlpha

    super.processAnimation(SAMPLE_RATE, chunk.length, CHANNELS)

    const endAlpha = this._currentAlpha

    if (startAlpha <= 0.001 && endAlpha <= 0.001) {
      this.s1L = this.s2L = this.s1R = this.s2R = 0
      return chunk
    }

    const totalFrames = chunk.length >> 2
    const isAnimating = Math.abs(endAlpha - startAlpha) > 0.0001

    if (!isAnimating) {
      this._computeCoefficients(endAlpha)
      this._processBlock(chunk, 0, totalFrames)
    } else {
      let frameOffset = 0
      while (frameOffset < totalFrames) {
        const blockFrames = Math.min(
          SUB_BLOCK_FRAMES,
          totalFrames - frameOffset
        )
        const t = (frameOffset + blockFrames * 0.5) / totalFrames
        const interpolatedAlpha = startAlpha + (endAlpha - startAlpha) * t
        this._computeCoefficients(interpolatedAlpha)
        this._processBlock(chunk, frameOffset, blockFrames)
        frameOffset += blockFrames
      }
    }

    return chunk
  }

  /**
   * Processes a sub-block using current biquad coefficients.
   * Direct Form II Transposed with Float64 state.
   */
  private _processBlock(
    chunk: Buffer,
    frameOffset: number,
    frameCount: number
  ): void {
    const { b0, b1, b2, a1, a2 } = this
    let { s1L, s2L, s1R, s2R } = this

    let byteOffset = frameOffset << 2
    for (let f = 0; f < frameCount; f++, byteOffset += 4) {
      const xL = chunk.readInt16LE(byteOffset)
      const yL = b0 * xL + s1L
      s1L = b1 * xL - a1 * yL + s2L
      s2L = b2 * xL - a2 * yL
      chunk.writeInt16LE(clamp16Bit(yL), byteOffset)

      const xR = chunk.readInt16LE(byteOffset + 2)
      const yR = b0 * xR + s1R
      s1R = b1 * xR - a1 * yR + s2R
      s2R = b2 * xR - a2 * yR
      chunk.writeInt16LE(clamp16Bit(yR), byteOffset + 2)
    }

    this.s1L = s1L
    this.s2L = s2L
    this.s1R = s1R
    this.s2R = s2R
  }

  public override flush(): Buffer {
    this.s1L = this.s2L = this.s1R = this.s2R = 0
    this._currentAlpha = 0
    return Buffer.alloc(0)
  }
}
