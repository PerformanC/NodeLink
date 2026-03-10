import { decodeTrack, logger, sendErrorResponse } from "../utils.js";
/**
 * Default validation message used when the `encodedTrack` query parameter is
 * missing or empty.
 */
const MISSING_ENCODED_TRACK_MESSAGE = 'encodedTrack parameter is required.';
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
 * Reads the target language from the query string.
 *
 * The historical schema declared a default of `en`, so the route now applies
 * that default explicitly instead of depending on validator side effects.
 *
 * @param parsedUrl - Parsed request URL.
 * @returns Target language for the meaning request.
 */
function getLanguageFromQuery(parsedUrl) {
    const language = parsedUrl.searchParams.get('lang')?.trim();
    return language ? language : 'en';
}
/**
 * Builds a strongly typed runtime view for the meaning endpoint.
 *
 * @param nodelink - Router-facing runtime instance.
 * @returns Runtime compatible with the meaning endpoint, or `null` when the
 * required manager fields are unavailable.
 */
function getMeaningRuntime(nodelink) {
    const runtime = nodelink;
    if (runtime.sourceWorkerManager === undefined ||
        runtime.workerManager === undefined ||
        runtime.meanings === undefined) {
        return null;
    }
    return runtime;
}
/**
 * Handles requests for the meaning loading endpoint.
 *
 * @param nodelink - Router-facing NodeLink runtime.
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @param sendResponse - Helper responsible for JSON serialization and headers.
 * @param parsedUrl - Parsed request URL.
 * @returns Promise that resolves once the response has been written.
 */
async function handler(nodelink, req, res, sendResponse, parsedUrl) {
    const runtime = getMeaningRuntime(nodelink);
    if (!runtime) {
        sendErrorResponse(req, res, 500, 'Internal Server Error', 'Meaning runtime contract is incomplete.', parsedUrl.pathname, true);
        return;
    }
    const encodedTrack = getEncodedTrackFromQuery(parsedUrl);
    if (!encodedTrack) {
        logger('warn', 'Meaning', MISSING_ENCODED_TRACK_MESSAGE);
        sendErrorResponse(req, res, 400, 'missing encodedTrack parameter', MISSING_ENCODED_TRACK_MESSAGE, parsedUrl.pathname, true);
        return;
    }
    const targetLanguage = getLanguageFromQuery(parsedUrl);
    let decodedTrack;
    try {
        decodedTrack = decodeTrack(encodedTrack);
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Invalid encoded track';
        logger('warn', 'Meaning', `Invalid encoded track: ${errorMessage}`);
        sendErrorResponse(req, res, 400, 'invalid encodedTrack', errorMessage, parsedUrl.pathname, true);
        return;
    }
    try {
        if (runtime.sourceWorkerManager) {
            const delegated = runtime.sourceWorkerManager.delegate(req, res, 'loadMeaning', {
                decodedTrackInfo: decodedTrack.info,
                language: targetLanguage
            });
            if (delegated) {
                return;
            }
        }
        let meaning;
        if (runtime.workerManager) {
            const worker = runtime.workerManager.getBestWorker();
            meaning = await runtime.workerManager.execute(worker, 'loadMeaning', {
                decodedTrackInfo: decodedTrack.info,
                language: targetLanguage
            });
        }
        else if (runtime.meanings?.loadMeaning) {
            meaning = await runtime.meanings.loadMeaning(decodedTrack, targetLanguage);
        }
        else {
            logger('error', 'Meaning', 'Meaning sources are not available.');
            sendErrorResponse(req, res, 503, 'meaning sources unavailable', 'Meaning sources are not available.', parsedUrl.pathname, true);
            return;
        }
        if (meaning.loadType === 'error') {
            sendErrorResponse(req, res, 500, 'failed to load meaning', meaning.data.message ?? 'Failed to load meaning', parsedUrl.pathname, true);
            return;
        }
        sendResponse(req, res, meaning, 200);
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to load meaning';
        logger('error', 'Meaning', `Failed to load meaning: ${errorMessage}`);
        sendErrorResponse(req, res, 500, 'failed to load meaning', errorMessage, parsedUrl.pathname, true);
    }
}
/**
 * Route module definition for the meaning loading endpoint.
 */
const meaningRoute = {
    handler
};
export default meaningRoute;
