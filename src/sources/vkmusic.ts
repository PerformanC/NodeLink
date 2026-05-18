import type { Readable } from 'node:stream'
import HLSHandler from '../playback/hls/HLSHandler.ts'
import type { VKMusicSourceConfig } from '../typings/config/config.types.ts'
import type {
  SourceInstance,
  SourceResult,
  TrackData,
  TrackInfo,
  TrackStreamResult,
  TrackUrlResult,
  WorkerNodeLink
} from '../typings/sources/source.types.ts'
import type {
  VKApiResponse,
  VKAudioList,
  VKAudioNode,
  VKTokenData,
  VKUserNode
} from '../typings/sources/vkmusic.types.ts'
import {
  encodeTrack,
  getBestMatch,
  http1makeRequest,
  logger,
  makeRequest
} from '../utils.ts'

/**
 * Base URL for the VK API.
 * @internal
 */
const API_BASE = 'https://api.vk.com/method/'

/**
 * VK API version used for all requests.
 * @internal
 */
const API_VERSION = '5.131'

/**
 * Base64 alphabet used by VK for URL masking.
 * @internal
 */
const BASE64_CHARS =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN0PQRSTUVWXYZO123456789+/='

/**
 * User agent string for VK internal requests.
 * @internal
 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:146.0) Gecko/20100101 Firefox/146.0'

/**
 * VK Music source implementation.
 * Integrates with the VK API and web scraping for track resolution and search.
 * Supports HLS and direct MP3 streams.
 * @public
 */
export default class VKMusicSource implements SourceInstance {
  /**
   * The NodeLink worker context.
   * @internal
   */
  private readonly nodelink: WorkerNodeLink

  /**
   * VK Music specific configuration.
   * @internal
   */
  private readonly config: VKMusicSourceConfig

  /**
   * Search term prefixes recognized by this source.
   * @public
   */
  public readonly searchTerms = ['vksearch']

  /**
   * Prefix for recommendation requests.
   * @public
   */
  public readonly recommendationTerm = ['vkrec']

  /**
   * Regular expression patterns for identifying VK URLs.
   * Matches playlists, albums, tracks, artists, and user audios.
   * @public
   */
  public readonly patterns = [
    /vk\.(?:com|ru)\/.*?[?&]z=audio_playlist(?<owner>-?\d+)_(?<id>\d+)(?:(?:%2F|_|\/|(?:\?|&)access_hash=)(?<hash>[a-z0-9]+))?/i,
    /vk\.(?:com|ru)\/(?:music\/(?:playlist|album)\/)(?<owner>-?\d+)_(?<id>\d+)(?:(?:%2F|_|\/|(?:\?|&)access_hash=)(?<hash>[a-z0-9]+))?/i,
    /vk\.(?:com|ru)\/audio(?<owner>-?\d+)_(?<id>\d+)(?:(?:%2F|_|\/)(?<hash>[a-z0-9]+))?/i,
    /vk\.(?:com|ru)\/artist\/(?<id>[^/?#\s&]+)/i,
    /vk\.(?:com|ru)\/audios(?<id>-?\d+)/i
  ]

  /**
   * Priority score for source selection.
   * @public
   */
  public readonly priority = 80

  /**
   * Current user's identifier.
   * @internal
   */
  private userId = 0

  /**
   * Whether a valid token is available for the API.
   * @internal
   */
  private hasToken = false

  /**
   * Access token for the VK API.
   * @internal
   */
  private accessToken: string | null = null

  /**
   * Token expiration timestamp (Unix MS).
   * @internal
   */
  private tokenExpiry = 0

  /**
   * User cookie for authenticated scraping and token refresh.
   * @internal
   */
  private cookie: string

  /**
   * Constructs a new VKMusicSource instance.
   * @param nodelink - The worker context.
   */
  constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
    this.config = (nodelink.options.sources?.vkmusic || {
      enabled: false,
      userToken: '',
      userCookie: ''
    }) as VKMusicSourceConfig
    this.accessToken = this.config.userToken || null
    this.cookie = this.config.userCookie || ''
  }

  /**
   * Performs source-level initialization.
   * Loads cached tokens or performs authentication if credentials are provided.
   * @returns A promise resolving to true if initialization succeeded.
   * @public
   */
  public async setup(): Promise<boolean> {
    const cm = this.nodelink.credentialManager
    if (!cm) return false

    const cachedToken = cm.get<string>('vk_access_token')
    if (cachedToken) {
      this.accessToken = cachedToken
      this.hasToken = true
      logger('info', 'VKMusic', 'Using cached VK access token.')
      return true
    }

    if (this.accessToken || this.cookie) {
      try {
        if (!this.accessToken && this.cookie) {
          await this._refreshAccessToken()
        }

        const response = await this._apiRequest<VKUserNode[]>('users.get', {})
        if (response?.[0]) {
          this.userId = response[0].id
          this.hasToken = true
          logger(
            'info',
            'VKMusic',
            `Logged into VK as: ${response[0].first_name} (${this.userId})`
          )
          return true
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        logger(
          'warn',
          'VKMusic',
          `Initial VK authentication failed: ${message}`
        )
      }
    }
    return true
  }

  /**
   * Refreshes the VK access token using the provided user cookie.
   * @returns A promise resolving to the new access token.
   * @internal
   */
  private async _refreshAccessToken(): Promise<string> {
    if (!this.cookie)
      throw new Error('No VK cookie provided for token refresh.')
    logger('debug', 'VKMusic', 'Refreshing VK access token...')

    const res = await http1makeRequest('https://login.vk.ru/?act=web_token', {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        Referer: 'https://vk.ru/',
        Origin: 'https://vk.ru',
        Cookie: this.cookie,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'version=1&app_id=6287487',
      disableBodyCompression: true,
      localAddress: this.nodelink.routePlanner?.getIP?.() || undefined,
      proxy: this.config.network.proxy
    })

    const body = res.body as {
      type: string
      data?: VKTokenData
      error_info?: string
    }

    if (
      res.error ||
      res.statusCode !== 200 ||
      body.type !== 'okay' ||
      !body.data
    ) {
      const info = body?.error_info || String(res.statusCode)
      logger('error', 'VKMusic', `VK token refresh failed: ${info}`)
      throw new Error(`VK token refresh failed: ${info}`)
    }

    this.accessToken = body.data.access_token
    this.tokenExpiry = body.data.expires * 1000
    this.userId = body.data.user_id
    this.hasToken = true

    if (this.nodelink.credentialManager) {
      this.nodelink.credentialManager.set(
        'vk_access_token',
        this.accessToken,
        this.tokenExpiry - Date.now()
      )
    }

    logger('info', 'VKMusic', 'VK access token refreshed successfully.')
    return this.accessToken
  }

  /**
   * Executes a catalog search on VK Music.
   * @param query - The search query.
   * @param sourceTerm - The prefix used.
   * @returns A promise resolving to the search result payload.
   * @public
   */
  public async search(
    query: string,
    sourceTerm?: string
  ): Promise<SourceResult> {
    if (sourceTerm && this.recommendationTerm.includes(sourceTerm)) {
      return this.getRecommendations(query)
    }

    if (!this.hasToken && this.cookie) await this._refreshAccessToken()
    if (!this.hasToken) {
      return {
        loadType: 'error',
        exception: {
          message: 'VK authentication required.',
          severity: 'common'
        }
      }
    }

    try {
      const res = await this._apiRequest<VKAudioList>('audio.search', {
        q: query,
        count: String(
          (this.nodelink.options.search.maxResults as number) || 10
        ),
        extended: '1'
      })

      if (!res?.items?.length) return { loadType: 'empty', data: {} }

      return {
        loadType: 'search',
        data: res.items.map((item) => this.buildTrack(item))
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger('error', 'VKMusic', `Search failed: ${message}`)
      return { loadType: 'error', exception: { message, severity: 'fault' } }
    }
  }

  /**
   * Fetches track recommendations based on a seed.
   * @param query - Seed track identifier or search string.
   * @returns A promise resolving to the resolution result.
   * @public
   */
  public async getRecommendations(query: string): Promise<SourceResult> {
    if (!this.hasToken && this.cookie) await this._refreshAccessToken()

    let audioId = query
    if (!/^-?\d+_\d+$/.test(query)) {
      const searchRes = await this.search(query, 'vksearch')
      if (searchRes.loadType === 'search' && searchRes.data.length > 0) {
        audioId = searchRes.data[0]?.info.identifier || query
      } else {
        return { loadType: 'empty', data: {} }
      }
    }

    try {
      const res = await this._apiRequest<VKAudioList>(
        'audio.getRecommendations',
        {
          target_audio: audioId,
          count: '20',
          extended: '1'
        }
      )

      if (!res?.items?.length) return { loadType: 'empty', data: {} }

      return {
        loadType: 'playlist',
        data: {
          info: { name: 'VK Recommendations', selectedTrack: 0 },
          tracks: res.items.map((item) => this.buildTrack(item)),
          pluginInfo: {}
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger('error', 'VKMusic', `Recommendations failed: ${message}`)
      return { loadType: 'error', exception: { message, severity: 'fault' } }
    }
  }

  /**
   * Resolves a VK URL into a track or collection.
   * @param url - The absolute VK URL.
   * @returns A promise resolving to the resolution result.
   * @public
   */
  public async resolve(url: string): Promise<SourceResult> {
    // 1. Playlist/Album check
    const pattern0 = this.patterns[0]
    const pattern1 = this.patterns[1]
    const playlistMatch =
      (pattern0 ? url.match(pattern0) : null) ||
      (pattern1 ? url.match(pattern1) : null)
    if (playlistMatch?.groups) {
      const owner = playlistMatch.groups.owner
      const id = playlistMatch.groups.id
      if (owner && id) {
        return await this._resolvePlaylist(
          owner,
          id,
          playlistMatch.groups.hash || null,
          url
        )
      }
    }

    // 2. Single track check
    const pattern2 = this.patterns[2]
    const trackMatch = pattern2 ? url.match(pattern2) : null
    if (trackMatch) return await this._resolveTrack(url, trackMatch)

    // 3. User audios check
    const pattern4 = this.patterns[4]
    const audiosMatch = pattern4 ? url.match(pattern4) : null
    if (audiosMatch?.groups) {
      const id = audiosMatch.groups.id
      if (id) {
        return await this._resolvePlaylist(id, null, null, url)
      }
    }

    return { loadType: 'empty', data: {} }
  }

  /**
   * Resolves a playlist collection via API or scraping fallback.
   * @internal
   */
  private async _resolvePlaylist(
    ownerId: string,
    playlistId: string | null,
    accessKey: string | null,
    url: string
  ): Promise<SourceResult> {
    if (!this.hasToken && this.cookie) await this._refreshAccessToken()
    if (this.hasToken) {
      try {
        const params: Record<string, string> = {
          owner_id: ownerId,
          extended: '1',
          count: String(
            (this.nodelink.options.playback.maxPlaylistLength as number) || 100
          )
        }
        if (playlistId) params.album_id = playlistId
        if (accessKey) params.access_key = accessKey

        const res = await this._apiRequest<VKAudioList>('audio.get', params)
        if (res?.items?.length) {
          return {
            loadType: 'playlist',
            data: {
              info: { name: 'VK Playlist', selectedTrack: 0 },
              tracks: res.items.map((item) => this.buildTrack(item)),
              pluginInfo: {}
            }
          }
        }
      } catch (e) {
        logger(
          'debug',
          'VKMusic',
          `API playlist resolution failed: ${e instanceof Error ? e.message : String(e)}`
        )
      }
    }
    return this._scrapePlaylist(url)
  }

  /**
   * Scrapes track metadata from a VK web page.
   * @internal
   */
  private async _scrapePlaylist(url: string): Promise<SourceResult> {
    try {
      const res = await http1makeRequest(url, {
        headers: { 'User-Agent': USER_AGENT, Cookie: this.cookie },
        proxy: this.config.network.proxy
      })

      if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`)

      const body =
        typeof res.body === 'string' ? res.body : JSON.stringify(res.body)
      const dataAudioMatch = body.match(/data-audio="([^"]+)"/g)

      if (dataAudioMatch) {
        const tracks = dataAudioMatch
          .map((m) => {
            const innerMatch = m.match(/"([^"]+)"/)
            if (!innerMatch?.[1]) return null
            const raw = innerMatch[1].replace(/&quot;/g, '"')
            return this._parseMeta(JSON.parse(raw) as unknown[])
          })
          .filter((t): t is TrackData => t !== null)

        return {
          loadType: 'playlist',
          data: {
            info: { name: 'VK Scraped Playlist', selectedTrack: 0 },
            tracks,
            pluginInfo: {}
          }
        }
      }
      throw new Error('No track data blocks found in page.')
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger('error', 'VKMusic', `Scraping failed: ${message}`)
      return {
        loadType: 'error',
        exception: { message: `Scraping failed: ${message}`, severity: 'fault' }
      }
    }
  }

  /**
   * Resolves a single track via API or scraping fallback.
   * @internal
   */
  private async _resolveTrack(
    url: string,
    trackMatch: RegExpMatchArray
  ): Promise<SourceResult> {
    if (!this.hasToken && this.cookie) await this._refreshAccessToken()
    if (this.hasToken && trackMatch.groups) {
      try {
        const { owner, id, hash } = trackMatch.groups
        const audios = `${owner}_${id}${hash ? `_${hash}` : ''}`

        const res = await this._apiRequest<VKAudioNode[]>('audio.getById', {
          audios,
          extended: '1'
        })

        if (res?.[0]) {
          let track = this.buildTrack(res[0])
          // Self-healing if artwork or direct URL is missing
          if (!track.info.artworkUrl || !res[0].url) {
            const searchRes = await this.search(
              `${res[0].artist} ${res[0].title}`,
              'vksearch'
            )
            if (searchRes.loadType === 'search' && searchRes.data.length > 0) {
              const healed =
                searchRes.data.find((t) => t.info.artworkUrl) ||
                searchRes.data[0]
              if (healed) track = healed
            }
          }
          return { loadType: 'track', data: track }
        }
      } catch (e) {
        logger(
          'debug',
          'VKMusic',
          `API track resolution failed: ${e instanceof Error ? e.message : String(e)}`
        )
      }
    }
    return this._scrapeTrack(url)
  }

  /**
   * Scrapes a single track's metadata from its VK page.
   * @internal
   */
  private async _scrapeTrack(url: string): Promise<SourceResult> {
    try {
      const res = await http1makeRequest(url, {
        headers: { 'User-Agent': USER_AGENT, Cookie: this.cookie },
        proxy: this.config.network.proxy
      })

      if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`)

      const body =
        typeof res.body === 'string' ? res.body : JSON.stringify(res.body)
      const dataAudioMatch = body.match(/data-audio="([^"]+)"/)

      if (dataAudioMatch?.[1]) {
        const data = JSON.parse(
          dataAudioMatch[1].replace(/&quot;/g, '"')
        ) as unknown[]
        let track = this._parseMeta(data)

        if (track && !track.info.artworkUrl && this.hasToken) {
          const searchRes = await this.search(
            `${track.info.author} ${track.info.title}`,
            'vksearch'
          )
          if (searchRes.loadType === 'search' && searchRes.data.length > 0) {
            const healed =
              searchRes.data.find((t) => t.info.artworkUrl) || searchRes.data[0]
            if (healed) track = healed
          }
        }
        return track
          ? { loadType: 'track', data: track }
          : { loadType: 'empty', data: {} }
      }
      throw new Error('Track data block not found.')
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger('error', 'VKMusic', `Scraping failed: ${message}`)
      return {
        loadType: 'error',
        exception: { message: `Scraping failed: ${message}`, severity: 'fault' }
      }
    }
  }

  /**
   * Parses raw metadata array from scraped VK HTML into TrackData.
   * @internal
   */
  private _parseMeta(data: unknown[]): TrackData | null {
    if (!Array.isArray(data) || data.length < 6) return null
    const id = `${data[1]}_${data[0]}`
    let rawUrl = data[2] as string
    if (rawUrl?.includes('audio_api_unavailable')) {
      rawUrl = this._unmask_url(rawUrl, this.userId) || ''
    }

    const artworkRaw = data[14] as string | undefined
    const artworkUrl = artworkRaw ? artworkRaw.split(',')[0] || null : null
    const trackInfo: TrackInfo = {
      identifier: id,
      isSeekable: true,
      author: String(data[4] || 'Unknown Artist'),
      length: Number(data[5] || 0) * 1000,
      isStream: false,
      position: 0,
      title: String(data[3] || 'Unknown Title'),
      uri: `https://vk.com/audio${id}`,
      artworkUrl,
      isrc: null,
      sourceName: 'vkmusic'
    }

    return {
      encoded: encodeTrack({
        ...trackInfo,
        details: [(data[25] as string) || null]
      }),
      info: trackInfo,
      pluginInfo: {}
    }
  }

  /**
   * Maps a VK API audio node into NodeLink's standard TrackData format.
   * @param item - Raw audio node from API.
   * @returns Built TrackData.
   * @public
   */
  public buildTrack(item: VKAudioNode): TrackData {
    const id = `${item.owner_id}_${item.id}`
    const thumb = item.album?.thumb || item.album?.images?.[0]
    let artworkUrl: string | null = null
    if (thumb) {
      artworkUrl =
        (thumb as Record<string, string>).photo_1200 ||
        (thumb as Record<string, string>).photo_600 ||
        (thumb as Record<string, string>).photo_300 ||
        (thumb as Record<string, string>).url ||
        null
    }

    const trackInfo: TrackInfo = {
      identifier: id,
      isSeekable: true,
      author: item.artist,
      length: item.duration * 1000,
      isStream: false,
      position: 0,
      title: item.title,
      uri: `https://vk.com/audio${id}`,
      artworkUrl,
      isrc: item.external_ids?.isrc || null,
      sourceName: 'vkmusic'
    }

    return {
      encoded: encodeTrack({
        ...trackInfo,
        details: [item.access_key || null]
      }),
      info: trackInfo,
      pluginInfo: {}
    }
  }

  /**
   * Resolves a playable URL for a VK track.
   * Prefers API-based resolution but falls back to catalog matching if needed.
   *
   * @param decodedTrack - Metadata of the track.
   * @param _itag - Optional quality tag.
   * @param forceRefresh - Whether to bypass the cache.
   * @returns A promise resolving to the playable stream result.
   * @public
   */
  public async getTrackUrl(
    decodedTrack: TrackInfo,
    _itag?: number,
    forceRefresh = false
  ): Promise<TrackUrlResult> {
    if (!forceRefresh && this.nodelink.trackCacheManager) {
      const cached = this.nodelink.trackCacheManager.get(
        'vkmusic',
        decodedTrack.identifier
      ) as TrackUrlResult
      if (cached) return cached
    }

    const id = decodedTrack.identifier
    const accessKey = (decodedTrack as TrackInfo & { details?: string[] })
      .details?.[0]
    logger('debug', 'VKMusic', `Resolving VK stream for: ${id}`)

    let url: string | null = null
    if (!this.hasToken && this.cookie) await this._refreshAccessToken()

    if (this.hasToken) {
      try {
        const audios = accessKey ? `${id}_${accessKey}` : id
        const res = await this._apiRequest<VKAudioNode[]>('audio.getById', {
          audios
        })
        if (res?.[0]?.url) {
          url = res[0].url.includes('audio_api_unavailable')
            ? this._unmask_url(res[0].url, this.userId)
            : res[0].url
        }
      } catch (e) {
        logger(
          'debug',
          'VKMusic',
          `Stream API resolution failed: ${e instanceof Error ? e.message : String(e)}`
        )
      }

      if (!url) {
        try {
          const res = await this._apiRequest<VKAudioList>('audio.search', {
            q: `${decodedTrack.author} ${decodedTrack.title}`,
            count: '10'
          })
          const match =
            res?.items?.find((i) => `${i.owner_id}_${i.id}` === id) ||
            res?.items?.[0]
          if (match?.url) {
            url = match.url.includes('audio_api_unavailable')
              ? this._unmask_url(match.url, this.userId)
              : match.url
          }
        } catch {}
      }
    }

    if (url && (url.startsWith('http') || url.includes('.m3u8'))) {
      const result: TrackUrlResult = {
        url,
        protocol: url.includes('.m3u8') ? 'hls' : 'https',
        format: url.includes('.m3u8') ? 'mpegts' : 'mp3'
      }

      if (this.nodelink.trackCacheManager) {
        this.nodelink.trackCacheManager.set(
          'vkmusic',
          decodedTrack.identifier,
          result,
          1000 * 60 * 60 * 2
        )
      }
      return result
    }

    // Delegation fallback
    const sm = this.nodelink.sources
    if (sm) {
      const searchRes = await sm.searchWithDefault(
        `${decodedTrack.title} ${decodedTrack.author}`
      )
      if (searchRes.loadType === 'search' && searchRes.data.length > 0) {
        const best = getBestMatch(searchRes.data, decodedTrack, {
          allowExplicit: true
        })
        if (best) {
          const mirrored = await sm.getTrackUrl(best.info as TrackInfo)
          return {
            newTrack: { info: best.info as TrackInfo },
            ...mirrored
          }
        }
      }
    }

    return { exception: { message: 'VK stream not found.', severity: 'fault' } }
  }

  /**
   * Finalizes stream loading using HLSHandler or direct pass-through.
   * @public
   */
  public async loadStream(
    _track: TrackInfo,
    url: string,
    protocol?: string,
    additionalData?: Record<string, unknown>
  ): Promise<TrackStreamResult> {
    const headers = {
      'User-Agent': USER_AGENT,
      Cookie: this.cookie,
      Referer: 'https://vk.com/',
      Origin: 'https://vk.com'
    }

    if (protocol === 'hls') {
      return {
        stream: new HLSHandler(url, {
          headers,
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
      streamOnly: true,
      headers,
      proxy: this.config.network.proxy
    })

    if (res.error || !res.stream)
      throw new Error(res.error || 'Failed to fetch direct stream.')

    return { stream: res.stream as Readable, type: 'mp3' }
  }

  /**
   * Authenticated API request helper.
   * @internal
   */
  private async _apiRequest<T>(
    method: string,
    params: Record<string, string>
  ): Promise<T | null> {
    if (
      this.cookie &&
      (!this.accessToken ||
        (this.tokenExpiry && Date.now() >= this.tokenExpiry - 60000))
    ) {
      await this._refreshAccessToken()
    }

    const url = new URL(API_BASE + method)
    params.access_token = this.accessToken || ''
    params.v = API_VERSION

    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v)
    }

    const res = await makeRequest(url.toString(), {
      method: 'GET',
      headers: {
        'User-Agent':
          'KateMobileAndroid/56 lite-460 (Android 4.4.2; SDK 19; x86; unknown Android SDK built for x86; en)'
      },
      localAddress: this.nodelink.routePlanner?.getIP?.() || undefined,
      proxy: this.config.network.proxy
    })

    const body = res.body as VKApiResponse<T>

    if (res.error || res.statusCode !== 200 || body.error) {
      if (
        (res.statusCode === 401 || body.error?.error_code === 5) &&
        this.cookie
      ) {
        await this._refreshAccessToken()
        return this._apiRequest<T>(method, params)
      }
      throw new Error(
        body.error?.error_msg || res.error || `HTTP ${res.statusCode}`
      )
    }

    return body.response || null
  }

  /**
   * Internal Base64 decoder.
   * @internal
   */
  private _b64_decode(enc: string): string {
    let dec = ''
    let e = 0
    let n = 0
    for (let i = 0; i < enc.length; i++) {
      const char = enc[i]
      if (!char) continue
      const r = BASE64_CHARS.indexOf(char)
      if (r === -1) continue
      e = n % 4 ? 64 * e + r : r
      if (n++ % 4) dec += String.fromCharCode(255 & (e >> ((-2 * n) & 6)))
    }
    return dec
  }

  /**
   * Decodes masked VK audio URLs.
   * @internal
   */
  private _unmask_url(mask_url: string, vk_id: number): string | null {
    if (!mask_url.includes('audio_api_unavailable')) return mask_url
    try {
      const parts = mask_url.split('?extra=')[1]?.split('#')
      if (!parts) return mask_url
      const p1 = parts[1]
      const p0 = parts[0]
      if (!p1 || !p0) return mask_url

      const split1 = this._b64_decode(p1).split(String.fromCharCode(11))
      const maskUrlArr = this._b64_decode(p0).split('')
      const s1 = split1[1]
      if (!s1) return mask_url

      let index = Number.parseInt(s1, 10) ^ vk_id
      const urlLen = maskUrlArr.length
      const indexes = new Array(urlLen)

      for (let n = urlLen - 1; n >= 0; n--) {
        index = ((urlLen * (n + 1)) ^ (index + n)) % urlLen
        indexes[n] = index
      }
      for (let n = 1; n < urlLen; n++) {
        const c = maskUrlArr[n]
        const idx = (indexes[urlLen - 1 - n] ?? 0) as number
        if (c !== undefined) {
          const targetChar = maskUrlArr[idx]
          if (targetChar !== undefined) {
            maskUrlArr[n] = targetChar
            maskUrlArr[idx] = c
          }
        }
      }
      return maskUrlArr.join('')
    } catch {
      return null
    }
  }
}
