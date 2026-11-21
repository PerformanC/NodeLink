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
import { Readable, Transform } from 'node:stream';
import { alignBytesToFrames, framesToMediaMs, mediaMsToFrames, STANDARD_ANALYSIS_PCM_FORMAT } from '../../typings/playback/progressiveAnalysis.types.js';
import { float32PcmToInt16Pcm, int16PcmToFloat32Pcm } from './float32Pcm.js';
/**
 * Transform stream that enforces frame boundary alignment and converts between
 * PCM representations (e.g. Float32LE <-> Int16LE) without dropping sub-frame data.
 */
export class PcmFramingTransform extends Transform {
    remainder = Buffer.alloc(0);
    inputFormat;
    targetFormat;
    isDirectCopy;
    isFloatToInt;
    isIntToFloat;
    _totalBytesRead = 0;
    _totalFramesRead = 0;
    get totalBytesRead() {
        return this._totalBytesRead;
    }
    get totalFramesRead() {
        return this._totalFramesRead;
    }
    constructor(inputFormat, targetFormat, highWaterMark = 65536) {
        super({ highWaterMark });
        this.inputFormat = inputFormat;
        this.targetFormat = targetFormat;
        this.isDirectCopy =
            inputFormat.sampleFormat === targetFormat.sampleFormat &&
                inputFormat.channels === targetFormat.channels &&
                inputFormat.sampleRate === targetFormat.sampleRate;
        this.isFloatToInt =
            inputFormat.sampleFormat === 'f32le' &&
                targetFormat.sampleFormat === 's16le';
        this.isIntToFloat =
            inputFormat.sampleFormat === 's16le' &&
                targetFormat.sampleFormat === 'f32le';
    }
    _transform(chunk, _encoding, callback) {
        let data = chunk;
        if (this.remainder.length > 0) {
            data = Buffer.concat([this.remainder, chunk]);
            this.remainder = Buffer.alloc(0);
        }
        const alignedBytes = alignBytesToFrames(data.length, this.inputFormat);
        if (alignedBytes < data.length) {
            this.remainder = Buffer.from(data.subarray(alignedBytes));
            data = data.subarray(0, alignedBytes);
        }
        if (data.length === 0) {
            callback();
            return;
        }
        const framesInChunk = data.length / this.inputFormat.bytesPerFrame;
        this._totalBytesRead += data.length;
        this._totalFramesRead += framesInChunk;
        if (this.isDirectCopy) {
            this.push(data);
        }
        else if (this.isFloatToInt) {
            this.push(float32PcmToInt16Pcm(data));
        }
        else if (this.isIntToFloat) {
            this.push(int16PcmToFloat32Pcm(data));
        }
        else {
            this.push(data);
        }
        callback();
    }
    _flush(callback) {
        this.remainder = Buffer.alloc(0);
        callback();
    }
}
/**
 * Isolated, non-blocking audio tap for sequential playback streams.
 * Ensures the primary playback pipeline is never delayed when analysis is slow.
 */
export class PlaybackStreamTap extends Readable {
    _isAttached = true;
    _droppedBytes = 0;
    _totalBytesWritten = 0;
    currentFrame = 0;
    maxQueueBytes;
    policy;
    onOverflow;
    get isAttached() {
        return this._isAttached;
    }
    get droppedBytes() {
        return this._droppedBytes;
    }
    get totalBytesWritten() {
        return this._totalBytesWritten;
    }
    constructor(maxQueueBytes = 65536, policy = 'drop', onOverflow) {
        super({ highWaterMark: maxQueueBytes });
        this.maxQueueBytes = maxQueueBytes;
        this.policy = policy;
        this.onOverflow = onOverflow;
    }
    _read() {
        // Chunks are pushed synchronously in real-time by write()
    }
    /**
     * Synchronously accepts a chunk from the primary playback stream.
     * Runs in O(1) time and will never await, block, or pause the caller.
     *
     * @param chunk - Audio buffer chunk.
     * @param startFrame - Optional absolute starting frame offset within the track timeline.
     */
    write(chunk, startFrame) {
        if (!this._isAttached || chunk.length === 0)
            return;
        // Absolute memory ceiling guard: discard chunks that individually exceed queue limit
        if (chunk.length > this.maxQueueBytes) {
            this._droppedBytes += chunk.length;
            this.onOverflow?.(chunk.length);
            return;
        }
        this._totalBytesWritten += chunk.length;
        const frameIdx = startFrame ?? this.currentFrame;
        if (this.readableLength + chunk.length > this.maxQueueBytes) {
            this._droppedBytes += chunk.length;
            this.onOverflow?.(chunk.length);
            if (this.policy === 'abort') {
                this.detach();
                this.destroy(new Error('Tap buffer overflow: analysis consumer lagging'));
            }
            return;
        }
        // Attach startFrame metadata to the Buffer instance without reallocation
        ;
        chunk.startFrame = frameIdx;
        this.currentFrame = frameIdx + Math.floor(chunk.length / 4);
        this.push(chunk);
    }
    /**
     * Detaches the tap from playback and signals end-of-stream.
     */
    detach() {
        if (!this._isAttached)
            return;
        this._isAttached = false;
        this.push(null);
    }
    _destroy(error, callback) {
        this._isAttached = false;
        callback(error);
    }
}
/**
 * Generic Progressive Audio Reader.
 * Coordinates acquisition, framing, format normalization, and backpressure isolation.
 */
export class ProgressiveAudioReader {
    provider;
    targetFormat;
    inputFormat;
    highWaterMark;
    tapQueueLimitBytes;
    tapOverflowPolicy;
    onTapOverflow;
    activeFramingTransform = null;
    activeTap = null;
    _activeSourceStream = null;
    _isAborted = false;
    _droppedBytes = 0;
    _initialStartFrame = 0;
    get sourceStream() {
        return this._activeSourceStream;
    }
    get isAborted() {
        return this._isAborted;
    }
    get initialStartFrame() {
        return this._initialStartFrame;
    }
    constructor(provider, options = {}) {
        this.provider = provider;
        this.targetFormat = options.targetFormat ?? STANDARD_ANALYSIS_PCM_FORMAT;
        this.inputFormat = options.inputFormat ?? this.targetFormat;
        this.highWaterMark = options.highWaterMark ?? 65536;
        this.tapQueueLimitBytes = options.tapQueueLimitBytes ?? 65536;
        this.tapOverflowPolicy = options.tapOverflowPolicy ?? 'drop';
        this.onTapOverflow = options.onTapOverflow;
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
    async open(track, request = {}) {
        const accessMode = this.provider.capabilities.accessMode;
        if (accessMode === 'none') {
            const empty = new Readable({
                read() {
                    this.push(null);
                }
            });
            return empty;
        }
        const signal = request.window?.signal ?? request.signal;
        if (signal?.aborted) {
            this._isAborted = true;
            const abortedStream = new Readable({
                read() {
                    this.destroy(new Error('Operation aborted before start'));
                }
            });
            return abortedStream;
        }
        const framing = new PcmFramingTransform(this.inputFormat, this.targetFormat, this.highWaterMark);
        this.activeFramingTransform = framing;
        let rawStream;
        if (accessMode === 'random' || accessMode === 'segmented') {
            if (!request.window) {
                throw new Error(`Provider requires an AnalysisWindow for accessMode '${accessMode}'`);
            }
            const windowedProvider = this.provider;
            rawStream = await windowedProvider.openAnalysisWindow(track, request.window, request.additionalData);
        }
        else {
            let tap = request.tap;
            if (!tap) {
                tap = new PlaybackStreamTap(this.tapQueueLimitBytes, this.tapOverflowPolicy, (dropped) => {
                    this._droppedBytes += dropped;
                    this.onTapOverflow?.(dropped);
                });
            }
            this.activeTap = tap;
            rawStream = tap;
        }
        this._activeSourceStream = rawStream;
        const windowStream = rawStream;
        const actualStartMs = windowStream.startMs ?? request.window?.startTimeMs ?? 0;
        this._initialStartFrame =
            windowStream.startFrame ??
                mediaMsToFrames(actualStartMs, this.targetFormat.sampleRate);
        const cleanup = (error) => {
            if (signal) {
                signal.removeEventListener('abort', onAbort);
            }
            if (this.activeTap) {
                this.activeTap.detach();
            }
            if (!rawStream.destroyed) {
                rawStream.destroy(error ?? undefined);
            }
            if (!framing.destroyed) {
                framing.destroy(error ?? undefined);
            }
        };
        const onAbort = () => {
            this._isAborted = true;
            cleanup(new Error('Progressive reading aborted'));
        };
        if (signal) {
            signal.addEventListener('abort', onAbort, { once: true });
        }
        rawStream.on('error', (err) => {
            cleanup(err);
        });
        framing.on('error', (err) => {
            cleanup(err);
        });
        framing.on('close', () => {
            cleanup();
        });
        rawStream.pipe(framing);
        return framing;
    }
    /**
     * Helper that converts the progressive readable stream into an AsyncIterable yielding PCM chunks.
     * Guarantees deterministic resource destruction on break or throw.
     *
     * @param stream - Readable stream returned by open().
     */
    async *toAsyncIterable(stream) {
        try {
            for await (const chunk of stream) {
                yield chunk;
            }
        }
        finally {
            if (!stream.destroyed) {
                stream.destroy();
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
    async *toProgressiveChunks(stream, initialStartFrame) {
        const bytesPerFrame = this.targetFormat.bytesPerFrame;
        let nextExpectedFrame = initialStartFrame ?? this._initialStartFrame;
        try {
            for await (const rawChunk of stream) {
                const chunk = rawChunk;
                const frameCount = Math.floor(chunk.length / bytesPerFrame);
                const startFrame = chunk.startFrame !== undefined ? chunk.startFrame : nextExpectedFrame;
                yield {
                    data: chunk,
                    startFrame,
                    frameCount
                };
                nextExpectedFrame = startFrame + frameCount;
            }
        }
        finally {
            if (!stream.destroyed) {
                stream.destroy();
            }
        }
    }
    /**
     * Retrieves cumulative metrics for this reader session.
     */
    getStats() {
        const totalBytesRead = this.activeFramingTransform?.totalBytesRead ?? 0;
        const totalFramesRead = this.activeFramingTransform?.totalFramesRead ?? 0;
        const totalMediaMs = framesToMediaMs(totalFramesRead, this.targetFormat.sampleRate);
        return {
            totalBytesRead,
            totalFramesRead,
            totalMediaMs,
            droppedBytes: this._droppedBytes,
            isAborted: this._isAborted
        };
    }
}
