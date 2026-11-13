import { sendResponse } from '../utils.js';
/**
 * Handles `GET /v4/sources/health` requests.
 *
 * Emits consolidated diagnostics, performance metrics (P50/P95 latencies, jitter),
 * circuit breaker states, and health recommendations for all registered audio sources.
 *
 * @param nodelink - NodeLink runtime instance.
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 */
function handler(nodelink, req, res) {
    const runtime = nodelink;
    const manager = runtime.sourceHealthManager;
    if (!manager?.isEnabled) {
        const disabledResponse = {
            enabled: false,
            timestamp: Date.now(),
            summary: {
                total: 0,
                healthy: 0,
                degraded: 0,
                unavailable: 0,
                rate_limited: 0,
                restricted: 0,
                misconfigured: 0,
                idle: 0,
                unknown: 0
            },
            sources: {},
            probe: {
                enabled: false,
                intervalMs: 0,
                nextRunAt: null,
                lastRunAt: null,
                running: false,
                currentSources: [],
                nextSources: [],
                eligibleSources: 0
            }
        };
        sendResponse(req, res, disabledResponse, 200);
        return;
    }
    const responsePayload = {
        enabled: true,
        timestamp: Date.now(),
        summary: manager.getSummary(),
        sources: manager.getAllHealth(),
        probe: manager.getProbeStatus()
    };
    sendResponse(req, res, responsePayload, 200);
}
/**
 * API route module configuration for source health diagnostics.
 */
const sourcesHealthRoute = {
    methods: ['GET'],
    paths: ['/v4/sources/health'],
    handler
};
export default sourcesHealthRoute;
