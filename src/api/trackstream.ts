import type {
  ApiNodelinkServer,
  ApiRequest,
  ApiResponse,
  ApiRouteModule,
  ApiSendResponse
} from '../typings/api/api.types.ts'
import type { EncodedTrackPayload } from '../typings/utils.types.ts'
import { decodeTrack, logger, sendErrorResponse } from '../utils.ts'

/**
 * JSON-compatible value used by the track stream endpoint response payload.
 */
type TrackStreamResponseValue =
  | string
  | number
  | boolean
  | null
  | TrackStreamResponseValue[]
  | { [key: string]: TrackStreamResponseValue }

/**
 * Track URL payload returned by the stream resolution endpoint.
 */
interface TrackUrlResponse {
  /**
   * Optional worker/source error descriptor.
   */
  exception?: {
    /**
     * Human-readable error message.
     */
    message: string
  }

  /**
   * Additional response fields returned by the source subsystem.
   */
  [key: string]: TrackStreamResponseValue | { message: string } | undefined
}

/**
 * Opaque worker reference used by the playback worker manager.
 */
type TrackStreamWorkerReference = object

/**
 * Minimal playback worker manager contract required by the track stream
 * endpoint.
 */
interface TrackStreamWorkerManager {
  /**
   * Returns the best available worker for the request.
   *
   * @returns Worker reference used for command execution.
   */
  getBestWorker: () => TrackStreamWorkerReference

  /**
   * Executes the track URL resolution command on a playback worker.
   *
   * @param worker - Target worker reference.
   * @param task - Worker command name.
   * @param payload - Serialized command payload.
   * @returns Promise resolving to the track URL payload.
   */
  execute: (
    worker: TrackStreamWorkerReference,
    task: 'getTrackUrl',
    payload: {
      decodedTrackInfo: EncodedTrackPayload['info']
      itag: number | null
    }
  ) => Promise<TrackUrlResponse>
}

/**
 * Minimal source manager contract required by the track stream endpoint.
 */
interface TrackStreamSourceManager {
  /**
   * Resolves a playable track URL.
   *
   * @param trackInfo - Decoded track information.
   * @param itag - Optional format identifier.
   * @returns Promise resolving to the track URL payload.
   */
  getTrackUrl: (
    trackInfo: EncodedTrackPayload['info'],
    itag: number | null
  ) => Promise<TrackUrlResponse>
}

/**
 * Runtime contract required by the track stream endpoint.
 */
interface TrackStreamRuntime extends ApiNodelinkServer {
  /**
   * Optional playback worker manager used in cluster mode.
   */
  workerManager: TrackStreamWorkerManager | null

  /**
   * Local source manager used in single-process mode.
   */
  sources: TrackStreamSourceManager
}

/**
 * Default validation message used when the `encodedTrack` query parameter is
 * missing or empty.
 */
const MISSING_ENCODED_TRACK_MESSAGE = 'Missing encodedTrack parameter.'

/**
 * Reads and normalizes the `encodedTrack` query string parameter.
 *
 * @param parsedUrl - Parsed request URL.
 * @returns Normalized encoded track string, or `null` when the parameter is
 * missing or empty.
 */
function getEncodedTrackFromQuery(parsedUrl: URL): string | null {
  const encodedTrack = parsedUrl.searchParams.get('encodedTrack')?.trim()
  if (!encodedTrack) {
    return null
  }

  return encodedTrack.replace(/ /g, '+')
}

/**
 * Parses the optional `itag` query parameter.
 *
 * @param parsedUrl - Parsed request URL.
 * @returns Parsed numeric itag, `null` when absent, or `false` when invalid.
 */
function getItagFromQuery(parsedUrl: URL): number | null | false {
  const itagParam = parsedUrl.searchParams.get('itag')
  if (!itagParam) {
    return null
  }

  const itag = Number(itagParam)
  return Number.isFinite(itag) ? itag : false
}

/**
 * Builds a strongly typed runtime view for the track stream endpoint.
 *
 * @param nodelink - Router-facing runtime instance.
 * @returns Runtime compatible with the track stream endpoint, or `null` when
 * the required manager fields are unavailable.
 */
function getTrackStreamRuntime(
  nodelink: ApiNodelinkServer
): TrackStreamRuntime | null {
  const runtime = nodelink as ApiNodelinkServer & Partial<TrackStreamRuntime>

  if (runtime.workerManager === undefined || !runtime.sources) {
    return null
  }

  return runtime as TrackStreamRuntime
}

/**
 * Handles requests for the track stream resolution endpoint.
 *
 * @param nodelink - Router-facing NodeLink runtime.
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @param sendResponse - Helper responsible for JSON serialization and headers.
 * @param parsedUrl - Parsed request URL.
 * @returns Promise that resolves once the response has been written.
 */
async function handler(
  nodelink: ApiNodelinkServer,
  req: ApiRequest,
  res: ApiResponse,
  sendResponse: ApiSendResponse,
  parsedUrl: URL
): Promise<void> {
  if (!nodelink.options.enableTrackStreamEndpoint) {
    sendErrorResponse(
      req,
      res,
      404,
      'Not Found',
      'The requested route was not found.',
      parsedUrl.pathname
    )
    return
  }

  const runtime = getTrackStreamRuntime(nodelink)
  if (!runtime) {
    sendErrorResponse(
      req,
      res,
      500,
      'Internal Server Error',
      'Track stream runtime contract is incomplete.',
      parsedUrl.pathname,
      true
    )
    return
  }

  const encodedTrack = getEncodedTrackFromQuery(parsedUrl)
  if (!encodedTrack) {
    sendErrorResponse(
      req,
      res,
      400,
      'Bad Request',
      MISSING_ENCODED_TRACK_MESSAGE,
      parsedUrl.pathname
    )
    return
  }

  const itag = getItagFromQuery(parsedUrl)
  if (itag === false) {
    sendErrorResponse(
      req,
      res,
      400,
      'Bad Request',
      'itag parameter must be a valid number.',
      parsedUrl.pathname,
      true
    )
    return
  }

  try {
    const decodedTrack = decodeTrack(encodedTrack)

    let urlResult: TrackUrlResponse
    if (runtime.workerManager) {
      const worker = runtime.workerManager.getBestWorker()
      urlResult = await runtime.workerManager.execute(worker, 'getTrackUrl', {
        decodedTrackInfo: decodedTrack.info,
        itag
      })
    } else {
      urlResult = await runtime.sources.getTrackUrl(decodedTrack.info, itag)
    }

    if (urlResult.exception) {
      sendErrorResponse(
        req,
        res,
        500,
        'Internal Server Error',
        urlResult.exception.message,
        parsedUrl.pathname
      )
      return
    }

    sendResponse(req, res, urlResult, 200)
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Failed to get track stream'
    logger(
      'error',
      'TrackStream',
      `Failed to get track stream for ${encodedTrack}:`,
      error
    )
    sendErrorResponse(
      req,
      res,
      500,
      'Internal Server Error',
      errorMessage,
      parsedUrl.pathname,
      true
    )
  }
}

/**
 * Route module definition for the track stream resolution endpoint.
 */
const trackStreamRoute: ApiRouteModule = {
  handler
}

export default trackStreamRoute
