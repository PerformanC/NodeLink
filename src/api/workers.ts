import type {
  ApiNodelinkServer,
  ApiRequest,
  ApiResponse,
  ApiRouteModule,
  ApiSendResponse
} from '../typings/api/api.types.ts'
import type {
  WorkerMetricsEntry,
  WorkerMetricsPayload
} from '../typings/api/stats.types.ts'
import { sendErrorResponse, sendResponse } from '../utils.ts'

/**
 * Loopback addresses allowed to access the workers patch endpoint when
 * external patching is disabled.
 */
const LOOPBACKS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * Request payload accepted by the workers patch endpoint.
 */
interface WorkersPatchPayload {
  /**
   * Shared secret required to authorize worker termination.
   */
  code?: string

  /**
   * Cluster worker identifier used internally by NodeLink.
   */
  clusterId?: number | string

  /**
   * Public worker identifier exposed by the metrics payload.
   */
  id?: number | string

  /**
   * Operating-system process identifier for the target worker.
   */
  pid?: number | string
}

/**
 * Normalized workers endpoint configuration.
 */
interface WorkersEndpointConfig {
  /**
   * Whether `PATCH /workers` is enabled.
   */
  patchEnabled: boolean

  /**
   * Whether the patch endpoint accepts non-loopback requests.
   */
  allowExternalPatch: boolean

  /**
   * Shared secret required by the patch endpoint.
   */
  code: string
}

/**
 * Minimal worker process metadata required by the endpoint.
 */
interface WorkerProcessInfo {
  /**
   * Operating-system process identifier.
   */
  pid?: number
}

/**
 * Minimal worker shape required by the endpoint.
 */
interface WorkersManagerWorker {
  /**
   * Cluster worker identifier assigned by Node.js.
   */
  id: number

  /**
   * Child process information for the worker.
   */
  process?: WorkerProcessInfo
}

/**
 * Minimal worker manager contract required by the endpoint.
 */
interface WorkersManagerRuntime {
  /**
   * Active worker list.
   */
  workers: WorkersManagerWorker[]

  /**
   * Workers indexed by cluster identifier.
   */
  workersById: Map<number, WorkersManagerWorker>

  /**
   * Public worker identifiers keyed by cluster identifier.
   */
  workerUniqueId: Map<number, number>

  /**
   * Returns the metrics payload for all active workers.
   *
   * @returns Worker metrics keyed by public worker identifier.
   */
  getWorkerMetrics: () => WorkerMetricsPayload

  /**
   * Removes a worker from the cluster runtime.
   *
   * @param workerId - Cluster worker identifier.
   * @returns Nothing. The worker is removed as a side effect.
   */
  removeWorker: (workerId: number) => void
}

/**
 * Runtime contract required by the workers endpoint.
 */
interface WorkersRouteRuntime extends ApiNodelinkServer {
  /**
   * Worker manager instance when cluster mode is enabled.
   */
  workerManager: WorkersManagerRuntime | null
}

/**
 * Serialized worker payload returned by `GET /workers`.
 */
type WorkerListEntry = WorkerMetricsEntry & {
  /**
   * Public worker identifier used by the API payload.
   */
  id: number
}

/**
 * Creates a strongly typed runtime view for the workers endpoint.
 *
 * @param nodelink - Router-facing runtime instance.
 * @returns Runtime compatible with the workers endpoint, or `null` when the
 * required worker manager field is unavailable.
 */
function getWorkersRuntime(
  nodelink: ApiNodelinkServer
): WorkersRouteRuntime | null {
  const runtime = nodelink as ApiNodelinkServer & Partial<WorkersRouteRuntime>

  if (runtime.workerManager === undefined) {
    return null
  }

  return runtime as WorkersRouteRuntime
}

/**
 * Resolves and normalizes the workers endpoint configuration.
 *
 * @param nodelink - Workers endpoint runtime.
 * @returns Normalized configuration with explicit boolean flags and default
 * fallback secret.
 */
function getEndpointConfig(
  nodelink: WorkersRouteRuntime
): WorkersEndpointConfig {
  const endpoint = nodelink.options.cluster?.endpoint
  const code =
    typeof endpoint?.code === 'string' && endpoint.code.length > 0
      ? endpoint.code
      : 'CAPYBARA'

  return {
    patchEnabled: endpoint?.patchEnabled === true,
    allowExternalPatch: endpoint?.allowExternalPatch === true,
    code
  }
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
function getPatchPayload(
  body: ApiRequest['body']
): Partial<WorkersPatchPayload> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {}
  }

  return body as Partial<WorkersPatchPayload>
}

/**
 * Parses an integer-like worker identifier from a request field.
 *
 * @param value - Raw identifier value from the request payload.
 * @returns Normalized integer when the value is a valid whole number;
 * otherwise `null`.
 */
function normalizeNumber(value: number | string | undefined): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isInteger(parsed)) {
      return parsed
    }
  }

  return null
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
function resolveWorkerId(
  manager: WorkersManagerRuntime,
  payload: Partial<WorkersPatchPayload>
): number | null {
  const clusterId = normalizeNumber(payload.clusterId)
  if (clusterId !== null && manager.workersById.has(clusterId)) {
    return clusterId
  }

  const uniqueId = normalizeNumber(payload.id)
  if (uniqueId !== null) {
    for (const [workerId, workerUniqueId] of manager.workerUniqueId.entries()) {
      if (workerUniqueId === uniqueId) {
        return workerId
      }
    }
  }

  const pid = normalizeNumber(payload.pid)
  if (pid !== null) {
    const worker = manager.workers.find((entry) => entry.process?.pid === pid)
    if (worker) {
      return worker.id
    }
  }

  return null
}

/**
 * Serializes the worker metrics payload into the public response shape.
 *
 * @param metrics - Metrics payload keyed by public worker identifier.
 * @returns Array of serialized worker entries.
 */
function buildWorkerList(metrics: WorkerMetricsPayload): WorkerListEntry[] {
  return Object.entries(metrics).map(([id, data]) => ({
    id: Number(id),
    ...data
  }))
}

/**
 * Handles `GET /workers` requests.
 *
 * @param nodelink - Workers endpoint runtime.
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @returns Nothing. The payload is written directly to the response.
 */
function handleGet(
  nodelink: WorkersRouteRuntime,
  req: ApiRequest,
  res: ApiResponse
): void {
  const manager = nodelink.workerManager
  if (!manager) {
    sendResponse(req, res, [], 200)
    return
  }

  sendResponse(req, res, buildWorkerList(manager.getWorkerMetrics()), 200)
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
function handlePatch(
  nodelink: WorkersRouteRuntime,
  req: ApiRequest,
  res: ApiResponse,
  parsedUrl: URL
): void {
  const manager = nodelink.workerManager
  if (!manager) {
    sendErrorResponse(
      req,
      res,
      409,
      'Conflict',
      'Cluster workers are not enabled.',
      parsedUrl.pathname
    )
    return
  }

  const endpointConfig = getEndpointConfig(nodelink)
  if (!endpointConfig.patchEnabled) {
    sendErrorResponse(
      req,
      res,
      403,
      'Forbidden',
      'Workers patch endpoint is disabled.',
      parsedUrl.pathname
    )
    return
  }

  const remoteAddress = req.socket?.remoteAddress ?? ''
  if (!endpointConfig.allowExternalPatch && !LOOPBACKS.has(remoteAddress)) {
    sendErrorResponse(
      req,
      res,
      403,
      'Forbidden',
      'External access to the workers patch endpoint is blocked.',
      parsedUrl.pathname
    )
    return
  }

  const payload = getPatchPayload(req.body)
  if (payload.code !== endpointConfig.code) {
    sendErrorResponse(
      req,
      res,
      403,
      'Forbidden',
      'Invalid workers patch code.',
      parsedUrl.pathname
    )
    return
  }

  const workerId = resolveWorkerId(manager, payload)
  if (workerId === null) {
    sendErrorResponse(
      req,
      res,
      400,
      'Bad Request',
      'Worker identifier is required.',
      parsedUrl.pathname
    )
    return
  }

  const worker = manager.workersById.get(workerId)
  if (!worker) {
    sendErrorResponse(
      req,
      res,
      404,
      'Not Found',
      'Worker not found.',
      parsedUrl.pathname
    )
    return
  }

  const uniqueId = manager.workerUniqueId.get(workerId) ?? workerId
  const pid = worker.process?.pid ?? null

  manager.removeWorker(workerId)

  sendResponse(
    req,
    res,
    {
      killed: true,
      id: uniqueId,
      clusterId: workerId,
      pid
    },
    200
  )
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
function handler(
  nodelink: ApiNodelinkServer,
  req: ApiRequest,
  res: ApiResponse,
  _sendResponse: ApiSendResponse,
  parsedUrl: URL
): void {
  const runtime = getWorkersRuntime(nodelink)

  if (!runtime) {
    sendErrorResponse(
      req,
      res,
      500,
      'Internal Server Error',
      'Workers runtime contract is incomplete.',
      parsedUrl.pathname
    )
    return
  }

  if (req.method === 'GET') {
    handleGet(runtime, req, res)
    return
  }

  if (req.method === 'PATCH') {
    handlePatch(runtime, req, res, parsedUrl)
    return
  }

  sendErrorResponse(
    req,
    res,
    405,
    'Method Not Allowed',
    'Method must be GET or PATCH.',
    parsedUrl.pathname
  )
}

/**
 * Route module definition for the workers endpoint.
 */
const workersRoute: ApiRouteModule = {
  handler,
  methods: ['GET', 'PATCH']
}

export default workersRoute
