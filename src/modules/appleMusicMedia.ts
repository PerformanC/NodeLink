import {
  type MediaImageInput,
  mediaUrl,
  type TrackMediaMetadata
} from './trackMedia.ts'

type ArtistResource = {
  id?: string
  attributes?: {
    name?: string
    artwork?: { url: string; width: number; height: number }
  }
}

/** Preserves actual song artist relationships without guessing name boundaries. */
export function appleMusicArtists(
  resources: ArtistResource[] | undefined,
  fallbackName?: string
): Array<{ name?: string; id?: string; artwork?: MediaImageInput[] }> {
  const items = Array.isArray(resources) ? resources : []
  const artists: Array<{
    name?: string
    id?: string
    artwork?: MediaImageInput[]
  }> = []
  for (const item of items) {
    const rawName = item?.attributes?.name
    if (typeof rawName !== 'string' || !rawName.trim()) continue
    const name = rawName.trim()
    const art = item.attributes?.artwork
    const validDimensions =
      art &&
      Number.isSafeInteger(art.width) &&
      art.width > 0 &&
      Number.isSafeInteger(art.height) &&
      art.height > 0
    const url =
      art && validDimensions && typeof art.url === 'string'
        ? mediaUrl(
            art.url
              ?.replace('{w}', String(art.width))
              .replace('{h}', String(art.height))
          )
        : undefined
    artists.push({
      name,
      id: item.id,
      ...(url && art
        ? { artwork: [{ url, width: art.width, height: art.height }] }
        : {})
    })
  }
  // A partially populated relationship must not silently drop other credits.
  if (artists.length && artists.length === items.length) return artists
  return [
    { name: fallbackName, ...(items.length === 1 ? { id: items[0]?.id } : {}) }
  ]
}

/** Only track/album motion variants, never artist or playlist hero videos. */
export function appleMusicMotion(
  trackEditorial: unknown,
  albumEditorial?: unknown
): TrackMediaMetadata['motionArtwork'] {
  for (const [scope, editorial] of [
    ['track', trackEditorial],
    ['album', albumEditorial]
  ] as const) {
    if (!editorial || typeof editorial !== 'object') continue
    const fields = editorial as Record<string, unknown>
    const variants: NonNullable<
      NonNullable<TrackMediaMetadata['motionArtwork']>['variants']
    > = []
    for (const [key, aspectRatio] of [
      ['motionDetailSquare', '1:1'],
      ['motionSquareVideo1x1', '1:1'],
      // Nominal editorial layout, verified against the After Hours HLS manifest.
      ['motionDetailTall', '3:4']
    ] as const) {
      const entry = fields[key]
      if (!entry || typeof entry !== 'object') continue
      const value = (entry as { video?: unknown }).video
      const url = typeof value === 'string' ? mediaUrl(value) : undefined
      if (
        url &&
        !variants.some(
          (variant) =>
            variant.url === url && variant.aspectRatio === aspectRatio
        )
      ) {
        variants.push({ url, aspectRatio })
      }
    }
    const first = variants[0]
    if (first) return { url: first.url, scope, variants }
  }
  return undefined
}

/** Accept standard or hyphenated ISRC values, without guessing from text. */
export function normalizeAppleMusicIsrc(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().toUpperCase()
  if (!/^[A-Z]{2}-?[A-Z0-9]{3}-?[0-9]{2}-?[0-9]{5}$/.test(trimmed))
    return undefined
  return trimmed.replace(/-/g, '')
}

/** Verify every recording's code and retain distinct matching editions. */
export function matchAppleMusicIsrc<
  T extends {
    id: string
    type: string
    attributes?: { isrc?: string }
  }
>(items: T[] | undefined, value: unknown): T[] {
  const isrc = normalizeAppleMusicIsrc(value)
  if (!isrc || !Array.isArray(items)) return []
  const seen = new Set<string>()
  const matches: T[] = []
  for (const item of items) {
    if (
      item?.type !== 'songs' ||
      typeof item.id !== 'string' ||
      !/^\d+$/.test(item.id) ||
      seen.has(item.id) ||
      normalizeAppleMusicIsrc(item.attributes?.isrc) !== isrc
    )
      continue
    seen.add(item.id)
    matches.push(item)
    if (matches.length === 25) break
  }
  return matches
}
