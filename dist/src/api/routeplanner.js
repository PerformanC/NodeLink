import { sendErrorResponse, sendResponse } from "../utils.js";
/**
 * Builds a strongly typed runtime view for the route planner endpoint.
 *
 * @param nodelink - Router-facing runtime instance.
 * @returns Runtime compatible with the route planner endpoint, or `null` when
 * the required manager field is unavailable.
 */
function getRoutePlannerRuntime(nodelink) {
    const runtime = nodelink;
    if (!runtime.routePlanner) {
        return null;
    }
    return runtime;
}
/**
 * Extracts and validates the free-address request body.
 *
 * @param body - Parsed request body.
 * @returns Valid payload object, or `null` when the payload is invalid.
 */
function getFreeAddressPayload(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return null;
    }
    const payload = body;
    if (typeof payload.address !== 'string' ||
        payload.address.trim().length === 0) {
        return null;
    }
    return {
        address: payload.address
    };
}
/**
 * Builds the route planner status payload.
 *
 * @param nodelink - Route planner runtime.
 * @returns Serialized planner status payload.
 */
function buildStatusResponse(nodelink) {
    const routePlanner = nodelink.routePlanner;
    const now = Date.now();
    const failingAddresses = [];
    for (const [ip, expiry] of routePlanner.bannedIps.entries()) {
        if (now < expiry) {
            const cooldown = routePlanner.config.bannedIpCooldown ?? 600000;
            const failingTimestamp = expiry - cooldown;
            failingAddresses.push({
                failingAddress: ip,
                failingTimestamp,
                failingTime: new Date(failingTimestamp).toString()
            });
        }
    }
    return {
        class: 'BalancingIpRoutePlanner',
        details: {
            ipBlock: {
                type: routePlanner.config.ipBlocks[0]?.includes(':')
                    ? 'Inet6Address'
                    : 'Inet4Address',
                size: routePlanner.ipBlocks.length
            },
            failingAddresses,
            strategy: routePlanner.config.strategy ?? 'RotateOnBan',
            currentAddress: null,
            blockIndex: null,
            ipIndex: null
        }
    };
}
/**
 * Handles `GET /routeplanner/status`.
 *
 * @param nodelink - Route planner runtime.
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @returns Nothing. The payload is written directly to the response.
 */
function getStatus(nodelink, req, res) {
    sendResponse(req, res, buildStatusResponse(nodelink), 200);
}
/**
 * Handles `POST /routeplanner/free/address`.
 *
 * @param nodelink - Route planner runtime.
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @returns Nothing. The response is written directly.
 */
function freeAddress(nodelink, req, res) {
    const payload = getFreeAddressPayload(req.body);
    if (!payload) {
        sendErrorResponse(req, res, 400, 'Bad Request', 'The address field is required.', req.url ?? '/v4/routeplanner/free/address');
        return;
    }
    nodelink.routePlanner.freeIP(payload.address);
    res.writeHead(204);
    res.end();
}
/**
 * Handles `POST /routeplanner/free/all`.
 *
 * @param nodelink - Route planner runtime.
 * @param _req - Incoming HTTP request. This route does not inspect it.
 * @param res - Outgoing HTTP response.
 * @returns Nothing. The response is written directly.
 */
function freeAll(nodelink, _req, res) {
    nodelink.routePlanner.freeAll();
    res.writeHead(204);
    res.end();
}
/**
 * Internal route table for route planner sub-routes.
 */
const routes = {
    '/v4/routeplanner/status': {
        GET: getStatus
    },
    '/v4/routeplanner/free/address': {
        POST: freeAddress
    },
    '/v4/routeplanner/free/all': {
        POST: freeAll
    }
};
/**
 * Handles requests for the route planner endpoint group.
 *
 * @param nodelink - Router-facing NodeLink runtime.
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @param _sendResponse - Unused route helper kept for handler signature
 * compatibility.
 * @param parsedUrl - Parsed request URL.
 * @returns Nothing. The response is written directly by the matched sub-route.
 */
function handler(nodelink, req, res, _sendResponse, parsedUrl) {
    const runtime = getRoutePlannerRuntime(nodelink);
    if (!runtime) {
        sendErrorResponse(req, res, 500, 'Internal Server Error', 'Route planner runtime contract is incomplete.', parsedUrl.pathname, true);
        return;
    }
    const route = routes[parsedUrl.pathname];
    const method = req.method === 'GET' || req.method === 'POST' ? req.method : null;
    if (route && method) {
        const methodHandler = route[method];
        if (methodHandler) {
            methodHandler(runtime, req, res);
            return;
        }
    }
    sendErrorResponse(req, res, 404, 'Not Found', 'The requested route planner endpoint was not found.', parsedUrl.pathname);
}
/**
 * Route module definition for the route planner endpoint group.
 */
const routePlannerRoute = {
    handler,
    methods: ['GET', 'POST']
};
export default routePlannerRoute;
