import { Buffer } from 'node:buffer'
import { Transform, type TransformCallback } from 'node:stream'

type FadeCurve = 'linear' | 'exponential' | 'sinusoidal'

const SUPPORTED_CURVES = new Set<FadeCurve>([
  'linear',
  'exponential',
  'sinusoidal'
])
const DEFAULT_CURVE: FadeCurve = 'sinusoidal'

interface TapeState {
  startRate: number
  targetRate: number
  durationMs: number
  elapsedMs: number
  curve: FadeCurve
  completed?: boolean
}

/**
 * Resampling audio transformer that implements tape-like start/stop effects.
 * Uses Cubic Hermite Spline interpolation for high-quality pitch/speed shifting.
 */
export class TapeTransformer extends Transform {
  private readonly sampleRate: number
  private readonly channels: number
  private currentRate = 1.0
  private tape: TapeState | null = null
  private _lastRampCompleted = false

  private inputBuffer: Float32Array | null = null
  private inputReadPos = 0
  private inputWritePos = 0
  private readonly maxBufferSize: number

  constructor(options: { sampleRate?: number; channels?: number } = {}) {
    super()
    this.sampleRate = options.sampleRate ?? 48000
    this.channels = options.channels ?? 2

    this.maxBufferSize = this.sampleRate * this.channels * 10
  }

  public setRate(rate: number): void {
    this.currentRate = Math.max(0.01, Math.min(2.0, rate))
    this.tape = null
    this._lastRampCompleted = false
  }

  public tapeTo(
    durationMs: number,
    type: 'start' | 'stop',
    curve: string = DEFAULT_CURVE
  ): void {
    const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0
    this._lastRampCompleted = false

    if (duration > 0) this._ensureInputBuffer()

    if (type === 'start' && this.inputWritePos > 0) {
      const latencySamples = 1024 * this.channels
      this.inputReadPos = Math.max(0, this.inputWritePos - latencySamples)
    }

    if (duration === 0) {
      this.currentRate = type === 'start' ? 1.0 : 0.01
      this.tape = null
      return
    }

    this.tape = {
      startRate: this.currentRate,
      targetRate: type === 'start' ? 1.0 : 0.01,
      durationMs: duration,
      elapsedMs: 0,
      curve: (SUPPORTED_CURVES.has(curve as FadeCurve)
        ? curve
        : DEFAULT_CURVE) as FadeCurve
    }
  }

  public isActive(): boolean {
    return (
      this.tape !== null ||
      Math.abs(this.currentRate - 1.0) > 0.001 ||
      this.inputWritePos > this.inputReadPos + this.channels
    )
  }

  public checkRampCompleted(): boolean {
    if (this._lastRampCompleted) {
      this._lastRampCompleted = false
      return true
    }
    return false
  }

  public getRate(): number {
    return this.currentRate
  }

  private _ensureInputBuffer(): Float32Array {
    if (!this.inputBuffer) {
      this.inputBuffer = new Float32Array(this.maxBufferSize)
      this.inputReadPos = 0
      this.inputWritePos = 0
    }

    return this.inputBuffer
  }

  private _getCurveValue(t: number, curve: FadeCurve): number {
    switch (curve) {
      case 'linear':
        return t
      case 'exponential':
        return t * t
      case 'sinusoidal':
        return (1 - Math.cos(t * Math.PI)) / 2
      default:
        return t
    }
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    if (chunk.length === 0) {
      callback()
      return
    }

    const output = this.process(chunk)
    this.push(output)
    callback()
  }

  public process(chunk: Buffer): Buffer {
    return this._process(chunk, false)
  }

  /** Float32 resampling path used by the Protected flow; output keeps headroom. */
  public processFloat32(chunk: Buffer): Buffer {
    return this._process(chunk, true)
  }

  private _process(chunk: Buffer, float32: boolean): Buffer {
    if (chunk.length === 0) return chunk
    if (
      !this.tape &&
      Math.abs(this.currentRate - 1.0) <= 0.001 &&
      this.inputWritePos <= this.inputReadPos + this.channels
    ) {
      return chunk
    }

    const bytesPerSample = float32 ? 4 : 2
    const incomingSamples = chunk.length / bytesPerSample
    const incomingFrames = incomingSamples / this.channels
    const inputBuffer = this._ensureInputBuffer()

    if (this.inputWritePos + incomingSamples > this.maxBufferSize) {
      this._compact()
      if (this.inputWritePos + incomingSamples > this.maxBufferSize) {
        const samplesToDrop =
          Math.ceil(incomingSamples / this.channels) * this.channels
        this.inputReadPos += samplesToDrop
        this._compact()
      }
    }

    for (let i = 0; i < incomingSamples; i++) {
      inputBuffer[this.inputWritePos++] = float32
        ? chunk.readFloatLE(i * bytesPerSample)
        : chunk.readInt16LE(i * bytesPerSample) / 32767
    }

    const out = float32
      ? Buffer.allocUnsafe(incomingSamples * 4)
      : new Int16Array(incomingSamples)
    const sampleDurationMs = 1000 / this.sampleRate

    for (let f = 0; f < incomingFrames; f++) {
      if (this.tape) {
        this.tape.elapsedMs += sampleDurationMs
        const t = Math.min(1.0, this.tape.elapsedMs / this.tape.durationMs)
        const curveT = this._getCurveValue(t, this.tape.curve)
        this.currentRate =
          this.tape.startRate +
          (this.tape.targetRate - this.tape.startRate) * curveT

        if (t >= 1.0) {
          this.currentRate = this.tape.targetRate
          this.tape = null
          this._lastRampCompleted = true
        }
      }

      const iPos = Math.floor(this.inputReadPos / this.channels) * this.channels
      if (iPos + this.channels * 3 >= this.inputWritePos) break

      const frac = (this.inputReadPos - iPos) / this.channels

      for (let c = 0; c < this.channels; c++) {
        const p0 =
          inputBuffer[iPos - this.channels + c] ?? inputBuffer[iPos + c] ?? 0
        const p1 = inputBuffer[iPos + c] ?? 0
        const p2 = inputBuffer[iPos + this.channels + c] ?? 0
        const p3 = inputBuffer[iPos + this.channels * 2 + c] ?? 0

        const val =
          0.5 *
          (2 * p1 +
            (-p0 + p2) * frac +
            (2 * p0 - 5 * p1 + 4 * p2 - p3) * frac * frac +
            (-p0 + 3 * p1 - 3 * p2 + p3) * frac * frac * frac)

        const sampleIndex = f * this.channels + c
        if (float32) (out as Buffer).writeFloatLE(val, sampleIndex * 4)
        else {
          ;(out as Int16Array)[sampleIndex] = Math.max(
            -32768,
            Math.min(32767, Math.round(val * 32767))
          )
        }
      }

      this.inputReadPos += this.currentRate * this.channels
    }

    if (this.inputReadPos > this.sampleRate * this.channels * 2) {
      this._compact()
    }

    return float32
      ? (out as Buffer)
      : Buffer.from(
          (out as Int16Array).buffer,
          (out as Int16Array).byteOffset,
          (out as Int16Array).byteLength
        )
  }

  override _destroy(
    _err: Error | null,
    cb: (error?: Error | null) => void
  ): void {
    this.inputBuffer = null
    this.tape = null
    cb(null)
  }

  private _compact(): void {
    if (!this.inputBuffer) return

    const integralReadPos =
      Math.floor(this.inputReadPos / this.channels) * this.channels
    const fractionalReadPos = this.inputReadPos - integralReadPos

    if (integralReadPos <= 0) return

    const remaining = this.inputWritePos - integralReadPos
    if (remaining > 0) {
      this.inputBuffer.copyWithin(0, integralReadPos, this.inputWritePos)
    }

    this.inputReadPos = fractionalReadPos
    this.inputWritePos = Math.max(0, remaining)
  }
}
