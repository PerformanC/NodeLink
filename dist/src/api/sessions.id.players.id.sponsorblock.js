import { sendErrorResponse } from "../utils.js";
/**
 * Builds a strongly typed runtime view for the SponsorBlock route.
 *
 * @param nodelink - Router-facing runtime instance.
 * @returns Runtime compatible with the route, or `null` when the required
 * session manager field is unavailable.
 */
function getSponsorBlockRuntime(nodelink) {
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
 * Handles `GET /sessions/:id/players/:guildId/sponsorblock`.
 */
async function handleGetSponsorBlock(req, res, pathParams, runtime, sendResponse) {
    const session = runtime.sessions.get(pathParams.sessionId);
    if (!session) {
        sendErrorResponse(req, res, 404, 'Not Found', "The provided sessionId doesn't exist.", req.url || '');
        return;
    }
    try {
        const state = await session.players.getSponsorBlock(pathParams.guildId);
        sendResponse(req, res, state, 200);
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Player not found';
        sendErrorResponse(req, res, 404, 'Not Found', errorMessage, req.url || '');
    }
}
/**
 * Handles `PATCH /sessions/:id/players/:guildId/sponsorblock`.
 */
async function handlePatchSponsorBlock(req, res, pathParams, runtime, sendResponse) {
    const session = runtime.sessions.get(pathParams.sessionId);
    if (!session) {
        sendErrorResponse(req, res, 404, 'Not Found', "The provided sessionId doesn't exist.", req.url || '');
        return;
    }
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        sendErrorResponse(req, res, 400, 'Bad Request', 'Invalid body', req.url || '');
        return;
    }
    try {
        const result = await session.players.updateSponsorBlock(pathParams.guildId, {
            enabled: body.enabled,
            categories: body.categories,
            actionTypes: body.actionTypes,
            skipMarginMs: body.skipMarginMs
        });
        if (result && 'status' in result && result.status !== 200) {
            sendErrorResponse(req, res, result.status || 500, 'Internal Server Error', result.message || 'Operation failed', req.url || '');
            return;
        }
        sendResponse(req, res, await session.players.getSponsorBlock(pathParams.guildId), 200);
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Player not found';
        sendErrorResponse(req, res, 404, 'Not Found', errorMessage, req.url || '');
    }
}
/**
 * Handles `POST /sessions/:id/players/:guildId/sponsorblock`.
 */
async function handlePostSponsorBlock(req, res, pathParams, runtime, sendResponse) {
    const session = runtime.sessions.get(pathParams.sessionId);
    if (!session) {
        sendErrorResponse(req, res, 404, 'Not Found', "The provided sessionId doesn't exist.", req.url || '');
        return;
    }
    const body = req.body;
    if (!body?.segments || !Array.isArray(body.segments)) {
        sendErrorResponse(req, res, 400, 'Bad Request', 'Invalid segments array', req.url || '');
        return;
    }
    try {
        const result = await session.players.setSponsorBlockSegments(pathParams.guildId, body.segments);
        if (result && 'status' in result && result.status !== 200) {
            sendErrorResponse(req, res, result.status || 500, 'Internal Server Error', result.message || 'Operation failed', req.url || '');
            return;
        }
        sendResponse(req, res, await session.players.getSponsorBlock(pathParams.guildId), 200);
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Player not found';
        sendErrorResponse(req, res, 404, 'Not Found', errorMessage, req.url || '');
    }
}
/**
 * Handles `DELETE /sessions/:id/players/:guildId/sponsorblock`.
 */
async function handleDeleteSponsorBlock(req, res, pathParams, runtime) {
    const session = runtime.sessions.get(pathParams.sessionId);
    if (!session) {
        sendErrorResponse(req, res, 404, 'Not Found', "The provided sessionId doesn't exist.", req.url || '');
        return;
    }
    try {
        await session.players.clearSponsorBlock(pathParams.guildId);
        res.writeHead(204);
        res.end();
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Player not found';
        sendErrorResponse(req, res, 404, 'Not Found', errorMessage, req.url || '');
    }
}
/**
 * Handles requests for the SponsorBlock route.
 */
async function handler(nodelink, req, res, sendResponse, parsedUrl) {
    const runtime = getSponsorBlockRuntime(nodelink);
    if (!runtime) {
        sendErrorResponse(req, res, 500, 'Internal Server Error', 'SponsorBlock runtime contract is incomplete.', parsedUrl.pathname, true);
        return;
    }
    const pathParams = getPathParams(parsedUrl);
    if (!pathParams) {
        sendErrorResponse(req, res, 400, 'Bad Request', 'Invalid path parameters', parsedUrl.pathname, true);
        return;
    }
    if (req.method === 'GET') {
        await handleGetSponsorBlock(req, res, pathParams, runtime, sendResponse);
        return;
    }
    if (req.method === 'PATCH') {
        await handlePatchSponsorBlock(req, res, pathParams, runtime, sendResponse);
        return;
    }
    if (req.method === 'POST') {
        await handlePostSponsorBlock(req, res, pathParams, runtime, sendResponse);
        return;
    }
    if (req.method === 'DELETE') {
        await handleDeleteSponsorBlock(req, res, pathParams, runtime);
        return;
    }
    sendErrorResponse(req, res, 405, 'Method Not Allowed', 'Method Not Allowed', parsedUrl.pathname);
}
const sponsorBlockRoute = {
    handler,
    methods: ['GET', 'POST', 'PATCH', 'DELETE']
};
export default sponsorBlockRoute;
