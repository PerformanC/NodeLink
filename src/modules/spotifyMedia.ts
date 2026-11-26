/** Image metadata supplied by a music provider. */
export interface MediaImage {
  url: string
  width?: number
  height?: number
}

/** Provider-neutral media metadata carried in track.pluginInfo.media. */
export interface TrackMediaMetadata {
  provider: string
  artists: Array<{ name: string; id?: string; artwork?: MediaImage[] }>
  album?: { name?: string; id?: string; artwork?: MediaImage[] }
  canvas?: { url: string; id?: string }
}

type ImageInput = { url?: string; width?: number | null; height?: number | null }
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
}

function webUrl(value?: string | null): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' && !url.username && !url.password) return value
  } catch {}
  return undefined
}

function images(input: ImageInput[] = []): MediaImage[] {
  const result = new Map<string, MediaImage>()
  for (const item of input) {
    const url = webUrl(item?.url)
    if (!url) continue
    const image: MediaImage = { ...result.get(url), url }
    if (typeof item.width === 'number' && Number.isSafeInteger(item.width) && item.width > 0) image.width = item.width
    if (typeof item.height === 'number' && Number.isSafeInteger(item.height) && item.height > 0) image.height = item.height
    result.set(url, image)
  }
  return [...result.values()]
}

function providerId(item: { id?: string; uri?: string }, kind: 'artist' | 'album'): string | undefined {
  if (item.id) return item.id
  const match = item.uri?.match(new RegExp(`^spotify:${kind}:([A-Za-z0-9]+)$`))
  return match?.[1]
}

/** Normalizes only metadata already present in Spotify track responses. */
export function buildSpotifyMedia(item: SpotifyMediaInput, fallbackArtwork?: string | null): TrackMediaMetadata {
  const listed = Array.isArray(item.artists) ? item.artists : item.artists?.items
  const rawArtists = listed?.length ? listed : [...(item.firstArtist?.items ?? []), ...(item.otherArtists?.items ?? [])]
  const artists: TrackMediaMetadata['artists'] = []
  for (const artist of rawArtists) {
    const name = artist?.profile?.name || artist?.name
    if (!name?.trim()) continue
    const id = providerId(artist, 'artist')
    const artwork = images(artist.images ?? artist.visuals?.avatarImage?.sources)
    artists.push({ name, ...(id ? { id } : {}), ...(artwork.length ? { artwork } : {}) })
  }
  const album = item.albumOfTrack ?? item.album
  const artwork = images(album?.coverArt?.sources ?? album?.images)
  const fallback = webUrl(fallbackArtwork)
  if (artwork.length === 0 && fallback) artwork.push({ url: fallback })
  const id = album ? providerId(album, 'album') : undefined
  const name = album?.name
  return {
    provider: 'spotify',
    artists,
    ...(name || id || artwork.length ? { album: { ...(name ? { name } : {}), ...(id ? { id } : {}), ...(artwork.length ? { artwork } : {}) } } : {})
  }
}

/** Normalizes an existing Canvas response without fetching or proxying media. */
export function spotifyCanvasMedia(entry: { id?: string; canvasUrl?: string; trackUri?: string }, trackUri: string): TrackMediaMetadata['canvas'] {
  if (entry.trackUri && entry.trackUri !== trackUri) return undefined
  const url = webUrl(entry.canvasUrl)
  return url ? { url, ...(entry.id ? { id: entry.id } : {}) } : undefined
}
