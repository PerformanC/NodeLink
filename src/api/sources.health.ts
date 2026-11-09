import type {
  ApiNodelinkServer,
  ApiRequest,
  ApiResponse,
  ApiRouteModule
} from '../typings/api/api.types.ts'
import type { SourceHealthApiResponse } from '../typings/sources/sourceHealth.types.ts'
import { sendResponse } from '../utils.ts'

/**
 * Extended server runtime exposing the SourceHealthManager instance.
 * @internal
 */
interface HealthRouteRuntime extends ApiNodelinkServer {
  sourceHealthManager?:
    | import('../managers/sourceHealthManager.ts').default
    | null
}

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
function handler(
  nodelink: ApiNodelinkServer,
  req: ApiRequest,
  res: ApiResponse
): void {
  const runtime = nodelink as HealthRouteRuntime
  const manager = runtime.sourceHealthManager

  if (!manager?.isEnabled) {
    const disabledResponse: SourceHealthApiResponse = {
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
      sources: {}
    }
    sendResponse(req, res, disabledResponse, 200)
    return
  }

  const responsePayload: SourceHealthApiResponse = {
    enabled: true,
    timestamp: Date.now(),
    summary: manager.getSummary(),
    sources: manager.getAllHealth()
  }

  sendResponse(req, res, responsePayload, 200)
}

/**
 * API route module configuration for source health diagnostics.
 */
const sourcesHealthRoute: ApiRouteModule = {
  methods: ['GET'],
  paths: ['/v4/sources/health'],
  handler
}

export default sourcesHealthRoute
