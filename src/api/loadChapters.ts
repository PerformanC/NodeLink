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
 * JSON-compatible value used by the chapters endpoint response payload.
 */
type ChapterResponseValue =
  | string
  | number
  | boolean
  | null
  | ChapterResponseValue[]
  | { [key: string]: ChapterResponseValue }

/**
 * Minimal source worker manager contract required by the chapters endpoint.
 */
interface ChaptersSourceWorkerManager {
  /**
   * Delegates the request to a source worker when available.
   *
   * @param req - Incoming HTTP request.
   * @param res - Outgoing HTTP response.
   * @param task - Delegated task name.
   * @param payload - Serialized task payload.
   * @returns `true` when the request has been delegated.
   */
  delegate: (
    req: ApiRequest,
    res: ApiResponse,
    task: 'loadChapters',
    payload: {
      decodedTrackInfo: EncodedTrackPayload['info']
    }
  ) => boolean
}

/**
 * Opaque worker reference used by the playback worker manager.
 */
type ChaptersWorkerReference = object

/**
 * Minimal playback worker manager contract required by the chapters endpoint.
 */
interface ChaptersWorkerManager {
  /**
   * Returns the best available worker for the request.
   *
   * @returns Worker reference used for command execution.
   */
  getBestWorker: () => ChaptersWorkerReference

  /**
   * Executes the chapter loading command on a playback worker.
   *
   * @param worker - Target worker reference.
   * @param task - Worker command name.
   * @param payload - Serialized command payload.
   * @returns Promise resolving to the serialized chapter response.
   */
  execute: (
    worker: ChaptersWorkerReference,
    task: 'loadChapters',
    payload: {
      decodedTrackInfo: EncodedTrackPayload['info']
    }
  ) => Promise<ChapterResponseValue>
}

/**
 * Minimal source manager contract required by the chapters endpoint.
 */
interface ChaptersSourceManager {
  /**
   * Loads chapters for a decoded track.
   *
   * @param track - Decoded track payload.
   * @returns Promise resolving to the serialized chapter payload.
   */
  getChapters: (
    track: Pick<EncodedTrackPayload, 'info'>
  ) => Promise<ChapterResponseValue>
}

/**
 * Runtime contract required by the chapters endpoint.
 */
interface LoadChaptersRuntime extends ApiNodelinkServer {
  /**
   * Optional source worker manager used for request delegation.
   */
  sourceWorkerManager: ChaptersSourceWorkerManager | null

  /**
   * Optional playback worker manager used in cluster mode.
   */
  workerManager: ChaptersWorkerManager | null

  /**
   * Local source manager used in single-process mode.
   */
  sources: ChaptersSourceManager
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
 * Builds a strongly typed runtime view for the chapters endpoint.
 *
 * @param nodelink - Router-facing runtime instance.
 * @returns Runtime compatible with the chapters endpoint, or `null` when the
 * required manager fields are unavailable.
 */
function getLoadChaptersRuntime(
  nodelink: ApiNodelinkServer
): LoadChaptersRuntime | null {
  const runtime = nodelink as ApiNodelinkServer & Partial<LoadChaptersRuntime>

  if (
    runtime.sourceWorkerManager === undefined ||
    runtime.workerManager === undefined ||
    !runtime.sources
  ) {
    return null
  }

  return runtime as LoadChaptersRuntime
}

/**
 * Determines whether the decoded track source supports chapter loading.
 *
 * @param decodedTrack - Decoded track payload.
 * @returns `true` when the source is YouTube or YouTube Music.
 */
function supportsChapters(decodedTrack: EncodedTrackPayload): boolean {
  return (
    decodedTrack.info.sourceName === 'youtube' ||
    decodedTrack.info.sourceName === 'ytmusic'
  )
}

/**
 * Handles requests for the chapters loading endpoint.
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
  const runtime = getLoadChaptersRuntime(nodelink)
  if (!runtime) {
    sendErrorResponse(
      req,
      res,
      500,
      'Internal Server Error',
      'Chapters runtime contract is incomplete.',
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

  try {
    const decodedTrack = decodeTrack(encodedTrack)
    if (!decodedTrack.info) {
      sendErrorResponse(
        req,
        res,
        400,
        'Bad Request',
        'The provided track is invalid.',
        parsedUrl.pathname
      )
      return
    }

    if (!supportsChapters(decodedTrack)) {
      sendResponse(req, res, [], 200)
      return
    }

    logger(
      'debug',
      'Chapters',
      `Request to load chapters for: ${decodedTrack.info.title}`
    )

    if (runtime.sourceWorkerManager) {
      const delegated = runtime.sourceWorkerManager.delegate(
        req,
        res,
        'loadChapters',
        {
          decodedTrackInfo: decodedTrack.info
        }
      )
      if (delegated) {
        return
      }
    }

    let chaptersData: ChapterResponseValue
    if (runtime.workerManager) {
      const worker = runtime.workerManager.getBestWorker()
      chaptersData = await runtime.workerManager.execute(
        worker,
        'loadChapters',
        {
          decodedTrackInfo: decodedTrack.info
        }
      )
    } else {
      chaptersData = await runtime.sources.getChapters(decodedTrack)
    }

    sendResponse(req, res, chaptersData, 200)
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Failed to load chapters.'
    logger('error', 'Chapters', 'Failed to load chapters:', error)
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
 * Route module definition for the chapters loading endpoint.
 */
const loadChaptersRoute: ApiRouteModule = {
  handler
}

export default loadChaptersRoute
