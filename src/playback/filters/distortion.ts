import { SAMPLE_RATE } from '../../constants.ts'
import type { FilterSettings } from '../../typings/playback/filters.types.ts'
import { AnimatableFilter } from './AnimatableFilter.ts'
import { clamp16Bit } from './dsp/clamp16Bit.ts'

const CHANNELS = 2

/**
 * Applies various distortion effects (sin, cos, tan, etc.).
 * Uses alpha for smooth animated transitions.
 * @public
 */
export default class Distortion extends AnimatableFilter {
  public priority = 10
  private sinOffset = 0
  private sinScale = 1
  private cosOffset = 0
  private cosScale = 1
  private tanOffset = 0
  private tanScale = 1
  private offset = 0
  private scale = 1
  private alpha = 0

  /**
   * Updates the distortion settings.
   * @param settings - Filter settings containing `distortion`.
   */
  public override update(settings: FilterSettings): void {
    const dist = settings?.distortion || {}
    const isDisabled = (dist as Record<string, unknown>)._disabled === true

    this.sinOffset = dist.sinOffset ?? 0
    this.sinScale = dist.sinScale ?? 1
    this.cosOffset = dist.cosOffset ?? 0
    this.cosScale = dist.cosScale ?? 1
    this.tanOffset = dist.tanOffset ?? 0
    this.tanScale = dist.tanScale ?? 1
    this.offset = dist.offset ?? 0
    this.scale = dist.scale ?? 1

    const isActive = !(
      this.sinOffset === 0 &&
      this.sinScale === 1 &&
      this.cosOffset === 0 &&
      this.cosScale === 1 &&
      this.tanOffset === 0 &&
      this.tanScale === 1 &&
      this.offset === 0 &&
      this.scale === 1
    )

    const targetAlpha = isDisabled ? 0.0 : isActive ? 1.0 : 0.0

    super.applyAnimatedUpdate(
      {
        distortion: {
          alpha: targetAlpha,
          transition: dist.transition
        }
      },
      'distortion',
      { alpha: 0.0 }
    )
  }

  protected override onConfigChanged(config: Record<string, number>): void {
    this.alpha = config.alpha ?? 0
  }

  protected override isConfigActive(config?: Record<string, number>): boolean {
    const a = config ? config.alpha : this.alpha
    return (a ?? 0) > 0.001
  }

  /**
   * Processes a PCM audio buffer.
   * @param chunk - PCM audio chunk.
   * @returns The processed PCM audio chunk.
   */
  public override process(chunk: Buffer): Buffer {
    super.processAnimation(SAMPLE_RATE, chunk.length, CHANNELS)

    if (this.alpha <= 0.001) {
      return chunk
    }

    const alpha = this.alpha

    for (let i = 0; i < chunk.length; i += 2) {
      const sample = chunk.readInt16LE(i) / 32768

      let processed =
        Math.sin(sample * this.sinScale + this.sinOffset) +
        Math.cos(sample * this.cosScale + this.cosOffset) +
        Math.tan(sample * this.tanScale + this.tanOffset) +
        (sample * this.scale + this.offset)

      processed = Math.max(-1, Math.min(1, processed))

      const out = sample + alpha * (processed - sample)

      chunk.writeInt16LE(clamp16Bit(out * 32768), i)
    }

    return chunk
  }

  /**
   * Flushes any pending data.
   * @returns An empty Buffer.
   */
  public override flush(): Buffer {
    return Buffer.alloc(0)
  }
}
