/** Image metadata supplied by a music provider. */
export interface MediaImage {
  url: string
  width?: number
  height?: number
}

export interface MediaIdentifiers {
  isrc?: string
  upc?: string
  ean?: string
}

export interface MediaColors {
  dark?: string
  light?: string
  raw?: string
}

export interface MediaCredit {
  name: string
  role: string
}

/** Provider-neutral media metadata carried in track.pluginInfo.media. */
export interface TrackMediaMetadata {
  provider: string
  artists: Array<{ name: string; id?: string; artwork?: MediaImage[]; banners?: MediaImage[] }>
  album?: { name?: string; id?: string; artwork?: MediaImage[] }
  canvas?: { url: string; id?: string; uri?: string; fileId?: string; type?: string }
  motionArtwork?: {
    url: string
    scope?: 'track' | 'album'
    variants?: Array<{ url: string; aspectRatio: '1:1' | '9:16' }>
  }
  artwork?: MediaImage[]
  channel?: { name?: string; id?: string; artwork?: MediaImage[]; banners?: MediaImage[] }
  identifiers?: MediaIdentifiers
  colors?: MediaColors
  credits?: MediaCredit[]
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
  banners?: MediaImageInput[]
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
  const banners = normalizeMediaImages(input.banners)
  return {
    ...(name ? { name } : {}),
    ...(id ? { id } : {}),
    ...(artwork.length ? { artwork } : {}),
    ...(banners.length ? { banners } : {})
  }
}

/** Adds only valid, provider-supplied identifiers, colors and credits. */
export function mediaDetails(input: {
  identifiers?: { isrc?: unknown; upc?: unknown; ean?: unknown }
  colors?: unknown
  credits?: Array<{ name?: unknown; role?: unknown }>
}): Pick<TrackMediaMetadata, 'identifiers' | 'colors' | 'credits'> {
  const identifiers: MediaIdentifiers = {}
  const rawIsrc = input.identifiers?.isrc
  if (typeof rawIsrc === 'string') {
    const isrc = rawIsrc.trim().replace(/-/g, '').toUpperCase()
    if (/^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(isrc)) identifiers.isrc = isrc
  }
  for (const key of ['upc', 'ean'] as const) {
    const raw = input.identifiers?.[key]
    if (typeof raw === 'string' && /^[0-9]{8,14}$/.test(raw.trim())) identifiers[key] = raw.trim()
  }
  const colors: MediaColors = {}
  if (input.colors && typeof input.colors === 'object') {
    const source = input.colors as Record<string, unknown>
    for (const key of ['dark', 'light', 'raw'] as const) {
      const value = source[key]
      if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) colors[key] = value.toUpperCase()
    }
  }
  const credits: MediaCredit[] = []
  for (const credit of Array.isArray(input.credits) ? input.credits : []) {
    if (typeof credit?.name !== 'string' || typeof credit?.role !== 'string') continue
    const name = credit.name.trim()
    const role = credit.role.trim()
    if (name && role && !credits.some((item) => item.name === name && item.role === role)) credits.push({ name, role })
  }
  return {
    ...(Object.keys(identifiers).length ? { identifiers } : {}),
    ...(Object.keys(colors).length ? { colors } : {}),
    ...(credits.length ? { credits } : {})
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
    channel?: MediaEntityInput
    identifiers?: Parameters<typeof mediaDetails>[0]['identifiers']
    colors?: unknown
    credits?: Parameters<typeof mediaDetails>[0]['credits']
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
    ...mediaDetails(input),
    ...(album && Object.keys(album).length ? { album } : {}),
    ...(motionUrl ? { motionArtwork: { url: motionUrl } } : {}),
    ...(artwork.length ? { artwork } : {}),
    ...(channel && Object.keys(channel).length ? { channel } : {})
  }
}
