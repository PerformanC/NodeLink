import crypto from 'node:crypto'
import { PassThrough, type Readable } from 'node:stream'
import type {
  SourceInstance,
  SourceResult,
  TrackData,
  TrackInfo,
  TrackUrlResult,
  WorkerNodeLink
} from '../typings/sources/source.types.ts'
import type { SourceTestCase } from '../typings/sources/test.types.ts'
import type {
  ZingMp3ApiResponse,
  ZingMp3Config,
  ZingMp3DecodedTrack,
  ZingMp3LoadStreamResult,
  ZingMp3ParsedUrl,
  ZingMp3PlaylistData,
  ZingMp3SearchData,
  ZingMp3SongData,
  ZingMp3StreamingData
} from '../typings/sources/zingmp3.types.ts'
import type { BestMatchCandidate } from '../typings/utils.types.ts'
import {
  encodeTrack,
  getBestMatch,
  http1makeRequest,
  logger
} from '../utils.ts'

const DOMAIN = 'https://zingmp3.vn'
const API_KEY = 'X5BM3w8N7MKozC0B85o4KMlzLZKhV00y'
const SECRET_KEY = 'acOrvUS15XRW2o9JksiK1KgQ6Vbds8ZW'
const VERSION = '1.22.4'
const DEFAULT_VIETNAM_IP = '118.69.135.1'
const SESSION_CACHE_TTL = 30 * 60 * 1000
const WHITELIST_PARAMS = ['count', 'ctime', 'id', 'page', 'type', 'version']

/**
 * Zing MP3 source implementation for NodeLink.
 * @public
 */
export default class ZingMp3Source implements SourceInstance {
  /**
   * Declarative test suite for validating source behavior.
   * @public
   */
  public static readonly _TESTS: SourceTestCase[] = [
    {
      id: 'zingmp3.track.standard',
      name: 'Zing MP3 track resolution',
      input: {
        type: 'resolve',
        value: 'https://zingmp3.vn/bai-hat/Xa-Mai-Xa-Bao-Thy/ZWZB9WAB.html'
      },
      expect: {
        result: {
          type: 'track'
        },
        metadata: {
          author: { op: 'matches', value: 'Bảo Thy' },
          sourceName: { op: 'equals', value: 'zingmp3' }
        }
      },
      forbid: {
        resultTypes: ['empty', 'error']
      }
    },
    {
      id: 'zingmp3.album.standard',
      name: 'Zing MP3 album resolution',
      input: {
        type: 'resolve',
        value: 'https://zingmp3.vn/album/Special-Album-Bao-Thy/Dw7v1MMIRBSU.html'
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
      id: 'zingmp3.search.standard',
      name: 'Zing MP3 search queries (zmsearch)',
      input: {
        type: 'search',
        value: 'Bao Thy',
        searchType: 'zmsearch'
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
   * Zing MP3 source configuration.
   * @public
   */
  public readonly config?: ZingMp3Config

  /**
   * Search prefixes recognized for Zing MP3.
   * @public
   */
  public readonly searchTerms: string[] = ['zmsearch', 'zingsearch']

  /**
   * Alternate names for source routing.
   * @public
   */
  public readonly additionalsSourceName: string[] = ['zingmp3', 'zing']

  /**
   * URL patterns for identifying Zing MP3 links.
   * @public
   */
  public readonly patterns: RegExp[] = [
    /^https?:\/\/(?:mp3\.zing|zingmp3)\.vn\/(bai-hat|video-clip|embed)\/[^/?#]+\/(\w+)(?:\.html|\?|$)/i,
    /^https?:\/\/(?:mp3\.zing|zingmp3)\.vn\/(album|playlist)\/[^/?#]+\/(\w+)(?:\.html|\?|$)/i
  ]

  /**
   * Priority score for source selection.
   * @public
   */
  public readonly priority: number = 65

  /**
   * Cached session cookie header.
   * @internal
   */
  private cachedCookieHeader: string = ''

  /**
   * Timestamp when the cookie cache was last refreshed.
   * @internal
   */
  private cookieCachedAt: number = 0

  /**
   * Configured or fallback Vietnam IPv4 address used for bypassing geo-restrictions.
   * @internal
   */
  private readonly vietnamIp: string

  /**
   * Initializes a new Zing MP3 source instance.
   * @param nodelink - NodeLink worker context.
   */
  public constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
    this.config = nodelink.options.sources?.zingmp3 as ZingMp3Config | undefined
    this.vietnamIp = this.config?.vietnamIp || DEFAULT_VIETNAM_IP
  }

  /**
   * Initializes the Zing MP3 source and warms the session cache.
   * @returns Promise resolving to true.
   * @public
   */
  public async setup(): Promise<boolean> {
    try {
      await this.ensureSession()
      logger('info', 'ZingMp3', 'Zing MP3 source initialized.')
      return true
    } catch (error) {
      logger(
        'warn',
        'ZingMp3',
        `Initialization warning: ${error instanceof Error ? error.message : String(error)}`
      )
      return true
    }
  }

  /**
   * Resolves search queries for Zing MP3 tracks.
   * @param query - Search term without prefix.
   * @returns Search results payload.
   * @public
   */
  public async search(query: string): Promise<SourceResult> {
    try {
      const response = await this.callApi<ZingMp3SearchData>(
        '/api/v2/search/multi',
        { q: query }
      )

      const songs = response?.data?.songs
      if (!songs || !Array.isArray(songs) || songs.length === 0) {
        return {
          loadType: 'empty',
          data: {}
        }
      }

      const tracks: TrackData[] = []
      for (const song of songs) {
        if (!song.encodeId || !song.title) continue
        tracks.push(this.buildTrack(song))
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
    } catch (error) {
      logger(
        'error',
        'ZingMp3',
        `Search failed for "${query}": ${error instanceof Error ? error.message : String(error)}`
      )
      return {
        loadType: 'error',
        exception: {
          message:
            error instanceof Error ? error.message : 'Zing MP3 search error',
          severity: 'common'
        }
      }
    }
  }

  /**
   * Resolves a Zing MP3 song or album URL.
   * @param url - Zing MP3 URL to resolve.
   * @returns Source result payload.
   * @public
   */
  public async resolve(url: string): Promise<SourceResult> {
    try {
      const parsed = this.parseUrl(url)
      if (!parsed) {
        return {
          loadType: 'empty',
          data: {}
        }
      }

      if (parsed.type === 'song' || parsed.type === 'video') {
        return await this.resolveSong(parsed.id)
      }

      if (parsed.type === 'album' || parsed.type === 'playlist') {
        return await this.resolvePlaylist(parsed.id)
      }

      return {
        loadType: 'empty',
        data: {}
      }
    } catch (error) {
      logger(
        'error',
        'ZingMp3',
        `Failed to resolve "${url}": ${error instanceof Error ? error.message : String(error)}`
      )
      return {
        loadType: 'error',
        exception: {
          message:
            error instanceof Error ? error.message : 'Zing MP3 resolution error',
          severity: 'common'
        }
      }
    }
  }

  /**
   * Resolves the streamable URL for a Zing MP3 track.
   * @param track - Decoded track information.
   * @returns URL result payload or fallback.
   * @public
   */
  public async getTrackUrl(
    track: ZingMp3DecodedTrack
  ): Promise<TrackUrlResult> {
    try {
      const response = await this.callApi<ZingMp3StreamingData>(
        '/api/v2/song/get/streaming',
        { id: track.identifier }
      )

      const streamUrl = response?.data?.['128']
      if (
        streamUrl &&
        typeof streamUrl === 'string' &&
        streamUrl !== 'VIP' &&
        streamUrl.startsWith('http')
      ) {
        return {
          url: streamUrl,
          protocol: 'http',
          format: 'mp3'
        }
      }

      logger(
        'debug',
        'ZingMp3',
        `Direct stream unavailable for ${track.identifier} (${response?.msg || 'VIP'}), attempting fallback.`
      )
      return await this.resolveFallback(track)
    } catch (error) {
      logger(
        'error',
        'ZingMp3',
        `Stream resolution failed for ${track.identifier}: ${error instanceof Error ? error.message : String(error)}`
      )
      return await this.resolveFallback(track)
    }
  }

  /**
   * Loads and proxies an audio stream from Zing MP3's CDN.
   * @param _track - Decoded track information.
   * @param url - Audio stream URL.
   * @returns Streaming result with PassThrough.
   * @public
   */
  public async loadStream(
    _track: TrackInfo,
    url: string
  ): Promise<ZingMp3LoadStreamResult> {
    const res = await http1makeRequest(url, {
      method: 'GET',
      streamOnly: true,
      proxy: this.config?.proxy
    })

    if (res.error || !res.stream || (res.statusCode && res.statusCode >= 400)) {
      return {
        exception: {
          message: res.error || `HTTP error ${res.statusCode} loading audio stream`,
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
      logger('error', 'ZingMp3', `Underlying stream error: ${err.message}`)
      if (!passthrough.destroyed) passthrough.destroy(err)
    })

    return {
      stream: passthrough,
      type: 'audio/mpeg'
    }
  }

  /**
   * Resolves a single song by encodeId.
   * @internal
   */
  private async resolveSong(id: string): Promise<SourceResult> {
    const response = await this.callApi<ZingMp3SongData>(
      '/api/v2/page/get/song',
      { id }
    )

    const song = response?.data
    if (!song || !song.encodeId || !song.title) {
      return {
        loadType: 'empty',
        data: {}
      }
    }

    return {
      loadType: 'track',
      data: this.buildTrack(song)
    }
  }

  /**
   * Resolves a playlist or album by encodeId.
   * @internal
   */
  private async resolvePlaylist(id: string): Promise<SourceResult> {
    const response = await this.callApi<ZingMp3PlaylistData>(
      '/api/v2/page/get/playlist',
      { id }
    )

    const playlist = response?.data
    const songItems = playlist?.song?.items
    if (!playlist || !songItems || !Array.isArray(songItems) || songItems.length === 0) {
      return {
        loadType: 'empty',
        data: {}
      }
    }

    const tracks: TrackData[] = []
    for (const song of songItems) {
      if (!song.encodeId || !song.title) continue
      tracks.push(this.buildTrack(song))
    }

    if (tracks.length === 0) {
      return {
        loadType: 'empty',
        data: {}
      }
    }

    return {
      loadType: 'playlist',
      data: {
        info: {
          name: playlist.title || 'Zing MP3 Playlist',
          selectedTrack: 0
        },
        pluginInfo: {},
        tracks
      }
    }
  }

  /**
   * Converts a Zing MP3 song object to standard NodeLink TrackData.
   * @internal
   */
  private buildTrack(song: ZingMp3SongData): TrackData {
    const uri = song.link
      ? (song.link.startsWith('http') ? song.link : `${DOMAIN}${song.link}`)
      : `${DOMAIN}/bai-hat/${song.encodeId}.html`

    const trackInfo: TrackInfo = {
      identifier: song.encodeId,
      isSeekable: true,
      author: song.artistsNames || 'Unknown Artist',
      length: (song.duration || 0) * 1000,
      isStream: false,
      position: 0,
      title: song.title,
      uri,
      artworkUrl: song.thumbnailM || song.thumbnail || null,
      isrc: null,
      sourceName: 'zingmp3'
    }

    return {
      encoded: encodeTrack({ ...trackInfo, details: [] }),
      info: trackInfo,
      pluginInfo: {}
    }
  }

  /**
   * Resolves an alternative stream for VIP or geoblocked tracks.
   * @internal
   */
  private async resolveFallback(
    track: ZingMp3DecodedTrack
  ): Promise<TrackUrlResult> {
    if (!this.nodelink.sources?.search) {
      return {
        exception: {
          message: 'Song is VIP only and fallback is unavailable.',
          severity: 'common'
        }
      }
    }

    const query = `${track.title} ${track.author}`
    const searchResult = await this.nodelink.sources.search(query, 'ytsearch')
    if (searchResult.loadType !== 'search' || !Array.isArray(searchResult.data)) {
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
      if (info && info.title && info.author) {
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
   * Parses entity type and ID from a given Zing MP3 URL.
   * @internal
   */
  private parseUrl(url: string): ZingMp3ParsedUrl | null {
    for (const pattern of this.patterns) {
      const match = pattern.exec(url)
      if (match && match[1] && match[2]) {
        const rawType = match[1].toLowerCase()
        const id = match[2]

        let type: ZingMp3ParsedUrl['type'] = 'song'
        if (rawType === 'album') type = 'album'
        else if (rawType === 'playlist') type = 'playlist'
        else if (rawType === 'video-clip') type = 'video'

        return { type, id }
      }
    }
    return null
  }

  /**
   * Calls a Zing MP3 API endpoint with cryptographic signature and session cookies.
   * @internal
   */
  private async callApi<T>(
    slug: string,
    params: Record<string, string | number>
  ): Promise<ZingMp3ApiResponse<T> | null> {
    const cookieHeader = await this.ensureSession()
    const url = this.buildApiUrl(slug, params)

    const res = await http1makeRequest(url, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        Referer: DOMAIN,
        Cookie: cookieHeader,
        'X-Forwarded-For': this.vietnamIp
      },
      proxy: this.config?.proxy
    })

    const body =
      typeof res.body === 'string'
        ? (JSON.parse(res.body) as ZingMp3ApiResponse<T>)
        : (res.body as ZingMp3ApiResponse<T>)

    // If server reports session or permission error, reset session and retry once
    if (body && (body.err === -403 || body.err === -201)) {
      this.cachedCookieHeader = ''
      this.cookieCachedAt = 0
      const refreshedCookie = await this.ensureSession()

      const retryRes = await http1makeRequest(url, {
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          Referer: DOMAIN,
          Cookie: refreshedCookie,
          'X-Forwarded-For': this.vietnamIp
        },
        proxy: this.config?.proxy
      })

      return typeof retryRes.body === 'string'
        ? (JSON.parse(retryRes.body) as ZingMp3ApiResponse<T>)
        : (retryRes.body as ZingMp3ApiResponse<T>)
    }

    return body
  }

  /**
   * Builds an authenticated and signed Zing MP3 API URL.
   * @internal
   */
  private buildApiUrl(
    slug: string,
    params: Record<string, string | number>
  ): string {
    const fullParams: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(params).map(([k, v]) => [k, String(v)])
      ),
      ctime: Math.round(Date.now() / 1000).toString(),
      version: VERSION
    }

    const sig = this.buildSignature(slug, fullParams)
    fullParams.sig = sig
    fullParams.apiKey = API_KEY

    return `${DOMAIN}${slug}?${new URLSearchParams(fullParams).toString()}`
  }

  /**
   * Computes the HMAC-SHA512 signature for whitelisted query parameters.
   * @internal
   */
  private buildSignature(
    slug: string,
    params: Record<string, string>
  ): string {
    const sortedKeys = Object.keys(params).sort()
    const hashParams: Record<string, string> = {}

    for (const key of sortedKeys) {
      if (
        WHITELIST_PARAMS.includes(key) &&
        params[key] !== null &&
        params[key] !== undefined &&
        params[key] !== ''
      ) {
        hashParams[key] = params[key]
      }
    }

    const paramStr = Object.keys(hashParams)
      .map(
        (key) =>
          `${encodeURIComponent(key)}=${encodeURIComponent(hashParams[key] ?? '')}`
      )
      .join('')

    const sha256 = crypto.createHash('sha256').update(paramStr).digest('hex')
    return crypto
      .createHmac('sha512', SECRET_KEY)
      .update(`${slug}${sha256}`)
      .digest('hex')
  }

  /**
   * Ensures an active session cookie exists, fetching from homepage if needed.
   * @internal
   */
  private async ensureSession(): Promise<string> {
    const now = Date.now()
    if (this.cachedCookieHeader && now - this.cookieCachedAt < SESSION_CACHE_TTL) {
      return this.cachedCookieHeader
    }

    const res = await http1makeRequest(DOMAIN, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'X-Forwarded-For': this.vietnamIp
      },
      proxy: this.config?.proxy
    })

    const setCookies = res.headers?.['set-cookie']
    if (Array.isArray(setCookies)) {
      this.cachedCookieHeader = setCookies.map((c) => c.split(';')[0]).join('; ')
    } else if (typeof setCookies === 'string') {
      this.cachedCookieHeader = setCookies.split(';')[0] ?? ''
    } else {
      this.cachedCookieHeader = `zmp3_app_version.1=1224; zmp3_rqid=MHwxMTgdUngNjkdUngMTM1LjF8djEdUngMjIdUngNHwxNzk0MTAzNTmUsIC2MjQw`
    }

    this.cookieCachedAt = now
    return this.cachedCookieHeader
  }
}
