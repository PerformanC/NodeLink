import { PassThrough, type Readable } from 'node:stream'
import type {
  QQMusicAlbumApiResponse,
  QQMusicConfig,
  QQMusicDecodedTrack,
  QQMusicLoadStreamResult,
  QQMusicParsedUrl,
  QQMusicPlaylistApiResponse,
  QQMusicSearchResponse,
  QQMusicSingerDetailApiResponse,
  QQMusicSongDetailResponse,
  QQMusicSongInfo,
  QQMusicSongLegacy,
  QQMusicToplistApiResponse
} from '../typings/sources/qqmusic.types.ts'
import type {
  SourceInstance,
  SourceResult,
  TrackData,
  TrackInfo,
  TrackUrlResult,
  WorkerNodeLink
} from '../typings/sources/source.types.ts'
import type {
  SourceTestCase,
  SourceTestStreamSpec,
  SourceTestVariant,
  SourceTestVariantResult,
  SourceVariantHandler
} from '../typings/sources/test.types.ts'
import type { BestMatchCandidate } from '../typings/utils.types.ts'
import {
  encodeTrack,
  getBestMatch,
  http1makeRequest,
  logger
} from '../utils.ts'

const MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
const SEARCH_URL = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp'
const ALBUM_URL = 'https://i.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg'
const PLAYLIST_URL =
  'https://i.y.qq.com/qzone-music/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg'
const TOPLIST_URL = 'https://i.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const REFERER = 'https://y.qq.com/'

/**
 * QQ Music source implementation for NodeLink.
 * @public
 */
export default class QQMusicSource
  implements SourceInstance, SourceVariantHandler
{
  /**
   * Declarative test suite for validating source behavior.
   * @public
   */
  public static readonly _TESTS: SourceTestCase[] = [
    {
      id: 'qqmusic.track.stream',
      name: 'QQ Music native audio streaming',
      input: {
        type: 'resolve',
        value: 'https://y.qq.com/n/ryqq/songDetail/002vbWwe3ZmffT'
      },
      matrix: {
        variants: [{ id: 'Standard' }]
      },
      expect: {
        result: {
          type: 'track'
        },
        metadata: {
          sourceName: { op: 'equals', value: 'qqmusic' }
        },
        stream: {
          required: true,
          download: 'complete',
          minBytes: 500000,
          validFormats: [
            { container: 'mp3', codec: 'mp3' },
            { container: 'mov,mp4,m4a,3gp,3g2,mj2', codec: 'aac' }
          ],
          decodeToEnd: true
        }
      },
      forbid: {
        resultTypes: ['empty', 'error']
      }
    },
    {
      id: 'qqmusic.track.standard',
      name: 'QQ Music track resolution',
      input: {
        type: 'resolve',
        value: 'https://y.qq.com/n/ryqq/songDetail/004Ti8rT003TaZ'
      },
      expect: {
        result: {
          type: 'track'
        },
        metadata: {
          sourceName: { op: 'equals', value: 'qqmusic' }
        }
      },
      forbid: {
        resultTypes: ['empty', 'error']
      }
    },
    {
      id: 'qqmusic.album.standard',
      name: 'QQ Music album resolution',
      input: {
        type: 'resolve',
        value: 'https://y.qq.com/n/ryqq/albumDetail/000gXCTb2AhRR1'
      },
      expect: {
        result: {
          type: 'playlist'
        },
        collection: {
          minItems: 1
        }
      },
      forbid: {
        resultTypes: ['empty', 'error']
      }
    },
    {
      id: 'qqmusic.playlist.standard',
      name: 'QQ Music playlist resolution',
      input: {
        type: 'resolve',
        value: 'https://y.qq.com/n/ryqq/playlist/1374105607'
      },
      expect: {
        result: {
          type: 'playlist'
        },
        collection: {
          minItems: 1
        }
      },
      forbid: {
        resultTypes: ['empty', 'error']
      }
    },
    {
      id: 'qqmusic.toplist.standard',
      name: 'QQ Music toplist resolution',
      input: {
        type: 'resolve',
        value: 'https://y.qq.com/n/ryqq/toplist/4'
      },
      expect: {
        result: {
          type: 'playlist'
        },
        collection: {
          minItems: 1
        }
      },
      forbid: {
        resultTypes: ['empty', 'error']
      }
    },
    {
      id: 'qqmusic.singer.standard',
      name: 'QQ Music singer discography resolution',
      input: {
        type: 'resolve',
        value: 'https://y.qq.com/n/ryqq/singer/001BLpXF2DyJe2'
      },
      expect: {
        result: {
          type: 'playlist'
        },
        collection: {
          minItems: 1
        }
      },
      forbid: {
        resultTypes: ['empty', 'error']
      }
    },
    {
      id: 'qqmusic.search.standard',
      name: 'QQ Music search queries (qqsearch)',
      input: {
        type: 'search',
        value: 'Jay Chou',
        searchType: 'qqsearch'
      },
      expect: {
        result: {
          type: 'search'
        },
        collection: {
          minItems: 1
        }
      },
      forbid: {
        resultTypes: ['empty', 'error']
      }
    }
  ]

  /**
   * Reference to the worker context.
   * @internal
   */
  private readonly nodelink: WorkerNodeLink

  /**
   * QQ Music source configuration.
   * @public
   */
  public readonly config?: QQMusicConfig

  /**
   * Search prefixes recognized for QQ Music.
   * @public
   */
  public readonly searchTerms: string[] = ['qqsearch']

  /**
   * Alternate names for source routing.
   * @public
   */
  public readonly additionalsSourceName: string[] = ['qqmusic', 'qq']

  /**
   * URL patterns for identifying QQ Music links.
   * @public
   */
  public readonly patterns: RegExp[] = [
    /^https?:\/\/(?:y|i)\.qq\.com\/(?:n\/ryqq\/songDetail|n\/yqq\/song)\/([0-9a-zA-Z]+)(?:\.html|\?|$)/i,
    /^https?:\/\/(?:i\.)?y\.qq\.com\/v8\/playsong\.html\?.*?\bsongmid=([0-9a-zA-Z]+)/i,
    /^https?:\/\/y\.qq\.com\/(?:n\/ryqq\/albumDetail|n\/yqq\/album)\/([0-9a-zA-Z]+)(?:\.html|\?|$)/i,
    /^https?:\/\/y\.qq\.com\/(?:n\/ryqq\/playlist|n\/yqq\/playlist)\/(\d+)(?:\.html|\?|$)/i,
    /^https?:\/\/y\.qq\.com\/n\/ryqq\/toplist\/(\d+)(?:\.html|\?|$)/i,
    /^https?:\/\/y\.qq\.com\/n\/ryqq\/singer\/([0-9a-zA-Z]+)(?:\.html|\?|$)/i
  ]

  /**
   * Priority score for source selection.
   * @public
   */
  public readonly priority: number = 65

  /**
   * Creates an instance of QQMusicSource.
   * @param nodelink - Worker context instance.
   */
  public constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
    this.config = nodelink.options.sources?.qqmusic as QQMusicConfig | undefined
  }

  /**
   * Initializes QQ Music source dependencies and verifies configuration.
   * @returns Resolves to true when initialization succeeds.
   * @public
   */
  public async setup(): Promise<boolean> {
    logger('info', 'Sources', 'Loaded QQ Music source.')
    return true
  }

  /**
   * Searches tracks on QQ Music.
   * @param query - Search text query.
   * @returns Search result payload.
   * @public
   */
  public async search(query: string): Promise<SourceResult> {
    const limit = this.nodelink.options.search?.maxResults || 20
    const url = `${SEARCH_URL}?p=1&n=${limit}&w=${encodeURIComponent(query)}&format=json&platform=yqq.json&inCharset=utf-8&outCharset=utf-8&new_json=1`

    try {
      const res = await http1makeRequest(url, {
        method: 'GET',
        headers: this.buildHeaders(),
        proxy: this.config?.proxy
      })

      if (res.error || !res.body) {
        return {
          loadType: 'error',
          exception: {
            message: res.error || 'Failed to fetch QQ Music search results',
            severity: 'fault'
          }
        }
      }

      const body =
        typeof res.body === 'string'
          ? (JSON.parse(res.body) as QQMusicSearchResponse)
          : (res.body as QQMusicSearchResponse)

      const list = body?.data?.song?.list
      if (!list || list.length === 0) {
        return {
          loadType: 'empty',
          data: {}
        }
      }

      const tracks: TrackData[] = []
      for (const item of list) {
        if (item.mid) {
          tracks.push(this.buildSongTrack(item))
        }
      }

      if (tracks.length === 0) {
        return {
          loadType: 'empty',
          data: {}
        }
      }

      return {
        loadType: 'search',
        data: tracks
      }
    } catch (err) {
      return {
        loadType: 'error',
        exception: {
          message: err instanceof Error ? err.message : String(err),
          severity: 'fault'
        }
      }
    }
  }

  /**
   * Resolves a QQ Music URL to a track or playlist.
   * @param url - Source URL to resolve.
   * @returns Resolved track or playlist payload.
   * @public
   */
  public async resolve(url: string): Promise<SourceResult> {
    const parsed = this.parseUrl(url)
    if (!parsed) {
      return {
        loadType: 'empty',
        data: {}
      }
    }

    switch (parsed.type) {
      case 'song':
        return await this.resolveSong(parsed.id)
      case 'album':
        return await this.resolveAlbum(parsed.id)
      case 'playlist':
        return await this.resolvePlaylist(parsed.id)
      case 'toplist':
        return await this.resolveToplist(parsed.id)
      case 'singer':
        return await this.resolveSinger(parsed.id)
      default:
        return {
          loadType: 'empty',
          data: {}
        }
    }
  }

  /**
   * Resolves audio streaming URL for a track, falling back to alternative source
   * when VIP or DRM restrictions prevent direct stream URL retrieval.
   * @param track - Track info.
   * @returns Streaming URL details.
   * @public
   */
  public async getTrackUrl(track: TrackInfo): Promise<TrackUrlResult> {
    const mid = track.identifier
    const curMs = Date.now() % 1000
    const guid = String(Math.floor((Math.random() * 2147483647 * curMs) % 1e10))
    const uin = this.config?.uin ? String(this.config.uin) : '0'

    let mediaMid = mid
    try {
      const detailPayload = {
        comm: { cv: 0, ct: 24, format: 'json', uin: Number(uin) || 0 },
        info: {
          module: 'music.pf_song_detail_svr',
          method: 'get_song_detail_yqq',
          param: { song_mid: mid, song_type: 0 }
        }
      }
      const detailRes = await this.callMusicu<{
        info?: QQMusicSongDetailResponse
      }>(detailPayload)
      const fetchedMediaMid = detailRes?.info?.data?.track_info?.file?.media_mid
      if (fetchedMediaMid) {
        mediaMid = fetchedMediaMid
      }
    } catch (err) {
      logger(
        'warn',
        'QQMusic',
        `Failed to fetch track media_mid: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    const formats = [
      { prefix: 'M800', ext: 'mp3', format: 'mp3' },
      { prefix: 'M500', ext: 'mp3', format: 'mp3' },
      { prefix: 'C400', ext: 'm4a', format: 'm4a' },
      { prefix: 'C200', ext: 'm4a', format: 'm4a' }
    ]

    try {
      const vkeyPayload = {
        comm: { cv: 0, ct: 24, format: 'json', uin: Number(uin) || 0 },
        req_1: {
          module: 'vkey.GetVkeyServer',
          method: 'CgiGetVkey',
          param: {
            guid,
            songmid: formats.map(() => mid),
            songtype: formats.map(() => 0),
            uin,
            loginflag: 1,
            platform: '20',
            filename: formats.map((f) => `${f.prefix}${mediaMid}.${f.ext}`)
          }
        }
      }

      const vkeyRes = await this.callMusicu<{
        req_1?: {
          code: number
          data?: {
            sip?: string[]
            midurlinfo?: Array<{
              songmid: string
              filename: string
              purl: string
              result?: number
            }>
          }
        }
      }>(vkeyPayload)

      const midurlinfo = vkeyRes?.req_1?.data?.midurlinfo
      const sip = vkeyRes?.req_1?.data?.sip || [
        'https://dl.stream.qqmusic.qq.com/'
      ]
      const baseSip = sip[0] || 'https://dl.stream.qqmusic.qq.com/'
      const host = baseSip.endsWith('/') ? baseSip : `${baseSip}/`

      if (Array.isArray(midurlinfo)) {
        for (const item of midurlinfo) {
          if (item.purl && item.purl.length > 0) {
            const streamUrl = `${host}${item.purl}`
            const ext = item.filename?.endsWith('.m4a') ? 'm4a' : 'mp3'
            return {
              url: streamUrl,
              protocol: 'http',
              format: ext
            }
          }
        }
      }
    } catch (err) {
      logger(
        'warn',
        'QQMusic',
        `Error requesting VKey: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    return await this.resolveFallback(track as QQMusicDecodedTrack)
  }

  /**
   * Streams audio data using event-driven backpressure management.
   * Avoids stream freezing bugs by using data/drain listeners instead of pipe().
   * @param _track - Decoded track information.
   * @param url - Audio stream URL.
   * @returns Streaming result with PassThrough.
   * @public
   */
  public async loadStream(
    _track: TrackInfo,
    url: string
  ): Promise<QQMusicLoadStreamResult> {
    const res = await http1makeRequest(url, {
      method: 'GET',
      streamOnly: true,
      headers: this.buildHeaders(),
      proxy: this.config?.proxy
    })

    if (res.error || !res.stream || (res.statusCode && res.statusCode >= 400)) {
      return {
        exception: {
          message:
            res.error || `HTTP error ${res.statusCode} loading audio stream`,
          severity: 'fault'
        }
      }
    }

    const passthrough = new PassThrough()
    const source = res.stream as Readable

    source.on('data', (chunk: Buffer) => {
      if (!passthrough.write(chunk)) source.pause()
    })

    passthrough.on('drain', () => {
      source.resume()
    })

    source.on('end', () => {
      if (!passthrough.writableEnded) {
        passthrough.emit('finishBuffering')
        passthrough.end()
      }
    })

    source.on('error', (err) => {
      logger('error', 'QQMusic', `Underlying stream error: ${err.message}`)
      if (!passthrough.destroyed) passthrough.destroy(err)
    })

    const isM4a = url.includes('.m4a')
    return {
      stream: passthrough,
      type: isM4a ? 'audio/mp4' : 'audio/mpeg'
    }
  }

  /**
   * Executes a variant test for declarative stream verification in test-sources.
   * @param variant - Test variant definition.
   * @param track - Track info under test.
   * @param streamSpec - Optional stream validation specification.
   * @returns Variant test result with stream.
   * @public
   */
  public async executeVariant(
    variant: SourceTestVariant,
    track: TrackInfo,
    streamSpec?: SourceTestStreamSpec
  ): Promise<SourceTestVariantResult> {
    const urlData = await this.getTrackUrl(track)
    if (!urlData || urlData.exception || !urlData.url) {
      return {
        variant: variant.id,
        resolved: false,
        error:
          urlData?.exception?.message || 'Failed to resolve track streaming URL'
      }
    }

    const container =
      urlData.format === 'm4a' ? 'mov,mp4,m4a,3gp,3g2,mj2' : 'mp3'
    const codec = urlData.format === 'm4a' ? 'aac' : 'mp3'

    if (!streamSpec?.required) {
      return {
        variant: variant.id,
        resolved: true,
        track: urlData.newTrack?.info || track,
        container,
        codec
      }
    }

    const streamResult = await this.loadStream(track, urlData.url)
    if (!('stream' in streamResult)) {
      return {
        variant: variant.id,
        resolved: true,
        error: streamResult.exception.message || 'Failed to load audio stream'
      }
    }

    return {
      variant: variant.id,
      resolved: true,
      track: urlData.newTrack?.info || track,
      stream: streamResult.stream,
      container,
      codec,
      httpStatus: 200
    }
  }

  /**
   * Resolves a single song by its alphanumeric MID.
   * @internal
   */
  private async resolveSong(mid: string): Promise<SourceResult> {
    const uin = this.config?.uin ? String(this.config.uin) : '0'
    const payload = {
      comm: { cv: 0, ct: 24, format: 'json', uin: Number(uin) || 0 },
      info: {
        module: 'music.pf_song_detail_svr',
        method: 'get_song_detail_yqq',
        param: { song_mid: mid, song_type: 0 }
      }
    }

    const res = await this.callMusicu<{ info?: QQMusicSongDetailResponse }>(
      payload
    )
    const trackInfo = res?.info?.data?.track_info
    if (!trackInfo || (!trackInfo.mid && !trackInfo.name)) {
      return {
        loadType: 'empty',
        data: {}
      }
    }

    const track = this.buildSongTrack(trackInfo)
    return {
      loadType: 'track',
      data: track
    }
  }

  /**
   * Resolves an album by its alphanumeric MID.
   * @internal
   */
  private async resolveAlbum(mid: string): Promise<SourceResult> {
    const url = `${ALBUM_URL}?albummid=${mid}&format=json`
    const res = await http1makeRequest(url, {
      method: 'GET',
      headers: this.buildHeaders(),
      proxy: this.config?.proxy
    })

    if (res.error || !res.body) {
      return {
        loadType: 'error',
        exception: {
          message: res.error || 'Failed to fetch QQ Music album',
          severity: 'fault'
        }
      }
    }

    const body =
      typeof res.body === 'string'
        ? (JSON.parse(res.body) as QQMusicAlbumApiResponse)
        : (res.body as QQMusicAlbumApiResponse)

    const list = body?.data?.list
    if (!list || list.length === 0) {
      return {
        loadType: 'empty',
        data: {}
      }
    }

    const tracks: TrackData[] = []
    for (const item of list) {
      tracks.push(this.buildLegacySongTrack(item))
    }

    return {
      loadType: 'playlist',
      data: {
        info: {
          name: body.data?.name || 'QQ Music Album',
          selectedTrack: 0
        },
        pluginInfo: {},
        tracks
      }
    }
  }

  /**
   * Resolves a playlist by its numeric identifier.
   * @internal
   */
  private async resolvePlaylist(disstid: string): Promise<SourceResult> {
    const url = `${PLAYLIST_URL}?type=1&json=1&utf8=1&onlysong=0&disstid=${disstid}`
    const res = await http1makeRequest(url, {
      method: 'GET',
      headers: this.buildHeaders(),
      proxy: this.config?.proxy
    })

    if (res.error || !res.body) {
      return {
        loadType: 'error',
        exception: {
          message: res.error || 'Failed to fetch QQ Music playlist',
          severity: 'fault'
        }
      }
    }

    let text =
      typeof res.body === 'string' ? res.body : JSON.stringify(res.body)
    text = text.replace(/^[a-zA-Z_0-9$.]+\s*\(/, '').replace(/\)\s*;?$/, '')

    let body: QQMusicPlaylistApiResponse
    try {
      body = JSON.parse(text) as QQMusicPlaylistApiResponse
    } catch {
      return {
        loadType: 'error',
        exception: {
          message: 'Failed to parse QQ Music playlist response',
          severity: 'fault'
        }
      }
    }

    const cd = body?.cdlist?.[0]
    const list = cd?.songlist
    if (!list || list.length === 0) {
      return {
        loadType: 'empty',
        data: {}
      }
    }

    const tracks: TrackData[] = []
    for (const item of list) {
      tracks.push(this.buildLegacySongTrack(item))
    }

    return {
      loadType: 'playlist',
      data: {
        info: {
          name: cd.dissname || 'QQ Music Playlist',
          selectedTrack: 0
        },
        pluginInfo: {},
        tracks
      }
    }
  }

  /**
   * Resolves a toplist by its numeric identifier.
   * @internal
   */
  private async resolveToplist(topid: string): Promise<SourceResult> {
    const url = `${TOPLIST_URL}?type=toplist&topid=${topid}&format=json`
    const res = await http1makeRequest(url, {
      method: 'GET',
      headers: this.buildHeaders(),
      proxy: this.config?.proxy
    })

    if (res.error || !res.body) {
      return {
        loadType: 'error',
        exception: {
          message: res.error || 'Failed to fetch QQ Music toplist',
          severity: 'fault'
        }
      }
    }

    const body =
      typeof res.body === 'string'
        ? (JSON.parse(res.body) as QQMusicToplistApiResponse)
        : (res.body as QQMusicToplistApiResponse)

    const list = body?.songlist
    if (!list || list.length === 0) {
      return {
        loadType: 'empty',
        data: {}
      }
    }

    const tracks: TrackData[] = []
    for (const item of list) {
      if (item?.data) {
        tracks.push(this.buildLegacySongTrack(item.data))
      }
    }

    return {
      loadType: 'playlist',
      data: {
        info: {
          name: body.topinfo?.ListName || 'QQ Music Toplist',
          selectedTrack: 0
        },
        pluginInfo: {},
        tracks
      }
    }
  }

  /**
   * Resolves a singer by alphanumeric MID.
   * @internal
   */
  private async resolveSinger(singermid: string): Promise<SourceResult> {
    const uin = this.config?.uin ? String(this.config.uin) : '0'
    const payload = {
      comm: { cv: 0, ct: 24, format: 'json', uin: Number(uin) || 0 },
      req_1: {
        module: 'music.web_singer_info_svr',
        method: 'get_singer_detail_info',
        param: {
          sort: 5,
          singermid,
          sin: 0,
          num: 50
        }
      }
    }

    const res = await this.callMusicu<{
      req_1?: QQMusicSingerDetailApiResponse
    }>(payload)
    const data = res?.req_1?.data
    const list = data?.songlist
    if (!list || list.length === 0) {
      return {
        loadType: 'empty',
        data: {}
      }
    }

    const tracks: TrackData[] = []
    for (const item of list) {
      if (item.mid) {
        tracks.push(this.buildSongTrack(item))
      }
    }

    return {
      loadType: 'playlist',
      data: {
        info: {
          name: data.singer_info?.name || 'QQ Music Singer',
          selectedTrack: 0
        },
        pluginInfo: {},
        tracks
      }
    }
  }

  /**
   * Converts a standard song object to NodeLink TrackData.
   * @internal
   */
  private buildSongTrack(song: QQMusicSongInfo): TrackData {
    const mid = song.mid || String(song.id || '')
    const author =
      song.singer
        ?.map((s) => s.name || s.title)
        .filter(Boolean)
        .join(', ') || 'Unknown Artist'
    const artworkUrl = song.album?.mid
      ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${song.album.mid}.jpg`
      : song.singer?.[0]?.mid
        ? `https://y.gtimg.cn/music/photo_new/T001R300x300M000${song.singer[0].mid}.jpg`
        : null

    const trackInfo: TrackInfo = {
      identifier: mid,
      isSeekable: true,
      author,
      length: (song.interval || 0) * 1000,
      isStream: false,
      position: 0,
      title: song.name || song.title || 'Unknown Title',
      uri: `https://y.qq.com/n/ryqq/songDetail/${mid}`,
      artworkUrl,
      isrc: null,
      sourceName: 'qqmusic'
    }

    return {
      encoded: encodeTrack({ ...trackInfo, details: [] }),
      info: trackInfo,
      pluginInfo: {}
    }
  }

  /**
   * Converts a legacy song object to NodeLink TrackData.
   * @internal
   */
  private buildLegacySongTrack(song: QQMusicSongLegacy): TrackData {
    const mid = song.songmid || String(song.songid || '')
    const author =
      song.singer
        ?.map((s) => s.name)
        .filter(Boolean)
        .join(', ') || 'Unknown Artist'
    const artworkUrl = song.albummid
      ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${song.albummid}.jpg`
      : song.singer?.[0]?.mid
        ? `https://y.gtimg.cn/music/photo_new/T001R300x300M000${song.singer[0].mid}.jpg`
        : null

    const trackInfo: TrackInfo = {
      identifier: mid,
      isSeekable: true,
      author,
      length: (song.interval || 0) * 1000,
      isStream: false,
      position: 0,
      title: song.songname || 'Unknown Title',
      uri: `https://y.qq.com/n/ryqq/songDetail/${mid}`,
      artworkUrl,
      isrc: null,
      sourceName: 'qqmusic'
    }

    return {
      encoded: encodeTrack({ ...trackInfo, details: [] }),
      info: trackInfo,
      pluginInfo: {}
    }
  }

  /**
   * Resolves alternative stream via YouTube search when QQ Music audio requires VIP.
   * @internal
   */
  private async resolveFallback(
    track: QQMusicDecodedTrack
  ): Promise<TrackUrlResult> {
    if (!this.nodelink.sources?.search) {
      return {
        exception: {
          message:
            'Song requires QQ Music VIP and alternative fallback search is unavailable.',
          severity: 'common'
        }
      }
    }

    const query = `${track.title} ${track.author}`
    const searchResult = await this.nodelink.sources.search(query, 'ytsearch')
    if (
      searchResult.loadType !== 'search' ||
      !Array.isArray(searchResult.data)
    ) {
      return {
        exception: {
          message: 'No fallback track found for VIP audio.',
          severity: 'common'
        }
      }
    }

    const candidates: BestMatchCandidate[] = []
    const fallbackTracks: TrackInfo[] = []

    for (const item of searchResult.data) {
      const info = (item as TrackData)?.info
      if (info?.title && info.author) {
        candidates.push({ info })
        fallbackTracks.push(info)
      }
    }

    const bestMatch = getBestMatch(candidates, track)
    if (!bestMatch) {
      return {
        exception: {
          message: 'No suitable alternative found for VIP track.',
          severity: 'common'
        }
      }
    }

    const fallbackTrack = fallbackTracks.find(
      (candidate) =>
        candidate.title === bestMatch.info.title &&
        candidate.author === bestMatch.info.author &&
        candidate.length === bestMatch.info.length
    )

    if (!fallbackTrack) {
      return {
        exception: {
          message: 'No matching alternative found.',
          severity: 'common'
        }
      }
    }

    const streamInfo = await this.nodelink.sources.getTrackUrl(fallbackTrack)
    return { newTrack: { info: fallbackTrack }, ...streamInfo }
  }

  /**
   * Calls the QQ Music modern gateway (musicu.fcg).
   * @internal
   */
  private async callMusicu<T>(
    payload: Record<string, unknown>
  ): Promise<T | null> {
    const url = `${MUSICU_URL}?data=${encodeURIComponent(JSON.stringify(payload))}`
    const res = await http1makeRequest(url, {
      method: 'GET',
      headers: this.buildHeaders(),
      proxy: this.config?.proxy
    })

    if (res.error || !res.body) {
      return null
    }

    return typeof res.body === 'string'
      ? (JSON.parse(res.body) as T)
      : (res.body as T)
  }

  /**
   * Constructs request headers including optional cookies.
   * @internal
   */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Referer: REFERER
    }

    const cookieParts: string[] = []
    if (this.config?.cookie) {
      cookieParts.push(this.config.cookie)
    }
    if (this.config?.uin && !this.config?.cookie?.includes('uin=')) {
      cookieParts.push(`uin=${this.config.uin}`)
    }
    if (this.config?.qmKeyst && !this.config?.cookie?.includes('qm_keyst=')) {
      cookieParts.push(`qm_keyst=${this.config.qmKeyst}`)
    }

    if (cookieParts.length > 0) {
      headers.Cookie = cookieParts.join('; ')
    }

    return headers
  }

  /**
   * Parses supported QQ Music URL patterns.
   * @internal
   */
  private parseUrl(url: string): QQMusicParsedUrl | null {
    const songRegex =
      /^https?:\/\/(?:y|i)\.qq\.com\/(?:n\/ryqq\/songDetail|n\/yqq\/song)\/([0-9a-zA-Z]+)(?:\.html|\?|$)/i
    const legacySongRegex =
      /^https?:\/\/(?:i\.)?y\.qq\.com\/v8\/playsong\.html\?.*?\bsongmid=([0-9a-zA-Z]+)/i
    const albumRegex =
      /^https?:\/\/y\.qq\.com\/(?:n\/ryqq\/albumDetail|n\/yqq\/album)\/([0-9a-zA-Z]+)(?:\.html|\?|$)/i
    const playlistRegex =
      /^https?:\/\/y\.qq\.com\/(?:n\/ryqq\/playlist|n\/yqq\/playlist)\/(\d+)(?:\.html|\?|$)/i
    const toplistRegex =
      /^https?:\/\/y\.qq\.com\/n\/ryqq\/toplist\/(\d+)(?:\.html|\?|$)/i
    const singerRegex =
      /^https?:\/\/y\.qq\.com\/n\/ryqq\/singer\/([0-9a-zA-Z]+)(?:\.html|\?|$)/i

    let match = songRegex.exec(url)
    if (match?.[1]) return { type: 'song', id: match[1] }

    match = legacySongRegex.exec(url)
    if (match?.[1]) return { type: 'song', id: match[1] }

    match = albumRegex.exec(url)
    if (match?.[1]) return { type: 'album', id: match[1] }

    match = playlistRegex.exec(url)
    if (match?.[1]) return { type: 'playlist', id: match[1] }

    match = toplistRegex.exec(url)
    if (match?.[1]) return { type: 'toplist', id: match[1] }

    match = singerRegex.exec(url)
    if (match?.[1]) return { type: 'singer', id: match[1] }

    return null
  }
}
