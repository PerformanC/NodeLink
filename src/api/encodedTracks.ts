import type {
  ApiNodelinkServer,
  ApiRequest,
  ApiResponse,
  ApiRouteModule,
  ApiSendResponse
} from '../typings/api/api.types.ts'
import type { TrackEncodeInput } from '../typings/utils.types.ts'
import { encodeTrack, logger, sendErrorResponse } from '../utils.ts'

/**
 * Validation message used when the request body is not a non-empty track list.
 */
const INVALID_TRACK_LIST_MESSAGE =
  'tracks parameter must be an array and cannot be empty.'

/**
 * Checks whether a value is a finite number.
 *
 * @param value - Candidate numeric value.
 * @returns `true` when the value is a finite number.
 */
function isFiniteNumber(
  value: number | string | boolean | null | undefined
): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Checks whether a value is a string or `null`.
 *
 * @param value - Candidate value.
 * @returns `true` when the value is a string or `null`.
 */
function isNullableString(
  value: string | number | boolean | null | undefined
): value is string | null {
  return value === null || typeof value === 'string'
}

/**
 * Checks whether a value is a valid details array.
 *
 * @param value - Candidate details value.
 * @returns `true` when the value is an array of strings and `null` items.
 */
function isTrackDetailsList(
  value: Array<string | null> | string | number | boolean | null | undefined
): value is Array<string | null> {
  return (
    Array.isArray(value) &&
    value.every((detail) => detail === null || typeof detail === 'string')
  )
}

/**
 * Validates the shape required by the track encoder utility.
 *
 * @param candidate - Candidate track payload.
 * @returns `true` when the payload satisfies the encoder contract.
 */
function isTrackEncodeInput(
  candidate: Partial<TrackEncodeInput>
): candidate is TrackEncodeInput {
  return (
    typeof candidate.title === 'string' &&
    typeof candidate.author === 'string' &&
    isFiniteNumber(candidate.length) &&
    typeof candidate.identifier === 'string' &&
    typeof candidate.isStream === 'boolean' &&
    isNullableString(candidate.uri) &&
    isNullableString(candidate.artworkUrl) &&
    isNullableString(candidate.isrc) &&
    typeof candidate.sourceName === 'string' &&
    isFiniteNumber(candidate.position) &&
    isTrackDetailsList(candidate.details)
  )
}

/**
 * Extracts a track payload from a body item.
 *
 * For backward compatibility, each array item may be either:
 * - a direct `TrackEncodeInput`
 * - an object containing an `info` field with the track payload
 *
 * @param item - Candidate array item.
 * @returns Valid track payload, or `null` when the item is invalid.
 */
function getTrackFromListItem(
  item: ApiRequest['body']
): TrackEncodeInput | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return null
  }

  const payload = item as Partial<TrackEncodeInput> & {
    info?: Partial<TrackEncodeInput>
  }
  const candidate =
    payload.info &&
    typeof payload.info === 'object' &&
    !Array.isArray(payload.info)
      ? payload.info
      : payload

  return isTrackEncodeInput(candidate) ? candidate : null
}

/**
 * Parses and validates the batch encode request body.
 *
 * @param body - Parsed request body.
 * @returns Valid track payload list, or `null` when validation fails.
 */
function getTrackList(body: ApiRequest['body']): TrackEncodeInput[] | null {
  if (!Array.isArray(body) || body.length === 0) {
    return null
  }

  const tracks: TrackEncodeInput[] = []
  for (const item of body) {
    const track = getTrackFromListItem(item)
    if (!track) {
      return null
    }
    tracks.push(track)
  }

  return tracks
}

/**
 * Encodes a batch of track payloads using the shared utility.
 *
 * @param tracks - Validated track payload list.
 * @returns Encoded track strings in request order.
 */
function encodeTrackBatch(tracks: TrackEncodeInput[]): string[] {
  const encodedTracks: string[] = []

  logger('debug', 'Tracks', `Encoding ${tracks.length} tracks.`)
  for (const track of tracks) {
    encodedTracks.push(encodeTrack(track))
  }

  return encodedTracks
}

/**
 * Handles requests for the batch encode endpoint.
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
  const tracks = getTrackList(req.body)

  if (!tracks) {
    sendErrorResponse(
      req,
      res,
      400,
      'Invalid request',
      INVALID_TRACK_LIST_MESSAGE,
      parsedUrl.pathname,
      true
    )
    return
  }

  try {
    sendResponse(req, res, encodeTrackBatch(tracks), 200)
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Failed to encode track'
    logger(
      'error',
      'Tracks',
      `Failed to encode one or more tracks from a batch of ${tracks.length}.`,
      error
    )
    sendErrorResponse(
      req,
      res,
      500,
      'Failed to encode track',
      errorMessage,
      parsedUrl.pathname,
      true
    )
  }
}

/**
 * Route module definition for the batch encode endpoint.
 */
const encodedTracksRoute: ApiRouteModule = {
  handler,
  methods: ['POST']
}

export default encodedTracksRoute
