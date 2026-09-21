/**
 * SoundCloud Source Type Definitions
 * Shared types for SoundCloud data processing and API interactions.
 *
 * @packageDocumentation
 * @module SoundCloudTypes
 */

import type { Readable } from 'node:stream'
import type {
  PlaylistData,
  SourceResult,
  TrackCacheManager,
  TrackData,
  TrackStreamResult,
  TrackUrlResult,
  WorkerNodeLink
} from './source.types.ts'

/**
 * Valid SoundCloud search type identifiers.
 *
 * Used to specify what kind of content to search for on SoundCloud.
 * Each type maps to a specific API endpoint.
 *
 * @example
 * ```typescript
 * const searchType: SoundCloudSearchType = 'tracks';
 * const endpoint = getSearchEndpoint(searchType); // '/search/tracks'
 * ```
 *
 * @public
 */
export type SoundCloudSearchType =
  | 'tracks'
  | 'users'
  | 'albums'
  | 'playlists'
  | 'all'

/**
 * Mapping of search type aliases to canonical types.
 *
 * Supports various user-facing aliases (e.g., 'sounds', 'music', 'set')
 * and normalizes them to API-compatible types.
 *
 * @example
 * ```typescript
 * const type = SEARCH_TYPE_MAP['sounds']; // 'tracks'
 * const type2 = SEARCH_TYPE_MAP['artists']; // 'users'
 * ```
 *
 * @public
 */
export const SEARCH_TYPE_MAP: Record<string, SoundCloudSearchType> = {
  track: 'tracks',
  tracks: 'tracks',
  sounds: 'tracks',
  sound: 'tracks',
  user: 'users',
  users: 'users',
  people: 'users',
  artist: 'users',
  artists: 'users',
  album: 'albums',
  albums: 'albums',
  playlist: 'playlists',
  playlists: 'playlists',
  set: 'playlists',
  sets: 'playlists',
  all: 'all',
  everything: 'all'
}

/**
 * SoundCloud API media transcoding format information.
 *
 * Describes the protocol, MIME type, and quality of an available stream.
 *
 * @example
 * ```typescript
 * const format: SoundCloudApiTranscodingFormat = {
 *   protocol: 'progressive',
 *   mime_type: 'audio/mpeg'
 * };
 * ```
 *
 * @public
 */
export interface SoundCloudApiTranscodingFormat {
  /**
   * Streaming protocol used for playback.
   *
   * - `'progressive'` - Direct HTTP download (preferred for compatibility)
   * - `'hls'` - HTTP Live Streaming (adaptive bitrate)
   *
   * @example 'progressive'
   */
  protocol?: 'progressive' | 'hls'

  /**
   * MIME type of the audio stream.
   *
   * @example 'audio/mpeg'
   * @example 'audio/aac'
   */
  mime_type?: string
}

/**
 * Individual transcoding entry in the media transcodings array.
 *
 * Each transcoding represents a different stream format/quality available
 * for a track. The source selects the best available transcoding based
 * on format preference and protocol support.
 *
 * @example
 * ```typescript
 * const transcoding: SoundCloudApiTranscoding = {
 *   url: 'https://api-v2.soundcloud.com/media/soundcloud:tracks:123/stream/hls',
 *   format: { protocol: 'hls', mime_type: 'audio/aac' },
 *   quality: 'hq'
 * };
 * ```
 *
 * @public
 */
export interface SoundCloudApiTranscoding {
  /**
   * API endpoint URL for this transcoding.
   *
   * Requires client_id parameter to resolve to the actual stream URL.
   *
   * @example 'https://api-v2.soundcloud.com/media/soundcloud:tracks:123/stream/progressive'
   */
  url?: string

  /**
   * Format information for this transcoding.
   */
  format?: SoundCloudApiTranscodingFormat

  /**
   * Quality identifier for this transcoding.
   *
   * - `'sq'` - Standard quality (128kbps)
   * - `'hq'` - High quality (256kbps)
   *
   * @example 'hq'
   */
  quality?: 'sq' | 'hq'

  /**
   * Preset name identifying the encoding profile.
   *
   * @example 'mp3_0_1'
   * @example 'aac_160'
   */
  preset?: string
}

/**
 * Media transcodings wrapper from SoundCloud API track response.
 *
 * Contains all available stream formats for a track.
 *
 * @public
 */
export interface SoundCloudApiMedia {
  /**
   * Array of available transcodings.
   */
  transcodings?: SoundCloudApiTranscoding[]
}

/**
 * Publisher metadata from SoundCloud API track response.
 *
 * Contains ISRC (International Standard Recording Code) and other
 * publishing information.
 *
 * @public
 */
export interface SoundCloudApiPublisherMetadata {
  /**
   * International Standard Recording Code.
   *
   * Unique identifier for the recording, useful for matching across services.
   *
   * @example 'USRC17607892'
   */
  isrc?: string

  /**
   * Publisher/label name.
   */
  publisher?: string

  /**
   * Allow additional unknown properties.
   */
  [key: string]: unknown
}

/**
 * User/artist object from SoundCloud API responses.
 *
 * Represents a SoundCloud user profile embedded in track and playlist responses.
 *
 * @example
 * ```typescript
 * const user: SoundCloudApiUser = {
 *   id: 123456,
 *   username: 'Artist Name',
 *   permalink_url: 'https://soundcloud.com/artistname',
 *   avatar_url: 'https://i1.sndcdn.com/avatars/...'
 * };
 * ```
 *
 * @public
 */
export interface SoundCloudApiUser {
  /**
   * Unique numeric user identifier.
   */
  id?: number

  /**
   * Display name of the user.
   */
  username?: string

  /**
   * Full name (first + last) if provided.
   */
  full_name?: string

  /**
   * Canonical SoundCloud profile URL.
   */
  permalink_url?: string

  /**
   * Avatar/thumbnail URL.
   */
  avatar_url?: string | null

  /**
   * User's banner image URL.
   */
  banner_url?: string | null

  /**
   * User biography/description.
   */
  description?: string

  /**
   * Number of followers.
   */
  followers_count?: number

  /**
   * Number of users this user follows.
   */
  followings_count?: number

  /**
   * Number of tracks uploaded.
   */
  track_count?: number

  /**
   * Number of public playlists.
   */
  playlist_count?: number

  /**
   * Whether the user is verified.
   */
  verified?: boolean

  /**
   * Entity type identifier.
   */
  kind?: 'user'

  /**
   * Allow additional unknown properties.
   */
  [key: string]: unknown
}

/**
 * Track object from SoundCloud API responses.
 *
 * Represents a single audio track with full metadata.
 *
 * @example
 * ```typescript
 * const track: SoundCloudApiTrack = {
 *   id: 123456789,
 *   title: 'Track Title',
 *   duration: 240000,
 *   permalink_url: 'https://soundcloud.com/artist/track',
 *   user: { username: 'Artist Name' },
 *   media: { transcodings: [...] }
 * };
 * ```
 *
 * @public
 */
export interface SoundCloudApiTrack {
  /**
   * Unique numeric track identifier.
   */
  id?: number

  /**
   * Track title.
   */
  title?: string

  /**
   * Track duration in milliseconds.
   */
  duration?: number

  /**
   * Canonical SoundCloud track URL.
   */
  permalink_url?: string

  /**
   * Artwork/thumbnail URL.
   *
   * May be `null` for tracks without custom artwork.
   */
  artwork_url?: string | null

  /**
   * User/artist who uploaded the track.
   */
  user?: SoundCloudApiUser

  /**
   * Media transcodings for playback.
   */
  media?: SoundCloudApiMedia

  /**
   * Publisher metadata including ISRC.
   */
  publisher_metadata?: SoundCloudApiPublisherMetadata

  /**
   * Track description.
   */
  description?: string

  /**
   * Genre tags.
   */
  genre?: string

  /**
   * Tags associated with the track.
   */
  tag_list?: string | string[]

  /**
   * Download/play count.
   */
  playback_count?: number

  /**
   * Number of downloads.
   */
  download_count?: number

  /**
   * Number of likes/favorites.
   */
  likes_count?: number

  /**
   * Number of comments.
   */
  comment_count?: number

  /**
   * Whether the track is publicly downloadable.
   */
  downloadable?: boolean

  /**
   * Whether the track has public comments.
   */
  commentable?: boolean

  /**
   * Creation timestamp (ISO 8601).
   */
  created_at?: string

  /**
   * Last modified timestamp (ISO 8601).
   */
  last_modified?: string

  /**
   * License type (e.g., 'all-rights-reserved', 'cc-by').
   */
  license?: string

  /**
   * Waveform URL for visualizations.
   */
  waveform_url?: string

  /**
   * BPM (beats per minute) if available.
   */
  bpm?: number

  /**
   * Key signature if available.
   */
  key?: string

  /**
   * Entity type identifier.
   */
  kind?: 'track'

  /**
   * HLS stream URL (legacy field, 160kbps).
   *
   * @deprecated Use media.transcodings instead
   */
  hls_aac_160_url?: string

  /**
   * HLS stream URL (legacy field, 96kbps).
   *
   * @deprecated Use media.transcodings instead
   */
  hls_aac_96_url?: string

  /**
   * Playback access granted by SoundCloud.
   */
  access?: 'playable' | 'preview' | 'blocked'

  /**
   * Preview URL for restricted tracks.
   */
  preview_url?: string

  /**
   * Whether this is a snippet/preview only.
   */
  snippet?: boolean

  /**
   * Allow additional unknown properties.
   */
  [key: string]: unknown
}

/**
 * Playlist/album object from SoundCloud API responses.
 *
 * Represents a collection of tracks (playlist or album).
 *
 * @example
 * ```typescript
 * const playlist: SoundCloudApiPlaylist = {
 *   id: 987654,
 *   title: 'My Playlist',
 *   permalink_url: 'https://soundcloud.com/user/sets/my-playlist',
 *   track_count: 10,
 *   tracks: [...],
 *   is_album: false
 * };
 * ```
 *
 * @public
 */
export interface SoundCloudApiPlaylist {
  /**
   * Unique numeric playlist identifier.
   */
  id?: number

  /**
   * Playlist title.
   */
  title?: string

  /**
   * Canonical SoundCloud playlist URL.
   */
  permalink_url?: string

  /**
   * Artwork/thumbnail URL.
   */
  artwork_url?: string | null

  /**
   * User/creator of the playlist.
   */
  user?: SoundCloudApiUser

  /**
   * Playlist description.
   */
  description?: string

  /**
   * Number of tracks in the playlist.
   */
  track_count?: number

  /**
   * Total duration in milliseconds.
   */
  duration?: number

  /**
   * Array of track objects or partial track references.
   *
   * May contain full track objects or minimal references with only `id`.
   * Partial tracks require additional API calls to fetch full metadata.
   */
  tracks?: Array<SoundCloudApiTrack | { id: number }>

  /**
   * Whether this playlist is an album.
   */
  is_album?: boolean

  /**
   * Album type if this is an album.
   */
  album_type?: string

  /**
   * Number of likes.
   */
  likes_count?: number

  /**
   * Creation timestamp (ISO 8601).
   */
  created_at?: string

  /**
   * Last modified timestamp (ISO 8601).
   */
  last_modified?: string

  /**
   * Whether the playlist is public.
   */
  public?: boolean

  /**
   * Entity type identifier.
   */
  kind?: 'playlist'

  /**
   * Genre tags.
   */
  genre?: string

  /**
   * Tags associated with the playlist.
   */
  tag_list?: string | string[]

  /**
   * Allow additional unknown properties.
   */
  [key: string]: unknown
}

/**
 * Search result collection item from SoundCloud API.
 *
 * Can be any entity type returned by search endpoints.
 *
 * @public
 */
export type SoundCloudApiSearchItem =
  | SoundCloudApiTrack
  | SoundCloudApiUser
  | SoundCloudApiPlaylist

/**
 * Search response from SoundCloud API endpoints.
 *
 * Supports pagination via `next_href` for large result sets.
 *
 * @example
 * ```typescript
 * const response: SoundCloudApiSearchResponse = {
 *   collection: [track1, track2, track3],
 *   total_results: 1500,
 *   next_href: 'https://api-v2.soundcloud.com/search/tracks?...'
 * };
 * ```
 *
 * @public
 */
export interface SoundCloudApiSearchResponse {
  /**
   * Array of search result items.
   */
  collection?: SoundCloudApiSearchItem[]

  /**
   * Total number of matching results.
   */
  total_results?: number

  /**
   * URL for the next page of results.
   */
  next_href?: string

  /**
   * Facet results for 'all' search type.
   */
  facet_results?: Record<string, unknown>

  /**
   * Allow additional unknown properties.
   */
  [key: string]: unknown
}

/**
 * Resolve endpoint response wrapper.
 *
 * SoundCloud's resolve endpoint returns different structures based on
 * the resolved entity type.
 *
 * @public
 */
export type SoundCloudApiResolveResponse =
  | SoundCloudApiTrack
  | SoundCloudApiPlaylist

/**
 * Batch tracks endpoint response.
 *
 * Returns an array of track objects when fetching multiple tracks by ID.
 *
 * @public
 */
export type SoundCloudApiBatchTracksResponse = SoundCloudApiTrack[]

/**
 * Plugin metadata for SoundCloud user results.
 *
 * Attached to search results of type 'user'.
 *
 * @example
 * ```typescript
 * const pluginInfo: SoundCloudUserPluginInfo = {
 *   type: 'user',
 *   followers: 15000,
 *   trackCount: 42
 * };
 * ```
 *
 * @public
 */
export interface SoundCloudUserPluginInfo extends Record<string, unknown> {
  /**
   * Result type identifier.
   */
  type: 'user'

  /**
   * Number of followers the user has.
   */
  followers?: number

  /**
   * Number of tracks the user has uploaded.
   */
  trackCount?: number
}

/**
 * Plugin metadata for SoundCloud album results.
 *
 * Attached to search results of type 'album'.
 *
 * @example
 * ```typescript
 * const pluginInfo: SoundCloudAlbumPluginInfo = {
 *   type: 'album',
 *   trackCount: 12
 * };
 * ```
 *
 * @public
 */
export interface SoundCloudAlbumPluginInfo extends Record<string, unknown> {
  /**
   * Result type identifier.
   */
  type: 'album'

  /**
   * Number of tracks in the album.
   */
  trackCount?: number
}

/**
 * Plugin metadata for SoundCloud playlist results.
 *
 * Attached to search results of type 'playlist'.
 *
 * @example
 * ```typescript
 * const pluginInfo: SoundCloudPlaylistPluginInfo = {
 *   type: 'playlist',
 *   trackCount: 25
 * };
 * ```
 *
 * @public
 */
export interface SoundCloudPlaylistPluginInfo extends Record<string, unknown> {
  /**
   * Result type identifier.
   */
  type: 'playlist'

  /**
   * Number of tracks in the playlist.
   */
  trackCount?: number
}

/**
 * Union type of all SoundCloud plugin info types.
 *
 * Discriminated by the `type` field.
 *
 * @public
 */
export type SoundCloudPluginInfo =
  | SoundCloudUserPluginInfo
  | SoundCloudAlbumPluginInfo
  | SoundCloudPlaylistPluginInfo
  | Record<string, never>

/**
 * Track data object for SoundCloud track results.
 *
 * Extends the base TrackData with SoundCloud-specific plugin info.
 *
 * @public
 */
export interface SoundCloudTrackData extends TrackData {
  /**
   * SoundCloud-specific metadata.
   */
  pluginInfo: SoundCloudPluginInfo
}

/**
 * Playlist data object for SoundCloud playlist/album results.
 *
 * @public
 */
export interface SoundCloudPlaylistData extends PlaylistData {
  /**
   * Tracks in the playlist.
   */
  tracks: SoundCloudTrackData[]
}

/**
 * Parsed search identifier result.
 *
 * Returned by `_parseSearchIdentifier` method.
 *
 * @example
 * ```typescript
 * const parsed: SoundCloudParsedSearch = {
 *   type: 'tracks',
 *   query: 'never gonna give you up'
 * };
 * ```
 *
 * @public
 */
export interface SoundCloudParsedSearch {
  /**
   * Normalized search type.
   */
  type: SoundCloudSearchType

  /**
   * Cleaned search query string.
   */
  query: string
}

/**
 * Stream URL resolve result from transcoding selection.
 *
 * Contains the final stream URL and format information after
 * selecting the best available transcoding.
 *
 * @example
 * ```typescript
 * const result: SoundCloudStreamUrlResult = {
 *   url: 'https://cf-media.sndcdn.com/...',
 *   protocol: 'progressive',
 *   format: 'mp3',
 *   additionalData: { format: 'mp3' }
 * };
 * ```
 *
 * @public
 */
export interface SoundCloudStreamUrlResult extends TrackUrlResult {
  /**
   * Resolved stream URL.
   */
  url?: string

  /**
   * Streaming protocol.
   *
   * - `'progressive'` - Direct HTTP download
   * - `'hls'` - HTTP Live Streaming
   */
  protocol?: string

  /**
   * Audio format identifier.
   *
   * - `'mp3'` - MP3/MPEG audio
   * - `'m4a'` - AAC in M4A container (progressive)
   * - `'aac_hls'` - AAC via HLS
   * - `'opus'` - Opus codec
   * - `'arbitrary'` - Unknown format
   * - `{ itag: number }` - YouTube-style format object
   */
  format?: string | Record<string, unknown>

  /**
   * Additional format metadata.
   */
  additionalData?: {
    /**
     * Stream format identifier.
     */
    format?: string

    /**
     * Allow additional properties.
     */
    [key: string]: unknown
  }
}

/**
 * Stream loading result for SoundCloud tracks.
 *
 * Contains the audio stream and type information.
 *
 * @public
 */
export interface SoundCloudStreamResult extends TrackStreamResult {
  /**
   * Audio stream (PassThrough for progressive, HLSHandler for HLS).
   */
  stream?: Readable

  /**
   * Detected media type string.
   *
   * @example 'mp3'
   * @example 'fmp4-buffered'
   * @example 'mpegts'
   */
  type?: string
}

/**
 * Official SoundCloud stream response.
 *
 * Returned by the authenticated /tracks/{track_urn}/streams endpoint.
 */
export interface SoundCloudOfficialStreamsResponse {
  hls_aac_160_url?: string
  hls_aac_96_url?: string
  hls_mp3_128_url?: string
  hls_opus_64_url?: string
  http_mp3_128_url?: string
  http_mp3_128_url_legacy?: string
  preview_mp3_128_url?: string
  [key: string]: unknown
}

/**
 * Source-level configuration options for SoundCloud.
 *
 * Pulled from `nodelink.options.sources.soundcloud`.
 *
 * @example
 * ```typescript
 * const config: SoundCloudSourceOptions = {
 *   clientId: 'your-client-id',
 *   maxSearchResults: 50,
 *   maxAlbumPlaylistLength: 500
 * };
 * ```
 *
 * @public
 */
export interface SoundCloudSourceOptions {
  /**
   * Pre-configured SoundCloud API client ID.
   *
   * If provided, skips the client ID extraction from SoundCloud pages.
   */
  clientId?: string

  /**
   * SoundCloud API client secret for official OAuth access.
   */
  clientSecret?: string

  /**
   * Maximum number of search results to return.
   *
   * @default 50
   */
  maxSearchResults?: number

  /**
   * Maximum number of tracks to load from playlists/albums.
   *
   * @default 100
   */
  maxAlbumPlaylistLength?: number

  /**
   * Allow additional unknown configuration keys.
   */
  [key: string]: unknown
}

/**
 * Runtime NodeLink context required by SoundCloud source.
 *
 * Extends the base WorkerNodeLink with SoundCloud-specific options.
 *
 * @public
 */
export interface SoundCloudNodeLinkContext extends WorkerNodeLink {
  /**
   * Runtime options used by the source.
   */
  options: WorkerNodeLink['options'] & {
    /**
     * Maximum search results to return.
     */
    maxSearchResults?: number

    /**
     * Maximum tracks to load from playlists/albums.
     */
    maxAlbumPlaylistLength?: number

    /**
     * Source-specific configuration.
     */
    sources?: {
      soundcloud?: SoundCloudSourceOptions
      [key: string]: unknown
    }
  }

  /**
   * Credential manager for client ID caching.
   */
  credentialManager: NonNullable<WorkerNodeLink['credentialManager']>

  /**
   * Track cache manager for URL caching.
   */
  trackCacheManager: TrackCacheManager

  /**
   * Route planner for IP rotation (optional).
   */
  routePlanner?: WorkerNodeLink['routePlanner']
}

/**
 * Error payload used by SoundCloud source.
 *
 * @public
 */
export interface SoundCloudErrorPayload {
  /**
   * Error message text.
   */
  message: string

  /**
   * Error severity category.
   *
   * @default 'fault'
   */
  severity: 'common' | 'suspicious' | 'fault'

  /**
   * Error cause identifier.
   */
  cause?: string
}

/**
 * Cached track URL entry in the track cache.
 *
 * Stored with the key `soundcloud:{trackId}`.
 *
 * @public
 */
export interface SoundCloudCachedUrlResult {
  /**
   * Cached stream URL.
   */
  url: string

  /**
   * Stream protocol.
   */
  protocol: 'progressive' | 'hls'

  /**
   * Stream format.
   */
  format: 'mp3' | 'm4a' | 'aac_hls' | 'opus' | 'arbitrary'

  /**
   * Additional format metadata.
   */
  additionalData?: {
    format?: string
    [key: string]: unknown
  }
}

/**
 * SoundCloud resolve/search result type.
 *
 * Union of all possible return types from resolve and search methods.
 *
 * @public
 */
export type SoundCloudSourceResult =
  | { loadType: 'track'; data: SoundCloudTrackData }
  | { loadType: 'search'; data: SoundCloudTrackData[] }
  | { loadType: 'playlist'; data: SoundCloudPlaylistData }
  | { loadType: 'empty'; data: Record<string, never> }
  | { loadType: 'error'; data: SoundCloudErrorPayload }
  | SourceResult

/**
 * Regex match groups for SoundCloud track URLs.
 *
 * Extracted by TRACK_PATTERN regex.
 *
 * @public
 */
export interface SoundCloudTrackUrlGroups {
  /**
   * Track slug from URL path.
   *
   * @example 'my-awesome-track'
   */
  slug?: string
}

/**
 * Regex match groups for SoundCloud search URLs.
 *
 * Extracted by SEARCH_URL_PATTERN regex.
 *
 * @public
 */
export interface SoundCloudSearchUrlGroups {
  /**
   * Search type from URL path.
   *
   * @example 'sounds'
   * @example 'people'
   */
  type?: 'sounds' | 'people' | 'albums' | 'sets'
}

/**
 * Transcoding selection result with quality preference.
 *
 * Used internally during stream URL resolution to rank available formats.
 *
 * @internal
 */
export interface SoundCloudTranscodingCandidate {
  /**
   * The transcoding object.
   */
  transcoding: SoundCloudApiTranscoding

  /**
   * Selection priority score (higher is better).
   */
  priority: number
}
