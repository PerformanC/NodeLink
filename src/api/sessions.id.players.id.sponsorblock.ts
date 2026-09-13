import type { PlayerCommandResponse } from '../managers/playerManager.ts'
import type {
  ApiNodelinkServer,
  ApiRequest,
  ApiResponse,
  ApiRouteModule,
  ApiSendResponse
} from '../typings/api/api.types.ts'
import type { Session } from '../typings/index.types.ts'
import type {
  PlayerSponsorBlockState,
  SponsorBlockSegment
} from '../typings/playback/player.types.ts'
import { sendErrorResponse } from '../utils.ts'

/**
 * Minimal player manager contract required by the SponsorBlock route.
 */
interface SponsorBlockPlayerManager {
  /**
   * Returns current SponsorBlock state for a player.
   */
  getSponsorBlock: (
    guildId: string
  ) => Promise<PlayerSponsorBlockState | PlayerCommandResponse>

  /**
   * Updates SponsorBlock settings for a player.
   */
  updateSponsorBlock: (
    guildId: string,
    updates: Partial<
      Omit<PlayerSponsorBlockState, 'segments' | 'lastSkippedUuid'>
    >
  ) => Promise<PlayerCommandResponse | undefined>

  /**
   * Overrides SponsorBlock segments for a player.
   */
  setSponsorBlockSegments: (
    guildId: string,
    segments: SponsorBlockSegment[]
  ) => Promise<PlayerCommandResponse | undefined>

  /**
   * Clears SponsorBlock state for a player.
   */
  clearSponsorBlock: (
    guildId: string
  ) => Promise<PlayerCommandResponse | undefined>
}

/**
 * Session contract required by the SponsorBlock route.
 */
type SponsorBlockSession = Omit<Session, 'players'> & {
  /**
   * Player manager instance for the session.
   */
  players: SponsorBlockPlayerManager
}

/**
 * Runtime contract required by the SponsorBlock route.
 */
interface SponsorBlockRuntime extends ApiNodelinkServer {
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
    get: (id: string) => SponsorBlockSession | undefined
  }
}

/**
 * Path parameters extracted from the dynamic route.
 */
interface SponsorBlockPathParams {
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
 * Builds a strongly typed runtime view for the SponsorBlock route.
 *
 * @param nodelink - Router-facing runtime instance.
 * @returns Runtime compatible with the route, or `null` when the required
 * session manager field is unavailable.
 */
function getSponsorBlockRuntime(
  nodelink: ApiNodelinkServer
): SponsorBlockRuntime | null {
  const runtime = nodelink as ApiNodelinkServer & Partial<SponsorBlockRuntime>

  if (!runtime.sessions || typeof runtime.sessions.get !== 'function') {
    return null
  }

  return runtime as SponsorBlockRuntime
}

/**
 * Extracts and validates the path parameters used by the route.
 *
 * @param parsedUrl - Parsed request URL.
 * @returns Validated path parameters, or `null` when validation fails.
 */
function getPathParams(parsedUrl: URL): SponsorBlockPathParams | null {
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
 * Handles `GET /sessions/:id/players/:guildId/sponsorblock`.
 */
async function handleGetSponsorBlock(
  req: ApiRequest,
  res: ApiResponse,
  pathParams: SponsorBlockPathParams,
  runtime: SponsorBlockRuntime,
  sendResponse: ApiSendResponse
): Promise<void> {
  const session = runtime.sessions.get(pathParams.sessionId)
  if (!session) {
    sendErrorResponse(
      req,
      res,
      404,
      'Not Found',
      "The provided sessionId doesn't exist.",
      req.url || ''
    )
    return
  }

  try {
    const state = await session.players.getSponsorBlock(pathParams.guildId)
    sendResponse(req, res, state, 200)
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Player not found'
    sendErrorResponse(req, res, 404, 'Not Found', errorMessage, req.url || '')
  }
}

/**
 * Handles `PATCH /sessions/:id/players/:guildId/sponsorblock`.
 */
async function handlePatchSponsorBlock(
  req: ApiRequest,
  res: ApiResponse,
  pathParams: SponsorBlockPathParams,
  runtime: SponsorBlockRuntime,
  sendResponse: ApiSendResponse
): Promise<void> {
  const session = runtime.sessions.get(pathParams.sessionId)
  if (!session) {
    sendErrorResponse(
      req,
      res,
      404,
      'Not Found',
      "The provided sessionId doesn't exist.",
      req.url || ''
    )
    return
  }

  const body = req.body as Partial<PlayerSponsorBlockState>
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendErrorResponse(
      req,
      res,
      400,
      'Bad Request',
      'Invalid body',
      req.url || ''
    )
    return
  }

  try {
    const result = await session.players.updateSponsorBlock(
      pathParams.guildId,
      {
        enabled: body.enabled,
        categories: body.categories,
        actionTypes: body.actionTypes,
        skipMarginMs: body.skipMarginMs
      }
    )

    if (result && 'status' in result && result.status !== 200) {
      sendErrorResponse(
        req,
        res,
        (result.status as number) || 500,
        'Internal Server Error',
        result.message || 'Operation failed',
        req.url || ''
      )
      return
    }

    sendResponse(
      req,
      res,
      await session.players.getSponsorBlock(pathParams.guildId),
      200
    )
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Player not found'
    sendErrorResponse(req, res, 404, 'Not Found', errorMessage, req.url || '')
  }
}

/**
 * Handles `POST /sessions/:id/players/:guildId/sponsorblock`.
 */
async function handlePostSponsorBlock(
  req: ApiRequest,
  res: ApiResponse,
  pathParams: SponsorBlockPathParams,
  runtime: SponsorBlockRuntime,
  sendResponse: ApiSendResponse
): Promise<void> {
  const session = runtime.sessions.get(pathParams.sessionId)
  if (!session) {
    sendErrorResponse(
      req,
      res,
      404,
      'Not Found',
      "The provided sessionId doesn't exist.",
      req.url || ''
    )
    return
  }

  const body = req.body as { segments: SponsorBlockSegment[] }
  if (!body?.segments || !Array.isArray(body.segments)) {
    sendErrorResponse(
      req,
      res,
      400,
      'Bad Request',
      'Invalid segments array',
      req.url || ''
    )
    return
  }

  try {
    const result = await session.players.setSponsorBlockSegments(
      pathParams.guildId,
      body.segments
    )

    if (result && 'status' in result && result.status !== 200) {
      sendErrorResponse(
        req,
        res,
        (result.status as number) || 500,
        'Internal Server Error',
        result.message || 'Operation failed',
        req.url || ''
      )
      return
    }

    sendResponse(
      req,
      res,
      await session.players.getSponsorBlock(pathParams.guildId),
      200
    )
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Player not found'
    sendErrorResponse(req, res, 404, 'Not Found', errorMessage, req.url || '')
  }
}

/**
 * Handles `DELETE /sessions/:id/players/:guildId/sponsorblock`.
 */
async function handleDeleteSponsorBlock(
  req: ApiRequest,
  res: ApiResponse,
  pathParams: SponsorBlockPathParams,
  runtime: SponsorBlockRuntime
): Promise<void> {
  const session = runtime.sessions.get(pathParams.sessionId)
  if (!session) {
    sendErrorResponse(
      req,
      res,
      404,
      'Not Found',
      "The provided sessionId doesn't exist.",
      req.url || ''
    )
    return
  }

  try {
    await session.players.clearSponsorBlock(pathParams.guildId)
    res.writeHead(204)
    res.end()
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Player not found'
    sendErrorResponse(req, res, 404, 'Not Found', errorMessage, req.url || '')
  }
}

/**
 * Handles requests for the SponsorBlock route.
 */
async function handler(
  nodelink: ApiNodelinkServer,
  req: ApiRequest,
  res: ApiResponse,
  sendResponse: ApiSendResponse,
  parsedUrl: URL
): Promise<void> {
  const runtime = getSponsorBlockRuntime(nodelink)
  if (!runtime) {
    sendErrorResponse(
      req,
      res,
      500,
      'Internal Server Error',
      'SponsorBlock runtime contract is incomplete.',
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

  if (req.method === 'GET') {
    await handleGetSponsorBlock(req, res, pathParams, runtime, sendResponse)
    return
  }

  if (req.method === 'PATCH') {
    await handlePatchSponsorBlock(req, res, pathParams, runtime, sendResponse)
    return
  }

  if (req.method === 'POST') {
    await handlePostSponsorBlock(req, res, pathParams, runtime, sendResponse)
    return
  }

  if (req.method === 'DELETE') {
    await handleDeleteSponsorBlock(req, res, pathParams, runtime)
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

const sponsorBlockRoute: ApiRouteModule = {
  handler,
  methods: ['GET', 'POST', 'PATCH', 'DELETE']
}

export default sponsorBlockRoute
