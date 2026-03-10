import type {
  ApiNodelinkServer,
  ApiRequest,
  ApiResponse,
  ApiRouteModule,
  ApiSendResponse
} from '../typings/api/api.types.ts'
import type { Session } from '../typings/index.types.ts'
import { logger, sendErrorResponse } from '../utils.ts'

/**
 * Runtime player manager contract required by the lyrics subscription route.
 */
interface LyricsSubscriptionPlayerManager {
  /**
   * Subscribes a player to lyrics updates.
   *
   * @param guildId - Target guild identifier.
   * @param skipTrackSource - Whether the current track source should be skipped.
   * @returns Promise that resolves when the subscription has been applied.
   */
  subscribeLyrics: (
    guildId: string,
    skipTrackSource: boolean | undefined
  ) => Promise<void>

  /**
   * Unsubscribes a player from lyrics updates.
   *
   * @param guildId - Target guild identifier.
   * @returns Promise that resolves when the subscription has been removed.
   */
  unsubscribeLyrics: (guildId: string) => Promise<void>
}

/**
 * Session contract required by the lyrics subscription route.
 */
type LyricsSubscriptionSession = Omit<Session, 'players'> & {
  /**
   * Player manager instance for the session.
   */
  players: LyricsSubscriptionPlayerManager
}

/**
 * Runtime contract required by the lyrics subscription route.
 */
interface LyricsSubscriptionRuntime extends ApiNodelinkServer {
  /**
   * Session manager accessor.
   */
  sessions: {
    /**
     * Retrieves a session from the active or resumable pools.
     *
     * @param id - Session identifier.
     * @returns Matching session or `undefined`.
     */
    get: (id: string) => LyricsSubscriptionSession | undefined
  }
}

/**
 * Path parameters extracted from the dynamic route.
 */
interface LyricsSubscriptionPathParams {
  /**
   * Session identifier.
   */
  sessionId: string

  /**
   * Guild identifier.
   */
  guildId: string
}

/**
 * Builds a strongly typed runtime view for the lyrics subscription route.
 *
 * @param nodelink - Router-facing runtime instance.
 * @returns Runtime compatible with the route, or `null` when the required
 * session manager field is unavailable.
 */
function getLyricsSubscriptionRuntime(
  nodelink: ApiNodelinkServer
): LyricsSubscriptionRuntime | null {
  const runtime = nodelink as ApiNodelinkServer &
    Partial<LyricsSubscriptionRuntime>

  if (!runtime.sessions || typeof runtime.sessions.get !== 'function') {
    return null
  }

  return runtime as LyricsSubscriptionRuntime
}

/**
 * Extracts and validates the path parameters used by the route.
 *
 * @param parsedUrl - Parsed request URL.
 * @returns Validated path parameters, or `null` when validation fails.
 */
function getPathParams(parsedUrl: URL): LyricsSubscriptionPathParams | null {
  const pathParts = parsedUrl.pathname.split('/')
  const sessionId = pathParts[3]
  const guildId = pathParts[5]

  if (!sessionId || !guildId) {
    return null
  }

  if (!/^\d{17,20}$/.test(guildId)) {
    return null
  }

  return {
    sessionId,
    guildId
  }
}

/**
 * Parses the optional `skipTrackSource` query parameter.
 *
 * @param parsedUrl - Parsed request URL.
 * @returns Parsed boolean value, or `null` when the parameter is invalid.
 */
function getSkipTrackSource(parsedUrl: URL): boolean | undefined | null {
  const rawValue = parsedUrl.searchParams.get('skipTrackSource')
  if (rawValue === null) {
    return undefined
  }

  if (rawValue === 'true') {
    return true
  }

  if (rawValue === 'false') {
    return false
  }

  return null
}

/**
 * Handles requests for the lyrics subscription route.
 *
 * Supports:
 * - `POST` to subscribe the player to lyrics updates
 * - `DELETE` to unsubscribe the player from lyrics updates
 *
 * @param nodelink - Router-facing NodeLink runtime.
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @param _sendResponse - Unused route helper kept for handler signature
 * compatibility.
 * @param parsedUrl - Parsed request URL.
 * @returns Promise that resolves once the response has been written.
 */
async function handler(
  nodelink: ApiNodelinkServer,
  req: ApiRequest,
  res: ApiResponse,
  _sendResponse: ApiSendResponse,
  parsedUrl: URL
): Promise<void> {
  const runtime = getLyricsSubscriptionRuntime(nodelink)
  if (!runtime) {
    sendErrorResponse(
      req,
      res,
      500,
      'Internal Server Error',
      'Lyrics subscription runtime contract is incomplete.',
      parsedUrl.pathname,
      true
    )
    return
  }

  const pathParams = getPathParams(parsedUrl)
  if (!pathParams) {
    sendErrorResponse(
      req,
      res,
      400,
      'Bad Request',
      'Invalid path parameters',
      parsedUrl.pathname,
      true
    )
    return
  }

  const session = runtime.sessions.get(pathParams.sessionId)
  if (!session) {
    sendErrorResponse(
      req,
      res,
      404,
      'Session not found',
      'Session not found',
      parsedUrl.pathname
    )
    return
  }

  if (!session.players) {
    sendErrorResponse(
      req,
      res,
      500,
      'Player manager not initialized',
      'Player manager not initialized',
      parsedUrl.pathname
    )
    return
  }

  if (req.method === 'POST') {
    const skipTrackSource = getSkipTrackSource(parsedUrl)
    if (skipTrackSource === null) {
      sendErrorResponse(
        req,
        res,
        400,
        'Bad Request',
        'Invalid parameters',
        parsedUrl.pathname,
        true
      )
      return
    }

    try {
      await session.players.subscribeLyrics(pathParams.guildId, skipTrackSource)
      res.writeHead(204)
      res.end()
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Error subscribing to lyrics'
      logger(
        'error',
        'LyricsAPI',
        `Error subscribing to lyrics: ${errorMessage}`
      )
      sendErrorResponse(
        req,
        res,
        500,
        errorMessage,
        errorMessage,
        parsedUrl.pathname,
        true
      )
    }
    return
  }

  if (req.method === 'DELETE') {
    try {
      await session.players.unsubscribeLyrics(pathParams.guildId)
      res.writeHead(204)
      res.end()
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : 'Error unsubscribing from lyrics'
      logger(
        'error',
        'LyricsAPI',
        `Error unsubscribing from lyrics: ${errorMessage}`
      )
      sendErrorResponse(
        req,
        res,
        500,
        errorMessage,
        errorMessage,
        parsedUrl.pathname,
        true
      )
    }
    return
  }

  sendErrorResponse(
    req,
    res,
    405,
    'Method Not Allowed',
    'Method Not Allowed',
    parsedUrl.pathname
  )
}

/**
 * Route module definition for the lyrics subscription route.
 */
const lyricsSubscriptionRoute: ApiRouteModule = {
  handler,
  methods: ['POST', 'DELETE']
}

export default lyricsSubscriptionRoute
