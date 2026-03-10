import type {
  ApiNodelinkServer,
  ApiRequest,
  ApiResponse,
  ApiRouteModule
} from '../typings/api/api.types.ts'

/**
 * Minimal Prometheus registry contract required by the metrics endpoint.
 */
interface MetricsRegistry {
  /**
   * Response content type exposed by the registry.
   */
  contentType: string

  /**
   * Serializes the full Prometheus exposition payload.
   *
   * @returns Promise resolving to the metrics document.
   */
  metrics: () => Promise<string>
}

/**
 * Stats manager contract required by the metrics endpoint.
 */
type MetricsStatsManager = ApiNodelinkServer['statsManager'] & {
  /**
   * Prometheus registry initialized when metrics are enabled.
   */
  promRegister?: MetricsRegistry
}

/**
 * Runtime contract required by the metrics endpoint.
 */
interface MetricsRouteRuntime extends ApiNodelinkServer {
  /**
   * Stats manager exposing the optional Prometheus registry.
   */
  statsManager: MetricsStatsManager
}

/**
 * Builds a strongly typed runtime view for the metrics endpoint.
 *
 * @param nodelink - Router-facing runtime instance.
 * @returns Runtime compatible with the metrics endpoint.
 */
function getMetricsRuntime(nodelink: ApiNodelinkServer): MetricsRouteRuntime {
  return nodelink as MetricsRouteRuntime
}

/**
 * Handles `GET /metrics` requests.
 *
 * When Prometheus metrics are disabled, the route returns HTTP 503 with a
 * plain-text explanation. Otherwise it writes the registry exposition format
 * returned by `prom-client`.
 *
 * @param nodelink - Router-facing NodeLink runtime.
 * @param _req - Incoming HTTP request. This endpoint does not inspect it.
 * @param res - Outgoing HTTP response.
 * @returns Promise that resolves once the metrics payload has been written.
 */
async function handler(
  nodelink: ApiNodelinkServer,
  _req: ApiRequest,
  res: ApiResponse
): Promise<void> {
  const runtime = getMetricsRuntime(nodelink)
  const register = runtime.statsManager.promRegister

  if (!register) {
    res.writeHead(503, { 'Content-Type': 'text/plain' })
    res.end('Metrics are disabled')
    return
  }

  res.writeHead(200, { 'Content-Type': register.contentType })
  res.end(await register.metrics())
}

/**
 * Route module definition for the Prometheus metrics endpoint.
 */
const metricsRoute: ApiRouteModule = {
  handler
}

export default metricsRoute
