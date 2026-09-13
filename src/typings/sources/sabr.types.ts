/**
 * SABR Stream Type Definitions
 *
 * Shared types for SABR (Server-side Adaptive Bitrate) streaming.
 * These types cover stream configuration, UMP part handling,
 * media segment tracking, and traffic logging.
 *
 * Re-exports codec types from {@link ./protor.ts} for centralized access.
 *
 * @packageDocumentation
 * @module SabrTypes
 */

import type {
  ClientInfoMsg,
  FormatIdMsg,
  FormatInitializationMetadataMsg,
  MediaHeaderMsg,
  NextRequestPolicyMsg,
  UMPPartId
} from '../../sources/youtube/sabr/protor.ts'

export type {
  ClientAbrStateMsg,
  ClientInfoMsg,
  FormatIdMsg,
  FormatInitializationMetadataMsg,
  MediaHeaderMsg,
  NextRequestPolicyMsg,
  SabrContextSendingPolicyMsg,
  SabrContextUpdateMsg,
  SabrErrorMsg,
  SabrRedirectMsg,
  StreamProtectionStatusMsg,
  TimeRangeMsg,
  VideoPlaybackAbrRequestMsg
} from '../../sources/youtube/sabr/protor.ts'

export {
  base64ToU8,
  concatenateChunks,
  FormatId,
  FormatInitializationMetadata,
  MediaHeader,
  NextRequestPolicy,
  PlaybackStartPolicy,
  ProtoReader,
  ProtoWriter,
  ReloadPlaybackContext,
  RequestCancellationPolicy,
  RequestIdentifier,
  SabrContextSendingPolicy,
  SabrContextUpdate,
  SabrError,
  SabrRedirect,
  StreamProtectionStatus,
  UMPPartId,
  UMPWriter,
  VideoPlaybackAbrRequest
} from '../../sources/youtube/sabr/protor.ts'

/**
 * Configuration object for initializing a {@link SabrStream}.
 *
 * Contains all parameters needed to establish a SABR streaming session,
 * including authentication tokens, format selection, and playback options.
 *
 * @example
 * ```typescript
 * const config: SabrStreamConfig = {
 *   videoId: 'dQw4w9WgXcQ',
 *   serverAbrStreamingUrl: 'https://rr3---sn-xyz.googlevideo.com/videoplayback...',
 *   videoPlaybackUstreamerConfig: 'base64config...',
 *   clientInfo: { clientName: 1, clientVersion: '2.20260114.01.00' },
 *   formats: [{ itag: 251, mimeType: 'audio/webm', bitrate: 160000 }],
 *   poToken: 'base64poToken...',
 *   visitorData: 'CgtvK8...',
 * };
 * ```
 *
 * @public
 */
export interface SabrStreamConfig {
  /** YouTube video identifier (11-character ID). */
  videoId: string

  /** Server-side ABR streaming URL from the innertube player response. */
  serverAbrStreamingUrl?: string

  /** Base64-encoded ustreamer configuration blob for media serving. */
  videoPlaybackUstreamerConfig?: string | Uint8Array

  /** Client identification metadata sent with each ABR request. */
  clientInfo?: ClientInfoMsg

  /**
   * Available format entries to stream.
   * Each entry must include at least an `itag` and optional `mimeType`.
   */
  formats?: FormatEntry[]

  /**
   * Proof-of-origin token for bot detection bypass.
   * Can be a base64 string (decoded on construction) or a pre-decoded byte array.
   */
  poToken?: string | Uint8Array | null

  /** Visitor data token for session tracking. */
  visitorData?: string

  /**
   * Bearer token for authenticated YouTube sessions.
   * When provided, the Authorization header is included in ABR requests.
   */
  accessToken?: string

  /**
   * Custom User-Agent header for HTTP requests.
   * Defaults to a Chrome-like user agent string when omitted.
   */
  userAgent?: string

  /**
   * Start time offset in milliseconds for stream initialization.
   * Used to seek to a specific position when starting playback.
   * @default 0
   */
  startTime?: number

  /**
   * Callback invoked with the current playback position in milliseconds
   * after media headers have been processed.
   */
  positionCallback?: (positionMs: number) => void

  /** Returns whether playback is currently paused. */
  playbackPaused?: () => boolean

  /**
   * Previous session state for session continuation across seek operations.
   * Transfers request ordering, policy, bandwidth, and SABR contexts to avoid
   * the session recreation penalty.
   */
  previousSession?: PreviousSessionState

  /**
   * Playback cookie for authenticated SABR sessions.
   * Can be a base64 string (decoded on construction) or pre-decoded bytes.
   */
  playbackCookie?: string | Uint8Array
}

/**
 * Minimal format descriptor used during SABR stream initialization.
 *
 * Each entry represents a single stream quality variant with its YouTube
 * itag identifier and optional metadata.
 *
 * @public
 */
export interface FormatEntry {
  /** YouTube format identifier (itag number). */
  itag: number

  /** MIME type string for the format (e.g. 'audio/webm; codecs="opus"'). */
  mimeType?: string

  /** Average bitrate in bits per second. */
  bitrate?: number

  /** Audio track identifier for multilingual audio. */
  audioTrackId?: string

  /** Additional format-specific tags (e.g. 'lang_en'). */
  xtags?: string

  /** Last modified timestamp for the format. */
  lastModified?: string

  /** Allow additional format-specific properties. */
  [key: string]: unknown
}

/**
 * Exported session state from a {@link SabrStream} instance.
 *
 * Used during seek operations or session recreation to transfer
 * request sequencing and policy state without the penalty of
 * rebuilding from scratch.
 *
 * @example
 * ```typescript
 * const state: PreviousSessionState = sabrStream.getSessionState();
 * // Later, create a new stream with the transferred state:
 * const newStream = new SabrStream({ ...config, previousSession: state });
 * ```
 *
 * @public
 */
export interface PreviousSessionState {
  /**
   * Current request sequence number.
   * Incremented with each ABR request to maintain ordering.
   */
  requestNumber: number

  /**
   * Estimated bandwidth in bits per second.
   * Used for adaptive quality selection.
   */
  bandwidthEstimate: number

  /**
   * Last received next request policy from the server.
   * Contains backoff timing and playback cookie for session continuity.
   */
  nextRequestPolicy?: NextRequestPolicyMsg

  /** SABR contexts required to continue the existing server session. */
  sabrContexts?: Array<{
    type: number
    value: Uint8Array
    sendByDefault?: boolean
  }>

  /** Context types currently enabled by the server sending policy. */
  activeSabrContextTypes?: number[]
}

/**
 * Numeric UMP part type identifier.
 * Values correspond to the constants in {@link UMPPartId}.
 *
 * @public
 */
export type UmpPartType = (typeof UMPPartId)[keyof typeof UMPPartId]

/**
 * Parsed UMP (Unified Media Protocol) part.
 *
 * Represents a single decoded part from the UMP binary stream,
 * containing its type identifier, byte size, and composite data buffer.
 *
 * @public
 */
export interface UmpPart {
  /**
   * Numeric part type identifier from {@link UMPPartId}.
   * Determines which handler processes this part.
   */
  type: UmpPartType

  /**
   * Declared byte size of the part payload.
   * Used to verify complete data availability before processing.
   */
  size: number

  /**
   * Composite buffer containing the part payload data.
   * The data is a {@link CompositeBuffer} instance wrapping one or more
   * byte chunks.
   */
  data: CompositeBuffer
}

/**
 * Result returned when a UMP part cannot be fully read.
 *
 * Indicates that the stream has only received a partial portion of the
 * declared part data, and the caller should accumulate more data before
 * processing.
 *
 * @public
 */
export interface IncompleteUmpPart {
  /** Part type identifier of the incomplete part. */
  type: number

  /** Declared total byte size of the part. */
  size: number

  /** Byte size of the part header (type varint + size varint). */
  headerSize: number

  /**
   * Remaining composite buffer containing the partial data received so far.
   * Includes the header bytes as well.
   */
  data: CompositeBuffer

  /** Always `true`, indicating this result is an incomplete part. */
  incomplete: true
}

/**
 * Callback function type for handling parsed UMP parts.
 *
 * Each UMP part type has a dedicated handler registered in
 * the {@link SabrStream.umpPartHandlers} map.
 *
 * @param part - The fully parsed UMP part.
 * @public
 */
export type UmpPartHandler = (part: UmpPart) => void

/**
 * Metadata for a completed downloaded media segment.
 *
 * Stored per-itag in the {@link SabrStream.downloadedSegmentsByItag}
 * map, keyed by segment number.
 *
 * @public
 */
export interface DownloadedSegment {
  /** Sequential segment number within the format. */
  segmentNumber: number

  /** Duration of this segment in milliseconds. */
  durationMs: number

  /** Total byte length of the downloaded segment data. */
  byteLength: number

  /** The media header that describes this segment. */
  mediaHeader: MediaHeaderMsg

  /**
   * Start time of the segment in milliseconds from the beginning
   * of the media timeline.
   */
  startMs: number

  /**
   * End time of the segment in milliseconds from the beginning
   * of the media timeline.
   */
  endMs: number
}

/**
 * In-flight segment entry tracked while receiving media data.
 *
 * Created when a `MEDIA_HEADER` part arrives, updated as `MEDIA` chunks
 * are received, and finalized when `MEDIA_END` is processed.
 *
 * @internal
 */
export interface PartialSegmentQueueEntry {
  /** Composite key identifying the format (`itag:xtags`). */
  formatIdKey: string

  /** Sequential segment number within the format. */
  segmentNumber: number

  /** The media header describing this segment. */
  mediaHeader: MediaHeaderMsg

  /** Duration string in milliseconds (from the media header). */
  durationMs: string

  /** Number of bytes received so far for this segment. */
  loadedBytes: number

  /** Whether this segment overlaps media already forwarded downstream. */
  discard?: boolean
}

/**
 * Entry stored in the initialized formats map.
 *
 * Tracks format initialization metadata received from the server,
 * keyed by composite format key (`itag:xtags`).
 *
 * @internal
 */
export interface FormatInitializationEntry {
  /** Decoded format initialization metadata from the server. */
  formatInitializationMetadata: FormatInitializationMetadataMsg
}

/**
 * Active partial media state maintained between read iterations.
 *
 * When the UMP reader encounters a `MEDIA` part that spans multiple
 * read cycles, this state tracks what has been processed so far.
 *
 * @internal
 */
export interface ActivePartial {
  /** UMP part type (always `MEDIA` for active partials). */
  type: number

  /** Total declared size of the media part in bytes. */
  totalSize: number

  /** Byte size of the part header. */
  headerSize: number

  /** Number of bytes already processed and pushed downstream. */
  processedBytes: number

  /**
   * Header ID byte identifying which segment this media belongs to.
   * Extracted from the first byte of the media payload.
   */
  id: number | undefined
}

/**
 * Adaptive Bitrate state passed to `fetchAndProcessSegments`.
 *
 * Describes the current playback position and network conditions
 * used by the server to select appropriate media quality.
 *
 * @internal
 */
export interface AbrState {
  /** Current playback position in milliseconds (including start time offset). */
  playerTimeMs: number

  /** Estimated bandwidth in bits per second (minimum 500kbps). */
  bandwidthEstimate: number

  /**
   * Bitfield indicating which track types are enabled.
   * @see {@link EnabledTrackTypes}
   */
  enabledTrackTypesBitfield: number

  /** Audio track identifier for multilingual audio selection. */
  audioTrackId: string

  /** Player state bitmask. */
  playerState: bigint

  /** Visibility state of the player (1 = visible). */
  visibility: number

  /** Current playback rate (1.0 = normal speed). */
  playbackRate: number

  /** Last manually selected video resolution in pixels. */
  lastManualSelectedResolution: number

  /** Sticky resolution maintained by ABR logic. */
  stickyResolution: number

  /** Whether the client viewport supports flexible resolution. */
  clientViewportIsFlexible: boolean
}

/**
 * Boolean flags tracking which UMP part types were seen
 * during a single ABR response cycle.
 *
 * Used for traffic logging and stall detection logic.
 *
 * @internal
 */
export interface SawFlags {
  /** Whether a `MEDIA` part was received. */
  media: boolean

  /** Whether a `MEDIA_HEADER` part was received. */
  mediaHeader: boolean

  /** Whether a `MEDIA_END` part was received. */
  mediaEnd: boolean

  /** Whether a `NEXT_REQUEST_POLICY` part was received. */
  nextRequestPolicy: boolean

  /** Whether a `PLAYBACK_START_POLICY` part was received. */
  playbackStartPolicy: boolean

  /** Whether a `REQUEST_IDENTIFIER` part was received. */
  requestIdentifier: boolean

  /** Whether a `REQUEST_CANCELLATION_POLICY` part was received. */
  requestCancellationPolicy: boolean

  /** Whether a `SABR_ERROR` part was received. */
  sabrError: boolean

  /** Whether a `SABR_REDIRECT` part was received. */
  sabrRedirect: boolean

  /** Whether a `SABR_CONTEXT_UPDATE` part was received. */
  sabrContextUpdate: boolean

  /** Whether a `STREAM_PROTECTION_STATUS` part was received. */
  streamProtectionStatus: boolean
}

/**
 * Entry in the UMP part sequence log.
 *
 * Records each part type encountered in order during a response cycle,
 * used for debugging and traffic analysis.
 *
 * @internal
 */
export interface PartSequenceEntry {
  /** Numeric part type identifier. */
  type: number

  /** Human-readable name of the part type. */
  name: string

  /** Byte size of the part. */
  size: number
}

/**
 * Dumped part payload for traffic debugging.
 *
 * Captures the decoded content of non-media UMP parts
 * for inclusion in the traffic log file.
 *
 * @internal
 */
export interface PartDumpEntry {
  /** Numeric part type identifier. */
  type: number

  /** Human-readable name of the part type. */
  name: string

  /** Byte size of the part. */
  size: number

  /** SHA-256 hash of the raw payload bytes. */
  sha256: string

  /** Base64-encoded (possibly truncated) payload. */
  payloadB64: string

  /** Whether the base64 payload was truncated. */
  payloadB64Truncated: boolean

  /** Decoded protobuf object (when available). */
  decoded?: Record<string, unknown>
}

/**
 * Entry written to the SABR traffic log file.
 *
 * Captures request and response metadata for debugging
 * SABR streaming issues. Written in JSONL format.
 *
 * @internal
 */
export interface TrafficLogEntry {
  /** ISO 8601 timestamp of the event. */
  ts: string

  /** Traffic direction: client request or server response. */
  dir: 'client->yt' | 'yt->client'

  /** Request sequence number. */
  rn: number

  /** Target URL for requests. */
  url?: string

  /** HTTP status code for responses. */
  status?: number

  /** Whether the request/response was successful. */
  ok?: boolean

  /** HTTP status text for error responses. */
  statusText?: string

  /** Request body byte length. */
  requestBodyBytes?: number

  /** SHA-256 hash of the request body. */
  requestBodySha256?: string

  /** Base64-encoded request body (possibly truncated). */
  requestBodyB64?: string

  /** Whether the request body base64 was truncated. */
  requestBodyB64Truncated?: boolean

  /** Player time in milliseconds at request time. */
  playerTimeMs?: number | string

  /** Preferred audio itags for the request. */
  preferredAudioItags?: number[]

  /** Selected format itags for the request. */
  selectedItags?: number[]

  /** Buffered range summaries. */
  bufferedRanges?: Array<{
    itag?: number
    startMs: string
    durMs: string
    seg: [number, number]
  }>

  /** Playback cookie byte length. */
  cookieLen?: number

  /** SABR context summaries. */
  contexts?: Array<{ type: number; valueLen: number }>

  /** Unsent SABR context type identifiers. */
  unsentContexts?: number[]

  /** Response byte length. */
  responseBytes?: number

  /** SHA-256 hash of the response body. */
  responseSha256?: string

  /** Base64-encoded response body (possibly truncated). */
  responseBodyB64?: string

  /** Whether the response body base64 was truncated. */
  responseBodyB64Truncated?: boolean

  /** Content-Type header from the response. */
  contentType?: string

  /** Content-Length header from the response. */
  contentLength?: string

  /** Request round-trip duration in milliseconds. */
  durationMs?: number

  /** Part type counts from the response. */
  parts?: Record<string, number>

  /** Ordered sequence of parts received. */
  partSeq?: PartSequenceEntry[]

  /** Dumped part payloads (when traffic dump is enabled). */
  partDumps?: PartDumpEntry[]

  /** Saw flags indicating which part types were received. */
  saw?: SawFlags

  /** Error text from failed responses. */
  errorText?: string

  /** Policy summary from the response. */
  policy?: {
    backoffTimeMs: number
    cookieLen: number
    targetAudioReadaheadMs?: number
    minAudioReadaheadMs?: number
    maxTimeSinceLastRequestMs?: number
  }

  /** Allow additional logging properties. */
  [key: string]: unknown
}

/**
 * Summarized buffered range for debug logging.
 *
 * @internal
 */
export interface BufferedRangeSummary {
  /** Format identifier with itag and optional xtags. */
  formatId?: FormatIdMsg

  /** Start time in milliseconds. */
  startTimeMs?: string

  /** Duration in milliseconds. */
  durationMs?: string

  /** Starting segment index. */
  startSegmentIndex?: number

  /** Ending segment index. */
  endSegmentIndex?: number

  /** Time range with ticks and timescale. */
  timeRange?: {
    startTicks?: string
    durationTicks?: string
    timescale?: number
  }
}

/**
 * Parameters passed to `logDetailedState` for debug output.
 *
 * @internal
 */
export interface DetailedStateParams {
  /** Current ABR request state. */
  abrState?: AbrState

  /** Audio format being streamed. */
  audioFormat?: FormatEntry

  /** Video format being streamed (optional for audio-only). */
  videoFormat?: FormatEntry

  /** Format IDs selected for this request cycle. */
  selectedFormatIds?: FormatIdMsg[]

  /** Preferred audio format IDs. */
  preferredAudioFormatIds?: FormatIdMsg[]

  /** Preferred video format IDs. */
  preferredVideoFormatIds?: FormatIdMsg[]

  /** Current buffered ranges being reported. */
  bufferedRanges?: BufferedRangeSummary[]

  /** Active SABR contexts being sent. */
  contexts?: Array<{ type: number; value: Uint8Array }>

  /** SABR context types not being sent. */
  unsent?: number[]
}

/**
 * Multi-chunk byte buffer used by the UMP reader for zero-copy parsing.
 *
 * Wraps multiple `Uint8Array` chunks and provides position-based access
 * without requiring a contiguous memory allocation. The implementation
 * lives in {@link ../sabr.ts}; this declaration provides the type shape
 * for references within this module.
 *
 * @public
 */
export declare class CompositeBuffer {
  /** Ordered array of byte chunks. */
  chunks: Uint8Array[]

  /** Cumulative byte offset of the current chunk under focus. */
  currentChunkOffset: number

  /** Index of the current chunk under focus. */
  currentChunkIndex: number

  /** Total byte length across all chunks. */
  totalLength: number

  /** Constructs a CompositeBuffer from an optional array of chunks. */
  constructor(chunks?: Uint8Array[])

  /** Appends a byte chunk or merges another CompositeBuffer. */
  append(chunk: Uint8Array | CompositeBuffer): void

  /**
   * Splits the buffer at the given position.
   * @returns Object with `extractedBuffer` (before position) and `remainingBuffer` (after position).
   */
  split(position: number): {
    extractedBuffer: CompositeBuffer
    remainingBuffer: CompositeBuffer
  }

  /** Returns true if `length` bytes are available starting from `position`. */
  canReadBytes(position: number, length: number): boolean

  /** Reads a single byte at the given position. */
  getUint8(position: number): number

  /** Returns the total byte length. */
  getLength(): number

  /** Advances the internal focus to the chunk containing `position`. */
  focus(position: number): void

  /** Resets focus to the first chunk. */
  resetFocus(): void
}
