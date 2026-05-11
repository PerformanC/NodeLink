import type { Agent as HttpAgent, IncomingHttpHeaders } from 'node:http'
import type { IncomingHttpHeaders as Http2IncomingHttpHeaders } from 'node:http2'
import type { Agent as HttpsAgent } from 'node:https'
import type { TrackModifierExtension } from './index.types.ts'
import type { StatsManager } from './sources/source.types.ts'

/**
 * Parsed semantic version components.
 *
 * Provides structured access to the major/minor/patch numbers as well as
 * pre-release and build metadata segments.
 * @public
 */
export interface SemverInfo {
  /** Major version number (breaking changes). */
  major: number
  /** Minor version number (feature releases). */
  minor: number
  /** Patch version number (bug fixes). */
  patch: number
  /** Pre-release identifiers split by dots (e.g., "beta.1"). */
  prerelease: string[]
  /** Build metadata identifiers split by dots (e.g., "build.123"). */
  build: string[]
}

/**
 * Git repository metadata snapshot.
 *
 * Used for diagnostics, logs, and update checks.
 * @public
 */
export interface GitInfo {
  /** Current branch name (e.g., "main"). */
  branch: string
  /** Short commit hash (e.g., "a1b2c3d"). */
  commit: string
  /** Commit timestamp in milliseconds since epoch. */
  commitTime: number
}

/**
 * Proxy settings for outbound HTTP requests.
 *
 * When provided, requests are routed through the proxy and optional
 * credentials are injected into the proxy URL.
 * @public
 */
export interface HttpProxyConfig {
  /** Proxy URL (http/https). */
  url: string
  /** Optional proxy username for basic auth. */
  username?: string
  /** Optional proxy password for basic auth. */
  password?: string
  /** Proxy type. 'reverse' uses URL prefixing. */
  type?: 'reverse' | 'forward'
}

/**
 * Header map for outbound HTTP requests.
 *
 * Header values may be normalized into arrays by lower-level APIs.
 * @public
 */
export type HttpRequestHeaders = Record<string, string | number | string[]> & {
  /** Cookie header value (lowercase). */
  cookie?: string
  /** Cookie header value (capitalized). */
  Cookie?: string
}

/**
 * SponsorBlock segment metadata returned by the API.
 */
export interface SponsorBlockSegment {
  uuid: string
  start: number
  end: number
  category: string
  actionType: string
  votes: number
  locked: boolean
  videoDuration: number
  description: string
}

/**
 * Options for HTTP requests executed by NodeLink utilities.
 * Includes retry, redirect, proxy, and compression settings.
 * @public
 */
export interface HttpRequestOptions {
  /** HTTP method (GET, POST, etc.). */
  method?: string
  /** Request headers. */
  headers?: HttpRequestHeaders
  /** Request body payload (string, buffer, or JSON-serializable object). */
  body?: string | Buffer | Uint8Array | Record<string, unknown>
  /** Request timeout in milliseconds. */
  timeout?: number
  /** Returns a stream without buffering the body. */
  streamOnly?: boolean
  /** Disables request body compression. */
  disableBodyCompression?: boolean
  /** Maximum number of redirects to follow. */
  maxRedirects?: number
  /** Local interface address to bind to. */
  localAddress?: string
  /** Custom HTTP agent override. */
  agent?: HttpAgent | HttpsAgent
  /** Internal redirect counter used by redirect handlers. */
  _redirectsFollowed?: number
  /** Forces response body to be returned as a Buffer. */
  responseType?: 'buffer'
  /** Maximum buffered response body size in bytes for non-stream requests. */
  maxResponseBodyBytes?: number
  /** Maximum number of retry attempts for transient failures. */
  maxRetries?: number
  /** Proxy settings for the request. */
  proxy?: HttpProxyConfig
}

/**
 * Unified response headers returned by HTTP/1 and HTTP/2 helpers.
 * @public
 */
export type HttpResponseHeaders =
  | IncomingHttpHeaders
  | Http2IncomingHttpHeaders
  | Record<string, string | string[] | number | undefined>

/**
 * Response payload returned by the utility HTTP clients.
 *
 * When `streamOnly` is enabled, `stream` is populated instead of `body`.
 * @public
 */
export interface HttpRequestResult {
  /** HTTP status code. */
  statusCode?: number
  /** Response headers (HTTP/1 or HTTP/2). */
  headers?: HttpResponseHeaders
  /** Parsed response body (JSON or string). */
  body?: unknown
  /** Streaming response body when streaming mode is used. */
  stream?: NodeJS.ReadableStream
  /** The final URL after following redirects. */
  finalUrl?: string
  /** Error message when request fails. */
  error?: string
}

/**
 * Track information decoded from the base64 payload.
 * @public
 */
export interface EncodedTrackInfo {
  /** Track title. */
  title: string
  /** Track author/artist name. */
  author: string
  /** Track duration in milliseconds. */
  length: number
  /** Unique track identifier. */
  identifier: string
  /** Whether the track is seekable (inverse of isStream). */
  isSeekable: boolean
  /** Whether the track is a live stream. */
  isStream: boolean
  /** Track URI if available. */
  uri: string | null
  /** Artwork/thumbnail URL. */
  artworkUrl: string | null
  /** International Standard Recording Code. */
  isrc: string | null
  /** Source name (youtube, spotify, etc.). */
  sourceName: string
  /** Current playback position in milliseconds. */
  position: number
}

/**
 * Track payload used for encoding and decoding utilities.
 *
 * Mirrors the Lavalink-compatible encoded track structure.
 * @public
 */
export interface EncodedTrackPayload {
  /** Base64-encoded track string. */
  encoded: string
  /** Parsed track information. */
  info: EncodedTrackInfo
  /** Optional detail list decoded from the payload. */
  details: Array<string | null>
  /** Plugin metadata. */
  pluginInfo: Record<string, unknown>
  /** User data attached to the track. */
  userData: Record<string, unknown>
  /** Message flags encoded in the payload header. */
  messageFlags: number
}

/**
 * Track info input accepted by the encodeTrack helper.
 *
 * The only optional fields are `artworkUrl` and `isrc`, which
 * enable v3 payloads. All other fields are required.
 * @public
 */
export interface TrackEncodeInput {
  /** Track title. */
  title: string
  /** Track author/artist name. */
  author: string
  /** Track duration in milliseconds. */
  length: number
  /** Unique track identifier. */
  identifier: string
  /** Whether the track is seekable. */
  isSeekable: boolean
  /** Whether the track is a live stream. */
  isStream: boolean
  /** Track URI (required for v2+ payloads). */
  uri: string | null
  /** Artwork/thumbnail URL (enables v3 payloads). */
  artworkUrl?: string | null
  /** International Standard Recording Code (enables v3 payloads). */
  isrc?: string | null
  /** Source name (youtube, spotify, etc.). */
  sourceName: string
  /** Current playback position in milliseconds. */
  position: number
  /** Additional track details to encode. */
  details: Array<string | null>
}

/**
 * Runtime route planner helpers used by HTTP utilities.
 * @public
 */
export interface RoutePlannerRuntime {
  /** Returns an available IP address for outbound requests. */
  getIP?: () => string | null | undefined
  /** Marks an IP as banned when a remote responds with 429. */
  banIP?: (ip?: string) => void
  /** Available IP blocks. */
  ipBlocks?: Array<unknown>
  /** Banned IPs registry. */
  bannedIps?: Set<unknown> | Map<unknown, unknown>
}

/**
 * Runtime NodeLink instance shape used by utilities.
 * @public
 */
/**
 * Snapshot of worker statistics used for aggregated metrics.
 * @public
 */
export interface WorkerStatsSnapshot {
  /** Active players on the worker. */
  players?: number
  /** Active playing players on the worker. */
  playingPlayers?: number
  /** Memory stats for the worker. */
  memory?: {
    /** Used heap memory in bytes. */
    used?: number
    /** Allocated heap memory in bytes. */
    allocated?: number
  }
  /** CPU stats for the worker. */
  cpu?: {
    /** Average NodeLink CPU load. */
    nodelinkLoad?: number
  }
  /** Frame statistics for the worker. */
  frameStats?: {
    /** Frames sent to the voice connection. */
    sent?: number
    /** Frames filled with silence. */
    nulled?: number
    /** Expected frame count based on timing. */
    expected?: number
  }
}

/**
 * Minimal worker manager shape used by stats aggregation.
 * @public
 */
export interface WorkerManagerRuntime {
  /** Map of worker statistics keyed by worker ID. */
  workerStats: Map<number, WorkerStatsSnapshot>
}

/**
 * Runtime voice connection statistics accessor.
 * @public
 */
export interface PlayerConnectionRuntime {
  /** Packet counters exposed by the voice connection. */
  statistics?: VoiceConnectionStats
}

/**
 * Minimal player runtime shape used for stats aggregation.
 * @public
 */
export interface PlayerRuntime {
  /** Voice connection for the player. */
  connection: PlayerConnectionRuntime | null
}

/**
 * Minimal session runtime shape used for stats aggregation.
 * @public
 */
export interface SessionRuntime {
  /** Player manager containing active players. */
  players: {
    /** Map of players keyed by guild ID. */
    players: Map<string, PlayerRuntime>
  }
}

/**
 * Minimal NodeLink runtime shape used by utilities.
 * @public
 */
export interface NodelinkRuntime {
  /** Active session registry. */
  sessions: {
    /** Returns an iterator over session instances. */
    values: () => IterableIterator<SessionRuntime>
  }
  /** Global server statistics. */
  statistics: {
    /** Total active players. */
    players: number
    /** Total playing players. */
    playingPlayers: number
  }
  /** Optional worker manager instance. */
  workerManager?: WorkerManagerRuntime | null
  /** Optional extension registry. */
  extensions?: {
    /** Track modifier hooks applied before serialization. */
    trackModifiers?: TrackModifierExtension[]
  }
  /** Optional route planner instance. */
  routePlanner?: RoutePlannerRuntime
  /** Optional stats manager instance. */
  statsManager?: StatsManager
  /** Global HTTP proxy server options. */
  options?: {
    server?: {
      httpProxy?: {
        enabled: boolean
        url: string
        username?: string
        password?: string
      }
    }
  }
}

/**
 * Options for best match scoring.
 * @public
 */
export interface BestMatchOptions {
  /** Allowed duration difference as a ratio (0.15 = 15%). */
  durationTolerance?: number
  /** Whether explicit tracks are allowed. */
  allowExplicit?: boolean
}

/**
 * Track info used for best match scoring.
 * @public
 */
export interface BestMatchTrackInfo {
  /** Track title. */
  title: string
  /** Track author/artist name. */
  author: string
  /** Track duration in milliseconds. */
  length: number
  /** Track URI used for explicit checks. */
  uri?: string | null
}

/**
 * Track candidate used for best match scoring.
 * @public
 */
export interface BestMatchCandidate {
  /** Track metadata used for scoring. */
  info: BestMatchTrackInfo
}

/**
 * Logging configuration used by NodeLink utilities.
 * @public
 */
export interface LoggingConfig {
  /** Minimum log level to output. */
  level?: 'debug' | 'info' | 'warn' | 'error'
  /** File logging configuration. */
  file?: {
    /** Whether file logging is enabled. */
    enabled?: boolean
    /** Directory to store log files. */
    path?: string
    /** Rotation schedule for log files. */
    rotation?: 'session' | 'hourly' | 'daily'
    /** Time-to-live for log files in days. */
    ttlDays?: number
  }
  /** Debug category toggles. */
  debug?: Record<string, boolean> & {
    /** Enables all debug categories unless explicitly disabled. */
    all?: boolean
    /** Enables verbose network request/response logging. */
    network?: boolean
  }
}

/**
 * Frame statistics aggregated across players.
 * @public
 */
export interface ServerFrameStats {
  /** Frames sent to the voice connection. */
  sent: number
  /** Frames filled with silence. */
  nulled: number
  /** Missing frames compared to expected. */
  deficit: number
  /** Expected frame count based on timing. */
  expected: number
}

/**
 * Memory statistics snapshot.
 * @public
 */
export interface ServerMemoryStats {
  /** Free system memory in bytes. */
  free: number
  /** Used heap memory in bytes. */
  used: number
  /** Allocated heap memory in bytes. */
  allocated: number
  /** Total reservable system memory in bytes. */
  reservable: number
}

/**
 * CPU statistics snapshot.
 * @public
 */
export interface ServerCpuStats {
  /** Total CPU cores. */
  cores: number
  /** System load average. */
  systemLoad: number
  /** Average NodeLink CPU load. */
  nodelinkLoad: number
}

/**
 * Aggregated server stats payload.
 * @public
 */
export interface ServerStatsPayload {
  /** Total active players. */
  players: number
  /** Total playing players. */
  playingPlayers: number
  /** Process uptime in milliseconds. */
  uptime: number
  /** Memory stats snapshot. */
  memory: ServerMemoryStats
  /** CPU stats snapshot. */
  cpu: ServerCpuStats
  /** Frame statistics for active players. */
  frameStats: ServerFrameStats | null
}

/**
 * Voice connection frame statistics shape.
 * @public
 */
export interface VoiceConnectionStats {
  /** Total packets sent. */
  packetsSent?: number
  /** Total packets lost. */
  packetsLost?: number
  /** Expected packet count based on timing. */
  packetsExpected?: number
}
