import type {
  ApiNodelinkServer,
  ApiRequest,
  ApiResponse,
  ApiRouteModule,
  ApiSendResponse
} from '../typings/api/api.types.ts'
import { sendErrorResponse, sendResponse } from '../utils.ts'

/**
 * Minimal route planner configuration required by the endpoint.
 */
interface RoutePlannerConfigRuntime {
  /**
   * Cooldown in milliseconds applied to banned IPs.
   */
  bannedIpCooldown?: number

  /**
   * Configured IP blocks in CIDR format.
   */
  ipBlocks: string[]

  /**
   * Active routing strategy name.
   */
  strategy?: string
}

/**
 * Minimal route planner manager contract required by the endpoint.
 */
interface RoutePlannerRuntimeManager {
  /**
   * Cooldown registry keyed by IP address.
   */
  bannedIps: Map<string, number>

  /**
   * Parsed IP blocks currently managed by the planner.
   */
  ipBlocks: Array<{
    /**
     * CIDR string for the block.
     */
    cidr: string
  }>

  /**
   * Planner configuration.
   */
  config: RoutePlannerConfigRuntime

  /**
   * Frees a single banned IP.
   *
   * @param address - Address to remove from the cooldown registry.
   * @returns Nothing. The cooldown entry is removed as a side effect.
   */
  freeIP: (address: string) => void

  /**
   * Clears all banned addresses and blocks.
   *
   * @returns Nothing. All cooldown entries are removed as a side effect.
   */
  freeAll: () => void
}

/**
 * Runtime contract required by the route planner endpoint.
 */
interface RoutePlannerRuntime extends ApiNodelinkServer {
  /**
   * Route planner manager available on the main runtime.
   */
  routePlanner: RoutePlannerRuntimeManager
}

/**
 * Request payload accepted by the free-address endpoint.
 */
interface FreeAddressPayload {
  /**
   * Banned IP address to remove from the cooldown registry.
   */
  address: string
}

/**
 * Serialized failing address entry returned by the status route.
 */
interface FailingAddressEntry {
  /**
   * Banned IP address.
   */
  failingAddress: string

  /**
   * Unix timestamp in milliseconds when the address first started failing.
   */
  failingTimestamp: number

  /**
   * Human-readable failing timestamp string.
   */
  failingTime: string
}

/**
 * Response payload returned by the route planner status endpoint.
 */
interface RoutePlannerStatusResponse {
  /**
   * Planner implementation name.
   */
  class: 'BalancingIpRoutePlanner'

  /**
   * Current planner details.
   */
  details: {
    /**
     * Active IP block family and count.
     */
    ipBlock: {
      /**
       * Java-style address family name kept for compatibility.
       */
      type: 'Inet4Address' | 'Inet6Address'

      /**
       * Number of configured IP blocks.
       */
      size: number
    }

    /**
     * Active failing addresses still under cooldown.
     */
    failingAddresses: FailingAddressEntry[]

    /**
     * Configured route planner strategy.
     */
    strategy: string

    /**
     * Reserved compatibility field for non-balancing planners.
     */
    currentAddress: null

    /**
     * Reserved compatibility field for non-balancing planners.
     */
    blockIndex: null

    /**
     * Reserved compatibility field for non-balancing planners.
     */
    ipIndex: null
  }
}

/**
 * Supported sub-route handlers inside the route planner endpoint module.
 */
type RoutePlannerMethodHandler = (
  nodelink: RoutePlannerRuntime,
  req: ApiRequest,
  res: ApiResponse
) => void

/**
 * Route planner sub-route table keyed by pathname and method.
 */
type RoutePlannerRouteTable = Record<
  string,
  Partial<Record<'GET' | 'POST', RoutePlannerMethodHandler>>
>

/**
 * Builds a strongly typed runtime view for the route planner endpoint.
 *
 * @param nodelink - Router-facing runtime instance.
 * @returns Runtime compatible with the route planner endpoint, or `null` when
 * the required manager field is unavailable.
 */
function getRoutePlannerRuntime(
  nodelink: ApiNodelinkServer
): RoutePlannerRuntime | null {
  const runtime = nodelink as ApiNodelinkServer & Partial<RoutePlannerRuntime>

  if (!runtime.routePlanner) {
    return null
  }

  return runtime as RoutePlannerRuntime
}

/**
 * Extracts and validates the free-address request body.
 *
 * @param body - Parsed request body.
 * @returns Valid payload object, or `null` when the payload is invalid.
 */
function getFreeAddressPayload(
  body: ApiRequest['body']
): FreeAddressPayload | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null
  }

  const payload = body as Partial<FreeAddressPayload>
  if (
    typeof payload.address !== 'string' ||
    payload.address.trim().length === 0
  ) {
    return null
  }

  return {
    address: payload.address
  }
}

/**
 * Builds the route planner status payload.
 *
 * @param nodelink - Route planner runtime.
 * @returns Serialized planner status payload.
 */
function buildStatusResponse(
  nodelink: RoutePlannerRuntime
): RoutePlannerStatusResponse {
  const routePlanner = nodelink.routePlanner
  const now = Date.now()
  const failingAddresses: FailingAddressEntry[] = []

  for (const [ip, expiry] of routePlanner.bannedIps.entries()) {
    if (now < expiry) {
      const cooldown = routePlanner.config.bannedIpCooldown ?? 600000
      const failingTimestamp = expiry - cooldown
      failingAddresses.push({
        failingAddress: ip,
        failingTimestamp,
        failingTime: new Date(failingTimestamp).toString()
      })
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
  }
}

/**
 * Handles `GET /routeplanner/status`.
 *
 * @param nodelink - Route planner runtime.
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @returns Nothing. The payload is written directly to the response.
 */
function getStatus(
  nodelink: RoutePlannerRuntime,
  req: ApiRequest,
  res: ApiResponse
): void {
  sendResponse(req, res, buildStatusResponse(nodelink), 200)
}

/**
 * Handles `POST /routeplanner/free/address`.
 *
 * @param nodelink - Route planner runtime.
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @returns Nothing. The response is written directly.
 */
function freeAddress(
  nodelink: RoutePlannerRuntime,
  req: ApiRequest,
  res: ApiResponse
): void {
  const payload = getFreeAddressPayload(req.body)

  if (!payload) {
    sendErrorResponse(
      req,
      res,
      400,
      'Bad Request',
      'The address field is required.',
      req.url ?? '/v4/routeplanner/free/address'
    )
    return
  }

  nodelink.routePlanner.freeIP(payload.address)
  res.writeHead(204)
  res.end()
}

/**
 * Handles `POST /routeplanner/free/all`.
 *
 * @param nodelink - Route planner runtime.
 * @param _req - Incoming HTTP request. This route does not inspect it.
 * @param res - Outgoing HTTP response.
 * @returns Nothing. The response is written directly.
 */
function freeAll(
  nodelink: RoutePlannerRuntime,
  _req: ApiRequest,
  res: ApiResponse
): void {
  nodelink.routePlanner.freeAll()
  res.writeHead(204)
  res.end()
}

/**
 * Internal route table for route planner sub-routes.
 */
const routes: RoutePlannerRouteTable = {
  '/v4/routeplanner/status': {
    GET: getStatus
  },
  '/v4/routeplanner/free/address': {
    POST: freeAddress
  },
  '/v4/routeplanner/free/all': {
    POST: freeAll
  }
}

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
function handler(
  nodelink: ApiNodelinkServer,
  req: ApiRequest,
  res: ApiResponse,
  _sendResponse: ApiSendResponse,
  parsedUrl: URL
): void {
  const runtime = getRoutePlannerRuntime(nodelink)
  if (!runtime) {
    sendErrorResponse(
      req,
      res,
      500,
      'Internal Server Error',
      'Route planner runtime contract is incomplete.',
      parsedUrl.pathname,
      true
    )
    return
  }

  const route = routes[parsedUrl.pathname]
  const method =
    req.method === 'GET' || req.method === 'POST' ? req.method : null

  if (route && method) {
    const methodHandler = route[method]
    if (methodHandler) {
      methodHandler(runtime, req, res)
      return
    }
  }

  sendErrorResponse(
    req,
    res,
    404,
    'Not Found',
    'The requested route planner endpoint was not found.',
    parsedUrl.pathname
  )
}

/**
 * Route module definition for the route planner endpoint group.
 */
const routePlannerRoute: ApiRouteModule = {
  handler,
  methods: ['GET', 'POST']
}

export default routePlannerRoute
