import crypto from 'node:crypto'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  CacheEntry,
  FetchedLyrics,
  FormattedLyrics,
  LyricsLine,
  LyricsResult,
  MxmMacroBody,
  MxmParsedSubtitleItem,
  MxmSearchBody,
  MxmTrack,
  MxmTrackItem,
  NodelinkInstanceForMusixmatch,
  ScoredTrack,
  TokenData,
  TrackInfo
} from '../typings/lyrics/musixmatch.types.ts'
import { http1makeRequest, logger } from '../utils.ts'

class HttpError extends Error {
  status: number
  constructor(status: number, message?: string) {
    super(message || `HTTP ${status}`)
    this.name = 'HttpError'
    this.status = status
  }
}

class MxmApiError extends Error {
  code: number
  hint?: string
  constructor(code: number, hint?: string) {
    super(hint || `Musixmatch API error ${code}`)
    this.name = 'MxmApiError'
    this.code = code
    if (hint !== undefined) this.hint = hint
  }
}

const APP_ID = 'android-player-v1.0'
const TOKEN_TTL = 55000
const TOKEN_PERSIST_INTERVAL = 5000
const CACHE_TTL = 180000
const MAX_CACHE_SIZE = 100

const ENDPOINTS = Object.freeze({
  TOKEN: 'https://apic.musixmatch.com/ws/1.1/token.get',
  SEARCH: 'https://apic.musixmatch.com/ws/1.1/track.search',
  LYRICS: 'https://apic.musixmatch.com/ws/1.1/track.lyrics.get',
  SUBTITLES: 'https://apic.musixmatch.com/ws/1.1/track.subtitle.get',
  MACRO: 'https://apic.musixmatch.com/ws/1.1/macro.subtitles.get'
})

const CLEAN_PATTERNS = [
  /\s*\([^)]*(?:official|lyrics?|video|audio|mv|visualizer|color\s*coded|hd|4k|prod\.)[^)]*\)/gi,
  /\s*\[[^\]]*(?:official|lyrics?|video|audio|mv|visualizer|color\s*coded|hd|4k|prod\.)[^\]]*\]/gi,
  /\s*-\s*Topic$/i,
  /VEVO$/i
]

const BRACKET_JUNK =
  /\s*\[([^\]]*(?:official|lyrics?|video|audio|mv|visualizer|color\s*coded|hd|4k)[^\]]*)\]/gi

const FEAT_PATTERN = /\s*[([]\s*(?:ft\.?|feat\.?|featuring)\s+[^)\]]+[)\]]/gi

const SEPARATORS = [' - ', ' – ', ' — ', ' ~ ']

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'

const DEFAULT_COOKIE =
  'AWSELB=unknown; x-mxm-user-id=undefined; x-mxm-token-guid=undefined; mxm-encrypted-token='

const isAuthCode = (code: number): boolean => code === 401 || code === 403

const extractMacroCalls = (body: MxmMacroBody | unknown) => {
  const calls = (body as MxmMacroBody | undefined)?.macro_calls
  return {
    lyrics: calls?.['track.lyrics.get']?.message?.body?.lyrics?.lyrics_body,
    track: calls?.['matcher.track.get']?.message?.body?.track,
    subtitles:
      calls?.['track.subtitles.get']?.message?.body?.subtitle_list?.[0]
        ?.subtitle?.subtitle_body
  }
}

const _guid = (): string =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })

const _buildUrl = (
  base: string,
  params: Record<string, string | undefined>
): string => {
  const url = new URL(base)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v))
  }
  return url.toString()
}

const _norm = (s: string): string => s.replace(/\s+/g, ' ').trim()

const _stripFeaturing = (s: string): string => {
  const lower = s.toLowerCase()
  let cut = -1
  for (const m of [' feat.', ' ft.', ' featuring ']) {
    const i = lower.indexOf(m)
    if (i !== -1 && (cut === -1 || i < cut)) cut = i
  }
  return (cut === -1 ? s : s.slice(0, cut)).trim()
}

const _stripJunkParens = (s: string): string => {
  let str = s
  for (;;) {
    str = str.trim()
    if (!str.endsWith(')')) return str
    const open = str.lastIndexOf('(')
    if (open === -1) return str
    const inside = str.slice(open + 1, -1).toLowerCase()
    const junk = [
      'official',
      'lyrics',
      'video',
      'audio',
      'mv',
      'visualizer',
      'hd',
      '4k'
    ]
    if (junk.some((w) => inside.includes(w))) {
      str = str.slice(0, open)
      continue
    }
    return str
  }
}

const _clean = (text: string, removeFeat = false): string => {
  let result = text
  for (const pattern of CLEAN_PATTERNS) result = result.replace(pattern, '')
  if (removeFeat) result = result.replace(FEAT_PATTERN, '')
  return result.trim()
}

const _parse = (query: string): { artist: string | null; title: string } => {
  let cleaned = _norm(query.replace(BRACKET_JUNK, ''))
  cleaned = _stripJunkParens(cleaned)

  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1).trim()
  }

  for (const sep of SEPARATORS) {
    const idx = cleaned.indexOf(sep)
    if (idx > 0 && idx < cleaned.length - sep.length) {
      const artist = cleaned.slice(0, idx).trim()
      const title = cleaned.slice(idx + sep.length).trim()
      if (artist && title) {
        return {
          artist: _stripFeaturing(_stripJunkParens(_norm(artist))),
          title: _stripFeaturing(_stripJunkParens(_norm(title)))
        }
      }
    }
  }

  for (const ch of ['–', '—', '~', '-'] as const) {
    const idx = cleaned.indexOf(ch)
    if (idx <= 0 || idx >= cleaned.length - 1) continue
    if (ch === '-' && cleaned[idx - 1] !== ' ' && cleaned[idx + 1] !== ' ')
      continue
    const artist = cleaned.slice(0, idx).trim()
    const title = cleaned.slice(idx + 1).trim()
    if (artist && title) {
      return {
        artist: _stripFeaturing(_stripJunkParens(_norm(artist))),
        title: _stripFeaturing(_stripJunkParens(_norm(title)))
      }
    }
  }

  if (!cleaned.includes(' ')) {
    const idx = cleaned.indexOf('-')
    if (
      idx > 0 &&
      idx === cleaned.lastIndexOf('-') &&
      idx < cleaned.length - 1
    ) {
      return {
        artist: _stripFeaturing(cleaned.slice(0, idx)),
        title: _stripFeaturing(cleaned.slice(idx + 1))
      }
    }
  }

  return {
    artist: null,
    title: _stripFeaturing(_stripJunkParens(_norm(cleaned)))
  }
}

export default class MusixmatchLyrics {
  private nodelink: NodelinkInstanceForMusixmatch
  private guid: string
  private useManualToken: boolean
  private tokenData: TokenData | null
  private tokenPromise: Promise<string> | null
  private lastTokenPersist: number
  private cookies: Map<string, string>
  private cache: Map<string, CacheEntry<LyricsResult>>
  private cacheCleanup: ReturnType<typeof setInterval> | null
  private tokenFile: string

  constructor(nodelink: NodelinkInstanceForMusixmatch) {
    this.nodelink = nodelink
    this.guid = _guid()
    this.useManualToken = false
    this.tokenData = null
    this.tokenPromise = null
    this.lastTokenPersist = 0
    this.cookies = new Map()
    this.cache = new Map()
    this.cacheCleanup = null
    this.tokenFile = path.join(os.tmpdir(), 'mxm_token.json')
  }

  async setup(): Promise<boolean> {
    const signatureSecret =
      this.nodelink.options.lyrics?.musixmatch?.signatureSecret
    this.useManualToken = !!signatureSecret

    logger(
      'info',
      'Lyrics',
      `Musixmatch using ${this.useManualToken ? 'signature' : 'automatic token'} authentication`
    )

    if (!this.useManualToken) {
      const cachedToken =
        this.nodelink.credentialManager.get('musixmatch_token')
      if (cachedToken) {
        this.tokenData = cachedToken
        logger(
          'info',
          'Lyrics',
          'Loaded Musixmatch token from CredentialManager'
        )
      }
    }

    this._startCacheCleanup()
    return true
  }

  destroy(): void {
    if (this.cacheCleanup) {
      clearInterval(this.cacheCleanup)
      this.cacheCleanup = null
    }
    this.cache.clear()
    this.cookies.clear()
  }

  private _startCacheCleanup(): void {
    this.cacheCleanup = setInterval(() => {
      const now = Date.now()
      for (const [key, entry] of this.cache) {
        if (entry.expires <= now) this.cache.delete(key)
      }
    }, 60000)
    if (this.cacheCleanup.unref) this.cacheCleanup.unref()
  }

  private _cacheKey(artist: string | null, title: string): string {
    return `${(artist || '').toLowerCase().trim()}|${title.toLowerCase().trim()}`
  }

  private _getCache(key: string): LyricsResult | undefined {
    const entry = this.cache.get(key)
    if (!entry) return undefined
    if (entry.expires <= Date.now()) {
      this.cache.delete(key)
      return undefined
    }
    this.cache.delete(key)
    this.cache.set(key, entry)
    return entry.value
  }

  private _setCache(key: string, value: LyricsResult): void {
    const now = Date.now()
    for (const [k, v] of this.cache) {
      if (v.expires <= now) this.cache.delete(k)
    }
    while (this.cache.size >= MAX_CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value as string | undefined
      if (!firstKey) break
      this.cache.delete(firstKey)
    }
    this.cache.set(key, { value, expires: now + CACHE_TTL })
  }

  private _signUrl(url: string): string {
    const secret = this.nodelink.options.lyrics?.musixmatch?.signatureSecret
    if (!secret) throw new Error('Musixmatch signatureSecret not configured')

    const dt = new Date()
    const timestamp = `${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, '0')}${String(dt.getUTCDate()).padStart(2, '0')}`
    const signature = crypto
      .createHmac('sha1', secret)
      .update(url + timestamp)
      .digest('base64')

    return `${url}&signature=${encodeURIComponent(signature)}&signature_protocol=sha1`
  }

  private _parseCookies(headers: string | string[] | number | undefined): void {
    if (!headers) return
    const list = Array.isArray(headers) ? headers : [headers]
    for (const h of list) {
      if (typeof h !== 'string') continue
      const cookieStr = h
      const semiParts = cookieStr.split(';')
      const firstPart = semiParts[0]
      if (!firstPart) continue
      const parts = firstPart.split('=')
      if (parts.length === 2) {
        const key = parts[0]
        const value = parts[1]
        if (key && value) this.cookies.set(key.trim(), value.trim())
      }
    }
  }

  private _getCookies(): string {
    return this.cookies.size === 0
      ? ''
      : Array.from(this.cookies, ([k, v]) => `${k}=${v}`).join('; ')
  }

  private async _fetchToken(): Promise<string> {
    const url = _buildUrl(ENDPOINTS.TOKEN, { app_id: APP_ID })
    const { statusCode, headers, body } = await http1makeRequest(url, {
      method: 'GET',
      headers: {
        accept: '*/*',
        'accept-language': 'en',
        cookie: DEFAULT_COOKIE,
        'user-agent': DEFAULT_UA
      }
    })

    if (headers?.['set-cookie']) {
      this._parseCookies(headers['set-cookie'])
    }

    if (statusCode !== 200) throw new HttpError(statusCode ?? 0)

    const parsed = typeof body === 'string' ? JSON.parse(body) : body
    const header = parsed?.message?.header
    const token = parsed?.message?.body?.user_token

    if (header?.status_code !== 200)
      throw new MxmApiError(header?.status_code ?? 0, header?.hint)

    if (!token) throw new MxmApiError(0, header?.hint || 'No token in response')

    return token
  }

  private async _resetToken(hard = false): Promise<void> {
    this.tokenData = null
    this.tokenPromise = null
    if (hard) {
      this.cookies.clear()
      try {
        await unlink(this.tokenFile)
      } catch {}
    }
  }

  private async _readToken(): Promise<TokenData | null> {
    try {
      const data = await readFile(this.tokenFile, 'utf-8')
      const parsed = JSON.parse(data)
      if (
        parsed?.value &&
        typeof parsed.expires === 'number' &&
        parsed.expires > Date.now()
      )
        return parsed
    } catch {}
    return null
  }

  private async _saveToken(token: string, expires: number): Promise<void> {
    try {
      await writeFile(this.tokenFile, JSON.stringify({ value: token, expires }))
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e)
      logger('warn', 'Lyrics', `Failed to save token: ${message}`)
    }
  }

  private _storeToken(token: string): string {
    const expires = Date.now() + TOKEN_TTL
    this.tokenData = { value: token, expires }
    this.nodelink.credentialManager.set(
      'musixmatch_token',
      this.tokenData,
      TOKEN_TTL
    )
    this._saveToken(token, expires).catch(() => {})
    return token
  }

  private async _getToken(force = false): Promise<string> {
    const now = Date.now()

    if (!force && this.tokenData && now < this.tokenData.expires) {
      this.tokenData.expires = now + TOKEN_TTL
      if (now - this.lastTokenPersist > TOKEN_PERSIST_INTERVAL) {
        this.lastTokenPersist = now
        this._saveToken(this.tokenData.value, this.tokenData.expires).catch(
          () => {}
        )
      }
      return this.tokenData.value
    }

    if (!this.tokenData && !force) {
      this.tokenData = await this._readToken()
      if (this.tokenData && now < this.tokenData.expires)
        return this.tokenData.value
    }

    if (this.tokenPromise) return this.tokenPromise

    this.tokenPromise = this._acquireToken()
    try {
      return await this.tokenPromise
    } finally {
      this.tokenPromise = null
    }
  }

  private async _acquireToken(): Promise<string> {
    try {
      return this._storeToken(await this._fetchToken())
    } catch (err: unknown) {
      const mxmError = err instanceof MxmApiError ? err : null
      const isCaptcha =
        mxmError?.hint?.toLowerCase().includes('captcha') ?? false
      const isAuth =
        (mxmError && isAuthCode(mxmError.code)) ||
        (err instanceof HttpError && isAuthCode(err.status))

      if (isCaptcha || isAuth) {
        this.cookies.clear()
        return this._storeToken(await this._fetchToken())
      }
      throw err
    }
  }

  private async _request(
    endpoint: string,
    params: Record<string, string | undefined>
  ): Promise<unknown> {
    const token = this.useManualToken ? undefined : await this._getToken()
    let url = _buildUrl(endpoint, {
      ...params,
      app_id: APP_ID,
      ...(token ? { usertoken: token } : {}),
      guid: this.guid
    })

    if (this.useManualToken) url = this._signUrl(url)

    const { statusCode, headers, body } = await http1makeRequest(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': DEFAULT_UA,
        cookie: this._getCookies()
      }
    })

    if (!this.useManualToken && headers?.['set-cookie']) {
      this._parseCookies(headers['set-cookie'])
    }

    const parsed = typeof body === 'string' ? JSON.parse(body) : body
    const apiStatus = parsed?.message?.header?.status_code
    const apiHint = parsed?.message?.header?.hint

    if (isAuthCode(statusCode ?? 0) || isAuthCode(apiStatus)) {
      if (!this.useManualToken) {
        const isCaptcha = apiHint?.toLowerCase().includes('captcha')
        await this._resetToken(!!isCaptcha)
        const newToken = await this._getToken(true)
        const retryUrl = _buildUrl(endpoint, {
          ...params,
          app_id: APP_ID,
          usertoken: newToken,
          guid: this.guid
        })

        const {
          statusCode: retryStatus,
          headers: retryHeaders,
          body: retryBody
        } = await http1makeRequest(retryUrl, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'user-agent': DEFAULT_UA,
            cookie: this._getCookies()
          }
        })

        if (retryHeaders?.['set-cookie']) {
          this._parseCookies(retryHeaders['set-cookie'])
        }
        const retryParsed =
          typeof retryBody === 'string' ? JSON.parse(retryBody) : retryBody

        if (
          retryStatus !== 200 ||
          retryParsed?.message?.header?.status_code !== 200
        )
          return null

        return retryParsed.message.body
      }
      return null
    }

    return statusCode === 200 && apiStatus === 200 ? parsed.message.body : null
  }

  private async _fetchMacro(
    title: string,
    artist: string | null
  ): Promise<FetchedLyrics | null> {
    const body = await this._request(ENDPOINTS.MACRO, {
      format: 'json',
      namespace: 'lyrics_richsynched',
      subtitle_format: 'mxm',
      q_track: title,
      q_artist: artist || undefined
    })

    if (!body) return null

    const { lyrics, track, subtitles } = extractMacroCalls(body)
    if (!lyrics && !subtitles) return null

    return {
      subtitles: subtitles ? this._parseSubtitles(subtitles) : null,
      lyrics: lyrics || null,
      track: track || {}
    }
  }

  private async _searchWithSubtitles(
    title: string,
    artist: string | null
  ): Promise<FetchedLyrics | null> {
    const body = (await this._request(ENDPOINTS.SEARCH, {
      page_size: artist ? '3' : '5',
      page: '1',
      s_track_rating: 'desc',
      f_has_subtitle: '1',
      q_track: title,
      q_artist: artist || undefined,
      q_track_artist: artist ? `${artist} ${title}` : undefined
    })) as MxmSearchBody

    if (!body?.track_list?.length) return null

    for (const item of body.track_list) {
      const track = item?.track
      const id = track?.track_id
      if (!id) continue

      try {
        const subBody = (await this._request(ENDPOINTS.SUBTITLES, {
          track_id: String(id),
          subtitle_format: 'mxm'
        })) as { subtitle?: { subtitle_body?: string } }
        const subtitleStr = subBody?.subtitle?.subtitle_body
        if (subtitleStr) {
          const subtitles = this._parseSubtitles(subtitleStr)
          if (subtitles?.length) return { subtitles, lyrics: null, track }
        }
      } catch {}
    }
    return null
  }

  private async _search(
    artist: string | null,
    title: string | null
  ): Promise<MxmTrack | null> {
    const params: Record<string, string | undefined> = {}
    if (artist) params.q_artist = artist
    if (title) params.q_track = title

    const body = (await this._request(ENDPOINTS.SEARCH, {
      ...params,
      page_size: '3',
      page: '1',
      s_track_rating: 'desc'
    })) as MxmSearchBody
    if (!body?.track_list) return null

    const tracks = body.track_list.map((item: MxmTrackItem) => {
      const track = item.track
      const tTitle = track?.track_name?.toLowerCase() ?? ''
      const tArtist = track?.artist_name?.toLowerCase() ?? ''
      const sTitle = (title || '').toLowerCase()
      const sArtist = (artist || '').toLowerCase()

      let score = (track?.track_rating ?? 0) / 10
      if (tTitle === sTitle) score += 100
      else if (tTitle.includes(sTitle)) score += 50
      else if (sTitle.includes(tTitle)) score += 30

      if (artist) {
        if (tArtist === sArtist) score += 100
        else if (tArtist.includes(sArtist)) score += 50
        else if (sArtist.includes(tArtist)) score += 30
      }

      // biome-ignore lint/style/noNonNullAssertion: false positive
      return { track: track!, score }
    })

    tracks.sort((a: ScoredTrack, b: ScoredTrack) => b.score - a.score)
    return tracks[0]?.track || null
  }

  private _parseSubtitles(subBody: string): LyricsLine[] | null {
    try {
      const parsed = JSON.parse(subBody)
      const arr = Array.isArray(parsed) ? parsed : parsed?.subtitle
      if (!Array.isArray(arr) || !arr.length) return null

      return arr.map((item: MxmParsedSubtitleItem) => ({
        text: String(item?.text ?? ''),
        time: Math.round((item?.time?.total ?? 0) * 1000),
        duration: Math.round((item?.time?.duration ?? 0) * 1000)
      }))
    } catch {
      return null
    }
  }

  private async _getLyrics(trackId: number): Promise<string | null> {
    const body = (await this._request(ENDPOINTS.LYRICS, {
      track_id: String(trackId)
    })) as { lyrics?: { lyrics_body?: string } }
    return body?.lyrics?.lyrics_body || null
  }

  private async _getSubtitles(trackId: number): Promise<LyricsLine[] | null> {
    const body = (await this._request(ENDPOINTS.SUBTITLES, {
      track_id: String(trackId),
      subtitle_format: 'mxm'
    })) as { subtitle?: { subtitle_body?: string } }
    const subBody = body?.subtitle?.subtitle_body
    return subBody ? this._parseSubtitles(subBody) : null
  }

  private _format(
    lyrics: string | null,
    subtitles: LyricsLine[] | null,
    track: MxmTrack
  ): FormattedLyrics | null {
    if (subtitles?.length) {
      return {
        synced: true,
        lines: subtitles,
        name: track?.track_name || 'Unknown'
      }
    }

    if (lyrics) {
      const lines = lyrics
        .split('\n')
        .map((line): LyricsLine | null => {
          const trimmed = line.trim()
          return trimmed ? { text: trimmed, time: 0, duration: 0 } : null
        })
        .filter((l): l is LyricsLine => l !== null)

      if (!lines.length) return null

      return {
        synced: false,
        lines,
        name: track?.track_name || 'Unknown'
      }
    }

    return null
  }

  private _raceForFirst<T>(
    factories: Array<(signal: AbortSignal) => Promise<T | null>>
  ): Promise<T | null> {
    if (!factories.length) return Promise.resolve(null)

    const controller = new AbortController()
    const promises = factories.map((fn) => fn(controller.signal))

    return new Promise((resolve) => {
      let pending = promises.length
      let done = false

      const settle = (result: T | null) => {
        if (done) return
        if (result !== null) {
          done = true
          controller.abort()
          resolve(result)
        } else if (--pending === 0) {
          resolve(null)
        }
      }

      for (const p of promises) p.then(settle, () => settle(null))
    })
  }

  async getLyrics(trackInfo: TrackInfo): Promise<LyricsResult> {
    try {
      const parsed = _parse(trackInfo.title)
      const cleanAuthor = _clean(trackInfo.author, false)
      const artist = parsed.artist || cleanAuthor
      const title = parsed.artist ? parsed.title : _clean(trackInfo.title, true)

      const cacheKey = this._cacheKey(artist, title)
      const cached = this._getCache(cacheKey)
      if (cached !== undefined) {
        logger('debug', 'Lyrics', 'Cache hit')
        return cached
      }

      logger('info', 'Lyrics', `Searching: "${title}" by "${artist}"`)

      let found: FetchedLyrics | null = null

      if (artist && title) {
        found = await this._raceForFirst([
          () => this._fetchMacro(title, artist),
          () => this._searchWithSubtitles(title, artist)
        ])
      }

      if (!found && title) {
        found = await this._fetchMacro(title, null)
      }

      if (!found) {
        let track = artist && title ? await this._search(artist, title) : null
        if (!track && title) track = await this._search(null, title)

        if (track?.track_id) {
          const [subtitles, lyrics] = await Promise.allSettled([
            this._getSubtitles(track.track_id),
            this._getLyrics(track.track_id)
          ])

          found = {
            subtitles:
              subtitles.status === 'fulfilled' ? subtitles.value : null,
            lyrics: lyrics.status === 'fulfilled' ? lyrics.value : null,
            track
          }
        }
      }

      if (!found) {
        const result: LyricsResult = { loadType: 'empty', data: {} }
        this._setCache(cacheKey, result)
        return result
      }

      const formatted = this._format(found.lyrics, found.subtitles, found.track)

      if (!formatted?.lines.length) {
        const result: LyricsResult = { loadType: 'empty', data: {} }
        this._setCache(cacheKey, result)
        return result
      }

      logger(
        'info',
        'Lyrics',
        `Found: "${found.track?.track_name}" by ${found.track?.artist_name}`
      )

      logger(
        'info',
        'Lyrics',
        `Success: ${formatted.lines.length} lines (synced: ${formatted.synced})`
      )

      const result: LyricsResult = {
        loadType: 'lyrics',
        data: {
          name: formatted.name,
          synced: formatted.synced,
          lines: formatted.lines,
          provider: 'musixmatch'
        }
      }

      this._setCache(cacheKey, result)
      return result
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e)
      logger('error', 'Lyrics', `Failed: ${message}`)
      return {
        loadType: 'error',
        data: { message, severity: 'fault' }
      }
    }
  }
}
