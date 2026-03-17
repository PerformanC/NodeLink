import crypto from 'node:crypto'
import {
  encodeTrack,
  getBestMatch,
  http1makeRequest,
  logger
} from '../utils.ts'
import type {
  BestMatchCandidate,
  BestMatchTrackInfo,
  HttpRequestResult,
  TrackEncodeInput
} from '../typings/utils.types.ts'

// The Types for AmazonMusic API. 

interface CsrfToken {
  token: string
  ts: string
  rnd: string
}

interface AmazonConfig {
  accessToken: string
  csrf: CsrfToken
  deviceId: string
  sessionId: string
}

interface ConfigCache {
  t: number
  v: AmazonConfig
}

interface LoadResultTrack {
  loadType: 'track'
  data: { encoded: string; info: TrackEncodeInput }
}

interface LoadResultPlaylist {
  loadType: 'playlist'
  data: {
    info: { name: string; selectedTrack: number }
    tracks: Array<{ encoded: string; info: TrackEncodeInput }>
  }
}

interface LoadResultSearch {
  loadType: 'search'
  data: Array<{ encoded: string; info: TrackEncodeInput }>
}

interface LoadResultEmpty {
  loadType: 'empty'
  data: Record<string, never>
}

interface LoadResultError {
  loadType: 'error'
  data: { message: string; severity: string }
}

type LoadResult =
  | LoadResultTrack
  | LoadResultPlaylist
  | LoadResultSearch
  | LoadResultEmpty
  | LoadResultError

type AnyObj = Record<string, unknown>

interface NodeLinkSources {
  search(source: string, query: string, searchType: string): Promise<LoadResult>
  searchWithDefault(query: string): Promise<LoadResult>
  getTrackUrl(trackInfo: TrackEncodeInput, itag: unknown, forceRefresh: boolean): Promise<AnyObj>
}

interface NodeLink {
  options: AnyObj
  sources: NodeLinkSources
}

// Constants

const BOT_USER_AGENT =
  'Mozilla/5.0 (compatible; NodeLinkBot/0.1; +https://nodelink.js.org/)'
const SEARCH_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'

const FALLBACK_DEVICE_ID = '13580682033287541'
const FALLBACK_SESSION_ID = '142-4001091-4160417'
const CONFIG_TTL_MS = 60_000

// Helper Functions

function parseJson(v: unknown): AnyObj | null {
  if (typeof v !== 'string' || !v) return null
  try { return JSON.parse(v) as AnyObj } catch { return null }
}

function bodyToString(result: HttpRequestResult): string {
  const b: unknown = result.body
  if (typeof b === 'string') return b
  if (Buffer.isBuffer(b)) return b.toString('utf8')
  if (b && typeof b === 'object') return JSON.stringify(b)
  return ''
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function extractTrackAsinParam(u: string): string | null {
  const k = 'trackAsin='
  const i = u.indexOf(k)
  if (i === -1) return null
  const s = i + k.length
  let e = u.indexOf('&', s)
  const e2 = u.indexOf('%26', s)
  if (e === -1 || (e2 !== -1 && e2 < e)) e = e2
  const hh = u.indexOf('#', s)
  if (e === -1 || (hh !== -1 && hh < e)) e = hh
  if (e === -1) e = u.length
  return u.slice(s, e) || null
}

function extractIdentifier(deeplink: string | null | undefined): string | null {
  if (!deeplink) return null
  const asin = extractTrackAsinParam(deeplink)
  if (asin) return asin
  let end = deeplink.length
  const q = deeplink.indexOf('?')
  if (q !== -1 && q < end) end = q
  const hh = deeplink.indexOf('#')
  if (hh !== -1 && hh < end) end = hh
  const cut = deeplink.lastIndexOf('/', end - 1)
  return deeplink.slice(cut + 1, end) || null
}

function parseColonDurationToMs(s: string): number {
  const parts = s.split(':')
  let sec = 0
  for (const part of parts) {
    const n = Number.parseInt(part, 10)
    if (!Number.isFinite(n)) return 0
    sec = sec * 60 + n
  }
  return sec * 1000
}

function parseISO8601Duration(duration: string | null | undefined): number {
  if (!duration) return 0
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
  if (!match) return 0
  const h = Number.parseInt(match[1] ?? '0', 10)
  const m = Number.parseInt(match[2] ?? '0', 10)
  const s = Number.parseInt(match[3] ?? '0', 10)
  return (h * 3600 + m * 60 + s) * 1000
}

function parseTimeStringToMs(s: string): number {
  const src = s.toUpperCase()
  let total = 0
  for (let i = 0; i < src.length; i++) {
    let c = src.charCodeAt(i)
    if (c < 48 || c > 57) continue
    let n = 0
    do {
      n = n * 10 + (c - 48)
      c = src.charCodeAt(++i)
    } while (i < src.length && c >= 48 && c <= 57)
    while (i < src.length && src.charCodeAt(i) === 32) i++
    if (src.startsWith('HOUR', i)) total += n * 3600
    else if (src.startsWith('MINUTE', i)) total += n * 60
    else if (src.startsWith('SECOND', i)) total += n
  }
  return total * 1000
}

function getArtistName(obj: AnyObj): string | null {
  const byArtist = obj['byArtist']
  if (byArtist) {
    if (Array.isArray(byArtist)) return str((byArtist[0] as AnyObj)?.['name'])
    return str((byArtist as AnyObj)['name'])
  }
  return str((obj['author'] as AnyObj | undefined)?.['name'] ?? obj['author'])
}

function makeTrackInput(
  title: string,
  author: string,
  uri: string,
  artworkUrl: string | null | undefined,
  identifier: string,
  length: number,
  isrc: string | null,
  sourceName: string
): TrackEncodeInput {
  return {
    title: title.trim() || 'Unknown Track',
    author: author.trim() || 'Unknown Artist',
    length,
    identifier,
    isStream: false,
    uri,
    artworkUrl: artworkUrl ?? null,
    isrc,
    sourceName,
    position: 0,
    details: []
  }
}

// Amazon Music Class

export default class AmazonMusicSource {
  private readonly nodelink: NodeLink
  readonly searchTerms: string[]
  readonly patterns: [RegExp, RegExp]
  readonly priority: number

  private _configCache: ConfigCache | null = null
  private _configPromise: Promise<AmazonConfig | null> | null = null

  constructor(nodelink: NodeLink) {
    this.nodelink = nodelink
    this.searchTerms = ['amazonmusic', 'azsearch']
    this.patterns = [
      /https?:\/\/music\.amazon\.[a-z.]+\/(?:.*\/)?(track|album|playlist|artist)s?\/([a-z0-9]+)/i,
      /https?:\/\/(?:www\.)?amazon\.[a-z.]+\/dp\/([a-z0-9]+)/i
    ]
    this.priority = 100
  }

  async setup(): Promise<boolean> {
    return true
  }

  private async _getAmazonConfig(): Promise<AmazonConfig | null> {
    const now = Date.now()
    if (this._configCache && now - this._configCache.t < CONFIG_TTL_MS)
      return this._configCache.v
    if (this._configPromise) return this._configPromise

    this._configPromise = (async (): Promise<AmazonConfig | null> => {
      const res = await http1makeRequest('https://music.amazon.com/config.json', {
        headers: { 'User-Agent': SEARCH_USER_AGENT }
      })
      if (res.statusCode !== 200) return null

      const cfg = parseJson(bodyToString(res))
      if (!cfg) return null

      const csrf = cfg['csrf'] as CsrfToken | undefined
      if (!csrf?.token) return null

      const deviceId =
        typeof cfg['deviceId'] === 'string' && !cfg['deviceId'].startsWith('000')
          ? cfg['deviceId']
          : FALLBACK_DEVICE_ID
      const sessionId =
        typeof cfg['sessionId'] === 'string' && !cfg['sessionId'].startsWith('000')
          ? cfg['sessionId']
          : FALLBACK_SESSION_ID

      const v: AmazonConfig = {
        accessToken: str(cfg['accessToken']) ?? '',
        csrf,
        deviceId,
        sessionId
      }
      this._configCache = { t: Date.now(), v }
      return v
    })()

    try {
      return await this._configPromise
    } finally {
      this._configPromise = null
    }
  }

  private _buildCsrfHeader(csrf: CsrfToken): string {
    return JSON.stringify({
      interface: 'CSRFInterface.v1_0.CSRFHeaderElement',
      token: csrf.token,
      timestamp: csrf.ts,
      rndNonce: csrf.rnd
    })
  }

  async resolve(url: string): Promise<LoadResult> {
    try {
      const match = url.match(this.patterns[0]) ?? url.match(this.patterns[1])
      if (!match) return { loadType: 'empty', data: {} }

      let type = match[1] ?? 'track'
      let id = match[2] ?? type
      if (!match[2]) { id = type; type = 'track' }

      const trackAsin = extractTrackAsinParam(url)
      if (trackAsin) return this._resolveTrack(url, trackAsin)

      if (type === 'track' || type === 'dp') return this._resolveTrack(url, id)
      if (type === 'album') return this._resolveAlbum(url, id)
      if (type === 'playlist') return this._resolvePlaylist(url, id)
      if (type === 'artist') return this._resolveArtist(url, id)

      return { loadType: 'empty', data: {} }
    } catch (e) {
      const msg = (e as Error).message
      logger('error', 'AmazonMusic', `Resolution failed: ${msg}`)
      return { loadType: 'error', data: { message: msg, severity: 'fault' } }
    }
  }

  private async _fetchTrackDurationFromAPI(trackId: string): Promise<number> {
    try {
      const cfg = await this._getAmazonConfig()
      if (!cfg) return 0

      const headersObj: AnyObj = {
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
        'x-amzn-timestamp': String(Date.now()),
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

      const data = parseJson(bodyToString(response))
      if (!data) return 0

      const methods = data['methods'] as AnyObj[] | undefined
      const template = (methods?.[0] as AnyObj | undefined)?.['template'] as AnyObj | undefined
      const headerText = str(template?.['headerTertiaryText'])
      if (!headerText) return 0

      const duration = parseTimeStringToMs(headerText)
      return duration > 0 ? duration : 0
    } catch (e) {
      logger('warn', 'AmazonMusic', `Failed to fetch duration for ${trackId}: ${(e as Error).message}`)
      return 0
    }
  }

  private async _resolveTrack(url: string, id: string): Promise<LoadResult> {
    const result = await this._fetchJsonLd(url, id)
    if (result?.loadType === 'track') {
      const track = result as LoadResultTrack
      if (track.data.info.length === 0) {
        const duration = await this._fetchTrackDurationFromAPI(id)
        track.data.info.length = duration
        track.data.encoded = encodeTrack(track.data.info)
      }
      return track
    }
    return this._fallbackToOdesli(url, id)
  }

  private async _resolveAlbum(url: string, id: string): Promise<LoadResult> {
    const result = await this._fetchJsonLd(url)
    if (result?.loadType === 'playlist') return result
    return this._fallbackToOdesli(url, id)
  }

  private async _resolvePlaylist(url: string, id: string): Promise<LoadResult> {
    const result = await this._fetchJsonLd(url)
    if (result?.loadType === 'playlist') return result
    return this._fallbackToOdesli(url, id)
  }

  private async _resolveArtist(url: string, id: string): Promise<LoadResult> {
    const result = await this._fetchJsonLd(url)
    if (result?.loadType === 'playlist') return result
    return this._fallbackToOdesli(url, id)
  }

  private async _fetchJsonLd(url: string, targetId?: string): Promise<LoadResult | null> {
    try {
      const res = await http1makeRequest(url, {
        headers: { 'User-Agent': BOT_USER_AGENT }
      })
      if (res.statusCode !== 200) return null

      const body = bodyToString(res)

      const headerArtist =
        body.match(/<music-detail-header[^>]*primary-text="([^"]+)"/)?.[1]
          ?.replaceAll('&amp;', '&') ?? null

      const headerImage =
        body.match(/<music-detail-header[^>]*image-src="([^"]+)"/)?.[1] ??
        body.match(/<meta property="og:image" content="([^"]+)"/)?.[1] ??
        null

      const jsonLdMatches = body.matchAll(
        /<script [^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g
      )

      let collection: AnyObj | null = null
      let trackData: AnyObj | null = null

      for (const match of jsonLdMatches) {
        try {
          const content = match[1]?.replaceAll('&quot;', '"').replaceAll('&amp;', '&')
          if (!content) continue
          const parsed = JSON.parse(content) as unknown
          const data = (Array.isArray(parsed) ? parsed[0] : parsed) as AnyObj
          const type = data['@type']
          if (type === 'MusicAlbum' || type === 'MusicGroup' || type === 'Playlist') {
            collection = data
          } else if (type === 'MusicRecording') {
            trackData = data
          }
        } catch { /* skip malformed */ }
      }

      const tracks: TrackEncodeInput[] = []
      let collectionName = headerArtist ?? 'Unknown Artist'
      let collectionImage: string | null = headerImage

      if (collection) {
        const artistName = getArtistName(collection)
        if (artistName) collectionName = artistName
        const img = str(collection['image'])
        if (img) collectionImage = img
      }

      if (Array.isArray(collection?.['track'])) {
        for (const raw of collection!['track'] as AnyObj[]) {
          const tUrl = str(raw['url'])
          const tId = str(raw['@id'])
          const identifier =
            tUrl?.split('/').pop() ??
            tId?.split('/').pop() ??
            `am-${Buffer.from(String(raw['name'] ?? '')).toString('hex')}`

          tracks.push(makeTrackInput(
            str(raw['name']) ?? 'Unknown Track',
            getArtistName(raw) ?? collectionName,
            tUrl ?? url,
            collectionImage,
            identifier,
            parseISO8601Duration(str(raw['duration'])),
            str(raw['isrcCode']),
            'amazonmusic'
          ))
        }
      }

      if (tracks.length === 0) {
        const rowMatches = body.matchAll(
          /<(music-image-row|music-text-row)[^>]*primary-text="([^"]+)"[^>]*primary-href="([^"]+)"(?:[^>]*secondary-text-1="([^"]+)")?[^>]*duration="([^"]+)"(?:[^>]*image-src="([^"]+)")?/g
        )
        for (const m of rowMatches) {
          const tTitle = m[2]?.replaceAll('&amp;', '&')
          const tHref = m[3]
          if (!tTitle || !tHref) continue
          const tArtist = (m[4] ?? collectionName).replaceAll('&amp;', '&')
          const tDuration = m[5]
          const tImage = m[6] ?? collectionImage
          const tId = extractIdentifier(tHref) ?? `am-${Buffer.from(tTitle).toString('hex')}`

          tracks.push(makeTrackInput(
            tTitle,
            tArtist,
            `https://music.amazon.com.br/tracks/${tId}`,
            tImage,
            tId,
            tDuration?.includes(':') ? parseColonDurationToMs(tDuration) : 0,
            null,
            'amazonmusic'
          ))
        }

        if (tracks.length === 0 && !headerArtist) {
          const titleMatch = body.match(/<title[^>]*>([^<]+)<\/title>/)
          if (titleMatch) {
            collectionName =
              titleMatch[1]?.split(' de ').pop()?.split(' no ')[0]
              ?? collectionName
          }
        }
      }

      if (tracks.length > 0) {
        if (targetId) {
          const selected = tracks.find(
            (t) => t.identifier === targetId || (t.uri ?? '').includes(targetId)
          )
          if (selected) {
            return { loadType: 'track', data: { encoded: encodeTrack(selected), info: selected } }
          }
        }
        if (url.includes('/tracks/') && !targetId) {
          const first = tracks[0]!
          return { loadType: 'track', data: { encoded: encodeTrack(first), info: first } }
        }
        return {
          loadType: 'playlist',
          data: {
            info: { name: collectionName, selectedTrack: 0 },
            tracks: tracks.map((t) => ({ encoded: encodeTrack(t), info: t }))
          }
        }
      }

      if (trackData) {
        const artist = getArtistName(trackData) ?? 'Unknown Artist'
        const trackImage =
          str(trackData['image']) ??
          body.match(/<music-detail-header[^>]*image-src="([^"]+)"/)?.[1] ??
          null
        const trackId =
          str(trackData['id']) ??
          str(trackData['isrcCode']) ??
          url.split('/').pop() ??
          url

        return this._buildTrackResult(
          str(trackData['name']) ?? 'Unknown Track',
          artist,
          url,
          trackImage,
          trackId,
          parseISO8601Duration(str(trackData['duration'])),
          str(trackData['isrcCode'])
        )
      }
    } catch { /* fall through */ }
    return null
  }

  private async _fallbackToOdesli(url: string, targetId: string): Promise<LoadResult> {
    try {
      const apiUrl = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(url.split('?')[0] ?? url)}`
      const res = await http1makeRequest(apiUrl)

      if (res.statusCode === 200) {
        const data = parseJson(bodyToString(res))
        if (data?.['entitiesByUniqueId']) {
          const byId = data['entitiesByUniqueId'] as Record<string, AnyObj>
          let entity = byId[data['entityUniqueId'] as string]
          if (targetId && (!entity || !str(entity['id'])?.includes(targetId))) {
            entity = Object.values(byId).find((e) => str(e['id'])?.includes(targetId)) ?? entity
          }
          if (entity) {
            return this._buildTrackResult(
              str(entity['title']) ?? 'Unknown Track',
              str(entity['artistName']) ?? 'Unknown Artist',
              url,
              str(entity['thumbnailUrl']),
              str(entity['id']) ?? url,
              0,
              str(entity['isrc'])
            )
          }
        }
      }
    } catch { /* fall through */ }
    return { loadType: 'empty', data: {} }
  }

  private _buildTrackResult(
    title: string,
    author: string,
    url: string,
    image: string | null | undefined,
    id: string,
    length = 0,
    isrc: string | null = null
  ): LoadResultTrack {
    const info = makeTrackInput(title, author, url, image, id, length, isrc, 'amazonmusic')
    return { loadType: 'track', data: { encoded: encodeTrack(info), info } }
  }

  async search(query: string, _sourceTerm: string): Promise<LoadResult> {
    function decodeAmp(v: unknown): string {
      return typeof v === 'string' ? v.replaceAll('&amp;', '&') : ''
    }
    function getText(v: unknown, fallback: string): string {
      if (v == null) return fallback
      if (typeof v === 'object') return decodeAmp((v as AnyObj)['text']) || fallback
      return decodeAmp(v) || fallback
    }

    try {
      const cfg = await this._getAmazonConfig()
      if (!cfg) throw new Error('Failed to retrieve CSRF token from config')

      const now = Date.now()
      const qEnc = encodeURIComponent(query)

      const innerHeaders = {
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
        'x-amzn-page-url': `https://music.amazon.com/search/${qEnc}?filter=IsLibrary%7Cfalse&sc=none`,
        'x-amzn-feature-flags': 'hd-supported,uhd-supported'
      }

      const searchPayload = {
        filter: '{"IsLibrary":["false"]}',
        keyword: JSON.stringify({
          interface: 'Web.TemplatesInterface.v1_0.Touch.SearchTemplateInterface.SearchKeywordClientInformation',
          keyword: ''
        }),
        suggestedKeyword: query,
        userHash: '{"level":"LIBRARY_MEMBER"}',
        headers: JSON.stringify(innerHeaders)
      }

      const payloadStr = JSON.stringify(searchPayload)

      const searchRes = await http1makeRequest(
        'https://na.mesk.skill.music.a2z.com/api/showSearch',
        {
          method: 'POST',
          body: payloadStr,
          disableBodyCompression: true,
          headers: {
            'User-Agent': SEARCH_USER_AGENT,
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

      const data = parseJson(bodyToString(searchRes))
      if (!data) return { loadType: 'empty', data: {} }

      const methods = data['methods'] as AnyObj[] | undefined
      const template = (methods?.[0] as AnyObj | undefined)?.['template'] as AnyObj | undefined
      const widgets = template?.['widgets'] as AnyObj[] | undefined
      if (!Array.isArray(widgets) || widgets.length === 0)
        return { loadType: 'empty', data: {} }

      const tracks: TrackEncodeInput[] = []

      for (const widget of widgets) {
        const items = widget['items'] as AnyObj[] | undefined
        if (!Array.isArray(items)) continue

        for (const item of items) {
          const isSong = item['label'] === 'song'
          const isSquare =
            typeof item['interface'] === 'string' &&
            (item['interface'] as string).includes('SquareHorizontalItemElement')
          if (!isSong && !isSquare) continue

          const deeplink = str((item['primaryLink'] as AnyObj | undefined)?.['deeplink'])
          const identifier = extractIdentifier(deeplink)
          if (!identifier) continue
          if (!isSong && (!deeplink || !deeplink.includes('trackAsin='))) continue

          tracks.push(makeTrackInput(
            getText(item['primaryText'], 'Unknown Track'),
            getText(item['secondaryText'], 'Unknown Artist'),
            `https://music.amazon.com/tracks/${identifier}`,
            str(item['image']),
            identifier,
            0,
            null,
            'amazonmusic'
          ))
        }
      }

      if (tracks.length === 0) return { loadType: 'empty', data: {} }

      const fetchLimit = Math.min(tracks.length, 5)
      const durations = await Promise.all(
        tracks.slice(0, fetchLimit).map((t) => this._fetchTrackDurationFromAPI(t.identifier))
      )
      for (let i = 0; i < fetchLimit; i++) {
        const d = durations[i]
        if (d !== undefined && d > 0) tracks[i]!.length = d
      }

      return {
        loadType: 'search',
        data: tracks.map((t) => ({ encoded: encodeTrack(t), info: t }))
      }
    } catch (e) {
      logger('error', 'AmazonMusic', `Search failed: ${(e as Error).message}`)
      return { loadType: 'empty', data: {} }
    }
  }

  async getTrackUrl(decodedTrack: BestMatchTrackInfo, itag: unknown, forceRefresh = false): Promise<AnyObj> {
    const query = `${decodedTrack.title} ${decodedTrack.author}`

    try {
      let searchResult: LoadResult | null = null

      const isrc = (decodedTrack as BestMatchTrackInfo & { isrc?: string | null }).isrc
      if (isrc) {
        searchResult = await this.nodelink.sources.search(
          'youtube',
          `"${isrc}"`,
          'ytmsearch'
        )
        if (searchResult.loadType !== 'search' || (searchResult as LoadResultSearch).data.length === 0)
          searchResult = null
      }

      if (!searchResult) {
        searchResult = await this.nodelink.sources.search('youtube', query, 'ytmsearch')
      }

      if (searchResult.loadType !== 'search' || (searchResult as LoadResultSearch).data.length === 0) {
        searchResult = await this.nodelink.sources.searchWithDefault(query)
      }

      if (searchResult.loadType !== 'search' || (searchResult as LoadResultSearch).data.length === 0) {
        throw new Error('No alternative stream found via default search.')
      }

      const candidates = (searchResult as LoadResultSearch).data as unknown as BestMatchCandidate[]
      const bestMatch = getBestMatch(candidates, decodedTrack)
      if (!bestMatch) throw new Error('No suitable alternative stream found after filtering.')

      const streamInfo = await this.nodelink.sources.getTrackUrl(
        bestMatch.info as unknown as TrackEncodeInput,
        itag,
        forceRefresh
      )
      return { newTrack: bestMatch, ...streamInfo }
    } catch (e) {
      logger('warn', 'AmazonMusic', `Mirror search for "${query}" failed: ${(e as Error).message}`)
      throw e
    }
  }

  async loadStream(): Promise<null> {
    return null
  }
}
