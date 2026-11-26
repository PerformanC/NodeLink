import { buildTrackMedia } from './trackMedia.ts'

type Artist = { name?: string; url?: string }
type Album = {
  name?: string
  title?: string
  url?: string
  image?: string
  '@id'?: string
}
type Resource = {
  '@type'?: string
  byArtist?: Artist | Artist[]
  author?: Artist
  inAlbum?: Album
  image?: string
}

/** Only extract IDs from canonical Amazon Music resource URLs. */
function resourceId(
  value: string | undefined,
  kind: 'artists' | 'albums'
): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      !/^music\.amazon\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/i.test(
        url.hostname
      )
    )
      return undefined
    if (url.username || url.password) return undefined
    return url.pathname.match(
      new RegExp(`^/${kind}/([A-Z0-9]{10})/?$`, 'i')
    )?.[1]
  } catch {
    return undefined
  }
}

/** Normalizes only existing Amazon Music metadata, with no additional requests. */
export function buildAmazonMedia(
  info: { author?: string; artworkUrl?: string | null; isrc?: string | null },
  resource?: Resource,
  collection?: Resource & Album
) {
  const artists = Array.isArray(resource?.byArtist)
    ? resource.byArtist
    : resource?.byArtist
      ? [resource.byArtist]
      : resource?.author
        ? [resource.author]
        : []
  const album =
    resource?.inAlbum ??
    (collection?.['@type'] === 'MusicAlbum' ? collection : undefined)
  // A playlist or artist page cover is not necessarily a track's cover.
  const image =
    resource?.image ??
    (!collection || collection['@type'] === 'MusicAlbum'
      ? info.artworkUrl
      : undefined)
  const fallbackName =
    !collection && info.author !== 'Unknown Artist' ? info.author : undefined
  return buildTrackMedia('amazonmusic', {
    artists: artists.length
      ? artists.map((artist) => ({
          name: artist?.name,
          id: resourceId(artist?.url, 'artists')
        }))
      : [{ name: fallbackName }],
    identifiers: { isrc: info.isrc },
    artwork: [{ url: image }],
    album: album
      ? {
          name: album.name || album.title,
          id: resourceId(album.url || album['@id'], 'albums'),
          artwork: [{ url: album.image }]
        }
      : undefined
  })
}
