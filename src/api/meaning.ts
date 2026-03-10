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
 * JSON-compatible value used by the meaning endpoint response payload.
 */
type MeaningResponseValue =
  | string
  | number
  | boolean
  | null
  | MeaningResponseValue[]
  | { [key: string]: MeaningResponseValue }

/**
 * Error payload returned when meaning resolution fails.
 */
interface MeaningErrorData {
  /**
   * Human-readable error message.
   */
  message?: string

  /**
   * Optional severity label emitted by providers.
   */
  severity?: string

  /**
   * Additional provider-specific fields.
   */
  [key: string]: MeaningResponseValue | undefined
}

/**
 * Unified meaning payload returned by the endpoint.
 */
type MeaningRouteResult =
  | {
      /**
       * Successful meaning load result.
       */
      loadType: 'meaning'
      /**
       * Serialized provider payload.
       */
      data: MeaningResponseValue
    }
  | {
      /**
       * Empty result emitted when no meaning source matches.
       */
      loadType: 'empty'
      /**
       * Empty payload object.
       */
      data: Record<string, never>
    }
  | {
      /**
       * Error result emitted by the meaning subsystem.
       */
      loadType: 'error'
      /**
       * Error payload including an optional provider message.
       */
      data: MeaningErrorData
    }

/**
 * Minimal source worker manager contract required by the meaning endpoint.
 */
interface MeaningSourceWorkerManager {
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
    task: 'loadMeaning',
    payload: {
      decodedTrackInfo: EncodedTrackPayload['info']
      language: string
    }
  ) => boolean
}

/**
 * Opaque worker reference used by the playback worker manager.
 */
type MeaningWorkerReference = object

/**
 * Minimal playback worker manager contract required by the meaning endpoint.
 */
interface MeaningWorkerManager {
  /**
   * Returns the best available worker for the request.
   *
   * @returns Worker reference used for command execution.
   */
  getBestWorker: () => MeaningWorkerReference

  /**
   * Executes the meaning loading command on a playback worker.
   *
   * @param worker - Target worker reference.
   * @param task - Worker command name.
   * @param payload - Serialized command payload.
   * @returns Promise resolving to the serialized meaning response.
   */
  execute: (
    worker: MeaningWorkerReference,
    task: 'loadMeaning',
    payload: {
      decodedTrackInfo: EncodedTrackPayload['info']
      language: string
    }
  ) => Promise<MeaningRouteResult>
}

/**
 * Minimal meanings manager contract required by the endpoint.
 */
interface MeaningsManagerRuntime {
  /**
   * Loads meaning data for a decoded track.
   *
   * @param track - Decoded track payload.
   * @param language - Target language.
   * @returns Promise resolving to the serialized meaning response.
   */
  loadMeaning: (
    track: Pick<EncodedTrackPayload, 'info'>,
    language: string
  ) => Promise<MeaningRouteResult>
}

/**
 * Runtime contract required by the meaning endpoint.
 */
interface MeaningRouteRuntime extends ApiNodelinkServer {
  /**
   * Optional source worker manager used for request delegation.
   */
  sourceWorkerManager: MeaningSourceWorkerManager | null

  /**
   * Optional playback worker manager used in cluster mode.
   */
  workerManager: MeaningWorkerManager | null

  /**
   * Optional local meanings manager used in single-process mode.
   */
  meanings: MeaningsManagerRuntime | null
}

/**
 * Default validation message used when the `encodedTrack` query parameter is
 * missing or empty.
 */
const MISSING_ENCODED_TRACK_MESSAGE = 'encodedTrack parameter is required.'

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
 * Reads the target language from the query string.
 *
 * The historical schema declared a default of `en`, so the route now applies
 * that default explicitly instead of depending on validator side effects.
 *
 * @param parsedUrl - Parsed request URL.
 * @returns Target language for the meaning request.
 */
function getLanguageFromQuery(parsedUrl: URL): string {
  const language = parsedUrl.searchParams.get('lang')?.trim()
  return language ? language : 'en'
}

/**
 * Builds a strongly typed runtime view for the meaning endpoint.
 *
 * @param nodelink - Router-facing runtime instance.
 * @returns Runtime compatible with the meaning endpoint, or `null` when the
 * required manager fields are unavailable.
 */
function getMeaningRuntime(
  nodelink: ApiNodelinkServer
): MeaningRouteRuntime | null {
  const runtime = nodelink as ApiNodelinkServer & Partial<MeaningRouteRuntime>

  if (
    runtime.sourceWorkerManager === undefined ||
    runtime.workerManager === undefined ||
    runtime.meanings === undefined
  ) {
    return null
  }

  return runtime as MeaningRouteRuntime
}

/**
 * Handles requests for the meaning loading endpoint.
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
  const runtime = getMeaningRuntime(nodelink)
  if (!runtime) {
    sendErrorResponse(
      req,
      res,
      500,
      'Internal Server Error',
      'Meaning runtime contract is incomplete.',
      parsedUrl.pathname,
      true
    )
    return
  }

  const encodedTrack = getEncodedTrackFromQuery(parsedUrl)
  if (!encodedTrack) {
    logger('warn', 'Meaning', MISSING_ENCODED_TRACK_MESSAGE)
    sendErrorResponse(
      req,
      res,
      400,
      'missing encodedTrack parameter',
      MISSING_ENCODED_TRACK_MESSAGE,
      parsedUrl.pathname,
      true
    )
    return
  }

  const targetLanguage = getLanguageFromQuery(parsedUrl)

  let decodedTrack: EncodedTrackPayload
  try {
    decodedTrack = decodeTrack(encodedTrack)
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Invalid encoded track'
    logger('warn', 'Meaning', `Invalid encoded track: ${errorMessage}`)
    sendErrorResponse(
      req,
      res,
      400,
      'invalid encodedTrack',
      errorMessage,
      parsedUrl.pathname,
      true
    )
    return
  }

  try {
    if (runtime.sourceWorkerManager) {
      const delegated = runtime.sourceWorkerManager.delegate(
        req,
        res,
        'loadMeaning',
        {
          decodedTrackInfo: decodedTrack.info,
          language: targetLanguage
        }
      )
      if (delegated) {
        return
      }
    }

    let meaning: MeaningRouteResult
    if (runtime.workerManager) {
      const worker = runtime.workerManager.getBestWorker()
      meaning = await runtime.workerManager.execute(worker, 'loadMeaning', {
        decodedTrackInfo: decodedTrack.info,
        language: targetLanguage
      })
    } else if (runtime.meanings?.loadMeaning) {
      meaning = await runtime.meanings.loadMeaning(decodedTrack, targetLanguage)
    } else {
      logger('error', 'Meaning', 'Meaning sources are not available.')
      sendErrorResponse(
        req,
        res,
        503,
        'meaning sources unavailable',
        'Meaning sources are not available.',
        parsedUrl.pathname,
        true
      )
      return
    }

    if (meaning.loadType === 'error') {
      sendErrorResponse(
        req,
        res,
        500,
        'failed to load meaning',
        meaning.data.message ?? 'Failed to load meaning',
        parsedUrl.pathname,
        true
      )
      return
    }

    sendResponse(req, res, meaning, 200)
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Failed to load meaning'
    logger('error', 'Meaning', `Failed to load meaning: ${errorMessage}`)
    sendErrorResponse(
      req,
      res,
      500,
      'failed to load meaning',
      errorMessage,
      parsedUrl.pathname,
      true
    )
  }
}

/**
 * Route module definition for the meaning loading endpoint.
 */
const meaningRoute: ApiRouteModule = {
  handler
}

export default meaningRoute
