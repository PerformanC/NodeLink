import { resolveMediaCredential } from './mediaProviderConfig.ts'
import { buildTrackMedia, type TrackMediaMetadata } from './trackMedia.ts'

type Data = Record<string, unknown>
type Request = (url: string, init: RequestInit) => Promise<Response>
function record(v: unknown): Data | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Data)
    : undefined
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}
function list(v: unknown): Data[] {
  return Array.isArray(v) ? v.map(record).filter((x): x is Data => !!x) : []
}
function refs(v: Data | undefined, key: string): Data[] {
  return list(record(record(v?.relationships)?.[key])?.data)
}
function seconds(v: unknown): number | undefined {
  const m = str(v)?.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/)
  if (!m?.slice(1).some(Boolean)) return undefined
  const n =
    Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
  return Number.isFinite(n) && n > 0 && n < 86400 ? n : undefined
}
export interface TidalOfficialTrack {
  id: string
  title: string
  author: string
  durationMs: number
  artworkUrl: string | null
  media: TrackMediaMetadata
}

/** Resolve only explicitly linked resources, preserving search ranking. */
export function parseOfficialTidalSearch(
  value: unknown,
  limit: number
): TidalOfficialTrack[] {
  const doc = record(value)
  if (!Array.isArray(doc?.data) || !Number.isFinite(limit))
    throw new Error('Invalid Tidal v2 search document')
  const included = new Map(
    list(doc.included).map((r) => [String(r.type) + ':' + String(r.id), r])
  )
  const get = (r: Data, type: string) =>
    r.type === type && typeof r.id === 'string'
      ? included.get(type + ':' + r.id)
      : undefined
  const images = (r: Data | undefined, key: string) =>
    refs(r, key)
      .flatMap((ref) => {
        const attrs = record(get(ref, 'artworks')?.attributes)
        if (attrs?.mediaType !== 'IMAGE') return []
        return list(attrs.files).flatMap((file) => {
          const url = str(file.href)
          const meta = record(file.meta)
          if (!url || !/^https:\/\/resources\.tidal\.com\//i.test(url))
            return []
          return [
            {
              url,
              width: typeof meta?.width === 'number' ? meta.width : undefined,
              height: typeof meta?.height === 'number' ? meta.height : undefined
            }
          ]
        })
      })
      .sort((a, b) => (b.width ?? 0) - (a.width ?? 0))
  const result: TidalOfficialTrack[] = []
  const seen = new Set<string>()
  for (const root of list(doc.data)) {
    if (root.type !== 'searchResults') continue
    for (const ref of refs(root, 'tracks')) {
      if (result.length >= Math.max(0, Math.floor(limit))) return result
      const track = get(ref, 'tracks')
      const id = str(track?.id)
      const a = record(track?.attributes)
      const title = str(a?.title)
      const duration = seconds(a?.duration)
      if (!id || !/^\d+$/.test(id) || seen.has(id) || !title || !duration)
        continue
      const artists = refs(track, 'artists').flatMap((ref) => {
        const artist = get(ref, 'artists')
        const name = str(record(artist?.attributes)?.name)
        const id = str(artist?.id)
        return name && id
          ? [{ id, name, artwork: images(artist, 'profileArt') }]
          : []
      })
      if (!artists.length) continue
      const albumRef = refs(track, 'albums')[0]
      const album = albumRef ? get(albumRef, 'albums') : undefined
      const aa = record(album?.attributes)
      const albumId = str(album?.id)
      const media = buildTrackMedia('tidal', {
        artists,
        album: {
          id: albumId,
          name: str(aa?.title),
          artwork: images(album, 'coverArt')
        },
        identifiers: { isrc: a?.isrc, upc: aa?.barcodeId }
      })
      for (const artist of media.artists)
        if (artist.id)
          artist.url =
            'https://tidal.com/browse/artist/' + encodeURIComponent(artist.id)
      if (media.album && albumId) {
        media.album.url =
          'https://tidal.com/browse/album/' + encodeURIComponent(albumId)
        media.album.releaseDate = str(aa?.releaseDate)
        media.album.type = str(aa?.albumType)
        media.album.copyright = str(record(aa?.copyright)?.text)
        if (
          typeof aa?.numberOfItems === 'number' &&
          Number.isSafeInteger(aa.numberOfItems) &&
          aa.numberOfItems > 0
        )
          media.album.trackCount = aa.numberOfItems
        if (
          typeof aa?.numberOfVolumes === 'number' &&
          Number.isSafeInteger(aa.numberOfVolumes) &&
          aa.numberOfVolumes > 0
        )
          media.album.discCount = aa.numberOfVolumes
      }
      media.catalog = {
        url: 'https://tidal.com/browse/track/' + id,
        version: str(a?.version),
        copyright: str(record(a?.copyright)?.text),
        explicit: typeof a?.explicit === 'boolean' ? a.explicit : undefined,
        popularity:
          typeof a?.popularity === 'number' &&
          a.popularity >= 0 &&
          a.popularity <= 1
            ? a.popularity * 100
            : undefined,
        mediaTags: Array.isArray(a?.mediaTags)
          ? a.mediaTags.filter((v): v is string => typeof v === 'string')
          : undefined
      }
      seen.add(id)
      result.push({
        id,
        title,
        author: artists.map((x) => x.name).join(', '),
        durationMs: Math.round(duration * 1000),
        artworkUrl: media.album?.artwork?.[0]?.url ?? null,
        media
      })
    }
  }
  return result
}

async function json(
  request: Request,
  url: string,
  init: RequestInit,
  label: string
): Promise<unknown> {
  const res = await request(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(5000)
  })
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined)
    throw new Error('Tidal ' + label + ': HTTP ' + res.status)
  }
  if (!res.body) throw new Error('Tidal ' + label + ': empty response')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0,
    body = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 2 * 1024 * 1024)
        throw new Error('Tidal ' + label + ': response too large')
      body += decoder.decode(value, { stream: true })
    }
    return JSON.parse(body + decoder.decode())
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** Per-source OAuth cache; no persistence, token logging, or credential sharing with v1. */
export class TidalOfficialClient {
  private cached?: { token: string; expires: number }
  private pending?: Promise<string>
  private readonly request: Request
  constructor(request: Request = fetch) {
    this.request = request
  }
  async accessToken(config: Data): Promise<string> {
    const supplied = resolveMediaCredential(
      true,
      process.env.NODELINK_TIDAL_METADATA_ACCESS_TOKEN,
      config.metadataAccessToken
    )
    if (supplied) return supplied
    if (this.cached && Date.now() < this.cached.expires)
      return this.cached.token
    if (this.pending) return this.pending
    const id = resolveMediaCredential(
      true,
      process.env.NODELINK_TIDAL_CLIENT_ID,
      config.clientId
    )
    const secret = resolveMediaCredential(
      true,
      process.env.NODELINK_TIDAL_CLIENT_SECRET,
      config.clientSecret
    )
    if (!id || !secret)
      throw new Error('Tidal v2 requires authorized application credentials')
    this.pending = (async () => {
      const v = record(
        await json(
          this.request,
          'https://auth.tidal.com/v1/oauth2/token',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Authorization:
                'Basic ' + Buffer.from(id + ':' + secret).toString('base64')
            },
            body: new URLSearchParams({ grant_type: 'client_credentials' })
          },
          'OAuth'
        )
      )
      const token = resolveMediaCredential(true, undefined, v?.access_token)
      if (
        !token ||
        typeof v?.expires_in !== 'number' ||
        !Number.isFinite(v.expires_in) ||
        v.expires_in <= 0
      )
        throw new Error('Invalid Tidal OAuth response')
      this.cached = {
        token,
        expires:
          Date.now() + Math.max(0, Math.min(v.expires_in, 86400) - 60) * 1000
      }
      return token
    })()
    try {
      return await this.pending
    } finally {
      this.pending = undefined
    }
  }
  async search(
    query: string,
    countryCode: string,
    limit: number,
    config: Data
  ) {
    const token = await this.accessToken(config)
    const url = new URL('https://openapi.tidal.com/v2/searchResults')
    url.searchParams.set('filter[query]', query)
    url.searchParams.set('countryCode', countryCode)
    url.searchParams.set(
      'include',
      'tracks.artists.profileArt,tracks.albums.coverArt'
    )
    return parseOfficialTidalSearch(
      await json(
        this.request,
        url.toString(),
        {
          headers: {
            Authorization: 'Bearer ' + token,
            Accept: 'application/vnd.api+json'
          }
        },
        'v2 search'
      ),
      limit
    )
  }
}
