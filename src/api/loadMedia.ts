import {
  fanartAlbum,
  fanartArtist,
  mbid,
  mediaIsrc,
  musicBrainzRecordings,
  musicBrainzWork
} from '../modules/externalMedia.ts'
import { MediaLookupClient } from '../modules/mediaLookupClient.ts'
import { resolveMediaCredential } from '../modules/mediaProviderConfig.ts'
import type {
  ApiRouteHandler,
  ApiRouteModule
} from '../typings/api/api.types.ts'

const musicBrainz = new MediaLookupClient()
const fanart = new MediaLookupClient()

const handler: ApiRouteHandler = async (
  nodelink,
  req,
  res,
  sendResponse,
  parsedUrl
) => {
  const keys = ['isrc', 'workMbid', 'artistMbid', 'releaseGroupMbid'] as const
  const selected = keys.filter((key) => parsedUrl.searchParams.has(key))
  const key = selected[0]
  if (
    selected.length !== 1 ||
    !key ||
    parsedUrl.searchParams.getAll(key).length !== 1
  ) {
    return sendResponse(
      req,
      res,
      {
        error:
          'Specify exactly one of isrc, workMbid, artistMbid or releaseGroupMbid'
      },
      400
    )
  }
  const raw = parsedUrl.searchParams.get(key)
  const id = key === 'isrc' ? mediaIsrc(raw) : mbid(raw)
  if (!id) return sendResponse(req, res, { error: 'Invalid identifier' }, 400)

  if (key === 'artistMbid' || key === 'releaseGroupMbid') {
    const config = nodelink.options.api.media?.fanart
    const projectKey = resolveMediaCredential(
      config?.enabled,
      process.env.NODELINK_FANART_PROJECT_KEY,
      config?.projectKey
    )
    if (!projectKey)
      return sendResponse(req, res, { error: 'Fanart.tv disabled' }, 503)
    const album = key === 'releaseGroupMbid'
    const url = album
      ? `https://webservice.fanart.tv/v3.2/music/albums/${id}`
      : `https://webservice.fanart.tv/v3.2/music/${id}?source=musicbrainz`
    const result = await fanart.lookup<unknown>(
      `${key}:${id}`,
      url,
      { 'api-key': projectKey, Accept: 'application/json' },
      (data) => (album ? fanartAlbum(data, id) : fanartArtist(data, id))
    )
    return sendResponse(
      req,
      res,
      result.data ?? {
        error: 'Fanart.tv lookup unavailable',
        reason: result.reason,
        upstreamStatus: result.upstreamStatus
      },
      result.status
    )
  }
  const config = nodelink.options.api.media?.musicbrainz
  const agent = resolveMediaCredential(
    config?.enabled,
    process.env.NODELINK_MUSICBRAINZ_USER_AGENT,
    config?.userAgent
  )
  if (!agent)
    return sendResponse(req, res, { error: 'MusicBrainz disabled' }, 503)
  const url =
    key === 'isrc'
      ? `https://musicbrainz.org/ws/2/isrc/${id}?inc=artist-credits+artist-rels+work-rels+isrcs+release-groups&fmt=json`
      : `https://musicbrainz.org/ws/2/work/${id}?inc=artist-rels&fmt=json`
  const result = await musicBrainz.lookup<unknown>(
    `${key}:${id}`,
    url,
    { 'User-Agent': agent, Accept: 'application/json' },
    (data) =>
      key === 'isrc'
        ? musicBrainzRecordings(data, id)
        : musicBrainzWork(data, id)
  )
  return sendResponse(
    req,
    res,
    result.data ?? {
      error: 'MusicBrainz lookup unavailable',
      reason: result.reason,
      upstreamStatus: result.upstreamStatus
    },
    result.status
  )
}
const route: ApiRouteModule = { handler }
export default route
