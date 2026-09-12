import { SAMPLE_RATE } from '../../constants.ts'
import type { FilterSettings } from '../../typings/playback/filters.types.ts'
import { AnimatableFilter } from './AnimatableFilter.ts'
import { clamp16Bit } from './dsp/clamp16Bit.ts'

const CHANNELS = 2

const BANDS = [
  25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000,
  16000
]

interface BiquadFilter {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
  x1: number
  x2: number
  y1: number
  y2: number
}

/**
 * Multi-band biquad equalizer filter.
 * Supports smooth per-band animation.
 * @public
 */
export default class Equalizer extends AnimatableFilter {
  public priority = 5
  private bandGains: number[]
  private filtersL: BiquadFilter[]
  private filtersR: BiquadFilter[]
  private activeBandIndices: number[]

  constructor() {
    super()
    this.bandGains = new Array(BANDS.length).fill(1.0)
    this.filtersL = BANDS.map((freq) => this._createFilter(freq))
    this.filtersR = BANDS.map((freq) => this._createFilter(freq))
    this.activeBandIndices = []
  }

  private _createFilter(freq: number): BiquadFilter {
    const omega = (2 * Math.PI * freq) / SAMPLE_RATE
    const sin = Math.sin(omega)
    const cos = Math.cos(omega)
    const alpha = sin / (2 * 1)

    const a0 = 1 + alpha
    return {
      b0: alpha / a0,
      b1: 0,
      b2: -alpha / a0,
      a1: (-2 * cos) / a0,
      a2: (1 - alpha) / a0,
      x1: 0,
      x2: 0,
      y1: 0,
      y2: 0
    }
  }

  public override update(settings: FilterSettings): void {
    const eq = settings.equalizer || {}
    const bands = eq.bands || []

    const defaults: Record<string, number> = {}
    for (let i = 0; i < BANDS.length; i++) {
      defaults[`band_${i}`] = 1.0
    }

    const mappedConfig: Record<string, unknown> = { transition: eq.transition }
    for (const band of bands) {
      if (band.band >= 0 && band.band < BANDS.length) {
        mappedConfig[`band_${band.band}`] = Math.max(
          0,
          Math.min(band.gain + 1.0, 2.0)
        )
      }
    }

    super.applyAnimatedUpdate(
      { equalizer: mappedConfig },
      'equalizer',
      defaults
    )
  }

  protected override onConfigChanged(config: Record<string, number>): void {
    for (let i = 0; i < BANDS.length; i++) {
      const val = config[`band_${i}`]
      if (val !== undefined) this.bandGains[i] = val
    }

    const activeIndices: number[] = []
    for (let i = 0; i < BANDS.length; i++) {
      const freq = BANDS[i]
      const gain = this.bandGains[i]
      const filterL = this.filtersL[i]
      const filterR = this.filtersR[i]

      if (freq === undefined || gain === undefined || !filterL || !filterR)
        continue

      // Unity-gain bands have H(z) = 1 (passthrough); track them so
      // process() can skip them entirely instead of running 15 biquads
      // per sample when only 1-2 bands are boosted/cut.
      if (Math.abs(gain - 1.0) <= 0.001) continue
      activeIndices.push(i)

      const omega = (2 * Math.PI * freq) / SAMPLE_RATE
      const sin = Math.sin(omega)
      const cos = Math.cos(omega)
      const alpha = sin / (2 * 1)
      const A = Math.sqrt(gain)

      const b0 = (1 + alpha * A) / (1 + alpha / A)
      const b1 = (-2 * cos) / (1 + alpha / A)
      const b2 = (1 - alpha * A) / (1 + alpha / A)
      const a1 = (-2 * cos) / (1 + alpha / A)
      const a2 = (1 - alpha / A) / (1 + alpha / A)

      filterL.b0 = b0
      filterL.b1 = b1
      filterL.b2 = b2
      filterL.a1 = a1
      filterL.a2 = a2

      filterR.b0 = b0
      filterR.b1 = b1
      filterR.b2 = b2
      filterR.a1 = a1
      filterR.a2 = a2
    }
    this.activeBandIndices = activeIndices
  }

  protected override isConfigActive(config?: Record<string, number>): boolean {
    if (config) {
      for (let i = 0; i < BANDS.length; i++) {
        if (Math.abs((config[`band_${i}`] ?? 1.0) - 1.0) > 0.001) return true
      }
      return false
    }

    for (const gain of this.bandGains) {
      if (Math.abs(gain - 1.0) > 0.001) return true
    }
    return false
  }

  public override process(chunk: Buffer): Buffer {
    super.processAnimation(SAMPLE_RATE, chunk.length, CHANNELS)

    const activeIndices = this.activeBandIndices
    if (activeIndices.length === 0) return chunk

    for (let i = 0; i < chunk.length; i += 4) {
      let left = chunk.readInt16LE(i)
      let right = chunk.readInt16LE(i + 2)

      for (let k = 0; k < activeIndices.length; k++) {
        const j = activeIndices[k] as number
        const fl = this.filtersL[j]
        const fr = this.filtersR[j]

        if (!fl || !fr) continue

        const outL =
          fl.b0 * left +
          fl.b1 * fl.x1 +
          fl.b2 * fl.x2 -
          fl.a1 * fl.y1 -
          fl.a2 * fl.y2
        fl.x2 = fl.x1
        fl.x1 = left
        fl.y2 = fl.y1
        fl.y1 = outL
        left = outL

        const outR =
          fr.b0 * right +
          fr.b1 * fr.x1 +
          fr.b2 * fr.x2 -
          fr.a1 * fr.y1 -
          fr.a2 * fr.y2
        fr.x2 = fr.x1
        fr.x1 = right
        fr.y2 = fr.y1
        fr.y1 = outR
        right = outR
      }

      chunk.writeInt16LE(clamp16Bit(left), i)
      chunk.writeInt16LE(clamp16Bit(right), i + 2)
    }

    return chunk
  }

  public override flush(): Buffer {
    for (const filter of this.filtersL) {
      filter.x1 = filter.x2 = filter.y1 = filter.y2 = 0
    }
    for (const filter of this.filtersR) {
      filter.x1 = filter.x2 = filter.y1 = filter.y2 = 0
    }
    return Buffer.alloc(0)
  }
}
