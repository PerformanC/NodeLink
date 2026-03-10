import { sendResponse } from "../utils.js";
/**
 * Creates a strongly typed runtime view for the connection endpoint.
 *
 * @param nodelink - Router-facing runtime instance.
 * @returns Runtime compatible with the connection endpoint, or `null` when the
 * connection manager field is unavailable.
 */
function getConnectionRuntime(nodelink) {
    const runtime = nodelink;
    if (runtime.connectionManager === undefined) {
        return null;
    }
    return runtime;
}
/**
 * Builds the disabled response payload used outside the primary process.
 *
 * @returns Stable disabled-state payload for the connection endpoint.
 */
function buildDisabledResponse() {
    return {
        status: 'disabled',
        metrics: null,
        reason: 'connection_manager_unavailable_in_this_process'
    };
}
/**
 * Builds the active response payload from the connection manager state.
 *
 * @param connectionManager - Active connection manager instance.
 * @returns Serialized status and metrics payload.
 */
function buildEnabledResponse(connectionManager) {
    return {
        status: connectionManager.status,
        metrics: connectionManager.metrics
    };
}
/**
 * Handles requests for the connection diagnostics endpoint.
 *
 * @param nodelink - Router-facing NodeLink runtime.
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @returns Nothing. The payload is written directly to the response.
 */
function handler(nodelink, req, res) {
    const runtime = getConnectionRuntime(nodelink);
    if (!runtime) {
        sendResponse(req, res, {
            timestamp: Date.now(),
            status: 500,
            error: 'Internal Server Error',
            message: 'Connection runtime contract is incomplete.',
            path: req.url ?? '/v4/connection'
        }, 500);
        return;
    }
    if (!runtime.connectionManager) {
        sendResponse(req, res, buildDisabledResponse(), 200);
        return;
    }
    sendResponse(req, res, buildEnabledResponse(runtime.connectionManager), 200);
}
/**
 * Route module definition for the connection diagnostics endpoint.
 */
const connectionRoute = {
    handler
};
export default connectionRoute;
