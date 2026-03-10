import type {
  ApiNodelinkServer,
  ApiRequest,
  ApiResponse,
  ApiRouteModule,
  ApiSendResponse
} from '../typings/api/api.types.ts'
import { logger, makeRequest, sendErrorResponse } from '../utils.ts'

/**
 * Google OAuth client identifier used by the YouTube refresh flow.
 *
 * This matches the runtime helper used by the YouTube source implementation.
 */
const CLIENT_ID =
  '861556708454-d6dlm3lh05idd8npek18k6be8ba3oc68.apps.googleusercontent.com'

/**
 * Google OAuth client secret used by the YouTube refresh flow.
 *
 * This matches the runtime helper used by the YouTube source implementation.
 */
const CLIENT_SECRET = 'SboVhoG9s0rNafixCSGGKXAT'

/**
 * JSON-compatible object used for request and response narrowing.
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
 * Serialized error payload returned by YouTube OAuth failures.
 */
interface YoutubeOAuthErrorBody extends JsonRecord {
  /**
   * OAuth error code returned by Google.
   */
  error?: string

  /**
   * Human-readable error description returned by Google.
   */
  error_description?: string
}

/**
 * Minimal request body accepted by the OAuth helper route.
 */
interface YoutubeOAuthBodyInput {
  /**
   * Candidate refresh token field.
   */
  refreshToken?: string
}

/**
 * Returns whether the provided body value is a plain object record.
 *
 * @param value - Candidate request or response payload.
 * @returns `true` when the value can be accessed through string keys.
 */
function isObjectRecord(value: ApiRequest['body']): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Reads a refresh token from either the query string or the request body.
 *
 * `GET` expects `?refreshToken=...`.
 * `POST` expects `{ refreshToken: string }` in the body.
 *
 * @param req - Incoming API request.
 * @param parsedUrl - Parsed request URL.
 * @returns Non-empty refresh token string, or `null` when absent/invalid.
 */
function getRefreshToken(req: ApiRequest, parsedUrl: URL): string | null {
  if (req.method === 'GET') {
    const refreshToken = parsedUrl.searchParams.get('refreshToken')
    return typeof refreshToken === 'string' && refreshToken.length > 0
      ? refreshToken
      : null
  }

  if (req.method === 'POST' && isObjectRecord(req.body)) {
    const refreshToken = (req.body as YoutubeOAuthBodyInput).refreshToken
    return typeof refreshToken === 'string' && refreshToken.length > 0
      ? refreshToken
      : null
  }

  return null
}

/**
 * Normalizes the error message returned by the Google OAuth refresh endpoint.
 *
 * @param body - Parsed HTTP response body.
 * @param requestError - Transport-level error from the request helper.
 * @returns Best available human-readable error message.
 */
function getOAuthErrorMessage(
  body: ApiRequest['body'],
  requestError: string | undefined
): string {
  if (typeof requestError === 'string' && requestError.length > 0) {
    return requestError
  }

  if (isObjectRecord(body)) {
    const oauthBody = body as YoutubeOAuthErrorBody
    if (
      typeof oauthBody.error_description === 'string' &&
      oauthBody.error_description.length > 0
    ) {
      return oauthBody.error_description
    }

    if (typeof oauthBody.error === 'string' && oauthBody.error.length > 0) {
      return oauthBody.error
    }
  }

  return 'Failed to refresh token'
}

/**
 * Handles the YouTube OAuth refresh helper route.
 *
 * The route accepts a refresh token through either `GET` query params or a
 * `POST` JSON body, forwards it to Google, and returns the upstream OAuth
 * response verbatim when successful.
 *
 * @param _nodelink - Router-facing runtime, unused by this route.
 * @param req - Incoming API request.
 * @param res - Outgoing API response.
 * @param sendResponse - JSON response helper from the router.
 * @param parsedUrl - Parsed request URL.
 * @returns Nothing. A response is always sent as a side effect.
 */
async function handler(
  _nodelink: ApiNodelinkServer,
  req: ApiRequest,
  res: ApiResponse,
  sendResponse: ApiSendResponse,
  parsedUrl: URL
): Promise<void> {
  const refreshToken = getRefreshToken(req, parsedUrl)
  if (refreshToken === null) {
    sendErrorResponse(
      req,
      res,
      400,
      'Bad Request',
      'Missing refreshToken parameter.',
      parsedUrl.pathname
    )
    return
  }

  try {
    const result = await makeRequest('https://www.youtube.com/o/oauth2/token', {
      method: 'POST',
      body: {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      }
    })

    const body = result.body
    if (
      typeof result.statusCode !== 'number' ||
      result.statusCode !== 200 ||
      result.error
    ) {
      sendErrorResponse(
        req,
        res,
        500,
        'Internal Server Error',
        getOAuthErrorMessage(body, result.error),
        parsedUrl.pathname
      )
      return
    }

    if (isObjectRecord(body)) {
      const oauthBody = body as YoutubeOAuthErrorBody
      if (
        typeof oauthBody.error === 'string' ||
        typeof oauthBody.error_description === 'string'
      ) {
        sendErrorResponse(
          req,
          res,
          500,
          'Internal Server Error',
          getOAuthErrorMessage(oauthBody, undefined),
          parsedUrl.pathname
        )
        return
      }
    }

    sendResponse(
      req,
      res,
      isObjectRecord(body) ? body : { access_token: body },
      200
    )
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'OAuth refresh failed.'
    logger('error', 'API', `OAuth refresh failed: ${message}`)
    sendErrorResponse(
      req,
      res,
      500,
      'Internal Server Error',
      message,
      parsedUrl.pathname
    )
  }
}

const youtubeOAuthRoute: ApiRouteModule = {
  handler,
  methods: ['GET', 'POST']
}

export default youtubeOAuthRoute
