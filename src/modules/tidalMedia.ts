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

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined
}

function date(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return undefined
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
    ? value
    : undefined
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result = [
    ...new Set(value.map(text).filter((entry): entry is string => !!entry))
  ]
  return result.length ? result : undefined
}

/** v1 grouped credit response: role type and individual contributor names. */
export function tidalCredits(
  value: unknown
): Array<{ name: string; role: string }> {
  if (!Array.isArray(value)) return []
  const result: Array<{ name: string; role: string }> = []
  for (const raw of value.slice(0, 128)) {
    const group = record(raw)
    const role = text(group?.type)
    if (!role || !Array.isArray(group?.contributors)) continue
    for (const rawContributor of group.contributors.slice(0, 256)) {
      const name = text(record(rawContributor)?.name)
      if (name) result.push({ name, role })
    }
  }
  return result
}

/** Enrich v1 track payloads from available catalog data and explicit credits. */
export function buildTidalMedia(
  item: RecordData,
  parentAlbum?: RecordData,
  credits?: unknown
) {
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
    credits: [
      ...entries.map((artist) => ({
        name: text(artist.name),
        role:
          artist.type === 'MAIN' || artist.type === 'FEATURED'
            ? artist.type
            : undefined
      })),
      ...tidalCredits(item.credits),
      ...tidalCredits(credits)
    ],
    album: {
      id: id(album?.id),
      name: text(album?.title),
      artwork: artwork(album?.cover, [1280, 640, 320, 160, 80])
    },
    colors: { raw: album?.vibrantColor }
  })
  for (const artist of media.artists) {
    if (artist.id) artist.url = `https://tidal.com/browse/artist/${artist.id}`
  }
  const albumFields = {
    url: id(album?.id)
      ? `https://tidal.com/browse/album/${id(album?.id)}`
      : undefined,
    releaseDate: date(album?.releaseDate),
    copyright: text(album?.copyright),
    label: text(album?.recordLabel) ?? text(album?.label),
    type: text(album?.type),
    trackCount: positiveInteger(album?.numberOfTracks),
    discCount: positiveInteger(album?.numberOfVolumes)
  }
  const albumDetails = Object.fromEntries(
    Object.entries(albumFields).filter(([, value]) => value !== undefined)
  )
  if (Object.keys(albumDetails).length)
    media.album = { ...media.album, ...albumDetails }
  const trackId = id(item.id)
  const catalog = {
    url: trackId ? `https://tidal.com/browse/track/${trackId}` : undefined,
    trackNumber: positiveInteger(item.trackNumber),
    discNumber: positiveInteger(item.volumeNumber),
    version: text(item.version),
    copyright: text(item.copyright),
    explicit: typeof item.explicit === 'boolean' ? item.explicit : undefined,
    popularity:
      typeof item.popularity === 'number' &&
      Number.isFinite(item.popularity) &&
      item.popularity >= 0 &&
      item.popularity <= 100
        ? item.popularity
        : undefined,
    audioQuality: text(item.audioQuality),
    audioModes: strings(item.audioModes),
    mediaTags: strings(record(item.mediaMetadata)?.tags)
  }
  if (Object.values(catalog).some((value) => value !== undefined)) {
    media.catalog = catalog
  }
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
