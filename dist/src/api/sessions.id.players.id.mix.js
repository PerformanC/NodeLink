import { decodeTrack, logger, sendErrorResponse } from "../utils.js";
/**
 * Builds a strongly typed runtime view for the mix collection route.
 *
 * @param nodelink - Router-facing runtime instance.
 * @returns Runtime compatible with the route, or `null` when the required
 * session manager field is unavailable.
 */
function getMixCollectionRuntime(nodelink) {
    const runtime = nodelink;
    if (!runtime.sessions || typeof runtime.sessions.get !== 'function') {
        return null;
    }
    return runtime;
}
/**
 * Extracts and validates the path parameters used by the route.
 *
 * @param parsedUrl - Parsed request URL.
 * @returns Validated path parameters, or `null` when validation fails.
 */
function getPathParams(parsedUrl) {
    const pathParts = parsedUrl.pathname.split('/');
    const sessionId = pathParts[3];
    const guildId = pathParts[5];
    if (!sessionId || !guildId) {
        return null;
    }
    if (!/^\d{17,20}$/.test(guildId)) {
        return null;
    }
    return {
        sessionId,
        guildId
    };
}
/**
 * Parses and validates the mix creation payload.
 *
 * @param body - Parsed request body.
 * @returns Valid payload object, or `null` when validation fails.
 */
function getCreateMixPayload(body) {
    if (typeof body === 'string') {
        try {
            const parsed = JSON.parse(body);
            return getCreateMixPayload(parsed);
        }
        catch {
            return null;
        }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return null;
    }
    const payload = body;
    if (!payload.track ||
        typeof payload.track !== 'object' ||
        Array.isArray(payload.track)) {
        return null;
    }
    if (payload.volume !== undefined) {
        if (typeof payload.volume !== 'number' ||
            !Number.isFinite(payload.volume) ||
            payload.volume < 0 ||
            payload.volume > 1) {
            return null;
        }
    }
    const track = payload.track;
    if (track.encoded !== undefined &&
        track.encoded !== null &&
        typeof track.encoded !== 'string') {
        return null;
    }
    return {
        track,
        volume: payload.volume
    };
}
/**
 * Normalizes decoded track info into the stricter `TrackInfoExtended` shape
 * required by the player mix API.
 *
 * @param decodedTrack - Decoded track payload.
 * @returns Normalized track information suitable for `PlayerTrack`.
 */
function normalizeMixTrackInfo(decodedTrack) {
    return {
        ...decodedTrack.info,
        uri: decodedTrack.info.uri ?? '',
        artworkUrl: decodedTrack.info.artworkUrl ?? null,
        isrc: decodedTrack.info.isrc ?? null
    };
}
/**
 * Builds the `PlayerTrack` payload required by `addMix(...)`.
 *
 * @param payload - Validated mix creation payload.
 * @returns Fully normalized player track payload.
 * @throws Error when the request does not provide a usable encoded track.
 */
function buildMixTrackPayload(payload) {
    const encoded = payload.track.encoded?.trim();
    if (!encoded) {
        throw new Error('Track must provide track.encoded for mix creation.');
    }
    const decodedTrack = decodeTrack(encoded.replace(/ /g, '+'));
    return {
        encoded: decodedTrack.encoded,
        info: normalizeMixTrackInfo(decodedTrack),
        userData: decodedTrack.userData,
        pluginInfo: decodedTrack.pluginInfo
    };
}
/**
 * Handles `POST /sessions/:id/players/:guildId/mix`.
 *
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @param pathParams - Validated path parameters.
 * @param runtime - Mix collection runtime.
 * @param sendResponse - Helper responsible for JSON serialization and headers.
 * @param parsedUrl - Parsed request URL.
 * @returns Promise that resolves once the response has been written.
 */
async function handleCreateMix(req, res, pathParams, runtime, sendResponse, parsedUrl) {
    const payload = getCreateMixPayload(req.body);
    if (!payload) {
        sendErrorResponse(req, res, 400, 'Bad Request', 'Invalid parameters', parsedUrl.pathname, true);
        return;
    }
    const mixConfig = runtime.options.mix ?? {
        enabled: true,
        defaultVolume: 0.8,
        maxLayersMix: 5,
        autoCleanup: true
    };
    if (!mixConfig.enabled) {
        sendErrorResponse(req, res, 403, 'Forbidden', 'Mix feature is disabled', parsedUrl.pathname);
        return;
    }
    try {
        const session = runtime.sessions.get(pathParams.sessionId);
        if (!session) {
            sendErrorResponse(req, res, 404, 'Session not found', 'Session not found', parsedUrl.pathname);
            return;
        }
        const trackPayload = buildMixTrackPayload(payload);
        const result = await session.players.addMix(pathParams.guildId, trackPayload, payload.volume ?? null);
        logger('debug', 'MixAPI', `Created mix ${result.id} for guild ${pathParams.guildId}`);
        const response = {
            id: result.id,
            track: result.track,
            volume: result.volume
        };
        sendResponse(req, res, response, 201);
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Error creating mix';
        logger('error', 'MixAPI', `Error creating mix: ${errorMessage}`);
        sendErrorResponse(req, res, 500, errorMessage, errorMessage, parsedUrl.pathname, true);
    }
}
/**
 * Handles `GET /sessions/:id/players/:guildId/mix`.
 *
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @param pathParams - Validated path parameters.
 * @param runtime - Mix collection runtime.
 * @param sendResponse - Helper responsible for JSON serialization and headers.
 * @param parsedUrl - Parsed request URL.
 * @returns Promise that resolves once the response has been written.
 */
async function handleGetMixes(req, res, pathParams, runtime, sendResponse, parsedUrl) {
    try {
        const session = runtime.sessions.get(pathParams.sessionId);
        if (!session) {
            sendErrorResponse(req, res, 404, 'Session not found', 'Session not found', parsedUrl.pathname);
            return;
        }
        const mixes = await session.players.getMixes(pathParams.guildId);
        const response = { mixes };
        sendResponse(req, res, response, 200);
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Error getting mixes';
        logger('error', 'MixAPI', `Error getting mixes: ${errorMessage}`);
        sendErrorResponse(req, res, 500, errorMessage, errorMessage, parsedUrl.pathname, true);
    }
}
/**
 * Handles requests for the mix collection route.
 *
 * Supports:
 * - `POST` to create a new mix layer
 * - `GET` to list active mix layers
 *
 * @param nodelink - Router-facing NodeLink runtime.
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @param sendResponse - Helper responsible for JSON serialization and headers.
 * @param parsedUrl - Parsed request URL.
 * @returns Promise that resolves once the response has been written.
 */
async function handler(nodelink, req, res, sendResponse, parsedUrl) {
    const runtime = getMixCollectionRuntime(nodelink);
    if (!runtime) {
        sendErrorResponse(req, res, 500, 'Internal Server Error', 'Mix collection runtime contract is incomplete.', parsedUrl.pathname, true);
        return;
    }
    const pathParams = getPathParams(parsedUrl);
    if (!pathParams) {
        sendErrorResponse(req, res, 400, 'Bad Request', 'Invalid path parameters', parsedUrl.pathname, true);
        return;
    }
    if (req.method === 'POST') {
        await handleCreateMix(req, res, pathParams, runtime, sendResponse, parsedUrl);
        return;
    }
    if (req.method === 'GET') {
        await handleGetMixes(req, res, pathParams, runtime, sendResponse, parsedUrl);
        return;
    }
    sendErrorResponse(req, res, 405, 'Method Not Allowed', 'Method Not Allowed', parsedUrl.pathname);
}
/**
 * Route module definition for the mix collection route.
 */
const mixCollectionRoute = {
    handler,
    methods: ['GET', 'POST']
};
export default mixCollectionRoute;
