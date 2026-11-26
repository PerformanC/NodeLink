import { buildTrackMedia, type TrackMediaMetadata } from './trackMedia.ts'

const MAX_HTML = 1024 * 1024
type Data = Record<string, unknown>
export type TidalEmbedKind = 'track' | 'album'
export interface TidalEmbedTrack {
  id: string
  title: string
  author: string
  durationMs: number
  artworkUrl: string | null
  media: TrackMediaMetadata
}

function record(value: unknown): Data | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Data : undefined
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
function decode(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (match, code: string) => {
    const names: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' }
    if (!code.startsWith('#')) return names[code.toLowerCase()] ?? match
    const point = code[1]?.toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1))
    return Number.isInteger(point) && point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : match
  }).trim()
}
function artistLinks(html: string): Array<{ name: string; id: string }> {
  const artists = new Map<string, { name: string; id: string }>()
  for (const match of html.matchAll(/<a\s+[^>]*href="https:\/\/tidal\.com\/artist\/(\d+)"[^>]*>([^<]+)<\/a>/gi)) {
    const id = match[1]
    const name = decode(match[2] ?? '')
    if (id && name) artists.set(id, { id, name })
  }
  return [...artists.values()]
}
function duration(value: string | undefined): number | undefined {
  if (!value || !/^\d{1,6}(?::\d{2}){0,2}$/.test(value)) return undefined
  const parts = value.split(':').map(Number)
  if (parts.slice(1).some(part => part >= 60)) return undefined
  const seconds = parts.reduce((total, part) => total * 60 + part, 0)
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1000 : undefined
}
function track(id: string, value: unknown, length: number | undefined, links: ReturnType<typeof artistLinks>, albumId?: string): TidalEmbedTrack | undefined {
  const source = record(value)
  const title = text(source?.title)
  const author = text(source?.artist)
  if (!title || !author || !length) return undefined
  const artwork = (Array.isArray(source?.artwork) ? source.artwork : []).flatMap(value => {
    const image = record(value)
    const url = text(image?.src)
    const size = text(image?.sizes)?.match(/^(\d{1,4})x(\d{1,4})$/)
    if (!url || !/^https:\/\/resources\.tidal\.com\/images\/[0-9a-f/]+\/\d+x\d+\.jpg$/i.test(url) || !size) return []
    const width = Number(size[1]), height = Number(size[2])
    return width > 0 && height > 0 && url.endsWith('/' + width + 'x' + height + '.jpg') ? [{ url, width, height }] : []
  }).sort((a,b) => b.width - a.width)
  // Do not split artist names on commas or guess IDs when the links do not match.
  const artists = links.map(artist => artist.name).join(', ') === author ? links : [{ name: author }]
  const media = buildTrackMedia('tidal', {
    artists,
    album: { id: albumId, name: text(source?.album), artwork }
  })
  for (const artist of media.artists) if (artist.id) artist.url = 'https://tidal.com/browse/artist/' + artist.id
  if (albumId && media.album) media.album.url = 'https://tidal.com/browse/album/' + albumId
  media.catalog = { url: 'https://tidal.com/browse/track/' + id }
  return { id, title, author, durationMs: length, artworkUrl: media.album?.artwork?.[0]?.url ?? null, media }
}

/** Parse only server-rendered public metadata; never execute the page's scripts. */
export function parseTidalEmbed(html: string, kind: TidalEmbedKind, id: string): { name: string; tracks: TidalEmbedTrack[] } | undefined {
  if (html.length > MAX_HTML || !/^\d{1,20}$/.test(id)) return undefined
  const trigger = [...html.matchAll(/<tidal-play-trigger\b([^>]*)>/gi)].some(match =>
    match[1]?.includes('product-id="' + id + '"') && match[1]?.includes('product-type="' + kind + '"'))
  if (!trigger) return undefined
  const json = html.match(/(?:^|\n)\s*window\.tidalMediaSessionMetadata\s*=\s*(\{[^\r\n]*\});\s*(?:\r?\n|<\/script>)/)
  if (!json?.[1]) return undefined
  let metadata: Data | undefined
  try { metadata = record(JSON.parse(json[1])) } catch { return undefined }
  if (!metadata) return undefined
  const header = html.match(/<span class="media-artist"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? ''
  const mainArtists = artistLinks(header)
  if (kind === 'track') {
    const length = duration(html.match(/<tidal-duration-time>(\d+)<\/tidal-duration-time>/i)?.[1])
    const item = track(id, metadata[id], length, mainArtists)
    return item ? { name: item.title, tracks: [item] } : undefined
  }
  const albumHeader = html.match(/<h1 class="media-album"[^>]*>\s*<a href="https:\/\/tidal\.com\/album\/(\d+)"[^>]*>([^<]+)<\/a>\s*<\/h1>/i)
  if (albumHeader?.[1] !== id || !albumHeader[2]) return undefined
  const name = decode(albumHeader[2])
  const tracks: TidalEmbedTrack[] = []
  const seen = new Set<string>()
  for (const row of html.matchAll(/<list-item\b([^>]*)>([\s\S]*?)<\/list-item>/gi)) {
    const trackId = row[1]?.match(/\bproduct-id="(\d{1,20})"/)?.[1]
    if (!trackId || !row[1]?.includes('product-type="track"') || seen.has(trackId)) continue
    const body = row[2] ?? ''
    const length = duration(body.match(/<time slot="duration">([^<]+)<\/time>/i)?.[1])
    const rowArtists = artistLinks(body.match(/<span slot="artist">([\s\S]*?)<\/span>/i)?.[1] ?? '')
    if (text(record(metadata[trackId])?.album) !== name) continue
    const item = track(trackId, metadata[trackId], length, [...mainArtists, ...rowArtists], id)
    if (item) { seen.add(trackId); tracks.push(item) }
  }
  return tracks.length ? { name, tracks } : undefined
}

/** One bounded, credential-free request to the official public embed host. */
export async function fetchTidalEmbed(kind: TidalEmbedKind, id: string, request: typeof fetch = fetch) {
  if (!/^\d{1,20}$/.test(id)) return undefined
  try {
    const response = await request('https://embed.tidal.com/' + kind + 's/' + id, {
      headers: { Accept: 'text/html' }, redirect: 'error', signal: AbortSignal.timeout(5000)
    })
    if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/html')) return undefined
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let bytes = 0
    let html = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > MAX_HTML) return undefined
        html += decoder.decode(value, { stream: true })
      }
      return parseTidalEmbed(html + decoder.decode(), kind, id)
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  } catch { return undefined }
}
