import { SAMPLE_RATE } from '../../constants.ts'
import type { FilterSettings } from '../../typings/playback/filters.types.ts'
import { AnimatableFilter } from './AnimatableFilter.ts'
import { clamp16Bit } from './dsp/clamp16Bit.ts'
import LFO from './dsp/lfo.ts'

const CHANNELS = 2

/**
 * Rotates audio between left and right channels at a specific frequency.
 * Uses an alpha property for smooth fade-in/out transitions.
 * @public
 */
export default class Rotation extends AnimatableFilter {
  public priority = 10
  private lfo: LFO
  private rotationHz = 0
  private alpha = 0

  constructor() {
    super()
    this.lfo = new LFO('SINE')
  }

  /**
   * Updates the rotation settings.
   * @param settings - Filter settings containing `rotation`.
   */
  public override update(settings: FilterSettings): void {
    const r = settings?.rotation || {}
    const isDisabled = (r as Record<string, unknown>)._disabled === true

    this.rotationHz = r.rotationHz ?? 0
    if (this.rotationHz > 0.001) {
      this.lfo.update(this.rotationHz, 1)
    }

    const targetAlpha = isDisabled ? 0.0 : this.rotationHz > 0.001 ? 1.0 : 0.0

    super.applyAnimatedUpdate(
      {
        rotation: {
          alpha: targetAlpha,
          transition: r.transition
        }
      },
      'rotation',
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

    for (let i = 0; i < chunk.length; i += 4) {
      const lfoValue = this.lfo.getValue()

      const leftFactor = Math.sqrt((1 - lfoValue) / 2)
      const rightFactor = Math.sqrt((1 + lfoValue) / 2)

      const currentLeft = chunk.readInt16LE(i)
      const currentRight = chunk.readInt16LE(i + 2)

      const newLeft = currentLeft * (1 - alpha + alpha * leftFactor)
      const newRight = currentRight * (1 - alpha + alpha * rightFactor)

      chunk.writeInt16LE(clamp16Bit(newLeft), i)
      chunk.writeInt16LE(clamp16Bit(newRight), i + 2)
    }

    return chunk
  }

  /**
   * Flushes any pending data.
   * @returns An empty Buffer.
   */
  public override flush(): Buffer {
    this.lfo.phase = 0
    return Buffer.alloc(0)
  }
}
