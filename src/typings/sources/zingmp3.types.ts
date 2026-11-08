import type { HttpProxyConfig } from '../utils.types.ts'
import type { TrackInfo, TrackStreamResult } from './source.types.ts'

/**
 * Zing MP3 configuration block within NodeLink.
 * @public
 */
export interface ZingMp3Config {
  /**
   * Whether the Zing MP3 source is enabled.
   */
  enabled: boolean

  /**
   * Optional custom Vietnam IPv4 address used in X-Forwarded-For headers
   * to bypass country streaming restrictions for clients running outside Vietnam.
   */
  vietnamIp?: string

  /**
   * Optional proxy settings for network requests.
   */
  proxy?: HttpProxyConfig
}

/**
 * Artist payload within Zing MP3 API structures.
 * @public
 */
export interface ZingMp3Artist {
  /** Artist unique identifier. */
  id?: string
  /** Human-readable artist name. */
  name?: string
  /** Web URL slug / path. */
  link?: string
  /** URL alias. */
  alias?: string
  /** Small square thumbnail URL. */
  thumbnail?: string
  /** Medium square thumbnail URL. */
  thumbnailM?: string
  /** Official Account flag. */
  isOA?: boolean
  /** Official Account brand flag. */
  isOABrand?: boolean
  /** Associated playlist identifier. */
  playlistId?: string
}

/**
 * Album payload within Zing MP3 song metadata.
 * @public
 */
export interface ZingMp3Album {
  /** Album unique encoded identifier. */
  encodeId: string
  /** Album title. */
  title: string
  /** Small thumbnail URL. */
  thumbnail?: string
  /** Medium thumbnail URL. */
  thumbnailM?: string
  /** Web path. */
  link?: string
  /** Release date or release year string. */
  releaseDate?: string
  /** Formatted artist names. */
  artistsNames?: string
}

/**
 * Track/Song payload returned by Zing MP3 song and playlist endpoints.
 * @public
 */
export interface ZingMp3SongData {
  /** Unique encoded identifier. */
  encodeId: string
  /** Track title. */
  title: string
  /** Title alias / slug. */
  alias?: string
  /** Official release flag. */
  isOffical?: boolean
  /** Username or uploader handle. */
  username?: string
  /** Formatted names of all participating artists. */
  artistsNames?: string
  /** Structured artist objects. */
  artists?: ZingMp3Artist[]
  /** Whether track playback is available worldwide without geo-restrictions. */
  isWorldWide?: boolean
  /** Medium thumbnail URL (typically 240x240). */
  thumbnailM?: string
  /** Small thumbnail URL (typically 94x94). */
  thumbnail?: string
  /** Web URL path (e.g. `/bai-hat/title/id.html`). */
  link?: string
  /** Duration in seconds. */
  duration?: number
  /** Release timestamp. */
  releaseDate?: number
  /** Containing album metadata. */
  album?: ZingMp3Album
  /** Streaming status code (1: free standard streaming, 2: VIP only). */
  streamingStatus?: number
  /** Audio ads indicator. */
  allowAudioAds?: boolean
  /** Whether synchronized lyrics are available. */
  hasLyric?: boolean
  [key: string]: unknown
}

/**
 * Playlist or Album container payload returned by Zing MP3 playlist endpoints.
 * @public
 */
export interface ZingMp3PlaylistData {
  /** Unique encoded identifier. */
  encodeId: string
  /** Playlist/Album title. */
  title: string
  /** Small thumbnail URL. */
  thumbnail?: string
  /** Medium thumbnail URL. */
  thumbnailM?: string
  /** Web path. */
  link?: string
  /** Formatted artist names. */
  artistsNames?: string
  /** Songs container with items array and count. */
  song?: {
    items?: ZingMp3SongData[]
    total?: number
  }
  [key: string]: unknown
}

/**
 * Search results payload returned by the multi-search endpoint.
 * @public
 */
export interface ZingMp3SearchData {
  /** Artists matching the query. */
  artists?: ZingMp3Artist[]
  /** Songs matching the query. */
  songs?: ZingMp3SongData[]
  /** Playlists and albums matching the query. */
  playlists?: ZingMp3PlaylistData[]
  /** Video clips matching the query. */
  videos?: unknown[]
  [key: string]: unknown
}

/**
 * Streaming quality map returned by the song streaming endpoint.
 * @public
 */
export interface ZingMp3StreamingData {
  /** Standard 128 kbps direct MP3 URL. */
  '128'?: string
  /** High-quality 320 kbps stream URL (or 'VIP' string if restricted). */
  '320'?: string
  [quality: string]: string | undefined
}

/**
 * Individual timed word in a synchronized lyric sentence.
 * @public
 */
export interface ZingMp3LyricWord {
  /** Word start time in milliseconds. */
  startTime: number
  /** Word end time in milliseconds. */
  endTime: number
  /** Word text content. */
  data: string
}

/**
 * Single timed lyric line/sentence composed of timed words.
 * @public
 */
export interface ZingMp3LyricSentence {
  /** Array of words in the sentence. */
  words: ZingMp3LyricWord[]
}

/**
 * Full lyrics payload from the lyric endpoint.
 * @public
 */
export interface ZingMp3LyricData {
  /** URL to downloadable .lrc file if present. */
  file?: string
  /** Synchronized sentence entries with word timings. */
  sentences?: ZingMp3LyricSentence[]
  [key: string]: unknown
}

/**
 * Standard envelope returned by Zing MP3 API endpoints.
 * @public
 */
export interface ZingMp3ApiResponse<T> {
  /** Status error code (0 for success, negative numbers for errors). */
  err: number
  /** Status message (e.g. 'Success'). */
  msg: string
  /** Response payload data if successful. */
  data?: T
  /** Response server timestamp in milliseconds. */
  timestamp?: number
  /** Request URL echoed back by server. */
  url?: string
}

/**
 * Decoded track representation with optional format hint.
 * @public
 */
export interface ZingMp3DecodedTrack extends TrackInfo {
  /** Audio stream format hint. */
  format?: string
}

/**
 * Result returned by `loadStream` for Zing MP3.
 * @public
 */
export type ZingMp3LoadStreamResult = TrackStreamResult

/**
 * URL category parsed from a Zing MP3 link.
 * @public
 */
export type ZingMp3UrlType = 'song' | 'playlist' | 'album' | 'video'

/**
 * Parsed URL descriptor containing entity type and ID.
 * @public
 */
export interface ZingMp3ParsedUrl {
  /** Category of the Zing MP3 URL. */
  type: ZingMp3UrlType
  /** Encoded alphanumeric identifier. */
  id: string
}
