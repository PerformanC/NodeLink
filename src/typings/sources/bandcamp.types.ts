/**
 * Type definitions for Bandcamp source payloads.
 * @module typings/sources/bandcamp.types
 */

/**
 * Single result returned by the Bandcamp autocomplete search API.
 */
export interface BandcampApiSearchResult {
  /** Item type, e.g. `"t"` for track, `"a"` for album. */
  type?: string
  /** Internal Bandcamp identifier. */
  id?: number
  /** Artwork identifier for building image URLs. */
  art_id?: number | null
  /** Track or album title. */
  name?: string
  /** Artist or band name. */
  band_name?: string
  /** Album name when the result is a track within an album. */
  album_name?: string | null
  /** Full canonical URL of the item. */
  item_url_path?: string
  /** Pre-built thumbnail URL. */
  img?: string | null
}

/**
 * Envelope returned by the Bandcamp autocomplete search API.
 */
export interface BandcampApiSearchResponse {
  /** Autocomplete results bucket. */
  auto?: {
    /** Matched items. */
    results?: BandcampApiSearchResult[]
  }
}

/**
 * Minimal Bandcamp track payload used by `data-tralbum`.
 */
export interface BandcampTralbumTrack {
  /** Internal track identifier exposed by Bandcamp. */
  track_id?: string | number
  /** Secondary internal identifier used by some pages. */
  id?: string | number
  /** Relative per-track page URL when the payload represents an album. */
  title_link?: string
  /** Human-readable track title. */
  title?: string
  /** Duration in seconds. */
  duration?: number
  /** Stream file mapping keyed by format (e.g. `"mp3-128"`). */
  file?: Record<string, string>
}

/**
 * Minimal Bandcamp page payload used by the source.
 */
export interface BandcampTralbumData {
  /** Artist name extracted from the page payload. */
  artist?: string
  /** Artwork identifier used to build the public image URL. */
  art_id?: string | number
  /** Current page metadata. */
  current?: {
    /** Album or track title. */
    title?: string
    /** ISRC when exposed by Bandcamp. */
    isrc?: string | null
  }
  /** Track list present on the page. */
  trackinfo?: BandcampTralbumTrack[]
}

/**
 * Structured data extracted from the JSON-LD `MusicRecording` block.
 */
export interface BandcampJsonLdData {
  /** Track or album title. */
  name?: string
  /** ISO 8601 duration string (e.g. `"P00H05M20S"`). */
  duration?: string
  /** ISRC code when available. */
  isrcCode?: string | null
  /** Artwork URL from the structured data. */
  image?: string | null
  /** Nested artist metadata. */
  byArtist?: {
    /** Human-readable artist name. */
    name?: string
  }
  /** Additional properties containing `track_id`, `art_id`, etc. */
  additionalProperty?: Array<{
    name?: string
    value?: string | number
  }>
}

/**
 * Track fields required to build an encoded Bandcamp track.
 */
export interface BandcampTrackBuildInput {
  identifier?: string | null
  isSeekable?: boolean
  author?: string | null
  length?: number
  isStream?: boolean
  title?: string | null
  uri: string
  artworkUrl: string | null
  isrc?: string | null
}

