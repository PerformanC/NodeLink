import { getStats } from "../utils.js";
/**
 * Builds a strongly typed runtime view for the stats endpoint.
 *
 * @param nodelink - Router-facing runtime instance.
 * @returns A runtime compatible with the stats endpoint, or `null` when the
 * required methods are unavailable.
 */
function getStatsRuntime(nodelink) {
    const runtime = nodelink;
    if (!runtime.statsManager) {
        return null;
    }
    if (typeof runtime.statsManager.getSnapshot !== 'function') {
        return null;
    }
    if (!runtime.sessions || typeof runtime.sessions.values !== 'function') {
        return null;
    }
    if (!runtime.statistics) {
        return null;
    }
    return runtime;
}
/**
 * Builds the serialized stats payload for the endpoint response.
 *
 * @param nodelink - Strongly typed runtime for the stats endpoint.
 * @returns Aggregate server stats plus the detailed stats manager snapshot.
 */
function buildStatsResponse(nodelink) {
    const payload = getStats(nodelink);
    const detailedStats = nodelink.statsManager.getSnapshot();
    return {
        ...payload,
        detailedStats
    };
}
/**
 * Handles requests for the public stats endpoint.
 *
 * The endpoint returns aggregate server statistics together with the richer
 * counters maintained by the in-memory stats manager.
 *
 * @param nodelink - Router-facing NodeLink runtime.
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @param sendResponse - Helper responsible for JSON serialization and headers.
 * @returns Nothing. The payload is written directly to the response.
 */
function handler(nodelink, req, res, sendResponse) {
    const runtime = getStatsRuntime(nodelink);
    if (!runtime) {
        sendResponse(req, res, {
            timestamp: Date.now(),
            status: 500,
            error: 'Internal Server Error',
            message: 'Stats runtime contract is incomplete.',
            path: req.url ?? '/v4/stats'
        }, 500);
        return;
    }
    sendResponse(req, res, buildStatsResponse(runtime), 200);
}
/**
 * Route module definition for the stats endpoint.
 */
const statsRoute = {
    handler
};
export default statsRoute;
