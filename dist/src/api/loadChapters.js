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
 * Builds a strongly typed runtime view for the chapters endpoint.
 *
 * @param nodelink - Router-facing runtime instance.
 * @returns Runtime compatible with the chapters endpoint, or `null` when the
 * required manager fields are unavailable.
 */
function getLoadChaptersRuntime(nodelink) {
    const runtime = nodelink;
    if (runtime.sourceWorkerManager === undefined ||
        runtime.workerManager === undefined ||
        !runtime.sources) {
        return null;
    }
    return runtime;
}
/**
 * Determines whether the decoded track source supports chapter loading.
 *
 * @param decodedTrack - Decoded track payload.
 * @returns `true` when the source is YouTube or YouTube Music.
 */
function supportsChapters(decodedTrack) {
    return (decodedTrack.info.sourceName === 'youtube' ||
        decodedTrack.info.sourceName === 'ytmusic');
}
/**
 * Handles requests for the chapters loading endpoint.
 *
 * @param nodelink - Router-facing NodeLink runtime.
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @param sendResponse - Helper responsible for JSON serialization and headers.
 * @param parsedUrl - Parsed request URL.
 * @returns Promise that resolves once the response has been written.
 */
async function handler(nodelink, req, res, sendResponse, parsedUrl) {
    const runtime = getLoadChaptersRuntime(nodelink);
    if (!runtime) {
        sendErrorResponse(req, res, 500, 'Internal Server Error', 'Chapters runtime contract is incomplete.', parsedUrl.pathname, true);
        return;
    }
    const encodedTrack = getEncodedTrackFromQuery(parsedUrl);
    if (!encodedTrack) {
        sendErrorResponse(req, res, 400, 'Bad Request', MISSING_ENCODED_TRACK_MESSAGE, parsedUrl.pathname);
        return;
    }
    try {
        const decodedTrack = decodeTrack(encodedTrack);
        if (!decodedTrack.info) {
            sendErrorResponse(req, res, 400, 'Bad Request', 'The provided track is invalid.', parsedUrl.pathname);
            return;
        }
        if (!supportsChapters(decodedTrack)) {
            sendResponse(req, res, [], 200);
            return;
        }
        logger('debug', 'Chapters', `Request to load chapters for: ${decodedTrack.info.title}`);
        if (runtime.sourceWorkerManager) {
            const delegated = runtime.sourceWorkerManager.delegate(req, res, 'loadChapters', {
                decodedTrackInfo: decodedTrack.info
            });
            if (delegated) {
                return;
            }
        }
        let chaptersData;
        if (runtime.workerManager) {
            const worker = runtime.workerManager.getBestWorker();
            chaptersData = await runtime.workerManager.execute(worker, 'loadChapters', {
                decodedTrackInfo: decodedTrack.info
            });
        }
        else {
            chaptersData = await runtime.sources.getChapters(decodedTrack);
        }
        sendResponse(req, res, chaptersData, 200);
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to load chapters.';
        logger('error', 'Chapters', 'Failed to load chapters:', error);
        sendErrorResponse(req, res, 500, 'Internal Server Error', errorMessage, parsedUrl.pathname, true);
    }
}
/**
 * Route module definition for the chapters loading endpoint.
 */
const loadChaptersRoute = {
    handler
};
export default loadChaptersRoute;
