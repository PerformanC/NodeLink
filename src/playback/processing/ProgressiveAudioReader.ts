/**
 * @file ProgressiveAudioReader.ts
 * @package NodeLink
 * @organization PerformanC
 * @author PerformanC <https://github.com/PerformanC>
 * @license GPL-3.0-or-later
 * @copyright (C) 2026 PerformanC
 *
 * @description
 * Generic, source-agnostic Progressive Audio Reader for NodeLink AutoMix.
 * Acquires, normalizes, and streams PCM audio incrementally from any AnalysisStreamProvider
 * or playback tap without accumulating monolithic buffers in memory.
 *
 * Implements strict backpressure decoupling:
 * - Windowed streams (random/segmented): standard stream backpressure down to decoder/acquisition.
 * - Sequential taps (sequential): isolated bounded FIFO buffer with drop-on-overflow policy;
 *   NEVER slows down, pauses, or delays the primary audio playback pipeline.
 */

import { Readable, Transform, type TransformCallback } from 'node:stream'
import type { TrackInfoExtended } from '../../typings/playback/player.types.ts'
import {
  type AnalysisPcmFormat,
  type AnalysisStreamProvider,
  type AnalysisWindow,
  type AnalysisWindowStream,
  alignBytesToFrames,
  framesToMediaMs,
  type IPlaybackStreamTap,
  mediaMsToFrames,
  type ProgressivePcmChunk,
  type ProgressiveReaderOptions,
  type ProgressiveReadStats,
  STANDARD_ANALYSIS_PCM_FORMAT,
  type TapOverflowPolicy,
  type WindowedAnalysisStreamProvider
} from '../../typings/playback/progressiveAnalysis.types.ts'
import type { TrackInfo } from '../../typings/sources/source.types.ts'
import { float32PcmToInt16Pcm, int16PcmToFloat32Pcm } from './float32Pcm.ts'

/**
 * Transform stream that enforces frame boundary alignment and converts between
 * PCM representations (e.g. Float32LE <-> Int16LE) without dropping sub-frame data.
 */
export class PcmFramingTransform extends Transform {
  private remainder = Buffer.alloc(0)
  public readonly inputFormat: AnalysisPcmFormat
  public readonly targetFormat: AnalysisPcmFormat
  private readonly isDirectCopy: boolean
  private readonly isFloatToInt: boolean
  private readonly isIntToFloat: boolean

  private _totalBytesRead = 0
  private _totalFramesRead = 0

  public get totalBytesRead(): number {
    return this._totalBytesRead
  }

  public get totalFramesRead(): number {
    return this._totalFramesRead
  }

  constructor(
    inputFormat: AnalysisPcmFormat,
    targetFormat: AnalysisPcmFormat,
    highWaterMark = 65536
  ) {
    super({ highWaterMark })
    this.inputFormat = inputFormat
    this.targetFormat = targetFormat

    this.isDirectCopy =
      inputFormat.sampleFormat === targetFormat.sampleFormat &&
      inputFormat.channels === targetFormat.channels &&
      inputFormat.sampleRate === targetFormat.sampleRate

    this.isFloatToInt =
      inputFormat.sampleFormat === 'f32le' &&
      targetFormat.sampleFormat === 's16le'

    this.isIntToFloat =
      inputFormat.sampleFormat === 's16le' &&
      targetFormat.sampleFormat === 'f32le'
  }

  public override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    let data = chunk

    if (this.remainder.length > 0) {
      data = Buffer.concat([this.remainder, chunk])
      this.remainder = Buffer.alloc(0)
    }

    const alignedBytes = alignBytesToFrames(data.length, this.inputFormat)

    if (alignedBytes < data.length) {
      this.remainder = Buffer.from(data.subarray(alignedBytes))
      data = data.subarray(0, alignedBytes)
    }

    if (data.length === 0) {
      callback()
      return
    }

    const framesInChunk = data.length / this.inputFormat.bytesPerFrame
    this._totalBytesRead += data.length
    this._totalFramesRead += framesInChunk

    if (this.isDirectCopy) {
      this.push(data)
    } else if (this.isFloatToInt) {
      this.push(float32PcmToInt16Pcm(data))
    } else if (this.isIntToFloat) {
      this.push(int16PcmToFloat32Pcm(data))
    } else {
      this.push(data)
    }

    callback()
  }

  public override _flush(callback: TransformCallback): void {
    this.remainder = Buffer.alloc(0)
    callback()
  }
}

/**
 * Isolated, non-blocking audio tap for sequential playback streams.
 * Ensures the primary playback pipeline is never delayed when analysis is slow.
 */
export class PlaybackStreamTap extends Readable implements IPlaybackStreamTap {
  private _isAttached = true
  private _droppedBytes = 0
  private _totalBytesWritten = 0
  private currentFrame = 0
  private readonly maxQueueBytes: number
  private readonly policy: TapOverflowPolicy
  private readonly onOverflow?: (droppedBytes: number) => void

  public get isAttached(): boolean {
    return this._isAttached
  }

  public get droppedBytes(): number {
    return this._droppedBytes
  }

  public get totalBytesWritten(): number {
    return this._totalBytesWritten
  }

  constructor(
    maxQueueBytes = 65536,
    policy: TapOverflowPolicy = 'drop',
    onOverflow?: (droppedBytes: number) => void
  ) {
    super({ highWaterMark: maxQueueBytes })
    this.maxQueueBytes = maxQueueBytes
    this.policy = policy
    this.onOverflow = onOverflow
  }

  public override _read(): void {
    // Chunks are pushed synchronously in real-time by write()
  }

  /**
   * Synchronously accepts a chunk from the primary playback stream.
   * Runs in O(1) time and will never await, block, or pause the caller.
   *
   * @param chunk - Audio buffer chunk.
   * @param startFrame - Optional absolute starting frame offset within the track timeline.
   */
  public write(chunk: Buffer, startFrame?: number): void {
    if (!this._isAttached || chunk.length === 0) return

    // Absolute memory ceiling guard: discard chunks that individually exceed queue limit
    if (chunk.length > this.maxQueueBytes) {
      this._droppedBytes += chunk.length
      this.onOverflow?.(chunk.length)
      return
    }

    this._totalBytesWritten += chunk.length
    const frameIdx = startFrame ?? this.currentFrame

    if (this.readableLength + chunk.length > this.maxQueueBytes) {
      this._droppedBytes += chunk.length
      this.onOverflow?.(chunk.length)

      if (this.policy === 'abort') {
        this.detach()
        this.destroy(
          new Error('Tap buffer overflow: analysis consumer lagging')
        )
      }
      return
    }
    // Attach startFrame metadata to the Buffer instance without reallocation
    ;(chunk as unknown as { startFrame?: number }).startFrame = frameIdx
    this.currentFrame = frameIdx + Math.floor(chunk.length / 4)
    this.push(chunk)
  }

  /**
   * Detaches the tap from playback and signals end-of-stream.
   */
  public detach(): void {
    if (!this._isAttached) return
    this._isAttached = false
    this.push(null)
  }

  public override _destroy(
    error: Error | null,
    callback: (error: Error | null) => void
  ): void {
    this._isAttached = false
    callback(error)
  }
}

/**
 * Generic Progressive Audio Reader.
 * Coordinates acquisition, framing, format normalization, and backpressure isolation.
 */
export class ProgressiveAudioReader {
  private readonly provider: AnalysisStreamProvider
  private readonly targetFormat: AnalysisPcmFormat
  private readonly inputFormat: AnalysisPcmFormat
  private readonly highWaterMark: number
  private readonly tapQueueLimitBytes: number
  private readonly tapOverflowPolicy: TapOverflowPolicy
  private readonly onTapOverflow?: (droppedBytes: number) => void

  private activeFramingTransform: PcmFramingTransform | null = null
  private activeTap: PlaybackStreamTap | null = null
  private _activeSourceStream: Readable | null = null
  private _isAborted = false
  private _droppedBytes = 0
  private _initialStartFrame = 0

  public get sourceStream(): Readable | null {
    return this._activeSourceStream
  }

  public get isAborted(): boolean {
    return this._isAborted
  }

  public get initialStartFrame(): number {
    return this._initialStartFrame
  }

  constructor(
    provider: AnalysisStreamProvider,
    options: ProgressiveReaderOptions = {}
  ) {
    this.provider = provider
    this.targetFormat = options.targetFormat ?? STANDARD_ANALYSIS_PCM_FORMAT
    this.inputFormat = options.inputFormat ?? this.targetFormat
    this.highWaterMark = options.highWaterMark ?? 65536
    this.tapQueueLimitBytes = options.tapQueueLimitBytes ?? 65536
    this.tapOverflowPolicy = options.tapOverflowPolicy ?? 'drop'
    this.onTapOverflow = options.onTapOverflow
  }

  /**
   * Opens a progressive audio stream for the specified track.
   *
   * Automatically branches according to provider accessMode:
   * - `random` | `segmented`: requests independent analysis window from provider with backpressure.
   * - `sequential`: attaches to the provided playback tap with isolated FIFO buffering.
   * - `none`: immediately returns an empty, cleanly closed readable stream.
   *
   * @param track - Track information.
   * @param request - Window configuration (for windowed mode) or tap instance (for sequential mode).
   * @param additionalData - Source-specific metadata passed to provider.
   * @returns Progressive Readable delivering framed, normalized PCM chunks.
   */
  public async open(
    track: TrackInfo | TrackInfoExtended,
    request: {
      window?: AnalysisWindow
      tap?: IPlaybackStreamTap
      signal?: AbortSignal
      additionalData?: Record<string, unknown>
    } = {}
  ): Promise<Readable> {
    const accessMode = this.provider.capabilities.accessMode

    if (accessMode === 'none') {
      const empty = new Readable({
        read(): void {
          this.push(null)
        }
      })
      return empty
    }

    const signal = request.window?.signal ?? request.signal

    if (signal?.aborted) {
      this._isAborted = true
      const abortedStream = new Readable({
        read(): void {
          this.destroy(new Error('Operation aborted before start'))
        }
      })
      return abortedStream
    }

    const framing = new PcmFramingTransform(
      this.inputFormat,
      this.targetFormat,
      this.highWaterMark
    )
    this.activeFramingTransform = framing

    let rawStream: Readable

    if (accessMode === 'random' || accessMode === 'segmented') {
      if (!request.window) {
        throw new Error(
          `Provider requires an AnalysisWindow for accessMode '${accessMode}'`
        )
      }
      const windowedProvider = this.provider as WindowedAnalysisStreamProvider
      rawStream = await windowedProvider.openAnalysisWindow(
        track,
        request.window,
        request.additionalData
      )
    } else {
      let tap = request.tap as PlaybackStreamTap | undefined
      if (!tap) {
        tap = new PlaybackStreamTap(
          this.tapQueueLimitBytes,
          this.tapOverflowPolicy,
          (dropped) => {
            this._droppedBytes += dropped
            this.onTapOverflow?.(dropped)
          }
        )
      }
      this.activeTap = tap
      rawStream = tap
    }

    this._activeSourceStream = rawStream

    const windowStream = rawStream as AnalysisWindowStream
    const actualStartMs =
      windowStream.startMs ?? request.window?.startTimeMs ?? 0
    this._initialStartFrame =
      windowStream.startFrame ??
      mediaMsToFrames(actualStartMs, this.targetFormat.sampleRate)

    const cleanup = (error?: Error | null): void => {
      if (signal) {
        signal.removeEventListener('abort', onAbort)
      }
      if (this.activeTap) {
        this.activeTap.detach()
      }
      if (!rawStream.destroyed) {
        rawStream.destroy(error ?? undefined)
      }
      if (!framing.destroyed) {
        framing.destroy(error ?? undefined)
      }
    }

    const onAbort = (): void => {
      this._isAborted = true
      cleanup(new Error('Progressive reading aborted'))
    }

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    rawStream.on('error', (err) => {
      cleanup(err)
    })

    framing.on('error', (err) => {
      cleanup(err)
    })

    framing.on('close', () => {
      cleanup()
    })

    rawStream.pipe(framing)
    return framing
  }

  /**
   * Helper that converts the progressive readable stream into an AsyncIterable yielding PCM chunks.
   * Guarantees deterministic resource destruction on break or throw.
   *
   * @param stream - Readable stream returned by open().
   */
  public async *toAsyncIterable(stream: Readable): AsyncIterable<Buffer> {
    try {
      for await (const chunk of stream) {
        yield chunk as Buffer
      }
    } finally {
      if (!stream.destroyed) {
        stream.destroy()
      }
    }
  }

  /**
   * Helper that converts the progressive readable stream into an AsyncIterable of ProgressivePcmChunk
   * objects carrying exact absolute frame indices.
   *
   * @param stream - Readable stream returned by open().
   * @param initialStartFrame - Base frame offset for the stream (e.g. from window.startTimeMs).
   */
  public async *toProgressiveChunks(
    stream: Readable,
    initialStartFrame?: number
  ): AsyncIterable<ProgressivePcmChunk> {
    const bytesPerFrame = this.targetFormat.bytesPerFrame
    let nextExpectedFrame = initialStartFrame ?? this._initialStartFrame

    try {
      for await (const rawChunk of stream) {
        const chunk = rawChunk as Buffer & { startFrame?: number }
        const frameCount = Math.floor(chunk.length / bytesPerFrame)
        const startFrame =
          chunk.startFrame !== undefined ? chunk.startFrame : nextExpectedFrame

        yield {
          data: chunk,
          startFrame,
          frameCount
        }

        nextExpectedFrame = startFrame + frameCount
      }
    } finally {
      if (!stream.destroyed) {
        stream.destroy()
      }
    }
  }

  /**
   * Retrieves cumulative metrics for this reader session.
   */
  public getStats(): ProgressiveReadStats {
    const totalBytesRead = this.activeFramingTransform?.totalBytesRead ?? 0
    const totalFramesRead = this.activeFramingTransform?.totalFramesRead ?? 0
    const totalMediaMs = framesToMediaMs(
      totalFramesRead,
      this.targetFormat.sampleRate
    )

    return {
      totalBytesRead,
      totalFramesRead,
      totalMediaMs,
      droppedBytes: this._droppedBytes,
      isAborted: this._isAborted
    }
  }
}
