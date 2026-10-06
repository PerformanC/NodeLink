import { Buffer } from 'node:buffer';
import { buildPlaylist, computeSessionId, HLSServer } from '../playback/hls/HLSServer.js';
import { decodeTrack, logger, sendErrorResponse } from '../utils.js';
/**
 * Standard CORS headers attached to all HLS responses.
 */
const HLS_CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges'
};
/**
 * Parses and validates optional audio filters from the query string.
 */
function parseFilters(param) {
    if (!param)
        return {};
    try {
        const parsed = JSON.parse(param);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : {};
    }
    catch {
        return {};
    }
}
/**
 * Sends a binary response with standard headers and handles HEAD requests.
 */
function sendBinaryResponse(req, res, contentType, data) {
    res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': String(data.length),
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        ...HLS_CORS_HEADERS
    });
    if (req.method === 'HEAD') {
        res.end();
        return;
    }
    res.end(data);
}
/**
 * HTTP handler for the HLS streaming endpoints.
 */
async function handler(nodelink, req, res, _sendResponse, parsedUrl) {
    for (const [header, value] of Object.entries(HLS_CORS_HEADERS)) {
        res.setHeader(header, value);
    }
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    if (!nodelink.options.api.enableHlsEndpoint) {
        sendErrorResponse(req, res, 404, 'Not Found', 'The requested route was not found.', parsedUrl.pathname);
        return;
    }
    const pathname = parsedUrl.pathname.toLowerCase();
    let action = 'playlist';
    if (pathname.endsWith('/init.mp4')) {
        action = 'init';
    }
    else if (pathname.endsWith('/segment.m4s') ||
        pathname.endsWith('/segment')) {
        action = 'segment';
    }
    const hlsServer = HLSServer.getInstance();
    const rawTrack = parsedUrl.searchParams.get('encodedTrack') ??
        parsedUrl.searchParams.get('track');
    const encodedTrack = rawTrack ? rawTrack.trim().replace(/ /g, '+') : null;
    const requestedSessionId = parsedUrl.searchParams.get('sessionId');
    const volumeParam = Number(parsedUrl.searchParams.get('volume') ?? 100);
    const volume = Number.isFinite(volumeParam) && volumeParam >= 0 && volumeParam <= 1000
        ? volumeParam
        : 100;
    const durationParam = Number(parsedUrl.searchParams.get('segmentDuration') ?? 4);
    const segmentDuration = Number.isFinite(durationParam) && durationParam >= 1 && durationParam <= 15
        ? durationParam
        : 4;
    const filters = parseFilters(parsedUrl.searchParams.get('filters'));
    try {
        let session = requestedSessionId
            ? hlsServer.getSession(requestedSessionId)
            : undefined;
        if (!session && encodedTrack) {
            const decodedTrack = decodeTrack(encodedTrack);
            const sessionId = requestedSessionId ||
                computeSessionId(encodedTrack, volume, filters, segmentDuration);
            session = hlsServer.getOrCreateSession({
                sessionId,
                encodedTrack,
                track: decodedTrack,
                segmentDurationSec: segmentDuration,
                volume,
                filters
            });
        }
        if (action === 'playlist') {
            if (!session) {
                sendErrorResponse(req, res, 400, 'Bad Request', 'Missing encodedTrack or sessionId parameter.', parsedUrl.pathname);
                return;
            }
            const playlistContent = buildPlaylist({
                encodedTrack: session.encodedTrack,
                trackLengthMs: session.track.info.length,
                segmentDurationSec: session.segmentDurationSec,
                isStream: session.track.info.isStream,
                sessionId: session.id,
                version: session.createdAt
            });
            const playlistBuffer = Buffer.from(playlistContent, 'utf-8');
            sendBinaryResponse(req, res, 'application/vnd.apple.mpegurl; charset=utf-8', playlistBuffer);
            return;
        }
        if (action === 'init') {
            if (!session) {
                sendErrorResponse(req, res, 404, 'Not Found', 'Session not found or expired.', parsedUrl.pathname);
                return;
            }
            sendBinaryResponse(req, res, 'video/mp4', session.initSegment);
            return;
        }
        if (action === 'segment') {
            const segmentParam = parsedUrl.searchParams.get('segment') ??
                parsedUrl.searchParams.get('seq') ??
                parsedUrl.searchParams.get('part');
            const segmentIndex = segmentParam !== null ? Number(segmentParam) : NaN;
            if (!Number.isFinite(segmentIndex) || segmentIndex < 0) {
                sendErrorResponse(req, res, 400, 'Bad Request', 'segment parameter must be a non-negative integer.', parsedUrl.pathname);
                return;
            }
            if (!session) {
                sendErrorResponse(req, res, 404, 'Not Found', 'Session not found or expired.', parsedUrl.pathname);
                return;
            }
            const segmentData = await hlsServer.getMediaSegment(session, segmentIndex, nodelink);
            sendBinaryResponse(req, res, 'video/iso.segment', segmentData);
            return;
        }
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Internal HLS server error.';
        logger('error', 'HLS', `HLS handler error on ${parsedUrl.pathname}:`, error);
        sendErrorResponse(req, res, 500, 'Internal Server Error', errorMessage, parsedUrl.pathname);
    }
}
/**
 * Route definition for HLS manifest and fragment streaming.
 */
const hlsRoute = {
    handler,
    methods: ['GET', 'HEAD', 'OPTIONS'],
    paths: [
        '/v4/hls',
        '/v4/hls/playlist.m3u8',
        '/v4/hls/init.mp4',
        '/v4/hls/segment.m4s',
        '/v4/hls/segment'
    ]
};
export default hlsRoute;
