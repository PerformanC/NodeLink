import { SAMPLE_RATE } from '../../constants.ts'
import type { FilterSettings } from '../../typings/playback/filters.types.ts'
import { AnimatableFilter } from './AnimatableFilter.ts'
import { clamp16Bit } from './dsp/clamp16Bit.ts'
import DelayLine from './dsp/delay.ts'
import LFO from './dsp/lfo.ts'

const CHANNELS = 2
const MAX_DELAY_MS = 20
const bufferSize = Math.ceil((SAMPLE_RATE * MAX_DELAY_MS) / 1000)

/**
 * Applies a vibrato effect (pitch modulation) using an LFO.
 * Uses alpha for smooth animated transitions.
 * @public
 */
export default class Vibrato extends AnimatableFilter {
  public priority = 10
  private lfo: LFO
  private leftDelay: DelayLine
  private rightDelay: DelayLine
  private targetFrequency = 0
  private targetDepth = 0
  private alpha = 0

  constructor() {
    super()
    this.lfo = new LFO('SINE')
    this.leftDelay = new DelayLine(bufferSize)
    this.rightDelay = new DelayLine(bufferSize)
  }

  /**
   * Updates the vibrato settings.
   * @param settings - Filter settings containing `vibrato`.
   */
  public override update(settings: FilterSettings): void {
    const v = settings?.vibrato || {}
    const isDisabled = (v as Record<string, unknown>)._disabled === true

    this.targetFrequency = v.frequency || 0
    this.targetDepth = Math.max(0, Math.min(v.depth ?? 0, 2.0))

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
        vibrato: {
          alpha: targetAlpha
        }
      },
      'vibrato',
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
    const maxDelayWidth = this.lfo.depth * (SAMPLE_RATE * 0.005)
    const centerDelay = maxDelayWidth

    for (let i = 0; i < chunk.length; i += 4) {
      const lfoValue = this.lfo.getValue()
      const delay = centerDelay + lfoValue * maxDelayWidth

      const leftSample = chunk.readInt16LE(i)
      this.leftDelay.write(leftSample)
      const delayedLeft = this.leftDelay.read(delay)

      const outLeft = leftSample + alpha * (delayedLeft - leftSample)
      chunk.writeInt16LE(clamp16Bit(outLeft), i)

      const rightSample = chunk.readInt16LE(i + 2)
      this.rightDelay.write(rightSample)
      const delayedRight = this.rightDelay.read(delay)

      const outRight = rightSample + alpha * (delayedRight - rightSample)
      chunk.writeInt16LE(clamp16Bit(outRight), i + 2)
    }

    return chunk
  }

  /**
   * Clears the vibrato state.
   */
  public override flush(): Buffer {
    this.leftDelay.clear()
    this.rightDelay.clear()
    this.lfo.phase = 0
    return Buffer.alloc(0)
  }

  public destroy(): void {
    this.leftDelay.destroy()
    this.rightDelay.destroy()
  }
}
