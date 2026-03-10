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
 * Reads the optional `lang` query string parameter.
 *
 * @param parsedUrl - Parsed request URL.
 * @returns Non-empty language string, or `undefined` when absent.
 */
function getLanguageFromQuery(parsedUrl) {
    const language = parsedUrl.searchParams.get('lang')?.trim();
    return language ? language : undefined;
}
/**
 * Builds a strongly typed runtime view for the lyrics endpoint.
 *
 * @param nodelink - Router-facing runtime instance.
 * @returns Runtime compatible with the lyrics endpoint, or `null` when the
 * required manager fields are unavailable.
 */
function getLoadLyricsRuntime(nodelink) {
    const runtime = nodelink;
    if (runtime.sourceWorkerManager === undefined ||
        runtime.workerManager === undefined ||
        !runtime.lyrics) {
        return null;
    }
    return runtime;
}
/**
 * Handles requests for the lyrics loading endpoint.
 *
 * @param nodelink - Router-facing NodeLink runtime.
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @param sendResponse - Helper responsible for JSON serialization and headers.
 * @param parsedUrl - Parsed request URL.
 * @returns Promise that resolves once the response has been written.
 */
async function handler(nodelink, req, res, sendResponse, parsedUrl) {
    const runtime = getLoadLyricsRuntime(nodelink);
    if (!runtime) {
        sendErrorResponse(req, res, 500, 'Internal Server Error', 'Lyrics runtime contract is incomplete.', parsedUrl.pathname, true);
        return;
    }
    const encodedTrack = getEncodedTrackFromQuery(parsedUrl);
    const language = getLanguageFromQuery(parsedUrl);
    if (!encodedTrack) {
        logger('warn', 'Lyrics', MISSING_ENCODED_TRACK_MESSAGE);
        sendErrorResponse(req, res, 400, 'Bad Request', MISSING_ENCODED_TRACK_MESSAGE, parsedUrl.pathname);
        return;
    }
    try {
        const decodedTrack = decodeTrack(encodedTrack);
        logger('debug', 'Lyrics', `Request to load lyrics for: ${decodedTrack.info.title}${language ? ` (Lang: ${language})` : ''}`);
        if (runtime.sourceWorkerManager) {
            const delegated = runtime.sourceWorkerManager.delegate(req, res, 'loadLyrics', {
                decodedTrackInfo: decodedTrack.info,
                language
            });
            if (delegated) {
                return;
            }
        }
        let lyricsData;
        if (runtime.workerManager) {
            const worker = runtime.workerManager.getBestWorker();
            lyricsData = await runtime.workerManager.execute(worker, 'loadLyrics', {
                decodedTrackInfo: decodedTrack.info,
                language
            });
        }
        else {
            lyricsData = await runtime.lyrics.loadLyrics(decodedTrack, language);
        }
        sendResponse(req, res, lyricsData, 200);
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to load lyrics.';
        logger('error', 'Lyrics', 'Failed to load lyrics:', error);
        sendErrorResponse(req, res, 500, 'Internal Server Error', errorMessage, parsedUrl.pathname, true);
    }
}
/**
 * Route module definition for the lyrics loading endpoint.
 */
const loadLyricsRoute = {
    handler
};
export default loadLyricsRoute;
