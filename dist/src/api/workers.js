import { sendErrorResponse, sendResponse } from "../utils.js";
/**
 * Loopback addresses allowed to access the workers patch endpoint when
 * external patching is disabled.
 */
const LOOPBACKS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/**
 * Creates a strongly typed runtime view for the workers endpoint.
 *
 * @param nodelink - Router-facing runtime instance.
 * @returns Runtime compatible with the workers endpoint, or `null` when the
 * required worker manager field is unavailable.
 */
function getWorkersRuntime(nodelink) {
    const runtime = nodelink;
    if (runtime.workerManager === undefined) {
        return null;
    }
    return runtime;
}
/**
 * Resolves and normalizes the workers endpoint configuration.
 *
 * @param nodelink - Workers endpoint runtime.
 * @returns Normalized configuration with explicit boolean flags and default
 * fallback secret.
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
 * Converts a body value to the typed patch payload shape.
 *
 * Non-object payloads and arrays are rejected and normalized to an empty
 * payload object.
 *
 * @param body - Parsed request body provided by the router.
 * @returns Typed patch payload object.
 */
function getPatchPayload(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return {};
    }
    return body;
}
/**
 * Parses an integer-like worker identifier from a request field.
 *
 * @param value - Raw identifier value from the request payload.
 * @returns Normalized integer when the value is a valid whole number;
 * otherwise `null`.
 */
function normalizeNumber(value) {
    if (typeof value === 'number' && Number.isInteger(value)) {
        return value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        if (Number.isInteger(parsed)) {
            return parsed;
        }
    }
    return null;
}
/**
 * Resolves a worker identifier from the supported patch payload fields.
 *
 * Resolution order matches the previous JavaScript implementation:
 * `clusterId`, then public `id`, then process `pid`.
 *
 * @param manager - Worker manager runtime.
 * @param payload - Parsed patch payload.
 * @returns Matching cluster worker identifier, or `null` when no worker can be
 * resolved from the payload.
 */
function resolveWorkerId(manager, payload) {
    const clusterId = normalizeNumber(payload.clusterId);
    if (clusterId !== null && manager.workersById.has(clusterId)) {
        return clusterId;
    }
    const uniqueId = normalizeNumber(payload.id);
    if (uniqueId !== null) {
        for (const [workerId, workerUniqueId] of manager.workerUniqueId.entries()) {
            if (workerUniqueId === uniqueId) {
                return workerId;
            }
        }
    }
    const pid = normalizeNumber(payload.pid);
    if (pid !== null) {
        const worker = manager.workers.find((entry) => entry.process?.pid === pid);
        if (worker) {
            return worker.id;
        }
    }
    return null;
}
/**
 * Serializes the worker metrics payload into the public response shape.
 *
 * @param metrics - Metrics payload keyed by public worker identifier.
 * @returns Array of serialized worker entries.
 */
function buildWorkerList(metrics) {
    return Object.entries(metrics).map(([id, data]) => ({
        id: Number(id),
        ...data
    }));
}
/**
 * Handles `GET /workers` requests.
 *
 * @param nodelink - Workers endpoint runtime.
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @returns Nothing. The payload is written directly to the response.
 */
function handleGet(nodelink, req, res) {
    const manager = nodelink.workerManager;
    if (!manager) {
        sendResponse(req, res, [], 200);
        return;
    }
    sendResponse(req, res, buildWorkerList(manager.getWorkerMetrics()), 200);
}
/**
 * Handles `PATCH /workers` requests used to terminate a worker process.
 *
 * @param nodelink - Workers endpoint runtime.
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @param parsedUrl - Parsed request URL used for standardized error payloads.
 * @returns Nothing. The payload is written directly to the response.
 */
function handlePatch(nodelink, req, res, parsedUrl) {
    const manager = nodelink.workerManager;
    if (!manager) {
        sendErrorResponse(req, res, 409, 'Conflict', 'Cluster workers are not enabled.', parsedUrl.pathname);
        return;
    }
    const endpointConfig = getEndpointConfig(nodelink);
    if (!endpointConfig.patchEnabled) {
        sendErrorResponse(req, res, 403, 'Forbidden', 'Workers patch endpoint is disabled.', parsedUrl.pathname);
        return;
    }
    const remoteAddress = req.socket?.remoteAddress ?? '';
    if (!endpointConfig.allowExternalPatch && !LOOPBACKS.has(remoteAddress)) {
        sendErrorResponse(req, res, 403, 'Forbidden', 'External access to the workers patch endpoint is blocked.', parsedUrl.pathname);
        return;
    }
    const payload = getPatchPayload(req.body);
    if (payload.code !== endpointConfig.code) {
        sendErrorResponse(req, res, 403, 'Forbidden', 'Invalid workers patch code.', parsedUrl.pathname);
        return;
    }
    const workerId = resolveWorkerId(manager, payload);
    if (workerId === null) {
        sendErrorResponse(req, res, 400, 'Bad Request', 'Worker identifier is required.', parsedUrl.pathname);
        return;
    }
    const worker = manager.workersById.get(workerId);
    if (!worker) {
        sendErrorResponse(req, res, 404, 'Not Found', 'Worker not found.', parsedUrl.pathname);
        return;
    }
    const uniqueId = manager.workerUniqueId.get(workerId) ?? workerId;
    const pid = worker.process?.pid ?? null;
    manager.removeWorker(workerId);
    sendResponse(req, res, {
        killed: true,
        id: uniqueId,
        clusterId: workerId,
        pid
    }, 200);
}
/**
 * Handles requests for the workers endpoint.
 *
 * The endpoint supports:
 * - `GET` to list worker metrics
 * - `PATCH` to remove a worker when the endpoint is enabled and authorized
 *
 * @param nodelink - Router-facing NodeLink runtime.
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @param _sendResponse - Unused route helper kept for handler signature
 * compatibility.
 * @param parsedUrl - Parsed request URL used for standardized error payloads.
 * @returns Nothing. The response is written directly by the selected handler.
 */
function handler(nodelink, req, res, _sendResponse, parsedUrl) {
    const runtime = getWorkersRuntime(nodelink);
    if (!runtime) {
        sendErrorResponse(req, res, 500, 'Internal Server Error', 'Workers runtime contract is incomplete.', parsedUrl.pathname);
        return;
    }
    if (req.method === 'GET') {
        handleGet(runtime, req, res);
        return;
    }
    if (req.method === 'PATCH') {
        handlePatch(runtime, req, res, parsedUrl);
        return;
    }
    sendErrorResponse(req, res, 405, 'Method Not Allowed', 'Method must be GET or PATCH.', parsedUrl.pathname);
}
/**
 * Route module definition for the workers endpoint.
 */
const workersRoute = {
    handler,
    methods: ['GET', 'PATCH']
};
export default workersRoute;
