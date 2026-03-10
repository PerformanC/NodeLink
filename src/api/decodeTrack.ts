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
 * Default validation message used when the encoded track query parameter is
 * absent or empty.
 */
const MISSING_ENCODED_TRACK_MESSAGE = 'Missing encodedTrack parameter.'

/**
 * Response payload returned by the single-track decode endpoint.
 *
 * The route mirrors the historical API shape, which moves `details` into the
 * `pluginInfo` object instead of returning it as a top-level field.
 */
interface DecodedTrackResponse {
  /**
   * Original base64-encoded track string.
   */
  encoded: EncodedTrackPayload['encoded']

  /**
   * Decoded track information.
   */
  info: EncodedTrackPayload['info']

  /**
   * Plugin metadata plus migrated `details`.
   */
  pluginInfo: EncodedTrackPayload['pluginInfo'] & {
    /**
     * Additional track details extracted from the payload trailer.
     */
    details?: EncodedTrackPayload['details']
  }

  /**
   * User-defined track payload metadata.
   */
  userData: EncodedTrackPayload['userData']

  /**
   * Bit flags stored in the encoded track header.
   */
  messageFlags: EncodedTrackPayload['messageFlags']
}

/**
 * Reads and normalizes the `encodedTrack` query string parameter.
 *
 * Spaces are replaced with `+` to preserve compatibility with clients that
 * accidentally submit URL-decoded base64 strings.
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
 * Builds the serialized decode response expected by the public endpoint.
 *
 * @param decodedTrack - Raw decoded track payload returned by the utility.
 * @returns Route response payload with `details` migrated into `pluginInfo`.
 */
function buildDecodeTrackResponse(
  decodedTrack: EncodedTrackPayload
): DecodedTrackResponse {
  return {
    encoded: decodedTrack.encoded,
    info: decodedTrack.info,
    pluginInfo: {
      ...decodedTrack.pluginInfo,
      ...(decodedTrack.details.length > 0
        ? { details: decodedTrack.details }
        : {})
    },
    userData: decodedTrack.userData,
    messageFlags: decodedTrack.messageFlags
  }
}

/**
 * Handles requests for the single-track decode endpoint.
 *
 * @param _nodelink - Unused NodeLink runtime instance.
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @param sendResponse - Helper responsible for JSON serialization and headers.
 * @param parsedUrl - Parsed request URL.
 * @returns Nothing. The payload is written directly to the response.
 */
function handler(
  _nodelink: ApiNodelinkServer,
  req: ApiRequest,
  res: ApiResponse,
  sendResponse: ApiSendResponse,
  parsedUrl: URL
): void {
  const encodedTrack = getEncodedTrackFromQuery(parsedUrl)

  if (!encodedTrack) {
    sendErrorResponse(
      req,
      res,
      400,
      'Bad Request',
      MISSING_ENCODED_TRACK_MESSAGE,
      parsedUrl.pathname,
      true
    )
    return
  }

  try {
    logger('debug', 'Tracks', `Decoding track: ${encodedTrack}`)
    const decodedTrack = decodeTrack(encodedTrack)
    sendResponse(req, res, buildDecodeTrackResponse(decodedTrack), 200)
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Failed to decode track'
    logger('error', 'Tracks', `Failed to decode track ${encodedTrack}:`, error)
    sendErrorResponse(
      req,
      res,
      500,
      'Failed to decode track',
      errorMessage,
      parsedUrl.pathname,
      true
    )
  }
}

/**
 * Route module definition for the single-track decode endpoint.
 */
const decodeTrackRoute: ApiRouteModule = {
  handler
}

export default decodeTrackRoute
