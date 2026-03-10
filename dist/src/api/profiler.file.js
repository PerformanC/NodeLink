import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendErrorResponse, sendResponse } from "../utils.js";
/**
 * Loopback addresses allowed to access the profiler endpoints when external
 * access is disabled.
 */
const LOOPBACKS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
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
 * Normalizes the profiler endpoint access configuration.
 *
 * @param nodelink - Router-facing runtime instance.
 * @returns Explicit endpoint configuration with boolean flags and fallback
 * secret.
 */
function getEndpointConfig(nodelink) {
    const endpoint = nodelink.options.cluster?.endpoint;
    const code = typeof endpoint?.code === 'string' && endpoint.code.length > 0
        ? endpoint.code
        : 'CAPYBARA';
    return {
        patchEnabled: endpoint?.patchEnabled === true,
        allowExternalPatch: endpoint?.allowExternalPatch === true,
        code
    };
}
/**
 * Parses a positive one-based line number.
 *
 * @param value - Raw query value.
 * @param fallback - Value returned when parsing fails.
 * @returns Sanitized positive integer.
 */
function parsePositiveLine(value, fallback = 1) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return fallback;
    }
    return Math.floor(parsed);
}
/**
 * Reads the profiler access code from either the query string or the request
 * body.
 *
 * @param req - Incoming API request.
 * @param parsedUrl - Parsed request URL.
 * @returns Access code string, or `null` when not provided.
 */
function getSuppliedCode(req, parsedUrl) {
    const queryCode = parsedUrl.searchParams.get('code');
    if (typeof queryCode === 'string' && queryCode.length > 0) {
        return queryCode;
    }
    if (isObjectRecord(req.body)) {
        const bodyCode = req.body.code;
        if (typeof bodyCode === 'string' && bodyCode.length > 0) {
            return bodyCode;
        }
    }
    return null;
}
/**
 * Validates that the requested path remains inside the project root.
 *
 * `file://` URLs are converted to absolute filesystem paths before the
 * containment check runs.
 *
 * @param rawPath - Raw query path received by the endpoint.
 * @returns Normalized absolute path inside the project root, or `null` when
 * the path escapes the workspace.
 */
function resolveWorkspacePath(rawPath) {
    const cwd = process.cwd();
    const parsedPath = rawPath.startsWith('file://')
        ? fileURLToPath(rawPath)
        : rawPath;
    const absolutePath = path.resolve(cwd, parsedPath);
    const normalizedCwd = `${cwd}${path.sep}`;
    if (absolutePath !== cwd &&
        !absolutePath.startsWith(normalizedCwd) &&
        !parsedPath.startsWith(normalizedCwd)) {
        return null;
    }
    return absolutePath;
}
/**
 * Builds candidate paths for source lookup.
 *
 * When the UI points to a compiled `dist/.../*.js` file, the route also tries
 * the corresponding `src/.../*.ts` file so the user sees the authored source.
 *
 * @param absolutePath - Normalized absolute path requested by the client.
 * @returns Candidate paths in lookup order.
 */
function getPathCandidates(absolutePath) {
    const candidates = [absolutePath];
    if (absolutePath.includes(`${path.sep}dist${path.sep}`) &&
        absolutePath.endsWith('.js')) {
        candidates.push(absolutePath
            .replace(`${path.sep}dist${path.sep}`, `${path.sep}src${path.sep}`)
            .replace(/\.js$/i, '.ts'));
    }
    return candidates;
}
/**
 * Resolves the first readable candidate path.
 *
 * @param candidates - Candidate absolute paths.
 * @returns Readable path when one exists, otherwise the first candidate.
 */
async function resolveReadablePath(candidates) {
    for (const candidate of candidates) {
        try {
            await fsPromises.access(candidate);
            return candidate;
        }
        catch { }
    }
    return candidates[0] ?? process.cwd();
}
/**
 * Builds the snippet payload returned by the profiler file endpoint.
 *
 * @param resolvedPath - Final readable file path.
 * @param line - Requested focal line.
 * @param context - Number of context lines around the focal line.
 * @returns Serialized snippet payload.
 */
async function buildSnippetResponse(resolvedPath, line, context) {
    const content = await fsPromises.readFile(resolvedPath, 'utf8');
    const lines = content.split('\n');
    const start = Math.max(1, line - context);
    const end = Math.min(lines.length, line + context);
    const snippet = [];
    for (let index = start; index <= end; index++) {
        snippet.push({
            number: index,
            text: lines[index - 1] ?? ''
        });
    }
    return {
        path: resolvedPath,
        line,
        start,
        end,
        totalLines: lines.length,
        snippet
    };
}
/**
 * Handles the profiler file snippet endpoint.
 *
 * The route is restricted to loopback clients unless external profiler access
 * is explicitly enabled. It also confines file reads to the current workspace
 * root and optionally remaps compiled `dist` JavaScript files back to authored
 * `src` TypeScript sources.
 *
 * @param nodelink - Router-facing NodeLink runtime.
 * @param req - Incoming API request.
 * @param res - Outgoing API response.
 * @param _sendResponse - Router helper, unused because this module relies on
 * the shared utility serializer.
 * @param parsedUrl - Parsed request URL.
 * @returns Nothing. A response is always sent as a side effect.
 */
async function handler(nodelink, req, res, _sendResponse, parsedUrl) {
    const endpointConfig = getEndpointConfig(nodelink);
    if (!endpointConfig.patchEnabled) {
        sendErrorResponse(req, res, 403, 'Forbidden', 'Profiler endpoint is disabled.', parsedUrl.pathname);
        return;
    }
    const remoteAddress = req.socket?.remoteAddress ?? '';
    if (!endpointConfig.allowExternalPatch && !LOOPBACKS.has(remoteAddress)) {
        sendErrorResponse(req, res, 403, 'Forbidden', 'External access to profiler file endpoint is blocked.', parsedUrl.pathname);
        return;
    }
    const code = getSuppliedCode(req, parsedUrl);
    if (code !== endpointConfig.code) {
        sendErrorResponse(req, res, 403, 'Forbidden', 'Invalid or missing profiler code.', parsedUrl.pathname);
        return;
    }
    const rawPath = parsedUrl.searchParams.get('path');
    if (!rawPath) {
        sendErrorResponse(req, res, 400, 'Bad Request', 'Missing path query parameter.', parsedUrl.pathname);
        return;
    }
    const absolutePath = resolveWorkspacePath(rawPath);
    if (absolutePath === null) {
        sendErrorResponse(req, res, 403, 'Forbidden', 'Path is outside the project root.', parsedUrl.pathname);
        return;
    }
    const line = parsePositiveLine(parsedUrl.searchParams.get('line'), 1);
    const context = Math.min(60, Math.max(3, parsePositiveLine(parsedUrl.searchParams.get('context'), 8)));
    try {
        const resolvedPath = await resolveReadablePath(getPathCandidates(absolutePath));
        sendResponse(req, res, await buildSnippetResponse(resolvedPath, line, context), 200);
    }
    catch (error) {
        sendErrorResponse(req, res, 404, 'Not Found', `Could not read file: ${error instanceof Error ? error.message : String(error)}`, parsedUrl.pathname);
    }
}
const profilerFileRoute = {
    handler,
    methods: ['GET']
};
export default profilerFileRoute;
