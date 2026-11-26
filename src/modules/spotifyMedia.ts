import {
  mediaUrl as webUrl,
  mediaDetails,
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

/** Normalizes an existing Canvas response without fetching or proxying media. */
export function spotifyCanvasMedia(entry: { id?: string; canvasUrl?: string; trackUri?: string }, trackUri: string): TrackMediaMetadata['canvas'] {
  if (!entry.trackUri || entry.trackUri !== trackUri) return undefined
  const url = webUrl(entry.canvasUrl)
  return url ? { url, ...(entry.id ? { id: entry.id } : {}) } : undefined
}

/** Select a matching, playable Canvas rather than trusting response order. */
export function selectSpotifyCanvas<T extends { id?: string; canvasUrl?: string; trackUri?: string }>(
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
