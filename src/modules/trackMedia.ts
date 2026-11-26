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
  motionArtwork?: { url: string }
  artwork?: MediaImage[]
  channel?: { name?: string; id?: string }
}

export type MediaImageInput = {
  url?: string | null
  width?: number | null
  height?: number | null
}

type MediaEntityInput = {
  name?: string | null
  id?: string | number | null
  artwork?: MediaImageInput[]
}

export function mediaUrl(value?: string | null): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' && !url.username && !url.password) return value
  } catch {}
  return undefined
}

export function normalizeMediaImages(
  input: MediaImageInput[] = []
): MediaImage[] {
  if (!Array.isArray(input)) return []
  const result = new Map<string, MediaImage>()
  for (const item of input) {
    const url = mediaUrl(item?.url)
    if (!url) continue
    const image: MediaImage = { ...result.get(url), url }
    if (
      typeof item.width === 'number' &&
      Number.isSafeInteger(item.width) &&
      item.width > 0
    ) image.width = item.width
    if (
      typeof item.height === 'number' &&
      Number.isSafeInteger(item.height) &&
      item.height > 0
    ) image.height = item.height
    result.set(url, image)
  }
  return [...result.values()]
}

function normalizeEntity(input: MediaEntityInput) {
  const name = typeof input.name === 'string' ? input.name.trim() : undefined
  const id = typeof input.id === 'string' || typeof input.id === 'number'
    ? String(input.id).trim()
    : undefined
  const artwork = normalizeMediaImages(input.artwork)
  return {
    ...(name ? { name } : {}),
    ...(id ? { id } : {}),
    ...(artwork.length ? { artwork } : {})
  }
}

/** Normalizes provider-supplied entities without making network requests. */
export function buildTrackMedia(
  provider: string,
  input: {
    artists?: MediaEntityInput[]
    album?: MediaEntityInput
    motionArtworkUrl?: string | null
    artwork?: MediaImageInput[]
    channel?: Pick<MediaEntityInput, 'name' | 'id'>
  }
): TrackMediaMetadata {
  const artists: TrackMediaMetadata['artists'] = []
  for (const raw of Array.isArray(input.artists) ? input.artists : []) {
    if (!raw || typeof raw !== 'object') continue
    const artist = normalizeEntity(raw)
    if (artist.name) artists.push({ ...artist, name: artist.name })
  }
  const album = input.album ? normalizeEntity(input.album) : undefined
  const motionUrl = mediaUrl(input.motionArtworkUrl)
  const artwork = normalizeMediaImages(input.artwork)
  const channel = input.channel ? normalizeEntity(input.channel) : undefined
  return {
    provider,
    artists,
    ...(album && Object.keys(album).length ? { album } : {}),
    ...(motionUrl ? { motionArtwork: { url: motionUrl } } : {}),
    ...(artwork.length ? { artwork } : {}),
    ...(channel && Object.keys(channel).length ? { channel } : {})
  }
}
