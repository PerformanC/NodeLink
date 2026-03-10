import OAuth from '../sources/youtube/OAuth.js'
import type {
  ApiNodelinkServer,
  ApiRequest,
  ApiResponse,
  ApiRouteModule,
  ApiSendResponse
} from '../typings/api/api.types.ts'
import { logger, sendErrorResponse } from '../utils.ts'

/**
 * JSON-compatible object used for request payload narrowing.
 */
interface JsonRecord {
  [key: string]:
    | JsonRecord
    | JsonRecord[]
    | string
    | number
    | boolean
    | null
    | undefined
}

/**
 * Request payload accepted by the YouTube config patch route.
 */
interface YoutubeConfigPayload {
  /**
   * OAuth refresh token propagated to the YouTube runtime.
   */
  refreshToken?: string

  /**
   * Visitor data propagated to the YouTube runtime context.
   */
  visitorData?: string
}

/**
 * Raw body payload before request validation.
 */
interface YoutubeConfigBodyInput {
  /**
   * Candidate refresh token field.
   */
  refreshToken?: JsonRecord[string]

  /**
   * Candidate visitor data field.
   */
  visitorData?: JsonRecord[string]
}

/**
 * Serialized response returned by the YouTube config route.
 */
interface YoutubeConfigResponse {
  /**
   * Masked refresh token currently stored by the runtime.
   */
  refreshToken: string | null

  /**
   * Masked visitor data currently stored by the runtime.
   */
  visitorData: string | null

  /**
   * Whether a refresh token is currently configured.
   */
  isConfigured: boolean

  /**
   * Validation result when `?validate=true` is requested.
   */
  isValid: boolean | null
}

/**
 * Minimal OAuth runtime contract used by the endpoint.
 */
interface OAuthRuntime {
  /**
   * Refresh token payload consumed by the OAuth helper.
   */
  refreshToken: string | string[]

  /**
   * Cached access token.
   */
  accessToken: string | null

  /**
   * Access token expiration timestamp.
   */
  tokenExpiry: number

  /**
   * Resolves a fresh access token from the configured refresh token.
   *
   * @returns OAuth access token, or `null` when the refresh flow fails.
   */
  getAccessToken: () => Promise<string | null>
}

/**
 * Minimal YouTube source state used by the route.
 */
interface YoutubeSourceRuntime {
  /**
   * OAuth state attached to the local YouTube source.
   */
  oauth?: {
    refreshToken?: string | string[] | null
    accessToken?: string | null
    tokenExpiry?: number
  }

  /**
   * YouTube internal context used to persist visitor data.
   */
  ytContext?: {
    client?: {
      visitorData?: string | null
    }
  }
}

/**
 * Minimal worker shape required for cluster propagation.
 */
interface YoutubeConfigWorker {
  /**
   * Cluster worker identifier.
   */
  id: number

  /**
   * Whether the worker is connected and ready to receive commands.
   *
   * @returns `true` when the worker can accept commands.
   */
  isConnected: () => boolean
}

/**
 * Shared live configuration cached by the worker manager.
 */
interface LiveYoutubeConfig {
  /**
   * Current refresh token propagated to workers.
   */
  refreshToken: string | null

  /**
   * Current visitor data propagated to workers.
   */
  visitorData: string | null
}

/**
 * Minimal worker manager contract used by the route.
 */
interface YoutubeWorkerManagerRuntime {
  /**
   * Cached live YouTube configuration.
   */
  liveYoutubeConfig: LiveYoutubeConfig

  /**
   * Active playback workers.
   */
  workers: YoutubeConfigWorker[]

  /**
   * Updates the cached live configuration for future worker spawns.
   *
   * @param config - Partial config update to persist.
   * @returns Nothing. The update is applied as a side effect.
   */
  setLiveYoutubeConfig: (config: Partial<LiveYoutubeConfig>) => void

  /**
   * Executes a config update in a connected worker.
   *
   * @param worker - Target worker instance.
   * @param action - Worker command name.
   * @param payload - Config payload sent to the worker.
   * @returns Promise resolved when the worker applies the update.
   */
  execute: (
    worker: YoutubeConfigWorker,
    action: 'updateYoutubeConfig',
    payload: YoutubeConfigPayload
  ) => Promise<object>
}

/**
 * Minimal runtime contract required by the endpoint.
 */
interface YoutubeConfigRuntime extends ApiNodelinkServer {
  /**
   * Cluster worker manager when cluster mode is enabled.
   */
  workerManager?: YoutubeWorkerManagerRuntime | null

  /**
   * Local source registry used outside cluster mode.
   */
  sources?: {
    sources?: Map<string, YoutubeSourceRuntime>
  }
}

/**
 * Returns whether the provided body value is a plain object record.
 *
 * @param value - Candidate request body.
 * @returns `true` when the value can be safely indexed by string keys.
 */
function isObjectRecord(value: ApiRequest['body']): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Narrows the router runtime to the fields used by the YouTube config route.
 *
 * @param nodelink - Router-facing runtime instance.
 * @returns Runtime view exposing optional worker and source managers.
 */
function getRuntime(nodelink: ApiNodelinkServer): YoutubeConfigRuntime {
  return nodelink as YoutubeConfigRuntime
}

/**
 * Extracts a non-empty string from a request field.
 *
 * @param value - Candidate request field.
 * @returns Trimmed string when valid, otherwise `undefined`.
 */
function getNonEmptyString(value: JsonRecord[string]): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  return value.length > 0 ? value : undefined
}

/**
 * Parses and validates the patch payload used by `PATCH /youtube.config`.
 *
 * @param body - Parsed request body.
 * @returns Valid payload, or `null` when any provided field is invalid.
 */
function getPatchPayload(
  body: ApiRequest['body']
): YoutubeConfigPayload | null {
  if (!isObjectRecord(body)) {
    return null
  }

  const payload = body as YoutubeConfigBodyInput

  const refreshToken =
    payload.refreshToken === undefined
      ? undefined
      : getNonEmptyString(payload.refreshToken)
  if (payload.refreshToken !== undefined && refreshToken === undefined) {
    return null
  }

  const visitorData =
    payload.visitorData === undefined
      ? undefined
      : getNonEmptyString(payload.visitorData)
  if (payload.visitorData !== undefined && visitorData === undefined) {
    return null
  }

  return {
    refreshToken,
    visitorData
  }
}

/**
 * Resolves the first non-empty refresh token from the runtime shape.
 *
 * Local OAuth helpers may store refresh tokens as an array while the cluster
 * manager stores a single string.
 *
 * @param value - Candidate refresh token state.
 * @returns Single refresh token string, or `null` when not configured.
 */
function getFirstRefreshToken(
  value: string | string[] | null | undefined
): string | null {
  if (typeof value === 'string' && value.length > 0) {
    return value
  }

  if (Array.isArray(value)) {
    for (const token of value) {
      if (typeof token === 'string' && token.length > 0) {
        return token
      }
    }
  }

  return null
}

/**
 * Masks a sensitive string while preserving a small visible prefix.
 *
 * @param value - Sensitive string value to mask.
 * @param visibleChars - Number of leading characters that remain visible.
 * @returns Masked string, or `null` when the input is empty.
 */
function maskString(value: string | null, visibleChars = 5): string | null {
  if (!value) {
    return null
  }

  if (value.length <= visibleChars) {
    return '***'
  }

  return `${value.substring(0, visibleChars)}...[hidden]`
}

/**
 * Reads the local YouTube source when the server is running without workers.
 *
 * @param runtime - Typed route runtime.
 * @returns Local YouTube source, or `null` when unavailable.
 */
function getLocalYoutubeSource(
  runtime: YoutubeConfigRuntime
): YoutubeSourceRuntime | null {
  return runtime.sources?.sources?.get('youtube') ?? null
}

/**
 * Collects the current runtime configuration and optionally validates the
 * stored refresh token by performing a sandboxed OAuth refresh.
 *
 * @param runtime - Typed route runtime.
 * @param parsedUrl - Parsed request URL.
 * @returns Serialized response payload for the GET endpoint.
 */
async function collectCurrentConfig(
  runtime: YoutubeConfigRuntime,
  parsedUrl: URL
): Promise<YoutubeConfigResponse> {
  let currentRefreshToken: string | null = null
  let currentVisitorData: string | null = null

  if (runtime.workerManager) {
    currentRefreshToken = runtime.workerManager.liveYoutubeConfig.refreshToken
    currentVisitorData = runtime.workerManager.liveYoutubeConfig.visitorData

    if (!currentRefreshToken) {
      currentRefreshToken = getFirstRefreshToken(
        runtime.options.sources.youtube?.clients?.settings?.TV?.refreshToken
      )
    }
  } else {
    const youtube = getLocalYoutubeSource(runtime)
    if (youtube) {
      currentRefreshToken = getFirstRefreshToken(youtube.oauth?.refreshToken)
      currentVisitorData = youtube.ytContext?.client?.visitorData ?? null
    }
  }

  let isValid: boolean | null = null
  if (
    parsedUrl.searchParams.get('validate') === 'true' &&
    currentRefreshToken !== null
  ) {
    try {
      const validator = new OAuth(runtime) as OAuthRuntime
      validator.refreshToken = currentRefreshToken
      validator.accessToken = null
      validator.tokenExpiry = 0
      isValid = Boolean(await validator.getAccessToken())
    } catch {
      isValid = false
    }
  }

  return {
    refreshToken: maskString(currentRefreshToken, 7),
    visitorData: maskString(currentVisitorData, 10),
    isConfigured: currentRefreshToken !== null,
    isValid
  }
}

/**
 * Validates a refresh token before any runtime state is mutated.
 *
 * @param runtime - Typed route runtime.
 * @param refreshToken - Refresh token proposed by the request payload.
 * @returns Nothing. The function throws when Google rejects the token.
 */
async function validateRefreshToken(
  runtime: YoutubeConfigRuntime,
  refreshToken: string
): Promise<void> {
  logger('info', 'API', 'Sandboxing new YouTube refresh token for validation.')

  const sandboxOAuth = new OAuth(runtime) as OAuthRuntime
  sandboxOAuth.refreshToken = refreshToken
  sandboxOAuth.accessToken = null
  sandboxOAuth.tokenExpiry = 0

  const accessToken = await sandboxOAuth.getAccessToken()
  if (!accessToken) {
    throw new Error(
      'Google rejected the refresh token (Invalid Grant or similar).'
    )
  }

  logger('info', 'API', 'YouTube refresh token validated successfully.')
}

/**
 * Propagates a YouTube config update through connected playback workers.
 *
 * @param runtime - Typed route runtime.
 * @param payload - Validated patch payload.
 * @returns Number of workers that applied the update successfully.
 */
async function updateClusterConfig(
  runtime: YoutubeConfigRuntime,
  payload: YoutubeConfigPayload
): Promise<number> {
  const manager = runtime.workerManager
  if (!manager) {
    return 0
  }

  manager.setLiveYoutubeConfig({
    refreshToken: payload.refreshToken ?? undefined,
    visitorData: payload.visitorData ?? undefined
  })
  logger('info', 'API', 'Master LiveConfig updated for future workers.')
  logger('info', 'API', 'Propagating YouTube config to cluster workers.')

  const results = await Promise.all(
    manager.workers
      .filter((worker) => worker.isConnected())
      .map(async (worker) => {
        try {
          await manager.execute(worker, 'updateYoutubeConfig', payload)
          return 1
        } catch (error) {
          logger(
            'error',
            'API',
            `Failed to update worker ${worker.id}: ${error instanceof Error ? error.message : String(error)}`
          )
          return 0
        }
      })
  )

  return results.reduce<number>((total, value) => total + value, 0)
}

/**
 * Applies a YouTube config update to the local in-process source.
 *
 * @param runtime - Typed route runtime.
 * @param payload - Validated patch payload.
 * @returns `1` when the local source was updated, otherwise `0`.
 */
function updateLocalConfig(
  runtime: YoutubeConfigRuntime,
  payload: YoutubeConfigPayload
): number {
  logger('info', 'API', 'Updating local YouTube source.')

  const youtube = getLocalYoutubeSource(runtime)
  if (!youtube) {
    return 0
  }

  if (payload.refreshToken !== undefined && youtube.oauth) {
    youtube.oauth.refreshToken = payload.refreshToken
    youtube.oauth.accessToken = null
    youtube.oauth.tokenExpiry = 0
    logger('info', 'YouTube', 'Local refresh token updated.')
  }

  if (payload.visitorData !== undefined && youtube.ytContext?.client) {
    youtube.ytContext.client.visitorData = payload.visitorData
    logger('info', 'YouTube', 'Local visitor data updated.')
  }

  return 1
}

/**
 * Handles the YouTube live configuration endpoint.
 *
 * `GET` returns masked runtime state and optionally validates the stored token.
 * `PATCH` validates and propagates runtime updates to workers or the local
 * source depending on the current deployment mode.
 *
 * @param nodelink - Router-facing NodeLink runtime.
 * @param req - Incoming API request.
 * @param res - Outgoing API response.
 * @param sendResponse - JSON response helper from the router.
 * @param parsedUrl - Parsed request URL.
 * @returns Nothing. A response is always sent as a side effect.
 */
async function handler(
  nodelink: ApiNodelinkServer,
  req: ApiRequest,
  res: ApiResponse,
  sendResponse: ApiSendResponse,
  parsedUrl: URL
): Promise<void> {
  const runtime = getRuntime(nodelink)

  if (req.method === 'GET') {
    sendResponse(req, res, await collectCurrentConfig(runtime, parsedUrl), 200)
    return
  }

  if (req.method !== 'PATCH') {
    return
  }

  const payload = getPatchPayload(req.body)
  if (payload === null) {
    sendErrorResponse(
      req,
      res,
      400,
      'Bad Request',
      'Invalid parameters',
      parsedUrl.pathname
    )
    return
  }

  if (payload.refreshToken === undefined && payload.visitorData === undefined) {
    sendErrorResponse(
      req,
      res,
      400,
      'Bad Request',
      'At least one field (refreshToken or visitorData) must be provided.',
      parsedUrl.pathname
    )
    return
  }

  if (payload.refreshToken !== undefined) {
    try {
      await validateRefreshToken(runtime, payload.refreshToken)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Token validation failed.'
      logger('warn', 'API', `YouTube token validation failed: ${message}`)
      sendErrorResponse(
        req,
        res,
        403,
        'Forbidden',
        `Token validation failed: ${message}. No changes were applied.`,
        parsedUrl.pathname
      )
      return
    }
  }

  try {
    const workersUpdated = runtime.workerManager
      ? await updateClusterConfig(runtime, payload)
      : updateLocalConfig(runtime, payload)

    const fieldsUpdated = [
      payload.refreshToken !== undefined ? 'refreshToken' : null,
      payload.visitorData !== undefined ? 'visitorData' : null
    ].filter((field): field is 'refreshToken' | 'visitorData' => field !== null)

    sendResponse(
      req,
      res,
      {
        message: 'YouTube configuration updated successfully.',
        workersUpdated,
        fieldsUpdated
      },
      200
    )
  } catch (error) {
    logger(
      'error',
      'API',
      `Critical error during config propagation: ${error instanceof Error ? error.message : String(error)}`
    )
    sendErrorResponse(
      req,
      res,
      500,
      'Internal Server Error',
      'Failed to propagate configuration changes.',
      parsedUrl.pathname
    )
  }
}

const youtubeConfigRoute: ApiRouteModule = {
  handler,
  methods: ['GET', 'PATCH']
}

export default youtubeConfigRoute
