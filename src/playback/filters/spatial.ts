import { SAMPLE_RATE } from '../../constants.ts'
import type { FilterSettings } from '../../typings/playback/filters.types.ts'
import { FLOAT32_HEADROOM_CAPABILITIES } from '../processing/audioContract.ts'
import { AnimatableFilter } from './AnimatableFilter.ts'
import { clamp16Bit } from './dsp/clamp16Bit.ts'
import DelayLine from './dsp/delay.ts'
import { Float64DelayLine } from './dsp/float64Delay.ts'
import LFO from './dsp/lfo.ts'

const CHANNELS = 2
const MAX_DELAY_MS = 30
const bufferSize = Math.ceil((SAMPLE_RATE * MAX_DELAY_MS) / 1000)

/**
 * Applies a spatial audio effect through cross-channel delay and modulation.
 * Uses alpha for smooth animated transitions.
 * @public
 */
export default class Spatial extends AnimatableFilter {
  public override audioCapabilities = FLOAT32_HEADROOM_CAPABILITIES
  public priority = 10
  private leftDelay: DelayLine
  private rightDelay: DelayLine
  private leftDelayFloat: Float64DelayLine | null = null
  private rightDelayFloat: Float64DelayLine | null = null
  private lfo: LFO
  private depth = 0
  private rate = 0
  private alpha = 0

  constructor() {
    super()
    this.leftDelay = new DelayLine(bufferSize)
    this.rightDelay = new DelayLine(bufferSize)
    this.lfo = new LFO('SINE')
  }

  /**
   * Updates the spatial settings.
   * @param settings - Filter settings containing `spatial`.
   */
  public override update(settings: FilterSettings): void {
    const s = settings?.spatial || {}
    const isDisabled = (s as Record<string, unknown>)._disabled === true

    this.depth = Math.max(0, Math.min(s.depth || 0, 1.0))
    this.rate = s.rate || 0

    this.lfo.update(this.rate, 1.0)

    const isActive = this.depth > 0
    const targetAlpha = isDisabled ? 0.0 : isActive ? 1.0 : 0.0

    super.applyAnimatedUpdate(
      {
        spatial: {
          alpha: targetAlpha,
          transition: s.transition
        }
      },
      'spatial',
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
    const wet = this.depth * 0.5
    const dry = 1.0 - wet
    const feedback = -0.3

    for (let i = 0; i < chunk.length; i += 4) {
      const leftSample = chunk.readInt16LE(i)
      const rightSample = chunk.readInt16LE(i + 2)

      const lfoValue = this.lfo.getValue()

      const delayTimeL = (5 + lfoValue * 2) * (SAMPLE_RATE / 1000)
      const delayTimeR = (5 - lfoValue * 2) * (SAMPLE_RATE / 1000)

      const delayedLeft = this.leftDelay.read(delayTimeL)
      const delayedRight = this.rightDelay.read(delayTimeR)

      this.leftDelay.write(clamp16Bit(leftSample + delayedLeft * feedback))
      this.rightDelay.write(clamp16Bit(rightSample + delayedRight * feedback))

      const spatialLeft = leftSample * dry + delayedRight * wet
      const spatialRight = rightSample * dry + delayedLeft * wet

      const newLeft = leftSample + alpha * (spatialLeft - leftSample)
      const newRight = rightSample + alpha * (spatialRight - rightSample)

      chunk.writeInt16LE(clamp16Bit(newLeft), i)
      chunk.writeInt16LE(clamp16Bit(newRight), i + 2)
    }

    return chunk
  }

  public processFloat32(chunk: Buffer): Buffer {
    if (chunk.length % 8 !== 0)
      throw new RangeError(
        'Spatial Float32 input must contain complete stereo frames'
      )
    super.processAnimation(SAMPLE_RATE, chunk.length, CHANNELS, 'f32le')
    if (this.alpha <= 0.001) return chunk
    this.leftDelayFloat ??= new Float64DelayLine(bufferSize)
    this.rightDelayFloat ??= new Float64DelayLine(bufferSize)
    const wet = this.depth * 0.5
    const dry = 1 - wet
    for (let i = 0; i < chunk.length; i += 8) {
      const left = chunk.readFloatLE(i)
      const right = chunk.readFloatLE(i + 4)
      const lfoValue = this.lfo.getValue()
      const delayedLeft = this.leftDelayFloat.read(
        (5 + lfoValue * 2) * (SAMPLE_RATE / 1000)
      )
      const delayedRight = this.rightDelayFloat.read(
        (5 - lfoValue * 2) * (SAMPLE_RATE / 1000)
      )
      this.leftDelayFloat.write(left + delayedLeft * -0.3)
      this.rightDelayFloat.write(right + delayedRight * -0.3)
      chunk.writeFloatLE(
        left + this.alpha * (dry * left + wet * delayedRight - left),
        i
      )
      chunk.writeFloatLE(
        right + this.alpha * (dry * right + wet * delayedLeft - right),
        i + 4
      )
    }
    return chunk
  }

  /**
   * Clears the spatial state.
   */
  public override flush(): Buffer {
    this.leftDelay.clear()
    this.rightDelay.clear()
    this.leftDelayFloat?.clear()
    this.rightDelayFloat?.clear()

    return Buffer.alloc(0)
  }

  public destroy(): void {
    this.leftDelay.destroy()
    this.rightDelay.destroy()
    this.leftDelayFloat?.destroy()
    this.rightDelayFloat?.destroy()
  }
}
