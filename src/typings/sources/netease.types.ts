import type { SourceConfigBase } from '../config/config.types.ts'
import type {
  SourceManager,
  SourceResult,
  TrackInfo,
  TrackStreamResult,
  TrackUrlResult,
  WorkerNodeLink
} from './source.types.ts'

/**
 * Supported Netease search types.
 * @public
 */
export type NeteaseSearchType = 'track' | 'album' | 'artist' | 'playlist'

/**
 * Basic artist payload returned by Netease APIs.
 * @public
 */
export interface NeteaseArtist {
  /**
   * Artist identifier.
   */
  id?: number | string

  /**
   * Artist display name.
   */
  name?: string
}

/**
 * Album payload shape used by this provider.
 * @public
 */
export interface NeteaseAlbum {
  /**
   * Album identifier.
   */
  id?: number | string

  /**
   * Album display name.
   */
  name?: string

  /**
   * Album artwork URL.
   */
  picUrl?: string

  /**
   * Album artist.
   */
  artist?: NeteaseArtist
}

/**
 * Playlist creator payload from Netease search.
 * @public
 */
export interface NeteaseCreator {
  /**
   * Creator nickname.
   */
  nickname?: string
}

/**
 * Playlist payload from Netease search.
 * @public
 */
export interface NeteaseSearchPlaylist {
  /**
   * Playlist identifier.
   */
  id?: number | string

  /**
   * Playlist name.
   */
  name?: string

  /**
   * Playlist creator.
   */
  creator?: NeteaseCreator
}

/**
 * Album payload from Netease search.
 * @public
 */
export interface NeteaseSearchAlbum {
  /**
   * Album identifier.
   */
  id?: number | string

  /**
   * Album name.
   */
  name?: string

  /**
   * Album artist.
   */
  artist?: NeteaseArtist
}

/**
 * Artist payload from Netease search.
 * @public
 */
export interface NeteaseSearchArtist {
  /**
   * Artist identifier.
   */
  id?: number | string

  /**
   * Artist name.
   */
  name?: string
}

/**
 * Song payload shape used by this provider.
 * @public
 */
export interface NeteaseSong {
  /**
   * Song identifier.
   */
  id?: number | string

  /**
   * Song title.
   */
  name?: string

  /**
   * Duration in milliseconds.
   */
  duration?: number

  /**
   * Duration in milliseconds (alternate field).
   */
  dt?: number

  /**
   * Artist list.
   */
  artists?: NeteaseArtist[]

  /**
   * Artist list (alternate field).
   */
  ar?: NeteaseArtist[]

  /**
   * Single artist fallback.
   */
  artist?: NeteaseArtist

  /**
   * Album payload.
   */
  album?: NeteaseAlbum

  /**
   * Album payload (alternate field).
   */
  al?: NeteaseAlbum
}

/**
 * Search result block from Netease search endpoint.
 * @public
 */
export interface NeteaseSearchResultBlock {
  /**
   * Track results.
   */
  songs?: unknown[]

  /**
   * Album results.
   */
  albums?: NeteaseSearchAlbum[]

  /**
   * Artist results.
   */
  artists?: NeteaseSearchArtist[]

  /**
   * Playlist results.
   */
  playlists?: NeteaseSearchPlaylist[]
}

/**
 * Search response payload from Netease endpoint.
 * @public
 */
export interface NeteaseSearchResponse {
  /**
   * Result block.
   */
  result?: NeteaseSearchResultBlock
}

/**
 * Song detail response payload.
 * @public
 */
export interface NeteaseSongDetailResponse {
  /**
   * Song list.
   */
  songs?: unknown[]
}

/**
 * Album response payload.
 * @public
 */
export interface NeteaseAlbumResponse {
  /**
   * Album metadata.
   */
  album?: NeteaseAlbum

  /**
   * Album tracks.
   */
  songs?: unknown[]
}

/**
 * Playlist details payload.
 * @public
 */
export interface NeteasePlaylistDetails {
  /**
   * Playlist name.
   */
  name?: string

  /**
   * Playlist tracks.
   */
  tracks?: unknown[]
}

/**
 * Playlist response payload.
 * @public
 */
export interface NeteasePlaylistResponse {
  /**
   * Legacy playlist block.
   */
  result?: NeteasePlaylistDetails

  /**
   * Modern playlist block.
   */
  playlist?: NeteasePlaylistDetails
}

/**
 * Artist top songs response payload.
 * @public
 */
export interface NeteaseArtistResponse {
  /**
   * Artist metadata.
   */
  artist?: NeteaseArtist

  /**
   * Artist top tracks.
   */
  hotSongs?: unknown[]
}

/**
 * Plugin metadata attached to Netease tracks.
 * @public
 */
export interface NeteasePluginInfo {
  [key: string]: unknown

  /**
   * Netease song identifier.
   */
  neteaseId?: string

  /**
   * Collection marker used by search results.
   */
  type?: string
}

/**
 * Track payload returned by Netease source.
 * @public
 */
export interface NeteaseTrackData {
  /**
   * Encoded track payload.
   */
  encoded: string

  /**
   * Canonical track metadata.
   */
  info: TrackInfo

  /**
   * Source plugin metadata.
   */
  pluginInfo: NeteasePluginInfo
}

/**
 * Playlist payload returned by Netease resolver.
 * @public
 */
export interface NeteasePlaylistData {
  /**
   * Playlist metadata.
   */
  info: {
    /**
     * Playlist title.
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
  pluginInfo: Record<string, unknown>

  /**
   * Playlist tracks.
   */
  tracks: NeteaseTrackData[]
}

/**
 * Source exception payload.
 * @public
 */
export interface NeteaseException {
  /**
   * Error message text.
   */
  message: string

  /**
   * Error severity.
   */
  severity: string
}

/**
 * Unified result payload returned by Netease source.
 * @public
 */
export type NeteaseSourceResult =
  | { loadType: 'track'; data: NeteaseTrackData }
  | { loadType: 'search'; data: NeteaseTrackData[] }
  | { loadType: 'playlist'; data: NeteasePlaylistData }
  | { loadType: 'empty'; data: Record<string, never> }
  | { loadType: 'error'; exception: NeteaseException }

/**
 * Decoded track payload accepted by `getTrackUrl`.
 * @public
 */
export interface NeteaseDecodedTrack extends TrackInfo {
  /**
   * Optional plugin metadata.
   */
  pluginInfo?: NeteasePluginInfo
}

/**
 * Track URL result payload for Netease source.
 * @public
 */
export type NeteaseTrackUrlResult =
  | TrackUrlResult
  | { exception: NeteaseException }

/**
 * Stream loading result payload for Netease source.
 * @public
 */
export type NeteaseLoadStreamResult =
  | TrackStreamResult
  | { exception: NeteaseException }

/**
 * Netease source config block.
 * @public
 */
export interface NeteaseSourceOptions extends Partial<SourceConfigBase> {}

/**
 * Source manager contract used by Netease fallback flow.
 * @public
 */
export interface NeteaseSourceManager extends SourceManager {
  /**
   * Searches using configured default source(s).
   */
  searchWithDefault: (query: string) => Promise<SourceResult>
}

/**
 * Runtime NodeLink context required by Netease provider.
 * @public
 */
export interface NeteaseNodeLinkContext extends WorkerNodeLink {
  /**
   * Runtime options consumed by this provider.
   */
  options: WorkerNodeLink['options'] & {
    maxSearchResults?: number
    sources?: WorkerNodeLink['options']['sources'] & {
      netease?: NeteaseSourceOptions
    }
  }

  /**
   * Source manager instance.
   */
  sources: NeteaseSourceManager
}
