/**
 * Type definitions for source worker
 * @module typings/source.types
 */

import type { Readable } from 'node:stream'
import type { Worker as NodeWorker } from 'node:worker_threads'
import type {
  StatsMetricsPayload,
  StatsSnapshot,
  WorkerMetricsPayload
} from '../api/stats.types.ts'
import type { NodelinkConfig } from '../config/config.types.ts'
import type {
  CredentialEntry,
  CredentialManagerStats
} from '../modules/credential.types.ts'
import type { LoggerFn, TrackInfoExtended } from '../playback/player.types.ts'
import type { TrackCacheEntry } from '../playback/trackCache.types.ts'

/**
 * Frame type identifier for socket communication protocol
 * @public
 */
export enum FrameType {
  /** Data chunk frame (0) - contains payload data */
  DATA = 0,
  /** End frame (1) - signals completion of transmission */
  END = 1,
  /** Error frame (2) - contains error message */
  ERROR = 2,
  /** Chat action frame (3) - contains live chat actions */
  CHAT_ACTION = 3
}

/**
 * Configuration for specialized source worker cluster
 * @public
 */
export interface SourceWorkerConfig {
  /** Number of micro-workers to spawn per source worker */
  microWorkers?: number
  /** Maximum tasks per micro-worker before queuing */
  tasksPerWorker?: number
  /** Queue/load threshold per active micro-worker to trigger scaling up */
  scaleUpThreshold?: number
  /** Minimum milliseconds between scale-up operations */
  scaleCooldownMs?: number
  /** Whether to suppress debug/info logs from micro-workers */
  silentLogs?: boolean
}

/**
 * Extended Worker with load tracking properties
 * @public
 */
export interface MicroWorker extends NodeWorker {
  /** Whether the worker is ready to receive tasks */
  ready: boolean
  /** Current number of active tasks on this worker */
  load: number
}

/**
 * Worker thread initialization data
 * @public
 */
export interface WorkerData {
  /** NodeLink configuration object */
  config: Record<string, unknown>
  /** Whether to silence debug/info logs */
  silentLogs: boolean
  /** Thread identifier (1-indexed) */
  threadId: number
}

/**
 * Base message structure for worker communication
 * @public
 */
export interface WorkerMessage {
  /** Message type identifier */
  type: string
}

/**
 * Message sent when worker becomes ready
 * @public
 */
export interface ReadyMessage extends WorkerMessage {
  type: 'ready'
  /** Process ID of the worker (optional, main thread only) */
  pid?: number
}

/**
 * Message containing task result
 * @public
 */
export interface ResultMessage extends WorkerMessage {
  type: 'result'
  /** Socket path for response */
  socketPath: string
  /** Task identifier */
  id: string
  /** JSON-stringified result data (mutually exclusive with error) */
  result?: string
  /** Error message (mutually exclusive with result) */
  error?: string
}

/**
 * Message containing stream data chunk
 * @public
 */
export interface StreamMessage extends WorkerMessage {
  type: 'stream'
  /** Socket path for streaming */
  socketPath: string
  /** Stream identifier */
  id: string
  /** Data chunk (Buffer or string) */
  chunk: Buffer | string
}

/**
 * Message containing live chat actions
 * @public
 */
export interface ChatActionMessage extends WorkerMessage {
  type: 'chatAction'
  /** Socket path for chat communication */
  socketPath: string
  /** Chat session identifier */
  id: string
  /** Live chat action data */
  data: {
    /** Operation type */
    op: 'actions'
    /** Array of chat actions/messages */
    actions: Array<Record<string, unknown>>
  }
}

/**
 * Message signaling stream end
 * @public
 */
export interface EndMessage extends WorkerMessage {
  type: 'end'
  /** Socket path */
  socketPath: string
  /** Stream identifier */
  id: string
}

/**
 * Message containing stream error
 * @public
 */
export interface ErrorMessage extends WorkerMessage {
  type: 'error'
  /** Socket path */
  socketPath: string
  /** Stream identifier */
  id: string
  /** Error message string */
  error: string
}

/**
 * Union type of all possible worker messages
 * @public
 */
export type WorkerMessageType =
  | ReadyMessage
  | ResultMessage
  | StreamMessage
  | ChatActionMessage
  | EndMessage
  | ErrorMessage

/**
 * Task data structure sent to micro-workers
 * @public
 */
export interface TaskData {
  /** Task identifier */
  id: string
  /** Task type */
  task: TaskType
  /** Task payload (task-specific data) */
  payload: TaskPayload
  /** Unix socket path for response */
  socketPath: string
}

/**
 * Supported task types for source workers
 * @public
 */
export type TaskType =
  | 'resolve'
  | 'search'
  | 'unifiedSearch'
  | 'loadLyrics'
  | 'loadMeaning'
  | 'loadChapters'
  | 'loadStream'
  | 'loadLiveChat'
  | 'cancelLiveChat'
  | 'profilerCommand'

/**
 * Base task payload structure
 * @public
 */
export interface BaseTaskPayload {
  /** Track information (for track-related tasks) */
  decodedTrackInfo?: TrackInfo
}

/**
 * Payload for resolve task
 * @public
 */
export interface ResolvePayload extends BaseTaskPayload {
  /** URL to resolve */
  url: string
}

/**
 * Payload for search task
 * @public
 */
export interface SearchPayload extends BaseTaskPayload {
  /** Source name to search */
  source: string
  /** Search query string */
  query: string
}

/**
 * Payload for unified search task
 * @public
 */
export interface UnifiedSearchPayload extends BaseTaskPayload {
  /** Search query string */
  query: string
}

/**
 * Payload for lyrics/meaning tasks
 * @public
 */
export interface LyricsPayload extends BaseTaskPayload {
  /** Decoded track information */
  decodedTrackInfo: TrackInfo
  /** Target language code (ISO 639-1) */
  language?: string
}

/**
 * Payload for load stream task
 * @public
 */
export interface LoadStreamPayload extends BaseTaskPayload {
  /** Decoded track information */
  decodedTrackInfo: TrackInfo
  /** Starting position in milliseconds */
  position?: number
  /** Volume level (0-1000, default 100) */
  volume?: number
  /** Audio filter configuration */
  filters?: Record<string, unknown>
}

/**
 * Payload for live chat task
 * @public
 */
export interface LiveChatPayload extends BaseTaskPayload {
  /** YouTube video ID */
  videoId: string
}

/**
 * Payload for cancel live chat task
 * @public
 */
export interface CancelChatPayload extends BaseTaskPayload {
  /** Chat session ID to cancel */
  id: string
}

/**
 * Payload for profiler commands executed by source micro-workers.
 * @public
 */
export interface ProfilerPayload extends BaseTaskPayload {
  action: string
  name?: string
  host?: string
  port?: number
  exposeWait?: boolean
}

/**
 * Union type of all task payloads
 * @public
 */
export type TaskPayload =
  | ResolvePayload
  | SearchPayload
  | UnifiedSearchPayload
  | LyricsPayload
  | LoadStreamPayload
  | LiveChatPayload
  | CancelChatPayload
  | ProfilerPayload
  | BaseTaskPayload

/**
 * Track information structure
 * @public
 */
export interface TrackInfo {
  /** Track identifier (Base64 encoded) */
  identifier: string
  /** Whether the track is seekable */
  isSeekable: boolean
  /** Track author/artist name */
  author: string
  /** Track duration in milliseconds */
  length: number
  /** Whether this is a live stream */
  isStream: boolean
  /** Track position in queue */
  position: number
  /** Track title */
  title: string
  /** Track source URI */
  uri: string
  /** Artwork/thumbnail URL */
  artworkUrl: string | null
  /** International Standard Recording Code */
  isrc: string | null
  /** Source name (e.g., 'youtube', 'spotify') */
  sourceName: string
}

/**
 * Result of track URL resolution
 * @public
 */
export interface TrackUrlResult {
  /** Resolved URL */
  url?: string
  /** Protocol type */
  protocol?: string
  /** Audio format */
  format?: string | { itag?: number; [key: string]: unknown }
  /** Updated track information (if changed) */
  newTrack?: {
    /** Updated track info */
    info: TrackInfo
  }
  /** Additional metadata for streaming */
  additionalData?: Record<string, unknown>
  /** Exception if resolution failed */
  exception?: {
    /** Error message */
    message: string
    /** Error severity level */
    severity: string
    /** Error cause */
    cause?: string
  }
}

/**
 * Result of track stream fetch
 * @public
 */
export interface TrackStreamResult {
  /** Readable stream of audio data */
  stream?: Readable
  /** MIME type or container format */
  type?: string
  /** Exception if fetch failed */
  exception?: {
    /** Error message */
    message: string
    /** Error severity level */
    severity: string
    /** Error cause */
    cause?: string
  }
}

/**
 * Live chat poll result
 * @public
 */
export interface LiveChatPollResult {
  /** Array of chat actions/messages */
  actions: Array<Record<string, unknown>>
  /** Milliseconds to wait before next poll */
  timeoutMs: number
}

/**
 * Complete track object returned by source methods.
 * @public
 */
export interface TrackData {
  /** Base64 encoded track. */
  encoded: string
  /** Normalized track metadata. */
  info: TrackInfo
  /** Source-specific metadata. */
  pluginInfo: Record<string, unknown>
  /** User-defined data, defaulted to an empty object in public responses. */
  userData?: unknown
}

/**
 * Complete playlist object returned by source methods.
 * @public
 */
export interface PlaylistData {
  /** Playlist metadata. */
  info: {
    /** Playlist name. */
    name: string
    /** Selected track index. */
    selectedTrack: number
  }
  /** Source-specific metadata. */
  pluginInfo: Record<string, unknown>
  /** Tracks in the playlist. */
  tracks: TrackData[]
}

/**
 * Result returned by search / resolve calls.
 * @public
 */
export type SourceResult =
  | { loadType: 'track' | 'episode'; data: TrackData }
  | {
      loadType: 'playlist' | 'album' | 'artist' | 'station' | 'podcast' | 'show'
      data: PlaylistData
    }
  | { loadType: 'search'; data: TrackData[] }
  | { loadType: 'empty'; data: Record<string, never> | null }
  | {
      loadType: 'error'
      exception: {
        message: string
        severity?: string
        cause?: string
        errors?: unknown[]
      }
    }

/**
 * Union of SourceResult variants that contain a `data` property.
 * @public
 */
export type SourceResultWithData = Exclude<SourceResult, { loadType: 'error' }>

/**
 * Represents a loaded source instance (e.g. YouTube, SoundCloud, HTTP).
 * @public
 */
export interface SourceInstance {
  /** Called once during initialization; returns true if ready. */
  setup?: () => Promise<boolean>
  /** Search for tracks by query. */
  search?: (
    query: string,
    sourceName?: string,
    searchType?: string
  ) => Promise<SourceResult>
  /** Resolve a URL to track/playlist data. */
  resolve?: (url: string, type?: string) => Promise<SourceResult>
  /** Get a playable URL for a track. */
  getTrackUrl?: (
    trackInfo: TrackInfo | TrackInfoExtended,
    itag?: number,
    isRecovering?: boolean
  ) => Promise<TrackUrlResult>
  /** Fetch an audio stream for a track. */
  loadStream?: (
    track: TrackInfo | TrackInfoExtended,
    url: string,
    protocol?: string,
    additionalData?: Record<string, unknown>
  ) => Promise<TrackStreamResult>
  /** Get chapters for a track (e.g. YouTube chapters). */
  getChapters?: (trackInfo: TrackInfo | TrackInfoExtended) => Promise<unknown[]>
  /** Additional source names that this source responds to. */
  additionalsSourceName?: string[]
  /** Search term prefixes (e.g. 'scsearch'). */
  searchTerms?: string[]
  /** Recommendation term prefixes. */
  recommendationTerm?: string[]
  /** URL regex patterns that this source handles. */
  patterns?: RegExp[]
  /** Priority for URL pattern matching (higher wins). */
  priority?: number
  /** Live chat handler (YouTube). */
  handleLiveChat?: (socket: unknown, videoId: string) => Promise<unknown>
  /** Live chat accessor (YouTube). */
  liveChat?: {
    /** Get live chat instance */
    getLiveChat: (videoId: string) => Promise<LiveChat | null>
  }
  /** OAuth credentials (source-specific). */
  oauth?: {
    refreshToken?: string | null
    accessToken?: string | null
    tokenExpiry?: number
    cleanup?: () => void
  }
  /** YouTube internal context. */
  ytContext?: { client?: { visitorData?: string | null } }
  /** Source-native seek (Deezer/SABR). */
  resolveHoloTrack?: (
    track: {
      info: TrackInfoExtended
      userData?: unknown
      [key: string]: unknown
    },
    options: { fetchChannelInfo?: boolean; resolveExternalLinks?: boolean }
  ) => Promise<{
    info: TrackInfoExtended
    userData?: unknown
    [key: string]: unknown
  } | null>
}

/**
 * Minimal NodeLink context for workers
 * @public
 */
export interface WorkerNodeLink {
  /** Configuration options */
  options: NodelinkConfig
  /** Logger function */
  logger: LoggerFn
  /** Source manager instance */
  sources?: SourceManager
  /** Lyrics manager instance */
  lyrics?: LyricsManager
  /** Meanings manager instance */
  meanings?: MeaningManager
  /** Credential manager instance */
  credentialManager?: CredentialManager
  /** Track cache manager instance */
  trackCacheManager?: TrackCacheManager
  /** Route planner manager instance */
  routePlanner?: RoutePlannerManager
  /** Proxy manager instance */
  proxyManager?: import('../../managers/proxyManager.ts').default
  /** Stats manager instance */
  statsManager?: StatsManager
  /** Global plugin manager for hook execution. */
  pluginManager?: import('../../managers/pluginManager.ts').default | null
  /** Catch-all for dynamic properties. */
  [key: string]: unknown
}

/**
 * Source manager interface (minimal)
 * @public
 */
export interface SourceManager {
  /** Resolve URL to track(s) */
  resolve: (url: string) => Promise<SourceResult>
  /** Search for tracks */
  search: (source: string, query: string) => Promise<SourceResult>
  /** Unified search across sources */
  unifiedSearch: (query: string) => Promise<SourceResult>
  /** Search using default search source */
  searchWithDefault: (query: string) => Promise<SourceResult>
  /** Get track URL */
  getTrackUrl: (
    track: TrackInfo | TrackInfoExtended,
    itag?: number,
    isRecovering?: boolean
  ) => Promise<
    TrackUrlResult & {
      protocol?: string
      format?: string | { itag?: number; [key: string]: unknown }
      trackInfo?: TrackInfoExtended
      additionalData?: Record<string, unknown>
    }
  >
  /** Get track stream */
  getTrackStream: (
    track: TrackInfo | TrackInfoExtended,
    url: string,
    protocol?: string,
    additionalData?: Record<string, unknown>
  ) => Promise<
    TrackStreamResult & { type?: string; exception?: { message: string } }
  >
  /** Get track chapters */
  getChapters: (track: {
    info?: TrackInfo | TrackInfoExtended
  }) => Promise<unknown[]>
  /** Get source by name */
  getSource: (name: string) => SourceInstance | null
  /** Load sources from folder */
  loadFolder: () => Promise<void>
  /** Primary source instances keyed by source name */
  sources: Map<string, SourceInstance>
  /** Get names of all enabled sources */
  getEnabledSourceNames: () => string[]
}

/**
 * YouTube source interface (minimal)
 * @public
 */
export interface YouTubeSource {
  /** Live chat interface */
  liveChat: {
    /** Get live chat instance */
    getLiveChat: (videoId: string) => Promise<LiveChat | null>
  }
}

/**
 * Live chat interface
 * @public
 */
export interface LiveChat {
  /** Poll for new chat messages */
  poll: () => Promise<LiveChatPollResult | null>
}

/**
 * Lyrics manager interface (minimal)
 * @public
 */
export interface LyricsManager {
  /** Load lyrics for track */
  loadLyrics: (
    track: { info: TrackInfo | TrackInfoExtended },
    language?: string
  ) => Promise<unknown>
  /** Load lyrics sources */
  loadFolder: () => Promise<void>
}

/**
 * Meanings manager interface (minimal)
 * @public
 */
export interface MeaningManager {
  /** Load song meaning/interpretation */
  loadMeaning: (
    track: { info: TrackInfo | TrackInfoExtended },
    language?: string
  ) => Promise<unknown>
  /** Load meaning sources */
  loadFolder: () => Promise<void>
}

/**
 * Credential manager interface (minimal)
 * @public
 */
export interface CredentialManager {
  /** Load credentials from disk */
  load: () => Promise<void>
  /** Lookup a stored credential value */
  get: <T = unknown>(key: string) => T | null
  /** Return the full credential entry with metadata */
  getEntry?: <T = unknown>(key: string) => CredentialEntry<T> | null
  /** Store or update a credential value */
  set: <T = unknown>(key: string, value: T, ttlMs?: number) => void
  /** Remove a credential entry */
  delete?: (key: string) => boolean
  /** Check whether a credential entry exists */
  has?: (key: string) => boolean
  /** Clear all stored credentials */
  clear?: () => void
  /** Persist credentials to disk immediately */
  forceSave?: () => Promise<void>
  /** Get runtime statistics about stored credentials */
  getStats?: () => CredentialManagerStats
}

/**
 * Track cache manager interface (minimal)
 * @public
 */
export interface TrackCacheManager {
  /** Load cache from disk */
  load: () => Promise<void>
  /** Lookup a cached entry */
  get: <T = unknown>(source: string, identifier: string) => T | null
  /** Store a cached entry */
  set: (
    source: string,
    identifier: string,
    value: unknown,
    ttlMs?: number
  ) => void
  /** Get the raw cached entry with metadata */
  getEntry?: (
    source: string,
    identifier: string
  ) => TrackCacheEntry<unknown> | null
  /** Persist the cache to disk immediately */
  forceSave?: () => Promise<void>
}

/**
 * Stats manager interface (minimal)
 * @public
 */
export interface StatsManager {
  /** Initialize stats manager */
  initialize?: () => Promise<void>
  /** Returns a snapshot of in-memory counters */
  getSnapshot?: () => StatsSnapshot
  /** Increments API request counters */
  incrementApiRequest?: (endpoint: string) => void
  /** Increments API error counters */
  incrementApiError?: (endpoint: string) => void
  /** Increments source success counters */
  incrementSourceSuccess?: (source: string) => void
  /** Increments source failure counters */
  incrementSourceFailure?: (source: string) => void
  /** Increments playback event counters */
  incrementPlaybackEvent?: (eventType: string) => void
  /** Updates stats gauges from aggregated payloads */
  updateStatsMetrics?: (
    statsData: StatsMetricsPayload,
    workerMetrics?: WorkerMetricsPayload | null
  ) => void
  /** Updates active voice connection count */
  setVoiceConnections?: (count: number) => void
  /** Updates active websocket connection count */
  setWebsocketConnections?: (count: number) => void
  /** Increments websocket message counters */
  incrementWebsocketMessage?: (direction: string, opType: string) => void
  /** Increments session resume counters */
  incrementSessionResume?: (clientName: string, success: boolean) => void
  /** Updates route planner IP counters */
  setRoutePlannerIps?: (available: number, banned: number) => void
  /** Records HTTP request durations */
  recordHttpRequestDuration?: (
    endpoint: string,
    method: string | undefined,
    statusCode: number | undefined,
    durationMs: number
  ) => void
  /** Increments rate limit hit counters */
  incrementRateLimitHit?: (endpoint: string, ip?: string) => void
  /** Increments DoS protection block counters */
  incrementDosProtectionBlock?: (
    ip: string | undefined,
    reason?: string
  ) => void
  /** Increments worker restart counters */
  incrementWorkerRestart?: (workerId: number | string) => void
  /** Increments worker failure counters */
  incrementWorkerFailure?: (
    workerId: number | string,
    exitCode?: number | string
  ) => void
  /** Records command execution times */
  recordCommandExecutionTime?: (
    commandType: string,
    workerId: number | string,
    durationMs: number
  ) => void
  /** Increments command timeout counters */
  incrementCommandTimeout?: (commandType: string) => void
  /** Increments command retry counters */
  incrementCommandRetry?: (commandType: string) => void
  /** Increments player restoration counters */
  incrementPlayerRestoration?: (workerId: number | string) => void
  /** Increments player destruction counters */
  incrementPlayerDestruction?: (sessionId: string, reason?: string) => void
  /** Increments track load counters */
  incrementTrackLoad?: (source: string, status: string) => void
  /** Records track load duration */
  recordTrackLoadDuration?: (source: string, durationMs: number) => void
  /** Increments stream error counters */
  incrementStreamError?: (errorType: string, source: string) => void
  /** Increments player stuck counters */
  incrementPlayerStuck?: (guildId: string, reason: string) => void
  /** Increments voice connection error counters */
  incrementVoiceConnectionError?: (errorType: string) => void
  /** Increments lyrics request counters */
  incrementLyricsRequest?: (provider: string, status: string) => void
  /** Increments filter usage counters */
  incrementFilterUsage?: (filterType: string) => void
  /** Manager instance properties */
  [key: string]: unknown
}

/**
 * Route planner manager interface (minimal)
 * @public
 */
export interface RoutePlannerManager {
  /** Initialize route planner */
  initialize?: () => Promise<void>
  /** Dispose route planner */
  dispose?: () => void | Promise<void>
  /** Get an IP address */
  getIP?: () => string | null | undefined
}
