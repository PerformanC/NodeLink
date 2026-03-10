import { decodeTrack, logger, sendErrorResponse } from "../utils.js";
/**
 * Default validation message used when the `encodedTrack` query parameter is
 * missing or empty.
 */
const MISSING_ENCODED_TRACK_MESSAGE = 'Missing encodedTrack parameter.';
/**
 * Reads and normalizes the `encodedTrack` query string parameter.
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
 * Parses the optional `itag` query parameter.
 *
 * @param parsedUrl - Parsed request URL.
 * @returns Parsed numeric itag, `null` when absent, or `false` when invalid.
 */
function getItagFromQuery(parsedUrl) {
    const itagParam = parsedUrl.searchParams.get('itag');
    if (!itagParam) {
        return null;
    }
    const itag = Number(itagParam);
    return Number.isFinite(itag) ? itag : false;
}
/**
 * Builds a strongly typed runtime view for the track stream endpoint.
 *
 * @param nodelink - Router-facing runtime instance.
 * @returns Runtime compatible with the track stream endpoint, or `null` when
 * the required manager fields are unavailable.
 */
function getTrackStreamRuntime(nodelink) {
    const runtime = nodelink;
    if (runtime.workerManager === undefined || !runtime.sources) {
        return null;
    }
    return runtime;
}
/**
 * Handles requests for the track stream resolution endpoint.
 *
 * @param nodelink - Router-facing NodeLink runtime.
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @param sendResponse - Helper responsible for JSON serialization and headers.
 * @param parsedUrl - Parsed request URL.
 * @returns Promise that resolves once the response has been written.
 */
async function handler(nodelink, req, res, sendResponse, parsedUrl) {
    if (!nodelink.options.enableTrackStreamEndpoint) {
        sendErrorResponse(req, res, 404, 'Not Found', 'The requested route was not found.', parsedUrl.pathname);
        return;
    }
    const runtime = getTrackStreamRuntime(nodelink);
    if (!runtime) {
        sendErrorResponse(req, res, 500, 'Internal Server Error', 'Track stream runtime contract is incomplete.', parsedUrl.pathname, true);
        return;
    }
    const encodedTrack = getEncodedTrackFromQuery(parsedUrl);
    if (!encodedTrack) {
        sendErrorResponse(req, res, 400, 'Bad Request', MISSING_ENCODED_TRACK_MESSAGE, parsedUrl.pathname);
        return;
    }
    const itag = getItagFromQuery(parsedUrl);
    if (itag === false) {
        sendErrorResponse(req, res, 400, 'Bad Request', 'itag parameter must be a valid number.', parsedUrl.pathname, true);
        return;
    }
    try {
        const decodedTrack = decodeTrack(encodedTrack);
        let urlResult;
        if (runtime.workerManager) {
            const worker = runtime.workerManager.getBestWorker();
            urlResult = await runtime.workerManager.execute(worker, 'getTrackUrl', {
                decodedTrackInfo: decodedTrack.info,
                itag
            });
        }
        else {
            urlResult = await runtime.sources.getTrackUrl(decodedTrack.info, itag);
        }
        if (urlResult.exception) {
            sendErrorResponse(req, res, 500, 'Internal Server Error', urlResult.exception.message, parsedUrl.pathname);
            return;
        }
        sendResponse(req, res, urlResult, 200);
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to get track stream';
        logger('error', 'TrackStream', `Failed to get track stream for ${encodedTrack}:`, error);
        sendErrorResponse(req, res, 500, 'Internal Server Error', errorMessage, parsedUrl.pathname, true);
    }
}
/**
 * Route module definition for the track stream resolution endpoint.
 */
const trackStreamRoute = {
    handler
};
export default trackStreamRoute;
