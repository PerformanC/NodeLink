import type { JioSaavnSourceConfig } from '../config/config.types.ts'
import type { HttpProxyConfig } from '../utils.types.ts'
import type {
  SourceManager,
  SourceResult,
  TrackInfo,
  TrackStreamResult,
  TrackUrlResult,
  WorkerNodeLink
} from './source.types.ts'

/**
 * Scalar values accepted by JioSaavn API query parameters.
 * @public
 */
export type JioSaavnApiPrimitive = string | number | boolean

/**
 * API query parameter map used by JioSaavn endpoints.
 * @public
 */
export type JioSaavnApiParams = Record<string, JioSaavnApiPrimitive>

/**
 * Track artist item from JioSaavn metadata.
 * @public
 */
export interface JioSaavnArtist {
  /**
   * Artist display name.
   */
  name?: string
}

/**
 * Artist map block from JioSaavn metadata payloads.
 * @public
 */
export interface JioSaavnArtistMap {
  /**
   * Primary artist list.
   */
  primary_artists?: JioSaavnArtist[]

  /**
   * Full artist list.
   */
  artists?: JioSaavnArtist[]
}

/**
 * Nested `more_info` metadata block from JioSaavn responses.
 * @public
 */
export interface JioSaavnMoreInfo {
  /**
   * Duration in seconds.
   */
  duration?: string | number

  /**
   * Artist mapping.
   */
  artistMap?: JioSaavnArtistMap

  /**
   * Music/author fallback value.
   */
  music?: string
}

/**
 * Normalized JioSaavn song payload used by this source.
 * @public
 */
export interface JioSaavnSongPayload {
  /**
   * Song identifier.
   */
  id?: string | number

  /**
   * Song title field.
   */
  title?: string

  /**
   * Alternative song title field.
   */
  song?: string

  /**
   * Canonical track URL.
   */
  perma_url?: string

  /**
   * Top-level duration in seconds.
   */
  duration?: string | number

  /**
   * Nested metadata block.
   */
  more_info?: JioSaavnMoreInfo

  /**
   * Top-level artist list fallback.
   */
  primary_artists?: string

  /**
   * Secondary artist list fallback.
   */
  singers?: string

  /**
   * Artwork URL.
   */
  image?: string

  /**
   * Encrypted media URL.
   */
  encrypted_media_url?: string

  /**
   * High bitrate availability flag.
   */
  '320kbps'?: string | boolean

  /**
   * Comma-separated primary artist IDs.
   */
  primary_artists_id?: string
}

/**
 * Search payload returned by `search.getResults`.
 * @public
 */
export interface JioSaavnSearchResponse {
  /**
   * Search result list.
   */
  results?: unknown[]
}

/**
 * Station creation payload returned by recommendations API.
 * @public
 */
export interface JioSaavnStationCreateResponse {
  /**
   * Station identifier.
   */
  stationid?: string
}

/**
 * Station song item payload.
 * @public
 */
export interface JioSaavnStationSongItem {
  /**
   * Song payload.
   */
  song?: unknown
}

/**
 * Station song response map.
 * @public
 */
export interface JioSaavnStationSongResponse {
  /**
   * Optional error payload.
   */
  error?: unknown

  /**
   * Dynamic station keys.
   */
  [key: string]: unknown
}

/**
 * Song details response payload.
 * @public
 */
export interface JioSaavnSongDetailsResponse {
  /**
   * Song list fallback.
   */
  songs?: unknown[]

  /**
   * Dynamic entries including keyed song IDs.
   */
  [key: string]: unknown
}

/**
 * Generic `webapi.get` response payload used by list/song resolutions.
 * @public
 */
export interface JioSaavnWebApiGetResponse {
  /**
   * Song list fallback.
   */
  songs?: unknown[]

  /**
   * Playlist/album list entries.
   */
  list?: unknown[]

  /**
   * Artist top songs entries.
   */
  topSongs?: unknown[]

  /**
   * Title field.
   */
  title?: string

  /**
   * Name field fallback.
   */
  name?: string
}

/**
 * URL type segment accepted in JioSaavn links.
 * @public
 */
export type JioSaavnUrlType =
  | 'album'
  | 'featured'
  | 'song'
  | 's/playlist'
  | 'artist'

/**
 * Regex group payload extracted from JioSaavn URLs.
 * @public
 */
export interface JioSaavnResolveGroups {
  /**
   * URL type segment.
   */
  type?: JioSaavnUrlType

  /**
   * Resource identifier segment.
   */
  id?: string
}

/**
 * Source-level options consumed by JioSaavn provider.
 * @public
 */
export interface JioSaavnSourceOptions extends Partial<JioSaavnSourceConfig> {
  /**
   * Optional outbound proxy.
   */
  proxy?: HttpProxyConfig
}

/**
 * Source manager contract used by JioSaavn fallback flow.
 * @public
 */
export interface JioSaavnSourceManager extends SourceManager {
  /**
   * Searches with configured default search source(s).
   */
  searchWithDefault: (query: string) => Promise<SourceResult>
}

/**
 * Runtime NodeLink context required by JioSaavn provider.
 * @public
 */
export interface JioSaavnNodeLinkContext extends WorkerNodeLink {
  /**
   * Runtime options consumed by this provider.
   */
  options: WorkerNodeLink['options'] & {
    sources?: WorkerNodeLink['options']['sources'] & {
      jiosaavn?: JioSaavnSourceOptions
    }
  }

  /**
   * Source manager instance.
   */
  sources: JioSaavnSourceManager
}

/**
 * Track payload returned by JioSaavn source.
 * @public
 */
export interface JioSaavnTrackData {
  /**
   * Encoded track string.
   */
  encoded: string

  /**
   * Canonical track metadata.
   */
  info: TrackInfo

  /**
   * JioSaavn plugin metadata (unused).
   */
  pluginInfo: Record<string, unknown>
}

/**
 * Playlist payload returned by JioSaavn source.
 * @public
 */
export interface JioSaavnPlaylistData {
  /**
   * Playlist metadata.
   */
  info: {
    /**
     * Playlist name.
     */
    name: string

    /**
     * Selected track index.
     */
    selectedTrack: number
  }

  /**
   * Optional plugin metadata.
   */
  pluginInfo?: {
    /**
     * Plugin category marker.
     */
    type?: string
    /**
     * Upstream total tracks in the collection.
     */
    totalTracks?: number | null
    /**
     * Whether only a partial subset was loaded.
     */
    isPartial?: boolean
    [key: string]: unknown
  }

  /**
   * Playlist tracks.
   */
  tracks: JioSaavnTrackData[]
}

/**
 * Exception payload shape used by JioSaavn source.
 * @public
 */
export interface JioSaavnException {
  /**
   * Error message text.
   */
  message: string

  /**
   * Error severity category.
   */
  severity: string
}

/**
 * Unified result payload returned by JioSaavn source methods.
 * @public
 */
export type JioSaavnSourceResult =
  | { loadType: 'track'; data: JioSaavnTrackData }
  | { loadType: 'search'; data: JioSaavnTrackData[] }
  | { loadType: 'playlist'; data: JioSaavnPlaylistData }
  | { loadType: 'empty'; data: Record<string, never> }
  | { loadType: 'error'; exception: JioSaavnException }

/**
 * Decoded track payload accepted by JioSaavn `getTrackUrl`.
 * @public
 */
export interface JioSaavnDecodedTrack extends TrackInfo {}

/**
 * Stream URL result payload returned by JioSaavn `getTrackUrl`.
 * @public
 */
export type JioSaavnTrackUrlResult =
  | TrackUrlResult
  | { exception: JioSaavnException }

/**
 * Stream loading result payload returned by JioSaavn `loadStream`.
 * @public
 */
export type JioSaavnLoadStreamResult =
  | TrackStreamResult
  | { exception: JioSaavnException }
