import crypto from 'node:crypto'
import {
  encodeTrack,
  getBestMatch,
  http1makeRequest,
  logger
} from '../utils.ts'
import type {
  SourceResult,
  TrackInfo,
  TrackUrlResult,
  WorkerNodeLink
} from '../typings/sources/source.types.ts'
import type { BestMatchCandidate, TrackEncodeInput } from '../typings/utils.types.ts'

const BOT_USER_AGENT =
  'Mozilla/5.0 (compatible; NodeLinkBot/0.1; +https://nodelink.js.org/)'
const SEARCH_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'

const FALLBACK_DEVICE_ID = '13580682033287541'
const FALLBACK_SESSION_ID = '142-4001091-4160417'
const CONFIG_TTL_MS = 60_000

interface AmazonCsrf {
  token: string
  ts: string | number
  rnd: string | number
}

interface AmazonConfig {
  accessToken: string
  csrf: AmazonCsrf
  deviceId: string
  sessionId: string
}

type EncodedTrackResult = {
  encoded: string
  info: TrackInfo
  pluginInfo?: Record<string, unknown>
}

type AmazonTrackResult = {
  loadType: 'track'
  data: EncodedTrackResult
}

type AmazonPlaylistResult = {
  loadType: 'playlist'
  data: {
    info: {
      name: string
      selectedTrack: number
    }
    tracks: EncodedTrackResult[]
    pluginInfo?: Record<string, unknown>
  }
}

type TrackMatchCandidate = {
  info: TrackInfo
}

const parseJson = (value: unknown): unknown => {
  if (!value || typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const extractTrackAsinParam = (url: string | null | undefined): string | null => {
  if (!url) return null
  const key = 'trackAsin='
  const startIndex = url.indexOf(key)
  if (startIndex === -1) return null

  const start = startIndex + key.length
  let end = url.indexOf('&', start)
  const encodedEnd = url.indexOf('%26', start)
  if (end === -1 || (encodedEnd !== -1 && encodedEnd < end)) end = encodedEnd

  const hashIndex = url.indexOf('#', start)
  if (end === -1 || (hashIndex !== -1 && hashIndex < end)) end = hashIndex
  if (end === -1) end = url.length

  const identifier = url.slice(start, end)
  return identifier || null
}

const extractIdentifier = (deeplink: string | null | undefined): string | null => {
  if (!deeplink) return null

  const asin = extractTrackAsinParam(deeplink)
  if (asin) return asin

  let end = deeplink.length
  const queryIndex = deeplink.indexOf('?')
  if (queryIndex !== -1 && queryIndex < end) end = queryIndex
  const hashIndex = deeplink.indexOf('#')
  if (hashIndex !== -1 && hashIndex < end) end = hashIndex

  const cut = deeplink.lastIndexOf('/', end - 1)
  const identifier = deeplink.slice(cut + 1, end)
  return identifier || null
}

const parseColonDurationToMs = (value: string | null | undefined): number => {
  if (!value) return 0
  const parts = String(value).split(':')
  let seconds = 0
  for (let i = 0; i < parts.length; i++) {
    const parsed = Number.parseInt(parts[i] || '', 10)
    if (!Number.isFinite(parsed)) return 0
    seconds = seconds * 60 + parsed
  }
  return seconds * 1000
}

function parseISO8601Duration(duration: string | null | undefined): number {
  if (!duration) return 0
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
  if (!match) return 0

  const hours = Number.parseInt(match[1] || '0', 10)
  const minutes = Number.parseInt(match[2] || '0', 10)
  const seconds = Number.parseInt(match[3] || '0', 10)
  return (hours * 3600 + minutes * 60 + seconds) * 1000
}

function parseTimeStringToMs(value: string | null | undefined): number {
  if (!value) return 0
  const input = String(value).toUpperCase()

  let total = 0
  for (let i = 0; i < input.length; i++) {
    let code = input.charCodeAt(i)
    if (code < 48 || code > 57) continue

    let amount = 0
    do {
      amount = amount * 10 + (code - 48)
      code = input.charCodeAt(++i)
    } while (i < input.length && code >= 48 && code <= 57)

    while (i < input.length && input.charCodeAt(i) === 32) i++

    if (input.startsWith('HOUR', i)) total += amount * 3600
    else if (input.startsWith('MINUTE', i)) total += amount * 60
    else if (input.startsWith('SECOND', i)) total += amount
  }

  return total * 1000
}

export default class AmazonMusicSource {
  public readonly nodelink: WorkerNodeLink & {
    sources: NonNullable<WorkerNodeLink['sources']>
  }

  public readonly config: Record<string, unknown>
  public readonly searchTerms: string[]
  public readonly patterns: RegExp[]
  public readonly priority: number

  private _configCache: { t: number; v: AmazonConfig } | null
  private _configPromise: Promise<AmazonConfig | null> | null

  public constructor(
    nodelink: WorkerNodeLink & { sources: NonNullable<WorkerNodeLink['sources']> }
  ) {
    this.nodelink = nodelink
    this.config = nodelink.options
    this.searchTerms = ['amazonmusic', 'azsearch']
    this.patterns = [
      /https?:\/\/music\.amazon\.[a-z.]+\/(?:.*\/)?(track|album|playlist|artist)s?\/([a-z0-9]+)/i,
      /https?:\/\/(?:www\.)?amazon\.[a-z.]+\/dp\/([a-z0-9]+)/i
    ]
    this.priority = 100
    this._configCache = null
    this._configPromise = null
  }

  public async setup(): Promise<boolean> {
    return true
  }

  public async resolve(url: string): Promise<SourceResult> {
    try {
      const primaryPattern = this.patterns[0]
      const secondaryPattern = this.patterns[1]
      const match =
        (primaryPattern ? url.match(primaryPattern) : null) ||
        (secondaryPattern ? url.match(secondaryPattern) : null)

      if (!match) return { loadType: 'empty', data: {} }

      let type = match[1]
      let identifier = match[2]

      if (!identifier && type) {
        identifier = type
        type = 'track'
      }

      if (!type || !identifier) return { loadType: 'empty', data: {} }

      const trackAsin = extractTrackAsinParam(url)
      if (trackAsin) return await this._resolveTrack(url, trackAsin)

      if (type === 'track' || type === 'dp') return await this._resolveTrack(url, identifier)
      if (type === 'album') return await this._resolveAlbum(url, identifier)
      if (type === 'playlist') return await this._resolvePlaylist(url, identifier)
      if (type === 'artist') return await this._resolveArtist(url, identifier)

      return { loadType: 'empty', data: {} }
    } catch (error) {
      const message = this.getErrorMessage(error)
      logger('error', 'AmazonMusic', `Resolution failed: ${message}`)
      return {
        loadType: 'error',
        data: { message, severity: 'fault' }
      }
    }
  }

  public async search(query: string, _sourceTerm?: string): Promise<SourceResult> {
    const headersUA = { 'User-Agent': SEARCH_USER_AGENT }

    const decodeAmp = (value: unknown): string | unknown =>
      typeof value === 'string' ? value.replaceAll('&amp;', '&') : value

    const getText = (value: unknown, fallback: string): string => {
      if (value == null) return fallback
      if (typeof value === 'object' && !Array.isArray(value)) {
        const text = this.asString((value as Record<string, unknown>)['text'])
        return (decodeAmp(text) as string | null) || fallback
      }

      const decoded = decodeAmp(value)
      return typeof decoded === 'string' && decoded ? decoded : fallback
    }

    try {
      const cfg = await this._getAmazonConfig()
      if (!cfg) throw new Error('Failed to retrieve CSRF token from config')

      const now = Date.now()
      const queryEncoded = encodeURIComponent(query)
      const searchPayload = {
        filter: '{"IsLibrary":["false"]}',
        keyword: JSON.stringify({
          interface:
            'Web.TemplatesInterface.v1_0.Touch.SearchTemplateInterface.SearchKeywordClientInformation',
          keyword: ''
        }),
        suggestedKeyword: query,
        userHash: '{"level":"LIBRARY_MEMBER"}',
        headers: JSON.stringify({
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
          'x-amzn-application-version': '1.0.9172.0',
          'x-amzn-device-time-zone': 'America/New_York',
          'x-amzn-timestamp': String(now),
          'x-amzn-csrf': this._buildCsrfHeader(cfg.csrf),
          'x-amzn-music-domain': 'music.amazon.com',
          'x-amzn-page-url': `https://music.amazon.com/search/${queryEncoded}?filter=IsLibrary%7Cfalse&sc=none`,
          'x-amzn-feature-flags': 'hd-supported,uhd-supported'
        })
      }

      const payloadStr = JSON.stringify(searchPayload)
      const searchRes = await http1makeRequest(
        'https://na.mesk.skill.music.a2z.com/api/showSearch',
        {
          method: 'POST',
          body: payloadStr,
          disableBodyCompression: true,
          headers: {
            ...headersUA,
            'Content-Type': 'text/plain;charset=UTF-8',
            'Content-Length': String(Buffer.byteLength(payloadStr)),
            'x-amzn-csrf': cfg.csrf.token,
            Origin: 'https://music.amazon.com',
            Referer: 'https://music.amazon.com/'
          }
        }
      )

      if (searchRes.statusCode !== 200) {
        logger('error', 'AmazonMusic', `Search API returned ${searchRes.statusCode}`)
        return { loadType: 'empty', data: {} }
      }

      const parsed = this.asRecord(parseJson(searchRes.body) || searchRes.body)
      const methods = this.asArrayRecords(parsed?.['methods'])
      const template = this.asRecord(methods[0]?.['template'])
      const widgets = this.asArrayRecords(template?.['widgets'])
      if (widgets.length === 0) return { loadType: 'empty', data: {} }

      const tracks: TrackInfo[] = []
      for (const widget of widgets) {
        const items = this.asArrayRecords(widget['items'])
        for (const item of items) {
          const track = this.mapSearchItem(item, getText)
          if (track) tracks.push(track)
        }
      }

      if (tracks.length === 0) return { loadType: 'empty', data: {} }

      const fetchLimit = Math.min(tracks.length, 5)
      const durations = await Promise.all(
        tracks
          .slice(0, fetchLimit)
          .map((track) => this._fetchTrackDurationFromAPI(track.identifier))
      )

      for (let i = 0; i < fetchLimit; i++) {
        const track = tracks[i]
        const duration = durations[i]
        if (track && duration && duration > 0) track.length = duration
      }

      return {
        loadType: 'search',
        data: tracks.map((track) => this.buildEncodedTrack(track))
      }
    } catch (error) {
      logger('error', 'AmazonMusic', `Search failed: ${this.getErrorMessage(error)}`)
      return { loadType: 'empty', data: {} }
    }
  }

  public async getTrackUrl(
    decodedTrack: TrackInfo,
    itag?: number,
    forceRefresh = false
  ): Promise<TrackUrlResult> {
    const query = `${decodedTrack.title} ${decodedTrack.author}`
    const searchWithDefault = this.getSearchWithDefaultFn()

    try {
      if (!searchWithDefault) {
        throw new Error('Default source search is not available.')
      }

      let searchResult = await searchWithDefault(
        decodedTrack.isrc ? `"${decodedTrack.isrc}"` : query
      )

      if (
        !searchResult ||
        searchResult.loadType !== 'search' ||
        !Array.isArray(searchResult.data) ||
        searchResult.data.length === 0
      ) {
        searchResult = await searchWithDefault(query)
      }

      if (
        !searchResult ||
        searchResult.loadType !== 'search' ||
        !Array.isArray(searchResult.data) ||
        searchResult.data.length === 0
      ) {
        throw new Error('No alternative stream found via default search.')
      }

      const bestMatch = getBestMatch(
        this.toBestMatchCandidates(searchResult.data),
        decodedTrack
      ) as TrackMatchCandidate | null
      if (!bestMatch) {
        throw new Error('No suitable alternative stream found after filtering.')
      }

      const streamInfo = await this.nodelink.sources.getTrackUrl(
        bestMatch.info,
        itag,
        forceRefresh
      )
      return { newTrack: bestMatch, ...streamInfo }
    } catch (error) {
      logger(
        'warn',
        'AmazonMusic',
        `Mirror search for "${query}" failed: ${this.getErrorMessage(error)}`
      )
      throw error
    }
  }

  public async loadStream(): Promise<null> {
    return null
  }

  private async _getAmazonConfig(): Promise<AmazonConfig | null> {
    const now = Date.now()
    if (this._configCache && now - this._configCache.t < CONFIG_TTL_MS) {
      return this._configCache.v
    }
    if (this._configPromise) return this._configPromise

    this._configPromise = (async () => {
      const res = await http1makeRequest('https://music.amazon.com/config.json', {
        headers: { 'User-Agent': SEARCH_USER_AGENT }
      })
      if (res.statusCode !== 200) return null

      const cfg = this.asRecord(parseJson(res.body) || res.body)
      const csrf = this.asRecord(cfg?.['csrf'])
      const csrfToken = this.asString(csrf?.['token'])
      if (!cfg || !csrf || !csrfToken) return null

      const deviceIdValue = this.asString(cfg['deviceId'])
      const sessionIdValue = this.asString(cfg['sessionId'])
      const csrfTs = csrf['ts']
      const csrfRnd = csrf['rnd']

      const config: AmazonConfig = {
        accessToken: this.asString(cfg['accessToken']) || '',
        csrf: {
          token: csrfToken,
          ts: typeof csrfTs === 'string' || typeof csrfTs === 'number' ? csrfTs : '',
          rnd: typeof csrfRnd === 'string' || typeof csrfRnd === 'number' ? csrfRnd : ''
        },
        deviceId:
          deviceIdValue && !deviceIdValue.startsWith('000')
            ? deviceIdValue
            : FALLBACK_DEVICE_ID,
        sessionId:
          sessionIdValue && !sessionIdValue.startsWith('000')
            ? sessionIdValue
            : FALLBACK_SESSION_ID
      }

      this._configCache = { t: Date.now(), v: config }
      return config
    })()

    try {
      return await this._configPromise
    } finally {
      this._configPromise = null
    }
  }

  private _buildCsrfHeader(csrf: AmazonCsrf): string {
    return JSON.stringify({
      interface: 'CSRFInterface.v1_0.CSRFHeaderElement',
      token: csrf.token,
      timestamp: csrf.ts,
      rndNonce: csrf.rnd
    })
  }

  private async _fetchTrackDurationFromAPI(trackId: string): Promise<number> {
    try {
      const cfg = await this._getAmazonConfig()
      if (!cfg) return 0

      const now = Date.now()
      const headersObj = {
        'x-amzn-authentication': JSON.stringify({
          interface: 'ClientAuthenticationInterface.v1_0.ClientTokenElement',
          accessToken: cfg.accessToken
        }),
        'x-amzn-device-model': 'WEBPLAYER',
        'x-amzn-device-width': '1920',
        'x-amzn-device-family': 'WebPlayer',
        'x-amzn-device-id': cfg.deviceId,
        'x-amzn-user-agent': SEARCH_USER_AGENT,
        'x-amzn-session-id': cfg.sessionId,
        'x-amzn-device-height': '1080',
        'x-amzn-request-id': crypto.randomUUID(),
        'x-amzn-device-language': 'en_US',
        'x-amzn-currency-of-preference': 'USD',
        'x-amzn-os-version': '1.0',
        'x-amzn-application-version': '1.0.9172.0',
        'x-amzn-device-time-zone': 'America/Sao_Paulo',
        'x-amzn-timestamp': String(now),
        'x-amzn-csrf': this._buildCsrfHeader(cfg.csrf),
        'x-amzn-music-domain': 'music.amazon.com',
        'x-amzn-referer': '',
        'x-amzn-affiliate-tags': '',
        'x-amzn-ref-marker': '',
        'x-amzn-page-url': `https://music.amazon.com/tracks/${trackId}`,
        'x-amzn-weblab-id-overrides': '',
        'x-amzn-video-player-token': '',
        'x-amzn-feature-flags': 'hd-supported,uhd-supported',
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
            'Content-Length': String(Buffer.byteLength(payloadStr)),
            Origin: 'https://music.amazon.com',
            Referer: 'https://music.amazon.com/'
          }
        }
      )

      if (response.statusCode !== 200) return 0
      const data = this.asRecord(parseJson(response.body) || response.body)
      const methods = this.asArrayRecords(data?.['methods'])
      const template = this.asRecord(methods[0]?.['template'])
      const tertiaryText = this.asString(template?.['headerTertiaryText'])
      if (!tertiaryText) return 0

      const duration = parseTimeStringToMs(tertiaryText)
      return duration > 0 ? duration : 0
    } catch (error) {
      logger(
        'warn',
        'AmazonMusic',
        `Failed to fetch duration for ${trackId}: ${this.getErrorMessage(error)}`
      )
      return 0
    }
  }

  private async _resolveTrack(url: string, id: string): Promise<SourceResult> {
    const data = await this._fetchJsonLd(url, id)
    if (data?.loadType === 'track') {
      if (data.data.info.length === 0) {
        const duration = await this._fetchTrackDurationFromAPI(id)
        data.data.info.length = duration
        data.data.encoded = this.encodeTrackInfo(data.data.info)
      }
      return data
    }

    return await this._fallbackToOdesli(url, id)
  }

  private async _resolveAlbum(url: string, id: string): Promise<SourceResult> {
    const data = await this._fetchJsonLd(url)
    if (data?.loadType === 'playlist') return data
    return await this._fallbackToOdesli(url, id)
  }

  private async _resolvePlaylist(url: string, id: string): Promise<SourceResult> {
    const data = await this._fetchJsonLd(url)
    if (data?.loadType === 'playlist') return data
    return await this._fallbackToOdesli(url, id)
  }

  private async _resolveArtist(url: string, id: string): Promise<SourceResult> {
    const data = await this._fetchJsonLd(url)
    if (data?.loadType === 'playlist') return data
    return await this._fallbackToOdesli(url, id)
  }

  private async _fetchJsonLd(
    url: string,
    targetId?: string
  ): Promise<AmazonTrackResult | AmazonPlaylistResult | null> {
    try {
      const { body, statusCode } = await http1makeRequest(url, {
        headers: { 'User-Agent': BOT_USER_AGENT }
      })
      if (statusCode !== 200 || typeof body !== 'string') return null

      const headerArtist =
        body
          .match(/<music-detail-header[^>]*primary-text="([^"]+)"/)?.[1]
          ?.replaceAll('&amp;', '&') || null

      const headerImage =
        body.match(/<music-detail-header[^>]*image-src="([^"]+)"/)?.[1] || null
      const ogImageMatch = body.match(
        /<meta property="og:image" content="([^"]+)"/
      )
      const artworkUrl = headerImage || (ogImageMatch?.[1] ?? null)

      const jsonLdMatches = body.matchAll(
        /<script [^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g
      )

      let collection: Record<string, unknown> | null = null
      let trackData: Record<string, unknown> | null = null

      for (const match of jsonLdMatches) {
        const content = match[1]
        if (!content) continue

        try {
          const parsed = JSON.parse(
            content.replaceAll('&quot;', '"').replaceAll('&amp;', '&')
          ) as unknown
          const item = Array.isArray(parsed)
            ? this.asRecord(parsed[0])
            : this.asRecord(parsed)
          if (!item) continue

          const type = this.asString(item['@type'])
          if (
            type === 'MusicAlbum' ||
            type === 'MusicGroup' ||
            type === 'Playlist'
          ) {
            collection = item
          } else if (type === 'MusicRecording') {
            trackData = item
          }
        } catch {}
      }

      const tracks: TrackInfo[] = []
      let collectionName = headerArtist || 'Unknown Artist'
      let collectionImage = artworkUrl

      if (collection) {
        const artistName =
          this.getNestedString(collection, 'byArtist', 'name') ||
          this.asString(this.asRecord(this.asUnknownArray(collection['byArtist'])[0])?.['name']) ||
          this.getNestedString(collection, 'author', 'name')

        if (artistName) collectionName = artistName
        const collectionImageValue = this.asString(collection['image'])
        if (collectionImageValue) collectionImage = collectionImageValue
      }

      const collectionTracks = this.asUnknownArray(collection?.['track'])
      if (collectionTracks.length > 0) {
        for (const rawTrack of collectionTracks) {
          const item = this.asRecord(rawTrack)
          if (!item) continue

          const title = this.asString(item['name'])
          if (!title) continue

          const itemUrl = this.asString(item['url']) || url
          const atId = this.asString(item['@id'])
          const identifier =
            itemUrl.split('/').pop() ||
            atId?.split('/').pop() ||
            `am-${Buffer.from(title).toString('hex')}`

          tracks.push({
            identifier,
            isSeekable: true,
            author:
              this.getNestedString(item, 'byArtist', 'name') ||
              this.getNestedString(item, 'author', 'name') ||
              collectionName,
            length: parseISO8601Duration(this.asString(item['duration'])),
            isStream: false,
            position: 0,
            title,
            uri: itemUrl,
            artworkUrl: collectionImage,
            isrc: this.asString(item['isrcCode']) || null,
            sourceName: 'amazonmusic'
          })
        }
      }

      if (tracks.length === 0) {
        const rowMatches = body.matchAll(
          /<(music-image-row|music-text-row)[^>]*primary-text="([^"]+)"[^>]*primary-href="([^"]+)"(?:[^>]*secondary-text-1="([^"]+)")?[^>]*duration="([^"]+)"(?:[^>]*image-src="([^"]+)")?/g
        )

        for (const match of rowMatches) {
          const title = match[2]?.replaceAll('&amp;', '&')
          const href = match[3]
          if (!title || !href) continue

          const artist = (match[4] || collectionName).replaceAll('&amp;', '&')
          const duration = match[5]
          const image = match[6] || collectionImage
          const identifier =
            extractIdentifier(href) || `am-${Buffer.from(title).toString('hex')}`

          tracks.push({
            identifier,
            isSeekable: true,
            author: artist,
            length:
              duration && duration.includes(':')
                ? parseColonDurationToMs(duration)
                : 0,
            isStream: false,
            position: 0,
            title,
            uri: `https://music.amazon.com.br/tracks/${identifier}`,
            artworkUrl: image,
            isrc: null,
            sourceName: 'amazonmusic'
          })
        }

        if (tracks.length === 0 && !headerArtist) {
          const titleMatch = body.match(/<title[^>]*>([^<]+)<\/title>/)
          if (titleMatch?.[1]) {
            collectionName =
              titleMatch[1]
                .split(' no Amazon')[0]
                ?.split(' de ')
                .pop()
                ?.split(' no ')[0] || collectionName
          }
        }
      }

      if (tracks.length > 0) {
        if (targetId) {
          const selected = tracks.find(
            (track) => track.identifier === targetId || track.uri.includes(targetId)
          )
          if (selected) {
            return {
              loadType: 'track',
              data: this.buildEncodedTrack(selected)
            }
          }
        }

        if (url.includes('/tracks/') && !targetId) {
          const firstTrack = tracks[0]
          if (firstTrack) {
            return {
              loadType: 'track',
              data: this.buildEncodedTrack(firstTrack)
            }
          }
        }

        return {
          loadType: 'playlist',
          data: {
            info: { name: collectionName, selectedTrack: 0 },
            tracks: tracks.map((track) => this.buildEncodedTrack(track))
          }
        }
      }

      if (trackData) {
        const artist =
          this.getNestedString(trackData, 'byArtist', 'name') ||
          this.getNestedString(trackData, 'author', 'name') ||
          'Unknown Artist'

        let trackImage = this.asString(trackData['image']) || artworkUrl
        if (!trackImage) {
          trackImage =
            body.match(/<music-detail-header[^>]*image-src="([^"]+)"/)?.[1] || null
        }

        return this._buildTrackResult(
          this.asString(trackData['name']),
          artist,
          url,
          trackImage,
          this.asString(trackData['id']) ||
            this.asString(trackData['isrcCode']) ||
            url.split('/').pop() ||
            '',
          parseISO8601Duration(this.asString(trackData['duration'])),
          this.asString(trackData['isrcCode']) || null
        )
      }
    } catch {}

    return null
  }

  private async _fallbackToOdesli(
    url: string,
    targetId?: string
  ): Promise<SourceResult> {
    try {
      const apiUrl = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(url.split('?')[0] || url)}`
      const { body, statusCode } = await http1makeRequest(apiUrl)
      const data = this.asRecord(body)

      if (statusCode === 200) {
        const entitiesByUniqueId = this.asRecord(data?.['entitiesByUniqueId'])
        const entityUniqueId = this.asString(data?.['entityUniqueId'])

        if (entitiesByUniqueId && entityUniqueId) {
          let entity = this.asRecord(entitiesByUniqueId[entityUniqueId])
          if (
            targetId &&
            (!entity || !(this.asString(entity['id']) || '').includes(targetId))
          ) {
            const found = Object.values(entitiesByUniqueId).find((value) => {
              const item = this.asRecord(value)
              const id = this.asString(item?.['id'])
              return Boolean(id && id.includes(targetId))
            })
            entity = this.asRecord(found)
          }

          if (entity) {
            return this._buildTrackResult(
              this.asString(entity['title']),
              this.asString(entity['artistName']),
              url,
              this.asString(entity['thumbnailUrl']),
              this.asString(entity['id']) || '',
              0,
              this.asString(entity['isrc']) || null
            )
          }
        }
      }
    } catch {}

    return { loadType: 'empty', data: {} }
  }

  private _buildTrackResult(
    title: string | null,
    author: string | null,
    url: string,
    image: string | null,
    id: string,
    length = 0,
    isrc: string | null = null
  ): AmazonTrackResult {
    const trackInfo: TrackInfo = {
      identifier: id,
      isSeekable: true,
      author: author?.trim() || 'Unknown Artist',
      length,
      isStream: false,
      position: 0,
      title: title?.trim() || 'Unknown Track',
      uri: url,
      artworkUrl: image || null,
      isrc,
      sourceName: 'amazonmusic'
    }

    return {
      loadType: 'track',
      data: this.buildEncodedTrack(trackInfo)
    }
  }

  private buildEncodedTrack(info: TrackInfo): EncodedTrackResult {
    return {
      encoded: this.encodeTrackInfo(info),
      info
    }
  }

  private encodeTrackInfo(info: TrackInfo): string {
    const encodedInput: TrackEncodeInput = { ...info, details: [] }
    return encodeTrack(encodedInput)
  }

  private mapSearchItem(
    item: Record<string, unknown>,
    getText: (value: unknown, fallback: string) => string
  ): TrackInfo | null {
    const label = this.asString(item['label'])
    const itemInterface = this.asString(item['interface'])
    const isSong = label === 'song'
    const isSquare =
      typeof itemInterface === 'string' &&
      itemInterface.includes('SquareHorizontalItemElement')
    if (!isSong && !isSquare) return null

    const primaryLink = this.asRecord(item['primaryLink'])
    const deeplink = this.asString(primaryLink?.['deeplink'])
    const identifier = extractIdentifier(deeplink)
    if (!identifier) return null
    if (!isSong && (!deeplink || !deeplink.includes('trackAsin='))) return null

    return {
      identifier,
      isSeekable: true,
      author: getText(item['secondaryText'], 'Unknown Artist'),
      length: 0,
      isStream: false,
      position: 0,
      title: getText(item['primaryText'], 'Unknown Track'),
      uri: `https://music.amazon.com/tracks/${identifier}`,
      artworkUrl: this.asString(item['image']) || null,
      isrc: null,
      sourceName: 'amazonmusic'
    }
  }

  private toBestMatchCandidates(data: unknown[]): TrackMatchCandidate[] {
    const candidates: TrackMatchCandidate[] = []

    for (const item of data) {
      const record = this.asRecord(item)
      const info = this.asRecord(record?.['info'])
      if (!info) continue

      const identifier = this.asString(info['identifier'])
      const author = this.asString(info['author'])
      const title = this.asString(info['title'])
      const uri = this.asString(info['uri'])
      const sourceName = this.asString(info['sourceName'])
      const length = this.asNumber(info['length'])
      const isSeekable = this.asBoolean(info['isSeekable'])
      const isStream = this.asBoolean(info['isStream'])
      const position = this.asNumber(info['position'])

      if (
        !identifier ||
        author === null ||
        title === null ||
        uri === null ||
        sourceName === null ||
        length === null ||
        isSeekable === null ||
        isStream === null ||
        position === null
      ) {
        continue
      }

      candidates.push({
        info: {
          identifier,
          isSeekable,
          author,
          length,
          isStream,
          position,
          title,
          uri,
          artworkUrl: this.asString(info['artworkUrl']) || null,
          isrc: this.asString(info['isrc']) || null,
          sourceName
        }
      })
    }

    return candidates
  }

  private getSearchWithDefaultFn():
    | ((query: string) => Promise<SourceResult>)
    | null {
    const sourcesObject = this.asRecord(this.nodelink.sources)
    const fn = sourcesObject?.['searchWithDefault']
    return typeof fn === 'function'
      ? (fn as (query: string) => Promise<SourceResult>)
      : null
  }

  private getNestedString(
    value: Record<string, unknown>,
    parentKey: string,
    childKey: string
  ): string | null {
    return this.asString(this.asRecord(value[parentKey])?.[childKey])
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  }

  private asArrayRecords(value: unknown): Record<string, unknown>[] {
    if (!Array.isArray(value)) return []
    return value
      .map((item) => this.asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null)
  }

  private asUnknownArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : []
  }

  private asString(value: unknown): string | null {
    return typeof value === 'string' ? value : null
  }

  private asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }

  private asBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}
