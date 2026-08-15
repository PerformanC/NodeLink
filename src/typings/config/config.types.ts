/**
 * Selection of the internal engine used for networking and protocol handling.
 */
export type ServerEngine = 'default' | 'bun'

/**
 * Represents any valid JSON value.
 * @public
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[]

/**
 * Threshold configuration for a specific rolling time window.
 */
export interface LimitRule {
  /** The maximum numerical threshold allowed within the window. */
  count: number

  /** The duration of the rolling sliding time window in milliseconds. */
  windowMs: number
}

/**
 * Technical parameters for a smooth audio ramp, volume fade, or filter transition.
 */
export interface AudioTransition {
  /** The total duration of the transition effect in milliseconds. */
  duration: number

  /** The identifier of the mathematical curve applied to the transition. */
  curve: string

  /** The technical logic type applied during the transition. */
  type: string
}

/**
 * Connection and authentication details for an external proxy server.
 */
export interface ProxyEndpoint {
  /** The full destination URL of the proxy server. */
  url: string

  /** The username required for proxies using authentication. */
  username?: string

  /** The secret password associated with the username for proxy authentication. */
  password?: string
}

/**
 * A standard boolean toggle for enabling or disabling internal system components.
 */
export interface FeatureToggle {
  /** Set to 'true' to activate the component or 'false' to completely bypass it. */
  enabled: boolean
}

/**
 * Shared runtime fields consumed by several source implementations.
 */
export interface SourceConfigBase {
  /** Master switch for the source plugin. */
  enabled: boolean

  /** Shared network/proxy options read by source internals. */
  network?: {
    proxy?: ProxyEndpoint
  }

  /** Global search options read by source internals. */
  search?: {
    maxResults?: number
    defaultSource?: string | string[]
    unifiedSources?: string[]
    resolveExternalLinks?: boolean
    fetchChannelInfo?: boolean
  }

  /** Shared playback options read by source internals. */
  playback?: {
    maxPlaylistLength?: number
    trackStuckThresholdMs?: number
    playerUpdateInterval?: number
    eventTimeoutMs?: number
    audio?: Record<string, unknown>
    sponsorblock?: Record<string, unknown>
  }

  /** Allow additional source-specific properties. */
  [key: string]: unknown
}

/**
 * Configuration for the YouTube and YouTube Music provider.
 */
export interface YouTubeSourceConfig {
  /** Master switch for the YouTube source plugin. */
  enabled: boolean

  /** List of specific YouTube 'itag' numbers allowed for audio selection. */
  allowItag: number[]

  /** Hard-code a specific 'itag' for all audio streams. */
  targetItag: number | null

  /** If true, utilize OAuth2 refresh tokens for private content access. */
  getOAuthToken: boolean

  /** The 'hl' (Host Language) parameter for metadata localization. */
  hl: string

  /** The 'gl' (Geographic Location) parameter for regional content availability. */
  gl: string

  /** Pool of proxy endpoints used exclusively for YouTube traffic. */
  proxies: ProxyEndpoint[]

  /** Ordered list of alternative sources tried if YouTube resolution fails. */
  fallbackSources: string[]

  /** Configuration for InnerTube clients. */
  clients: {
    /** Ordered priority of clients used for search. */
    search: string[]

    /** Ordered priority of clients used for audio streaming. */
    playback: string[]

    /** Ordered priority of clients used for metadata resolution. */
    resolve: string[]

    /** Granular settings for individual client groups. */
    settings: {
      /** Settings for the 'YouTube on TV' client. */
      TV: {
        /** OAuth2 refresh tokens for session rotation. */
        refreshToken: string[]
      }
    }
  }

  /** Configuration for signature deciphering. */
  cipher: {
    /** Base URL of the deciphering service. */
    url: string

    /** Optional private access token. */
    token: string | null
  }

  /** Initial visitor data for InnerTube requests. */
  visitorData?: string

  /**
   * Allow additional unknown configuration keys.
   */
  [key: string]: unknown

  /** When true, official albums (OLAK) are resolved via an internal audio-only mirror search to ensure gapless playback. */
  mirrorOfficialAlbums?: boolean
}

/**
 * Configuration for the Spotify metadata resolution provider.
 */
export interface SpotifySourceConfig {
  /** Enables the Spotify resolution plugin. */
  enabled: boolean

  /** Official Spotify Application Client ID. */
  clientId: string

  /** Official Spotify Application Client Secret. */
  clientSecret: string

  /** URL of an external service for automated token generation. */
  externalAuthUrl: string

  /** Default market code (ISO 3166-1 alpha-2) for track availability. */
  market: string

  /** Maximum pages to load from a playlist (0 = no limit). */
  playlistLoadLimit: number

  /** Simultaneous requests allowed when fetching playlist pages. */
  playlistPageLoadConcurrency: number

  /** Maximum pages to load from an album. */
  albumLoadLimit: number

  /** Simultaneous requests allowed when fetching album pages. */
  albumPageLoadConcurrency: number

  /** If false, attempts to resolve a non-explicit version of the track. */
  allowExplicit: boolean

  /** If true, keeps 'Local Files' as placeholder tracks. */
  allowLocalFiles: boolean

  /** The 'sp_dc' cookie for mobile token generation. */
  sp_dc: string
}

/**
 * Configuration for the Apple Music resolution provider.
 */
export interface AppleMusicSourceConfig {
  /** Enables the Apple Music resolution plugin. */
  enabled: boolean

  /** Developer Media API Token. */
  mediaApiToken: string

  /** Target storefront market code (ISO 3166-1 alpha-2). */
  market: string

  /** Hard limit for tracks from a playlist. */
  playlistLoadLimit: number

  /** Hard limit for tracks from an album. */
  albumLoadLimit: number

  /** Simultaneous connections for playlist fetching. */
  playlistPageLoadConcurrency: number

  /** Simultaneous connections for album fetching. */
  albumPageLoadConcurrency: number

  /** Whether to allow tracks marked as explicit. */
  allowExplicit: boolean
}

/**
 * Configuration for the VK Music provider.
 */
export interface VKMusicSourceConfig extends SourceConfigBase {
  /** Enables the VK Music source plugin. */
  enabled: boolean

  /** API User Token for authenticated requests. */
  userToken: string

  /** Full session cookie string for browser emulation. */
  userCookie: string

  /** Dedicated proxy for VK-related requests. */
  proxy: ProxyEndpoint

  /** Runtime-compatible network proxy wrapper. */
  network: {
    proxy: ProxyEndpoint
  }
}

/**
 * Configuration for the Deezer media provider.
 */
export interface DeezerSourceConfig {
  /** Enables the Deezer source plugin. */
  enabled: boolean

  /** User 'arl' cookie for authenticated requests. */
  arl: string

  /** Optional manual decryption key for streams. */
  decryptionKey: string
}

/**
 * Configuration for the Tidal high-fidelity music provider.
 */
export interface TidalSourceConfig {
  /** Enables the Tidal source plugin. */
  enabled: boolean

  /** Personal API Access Token. */
  token: string

  /** ISO 3166-1 alpha-2 country code for availability. */
  countryCode: string

  /** Maximum pages loaded per playlist resolution. */
  playlistLoadLimit: number

  /** Number of simultaneous page downloads. */
  playlistPageLoadConcurrency: number

  /** Array of private Hi-Fi API endpoint URLs. */
  hifiApis: string[]

  /** Ordered list of preferred audio quality tiers. */
  hifiQualities: string[]
}

/**
 * Configuration for the JioSaavn Indian music provider.
 */
export interface JioSaavnSourceConfig extends SourceConfigBase {
  /** Enables the JioSaavn source plugin. */
  enabled: boolean

  /** Maximum tracks to load from a playlist. */
  playlistLoadLimit: number

  /** Maximum tracks to load for a single artist. */
  artistLoadLimit: number

  /** Proxy settings for regional access. */
  proxy: ProxyEndpoint

  /** Runtime-compatible network proxy wrapper. */
  network: {
    proxy: ProxyEndpoint
  }

  /** Optional custom decryption key for streams. */
  secretKey: string
}

/**
 * Configuration for the Gaana Indian music provider.
 */
export interface GaanaSourceConfig extends SourceConfigBase {
  /** Enables the Gaana source plugin. */
  enabled: boolean

  /** Target stream quality profile ('high', 'medium', 'low'). */
  streamQuality: string

  /** Maximum tracks from a Gaana playlist. */
  playlistLoadLimit: number

  /** Maximum tracks from a Gaana album. */
  albumLoadLimit: number

  /** Maximum tracks for a single Gaana artist. */
  artistLoadLimit: number

  /** Proxy configuration for gaana requests. */
  proxy: ProxyEndpoint

  /** Runtime-compatible network proxy wrapper. */
  network: {
    proxy: ProxyEndpoint
  }
}

/**
 * Configuration for the Yandex Music (Russia) provider.
 */
export interface YandexMusicSourceConfig extends SourceConfigBase {
  /** Master switch for the Yandex Music source plugin. */
  enabled: boolean

  /** User Access Token retrieved from an authenticated Yandex session. */
  accessToken: string

  /** If true, includes tracks even if marked as unavailable in the region. */
  allowUnavailable: boolean

  /** Whether to include explicit content in results. */
  allowExplicit: boolean

  /** Track limit for artist-based loading. */
  artistLoadLimit: number

  /** Track limit for album-based loading. */
  albumLoadLimit: number

  /** Track limit for playlist-based loading. */
  playlistLoadLimit: number

  /** Proxy configuration for regional Yandex access. */
  proxy: ProxyEndpoint

  /** Runtime-compatible network proxy wrapper. */
  network: {
    proxy: ProxyEndpoint
  }
}

/**
 * Configuration for the EternalBox loop and remix engine.
 */
export interface EternalBoxSourceConfig {
  /** Enables the EternalBox infinite looping plugin. */
  enabled: boolean

  /** The base URL for the EternalBox mirror API. */
  baseUrl: string

  /** Number of search results analyzed to find the best matching track. */
  searchResults: number

  /** If true, fetches additional audio feature metrics from Spotify. */
  enrichSpotify: boolean

  /** If true, includes full segment-by-segment audio analysis. */
  includeAnalysis: boolean

  /** If true, includes only a summarized version of the audio analysis. */
  includeAnalysisSummary: boolean

  /** Master switch for the automated eternal stream handler. */
  eternalStream: boolean

  /** Maximum memory (in bytes) for the in-memory analysis cache. */
  cacheMaxBytes: number

  /** Maximum simultaneous alternative branch paths per segment. */
  maxBranches: number

  /** Maximum similarity value for a valid branch. */
  maxBranchThreshold: number

  /** Initial discovery threshold for branch discovery. */
  branchThresholdStart: number

  /** Step size when expanding the similarity search. */
  branchThresholdStep: number

  /** Divisor factor to normalize branch scores. */
  branchTargetDivisor: number

  /** If true, forces a branch connection at the end of the track. */
  addLastEdge: boolean

  /** If true, only allows branches that jump backwards in time. */
  justBackwards: boolean

  /** If true, filters out very short jump distances. */
  justLongBranches: boolean

  /** If true, prevents repetitive A-B-A branch loops. */
  removeSequentialBranches: boolean

  /** If true, uses segment filtering for higher rhythmic accuracy. */
  useFilteredSegments: boolean

  /** Minimum baseline chance for a random jump. */
  minRandomBranchChance: number

  /** Maximum potential chance for a random jump. */
  maxRandomBranchChance: number

  /** Random variance delta applied per cycle. */
  randomBranchChanceDelta: number

  /** Importance of timbre/texture matching. */
  timbreWeight: number

  /** Importance of musical pitch/chroma matching. */
  pitchWeight: number

  /** Importance of the segment start volume envelope. */
  loudStartWeight: number

  /** Importance of the segment peak volume level. */
  loudMaxWeight: number

  /** Importance of the segment duration/length. */
  durationWeight: number

  /** Importance of the algorithm's confidence score. */
  confidenceWeight: number

  /** Enables persistent infinite streaming mode. */
  infiniteStream: boolean

  /** Maximum reconnection attempts before giving up. */
  maxReconnects: number

  /** Delay in milliseconds between retry attempts. */
  reconnectDelayMs: number
}

/** @deprecated use EternalBoxSourceConfig */
export type EternalboxSourceConfig = EternalBoxSourceConfig

/**
 * Configuration for the Amazon Music provider.
 */
export interface AmazonMusicSourceConfig extends SourceConfigBase {
  enabled: boolean
  playlistLoadLimit: number
  albumLoadLimit: number
}

/**
 * Configuration for the Bilibili provider.
 */
export interface BilibiliSourceConfig extends SourceConfigBase {
  enabled: boolean
  sessdata: string
  network: {
    proxy: ProxyEndpoint
  }
}

/**
 * Configuration for the Google Drive provider.
 */
export interface GoogleDriveSourceConfig extends SourceConfigBase {
  enabled: boolean
  /** Raw cookie header used to access private or restricted Drive files/folders. */
  cookies: string
}

/**
 * Configuration for the Songlink metadata bridge.
 */
export interface SonglinkSourceConfig {
  /** Master switch for the Songlink plugin. */
  enabled: boolean

  /** Your private API Key for the Odesli platform. */
  apiKey: string

  /** ISO 3166-1 alpha-2 country code for resolution market. */
  userCountry: string

  /** If true, returns only the original song if only one match is found. */
  songIfSingle: boolean

  /** Use the official Odesli REST API. */
  useApi: boolean

  /** Use web scraping as a fallback if the API fails or is disabled. */
  useScrapeFallback: boolean

  /** Ordered list of platforms to prefer during link resolution. */
  preferredPlatforms: string[]

  /** If true, falls back to any available platform if preferred ones fail. */
  fallbackToAny: boolean
}

/**
 * Direct HTTP/HTTPS stream resolver configuration.
 */
export interface HttpSourceConfig {
  /** Enables the direct URL resolution plugin. */
  enabled: boolean

  /** Custom 'User-Agent' string sent with every outgoing request. */
  userAgent: string
}

/**
 * Configuration for the Flowery Text-to-Speech provider.
 */
export interface FlowerySourceConfig {
  /** Enables the Flowery TTS plugin. */
  enabled: boolean

  /** Identifier of the default voice used for synthesis. */
  voice: string

  /** If true, automatically translates input text before synthesis. */
  translate: boolean

  /** Duration of trailing silence (ms) added to the end of the clip. */
  silence: number

  /** Playback speed multiplier (e.g., 1.0 = normal). */
  speed: number

  /** If true, ignores user-provided synthesis overrides. */
  enforceConfig: boolean
}

/**
 * Configuration for the LazyPy Text-to-Speech aggregator.
 */
export interface LazyPySourceConfig {
  /** Enables the LazyPy TTS plugin. */
  enabled: boolean

  /** Identifier of the underlying synthesis service. */
  service: string

  /** Identifier of the default voice for the selected service. */
  voice: string

  /** Hard character limit per synthesis request. */
  maxTextLength: number

  /** If true, forces server-side configuration over user requests. */
  enforceConfig: boolean
}

/**
 * Configuration for the local Piper neural Text-to-Speech engine.
 */
export interface PiperSourceConfig {
  /** Enables the local Piper neural TTS plugin. */
  enabled: boolean

  /** The HTTP/WebSocket URL of the local Piper server instance. */
  url: string

  /** Identifier of the neural voice model file (ONNX). */
  voice: string

  /** Speaker index for models containing multiple different voices. */
  speaker: number

  /** Optional speaker identifier for backends that expect string IDs. */
  speaker_id?: string | number

  /** Tempo/Speed multiplier (e.g., 1.0 is normal). */
  length_scale: number

  /** Phoneme-level noise variation for more 'human' expression. */
  noise_scale: number

  /** Duration-level noise variation for rhythmic naturalness. */
  noise_w_scale: number
}

/**
 * Configuration for the Audius decentralized music provider.
 */
export interface AudiusSourceConfig {
  /** Enables the Audius source plugin. */
  enabled: boolean

  /** Unique application name for Audius API identification. */
  appName: string

  /** Public API service key. */
  apiKey: string

  /** Private API service secret. */
  apiSecret: string

  /** Maximum tracks loaded from an Audius playlist. */
  playlistLoadLimit: number

  /** Maximum tracks loaded from an Audius album. */
  albumLoadLimit: number
}

/**
 * Configuration for the Qobuz high-resolution music provider.
 */
export interface QobuzSourceConfig {
  /** Master switch for the Qobuz source plugin. */
  enabled: boolean

  /** Personal User Token retrieved from an authenticated Qobuz session. */
  userToken: string

  /** Preferred audio format/quality identifier. */
  formatId: string

  /** Whether to include tracks marked with explicit content. */
  allowExplicit: boolean
}

/**
 * Configuration for the Monochrome decentralized music API.
 */
/**
 * Monochrome source configuration
 * @public
 */
export interface MonochromeSourceConfig extends SourceConfigBase {
  /**
   * List of API instances to use for metadata and search.
   * @remarks These instances handle track info, search queries, and collection metadata.
   */
  instances: string[]

  /**
   * List of streaming instances used for manifest resolution.
   * @remarks These instances are specifically used to resolve playable stream URIs.
   */
  streamingInstances: string[]

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
  quality: 'HI_RES_LOSSLESS' | 'LOSSLESS' | 'HIGH' | 'LOW' | string
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
   * The format to receive audio in
   * @defaultValue 'pcm'
   */
  format: 'pcm' | 'opus'
}

/**
 * Configuration for the Deezer media provider.
 */
export interface DeezerSourceConfig {
  /** Master switch for the Deezer source plugin. */
  enabled: boolean

  /** User 'arl' cookie for authenticated Deezer requests. */
  arl: string

  /** Optional manual decryption key for Deezer audio streams. */
  decryptionKey: string
}

/**
 * Configuration for the Pandora music provider.
 */
export interface PandoraSourceConfig {
  /** Master switch for the Pandora source plugin. */
  enabled: boolean

  /** Manual session/CSRF token for bypassing regional gatekeeping. */
  csrfToken: string

  /** URL of a remote microservice for token rotation. */
  remoteTokenUrl: string
}

/**
 * Registry of all available content provider configurations.
 */
export interface SourcesRegistry {
  /** YouTube and YouTube Music. */
  youtube: YouTubeSourceConfig

  /** Spotify metadata resolution. */
  spotify: SpotifySourceConfig

  /** Apple Music resolution. */
  applemusic: AppleMusicSourceConfig

  /** VK Music resolution. */
  vkmusic: VKMusicSourceConfig

  /** Deezer resolution. */
  deezer: DeezerSourceConfig

  /** Tidal resolution. */
  tidal: TidalSourceConfig

  /** JioSaavn resolution. */
  jiosaavn: JioSaavnSourceConfig

  /** Gaana resolution. */
  gaana: GaanaSourceConfig

  /** Yandex Music resolution. */
  yandexmusic: YandexMusicSourceConfig

  /** EternalBox loop engine. */
  eternalbox: EternalBoxSourceConfig

  /** Songlink bridge. */
  songlink: SonglinkSourceConfig

  /** Direct HTTP/HTTPS. */
  http: HttpSourceConfig

  /** Flowery TTS. */
  flowery: FlowerySourceConfig

  /** LazyPy TTS aggregator. */
  lazypytts: LazyPySourceConfig

  /** Local Piper neural TTS. */
  pipertts: PiperSourceConfig

  /** Audius decentralized music. */
  audius: AudiusSourceConfig

  /** Qobuz high-resolution. */
  qobuz: QobuzSourceConfig

  /** Monochrome API. */
  monochrome: MonochromeSourceConfig

  /** Pandora resolution. */
  pandora: PandoraSourceConfig

  /** Amazon Music resolution. */
  amazonmusic: AmazonMusicSourceConfig

  /** BlueSky post-audio. */
  bluesky: FeatureToggle & {
    /** Optional source-local override for search result limit. */
    maxSearchResults?: number
  }

  /** MENA region resolution. */
  anghami: FeatureToggle & {
    /** Session cookies for anghami. */
    cookies: string
  }

  /** RSS feed extractor. */
  rss: FeatureToggle

  /** Mixcloud resolution. */
  mixcloud: FeatureToggle

  /** Audiomack resolution. */
  audiomack: FeatureToggle

  /** Bandcamp resolution. */
  bandcamp: FeatureToggle

  /** Newgrounds Audio Portal resolution. */
  newgrounds: FeatureToggle

  /** SoundCloud resolution. */
  soundcloud: FeatureToggle & {
    /** Optional SoundCloud API Client ID. */
    clientId: string
  }

  /** Local filesystem. */
  local: FeatureToggle & {
    /** Local root path for music scanning. */
    basePath: string
  }

  /** Vimeo video-audio. */
  vimeo: FeatureToggle

  /** iHeartRadio resolution. */
  iheartradio: FeatureToggle

  /** Telegram file resolution. */
  telegram: FeatureToggle

  /** Shazam recognition. */
  shazam: FeatureToggle & {
    /** Filter explicit content in Shazam results. */
    allowExplicit: boolean
  }

  /** Bilibili video-audio. */
  bilibili: BilibiliSourceConfig

  /** Genius metadata. */
  genius: FeatureToggle

  /** Pinterest video-audio. */
  pinterest: FeatureToggle

  /** Google Text-to-Speech. */
  'google-tts': FeatureToggle & {
    /** Google TTS language tag. */
    language: string
  }

  /** Instagram post-audio. */
  instagram: FeatureToggle

  /** Kwai video-audio. */
  kwai: FeatureToggle

  /** Twitch stream/clip. */
  twitch: FeatureToggle

  /** NicoVideo resolution. */
  nicovideo: FeatureToggle

  /** Reddit video-audio. */
  reddit: FeatureToggle

  /** Tumblr post-audio. */
  tumblr: FeatureToggle

  /** Twitter (X) post-audio. */
  twitter: FeatureToggle

  /** Last.fm enrichment. */
  lastfm: FeatureToggle & {
    /** Last.fm API Key. */
    apiKey: string
  }

  /** NetEase resolution. */
  netease: FeatureToggle

  /** Letras.mus.br lyrics. */
  letrasmus: FeatureToggle

  /** Google Drive files. */
  googledrive: GoogleDriveSourceConfig

  /** TikTok video-audio. */
  tiktok: FeatureToggle

  /** Allow dynamic indexing of sources. */
  [key: string]: FeatureToggle | SourceConfigBase | undefined
}

/**
 * Infrastructure settings for the core server.
 */
export interface ServerSection {
  /** Bind host address. */
  host: string

  /** API/WebSocket port. */
  port: number

  /** Master auth password. */
  password?: string

  /** Enable experimental Bun server engine. */
  useBunServer: boolean
}

/**
 * System-wide security and mitigations.
 */
export interface SecuritySection {
  /** Master auth password. */
  password?: string

  /** Trust X-Forwarded-For headers. */
  trustProxy: boolean

  /** Anti-flooding protection. */
  dosProtection: {
    enabled: boolean
    thresholds: {
      /** Max requests in window. */
      burstRequests: number
      /** Sliding window size (ms). */
      timeWindowMs: number
    }
    mitigation: {
      /** Artificial response delay (ms). */
      delayMs: number
      /** access block duration (ms). */
      blockDurationMs: number
    }
    ignore: {
      userIds: string[]
      guildIds: string[]
      ips: string[]
    }
  }

  /** fair-use API throttling. */
  rateLimit: {
    enabled: boolean
    maxEntries: number
    global: {
      maxRequests: number
      timeWindowMs: number
    }
    perIp: {
      maxRequests: number
      timeWindowMs: number
    }
    perUserId: {
      maxRequests: number
      timeWindowMs: number
    }
    perGuildId: {
      maxRequests: number
      timeWindowMs: number
    }
    /** Paths that bypass rate limiting. */
    ignorePaths: string[]
    ignore: {
      userIds: string[]
      guildIds: string[]
      ips: string[]
    }
  }

  /** Allow additional security-specific properties. */
  [key: string]: unknown
}

/**
 * Multi-process cluster and scaling settings.
 */
export interface ClusterSection {
  /** Active cluster mode. */
  enabled: boolean

  /** Dedicated playback workers count (0 = auto). */
  workers: number

  /** Standby workers pool size. */
  minWorkers: number

  /** Runtime flags for worker processes. */
  runtime: {
    workerMaxOldSpaceMb: number
    workerExposeGc: boolean
    workerExecArgv: string[]
    sourceWorkerMaxOldSpaceMb: number
    sourceWorkerExposeGc: boolean
    sourceWorkerExecArgv: string[]
  }

  /** Offloads heavy metadata tasks to dedicated processes. */
  specializedSourceWorker: {
    enabled: boolean
    count: number
    microWorkers: number
    tasksPerWorker: number
    silentLogs: boolean
  }

  /** Heavy command timeout (ms). */
  commandTimeout: number

  /** Player control command timeout (ms). */
  fastCommandTimeout: number

  /** Hierarchical timeout aliases for migration compatibility. */
  timeouts?: {
    heavyMs: number
    fastMs: number
  }

  /** IPC retry attempts. */
  maxRetries: number

  /** Process suspension logic. */
  hibernation: {
    enabled: boolean
    timeoutMs: number
  }

  /** Load balancer orchestration. */
  scaling: {
    maxPlayersPerWorker: number
    targetUtilization: number
    scaleUpThreshold: number
    scaleDownThreshold: number
    checkIntervalMs: number
    idleWorkerTimeoutMs: number
    queueLengthScaleUpFactor: number
    lagPenaltyLimit: number
    cpuPenaltyLimit: number
  }

  /** cluster control API. */
  endpoint: {
    patchEnabled: boolean
    allowExternalPatch: boolean
    code: string
  }
}

/**
 * System-wide logging and debugging engine.
 */
export interface LoggingSection {
  /** log level (e.g. 'info', 'debug'). */
  level: string

  /** Disk logging settings. */
  file: {
    enabled: boolean
    path: string
    rotation: string
    ttlDays: number
  }

  /** Granular debug flags. */
  debug: {
    all: boolean
    request: boolean
    session: boolean
    player: boolean
    filters: boolean
    sources: boolean
    lyrics: boolean
    youtube: boolean
    'youtube-cipher': boolean
    sabr: boolean
    potoken: boolean
  }
}

/**
 * Connectivity health and multi-IP rotation.
 */
export interface NetworkSection {
  /** Shared outbound proxy for sources and internals. */
  proxy: {
    enabled: boolean
    strategy: string
    retries: number
    timeout: number
    shuffleOnStart: boolean
    list: ProxyEndpoint[]
  }

  /** Background connection probing. */
  connection: {
    logAllChecks: boolean
    interval: number
    timeout: number
    thresholds: {
      bad: number
      average: number
    }
  }

  /** Outbound IP rotation. */
  routePlanner: {
    strategy: string
    bannedIpCooldown: number
    ipBlocks: Array<string | { cidr: string }>
  }
}

/**
 * Configuration for audio filters.
 */
export interface FilterConfig {
  /**
   * Toggles for individual audio filters.
   */
  enabled: {
    /** tremolo filter. */
    tremolo: boolean
    /** vibrato filter. */
    vibrato: boolean
    /** lowpass filter. */
    lowpass: boolean
    /** highpass filter. */
    highpass: boolean
    /** rotation filter. */
    rotation: boolean
    /** karaoke filter. */
    karaoke: boolean
    /** distortion filter. */
    distortion: boolean
    /** channelMix filter. */
    channelMix: boolean
    /** equalizer filter. */
    equalizer: boolean
    /** chorus filter. */
    chorus: boolean
    /** compressor filter. */
    compressor: boolean
    /** echo filter. */
    echo: boolean
    /** phaser filter. */
    phaser: boolean
    /** timescale filter. */
    timescale: boolean
  }
}

/**
 * The consolidated NodeLink configuration schema.
 */
export interface NodelinkConfig {
  server: ServerSection
  cluster: ClusterSection
  logging: LoggingSection
  connection: NetworkSection['connection']
  rateLimit: SecuritySection['rateLimit']
  dosProtection: SecuritySection['dosProtection']
  trustProxy: boolean
  network: NetworkSection
  search: {
    maxResults: number
    defaultSource: string | string[]
    unifiedSources: string[]
    resolveExternalLinks: boolean
    fetchChannelInfo: boolean
  }
  playback: {
    maxPlaylistLength: number
    playerUpdateInterval: number
    statsUpdateInterval: number
    trackStuckThresholdMs: number
    eventTimeoutMs: number
    zombieThresholdMs: number
    sponsorblock: {
      enabled: boolean
      api: string
      categories: string[]
      actionTypes: string[]
      skipMarginMs: number
    }
    filters: FilterConfig
    audio: {
      quality: string
      encryption: string
      resamplingQuality: string
      loudnessNormalizer: boolean
      lookaheadMs: number
      gateThresholdLUFS: number
      fading: {
        enabled: boolean
        trackStart: AudioTransition
        trackEnd: AudioTransition
        trackStop: AudioTransition
        seek: AudioTransition
        pause: AudioTransition
        resume: AudioTransition
        ducking: {
          enabled: boolean
          duration: number
          targetVolume: number
          curve: string
        }
      }
      crossfade: {
        enabled: boolean
        duration: number
        curve: string
        mode: 'preload' | 'stream'
        minBufferMs: number
        bufferMs: number
      }
    }
    voiceReceive: VoiceReceiveConfig
    mix: {
      enabled: boolean
      defaultVolume: number
      maxLayersMix: number
      autoCleanup: boolean
    }
  }
  api: {
    enableTrackStreamEndpoint: boolean
    enableLoadStreamEndpoint: boolean
    metrics: {
      enabled: boolean
      authorization: {
        type: 'Bearer' | 'Basic'
        username: string
        password: string
      }
    }
  }
  experimental: {
    enableHoloTracks: boolean
  }

  /** provider-specific configurations. */
  sources: SourcesRegistry

  /** Lyrics extraction settings. */
  lyrics: {
    fallbackSource: string
    /** Ordered lyrics providers tried after the track's native provider. */
    preferredSources?: string[]
    [source: string]: unknown
  }

  /** track meaning providers. */
  meanings: {
    [key: string]: FeatureToggle | undefined
  }

  /** scraper metrics endpoint. */
  metrics: {
    enabled: boolean
    authorization: {
      type: 'Bearer' | 'Basic' | string
      username: string
      password: string
    }
  }

  /** Multi-audio layering mixer. */
  mix: {
    enabled: boolean
    defaultVolume: number
    maxLayersMix: number
    autoCleanup: boolean
  }

  /** Registry of addons to load. */
  plugins: Array<{
    name: string
    source: string
    path?: string
  }>

  /** Configuration for disk caching. */
  cache?: {
    diskEnabled?: boolean
  }

  /** Passthrough addon settings. */
  pluginConfig: Record<string, Record<string, unknown>>
}
