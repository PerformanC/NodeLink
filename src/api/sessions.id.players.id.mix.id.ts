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
 * Runtime player manager contract required by the mix item route.
 */
interface MixItemPlayerManager {
  /**
   * Updates the volume of an existing mix layer.
   *
   * @param guildId - Target guild identifier.
   * @param mixId - Mix layer identifier.
   * @param volume - New mix volume in the `[0, 1]` range.
   * @returns Promise resolving to `true` when the mix exists and was updated.
   */
  updateMix: (
    guildId: string,
    mixId: string,
    volume: number
  ) => Promise<boolean>

  /**
   * Removes an existing mix layer.
   *
   * @param guildId - Target guild identifier.
   * @param mixId - Mix layer identifier.
   * @returns Promise resolving to `true` when the mix existed and was removed.
   */
  removeMix: (guildId: string, mixId: string) => Promise<boolean>
}

/**
 * Session contract required by the mix item route.
 */
type MixItemSession = Omit<Session, 'players'> & {
  /**
   * Player manager instance for the session.
   */
  players: MixItemPlayerManager
}

/**
 * Runtime contract required by the mix item route.
 */
interface MixItemRuntime extends ApiNodelinkServer {
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
    get: (id: string) => MixItemSession | undefined
  }
}

/**
 * Path parameters extracted from the dynamic route.
 */
interface MixItemPathParams {
  /**
   * Session identifier.
   */
  sessionId: string

  /**
   * Guild identifier.
   */
  guildId: string

  /**
   * Mix layer identifier.
   */
  mixId: string
}

/**
 * Request payload accepted by the mix update route.
 */
interface UpdateMixPayload {
  /**
   * New mix volume in the `[0, 1]` range.
   */
  volume: number
}

/**
 * Builds a strongly typed runtime view for the mix item route.
 *
 * @param nodelink - Router-facing runtime instance.
 * @returns Runtime compatible with the route, or `null` when the required
 * session manager field is unavailable.
 */
function getMixItemRuntime(nodelink: ApiNodelinkServer): MixItemRuntime | null {
  const runtime = nodelink as ApiNodelinkServer & Partial<MixItemRuntime>

  if (!runtime.sessions || typeof runtime.sessions.get !== 'function') {
    return null
  }

  return runtime as MixItemRuntime
}

/**
 * Extracts and validates the path parameters used by the route.
 *
 * @param parsedUrl - Parsed request URL.
 * @returns Validated path parameters, or `null` when validation fails.
 */
function getPathParams(parsedUrl: URL): MixItemPathParams | null {
  const pathParts = parsedUrl.pathname.split('/')
  const sessionId = pathParts[3]
  const guildId = pathParts[5]
  const mixId = pathParts[7]

  if (!sessionId || !guildId || !mixId) {
    return null
  }

  if (!/^\d{17,20}$/.test(guildId)) {
    return null
  }

  return {
    sessionId,
    guildId,
    mixId
  }
}

/**
 * Parses and validates the update mix payload.
 *
 * @param body - Parsed request body.
 * @returns Valid payload object, or `null` when validation fails.
 */
function getUpdateMixPayload(
  body: ApiRequest['body']
): UpdateMixPayload | null {
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body) as UpdateMixPayload
      return getUpdateMixPayload(parsed)
    } catch {
      return null
    }
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null
  }

  const payload = body as Partial<UpdateMixPayload>
  if (
    typeof payload.volume !== 'number' ||
    !Number.isFinite(payload.volume) ||
    payload.volume < 0 ||
    payload.volume > 1
  ) {
    return null
  }

  return {
    volume: payload.volume
  }
}

/**
 * Handles `PATCH /sessions/:id/players/:guildId/mix/:mixId`.
 *
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @param pathParams - Validated path parameters.
 * @param runtime - Mix item runtime.
 * @param parsedUrl - Parsed request URL.
 * @returns Promise that resolves once the response has been written.
 */
async function handleUpdateMix(
  req: ApiRequest,
  res: ApiResponse,
  pathParams: MixItemPathParams,
  runtime: MixItemRuntime,
  parsedUrl: URL
): Promise<void> {
  const payload = getUpdateMixPayload(req.body)
  if (!payload) {
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

    const updated = await session.players.updateMix(
      pathParams.guildId,
      pathParams.mixId,
      payload.volume
    )

    if (!updated) {
      sendErrorResponse(
        req,
        res,
        404,
        'Mix not found',
        'Mix not found',
        parsedUrl.pathname
      )
      return
    }

    logger(
      'debug',
      'MixAPI',
      `Updated mix ${pathParams.mixId} volume to ${payload.volume} for guild ${pathParams.guildId}`
    )

    res.writeHead(204)
    res.end()
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Error updating mix'
    logger('error', 'MixAPI', `Error updating mix: ${errorMessage}`)
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
}

/**
 * Handles `DELETE /sessions/:id/players/:guildId/mix/:mixId`.
 *
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @param pathParams - Validated path parameters.
 * @param runtime - Mix item runtime.
 * @param parsedUrl - Parsed request URL.
 * @returns Promise that resolves once the response has been written.
 */
async function handleDeleteMix(
  req: ApiRequest,
  res: ApiResponse,
  pathParams: MixItemPathParams,
  runtime: MixItemRuntime,
  parsedUrl: URL
): Promise<void> {
  try {
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

    const removed = await session.players.removeMix(
      pathParams.guildId,
      pathParams.mixId
    )

    if (!removed) {
      sendErrorResponse(
        req,
        res,
        404,
        'Mix not found',
        'Mix not found',
        parsedUrl.pathname
      )
      return
    }

    logger(
      'debug',
      'MixAPI',
      `Removed mix ${pathParams.mixId} for guild ${pathParams.guildId}`
    )

    res.writeHead(204)
    res.end()
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Error removing mix'
    logger('error', 'MixAPI', `Error removing mix: ${errorMessage}`)
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
}

/**
 * Handles requests for the mix item route.
 *
 * Supports:
 * - `PATCH` to update a mix volume
 * - `DELETE` to remove a mix layer
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
  const runtime = getMixItemRuntime(nodelink)
  if (!runtime) {
    sendErrorResponse(
      req,
      res,
      500,
      'Internal Server Error',
      'Mix runtime contract is incomplete.',
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

  if (req.method === 'PATCH') {
    await handleUpdateMix(req, res, pathParams, runtime, parsedUrl)
    return
  }

  if (req.method === 'DELETE') {
    await handleDeleteMix(req, res, pathParams, runtime, parsedUrl)
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
 * Route module definition for the mix item route.
 */
const mixItemRoute: ApiRouteModule = {
  handler,
  methods: ['PATCH', 'DELETE']
}

export default mixItemRoute
