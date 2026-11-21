import { SAMPLE_RATE } from '../../constants.ts'
import type { FilterSettings } from '../../typings/playback/filters.types.ts'
import { FLOAT32_HEADROOM_CAPABILITIES } from '../processing/audioContract.ts'
import { AnimatableFilter } from './AnimatableFilter.ts'
import { clamp16Bit } from './dsp/clamp16Bit.ts'
import LFO from './dsp/lfo.ts'

const CHANNELS = 2

export default class Tesseract extends AnimatableFilter {
  public override audioCapabilities = FLOAT32_HEADROOM_CAPABILITIES
  public priority = 11
  private lfoTheta: LFO
  private lfoPhi: LFO
  private lfoGamma: LFO
  private rotationHz = 0
  private alpha = 0

  private delaySamples = Math.floor(SAMPLE_RATE * 0.015)
  private delayBufferL = new Int16Array(this.delaySamples)
  private delayBufferR = new Int16Array(this.delaySamples)
  private delayFloatL: Float64Array | null = null
  private delayFloatR: Float64Array | null = null
  private delayIndex = 0

  constructor() {
    super()
    this.lfoTheta = new LFO('SINE')
    this.lfoPhi = new LFO('SINE')
    this.lfoGamma = new LFO('SINE')
  }

  public override update(settings: FilterSettings): void {
    const r = settings?.tesseract || {}
    const isDisabled = (r as Record<string, unknown>)._disabled === true

    this.rotationHz = r.rotationHz ?? 0
    if (this.rotationHz > 0.001) {
      this.lfoTheta.update(this.rotationHz, 1)
      this.lfoPhi.update(this.rotationHz * 1.33, 1)
      this.lfoGamma.update(this.rotationHz * 0.77, 1)
    }

    const targetAlpha = isDisabled ? 0.0 : this.rotationHz > 0.001 ? 1.0 : 0.0

    super.applyAnimatedUpdate(
      { tesseract: { alpha: targetAlpha } },
      'tesseract',
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

  public override process(chunk: Buffer): Buffer {
    super.processAnimation(SAMPLE_RATE, chunk.length, CHANNELS)

    if (this.alpha <= 0.001) {
      return chunk
    }

    const alpha = this.alpha

    for (let i = 0; i < chunk.length; i += 4) {
      const thetaVal = this.lfoTheta.getValue() * Math.PI
      const phiVal = this.lfoPhi.getValue() * Math.PI
      const gammaVal = this.lfoGamma.getValue() * Math.PI

      const sinTheta = Math.sin(thetaVal)
      const cosTheta = Math.cos(thetaVal)
      const sinPhi = Math.sin(phiVal)
      const cosPhi = Math.cos(phiVal)
      const sinGamma = Math.sin(gammaVal)
      const cosGamma = Math.cos(gammaVal)

      const L = chunk.readInt16LE(i)
      const R = chunk.readInt16LE(i + 2)

      const Y = this.delayBufferL[this.delayIndex] ?? 0
      const Z = this.delayBufferR[this.delayIndex] ?? 0

      this.delayBufferL[this.delayIndex] = L
      this.delayBufferR[this.delayIndex] = R
      this.delayIndex = (this.delayIndex + 1) % this.delaySamples

      const L_rot = L * cosTheta - Y * sinTheta
      const R_rot = R * cosPhi - Z * sinPhi

      const newLeft = L_rot * cosGamma - R_rot * sinGamma
      const newRight = L_rot * sinGamma + R_rot * cosGamma

      const finalLeft = L * (1 - alpha) + newLeft * alpha
      const finalRight = R * (1 - alpha) + newRight * alpha

      chunk.writeInt16LE(clamp16Bit(finalLeft), i)
      chunk.writeInt16LE(clamp16Bit(finalRight), i + 2)
    }

    return chunk
  }

  public processFloat32(chunk: Buffer): Buffer {
    if (chunk.length % 8 !== 0)
      throw new RangeError(
        'Tesseract Float32 input must contain complete stereo frames'
      )
    super.processAnimation(SAMPLE_RATE, chunk.length, CHANNELS, 'f32le')
    if (this.alpha <= 0.001) return chunk
    this.delayFloatL ??= new Float64Array(this.delaySamples)
    this.delayFloatR ??= new Float64Array(this.delaySamples)
    for (let i = 0; i < chunk.length; i += 8) {
      const theta = this.lfoTheta.getValue() * Math.PI
      const phi = this.lfoPhi.getValue() * Math.PI
      const gamma = this.lfoGamma.getValue() * Math.PI
      const left = chunk.readFloatLE(i),
        right = chunk.readFloatLE(i + 4)
      const y = this.delayFloatL[this.delayIndex] ?? 0
      const z = this.delayFloatR[this.delayIndex] ?? 0
      this.delayFloatL[this.delayIndex] = left
      this.delayFloatR[this.delayIndex] = right
      this.delayIndex = (this.delayIndex + 1) % this.delaySamples
      const lr = left * Math.cos(theta) - y * Math.sin(theta)
      const rr = right * Math.cos(phi) - z * Math.sin(phi)
      const outL = lr * Math.cos(gamma) - rr * Math.sin(gamma)
      const outR = lr * Math.sin(gamma) + rr * Math.cos(gamma)
      chunk.writeFloatLE(left * (1 - this.alpha) + outL * this.alpha, i)
      chunk.writeFloatLE(right * (1 - this.alpha) + outR * this.alpha, i + 4)
    }
    return chunk
  }

  public override flush(): Buffer {
    this.lfoTheta.phase = 0
    this.lfoPhi.phase = 0
    this.lfoGamma.phase = 0
    this.delayBufferL.fill(0)
    this.delayBufferR.fill(0)
    this.delayFloatL?.fill(0)
    this.delayFloatR?.fill(0)
    this.delayIndex = 0
    return Buffer.alloc(0)
  }
}
