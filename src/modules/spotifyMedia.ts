import { spotifyCanvasType, spotifyCanvasUrl } from './spotifyCanvasResponse.ts'
import {
  mediaUrl as webUrl,
  mediaDetails,
  normalizeMediaPalette,
  type MediaColors,
  normalizeMediaImages as images,
  type MediaImageInput as ImageInput,
  type TrackMediaMetadata
} from './trackMedia.ts'

type ArtistInput = {
  name?: string
  id?: string
  uri?: string
  profile?: { name?: string }
  images?: ImageInput[]
  visuals?: { avatarImage?: { sources?: ImageInput[] } }
}
type AlbumInput = {
  name?: string
  id?: string
  uri?: string
  images?: ImageInput[]
  coverArt?: { sources?: ImageInput[] }
}
type SpotifyMediaInput = {
  artists?: ArtistInput[] | { items: ArtistInput[] }
  firstArtist?: { items: ArtistInput[] }
  otherArtists?: { items: ArtistInput[] }
  album?: AlbumInput
  albumOfTrack?: AlbumInput
  externalIds?: { isrc?: string; upc?: string; ean?: string }
  external_ids?: { isrc?: string; upc?: string; ean?: string }
}

function providerId(item: { id?: string; uri?: string }, kind: 'artist' | 'album'): string | undefined {
  if (typeof item.id === 'string' && item.id) return item.id
  const match = typeof item.uri === 'string' ? item.uri.match(new RegExp(`^spotify:${kind}:([A-Za-z0-9]+)$`)) : undefined
  return match?.[1]
}

/** Normalizes only metadata already present in Spotify track responses. */
export function buildSpotifyMedia(item: SpotifyMediaInput, fallbackArtwork?: string | null): TrackMediaMetadata {
  const listed = Array.isArray(item.artists) ? item.artists : item.artists?.items
  const rawArtists = Array.isArray(listed) && listed.length ? listed : [
    ...(Array.isArray(item.firstArtist?.items) ? item.firstArtist.items : []),
    ...(Array.isArray(item.otherArtists?.items) ? item.otherArtists.items : [])
  ]
  const artists: TrackMediaMetadata['artists'] = []
  for (const artist of rawArtists) {
    const rawName = artist?.profile?.name || artist?.name
    if (typeof rawName !== 'string' || !rawName.trim()) continue
    const name = rawName.trim()
    const id = providerId(artist, 'artist')
    const artwork = images(artist.images ?? artist.visuals?.avatarImage?.sources)
    artists.push({ name, ...(id ? { id } : {}), ...(artwork.length ? { artwork } : {}) })
  }
  const album = item.albumOfTrack ?? item.album
  const artwork = images(album?.coverArt?.sources ?? album?.images)
  const fallback = webUrl(fallbackArtwork)
  if (artwork.length === 0 && fallback) artwork.push({ url: fallback })
  const id = album ? providerId(album, 'album') : undefined
  const name = typeof album?.name === 'string' ? album.name.trim() : undefined
  return {
    provider: 'spotify',
    artists,
    ...mediaDetails({ identifiers: item.externalIds ?? item.external_ids }),
    ...(name || id || artwork.length ? { album: { ...(name ? { name } : {}), ...(id ? { id } : {}), ...(artwork.length ? { artwork } : {}) } } : {})
  }
}

type CanvasMediaInput = { id?: string; canvasUrl?: string; trackUri?: string; canvasUri?: string; fileId?: string; type?: string }

/** Normalizes an existing Canvas response without fetching or proxying media. */
export function spotifyCanvasMedia(entry: CanvasMediaInput, trackUri: string): TrackMediaMetadata['canvas'] {
  if (!entry.trackUri || entry.trackUri !== trackUri) return undefined
  const type = spotifyCanvasType(entry.type)
  if (type && type !== 'UNKNOWN' && type !== 'UNRECOGNIZED' && !type.startsWith('VIDEO')) return undefined
  const url = spotifyCanvasUrl(entry.canvasUrl)
  return url ? {
    url,
    ...(entry.id ? { id: entry.id } : {}),
    ...(typeof entry.canvasUri === 'string' && /^spotify:canvas:[A-Za-z0-9]+$/.test(entry.canvasUri) ? { uri: entry.canvasUri } : {}),
    ...(typeof entry.fileId === 'string' && /^[a-f0-9]{32}$/i.test(entry.fileId) ? { fileId: entry.fileId } : {}),
    ...(type ? { type } : {})
  } : undefined
}

/** Select a matching, playable Canvas rather than trusting response order. */
export function selectSpotifyCanvas<T extends CanvasMediaInput>(
  entries: readonly T[] | undefined,
  trackUri: string
): { entry: T; canvas: NonNullable<TrackMediaMetadata['canvas']> } | undefined {
  for (const entry of entries ?? []) {
    const canvas = spotifyCanvasMedia(entry, trackUri)
    if (canvas) return { entry, canvas }
  }
  return undefined
}

/** Report only the validity of an existing session, never its token or expiry. */
export function spotifyCanvasSessionState(token: string | null, expiry: number | null, now = Date.now()): 'missing' | 'expired' | 'unknown-expiry' | 'ready' {
  if (!token || !token.trim()) return 'missing'
  if (expiry === null || !Number.isFinite(expiry)) return 'unknown-expiry'
  return expiry <= now ? 'expired' : 'ready'
}

/** Preserve the imagery of an explicitly resolved artist, not the artist of every track. */
export function buildSpotifyArtistMedia(input: unknown, expectedId: string): TrackMediaMetadata | undefined {
  function object(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  }
  const artist = object(input)
  if (!artist || (artist.id !== undefined && artist.id !== expectedId) ||
      (artist.uri !== undefined && artist.uri !== `spotify:artist:${expectedId}`)) return undefined
  const name = object(artist.profile)?.name ?? artist.name
  if (typeof name !== 'string' || !name.trim()) return undefined
  const visuals = object(artist.visuals)
  const gallery = object(visuals?.gallery)?.items
  const artworkInputs: ImageInput[] = []
  const append = (value: unknown) => {
    if (Array.isArray(value)) artworkInputs.push(...value.slice(0, 100))
  }
  append(object(visuals?.avatarImage)?.sources)
  append(artist.images)
  for (const item of Array.isArray(gallery) ? gallery.slice(0, 50) : []) append(object(item)?.sources)
  const artwork = images(artworkInputs)
  const header = object(object(artist.headerImage)?.data)
  const banners = images(Array.isArray(header?.sources) ? header.sources.slice(0, 100) : [])
  return { provider: 'spotify', artists: [{ id: expectedId, name: name.trim(),
    ...(artwork.length ? { artwork } : {}), ...(banners.length ? { banners } : {}) }] }
}

/** Read an ISRC only from the exact track returned by the official catalog. */
export function readOfficialSpotifyIsrc(input: unknown, expectedId: string): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const track = input as Record<string, unknown>
  if (track.id !== expectedId) return undefined
  const ids = track.external_ids
  if (!ids || typeof ids !== 'object' || Array.isArray(ids)) return undefined
  return mediaDetails({ identifiers: { isrc: (ids as Record<string, unknown>).isrc } }).identifiers?.isrc
}

/** Normalize a single-image response; the provider does not include an image ID in each result. */
export function normalizeSpotifyDynamicColors(input: unknown): MediaColors | undefined {
  function object(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  }
  function rgb(value: unknown): string | undefined {
    const color = object(value)
    if (!color || color.alpha !== 255) return undefined
    const channels = [color.red, color.green, color.blue]
    if (!channels.every((v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255)) return undefined
    return '#' + channels.map((v) => (v as number).toString(16).padStart(2, '0')).join('').toUpperCase()
  }
  const items = object(input)?.dynamicColors
  if (!Array.isArray(items) || items.length !== 1) return undefined
  const source = object(items[0])
  if (!source || source.status !== 'OK') return undefined
  const converted: Record<string, unknown> = {
    bestFit: source.bestFit === 'DARK' ? 'dark' : source.bestFit === 'LIGHT' ? 'light' : undefined
  }
  for (const mode of ['dark', 'light'] as const) {
    const raw = object(source[mode])
    if (!raw) continue
    const theme: Record<string, unknown> = { encoreBaseSetTextColor: rgb(raw.encoreBaseSetTextColor) }
    for (const level of ['minContrast', 'highContrast', 'higherContrast'] as const) {
      const group = object(raw[level])
      if (!group) continue
      theme[level] = Object.fromEntries(['backgroundBase', 'backgroundTintedBase', 'textBase', 'textBrightAccent', 'textSubdued'].map(key => [key, rgb(group[key])]))
    }
    converted[mode] = theme
  }
  const palette = normalizeMediaPalette(converted)
  if (!palette) return undefined
  const dark = palette.dark?.highContrast?.backgroundBase
  const light = palette.light?.highContrast?.backgroundBase
  return { ...(dark ? { dark } : {}), ...(light ? { light } : {}), palette }
}

/** Read only explicitly identified ISRCs from the legacy metadata response. */
export function readSpotifyMetadataIsrc(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const ids = (input as Record<string, unknown>).external_id
  if (!Array.isArray(ids)) return undefined
  const values = new Set<string>()
  for (const entry of ids) {
    if (!entry || typeof entry !== 'object' || entry.type !== 'isrc') continue
    const isrc = mediaDetails({ identifiers: { isrc: entry.id } }).identifiers?.isrc
    if (isrc) values.add(isrc)
  }
  return values.size === 1 ? [...values][0] : undefined
}
