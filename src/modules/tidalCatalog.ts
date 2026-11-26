import { mediaUrl, type TrackMediaMetadata } from './trackMedia.ts'

type RecordData = Record<string, unknown>
function record(value: unknown): RecordData | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordData)
    : undefined
}
function text(value: unknown, max = 16000): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= max
    ? value.trim()
    : undefined
}
function linked(resource: RecordData | undefined, name: string): RecordData[] {
  const data = record(record(resource?.relationships)?.[name])?.data
  return (Array.isArray(data) ? data : [data])
    .map(record)
    .filter((item): item is RecordData => !!item)
}
function included(
  document: RecordData | undefined,
  ref: RecordData
): RecordData | undefined {
  if (
    !Array.isArray(document?.included) ||
    typeof ref.id !== 'string' ||
    typeof ref.type !== 'string'
  )
    return undefined
  return document.included
    .map(record)
    .find((item) => item?.id === ref.id && item?.type === ref.type)
}

/** Only attach related resources explicitly linked to the matching track. */
export function applyTidalCatalog(
  media: TrackMediaMetadata,
  trackId: string,
  value: unknown
): void {
  const document = record(value)
  const track = record(document?.data)
  if (track?.type !== 'tracks' || track.id !== trackId) return
  const genres = [
    ...new Set(
      linked(track, 'genres')
        .filter((ref) => ref.type === 'genres')
        .map((ref) =>
          text(record(included(document, ref)?.attributes)?.genreName, 256)
        )
        .filter((name): name is string => !!name)
    )
  ]
  if (genres.length) media.catalog = { ...media.catalog, genres }
  for (const ref of linked(track, 'artists')) {
    if (ref.type !== 'artists') continue
    const artist = media.artists.find((entry) => entry.id === ref.id)
    if (!artist) continue
    const resource = included(document, ref)
    const bioRef = linked(resource, 'biography').find(
      (entry) => entry.type === 'artistBiographies'
    )
    if (!bioRef) continue
    const attrs = record(included(document, bioRef)?.attributes)
    const body = text(attrs?.text)
    if (!body) continue
    const source = text(attrs?.source, 256)
    const summary = text(attrs?.summary, 4000)
    artist.biography = {
      text: body,
      ...(source ? { source } : {}),
      ...(summary ? { summary } : {})
    }
  }
}

/** Public GraphQL preview field; never substitute the full playback URL. */
export function tidalPreview(value: unknown): string | undefined {
  const response = record(value)
  if (Array.isArray(response?.errors) && response.errors.length)
    return undefined
  const url = mediaUrl(text(record(response?.data)?.trackPreviewUrl, 4096))
  if (!url) return undefined
  const parsed = new URL(url)
  if (
    parsed.port ||
    !/(^|\.)(tidal\.com|tidalhifi\.com)$/i.test(parsed.hostname)
  )
    return undefined
  return url
}
