import type { Readable } from 'node:stream'
import type {
  VoiceAudioStream,
  VoiceConnection,
  VoicePlayerState
} from '@performanc/voice'
import type { TrackData } from '../index.types.ts'
import type {
  TrackStreamResult,
  TrackUrlResult
} from '../sources/source.types.ts'

/**
 * Runtime filter settings applied to an audio stream.
 */
export interface FiltersState {
  filters?: Record<string, unknown> & {
    timescale?: { speed?: number; pitch?: number; rate?: number }
  }
}

/**
 * Single fade segment configuration.
 */
export interface FadingSection {
  duration: number
  curve?: string
  type?: 'volume' | 'tape' | 'scratch' | 'both'
}

/**
 * Composite fading configuration for different playback actions.
 */
export interface FadingConfig {
  enabled?: boolean
  trackStart?: FadingSection
  trackEnd?: FadingSection
  trackStop?: FadingSection
  seek?: FadingSection
  pause?: FadingSection
  resume?: FadingSection
  ducking?: import('./ducking.types.ts').DuckingConfig
}

/**
 * Voice connection state used to resume or update sessions.
 */
export interface PlayerVoiceState {
  sessionId: string | null
  token: string | null
  endpoint: string | null
  channelId: string | null
}

/**
 * Snapshot of player runtime metrics sent to clients.
 */
export interface PlayerEventState {
  time: number
  position: number
  connected: boolean
  ping: number
}

/**
 * Timestamped lyric line with optional per-word metadata.
 */
export interface LyricsLine {
  timestamp: number
  duration: number
  line: string
  words: Array<Record<string, unknown>>
  plugin: Record<string, unknown>
}

/**
 * Full lyrics payload emitted to clients.
 */
export interface LyricsPayload {
  sourceName: string
  provider: string
  text: string
  lines: LyricsLine[]
  plugin: Record<string, unknown>
}

/**
 * Stream format indicator. Can be a simple string or a detailed object.
 */
export type TrackFormat = string | { itag?: number; [key: string]: unknown }

type BaseTrackInfo = NonNullable<TrackData['info']> & {
  artworkUrl: string | null
  isrc: string | null
  uri: string
}

/**
 * Track metadata enriched with optional artwork and identifiers.
 */
export type TrackInfoExtended = BaseTrackInfo & {
  audioTrackId?: string
}

/**
 * Track data used internally by the player.
 */
export interface PlayerTrack {
  encoded?: string
  info: TrackInfoExtended
  endTime?: number
  userData?: unknown
  audioTrackId?: string
  pluginInfo?: Record<string, unknown>
  [key: string]: unknown
}

export type StreamInfo =
  | (TrackUrlResult & {
      trackInfo?: TrackInfoExtended
      format?: TrackFormat
      protocol?: string
    })
  | null

/**
 * Audio resource abstraction returned by stream processor.
 */
export interface AudioResource {
  setVolume(volume: number): void
  setFilters(filters: FiltersState): void
  setFadeVolume?(volume: number): void
  fadeTo?(volume: number, durationMs: number, curve?: string): void
  tapeTo?(durationMs: number, type: 'start' | 'stop', curve?: string): void
  checkTapeRampCompleted?(): boolean
  scratchTo?(
    durationMs: number,
    style: import('./processing.types.ts').ScratchStyle
  ): void
  checkScratchEffectCompleted?(): boolean
  getEffectiveRate?: () => number
  getRMS?: () => number
  isSilent?: () => boolean
  setLoudnessNormalizer?(enabled: boolean): void
  destroy(): void
  stream?: VoiceAudioStream | null
}

export interface ExtendedVoiceConnection extends VoiceConnection {
  audioStream?: VoiceAudioStream | null
  udp?: { flush?: () => void }
  playerState?: VoicePlayerState & { reason?: string }
}

export interface TrackEnergy {
  rms: number
}

/** Supported crossfade buffering modes. */
export type CrossfadeMode = 'preload' | 'stream'

/** Per-player crossfade configuration. */
export interface CrossfadeConfig {
  enabled?: boolean
  duration?: number
  curve?: import('./processing.types.ts').FadeCurve
  mode?: CrossfadeMode
  minBufferMs?: number
  bufferMs?: number
}

/** PCM buffering options passed to the crossfade controller. */
export interface CrossfadePrepareOptions {
  durationMs: number
  minBufferMs?: number
  bufferMs?: number
}

export interface ExtendedAudioStream extends AudioResource {
  getMainEnergy?: () => TrackEnergy | null
  destroyed?: boolean
  _cleanupListeners?: () => void
  pipes?: Array<{ destroy?: () => void }>
  isPipelineFinished?: () => boolean
  getConsumedMs?: () => number
  prepareCrossfade?(
    stream: Readable,
    options: CrossfadePrepareOptions,
    onComplete: (consumedMs: number) => void
  ): boolean
  startCrossfade?(
    durationMs?: number,
    curve?: string,
    availableMs?: number
  ): boolean
  clearCrossfade?(): void
  setCrossfadePaused?(paused: boolean): void
  getCrossfadeState?(): {
    active: boolean
    bufferedMs: number
    isBridging: boolean
  }
}

export interface FilterTransitionsConfig {
  enabled?: boolean
  durationMs?: number
  curve?: string
}

export interface FilterStateTransition {
  durationMs?: number
  curve?: string
}

export interface FilterStateEntry extends Record<string, unknown> {
  _disabled?: boolean
  transition?: FilterStateTransition
}

export interface DeezerTrackMetadata {
  bpm?: number | string | null
  gain?: number | string | null
  [key: string]: unknown
}

export type PlayerPluginInfo = Record<string, unknown> & {
  deezer?: DeezerTrackMetadata
  deezerMetadata?: DeezerTrackMetadata
}

/**
 * Mixer interface used to blend PCM layers.
 */
export interface AudioMixer {
  autoCleanup?: boolean
  enabled?: boolean
  mixLayers: Map<
    string,
    {
      id: string
      track: PlayerTrack
      volume: number
      position: number
      startTime: number
    }
  >
  addLayer: (
    stream: VoiceAudioStream,
    track: PlayerTrack,
    volume?: number | null
  ) => string
  removeLayer: (id: string, reason?: string) => boolean
  updateLayerVolume: (id: string, volume: number) => boolean
  getLayers: () => Array<{
    id: string
    track: PlayerTrack
    volume: number
    position: number
    startTime: number
  }>
  clearLayers: (reason?: string) => number
  readLayerChunks: (
    chunkSize: number
  ) => Map<string, { buffer: Buffer; volume: number }>
  mixBuffers: (
    mainPCM: Buffer,
    layersPCM: Map<string, { buffer: Buffer; volume: number }>
  ) => Buffer
  hasActiveLayers: () => boolean
  destroy: () => this
  on: (
    event: 'mixStarted' | 'mixEnded' | 'mixError',
    listener: (data: {
      id: string
      track?: PlayerTrack
      volume?: number
      reason?: string
      error?: Error
    }) => void
  ) => void
}

/**
 * Timer handles used for fade scheduling.
 */
export interface FadeTimers {
  trackEnd: NodeJS.Timeout | null
  pause:
    | NodeJS.Timeout
    | { interval: NodeJS.Timeout; timeout?: NodeJS.Timeout }
    | null
  stop:
    | NodeJS.Timeout
    | { interval: NodeJS.Timeout; timeout?: NodeJS.Timeout }
    | null
}

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

export interface PlayerSponsorBlockState {
  enabled: boolean
  categories: string[]
  actionTypes: string[]
  segments: SponsorBlockSegment[]
  lastSkippedUuid: string | null
  skipMarginMs: number
}

/**
 * NodeLink runtime options relevant to playback.
 */
export interface NodeLinkOptions {
  defaultVolume?: number
  eventTimeoutMs?: number
  trackStuckThresholdMs: number
  playerUpdateInterval: number
  enableHoloTracks?: boolean
  fetchChannelInfo?: boolean
  resolveExternalLinks?: boolean
  sponsorblock?: {
    enabled?: boolean
    api?: string
    categories?: string[]
    actionTypes?: string[]
    skipMarginMs?: number
  }
  audio?: {
    encryption?: string | null
    fading?: FadingConfig
    loudnessNormalizer?: boolean
    resamplingQuality?: string
    lookaheadMs?: number
    gateThresholdLUFS?: number
    filterTransitions?: FilterTransitionsConfig
    crossfade?: CrossfadeConfig
    automix?: {
      enabled?: boolean
      silenceThresholdDb?: number
    }
  }
  mix?: {
    enabled?: boolean
    defaultVolume?: number
    maxLayersMix?: number
    autoCleanup?: boolean
  }
  connection?: import('../voice/connection.types.ts').ConnectionConfig
  search: {
    maxResults?: number
    defaultSource?: string | string[]
    unifiedSources?: string[]
    resolveExternalLinks?: boolean
    fetchChannelInfo?: boolean
    [key: string]: unknown
  }
  playback: {
    maxPlaylistLength?: number
    playerUpdateInterval?: number
    statsUpdateInterval?: number
    trackStuckThresholdMs?: number
    eventTimeoutMs?: number
    zombieThresholdMs?: number
    sponsorblock?: NodeLinkOptions['sponsorblock']
    filters?: { enabled?: Record<string, boolean> }
    audio?: NodeLinkOptions['audio']
    voiceReceive?: { enabled?: boolean; format?: string }
    mix?: NodeLinkOptions['mix']
    [key: string]: unknown
  }
  experimental: {
    enableHoloTracks?: boolean
    [key: string]: unknown
  }
  network: {
    proxy?: {
      enabled?: boolean
      list?: unknown[]
      [key: string]: unknown
    }
    connection?: import('../voice/connection.types.ts').ConnectionConfig
    routePlanner?: {
      strategy?: string
      bannedIpCooldown?: number
      ipBlocks?: Array<string | { cidr: string }>
      [key: string]: unknown
    }
    [key: string]: unknown
  }
}

export type AudioOptionsWithTransitions = NonNullable<
  NodeLinkOptions['audio']
> & {
  filterTransitions?: FilterTransitionsConfig
}

/**
 * Minimal source manager contract used by the player.
 */
export interface SourceManagerLike {
  getTrackUrl: (
    trackInfo: TrackInfoExtended,
    itag?: number,
    isRecovering?: boolean
  ) => Promise<
    TrackUrlResult & {
      protocol?: string
      format?: TrackFormat
      trackInfo?: TrackInfoExtended
      additionalData?: Record<string, unknown>
    }
  >
  getTrackStream: (
    trackInfo: TrackInfoExtended,
    url: string,
    protocol?: string,
    additionalData?: Record<string, unknown>
  ) => Promise<
    TrackStreamResult & { type?: string; exception?: { message: string } }
  >
  getSource: (
    name: string
  ) => import('../sources/source.types.ts').SourceInstance | null
}

/**
 * Lyrics provider interface.
 */
export interface LyricsManagerLike {
  loadLyrics: (
    track: { info: TrackInfoExtended },
    token?: unknown,
    skip?: boolean
  ) => Promise<{
    loadType: 'lyrics'
    data: {
      provider: string
      lines: Array<{
        time: number
        duration?: number
        text: string
        words?: Array<Record<string, unknown>>
      }>
    }
  } | null>
}

/**
 * Basic statistics collector used for playback events.
 */
export interface StatsManagerLike {
  incrementPlaybackEvent: (event: string) => void
}

/**
 * Logging function signature.
 */
export type LoggerFn = (level: string, ...args: unknown[]) => void

/**
 * NodeLink runtime context required by the player.
 */
export interface NodeLink {
  options: NodeLinkOptions & {
    trackStuckThresholdMs: number
    playerUpdateInterval: number
  }
  logger: LoggerFn
  statsManager: StatsManagerLike
  voiceRelay?: {
    attach?: (connection: VoiceConnection, guildId: string) => void
    detach?: (connection: VoiceConnection) => void
  }
  sources: SourceManagerLike
  lyrics: LyricsManagerLike | null
  statistics?: { players?: number }
  extensions?: {
    audioInterceptors?: Array<() => import('node:stream').Transform>
  } & Record<string, unknown>
  pluginManager?: import('../../managers/pluginManager.ts').default | null
  trackCacheManager?:
    | import('../../managers/trackCacheManager.ts').default
    | null
  getLyricsManager?: () => Promise<LyricsManagerLike>
  [key: string]: unknown
}

/**
 * Session context for the websocket client controlling the player.
 */
export interface Session {
  id: string
  userId: string
  socket: { send: (data: string) => void }
  isPaused: boolean
  eventQueue: string[]
}

/**
 * Player constructor options.
 */
export interface PlayerOptions {
  nodelink: NodeLink
  session: Session
  guildId: string
}

/**
 * Payload accepted by the play operation.
 */
export interface PlayPayload {
  encoded?: string
  info: TrackInfoExtended
  userData?: unknown
  audioTrackId?: string
  noReplace?: boolean
  startTime?: number
  endTime?: number
}

/**
 * JSON-safe representation of a player used in gateway events.
 */
export interface PlayerStateJSON {
  guildId: string
  track: PlayerTrack | null
  volume: number
  fading?: FadingConfig | undefined
  crossfade?: CrossfadeConfig | undefined
  loudnessNormalizer: boolean
  paused: boolean
  filters: FiltersState
  state: PlayerEventState
  voice: PlayerVoiceState
}

/**
 * Factory signature for creating audio resources.
 */
export type CreateAudioResource = (
  guildId: string,
  stream: TrackStreamResult['stream'],
  type: unknown,
  nodelink: NodeLink,
  initialFilters: FiltersState,
  volume: number,
  audioMixer: AudioMixer | null,
  returnPCM?: boolean,
  loudnessNormalizer?: boolean,
  enableCrossfade?: boolean
) => AudioResource

/**
 * Factory signature for creating seekable audio resources.
 */
export type CreateSeekeableAudioResource = (
  guildId: string,
  url: string,
  seekTime: number,
  endTime: number | undefined,
  nodelink: NodeLink,
  initialFilters: FiltersState,
  player: { streamInfo: StreamInfo; loudnessNormalizer?: boolean },
  volume: number,
  audioMixer: AudioMixer | null,
  returnPCM?: boolean,
  enableAGC?: boolean,
  enableCrossfade?: boolean
) => Promise<
  AudioResource | { exception: { message: string; severity?: string } }
>
