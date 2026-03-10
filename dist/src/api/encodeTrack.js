import { encodeTrack, logger, sendErrorResponse } from "../utils.js";
/**
 * Validation message used when no usable track payload is provided.
 */
const MISSING_TRACK_MESSAGE = 'Track payload is required.';
/**
 * Validation message used when the provided payload does not match the track
 * shape required by the encoder.
 */
const INVALID_TRACK_MESSAGE = 'Track payload must be a valid track info object.';
/**
 * Checks whether a value is a finite number.
 *
 * @param value - Candidate numeric value.
 * @returns `true` when the value is a finite number.
 */
function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
/**
 * Checks whether a value is a string or `null`.
 *
 * @param value - Candidate value.
 * @returns `true` when the value is a string or `null`.
 */
function isNullableString(value) {
    return value === null || typeof value === 'string';
}
/**
 * Checks whether a value is a valid details array.
 *
 * @param value - Candidate details value.
 * @returns `true` when the value is an array of strings and `null` items.
 */
function isTrackDetailsList(value) {
    return (Array.isArray(value) &&
        value.every((detail) => detail === null || typeof detail === 'string'));
}
/**
 * Validates the shape required by the track encoder utility.
 *
 * @param candidate - Candidate track payload.
 * @returns `true` when the payload satisfies the encoder contract.
 */
function isTrackEncodeInput(candidate) {
    return (typeof candidate.title === 'string' &&
        typeof candidate.author === 'string' &&
        isFiniteNumber(candidate.length) &&
        typeof candidate.identifier === 'string' &&
        typeof candidate.isStream === 'boolean' &&
        isNullableString(candidate.uri) &&
        isNullableString(candidate.artworkUrl) &&
        isNullableString(candidate.isrc) &&
        typeof candidate.sourceName === 'string' &&
        isFiniteNumber(candidate.position) &&
        isTrackDetailsList(candidate.details));
}
/**
 * Extracts a candidate object from the query string or request body.
 *
 * The route accepts:
 * - `track` query parameter containing a JSON-serialized track object
 * - request body containing the track object directly
 * - request body containing an object with an `info` field
 *
 * @param req - Incoming HTTP request.
 * @param parsedUrl - Parsed request URL.
 * @returns Candidate track object, `null` when missing, or `false` when a
 * payload was provided but is syntactically invalid.
 */
function getTrackCandidate(req, parsedUrl) {
    const trackParam = parsedUrl.searchParams.get('track')?.trim();
    if (trackParam) {
        try {
            const parsed = JSON.parse(trackParam);
            return parsed;
        }
        catch {
            return false;
        }
    }
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return null;
    }
    const payload = body;
    if (payload.info &&
        typeof payload.info === 'object' &&
        !Array.isArray(payload.info)) {
        return payload.info;
    }
    return payload;
}
/**
 * Handles requests for the single-track encode endpoint.
 *
 * @param _nodelink - Unused NodeLink runtime instance.
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @param sendResponse - Helper responsible for JSON serialization and headers.
 * @param parsedUrl - Parsed request URL.
 * @returns Nothing. The payload is written directly to the response.
 */
function handler(_nodelink, req, res, sendResponse, parsedUrl) {
    const trackCandidate = getTrackCandidate(req, parsedUrl);
    if (trackCandidate === null) {
        sendErrorResponse(req, res, 400, 'Bad Request', MISSING_TRACK_MESSAGE, parsedUrl.pathname, true);
        return;
    }
    if (trackCandidate === false || !isTrackEncodeInput(trackCandidate)) {
        sendErrorResponse(req, res, 400, 'Bad Request', INVALID_TRACK_MESSAGE, parsedUrl.pathname, true);
        return;
    }
    try {
        logger('debug', 'Tracks', `Encoding track: ${trackCandidate.identifier}`);
        sendResponse(req, res, encodeTrack(trackCandidate), 200);
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to encode track';
        logger('error', 'Tracks', `Failed to encode track ${trackCandidate.identifier}:`, error);
        sendErrorResponse(req, res, 500, 'Failed to encode track', errorMessage, parsedUrl.pathname, true);
    }
}
/**
 * Route module definition for the single-track encode endpoint.
 */
const encodeTrackRoute = {
    handler
};
export default encodeTrackRoute;
