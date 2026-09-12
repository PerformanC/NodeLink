import crypto from 'node:crypto'
import type { AmazonMusicSourceConfig } from '../typings/config/config.types.ts'
import type {
  SourceInstance,
  SourceResult,
  TrackInfo,
  TrackStreamResult,
  TrackUrlResult,
  WorkerNodeLink
} from '../typings/sources/source.types.ts'
import {
  encodeTrack,
  getBestMatch,
  http1makeRequest,
  logger
} from '../utils.ts'

/**
 * User agent string used for general browsing and scraping operations.
 * @internal
 */
const BOT_USER_AGENT =
  'Mozilla/5.0 (compatible; NodeLinkBot/0.1; +https://nodelink.js.org/)'

/**
 * User agent string specifically for search and Cosmic API requests.
 * @internal
 */
const SEARCH_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'

/**
 * Fallback device identifier used when the official configuration is unavailable.
 * @internal
 */
const FALLBACK_DEVICE_ID = '13580682033287541'

/**
 * Fallback session identifier used when the official configuration is unavailable.
 * @internal
 */
const FALLBACK_SESSION_ID = '142-4001091-4160417'

/**
 * Duration in milliseconds for which the Amazon Music configuration is cached.
 * @internal
 */
const CONFIG_TTL_MS = 60_000

/**
 * Duration in milliseconds for which track metadata is cached.
 * @internal
 */
const META_CACHE_TTL_MS = 300_000

/**
 * Maximum number of entries in the metadata cache.
 * @internal
 */
const META_CACHE_MAX = 200

/**
 * Internal Amazon Music configuration metadata retrieved from the music portal.
 * @internal
 */
interface AmazonConfig {
  /** The OAuth access token for authenticated requests. */
  accessToken: string
  /** CSRF tokens and timestamps required for state-changing operations. */
  csrf: {
    /** The actual CSRF token string. */
    token: string
    /** The timestamp of the token generation. */
    ts: string
    /** A random nonce used for signature verification. */
    rnd: string
  }
  /** The unique device identifier assigned to the web client. */
  deviceId: string
  /** The current session identifier for the web portal. */
  sessionId: string
}

/**
 * Response shape for Odesli (Songlink) API.
 * @internal
 */
interface OdesliResponse {
  entityUniqueId: string
  entitiesByUniqueId: Record<
    string,
    {
      title: string
      artistName: string
      thumbnailUrl: string
      id: string
      isrc?: string
    }
  >
}

/**
 * Cached track metadata including duration and ISRC.
 * @internal
 */
interface TrackMeta {
  duration: number
  isrc: string | null
}

/**
 * Cache entry for track metadata with timestamp.
 * @internal
 */
interface MetaCacheEntry {
  t: number
  v: TrackMeta
}

/**
 * Amazon Music source implementation.
 * Integrates with the Amazon Music web interface and the Cosmic API for resource resolution and search.
 * Provides fallback resolution via Odesli when native scraping fails.
 * @public
 */
export default class AmazonMusicSource implements SourceInstance {
  /**
   * The global worker NodeLink context.
   * @internal
   */
  private readonly nodelink: WorkerNodeLink

  /**
   * The configuration bucket for Amazon Music.
   * @internal
   */
  private readonly config: AmazonMusicSourceConfig

  /**
   * Prefixes used to identify search queries targeting this source.
   * @public
   */
  public readonly searchTerms = ['amazonmusic', 'azsearch']

  /**
   * Regular expression patterns used to match Amazon Music and Retail URLs.
   * @public
   */
  public readonly patterns = [
    /https?:\/\/music\.amazon\.[a-z.]+\/(?:.*\/)?(track|album|playlist|artist)s?\/([a-z0-9]+)/i,
    /https?:\/\/(?:www\.)?amazon\.[a-z.]+\/dp\/([a-z0-9]+)/i
  ]

  /**
   * Matching priority for this source.
   * @public
   */
  public readonly priority = 100

  /**
   * Cached internal API configuration data.
   * @internal
   */
  private configCache: { t: number; v: AmazonConfig } | null = null

  /**
   * Pending configuration promise to prevent duplicate concurrent initialization requests.
   * @internal
   */
  private configPromise: Promise<AmazonConfig | null> | null = null

  /**
   * Cache for track metadata (duration and ISRC).
   * @internal
   */
  private metaCache: Map<string, MetaCacheEntry> = new Map()

  /**
   * In-flight metadata fetch promises to deduplicate concurrent requests.
   * @internal
   */
  private metaInflight: Map<string, Promise<TrackMeta>> = new Map()

  /**
   * Constructs a new AmazonMusicSource instance.
   * @param nodelink - The worker NodeLink context.
   */
  constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
    this.config = (nodelink.options.sources?.amazonmusic || {
      enabled: false,
      playlistLoadLimit: 0,
      albumLoadLimit: 0
    }) as AmazonMusicSourceConfig
  }

  /**
   * Performs source-level initialization.
   * @returns A promise resolving to true.
   * @public
   */
  public async setup(): Promise<boolean> {
    return true
  }

  /**
   * Retrieves and caches the internal Amazon Music configuration.
   * Fetches the official config.json from the music portal to obtain tokens and identifiers.
   * @returns A promise resolving to the AmazonConfig or null if initialization failed.
   * @internal
   */
  private async getAmazonConfig(): Promise<AmazonConfig | null> {
    const now = Date.now()
    if (this.configCache && now - this.configCache.t < CONFIG_TTL_MS)
      return this.configCache.v
    if (this.configPromise) return this.configPromise

    this.configPromise = (async () => {
      const res = await http1makeRequest(
        'https://music.amazon.com/config.json',
        {
          headers: { 'User-Agent': SEARCH_USER_AGENT }
        }
      )
      if (res.statusCode !== 200) return null

      const cfg =
        typeof res.body === 'string'
          ? JSON.parse(res.body)
          : (res.body as Record<string, unknown>)
      if (!cfg?.csrf?.token) return null

      const v: AmazonConfig = {
        accessToken: cfg.accessToken || '',
        csrf: cfg.csrf,
        deviceId:
          cfg.deviceId && !cfg.deviceId.startsWith('000')
            ? cfg.deviceId
            : FALLBACK_DEVICE_ID,
        sessionId:
          cfg.sessionId && !cfg.sessionId.startsWith('000')
            ? cfg.sessionId
            : FALLBACK_SESSION_ID
      }
      this.configCache = { t: Date.now(), v }
      return v
    })()

    try {
      return await this.configPromise
    } finally {
      this.configPromise = null
    }
  }

  /**
   * Constructs the CSRF header payload required by the Amazon Music Cosmic API.
   * @param csrf - The CSRF configuration obtained from the portal.
   * @returns The serialized CSRF header string.
   * @internal
   */
  private buildCsrfHeader(csrf: AmazonConfig['csrf']): string {
    return JSON.stringify({
      interface: 'CSRFInterface.v1_0.CSRFHeaderElement',
      token: csrf.token,
      timestamp: csrf.ts,
      rndNonce: csrf.rnd
    })
  }

  /**
   * Builds common Amazon Music API headers.
   * @param cfg - The Amazon configuration.
   * @param pageUrl - The page URL for the request context.
   * @returns Headers object for Amazon Music API requests.
   * @internal
   */
  private buildAmznHeaders(
    cfg: AmazonConfig,
    pageUrl: string
  ): Record<string, string> {
    return {
      'x-amzn-authentication': JSON.stringify({
        interface: 'ClientAuthenticationInterface.v1_0.ClientTokenElement',
        accessToken: cfg.accessToken
      }),
      'x-amzn-device-model': 'WEBPLAYER',
      'x-amzn-device-width': '1920',
      'x-amzn-device-height': '1080',
      'x-amzn-device-family': 'WebPlayer',
      'x-amzn-device-id': cfg.deviceId,
      'x-amzn-user-agent': SEARCH_USER_AGENT,
      'x-amzn-session-id': cfg.sessionId,
      'x-amzn-request-id': crypto.randomUUID(),
      'x-amzn-device-language': 'en_US',
      'x-amzn-currency-of-preference': 'USD',
      'x-amzn-os-version': '1.0',
      'x-amzn-application-version': '1.0.10905.0',
      'x-amzn-device-time-zone': 'America/New_York',
      'x-amzn-timestamp': String(Date.now()),
      'x-amzn-csrf': this.buildCsrfHeader(cfg.csrf),
      'x-amzn-music-domain': 'music.amazon.com',
      'x-amzn-page-url': pageUrl,
      'x-amzn-feature-flags': 'hd-supported,uhd-supported',
      'x-amnz-age-band': 'ADULT',
      'x-amzn-has-profile-id': 'true'
    }
  }

  /**
   * Extracts the origin from a URL.
   * @param url - The URL to extract origin from.
   * @returns The origin or fallback to default.
   * @internal
   */
  private extractOrigin(url: string): string {
    try {
      return new URL(url).origin
    } catch {
      return 'https://music.amazon.com'
    }
  }

  /**
   * Resolves an Amazon Music URL to its corresponding audio resource.
   * Handles individual tracks, albums, playlists, and artist profiles.
   * @param url - The canonical Amazon Music or Retail URL.
   * @returns A promise resolving to a SourceResult.
   * @public
   */
  public async resolve(url: string): Promise<SourceResult> {
    try {
      const pattern1 = this.patterns[0]
      const pattern2 = this.patterns[1]
      if (!pattern1 || !pattern2) return { loadType: 'empty', data: {} }

      const match = url.match(pattern1) || url.match(pattern2)
      if (!match) return { loadType: 'empty', data: {} }

      let [, type, id] = match
      if (!id) {
        id = type
        type = 'track'
      }

      if (!id) return { loadType: 'empty', data: {} }

      const trackAsin = this.extractTrackAsinParam(url)
      if (trackAsin) return await this.resolveTrack(url, trackAsin)

      if (type === 'track' || type === 'dp')
        return await this.resolveTrack(url, id)
      if (type === 'album') return await this.resolveAlbum(url, id)
      if (type === 'playlist') return await this.resolvePlaylist(url, id)
      if (type === 'artist') return await this.resolveArtist(url, id)

      return { loadType: 'empty', data: {} }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger('error', 'AmazonMusic', `Resolution failed: ${message}`)
      return {
        loadType: 'error',
        exception: { message, severity: 'fault' }
      }
    }
  }

  /**
   * Retrieves track metadata (duration and ISRC) from the Amazon Cosmic API.
   * Uses caching and request deduplication for efficiency.
   * @param trackId - The track's Amazon Standard Identification Number (ASIN).
   * @returns A promise resolving to track metadata.
   * @internal
   */
  private async fetchTrackMetaFromAPI(trackId: string): Promise<TrackMeta> {
    const cached = this.metaCache.get(trackId)
    if (cached && Date.now() - cached.t < META_CACHE_TTL_MS) return cached.v

    const inflight = this.metaInflight.get(trackId)
    if (inflight) return inflight

    const promise = this.fetchTrackMetaFromAPIUncached(trackId)
    this.metaInflight.set(trackId, promise)

    try {
      const result = await promise
      if (this.metaCache.size >= META_CACHE_MAX) {
        const oldest = this.metaCache.keys().next().value
        if (oldest) this.metaCache.delete(oldest)
      }
      this.metaCache.set(trackId, { t: Date.now(), v: result })
      return result
    } finally {
      this.metaInflight.delete(trackId)
    }
  }

  /**
   * Fetches track metadata from the API without caching.
   * @param trackId - The track's Amazon Standard Identification Number (ASIN).
   * @returns A promise resolving to track metadata.
   * @internal
   */
  private async fetchTrackMetaFromAPIUncached(
    trackId: string
  ): Promise<TrackMeta> {
    try {
      const cfg = await this.getAmazonConfig()
      if (!cfg) return { duration: 0, isrc: null }

      const headersObj = {
        ...this.buildAmznHeaders(
          cfg,
          `https://music.amazon.com/tracks/${trackId}`
        ),
        'x-amzn-referer': '',
        'x-amzn-affiliate-tags': '',
        'x-amzn-ref-marker': '',
        'x-amzn-weblab-id-overrides': '',
        'x-amzn-video-player-token': '',
        'x-amzn-has-profile-id': '',
        'x-amzn-age-band': ''
      }

      const payloadStr = JSON.stringify({
        id: trackId,
        userHash: '{"level":"LIBRARY_MEMBER"}',
        headers: JSON.stringify(headersObj)
      })

      const response = await http1makeRequest(
        'https://na.mesk.skill.music.a2z.com/api/cosmicTrack/displayCatalogTrack',
        {
          method: 'POST',
          body: payloadStr,
          disableBodyCompression: true,
          headers: {
            'User-Agent': SEARCH_USER_AGENT,
            'Content-Type': 'text/plain;charset=UTF-8',
            Origin: 'https://music.amazon.com'
          }
        }
      )

      if (response.statusCode !== 200) return { duration: 0, isrc: null }

      const data =
        typeof response.body === 'string'
          ? JSON.parse(response.body)
          : (response.body as Record<string, unknown>)

      logger(
        'debug',
        'AmazonMusic',
        `API response keys: ${JSON.stringify(Object.keys(data || {}))}`
      )

      let duration = 0
      const t = (
        data as { methods?: { template?: { headerTertiaryText?: string } }[] }
      )?.methods?.[0]?.template?.headerTertiaryText
      if (t) {
        duration = this.parseTimeStringToMs(t)
        if (duration <= 0) duration = 0
      }

      let isrc: string | null = null
      const findIsrc = (obj: unknown, depth = 0): void => {
        if (!obj || typeof obj !== 'object' || isrc || depth > 15) return
        const record = obj as Record<string, unknown>

        if (typeof record.isrcCode === 'string' && record.isrcCode) {
          isrc = record.isrcCode
          return
        }

        if (typeof record.innerHTML === 'string') {
          try {
            const parsed = JSON.parse(record.innerHTML) as Record<
              string,
              unknown
            >
            if (typeof parsed?.isrcCode === 'string' && parsed.isrcCode) {
              isrc = parsed.isrcCode
              return
            }
          } catch {}
        }

        for (const v of Object.values(record)) {
          findIsrc(v, depth + 1)
          if (isrc) return
        }
      }
      findIsrc(data)

      logger('debug', 'AmazonMusic', `Extracted ISRC for ${trackId}: ${isrc}`)
      return { duration, isrc }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger(
        'warn',
        'AmazonMusic',
        `Failed to fetch meta for ${trackId}: ${message}`
      )
      return { duration: 0, isrc: null }
    }
  }

  /**
   * Resolves a single track identifier into normalized metadata.
   * @param url - The track URL.
   * @param id - The track identifier (ASIN).
   * @returns A promise resolving to a SourceResult.
   * @internal
   */
  private async resolveTrack(url: string, id: string): Promise<SourceResult> {
    const data = await this.fetchJsonLd(url, id)
    if (data?.loadType === 'track' && data.data?.info) {
      if (data.data.info.length === 0 || !data.data.info.isrc) {
        logger(
          'debug',
          'AmazonMusic',
          `Fetching API meta for ${id} (length=${data.data.info.length}, isrc=${data.data.info.isrc})`
        )
        const meta = await this.fetchTrackMetaFromAPI(id)
        logger(
          'debug',
          'AmazonMusic',
          `API meta result: duration=${meta.duration}, isrc=${meta.isrc}`
        )
        if (meta.duration > 0) data.data.info.length = meta.duration
        if (meta.isrc) data.data.info.isrc = meta.isrc
        data.data.encoded = encodeTrack({ ...data.data.info, details: [] })
      }
      return data
    }
    return await this.fallbackToOdesli(url, id)
  }

  /**
   * Resolves an album URL and returns its track collection.
   * @param url - The album URL.
   * @param id - The album identifier.
   * @returns A promise resolving to a SourceResult.
   * @internal
   */
  private async resolveAlbum(url: string, id: string): Promise<SourceResult> {
    const data = await this.fetchJsonLd(url)
    if (data?.loadType === 'playlist') return data
    return await this.fallbackToOdesli(url, id)
  }

  /**
   * Resolves a playlist URL and returns its track collection.
   * @param url - The playlist URL.
   * @param id - The playlist identifier.
   * @returns A promise resolving to a SourceResult.
   * @internal
   */
  private async resolvePlaylist(
    url: string,
    id: string
  ): Promise<SourceResult> {
    const data = await this.fetchJsonLd(url)
    if (data?.loadType === 'playlist') return data
    return await this.fallbackToOdesli(url, id)
  }

  /**
   * Resolves an artist profile URL and returns their top tracks.
   * @param url - The artist URL.
   * @param id - The artist identifier.
   * @returns A promise resolving to a SourceResult.
   * @internal
   */
  private async resolveArtist(url: string, id: string): Promise<SourceResult> {
    const data = await this.fetchJsonLd(url)
    if (data?.loadType === 'playlist') return data
    return await this.fallbackToOdesli(url, id)
  }

  /**
   * Scrapes and parses JSON-LD metadata from Amazon Music HTML documents.
   * Handles various schema types including MusicAlbum, MusicGroup, and MusicRecording.
   * @param url - The page URL to scrape.
   * @param targetId - Optional identifier to target a specific track within a collection.
   * @returns A promise resolving to a SourceResult or null if scraping failed.
   * @internal
   */
  private async fetchJsonLd(
    url: string,
    targetId?: string
  ): Promise<SourceResult | null> {
    const origin = this.extractOrigin(url)

    try {
      const { body, statusCode } = await http1makeRequest(url, {
        headers: { 'User-Agent': BOT_USER_AGENT }
      })
      if (statusCode !== 200 || typeof body !== 'string') return null

      const headerArtist = body
        .match(/<music-detail-header[^>]*primary-text="([^"]+)"/)?.[1]
        ?.replaceAll('&amp;', '&')
      const headerImage = body.match(
        /<music-detail-header[^>]*image-src="([^"]+)"/
      )?.[1]
      const ogImageMatch = body.match(
        /<meta property="og:image" content="([^"]+)"/
      )
      const artworkUrl = headerImage || (ogImageMatch ? ogImageMatch[1] : null)

      const jsonLdMatches = body.matchAll(
        /<script [^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g
      )

      interface AmazonJsonLdEntity {
        '@type': string
        name: string
        duration?: string
        image?: string
        id?: string
        '@id'?: string
        url?: string
        isrcCode?: string
        byArtist?: { name: string } | { name: string }[]
        author?: { name: string }
        track?: AmazonJsonLdEntity[]
      }

      let collection: AmazonJsonLdEntity | null = null
      let trackData: AmazonJsonLdEntity | null = null

      for (const match of jsonLdMatches) {
        try {
          const content = match[1]
            ?.replaceAll('&quot;', '"')
            .replaceAll('&amp;', '&')
          if (!content) continue
          const parsed = JSON.parse(content)
          const entries = Array.isArray(parsed) ? parsed : [parsed]
          for (const data of entries as AmazonJsonLdEntity[]) {
            if (
              ['MusicAlbum', 'MusicGroup', 'Playlist'].includes(data['@type'])
            ) {
              collection = data
            } else if (data['@type'] === 'MusicRecording') {
              trackData = data
            }
          }
        } catch (e) {
          logger(
            'debug',
            'AmazonMusic',
            `JSON-LD parse error: ${e instanceof Error ? e.message : String(e)}`
          )
        }
      }

      const tracks: TrackInfo[] = []
      let collectionName = headerArtist || 'Unknown Artist'
      let collectionImage = artworkUrl

      if (collection) {
        const artistName =
          (Array.isArray(collection.byArtist)
            ? collection.byArtist[0]?.name
            : (collection.byArtist as { name: string } | undefined)?.name) ||
          collection.author?.name
        if (artistName) collectionName = artistName
        if (collection.image) collectionImage = collection.image
      }

      if (collection?.track) {
        for (const t of collection.track) {
          const id =
            t.url?.split('/').pop() ||
            t['@id']?.split('/').pop() ||
            `am-${Buffer.from(t.name).toString('hex')}`
          tracks.push({
            identifier: id,
            isSeekable: true,
            author:
              (Array.isArray(t.byArtist)
                ? (t.byArtist as { name: string }[])[0]?.name
                : (t.byArtist as { name: string } | undefined)?.name) ||
              t.author?.name ||
              collectionName,
            length: this.parseISO8601Duration(t.duration),
            isStream: false,
            position: 0,
            title: t.name,
            uri: t.url || url,
            artworkUrl: collectionImage ?? null,
            isrc: t.isrcCode || null,
            sourceName: 'amazonmusic'
          })
        }
      }

      if (tracks.length === 0) {
        const rowMatches = body.matchAll(
          /<(music-image-row|music-text-row)[^>]*primary-text="([^"]+)"[^>]*primary-href="([^"]+)"(?:[^>]*secondary-text-1="([^"]+)")?[^>]*duration="([^"]+)"(?:[^>]*image-src="([^"]+)")?/g
        )
        for (const m of rowMatches) {
          const tTitle = m[2]?.replaceAll('&amp;', '&')
          if (!tTitle) continue
          const tHref = m[3]
          const tArtist = (m[4] || collectionName).replaceAll('&amp;', '&')
          const tDuration = m[5]
          const tImage = m[6] || collectionImage
          const tId =
            this.extractIdentifier(tHref) ||
            `am-${Buffer.from(tTitle).toString('hex')}`

          tracks.push({
            identifier: tId,
            isSeekable: true,
            author: tArtist,
            length: tDuration?.includes(':')
              ? this.parseColonDurationToMs(tDuration)
              : 0,
            isStream: false,
            position: 0,
            title: tTitle,
            uri: `${origin}/tracks/${tId}`,
            artworkUrl: tImage ?? null,
            isrc: null,
            sourceName: 'amazonmusic'
          })
        }
      }

      if (tracks.length > 0) {
        if (targetId) {
          const selected = tracks.find(
            (t) =>
              t.identifier === targetId ||
              t.uri.endsWith(`/${targetId}`) ||
              t.uri.endsWith(`=${targetId}`)
          )
          if (selected)
            return {
              loadType: 'track',
              data: {
                encoded: encodeTrack({ ...selected, details: [] }),
                info: selected,
                pluginInfo: {} as Record<string, unknown>
              }
            }
        }
        const first = tracks[0]
        if (url.includes('/tracks/') && !targetId && first) {
          return {
            loadType: 'track',
            data: {
              encoded: encodeTrack({ ...first, details: [] }),
              info: first,
              pluginInfo: {} as Record<string, unknown>
            }
          }
        }

        let collectionType = 'playlist'
        if (collection) {
          if (collection['@type'] === 'MusicAlbum') collectionType = 'album'
          if (collection['@type'] === 'MusicGroup') collectionType = 'artist'
        }

        return {
          loadType: collectionType as 'playlist' | 'album' | 'artist',
          data: {
            info: { name: collectionName, selectedTrack: 0 },
            tracks: tracks.map((t) => ({
              encoded: encodeTrack({ ...t, details: [] }),
              info: t,
              pluginInfo: {} as Record<string, unknown>
            })),
            pluginInfo: {} as Record<string, unknown>
          }
        }
      }

      if (trackData) {
        const artist =
          (Array.isArray(trackData.byArtist)
            ? (trackData.byArtist as { name: string }[])[0]?.name
            : (trackData.byArtist as { name: string } | undefined)?.name) ||
          trackData.author?.name ||
          'Unknown Artist'
        return this.buildTrackResult(
          trackData.name,
          artist,
          url,
          trackData.image ?? artworkUrl ?? null,
          trackData.id ||
            trackData.isrcCode ||
            url.split('/').pop() ||
            'am-unknown',
          this.parseISO8601Duration(trackData.duration),
          trackData.isrcCode
        )
      }
    } catch (e) {
      logger(
        'debug',
        'AmazonMusic',
        `fetchJsonLd failed for ${url}: ${e instanceof Error ? e.message : String(e)}`
      )
    }
    return null
  }

  /**
   * Facilitates resource resolution using the Odesli (Songlink) API as a fallback.
   * @param url - The original Amazon URL to resolve.
   * @param targetId - Optional identifier target for finding a specific entry in results.
   * @returns A promise resolving to a SourceResult.
   * @internal
   */
  private async fallbackToOdesli(
    url: string,
    targetId?: string
  ): Promise<SourceResult> {
    try {
      const apiUrl = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(url.split('?')[0] || url)}`
      const { body, statusCode } = await http1makeRequest(apiUrl)
      const parsed =
        typeof body === 'string'
          ? (JSON.parse(body) as OdesliResponse)
          : (body as OdesliResponse)
      if (statusCode === 200 && parsed?.entitiesByUniqueId) {
        interface OdesliEntity {
          id: string
          title: string
          artistName: string
          thumbnailUrl: string
          isrc?: string
        }
        let entity = parsed.entitiesByUniqueId[parsed.entityUniqueId] as
          | OdesliEntity
          | undefined
        if (targetId && !entity?.id.includes(targetId)) {
          entity = Object.values(parsed.entitiesByUniqueId).find((e) => {
            const typedE = e as unknown as OdesliEntity
            return typeof typedE.id === 'string' && typedE.id.includes(targetId)
          }) as OdesliEntity | undefined
        }
        if (entity)
          return this.buildTrackResult(
            entity.title,
            entity.artistName,
            url,
            entity.thumbnailUrl,
            entity.id,
            0,
            entity.isrc || null
          )
      }
    } catch (e) {
      logger(
        'debug',
        'AmazonMusic',
        `Odesli fallback failed for ${url}: ${e instanceof Error ? e.message : String(e)}`
      )
    }
    return { loadType: 'empty', data: {} }
  }

  /**
   * Constructs a standardized track result object wrapped in a SourceResult.
   * @param title - The track title.
   * @param author - The track author or artist name.
   * @param url - The track URL.
   * @param image - Optional artwork URL.
   * @param id - Stable track identifier.
   * @param length - Track duration in milliseconds.
   * @param isrc - Optional ISRC code.
   * @returns A SourceResult representing the resolved track.
   * @internal
   */
  private buildTrackResult(
    title: string,
    author: string,
    url: string,
    image: string | null,
    id: string,
    length = 0,
    isrc: string | null = null
  ): SourceResult {
    const info: TrackInfo = {
      identifier: id,
      isSeekable: true,
      author: author?.trim() || 'Unknown Artist',
      length,
      isStream: false,
      position: 0,
      title: title?.trim() || 'Unknown Track',
      uri: url,
      artworkUrl: image,
      isrc,
      sourceName: 'amazonmusic'
    }
    return {
      loadType: 'track',
      data: {
        encoded: encodeTrack({ ...info, details: [] }),
        info,
        pluginInfo: {} as Record<string, unknown>
      }
    }
  }

  /**
   * Executes a catalog search using the Amazon Cosmic API.
   * @param query - The search query string.
   * @returns A promise resolving to a SourceResult containing search hits.
   * @public
   */
  public async search(query: string): Promise<SourceResult> {
    try {
      const cfg = await this.getAmazonConfig()
      if (!cfg) return { loadType: 'empty', data: {} }

      const qEnc = encodeURIComponent(query)
      const searchPayload = {
        filter: '{"IsLibrary":["false"]}',
        keyword: JSON.stringify({
          interface:
            'Web.TemplatesInterface.v1_0.Touch.SearchTemplateInterface.SearchKeywordClientInformation',
          keyword: ''
        }),
        suggestedKeyword: query,
        userHash: '{"level":"LIBRARY_MEMBER"}',
        headers: JSON.stringify(
          this.buildAmznHeaders(
            cfg,
            `https://music.amazon.com/search/${qEnc}?filter=IsLibrary%7Cfalse&sc=none`
          )
        )
      }

      const payloadStr = JSON.stringify(searchPayload)
      const res = await http1makeRequest(
        'https://na.mesk.skill.music.a2z.com/api/showSearch',
        {
          method: 'POST',
          body: payloadStr,
          disableBodyCompression: true,
          headers: {
            'User-Agent': SEARCH_USER_AGENT,
            'Content-Type': 'text/plain;charset=UTF-8',
            'x-amzn-csrf': cfg.csrf.token,
            Origin: 'https://music.amazon.com'
          }
        }
      )

      if (res.statusCode !== 200) return { loadType: 'empty', data: {} }
      const data =
        typeof res.body === 'string'
          ? JSON.parse(res.body)
          : (res.body as Record<string, unknown>)
      const widgets = (
        data as { methods?: { template?: { widgets?: unknown[] } }[] }
      )?.methods?.[0]?.template?.widgets
      if (!Array.isArray(widgets)) return { loadType: 'empty', data: {} }

      const tracks: TrackInfo[] = []
      for (const widget of widgets) {
        const w = widget as { items?: unknown[] }
        if (!Array.isArray(w.items)) continue
        for (const item of w.items) {
          const it = item as Record<string, unknown>
          const isSong = it?.label === 'song'
          const isSquare =
            typeof it?.interface === 'string' &&
            (it.interface as string).includes('SquareHorizontalItemElement')
          if (!isSong && !isSquare) continue

          const primaryLink = it?.primaryLink as
            | { deeplink?: string }
            | undefined
          const identifier = this.extractIdentifier(primaryLink?.deeplink)
          if (!identifier) continue

          const secondaryText = it.secondaryText as
            | { text?: string }
            | string
            | undefined
          const primaryText = it.primaryText as
            | { text?: string }
            | string
            | undefined

          tracks.push({
            identifier,
            isSeekable: true,
            author:
              (typeof secondaryText === 'object'
                ? secondaryText?.text
                : secondaryText) || 'Unknown Artist',
            length: 0,
            isStream: false,
            position: 0,
            title:
              (typeof primaryText === 'object'
                ? primaryText?.text
                : primaryText) || 'Unknown Track',
            uri: `https://music.amazon.com/tracks/${identifier}`,
            artworkUrl: it.image as string | null,
            isrc: null,
            sourceName: 'amazonmusic'
          })
        }
      }

      if (tracks.length === 0) return { loadType: 'empty', data: {} }

      const fetchLimit = Math.min(tracks.length, 5)
      const metas = await Promise.all(
        tracks
          .slice(0, fetchLimit)
          .map((t) => this.fetchTrackMetaFromAPI(t.identifier))
      )
      for (let i = 0; i < fetchLimit; i++) {
        const meta = metas[i]
        const t = tracks[i]
        if (t && meta) {
          if (meta.duration > 0) t.length = meta.duration
          if (meta.isrc) t.isrc = meta.isrc
        }
      }

      return {
        loadType: 'search',
        data: tracks.map((t) => ({
          encoded: encodeTrack({ ...t, details: [] }),
          info: t,
          pluginInfo: {} as Record<string, unknown>
        }))
      }
    } catch {
      return { loadType: 'empty', data: {} }
    }
  }

  /**
   * Resolves a delegated track URL for an Amazon Music resource.
   * Performs a metadata-based mirror search on configured default sources.
   * @param decodedTrack - The Amazon Music track metadata to resolve.
   * @returns A promise resolving to a TrackUrlResult or an error.
   * @public
   */
  public async getTrackUrl(decodedTrack: TrackInfo): Promise<TrackUrlResult> {
    const query = `${decodedTrack.title} ${decodedTrack.author}`
    const sources = this.nodelink.sources
    if (!sources) {
      return {
        exception: { message: 'Sources not available.', severity: 'fault' }
      }
    }
    const searchResult = await sources.searchWithDefault(
      decodedTrack.isrc ? `"${decodedTrack.isrc}"` : query
    )
    const candidates =
      searchResult.loadType === 'search' ? searchResult.data : []
    const bestMatch = getBestMatch(candidates, decodedTrack)

    if (!bestMatch) {
      return {
        exception: {
          message: 'No suitable alternative stream found.',
          severity: 'fault'
        }
      }
    }
    const trackUrl = await sources.getTrackUrl(
      bestMatch.info as unknown as TrackInfo
    )
    return {
      newTrack: { info: bestMatch.info as unknown as TrackInfo },
      ...trackUrl
    }
  }

  /**
   * Direct stream fetching is not supported by the Amazon Music source.
   * @returns A promise resolving to a structured exception.
   * @public
   */
  public async loadStream(): Promise<TrackStreamResult> {
    return {
      exception: {
        message:
          'Direct stream loading is not supported by Amazon Music source.',
        severity: 'common'
      }
    }
  }

  /**
   * Extracts the 'trackAsin' parameter from a provided URL string.
   * @param u - The URL to parse.
   * @returns The ASIN string or null if not found.
   * @internal
   */
  private extractTrackAsinParam(u?: string): string | null {
    if (!u) return null
    const k = 'trackAsin='
    const i = u.indexOf(k)
    if (i === -1) return null
    const s = i + k.length
    let e = u.indexOf('&', s)
    const e2 = u.indexOf('%26', s)
    if (e === -1 || (e2 !== -1 && e2 < e)) e = e2
    const h = u.indexOf('#', s)
    if (e === -1 || (h !== -1 && h < e)) e = h
    if (e === -1) e = u.length
    return u.slice(s, e) || null
  }

  /**
   * Extracts a unique resource identifier from an Amazon deeplink or URI.
   * @param deeplink - The deeplink or URL to process.
   * @returns The resource identifier or null if parsing failed.
   * @internal
   */
  private extractIdentifier(deeplink?: string): string | null {
    if (!deeplink) return null
    const asin = this.extractTrackAsinParam(deeplink)
    if (asin) return asin
    let end = deeplink.length
    const q = deeplink.indexOf('?')
    if (q !== -1 && q < end) end = q
    const h = deeplink.indexOf('#')
    if (h !== -1 && h < end) end = h
    const cut = deeplink.lastIndexOf('/', end - 1)
    return deeplink.slice(cut + 1, end) || null
  }

  /**
   * Parses a colon-delimited duration string into a millisecond timestamp.
   * @param s - The duration string (e.g., 'MM:SS').
   * @returns The total duration in milliseconds.
   * @internal
   */
  private parseColonDurationToMs(s: string): number {
    const parts = s.split(':')
    let sec = 0
    for (const p of parts) {
      const n = parseInt(p, 10)
      if (Number.isNaN(n)) return 0
      sec = sec * 60 + n
    }
    return sec * 1000
  }

  /**
   * Parses an ISO 8601 duration string into a millisecond value.
   * @param duration - The ISO 8601 duration string.
   * @returns The total duration in milliseconds.
   * @internal
   */
  private parseISO8601Duration(duration?: string): number {
    if (!duration) return 0
    const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
    if (!match) return 0
    const hours = parseInt(match[1] || '0', 10)
    const minutes = parseInt(match[2] || '0', 10)
    const seconds = parseInt(match[3] || '0', 10)
    return (hours * 3600 + minutes * 60 + seconds) * 1000
  }

  /**
   * Parses various human-readable time strings into a millisecond value.
   * Supports 'HOUR', 'MINUTE', 'SECOND' keywords and H/M/S suffixes.
   * @param s - The duration string to parse.
   * @returns The total duration in milliseconds.
   * @internal
   */
  private parseTimeStringToMs(s: string): number {
    s = s.toUpperCase()
    let total = 0
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i)
      if (c < 48 || c > 57) continue
      let n = 0
      do {
        n = n * 10 + (c - 48)
        c = s.charCodeAt(++i)
      } while (i < s.length && c >= 48 && c <= 57)
      while (i < s.length && s.charCodeAt(i) === 32) i++
      if (s.startsWith('HOUR', i)) total += n * 3600
      else if (s.startsWith('MINUTE', i)) total += n * 60
      else if (s.startsWith('SECOND', i)) total += n
      else if (i < s.length && s[i] === 'H') total += n * 3600
      else if (i < s.length && s[i] === 'M') total += n * 60
      else if (i < s.length && s[i] === 'S') total += n
    }
    return total * 1000
  }
}
