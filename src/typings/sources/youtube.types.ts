/**
 * YouTube Source Type Definitions
 * Shared types for YouTube data processing across all YouTube clients.
 *
 * @packageDocumentation
 * @module YouTubeTypes
 */
import type { Readable } from 'node:stream'
import type {
  HttpRequestOptions,
  HttpRequestResult,
  NodelinkRuntime
} from '../utils.types.ts'
import type { ClientInfoMsg, PreviousSessionState } from './sabr.types.ts'
import type { TrackInfo } from './source.types.ts'

/**
 * YouTube URL type constants for classification.
 * @public
 */
export const YOUTUBE_CONSTANTS = {
  /** Regular YouTube video (watch URL) */
  VIDEO: 0,

  /** YouTube playlist (playlist URL with list parameter) */
  PLAYLIST: 1,

  /** YouTube Shorts video (short form content) */
  SHORTS: 2,

  /** Unknown or unsupported URL type */
  UNKNOWN: -1
} as const

/** Type representing valid YouTube URL type constants */
export type YOUTUBE_CONSTANTS_TYPE =
  (typeof YOUTUBE_CONSTANTS)[keyof typeof YOUTUBE_CONSTANTS]

/**
 * Interface for OAuth authentication manager.
 * Provides token management for authenticated YouTube API requests.
 *
 * @public
 */
export interface IOAuth {
  /**
   * Retrieves the current OAuth access token.
   * @returns Promise resolving to token string or null if not authenticated
   */
  getAccessToken(): Promise<string | null>

  /**
   * Retrieves authentication headers for API requests.
   * @returns Promise resolving to header key-value map
   */
  getAuthHeaders(): Promise<Record<string, string>>
}

/**
 * Interface for cached player script data.
 * Represents the JavaScript player script retrieved from YouTube.
 *
 * @public
 */
export interface ICachedPlayerScript {
  /** Full URL to the player script JS file */
  url: string

  /** Unix timestamp (ms) when the cached script expires */
  expireTimestampMs: number
}

/**
 * Interface for signature decipher/cipher manager.
 * Handles decryption of YouTube URL signatures for stream access.
 *
 * @public
 */
export interface ICipherManager {
  /**
   * Retrieves the cached player script, fetching if needed.
   * @returns Promise resolving to cached script or null if unavailable
   */
  getCachedPlayerScript(): Promise<ICachedPlayerScript | null>

  /**
   * Gets the signature timestamp for a given player URL.
   * @param playerUrl - URL of the player script
   * @returns Promise resolving to timestamp string
   */
  getTimestamp(playerUrl: string): Promise<string>

  /**
   * Resolves a stream URL by deciphering the signature if encrypted.
   * @param streamUrl - The stream URL to resolve
   * @param encryptedSignature - Encrypted signature string (if applicable)
   * @param nParam - The 'n' parameter from YouTube URL
   * @param signatureKey - Which signature parameter to use ('sig' or 'signature')
   * @param playerScript - The cached player script for deciphering
   * @param context - Optional YouTube API context
   * @returns Promise resolving to the deciphered stream URL
   */
  resolveUrl(
    streamUrl: string,
    encryptedSignature: string | null,
    nParam: string | null,
    signatureKey: string | null,
    playerScript: ICachedPlayerScript,
    context?: YouTubeContext
  ): Promise<string>
}

/**
 * YouTube internal client context passed to every innertube API call.
 * Simulates different device configurations for YouTube API requests.
 *
 * @example
 * ```typescript
 * const context: YouTubeContext = {
 *   client: {
 *     hl: 'en',
 *     gl: 'US',
 *     visitorData: 'CgtvK8...',
 *     clientName: 'WEB',
 *     clientVersion: '2.20251030.01.00'
 *   }
 * };
 * ```
 *
 * @public
 */
export interface YouTubeContext {
  /**
   * Simulated client device metadata.
   * YouTube uses this to return device-specific content and formats.
   */
  client: {
    /**
     * Screen density (float) reported to the innertube API.
     * @example 1.0, 1.5, 2.0 for retina displays
     */
    screenDensityFloat?: number

    /**
     * Screen height in points reported to the innertube API.
     * @example 1080
     */
    screenHeightPoints?: number

    /**
     * Device pixel density ratio.
     * @example 1, 1.5, 2
     */
    screenPixelDensity?: number

    /**
     * Screen width in points reported to the innertube API.
     * @example 1920
     */
    screenWidthPoints?: number

    /**
     * Host language code for localization.
     * @example 'en', 'es', 'ja', 'pt-BR'
     */
    hl: string

    /**
     * Geographic region code for content geo-restrictions.
     * @example 'US', 'BR', 'JP', 'GB'
     */
    gl: string

    /**
     * Visitor data token refreshed periodically from YouTube embed pages.
     * Used for tracking session state and recommendations.
     */
    visitorData: string | null

    /**
     * Client name identifying the YouTube client variant.
     * @example 'WEB', 'ANDROID', 'IOS', 'TV', 'WEB_EMBEDDED_PLAYER'
     */
    clientName?: string

    /**
     * Client version for API compatibility.
     * @example '2.20251030.01.00'
     */
    clientVersion?: string

    /**
     * Platform identifier for the client.
     * @example 'DESKTOP', 'MOBILE', 'TV'
     */
    platform?: string

    /**
     * Operating system name identifier.
     * @example 'Windows', 'Android', 'iOS', 'Linux'
     */
    osName?: string

    /**
     * UTC offset in minutes relative to GMT.
     * @example 0, -180, 120
     */
    utcOffsetMinutes?: number

    /**
     * Operating system version string.
     * @example '10.0', '13', '14.1'
     */
    osVersion?: string

    /**
     * User agent string sent with API requests.
     * @example 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)...'
     */
    userAgent?: string

    /**
     * Client form factor.
     */
    clientFormFactor?: string

    /**
     * User interface theme.
     */
    userInterfaceTheme?: string

    /**
     * Browser name.
     */
    browserName?: string

    /**
     * Browser version string.
     */
    browserVersion?: string
  }
}

/**
 * Context structure returned by getClient() in BaseClient.
 * Used internally by YouTube innertube clients for API requests.
 *
 * @internal
 */
export interface YouTubeClientContext {
  /** Client identification and configuration */
  client: {
    /** Client identifier name */
    clientName: string

    /** Client version string */
    clientVersion: string

    /** Platform identifier */
    platform?: string

    /** User agent for HTTP requests */
    userAgent: string

    /** Host language code */
    hl: string

    /** Geographic region code */
    gl: string

    /** Visitor tracking data token */
    visitorData?: string | null

    /** Allow additional unknown properties */
    [key: string]: unknown
  }

  /** User-specific settings and preferences */
  user?: {
    /** Whether restricted mode is enabled */
    lockedSafetyMode?: boolean

    /** Allow additional unknown properties */
    [key: string]: unknown
  }

  /** Request-specific configuration */
  request?: {
    /** Whether to use SSL for requests */
    useSsl?: boolean

    /** Allow additional unknown properties */
    [key: string]: unknown
  }

  /** Allow additional unknown top-level properties */
  [key: string]: unknown
}

/**
 * Thumbnail image data from YouTube API responses.
 * Represents different thumbnail sizes available for videos/channels.
 *
 * @example
 * ```typescript
 * const thumb: YouTubeThumbnail = {
 *   url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/default.jpg',
 *   width: 120,
 *   height: 90
 * };
 * ```
 *
 * @internal
 */
export interface YouTubeThumbnail {
  /** Full URL to the thumbnail image */
  url: string

  /** Width of the thumbnail in pixels */
  width?: number

  /** Height of the thumbnail in pixels */
  height?: number
}

/**
 * A single text run within a formatted YouTube text element.
 * Supports linked/navigable text segments.
 *
 * @internal
 */
export interface YouTubeTextRun {
  /** The text content of this run segment */
  text: string

  /**
   * Navigation endpoint for clickable/hyperlinked text.
   * Contains action data for when user clicks the link.
   */
  navigationEndpoint?: unknown
}

/**
 * YouTube text content structure supporting both simple and rich text.
 * Can contain formatted runs with navigation or simple plain text.
 *
 * @example
 * ```typescript
 * // Rich text with links
 * const richText: YouTubeText = {
 *   runs: [
 *     { text: 'Click ', navigationEndpoint: {...} },
 *     { text: 'here', navigationEndpoint: {...} },
 *     { text: ' for more info' }
 *   ]
 * };
 *
 * // Simple text
 * const simpleText: YouTubeText = {
 *   simpleText: 'Simple text content'
 * };
 * ```
 *
 * @internal
 */
export interface YouTubeText {
  /** Array of formatted text runs with optional navigation */
  runs?: YouTubeTextRun[]

  /** Simple plain text without formatting */
  simpleText?: string
}

/**
 * Common YouTube item renderer structure for search results and playlists.
 * Used throughout YouTube API responses to represent videos, channels, playlists.
 *
 * @example
 * ```typescript
 * const renderer: YouTubeRenderer = {
 *   videoId: 'dQw4w9WgXcQ',
 *   title: { simpleText: 'Never Gonna Give You Up' },
 *   author: 'RickAstley',
 *   lengthText: { simpleText: '3:33' },
 *   thumbnail: {
 *     thumbnails: [{ url: 'https://i.ytimg.com/vi/xxx/default.jpg' }]
 *   }
 * };
 * ```
 *
 * @public
 */
export interface YouTubeRenderer {
  /** YouTube video identifier (11 character ID) */
  videoId?: string

  /** YouTube playlist identifier */
  playlistId?: string

  /** YouTube channel identifier */
  channelId?: string

  /** Video/channel/playlist title (string or rich text format) */
  title?: string | YouTubeText

  /** Author/creator name (for videos: channel name) */
  author?: string

  /** Thumbnail image data */
  thumbnail?: {
    /** Array of available thumbnail sizes */
    thumbnails?: YouTubeThumbnail[]

    /** Music-specific thumbnail renderer */
    musicThumbnailRenderer?: {
      thumbnail?: {
        thumbnails?: YouTubeThumbnail[]
      }
    }
  }

  /** Length text (e.g., "3:33" or "1:23:45") */
  lengthText?: YouTubeText

  /** Length in seconds (string or number) */
  lengthSeconds?: string | number

  /** Whether this is a live stream */
  isLive?: boolean

  /** Short byline text (channel name for search results) */
  shortBylineText?: YouTubeText

  /** Long byline text (full channel name) */
  longBylineText?: YouTubeText

  /** Owner text (channel name for video owner) */
  ownerText?: YouTubeText

  /** View count text (e.g., "1M views") */
  viewCountText?: YouTubeText

  /** Short view count text (abbreviated) */
  shortViewCountText?: YouTubeText

  /** Published time text (e.g., "2 years ago") */
  publishedTimeText?: YouTubeText

  /** Video count text (for channels/playlists) */
  videoCountText?: YouTubeText

  /** Subscriber count text (for channels) */
  subscriberCountText?: YouTubeText

  /** Video count number (for channels) */
  videoCount?: string | number

  /** Subscriber count (for channels) */
  subscriberCount?: string | number

  /** Handle/username (for channels with custom URLs) */
  handle?: string

  /** Display name (for channel) */
  displayName?: YouTubeText

  /** Attributed title with link data */
  attributedTitle?: {
    content: string
  }

  /** Flex columns for layout (used in music items) */
  flexColumns?: Array<{
    musicResponsiveListItemFlexColumnRenderer?: {
      text?: YouTubeText
    }
  }>

  /** Internal type marker ('track', 'playlist', 'channel') */
  _type?: string

  /** Channel renderer for nested channel data */
  channelRenderer?: YouTubeRenderer

  /** Owner badges (verified, official artist, etc.) */
  ownerBadges?: unknown[]

  /** Accessibility data for screen readers */
  accessibility?: {
    accessibilityData: {
      label: string
    }
  }

  /** Element renderer for new UI components */
  elementRenderer?: {
    newElement?: {
      type?: {
        componentType?: {
          model?: {
            /** Compact channel model for browse endpoints */
            compactChannelModel?: {
              compactChannelData?: YouTubeRenderer
            }
            /** Compact playlist model for browse endpoints */
            compactPlaylistModel?: {
              compactPlaylistData?: YouTubeRenderer
            }
          }
        }
      }
    }
  }

  /** Channel video player renderer (featured video on channel) */
  channelVideoPlayerRenderer?: {
    videoId: string
    title?: YouTubeText
    description?: YouTubeText
  }

  /** Allow additional unknown properties from YouTube API */
  [key: string]: unknown
}

/**
 * YouTube API Player response structure.
 * Represents the full response from the innertube player endpoint.
 * Contains video details, streaming data, captions, and playability status.
 *
 * @example
 * ```typescript
 * const response: YouTubePlayerResponse = {
 *   videoDetails: {
 *     videoId: 'dQw4w9WgXcQ',
 *     title: 'Never Gonna Give You Up',
 *     author: 'RickAstley',
 *     keywords: ['rickroll', 'funny'],
 *     isLiveContent: false
 *   },
 *   streamingData: {
 *     formats: [...],
 *     adaptiveFormats: [...]
 *   },
 *   playabilityStatus: {
 *     status: 'OK'
 *   }
 * };
 * ```
 *
 * @public
 */
export interface YouTubePlayerResponse {
  /** Core video metadata */
  videoDetails?: {
    /** Unique 11-character video identifier */
    videoId: string

    /** Video title */
    title: string

    /** Channel name/uploader */
    author: string

    /** View count as string or number */
    viewCount?: string | number

    /** Video keywords/tags */
    keywords?: string[]

    /** Video description (first 2000 chars) */
    shortDescription?: string

    /** Whether content is a live stream */
    isLiveContent?: boolean

    /** Channel identifier */
    channelId?: string

    /** Video thumbnail images */
    thumbnail?: {
      thumbnails: YouTubeThumbnail[]
    }

    /** Publish date (ISO 8601) */
    publishDate?: string

    /** Allow additional unknown properties */
    [key: string]: unknown
  }

  /** Microformat data for video page */
  microformat?: {
    playerMicroformatRenderer: {
      title: YouTubeText | string
      ownerChannelName: string
      publishDate?: string
      uploadDate?: string
      category?: string
      likeCount?: string | number
      [key: string]: unknown
    }
    microformatDataRenderer: {
      urlCanonical: string
      title: string
      description: string
      thumbnail: unknown[]
      siteName: string
      appName: string
      androidPackage: string
      iosAppStoreId: string
      iosAppArguments: string
      ogType: string
      urlApplinksIos: string
      urlApplinksAndroid: string
      urlTwitterIos: string
      urlTwitterAndroid: string
      twitterCardType: string
      twitterSiteHandle: string
      schemaDotOrgType: string
      noindex: boolean
      unlisted: boolean
      paid: boolean
      familySafe: boolean
      availableCountries: unknown[]
      pageOwnerDetails: Record<string, unknown>
      videoDetails: Record<string, unknown>
      linkAlternates: unknown[]
      viewCount: string
      publishDate: string
      category: string
      uploadDate: string
      [key: string]: unknown
    }
  }

  /** Playability status for the video */
  playabilityStatus?: {
    /** Status code (OK, LOGIN_REQUIRED, UNPLAYABLE, etc.) */
    status: string

    /** Human-readable reason if not playable */
    reason?: string

    /** Allow additional unknown properties */
    [key: string]: unknown
  }

  /** Streaming data with format information */
  streamingData?: {
    /** Legacy streaming formats */
    formats?: unknown[]

    /** Adaptive streaming formats (DASH) */
    adaptiveFormats?: string[]

    /** HLS manifest URL for live streams */
    hlsManifestUrl?: string

    /** Server-side ABR streaming URL */
    serverAbrStreamingUrl?: string

    /** Allow additional unknown properties */
    [key: string]: unknown
  }

  /** Available caption tracks */
  captions?: Record<string, unknown>

  /** Response context with visit tracking data */
  responseContext?: Record<string, unknown>

  /** Error information if request failed */
  error?: {
    message: string
    [key: string]: unknown
  }

  /** Allow additional unknown properties */
  [key: string]: unknown
}

/**
 * Interface for published date information.
 * @public
 */
export interface PublishedAtInfo {
  /** Original text from YouTube (e.g. "2 years ago") */
  original: string

  /** Approximate Unix timestamp in milliseconds */
  timestamp: number

  /** ISO 8601 date string */
  date: string

  /** Human readable relative time (e.g. "2 years ago") */
  readable: string

  /** Compact duration string (e.g. "2y 0mo 0w 0d 0h 0m 0s") */
  compact: string

  /** Breakdown of time units ago */
  ago: {
    years: number
    months: number
    weeks: number
    days: number
    hours: number
    minutes: number
    seconds: number
  }
}

/**
 * Channel information retrieved from YouTube.
 * @public
 */
export interface YouTubeChannelInfo {
  /** URL to the channel's icon/avatar */
  icon: string | null

  /** URL to the channel's banner image */
  banner: string | null

  /** Subscriber count information */
  subscribers: {
    original: string
    count: number | null
    formatted: string
  } | null

  /** Whether the channel is verified */
  verified: boolean

  /** Channel description text */
  description: string | null

  /** List of external links from the channel header */
  links: string[]

  /** Number of videos on the channel */
  videoCount?: {
    original: string
    count: number | null
    formatted: string
  }

  /** Featured video on the channel page */
  featuredVideo?: {
    id: string
    url: string
    title: string | null
    description: string | null
  }
}

/**
 * External links extracted from a video description.
 * @public
 */
export interface ExternalLinks {
  spotify?: string | null
  spotifyId?: {
    type: string
    id: string
  }
  appleMusic?: string | null
  soundcloud?: string | null
  bandcamp?: string | null
  deezer?: string | null
  tidal?: string | null
  amazonMusic?: string | null
  youtubeMusic?: string | null
  website?: string | null
  other?: string[]
}

/**
 * Video quality information.
 * @public
 */
export interface VideoQuality {
  quality: string
  bitrate: number
  fps: number | null
  mimeType: string | null
  width: number | null
  height: number | null
  codec: string
  itag: number
  container: string | null
  averageBitrate: number | null
  contentLength: string | number | null
}

/**
 * Audio format information.
 * @public
 */
export interface AudioFormat {
  itag: number
  mimeType: string
  bitrate: number
  averageBitrate: number | null
  audioQuality: string | null
  audioSampleRate: string | null
  audioChannels: number | null
  codec: string
  container: string | null
  contentLength: string | number | null
  loudnessDb: number | null
}

/**
 * Multilingual audio track information.
 * @public
 */
export interface AudioTrack {
  id: string
  name: string
  isDefault: boolean
  isAutoDubbed: boolean
}

/**
 * Video caption track information.
 * @public
 */
export interface CaptionTrack {
  languageCode: string
  name: string | undefined
  isTranslatable: boolean
  baseUrl: string
  kind: string | undefined
}

/**
 * Typedef for the HTTP request utility function.
 * Wraps the internal makeRequest with YouTube-specific typing.
 *
 * @param urlString - The full URL to request
 * @param options - HTTP request options (method, headers, body, etc.)
 * @param nodelink - Optional NodeLink runtime context
 * @returns Promise resolving to HTTP request result with body, status, etc.
 *
 * @example
 * ```typescript
 * const result = await makeRequestFn('https://youtube.com/api', {
 *   method: 'GET',
 *   headers: { 'Authorization': 'Bearer token' }
 * });
 * ```
 *
 * @public
 */
export type MakeRequestFn = (
  urlString: string,
  options: HttpRequestOptions,
  nodelink?: NodelinkRuntime
) => Promise<HttpRequestResult>

/**
 * Internal state tracked for each proxy in the pool.
 *
 * Each entry maintains health metrics (score, failures, latency) that
 * the proxy manager uses to rank and select proxies.
 *
 * @public
 */
export interface ProxyEntry {
  /** Full proxy URL (e.g. `http://host:port` or `https://host`). */
  url: string
  /** Proxy protocol type. */
  type: 'forward' | 'reverse'
  /** Consecutive failure count since the last successful request. */
  failures: number
  /** Unix epoch timestamp (ms) of the most recent failure. */
  lastFailure: number
  /** Number of in-flight requests currently using this proxy. */
  activeRequests: number
  /** Health score between 0 and 100. */
  score: number
  /** Exponentially-weighted moving average latency in milliseconds. */
  latency: number
}

/**
 * Immutable snapshot of a {@link ProxyEntry} returned by the proxy manager.
 *
 * Callers hold a shallow copy so they can report success/failure back
 * without mutating the internal pool entry.
 *
 * @public
 */
export type ProxySnapshot = ProxyEntry

/**
 * Raw proxy configuration accepted by the constructor.
 *
 * Accepts either a plain URL string (defaults to `forward` type) or an
 * object with an explicit `url` and optional `type` override.
 *
 * @public
 */
export type RawProxyInput = string | { url: string; type?: string }

/**
 * Per-source YouTube configuration pulled from `nodelink.options.sources.youtube`.
 *
 * This interface defines all user-configurable options for the YouTube source,
 * including proxy settings, client selection, and feature flags.
 *
 * @public
 */
export interface YouTubeSourceConfig {
  /** List of proxy endpoints used for load-balanced requests. */
  proxies?: RawProxyInput[]
  /** Named client groups used for different operations. */
  clients: {
    /** Client names tried in order for search operations. */
    search: string[]
    /** Client names tried in order for URL resolution. Falls back to `playback` when omitted. */
    resolve?: string[]
    /** Client names tried in order for track URL / playback resolution. */
    playback: string[]
  }
  /** Ordered list of fallback source names tried when YouTube clients fail to resolve a track URL. */
  fallbackSources?: string[]
  /** Maximum number of search results to return. */
  maxSearchResults?: number
  /** Maximum number of tracks loaded from album/playlist URLs. */
  maxAlbumPlaylistLength?: number
  /** When `true`, enables enriched "Holo" track metadata resolution via the Web client player API. */
  enableHoloTracks?: boolean
  /** When `true`, resolves external links embedded in YouTube descriptions during track resolution. */
  resolveExternalLinks?: boolean
  /** When `true`, fetches channel information (avatar, subscriber count) during Holo resolution. */
  fetchChannelInfo?: boolean
  /** When `true`, official albums (OLAK) are resolved via an internal audio-only mirror search to ensure gapless playback. */
  mirrorOfficialAlbums?: boolean
  /** Allow additional unknown configuration keys for forward compatibility. */
  [key: string]: unknown
}

/**
 * Lightweight cancel token shared between stream producers and consumers.
 *
 * Setting `aborted` to `true` signals all cooperating callbacks to stop
 * producing data and release resources.
 *
 * @public
 */
export interface CancelSignal {
  /** Whether the associated stream operation has been cancelled. */
  aborted: boolean
}

/**
 * Result returned from `getTrackUrl` before caching.
 *
 * This interface represents the data structure returned when resolving a track URL
 * from YouTube. It contains various properties depending on the streaming protocol
 * used (direct URL, SABR, or HLS).
 *
 * @public
 */
export interface TrackUrlData {
  /** Direct playback URL for the track (used with HTTP/RTMP protocols). */
  url?: string
  /**
   * Streaming protocol identifier (e.g., 'http', 'https', 'sabr', 'hls').
   * Accepts `null` from JS clients that explicitly clear the field; callers
   * should treat `null` as absent.
   */
  protocol?: string | null
  /**
   * Media container format (e.g., 'm4a', 'webm/opus', 'mpegts').
   * Accepts `null` from JS clients that explicitly clear the field.
   */
  format?: string | null
  /** HLS manifest URL for HLS streaming protocol. */
  hlsUrl?: string | null
  /** Array of available format entries with their metadata. */
  formats?: FormatEntry[]
  /** The specific itag used for this track URL. */
  itag?: number
  /** Additional metadata attached to the track URL (content length, proxy info, access tokens, etc.). */
  additionalData?: Record<string, unknown>
  /** New track information when resolution redirects to a different track (e.g., fallback sources). */
  newTrack?: { info: TrackInfo }
  /** Exception details when the track URL resolution fails. */
  exception?: {
    /** Human-readable error message describing what went wrong. */
    message: string
    /** Error severity level ('common', 'fault', etc.). */
    severity: string
    /** Optional cause of the error (e.g., 'Upstream', 'Input', 'NoVideoDetails'). */
    cause?: string
    /** HTTP status code if the error was caused by an HTTP request failure. */
    status?: number
  }
  /** Allow additional properties for future extensibility. */
  [key: string]: unknown
}

/**
 * Minimal format descriptor used during URL selection.
 *
 * Each entry represents a single stream quality variant returned by the
 * YouTube innertube API. The `itag` field uniquely identifies the format
 * and is used by clients to request specific audio/video streams.
 *
 * @public
 */
export interface FormatEntry {
  /** YouTube format identifier (itag number). */
  itag: number
  /** MIME type string for the format. */
  mimeType?: string
  /** Average bitrate in bits per second for this format variant. */
  bitrate?: number
  /** Audio track identifier for multilingual audio. */
  audioTrackId?: string
  /** Allow additional format-specific properties for forward compatibility. */
  [key: string]: unknown
}

/**
 * Result returned from the stream loader.
 *
 * Contains either a readable `stream` with optional `type`, or an
 * `exception` describing why stream loading failed.
 *
 * @public
 */
export interface StreamResult {
  /**
   * Readable stream for audio data, augmented with protocol-specific properties.
   */
  stream?: Readable & {
    /** Raw HTTP response stream (direct HTTP streams only). */
    responseStream?: Readable
    /** Underlying SABR stream instance (SABR protocol only). */
    _sabrStream?: unknown
    /** Pauses SABR requests and returns state for a seek replacement. */
    beginSeekHandoff?: () => Promise<unknown>
    /** Resumes SABR requests when a seek replacement fails. */
    cancelSeekHandoff?: () => void
    /** Destroys the stream and releases all associated resources. */
    destroy: (err?: Error) => void
  }
  /** Detected media type string (e.g. `'m4a'`, `'webm/opus'`, `'mpegts'`). */
  type?: string
  /** Exception details when stream loading fails. */
  exception?: {
    /** Human-readable error message. */
    message: string
    /** Error severity level (`'common'`, `'fault'`, etc.). */
    severity: string
    /** Optional cause identifier (e.g. `'Upstream'`). */
    cause?: string
  }
}

/**
 * Additional data attached to a cached or returned track URL.
 *
 * Carries protocol-specific metadata needed by the stream loader
 * to establish the audio stream (proxy info, SABR tokens, content length, etc.).
 *
 * @public
 */
export interface TrackUrlAdditionalData {
  /** Total content length in bytes for the media resource, or `null` when unknown. */
  contentLength?: number | null
  /** Proxy snapshot used during URL resolution, for latency reporting and cache validation. */
  proxy?: ProxySnapshot
  /** SABR access token required for SABR streaming protocol. */
  accessToken?: string
  /** Visitor data token included in SABR session initialization. */
  visitorData?: string
  /** Server-side ABR streaming URL used to establish SABR sessions. */
  serverAbrStreamingUrl?: string
  /** Video playback ustreamer configuration blob used by SABR for media serving. */
  videoPlaybackUstreamerConfig?: string | Uint8Array
  /** Proof-of-origin token required by SABR for bot-detection bypass. */
  poToken?: string | Uint8Array
  /** Client identification metadata passed to SABR session initialization. */
  clientInfo?: ClientInfoMsg
  /** Available format entries used by SABR to select audio quality. */
  formats?: FormatEntry[]
  /** The specific itag used for this track URL. */
  itag?: number
  /** Start time offset in seconds for SABR stream initialization. */
  startTime?: number
  /** Position callback used by SABR to report playback progress. */
  positionCallback?: (positionMs: number) => void
  /** Callback used by SABR to stop its playhead while playback is paused. */
  playbackPaused?: () => boolean
  /** Previous SABR session state for session continuation. */
  previousSession?: PreviousSessionState
  /** Unique key identifying this stream in the active streams map. */
  streamKey?: string | symbol
  /** User-Agent header value for SABR HTTP requests. */
  userAgent?: string
  /** Playback cookie used for authenticated SABR sessions. */
  playbackCookie?: string | Uint8Array
  /** Allow additional properties for future extensibility. */
  [key: string]: unknown
}

/**
 * Map of client class names to their constructors.
 *
 * Uses a loose constructor signature because the actual client classes are
 * plain-JS files whose constructor arities vary and whose return types are
 * inferred as `any`.
 *
 * @public
 */
// biome-ignore lint/suspicious/noExplicitAny: intentional loose type for JS client classes
export type ClientClassMap = Record<string, new (...args: any[]) => any>
