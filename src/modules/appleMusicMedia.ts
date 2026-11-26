import { mediaUrl, type MediaImageInput } from './trackMedia.ts'

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
  const artists: Array<{ name?: string; id?: string; artwork?: MediaImageInput[] }> = []
  for (const item of items) {
    const rawName = item?.attributes?.name
    if (typeof rawName !== 'string' || !rawName.trim()) continue
    const name = rawName.trim()
    const art = item.attributes?.artwork
    const validDimensions = art && Number.isSafeInteger(art.width) && art.width > 0 &&
      Number.isSafeInteger(art.height) && art.height > 0
    const url = art && validDimensions && typeof art.url === 'string'
      ? mediaUrl(art.url?.replace('{w}', String(art.width)).replace('{h}', String(art.height)))
      : undefined
    artists.push({
      name,
      id: item.id,
      ...(url && art ? { artwork: [{ url, width: art.width, height: art.height }] } : {})
    })
  }
  // A partially populated relationship must not silently drop other credits.
  if (artists.length && artists.length === items.length) return artists
  return [{ name: fallbackName, ...(items.length === 1 ? { id: items[0]?.id } : {}) }]
}
