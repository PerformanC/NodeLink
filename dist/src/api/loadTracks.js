import { logger, sendErrorResponse } from "../utils.js";
import { validator } from "../validators.js";
/**
 * Quick protocol matcher for absolute URLs.
 */
const URL_PROTOCOL_RE = /^(?:https?|ftts):\/\//i;
/**
 * Identifier parser for `source:query` and local-path identifiers.
 *
 * Captures named groups: `source`, `query`, and `local`.
 */
const IDENTIFIER_RE = /^(?:(?<source>(?![A-Z]:\\)[A-Za-z0-9]+):(?<query>(?!\/\/).+)|(?<local>(?:\/|[A-Z]:\\|\\).+))$/i;
/**
 * Message used when the identifier parameter is missing or empty.
 */
const IDENTIFIER_REQUIRED_MESSAGE = 'identifier parameter is required.';
/**
 * Schema for query string validation.
 *
 * Ensures the identifier parameter is present and non-empty.
 */
const loadTracksSchema = validator.compile({
    identifier: {
        type: 'string',
        empty: false,
        messages: {
            required: IDENTIFIER_REQUIRED_MESSAGE,
            string: IDENTIFIER_REQUIRED_MESSAGE,
            stringEmpty: IDENTIFIER_REQUIRED_MESSAGE
        }
    }
});
/**
 * Normalizes the default search source configuration.
 *
 * @param value - Default search source from configuration.
 * @returns The first source when an array is provided, otherwise the string.
 * @example
 * ```ts
 * normalizeDefaultSearchSource(['youtube', 'soundcloud'])
 * ```
 */
function normalizeDefaultSearchSource(value) {
    return Array.isArray(value) ? value[0] : value;
}
/**
 * Parses a track identifier into a normalized load target.
 *
 * @param identifier - Raw identifier string from the query parameter.
 * @param defaultSearchSource - Optional fallback source when no prefix is present.
 * @returns Normalized target describing how to resolve the identifier.
 * @example
 * ```ts
 * const target = parseIdentifier('youtube:lofi', ['youtube'])
 * ```
 */
function parseIdentifier(identifier, defaultSearchSource) {
    if (URL_PROTOCOL_RE.test(identifier)) {
        return { kind: 'url', url: identifier };
    }
    const match = IDENTIFIER_RE.exec(identifier);
    const groups = match?.groups;
    if (groups?.local) {
        return { kind: 'search', source: 'local', query: groups.local };
    }
    if (groups?.source && groups?.query) {
        if (groups.source === 'search') {
            return { kind: 'unifiedSearch', query: groups.query };
        }
        if (groups.source.toLowerCase() === 'isrc') {
            return { kind: 'search', source: normalizeDefaultSearchSource(defaultSearchSource), query: groups.query };
        }
        return { kind: 'search', source: groups.source, query: groups.query };
    }
    return {
        kind: 'search',
        source: normalizeDefaultSearchSource(defaultSearchSource),
        query: identifier
    };
}
/**
 * Maps a normalized target to a worker task and payload.
 *
 * @param target - Normalized load target.
 * @returns Worker task configuration for delegation.
 */
function buildWorkerRequest(target) {
    if (target.kind === 'url') {
        return { task: 'resolve', payload: { url: target.url } };
    }
    if (target.kind === 'unifiedSearch') {
        return { task: 'unifiedSearch', payload: { query: target.query } };
    }
    return {
        task: 'search',
        payload: { source: target.source, query: target.query }
    };
}
/**
 * Handles API requests for loading tracks.
 *
 * Validates the query, normalizes the identifier, and routes the request
 * to worker managers or sources depending on runtime capabilities.
 *
 * @param nodelink - NodeLink server instance.
 * @param req - Incoming HTTP request.
 * @param res - HTTP response object.
 * @param sendResponse - Helper for JSON responses.
 * @param parsedUrl - Parsed request URL.
 * @example
 * ```ts
 * await handler(nodelink, req, res, sendResponse, parsedUrl)
 * ```
 */
async function handler(nodelink, req, res, sendResponse, parsedUrl) {
    const identifierParam = parsedUrl.searchParams.get('identifier');
    const validation = loadTracksSchema({
        identifier: identifierParam ?? undefined
    });
    if (validation !== true) {
        const errorMessage = (Array.isArray(validation) ? validation[0]?.message : undefined) ||
            IDENTIFIER_REQUIRED_MESSAGE;
        logger('warn', 'Tracks', errorMessage);
        return sendErrorResponse(req, res, 400, 'missing identifier parameter', errorMessage, parsedUrl.pathname, true);
    }
    const identifier = (identifierParam ?? '').trim();
    if (!identifier) {
        logger('warn', 'Tracks', IDENTIFIER_REQUIRED_MESSAGE);
        return sendErrorResponse(req, res, 400, 'missing identifier parameter', IDENTIFIER_REQUIRED_MESSAGE, parsedUrl.pathname, true);
    }
    logger('debug', 'Tracks', `Loading tracks with identifier: "${identifier}"`);
    const target = parseIdentifier(identifier, nodelink.options.defaultSearchSource);
    const workerRequest = buildWorkerRequest(target);
    const runtime = nodelink;
    try {
        const sourceWorkerManager = runtime.sourceWorkerManager;
        if (sourceWorkerManager) {
            const delegated = sourceWorkerManager.delegate(req, res, workerRequest.task, workerRequest.payload);
            if (delegated)
                return;
        }
        let result;
        const workerManager = runtime.workerManager;
        const sources = runtime.sources;
        if (workerManager && !sourceWorkerManager) {
            const worker = workerManager.getBestWorker();
            result = await workerManager.execute(worker, 'loadTracks', { identifier });
        }
        else if (sources) {
            if (target.kind === 'url') {
                result = await sources.resolve(target.url);
            }
            else if (target.kind === 'unifiedSearch') {
                result = await sources.unifiedSearch(target.query);
            }
            else {
                result = await sources.search(target.source, target.query);
            }
        }
        return sendResponse(req, res, result, 200);
    }
    catch (err) {
        const error = err;
        logger('error', 'Tracks', `Failed to load track with identifier "${identifier}":`, error);
        return sendErrorResponse(req, res, 500, 'failed to load track', error.message || 'Failed to load track', parsedUrl.pathname, true);
    }
}
export default {
    handler
};
