import { SAMPLE_RATE } from '../../constants.ts'
import type { FilterSettings } from '../../typings/playback/filters.types.ts'
import { AnimatableFilter } from './AnimatableFilter.ts'
import { clamp16Bit } from './dsp/clamp16Bit.ts'
import LFO from './dsp/lfo.ts'

const CHANNELS = 2

/**
 * Applies a tremolo effect (amplitude modulation) using an LFO.
 * Uses alpha for smooth animated transitions.
 * @public
 */
export default class Tremolo extends AnimatableFilter {
  public priority = 10
  private lfo: LFO
  private targetFrequency = 0
  private targetDepth = 0
  private alpha = 0

  constructor() {
    super()
    this.lfo = new LFO('SINE')
  }

  /**
   * Updates the tremolo settings.
   * @param settings - Filter settings containing `tremolo`.
   */
  public override update(settings: FilterSettings): void {
    const t = settings?.tremolo || {}
    const isDisabled = (t as Record<string, unknown>)._disabled === true

    this.targetFrequency = t.frequency || 0
    this.targetDepth = Math.max(0, Math.min(t.depth || 0, 1.0))

    if (this.targetFrequency > 0 && this.targetDepth > 0) {
      this.lfo.update(this.targetFrequency, this.targetDepth)
    }

    const targetAlpha = isDisabled
      ? 0.0
      : this.targetFrequency > 0 && this.targetDepth > 0
        ? 1.0
        : 0.0

    super.applyAnimatedUpdate(
      {
        tremolo: {
          alpha: targetAlpha,
          transition: t.transition
        }
      },
      'tremolo',
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
      const sample = chunk.readInt16LE(i)
      const multiplier = this.lfo.process()

      const blendedMultiplier = 1.0 + alpha * (multiplier - 1.0)

      chunk.writeInt16LE(clamp16Bit(sample * blendedMultiplier), i)
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
