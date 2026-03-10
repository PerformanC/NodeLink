import { pipeline } from 'node:stream';
import { decodeTrack, logger, sendErrorResponse } from "../utils.js";
/**
 * Cached dynamic import for the stream processor module.
 */
let streamProcessorModulePromise = null;
/**
 * Default headers returned by the raw PCM stream endpoint.
 */
const LOAD_STREAM_HEADERS = {
    'Content-Type': 'audio/l16;rate=48000;channels=2',
    'Transfer-Encoding': 'chunked',
    Connection: 'keep-alive'
};
/**
 * Lazily imports and caches the stream processor module.
 *
 * @returns Promise resolving to the stream processor module exports.
 */
function getStreamProcessorModule() {
    if (!streamProcessorModulePromise) {
        streamProcessorModulePromise = import("../playback/processing/streamProcessor.js");
    }
    return streamProcessorModulePromise;
}
/**
 * Builds a strongly typed runtime view for the load stream endpoint.
 *
 * @param nodelink - Router-facing runtime instance.
 * @returns Runtime compatible with the load stream endpoint, or `null` when
 * the required manager fields are unavailable.
 */
function getLoadStreamRuntime(nodelink) {
    const runtime = nodelink;
    if (runtime.sourceWorkerManager === undefined ||
        runtime.workerManager === undefined ||
        runtime.sources === undefined) {
        return null;
    }
    return runtime;
}
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
 * Normalizes the optional filters payload.
 *
 * @param value - Candidate filters object.
 * @returns Valid filters payload, `false` when the value is invalid, or an
 * empty filter state when omitted.
 */
function normalizeFilters(value) {
    if (value === undefined) {
        return {};
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    return value;
}
/**
 * Extracts request data from a `POST` body payload.
 *
 * @param body - Parsed request body.
 * @returns Normalized request data, or `null` when validation fails.
 */
function getLoadStreamInputFromBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return null;
    }
    const payload = body;
    if (typeof payload.encodedTrack !== 'string' ||
        payload.encodedTrack.trim() === '') {
        return null;
    }
    if (payload.volume !== undefined) {
        if (!isFiniteNumber(payload.volume) ||
            payload.volume < 0 ||
            payload.volume > 1000) {
            return null;
        }
    }
    if (payload.position !== undefined) {
        if (!isFiniteNumber(payload.position) || payload.position < 0) {
            return null;
        }
    }
    const filters = normalizeFilters(payload.filters);
    if (filters === false) {
        return null;
    }
    return {
        encodedTrack: payload.encodedTrack,
        volume: payload.volume ?? 100,
        position: payload.position ?? 0,
        filters
    };
}
/**
 * Parses the `filters` query parameter.
 *
 * Invalid JSON is ignored to preserve the historical behavior of the route.
 *
 * @param parsedUrl - Parsed request URL.
 * @returns Parsed filters payload or `undefined` when absent/invalid.
 */
function getFiltersFromQuery(parsedUrl) {
    const filtersRaw = parsedUrl.searchParams.get('filters');
    if (!filtersRaw) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(filtersRaw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Extracts request data from the query string used by `GET /loadStream`.
 *
 * @param parsedUrl - Parsed request URL.
 * @returns Normalized request data, or `null` when validation fails.
 */
function getLoadStreamInputFromQuery(parsedUrl) {
    const encodedTrack = parsedUrl.searchParams.get('encodedTrack')?.trim();
    if (!encodedTrack) {
        return null;
    }
    const volumeParam = parsedUrl.searchParams.get('volume');
    const positionParam = parsedUrl.searchParams.get('position') ?? parsedUrl.searchParams.get('t');
    const volume = volumeParam === null || volumeParam === '' ? 100 : Number(volumeParam);
    const position = positionParam === null || positionParam === '' ? 0 : Number(positionParam);
    if (!Number.isFinite(volume) || volume < 0 || volume > 1000) {
        return null;
    }
    if (!Number.isFinite(position) || position < 0) {
        return null;
    }
    const filters = getFiltersFromQuery(parsedUrl) ?? {};
    return {
        encodedTrack,
        volume,
        position,
        filters
    };
}
/**
 * Extracts normalized request data regardless of HTTP method.
 *
 * @param req - Incoming HTTP request.
 * @param parsedUrl - Parsed request URL.
 * @returns Normalized request data, or `null` when validation fails.
 */
function getLoadStreamInput(req, parsedUrl) {
    return req.method === 'POST'
        ? getLoadStreamInputFromBody(req.body)
        : getLoadStreamInputFromQuery(parsedUrl);
}
/**
 * Casts the full runtime to the runtime contract required by the
 * stream processor.
 *
 * @param nodelink - Load stream runtime.
 * @returns Runtime view consumed by the stream processor.
 */
function getStreamProcessorRuntime(nodelink) {
    return nodelink;
}
/**
 * Resolves the track URL required for streaming.
 *
 * @param nodelink - Load stream runtime.
 * @param decodedTrack - Decoded track payload.
 * @returns Promise resolving to the track URL response.
 */
async function getTrackUrlResult(nodelink, decodedTrack) {
    if (nodelink.workerManager) {
        const worker = nodelink.workerManager.getBestWorker();
        return await nodelink.workerManager.execute(worker, 'getTrackUrl', {
            decodedTrackInfo: decodedTrack.info
        });
    }
    if (!nodelink.sources) {
        throw new Error('Sources manager is not available for loadStream.');
    }
    return await nodelink.sources.getTrackUrl(decodedTrack.info);
}
/**
 * Destroys a readable stream when it is still active.
 *
 * @param stream - Candidate stream.
 * @returns Nothing. The stream is destroyed as a side effect.
 */
function destroyStream(stream) {
    if (stream && !stream.destroyed) {
        stream.destroy();
    }
}
/**
 * Handles requests for the raw PCM stream endpoint.
 *
 * @param nodelink - Router-facing NodeLink runtime.
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @param _sendResponse - Unused route helper kept for handler signature
 * compatibility.
 * @param parsedUrl - Parsed request URL.
 * @returns Promise that resolves once the response has been written or the
 * stream has been delegated.
 */
async function handler(nodelink, req, res, _sendResponse, parsedUrl) {
    const runtime = getLoadStreamRuntime(nodelink);
    if (!runtime) {
        sendErrorResponse(req, res, 500, 'Internal Server Error', 'Load stream runtime contract is incomplete.', parsedUrl.pathname, true);
        return;
    }
    if (!runtime.options.enableLoadStreamEndpoint) {
        sendErrorResponse(req, res, 404, 'Not Found', 'The requested route was not found.', parsedUrl.pathname);
        return;
    }
    const input = getLoadStreamInput(req, parsedUrl);
    if (!input) {
        sendErrorResponse(req, res, 400, 'Bad Request', 'Invalid parameters', parsedUrl.pathname);
        return;
    }
    const encodedTrack = input.encodedTrack.replace(/ /g, '+');
    const streamResponse = res;
    try {
        const decodedTrack = decodeTrack(encodedTrack);
        if (runtime.sourceWorkerManager) {
            const delegated = runtime.sourceWorkerManager.delegate(req, res, 'loadStream', {
                decodedTrackInfo: decodedTrack.info,
                volume: input.volume,
                position: input.position,
                filters: input.filters
            }, {
                headers: { ...LOAD_STREAM_HEADERS }
            });
            if (delegated) {
                return;
            }
        }
        if (!runtime.sources && runtime.workerManager) {
            const delegated = runtime.workerManager.delegateStream(req, res, {
                decodedTrackInfo: decodedTrack.info,
                volume: input.volume,
                position: input.position,
                filters: input.filters
            }, {
                headers: { ...LOAD_STREAM_HEADERS }
            });
            if (delegated) {
                return;
            }
            sendErrorResponse(req, res, 503, 'Service Unavailable', 'No available workers to stream audio.', parsedUrl.pathname);
            return;
        }
        if (!runtime.sources && !runtime.workerManager) {
            sendErrorResponse(req, res, 503, 'Service Unavailable', 'Sources manager is not available for loadStream.', parsedUrl.pathname);
            return;
        }
        const urlResult = await getTrackUrlResult(runtime, decodedTrack);
        if (urlResult.exception) {
            sendErrorResponse(req, res, 500, 'Internal Server Error', urlResult.exception.message, parsedUrl.pathname);
            return;
        }
        const { createAudioResource, createSeekeableAudioResource } = await getStreamProcessorModule();
        const streamProcessorRuntime = getStreamProcessorRuntime(runtime);
        const sourceName = decodedTrack.info.sourceName;
        const isHls = urlResult.protocol === 'hls';
        const isSabr = urlResult.protocol === 'sabr';
        const isLocal = sourceName === 'local';
        let pcmStream = null;
        let fetchedStream = null;
        if (urlResult.url && !isHls && !isLocal && !isSabr) {
            const resource = (await createSeekeableAudioResource(urlResult.url, input.position, undefined, streamProcessorRuntime, input.filters, {
                streamInfo: urlResult,
                loudnessNormalizer: runtime.options.audio?.loudnessNormalizer
            }, input.volume / 100, null, true));
            if ('exception' in resource) {
                sendErrorResponse(req, res, 500, 'Internal Server Error', resource.exception.message, parsedUrl.pathname);
                return;
            }
            pcmStream = resource.stream;
        }
        else {
            if (!runtime.sources || !urlResult.url) {
                throw new Error('Unable to fetch source stream for the requested track.');
            }
            const additionalData = {
                ...(urlResult.additionalData ?? {}),
                startTime: input.position
            };
            const fetched = await runtime.sources.getTrackStream(urlResult.newTrack?.info ?? decodedTrack.info, urlResult.url, urlResult.protocol, additionalData);
            if (fetched.exception) {
                sendErrorResponse(req, res, 500, 'Internal Server Error', fetched.exception.message, parsedUrl.pathname);
                return;
            }
            fetchedStream = fetched.stream;
            const resource = createAudioResource(fetched.stream, fetched.type ?? urlResult.format ?? 'unknown', streamProcessorRuntime, input.filters, input.volume / 100, null, true, runtime.options.audio?.loudnessNormalizer);
            pcmStream = resource.stream;
        }
        pcmStream.on('error', (error) => {
            logger('error', 'LoadStream', `Pipeline component error: ${error.message} (${error.code})`);
        });
        streamResponse.writeHead(200, { ...LOAD_STREAM_HEADERS });
        pipeline(pcmStream, streamResponse, (error) => {
            if (error && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
                logger('error', 'LoadStream', `Pipeline output failed for ${decodedTrack.info.title}: ${error.message}`);
            }
            destroyStream(pcmStream);
            destroyStream(fetchedStream);
        });
        streamResponse.on('close', () => {
            destroyStream(pcmStream);
            destroyStream(fetchedStream);
        });
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Fatal loadStream error.';
        logger('error', 'LoadStream', 'Fatal handler error:', error);
        if (!streamResponse.writableEnded) {
            sendErrorResponse(req, res, 500, 'Internal Server Error', errorMessage, parsedUrl.pathname);
        }
    }
}
/**
 * Route module definition for the raw PCM stream endpoint.
 */
const loadStreamRoute = {
    handler,
    methods: ['GET', 'POST']
};
export default loadStreamRoute;
