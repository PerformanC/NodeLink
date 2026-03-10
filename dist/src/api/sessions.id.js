import { logger, sendErrorResponse } from "../utils.js";
/**
 * Builds a strongly typed runtime view for the session patch endpoint.
 *
 * @param nodelink - Router-facing runtime instance.
 * @returns Runtime compatible with the endpoint, or `null` when the required
 * session manager field is unavailable.
 */
function getSessionRuntime(nodelink) {
    const runtime = nodelink;
    if (!runtime.sessions || typeof runtime.sessions.get !== 'function') {
        return null;
    }
    return runtime;
}
/**
 * Extracts the session identifier from the dynamic route pathname.
 *
 * @param parsedUrl - Parsed request URL.
 * @returns Session identifier or `null` when it cannot be resolved.
 */
function getSessionIdFromPath(parsedUrl) {
    const parts = parsedUrl.pathname.split('/');
    const sessionId = parts[3];
    return sessionId ? sessionId : null;
}
/**
 * Parses and validates the session patch payload.
 *
 * @param body - Parsed request body.
 * @returns Valid patch payload, or `null` when validation fails.
 */
function getSessionPatchPayload(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return null;
    }
    const payload = body;
    if (payload.resuming !== undefined && typeof payload.resuming !== 'boolean') {
        return null;
    }
    if (payload.timeout !== undefined) {
        if (!Number.isFinite(payload.timeout) || payload.timeout < 0) {
            return null;
        }
    }
    return payload;
}
/**
 * Applies a validated patch payload to a session.
 *
 * @param session - Session instance to mutate.
 * @param payload - Validated patch payload.
 * @returns Serialized response payload describing the updated fields.
 */
function applySessionPatch(session, payload) {
    if (payload.resuming !== undefined) {
        session.resuming = payload.resuming;
    }
    if (payload.timeout !== undefined) {
        session.timeout = payload.timeout;
    }
    return {
        resuming: session.resuming,
        timeout: session.timeout
    };
}
/**
 * Handles requests for `PATCH /sessions/:id`.
 *
 * @param nodelink - Router-facing NodeLink runtime.
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @param sendResponse - Helper responsible for JSON serialization and headers.
 * @param parsedUrl - Parsed request URL.
 * @returns Promise that resolves once the response has been written.
 */
async function handler(nodelink, req, res, sendResponse, parsedUrl) {
    const runtime = getSessionRuntime(nodelink);
    if (!runtime) {
        sendErrorResponse(req, res, 500, 'Internal Server Error', 'Session runtime contract is incomplete.', parsedUrl.pathname, true);
        return;
    }
    const sessionId = getSessionIdFromPath(parsedUrl);
    if (!sessionId) {
        sendErrorResponse(req, res, 400, 'Bad Request', 'Session identifier is required.', parsedUrl.pathname, true);
        return;
    }
    const session = runtime.sessions.get(sessionId);
    if (!session) {
        sendErrorResponse(req, res, 404, 'Not Found', "The provided sessionId doesn't exist.", parsedUrl.pathname);
        return;
    }
    const payload = getSessionPatchPayload(req.body);
    if (!payload) {
        const errorMessage = 'Invalid PATCH payload';
        logger('warn', 'Session', `Invalid PATCH payload for session ${sessionId}: ${errorMessage}`);
        sendErrorResponse(req, res, 400, 'Bad Request', errorMessage, parsedUrl.pathname);
        return;
    }
    logger('debug', 'Session', `Received PATCH for session ${sessionId}:`, payload);
    const response = applySessionPatch(session, payload);
    logger('debug', 'Session', `Updated session ${sessionId}:`, response);
    sendResponse(req, res, response, 200);
}
/**
 * Route module definition for the session patch endpoint.
 */
const sessionRoute = {
    handler,
    methods: ['PATCH']
};
export default sessionRoute;
