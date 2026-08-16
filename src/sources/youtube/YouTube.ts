import { PassThrough } from 'node:stream'
import HLSHandler from '../../playback/hls/HLSHandler.ts'
import type { SabrStreamConfig } from '../../typings/sources/sabr.types.ts'
import type {
  SourceResult,
  TrackInfo,
  TrackUrlResult,
  WorkerNodeLink
} from '../../typings/sources/source.types.ts'
import type {
  CancelSignal,
  ClientClassMap,
  ProxyEntry,
  ProxySnapshot,
  RawProxyInput,
  StreamResult,
  TrackUrlAdditionalData,
  TrackUrlData,
  YouTubeSourceConfig
} from '../../typings/sources/youtube.types.ts'
import type { YouTubeLiveChatSocket } from '../../typings/sources/youtubeClient.types.ts'
import type {
  HttpProxyConfig,
  HttpRequestResult,
  TrackEncodeInput
} from '../../typings/utils.types.ts'
import {
  encodeTrack,
  getBestMatch,
  http1makeRequest,
  logger,
  makeRequest
} from '../../utils.ts'
import CipherManager from './CipherManager.ts'
import {
  checkURLType,
  YOUTUBE_CONSTANTS,
  type YouTubeContext
} from './common.ts'
import YouTubeLiveChat from './LiveChat.ts'
import OAuth from './OAuth.ts'
import { SabrStream } from './sabr/sabr.ts'

/** Size in bytes of each range-request chunk for direct HTTP streaming. */
const CHUNK_SIZE = 64 * 1024

/** Maximum consecutive errors before triggering URL recovery. */
const MAX_RETRIES = 3

/** Maximum number of URL refresh attempts during recovery. */
const MAX_URL_REFRESH = 10

/** Interval in milliseconds between visitor data refreshes. */
const VISITOR_DATA_INTERVAL = 3_600_000

/** PassThrough buffer size. 48KB = ~3s of 128kbps Opus, enough to cover reconnect gaps. */
const STREAM_BUFFER_SIZE = 48 * 1024

/** Refresh URL before YouTube's ~6h expiry. */
const URL_MAX_AGE_MS = 4.5 * 60 * 60 * 1000

/** Recovery base delay with exponential backoff. So 2s, 4s, 8s, etc. */
const RECOVER_BASE_DELAY_MS = 2000
const MAX_RETRY_DELAY_MS = 8000

/**
 * Manages a scored pool of proxies with automatic health tracking.
 *
 * Proxies are scored from 0 to 100; failed requests decrease the score and
 * successful ones restore it. When selecting a proxy the top-3 healthiest
 * candidates are picked at random to spread the load.
 */
class YouTubeProxyManager {
  /** Internal pool of proxy entries with health metrics. */
  private proxies: ProxyEntry[]

  /**
   * Creates a new proxy manager from raw configuration entries.
   * @param rawProxies - Array of proxy URLs or configuration objects.
   */
  constructor(rawProxies: RawProxyInput[]) {
    this.proxies = (rawProxies || []).map(
      (p): ProxyEntry => ({
        url: typeof p === 'string' ? p : p.url,
        type: (typeof p === 'string' ? 'forward' : p.type || 'forward') as
          | 'forward'
          | 'reverse',
        failures: 0,
        lastFailure: 0,
        activeRequests: 0,
        score: 100,
        latency: 0
      })
    )
  }

  /**
   * Selects the healthiest available proxy from the pool.
   *
   * Filters out proxies that have been recently penalized (score 0 with
   * recent failures), sorts by score then active requests then latency,
   * and randomly picks one of the top-3 candidates to spread load.
   *
   * @returns A shallow copy {@link ProxySnapshot} of the selected proxy, or `undefined` if the pool is empty.
   */
  getBestProxy(): ProxySnapshot | undefined {
    if (!this.proxies.length) return undefined
    const now = Date.now()

    const available = this.proxies.filter((p) => {
      if (p.score <= 0) return now - p.lastFailure > 600_000
      if (p.failures > 5) return now - p.lastFailure > 60_000
      return true
    })

    const list = available.length ? available : this.proxies

    list.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (a.activeRequests !== b.activeRequests)
        return a.activeRequests - b.activeRequests
      return a.latency - b.latency
    })

    const topCount = Math.min(3, list.length)
    const selected = list[Math.floor(Math.random() * topCount)]
    if (!selected) return undefined

    selected.activeRequests++
    return { ...selected } as ProxySnapshot
  }

  /**
   * Reports the outcome of a proxy request for health tracking.
   *
   * Successful requests restore 5 score points; failures apply a penalty
   * proportional to the HTTP status code (403 = 50, 429 = 30, 503 = 20, other = 10).
   * The latency is exponentially smoothed into the proxy's running average.
   *
   * @param proxyUrl - Full URL of the proxy used.
   * @param success - Whether the request succeeded.
   * @param status - HTTP status code of the response.
   * @param latency - Round-trip latency in milliseconds (defaults to 0).
   */
  report(
    proxyUrl: string,
    success: boolean,
    status: number,
    latency = 0
  ): void {
    const p = this.proxies.find((pr) => pr.url === proxyUrl)
    if (!p) return

    if (p.activeRequests > 0) p.activeRequests--

    if (latency > 0) {
      p.latency = p.latency === 0 ? latency : p.latency * 0.8 + latency * 0.2
    }

    if (success) {
      p.score = Math.min(100, p.score + 5)
      p.failures = 0
    } else {
      p.failures++
      p.lastFailure = Date.now()

      let penalty = 10
      if (status === 403) penalty = 50
      if (status === 429) penalty = 30
      if (status === 503) penalty = 20

      p.score = Math.max(0, p.score - penalty)
    }
  }
}
/**
 * YouTube source implementation for NodeLink.
 *
 * Provides search, resolve, and stream-loading capabilities using a pool of
 * interchangeable innertube clients (Android, Web, TV, etc.) with automatic
 * fallback, proxy health tracking, and SABR/HLS protocol support.
 *
 * @public
 */
export default class YouTubeSource {
  /** Reference to the global NodeLink context used for configuration, caching, and source delegation. */
  private nodelink: WorkerNodeLink

  /** YouTube-specific configuration block from `nodelink.options.sources.youtube`. */
  private config: YouTubeSourceConfig

  /** Scored proxy pool manager with automatic health tracking and load balancing. */
  private proxyManager: YouTubeProxyManager

  /** Instantiated YouTube innertube client objects keyed by class name (e.g. `Android`, `Web`). */
  // biome-ignore lint/suspicious/noExplicitAny: JS client class instances have heterogeneous method shapes
  private clients: Record<string, any>

  /** OAuth helper for authenticated client requests, or `null` when not configured. */
  private oauth: OAuth | null

  /** Interval handle for periodic visitor data refresh, or `null` when not running. */
  private visitorDataInterval: ReturnType<typeof setInterval> | null

  /** Interval handle to clear failingClientsByTrack periodically. */
  private failingClientsInterval: ReturnType<typeof setInterval> | null

  /** Cipher/signature decryption manager shared across all innertube clients. */
  private cipherManager: CipherManager

  /** Live chat connection handler for YouTube live streams. */
  private liveChat: YouTubeLiveChat

  /** Map of active download streams keyed by a unique symbol or string, used for cancellation. */
  private activeStreams: Map<string | symbol, CancelSignal>

  /** Set of fallback-mirror lookup keys currently in flight, used to prevent infinite recursion loops. */
  private mirrorFallbackInFlight: Set<string>

  /** Map of track identifiers to a set of client names that failed to provide a playable URL. */
  private failingClientsByTrack: Map<string, Set<string>>

  /** YouTube innertube request context sent with every API call (device info, locale, visitor data). */
  private ytContext: YouTubeContext

  /** Dynamic bandwidth estimate in bits per second (starts at 128kbps/16KB/s). */
  private bandwidthEstimate = 128_000

  // -- Public fields consumed by the framework --

  /** Additional source names this source can proxy through (e.g. `['ytmusic']`). */
  additionalsSourceName: string[]
  /** Search term aliases recognized by the framework (e.g. `['ytsearch', 'ytmsearch']`). */
  searchTerms: string[]
  /** Recommendation term aliases recognized by the framework (e.g. `['ytrec']`). */
  recommendationTerm: string[]
  /** URL regex patterns this source can handle (YouTube watch, shorts, live, music URLs). */
  patterns: RegExp[]
  /** Source priority for URL matching (higher = preferred). */
  priority: number

  /**
   * Creates a new YouTube source instance.
   * @param nodelink - Runtime NodeLink context providing configuration and utilities.
   */
  constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
    this.config = nodelink.options.sources
      .youtube as unknown as YouTubeSourceConfig
    this.proxyManager = new YouTubeProxyManager(this.config.proxies || [])
    this.additionalsSourceName = ['ytmusic']
    this.searchTerms = ['ytsearch', 'ytmsearch']
    this.recommendationTerm = ['ytrec']
    this.patterns = [
      /^https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=[\w-]+(?:&list=[\w-]+)?|playlist\?list=[\w-]+|live\/[\w-]+)|youtu\.be\/[\w-]+)/,
      /^https?:\/\/(?:www\.)?youtube\.com\/shorts\/[\w-]+/,
      /^https?:\/\/music\.youtube\.com\/(?:watch\?v=[\w-]+(?:&list=[\w-]+)?|playlist\?list=[\w-]+)/
    ]

    this.priority = 100
    this.clients = {}
    this.oauth = null
    this.visitorDataInterval = null
    this.failingClientsInterval = null
    this.cipherManager = new CipherManager(nodelink)
    this.liveChat = new YouTubeLiveChat(nodelink, {
      getProxy: this.getProxy.bind(this),
      getContext: () => this.ytContext
    })
    this.activeStreams = new Map()
    this.mirrorFallbackInFlight = new Set()
    this.failingClientsByTrack = new Map()
    this.ytContext = {
      client: {
        screenDensityFloat: 1,
        screenHeightPoints: 1080,
        screenPixelDensity: 1,
        screenWidthPoints: 1920,
        hl: 'en',
        gl: 'US',
        visitorData: null
      }
    }
  }

  /**
   * Returns the healthiest available proxy from the managed pool.
   * @param _rotate - Whether to rotate the proxy selection (currently unused, kept for interface compatibility).
   * @returns A {@link ProxySnapshot} of the selected proxy, or `undefined` if no proxies are configured.
   */
  getProxy(_rotate = true): ProxySnapshot | undefined {
    return this.proxyManager.getBestProxy()
  }

  /**
   * Reports the outcome of a proxied request for health tracking.
   * @param proxy - The proxy snapshot used for the request, or `undefined` if no proxy was used.
   * @param success - Whether the request succeeded.
   * @param status - HTTP status code returned.
   * @param latency - Round-trip latency in milliseconds.
   */
  reportProxyStatus(
    proxy: ProxySnapshot | undefined,
    success: boolean,
    status: number,
    latency = 0
  ): void {
    if (proxy?.url) {
      this.proxyManager.report(proxy.url, success, status, latency)
    }
  }

  /**
   * Initializes the YouTube source by instantiating innertube clients,
   * fetching visitor data, caching the player script, and starting
   * periodic visitor data refresh.
   * @returns Promise resolving to `true` when setup completes successfully.
   */
  async setup(): Promise<boolean> {
    logger('info', 'YouTube', 'Setting up YouTube source...')

    this.oauth = new OAuth(this.nodelink)

    const [
      { default: Android },
      { default: AndroidVR },
      { default: IOS },
      { default: Music },
      { default: WebRemix },
      { default: TV },
      { default: TV_DOWN },
      { default: TVCast },
      { default: Web },
      { default: WebEmbedded },
      { default: VisionOs }
    ] = await Promise.all([
      import('./clients/Android.ts'),
      import('./clients/AndroidVR.ts'),
      import('./clients/IOS.ts'),
      import('./clients/Music.ts'),
      import('./clients/Web_Remix.ts'),
      import('./clients/TV.ts'),
      import('./clients/TV_downgraded.ts'),
      import('./clients/TVCast.ts'),
      import('./clients/Web.ts'),
      import('./clients/WebEmbedded.ts'),
      import('./clients/visionOs.ts')
    ])

    const clientClasses: ClientClassMap = {
      Android,
      AndroidVR,
      IOS,
      Music,
      WebRemix,
      TV,
      TV_DOWN,
      TVCast,
      Web,
      WebEmbedded,
      VisionOs
    }

    for (const clientName of Object.keys(clientClasses)) {
      const ClientCtor = clientClasses[clientName]
      if (!ClientCtor) continue
      this.clients[clientName] = new ClientCtor(this.nodelink, this.oauth)
    }

    logger(
      'debug',
      'YouTube',
      `Initialized clients: ${Object.keys(this.clients).join(', ')}`
    )

    await this._fetchVisitorData()
    await this.cipherManager.getCachedPlayerScript()

    if (this.visitorDataInterval) clearInterval(this.visitorDataInterval)
    this.visitorDataInterval = setInterval(
      () => this._fetchVisitorData(),
      VISITOR_DATA_INTERVAL
    )
    this.visitorDataInterval.unref?.()

    if (this.failingClientsInterval) clearInterval(this.failingClientsInterval)
    this.failingClientsInterval = setInterval(
      () => this.failingClientsByTrack.clear(),
      1000 * 60 * 60 * 12
    )
    this.failingClientsInterval.unref?.()

    logger('info', 'YouTube', 'YouTube source setup complete.')
    return true
  }

  /**
   * Tears down the YouTube source by aborting active streams, clearing
   * the visitor data interval, and cleaning up OAuth and cipher resources.
   */
  cleanup(): void {
    logger('info', 'YouTube', 'Cleaning up YouTube source...')

    for (const [, cancelSignal] of this.activeStreams.entries()) {
      cancelSignal.aborted = true
    }
    this.activeStreams.clear()

    if (this.visitorDataInterval) {
      clearInterval(this.visitorDataInterval)
      this.visitorDataInterval = null
    }

    if (this.failingClientsInterval) {
      clearInterval(this.failingClientsInterval)
      this.failingClientsInterval = null
    }

    if (this.oauth) (this.oauth as { cleanup?: () => void }).cleanup?.()
    ;(this.cipherManager as { cleanup?: () => void })?.cleanup?.()
    this.failingClientsByTrack.clear()
  }
  /**
   * Fetches visitor data and player script URL from YouTube embed pages.
   *
   * Tries the embed endpoint first, then falls back to the guide API.
   * Both visitor data and player script URL are cached in the credential
   * manager for use by innertube clients.
   *
   * @returns Promise that resolves when the fetch attempt completes.
   */
  private async _fetchVisitorData(): Promise<void> {
    // this should prevent the visitorData getting initialized twice.
    if (process.env.WORKER_TYPE === 'source') return
    
    const cachedPlayerScript = this.nodelink.credentialManager?.get<string>(
      'yt_player_script_url'
    )
    if (cachedPlayerScript) {
      this.cipherManager.setPlayerScriptUrl(cachedPlayerScript)
      logger('debug', 'YouTube', 'Player script URL loaded from cache.')
    }

    let visitorFound = false
    let playerScriptUrl: string | null = null

    try {
      const { body, error, statusCode } = await makeRequest(
        'https://youtubei.googleapis.com/youtubei/v1/visitor_id?key=AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w',
        {
          method: 'POST',
          body: {
            context: {
              client: {
                clientName: 'ANDROID',
                clientVersion: '20.01.35'
              }
            }
          },
          disableBodyCompression: true
        }
      )

      const data = body as {
        responseContext?: {
          visitorData?: string
        }
      }

      if (!error && statusCode === 200 && data?.responseContext?.visitorData) {
        this.ytContext.client.visitorData = data.responseContext.visitorData
        visitorFound = true
        logger(
          'debug',
          'YouTube',
          `visitorData obtained from visitor_id endpoint (len=${data.responseContext.visitorData.length})`
        )
      }
    } catch (e) {
      logger(
        'debug',
        'YouTube',
        `visitor_id endpoint failed: ${(e as Error).message}`
      )
    }
    if (!visitorFound) {
      try {
        const {
          body: data,
          error,
          statusCode
        } = await makeRequest('https://www.youtube.com/embed', {
          method: 'GET',
          headers: {
            Cookie: 'YSC=LUAfwHpna4E; VISITOR_INFO1_LIVE=Zuih2uZbq3I;'
          }
        })

        if (!error && statusCode === 200) {
          const bodyStr = data as string
          const visitorMatch = bodyStr?.match(/"VISITOR_DATA":"([^"]+)"/)
          if (visitorMatch?.[1]) {
            this.ytContext.client.visitorData = visitorMatch[1]
            visitorFound = true
            logger('debug', 'YouTube', 'visitorData refreshed from embed.')
          }

          if (!cachedPlayerScript) {
            const playerScriptMatch = bodyStr?.match(/"jsUrl":"([^"]+)"/)
            if (playerScriptMatch?.[1]) {
              playerScriptUrl = playerScriptMatch[1].replace(
                /\/[a-z]{2}_[A-Z]{2}\//,
                '/en_US/'
              )
              this.nodelink.credentialManager?.set(
                'yt_player_script_url',
                playerScriptUrl,
                12 * 60 * 60 * 1000
              )
              logger(
                'debug',
                'YouTube',
                `Player script URL: ${playerScriptUrl}`
              )
            }
          }
        } else {
          logger(
            'warn',
            'YouTube',
            `Embed request failed: ${(error as { message?: string })?.message || `Status ${statusCode}`}`
          )
        }

        if (!visitorFound) {
          const {
            body: guideData,
            error: guideError,
            statusCode: guideStatusCode
          } = await makeRequest('https://www.youtube.com/youtubei/v1/guide', {
            method: 'POST',
            body: { context: this.ytContext },
            disableBodyCompression: true
          })

          const guideBody = guideData as {
            responseContext?: { visitorData?: string }
          }
          if (
            !guideError &&
            guideStatusCode === 200 &&
            guideBody?.responseContext?.visitorData
          ) {
            this.ytContext.client.visitorData =
              guideBody.responseContext.visitorData
            visitorFound = true
            logger('debug', 'YouTube', 'visitorData refreshed via guide.')
          } else {
            logger(
              'warn',
              'YouTube',
              'Failed to refresh visitorData via guide.'
            )
          }
        }
      } catch (e) {
        logger(
          'error',
          'YouTube',
          `Error fetching visitor data: ${(e as Error).message}`
        )
      }
    }

    if (playerScriptUrl) this.cipherManager.setPlayerScriptUrl(playerScriptUrl)
  }
  /**
   * Searches YouTube for tracks, playlists, or recommendations.
   *
   * Iterates through the configured search clients in priority order,
   * returning the first successful result. For YouTube Music searches
   * (`ytmsearch`), only WebRemix and Music clients are used.
   *
   * @param query - Search query string.
   * @param type - Search term alias (`'ytsearch'`, `'ytmsearch'`, `'ytrec'`).
   * @param searchType - Content type to search for (`'track'`, `'playlist'`, etc.).
   * @returns Promise resolving to a source result with search results or an exception.
   */
  async search(
    query: string,
    type: string,
    searchType = 'track'
  ): Promise<SourceResult> {
    if (type === 'ytrec') {
      return this.getRecommendations(query)
    }

    let clientList: string[] = this.config.clients.search

    if (type === 'ytmsearch') {
      clientList = ['WebRemix', 'Music']
    }

    const clientErrors: Array<{ client: string; message: string }> = []

    for (const clientName of clientList) {
      const client = this.clients[clientName]
      if (!client) continue

      try {
        logger(
          'debug',
          'YouTube',
          `Attempting ${searchType} search with client: ${clientName}`
        )
        const searchProxy =
          clientName === 'Android' ? this.getProxy(true) : undefined
        const result = await client.search(
          query,
          searchType,
          this.ytContext,
          searchProxy,
          this.reportProxyStatus.bind(this)
        )

        if (result && result.loadType === 'search') {
          logger(
            'debug',
            'YouTube',
            `Search successful with client: ${clientName}`
          )
          return result
        }

        const errorMessage =
          (result?.data as { message?: string })?.message ||
          'Client returned empty or failed.'
        clientErrors.push({ client: clientName, message: errorMessage })
        logger(
          'debug',
          'YouTube',
          `Client ${clientName} returned empty or failed search.`
        )
      } catch (e) {
        clientErrors.push({
          client: clientName,
          message: (e as Error).message
        })
        logger(
          'warn',
          'YouTube',
          `Client ${clientName} threw an exception during search: ${(e as Error).message}`
        )
      }
    }

    logger(
      'error',
      'YouTube',
      'No search results found from any configured client.'
    )
    return {
      loadType: 'error',
      exception: {
        message: 'No search results found from any configured client.',
        severity: 'fault',
        cause: 'All clients failed.',
        errors: clientErrors
      }
    }
  }
  /**
   * Fetches YouTube auto-mix recommendations for a given video or query.
   *
   * Constructs an auto-mix playlist ID (`RD{videoId}`) and attempts to
   * resolve it through music and TV clients in priority order. If the
   * query is not a valid video ID, performs a search first to resolve one.
   *
   * @param query - YouTube video ID or search query string.
   * @returns Promise resolving to a playlist result with recommendations, or an empty result.
   */
  async getRecommendations(query: string): Promise<SourceResult> {
    let videoId = query
    if (!/^[a-zA-Z0-9_-]{11}$/.test(query)) {
      const searchRes = await this.search(query, 'ytmsearch')
      if (searchRes.loadType !== 'search' || searchRes.data.length === 0) {
        return { loadType: 'empty', data: {} }
      }
      videoId = (
        (searchRes.data as Array<{ info: TrackInfo }>)[0] as {
          info: TrackInfo
        }
      ).info.identifier
    }

    try {
      const automixId = `RD${videoId}`
      let automixRes: SourceResult | null = null

      if (this.clients.WebRemix || this.clients.Music) {
        try {
          const musicClient = this.clients.WebRemix ?? this.clients.Music
          if (!musicClient) throw new Error('no music client')
          const clientName = this.clients.WebRemix ? 'WebRemix' : 'Music'
          logger(
            'debug',
            'YouTube',
            `Attempting recommendations with ${clientName} client`
          )

          automixRes = await musicClient.resolve(
            `https://music.youtube.com/playlist?list=${automixId}`,
            'ytmusic',
            this.ytContext,
            this.cipherManager
          )
        } catch (e) {
          logger(
            'debug',
            'YouTube',
            `Music client failed for recommendations: ${(e as Error).message}`
          )
        }
      }

      if (
        automixRes?.loadType !== 'playlist' &&
        (this.clients.TV || this.clients.TVCast || this.clients.WebRemix)
      ) {
        try {
          const tvClient = this.clients.TV ?? this.clients.TVCast
          if (!tvClient) throw new Error('no tv client')
          const clientName = this.clients.TV ? 'TV' : 'TVCast'
          logger(
            'debug',
            'YouTube',
            `Attempting recommendations with ${clientName} client`
          )
          automixRes = await tvClient.resolve(
            `https://www.youtube.com/playlist?list=${automixId}`,
            'youtube',
            this.ytContext,
            this.cipherManager
          )
        } catch (e) {
          logger(
            'debug',
            'YouTube',
            `TV client failed for recommendations: ${(e as Error).message}`
          )
        }
      }

      if (
        automixRes &&
        automixRes.loadType === 'playlist' &&
        automixRes.data.tracks.length > 0
      ) {
        const tracks = automixRes.data.tracks.filter(
          (t) => t.info.identifier !== videoId
        )
        return {
          loadType: 'playlist',
          data: {
            info: { name: 'YouTube Recommendations', selectedTrack: 0 },
            pluginInfo: { type: 'recommendations' },
            tracks
          }
        }
      }

      return { loadType: 'empty', data: {} }
    } catch (e) {
      logger(
        'error',
        'YouTube',
        `Recommendations failed: ${(e as Error).message}`
      )
      return {
        loadType: 'error',
        exception: { message: (e as Error).message, severity: 'fault' }
      }
    }
  }
  /**
   * Resolves a YouTube or YouTube Music URL into a track or playlist result.
   *
   * Normalizes live URLs, detects music URLs for specialized client routing,
   * and iterates through configured clients with automatic fallback between
   * music and standard YouTube clients when playability errors occur.
   *
   * @param url - YouTube or YouTube Music URL to resolve.
   * @param type - Optional source type override (e.g. `'youtube-fallback'` for recursive fallback).
   * @returns Promise resolving to a source result with track/playlist data or an exception.
   */
  async resolve(url: string, type?: string): Promise<SourceResult> {
    const result = await this._resolveWorker(url, type)

    if (
      this.config.mirrorOfficialAlbums &&
      url.includes('list=OLAK') &&
      result.loadType === 'playlist'
    ) {
      const tracks = (result.data as { tracks?: Array<{ info: TrackInfo; encoded: string }> })
        ?.tracks
      if (tracks) {
        for (const track of tracks) {
          if (track.info && !track.info.uri.includes('olak=true')) {
            const separator = track.info.uri.includes('?') ? '&' : '?'
            track.info.uri += `${separator}olak=true`
            track.encoded = encodeTrack({ ...track.info, details: [] } as TrackEncodeInput)
          }
        }
      }
    }

    return result
  }

  /**
   * Internal worker for URL resolution.
   * @internal
   */
  private async _resolveWorker(url: string, type?: string): Promise<SourceResult> {
    const liveMatch = url.match(
      /^https?:\/\/(?:www\.)?youtube\.com\/live\/([\w-]+)/
    )
    if (liveMatch) {
      const videoId = liveMatch[1]
      url = `https://www.youtube.com/watch?v=${videoId}`
      logger('debug', 'YouTube', `Normalized live URL to: ${url}`)
    }

    const isMusicUrl = url.includes('music.youtube.com')
    const sourceType = isMusicUrl ? 'ytmusic' : 'youtube'

    const processUrl = url

    const clientList =
      this.config.clients.resolve || this.config.clients.playback
    logger(
      'debug',
      'YouTube',
      `Using resolve clients: ${clientList.join(', ')}`
    )

    const clientErrors: Array<{ client: string; message: string }> = []
    const urlType = checkURLType(processUrl, sourceType)

    if (isMusicUrl) {
      const musicClients = ['WebRemix', 'Music']

      for (const clientName of musicClients) {
        const musicClient = this.clients[clientName]
        if (!musicClient) continue

        try {
          logger(
            'debug',
            'YouTube',
            `Attempting to resolve YouTube Music URL with ${clientName} client.`
          )
          const result = await musicClient.resolve(
            processUrl,
            sourceType,
            this.ytContext,
            this.cipherManager
          )

          if (
            result &&
            (result.loadType === 'track' || result.loadType === 'playlist')
          ) {
            logger(
              'debug',
              'YouTube',
              `Successfully resolved YouTube Music URL with ${clientName} client.`
            )
            return result
          }

          if (
            result?.loadType === 'error' &&
            result.exception?.cause === 'UpstreamPlayability'
          ) {
            const listIdMatch = url.match(/[?&]list=([\w-]+)/)
            const videoIdMatch = url.match(/[?&]v=([\w-]+)/)
            const listId = listIdMatch ? listIdMatch[1] : null
            const videoId = videoIdMatch ? videoIdMatch[1] : null
            const fallbackId = listId || videoId

            if (fallbackId) {
              logger(
                'warn',
                'YouTube',
                `${clientName} client returned Playability Error for ${fallbackId}. Attempting fallback to standard YouTube client.`
              )
              let fallbackUrl: string
              if (listId) {
                fallbackUrl = `https://www.youtube.com/playlist?list=${listId}`
                if (videoId) {
                  fallbackUrl += `&v=${videoId}`
                }
              } else {
                fallbackUrl = `https://www.youtube.com/watch?v=${videoId}`
              }
              const fallbackResult = await this.resolve(fallbackUrl, 'youtube')

              if (
                fallbackResult &&
                (fallbackResult.loadType === 'track' ||
                  fallbackResult.loadType === 'playlist' ||
                  fallbackResult.loadType === 'empty')
              ) {
                if (
                  fallbackResult.loadType === 'track' &&
                  (fallbackResult.data as { info?: TrackInfo })?.info
                ) {
                  ;(
                    fallbackResult.data as { info: TrackInfo }
                  ).info.sourceName = 'ytmusic'
                  ;(fallbackResult.data as { info: TrackInfo }).info.uri = url
                } else if (
                  fallbackResult.loadType === 'playlist' &&
                  (
                    fallbackResult.data as {
                      tracks?: Array<{ info: TrackInfo }>
                    }
                  )?.tracks
                ) {
                  for (const track of (
                    fallbackResult.data as {
                      tracks: Array<{ info: TrackInfo }>
                    }
                  ).tracks) {
                    if (track.info) {
                      track.info.sourceName = 'ytmusic'
                      const trackVideoId = track.info.identifier
                      track.info.uri = `https://music.youtube.com/watch?v=${trackVideoId}`
                    }
                  }
                }
                return fallbackResult
              }
            }
          }

          const errorMessage =
            result?.exception?.message ||
            `${clientName} client returned empty or failed.`
          clientErrors.push({ client: clientName, message: errorMessage })
          logger(
            'debug',
            'YouTube',
            `${clientName} client returned empty or failed for Music URL.`
          )
        } catch (e) {
          clientErrors.push({
            client: clientName,
            message: (e as Error).message
          })
          logger(
            'warn',
            'YouTube',
            `${clientName} client threw an exception during Music URL resolve: ${(e as Error).message}`
          )
        }
      }

      const msg = 'All music clients failed for direct Music URL.'
      logger('error', 'YouTube', msg)
      return {
        loadType: 'error',
        exception: {
          message: msg,
          severity: 'fault',
          cause: 'MusicClientsFailure',
          errors: clientErrors
        }
      }
    }

    if (urlType === YOUTUBE_CONSTANTS.PLAYLIST) {
      const androidClient = this.clients.Android
      if (androidClient) {
        try {
          logger(
            'debug',
            'YouTube',
            'Attempting to resolve playlist with Android client.'
          )
          const result = await androidClient.resolve(
            processUrl,
            sourceType,
            this.ytContext,
            this.cipherManager
          )

          if (
            result &&
            (result.loadType === 'track' ||
              result.loadType === 'playlist' ||
              result.loadType === 'empty')
          ) {
            logger(
              'debug',
              'YouTube',
              'Successfully resolved playlist with Android client.'
            )
            return result
          }

          const errorMessage =
            (result?.data as { message?: string })?.message ||
            'Android client failed for playlist.'
          clientErrors.push({ client: 'Android', message: errorMessage })
          logger(
            'debug',
            'YouTube',
            'Android client returned empty or failed to resolve playlist.'
          )
        } catch (e) {
          clientErrors.push({
            client: 'Android',
            message: (e as Error).message
          })
          logger(
            'warn',
            'YouTube',
            `Android client threw an exception during playlist resolve: ${(e as Error).message}`
          )
        }
      } else {
        clientErrors.push({
          client: 'Android',
          message: 'Android client not available.'
        })
        logger(
          'warn',
          'YouTube',
          'Android client not available for playlist priority.'
        )
      }
    }

    for (const clientName of clientList) {
      const client = this.clients[clientName]
      if (!client) continue

      if (!isMusicUrl && clientName === 'Music') continue
      if (isMusicUrl && clientName !== 'Music' && type !== 'youtube-fallback') {
        continue
      }
      if (
        type === 'youtube-fallback' &&
        !['Android', 'Web'].includes(clientName)
      ) {
        continue
      }

      try {
        logger(
          'debug',
          'YouTube',
          `Attempting to resolve URL with client: ${clientName}`
        )
        const result = await client.resolve(
          processUrl,
          sourceType,
          this.ytContext,
          this.cipherManager,
          this.reportProxyStatus.bind(this)
        )

        if (
          result &&
          (result.loadType === 'track' ||
            result.loadType === 'playlist' ||
            result.loadType === 'empty')
        ) {
          logger(
            'debug',
            'YouTube',
            `Successfully resolved URL with client: ${clientName}`
          )
          return result
        }

        const errorMessage =
          (result?.data as { message?: string })?.message ||
          'Client returned empty or failed.'
        clientErrors.push({ client: clientName, message: errorMessage })
        logger(
          'debug',
          'YouTube',
          `Client ${clientName} returned empty or failed to resolve URL.`
        )
      } catch (e) {
        clientErrors.push({
          client: clientName,
          message: (e as Error).message
        })
        logger(
          'warn',
          'YouTube',
          `Client ${clientName} threw an exception during resolve: ${(e as Error).message}`
        )
      }
    }

    logger('error', 'YouTube', 'All clients failed to resolve the URL.')
    return {
      loadType: 'error',
      exception: {
        message: 'All clients failed to resolve the URL.',
        severity: 'fault',
        cause: 'All clients failed.',
        errors: clientErrors
      }
    }
  }
  /**
   * Enriches a basic track with "Holo" metadata by querying the Web client
   * player API. Falls back to the original track if enrichment fails.
   * @param vanillaTrack - Basic track object with `info` and optional `userData`.
   * @param options - Optional overrides for channel info and external link resolution.
   * @returns Promise resolving to the enriched track or the original if enrichment fails.
   */
  async resolveHoloTrack(
    vanillaTrack: { info: TrackInfo; userData?: unknown },
    options: {
      fetchChannelInfo?: boolean
      resolveExternalLinks?: boolean
    } = {}
  ): Promise<{ info: TrackInfo; userData?: unknown }> {
    try {
      const { info, userData } = vanillaTrack

      const webClient = this.clients.Web
      if (!webClient) {
        logger(
          'warn',
          'YouTube',
          'Web client not available for Holo resolution'
        )
        return vanillaTrack
      }

      const videoId = info.identifier
      const playerResult = await webClient._makePlayerRequest?.(
        videoId,
        this.ytContext,
        {} as Record<string, string>,
        this.cipherManager
      )

      const playerBody = (playerResult as HttpRequestResult | undefined)?.body
      if (!playerBody || (playerBody as { error?: unknown }).error)
        return vanillaTrack

      const { buildHoloTrack } = await import('./common.ts')

      const holoTrack = await buildHoloTrack(
        info,
        null,
        info.sourceName === 'ytmusic' ? 'ytmusic' : 'youtube',
        playerBody as Record<string, unknown>,
        {
          fetchChannelInfo: options.fetchChannelInfo ?? false,
          resolveExternalLinks: options.resolveExternalLinks ?? false,
          search: {}
        }
      )

      if (holoTrack) holoTrack.userData = userData
      return holoTrack
    } catch (err) {
      logger(
        'error',
        'YouTube',
        `Failed to resolve Holo track: ${(err as Error).message}`
      )
      return vanillaTrack
    }
  }
  /**
   * Resolves the playable stream URL for a decoded track.
   *
   * Checks the track cache first (unless `forceRefresh` is set), then
   * iterates through configured playback clients. Validates direct URLs
   * with a pre-flight range request and falls back to HLS when direct
   * URLs return 403. If all clients fail, attempts mirror-source fallback.
   *
   * @param decodedTrack - Track metadata to resolve.
   * @param itag - Optional specific format itag to request.
   * @param forceRefresh - When `true`, bypasses the track cache and forces a fresh URL fetch.
   * @returns Promise resolving to track URL data with stream info or an exception.
   */
  async getTrackUrl(
    decodedTrack: TrackInfo,
    itag?: number | null,
    forceRefresh = false
  ): Promise<TrackUrlData> {
    if (decodedTrack.uri?.includes('olak=true')) {
      logger('debug', 'YouTube', `Resolving mirrored audio track for official album: ${decodedTrack.identifier}`)
      
      let searchTitle = decodedTrack.title
      let searchAuthor = decodedTrack.author
      if (searchTitle.includes(' - ')) {
        const parts = searchTitle.split(' - ')
        if (parts[0] && parts.length > 1) {
          searchAuthor = parts[0].trim()
          searchTitle = parts.slice(1).join(' - ').trim()
        }
      }

      const query = `${searchAuthor} ${searchTitle}`
      const searchTrack = { ...decodedTrack, title: searchTitle, author: searchAuthor }
      
      try {
        const res = await this.search(query, 'ytmsearch')
        if (res.loadType === 'search' && res.data.length) {
          const best = getBestMatch(res.data, searchTrack)
          if (best) {
            const urlData = await this.getTrackUrl(best.info as TrackInfo, itag, forceRefresh)
            return {
              newTrack: { info: best.info as TrackInfo },
              url: urlData.url,
              protocol: urlData.protocol,
              format: typeof urlData.format === 'string' ? urlData.format : undefined,
              additionalData: urlData.additionalData,
              exception: urlData.exception as TrackUrlData['exception']
            }
          }
        }
      } catch (e) {
        logger('warn', 'YouTube', `Failed to mirror OLAK track ${decodedTrack.identifier}: ${(e as Error).message}`)
      }
    }
    if (!forceRefresh) {
      const cached = this.nodelink.trackCacheManager?.get<TrackUrlData>(
        'youtube',
        decodedTrack.identifier
      )
      if (cached) {
        const cachedProxyUrl = (
          cached.additionalData as TrackUrlAdditionalData | undefined
        )?.proxy?.url
        const currentProxies = this.config.proxies || []
        const isProxyStillValid =
          !cachedProxyUrl ||
          currentProxies.some(
            (p) => (typeof p === 'string' ? p : p.url) === cachedProxyUrl
          )

        if (isProxyStillValid) {
          logger(
            'debug',
            'YouTube',
            `Using cached URL for ${decodedTrack.identifier}`
          )
          return cached
        }
        logger(
          'debug',
          'YouTube',
          `Cached proxy for ${decodedTrack.identifier} is no longer in config. Forcing refresh...`
        )
      }
    }

    let clientList = [...this.config.clients.playback]
    if (!clientList.length) clientList = ['Web']
    const clientErrors: Array<{ client: string; message: string }> = []

    const failingClients = this.failingClientsByTrack.get(
      decodedTrack.identifier
    )

    for (const clientName of clientList) {
      if (failingClients?.has(clientName)) {
        logger(
          'debug',
          'YouTube',
          `Skipping known failing client ${clientName} for track ${decodedTrack.identifier}`
        )
        continue
      }

      const client = this.clients[clientName]
      if (!client) continue

      try {
        logger(
          'debug',
          'YouTube',
          `Attempting to get track URL for ${decodedTrack.title} with client: ${clientName}`
        )
        const proxyToUse = this.getProxy(true)
        const proxyStartTime = Date.now()
        const urlData: TrackUrlData = await client.getTrackUrl(
          decodedTrack,
          this.ytContext,
          this.cipherManager,
          itag,
          proxyToUse
        )

        const proxyLatency = Date.now() - proxyStartTime

        if (urlData.exception) {
          const isNoStream = urlData.exception.cause === 'UpstreamNoStream'
          const isNotFound = urlData.exception.status === 404

          if (isNoStream || isNotFound) {
            if (!this.failingClientsByTrack.has(decodedTrack.identifier)) {
              this.failingClientsByTrack.set(decodedTrack.identifier, new Set())
            }
            this.failingClientsByTrack
              .get(decodedTrack.identifier)
              ?.add(clientName)
          }

          this.reportProxyStatus(
            proxyToUse,
            false,
            urlData.exception.status || 500,
            proxyLatency
          )
          clientErrors.push({
            client: clientName,
            message: urlData.exception.message
          })
          logger(
            'debug',
            'YouTube',
            `Client ${clientName} failed: ${urlData.exception.message}`
          )
          continue
        }

        if (urlData.protocol === 'sabr') {
          this.reportProxyStatus(proxyToUse, true, 200, proxyLatency)
          const bestAudio = urlData.formats
            ?.filter((f) => f.mimeType?.includes('audio'))
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]

          if (bestAudio) {
            urlData.format = bestAudio.mimeType?.includes('webm')
              ? 'webm/opus'
              : 'm4a'
          }

          return urlData
        }

        if (urlData.url) {
          const check: HttpRequestResult = await http1makeRequest(urlData.url, {
            method: 'GET',
            headers: { Range: 'bytes=0-0' },
            streamOnly: true,
            proxy: proxyToUse as unknown as HttpProxyConfig
          })

          if (check.stream)
            (
              check.stream as NodeJS.ReadableStream & { destroy: () => void }
            ).destroy()

          this.reportProxyStatus(
            proxyToUse,
            !check.error &&
              (check.statusCode === 200 || check.statusCode === 206),
            check.statusCode || 0,
            Date.now() - proxyStartTime
          )

          if (
            !check.error &&
            (check.statusCode === 200 || check.statusCode === 206)
          ) {
            let contentLength: number | null = null
            const headers = check.headers as Record<string, string | undefined>
            if (headers?.['content-range']) {
              const match = headers['content-range']?.match(/\/(\d+)/)
              if (match) contentLength = Number.parseInt(match[1] ?? '0', 10)
            }
            if (!contentLength && headers?.['content-length']) {
              contentLength = Number.parseInt(
                headers['content-length'] as string,
                10
              )
            }

            logger(
              'debug',
              'YouTube',
              `URL pre-flight check successful for client ${clientName}.`
            )
            const result: TrackUrlData = {
              ...urlData,
              additionalData: {
                contentLength,
                proxy: proxyToUse,
                itag: urlData.itag,
                formats: urlData.formats
              }
            }
            this.nodelink.trackCacheManager?.set(
              'youtube',
              decodedTrack.identifier,
              result,
              1000 * 60 * 60 * 5
            )
            return result
          }

          const errorMessage = `URL pre-flight failed. Status: ${check.statusCode}, Error: ${check.error}`
          clientErrors.push({
            client: clientName,
            message: `Direct URL: ${errorMessage}`
          })
          logger('warn', 'YouTube', `Client ${clientName}: ${errorMessage}`)

          if (check.statusCode === 403 && urlData.hlsUrl) {
            logger(
              'warn',
              'YouTube',
              `Direct URL 403, attempting HLS fallback for client ${clientName}.`
            )
            const hlsCheck: HttpRequestResult = await http1makeRequest(
              urlData.hlsUrl,
              {
                method: 'GET',
                headers: { Range: 'bytes=0-0' },
                streamOnly: true,
                proxy: proxyToUse as unknown as HttpProxyConfig
              }
            )

            if (hlsCheck.stream)
              (
                hlsCheck.stream as NodeJS.ReadableStream & {
                  destroy: () => void
                }
              ).destroy()

            this.reportProxyStatus(
              proxyToUse,
              !hlsCheck.error &&
                (hlsCheck.statusCode === 200 || hlsCheck.statusCode === 206),
              hlsCheck.statusCode || 0,
              Date.now() - proxyStartTime
            )

            if (
              !hlsCheck.error &&
              (hlsCheck.statusCode === 200 || hlsCheck.statusCode === 206)
            ) {
              logger(
                'debug',
                'YouTube',
                `HLS fallback check successful for client ${clientName}.`
              )
              const result: TrackUrlData = {
                url: urlData.hlsUrl,
                protocol: 'hls',
                format: 'mpegts'
              }
              this.nodelink.trackCacheManager?.set(
                'youtube',
                decodedTrack.identifier,
                result,
                1000 * 60 * 60 * 5
              )
              return result
            }

            const hlsError = `HLS fallback failed. Status: ${hlsCheck.statusCode}, Error: ${hlsCheck.error}`
            clientErrors.push({ client: clientName, message: hlsError })
            logger('warn', 'YouTube', `Client ${clientName}: ${hlsError}`)
          }
        } else if (urlData.hlsUrl) {
          const hlsCheck: HttpRequestResult = await http1makeRequest(
            urlData.hlsUrl,
            {
              method: 'GET',
              headers: { Range: 'bytes=0-0' },
              streamOnly: true,
              proxy: proxyToUse as unknown as HttpProxyConfig
            }
          )

          if (hlsCheck.stream)
            (
              hlsCheck.stream as NodeJS.ReadableStream & { destroy: () => void }
            ).destroy()

          this.reportProxyStatus(
            proxyToUse,
            !hlsCheck.error &&
              (hlsCheck.statusCode === 200 || hlsCheck.statusCode === 206),
            hlsCheck.statusCode || 0,
            Date.now() - proxyStartTime
          )

          if (
            !hlsCheck.error &&
            (hlsCheck.statusCode === 200 || hlsCheck.statusCode === 206)
          ) {
            logger(
              'debug',
              'YouTube',
              `HLS-only check successful for client ${clientName}.`
            )
            const result: TrackUrlData = {
              url: urlData.hlsUrl,
              protocol: 'hls',
              format: 'mpegts'
            }
            this.nodelink.trackCacheManager?.set(
              'youtube',
              decodedTrack.identifier,
              result,
              1000 * 60 * 60 * 5
            )
            return result
          }

          const hlsError = `HLS-only check failed. Status: ${hlsCheck.statusCode}, Error: ${hlsCheck.error}`
          clientErrors.push({ client: clientName, message: hlsError })
          logger('warn', 'YouTube', `Client ${clientName}: ${hlsError}`)
        }
      } catch (e) {
        clientErrors.push({
          client: clientName,
          message: (e as Error).message
        })
        logger(
          'warn',
          'YouTube',
          `Client ${clientName} threw an exception in getTrackUrl: ${(e as Error).message}`
        )
      }
    }

    if ((decodedTrack as TrackInfo & { audioTrackId?: string }).audioTrackId) {
      logger(
        'warn',
        'YouTube',
        `Requested audio track "${(decodedTrack as TrackInfo & { audioTrackId?: string }).audioTrackId}" not found on any client. Falling back to default audio.`
      )

      const fallbackTrack = { ...decodedTrack } as TrackInfo & {
        audioTrackId?: string
      }
      delete fallbackTrack.audioTrackId

      return this.getTrackUrl(fallbackTrack, itag)
    }

    const mirrored = await this._tryMirrorSourceTrackUrl(
      decodedTrack,
      itag,
      forceRefresh
    )
    if (mirrored) return mirrored

    logger(
      'error',
      'YouTube',
      'Failed to get a working track URL from any configured client.'
    )
    return {
      loadType: 'error',
      exception: {
        message: 'Failed to get a working track URL from any client.',
        severity: 'fault',
        cause: 'All clients failed.'
      }
    }
  }
  /**
   * Attempts to resolve a track URL via alternative enabled sources when all
   * YouTube clients fail. Uses a debounce set to prevent infinite recursion.
   * @param decodedTrack - Track metadata to mirror.
   * @param itag - Optional specific format itag to request from the mirror source.
   * @param forceRefresh - Whether to bypass caches in the mirror source.
   * @returns Promise resolving to a track URL data with a `newTrack` redirect, or `null` on failure.
   */
  private async _tryMirrorSourceTrackUrl(
    decodedTrack: TrackInfo,
    itag?: number | null,
    forceRefresh = false
  ): Promise<TrackUrlData | null> {
    const key = `${decodedTrack?.identifier || ''}:${decodedTrack?.title || ''}:${decodedTrack?.author || ''}`
    if (this.mirrorFallbackInFlight.has(key)) return null

    const blockedFallbackSources = new Set([
      'amazonmusic',
      'anghami',
      'applemusic',
      'eternalbox',
      'flowery',
      'genius',
      'google-tts',
      'http',
      'instagram',
      'kwai',
      'lastfm',
      'lazypytts',
      'letrasmus',
      'local',
      'pandora',
      'pinterest',
      'pipertts',
      'reddit',
      'rss',
      'shazam',
      'songlink',
      'spotify',
      'telegram',
      'tidal',
      'twitch',
      'tumblr',
      'twitter',
      'vimeo'
    ])

    const configuredFallbackSources = Array.isArray(
      this.config?.fallbackSources
    )
      ? this.config.fallbackSources
      : []

    const opts = this.nodelink.options as unknown as Record<string, unknown>
    const searchConfig = opts.search as Record<string, unknown> | undefined
    const defaultSources = Array.isArray(searchConfig?.defaultSource)
      ? (searchConfig.defaultSource as string[])
      : [searchConfig?.defaultSource as string]

    const fallbackOrder = [
      ...configuredFallbackSources,
      ...defaultSources,
      'soundcloud',
      'deezer',
      'jiosaavn',
      'qobuz',
      'gaana',
      'vkmusic',
      'yandexmusic',
      'audiomack',
      'bandcamp',
      'audius',
      'mixcloud',
      'bilibili',
      'bluesky',
      'nicovideo'
    ].filter((name, index, arr) => {
      const source = this.nodelink.sources?.getSource(name)
      const sourcesConfig = (opts.sources ?? {}) as Record<
        string,
        { enabled?: boolean } | undefined
      >
      return (
        typeof name === 'string' &&
        name.length > 0 &&
        arr.indexOf(name) === index &&
        !['youtube', 'ytmusic'].includes(name) &&
        !blockedFallbackSources.has(name) &&
        sourcesConfig[name]?.enabled &&
        source &&
        !!source.search &&
        !!source.getTrackUrl
      )
    })

    if (fallbackOrder.length === 0) return null

    const query =
      `${decodedTrack?.title || ''} ${decodedTrack?.author || ''}`.trim()
    if (!query) return null

    this.mirrorFallbackInFlight.add(key)
    try {
      for (const fallbackSource of fallbackOrder) {
        try {
          const search = await this.nodelink.sources?.search(
            fallbackSource,
            query
          )
          if (
            search?.loadType !== 'search' ||
            !Array.isArray(search.data) ||
            search.data.length === 0
          ) {
            continue
          }

          const bestMatch = getBestMatch(search.data, decodedTrack)
          const bestInfo = (bestMatch as { info?: TrackInfo })?.info
          if (
            !bestInfo ||
            ['youtube', 'ytmusic'].includes(bestInfo.sourceName)
          ) {
            continue
          }

          const stream = await this.nodelink.sources?.getTrackUrl(
            bestInfo,
            itag ?? undefined,
            forceRefresh
          )
          if (!(stream as TrackUrlData)?.exception) {
            logger(
              'warn',
              'YouTube',
              `Fallback source succeeded via ${bestInfo.sourceName} for "${bestInfo.title}".`
            )
            return {
              ...(stream as TrackUrlData),
              newTrack: bestMatch as { info: TrackInfo }
            }
          }
        } catch (e) {
          logger(
            'debug',
            'YouTube',
            `Fallback source ${fallbackSource} failed: ${(e as Error).message}`
          )
        }
      }
    } finally {
      this.mirrorFallbackInFlight.delete(key)
    }

    return null
  }
  /**
   * Opens a readable audio stream for the given track.
   *
   * Dispatches to the appropriate protocol handler:
   * - `sabr` – SABR streaming with automatic stall recovery.
   * - `hls` – HLS manifest with n-token decryption.
   * - Direct HTTP – range-request streaming when content length is known,
   *   otherwise a simple single-stream download.
   *
   * @param decodedTrack - Track metadata.
   * @param url - Resolved playback URL (direct or manifest).
   * @param protocol - Streaming protocol identifier (`'sabr'`, `'hls'`, `'http'`, `'https'`).
   * @param additionalData - Protocol-specific metadata from {@link TrackUrlAdditionalData}.
   * @returns Promise resolving to a {@link StreamResult} with the readable stream or an exception.
   */
  async loadStream(
    decodedTrack: TrackInfo,
    url: string,
    protocol: string,
    additionalData?: TrackUrlAdditionalData
  ): Promise<StreamResult> {
    logger(
      'debug',
      'YouTube',
      `Loading stream for "${decodedTrack.title}" with protocol ${protocol}`
    )

    const cancelSignal: CancelSignal = { aborted: false }
    const streamKey: string | symbol =
      additionalData?.streamKey || Symbol('streamKey')
    this.activeStreams.set(streamKey, cancelSignal)

    try {
      if (protocol === 'sabr') {
        return await this._loadSabrStream(
          decodedTrack,
          additionalData ?? ({} as TrackUrlAdditionalData),
          cancelSignal,
          streamKey
        )
      }

      if (protocol === 'hls') {
        return this._loadHlsStream(url, cancelSignal, streamKey)
      }

      if (!url) throw new Error('No direct URL')

      let contentLength = additionalData?.contentLength ?? null

      if (!contentLength) {
        const testResponse = await http1makeRequest(url, {
          method: 'HEAD',
          timeout: 5000
        })

        const headers = testResponse.headers as Record<
          string,
          string | undefined
        >
        if (headers?.['content-length']) {
          contentLength = Number.parseInt(headers['content-length'] ?? '0', 10)
        }

        if (testResponse.statusCode === 403) {
          throw new Error('URL returned 403 Forbidden')
        }

        if (!contentLength) {
          const rangeResponse = await http1makeRequest(url, {
            method: 'GET',
            headers: { Range: 'bytes=0-0' },
            streamOnly: true,
            proxy: this.getProxy() as unknown as HttpProxyConfig
          })

          if (rangeResponse.stream)
            (
              rangeResponse.stream as NodeJS.ReadableStream & {
                destroy: () => void
              }
            ).destroy()

          const rangeHeaders = rangeResponse.headers as Record<
            string,
            string | undefined
          >
          if (rangeHeaders?.['content-range']) {
            const match = rangeHeaders['content-range']?.match(/\/(\d+)/)
            if (match) contentLength = Number.parseInt(match[1] ?? '0', 10)
          }
        }
      }

      if (contentLength && contentLength > 0) {
        logger(
          'debug',
          'YouTube',
          `Using Chunked HTTP buffering for ${decodedTrack.title} (${Math.round(contentLength / 1024 / 1024)}MB)`
        )
        return this._streamChunkedHttp(
          url,
          contentLength,
          decodedTrack,
          cancelSignal,
          streamKey,
          additionalData
        )
      }

      return await this._loadDirectStream(
        url,
        decodedTrack,
        cancelSignal,
        streamKey,
        additionalData
      )
    } catch (e) {
      this.activeStreams.delete(streamKey)
      logger(
        'error',
        'YouTube',
        `Error loading stream for ${decodedTrack.identifier}: ${(e as Error).message}`
      )
      return {
        exception: {
          message: (e as Error).message,
          severity: 'fault',
          cause: 'Upstream'
        }
      }
    }
  }
  /**
   * Creates a SABR streaming session with automatic stall recovery.
   *
   * Initializes a {@link SabrStream} instance with the track's session data,
   * pipes audio chunks through a PassThrough stream, and sets up a stall
   * recovery handler that refreshes the session on failure.
   *
   * @param decodedTrack - Track metadata for stall recovery URL refresh.
   * @param additionalData - SABR session data (tokens, config, formats).
   * @param _cancelSignal - Shared cancel token (unused; stream owns cancellation via destroy).
   * @param streamKey - Unique key for tracking this stream in the active streams map.
   * @returns Promise resolving to a {@link StreamResult} with the PassThrough stream and media type.
   */
  private async _loadSabrStream(
    decodedTrack: TrackInfo,
    additionalData: TrackUrlAdditionalData,
    _cancelSignal: CancelSignal,
    streamKey: string | symbol
  ): Promise<StreamResult> {
    const sabrConfig: SabrStreamConfig = {
      videoId: decodedTrack.identifier,
      accessToken: additionalData.accessToken,
      visitorData: additionalData.visitorData,
      serverAbrStreamingUrl: additionalData.serverAbrStreamingUrl,
      videoPlaybackUstreamerConfig: additionalData.videoPlaybackUstreamerConfig,
      poToken: additionalData.poToken,
      clientInfo: additionalData.clientInfo,
      formats: additionalData.formats,
      startTime: additionalData.startTime ?? 0,
      positionCallback: additionalData.positionCallback,
      playbackPaused: additionalData.playbackPaused,
      previousSession: additionalData.previousSession
    }
    const sabr = new SabrStream(sabrConfig)

    const stream = new PassThrough()
    let readyResolved = false
    let readyResolve: () => void
    let readyReject: (err: Error) => void
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve
      readyReject = reject
    })
    let isRecovering = false

    sabr.once('mediaProgress', () => {
      if (readyResolved) return
      readyResolved = true
      readyResolve()
    })

    sabr.on('data', (chunk: Buffer) => {
      if (!stream.write(chunk)) {
        sabr.pause()
      }
    })
    const onSabrDrain = () => sabr.resume()
    stream.on('drain', onSabrDrain)

    sabr.on('end', () => {
      if (!readyResolved) {
        readyResolved = true
        readyReject(new Error('SABR stream ended before data'))
      }
      stream.end()
    })
    sabr.on('finishBuffering', () => stream.emit('finishBuffering'))
    sabr.on(
      'stall',
      async (reason: string = 'starvation', recoveryGeneration?: number) => {
        if (isRecovering || stream.destroyed || sabr.destroyed) return

        isRecovering = true
        const generation =
          recoveryGeneration ?? sabr.getMediaProgressGeneration()
        try {
          logger(
            'warn',
            'YouTube',
            `SABR ${reason} recovery requested for ${decodedTrack.title}. Refreshing session...`
          )
          const newUrlData = await this.getTrackUrl(decodedTrack, null, true)
          if (newUrlData?.protocol !== 'sabr') {
            throw new Error('No SABR session available for recovery')
          }

          if (!sabr.canCommitRecovery(generation)) {
            logger(
              'debug',
              'YouTube',
              `Discarding stale SABR replacement for ${decodedTrack.title}; media advanced during recovery.`
            )
            sabr.cancelRecovery()
            return
          }

          const ad = (newUrlData.additionalData || {}) as TrackUrlAdditionalData
          sabr.clearBuffers()
          sabr.updateSession({
            serverAbrStreamingUrl: ad.serverAbrStreamingUrl || newUrlData.url,
            videoPlaybackUstreamerConfig: ad.videoPlaybackUstreamerConfig,
            poToken: ad.poToken,
            visitorData: ad.visitorData,
            clientInfo: ad.clientInfo,
            formats: ad.formats,
            userAgent: ad.userAgent,
            playbackCookie: ad.playbackCookie
          })
        } catch (err) {
          logger(
            'warn',
            'YouTube',
            `SABR recovery failed: ${(err as Error).message}`
          )
          if (!readyResolved) {
            readyResolved = true
            readyReject(err as Error)
            if (!stream.destroyed) stream.destroy()
          } else if (!stream.destroyed) {
            stream.destroy(err as Error)
          }
        } finally {
          isRecovering = false
        }
      }
    )
    sabr.on('error', async (err: Error) => {
      logger('error', 'YouTube', `SABR stream error: ${err.message}`)
      if (!readyResolved) {
        readyResolved = true
        readyReject(err)
        if (!stream.destroyed) stream.destroy()
        return
      }

      if (!stream.destroyed) stream.destroy(err)
    })

    const originalDestroy = stream.destroy.bind(stream)
    let isDestroying = false
    stream.destroy = ((err?: Error) => {
      if (isDestroying) return stream
      isDestroying = true
      stream.removeListener('drain', onSabrDrain)
      sabr.destroy(err)
      this.activeStreams.delete(streamKey)
      originalDestroy(err)
      return stream
    }) as typeof stream.destroy

    stream.once('close', () => {
      if (isDestroying) return
      isDestroying = true
      stream.removeListener('drain', onSabrDrain)
      sabr.destroy()
      this.activeStreams.delete(streamKey)
    })

    ;(stream as unknown as Record<string, unknown>)._sabrStream = sabr
    ;(stream as unknown as Record<string, unknown>).beginSeekHandoff = () => {
      if (isDestroying || stream.destroyed) return Promise.resolve(null)
      return sabr.beginSeekHandoff()
    }
    ;(stream as unknown as Record<string, unknown>).cancelSeekHandoff = () => {
      if (!isDestroying && !stream.destroyed) sabr.cancelSeekHandoff()
    }

    const bestAudio = (additionalData.formats ?? [])
      .filter((f) => f.mimeType?.includes('audio'))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]

    if (!bestAudio) {
      stream.destroy(new Error('No audio format available in SABR stream'))
      throw new Error('No audio format available in SABR stream')
    }

    sabr.start(bestAudio.itag)

    const type = bestAudio.mimeType?.includes('webm') ? 'webm/opus' : 'm4a'

    await ready
    return { stream, type }
  }
  /**
   * Creates an HLS stream handler for the given manifest URL.
   *
   * Configures n-token decryption for segment URLs and wires up
   * cancellation via the shared cancel signal.
   *
   * @param url - HLS manifest URL.
   * @param cancelSignal - Shared cancel token for stream abort.
   * @param streamKey - Unique key for tracking this stream in the active streams map.
   * @returns A {@link StreamResult} containing the HLS handler stream.
   */
  private _loadHlsStream(
    url: string,
    cancelSignal: CancelSignal,
    streamKey: string | symbol
  ): StreamResult {
    const playerScriptPromise = this.cipherManager.getCachedPlayerScript()
    const stream = new HLSHandler(url, {
      type: 'mpegts',
      localAddress: this.nodelink.routePlanner?.getIP?.(),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        Referer: 'https://www.youtube.com/',
        Origin: 'https://www.youtube.com'
      },
      onResolveUrl: async (segmentUrl: string): Promise<string | null> => {
        if (segmentUrl.includes('/n/')) {
          const nToken = segmentUrl.match(/\/n\/([^/]+)/)?.[1]
          const playerScript = await playerScriptPromise
          if (nToken && playerScript) {
            try {
              return await this.cipherManager.resolveUrl(
                segmentUrl,
                null,
                nToken,
                null,
                playerScript
              )
            } catch (err) {
              logger(
                'warn',
                'YouTube',
                `Failed to resolve n-token: ${(err as Error).message}`
              )
            }
          }
        }
        return null
      }
    })

    const originalDestroy = stream.destroy.bind(stream)
    stream.destroy = ((err?: Error) => {
      if (cancelSignal.aborted) return stream
      cancelSignal.aborted = true
      this.activeStreams.delete(streamKey)
      originalDestroy(err)
      return stream
    }) as typeof stream.destroy

    return { stream }
  }
  /**
   * Streams audio from a direct HTTP URL using a single-pass download.
   *
   * Pipes the raw HTTP response through a PassThrough stream with
   * back-pressure support, error handling, and proper cleanup on
   * stream close or destruction.
   *
   * @param url - Direct playback URL.
   * @param _decodedTrack - Track metadata (unused; reserved for future use).
   * @param cancelSignal - Shared cancel token for stream abort.
   * @param streamKey - Unique key for tracking this stream in the active streams map.
   * @param additionalData - Optional additional data containing proxy info.
   * @returns Promise resolving to a {@link StreamResult} with the PassThrough stream.
   */
  private async _loadDirectStream(
    url: string,
    _decodedTrack: TrackInfo,
    cancelSignal: CancelSignal,
    streamKey: string | symbol,
    additionalData?: TrackUrlAdditionalData
  ): Promise<StreamResult> {
    const fetchStartTime = Date.now()
    const response = await http1makeRequest(url, {
      method: 'GET',
      streamOnly: true,
      proxy: (additionalData?.proxy ||
        this.getProxy()) as unknown as HttpProxyConfig,
      timeout: 20000
    })

    this.reportProxyStatus(
      (additionalData?.proxy || this.getProxy(false)) as
        | ProxySnapshot
        | undefined,
      !response.error &&
        (response.statusCode === 200 || response.statusCode === 206),
      response.statusCode || 0,
      Date.now() - fetchStartTime
    )

    if (response.statusCode !== 200 && response.statusCode !== 206) {
      throw new Error(`HTTP status ${response.statusCode}`)
    }

    const responseStream = response.stream as NodeJS.ReadableStream & {
      destroyed: boolean
      destroy: () => void
      pause: () => void
      resume: () => void
      removeAllListeners: () => void
    }

    const stream = new PassThrough()
    ;(stream as unknown as Record<string, unknown>).responseStream =
      responseStream

    let cleanedUp = false
    const onDrain = () => {
      if (!responseStream.destroyed) responseStream.resume()
    }
    const cleanup = () => {
      if (cleanedUp) return
      cleanedUp = true
      cancelSignal.aborted = true
      stream.removeListener('drain', onDrain)
      responseStream.removeAllListeners()
      if (!responseStream.destroyed) responseStream.destroy()
      this.activeStreams.delete(streamKey)
      stream.removeListener('close', cleanup)
    }

    responseStream.on('data', (chunk: Buffer) => {
      if (!stream.write(chunk)) {
        responseStream.pause()
      }
    })

    stream.on('drain', onDrain)

    responseStream.on('end', () => {
      cleanup()
      if (!stream.writableEnded) {
        stream.emit('finishBuffering')
        stream.end()
      }
    })

    responseStream.on('error', (error: Error & { code?: string }) => {
      cleanup()

      if (error.message === 'aborted' || error.code === 'ECONNRESET') {
        logger('debug', 'YouTube', 'Client disconnected from stream')
        if (!stream.destroyed) stream.destroy()
        return
      }

      logger('error', 'YouTube', `Stream error: ${error.message}`)
      if (!stream.destroyed) {
        stream.emit('error', new Error(`Stream failed: ${error.message}`))
        stream.destroy()
      }
    })

    const originalDestroy = stream.destroy.bind(stream)
    stream.destroy = ((err?: Error) => {
      cleanup()
      originalDestroy(err)
      return stream
    }) as typeof stream.destroy

    stream.once('close', cleanup)

    return { stream }
  }
  /**
   * Streams audio using HTTP range requests with automatic URL recovery.
   *
   * Fetches the media in {@link CHUNK_SIZE} chunks, tracks the byte position,
   * and performs URL recovery when the upstream returns 403/404/5xx errors
   * or connection resets. Recovery attempts a fresh URL from `getTrackUrl`
   * and resumes from the last known position.
   *
   * @param url - Initial playback URL.
   * @param contentLength - Total content length in bytes.
   * @param decodedTrack - Track metadata used for URL recovery.
   * @param cancelSignal - Shared cancel token for stream abort.
   * @param streamKey - Unique key for tracking this stream in the active streams map.
   * @param additionalData - Optional additional data containing proxy info.
   * @returns A {@link StreamResult} containing the range-request PassThrough stream.
   */
  private _streamWithRangeRequests(
    url: string,
    contentLength: number,
    decodedTrack: TrackInfo,
    cancelSignal: CancelSignal,
    streamKey: string | symbol,
    additionalData?: TrackUrlAdditionalData
  ): StreamResult {
    const stream = new PassThrough({ highWaterMark: CHUNK_SIZE * 2 })
    let position = 0
    let errors = 0
    let refreshes = 0
    let currentUrl = url
    let destroyed = false
    let fetching = false
    let activeRequest:
      | (NodeJS.ReadableStream & {
          destroyed: boolean
          destroy: () => void
          pause: () => void
          resume: () => void
          removeListener: (
            event: string,
            listener: (...args: unknown[]) => void
          ) => void
          on: (event: string, listener: (...args: unknown[]) => void) => void
        })
      | null = null
    let recoverTimeout: ReturnType<typeof setTimeout> | null = null
    let currentAdditionalData = additionalData
    let currentItag = currentAdditionalData?.itag
    let availableFormats = currentAdditionalData?.formats || []
    const failedItags = new Set<number>()
    const _isRecovering = false

    const cleanup = () => {
      if (destroyed) return
      destroyed = true
      cancelSignal.aborted = true

      stream.removeListener('drain', onDrain)
      stream.removeListener('close', cleanup)
      stream.removeListener('end', cleanup)
      stream.removeListener('error', cleanup)

      if (activeRequest) {
        activeRequest.removeAllListeners()
        if (!activeRequest.destroyed) activeRequest.destroy()
        activeRequest = null
      }

      if (recoverTimeout) {
        clearTimeout(recoverTimeout)
        recoverTimeout = null
      }

      this.activeStreams.delete(streamKey)
    }

    const onDrain = () => {
      if (destroyed || cancelSignal.aborted) return
      if (activeRequest && !activeRequest.destroyed) {
        activeRequest.resume()
      }
      if (!fetching && position < contentLength) {
        fetchNext()
      }
    }

    stream.on('drain', onDrain)
    stream.once('close', cleanup)
    stream.once('end', cleanup)
    stream.once('error', cleanup)

    const fetchNext = async () => {
      if (destroyed || cancelSignal.aborted || stream.destroyed) {
        cleanup()
        return
      }

      if (position >= contentLength) {
        if (!stream.writableEnded) {
          stream.emit('finishBuffering')
          stream.end()
        }
        cleanup()
        return
      }

      if (fetching) return
      fetching = true

      const start = position
      const end = Math.min(start + CHUNK_SIZE - 1, contentLength - 1)

      try {
        const fetchStartTime = Date.now()
        const result = await http1makeRequest(currentUrl, {
          method: 'GET',
          headers: { Range: `bytes=${start}-${end}` },
          streamOnly: true,
          proxy: (currentAdditionalData?.proxy ||
            this.getProxy()) as unknown as HttpProxyConfig,
          timeout: 20000
        })

        const responseStream = result.stream as typeof activeRequest
        const { error, statusCode } = result

        this.reportProxyStatus(
          (currentAdditionalData?.proxy || this.getProxy(false)) as
            | ProxySnapshot
            | undefined,
          !error && (statusCode === 200 || statusCode === 206),
          statusCode || 0,
          Date.now() - fetchStartTime
        )

        if (destroyed || cancelSignal.aborted) {
          if (responseStream && !responseStream.destroyed) {
            responseStream.destroy()
          }
          fetching = false
          return
        }

        const rs = responseStream as NonNullable<typeof responseStream>
        activeRequest = rs

        if (error || (statusCode !== 200 && statusCode !== 206)) {
          if (
            statusCode === 403 ||
            statusCode === 404 ||
            (statusCode ?? 0) >= 500
          ) {
            logger(
              'warn',
              'YouTube',
              `Got ${statusCode} at pos ${position} → forcing recovery`
            )
            fetching = false
            recover({
              message: `HTTP ${statusCode}`,
              statusCode,
              name: 'Error'
            })
            return
          }
          throw new Error(`Range request failed: ${statusCode}`)
        }

        const onData = (chunk: Buffer) => {
          if (destroyed || cancelSignal.aborted) {
            rs.destroy()
            return
          }
          if (refreshes > 0) refreshes = 0
          position += chunk.length
          if (!stream.write(chunk)) {
            rs.pause()
          }
        }

        const onEnd = () => {
          cleanupRequestListeners()
          activeRequest = null
          fetching = false
          if (!destroyed && !cancelSignal.aborted && position < contentLength) {
            setImmediate(fetchNext)
          } else if (!stream.writableEnded && position >= contentLength) {
            stream.emit('finishBuffering')
            stream.end()
            cleanup()
          }
        }

        const onError = (err: Error & { code?: string }) => {
          cleanupRequestListeners()
          activeRequest = null
          fetching = false
          if (!destroyed && !cancelSignal.aborted) {
            logger(
              'warn',
              'YouTube',
              `Range request error at pos ${position}: ${err.message}`
            )
            const isAborted =
              err.message === 'aborted' || err.code === 'ECONNRESET'
            if (++errors >= MAX_RETRIES || isAborted) {
              if (isAborted)
                logger(
                  'warn',
                  'YouTube',
                  'Connection aborted, forcing immediate recovery with new URL.'
                )
              recover(err)
            } else {
              const timeout = setTimeout(
                fetchNext,
                Math.min(1000 * 2 ** (errors - 1), 5000)
              )
              timeout.unref?.()
            }
          }
        }

        const cleanupRequestListeners = () => {
          rs.removeListener('data', onData as (...args: unknown[]) => void)
          rs.removeListener('end', onEnd as (...args: unknown[]) => void)
          rs.removeListener('error', onError as (...args: unknown[]) => void)
        }

        rs.on('data', onData as (...args: unknown[]) => void)
        rs.on('end', onEnd as (...args: unknown[]) => void)
        rs.on('error', onError as (...args: unknown[]) => void)
      } catch (err) {
        activeRequest = null
        fetching = false
        if (!destroyed && !cancelSignal.aborted) {
          logger(
            'warn',
            'YouTube',
            `Range request exception at pos ${position}: ${(err as Error).message}`
          )
          const isAborted =
            (err as Error).message === 'aborted' ||
            (err as Error & { code?: string }).code === 'ECONNRESET'
          if (++errors >= MAX_RETRIES || isAborted) {
            if (isAborted)
              logger(
                'warn',
                'YouTube',
                'Connection aborted, forcing immediate recovery with new URL.'
              )
            recover(err as Error)
          } else {
            const timeout = setTimeout(
              fetchNext,
              Math.min(1000 * 2 ** (errors - 1), 5000)
            )
            timeout.unref?.()
          }
        }
      }
    }

    const recover = async (causeError?: Error & { statusCode?: number }) => {
      if (destroyed || cancelSignal.aborted) return

      const isForbidden =
        causeError?.message?.includes('403') || causeError?.statusCode === 403
      const isAborted =
        causeError?.message === 'aborted' ||
        (causeError as Error & { code?: string })?.code === 'ECONNRESET'

      if (!isForbidden && refreshes === 0) {
        logger(
          'debug',
          'YouTube',
          `Retrying same URL for recovery first (cause: ${causeError?.message})...`
        )
        errors = 0
        fetching = false
        fetchNext()
        refreshes++
        return
      }

      if (++refreshes > MAX_URL_REFRESH) {
        logger('error', 'YouTube', 'Max URL refresh attempts reached')
        if (!stream.destroyed) {
          stream.destroy(new Error('Failed to recover stream'))
        }
        return
      }

      if (stream.destroyed || stream.writableEnded) {
        cleanup()
        return
      }

      if (isAborted && stream.writableNeedDrain) {
        logger(
          'debug',
          'YouTube',
          `Stream is paused/backed up, waiting for drain before recovery (cause: ${causeError?.message})`
        )
        await new Promise<void>((resolve) => {
          const onDrainOrEnd = () => {
            cleanupListeners()
            resolve()
          }
          const cleanupListeners = () => {
            stream.off('drain', onDrainOrEnd)
            stream.off('close', onDrainOrEnd)
            stream.off('error', onDrainOrEnd)
          }
          stream.once('drain', onDrainOrEnd)
          stream.once('close', onDrainOrEnd)
          stream.once('error', onDrainOrEnd)
        })
        if (destroyed || cancelSignal.aborted || stream.destroyed) return
      }

      try {
        let itagToTry: number | null = null

        if (refreshes > 2 && currentItag) {
          failedItags.add(currentItag)
          logger(
            'warn',
            'YouTube',
            `Itag ${currentItag} failed consistently. Attempting quality fallback...`
          )

          const currentMime =
            currentAdditionalData?.formats?.find((f) => f.itag === currentItag)
              ?.mimeType || ''
          const isWebm = currentMime.includes('webm')

          const otherAudioFormats = availableFormats
            .filter(
              (f) =>
                f.itag !== currentItag &&
                !failedItags.has(f.itag) &&
                f.mimeType?.includes('audio') &&
                (isWebm
                  ? f.mimeType.includes('webm')
                  : f.mimeType.includes('mp4'))
            )
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))

          const bestFallback = otherAudioFormats[0]
          if (bestFallback) {
            itagToTry = bestFallback.itag as number
            logger(
              'info',
              'YouTube',
              `Switching to itag ${itagToTry} (available: ${otherAudioFormats.map((f) => f.itag).join(', ')})`
            )
          }
        }

        const newUrlData = await this.getTrackUrl(decodedTrack, itagToTry, true)

        if (destroyed || cancelSignal.aborted) return

        if (newUrlData.exception || !newUrlData.url) {
          throw new Error('No valid URL from getTrackUrl')
        }

        const oldContentLength =
          (currentAdditionalData?.contentLength as number | undefined) ||
          contentLength
        const newAdditionalData = newUrlData.additionalData as
          | TrackUrlAdditionalData
          | undefined
        const newContentLength = newAdditionalData?.contentLength as
          | number
          | undefined

        if (
          oldContentLength &&
          newContentLength &&
          oldContentLength !== newContentLength
        ) {
          const ratio = newContentLength / oldContentLength
          const oldPos = position
          position = Math.floor(position * ratio)
          contentLength = newContentLength
          logger(
            'debug',
            'YouTube',
            `Adjusted position for itag switch (${currentItag} -> ${newUrlData.itag || itagToTry}): ${oldPos} -> ${position} bytes (ratio: ${ratio.toFixed(4)})`
          )
        }

        currentUrl = newUrlData.url
        currentAdditionalData =
          newUrlData.additionalData as TrackUrlAdditionalData
        currentItag = newUrlData.itag || itagToTry || currentItag
        if (newUrlData.formats) availableFormats = newUrlData.formats

        errors = 0
        logger(
          'debug',
          'YouTube',
          `URL recovered for ${decodedTrack.title} (resume at ${position} bytes, attempt ${refreshes}, itag ${currentItag}, cause: ${causeError?.message})`
        )
        fetching = false
        fetchNext()
      } catch (error) {
        logger(
          'warn',
          'YouTube',
          `Recovery failed (attempt ${refreshes}): ${(error as Error).message}`
        )
        if (!destroyed && !cancelSignal.aborted) {
          recoverTimeout = setTimeout(
            () => recover(causeError),
            4000 + refreshes * 1000
          )
          recoverTimeout.unref?.()
        }
      }
    }

    fetchNext()

    const originalDestroy = stream.destroy.bind(stream)
    stream.destroy = ((err?: Error) => {
      cleanup()
      originalDestroy(err)
      return stream
    }) as typeof stream.destroy

    return { stream }
  }
  /**
   * Streams audio using chunked range requests. This tries to "Replicate" on how the browser
   * streams audio directly from youtube with code status 206.
   *
   * Uses dynamic chunk sizing (256 KB – 512 KB) based on per-stream bandwidth
   * The limit is around ~570 KB per chunk. But setted to 512KB for better memory efficiency.
   * Fast-reconnects on ECONNRESET without refreshing the URL until the third consecutive failure.
   * Opens only 1 connection per stream, reusing it for multiple chunks.
   * This is the same ideia used for _streamWithRangeRequests, but this tries to limit to 1 connection only.
   *
   *
   * @param url - Initial playback URL.
   * @param contentLength - Total content length in bytes.
   * @param decodedTrack - Track metadata for URL recovery.
   * @param cancelSignal - Shared cancel token for stream abort.
   * @param streamKey - Unique key for tracking this stream.
   * @param additionalData - Optional proxy and format info.
   * @returns StreamResult with the PassThrough stream.
   */
  private async _streamChunkedHttp(
    url: string,
    contentLength: number,
    decodedTrack: TrackInfo,
    cancelSignal: CancelSignal,
    streamKey: string | symbol,
    additionalData?: TrackUrlAdditionalData
  ): Promise<StreamResult> {
    const stream = new PassThrough({
      highWaterMark: STREAM_BUFFER_SIZE
    })

    let currentUrl = url
    let currentProxy = additionalData?.proxy as unknown as
      | HttpProxyConfig
      | undefined
    if (!currentProxy) {
      currentProxy = this.getProxy() as unknown as HttpProxyConfig
    }
    let urlFetchTime = Date.now()
    let isDestroyed = false
    let isBackpressured = false
    let totalBytesReceived = 0
    let currentItag = additionalData?.itag
    let availableFormats = additionalData?.formats || []
    const failedItags = new Set<number>()
    let refreshAttempts = 0
    let consecutiveResets = 0
    let activeResponseStream:
      | (NodeJS.ReadableStream & {
          destroyed: boolean
          destroy: () => void
          resume: () => void
          pause: () => void
        })
      | null = null

    let bandwidthEstimate = this.bandwidthEstimate || 128_000
    const updateBandwidthEstimate = (
      bytes: number,
      durationMs: number
    ): void => {
      if (bytes <= 0 || durationMs <= 0) return
      const bits = bytes * 8
      const throughput = (bits / durationMs) * 1000
      const alpha = 0.25
      bandwidthEstimate = Math.max(
        128_000,
        alpha * throughput + (1 - alpha) * bandwidthEstimate
      )
      // this will update the class-level bandwidth estimate for future streams,
      // so that it can be used to seed the estimate for new streams and cause less errors hopefully.
      this.bandwidthEstimate = bandwidthEstimate
    }

    const onDrain = () => {
      isBackpressured = false
      if (activeResponseStream && !activeResponseStream.destroyed) {
        activeResponseStream.resume()
      }
    }

    let _wakeUp: (() => void) | null = null
    const cancelSleep = () => {
      _wakeUp?.()
      _wakeUp = null
    }
    const sleep = (ms: number): Promise<void> =>
      new Promise<void>((r) => {
        const t = setTimeout(() => {
          _wakeUp = null
          r()
        }, ms)
        t.unref?.()
        _wakeUp = () => {
          clearTimeout(t)
          r()
        }
      })

    const cleanup = (err?: Error): void => {
      if (isDestroyed) return
      isDestroyed = true
      cancelSignal.aborted = true
      cancelSleep()
      stream.removeListener('drain', onDrain)

      if (activeResponseStream && !activeResponseStream.destroyed) {
        activeResponseStream.destroy()
        activeResponseStream = null
      }

      if (!stream.destroyed) stream.destroy(err)
      this.activeStreams.delete(streamKey)
    }

    // Waits for the PassThrough to drain after a backpressure-caused reset,
    // without leaving a dangling listener for whichever event didn't fire.
    const waitForDrainOrClose = (): Promise<void> =>
      new Promise<void>((resolve) => {
        const onReady = () => {
          stream.removeListener('drain', onReady)
          stream.removeListener('close', onReady)
          resolve()
        }
        stream.once('drain', onReady)
        stream.once('close', onReady)
      })

    stream.once('close', () => cleanup())
    stream.once('error', (err: Error) => cleanup(err))

    stream.on('drain', onDrain)

    const refreshUrl = async (reason: string): Promise<string | null> => {
      if (isDestroyed || cancelSignal.aborted) return null
      if (++refreshAttempts > MAX_URL_REFRESH) {
        logger(
          'error',
          'YouTube',
          `Max URL refresh (${MAX_URL_REFRESH}) reached for ${decodedTrack.title}`
        )
        return null
      }

      logger(
        'debug',
        'YouTube',
        `Refreshing URL for "${decodedTrack.title}" (reason: ${reason}, ${refreshAttempts}/${MAX_URL_REFRESH})`
      )

      try {
        let itagToTry: number | null = null
        if (
          currentItag &&
          failedItags.has(currentItag) &&
          availableFormats.length > 0
        ) {
          const currentMime =
            availableFormats.find((f) => f.itag === currentItag)?.mimeType || ''
          const isWebm = currentMime.includes('webm')
          const fallback = availableFormats
            .filter(
              (f) =>
                f.itag !== currentItag &&
                !failedItags.has(f.itag) &&
                f.mimeType?.includes('audio') &&
                (isWebm
                  ? f.mimeType.includes('webm')
                  : f.mimeType.includes('mp4'))
            )
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]

          if (fallback) {
            itagToTry = fallback.itag as number
            logger(
              'info',
              'YouTube',
              `Switching to itag ${itagToTry} for "${decodedTrack.title}"`
            )
          }
        }

        const newUrlData = await this.getTrackUrl(decodedTrack, itagToTry, true)
        if (isDestroyed || cancelSignal.aborted) return null
        if (newUrlData.exception || !newUrlData.url) return null

        currentUrl = newUrlData.url
        const newAd = newUrlData.additionalData as
          | TrackUrlAdditionalData
          | undefined
        currentProxy =
          (newAd?.proxy as unknown as HttpProxyConfig | undefined) ||
          currentProxy
        currentItag = newUrlData.itag || currentItag
        if (newUrlData.formats) availableFormats = newUrlData.formats
        urlFetchTime = Date.now()
        consecutiveResets = 0

        logger(
          'debug',
          'YouTube',
          `URL refreshed for "${decodedTrack.title}" (itag ${currentItag})`
        )
        return currentUrl
      } catch (err) {
        logger(
          'error',
          'YouTube',
          `URL refresh failed: ${(err as Error).message}`
        )
        return null
      }
    }

    const startStreaming = async (): Promise<void> => {
      const MIN_TARGET_SECONDS = 2
      const MAX_TARGET_SECONDS = 12
      const INITIAL_TARGET_SECONDS = 4
      let targetSeconds = INITIAL_TARGET_SECONDS

      const ABS_MIN_BYTES = 64 * 1024
      const ABS_MAX_BYTES = 512 * 1024

      const trackBytesPerSecond =
        contentLength > 0 && decodedTrack.length > 0
          ? contentLength / (decodedTrack.length / 1000)
          : 16_000

      let chunkCount = 0

      while (
        !isDestroyed &&
        !cancelSignal.aborted &&
        totalBytesReceived < contentLength
      ) {
        const urlAge = Date.now() - urlFetchTime
        if (urlAge > URL_MAX_AGE_MS) {
          const refreshed = await refreshUrl('URL age > 4.5h')
          if (!refreshed) {
            cleanup(new Error('Failed to refresh expired URL'))
            return
          }
        }

        const proxyToUse = currentProxy
        const fetchStartTime = Date.now()

        const bytesPerSecond = bandwidthEstimate / 8
        let dynamicChunkSize = Math.floor(bytesPerSecond * targetSeconds)
        dynamicChunkSize = Math.max(
          ABS_MIN_BYTES,
          Math.min(dynamicChunkSize, ABS_MAX_BYTES)
        )

        const start = totalBytesReceived
        const end = Math.min(start + dynamicChunkSize - 1, contentLength - 1)
        const rangeHeader = `bytes=${start}-${end}`

        try {
          const result = await http1makeRequest(currentUrl, {
            method: 'GET',
            streamOnly: true,
            proxy: proxyToUse,
            timeout: 30000,
            headers: {
              Range: rangeHeader,
              'Accept-Encoding': 'identity;q=1, *;q=0',
              'Sec-Fetch-Dest': 'video',
              'Sec-Fetch-Mode': 'no-cors',
              'Sec-Fetch-Site': 'same-origin',
              Referer: currentUrl,
              Accept: '*/*',
              'Accept-Language': 'en-US,en;q=0.9',
              'Cache-Control': 'no-cache',
              Pragma: 'no-cache',
              Priority: 'i'
            }
          })

          if (isDestroyed || cancelSignal.aborted) {
            const s = result.stream as NodeJS.ReadableStream & {
              destroyed?: boolean
              destroy: () => void
            }
            if (s && !s.destroyed) {
              s.destroy()
            }
            return
          }

          this.reportProxyStatus(
            proxyToUse as unknown as ProxySnapshot,
            !result.error && result.statusCode === 206,
            result.statusCode || 0,
            Date.now() - fetchStartTime
          )

          if (
            result.error ||
            (result.statusCode !== 200 && result.statusCode !== 206)
          ) {
            if (result.statusCode === 403 || result.statusCode === 404) {
              logger(
                'warn',
                'YouTube',
                `HTTP ${result.statusCode} for "${decodedTrack.title}" -- refreshing...`
              )
              if (currentItag) failedItags.add(currentItag)
              const refreshed = await refreshUrl(`HTTP ${result.statusCode}`)
              if (refreshed) continue
              cleanup(
                new Error(`HTTP ${result.statusCode}: max URL refresh reached`)
              )
              return
            }

            const retryDelay = Math.min(
              RECOVER_BASE_DELAY_MS * 2 ** Math.max(0, refreshAttempts - 1),
              MAX_RETRY_DELAY_MS
            )
            logger(
              'warn',
              'YouTube',
              `HTTP ${result.statusCode}, retrying in ${retryDelay}ms...`
            )
            await sleep(retryDelay)
            continue
          }

          const contentRangeHeader = result.headers?.['content-range']
          const contentRange = Array.isArray(contentRangeHeader)
            ? contentRangeHeader[0]
            : contentRangeHeader == null
              ? null
              : String(contentRangeHeader)
          const rangeMatch =
            result.statusCode === 206
              ? /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange ?? '')
              : null
          const responseStart = rangeMatch ? Number(rangeMatch[1]) : -1
          const responseEnd = rangeMatch ? Number(rangeMatch[2]) : -1

          if (
            result.statusCode !== 206 ||
            responseStart !== start ||
            responseEnd < responseStart ||
            responseEnd > end
          ) {
            const responseStream = result.stream as
              | (NodeJS.ReadableStream & { destroy?: () => void })
              | undefined
            responseStream?.destroy?.()
            logger(
              'warn',
              'YouTube',
              `Invalid range response for ${rangeHeader}: HTTP ${result.statusCode}, Content-Range ${contentRange ?? 'missing'}. Refreshing URL...`
            )
            const refreshed = await refreshUrl('invalid range response')
            if (refreshed) continue
            cleanup(new Error('Invalid HTTP range response'))
            return
          }

          const responseStream = result.stream as NodeJS.ReadableStream & {
            destroyed: boolean
            destroy: () => void
            pause: () => void
            resume: () => void
          }

          activeResponseStream = responseStream
          let bytesThisChunk = 0
          let dataStartTime = 0

          await new Promise<void>((resolve, reject) => {
            if (isDestroyed || cancelSignal.aborted) {
              if (!responseStream.destroyed) responseStream.destroy()
              return resolve()
            }

            const onData = (chunk: Buffer) => {
              if (isDestroyed || cancelSignal.aborted) {
                responseStream.destroy()
                return
              }
              if (dataStartTime === 0) dataStartTime = Date.now()
              bytesThisChunk += chunk.length
              totalBytesReceived += chunk.length
              if (!stream.write(chunk)) {
                isBackpressured = true
                responseStream.pause()
              }
            }

            const onEnd = () => {
              responseStream.removeListener('data', onData)
              responseStream.removeListener('error', onError)
              activeResponseStream = null
              resolve()
            }

            const onError = (err: Error) => {
              responseStream.removeListener('data', onData)
              responseStream.removeListener('end', onEnd)
              activeResponseStream = null
              if (isDestroyed || cancelSignal.aborted) resolve()
              else reject(err)
            }

            responseStream.once('end', onEnd)
            responseStream.once('error', onError)
            responseStream.on('data', onData)
          })

          if (!responseStream.destroyed) {
            responseStream.destroy()
          }

          const transferDuration = dataStartTime
            ? Date.now() - dataStartTime
            : Date.now() - fetchStartTime
          updateBandwidthEstimate(bytesThisChunk, transferDuration)

          chunkCount++
          if (chunkCount <= 2) {
            targetSeconds = MIN_TARGET_SECONDS
          } else if (chunkCount <= 5) {
            targetSeconds = INITIAL_TARGET_SECONDS
          } else {
            const estimatedSecondsInChunk = bytesThisChunk / trackBytesPerSecond
            if (estimatedSecondsInChunk >= targetSeconds * 0.8) {
              targetSeconds = Math.min(targetSeconds + 2, MAX_TARGET_SECONDS)
            } else {
              targetSeconds = Math.max(targetSeconds - 2, MIN_TARGET_SECONDS)
            }
          }

          /*
          logger(
            'debug',
            'YouTube',
            `Chunk #${chunkCount} complete: ${bytesThisChunk} bytes in ${Date.now() - fetchStartTime}ms (${totalBytesReceived}/${contentLength} total, target=${targetSeconds}s)`
          ) */
          // i was using this for debugging, so i will keep this commented incase i need it later.

          if (totalBytesReceived >= contentLength) {
            if (!stream.writableEnded) {
              stream.emit('finishBuffering')
              stream.end()
            }
            return
          }

          consecutiveResets = 0
          isBackpressured = false
        } catch (err) {
          if (isDestroyed || cancelSignal.aborted) return
          const error = err as Error & { code?: string }

          if (
            error.code === 'ECONNRESET' ||
            error.code === 'ERR_STREAM_DESTROYED'
          ) {
            bandwidthEstimate = Math.max(128_000, bandwidthEstimate * 0.7)

            if (isBackpressured) {
              consecutiveResets = 0
              isBackpressured = false
              logger(
                'debug',
                'YouTube',
                `Buffer-drain recovery at ${totalBytesReceived} bytes (consecutive resets cleared).`
              )
              if (stream.writableLength > 0) {
                await waitForDrainOrClose()
              }
              continue
            }

            logger(
              'warn',
              'YouTube',
              `Connection reset at ${totalBytesReceived} bytes.`
            )

            // Try same URL first (it's probably still valid) since it takes ~6 hours for an URL to expire
            const retryDelay = Math.min(250 * 2 ** consecutiveResets, 1000)
            consecutiveResets++
            logger(
              'warn',
              'YouTube',
              `Retrying same URL in ${retryDelay}ms (consecutive reset ${consecutiveResets})...`
            )
            await sleep(retryDelay)

            if (consecutiveResets >= 3) {
              logger(
                'warn',
                'YouTube',
                `Same URL failed ${consecutiveResets} times, refreshing...`
              )
              consecutiveResets = 0
              const refreshed = await refreshUrl(
                'multiple ECONNRESET on same URL'
              )
              if (refreshed) continue
              cleanup(new Error('ECONNRESET: max URL refresh reached'))
              return
            } else {
              continue
            }
          }

          if (
            error.message?.includes('403') ||
            error.message?.includes('404')
          ) {
            if (currentItag) failedItags.add(currentItag)
            const refreshed = await refreshUrl('mid-stream 403/404')
            if (refreshed) continue
            cleanup(new Error('mid-stream 403/404: max URL refresh reached'))
            return
          }

          const retryDelay = Math.min(
            RECOVER_BASE_DELAY_MS * 2 ** Math.max(0, refreshAttempts - 1),
            MAX_RETRY_DELAY_MS
          )
          logger(
            'warn',
            'YouTube',
            `Stream error for "${decodedTrack.title}": ${error.message}. Retrying in ${retryDelay}ms...`
          )
          await sleep(retryDelay)
        }
      }
    }

    startStreaming().catch((err: Error) => {
      logger('error', 'YouTube', `Fatal streaming error: ${err.message}`)
      cleanup(err)
    })

    return { stream }
  }
  /**
   * Fetches chapter markers for a track using the Web client.
   * @param trackInfo - Track metadata containing the video identifier.
   * @returns Promise resolving to an array of chapter objects, or an empty array on failure.
   */
  async getChapters(trackInfo: TrackInfo): Promise<unknown[]> {
    const webClient = this.clients.Web
    if (!webClient) {
      logger(
        'warn',
        'YouTube',
        'Web client not available for fetching chapters.'
      )
      return []
    }

    try {
      return (await webClient.getChapters?.(trackInfo, this.ytContext)) ?? []
    } catch (e) {
      logger(
        'error',
        'YouTube',
        `Failed to fetch chapters: ${(e as Error).message}`
      )
      return []
    }
  }
  /**
   * Handles a new live chat WebSocket connection for the given track.
   * @param socket - WebSocket connection object from the framework.
   * @param id - YouTube video identifier for the live stream.
   * @returns Promise resolving when the live chat handler completes.
   */
  async handleLiveChat(socket: unknown, id: string): Promise<unknown> {
    return this.liveChat.handleConnection(socket as YouTubeLiveChatSocket, id)
  }
}
