import { buildTrackMedia, type MediaImageInput } from './trackMedia.ts'

type RecordData = Record<string, unknown>

function record(value: unknown): RecordData | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordData)
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function id(value: unknown): string | undefined {
  const result = typeof value === 'number' ? String(value) : text(value)
  return result && /^[0-9]+$/.test(result) ? result : undefined
}

/** Tidal CDN resources are identified by UUIDs, not arbitrary paths. */
function resourcePath(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value
    )
  )
    return undefined
  return value.replace(/-/g, '/')
}

function artwork(value: unknown, sizes: readonly number[]): MediaImageInput[] {
  const path = resourcePath(value)
  if (!path) return []
  return sizes.map((size) => ({
    url: `https://resources.tidal.com/images/${path}/${size}x${size}.jpg`,
    width: size,
    height: size
  }))
}

/** Enrich existing v1 track payloads without additional network requests. */
export function buildTidalMedia(item: RecordData, parentAlbum?: RecordData) {
  const nested = record(item.album)
  // Reuse a fetched parent only for its own album tracks; never mix editions.
  const parentId = id(parentAlbum?.id)
  const nestedId = id(nested?.id)
  const album =
    parentId && (!nestedId || nestedId === parentId)
      ? {
          ...parentAlbum,
          ...Object.fromEntries(
            Object.entries(nested ?? {}).filter(([, value]) => value != null)
          )
        }
      : nested

  const artists = new Map<string, RecordData>()
  const rawArtists = Array.isArray(item.artists) ? item.artists : []
  for (const raw of [...rawArtists, item.artist]) {
    const artist = record(raw)
    const name = text(artist?.name)
    if (!artist || !name) continue
    const artistId = id(artist.id)
    const key = artistId ? `id:${artistId}` : `name:${name}`
    const previous = artists.get(key)
    if (!previous) artists.set(key, artist)
    else
      artists.set(key, {
        ...artist,
        ...Object.fromEntries(
          Object.entries(previous).filter(
            ([, value]) => value != null && value !== ''
          )
        )
      })
  }
  const entries = [...artists.values()]
  const media = buildTrackMedia('tidal', {
    identifiers: { isrc: item.isrc, upc: album?.upc },
    artists: entries.map((artist) => ({
      name: text(artist.name),
      id: id(artist.id),
      artwork: artwork(artist.picture, [750, 640, 320, 160])
    })),
    credits: entries.map((artist) => ({
      name: text(artist.name),
      role:
        artist.type === 'MAIN' || artist.type === 'FEATURED'
          ? artist.type
          : undefined
    })),
    album: {
      id: id(album?.id),
      name: text(album?.title),
      artwork: artwork(album?.cover, [1280, 640, 320, 160, 80])
    },
    colors: { raw: album?.vibrantColor }
  })
  const video = resourcePath(album?.videoCover)
  if (video) {
    const variants = [1280, 640, 320, 160, 80].map((size) => ({
      url: `https://resources.tidal.com/videos/${video}/${size}x${size}.mp4`,
      aspectRatio: '1:1' as const,
      width: size,
      height: size
    }))
    const first = variants[0]
    if (first)
      media.motionArtwork = { url: first.url, scope: 'album', variants }
  }
  return media
}
