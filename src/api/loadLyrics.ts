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
 * JSON-compatible value used by the lyrics endpoint response payload.
 */
type LyricsResponseValue =
  | string
  | number
  | boolean
  | null
  | LyricsResponseValue[]
  | { [key: string]: LyricsResponseValue }

/**
 * Minimal source worker manager contract required by the lyrics endpoint.
 */
interface LyricsSourceWorkerManager {
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
    task: 'loadLyrics',
    payload: {
      decodedTrackInfo: EncodedTrackPayload['info']
      language?: string
    }
  ) => boolean
}

/**
 * Opaque worker reference used by the playback worker manager.
 */
type LyricsWorkerReference = object

/**
 * Minimal playback worker manager contract required by the lyrics endpoint.
 */
interface LyricsWorkerManager {
  /**
   * Returns the best available worker for the request.
   *
   * @returns Worker reference used for command execution.
   */
  getBestWorker: () => LyricsWorkerReference

  /**
   * Executes the lyrics loading command on a playback worker.
   *
   * @param worker - Target worker reference.
   * @param task - Worker command name.
   * @param payload - Serialized command payload.
   * @returns Promise resolving to the serialized lyrics response.
   */
  execute: (
    worker: LyricsWorkerReference,
    task: 'loadLyrics',
    payload: {
      decodedTrackInfo: EncodedTrackPayload['info']
      language?: string
    }
  ) => Promise<LyricsResponseValue>
}

/**
 * Minimal lyrics manager contract required by the endpoint.
 */
interface LyricsManagerRuntime {
  /**
   * Loads lyrics for a decoded track.
   *
   * @param track - Decoded track payload.
   * @param language - Optional target language.
   * @returns Promise resolving to the serialized lyrics response.
   */
  loadLyrics: (
    track: Pick<EncodedTrackPayload, 'info'>,
    language?: string
  ) => Promise<LyricsResponseValue>
}

/**
 * Runtime contract required by the lyrics endpoint.
 */
interface LoadLyricsRuntime extends ApiNodelinkServer {
  /**
   * Optional source worker manager used for request delegation.
   */
  sourceWorkerManager: LyricsSourceWorkerManager | null

  /**
   * Optional playback worker manager used in cluster mode.
   */
  workerManager: LyricsWorkerManager | null

  /**
   * Local lyrics manager used in single-process mode.
   */
  lyrics: LyricsManagerRuntime
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
 * Reads the optional `lang` query string parameter.
 *
 * @param parsedUrl - Parsed request URL.
 * @returns Non-empty language string, or `undefined` when absent.
 */
function getLanguageFromQuery(parsedUrl: URL): string | undefined {
  const language = parsedUrl.searchParams.get('lang')?.trim()
  return language ? language : undefined
}

/**
 * Builds a strongly typed runtime view for the lyrics endpoint.
 *
 * @param nodelink - Router-facing runtime instance.
 * @returns Runtime compatible with the lyrics endpoint, or `null` when the
 * required manager fields are unavailable.
 */
function getLoadLyricsRuntime(
  nodelink: ApiNodelinkServer
): LoadLyricsRuntime | null {
  const runtime = nodelink as ApiNodelinkServer & Partial<LoadLyricsRuntime>

  if (
    runtime.sourceWorkerManager === undefined ||
    runtime.workerManager === undefined ||
    !runtime.lyrics
  ) {
    return null
  }

  return runtime as LoadLyricsRuntime
}

/**
 * Handles requests for the lyrics loading endpoint.
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
  const runtime = getLoadLyricsRuntime(nodelink)
  if (!runtime) {
    sendErrorResponse(
      req,
      res,
      500,
      'Internal Server Error',
      'Lyrics runtime contract is incomplete.',
      parsedUrl.pathname,
      true
    )
    return
  }

  const encodedTrack = getEncodedTrackFromQuery(parsedUrl)
  const language = getLanguageFromQuery(parsedUrl)

  if (!encodedTrack) {
    logger('warn', 'Lyrics', MISSING_ENCODED_TRACK_MESSAGE)
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

    logger(
      'debug',
      'Lyrics',
      `Request to load lyrics for: ${decodedTrack.info.title}${language ? ` (Lang: ${language})` : ''}`
    )

    if (runtime.sourceWorkerManager) {
      const delegated = runtime.sourceWorkerManager.delegate(
        req,
        res,
        'loadLyrics',
        {
          decodedTrackInfo: decodedTrack.info,
          language
        }
      )
      if (delegated) {
        return
      }
    }

    let lyricsData: LyricsResponseValue
    if (runtime.workerManager) {
      const worker = runtime.workerManager.getBestWorker()
      lyricsData = await runtime.workerManager.execute(worker, 'loadLyrics', {
        decodedTrackInfo: decodedTrack.info,
        language
      })
    } else {
      lyricsData = await runtime.lyrics.loadLyrics(decodedTrack, language)
    }

    sendResponse(req, res, lyricsData, 200)
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Failed to load lyrics.'
    logger('error', 'Lyrics', 'Failed to load lyrics:', error)
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
 * Route module definition for the lyrics loading endpoint.
 */
const loadLyricsRoute: ApiRouteModule = {
  handler
}

export default loadLyricsRoute
