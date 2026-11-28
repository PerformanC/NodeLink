import { Transform, type TransformCallback } from 'node:stream'
import {
  AudioProcessingTelemetryAccumulator,
  type AudioProcessingTelemetrySnapshot
} from './audioContract.ts'
import { float32PcmToInt16Pcm, int16PcmToFloat32Pcm } from './float32Pcm.ts'
import { TruePeakLookaheadLimiter } from './TruePeakLookaheadLimiter.ts'

const F32_STEREO_FRAME_BYTES = 8

/** Converts decoded s16le stereo PCM to the Protected internal representation. */
export class ProtectedPcmInput extends Transform {
  constructor() {
    super({ readableHighWaterMark: 3840 * 2 })
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    try {
      if (chunk.length % 4 !== 0)
        throw new RangeError(
          'Protected PCM input must be complete stereo s16le frames'
        )
      this.push(int16PcmToFloat32Pcm(chunk))
      callback()
    } catch (error) {
      callback(error as Error)
    }
  }
}

/** Final Protected stage: limiter, then the single terminal Float32-to-Int16 conversion. */
export class ProtectedLimiterOutput extends Transform {
  private readonly limiter: TruePeakLookaheadLimiter
  private readonly telemetry = new AudioProcessingTelemetryAccumulator(100)
  private readonly requestedGain: () => number
  private destroyedOutput = false

  constructor(requestedGain: () => number) {
    super({ writableHighWaterMark: 3840 * 2, readableHighWaterMark: 3840 })
    this.requestedGain = requestedGain
    // A -2.5 dBTP input ceiling uses the worst +1.3 dB post-Opus rise observed
    // in the local synthetic/captured samples plus 0.2 dB reserve. This is an
    // empirical operating point, not a universal ceiling guarantee.
    this.limiter = new TruePeakLookaheadLimiter({
      sampleRate: 48000,
      channels: 2,
      oversampling: 4,
      lookaheadMs: 5,
      attackMs: 2,
      releaseMs: 80,
      ceilingDbTP: -2.4
    })
  }

  public snapshot(): AudioProcessingTelemetrySnapshot {
    return this.telemetry.snapshot()
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    try {
      if (chunk.length % F32_STEREO_FRAME_BYTES !== 0)
        throw new RangeError(
          'Protected limiter input must contain complete Float32 stereo frames'
        )
      const result = this.limiter.process(chunk)
      if (result.metrics.frames > 0) {
        const requested = this.requestedGain()
        this.telemetry.recordBlock({
          requested_gain: requested,
          applied_gain: requested * result.metrics.applied_gain,
          peak_gain_reduction_db: result.metrics.peak_gain_reduction_db,
          average_gain_reduction_db: result.metrics.average_gain_reduction_db,
          average_applied_gain: requested * result.metrics.average_applied_gain,
          duration_ms: result.metrics.duration_ms
        })
      }
      if (result.data.length) this.push(float32PcmToInt16Pcm(result.data))
      callback()
    } catch (error) {
      callback(error as Error)
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      const tail = this.limiter.flush()
      if (tail.data.length) this.push(float32PcmToInt16Pcm(tail.data))
      if (tail.metrics.frames > 0) {
        const requested = this.requestedGain()
        this.telemetry.recordBlock({
          requested_gain: requested,
          applied_gain: requested * tail.metrics.applied_gain,
          peak_gain_reduction_db: tail.metrics.peak_gain_reduction_db,
          average_gain_reduction_db: tail.metrics.average_gain_reduction_db,
          average_applied_gain: requested * tail.metrics.average_applied_gain,
          duration_ms: tail.metrics.duration_ms
        })
      }
      this.telemetry.flushPartialWindow()
      callback()
    } catch (error) {
      callback(error as Error)
    }
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void
  ): void {
    if (!this.destroyedOutput) {
      this.destroyedOutput = true
      this.limiter.destroy()
    }
    callback(error)
  }
}
