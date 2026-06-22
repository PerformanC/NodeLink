import crypto from 'node:crypto'
import { PassThrough, type Readable } from 'node:stream'
import HLSHandler from '../playback/hls/HLSHandler.ts'
import type { BilibiliSourceConfig } from '../typings/config/config.types.ts'
import type {
  BilibiliApiResponse,
  BilibiliAudioData,
  BilibiliBangumiData,
  BilibiliBangumiEpisode,
  BilibiliPlayurlData,
  BilibiliVideoData,
  BilibiliWbiImg
} from '../typings/sources/bilibili.types.ts'
import type {
  SourceInstance,
  SourceResult,
  TrackData,
  TrackInfo,
  TrackStreamResult,
  TrackUrlResult,
  WorkerNodeLink
} from '../typings/sources/source.types.ts'
import { encodeTrack, http1makeRequest, logger, makeRequest } from '../utils.ts'

/**
 * Mixin key encoding table for Bilibili WBI signatures.
 * @internal
 */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52
]

/**
 * Default HTTP headers for Bilibili API requests.
 * @internal
 */
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/'
}

/**
 * Bilibili source implementation.
 * Supports Video (BV/av), Bangumi, Audio, Live, and Space resolution.
 * Implements WBI signature generation for authenticated API access.
 * @public
 */
export default class BilibiliSource implements SourceInstance {
  /**
   * The NodeLink worker context.
   * @internal
   */
  private readonly nodelink: WorkerNodeLink

  /**
   * Bilibili specific configuration.
   * @internal
   */
  private readonly config: BilibiliSourceConfig

  /**
   * Regular expression patterns for identifying Bilibili URLs.
   * @public
   */
  public readonly patterns = [
    /https?:\/\/(?:www\.)?bilibili\.com\/video\/(BV[a-zA-Z0-9]+|av\d+)/,
    /https?:\/\/(?:www\.)?bilibili\.com\/bangumi\/play\/(ep|ss)(\d+)/,
    /https?:\/\/(?:www\.)?bilibili\.com\/audio\/(au|am)(\d+)/,
    /https?:\/\/live\.bilibili\.com\/(\d+)/,
    /https?:\/\/space\.bilibili\.com\/(\d+)/,
    /^https?:\/\/b23\.tv\/.+/i
  ]

  /**
   * Search term prefixes recognized by this source.
   * @public
   */
  public readonly searchTerms = ['bilisearch', 'bilibili']

  /**
   * Priority score for source selection.
   * @public
   */
  public readonly priority = 100

  /**
   * Cached WBI mixin key for signature generation.
   * @internal
   */
  private wbiKeys: string | null = null

  /**
   * Expiration timestamp for the cached WBI key.
   * @internal
   */
  private wbiKeysExpiry = 0

  /**
   * Buvid3 identifier for cookies.
   * @internal
   */
  private readonly buvid3: string

  /**
   * Buvid4 identifier for cookies.
   * @internal
   */
  private readonly buvid4: string

  /**
   * SESSDATA cookie string.
   * @internal
   */
  private readonly cookie: string

  /**
   * Constructs a new BilibiliSource instance.
   * @param nodelink - The worker context.
   */
  constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
    this.config = (nodelink.options.sources?.bilibili || {
      enabled: false,
      sessdata: ''
    }) as BilibiliSourceConfig

    this.buvid3 = this.generateBuvid3()
    this.buvid4 = this.generateBuvid4()
    this.cookie = this.config.sessdata ? `SESSDATA=${this.config.sessdata}` : ''
  }

  /**
   * Generates a random buvid3 identifier.
   * @returns A 32-character random string.
   * @internal
   */
  private generateBuvid3(): string {
    const chars =
      '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
    let result = ''
    for (let i = 0; i < 32; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    return result
  }

  /**
   * Generates a random buvid4 identifier.
   * @returns A 36-character random string.
   * @internal
   */
  private generateBuvid4(): string {
    const chars =
      '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
    let result = ''
    for (let i = 0; i < 36; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    return result
  }

  /**
   * Constructs the full cookie header for API requests.
   * @returns A semicolon-separated cookie string.
   * @internal
   */
  private buildCookieHeader(): string {
    const baseCookie = `buvid3=${this.buvid3}; buvid4=${this.buvid4}; CURRENT_FNVAL=4048`
    return this.cookie ? `${baseCookie}; ${this.cookie}` : baseCookie
  }

  /**
   * Performs source-level initialization.
   * @returns A promise resolving to true.
   * @public
   */
  public async setup(): Promise<boolean> {
    logger(
      'info',
      'Sources',
      'Loaded Bilibili source (Video, Audio, Live, Space, Lyrics, Login).'
    )
    return true
  }

  /**
   * Fetches and caches WBI keys for API signing.
   * @returns A promise resolving to the mixin key.
   * @internal
   */
  private async _getWbiKeys(): Promise<string> {
    if (this.wbiKeys && Date.now() < this.wbiKeysExpiry) {
      return this.wbiKeys
    }

    const cm = this.nodelink.credentialManager
    const cachedKeys = cm?.get<string>('bilibili_wbi_keys')
    if (cachedKeys) {
      this.wbiKeys = cachedKeys
      this.wbiKeysExpiry = Date.now() + 1000 * 60 * 60
      return this.wbiKeys
    }

    const res = await makeRequest(
      'https://api.bilibili.com/x/web-interface/nav',
      {
        method: 'GET',
        headers: { ...HEADERS, Cookie: this.buildCookieHeader() },
        proxy: this.config.network.proxy
      }
    )

    const body = res.body as
      | BilibiliApiResponse<{ wbi_img: BilibiliWbiImg }>
      | undefined

    if (res.error || !body?.data?.wbi_img) {
      throw new Error(`Failed to fetch WBI keys: ${res.error || 'No data'}`)
    }

    const { img_url, sub_url } = body.data.wbi_img
    const imgKey = img_url.slice(
      img_url.lastIndexOf('/') + 1,
      img_url.lastIndexOf('.')
    )
    const subKey = sub_url.slice(
      sub_url.lastIndexOf('/') + 1,
      sub_url.lastIndexOf('.')
    )

    const rawKey = imgKey + subKey
    let mixinKey = ''
    for (const index of MIXIN_KEY_ENC_TAB) {
      const char = rawKey[index]
      if (char) mixinKey += char
    }

    this.wbiKeys = mixinKey.slice(0, 32)
    this.wbiKeysExpiry = Date.now() + 1000 * 60 * 60
    cm?.set('bilibili_wbi_keys', this.wbiKeys, 1000 * 60 * 60)

    return this.wbiKeys
  }

  /**
   * Signs a set of parameters with a WBI mixin key.
   * @param params - The query parameters to sign.
   * @param mixinKey - The mixin key.
   * @returns A signed query string.
   * @internal
   */
  private _signWbi(
    params: Record<string, string | number>,
    mixinKey: string
  ): string {
    const currTime = Math.round(Date.now() / 1000)
    const newParams: Record<string, string | number> = {
      ...params,
      wts: currTime
    }

    const query = Object.keys(newParams)
      .sort()
      .map((key) => {
        const val = newParams[key]
        const value = (
          val !== undefined && val !== null ? val.toString() : ''
        ).replace(/[!'()*]/g, '')
        return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
      })
      .join('&')

    const w_rid = crypto
      .createHash('md5')
      .update(query + mixinKey)
      .digest('hex')
    return `${query}&w_rid=${w_rid}`
  }

  /**
   * Executes a catalog search on Bilibili.
   * Falls back from video-only search to all-type search if needed.
   * @param query - The search query.
   * @returns A promise resolving to the search result payload.
   * @public
   */
  public async search(query: string): Promise<SourceResult> {
    try {
      let body: BilibiliApiResponse<unknown> | null = null
      const cookie = this.buildCookieHeader()

      const searchResponse = await makeRequest(
        `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(query)}`,
        {
          method: 'GET',
          headers: {
            ...HEADERS,
            Cookie: cookie,
            Referer: 'https://search.bilibili.com/'
          },
          proxy: this.config.network.proxy
        }
      )
      body = searchResponse.body as BilibiliApiResponse<unknown>

      if (
        !body?.data ||
        !(body.data as { result?: unknown[] }).result ||
        !Array.isArray((body.data as { result: unknown[] }).result) ||
        (body.data as { result: unknown[] }).result.length === 0
      ) {
        const allSearchResponse = await makeRequest(
          `https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(query)}`,
          {
            method: 'GET',
            headers: {
              ...HEADERS,
              Cookie: cookie,
              Referer: 'https://search.bilibili.com/'
            },
            proxy: this.config.network.proxy
          }
        )
        body = allSearchResponse.body as BilibiliApiResponse<unknown>
      }

      const results = (body?.data as { result?: unknown[] })?.result || []
      let videos: Array<Record<string, unknown>> = []

      if (results.length > 0) {
        const first = results[0] as { type?: string }
        if (first.type === 'video') {
          videos = results as Array<Record<string, unknown>>
        } else {
          const videoSection = (
            results as Array<{ result_type?: string; data?: unknown[] }>
          ).find((r) => r.result_type === 'video')
          if (Array.isArray(videoSection?.data)) {
            videos = videoSection.data as Array<Record<string, unknown>>
          }
        }
      }

      if (!videos?.length) {
        return { loadType: 'empty', data: {} }
      }

      const tracks: TrackData[] = []
      const limit = (this.nodelink.options.search.maxResults as number) || 10

      for (const item of videos.slice(0, limit)) {
        const durationParts = String(item.duration || '0:0')
          .split(':')
          .map(Number)
        let durationMs = 0
        if (durationParts.length === 2) {
          durationMs =
            ((durationParts[0] || 0) * 60 + (durationParts[1] || 0)) * 1000
        } else if (durationParts.length === 3) {
          durationMs =
            ((durationParts[0] || 0) * 3600 +
              (durationParts[1] || 0) * 60 +
              (durationParts[2] || 0)) *
            1000
        }

        const bvid = String(item.bvid || '')
        const trackInfo: TrackInfo = {
          identifier: bvid,
          isSeekable: true,
          author: String(item.author || 'Unknown'),
          length: durationMs,
          isStream: false,
          position: 0,
          title: String(item.title || 'Unknown').replace(/<[^>]*>/g, ''),
          uri: String(item.arcurl || `https://www.bilibili.com/video/${bvid}`),
          artworkUrl: String(item.pic || '').startsWith('//')
            ? `https:${item.pic}`
            : String(item.pic || ''),
          isrc: null,
          sourceName: 'bilibili'
        }

        tracks.push({
          encoded: encodeTrack({ ...trackInfo, details: [] }),
          info: trackInfo,
          pluginInfo: { aid: item.aid, cid: item.cid || 0 }
        })
      }

      return { loadType: 'search', data: tracks }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return { loadType: 'error', exception: { message, severity: 'fault' } }
    }
  }

  /**
   * Resolves Bilibili short URLs (b23.tv) via redirection analysis.
   * @param shortUrl - The short URL.
   * @returns A promise resolving to the canonical URL.
   * @public
   */
  public async resolveShortUrl(shortUrl: string): Promise<string> {
    try {
      const res = await makeRequest(shortUrl, {
        method: 'GET',
        headers: HEADERS,
        maxRedirects: 3,
        timeout: 5000,
        proxy: this.config.network.proxy
      })

      if (typeof res.body === 'string') {
        const match = res.body.match(
          /rel=["']canonical["'][^>]+href=["']([^"']+)["']/
        )
        if (match?.[1]) return match[1]
      }
      return shortUrl
    } catch (error) {
      logger(
        'warn',
        'Bilibili',
        `Short URL resolution failed: ${error instanceof Error ? error.message : String(error)}`
      )
      return shortUrl
    }
  }

  /**
   * Extracts the page index ('p' parameter) from a Bilibili URL.
   * @internal
   */
  private extractPageParameter(url: string): number {
    const pageMatch = url.match(/[?&]p=(\d+)/)
    if (pageMatch) {
      const val = pageMatch[1]
      return val ? Number.parseInt(val, 10) : 0
    }
    return 0
  }

  /**
   * Builds a single track response from video metadata.
   * @internal
   */
  private loadSingleVideo(videoData: BilibiliVideoData): SourceResult {
    const trackInfo: TrackInfo = {
      identifier: videoData.bvid,
      isSeekable: true,
      author: videoData.owner.name,
      length: videoData.duration * 1000,
      isStream: false,
      position: 0,
      title: videoData.title,
      uri: `https://www.bilibili.com/video/${videoData.bvid}`,
      artworkUrl: videoData.pic,
      isrc: null,
      sourceName: 'bilibili'
    }

    return {
      loadType: 'track',
      data: {
        encoded: encodeTrack({ ...trackInfo, details: [] }),
        info: trackInfo,
        pluginInfo: {
          aid: videoData.aid,
          cid: videoData.cid,
          bvid: videoData.bvid
        }
      }
    }
  }

  /**
   * Builds a single track response from a specific page of a multi-page video.
   * @internal
   */
  private loadVideoPage(
    videoData: BilibiliVideoData,
    pageIndex: number
  ): SourceResult {
    const pages = videoData.pages || []
    const pageData = pages[pageIndex]
    if (!pageData) {
      return this.loadSingleVideo(videoData)
    }

    const trackInfo: TrackInfo = {
      identifier: `${videoData.bvid}?p=${pageData.page}`,
      isSeekable: true,
      author: videoData.owner.name,
      length: pageData.duration * 1000,
      isStream: false,
      position: 0,
      title: `${videoData.title} - ${pageData.part}`,
      uri: `https://www.bilibili.com/video/${videoData.bvid}?p=${pageData.page}`,
      artworkUrl: videoData.pic,
      isrc: null,
      sourceName: 'bilibili'
    }

    return {
      loadType: 'track',
      data: {
        encoded: encodeTrack({ ...trackInfo, details: [] }),
        info: trackInfo,
        pluginInfo: {
          aid: videoData.aid,
          cid: pageData.cid,
          bvid: videoData.bvid,
          page: pageData.page
        }
      }
    }
  }

  /**
   * Builds a playlist response from all pages of a multi-page video.
   * @internal
   */
  private loadVideoAnthology(videoData: BilibiliVideoData): SourceResult {
    const pages = videoData.pages || []
    const tracks: TrackData[] = pages.map((page) => {
      const trackInfo: TrackInfo = {
        identifier: `${videoData.bvid}?p=${page.page}`,
        isSeekable: true,
        author: videoData.owner.name,
        length: page.duration * 1000,
        isStream: false,
        position: 0,
        title: `${videoData.title} - ${page.part}`,
        uri: `https://www.bilibili.com/video/${videoData.bvid}?p=${page.page}`,
        artworkUrl: videoData.pic,
        isrc: null,
        sourceName: 'bilibili'
      }

      return {
        encoded: encodeTrack({ ...trackInfo, details: [] }),
        info: trackInfo,
        pluginInfo: {
          aid: videoData.aid,
          cid: page.cid,
          bvid: videoData.bvid,
          page: page.page
        }
      }
    })

    return {
      loadType: 'playlist',
      data: {
        info: { name: videoData.title, selectedTrack: 0 },
        tracks,
        pluginInfo: {}
      }
    }
  }

  /**
   * Resolves a Bilibili URL into a track or collection.
   * Supports Videos, Bangumis, Audios, Live rooms, and Space search.
   * @param url - The absolute Bilibili URL.
   * @returns A promise resolving to the resolution result.
   * @public
   */
  public async resolve(url: string): Promise<SourceResult> {
    if (url.includes('b23.tv')) {
      url = await this.resolveShortUrl(url)
    }

    const pat0 = this.patterns[0]
    const videoMatch = pat0 ? url.match(pat0) : null
    if (videoMatch) {
      const bvidOrAvid = videoMatch[1]
      if (!bvidOrAvid) return { loadType: 'empty', data: {} }
      const requestedPage = this.extractPageParameter(url)

      try {
        let apiUrl = 'https://api.bilibili.com/x/web-interface/view?'
        apiUrl += bvidOrAvid.startsWith('BV')
          ? `bvid=${bvidOrAvid}`
          : `aid=${bvidOrAvid.substring(2)}`

        const res = await makeRequest(apiUrl, {
          method: 'GET',
          headers: { ...HEADERS, Cookie: this.buildCookieHeader() },
          proxy: this.config.network.proxy
        })

        const body = res.body as
          | BilibiliApiResponse<BilibiliVideoData>
          | undefined

        if (body?.code !== 0) {
          throw new Error(`API Error: ${body?.message || 'Video not found'}`)
        }

        const data = body.data
        if (!data) throw new Error('No data returned from video API.')
        const pages = data.pages || []

        if (pages.length > 1) {
          if (requestedPage > 0)
            return this.loadVideoPage(data, requestedPage - 1)
          return this.loadVideoAnthology(data)
        }
        return this.loadSingleVideo(data)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return { loadType: 'error', exception: { message, severity: 'fault' } }
      }
    }

    const pat1 = this.patterns[1]
    const bangumiMatch = pat1 ? url.match(pat1) : null
    if (bangumiMatch) {
      const type = bangumiMatch[1]
      const id = bangumiMatch[2]
      if (!type || !id) return { loadType: 'empty', data: {} }

      try {
        const apiUrl =
          type === 'ep'
            ? `https://api.bilibili.com/pgc/view/web/season?ep_id=${id}`
            : `https://api.bilibili.com/pgc/view/web/season?season_id=${id}`

        const res = await makeRequest(apiUrl, {
          method: 'GET',
          headers: { ...HEADERS, Cookie: this.buildCookieHeader() },
          proxy: this.config.network.proxy
        })

        const body = res.body as
          | BilibiliApiResponse<BilibiliBangumiData>
          | undefined

        if (body?.code !== 0)
          throw new Error(`Bangumi API Error: ${body?.message}`)

        const result = body.result
        if (!result) throw new Error('No result returned from bangumi API.')
        const tracks: TrackData[] = result.episodes.map(
          (ep: BilibiliBangumiEpisode) => {
            const trackInfo: TrackInfo = {
              identifier: `ep${ep.id}`,
              isSeekable: true,
              author: result.season_title,
              length: ep.duration,
              isStream: false,
              position: 0,
              title: ep.long_title
                ? `${ep.title} - ${ep.long_title}`
                : ep.title,
              uri: ep.link,
              artworkUrl: ep.cover,
              isrc: null,
              sourceName: 'bilibili'
            }

            return {
              encoded: encodeTrack({ ...trackInfo, details: [] }),
              info: trackInfo,
              pluginInfo: {
                aid: ep.aid,
                cid: ep.cid,
                ep_id: ep.id,
                bvid: ep.bvid
              }
            }
          }
        )

        if (type === 'ep') {
          const target = tracks.find((t) => String(t.pluginInfo.ep_id) === id)
          if (target) return { loadType: 'track', data: target }
        }

        return {
          loadType: 'playlist',
          data: {
            info: { name: result.season_title, selectedTrack: 0 },
            tracks,
            pluginInfo: {}
          }
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return { loadType: 'error', exception: { message, severity: 'fault' } }
      }
    }

    const pat2 = this.patterns[2]
    const audioMatch = pat2 ? url.match(pat2) : null
    if (audioMatch) {
      const type = audioMatch[1]
      const id = audioMatch[2]
      if (!type || !id) return { loadType: 'empty', data: {} }
      try {
        if (type === 'au') {
          const res = await makeRequest(
            `https://www.bilibili.com/audio/music-service-c/web/song/info?sid=${id}`,
            {
              method: 'GET',
              headers: { ...HEADERS, Cookie: this.buildCookieHeader() },
              proxy: this.config.network.proxy
            }
          )

          const body = res.body as
            | BilibiliApiResponse<BilibiliAudioData>
            | undefined

          if (body?.code !== 0) throw new Error(`Audio API Error: ${body?.msg}`)

          const data = body.data
          if (!data) throw new Error('No data returned from audio API.')
          const trackInfo: TrackInfo = {
            identifier: `au${data.id}`,
            isSeekable: true,
            author: data.uname,
            length: data.duration * 1000,
            isStream: false,
            position: 0,
            title: data.title,
            uri: `https://www.bilibili.com/audio/au${data.id}`,
            artworkUrl: data.cover,
            isrc: null,
            sourceName: 'bilibili'
          }

          return {
            loadType: 'track',
            data: {
              encoded: encodeTrack({ ...trackInfo, details: [] }),
              info: trackInfo,
              pluginInfo: { sid: data.id, type: 'audio' }
            }
          }
        }

        const albumResRaw = await makeRequest(
          `https://www.bilibili.com/audio/music-service-c/web/song/of-menu?sid=${id}&pn=1&ps=100`,
          {
            method: 'GET',
            headers: { ...HEADERS, Cookie: this.buildCookieHeader() },
            proxy: this.config.network.proxy
          }
        )

        const albumRes = albumResRaw.body as
          | BilibiliApiResponse<{ data: BilibiliAudioData[] }>
          | undefined

        if (albumRes?.code !== 0)
          throw new Error(`Album API Error: ${albumRes?.msg}`)

        const tracks: TrackData[] = (albumRes.data?.data || []).map(
          (song: BilibiliAudioData) => {
            const trackInfo: TrackInfo = {
              identifier: `au${song.id}`,
              isSeekable: true,
              author: song.uname,
              length: song.duration * 1000,
              isStream: false,
              position: 0,
              title: song.title,
              uri: `https://www.bilibili.com/audio/au${song.id}`,
              artworkUrl: song.cover,
              isrc: null,
              sourceName: 'bilibili'
            }
            return {
              encoded: encodeTrack({ ...trackInfo, details: [] }),
              info: trackInfo,
              pluginInfo: { sid: song.id, type: 'audio' }
            }
          }
        )

        const infoResRaw = await makeRequest(
          `https://www.bilibili.com/audio/music-service-c/web/menu/info?sid=${id}`,
          {
            method: 'GET',
            headers: { ...HEADERS, Cookie: this.buildCookieHeader() },
            proxy: this.config.network.proxy
          }
        )

        const infoRes = infoResRaw.body as
          | BilibiliApiResponse<{ title: string }>
          | undefined

        return {
          loadType: 'playlist',
          data: {
            info: {
              name: infoRes?.data?.title || 'Bilibili Album',
              selectedTrack: 0
            },
            tracks,
            pluginInfo: {}
          }
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return { loadType: 'error', exception: { message, severity: 'fault' } }
      }
    }

    const pat3 = this.patterns[3]
    const liveMatch = pat3 ? url.match(pat3) : null
    if (liveMatch) {
      const id = liveMatch[1]
      if (!id) return { loadType: 'empty', data: {} }
      try {
        const res = await makeRequest(
          `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${id}`,
          {
            method: 'GET',
            headers: { ...HEADERS, Cookie: this.buildCookieHeader() },
            proxy: this.config.network.proxy
          }
        )

        const body = res.body as
          | BilibiliApiResponse<{
              room_id: number
              live_status: number
              title: string
              user_cover: string
            }>
          | undefined

        if (body?.code !== 0) throw new Error(`Live API Error: ${body?.msg}`)
        if (body.data?.live_status !== 1) throw new Error('Room is not live.')

        const data = body.data
        if (!data) throw new Error('No data returned from live API.')
        const trackInfo: TrackInfo = {
          identifier: `live${data.room_id}`,
          isSeekable: false,
          author: `Room ${data.room_id}`,
          length: 0,
          isStream: true,
          position: 0,
          title: data.title,
          uri: `https://live.bilibili.com/${data.room_id}`,
          artworkUrl: data.user_cover,
          isrc: null,
          sourceName: 'bilibili'
        }

        return {
          loadType: 'track',
          data: {
            encoded: encodeTrack({ ...trackInfo, details: [] }),
            info: trackInfo,
            pluginInfo: { room_id: data.room_id, type: 'live' }
          }
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return { loadType: 'error', exception: { message, severity: 'fault' } }
      }
    }

    const pat4 = this.patterns[4]
    const spaceMatch = pat4 ? url.match(pat4) : null
    if (spaceMatch) {
      const mid = spaceMatch[1]
      if (!mid) return { loadType: 'empty', data: {} }
      try {
        const mixinKey = await this._getWbiKeys()
        const queryParams = this._signWbi(
          { mid, ps: 30, tid: 0, keyword: '', order: 'pubdate' },
          mixinKey
        )

        const res = await makeRequest(
          `https://api.bilibili.com/x/space/wbi/arc/search?${queryParams}`,
          {
            method: 'GET',
            headers: { ...HEADERS, Cookie: this.buildCookieHeader() },
            proxy: this.config.network.proxy
          }
        )

        const body = res.body as
          | BilibiliApiResponse<{
              list: { vlist: Array<Record<string, unknown>> }
            }>
          | undefined

        if (body?.code !== 0)
          throw new Error(`Space API Error: ${body?.message}`)

        const list = body.data?.list?.vlist
        if (!list?.length) return { loadType: 'empty', data: {} }

        const tracks: TrackData[] = list.map((item) => {
          const durationParts = String(item.length || '0:0')
            .split(':')
            .map(Number)
          let durationMs = 0
          if (durationParts.length === 2) {
            durationMs =
              ((durationParts[0] || 0) * 60 + (durationParts[1] || 0)) * 1000
          } else if (durationParts.length === 3) {
            durationMs =
              ((durationParts[0] || 0) * 3600 +
                (durationParts[1] || 0) * 60 +
                (durationParts[2] || 0)) *
              1000
          }

          const bvid = String(item.bvid || '')
          const trackInfo: TrackInfo = {
            identifier: bvid,
            isSeekable: true,
            author: String(item.author || 'Unknown'),
            length: durationMs,
            isStream: false,
            position: 0,
            title: String(item.title || 'Unknown'),
            uri: `https://www.bilibili.com/video/${bvid}`,
            artworkUrl: String(item.pic || ''),
            isrc: null,
            sourceName: 'bilibili'
          }

          return {
            encoded: encodeTrack({ ...trackInfo, details: [] }),
            info: trackInfo,
            pluginInfo: { aid: item.aid, bvid: item.bvid, cid: 0 }
          }
        })

        const firstAuthor = String(list[0]?.author || 'Unknown')
        return {
          loadType: 'playlist',
          data: {
            info: { name: `Uploads by ${firstAuthor}`, selectedTrack: 0 },
            tracks,
            pluginInfo: {}
          }
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return { loadType: 'error', exception: { message, severity: 'fault' } }
      }
    }

    return { loadType: 'empty', data: {} }
  }

  /**
   * Resolves a playable stream URL for a Bilibili resource.
   * Handles Audio, Live, and Video types with dynamic signing.
   * @param track - Metadata of the track.
   * @returns A promise resolving to the playable stream result.
   * @public
   */
  public async getTrackUrl(track: TrackInfo): Promise<TrackUrlResult> {
    try {
      const pluginInfo = (track as unknown as Record<string, unknown>)
        .pluginInfo as Record<string, unknown> | undefined | undefined
      const isAudio =
        pluginInfo?.type === 'audio' || track.identifier.startsWith('au')
      const isLive =
        pluginInfo?.type === 'live' || track.identifier.startsWith('live')

      if (isAudio) {
        const sid = pluginInfo?.sid || track.identifier.replace('au', '')
        const res = await makeRequest(
          `https://www.bilibili.com/audio/music-service-c/web/url?sid=${sid}`,
          {
            method: 'GET',
            headers: { ...HEADERS, Cookie: this.buildCookieHeader() },
            proxy: this.config.network.proxy
          }
        )
        const body = res.body as
          | BilibiliApiResponse<{ cdns: string[] }>
          | undefined
        if (body?.code !== 0 || !body.data?.cdns?.[0]) {
          throw new Error('Failed to get audio stream.')
        }

        return {
          url: body.data.cdns[0] || '',
          protocol: 'https',
          format: 'mp3'
        }
      }

      if (isLive) {
        const roomId =
          pluginInfo?.room_id || track.identifier.replace('live', '')
        const res = await makeRequest(
          `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${roomId}&protocol=0,1&format=0,2&codec=0,1&qn=10000&platform=web&pt=web&no_playurl=0&mask=0`,
          {
            method: 'GET',
            headers: { ...HEADERS, Cookie: this.buildCookieHeader() },
            proxy: this.config.network.proxy
          }
        )

        const body = res.body as BilibiliApiResponse<unknown> | undefined

        if (
          body?.code !== 0 ||
          !(body.data as { playurl_info?: unknown })?.playurl_info
        ) {
          throw new Error('Failed to get live stream info.')
        }

        const playurlInfo = (
          body.data as {
            playurl_info: {
              playurl: {
                stream: Array<{
                  protocol_name: string
                  format: Array<{
                    format_name: string
                    codec: Array<{
                      base_url: string
                      url_info: Array<{ host: string; extra: string }>
                    }>
                  }>
                }>
              }
            }
          }
        ).playurl_info
        const streams = playurlInfo.playurl.stream
        let targetFormat: {
          base_url: string
          url_info: Array<{ host: string; extra: string }>
        } | null = null
        let formatType = 'flv'
        let protocol = 'http'

        for (const stream of streams) {
          if (stream.protocol_name === 'http_stream') {
            const fmt = stream.format.find((f) => f.format_name === 'flv')
            if (fmt?.codec?.[0]) {
              targetFormat = fmt.codec[0] ?? null
              formatType = 'flv'
              protocol = 'http'
              break
            }
          }
        }

        if (!targetFormat) {
          for (const stream of streams) {
            const fmt = stream.format[0]
            if (fmt?.codec?.[0]) {
              targetFormat = fmt.codec[0] ?? null
              formatType = fmt.format_name === 'ts' ? 'mpegts' : fmt.format_name
              protocol = stream.protocol_name === 'http_hls' ? 'hls' : 'http'
              break
            }
          }
        }

        if (targetFormat) {
          const urlInfo = targetFormat.url_info[0]
          if (urlInfo) {
            return {
              url: `${urlInfo.host}${targetFormat.base_url}${urlInfo.extra}`,
              protocol,
              format: formatType,
              additionalData: {
                headers: {
                  ...HEADERS,
                  Cookie: this.buildCookieHeader(),
                  Referer: `https://live.bilibili.com/${roomId}`
                }
              }
            }
          }
        }
        throw new Error('No supported stream format found.')
      }

      let cid = pluginInfo?.cid as number | undefined
      const bvid =
        (pluginInfo?.bvid as string | undefined) ||
        track.identifier.split('?')[0] ||
        ''

      if (!cid) {
        const res = await makeRequest(
          `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
          {
            method: 'GET',
            headers: { ...HEADERS, Cookie: this.buildCookieHeader() },
            proxy: this.config.network.proxy
          }
        )
        const body = res.body as
          | BilibiliApiResponse<BilibiliVideoData>
          | undefined
        if (body?.code !== 0 || !body.data) {
          throw new Error('Failed to fetch video metadata for stream.')
        }

        const pMatch = track.identifier.match(/\?p=(\d+)/)
        const pageIndex = pMatch ? Number.parseInt(pMatch[1] || '1', 10) : 1
        const page = body.data.pages?.find((p) => p.page === pageIndex)
        cid = page ? page.cid : body.data.cid
      }

      const mixinKey = await this._getWbiKeys()
      const queryParams = this._signWbi(
        { bvid, cid, qn: 120, fnval: 16 },
        mixinKey
      )

      const res = await makeRequest(
        `https://api.bilibili.com/x/player/wbi/playurl?${queryParams}`,
        {
          method: 'GET',
          headers: {
            ...HEADERS,
            Referer: 'https://www.bilibili.com/',
            Cookie: this.buildCookieHeader()
          },
          proxy: this.config.network.proxy
        }
      )

      const body = res.body as
        | BilibiliApiResponse<BilibiliPlayurlData>
        | undefined

      if (body?.code !== 0 || !body.data) {
        throw new Error(`Playurl API Error: ${body?.message}`)
      }

      const { durl, dash } = body.data
      let streamUrl: string | null = null
      let type = 'mp4'

      if (dash) {
        if (dash.audio?.[0]) {
          streamUrl =
            dash.audio[0].base_url || dash.audio[0].backup_url?.[0] || null
          type = 'm4a'
        } else if (dash.video?.[0]) {
          streamUrl =
            dash.video[0].base_url || dash.video[0].backup_url?.[0] || null
          type = 'mp4'
        }
      } else if (durl?.[0]) {
        streamUrl = durl[0].url
        type = 'mp4'
      }

      if (!streamUrl) throw new Error('No playable stream found.')

      return {
        url: streamUrl,
        protocol: 'https',
        format: type,
        additionalData: {
          headers: {
            ...HEADERS,
            Cookie: this.buildCookieHeader()
          }
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return { exception: { message, severity: 'fault' } }
    }
  }

  /**
   * Loads the audio/video stream from a Bilibili CDN URL.
   * @public
   */
  public async loadStream(
    decodedTrack: TrackInfo,
    url: string,
    protocol?: string,
    additionalData?: Record<string, unknown>
  ): Promise<TrackStreamResult> {
    try {
      let type =
        ((decodedTrack as unknown as Record<string, unknown>).format as
          | string
          | undefined) || 'mp4'
      if (url.includes('.m3u8')) type = 'mpegts'
      else if (url.includes('.flv')) type = 'flv'

      const headers = {
        ...HEADERS,
        ...(additionalData?.headers as Record<string, string>)
      }

      if (protocol === 'hls' || url.includes('.m3u8')) {
        return {
          stream: new HLSHandler(url, {
            headers: HEADERS,
            type: 'mpegts',
            localAddress: this.nodelink.routePlanner?.getIP?.() || undefined,
            startTime: (additionalData?.startTime as number) || 0,
            proxy: this.config.network.proxy
          }),
          type: 'mpegts'
        }
      }

      const res = await http1makeRequest(url, {
        method: 'GET',
        headers,
        streamOnly: true,
        proxy: this.config.network.proxy
      })

      if (res.error || !res.stream)
        throw new Error(res.error || 'Failed to get stream.')

      const stream = new PassThrough()
      const sourceStream = res.stream as Readable

      sourceStream.on('data', (chunk) => {
        if (!stream.write(chunk)) sourceStream.pause()
      })

      stream.on('drain', () => {
        if (!sourceStream.destroyed) sourceStream.resume()
      })

      sourceStream.on('end', () => {
        if (!stream.writableEnded) {
          stream.emit('finishBuffering')
          stream.end()
        }
      })

      sourceStream.on('error', (err) => {
        logger('error', 'Bilibili', `Upstream stream error: ${err.message}`)
        if (!stream.destroyed) {
          stream.emit('finishBuffering')
          stream.destroy(err)
        }
      })

      return { stream, type }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { exception: { message, severity: 'common' } }
    }
  }
}
