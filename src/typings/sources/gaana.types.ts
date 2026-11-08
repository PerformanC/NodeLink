import type { Readable } from 'node:stream'

/**
 * Individual artist structure within Gaana metadata.
 * @public
 */
export interface GaanaArtist {
  /** Numeric or string artist ID. */
  artist_id?: string | number
  /** SEO slug for the artist page. */
  seokey?: string
  /** Artist display name. */
  name?: string
  /** High or medium resolution artwork URL. */
  atw?: string
  /** Standard artwork URL. */
  artwork?: string
  /** Favorite count for this artist. */
  favorite_count?: string | number
  /** Role in the track (e.g. 'Singer', 'Composer', 'Lyricist'). */
  role?: string
}

/**
 * Generic tag or genre structure returned by Gaana.
 * @public
 */
export interface GaanaTag {
  tag_id?: number | string
  tag_name?: string
}

/**
 * Raw track item payload returned by Gaana APIs.
 * @public
 */
export interface GaanaRawTrack {
  track_id?: string | number
  seokey?: string
  track_title?: string
  track_title_trans?: string
  name?: string
  album_id?: string | number
  album_title?: string
  albumseokey?: string
  duration?: string | number
  isrc?: string
  language?: string
  release_date?: string
  artwork?: string
  artwork_web?: string
  artwork_large?: string
  atw?: string
  artist?: GaanaArtist[] | GaanaArtist
  artist_detail?: GaanaArtist[]
  composer?: GaanaArtist[]
  lyricist?: GaanaArtist[]
  gener?: Array<{ genre_id?: string | number; name?: string }>
  tags?: GaanaTag[]
  play_ct?: string | number
  total_favourite_count?: string | number
  favorite_count?: string | number
  vendor_name?: string
  parental_warning?: number | string
  is_premium?: number | string
  premium_content?: string | number
  youtube_id?: string
  lyrics_url?: string
}

/**
 * Entity structure used in Gaana artist top tracks and playlist/search listings.
 * @public
 */
export interface GaanaEntityInfoItem {
  key: string
  value?: unknown
}

/**
 * Generic entity payload returned by Gaana API v2.
 * @public
 */
export interface GaanaEntity {
  entity_id?: string | number
  entity_type?: string
  name?: string
  seokey?: string
  language?: string
  atw?: string
  artwork?: string
  artwork_medium?: string
  favorite_count?: number | string
  entity_info?: GaanaEntityInfoItem[]
}

/**
 * Enriched pluginInfo metadata exposed for Gaana tracks.
 * @public
 */
export interface GaanaTrackPluginInfo {
  [key: string]: unknown
  trackId: string | null
  albumId?: string | null
  albumName?: string | null
  albumUrl?: string | null
  artists?: Array<{
    id?: string | number
    name?: string
    seokey?: string
    artwork?: string
  }>
  composers?: Array<{
    id?: string | number
    name?: string
    seokey?: string
  }>
  lyricists?: Array<{
    id?: string | number
    name?: string
    seokey?: string
  }>
  genres?: string[]
  language?: string | null
  releaseDate?: string | null
  isrc?: string | null
  label?: string | null
  playCount?: string | number | null
  favoriteCount?: number | null
  explicit?: boolean
  isPremium?: boolean
  youtubeId?: string | null
  lyricsUrl?: string | null
}

/**
 * Result returned by Gaana loadStream.
 * @public
 */
export type GaanaLoadStreamResult =
  | {
      stream: Readable
      type: string
    }
  | {
      exception: {
        message: string
        severity: string
      }
    }
