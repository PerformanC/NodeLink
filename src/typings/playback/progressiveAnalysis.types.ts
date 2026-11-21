/**
 * @file progressiveAnalysis.types.ts
 * @package NodeLink
 * @organization PerformanC
 * @author PerformanC <https://github.com/PerformanC>
 * @license GPL-3.0-or-later
 * @copyright (C) 2026 PerformanC
 *
 * @description
 * Universal type definitions and capability contracts for Progressive Lookahead Audio Analysis
 * in NodeLink AutoMix. Standardizes media time access, PCM audio format guarantees, and
 * streaming MIR (Music Information Retrieval) feature extraction.
 */

import type { Readable } from 'node:stream'
import type { TrackInfo } from '../sources/source.types.ts'
import type { TrackInfoExtended } from './player.types.ts'

/**
 * Supported PCM sample formats for analysis.
 */
export type AnalysisSampleFormat = 's16le' | 'f32le'

/**
 * Formal PCM audio format contract for progressive analysis.
 * AutoMix operates on normalized, uncompressed stereo PCM streams.
 */
export interface AnalysisPcmFormat {
  /** Sampling frequency in Hz (typically 48000 for Opus/WebRTC). */
  readonly sampleRate: number
  /** Channel count (typically 2 for stereo interleaved audio). */
  readonly channels: number
  /** Sample representation format. Default is 16-bit signed integer little-endian. */
  readonly sampleFormat: AnalysisSampleFormat
  /** Bytes per individual sample per channel (2 for s16le, 4 for f32le). */
  readonly bytesPerSample: number
  /** Bytes per multi-channel interleaved frame (`channels * bytesPerSample`, e.g. 4 for 16-bit stereo, 8 for 32-bit float stereo). */
  readonly bytesPerFrame: number
}

/**
 * Creates a validated AnalysisPcmFormat deriving bytesPerSample and bytesPerFrame.
 */
export function createAnalysisPcmFormat(
  options?: Partial<Omit<AnalysisPcmFormat, 'bytesPerSample' | 'bytesPerFrame'>>
): AnalysisPcmFormat {
  const sampleRate = options?.sampleRate ?? 48000
  const channels = options?.channels ?? 2
  const sampleFormat = options?.sampleFormat ?? 's16le'
  const bytesPerSample = sampleFormat === 's16le' ? 2 : 4
  const bytesPerFrame = channels * bytesPerSample

  return {
    sampleRate,
    channels,
    sampleFormat,
    bytesPerSample,
    bytesPerFrame
  }
}

/**
 * Standard NodeLink 48kHz stereo 16-bit PCM format configuration.
 */
export const STANDARD_ANALYSIS_PCM_FORMAT: AnalysisPcmFormat =
  createAnalysisPcmFormat({
    sampleRate: 48000,
    channels: 2,
    sampleFormat: 's16le'
  })

/**
 * Converts a raw byte count into equivalent media milliseconds based on full PCM frames.
 *
 * @param bytes - Total number of bytes.
 * @param format - Target PCM audio format specification.
 * @returns Equivalent duration in media milliseconds derived strictly from integer frames.
 */
export function bytesToMediaMs(
  bytes: number,
  format: AnalysisPcmFormat = STANDARD_ANALYSIS_PCM_FORMAT
): number {
  const fullFrames = Math.floor(bytes / format.bytesPerFrame)
  return (fullFrames / format.sampleRate) * 1000
}

/**
 * Converts media milliseconds into an equivalent byte count aligned to full audio frames.
 *
 * @param ms - Duration in media milliseconds.
 * @param format - Target PCM audio format specification.
 * @returns Aligned byte count.
 */
export function mediaMsToBytes(
  ms: number,
  format: AnalysisPcmFormat = STANDARD_ANALYSIS_PCM_FORMAT
): number {
  const frames = Math.round((ms * format.sampleRate) / 1000)
  return frames * format.bytesPerFrame
}

/**
 * Aligns a byte count to the nearest full frame boundary without exceeding the original count.
 *
 * @param bytes - Raw byte count.
 * @param format - Target PCM audio format specification.
 * @returns Byte count aligned to full frame boundary.
 */
export function alignBytesToFrames(
  bytes: number,
  format: AnalysisPcmFormat = STANDARD_ANALYSIS_PCM_FORMAT
): number {
  return bytes - (bytes % format.bytesPerFrame)
}

/**
 * Converts frame count into equivalent media milliseconds.
 *
 * @param frames - Number of audio frames.
 * @param sampleRate - Sampling rate in Hz.
 * @returns Duration in media milliseconds.
 */
export function framesToMediaMs(
  frames: number,
  sampleRate = STANDARD_ANALYSIS_PCM_FORMAT.sampleRate
): number {
  return (frames / sampleRate) * 1000
}

/**
 * Converts media milliseconds into an equivalent frame count.
 *
 * @param ms - Duration in media milliseconds.
 * @param sampleRate - Sampling rate in Hz.
 * @returns Number of audio frames.
 */
export function mediaMsToFrames(
  ms: number,
  sampleRate = STANDARD_ANALYSIS_PCM_FORMAT.sampleRate
): number {
  return Math.round((ms * sampleRate) / 1000)
}

/**
 * Mode of audio access supported by a media source for lookahead analysis.
 *
 * - `random`: Source supports independent random-access temporal requests (e.g. YouTube, local files, HTTP byte-range).
 * - `segmented`: Source supports opening independent windows aligned to segment/chunk boundaries (e.g. HLS, DASH).
 * - `sequential`: Source is continuous or live; cannot open independent windows without interrupting playback or redownloading. Analysis must tap the live playback stream.
 * - `none`: Source does not provide audio for lookahead analysis; relies strictly on fallback profiles.
 */
export type AnalysisAccessMode = 'random' | 'segmented' | 'sequential' | 'none'

/**
 * Base temporal capabilities declared by an audio source.
 */
export interface AnalysisCapabilitiesBase {
  /** Mode of audio access supported. */
  readonly accessMode: AnalysisAccessMode
  /** Whether the source can seek to exact millisecond/sample timestamps or only coarse keyframe boundaries. */
  readonly accurateTimeSeek: boolean
  /** Whether the window stream can be resumed or reopened cheaply without expensive re-authentication. */
  readonly resumable: boolean
  /** Whether an active analysis stream can be immediately aborted via AbortSignal without resource/socket leaks. */
  readonly earlyAbort: boolean
  /** Maximum supported duration for an independent analysis window in milliseconds, if bounded. */
  readonly maxWindowDurationMs?: number
}

/**
 * Capabilities for random-access sources (e.g. YouTube, local files, HTTP range requests).
 */
export interface RandomAnalysisCapabilities extends AnalysisCapabilitiesBase {
  readonly accessMode: 'random'
}

/**
 * Capabilities for segmented sources (e.g. HLS, DASH).
 */
export interface SegmentedAnalysisCapabilities
  extends AnalysisCapabilitiesBase {
  readonly accessMode: 'segmented'
}

/**
 * Capabilities for sequential sources (e.g. continuous live streams, Icecast).
 * Cannot open independent windows; analysis must consume a tap of the playback stream.
 */
export interface SequentialAnalysisCapabilities
  extends AnalysisCapabilitiesBase {
  readonly accessMode: 'sequential'
  readonly accurateTimeSeek: false
  readonly resumable: false
}

/**
 * Capabilities for sources that do not provide audio for lookahead analysis.
 */
export interface NoneAnalysisCapabilities extends AnalysisCapabilitiesBase {
  readonly accessMode: 'none'
  readonly accurateTimeSeek: false
  readonly resumable: false
  readonly earlyAbort: false
}

/**
 * Universal union of source analysis capabilities.
 */
export type AnalysisCapabilities =
  | RandomAnalysisCapabilities
  | SegmentedAnalysisCapabilities
  | SequentialAnalysisCapabilities
  | NoneAnalysisCapabilities

/**
 * Temporal window specification requested by the AutoMix Lookahead Engine.
 * All units are in media time milliseconds.
 */
export interface AnalysisWindow {
  /** Start position within the media track in milliseconds. */
  readonly startTimeMs: number
  /** Requested duration of the window in milliseconds. */
  readonly durationMs: number
  /** Mandatory abort signal for early cancellation and resource cleanup. */
  readonly signal: AbortSignal
}

/**
 * Readable audio stream returned by openAnalysisWindow with optional temporal preroll metadata.
 */
export interface AnalysisWindowStream extends Readable {
  /** Actual starting media time in milliseconds if different from requested window.startTimeMs due to preroll/keyframe alignment. */
  startMs?: number
  /** Actual starting audio frame index if known. */
  startFrame?: number
}

/**
 * Provider interface for sources capable of opening independent lookahead windows (`random` or `segmented`).
 */
export interface WindowedAnalysisStreamProvider {
  readonly capabilities:
    | RandomAnalysisCapabilities
    | SegmentedAnalysisCapabilities

  /**
   * Opens an independent readable audio stream for the requested media window.
   *
   * @param track - Track information.
   * @param window - Media time window specification and cancellation signal.
   * @param additionalData - Source-specific metadata if needed.
   * @returns Readable stream delivering raw audio for the window.
   */
  openAnalysisWindow(
    track: TrackInfo | TrackInfoExtended,
    window: AnalysisWindow,
    additionalData?: Record<string, unknown>
  ): Promise<Readable | AnalysisWindowStream>
}

/**
 * Provider interface for sequential sources whose analysis must tap the active playback stream.
 */
export interface SequentialAnalysisStreamProvider {
  readonly capabilities: SequentialAnalysisCapabilities
}

/**
 * Provider interface for sources that do not support lookahead analysis.
 */
export interface NoneAnalysisStreamProvider {
  readonly capabilities: NoneAnalysisCapabilities
}

/**
 * Universal discriminated union for source analysis providers.
 * Enforces that only sources declaring `random` or `segmented` access can and must implement `openAnalysisWindow`.
 */
export type AnalysisStreamProvider =
  | WindowedAnalysisStreamProvider
  | SequentialAnalysisStreamProvider
  | NoneAnalysisStreamProvider

/**
 * Smoothed stereo energy measured across broad frequency bands.
 */
export interface MusicalBandEnergy {
  readonly low: number
  readonly mid: number
  readonly high: number
}

/**
 * Discrete point in time within the temporal feature map extracted by MIR.
 */
export interface TemporalFeaturePoint {
  /** Exact media position in milliseconds from the start of the track. */
  readonly timestampMs: number
  /** Root Mean Square amplitude of the audio frame (0.0 to 1.0). */
  readonly rms: number
  /** Peak instantaneous sample value (0.0 to 1.0). */
  readonly peak: number
  /** Spectral band energy distribution across low, mid, and high frequencies. */
  readonly bands: MusicalBandEnergy
  /** Whether a transient onset occurred at this point. */
  readonly onset: boolean
  /** Whether this frame aligns with an estimated metric beat. */
  readonly beat: boolean
  /**
   * Estimated acoustic energy ratio in the human vocal formant range (250 Hz - 2500 Hz).
   *
   * @notice IMPORTANT: This is an acoustic mid-band formant concentration heuristic, NOT
   * an AI-based human voice recognition or isolation model. It can respond to lead guitars,
   * synthesizers, and other mid-heavy instruments. NEVER use this value in isolation
   * to determine mix/crossfade transition points.
   */
  readonly vocalActivity: number
  /** Whether the audio at this point is effectively silent (below noise threshold). */
  readonly isSilence: boolean
  /** Confidence score for the metrics at this point (0.0 to 1.0). */
  readonly confidence: number
}

/**
 * Progressively built temporal feature map for a track.
 * Stores lightweight numerical descriptors and boundary markers without holding raw PCM in memory.
 */
export interface TemporalFeatureMap {
  /** Unique track identifier. */
  readonly trackId: string
  /** Total known or estimated track duration in milliseconds. */
  readonly durationMs: number
  /** Media position in milliseconds analyzed so far. */
  readonly analyzedUntilMs: number
  /** Sequential feature points across the analyzed regions. */
  readonly points: readonly TemporalFeaturePoint[]
  /** Detected natural outro point in milliseconds, or null if not yet determined. */
  readonly naturalOutroPointMs: number | null
  /** Detected start of energy decay in milliseconds, or null if not yet determined. */
  readonly energyDecayStartMs: number | null
  /** Residual RMS energy at the cut point immediately before EOF. */
  readonly sourceEndRms: number
  /** Overall confidence score of the analysis (0.0 to 1.0). */
  readonly confidence: number
}

/**
 * Envelope for a normalized PCM chunk carrying its exact absolute position in the media timeline.
 */
export interface ProgressivePcmChunk {
  /** Raw PCM audio buffer aligned to full audio frames. */
  readonly data: Buffer
  /** Absolute audio frame index from the beginning of the track (0-indexed). */
  readonly startFrame: number
  /** Number of full audio frames contained in this chunk. */
  readonly frameCount: number
}

/**
 * Contract for progressive, streaming-based audio feature extraction.
 * Processes PCM chunks incrementally without allocating monolithic buffers.
 */
export interface IncrementalAnalyzer {
  /**
   * Pushes a progressive PCM chunk with explicit temporal frame positioning into the analyzer.
   *
   * @param chunk - PCM chunk or ProgressivePcmChunk carrying data and its absolute frame index.
   * @param startFrame - Optional explicit start frame index when chunk is a plain Buffer.
   */
  pushPcm(chunk: ProgressivePcmChunk | Buffer, startFrame?: number): void

  /**
   * Returns a snapshot of the temporal feature map accumulated so far.
   */
  getSnapshot(): TemporalFeatureMap

  /**
   * Finalizes the analysis, resolving pending outro boundaries and metric estimates.
   */
  finalize(): TemporalFeatureMap

  /**
   * Resets analyzer state for reuse.
   */
  reset(): void
}

/**
 * Policy for handling tap buffer overflow when consumer cannot keep up with playback.
 */
export type TapOverflowPolicy = 'drop' | 'abort'

/**
 * Interface for an isolated audio tap hooked to the playback pipeline.
 */
export interface IPlaybackStreamTap {
  /** Synchronously writes a PCM chunk into the isolated tap buffer without blocking playback. */
  write(chunk: Buffer, startFrame?: number): void
  /** Closes and detaches the tap. */
  detach(): void
  /** Whether the tap is actively receiving chunks. */
  readonly isAttached: boolean
}

/**
 * Options for configuring ProgressiveAudioReader.
 */
export interface ProgressiveReaderOptions {
  /** Target PCM format for output stream. Defaults to STANDARD_ANALYSIS_PCM_FORMAT (48kHz 16-bit stereo). */
  readonly targetFormat?: AnalysisPcmFormat
  /** Incoming PCM format if known and different from targetFormat. */
  readonly inputFormat?: AnalysisPcmFormat
  /** Maximum buffer size in bytes for stream highWaterMark. Default: 65536 (64 KB). */
  readonly highWaterMark?: number
  /** Maximum queue size in bytes for sequential tap buffer. Default: 65536 (64 KB). */
  readonly tapQueueLimitBytes?: number
  /** Overflow policy for tap buffer when analysis lags behind playback. Default: 'drop'. */
  readonly tapOverflowPolicy?: TapOverflowPolicy
  /** Callback fired when frames are dropped due to tap buffer overflow. */
  readonly onTapOverflow?: (droppedBytes: number) => void
}

/**
 * Execution metrics collected during progressive reading.
 */
export interface ProgressiveReadStats {
  readonly totalBytesRead: number
  readonly totalFramesRead: number
  readonly totalMediaMs: number
  readonly droppedBytes: number
  readonly isAborted: boolean
}
