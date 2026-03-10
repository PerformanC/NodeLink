import type {
  ApiNodelinkServer,
  ApiRequest,
  ApiResponse,
  ApiRouteModule,
  ApiSendResponse
} from '../typings/api/api.types.ts'
import type { Session } from '../typings/index.types.ts'
import type {
  PlayerTrack,
  TrackInfoExtended
} from '../typings/playback/player.types.ts'
import type { EncodedTrackPayload } from '../typings/utils.types.ts'
import { decodeTrack, logger, sendErrorResponse } from '../utils.ts'

/**
 * Mix feature configuration consumed by the route.
 */
interface MixConfig {
  /**
   * Whether the mix feature is enabled.
   */
  enabled?: boolean

  /**
   * Default volume for new mix layers.
   */
  defaultVolume?: number

  /**
   * Maximum number of mix layers allowed.
   */
  maxLayersMix?: number

  /**
   * Whether mix layers should auto-clean up.
   */
  autoCleanup?: boolean
}

/**
 * Runtime mix creation result payload.
 */
interface MixAddResult {
  /**
   * Mix layer identifier.
   */
  id: string

  /**
   * Track payload associated with the mix layer.
   */
  track: PlayerTrack

  /**
   * Applied mix volume.
   */
  volume: number
}

/**
 * Runtime mix state payload.
 */
interface MixState {
  /**
   * Mix layer identifier.
   */
  id: string

  /**
   * Track payload associated with the mix layer.
   */
  track: PlayerTrack

  /**
   * Current mix volume.
   */
  volume: number

  /**
   * Current playback position in milliseconds.
   */
  position: number

  /**
   * Start timestamp in milliseconds.
   */
  startTime: number
}

/**
 * Runtime player manager contract required by the mix collection route.
 */
interface MixCollectionPlayerManager {
  /**
   * Adds a new mix layer to the player.
   *
   * @param guildId - Target guild identifier.
   * @param trackPayload - Fully decoded track payload for the mix layer.
   * @param volume - Optional volume override.
   * @returns Promise resolving to the created mix payload.
   */
  addMix: (
    guildId: string,
    trackPayload: PlayerTrack,
    volume: number | null
  ) => Promise<MixAddResult>

  /**
   * Returns all active mix layers.
   *
   * @param guildId - Target guild identifier.
   * @returns Promise resolving to the active mix list.
   */
  getMixes: (guildId: string) => Promise<MixState[]>
}

/**
 * Session contract required by the mix collection route.
 */
type MixCollectionSession = Omit<Session, 'players'> & {
  /**
   * Player manager instance for the session.
   */
  players: MixCollectionPlayerManager
}

/**
 * Runtime contract required by the mix collection route.
 */
interface MixCollectionRuntime extends ApiNodelinkServer {
  /**
   * Runtime options used by the route.
   */
  options: ApiNodelinkServer['options'] & {
    mix?: MixConfig
  }

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
    get: (id: string) => MixCollectionSession | undefined
  }
}

/**
 * Path parameters extracted from the dynamic route.
 */
interface MixCollectionPathParams {
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
 * Track payload accepted by the mix creation route.
 */
interface MixCreateTrackInput {
  /**
   * Encoded track string used to reconstruct a full `PlayerTrack`.
   */
  encoded?: string | null
}

/**
 * Body payload accepted by the mix creation route.
 */
interface CreateMixPayload {
  /**
   * Track payload used to create the mix layer.
   */
  track: MixCreateTrackInput

  /**
   * Optional mix volume override.
   */
  volume?: number
}

/**
 * Response payload returned by the mix creation route.
 */
interface CreateMixResponse {
  /**
   * Mix layer identifier.
   */
  id: string

  /**
   * Track payload associated with the mix layer.
   */
  track: PlayerTrack

  /**
   * Applied mix volume.
   */
  volume: number
}

/**
 * Response payload returned by the mix listing route.
 */
interface GetMixesResponse {
  /**
   * Active mix layers for the player.
   */
  mixes: MixState[]
}

/**
 * Builds a strongly typed runtime view for the mix collection route.
 *
 * @param nodelink - Router-facing runtime instance.
 * @returns Runtime compatible with the route, or `null` when the required
 * session manager field is unavailable.
 */
function getMixCollectionRuntime(
  nodelink: ApiNodelinkServer
): MixCollectionRuntime | null {
  const runtime = nodelink as ApiNodelinkServer & Partial<MixCollectionRuntime>

  if (!runtime.sessions || typeof runtime.sessions.get !== 'function') {
    return null
  }

  return runtime as MixCollectionRuntime
}

/**
 * Extracts and validates the path parameters used by the route.
 *
 * @param parsedUrl - Parsed request URL.
 * @returns Validated path parameters, or `null` when validation fails.
 */
function getPathParams(parsedUrl: URL): MixCollectionPathParams | null {
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
 * Parses and validates the mix creation payload.
 *
 * @param body - Parsed request body.
 * @returns Valid payload object, or `null` when validation fails.
 */
function getCreateMixPayload(
  body: ApiRequest['body']
): CreateMixPayload | null {
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body) as CreateMixPayload
      return getCreateMixPayload(parsed)
    } catch {
      return null
    }
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null
  }

  const payload = body as Partial<CreateMixPayload>
  if (
    !payload.track ||
    typeof payload.track !== 'object' ||
    Array.isArray(payload.track)
  ) {
    return null
  }

  if (payload.volume !== undefined) {
    if (
      typeof payload.volume !== 'number' ||
      !Number.isFinite(payload.volume) ||
      payload.volume < 0 ||
      payload.volume > 1
    ) {
      return null
    }
  }

  const track = payload.track as MixCreateTrackInput
  if (
    track.encoded !== undefined &&
    track.encoded !== null &&
    typeof track.encoded !== 'string'
  ) {
    return null
  }

  return {
    track,
    volume: payload.volume
  }
}

/**
 * Normalizes decoded track info into the stricter `TrackInfoExtended` shape
 * required by the player mix API.
 *
 * @param decodedTrack - Decoded track payload.
 * @returns Normalized track information suitable for `PlayerTrack`.
 */
function normalizeMixTrackInfo(
  decodedTrack: EncodedTrackPayload
): TrackInfoExtended {
  return {
    ...decodedTrack.info,
    uri: decodedTrack.info.uri ?? '',
    artworkUrl: decodedTrack.info.artworkUrl ?? null,
    isrc: decodedTrack.info.isrc ?? null
  }
}

/**
 * Builds the `PlayerTrack` payload required by `addMix(...)`.
 *
 * @param payload - Validated mix creation payload.
 * @returns Fully normalized player track payload.
 * @throws Error when the request does not provide a usable encoded track.
 */
function buildMixTrackPayload(payload: CreateMixPayload): PlayerTrack {
  const encoded = payload.track.encoded?.trim()
  if (!encoded) {
    throw new Error('Track must provide track.encoded for mix creation.')
  }

  const decodedTrack = decodeTrack(encoded.replace(/ /g, '+'))

  return {
    encoded: decodedTrack.encoded,
    info: normalizeMixTrackInfo(decodedTrack),
    userData: decodedTrack.userData,
    pluginInfo: decodedTrack.pluginInfo
  }
}

/**
 * Handles `POST /sessions/:id/players/:guildId/mix`.
 *
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @param pathParams - Validated path parameters.
 * @param runtime - Mix collection runtime.
 * @param sendResponse - Helper responsible for JSON serialization and headers.
 * @param parsedUrl - Parsed request URL.
 * @returns Promise that resolves once the response has been written.
 */
async function handleCreateMix(
  req: ApiRequest,
  res: ApiResponse,
  pathParams: MixCollectionPathParams,
  runtime: MixCollectionRuntime,
  sendResponse: ApiSendResponse,
  parsedUrl: URL
): Promise<void> {
  const payload = getCreateMixPayload(req.body)
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

  const mixConfig = runtime.options.mix ?? {
    enabled: true,
    defaultVolume: 0.8,
    maxLayersMix: 5,
    autoCleanup: true
  }

  if (!mixConfig.enabled) {
    sendErrorResponse(
      req,
      res,
      403,
      'Forbidden',
      'Mix feature is disabled',
      parsedUrl.pathname
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

    const trackPayload = buildMixTrackPayload(payload)
    const result = await session.players.addMix(
      pathParams.guildId,
      trackPayload,
      payload.volume ?? null
    )

    logger(
      'debug',
      'MixAPI',
      `Created mix ${result.id} for guild ${pathParams.guildId}`
    )

    const response: CreateMixResponse = {
      id: result.id,
      track: result.track,
      volume: result.volume
    }
    sendResponse(req, res, response, 201)
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Error creating mix'
    logger('error', 'MixAPI', `Error creating mix: ${errorMessage}`)
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
 * Handles `GET /sessions/:id/players/:guildId/mix`.
 *
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @param pathParams - Validated path parameters.
 * @param runtime - Mix collection runtime.
 * @param sendResponse - Helper responsible for JSON serialization and headers.
 * @param parsedUrl - Parsed request URL.
 * @returns Promise that resolves once the response has been written.
 */
async function handleGetMixes(
  req: ApiRequest,
  res: ApiResponse,
  pathParams: MixCollectionPathParams,
  runtime: MixCollectionRuntime,
  sendResponse: ApiSendResponse,
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

    const mixes = await session.players.getMixes(pathParams.guildId)
    const response: GetMixesResponse = { mixes }
    sendResponse(req, res, response, 200)
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Error getting mixes'
    logger('error', 'MixAPI', `Error getting mixes: ${errorMessage}`)
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
 * Handles requests for the mix collection route.
 *
 * Supports:
 * - `POST` to create a new mix layer
 * - `GET` to list active mix layers
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
  const runtime = getMixCollectionRuntime(nodelink)
  if (!runtime) {
    sendErrorResponse(
      req,
      res,
      500,
      'Internal Server Error',
      'Mix collection runtime contract is incomplete.',
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

  if (req.method === 'POST') {
    await handleCreateMix(
      req,
      res,
      pathParams,
      runtime,
      sendResponse,
      parsedUrl
    )
    return
  }

  if (req.method === 'GET') {
    await handleGetMixes(req, res, pathParams, runtime, sendResponse, parsedUrl)
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
 * Route module definition for the mix collection route.
 */
const mixCollectionRoute: ApiRouteModule = {
  handler,
  methods: ['GET', 'POST']
}

export default mixCollectionRoute
