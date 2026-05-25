/**
 * Source-level configuration options for Boomplay.
 *
 * Pulled from `nodelink.options.sources.boomplay`.
 *
 * @public
 */
export interface BoomplaySourceOptions extends Record<string, unknown> {
  /**
   * Whether the Boomplay source is enabled.
   *
   * @default false
   */
  enabled?: boolean

  /**
   * Maximum number of tracks to load from playlists.
   *
   * @default 100
   */
  playlistLoadLimit?: number

  /**
   * Maximum number of tracks to load from albums.
   *
   * @default 100
   */
  albumLoadLimit?: number

  /**
   * Cookie string for authenticated requests.
   */
  cookie?: string

  /**
   * Whether to allow explicit content in search results.
   */
  allowExplicit?: boolean
}

/**
 * Raw track data parsed from Boomplay HTML pages or API responses.
 *
 * @public
 */
export interface BoomplayRawTrack {
  /** Unique track identifier. */
  id: string | number
  /** Track title. */
  title: string
  /** Artist display name. */
  artistName: string
  /** Track duration in seconds. */
  duration: number
  /** URL to the track artwork, or null if unavailable. */
  artworkUrl: string | null
  /** ISRC code for the track, or null if unavailable. */
  isrc: string | null
  /** Canonical Boomplay track URI. */
  uri: string
}

/**
 * Parsed search query components extracted from a user query string.
 *
 * Supports structured filters like `artist:`, `album:`, `isrc:`, etc.
 *
 * @public
 */
export interface BoomplayParsedQuery {
  /** The cleaned search text with filter terms removed. */
  text: string
  /** Artist filter value. */
  artist?: string
  /** Album artist filter value. */
  albumArtist?: string
  /** Album filter value. */
  album?: string
  /** Year filter value. */
  year?: number
  /** Minimum duration filter in seconds. */
  minDuration?: number
  /** Maximum duration filter in seconds. */
  maxDuration?: number
  /** Genre filter value. */
  genre?: string
  /** ISRC filter value. */
  isrc?: string
  /** Generic key-value filter map. */
  filters: Map<string, string>
}

/**
 * Metadata extracted from a Boomplay `data-data` attribute.
 *
 * @public
 */
export interface BoomplayParsedData {
  /** Track title. */
  title?: string
  /** Artist display name. */
  artistName?: string
  /** Track duration in seconds. */
  duration?: number
  /** URL to the track artwork, or null if unavailable. */
  artworkUrl?: string | null
}
