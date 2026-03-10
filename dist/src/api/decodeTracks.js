import { decodeTrack, logger, sendErrorResponse } from "../utils.js";
/**
 * Default validation message used when the request body is not a non-empty
 * array of encoded track strings.
 */
const INVALID_ENCODED_TRACKS_MESSAGE = 'encodedTracks parameter must be a non-empty array of strings.';
/**
 * Validates the request body used by the batch decode endpoint.
 *
 * @param body - Parsed request body.
 * @returns `true` when the body is a non-empty array of non-empty strings.
 */
function isEncodedTrackList(body) {
    return (Array.isArray(body) &&
        body.length > 0 &&
        body.every((encodedTrack) => typeof encodedTrack === 'string' && encodedTrack.trim().length > 0));
}
/**
 * Normalizes a batch of encoded track strings before decoding.
 *
 * @param encodedTracks - Raw encoded track list from the request body.
 * @returns Normalized list where spaces are replaced with `+`.
 */
function normalizeEncodedTracks(encodedTracks) {
    return encodedTracks.map((encodedTrack) => encodedTrack.replace(/ /g, '+'));
}
/**
 * Decodes a batch of encoded tracks using the shared utility.
 *
 * @param encodedTracks - Normalized list of encoded track strings.
 * @returns Decoded track payload list in request order.
 * @throws Error when any track fails to decode.
 */
function decodeTrackBatch(encodedTracks) {
    const decodedTracks = [];
    logger('debug', 'Tracks', `Decoding ${encodedTracks.length} tracks.`);
    for (const encodedTrack of encodedTracks) {
        decodedTracks.push(decodeTrack(encodedTrack));
    }
    return decodedTracks;
}
/**
 * Handles requests for the batch decode endpoint.
 *
 * @param _nodelink - Unused NodeLink runtime instance.
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @param sendResponse - Helper responsible for JSON serialization and headers.
 * @param parsedUrl - Parsed request URL.
 * @returns Nothing. The payload is written directly to the response.
 */
function handler(_nodelink, req, res, sendResponse, parsedUrl) {
    if (!isEncodedTrackList(req.body)) {
        sendErrorResponse(req, res, 400, 'Invalid request', INVALID_ENCODED_TRACKS_MESSAGE, parsedUrl.pathname, true);
        return;
    }
    const encodedTracks = normalizeEncodedTracks(req.body);
    try {
        sendResponse(req, res, decodeTrackBatch(encodedTracks), 200);
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to decode track';
        logger('error', 'Tracks', `Failed to decode one or more tracks from a batch of ${encodedTracks.length}.`, error);
        sendErrorResponse(req, res, 500, 'Failed to decode track', errorMessage, parsedUrl.pathname, true);
    }
}
/**
 * Route module definition for the batch decode endpoint.
 */
const decodeTracksRoute = {
    handler,
    methods: ['POST']
};
export default decodeTracksRoute;
