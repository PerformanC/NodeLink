import { SAMPLE_RATE } from '../../constants.ts'
import type {
  FilterSettings,
  PhonographSettings
} from '../../typings/playback/filters.types.ts'
import { AnimatableFilter } from './AnimatableFilter.ts'
import { clamp16Bit } from './dsp/clamp16Bit.ts'
import LFO from './dsp/lfo.ts'

const MAX_DELAY_MS = 60
const MAX_DELAY_SAMPLES = Math.ceil((SAMPLE_RATE * MAX_DELAY_MS) / 1000)

class XorShift32 {
  private s = 0x12345678 | 0
  constructor(seed = 0xc0ffee) {
    this.s = seed | 0
  }
  nextU32(): number {
    let x = this.s | 0
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    this.s = x | 0
    return x >>> 0
  }
  next01(): number {
    return this.nextU32() / 0x100000000
  }
  next11(): number {
    return this.next01() * 2 - 1
  }
  nextNoise(): number {
    return (this.next11() + this.next11() + this.next11()) / 3
  }
}

class InterpDelayLine {
  private buf: Float32Array
  private w = 0
  constructor(size: number) {
    this.buf = new Float32Array(size)
  }
  clear() {
    this.buf.fill(0)
    this.w = 0
  }
  destroy() {
    // biome-ignore lint/suspicious/noExplicitAny: intentional null to release buffer
    ;(this as any).buf = null
  }
  write(x: number) {
    this.buf[this.w] = x
    this.w = (this.w + 1) % this.buf.length
  }
  read(delaySamples: number): number {
    const n = this.buf.length
    let r = this.w - delaySamples
    while (r < 0) r += n
    while (r >= n) r -= n

    const i0 = r | 0
    const i1 = (i0 + 1) % n
    const frac = r - i0
    return (this.buf[i0] ?? 0) * (1 - frac) + (this.buf[i1] ?? 0) * frac
  }
}

class Biquad {
  private b0 = 1
  private b1 = 0
  private b2 = 0
  private a1 = 0
  private a2 = 0
  private z1 = 0
  private z2 = 0

  reset() {
    this.z1 = 0
    this.z2 = 0
  }

  setCoeffs(
    b0: number,
    b1: number,
    b2: number,
    a0: number,
    a1: number,
    a2: number
  ) {
    const invA0 = 1 / a0
    this.b0 = b0 * invA0
    this.b1 = b1 * invA0
    this.b2 = b2 * invA0
    this.a1 = a1 * invA0
    this.a2 = a2 * invA0
  }

  process(x: number): number {
    const y = this.b0 * x + this.z1
    this.z1 = this.b1 * x - this.a1 * y + this.z2
    this.z2 = this.b2 * x - this.a2 * y
    return y
  }

  static lowpass(fc: number, q: number, fs: number, out: Biquad) {
    const w0 = 2 * Math.PI * (fc / fs)
    const c = Math.cos(w0)
    const s = Math.sin(w0)
    const alpha = s / (2 * q)
    const b0 = (1 - c) / 2
    const b1 = 1 - c
    const b2 = (1 - c) / 2
    const a0 = 1 + alpha
    const a1 = -2 * c
    const a2 = 1 - alpha
    out.setCoeffs(b0, b1, b2, a0, a1, a2)
  }

  static highpass(fc: number, q: number, fs: number, out: Biquad) {
    const w0 = 2 * Math.PI * (fc / fs)
    const c = Math.cos(w0)
    const s = Math.sin(w0)
    const alpha = s / (2 * q)
    const b0 = (1 + c) / 2
    const b1 = -(1 + c)
    const b2 = (1 + c) / 2
    const a0 = 1 + alpha
    const a1 = -2 * c
    const a2 = 1 - alpha
    out.setCoeffs(b0, b1, b2, a0, a1, a2)
  }

  static peaking(
    fc: number,
    q: number,
    gainDb: number,
    fs: number,
    out: Biquad
  ) {
    const A = 10 ** (gainDb / 40)
    const w0 = 2 * Math.PI * (fc / fs)
    const c = Math.cos(w0)
    const s = Math.sin(w0)
    const alpha = s / (2 * q)
    const b0 = 1 + alpha * A
    const b1 = -2 * c
    const b2 = 1 - alpha * A
    const a0 = 1 + alpha / A
    const a1 = -2 * c
    const a2 = 1 - alpha / A
    out.setCoeffs(b0, b1, b2, a0, a1, a2)
  }
}

function softClip(x: number): number {
  const x2 = x * x
  return (x * (27 + x2)) / (27 + 9 * x2)
}

/**
 * Advanced simulation of an early 20th-century phonograph.
 * Includes biquad filtering, wow & flutter, early reflections, and mic AGC.
 * @public
 */
export default class Phonograph extends AnimatableFilter {
  public priority = 10

  private frequency = 0.8
  private depth = 0.25
  private crackle = 0.18
  private flutter = 0.18
  private room = 0.22
  private micAgc = 0.25
  private drive = 0.25

  private wowLfo = new LFO('SINE')
  private flutterLfo = new LFO('SINE')
  private drift = 0
  private delay = new InterpDelayLine(MAX_DELAY_SAMPLES)

  private hp1 = new Biquad()
  private hp2 = new Biquad()
  private lp1 = new Biquad()
  private lp2 = new Biquad()
  private peak1 = new Biquad()
  private peak2 = new Biquad()
  private hissHp = new Biquad()
  private hissLp = new Biquad()

  private r1 = new InterpDelayLine(Math.ceil(SAMPLE_RATE * 0.03))
  private r2 = new InterpDelayLine(Math.ceil(SAMPLE_RATE * 0.03))
  private r3 = new InterpDelayLine(Math.ceil(SAMPLE_RATE * 0.03))
  private roomDamp = 0

  private tickEnv = 0
  private tickAmp = 0
  private scratchEnv = 0
  private scratchAmp = 0
  private env = 0
  private agcGain = 1

  private rng = new XorShift32(0x1a2b3c4d)

  constructor() {
    super()
    this.recomputeFilters(1.0)
    this.wowLfo.update(this.frequency, 1)
    this.flutterLfo.update(7.5, 1)
  }

  private recomputeFilters(a: number) {
    const fs = SAMPLE_RATE
    const q = Math.SQRT1_2

    const hpFreq = 2 + (260 - 2) * a

    const lpFreq = 22000 - (22000 - 3300) * a

    Biquad.highpass(hpFreq, q, fs, this.hp1)
    Biquad.highpass(hpFreq, q, fs, this.hp2)
    Biquad.lowpass(lpFreq, q, fs, this.lp1)
    Biquad.lowpass(lpFreq, q, fs, this.lp2)
    Biquad.peaking(950, 1.1, 7.0 * a, fs, this.peak1)
    Biquad.peaking(2400, 1.6, 3.5 * a, fs, this.peak2)

    Biquad.highpass(1800, q, fs, this.hissHp)
    Biquad.lowpass(6500, q, fs, this.hissLp)
  }

  private targetDepth = 0.25
  private targetCrackle = 0.18
  private targetFlutter = 0.18
  private targetRoom = 0.22
  private targetMicAgc = 0.25
  private targetDrive = 0.25
  private alpha = 1.0

  public override update(settings: FilterSettings): void {
    const phono = (settings.phonograph as PhonographSettings) || {}
    const isDisabled = (phono as Record<string, unknown>)._disabled === true

    this.frequency = phono.frequency ?? 0.8
    this.targetDepth = Math.max(0, Math.min(phono.depth ?? 0.25, 1.0))
    this.targetCrackle = Math.max(0, Math.min(phono.crackle ?? 0.18, 1.0))
    this.targetFlutter = Math.max(0, Math.min(phono.flutter ?? 0.18, 1.0))
    this.targetRoom = Math.max(0, Math.min(phono.room ?? 0.22, 1.0))
    this.targetMicAgc = Math.max(0, Math.min(phono.micAgc ?? 0.25, 1.0))
    this.targetDrive = Math.max(0, Math.min(phono.drive ?? 0.25, 1.0))

    this.wowLfo.update(this.frequency, 1)

    this.flutterLfo.update(4.5, 0.45)

    const targetAlpha = isDisabled ? 0.0 : 1.0

    super.applyAnimatedUpdate(
      {
        phonograph: {
          alpha: targetAlpha
        }
      },
      'phonograph',
      { alpha: 0.0 }
    )
  }

  protected override onConfigChanged(config: Record<string, number>): void {
    this.alpha = config.alpha ?? 1.0

    this.depth = this.targetDepth * this.alpha
    this.crackle = this.targetCrackle * this.alpha
    this.flutter = this.targetFlutter * this.alpha
    this.room = this.targetRoom * this.alpha
    this.micAgc = this.targetMicAgc * this.alpha
    this.drive = this.targetDrive * this.alpha
  }

  protected override isConfigActive(config?: Record<string, number>): boolean {
    const a = config ? config.alpha : this.alpha
    return (a ?? 1.0) > 0.001
  }

  public override process(chunk: Buffer): Buffer {
    super.processAnimation(SAMPLE_RATE, chunk.length, 2)

    if (this.alpha <= 0.001) {
      return chunk
    }

    this.recomputeFilters(this.alpha)

    const fs = SAMPLE_RATE
    const wowMax = this.depth * 0.014 * fs
    const flutterMax = this.flutter * 0.0022 * fs
    const center = 1 + wowMax + flutterMax
    const driftAmount = this.depth * 0.0012 * fs
    const driftSmooth = 0.00015
    const hissGain = 0.01 * this.crackle
    const tickRate = 0.00002 * this.crackle
    const scratchRate = 0.0000025 * this.crackle
    const d1 = (7.5 / 1000) * fs
    const d2 = (12.0 / 1000) * fs
    const d3 = (17.5 / 1000) * fs
    const roomMix = 0.35 * this.room
    const agcOn = this.micAgc > 0
    const target = 0.22
    const atk = 0.006 + 0.01 * this.micAgc
    const rel = 0.0006 + 0.0012 * this.micAgc

    for (let i = 0; i < chunk.length; i += 4) {
      const l = chunk.readInt16LE(i)
      const r = chunk.readInt16LE(i + 2)
      let x = ((l + r) * 0.5) / 32768

      const dNoise = this.rng.nextNoise()
      this.drift += (dNoise * driftAmount - this.drift) * driftSmooth
      const wow = this.wowLfo.getValue()
      const flt = this.flutterLfo.getValue()
      let dly = center + wow * wowMax + flt * flutterMax + this.drift
      if (dly < 1) dly = 1
      if (dly > MAX_DELAY_SAMPLES - 2) dly = MAX_DELAY_SAMPLES - 2

      this.delay.write(x)
      x = this.delay.read(dly)

      if (this.drive > 0) {
        const g = 1 + this.drive * 6.0
        x = softClip(x * g) / softClip(g)
      }

      x = this.hp1.process(x)
      x = this.hp2.process(x)
      x = this.lp1.process(x)
      x = this.lp2.process(x)
      x = this.peak1.process(x)
      x = this.peak2.process(x)

      if (this.crackle > 0) {
        let n = this.rng.nextNoise()
        n = this.hissHp.process(n)
        n = this.hissLp.process(n)
        x += n * hissGain
        if (this.rng.next01() < tickRate) {
          this.tickEnv = 1
          this.tickAmp = this.rng.next11() * (0.45 + this.crackle)
        }
        this.tickEnv *= 0.965
        x += this.tickAmp * this.tickEnv * 0.18
        if (this.rng.next01() < scratchRate) {
          this.scratchEnv = 1
          this.scratchAmp = this.rng.next11() * (0.35 + this.crackle)
        }
        this.scratchEnv *= 0.992
        x += this.scratchAmp * this.scratchEnv * 0.06
      }

      if (this.room > 0) {
        this.roomDamp += 0.08 * (x - this.roomDamp)
        this.r1.write(this.roomDamp)
        this.r2.write(this.roomDamp)
        this.r3.write(this.roomDamp)
        const a = this.r1.read(d1)
        const b = this.r2.read(d2)
        const c = this.r3.read(d3)
        x = x * (1 - roomMix) + (a + b + c) * (roomMix / 3)
      }

      if (agcOn) {
        const ax = Math.abs(x)
        const coeff = ax > this.env ? atk : rel
        this.env += (ax - this.env) * coeff
        const desired = target / (this.env + 1e-6)
        this.agcGain += (desired - this.agcGain) * 0.0015
        const g = Math.max(0.35, Math.min(this.agcGain, 2.8))
        x *= g
      }

      const out = clamp16Bit((x * 32768) | 0)
      chunk.writeInt16LE(out, i)
      chunk.writeInt16LE(out, i + 2)
    }
    return chunk
  }

  public override flush(): Buffer {
    this.delay.clear()
    this.r1.clear()
    this.r2.clear()
    this.r3.clear()
    this.wowLfo.phase = 0
    this.flutterLfo.phase = 0
    this.drift = 0
    this.hp1.reset()
    this.hp2.reset()
    this.lp1.reset()
    this.lp2.reset()
    this.peak1.reset()
    this.peak2.reset()
    this.hissHp.reset()
    this.hissLp.reset()
    this.tickEnv = 0
    this.tickAmp = 0
    this.scratchEnv = 0
    this.scratchAmp = 0
    this.roomDamp = 0
    this.env = 0
    this.agcGain = 1
    return Buffer.alloc(0)
  }

  public destroy(): void {
    this.delay.destroy()
    this.r1.destroy()
    this.r2.destroy()
    this.r3.destroy()
  }
}
