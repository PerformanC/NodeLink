import { fanartArtist, mbid, mediaIsrc, musicBrainzRecordings, musicBrainzWork } from '../modules/externalMedia.js';
import { MediaLookupClient } from '../modules/mediaLookupClient.js';
import { resolveMediaCredential } from '../modules/mediaProviderConfig.js';
const musicBrainz = new MediaLookupClient();
const fanart = new MediaLookupClient();
const handler = async (nodelink, req, res, sendResponse, parsedUrl) => {
    const keys = ['isrc', 'workMbid', 'artistMbid'];
    const selected = keys.filter((key) => parsedUrl.searchParams.has(key));
    const key = selected[0];
    if (selected.length !== 1 ||
        !key ||
        parsedUrl.searchParams.getAll(key).length !== 1) {
        return sendResponse(req, res, { error: 'Specify exactly one of isrc, workMbid or artistMbid' }, 400);
    }
    const raw = parsedUrl.searchParams.get(key);
    const id = key === 'isrc' ? mediaIsrc(raw) : mbid(raw);
    if (!id)
        return sendResponse(req, res, { error: 'Invalid identifier' }, 400);
    if (key === 'artistMbid') {
        const config = nodelink.options.api.media?.fanart;
        const projectKey = resolveMediaCredential(config?.enabled, process.env.NODELINK_FANART_PROJECT_KEY, config?.projectKey);
        if (!projectKey)
            return sendResponse(req, res, { error: 'Fanart.tv disabled' }, 503);
        const result = await fanart.lookup(id, `https://webservice.fanart.tv/v3.2/music/${id}?source=musicbrainz`, { 'api-key': projectKey, Accept: 'application/json' }, (data) => fanartArtist(data, id));
        return sendResponse(req, res, result.data ?? {
            error: 'Fanart.tv lookup unavailable',
            reason: result.reason,
            upstreamStatus: result.upstreamStatus
        }, result.status);
    }
    const config = nodelink.options.api.media?.musicbrainz;
    const agent = resolveMediaCredential(config?.enabled, process.env.NODELINK_MUSICBRAINZ_USER_AGENT, config?.userAgent);
    if (!agent)
        return sendResponse(req, res, { error: 'MusicBrainz disabled' }, 503);
    const url = key === 'isrc'
        ? `https://musicbrainz.org/ws/2/isrc/${id}?inc=artist-credits+artist-rels+work-rels+isrcs&fmt=json`
        : `https://musicbrainz.org/ws/2/work/${id}?inc=artist-rels&fmt=json`;
    const result = await musicBrainz.lookup(`${key}:${id}`, url, { 'User-Agent': agent, Accept: 'application/json' }, (data) => key === 'isrc'
        ? musicBrainzRecordings(data, id)
        : musicBrainzWork(data, id));
    return sendResponse(req, res, result.data ?? {
        error: 'MusicBrainz lookup unavailable',
        reason: result.reason,
        upstreamStatus: result.upstreamStatus
    }, result.status);
};
const route = { handler };
export default route;
