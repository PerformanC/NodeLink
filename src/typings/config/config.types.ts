/**
 * Nodelink configuration type based on config.default.js
 * @public
 */
export type NodelinkConfig = typeof import('../../../config.default.js').default

/**
 * Server configuration options
 * @public
 */
export interface ServerConfig {
  /**
   * Port number for the server to listen on
   * @remarks Must be between 1 and 65535
   */
  port: number

  /**
   * Host address to bind the server to
   * @remarks Use "0.0.0.0" to listen on all interfaces
   */
  host: string

  /**
   * Authentication password for client connections
   */
  password: string

  /**
   * Whether to use Bun's native server instead of Node.js HTTP server
   * @defaultValue false
   * @experimental
   */
  useBunServer?: boolean
}

/**
 * Cluster configuration for multi-process deployment
 * @public
 */
export interface ClusterConfig {
  /**
   * Whether cluster mode is enabled
   * @defaultValue false
   */
  enabled: boolean

  /**
   * Number of worker processes to spawn
   * @remarks Set to 0 for automatic (CPU count)
   */
  workers: number

  /**
   * Runtime node flags for playback/source worker processes
   */
  runtime?: {
    /**
     * Max old space size (MB) for playback workers (0 disables override)
     */
    workerMaxOldSpaceMb?: number
    /**
     * Enables --expose-gc for playback workers
     */
    workerExposeGc?: boolean
    /**
     * Extra Node.js argv for playback workers
     */
    workerExecArgv?: string[] | string
    /**
     * Max old space size (MB) for source workers (0 disables override)
     */
    sourceWorkerMaxOldSpaceMb?: number
    /**
     * Enables --expose-gc for source workers
     */
    sourceWorkerExposeGc?: boolean
    /**
     * Extra Node.js argv for source workers
     */
    sourceWorkerExecArgv?: string[] | string
  }

  /**
   * Specialized worker configuration for audio sources
   */
  specializedSourceWorker?: {
    /**
     * Whether specialized source worker is enabled
     * @defaultValue false
     */
    enabled: boolean
  }
}

/**
 * Audio source configuration base
 * @public
 */
export interface SourceConfigBase {
  /**
   * Whether this audio source is enabled
   */
  enabled: boolean
}

/**
 * YouTube source configuration
 * @public
 */
export interface YouTubeSourceConfig extends SourceConfigBase {
  /**
   * Playlist load limit
   */
  playlistLoadLimit: number

  /**
   * Album load limit
   */
  albumLoadLimit: number
}

/**
 * Spotify source configuration
 * @public
 */
export interface SpotifySourceConfig extends SourceConfigBase {
  /**
   * Client ID for official API access.
   */
  clientId?: string

  /**
   * Client secret for official API access.
   */
  clientSecret?: string

  /**
   * Optional external URL for anonymous token generation.
   */
  externalAuthUrl?: string

  /**
   * Spotify sp_dc cookie for mobile token generation.
   */
  sp_dc?: string

  /**
   * Market code for search and resolution.
   * @defaultValue "US"
   */
  market?: string

  /**
   * Playlist load limit.
   */
  playlistLoadLimit: number

  /**
   * Album load limit.
   */
  albumLoadLimit: number

  /**
   * Maximum concurrent requests during playlist loading.
   */
  playlistPageLoadConcurrency?: number

  /**
   * Maximum concurrent requests during album loading.
   */
  albumPageLoadConcurrency?: number

  /**
   * Whether to allow explicit tracks in search/recommendations.
   */
  allowExplicit?: boolean

  /**
   * Whether Spotify playlist local files should be included.
   */
  allowLocalFiles: boolean
}

/**
 * Audius source configuration
 * @public
 */
export interface AudiusSourceConfig extends SourceConfigBase {
  /**
   * App name
   */
  appName: string

  /**
   * API key
   */
  apiKey: string

  /**
   * API secret
   */
  apiSecret: string

  /**
   * Playlist load limit
   */
  playlistLoadLimit: number

  /**
   * Album load limit
   */
  albumLoadLimit: number
}

/**
 * Yandex Music source configuration
 * @public
 */
export interface YandexMusicSourceConfig extends SourceConfigBase {
  /**
   * Access token
   */
  accessToken: string

  /**
   * Playlist load limit
   */
  playlistLoadLimit: number

  /**
   * Album load limit
   */
  albumLoadLimit: number

  /**
   * Artist load limit
   */
  artistLoadLimit: number

  /**
   * Whether to include unavailable tracks
   */
  allowUnavailable: boolean

  /**
   * Whether to allow explicit content
   */
  allowExplicit: boolean

  /**
   * Proxy settings for the request.
   */
  proxy?: import('../utils.types.ts').HttpProxyConfig
}

/**
 * VK Music source configuration
 * @public
 */
export interface VKMusicSourceConfig extends SourceConfigBase {
  /**
   * Access token for the user
   */
  userToken?: string

  /**
   * User cookie for authentication fallback
   */
  userCookie?: string

  /**
   * Proxy settings for the request.
   */
  proxy?: import('../utils.types.ts').HttpProxyConfig
}

/**
 * Bilibili source configuration
 * @public
 */
export interface BilibiliSourceConfig extends SourceConfigBase {
  /**
   * SESSDATA cookie for authentication
   */
  sessdata?: string

  /**
   * Proxy settings for the request.
   */
  proxy?: import('../utils.types.ts').HttpProxyConfig
}

/**
 * Eternalbox source configuration
 * @public
 */
export interface EternalboxSourceConfig extends SourceConfigBase {
  /**
   * Base URL for the Eternalbox mirror
   * @defaultValue 'https://eternalboxmirror.xyz'
   */
  baseUrl: string

  /**
   * Whether to enable the eternal (infinite) stream loop
   * @defaultValue true
   */
  eternalStream: boolean

  /**
   * Whether to signal the stream as infinite to the client
   * @defaultValue true
   */
  infiniteStream: boolean

  /**
   * Whether to enrich the track with Spotify metadata if available
   * @defaultValue false
   */
  enrichSpotify: boolean

  /**
   * Maximum search results to return
   * @defaultValue 10
   */
  searchResults: number

  /**
   * Maximum size of the internal audio cache in bytes
   * @defaultValue 20MB
   */
  cacheMaxBytes: number

  /**
   * Whether to include full audio analysis in pluginInfo
   * @defaultValue true
   */
  includeAnalysis: boolean

  /**
   * Whether to include a summary of audio analysis in pluginInfo
   * @defaultValue true
   */
  includeAnalysisSummary: boolean

  /**
   * Algorithm parameter: Maximum branches per beat
   */
  maxBranches: number

  /**
   * Algorithm parameter: Maximum branch similarity threshold
   */
  maxBranchThreshold: number

  /**
   * Algorithm parameter: Minimum branch similarity threshold
   */
  branchThresholdStart: number

  /**
   * Algorithm parameter: Branch threshold iteration step
   */
  branchThresholdStep: number

  /**
   * Algorithm parameter: Target divisor for branch count
   */
  branchTargetDivisor: number

  /**
   * Algorithm parameter: Whether to force a branch at the end
   */
  addLastEdge: boolean

  /**
   * Algorithm parameter: Only branch backwards
   */
  justBackwards: boolean

  /**
   * Algorithm parameter: Only branch to distant beats
   */
  justLongBranches: boolean

  /**
   * Algorithm parameter: Remove sequential (duplicate) branches
   */
  removeSequentialBranches: boolean

  /**
   * Algorithm parameter: Filter segments for smoother branching
   */
  useFilteredSegments: boolean

  /**
   * Weight for timbre similarity
   */
  timbreWeight: number

  /**
   * Weight for pitch similarity
   */
  pitchWeight: number

  /**
   * Weight for loudness start similarity
   */
  loudStartWeight: number

  /**
   * Weight for loudness max similarity
   */
  loudMaxWeight: number

  /**
   * Weight for duration similarity
   */
  durationWeight: number

  /**
   * Weight for confidence similarity
   */
  confidenceWeight: number

  /**
   * Minimum random branch probability
   */
  minRandomBranchChance: number

  /**
   * Maximum random branch probability
   */
  maxRandomBranchChance: number

  /**
   * Random branch probability increment per beat
   */
  randomBranchChanceDelta: number

  /**
   * Maximum reconnect attempts for the stream
   */
  maxReconnects: number

  /**
   * Delay between reconnect attempts in ms
   */
  reconnectDelayMs: number
}

/**
 * JioSaavn source configuration
 * @public
 */
export interface JioSaavnSourceConfig extends SourceConfigBase {
  /**
   * Playlist load limit
   */
  playlistLoadLimit: number

  /**
   * Artist load limit
   */
  artistLoadLimit: number
}

/**
 * Apple Music source configuration
 * @public
 */
export interface AppleMusicSourceConfig extends SourceConfigBase {
  /**
   * Media API token for authentication
   */
  mediaApiToken?: string

  /**
   * Market/country code
   */
  market?: string

  /**
   * Playlist load limit
   */
  playlistLoadLimit: number

  /**
   * Album load limit
   */
  albumLoadLimit: number

  /**
   * Whether to allow explicit content
   */
  allowExplicit: boolean
}

/**
 * Amazon Music source configuration
 * @public
 */
export interface AmazonMusicSourceConfig extends SourceConfigBase {
  /**
   * Playlist load limit
   */
  playlistLoadLimit: number

  /**
   * Album load limit
   */
  albumLoadLimit: number
}

/**
 * Monochrome source configuration
 * @public
 */
export interface MonochromeSourceConfig extends SourceConfigBase {
  /**
   * List of API instances to use for metadata and search.
   * @remarks These instances handle track info, search queries, and collection metadata.
   */
  instances?: string[]

  /**
   * List of streaming instances used for manifest resolution.
   * @remarks These instances are specifically used to resolve playable stream URIs.
   */
  streamingInstances?: string[]

  /**
   * List of Qobuz proxy instances used as fallback for stream resolution.
   * @remarks These endpoints expose `/api/get-music` and `/api/download-music` to resolve Qobuz tracks.
   */
  qobuzInstances?: string[]

  /**
   * Preferred audio quality.
   * @remarks
   * - `HI_RES_LOSSLESS`: Highest available quality (FLAC Hi-Res).
   * - `LOSSLESS`: Standard CD quality (FLAC).
   * - `HIGH`: High quality compressed (AAC 320kbps).
   * - `LOW`: Low quality compressed (AAC 96kbps).
   */
  quality?: 'HI_RES_LOSSLESS' | 'LOSSLESS' | 'HIGH' | 'LOW'
}

/**
 * Voice receive configuration for receiving audio from Discord
 * @public
 */
export interface VoiceReceiveConfig {
  /**
   * Whether voice receiving is enabled
   * @defaultValue false
   */
  enabled: boolean

  /**
   * Audio format for received voice data
   * @remarks
   * - `pcm`: Raw PCM audio data
   * - `opus`: Opus-encoded audio data
   */
  format: 'pcm' | 'opus'
}

/**
 * Rate limiting configuration
 * @public
 */
export interface RateLimitConfig {
  /**
   * Duration of the rate limit window in milliseconds
   */
  duration: number

  /**
   * Maximum number of requests allowed within the window
   */
  maxRequests: number
}

/**
 * Metrics collection configuration
 * @public
 */
export interface MetricsConfig {
  /**
   * Whether metrics collection is enabled
   * @defaultValue false
   */
  enabled: boolean

  /**
   * Interval for collecting metrics in milliseconds
   * @defaultValue 5000
   */
  interval?: number
}
