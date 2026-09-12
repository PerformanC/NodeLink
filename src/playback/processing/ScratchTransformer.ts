import { Buffer } from 'node:buffer'
import { Transform, type TransformCallback } from 'node:stream'

/**
 * Supported scratch movement styles.
 */
export type ScratchStyle =
  | 'wash'
  | 'backspin'
  | 'baby'
  | 'start'
  | 'stop'
  | 'random'

/**
 * Internal state for an active scratch effect.
 */
interface ScratchState {
  style: ScratchStyle
  durationMs: number
  elapsedMs: number
  startRate: number
  targetRate: number
  seed: number
}

/**
 * Resampling audio transformer that simulates physical vinyl scratching.
 *
 * Uses a circular Float32Array buffer to maintain audio history, allowing
 * for bidirectional playback (forward and reverse) without re-allocating memory.
 * This keeps RSS (Resident Set Size) stable and prevents GC pressure.
 *
 * @public
 */
export class ScratchTransformer extends Transform {
  private readonly sampleRate: number
  private readonly channels: number
  private currentRate = 1.0
  private state: ScratchState | null = null
  private _lastEffectCompleted = false

  /**
   * Internal circular buffer for storing PCM samples.
   * Storing as floats (0.0 to 1.0) simplifies resampling math.
   */
  private inputBuffer: Float32Array | null = null
  private inputReadPos = 0
  private inputWritePos = 0
  private readonly maxBufferSize: number

  /**
   * Creates a new ScratchTransformer instance.
   * @param options - Configuration options containing sample rate and channels.
   */
  constructor(options: { sampleRate?: number; channels?: number } = {}) {
    super()
    this.sampleRate = options.sampleRate ?? 48000
    this.channels = options.channels ?? 2

    this.maxBufferSize = this.sampleRate * this.channels * 5
  }

  /**
   * Triggers a scratch movement.
   * @param durationMs - Total time for the movement to complete.
   * @param style - The character of the scratch (e.g., 'backspin', 'wash').
   */
  public scratchTo(durationMs: number, style: ScratchStyle): void {
    const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 500
    this._lastEffectCompleted = false

    if (duration > 0) this._ensureInputBuffer()

    if (style === 'start' && this.inputWritePos > 0) {
      const latencySamples = 1024 * this.channels
      this.inputReadPos = Math.max(
        this.channels,
        this.inputWritePos - latencySamples
      )
    }

    if (duration === 0) {
      this.currentRate = style === 'start' ? 1.0 : 0.0
      this.state = null
      this._lastEffectCompleted = true
      return
    }

    this.state = {
      style,
      durationMs: duration,
      elapsedMs: 0,
      startRate: this.currentRate,
      targetRate: style === 'start' ? 1.0 : 0.0,
      seed: Math.random()
    }
  }

  /**
   * Returns true if a scratch effect is currently being applied.
   */
  public isActive(): boolean {
    return (
      this.state !== null ||
      Math.abs(this.currentRate - 1.0) > 0.001 ||
      this.inputWritePos > this.inputReadPos + this.channels
    )
  }

  /**
   * Checks if the last triggered ramp has finished.
   * Resets the internal flag upon calling.
   */
  public checkEffectCompleted(): boolean {
    if (this._lastEffectCompleted) {
      this._lastEffectCompleted = false
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

  /**
   * Core math for rate modulation. Simulates the physics of a DJ's hand.
   * @param t - Progress of the effect (0.0 to 1.0).
   * @param state - Current scratch configuration.
   * @returns The playback rate (can be negative for reverse).
   */
  private _calculateRate(t: number, state: ScratchState): number {
    const s = state.seed
    let style = state.style

    if (style === 'random') {
      style = state.targetRate > 0 ? 'start' : s > 0.5 ? 'backspin' : 'wash'
    }

    switch (style) {
      case 'wash':
        if (t < 0.6) return state.startRate * (1 - t / 0.6) ** 2.5

        return Math.sin((t - 0.6) * 25) * (0.4 + s * 0.2) * (1 - t)

      case 'backspin':
        if (t < 0.15) return state.startRate * (1 - t * 6.6)
        if (t < 0.8) return -3.0 - s * 5.0 * (1 - t)
        return -0.8 * (1 - t)

      case 'baby':
        return Math.cos(t * Math.PI * (5 + s * 3)) * (1 - t)

      case 'start':
        if (t < 0.5) return (t / 0.5) ** 2 * 1.5
        return 1.5 - ((t - 0.5) / 0.5) * 0.5

      case 'stop':
        return state.startRate * (1 - t ** 2.2)

      default:
        return 1 - t
    }
  }

  /**
   * Inherited transform method for stream processing.
   */
  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    if (chunk.length === 0) {
      callback()
      return
    }
    this.push(this.process(chunk))
    callback()
  }

  /**
   * Processes a PCM buffer and applies the current resampling rate.
   * @param chunk - Input buffer containing 16-bit LE PCM data.
   * @returns Resampled audio buffer.
   */
  public process(chunk: Buffer): Buffer {
    if (chunk.length === 0) return chunk
    if (
      !this.state &&
      Math.abs(this.currentRate - 1.0) <= 0.001 &&
      this.inputWritePos <= this.inputReadPos + this.channels
    ) {
      return chunk
    }

    const incomingSamples = chunk.length / 2
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
      inputBuffer[this.inputWritePos++] = chunk.readInt16LE(i * 2) / 32767
    }

    const outI16 = new Int16Array(incomingSamples)
    const frameDurationMs = 1000 / this.sampleRate

    const latencyFrames = 1024
    if (
      !this.state &&
      this.currentRate === 1.0 &&
      this.inputWritePos < latencyFrames * this.channels * 2
    ) {
      this.inputReadPos = 0
      return chunk
    }

    for (let f = 0; f < incomingFrames; f++) {
      if (this.state) {
        this.state.elapsedMs += frameDurationMs
        const t = Math.min(1.0, this.state.elapsedMs / this.state.durationMs)

        this.currentRate = this._calculateRate(t, this.state)

        if (t >= 1.0) {
          this.currentRate = this.state.targetRate
          this.state = null
          this._lastEffectCompleted = true
        }
      }

      const iPos = Math.floor(this.inputReadPos / this.channels) * this.channels

      const safeIPos = Math.max(
        this.channels,
        Math.min(this.inputWritePos - this.channels * 3, iPos)
      )
      const frac = (this.inputReadPos - iPos) / this.channels

      for (let c = 0; c < this.channels; c++) {
        const p0 = inputBuffer[safeIPos - this.channels + c] || 0
        const p1 = inputBuffer[safeIPos + c] || 0
        const p2 = inputBuffer[safeIPos + this.channels + c] || 0
        const p3 = inputBuffer[safeIPos + this.channels * 2 + c] || 0

        const val =
          0.5 *
          (2 * p1 +
            (-p0 + p2) * frac +
            (2 * p0 - 5 * p1 + 4 * p2 - p3) * frac * frac +
            (-p0 + 3 * p1 - 3 * p2 + p3) * frac * frac * frac)

        outI16[f * this.channels + c] = Math.max(
          -32768,
          Math.min(32767, Math.round(val * 32767))
        )
      }

      this.inputReadPos += this.currentRate * this.channels

      if (this.inputReadPos < this.channels) this.inputReadPos = this.channels
      if (this.inputReadPos >= this.inputWritePos)
        this.inputReadPos = this.inputWritePos - 1
    }

    return Buffer.from(outI16.buffer, outI16.byteOffset, outI16.byteLength)
  }

  /**
   * Shifts the circular buffer to free up space while preserving 1s of history.
   * This allows the "disk" to be pulled backwards immediately even at the start of a chunk.
   */
  private _compact(): void {
    if (!this.inputBuffer) return

    const historyFrames = this.sampleRate * 1
    const keepSamples = historyFrames * this.channels

    const integralReadPos =
      Math.floor(this.inputReadPos / this.channels) * this.channels
    const copyStart = Math.max(0, integralReadPos - keepSamples)

    if (copyStart <= 0) return

    const remaining = this.inputWritePos - copyStart
    this.inputBuffer.copyWithin(0, copyStart, this.inputWritePos)

    this.inputReadPos -= copyStart
    this.inputWritePos = remaining
  }

  override _destroy(
    _err: Error | null,
    cb: (error?: Error | null) => void
  ): void {
    this.inputBuffer = null
    this.state = null
    cb(null)
  }
}
