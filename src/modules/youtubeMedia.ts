import {
  buildTrackMedia,
  type MediaImageInput,
  normalizeMediaImages
} from './trackMedia.ts'

type Data = Record<string, unknown>
function record(value: unknown): Data | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Data)
    : undefined
}
function get(value: unknown, ...keys: string[]): unknown {
  return keys.reduce<unknown>((current, key) => record(current)?.[key], value)
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
export function youtubeImages(...sources: unknown[]) {
  return normalizeMediaImages(
    sources.flatMap((source) =>
      array(source)
        .slice(0, 64)
        .map((raw) => {
          const image = record(raw)
          const url = text(image?.url)
          return {
            url: url?.startsWith('//') ? 'https:' + url : url,
            width: typeof image?.width === 'number' ? image.width : undefined,
            height: typeof image?.height === 'number' ? image.height : undefined
          }
        })
    )
  )
}

function channelId(value: unknown): string | undefined {
  const id = text(value)
  return id && /^UC[A-Za-z0-9_-]{22}$/.test(id) ? id : undefined
}
function musicEntities(renderer: unknown) {
  const artists = new Map<string, { name: string; id: string }>()
  let album: { name: string; id: string } | undefined
  const columns = array(get(renderer, 'flexColumns'))
    .slice(1, 5)
    .map((column) =>
      get(column, 'musicResponsiveListItemFlexColumnRenderer', 'text', 'runs')
    )
  for (const runs of [
    get(renderer, 'subtitle', 'runs'),
    get(renderer, 'longBylineText', 'runs'),
    get(renderer, 'shortBylineText', 'runs'),
    ...columns
  ]) {
    for (const raw of array(runs).slice(0, 64)) {
      const name = text(get(raw, 'text'))
      const endpoint = get(raw, 'navigationEndpoint', 'browseEndpoint')
      const id = text(get(endpoint, 'browseId'))
      const type = get(
        endpoint,
        'browseEndpointContextSupportedConfigs',
        'browseEndpointContextMusicConfig',
        'pageType'
      )
      if (!name || !id) continue
      if (type === 'MUSIC_PAGE_TYPE_ARTIST' && channelId(id))
        artists.set(id, { name, id })
      if (
        !album &&
        type === 'MUSIC_PAGE_TYPE_ALBUM' &&
        /^MPRE[A-Za-z0-9_-]+$/.test(id)
      )
        album = { name, id }
    }
  }
  return { artists: [...artists.values()], album }
}

/** Normalize only metadata already present in renderer/player/channel responses. */
export function buildYouTubeMedia(
  info: {
    sourceName: string
    identifier: string
    author: string
    artworkUrl?: string | null
  },
  renderer: unknown,
  response: unknown,
  channel?: Data,
  legacyArtwork: MediaImageInput[] = []
) {
  const details = record(get(response, 'videoDetails'))
  const matching = details?.videoId === info.identifier ? details : undefined
  const music = info.sourceName === 'ytmusic'
  const entities = music
    ? musicEntities(renderer)
    : { artists: [], album: undefined }
  const artwork = youtubeImages(
    get(matching, 'thumbnail', 'thumbnails'),
    get(renderer, 'thumbnail', 'thumbnails'),
    get(
      renderer,
      'thumbnail',
      'musicThumbnailRenderer',
      'thumbnail',
      'thumbnails'
    ),
    get(renderer, 'thumbnail', 'sources'),
    legacyArtwork,
    [{ url: info.artworkUrl }]
  )
  const owner = ['ownerText', 'longBylineText', 'shortBylineText']
    .flatMap((key) => array(get(renderer, key, 'runs')))
    .find((run) =>
      channelId(get(run, 'navigationEndpoint', 'browseEndpoint', 'browseId'))
    )
  const id =
    channelId(matching?.channelId) ??
    channelId(channel?.id) ??
    (!music
      ? channelId(
          get(owner, 'navigationEndpoint', 'browseEndpoint', 'browseId')
        )
      : undefined)
  const name =
    text(matching?.author) ??
    text(channel?.name) ??
    (!music ? text(get(owner, 'text')) : undefined)
  const sameChannel = id && id === channelId(channel?.id)
  const channelArt = youtubeImages(
    sameChannel ? channel?.artwork : undefined,
    sameChannel ? [{ url: channel?.icon }] : [],
    !music && id
      ? get(
          renderer,
          'channelThumbnailSupportedRenderers',
          'channelThumbnailWithLinkRenderer',
          'thumbnail',
          'thumbnails'
        )
      : undefined
  )
  const media = buildTrackMedia(info.sourceName, {
    artwork,
    artists: entities.artists,
    album: entities.album,
    channel: id
      ? {
          id,
          name,
          artwork: channelArt,
          banners: youtubeImages(
            sameChannel ? channel?.banners : undefined,
            sameChannel ? [{ url: channel?.banner }] : []
          )
        }
      : undefined
  })
  for (const artist of media.artists)
    if (artist.id) artist.url = 'https://music.youtube.com/browse/' + artist.id
  if (media.album?.id)
    media.album.url = 'https://music.youtube.com/browse/' + media.album.id
  if (/^[A-Za-z0-9_-]{11}$/.test(info.identifier))
    media.catalog = {
      url:
        (music ? 'https://music.youtube.com' : 'https://www.youtube.com') +
        '/watch?v=' +
        info.identifier
    }
  return media
}
