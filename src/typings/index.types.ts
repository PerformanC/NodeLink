import type { EventEmitter } from 'node:events'
import type * as http from 'node:http'
import type WebSocketServer from '@performanc/pwsl-server'
import type { ServerWebSocket } from 'bun'
import type {
  ApiMiddlewareExtension,
  ApiRouteExtension
} from './api/api.types.ts'
import type { WorkerMetricsEntry } from './api/stats.types.ts'
import type { NodelinkConfig } from './config/config.types.ts'
import type { PlayerVoiceState } from './playback/player.types.ts'
import type { ClientInfo } from './shared.types.ts'

/**
 * Data associated with a Bun WebSocket connection
 * Contains client information, session data, and request metadata
 * @public
 */
export interface BunSocketData {
  /**
   * Information about the connected client
   */
  clientInfo: ClientInfo

  /**
   * Session ID if resuming an existing session, null for new connections
   */
  sessionId: string | null

  /**
   * HTTP request headers from the WebSocket upgrade request
   */
  reqHeaders: http.IncomingHttpHeaders

  /**
   * Remote IP address of the client
   */
  remoteAddress: string

  /**
   * Full WebSocket URL from the request
   */
  url: string

  /**
   * Socket wrapper instance for event handling
   * @internal
   */
  wrapper?: IBunSocketWrapper

  /**
   * Pre-parsed pathname from the upgrade request URL
   * @internal
   */
  pathname?: string

  /**
   * Pre-resolved event name to emit on the internal socket bus
   * (`/v4/websocket`, `/v4/websocket/voice`, `/v4/websocket/youtube/live`,
   * or `/v4/profiler/socket`)
   * @internal
   */
  eventName?: string

  /**
   * Pre-extracted route identifier (guildId for voice, videoId/encoded track
   * for live chat); null when not applicable
   * @internal
   */
  routeId?: string | null
}

/**
 * Wrapper for Bun's ServerWebSocket that implements EventEmitter
 * Provides a compatible interface for event-based socket management
 * @public
 */
export interface IBunSocketWrapper extends EventEmitter {
  /**
   * Underlying Bun WebSocket instance
   */
  ws: ServerWebSocket<BunSocketData>

  /**
   * Remote address of the connected client
   */
  remoteAddress: string

  /**
   * Sends data through the WebSocket connection
   * @param data - Data to send (string or Buffer)
   * @returns true if sent successfully, false otherwise
   */
  send(data: string | Buffer): boolean

  /**
   * Sends a WebSocket ping frame
   * @param data - Optional ping data
   * @returns true if sent successfully, false otherwise
   */
  ping(data?: string | Buffer): boolean

  /**
   * Closes the WebSocket connection gracefully
   * @param code - Close code (default: 1000 for normal closure)
   * @param reason - Human-readable close reason
   * @remarks
   * Common close codes:
   * - 1000: Normal closure
   * - 1009: Message too big
   * - 1011: Server error
   * - 1012: Server restarting
   * - 1013: Server too busy / rate limited
   * - 4000-4999: Application-specific codes
   */
  close(code?: number, reason?: string): void

  /**
   * Terminates the connection abruptly
   * @remarks This immediately closes the connection without graceful shutdown
   */
  terminate(): void

  /**
   * Internal handler for received messages
   * @param message - Message data received from the client
   * @internal
   */
  _handleMessage(message: string | Buffer): void

  /**
   * Internal handler for connection close events
   * @param code - Close code received
   * @param reason - Close reason received
   * @internal
   */
  _handleClose(code: number, reason: string): void
}

/**
 * Server instance type used by Nodelink
 * Can be either Bun's native server or Node.js HTTP server
 * @public
 */
export type NodelinkServerType =
  | import('bun').Server<BunSocketData>
  | http.Server
  | null

/**
 * WebSocket server type used by Nodelink
 * Varies based on whether using Bun or Node.js
 * @public
 */
export type NodelinkSocketType = EventEmitter | WebSocketServer | null

/**
 * Git repository information
 * @public
 */
export interface GitInfo {
  /**
   * Current git branch name
   */
  branch: string

  /**
   * Current commit hash
   */
  commit: string

  /**
   * Commit timestamp
   */
  commitTime: number

  /**
   * Current version tag
   */
  tag?: string
}

/**
 * Global server statistics
 * @public
 */
export interface NodelinkStatistics {
  /**
   * Total number of active players across all sessions
   */
  players: number

  /**
   * Number of players currently playing audio
   */
  playingPlayers: number
}

/**
 * Extension system for Nodelink functionality
 * Allows plugins to add custom sources, filters, routes, and interceptors
 * @public
 */
export interface NodelinkExtensions {
  /**
   * Custom audio source providers
   * @example YouTube, Spotify, SoundCloud implementations
   */
  sources: Map<string, SourceExtension>

  /**
   * Custom audio filters
   * @example Equalizer, bassboost, nightcore filters
   */
  filters: Map<string, FilterExtension>

  /**
   * Custom HTTP routes
   */
  routes: RouteExtension[]

  /**
   * HTTP middleware functions
   */
  middlewares: ApiMiddlewareExtension[]

  /**
   * Track data modifiers
   * @remarks Called before track data is returned to clients
   */
  trackModifiers: TrackModifierExtension[]

  /**
   * WebSocket message interceptors
   * @remarks Can block or modify incoming WebSocket messages
   */
  wsInterceptors: WebSocketInterceptorExtension[]

  /**
   * Audio data interceptors
   * @remarks Can modify PCM audio data before playback
   */
  audioInterceptors: AudioInterceptorExtension[]

  /**
   * Player lifecycle interceptors
   * @remarks Called when players are created
   */
  playerInterceptors: PlayerInterceptorExtension[]
}

/**
 * Source search options
 * @public
 */
export interface SourceSearchOptions {
  /**
   * Maximum number of results
   */
  limit?: number

  /**
   * Search offset
   */
  offset?: number

  /**
   * Additional search parameters
   */
  [key: string]: string | number | boolean | undefined
}

/**
 * Source search result
 * @public
 */
export interface SourceSearchResult {
  /**
   * Result type (track, playlist, album, etc.)
   */
  type: 'track' | 'playlist' | 'album' | 'artist'

  /**
   * Tracks in the result
   */
  tracks: TrackData[]

  /**
   * Playlist/album information if applicable
   */
  info?: PlaylistInfo
}

/**
 * Playlist information
 * @public
 */
export interface PlaylistInfo {
  /**
   * Playlist name
   */
  name: string

  /**
   * Selected track index
   */
  selectedTrack?: number
}

/**
 * Custom audio source extension
 * @public
 */
export interface SourceExtension {
  /**
   * Unique name of the audio source
   */
  name: string

  /**
   * Searches for tracks using the source
   * @param query - Search query string
   * @param options - Additional search options
   * @returns Search results
   */
  search: (
    query: string,
    options?: SourceSearchOptions
  ) => Promise<SourceSearchResult>

  /**
   * Loads a specific track by identifier
   * @param identifier - Track identifier (URL, ID, etc.)
   * @returns Track data
   */
  loadTrack?: (identifier: string) => Promise<TrackData>
}

/**
 * Filter apply options
 * @public
 */
export interface FilterOptions {
  /**
   * Filter intensity/strength
   */
  intensity?: number

  /**
   * Additional filter parameters
   */
  [key: string]: string | number | boolean | undefined
}

/**
 * Custom audio filter extension
 * @public
 */
export interface FilterExtension {
  /**
   * Unique name of the filter
   */
  name: string

  /**
   * Applies the filter to audio data
   * @param data - PCM audio buffer
   * @param options - Filter configuration options
   * @returns Filtered audio buffer
   */
  apply: (data: Buffer, options?: FilterOptions) => Buffer | Promise<Buffer>

  /**
   * Additional filter-specific properties
   */
  [key: string]:
    | string
    | number
    | boolean
    | ((data: Buffer, options?: FilterOptions) => Buffer | Promise<Buffer>)
}

/**
 * HTTP request object
 * @public
 */
export interface HttpRequest {
  /**
   * HTTP method
   */
  method: string

  /**
   * Request URL
   */
  url: string

  /**
   * Request headers
   */
  headers: http.IncomingHttpHeaders

  /**
   * Request body
   */
  body?: string | Buffer
}

/**
 * HTTP response object
 * @public
 */
export interface HttpResponse {
  /**
   * Sets response status code
   */
  status: (code: number) => HttpResponse

  /**
   * Sends response data
   */
  send: (
    data: string | Buffer | Record<string, string | number | boolean | null>
  ) => void

  /**
   * Sends JSON response
   */
  json: (
    data: Record<
      string,
      string | number | boolean | null | (string | number | boolean)[]
    >
  ) => void
}

/**
 * Custom HTTP route extension
 * @public
 */
export interface RouteExtension extends ApiRouteExtension {}

/**
 * Track data modifier function
 * @param data - Track data object to modify
 * @public
 */
export type TrackModifierExtension = (data: TrackData) => void

/**
 * Parsed WebSocket message data
 * @public
 */
export type ParsedWebSocketData =
  | string
  | Buffer
  | {
      op: string
      guildId?: string
      track?: string | TrackData
      position?: number
      paused?: boolean
      volume?: number
      filters?: Record<string, number | boolean>
      [key: string]:
        | string
        | number
        | boolean
        | TrackData
        | Record<string, number | boolean>
        | undefined
    }

/**
 * WebSocket interceptor context
 * @public
 */
export interface WebSocketSocket {
  /**
   * Sends data through the socket
   */
  send: (data: string | Buffer) => boolean

  /**
   * Closes the socket
   */
  close: (code?: number, reason?: string) => void
}

/**
 * WebSocket message interceptor function
 * @param nodelink - Nodelink server instance
 * @param socket - WebSocket connection
 * @param data - Parsed message data
 * @param clientInfo - Client information
 * @returns true to block the message, undefined to allow it
 * @public
 */
export type WebSocketInterceptorExtension = (
  nodelink: NodelinkServer,
  socket: WebSocketSocket,
  data: ParsedWebSocketData,
  clientInfo: ClientInfo
) => Promise<boolean | undefined>

/**
 * Audio data interceptor function
 * @param pcm - PCM audio buffer
 * @param sampleRate - Audio sample rate in Hz
 * @param channels - Number of audio channels
 * @param format - Audio format identifier
 * @returns Modified PCM audio buffer
 * @public
 */
export type AudioInterceptorExtension = (
  pcm: Buffer,
  sampleRate: number,
  channels: number,
  format: string
) => Promise<Buffer>

/**
 * Player instance interface
 * @public
 */
export interface Player {
  /**
   * Guild ID this player belongs to
   */
  guildId: string

  /**
   * Current track being played
   */
  track: TrackData | null

  /**
   * Whether the player is paused
   */
  isPaused: boolean

  /**
   * Voice connection instance
   */
  connection: VoiceConnection | null

  /**
   * Current Discord voice connection status
   */
  connStatus: 'connecting' | 'connected' | 'disconnected' | 'destroyed'

  /**
   * Last time stream data was received
   * @internal
   */
  _lastStreamDataTime: number

  /**
   * Sends a player update event
   * @internal
   */
  _sendUpdate: () => void

  /**
   * Emits an event to the client
   */
  emitEvent: (event: string, data: EventData) => void

  /**
   * Destroys the player instance
   */
  destroy?: () => void
}

/**
 * Event data sent to clients
 * @public
 */
export interface EventData {
  /**
   * Guild ID
   */
  guildId: string

  /**
   * Track data if applicable
   */
  track?: TrackData | null

  /**
   * Additional event-specific data
   */
  [key: string]: string | number | boolean | TrackData | null | undefined
}

/**
 * Player interceptor function
 * @param player - Player instance
 * @public
 */
export type PlayerInterceptorExtension = (player: Player) => void

/**
 * Track metadata
 * @public
 */
export interface TrackData {
  /**
   * Encoded track string
   */
  encoded?: string

  /**
   * Track information
   */
  info?: {
    /**
     * Unique track identifier
     */
    identifier: string

    /**
     * Whether this track is seekable
     */
    isSeekable: boolean

    /**
     * Track author/artist name
     */
    author: string

    /**
     * Track duration in milliseconds
     */
    length: number

    /**
     * Whether this is a live stream
     */
    isStream: boolean

    /**
     * Current playback position in milliseconds
     */
    position: number

    /**
     * Track title
     */
    title: string

    /**
     * Track URL/URI
     */
    uri: string

    /**
     * Thumbnail/artwork URL
     */
    artworkUrl: string | null

    /**
     * International Standard Recording Code
     */
    isrc: string | null

    /**
     * Audio source name (youtube, spotify, etc.)
     */
    sourceName: string
  }

  /**
   * Plugin information
   */
  pluginInfo?: Record<string, string | number | boolean>

  /**
   * Additional track-specific properties
   */
  [key: string]:
    | string
    | number
    | boolean
    | Record<string, string | number | boolean | null>
    | null
    | undefined
}

/**
 * Voice frame header information
 * @public
 */
export interface VoiceFrameHeader {
  /**
   * Discord guild (server) ID
   */
  guildId: string

  /**
   * Discord user ID who sent the audio
   */
  userId: string

  /**
   * Sequence number
   */
  sequence: number

  /**
   * Timestamp
   */
  timestamp: number
}

/**
 * Voice frame data received from Discord
 * @public
 */
export interface VoiceFrame {
  /**
   * Discord guild (server) ID
   */
  guildId: string

  /**
   * Discord user ID who sent the audio
   */
  userId: string

  /**
   * PCM audio data buffer
   */
  pcm: Buffer

  /**
   * Audio sample rate in Hz
   */
  sampleRate: number

  /**
   * Number of audio channels
   */
  channels: number

  /**
   * Audio format identifier
   */
  format: string

  /**
   * Frame timestamp in milliseconds
   */
  timestamp: number
}

/**
 * Voice connection instance
 * @public
 */
export interface VoiceConnection {
  /**
   * Guild ID
   */
  guildId: string

  /**
   * Voice channel ID
   */
  channelId: string

  /**
   * Whether the connection is active
   */
  connected: boolean

  /**
   * Voice connection statistics
   * @public
   */
  statistics: {
    /**
     * Total number of packets sent
     */
    packetsSent: number

    /**
     * Total number of packets lost/nulled
     */
    packetsLost: number

    /**
     * Total number of packets expected to be sent
     */
    packetsExpected: number
  }

  /**
   * Sends audio data
   */
  sendAudio: (data: Buffer) => void

  /**
   * Disconnects the voice connection
   */
  disconnect: () => void
}

/**
 * Session socket type
 * @public
 */
export interface SessionSocket {
  /** Optional guild association used by websocket hooks. */
  guildId?: string

  /**
   * Sends data through the socket
   */
  send: (data: string | Buffer) => boolean

  /**
   * Sends a ping frame
   */
  ping?: (data?: string | Buffer) => boolean

  /**
   * Sends a voice frame
   */
  sendFrame?: (
    frame: Buffer,
    options?: { len: number; fin: boolean; opcode: number }
  ) => void

  /**
   * Closes the socket
   */
  close: (code?: number, reason?: string) => void

  /**
   * Destroys the socket
   */
  destroy?: () => void

  /**
   * Adds an event listener
   */
  on: (
    event: string,
    listener: (...args: (string | Buffer | number)[]) => void
  ) => void
}

/**
 * Player manager instance
 * @public
 */
export interface PlayerManagerInstance {
  /**
   * Map of players by guild ID
   */
  players: Map<string, Player>

  /**
   * Gets a player for a guild
   */
  get: (guildId: string) => Player | undefined

  /**
   * Creates a player for a guild
   */
  create: (guildId: string, voice: PlayerVoiceState) => Promise<Player>

  /**
   * Destroys a player
   * @returns A promise that resolves when the player is destroyed
   */
  destroy: (guildId: string) => Promise<void>
}

/**
 * Session instance
 * @public
 */
export interface Session {
  /**
   * Unique session ID
   */
  id: string

  /**
   * Discord user ID associated with the session
   */
  userId?: string | string[]

  /**
   * WebSocket connection
   */
  socket: SessionSocket | null

  /**
   * Player manager for this session
   */
  players: PlayerManagerInstance

  /**
   * Group manager for multi-guild player synchronization
   */
  groups: import('../managers/groupManager.ts').default

  /**
   * Event queue for reconnection
   */
  eventQueue: string[]

  /**
   * Whether the session is in resuming state
   */
  resuming: boolean

  /**
   * Whether the session is paused
   */
  isPaused: boolean

  /**
   * Client information
   */
  clientInfo: ClientInfo

  /**
   * Session timeout in seconds
   */
  timeout: number

  /**
   * Timeout handle for session destruction
   */
  timeoutFuture: NodeJS.Timeout | null
}

/**
 * HTTP request shim for Bun/Node compatibility
 * @public
 */
export interface RequestShim {
  /**
   * HTTP method (GET, POST, etc.)
   */
  method?: string

  /**
   * Request URL path and query
   */
  url?: string

  /**
   * HTTP request headers
   */
  headers: Record<string, string | string[]>

  /**
   * Socket connection information
   */
  socket?: {
    /**
     * Remote IP address
     */
    remoteAddress?: string
  }

  /**
   * End callback for request body streaming
   * @internal
   */
  _endCb?: () => void

  /**
   * Event listener for request events
   * @param event - Event name (e.g., 'data', 'end')
   * @param cb - Event callback function
   */
  on?: (event: string, cb: (data: Buffer) => void) => void
}

/**
 * HTTP response shim for Bun/Node compatibility
 * @public
 */
export interface ResponseShim {
  /**
   * HTTP status code
   * @internal
   */
  _status: number

  /**
   * Response headers
   * @internal
   */
  _headers: http.OutgoingHttpHeaders

  /**
   * Response body chunks
   * @internal
   */
  _body: (string | Buffer)[]

  /**
   * Sets the response status code and headers
   * @param status - HTTP status code
   * @param headers - Optional response headers
   */
  writeHead(status: number, headers?: Record<string, string | string[]>): void

  /**
   * Sets a single response header
   * @param name - Header name
   * @param value - Header value
   */
  setHeader(name: string, value: string | string[]): void

  /**
   * Gets a response header value
   * @param name - Header name
   * @returns Header value or undefined
   */
  getHeader(name: string): string | string[] | undefined

  /**
   * Finishes the response and sends any remaining data
   * @param data - Optional final data to send
   */
  end(data?: string | Buffer): void

  /**
   * Writes data to the response body
   * @param data - Data to write
   */
  write(data: string | Buffer): void
}

/**
 * Property validator function
 * @param value - Value to validate
 * @returns true if valid, false otherwise
 * @public
 */
export type PropertyValidator<T = string | number | boolean | string[]> = (
  value: T
) => boolean

/**
 * Error thrown during configuration loading
 * @public
 */
export interface ConfigLoadError {
  /**
   * Error code (ERR_MODULE_NOT_FOUND, ENOENT, etc.)
   */
  code?: string

  /**
   * Error message
   */
  message: string

  /**
   * Error stack trace
   */
  stack?: string
}

/**
 * Voice relay configuration
 * @public
 */
export interface VoiceRelayConfig {
  /**
   * Whether voice relay is enabled
   */
  enabled: boolean

  /**
   * Audio format for voice data
   */
  format: 'pcm' | 'opus'

  /**
   * Callback for sending voice frames
   */
  sendFrame: (frame: Buffer) => void

  /**
   * Logger function
   */
  logger: (level: string, category: string, message: string) => void
}

/**
 * Voice relay instance
 * @public
 */
export interface VoiceRelay {
  /**
   * Attaches a voice connection
   */
  attach?: (connection: VoiceConnection, guildId: string) => void

  /**
   * Processes incoming voice data
   */
  processVoicePacket?: (guildId: string, userId: string, data: Buffer) => void

  /**
   * Stops the voice relay
   */
  stop?: () => void
}

/**
 * Player manager class type
 * @public
 */
export type PlayerManagerConstructor = new (
  nodelink: NodelinkServer,
  sessionId: string
) => PlayerManagerInstance

/**
 * Worker instance
 * @public
 */
export interface Worker {
  /**
   * Worker ID
   */
  id: number

  /**
   * Worker process
   */
  process: {
    /**
     * Process ID
     */
    pid: number

    /**
     * Sends a message to the worker
     */
    send?: (message: WorkerMessage) => void
  }

  /**
   * Whether the worker is ready
   */
  ready: boolean
}

/**
 * Worker message
 * @public
 */
export interface WorkerMessage {
  /**
   * Message type
   */
  type: 'playerCommand' | 'init' | 'shutdown'

  /**
   * Session ID
   */
  sessionId?: string

  /**
   * Guild ID
   */
  guildId?: string

  /**
   * Command name
   */
  command?: string

  /**
   * Command arguments
   */
  args?: (
    | string
    | number
    | boolean
    | Record<string, string | number | boolean>
  )[]
}

/**
 * Worker metrics
 * @public
 */
export interface WorkerMetrics {
  /**
   * Worker ID
   */
  workerId: number

  /**
   * Number of players
   */
  players: number

  /**
   * Number of players currently playing audio
   */
  playingPlayers: number

  /**
   * Frame statistics for the worker
   */
  frameStats?: {
    /**
     * Number of packets sent
     */
    sent: number

    /**
     * Number of packets nulled
     */
    nulled: number

    /**
     * Number of packets expected
     */
    expected: number
  }

  /**
   * Memory usage
   */
  memory?: {
    used: number
    allocated: number
  }

  /**
   * CPU usage
   */
  cpu?: {
    nodelinkLoad: number
  }
}

/**
 * Context required by the ConnectionManager.
 * Supports both main server and worker processes.
 * @public
 */
export interface ConnectionManagerContext {
  /**
   * Server or worker configuration.
   */
  options: {
    connection?: import('./voice/connection.types.ts').ConnectionConfig
    network?: {
      connection?: import('./voice/connection.types.ts').ConnectionConfig
    }
  }

  /**
   * Session manager (only available on main server).
   */
  sessions?: {
    /**
     * Gets all session values.
     */
    values: () => IterableIterator<{
      socket: {
        send: (data: string | Buffer) => boolean
      } | null
      players: {
        players: Map<string, { guildId: string }>
      }
    }>
  }
}

/**
 * Nodelink server instance
 * @public
 */
export interface NodelinkServer {
  /**
   * Server configuration
   */
  options: NodelinkConfig

  /**
   * Session manager
   */
  sessions: {
    /**
     * Active sessions map
     */
    activeSessions: Map<string, Session>

    /**
     * Resumable sessions map
     */
    resumableSessions: Map<string, Session>

    /**
     * Gets all session values
     */
    values: () => IterableIterator<Session>

    /**
     * Gets a session by ID
     */
    get: (id: string) => Session | undefined

    /**
     * Checks if a session exists
     */
    has: (id: string) => boolean
  }

  /**
   * Worker manager
   */
  workerManager: {
    /**
     * List of workers
     */
    workers: Worker[]

    /**
     * Map of worker statistics
     */
    workerStats: Map<number, WorkerMetrics>

    /**
     * Worker load map
     */
    workerLoad: Map<number, number>

    /**
     * Gets worker for a guild
     */
    getWorkerForGuild: (guildId: string) => Worker | null

    /**
     * Executes a command on a worker
     */
    execute: (worker: Worker, type: string, payload: WorkerMessage) => void

    /**
     * Gets worker metrics
     */
    getWorkerMetrics: () => Record<string, WorkerMetricsEntry>
  } | null

  /**
   * Global server statistics
   */
  statistics: NodelinkStatistics

  /**
   * Voice sockets map
   */
  voiceSockets: Map<string, Set<SessionSocket>>

  /**
   * Extension system
   */
  extensions?: NodelinkExtensions
}
