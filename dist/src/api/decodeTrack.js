import { decodeTrack, logger, sendErrorResponse } from "../utils.js";
/**
 * Default validation message used when the encoded track query parameter is
 * absent or empty.
 */
const MISSING_ENCODED_TRACK_MESSAGE = 'Missing encodedTrack parameter.';
/**
 * Reads and normalizes the `encodedTrack` query string parameter.
 *
 * Spaces are replaced with `+` to preserve compatibility with clients that
 * accidentally submit URL-decoded base64 strings.
 *
 * @param parsedUrl - Parsed request URL.
 * @returns Normalized encoded track string, or `null` when the parameter is
 * missing or empty.
 */
function getEncodedTrackFromQuery(parsedUrl) {
    const encodedTrack = parsedUrl.searchParams.get('encodedTrack')?.trim();
    if (!encodedTrack) {
        return null;
    }
    return encodedTrack.replace(/ /g, '+');
}
/**
 * Builds the serialized decode response expected by the public endpoint.
 *
 * @param decodedTrack - Raw decoded track payload returned by the utility.
 * @returns Route response payload with `details` migrated into `pluginInfo`.
 */
function buildDecodeTrackResponse(decodedTrack) {
    return {
        encoded: decodedTrack.encoded,
        info: decodedTrack.info,
        pluginInfo: {
            ...decodedTrack.pluginInfo,
            ...(decodedTrack.details.length > 0
                ? { details: decodedTrack.details }
                : {})
        },
        userData: decodedTrack.userData,
        messageFlags: decodedTrack.messageFlags
    };
}
/**
 * Handles requests for the single-track decode endpoint.
 *
 * @param _nodelink - Unused NodeLink runtime instance.
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @param sendResponse - Helper responsible for JSON serialization and headers.
 * @param parsedUrl - Parsed request URL.
 * @returns Nothing. The payload is written directly to the response.
 */
function handler(_nodelink, req, res, sendResponse, parsedUrl) {
    const encodedTrack = getEncodedTrackFromQuery(parsedUrl);
    if (!encodedTrack) {
        sendErrorResponse(req, res, 400, 'Bad Request', MISSING_ENCODED_TRACK_MESSAGE, parsedUrl.pathname, true);
        return;
    }
    try {
        logger('debug', 'Tracks', `Decoding track: ${encodedTrack}`);
        const decodedTrack = decodeTrack(encodedTrack);
        sendResponse(req, res, buildDecodeTrackResponse(decodedTrack), 200);
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to decode track';
        logger('error', 'Tracks', `Failed to decode track ${encodedTrack}:`, error);
        sendErrorResponse(req, res, 500, 'Failed to decode track', errorMessage, parsedUrl.pathname, true);
    }
}
/**
 * Route module definition for the single-track decode endpoint.
 */
const decodeTrackRoute = {
    handler
};
export default decodeTrackRoute;
