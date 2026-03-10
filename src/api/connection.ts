import type {
  ApiNodelinkServer,
  ApiRequest,
  ApiResponse,
  ApiRouteModule
} from '../typings/api/api.types.ts'
import type {
  ConnectionMetrics,
  ConnectionStatus
} from '../typings/voice/connection.types.ts'
import { sendResponse } from '../utils.ts'

/**
 * Minimal connection manager contract required by the endpoint.
 */
interface ConnectionManagerRuntime {
  /**
   * Current connection quality classification.
   */
  status: ConnectionStatus

  /**
   * Latest connection metrics snapshot.
   */
  metrics: ConnectionMetrics
}

/**
 * Runtime contract required by the connection endpoint.
 */
interface ConnectionRouteRuntime extends ApiNodelinkServer {
  /**
   * Connection manager instance when available in the current process.
   */
  connectionManager: ConnectionManagerRuntime | null
}

/**
 * Response payload emitted when the connection manager is active.
 */
interface ConnectionEnabledResponse {
  /**
   * Current connection quality classification.
   */
  status: ConnectionStatus

  /**
   * Latest connection metrics snapshot.
   */
  metrics: ConnectionMetrics
}

/**
 * Response payload emitted when the connection manager is unavailable.
 */
interface ConnectionDisabledResponse {
  /**
   * Sentinel status used to indicate the endpoint is inactive in this process.
   */
  status: 'disabled'

  /**
   * Metrics are absent when the manager is unavailable.
   */
  metrics: null

  /**
   * Stable machine-readable reason for the disabled state.
   */
  reason: 'connection_manager_unavailable_in_this_process'
}

/**
 * Creates a strongly typed runtime view for the connection endpoint.
 *
 * @param nodelink - Router-facing runtime instance.
 * @returns Runtime compatible with the connection endpoint, or `null` when the
 * connection manager field is unavailable.
 */
function getConnectionRuntime(
  nodelink: ApiNodelinkServer
): ConnectionRouteRuntime | null {
  const runtime = nodelink as ApiNodelinkServer &
    Partial<ConnectionRouteRuntime>

  if (runtime.connectionManager === undefined) {
    return null
  }

  return runtime as ConnectionRouteRuntime
}

/**
 * Builds the disabled response payload used outside the primary process.
 *
 * @returns Stable disabled-state payload for the connection endpoint.
 */
function buildDisabledResponse(): ConnectionDisabledResponse {
  return {
    status: 'disabled',
    metrics: null,
    reason: 'connection_manager_unavailable_in_this_process'
  }
}

/**
 * Builds the active response payload from the connection manager state.
 *
 * @param connectionManager - Active connection manager instance.
 * @returns Serialized status and metrics payload.
 */
function buildEnabledResponse(
  connectionManager: ConnectionManagerRuntime
): ConnectionEnabledResponse {
  return {
    status: connectionManager.status,
    metrics: connectionManager.metrics
  }
}

/**
 * Handles requests for the connection diagnostics endpoint.
 *
 * @param nodelink - Router-facing NodeLink runtime.
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @returns Nothing. The payload is written directly to the response.
 */
function handler(
  nodelink: ApiNodelinkServer,
  req: ApiRequest,
  res: ApiResponse
): void {
  const runtime = getConnectionRuntime(nodelink)

  if (!runtime) {
    sendResponse(
      req,
      res,
      {
        timestamp: Date.now(),
        status: 500,
        error: 'Internal Server Error',
        message: 'Connection runtime contract is incomplete.',
        path: req.url ?? '/v4/connection'
      },
      500
    )
    return
  }

  if (!runtime.connectionManager) {
    sendResponse(req, res, buildDisabledResponse(), 200)
    return
  }

  sendResponse(req, res, buildEnabledResponse(runtime.connectionManager), 200)
}

/**
 * Route module definition for the connection diagnostics endpoint.
 */
const connectionRoute: ApiRouteModule = {
  handler
}

export default connectionRoute
