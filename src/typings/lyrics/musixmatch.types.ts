/**
 * Type definitions for Musixmatch lyrics provider
 * @module typings/lyrics/musixmatch.types
 */

import type { HttpProxyConfig } from '../utils.types.ts'

export type { HttpProxyConfig }

/**
 * Single proxy configuration definition.
 * @public
 */
export type MusixmatchProxyConfig = HttpProxyConfig | string

/**
 * Musixmatch-specific configuration options
 * @public
 */
export interface MusixmatchConfig {
  /** Whether the Musixmatch lyrics source is enabled */
  enabled: boolean

  /** Optional signature secret for manual token authentication */
  signatureSecret?: string

  /** Optional dedicated proxy URL, config, or rotating array of proxies to route Musixmatch requests */
  proxy?: MusixmatchProxyConfig | MusixmatchProxyConfig[]
}

/**
 * Lyrics configuration containing Musixmatch settings
 * @public
 */
export interface LyricsConfig {
  /** Musixmatch configuration */
  musixmatch?: MusixmatchConfig
}

/**
 * NodeLink options that include lyrics configuration
 * @public
 */
export interface NodelinkOptions {
  /** Lyrics provider configuration */
  lyrics?: LyricsConfig
}

/**
 * Credential manager interface for token storage
 * @public
 */
export interface CredentialManager {
  /** Retrieves a credential by key */
  get: (key: string) => { value: string; expires: number } | null

  /** Stores a credential with a TTL */
  set: (
    key: string,
    value: { value: string; expires: number },
    ttl: number
  ) => void
}

/**
 * Snapshot representation of a proxy target.
 * @public
 */
export interface ProxySnapshotLike {
  /** Target proxy server parameters */
  target: {
    url: string
    protocol?: string
    username?: string
    password?: string
  }
}

/**
 * Proxy manager contract for selecting available proxies.
 * @public
 */
export interface ProxyManagerLike {
  /** Selects the optimal proxy target for a given provider */
  getBestProxy: (sourceName: string) => ProxySnapshotLike | undefined

  /** Reports request health feedback for the selected proxy */
  report?: (
    proxyUrl: string,
    success: boolean,
    statusCode: number,
    latencyMs?: number
  ) => void
}

/**
 * Minimal NodeLink instance shape required by MusixmatchLyrics
 * @public
 */
export interface NodelinkInstanceForMusixmatch {
  /** Server configuration options */
  options: NodelinkOptions

  /** Credential manager for token persistence */
  credentialManager: CredentialManager

  /** Proxy manager for selecting available proxies */
  proxyManager?: ProxyManagerLike
}

/**
 * Musixmatch API message header
 * @public
 */
export interface MxmMessageHeader {
  /** HTTP-style status code */
  status_code?: number

  /** Human-readable hint or error message */
  hint?: string

  /** Request execution time in seconds */
  execute_time?: number
}

/**
 * Token endpoint response body
 * @public
 */
export interface MxmTokenBody {
  /** User token for authenticated requests */
  user_token?: string
}

/**
 * Token endpoint message wrapper
 * @public
 */
export interface MxmTokenMessage {
  header?: MxmMessageHeader
  body?: MxmTokenBody
}

/**
 * Token endpoint full response
 * @public
 */
export interface MxmTokenResponse {
  message?: MxmTokenMessage
}

/**
 * Genre information within a track
 * @public
 */
export interface MxmMusicGenre {
  music_genre_id?: number
  music_genre_parent_id?: number
  music_genre_name?: string
  music_genre_name_extended?: string
  music_genre_vanity?: string
}

/**
 * Genre list item wrapper
 * @public
 */
export interface MxmMusicGenreItem {
  music_genre?: MxmMusicGenre
}

/**
 * Primary genres container for a track
 * @public
 */
export interface MxmPrimaryGenres {
  music_genre_list?: MxmMusicGenreItem[]
}

/**
 * Musixmatch track metadata
 * @public
 */
export interface MxmTrack {
  /** Unique track identifier */
  track_id?: number

  /** Track title */
  track_name?: string

  /** Track popularity rating (0-100) */
  track_rating?: number

  /** Primary artist name */
  artist_name?: string

  /** Album name */
  album_name?: string

  /** Album identifier */
  album_id?: number

  /** Common track identifier across versions */
  commontrack_id?: number

  /** Whether the track is instrumental (1 = yes) */
  instrumental?: number

  /** Whether lyrics are available (1 = yes) */
  has_lyrics?: number

  /** Whether subtitles are available (1 = yes) */
  has_subtitles?: number

  /** Whether rich sync lyrics are available (1 = yes) */
  has_richsync?: number

  /** Shareable track URL */
  track_share_url?: string

  /** URL for editing track metadata */
  track_edit_url?: string

  /** Original release date */
  first_release_date?: string

  /** Last update timestamp */
  updated_time?: string

  /** Genre classifications */
  primary_genres?: MxmPrimaryGenres
}

/**
 * Track item wrapper in list responses
 * @public
 */
export interface MxmTrackItem {
  track?: MxmTrack
}

/**
 * Search endpoint response body
 * @public
 */
export interface MxmSearchBody {
  track_list?: MxmTrackItem[]
}

/**
 * Search endpoint message wrapper
 * @public
 */
export interface MxmSearchMessage {
  header?: MxmMessageHeader
  body?: MxmSearchBody
}

/**
 * Search endpoint full response
 * @public
 */
export interface MxmSearchResponse {
  message?: MxmSearchMessage
}

/**
 * Lyrics metadata and content
 * @public
 */
export interface MxmLyrics {
  lyrics_id?: number
  can_edit?: number
  locked?: number
  action_requested?: string

  /** The actual lyrics text */
  lyrics_body?: string

  lyrics_language?: string
  lyrics_language_description?: string
  script_tracking_url?: string
  html_tracking_url?: string
  copyright?: string
  updated_time?: string
}

/**
 * Lyrics endpoint response body
 * @public
 */
export interface MxmLyricsBody {
  lyrics?: MxmLyrics
}

/**
 * Lyrics endpoint message wrapper
 * @public
 */
export interface MxmLyricsMessage {
  header?: MxmMessageHeader
  body?: MxmLyricsBody
}

/**
 * Lyrics endpoint full response
 * @public
 */
export interface MxmLyricsResponse {
  message?: MxmLyricsMessage
}

/**
 * Time information for a subtitle line
 * @public
 */
export interface MxmSubtitleTime {
  /** Total time in seconds */
  total?: number

  minutes?: number
  seconds?: number
  hundredths?: number

  /** Duration in seconds */
  duration?: number
}

/**
 * Raw subtitle item from parsed JSON
 * @public
 */
export interface MxmParsedSubtitleItem {
  /** Lyric text for this line */
  text?: string

  /** Timing information */
  time?: MxmSubtitleTime
}

/**
 * Subtitle item wrapper in API responses
 * @public
 */
export interface MxmSubtitleItem {
  subtitle?: MxmSubtitle
}

/**
 * Subtitle metadata and content
 * @public
 */
export interface MxmSubtitle {
  subtitle_id?: number

  /** JSON string containing synced lyrics */
  subtitle_body?: string

  subtitle_language?: string
  subtitle_language_description?: string
  restricted?: number
  lyrics_id?: number
  script_tracking_url?: string
  html_tracking_url?: string
  updated_time?: string
}

/**
 * Subtitle endpoint response body
 * @public
 */
export interface MxmSubtitleBody {
  subtitle?: MxmSubtitle
}

/**
 * Subtitle endpoint message wrapper
 * @public
 */
export interface MxmSubtitleMessage {
  header?: MxmMessageHeader
  body?: MxmSubtitleBody
}

/**
 * Subtitle endpoint full response
 * @public
 */
export interface MxmSubtitleResponse {
  message?: MxmSubtitleMessage
}

/**
 * Collection of macro API calls
 * @public
 */
export interface MxmMacroCalls {
  /** Lyrics get call result */
  'track.lyrics.get'?: {
    message?: {
      header?: MxmMessageHeader
      body?: {
        lyrics?: MxmLyrics
      }
    }
  }

  /** Track matcher call result */
  'matcher.track.get'?: {
    message?: {
      header?: MxmMessageHeader
      body?: {
        track?: MxmTrack
      }
    }
  }

  /** Subtitles get call result */
  'track.subtitles.get'?: {
    message?: {
      header?: MxmMessageHeader
      body?: {
        subtitle_list?: MxmSubtitleItem[]
      }
    }
  }
}

/**
 * Macro endpoint response body
 * @public
 */
export interface MxmMacroBody {
  macro_calls?: MxmMacroCalls
}

/**
 * Macro endpoint message wrapper
 * @public
 */
export interface MxmMacroMessage {
  header?: MxmMessageHeader
  body?: MxmMacroBody
}

/**
 * Macro endpoint full response
 * @public
 */
export interface MxmMacroResponse {
  message?: MxmMacroMessage
}

/**
 * Union of all possible body shapes returned by `_request`.
 *
 * Each endpoint returns a different body structure; this union lets callers
 * narrow to the shape they need via optional-chaining without resorting to
 * `any`.
 * @public
 */
export type MxmResponseBody =
  | MxmMacroBody
  | MxmSearchBody
  | MxmLyricsBody
  | MxmSubtitleBody

/**
 * Token data with expiration
 * @public
 */
export interface TokenData {
  /** The token value */
  value: string

  /** Expiration timestamp in milliseconds */
  expires: number
}

/**
 * Generic cache entry with TTL
 * @public
 */
export interface CacheEntry<T> {
  /** Cached value */
  value: T

  /** Expiration timestamp in milliseconds */
  expires: number
}

/**
 * Input track information for lyrics search
 * @public
 */
export interface TrackInfo {
  /** Track title (may contain artist prefix) */
  title: string

  /** Track author/artist */
  author: string
}

/**
 * Single line of lyrics with timing
 * @public
 */
export interface LyricsLine {
  /** Lyric text */
  text: string

  /** Start time in milliseconds */
  time: number

  /** Duration in milliseconds */
  duration: number
}

/**
 * Formatted lyrics ready for response
 * @public
 */
export interface FormattedLyrics {
  /** Whether lyrics are time-synced */
  synced: boolean

  /** Lyric lines */
  lines: LyricsLine[]

  /** Track name */
  name: string
}

/**
 * Lyrics result data payload
 * @public
 */
export interface LyricsResultData {
  /** Track name */
  name?: string

  /** Whether lyrics are synced */
  synced?: boolean

  /** Lyric lines */
  lines?: LyricsLine[]

  /** Lyrics provider (e.g., 'musixmatch', 'genius') */
  provider?: string

  /** Error message if applicable */
  message?: string

  /** Error severity if applicable */
  severity?: string
}

/**
 * Lyrics result structure for API response
 * @public
 */
export interface LyricsResult {
  /** Result type: 'lyrics', 'empty', or 'error' */
  loadType: string

  /** Result payload */
  data: LyricsResultData
}

/**
 * Lyrics fetched from various sources
 * @public
 */
export interface FetchedLyrics {
  /** Synced lyrics lines if available */
  subtitles: LyricsLine[] | null

  /** Plain lyrics text if available */
  lyrics: string | null

  /** Track metadata */
  track: MxmTrack
}

/**
 * Track with search relevance score
 * @public
 */
export interface ScoredTrack {
  /** Track metadata */
  track: MxmTrack

  /** Match score (higher = better match) */
  score: number
}
