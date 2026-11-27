import { buildTrackMedia, type MediaImageInput } from './trackMedia.ts'

type Data = Record<string, unknown>
function record(value: unknown): Data | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Data)
    : undefined
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
function id(value: unknown): string | undefined {
  const result =
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? String(value)
      : text(value)
  return result && /^[a-zA-Z0-9]+$/.test(result) ? result : undefined
}
function positive(value: unknown): number | undefined {
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
function images(image: unknown, picture?: unknown): MediaImageInput[] {
  const data = record(image)
  return [
    ...['mega', 'extralarge', 'large', 'medium', 'small', 'thumbnail'].map(
      (key) => ({ url: text(data?.[key]) })
    ),
    { url: text(picture) }
  ]
}
function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as T
}

/** Qobuz credit strings use "name, role, role - name, role". Preserve explicit roles. */
export function qobuzCredits(
  value: unknown
): Array<{ name: string; role: string }> {
  if (typeof value !== 'string' || value.length > 32000) return []
  const result: Array<{ name: string; role: string }> = []
  for (const group of value.split(' - ').slice(0, 256)) {
    const [name, ...roles] = group.split(',').map((part) => part.trim())
    if (!name || !roles.length || !roles.every(Boolean)) continue
    for (const role of roles.slice(0, 32)) result.push({ name, role })
  }
  return result
}

/** Only accept exact recording identifiers in an ISRC search. */
export function normalizeQobuzIsrc(value: unknown): string | undefined {
  const code = text(value)?.replace(/-/g, '').toUpperCase()
  return code && /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(code) ? code : undefined
}

export function filterQobuzIsrc(items: Data[], requested: string): Data[] {
  const code = normalizeQobuzIsrc(requested)
  if (!code) return []
  return items.filter((item) => normalizeQobuzIsrc(item.isrc) === code)
}

/** Reuse only an explicitly matching parent album, or the enclosing album for rows without an album ID. */
export function qobuzAlbum(item: Data, parentAlbum?: Data): Data | undefined {
  const nested = record(item.album)
  const parentId = id(parentAlbum?.id)
  const nestedId = id(nested?.id)
  if (!parentId || (nestedId && nestedId !== parentId)) return nested
  const image = {
    ...record(parentAlbum?.image),
    ...Object.fromEntries(
      Object.entries(record(nested?.image) ?? {}).filter(
        ([, value]) => value != null && value !== ''
      )
    )
  }
  return {
    ...parentAlbum,
    ...Object.fromEntries(
      Object.entries(nested ?? {}).filter(
        ([, value]) => value != null && value !== ''
      )
    ),
    image
  }
}

export function buildQobuzMedia(
  item: Data,
  parentAlbum?: Data,
  parentArtist?: Data
) {
  const album = qobuzAlbum(item, parentAlbum)
  const artists = new Map<string, Data>()
  for (const raw of [item.artist, item.performer]) {
    const artist = record(raw)
    const name = text(artist?.name)
    if (!artist || !name) continue
    const artistId = id(artist.id)
    const key = artistId ? `id:${artistId}` : `name:${name}`
    const previous = artists.get(key)
    artists.set(key, {
      ...artist,
      ...Object.fromEntries(
        Object.entries(previous ?? {}).filter(([, value]) => value != null)
      )
    })
  }
  const entries = [...artists.values()].map((artist) => {
    const artistId = id(artist.id)
    return artistId && artistId === id(parentArtist?.id)
      ? {
          ...parentArtist,
          ...Object.fromEntries(
            Object.entries(artist).filter(([, value]) => value != null)
          )
        }
      : artist
  })
  const composer = record(item.composer)
  const performer = record(item.performer)
  const media = buildTrackMedia('qobuz', {
    artists: entries.map((artist) => ({
      name: text(artist.name),
      id: id(artist.id),
      artwork: images(artist.image, artist.picture)
    })),
    album: {
      id: id(album?.id),
      name: text(album?.title),
      artwork: images(album?.image)
    },
    identifiers: { isrc: item.isrc, upc: album?.upc },
    credits: [
      ...qobuzCredits(item.performers),
      { name: text(composer?.name), role: 'Composer' },
      { name: text(performer?.name), role: 'Performer' }
    ]
  })
  for (const artist of media.artists) {
    const source = entries.find((entry) =>
      artist.id ? id(entry.id) === artist.id : text(entry.name) === artist.name
    )
    if (artist.id) artist.url = `https://open.qobuz.com/artist/${artist.id}`
    const bio = record(source?.biography)
    const content = text(bio?.content)
    if (content)
      artist.biography = compact({
        text: content,
        source: text(bio?.source),
        summary: text(bio?.summary)
      })
  }
  const albumId = id(album?.id)
  const details = compact({
    url: albumId ? `https://open.qobuz.com/album/${albumId}` : undefined,
    releaseDate: date(album?.release_date_original),
    copyright: text(album?.copyright),
    label: text(record(album?.label)?.name),
    type: text(album?.release_type),
    trackCount: positive(album?.tracks_count),
    discCount: positive(album?.media_count)
  })
  if (Object.keys(details).length) media.album = { ...media.album, ...details }
  const rate = item.maximum_sampling_rate
  const hz =
    typeof rate === 'number' &&
    Number.isFinite(rate) &&
    rate > 0 &&
    Number.isSafeInteger(rate * 1000)
      ? rate * 1000
      : undefined
  const specs = compact({
    maximumBitDepth: positive(item.maximum_bit_depth),
    maximumSamplingRateHz: hz,
    maximumChannelCount: positive(item.maximum_channel_count),
    hiRes: typeof item.hires === 'boolean' ? item.hires : undefined,
    hiResStreamable:
      typeof item.hires_streamable === 'boolean'
        ? item.hires_streamable
        : undefined
  })
  const trackId = id(item.id)
  const genre = text(record(album?.genre)?.name)
  const catalog = compact({
    url: trackId ? `https://open.qobuz.com/track/${trackId}` : undefined,
    releaseDate: date(item.release_date_original),
    trackNumber: positive(item.track_number),
    discNumber: positive(item.media_number),
    version: text(item.version),
    copyright: text(item.copyright),
    explicit:
      typeof item.parental_warning === 'boolean'
        ? item.parental_warning
        : undefined,
    genres: genre ? [genre] : undefined,
    audioSpecifications: Object.keys(specs).length ? specs : undefined
  })
  if (Object.keys(catalog).length) media.catalog = catalog
  return media
}
