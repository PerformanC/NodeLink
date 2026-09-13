import type { Readable, Transform, TransformOptions } from 'node:stream'
import type {
  AudioMixer,
  AudioResource,
  FiltersState,
  NodeLink,
  StreamInfo
} from './player.types.ts'

/**
 * Configuration for general audio stream parameters.
 */
export interface AudioConfig {
  /** The sampling rate in Hz (e.g., 48000). */
  sampleRate: number
  /** Number of audio channels (e.g., 2 for stereo). */
  channels: number
  /** Number of samples per frame. */
  frameSize: number
  /** High water mark for the internal stream buffer in bytes. */
  highWaterMark: number
}

/**
 * Thresholds for managing compressed audio buffering.
 */
export interface BufferThresholds {
  /** Maximum size in bytes before applying backpressure. */
  maxCompressed: number
  /** Minimum size in bytes required to start/resume playback. */
  minCompressed: number
}

/**
 * Constants governing the audio decoding process.
 */
export interface AudioConstants {
  /** Scaling factor for converting float samples to PCM. */
  pcmFloatFactor: number
  /** Maximum number of frames decoded in a single tick. */
  maxDecodesPerTick: number
  /** Interval in milliseconds between decode ticks. */
  decodeIntervalMs: number
}

/**
 * Configuration for MPEG-TS stream parsing.
 */
export interface MpegtsConfig {
  /** Sync byte used to identify packet starts (usually 0x47). */
  syncByte: number
  /** Size of a single TS packet in bytes (usually 188). */
  packetSize: number
  /** Stream type ID for AAC audio. */
  aacStreamType: number
  /** Stream type ID for MP3 audio (primary). */
  mp3StreamType: number
  /** Stream type ID for MP3 audio (secondary). */
  mp3StreamType2: number
}

/**
 * Coefficients for downmixing multi-channel audio to stereo.
 */
export interface DownmixCoefficients {
  /** Weight for the center channel. */
  center: number
  /** Weight for the surround channels. */
  surround: number
  /** Weight for the Low Frequency Effects (subwoofer) channel. */
  lfe: number
}

/**
 * Minimal representation of an MP4 box (atom).
 */
export interface MP4Box {
  /** The four-character box type (e.g., 'mdat', 'moof'). */
  type: string
  /** Total size of the box including header. */
  size: number
  /** Raw data content of the box. */
  data: Buffer
  /** Byte offset from the start of the file or segment. */
  offset: number
}

/**
 * Metadata for a found ADTS (Advanced Audio Coding Transport Stream) frame.
 */
export interface ADTSFrameInfo {
  /** Start index of the frame in the source buffer. */
  start: number
  /** End index of the frame in the source buffer. */
  end: number
  /** The extracted ADTS frame data. */
  frame: Buffer
}

/**
 * Mocked interface for FLV demuxing components.
 */
export interface FlvDemuxerLike extends Transform {
  on(event: 'data', listener: (audioTag: Buffer) => void): this
  on(event: 'error', listener: (err: Error) => void): this
  write(
    chunk: Buffer,
    encoding?: BufferEncoding,
    callback?: (error?: Error | null) => void
  ): boolean
  write(chunk: Buffer, callback?: (error?: Error | null) => void): boolean
  end(callback?: (error?: Error | null) => void): this
  end(chunk: Buffer, callback?: (error?: Error | null) => void): this
  end(
    chunk: Buffer,
    encoding?: BufferEncoding,
    callback?: (error?: Error | null) => void
  ): this
  destroy(error?: Error): this
}

/**
 * Configuration for an AAC track derived from headers or metadata.
 *
 * @example
 * ```ts
 * const config: AACConfig = {
 *   profile: 2, // LC-AAC
 *   samplingIndex: 4, // 44100Hz
 *   channelCount: 2
 * }
 * ```
 */
export interface AACConfig {
  /** AAC Profile (e.g., 2 for LC, 5 for HE-AAC). */
  profile: number
  /** Sampling frequency index as defined in MPEG-4 Audio. */
  samplingIndex: number
  /** Number of audio channels. */
  channelCount: number
  /** Calculated sample rate if available. */
  sampleRate?: number
  /** Internal track identifier. */
  trackId?: number
  /** Default sample size specified in MP4 headers. */
  defaultSampleSize?: number
}

/**
 * Generic result of an audio decoding operation.
 */
export interface DecodeResult {
  /** Interleaved PCM samples in a Buffer. */
  samples: Buffer
  /** Sample rate of the decoded audio. */
  sampleRate: number
  /** Number of channels in the decoded audio. */
  channels: number
}

/**
 * Result of an AAC-specific decoding operation.
 */
export interface AACDecodeResult {
  /** PCM samples as 32-bit floats. */
  pcm: Float32Array
  /** Sample rate of the decoded audio. */
  sampleRate: number
  /** Number of channels in the decoded audio. */
  channels: number
  /** Number of samples per individual channel. */
  samplesPerChannel: number
}

/**
 * A chunk of data waiting for async resampler initialization.
 */
export interface PendingChunk {
  /** The raw data buffer. */
  chunk: Buffer
  /** Character encoding of the buffer if applicable. */
  encoding: BufferEncoding
  /** Stream callback to signal processing completion. */
  callback: (error?: Error | null) => void
}

/**
 * Internal state for fMP4 segment parsing.
 */
export interface FMP4StreamState {
  /** Current parsing phase. */
  mode: 'READ_HEADER' | 'READ_BODY' | 'STREAM_MDAT'
  /** Current byte offset in the internal buffer. */
  offset: number
  /** Size of the box currently being parsed. */
  boxSize: number
  /** FourCC type of the current box. */
  boxType: string
  /** Size of the box header. */
  headerSize: number
  /** Accumulated buffer for 'moof' boxes. */
  moofBuffer: Buffer
  /** List of sample sizes extracted from 'trun' boxes. */
  samples: number[]
}

/**
 * Metadata provided by seekable streams.
 */
export interface SeekableStreamMeta {
  /** Optional codec information. */
  codec?: {
    /** The container format (e.g., 'mp4', 'mpegts'). */
    container?: string
  }
}

/**
 * Standardized error response returned by seek operations.
 */
export interface ErrorResponse {
  exception: {
    /** High-level error message. */
    message: string
    /** Severity level of the error. */
    severity: string
    /** Machine-readable error code or cause. */
    cause: string
  }
}

/**
 * Contract for a Symphonia-based decoder implementation.
 */
export interface SymphoniaDecoderLike {
  /** Number of bytes currently held in the internal buffer. */
  bufferedBytes: number
  /** Whether the stream header has been successfully probed. */
  isProbed: boolean
  /** Pushes new data to the decoder buffer. */
  push(chunk: Buffer): void
  /** Initializes the decoder once enough compressed input is buffered. */
  initialize(codecRegistryHint?: string | null): boolean
  /** Decodes the next available frame. */
  decode(): DecodeResult | null
  /** Closes the input handle. */
  closeInput(): void
  /** Flushes internal buffers. */
  flush(): void
  /** Releases all native resources. */
  free(): void
}

/**
 * Interface for libsamplerate-based resamplers.
 */
export interface ResamplerLike {
  /** Processes a set of float samples. */
  full(samples: Float32Array): Float32Array
  /** Releases native resources. */
  destroy(): void
}

/**
 * Contract for a FAAD2-based AAC decoder implementation.
 */
export interface FAAD2DecoderLike {
  /** Promise that resolves when the WASM module is ready. */
  ready: Promise<void>
  /** Configures the decoder for a specific frame type. */
  configure(frame: Buffer, autoDetect?: boolean): Promise<void>
  /** Decodes a single AAC frame. */
  decode(frame: Buffer): AACDecodeResult | null
  /** Releases native resources (FAAD2 node binding version). */
  free?(): void
  /** Releases resources (Common across implementations). */
  destroy?(): void
}

/**
 * Interface for the MP4Box.js file object used for demuxing.
 */
export interface MP4BoxFile {
  /** Callback triggered when file metadata is ready. */
  onReady: ((info: MP4BoxInfo) => void) | null
  /** Callback triggered when new samples are extracted. */
  onSamples:
    | ((id: number, user: unknown, samples: MP4BoxSample[]) => void)
    | null
  /** Callback triggered on parsing errors. */
  onError: ((error: string) => void) | null
  /** Appends raw data to the MP4Box parser. */
  appendBuffer(buffer: ArrayBufferLike & { fileStart?: number }): void
  /** Configures sample extraction for a specific track. */
  setExtractionOptions(
    trackId: number,
    user: unknown,
    options: { nbSamples: number }
  ): void
  /** Starts the extraction process. */
  start(): void
  /** Stops the extraction process. */
  stop(): void
  /** Flushes any remaining data. */
  flush(): void
}

/**
 * Metadata provided by MP4Box upon successful parsing of file headers.
 */
export interface MP4BoxInfo {
  /** List of tracks (audio, video, etc.) found in the file. */
  tracks: MP4BoxTrack[]
}

/**
 * Metadata for a specific track within an MP4 container.
 */
export interface MP4BoxTrack {
  /** Unique identifier for the track. */
  id: number
  /** Codec string (e.g., 'mp4a.40.2'). */
  codec?: string
  /** Audio-specific parameters if the track is an audio track. */
  audio: {
    /** Sampling frequency in Hz. */
    sample_rate: number
    /** Number of audio channels. */
    channel_count: number
  }
}

/**
 * A single audio sample extracted from an MP4 container.
 */
export interface MP4BoxSample {
  /** Raw sample data. */
  data: ArrayBuffer
}

/**
 * Interface for a circular buffer used for stream synchronization.
 */
export interface RingBufferLike {
  /** Number of bytes currently available in the buffer. */
  length: number
  /** Adds data to the end of the buffer. */
  write(chunk: Buffer): void
  /** Removes and returns the requested number of bytes. */
  read(count: number): Buffer | null
  /** Skips/discards bytes without allocating a new buffer. */
  skip(count: number): number
  /** Returns the requested number of bytes without removing them. */
  peek(count: number): Buffer | null
  /** Discards all data in the buffer. */
  clear(): void
  /** Disposes of resources and marks the buffer as dead. */
  dispose(): void
}

/**
 * Initialization options for the Opus decoder.
 */
export interface OpusDecoderOptions {
  /** Sampling rate (usually 48000). */
  rate: number
  /** Channel count (usually 2). */
  channels: number
  /** Frame size in samples. */
  frameSize: number
}

/**
 * Mocked interface for the Opus encoder component.
 */
export interface OpusEncoderLike extends Transform {
  /** Configures Discontinuous Transmission (DTX) for bandwidth saving. */
  setDTX(enabled: boolean): void
}

/**
 * Options for configuring volume transformation and Automatic Gain Control.
 */
export interface VolumeTransformerOptions {
  /** PCM sample format (e.g., 's16le'). */
  type: string
  /** Initial volume multiplier (1.0 = 100%). */
  volume: number
  /** Whether to enable Automatic Gain Control. */
  enableAGC?: boolean
  /** Lookahead duration in milliseconds for AGC. */
  lookaheadMs?: number
  /** Threshold in LUFS for the noise gate. */
  gateThresholdLUFS?: number
}

/**
 * Options for configuring audio fade effects.
 */
export interface FadeTransformerOptions {
  /** PCM sample format (e.g., 's16le'). */
  type: string
  /** Target volume multiplier. */
  volume: number
  /** Audio sampling rate. */
  sampleRate: number
  /** Number of channels. */
  channels: number
}

/**
 * Options for the Symphonia-based decoder stream.
 */
export interface SymphoniaDecoderStreamOptions extends TransformOptions {
  /** Desired resampling quality. */
  resamplingQuality?: string
  /** Optional file-extension hint for Symphonia probing. */
  codecRegistryHint?: string | null
  /** Stream high water mark in bytes. */
  highWaterMark?: number
}

/**
 * Options for the AAC-specific decoder stream.
 */
export interface AACDecoderStreamOptions extends TransformOptions {
  /** Desired resampling quality. */
  resamplingQuality?: ResamplingQuality
  state?: { isAlac: boolean }
}

/**
 * Options for the segmented MP4 (fMP4) stream component.
 */
export interface FMP4StreamOptions extends TransformOptions {
  /** Whether to process chunks as independent fragments. */
  bufferMode?: boolean
}

/**
 * Function type for creating generalized audio resources.
 */
export type CreateAudioResourceFn = (
  stream: Readable,
  type: string,
  nodelink: NodeLink,
  initialFilters?: FiltersState,
  volume?: number,
  audioMixer?: AudioMixer | null,
  returnPCM?: boolean,
  enableAGC?: boolean,
  enableCrossfade?: boolean
) => Promise<AudioResource>

/**
 * Function type for creating seekable audio resources.
 */
export type CreateSeekableAudioResourceFn = (
  url: string,
  seekTime: number,
  endTime: number | undefined,
  nodelink: NodeLink,
  initialFilters: FiltersState,
  player: { streamInfo: StreamInfo; loudnessNormalizer?: boolean },
  volume?: number,
  audioMixer?: AudioMixer | null
) => Promise<AudioResource | ErrorResponse>

/**
 * Function type for creating raw PCM streams.
 */
export type CreatePCMStreamFn = (
  stream: Readable,
  type: string,
  nodelink: NodeLink,
  volume?: number,
  filters?: FiltersState
) => Transform

/**
 * Levels of quality/speed for the internal resampler.
 */
export type ResamplingQuality =
  | 'best'
  | 'medium'
  | 'fastest'
  | 'zero order holder'
  | 'linear'

/**
 * Representation of an audio tag extracted from an FLV container.
 */
export interface FLVAudioTag {
  /** Raw audio data body. */
  body: Buffer
  /** AAC payload type (0: Sequence Header, 1: Raw). */
  aacPacketType: number
}

/**
 * Exhaustive options for constructing high-level audio resources.
 */
export interface StreamAudioResourceOptions {
  /** The source readable stream. */
  stream: Readable
  /** Mime-type or format name of the source. */
  type: string
  /** Global NodeLink context. */
  nodelink: NodeLink
  /** Initial filter state to apply. */
  initialFilters: FiltersState
  /** Initial playback volume. */
  volume: number
  /** Optional mixer to register the stream with. */
  audioMixer: AudioMixer | null
  /** Whether to output raw PCM instead of encoded audio. */
  returnPCM: boolean
  /** Whether to enable AGC. */
  enableAGC?: boolean
}
