import OAuth from '../sources/youtube/OAuth.js';
import { logger, sendErrorResponse } from "../utils.js";
/**
 * Returns whether the provided body value is a plain object record.
 *
 * @param value - Candidate request body.
 * @returns `true` when the value can be safely indexed by string keys.
 */
function isObjectRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
/**
 * Narrows the router runtime to the fields used by the YouTube config route.
 *
 * @param nodelink - Router-facing runtime instance.
 * @returns Runtime view exposing optional worker and source managers.
 */
function getRuntime(nodelink) {
    return nodelink;
}
/**
 * Extracts a non-empty string from a request field.
 *
 * @param value - Candidate request field.
 * @returns Trimmed string when valid, otherwise `undefined`.
 */
function getNonEmptyString(value) {
    if (typeof value !== 'string') {
        return undefined;
    }
    return value.length > 0 ? value : undefined;
}
/**
 * Parses and validates the patch payload used by `PATCH /youtube.config`.
 *
 * @param body - Parsed request body.
 * @returns Valid payload, or `null` when any provided field is invalid.
 */
function getPatchPayload(body) {
    if (!isObjectRecord(body)) {
        return null;
    }
    const payload = body;
    const refreshToken = payload.refreshToken === undefined
        ? undefined
        : getNonEmptyString(payload.refreshToken);
    if (payload.refreshToken !== undefined && refreshToken === undefined) {
        return null;
    }
    const visitorData = payload.visitorData === undefined
        ? undefined
        : getNonEmptyString(payload.visitorData);
    if (payload.visitorData !== undefined && visitorData === undefined) {
        return null;
    }
    return {
        refreshToken,
        visitorData
    };
}
/**
 * Resolves the first non-empty refresh token from the runtime shape.
 *
 * Local OAuth helpers may store refresh tokens as an array while the cluster
 * manager stores a single string.
 *
 * @param value - Candidate refresh token state.
 * @returns Single refresh token string, or `null` when not configured.
 */
function getFirstRefreshToken(value) {
    if (typeof value === 'string' && value.length > 0) {
        return value;
    }
    if (Array.isArray(value)) {
        for (const token of value) {
            if (typeof token === 'string' && token.length > 0) {
                return token;
            }
        }
    }
    return null;
}
/**
 * Masks a sensitive string while preserving a small visible prefix.
 *
 * @param value - Sensitive string value to mask.
 * @param visibleChars - Number of leading characters that remain visible.
 * @returns Masked string, or `null` when the input is empty.
 */
function maskString(value, visibleChars = 5) {
    if (!value) {
        return null;
    }
    if (value.length <= visibleChars) {
        return '***';
    }
    return `${value.substring(0, visibleChars)}...[hidden]`;
}
/**
 * Reads the local YouTube source when the server is running without workers.
 *
 * @param runtime - Typed route runtime.
 * @returns Local YouTube source, or `null` when unavailable.
 */
function getLocalYoutubeSource(runtime) {
    return runtime.sources?.sources?.get('youtube') ?? null;
}
/**
 * Collects the current runtime configuration and optionally validates the
 * stored refresh token by performing a sandboxed OAuth refresh.
 *
 * @param runtime - Typed route runtime.
 * @param parsedUrl - Parsed request URL.
 * @returns Serialized response payload for the GET endpoint.
 */
async function collectCurrentConfig(runtime, parsedUrl) {
    let currentRefreshToken = null;
    let currentVisitorData = null;
    if (runtime.workerManager) {
        currentRefreshToken = runtime.workerManager.liveYoutubeConfig.refreshToken;
        currentVisitorData = runtime.workerManager.liveYoutubeConfig.visitorData;
        if (!currentRefreshToken) {
            currentRefreshToken = getFirstRefreshToken(runtime.options.sources.youtube?.clients?.settings?.TV?.refreshToken);
        }
    }
    else {
        const youtube = getLocalYoutubeSource(runtime);
        if (youtube) {
            currentRefreshToken = getFirstRefreshToken(youtube.oauth?.refreshToken);
            currentVisitorData = youtube.ytContext?.client?.visitorData ?? null;
        }
    }
    let isValid = null;
    if (parsedUrl.searchParams.get('validate') === 'true' &&
        currentRefreshToken !== null) {
        try {
            const validator = new OAuth(runtime);
            validator.refreshToken = currentRefreshToken;
            validator.accessToken = null;
            validator.tokenExpiry = 0;
            isValid = Boolean(await validator.getAccessToken());
        }
        catch {
            isValid = false;
        }
    }
    return {
        refreshToken: maskString(currentRefreshToken, 7),
        visitorData: maskString(currentVisitorData, 10),
        isConfigured: currentRefreshToken !== null,
        isValid
    };
}
/**
 * Validates a refresh token before any runtime state is mutated.
 *
 * @param runtime - Typed route runtime.
 * @param refreshToken - Refresh token proposed by the request payload.
 * @returns Nothing. The function throws when Google rejects the token.
 */
async function validateRefreshToken(runtime, refreshToken) {
    logger('info', 'API', 'Sandboxing new YouTube refresh token for validation.');
    const sandboxOAuth = new OAuth(runtime);
    sandboxOAuth.refreshToken = refreshToken;
    sandboxOAuth.accessToken = null;
    sandboxOAuth.tokenExpiry = 0;
    const accessToken = await sandboxOAuth.getAccessToken();
    if (!accessToken) {
        throw new Error('Google rejected the refresh token (Invalid Grant or similar).');
    }
    logger('info', 'API', 'YouTube refresh token validated successfully.');
}
/**
 * Propagates a YouTube config update through connected playback workers.
 *
 * @param runtime - Typed route runtime.
 * @param payload - Validated patch payload.
 * @returns Number of workers that applied the update successfully.
 */
async function updateClusterConfig(runtime, payload) {
    const manager = runtime.workerManager;
    if (!manager) {
        return 0;
    }
    manager.setLiveYoutubeConfig({
        refreshToken: payload.refreshToken ?? undefined,
        visitorData: payload.visitorData ?? undefined
    });
    logger('info', 'API', 'Master LiveConfig updated for future workers.');
    logger('info', 'API', 'Propagating YouTube config to cluster workers.');
    const results = await Promise.all(manager.workers
        .filter((worker) => worker.isConnected())
        .map(async (worker) => {
        try {
            await manager.execute(worker, 'updateYoutubeConfig', payload);
            return 1;
        }
        catch (error) {
            logger('error', 'API', `Failed to update worker ${worker.id}: ${error instanceof Error ? error.message : String(error)}`);
            return 0;
        }
    }));
    return results.reduce((total, value) => total + value, 0);
}
/**
 * Applies a YouTube config update to the local in-process source.
 *
 * @param runtime - Typed route runtime.
 * @param payload - Validated patch payload.
 * @returns `1` when the local source was updated, otherwise `0`.
 */
function updateLocalConfig(runtime, payload) {
    logger('info', 'API', 'Updating local YouTube source.');
    const youtube = getLocalYoutubeSource(runtime);
    if (!youtube) {
        return 0;
    }
    if (payload.refreshToken !== undefined && youtube.oauth) {
        youtube.oauth.refreshToken = payload.refreshToken;
        youtube.oauth.accessToken = null;
        youtube.oauth.tokenExpiry = 0;
        logger('info', 'YouTube', 'Local refresh token updated.');
    }
    if (payload.visitorData !== undefined && youtube.ytContext?.client) {
        youtube.ytContext.client.visitorData = payload.visitorData;
        logger('info', 'YouTube', 'Local visitor data updated.');
    }
    return 1;
}
/**
 * Handles the YouTube live configuration endpoint.
 *
 * `GET` returns masked runtime state and optionally validates the stored token.
 * `PATCH` validates and propagates runtime updates to workers or the local
 * source depending on the current deployment mode.
 *
 * @param nodelink - Router-facing NodeLink runtime.
 * @param req - Incoming API request.
 * @param res - Outgoing API response.
 * @param sendResponse - JSON response helper from the router.
 * @param parsedUrl - Parsed request URL.
 * @returns Nothing. A response is always sent as a side effect.
 */
async function handler(nodelink, req, res, sendResponse, parsedUrl) {
    const runtime = getRuntime(nodelink);
    if (req.method === 'GET') {
        sendResponse(req, res, await collectCurrentConfig(runtime, parsedUrl), 200);
        return;
    }
    if (req.method !== 'PATCH') {
        return;
    }
    const payload = getPatchPayload(req.body);
    if (payload === null) {
        sendErrorResponse(req, res, 400, 'Bad Request', 'Invalid parameters', parsedUrl.pathname);
        return;
    }
    if (payload.refreshToken === undefined && payload.visitorData === undefined) {
        sendErrorResponse(req, res, 400, 'Bad Request', 'At least one field (refreshToken or visitorData) must be provided.', parsedUrl.pathname);
        return;
    }
    if (payload.refreshToken !== undefined) {
        try {
            await validateRefreshToken(runtime, payload.refreshToken);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Token validation failed.';
            logger('warn', 'API', `YouTube token validation failed: ${message}`);
            sendErrorResponse(req, res, 403, 'Forbidden', `Token validation failed: ${message}. No changes were applied.`, parsedUrl.pathname);
            return;
        }
    }
    try {
        const workersUpdated = runtime.workerManager
            ? await updateClusterConfig(runtime, payload)
            : updateLocalConfig(runtime, payload);
        const fieldsUpdated = [
            payload.refreshToken !== undefined ? 'refreshToken' : null,
            payload.visitorData !== undefined ? 'visitorData' : null
        ].filter((field) => field !== null);
        sendResponse(req, res, {
            message: 'YouTube configuration updated successfully.',
            workersUpdated,
            fieldsUpdated
        }, 200);
    }
    catch (error) {
        logger('error', 'API', `Critical error during config propagation: ${error instanceof Error ? error.message : String(error)}`);
        sendErrorResponse(req, res, 500, 'Internal Server Error', 'Failed to propagate configuration changes.', parsedUrl.pathname);
    }
}
const youtubeConfigRoute = {
    handler,
    methods: ['GET', 'PATCH']
};
export default youtubeConfigRoute;
