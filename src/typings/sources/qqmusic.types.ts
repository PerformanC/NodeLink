import type { Readable } from 'node:stream'
import type {
  SourceResult,
  TrackData,
  TrackInfo,
  TrackStreamResult,
  TrackUrlResult,
  WorkerNodeLink
} from './source.types.ts'
import type { HttpProxyConfig } from '../utils.types.ts'

/**
 * QQ Music configuration block within NodeLink.
 * @public
 */
export interface QQMusicConfig {
  /**
   * Whether the QQ Music source is enabled.
   */
  enabled: boolean

  /**
   * Optional raw cookie header string containing user credentials
   * (e.g. uin, qm_keyst, qqmusic_key) for unlocking VIP and subscriber audio streams.
   */
  cookie?: string

  /**
   * Optional QQ User Identification Number (UIN).
   */
  uin?: string | number

  /**
   * Optional QQ Music keyst token for authenticated API calls.
   */
  qmKeyst?: string

  /**
   * Optional proxy settings for network requests.
   */
  proxy?: HttpProxyConfig
}

/**
 * Artist structure returned by QQ Music API endpoints.
 * @public
 */
export interface QQMusicSinger {
  /** Singer numeric ID. */
  id?: number
  /** Singer alphanumeric MID. */
  mid?: string
  /** Singer name. */
  name?: string
  /** Singer title alias. */
  title?: string
}

/**
 * Album structure returned by QQ Music API endpoints.
 * @public
 */
export interface QQMusicAlbum {
  /** Album numeric ID. */
  id?: number
  /** Album alphanumeric MID. */
  mid?: string
  /** Album name. */
  name?: string
  /** Album title. */
  title?: string
  /** Album subtitle. */
  subtitle?: string
  /** Time of public release. */
  time_public?: string
}

/**
 * File metadata structure within QQ Music song payloads.
 * @public
 */
export interface QQMusicFile {
  /** Media MID used for building audio file paths. */
  media_mid?: string
  /** Size of 128kbps MP3 stream. */
  size_128mp3?: number
  /** Size of 320kbps MP3 stream. */
  size_320mp3?: number
  /** Size of FLAC stream. */
  size_flac?: number
  /** String media MID alias. */
  strMediaMid?: string
}

/**
 * Song payload structure returned by modern QQ Music gateway (musicu.fcg).
 * @public
 */
export interface QQMusicSongInfo {
  /** Track numeric ID. */
  id?: number
  /** Track alphanumeric MID. */
  mid?: string
  /** Track title. */
  name?: string
  /** Alternative title property. */
  title?: string
  /** Participating artists. */
  singer?: QQMusicSinger[]
  /** Associated album. */
  album?: QQMusicAlbum
  /** Duration in seconds. */
  interval?: number
  /** Audio file details. */
  file?: QQMusicFile
  /** Optional stream or preview URL. */
  url?: string
}

/**
 * Modern song detail envelope returned by `music.pf_song_detail_svr`.
 * @public
 */
export interface QQMusicSongDetailResponse {
  code: number
  data?: {
    track_info?: QQMusicSongInfo
  }
}

/**
 * Streaming VKey response returned by `vkey.GetVkeyServer`.
 * @public
 */
export interface QQMusicVkeyItem {
  songmid: string
  filename: string
  purl: string
  vkey?: string
  result?: number
}

/**
 * Streaming VKey envelope returned by `vkey.GetVkeyServer`.
 * @public
 */
export interface QQMusicVkeyResponse {
  code: number
  data?: {
    sip?: string[]
    midurlinfo?: QQMusicVkeyItem[]
  }
}

/**
 * Lyric response returned by `music.musichallSong.PlayLyricInfo`.
 * @public
 */
export interface QQMusicLyricResponse {
  code: number
  data?: {
    lyric?: string
    trans?: string
  }
}

/**
 * Search track item from client_search_cp API.
 * @public
 */
export interface QQMusicSearchItem {
  id?: number
  mid?: string
  name?: string
  title?: string
  singer?: QQMusicSinger[]
  album?: QQMusicAlbum
  interval?: number
  file?: QQMusicFile
}

/**
 * Search response returned by client_search_cp.
 * @public
 */
export interface QQMusicSearchResponse {
  code: number
  data?: {
    song?: {
      list?: QQMusicSearchItem[]
      totalnum?: number
      curpage?: number
    }
  }
}

/**
 * Legacy song format returned by album, playlist, and toplist endpoints.
 * @public
 */
export interface QQMusicSongLegacy {
  songid?: number
  songmid: string
  songname: string
  albumid?: number
  albummid?: string
  albumname?: string
  albumdesc?: string
  interval: number
  singer?: Array<{
    id?: number
    mid?: string
    name: string
  }>
  strMediaMid?: string
}

/**
 * Album response returned by fcg_v8_album_info_cp.fcg.
 * @public
 */
export interface QQMusicAlbumApiResponse {
  code: number
  data?: {
    name: string
    mid: string
    desc?: string
    list?: QQMusicSongLegacy[]
  }
}

/**
 * Playlist response returned by fcg_ucc_getcdinfo_byids_cp.fcg.
 * @public
 */
export interface QQMusicPlaylistApiResponse {
  code: number
  cdlist?: Array<{
    dissname: string
    disstid: string
    desc?: string
    logo?: string
    songlist?: QQMusicSongLegacy[]
  }>
}

/**
 * Toplist response returned by fcg_v8_toplist_cp.fcg.
 * @public
 */
export interface QQMusicToplistApiResponse {
  code: number
  topinfo?: {
    ListName: string
    info?: string
  }
  songlist?: Array<{
    data: QQMusicSongLegacy
  }>
}

/**
 * Singer detail response returned by `music.web_singer_info_svr`.
 * @public
 */
export interface QQMusicSingerDetailApiResponse {
  code: number
  data?: {
    singer_info?: {
      name: string
      mid: string
    }
    songlist?: Array<{
      mid: string
      name?: string
      title?: string
      interval?: number
      singer?: QQMusicSinger[]
      album?: QQMusicAlbum
    }>
  }
}

/**
 * Decoded URL details parsed from supported QQ Music links.
 * @public
 */
export interface QQMusicParsedUrl {
  type: 'song' | 'album' | 'playlist' | 'toplist' | 'singer'
  id: string
}

/**
 * Minimal decoded track structure used for fallback resolution.
 * @public
 */
export interface QQMusicDecodedTrack {
  identifier: string
  title: string
  author: string
  length: number
  uri: string
  artworkUrl: string | null
  isrc: string | null
  sourceName: string
}

/**
 * Result returned by {@link QQMusicSource.loadStream}.
 * @public
 */
export type QQMusicLoadStreamResult =
  | {
      stream: Readable
      type: string
    }
  | {
      exception: {
        message: string
        severity: 'common' | 'suspicious' | 'fault'
      }
    }
