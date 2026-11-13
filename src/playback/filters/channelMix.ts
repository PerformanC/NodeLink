import { SAMPLE_RATE } from '../../constants.ts'
import type { FilterSettings } from '../../typings/playback/filters.types.ts'
import { FLOAT32_HEADROOM_CAPABILITIES } from '../processing/audioContract.ts'
import { AnimatableFilter } from './AnimatableFilter.ts'
import { clamp16Bit } from './dsp/clamp16Bit.ts'

const CHANNELS = 2

/**
 * Mixes audio channels based on configurable weights.
 * @public
 */
export default class ChannelMix extends AnimatableFilter {
  public priority = 10
  public override audioCapabilities = FLOAT32_HEADROOM_CAPABILITIES
  private leftToLeft = 1.0
  private leftToRight = 0.0
  private rightToLeft = 0.0
  private rightToRight = 1.0

  /**
   * Updates the channel weights.
   * @param settings - Filter settings containing `channelMix`.
   */
  public override update(settings: FilterSettings): void {
    super.applyAnimatedUpdate(settings, 'channelMix', {
      leftToLeft: 1.0,
      leftToRight: 0.0,
      rightToLeft: 0.0,
      rightToRight: 1.0
    })
  }

  protected override onConfigChanged(config: Record<string, number>): void {
    this.leftToLeft = Math.max(0.0, Math.min(1.0, config.leftToLeft ?? 1.0))
    this.leftToRight = Math.max(0.0, Math.min(1.0, config.leftToRight ?? 0.0))
    this.rightToLeft = Math.max(0.0, Math.min(1.0, config.rightToLeft ?? 0.0))
    this.rightToRight = Math.max(0.0, Math.min(1.0, config.rightToRight ?? 1.0))
  }

  protected override isConfigActive(): boolean {
    return (
      Math.abs(this.leftToLeft - 1.0) > 0.001 ||
      Math.abs(this.leftToRight - 0.0) > 0.001 ||
      Math.abs(this.rightToLeft - 0.0) > 0.001 ||
      Math.abs(this.rightToRight - 1.0) > 0.001
    )
  }

  /**
   * Processes a PCM audio buffer.
   * @param chunk - PCM audio chunk.
   * @returns The processed PCM audio chunk.
   */
  public override process(chunk: Buffer): Buffer {
    super.processAnimation(SAMPLE_RATE, chunk.length, CHANNELS)

    if (
      this.leftToLeft >= 0.999 &&
      this.leftToRight <= 0.001 &&
      this.rightToLeft <= 0.001 &&
      this.rightToRight >= 0.999
    ) {
      return chunk
    }

    for (let i = 0; i < chunk.length; i += 4) {
      const left = chunk.readInt16LE(i)
      const right = chunk.readInt16LE(i + 2)

      const newLeft = left * this.leftToLeft + right * this.rightToLeft
      const newRight = left * this.leftToRight + right * this.rightToRight

      chunk.writeInt16LE(clamp16Bit(newLeft), i)
      chunk.writeInt16LE(clamp16Bit(newRight), i + 2)
    }

    return chunk
  }

  public processFloat32(chunk: Buffer): Buffer {
    if (chunk.length % 8 !== 0)
      throw new RangeError(
        'ChannelMix Float32 input must contain complete stereo frames'
      )
    super.processAnimation(SAMPLE_RATE, chunk.length, CHANNELS, 'f32le')
    if (
      this.leftToLeft >= 0.999 &&
      this.leftToRight <= 0.001 &&
      this.rightToLeft <= 0.001 &&
      this.rightToRight >= 0.999
    )
      return chunk
    for (let i = 0; i < chunk.length; i += 8) {
      const left = chunk.readFloatLE(i)
      const right = chunk.readFloatLE(i + 4)
      chunk.writeFloatLE(left * this.leftToLeft + right * this.rightToLeft, i)
      chunk.writeFloatLE(
        left * this.leftToRight + right * this.rightToRight,
        i + 4
      )
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
