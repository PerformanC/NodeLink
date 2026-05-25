import type {
  SourceInstance,
  SourceResult,
  TrackData,
  TrackInfo,
  TrackUrlResult,
  WorkerNodeLink
} from '../typings/sources/source.types.ts'
import type {
  BestMatchCandidate,
  TrackEncodeInput
} from '../typings/utils.types.ts'
import type { BoomplaySourceConfig } from '../typings/config/config.types.ts'
import type {
  BoomplayRawTrack,
  BoomplayParsedQuery,
  BoomplayParsedData
} from '../typings/sources/boomplay.types.ts'
import {
  encodeTrack,
  getBestMatch,
  http1makeRequest,
  logger
} from '../utils.ts'

const BOOMPLAY_BASE = 'https://www.boomplay.com'
const AES_KEY = 'boomplayVr3xopAM'
const AES_IV = 'boomplay8xIsKTn9'
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
const ANDROID_UA = 'BoomplayMusicApp/6.0 (Android; BoomPlayer)'

function strToBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str)
}

async function aesEncrypt(plaintext: string): Promise<string> {
  const keyBytes = strToBytes(AES_KEY)
  const ivBytes = strToBytes(AES_IV)
  const dataBytes = strToBytes(plaintext)
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw',
    keyBytes as unknown as BufferSource,
    { name: 'AES-CBC' },
    false,
    ['encrypt']
  )
  const encrypted = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: ivBytes as unknown as BufferSource },
    cryptoKey,
    dataBytes as unknown as BufferSource
  )
  return btoa(String.fromCharCode(...new Uint8Array(encrypted)))
}

async function aesDecrypt(base64Cipher: string): Promise<string> {
  const keyBytes = strToBytes(AES_KEY)
  const ivBytes = strToBytes(AES_IV)
  const cipherBytes = Uint8Array.from(atob(base64Cipher), (c) =>
    c.charCodeAt(0)
  )
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw',
    keyBytes as unknown as BufferSource,
    { name: 'AES-CBC' },
    false,
    ['decrypt']
  )
  const decrypted = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: ivBytes as unknown as BufferSource },
    cryptoKey,
    cipherBytes as unknown as BufferSource
  )
  return new TextDecoder().decode(decrypted)
}

function metaContent(html: string, _attr: string, value: string): string | null {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${value}["'][^>]+content=["']([^"']+)["']`,
    'i'
  )
  const m =
    html.match(re) ??
    html.match(
      new RegExp(
        `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${value}["']`,
        'i'
      )
    )
  return m ? (m[1] ?? null) : null
}

function jsonLd(html: string, type: string): Record<string, unknown> | null {
  const re =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    try {
      if (!m[1]) continue
      const obj = JSON.parse(m[1]) as Record<string, unknown>
      if (obj['@type'] === type) return obj
    } catch {}
  }
  return null
}

function allMatches(html: string, re: RegExp): RegExpExecArray[] {
  const results: RegExpExecArray[] = []
  let m: RegExpExecArray | null
  const reG = new RegExp(
    re.source,
    re.flags.includes('g') ? re.flags : re.flags + 'g'
  )
  while ((m = reG.exec(html)) !== null) results.push(m)
  return results
}

function cleanText(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim()
}

function parseDataDataMetadata(raw: string): BoomplayParsedData {
  const decoded = raw
    .replace(/%40%2B%23/gi, '@+#')
    .replace(/%3A/gi, ':')
    .replace(/%2F/gi, '/')
    .replace(/%3F/gi, '?')
    .replace(/%3D/gi, '=')
    .replace(/%26/gi, '&')
    .replace(/%20/gi, ' ')
    .replace(/%28/gi, '(')
    .replace(/%29/gi, ')')
    .replace(/%2C/gi, ',')
    .replace(/%27/gi, "'")
    .replace(/%22/gi, '"')
    .replace(/%21/gi, '!')
    .replace(/%2E/gi, '.')
    .replace(/%2D/gi, '-')
    .replace(/%5F/gi, '_')
    .replace(/%7C/gi, '|')

  const parts = decoded.split('@+#')
  if (parts.length < 6) return {}

  const titleCandidate = parts[4]?.trim()
  const artistCandidate = parts[5]?.trim()
  const imgCandidate = parts[3]?.trim()
  const timeCandidate = parts[7]?.trim()

  return {
    title: titleCandidate
      ? cleanText(
          decodeURIComponent(titleCandidate).replace(/%/g, '').trim() ||
            titleCandidate
        )
      : undefined,
    artistName: artistCandidate
      ? cleanText(
          decodeURIComponent(artistCandidate).replace(/%/g, '').trim() ||
            artistCandidate
        )
      : undefined,
    artworkUrl:
      imgCandidate && imgCandidate.startsWith('http') ? imgCandidate : null,
    duration:
      timeCandidate && /^\d{1,2}:\d{2}$/.test(timeCandidate)
        ? mmssToSeconds(timeCandidate)
        : undefined
  }
}

function mmssToSeconds(t: string): number {
  const parts = t.trim().split(':')
  if (parts.length === 2)
    return parseInt(parts[0] ?? '0', 10) * 60 + parseInt(parts[1] ?? '0', 10)
  if (parts.length === 3)
    return (
      parseInt(parts[0] ?? '0', 10) * 3600 +
      parseInt(parts[1] ?? '0', 10) * 60 +
      parseInt(parts[2] ?? '0', 10)
    )
  return 0
}

function isoDurationToSeconds(iso: string): number {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
  if (!m) return 0
  return (
    parseInt(m[1] ?? '0', 10) * 3600 +
    parseInt(m[2] ?? '0', 10) * 60 +
    parseInt(m[3] ?? '0', 10)
  )
}

function attrVal(attrString: string, name: string): string | null {
  const re = new RegExp(`${name}=["']([^"']+)["']`, 'i')
  return attrString.match(re)?.[1] ?? null
}

function attrValFromHtml(html: string, attr: string): string | null {
  const re = new RegExp(`${attr}=["']([^"']+)["']`, 'i')
  return html.match(re)?.[1] ?? null
}

async function fetchPage(url: string, cookies = ''): Promise<string | null> {
  try {
    const headers: Record<string, string> = {
      'User-Agent': DESKTOP_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache'
    }
    if (cookies) headers['Cookie'] = cookies
    const res = await http1makeRequest(url, { method: 'GET', headers })
    if (res.statusCode !== 200) {
      logger('debug', 'Boomplay', `fetchPage ${url} → HTTP ${res.statusCode}`)
      return null
    }
    return typeof res.body === 'string' ? res.body : JSON.stringify(res.body)
  } catch (err) {
    logger('debug', 'Boomplay', `fetchPage error ${url}: ${err}`)
    return null
  }
}

function parseSearchHtml(html: string): BoomplayRawTrack[] {
  const tracks: BoomplayRawTrack[] = []
  const seen = new Set<string>()

  const liRe = /<li[^>]+class="[^"]*\bplay_one\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi
  const liMatches = allMatches(html, liRe)

  for (const li of liMatches) {
    const block = li[0]
    const idMatch = block.match(/\bdata-id=["'](\d+)["']/)
    if (!idMatch) continue
    const id = idMatch[1]
    if (!id || seen.has(id)) continue
    seen.add(id)

    const dataDataMatch = block.match(/\bdata-data=["']([^"']+)["']/)
    let title: string | null = null
    let artistName = 'Unknown'
    let duration = 0
    let artworkUrl: string | null = null

    if (dataDataMatch) {
      const metadata = parseDataDataMetadata(dataDataMatch[1] ?? '')
      if (metadata.title) title = metadata.title
      if (metadata.artistName) artistName = metadata.artistName
      if (metadata.artworkUrl !== undefined) artworkUrl = metadata.artworkUrl
      if (metadata.duration !== undefined) duration = metadata.duration
    }

    if (!title) {
      const songAnchor = block.match(
        /<a[^>]+class="songName"[^>]*>\s*([\s\S]*?)\s*<\/a>/
      )
      if (songAnchor?.[1])
        title = cleanText(songAnchor[1].replace(/<[^>]+>/g, '').trim())
    }

    if (!title) continue

    if (artistName === 'Unknown') {
      const artistAnchor = block.match(
        /<a[^>]+class="artistName"[^>]*>\s*([\s\S]*?)\s*<\/a>/
      )
      if (artistAnchor?.[1])
        artistName = cleanText(artistAnchor[1].replace(/<[^>]+>/g, '').trim())
    }

    if (duration === 0) {
      const timeEl = block.match(/<time[^>]*>(\d{1,2}:\d{2})<\/time>/)
      if (timeEl?.[1]) duration = mmssToSeconds(timeEl[1])
    }

    tracks.push({
      id,
      title,
      artistName,
      duration,
      artworkUrl,
      isrc: null,
      uri: `${BOOMPLAY_BASE}/songs/${id}`
    })
  }

  if (tracks.length > 0) return tracks

  const liRe2 = /<li[^>]+class="[^"]*songlist-item[^"]*"([\s\S]*?)<\/li>/gi
  const liMatches2 = allMatches(html, liRe2)

  for (const li of liMatches2) {
    const attrs = li[1] ?? ''
    const id = attrVal(attrs, 'data-id')
    const title2 = attrVal(attrs, 'data-name')
    const artist =
      attrVal(attrs, 'data-artiste') ?? attrVal(attrs, 'data-artist')
    const durStr = attrVal(attrs, 'data-duration')
    const isrc = attrVal(attrs, 'data-isrc')
    const imgMatch = attrs.match(/<img[^>]+src=["']([^"']+)["']/)
    const artwork = imgMatch?.[1] ?? null

    if (!id || !title2 || seen.has(id)) continue
    seen.add(id)

    tracks.push({
      id,
      title: cleanText(title2),
      artistName: cleanText(artist ?? 'Unknown'),
      duration: durStr ? parseInt(durStr, 10) : 0,
      artworkUrl: artwork,
      isrc: isrc ?? null,
      uri: `${BOOMPLAY_BASE}/songs/${id}`
    })
  }

  if (tracks.length > 0) return tracks

  const jsonScriptRe =
    /<script[^>]*>\s*var\s+searchResult\s*=\s*(\{[\s\S]*?\});\s*<\/script>/i
  const jsonMatch = html.match(jsonScriptRe)
  if (jsonMatch?.[1]) {
    try {
      const data = JSON.parse(jsonMatch[1]) as {
        songs?: Array<{
          id: number | string
          title?: string
          name?: string
          artiste?: string
          artist?: string
          duration?: number
          isrc?: string
          coverImage?: string
          artwork?: string
        }>
      }
      for (const s of data.songs ?? []) {
        const id = String(s.id)
        const title = s.title ?? s.name
        if (!id || !title || seen.has(id)) continue
        seen.add(id)
        tracks.push({
          id,
          title: cleanText(title),
          artistName: cleanText(s.artiste ?? s.artist ?? 'Unknown'),
          duration: s.duration ?? 0,
          artworkUrl: s.coverImage ?? s.artwork ?? null,
          isrc: s.isrc ?? null,
          uri: `${BOOMPLAY_BASE}/songs/${id}`
        })
      }
    } catch {}
  }

  return tracks
}

function parseTrackPage(html: string, songId: string): BoomplayRawTrack | null {
  const ld = jsonLd(html, 'MusicRecording')

  let title: string | null = null
  let artist: string | null = null
  let durationSec = 0
  let artworkUrl: string | null = null
  let isrc: string | null = null

  if (ld) {
    title = (ld['name'] as string | undefined) ?? null
    const byArtist = ld['byArtist']
    if (Array.isArray(byArtist) && byArtist.length > 0) {
      artist =
        ((byArtist[0] as Record<string, unknown>)?.['name'] as string) ?? null
    } else if (byArtist && typeof byArtist === 'object') {
      artist =
        ((byArtist as Record<string, unknown>)?.['name'] as string) ?? null
    }
    const iso = ld['duration'] as string | undefined
    if (iso) durationSec = isoDurationToSeconds(iso)
    artworkUrl = (ld['image'] as string | undefined) ?? null
    isrc = (ld['isrcCode'] as string | undefined) ?? null
  }

  artworkUrl ??= metaContent(html, 'property', 'og:image')

  if (!title) {
    const ogTitle = metaContent(html, 'property', 'og:title') ?? ''
    const m = ogTitle.match(/^(.+?)\s*-\s*(.+?)\s*(?:MP3|Download|Lyrics|\|)/)
    if (m?.[1]) artist ??= cleanText(m[1])
    if (m?.[2]) title = cleanText(m[2])
  }

  if (!artist) {
    const artistMatch = html.match(/Artist:\s*([^<"]+)/)
    if (artistMatch?.[1]) artist = cleanText(artistMatch[1])
  }

  if (durationSec === 0) {
    const timeEl = html.match(/<time[^>]*>(\d{1,2}:\d{2})<\/time>/)
    if (timeEl?.[1]) durationSec = mmssToSeconds(timeEl[1])
  }

  if (durationSec === 0) {
    const dataAttr = html.match(/data-data="([^"]+)"/)
    if (dataAttr?.[1]) {
      const timeMatch = dataAttr[1].match(/@\+#(\d{1,2}:\d{2})@\+#/)
      if (timeMatch?.[1]) durationSec = mmssToSeconds(timeMatch[1])
    }
  }

  if (!title) return null

  return {
    id: songId,
    title: cleanText(title),
    artistName: cleanText(artist ?? 'Unknown'),
    duration: durationSec,
    artworkUrl,
    isrc,
    uri: `${BOOMPLAY_BASE}/songs/${songId}`
  }
}

function parseTrackListHtml(html: string): BoomplayRawTrack[] {
  const tracks: BoomplayRawTrack[] = []
  const seen = new Set<string>()

  const playOneRe =
    /<li[^>]+class="[^"]*\bplay_one\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi
  const playOneMatches = allMatches(html, playOneRe)

  for (const m of playOneMatches) {
    const block = m[0]
    const idMatch = block.match(/\bdata-id=["'](\d+)["']/)
    if (!idMatch) continue
    const id = idMatch[1]
    if (!id || seen.has(id)) continue
    seen.add(id)

    const dataDataMatch = block.match(/\bdata-data=["']([^"']+)["']/)
    let title: string | null = null
    let artistName = 'Unknown'
    let duration = 0
    let artworkUrl: string | null = null

    if (dataDataMatch) {
      const metadata = parseDataDataMetadata(dataDataMatch[1] ?? '')
      if (metadata.title) title = metadata.title
      if (metadata.artistName) artistName = metadata.artistName
      if (metadata.artworkUrl !== undefined) artworkUrl = metadata.artworkUrl
      if (metadata.duration !== undefined) duration = metadata.duration
    }

    if (!title) {
      const anchor = block.match(
        /<a[^>]+class="songName"[^>]*>\s*([\s\S]*?)\s*<\/a>/
      )
      if (anchor?.[1])
        title = cleanText(anchor[1].replace(/<[^>]+>/g, '').trim())
    }

    if (!title) continue

    if (artistName === 'Unknown') {
      const anchor = block.match(
        /<a[^>]+class="artistName"[^>]*>\s*([\s\S]*?)\s*<\/a>/
      )
      if (anchor?.[1])
        artistName = cleanText(anchor[1].replace(/<[^>]+>/g, '').trim())
    }

    if (duration === 0) {
      const timeEl = block.match(/<time[^>]*>(\d{1,2}:\d{2})<\/time>/)
      if (timeEl?.[1]) duration = mmssToSeconds(timeEl[1])
    }

    tracks.push({
      id,
      title,
      artistName,
      duration,
      artworkUrl,
      isrc: null,
      uri: `${BOOMPLAY_BASE}/songs/${id}`
    })
  }

  if (tracks.length > 0) return tracks

  const rowRe = /<(?:tr|li)[^>]+data-id=["'](\d+)["'][^>]*>/gi
  const rowMatches = allMatches(html, rowRe)

  for (const m of rowMatches) {
    const id = m[1]
    if (!id || seen.has(id)) continue
    seen.add(id)
    const start = m.index
    const snippet = html.slice(start, start + 2000)
    const title =
      attrValFromHtml(snippet, 'data-name') ??
      attrValFromHtml(snippet, 'data-title')
    const artist =
      attrValFromHtml(snippet, 'data-artiste') ??
      attrValFromHtml(snippet, 'data-artist')
    const durStr = attrValFromHtml(snippet, 'data-duration')
    const isrc = attrValFromHtml(snippet, 'data-isrc')
    const imgMatch = snippet.match(/<img[^>]+src=["']([^"']+)["']/)
    if (!title) continue
    tracks.push({
      id,
      title: cleanText(title),
      artistName: cleanText(artist ?? 'Unknown'),
      duration: durStr ? parseInt(durStr, 10) : 0,
      artworkUrl: imgMatch?.[1] ?? null,
      isrc: isrc ?? null,
      uri: `${BOOMPLAY_BASE}/songs/${id}`
    })
  }

  return tracks
}

function parseAlbumPage(html: string): { name: string; tracks: BoomplayRawTrack[] } | null {
  const albumLd = jsonLd(html, 'MusicAlbum')
  const name =
    (albumLd?.['name'] as string | undefined) ??
    metaContent(html, 'property', 'og:title') ??
    'Album'
  const tracks = parseTrackListHtml(html)
  if (tracks.length === 0) return null
  return { name: cleanText(name), tracks }
}

function parsePlaylistPage(html: string): { name: string; tracks: BoomplayRawTrack[] } | null {
  const name =
    metaContent(html, 'property', 'og:title') ??
    html.match(/<h1[^>]*class="[^"]*playlist[^"]*"[^>]*>([^<]+)<\/h1>/i)?.[1] ??
    'Playlist'
  const tracks = parseTrackListHtml(html)
  if (tracks.length === 0) return null
  return { name: cleanText(name), tracks }
}

function parseArtistPage(html: string): { name: string; tracks: BoomplayRawTrack[] } | null {
  const artistLd = jsonLd(html, 'MusicGroup')
  const name =
    (artistLd?.['name'] as string | undefined) ??
    metaContent(html, 'property', 'og:title') ??
    'Artist'
  const tracks = parseTrackListHtml(html)
  if (tracks.length === 0) return null
  return { name: cleanText(name), tracks }
}

function parseQuery(query: string): BoomplayParsedQuery {
  const filters = new Map<string, string>()
  let text = query
  const filterRegex = /(\w+):["']?([^"'\s]+)["']?/g
  let match: RegExpExecArray | null
  while ((match = filterRegex.exec(query)) !== null) {
    const key = match[1] ?? ''
    const value = match[2] ?? ''
    if (!key || !value) continue
    filters.set(key.toLowerCase(), value)
    text = text.replace(match[0], '').trim()
  }
  const parsed: BoomplayParsedQuery = { text: text || query, filters }
  if (filters.has('artist')) parsed.artist = filters.get('artist')
  if (filters.has('albumartist')) parsed.albumArtist = filters.get('albumartist')
  if (filters.has('album')) parsed.album = filters.get('album')
  if (filters.has('genre')) parsed.genre = filters.get('genre')
  if (filters.has('isrc')) parsed.isrc = filters.get('isrc')
  if (filters.has('year')) {
    const y = parseInt(filters.get('year') ?? '', 10)
    if (!isNaN(y)) parsed.year = y
  }
  if (filters.has('minduration')) {
    const d = parseInt(filters.get('minduration') ?? '', 10)
    if (!isNaN(d)) parsed.minDuration = d
  }
  if (filters.has('maxduration')) {
    const d = parseInt(filters.get('maxduration') ?? '', 10)
    if (!isNaN(d)) parsed.maxDuration = d
  }
  const durationMatch = text.match(/duration:([\d:]+)/i)
  if (durationMatch?.[1]) {
    const durStr = durationMatch[1]
    if (durStr.includes(':')) {
      const parts = durStr.split(':')
      const minutesPart = parts[0] ?? '0'
      const secondsPart = parts[1] ?? '0'
      const seconds = parseInt(minutesPart, 10) * 60 + parseInt(secondsPart, 10)
      parsed.minDuration = Math.max(0, seconds - 5)
      parsed.maxDuration = seconds + 5
    }
  }
  return parsed
}

function filterTracksByQuery(tracks: BoomplayRawTrack[], query: BoomplayParsedQuery): BoomplayRawTrack[] {
  return tracks.filter((track) => {
    if (query.minDuration !== undefined && track.duration < query.minDuration)
      return false
    if (query.maxDuration !== undefined && track.duration > query.maxDuration)
      return false
    if (query.artist) {
      if (!track.artistName.toLowerCase().includes(query.artist.toLowerCase()))
        return false
    }
    if (query.albumArtist) {
      if (
        !track.artistName
          .toLowerCase()
          .includes(query.albumArtist.toLowerCase())
      )
        return false
    }
    if (query.isrc && track.isrc) {
      if (!track.isrc.toLowerCase().includes(query.isrc.toLowerCase()))
        return false
    }
    return true
  })
}

export default class BoomplaySource implements SourceInstance {
  private readonly nodelink: WorkerNodeLink
  private readonly config: BoomplaySourceConfig

  public readonly searchTerms = ['bpsearch', 'boomplay']
  public readonly patterns = [
    /https?:\/\/(?:www\.)?boomplay\.com\/(songs|track|album|albums|playlist|playlists|artist|artists)\/([a-zA-Z0-9_-]+)/i,
    /https?:\/\/(?:www\.)?boomplay\.com\/search/i
  ]
  public readonly priority = 60

  public constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
    this.config = (nodelink.options.sources?.boomplay ?? {
      enabled: false,
      playlistLoadLimit: 100,
      albumLoadLimit: 100
    }) as BoomplaySourceConfig
  }

  public async setup(): Promise<boolean> {
    if (this.config.enabled === false) return false
    logger('info', 'Sources', 'Loaded Boomplay source.')
    return true
  }

  public async search(
    query: string,
    _term?: string,
    searchType = 'track'
  ): Promise<SourceResult> {
    try {
      const parsedQuery = parseQuery(query)
      const baseText =
        parsedQuery.text.trim() || query.replace(/\w+:[^\s]+/g, '').trim()
      const artistPart = parsedQuery.artist ?? parsedQuery.albumArtist ?? ''
      const searchText =
        artistPart && !baseText.toLowerCase().includes(artistPart.toLowerCase())
          ? `${baseText} ${artistPart}`.trim()
          : baseText
      return await this._searchWeb(searchText, searchType, parsedQuery)
    } catch (error) {
      const msg = this._errMsg(error)
      logger('error', 'Boomplay', `search error: ${msg}`)
      return {
        loadType: 'error',
        exception: { message: msg, severity: 'fault' }
      }
    }
  }

  private async _searchWeb(
    query: string,
    searchType: string,
    parsedQuery?: BoomplayParsedQuery
  ): Promise<SourceResult> {
    const bpMediaType =
      searchType === 'track'
        ? 'music'
        : searchType === 'album'
          ? 'album'
          : searchType === 'playlist'
            ? 'playlist'
            : searchType === 'artist'
              ? 'artist'
              : 'music'

    const urls = [
      `${BOOMPLAY_BASE}/search/${bpMediaType}/${encodeURIComponent(query)}`,
      `${BOOMPLAY_BASE}/search/default/${encodeURIComponent(query)}`,
      `${BOOMPLAY_BASE}/search/${bpMediaType}?query=${encodeURIComponent(query)}`
    ]

    for (const url of urls) {
      const html = await fetchPage(url, this.config.cookie ?? '')
      if (!html) continue

      logger('debug', 'Boomplay', `Web search HTML snippet (${url}): ${html.slice(0, 600)}`)

      let rawTracks = parseSearchHtml(html)
      if (parsedQuery) rawTracks = filterTracksByQuery(rawTracks, parsedQuery)

      if (rawTracks.length > 0) {
        logger('debug', 'Boomplay', `Web search "${query}" → ${rawTracks.length} results`)
        return {
          loadType: 'search',
          data: rawTracks.map((t) => this._buildTrackData(t))
        }
      }

      logger('debug', 'Boomplay', `No tracks parsed from web search URL: ${url}`)
    }

    return { loadType: 'empty', data: {} }
  }

  public async resolve(url: string): Promise<SourceResult> {
    try {
      const pattern = this.patterns[0]
      const match = pattern ? url.match(pattern) : null
      if (!match?.[1] || !match[2]) return { loadType: 'empty', data: {} }
      const rawType = match[1].toLowerCase()
      const id = match[2]
      if (rawType === 'songs' || rawType === 'track')
        return this._resolveTrack(id)
      if (rawType === 'albums' || rawType === 'album')
        return this._resolveCollection(`${BOOMPLAY_BASE}/albums/${id}`, 'album')
      if (rawType === 'playlists' || rawType === 'playlist')
        return this._resolveCollection(`${BOOMPLAY_BASE}/playlists/${id}`, 'playlist')
      if (rawType === 'artists' || rawType === 'artist')
        return this._resolveCollection(`${BOOMPLAY_BASE}/artists/${id}`, 'artist')
      return { loadType: 'empty', data: {} }
    } catch (error) {
      const msg = this._errMsg(error)
      logger('error', 'Boomplay', `resolve error: ${msg}`)
      return {
        loadType: 'error',
        exception: { message: msg, severity: 'fault' }
      }
    }
  }

  public async getTrackUrl(
    decodedTrack: TrackInfo
  ): Promise<TrackUrlResult | { exception: { message: string; severity: string } }> {
    const songIdMatch = decodedTrack.uri?.match(/\/songs\/(\d+)/)
    const songId = songIdMatch?.[1]

    if (songId) {
      const streamUrl = await this._fetchStreamUrl(songId)
      if (streamUrl) {
        logger('debug', 'Boomplay', `Resolved stream for ${decodedTrack.title}: ${streamUrl}`)
        return { url: streamUrl }
      }
    }

    return this._delegateTrackUrl(decodedTrack)
  }

  private async _resolveTrack(songId: string): Promise<SourceResult> {
    const androidTrack = await this._fetchTrackMetadataAndroid(songId)
    if (androidTrack)
      return { loadType: 'track', data: this._buildTrackData(androidTrack) }
    const html = await fetchPage(
      `${BOOMPLAY_BASE}/songs/${songId}`,
      this.config.cookie ?? ''
    )
    if (!html) return { loadType: 'empty', data: {} }
    const raw = parseTrackPage(html, songId)
    if (!raw) return { loadType: 'empty', data: {} }
    return { loadType: 'track', data: this._buildTrackData(raw) }
  }

  private async _fetchTrackMetadataAndroid(songId: string): Promise<BoomplayRawTrack | null> {
    const attempts = [
      {
        url: 'https://android.boomplaymusic.com/BoomPlayer/getSongInfo',
        body: new URLSearchParams({ songId }).toString()
      },
      {
        url: 'https://android.boomplaymusic.com/BoomPlayer/getSongsInfo',
        body: new URLSearchParams({ songIds: songId }).toString()
      },
      {
        url: 'https://android.boomplaymusic.com/BoomPlayer/getSongInfo',
        body: new URLSearchParams({ id: songId, type: 'MUSIC' }).toString()
      }
    ]

    for (const { url, body } of attempts) {
      try {
        const res = await http1makeRequest(url, {
          method: 'POST',
          headers: {
            'User-Agent': ANDROID_UA,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json'
          },
          body
        })
        logger('debug', 'Boomplay', `getSongInfo ${url} -> ${res.statusCode}`)
        if (res.statusCode !== 200) continue
        const bodyStr =
          typeof res.body === 'string' ? res.body : JSON.stringify(res.body)
        logger('debug', 'Boomplay', `getSongInfo response: ${bodyStr.slice(0, 800)}`)
        let parsed: unknown
        try {
          parsed = JSON.parse(bodyStr)
        } catch {
          continue
        }
        const d = parsed as Record<string, unknown>
        const raw = d?.data ?? d?.song ?? d
        const songObj = (Array.isArray(raw) ? raw[0] : raw) as
          | Record<string, unknown>
          | undefined
        if (!songObj) continue
        const title = (songObj.songName ?? songObj.name ?? songObj.title) as
          | string
          | undefined
        if (!title) continue
        return {
          id: songId,
          title: cleanText(title),
          artistName: cleanText(
            (songObj.artistName ?? songObj.artist ?? 'Unknown') as string
          ),
          duration: (songObj.duration as number | undefined) ?? 0,
          artworkUrl: (songObj.bigPicture ?? songObj.picture ?? null) as
            | string
            | null,
          isrc: (songObj.isrc ?? null) as string | null,
          uri: `${BOOMPLAY_BASE}/songs/${songId}`
        }
      } catch (err) {
        logger('debug', 'Boomplay', `getSongInfo attempt failed: ${this._errMsg(err)}`)
      }
    }
    return null
  }

  private async _resolveCollection(
    pageUrl: string,
    type: 'album' | 'playlist' | 'artist'
  ): Promise<SourceResult> {
    const maxTracks =
      (this.nodelink.options.playback?.maxPlaylistLength as number | undefined) ?? 1000
    const html = await fetchPage(pageUrl, this.config.cookie ?? '')
    if (!html) return { loadType: 'empty', data: {} }

    let parsed: { name: string; tracks: BoomplayRawTrack[] } | null = null
    if (type === 'album') parsed = parseAlbumPage(html)
    else if (type === 'playlist') parsed = parsePlaylistPage(html)
    else if (type === 'artist') parsed = parseArtistPage(html)

    if (!parsed || parsed.tracks.length === 0)
      return { loadType: 'empty', data: {} }

    const tracks = parsed.tracks
      .slice(0, maxTracks)
      .map((t) => this._buildTrackData(t))
    return {
      loadType: 'playlist',
      data: {
        info: { name: parsed.name, selectedTrack: 0 },
        tracks,
        pluginInfo: { source: 'boomplay', type }
      }
    }
  }

  private async _fetchStreamUrl(songId: string): Promise<string | null> {
    try {
      const payload = JSON.stringify({ itemID: songId, itemType: 'MUSIC' })
      const encrypted = await aesEncrypt(payload)
      const res = await http1makeRequest(`${BOOMPLAY_BASE}/getResourceAddr`, {
        method: 'POST',
        headers: {
          'User-Agent': DESKTOP_UA,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
        },
        body: new URLSearchParams({ param: encrypted }).toString()
      })

      if (res.statusCode !== 200) {
        logger('debug', 'Boomplay', `getResourceAddr returned ${res.statusCode}`)
        return null
      }

      const bodyStr =
        typeof res.body === 'string' ? res.body : JSON.stringify(res.body)
      let streamUrl: string | null = null
      try {
        const parsed = JSON.parse(bodyStr) as { source?: string; desc?: string }
        if (parsed.desc && parsed.desc.includes('unavailable in your country')) {
          logger('debug', 'Boomplay', `Track ${songId} is geo-restricted`)
          return null
        }
        if (parsed.source) {
          const decrypted = await aesDecrypt(parsed.source)
          streamUrl = decrypted.trim().replace(/\0+$/, '')
        }
      } catch (err) {
        logger('debug', 'Boomplay', `getResourceAddr parse error: ${this._errMsg(err)}`)
      }
      return streamUrl
    } catch (err) {
      logger('debug', 'Boomplay', `_fetchStreamUrl failed: ${this._errMsg(err)}`)
      return null
    }
  }

  private async _delegateTrackUrl(
    decodedTrack: TrackInfo
  ): Promise<TrackUrlResult | { exception: { message: string; severity: string } }> {
    const sm = this.nodelink.sources
    if (!sm)
      return {
        exception: { message: 'Source manager unavailable.', severity: 'fault' }
      }

    try {
      const isrcQuery = decodedTrack.isrc ? `"${decodedTrack.isrc}"` : null
      const titleQuery = `${decodedTrack.title} ${decodedTrack.author}`

      let res = isrcQuery ? await sm.searchWithDefault(isrcQuery) : null

      if (!res || res.loadType !== 'search' || !(res.data as TrackData[]).length) {
        res = await sm.searchWithDefault(titleQuery)
      }

      if (res.loadType !== 'search' || !(res.data as TrackData[]).length) {
        return {
          exception: { message: 'No fallback source found.', severity: 'fault' }
        }
      }

      const candidates: BestMatchCandidate[] = (res.data as TrackData[]).map((t) => ({
        info: {
          title: t.info.title,
          author: t.info.author,
          length: t.info.length,
          uri: t.info.uri
        }
      }))

      const best = getBestMatch(candidates, decodedTrack, {
        allowExplicit: this.config.allowExplicit
      })

      if (!best)
        return {
          exception: { message: 'No suitable matching alternative was found.', severity: 'fault' }
        }

      const url = await sm.getTrackUrl(best.info as TrackInfo)
      return { newTrack: { info: best.info as TrackInfo }, ...url }
    } catch (err) {
      return {
        exception: {
          message: `Delegation failed: ${this._errMsg(err)}`,
          severity: 'fault'
        }
      }
    }
  }

  private _buildTrackData(raw: BoomplayRawTrack): {
    encoded: string
    info: TrackInfo
    pluginInfo: Record<string, unknown>
  } {
    const info: TrackInfo = {
      identifier: String(raw.id),
      isSeekable: true,
      author: raw.artistName,
      length: raw.duration * 1000,
      isStream: false,
      position: 0,
      title: raw.title,
      uri: raw.uri,
      artworkUrl: raw.artworkUrl,
      isrc: raw.isrc,
      sourceName: 'boomplay'
    }
    const encodeInput: TrackEncodeInput = { ...info, details: [] }
    return {
      encoded: encodeTrack(encodeInput),
      info,
      pluginInfo: { boomplayId: raw.id }
    }
  }

  private _errMsg(err: unknown): string {
    if (err instanceof Error) return err.message
    if (typeof err === 'string') return err
    return String(err)
  }
}
