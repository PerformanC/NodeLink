import type { Readable } from 'node:stream'

/**
 * Encryption key information for an HLS segment.
 * Used when segments are encrypted with AES-128 or SAMPLE-AES.
 *
 * @example
 * ```ts
 * const key: HLSSegmentKey = {
 *   method: 'AES-128',
 *   uri: 'https://example.com/key.bin',
 *   iv: Buffer.from('0123456789abcdef0123456789abcdef', 'hex')
 * }
 * ```
 * @public
 */
export interface HLSSegmentKey {
  /** Encryption method: 'AES-128', 'SAMPLE-AES', or 'NONE' */
  method?: string
  /** URI to fetch the encryption key */
  uri?: string
  /** Optional initialization vector for decryption */
  iv?: Buffer
}

/**
 * Initialization segment map information for fmp4 streams.
 * Required for fragmented MP4 playback to initialize the decoder.
 *
 * @example
 * ```ts
 * const map: HLSSegmentMap = {
 *   uri: 'https://example.com/init.mp4'
 * }
 * ```
 * @public
 */
export interface HLSSegmentMap {
  /** URI of the initialization segment */
  uri?: string
  /** Byte range when the initialization segment shares a media file */
  byteRange?: HLSByteRange | null
}

/**
 * Byte range specification for partial segment fetching.
 * Used with EXT-X-BYTERANGE tag in HLS playlists.
 *
 * @example
 * ```ts
 * const range: HLSByteRange = {
 *   length: 1024000,
 *   offset: 0
 * }
 * ```
 * @public
 */
export interface HLSByteRange {
  /** Length of the byte range in bytes */
  length: number
  /** Offset from the start of the resource */
  offset: number
}

/**
 * Single HLS segment with metadata.
 * Represents one entry in a media playlist.
 *
 * @example
 * ```ts
 * const segment: HLSSegment = {
 *   url: 'https://example.com/segment_001.ts',
 *   duration: 10.0,
 *   key: null,
 *   map: null,
 *   byteRange: null,
 *   sequence: 1,
 *   discontinuity: false
 * }
 * ```
 * @public
 */
export interface HLSSegment {
  /** Segment URL (absolute or relative) */
  url: string
  /** Segment duration in seconds from EXTINF tag */
  duration: number
  /** Encryption key info, null if unencrypted */
  key: HLSSegmentKey | null
  /** Map segment for fmp4, null if not fmp4 */
  map: HLSSegmentMap | null
  /** Byte range for partial fetch, null if full segment */
  byteRange: HLSByteRange | null
  /** Media sequence number */
  sequence: number
  /** Whether segment has EXT-X-DISCONTINUITY marker */
  discontinuity: boolean
}

/**
 * HLS variant stream from master playlist.
 * Represents one EXT-X-STREAM-INF entry.
 *
 * @example
 * ```ts
 * const variant: HLSVariant = {
 *   url: 'https://example.com/1080p/playlist.m3u8',
 *   bandwidth: 5000000,
 *   codecs: 'avc1.640028,mp4a.40.2',
 *   audio: 'audio-group-1'
 * }
 * ```
 * @public
 */
export interface HLSVariant {
  /** Variant playlist URL */
  url: string
  /** Bandwidth in bits per second */
  bandwidth: number
  /** Codecs string (e.g., 'mp4a.40.2' for AAC audio) */
  codecs?: string
  /** Audio group ID for alternate audio renditions */
  audio?: string
}

/**
 * Audio rendition entry from EXT-X-MEDIA tag.
 * Used for alternate audio tracks (e.g., different languages).
 *
 * @example
 * ```ts
 * const rendition: HLSAudioRendition = {
 *   uri: 'https://example.com/audio/english.m3u8',
 *   groupid: 'audio-group-1',
 *   language: 'en',
 *   name: 'English',
 *   default: 'YES'
 * }
 * ```
 * @public
 */
export interface HLSAudioRendition {
  /** Rendition playlist URI */
  uri?: string
  /** Group ID this rendition belongs to */
  groupid?: string
  /** Language code (ISO 639-1) */
  language?: string
  /** Human-readable rendition name */
  name?: string
  /** 'YES' if default rendition */
  default?: string
  /** 'YES' if should auto-select */
  autoselect?: string
}

/**
 * Parsed HLS master playlist structure.
 * Contains variant streams and audio renditions.
 *
 * @public
 */
export interface HLSMasterPlaylist {
  /** Always true for master playlists */
  isMaster: true
  /** Available variant streams sorted by bandwidth */
  variants: HLSVariant[]
  /** Audio rendition groups */
  audioGroups: Record<string, HLSAudioRendition[]>
}

/**
 * Parsed HLS media playlist structure.
 * Contains segments for a specific variant.
 *
 * @example
 * ```ts
 * const playlist: HLSMediaPlaylist = {
 *   isMaster: false,
 *   mediaSequence: 100,
 *   targetDuration: 10,
 *   isLive: true,
 *   segments: [...]
 * }
 * ```
 * @public
 */
export interface HLSMediaPlaylist {
  /** Always false for media playlists */
  isMaster: false
  /** Media sequence number from EXT-X-MEDIA-SEQUENCE */
  mediaSequence: number
  /** Target duration from EXT-X-TARGETDURATION */
  targetDuration: number
  /** True if no EXT-X-ENDLIST present (live stream) */
  isLive: boolean
  /** Playlist segments in order */
  segments: HLSSegment[]
}

/**
 * Union type for parsed HLS playlists.
 * Can be either master or media playlist.
 *
 * @public
 */
export type HLSPlaylist = HLSMasterPlaylist | HLSMediaPlaylist

/**
 * Fetch strategy for HLS segments.
 * - 'segmented': Download complete segments before playing (faster seeking)
 * - 'streaming': Stream segments progressively (lower latency)
 * - 'sequential': Download one at a time (minimal memory)
 *
 * @public
 */
export type HLSFetchStrategy = 'segmented' | 'streaming' | 'sequential'

/**
 * Options for creating an HLS handler.
 *
 * @example
 * ```ts
 * const options: HLSHandlerOptions = {
 *   strategy: 'streaming',
 *   startTime: 30000, // Start 30 seconds in
 *   headers: { 'Authorization': 'Bearer token' },
 *   highWaterMark: 1024 * 1024 * 10
 * }
 * ```
 * @public
 */
export interface HLSHandlerOptions {
  /** High water mark for stream buffer in bytes */
  highWaterMark?: number
  /** HTTP headers to include in requests */
  headers?: Record<string, string>
  /** Local address to bind network requests to */
  localAddress?: string | null
  /** Proxy configuration for requests */
  proxy?: {
    url: string
    username?: string
    password?: string
  } | null
  /** Backward-compatible network block used by some callers. */
  network?: {
    proxy?: {
      url: string
      username?: string
      password?: string
    } | null
  }
  /** Callback for URL resolution (e.g., signature decryption) */
  onResolveUrl?: ((url: string) => Promise<string | null>) | null
  /** Fetch strategy: 'segmented' | 'streaming' | 'sequential' */
  strategy?: HLSFetchStrategy
  /** Stream type hint (e.g., 'fmp4' triggers segmented mode) */
  type?: string
  /** Start time offset in milliseconds */
  startTime?: number
}

/**
 * Result of fetching an HLS segment.
 * Contains either buffered data or a readable stream.
 *
 * @public
 */
export interface HLSSegmentFetchResult {
  /** The segment that was fetched */
  segment: HLSSegment
  /** Segment data buffer (for segmented strategy) */
  data?: Buffer
  /** Segment readable stream (for streaming strategy) */
  stream?: Readable
}

/**
 * Options for the segment fetcher.
 *
 * @public
 */
export interface SegmentFetcherOptions {
  /** HTTP headers for segment requests */
  headers?: Record<string, string>
  /** Local address to bind to */
  localAddress?: string | null
  /** Proxy configuration */
  proxy?: {
    url: string
    username?: string
    password?: string
  } | null
  /** Backward-compatible network block used by some callers. */
  network?: {
    proxy?: {
      url: string
      username?: string
      password?: string
    } | null
  }
  /** URL resolution callback */
  onResolveUrl?: ((url: string) => Promise<string | null>) | null
}

/**
 * Options for fetching a segment.
 *
 * @public
 */
export interface FetchSegmentOptions {
  /** Whether to return a stream instead of buffer */
  stream?: boolean
}

/**
 * Parsed attributes from HLS playlist tags.
 * Key-value pairs from EXT-X-KEY, EXT-X-MAP, etc.
 *
 * @public
 */
export interface HLSAttributes {
  /** EXT-X-MEDIA TYPE attribute. */
  type?: string
  /** EXT-X-MEDIA GROUP-ID attribute. */
  groupid?: string
  /** EXT-X-STREAM-INF BANDWIDTH attribute. */
  bandwidth?: string
  /** EXT-X-STREAM-INF CODECS attribute. */
  codecs?: string
  /** EXT-X-STREAM-INF AUDIO attribute. */
  audio?: string
  /** URI attribute for EXT-X-MEDIA or EXT-X-KEY tags. */
  uri?: string
  /** IV attribute for EXT-X-KEY tags. */
  iv?: string | Buffer
  [key: string]: string | Buffer | undefined
}

/**
 * Byte range information with validation.
 *
 * @public
 */
export interface HLSByteRangeInfo {
  /** Length of the range */
  length: number
  /** Offset from start */
  offset: number
}
