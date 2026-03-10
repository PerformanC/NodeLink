import type {
  ApiNodelinkServer,
  ApiRequest,
  ApiResponse,
  ApiRouteModule,
  ApiSendResponse
} from '../typings/api/api.types.ts'
import type { Session } from '../typings/index.types.ts'
import type {
  CrossfadeConfig,
  FadingConfig,
  FiltersState,
  PlayerStateJSON,
  PlayerTrack,
  PlayerVoiceState,
  PlayPayload,
  TrackInfoExtended
} from '../typings/playback/player.types.ts'
import type { EncodedTrackPayload } from '../typings/utils.types.ts'
import { decodeTrack, logger, sendErrorResponse } from '../utils.ts'

/**
 * Track payload accepted by the player update route.
 */
interface PlayerTrackUpdateInput {
  /**
   * Encoded track payload, or `null` to clear/stop depending on the field.
   */
  encoded?: string | null

  /**
   * External identifier resolved via `nodelink.loadTrack(...)`.
   */
  identifier?: string

  /**
   * User data attached to the track payload.
   */
  userData?: PlayerTrack['userData']

  /**
   * Explicit audio track identifier override.
   */
  audioTrackId?: string | null

  /**
   * Legacy alias used by some clients for `audioTrackId`.
   */
  language?: string | null
}

/**
 * Body payload accepted by `PATCH /sessions/:id/players/:guildId`.
 */
interface PlayerPatchPayload {
  /**
   * Primary track to play, or encoded `null` to stop playback.
   */
  track?: PlayerTrackUpdateInput

  /**
   * Optional next track to preload, or `null` to clear the preloaded track.
   */
  nextTrack?: PlayerTrackUpdateInput | null

  /**
   * Deprecated legacy encoded track field.
   */
  encodedTrack?: string | null

  /**
   * Target seek position in milliseconds.
   */
  position?: number

  /**
   * Optional playback end time in milliseconds.
   */
  endTime?: number | null

  /**
   * Output volume in the `[0, 1000]` range.
   */
  volume?: number

  /**
   * Pause state toggle.
   */
  paused?: boolean

  /**
   * Loudness normalizer toggle.
   */
  loudnessNormalizer?: boolean

  /**
   * Optional filter payload.
   */
  filters?: FiltersState

  /**
   * Optional fading configuration payload.
   */
  fading?: ApiRequest['body']

  /**
   * Optional crossfade configuration payload.
   */
  crossfade?: ApiRequest['body']

  /**
   * Voice state update payload.
   */
  voice?: Partial<PlayerVoiceState>
}

/**
 * Raw voice payload before validation.
 */
interface PlayerVoicePayloadInput {
  /**
   * Voice token issued by Discord.
   */
  token?: string | null

  /**
   * Voice endpoint hostname.
   */
  endpoint?: string | null

  /**
   * Voice session identifier.
   */
  sessionId?: string | null

  /**
   * Optional target voice channel identifier.
   */
  channelId?: string | null
}

/**
 * Raw track update payload before validation.
 */
interface PlayerTrackUpdateBodyInput {
  /**
   * Candidate encoded track value.
   */
  encoded?: string | null

  /**
   * Candidate external identifier.
   */
  identifier?: string

  /**
   * Candidate user data payload.
   */
  userData?: PlayerTrack['userData']

  /**
   * Candidate audio track identifier.
   */
  audioTrackId?: string | null

  /**
   * Candidate language alias for the track selection.
   */
  language?: string | null
}

/**
 * Raw player patch payload before validation.
 */
interface PlayerPatchBodyInput {
  /**
   * Candidate primary track payload.
   */
  track?: ApiRequest['body']

  /**
   * Candidate next-track payload.
   */
  nextTrack?: ApiRequest['body'] | null

  /**
   * Candidate legacy encoded-track field.
   */
  encodedTrack?: string | null

  /**
   * Candidate seek position.
   */
  position?: number

  /**
   * Candidate playback end time.
   */
  endTime?: number | null

  /**
   * Candidate volume value.
   */
  volume?: number

  /**
   * Candidate pause toggle.
   */
  paused?: boolean

  /**
   * Candidate loudness normalizer toggle.
   */
  loudnessNormalizer?: boolean

  /**
   * Candidate filters payload.
   */
  filters?: ApiRequest['body']

  /**
   * Candidate fading payload.
   */
  fading?: ApiRequest['body']

  /**
   * Candidate crossfade payload.
   */
  crossfade?: ApiRequest['body']

  /**
   * Candidate voice payload.
   */
  voice?: ApiRequest['body']
}

/**
 * Raw fading section payload before validation.
 */
interface FadingSectionInput {
  /**
   * Candidate section duration.
   */
  duration?: number

  /**
   * Candidate section curve.
   */
  curve?: string

  /**
   * Candidate section effect type.
   */
  type?: string
}

/**
 * Raw fading payload before validation.
 */
interface FadingConfigInput {
  /**
   * Candidate master enable toggle.
   */
  enabled?: boolean

  /**
   * Candidate section payloads.
   */
  trackStart?: FadingSectionInput
  trackEnd?: FadingSectionInput
  trackStop?: FadingSectionInput
  seek?: FadingSectionInput
  pause?: FadingSectionInput
  resume?: FadingSectionInput
}

/**
 * Raw crossfade payload before validation.
 */
interface CrossfadeConfigInput {
  /**
   * Candidate master enable toggle.
   */
  enabled?: boolean

  /**
   * Candidate crossfade duration.
   */
  duration?: number

  /**
   * Candidate curve name.
   */
  curve?: string

  /**
   * Candidate crossfade mode.
   */
  mode?: string

  /**
   * Candidate preload buffer floor.
   */
  minBufferMs?: number

  /**
   * Candidate active buffer size.
   */
  bufferMs?: number

  /**
   * Candidate immediate trigger flag.
   */
  triggerNow?: boolean
}

/**
 * Query parameters accepted by the player patch route.
 */
interface PlayerPatchQuery {
  /**
   * Whether playback should refuse replacing an active track.
   */
  noReplace?: boolean
}

/**
 * Runtime response returned by `nodelink.loadTrack(...)`.
 */
interface LoadedTrackResult {
  /**
   * Loader result kind.
   */
  loadType: 'track' | 'empty' | string

  /**
   * Payload returned when `loadType === "track"`.
   */
  data: {
    /**
     * Encoded track string.
     */
    encoded: string

    /**
     * Normalized track information.
     */
    info: TrackInfoExtended
  }
}

/**
 * Minimal managed player shape required for session-wide player listing.
 */
interface SessionPlayerEntry {
  /**
   * Guild identifier associated with the player.
   */
  guildId: string
}

/**
 * Local player handle used for manual crossfade triggering.
 */
interface TriggerablePlayerHandle {
  /**
   * Triggers a crossfade immediately.
   *
   * @param durationMs - Optional crossfade duration override.
   * @returns Promise resolving to `true` when the trigger was accepted.
   */
  triggerCrossfade?: (durationMs?: number) => Promise<boolean>
}

/**
 * Runtime player manager contract required by the player route.
 */
interface PlayersRoutePlayerManager {
  /**
   * Registry of players for the current session.
   */
  players: Map<string, SessionPlayerEntry>

  /**
   * Retrieves a player handle by guild identifier.
   *
   * @param guildId - Target guild identifier.
   * @returns Player handle or `undefined`.
   */
  get: (guildId: string) => TriggerablePlayerHandle | undefined

  /**
   * Creates or returns the player for a guild.
   *
   * @param guildId - Target guild identifier.
   * @param voice - Optional initial voice state.
   * @returns Promise resolving once the player exists.
   */
  create: (
    guildId: string,
    voice?: Partial<PlayerVoiceState>
  ) => Promise<object>

  /**
   * Destroys the player for a guild.
   *
   * @param guildId - Target guild identifier.
   * @returns Promise resolving once the player is destroyed.
   */
  destroy: (guildId: string) => Promise<void>

  /**
   * Starts playback for the provided track payload.
   *
   * @param guildId - Target guild identifier.
   * @param trackPayload - Playback payload.
   * @returns Promise resolving once the command is applied.
   */
  play: (
    guildId: string,
    trackPayload: PlayPayload
  ) => Promise<boolean | object>

  /**
   * Preloads the provided track payload.
   *
   * @param guildId - Target guild identifier.
   * @param trackPayload - Track payload to preload.
   * @returns Promise resolving once the command is applied.
   */
  preload: (
    guildId: string,
    trackPayload: PlayerTrack
  ) => Promise<boolean | object>

  /**
   * Clears the preloaded next track.
   *
   * @param guildId - Target guild identifier.
   * @returns Promise resolving once the command is applied.
   */
  clearNextTrack: (guildId: string) => Promise<boolean | object>

  /**
   * Stops playback.
   *
   * @param guildId - Target guild identifier.
   * @returns Promise resolving once the command is applied.
   */
  stop: (guildId: string) => Promise<boolean | object>

  /**
   * Pauses or resumes playback.
   *
   * @param guildId - Target guild identifier.
   * @param shouldPause - Desired pause state.
   * @returns Promise resolving once the command is applied.
   */
  pause: (guildId: string, shouldPause: boolean) => Promise<boolean | object>

  /**
   * Seeks playback.
   *
   * @param guildId - Target guild identifier.
   * @param position - Optional target position in milliseconds.
   * @param endTime - Optional end time in milliseconds.
   * @returns Promise resolving once the command is applied.
   */
  seek: (
    guildId: string,
    position?: number,
    endTime?: number
  ) => Promise<boolean | object>

  /**
   * Updates player volume.
   *
   * @param guildId - Target guild identifier.
   * @param level - New volume.
   * @returns Promise resolving once the command is applied.
   */
  volume: (guildId: string, level: number) => Promise<boolean | object>

  /**
   * Applies filter configuration.
   *
   * @param guildId - Target guild identifier.
   * @param filtersPayload - Sanitized filter payload.
   * @returns Promise resolving once the command is applied.
   */
  setFilters: (
    guildId: string,
    filtersPayload: FiltersState
  ) => Promise<boolean | object>

  /**
   * Applies fading configuration.
   *
   * @param guildId - Target guild identifier.
   * @param fadingConfig - Sanitized fading configuration.
   * @returns Promise resolving once the command is applied.
   */
  setFading: (
    guildId: string,
    fadingConfig?: FadingConfig
  ) => Promise<boolean | object>

  /**
   * Applies crossfade configuration.
   *
   * @param guildId - Target guild identifier.
   * @param crossfadeConfig - Sanitized crossfade configuration.
   * @returns Promise resolving once the command is applied.
   */
  setCrossfade: (
    guildId: string,
    crossfadeConfig?: CrossfadeConfig
  ) => Promise<boolean | object>

  /**
   * Toggles loudness normalization.
   *
   * @param guildId - Target guild identifier.
   * @param enabled - Whether loudness normalization should be enabled.
   * @returns Promise resolving once the command is applied.
   */
  setLoudnessNormalizer: (
    guildId: string,
    enabled: boolean
  ) => Promise<boolean | object>

  /**
   * Updates voice state.
   *
   * @param guildId - Target guild identifier.
   * @param voicePayload - Partial voice state payload.
   * @returns Promise resolving once the command is applied.
   */
  updateVoice: (
    guildId: string,
    voicePayload: Partial<PlayerVoiceState>
  ) => Promise<object | undefined>

  /**
   * Serializes player state.
   *
   * @param guildId - Target guild identifier.
   * @returns Promise resolving to the player JSON payload.
   */
  toJSON: (guildId: string) => Promise<PlayerStateJSON>
}

/**
 * Session contract required by the player route.
 */
type PlayersRouteSession = Omit<Session, 'players'> & {
  /**
   * Player manager instance for the session.
   */
  players: PlayersRoutePlayerManager
}

/**
 * Worker manager contract required for cluster player listing.
 */
interface PlayersRouteWorkerManager {
  /**
   * Map of `{sessionId}:{guildId}` keys to worker identifiers.
   */
  guildToWorker: Map<string, number>
}

/**
 * Runtime contract required by the player route.
 */
interface PlayersRouteRuntime extends ApiNodelinkServer {
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
    get: (id: string) => PlayersRouteSession | undefined
  }

  /**
   * Optional worker manager used for session-wide player listing.
   */
  workerManager: PlayersRouteWorkerManager | null

  /**
   * Optional track loader used by identifier-based play/preload payloads.
   */
  loadTrack?: (identifier: string) => Promise<LoadedTrackResult>
}

/**
 * Path parameters extracted from the dynamic route.
 */
interface PlayersRoutePathParams {
  /**
   * Session identifier.
   */
  sessionId: string

  /**
   * Optional guild identifier.
   */
  guildId?: string
}

/**
 * Sanitized crossfade configuration including the route-only `triggerNow` flag.
 */
interface SanitizedCrossfadeConfig extends CrossfadeConfig {
  /**
   * Whether the route should trigger the crossfade immediately after applying
   * the configuration.
   */
  triggerNow: boolean
}

/**
 * Validates that a value is a non-array object.
 *
 * @param value - Candidate object value.
 * @returns `true` when the value is a plain object-like value.
 */
function isObjectRecord(
  value: ApiRequest['body']
): value is Record<
  string,
  object | string | number | boolean | null | undefined
> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Builds a strongly typed runtime view for the player route.
 *
 * @param nodelink - Router-facing runtime instance.
 * @returns Runtime compatible with the route, or `null` when the required
 * session manager field is unavailable.
 */
function getPlayersRouteRuntime(
  nodelink: ApiNodelinkServer
): PlayersRouteRuntime | null {
  const runtime = nodelink as ApiNodelinkServer & Partial<PlayersRouteRuntime>

  if (
    !runtime.sessions ||
    typeof runtime.sessions.get !== 'function' ||
    runtime.workerManager === undefined
  ) {
    return null
  }

  return runtime as PlayersRouteRuntime
}

/**
 * Extracts and validates the dynamic route parameters.
 *
 * @param parsedUrl - Parsed request URL.
 * @returns Validated path parameters, or `null` when validation fails.
 */
function getPathParams(parsedUrl: URL): PlayersRoutePathParams | null {
  const parts = parsedUrl.pathname.split('/')
  const sessionId = parts[3]
  const guildId = parts[5]

  if (!sessionId) {
    return null
  }

  if (guildId !== undefined && guildId !== '' && !/^\d{17,20}$/.test(guildId)) {
    return null
  }

  return guildId
    ? { sessionId, guildId }
    : {
        sessionId
      }
}

/**
 * Parses the `noReplace` query parameter.
 *
 * @param parsedUrl - Parsed request URL.
 * @returns Parsed query state, or `null` when the query value is invalid.
 */
function getQueryParams(parsedUrl: URL): PlayerPatchQuery | null {
  const noReplaceRaw = parsedUrl.searchParams.get('noReplace')

  if (noReplaceRaw === null) {
    return {}
  }

  if (noReplaceRaw === 'true') {
    return { noReplace: true }
  }

  if (noReplaceRaw === 'false') {
    return { noReplace: false }
  }

  return null
}

/**
 * Parses and validates a voice state payload.
 *
 * @param value - Candidate voice payload.
 * @returns Valid voice payload, or `null` when validation fails.
 */
function getVoicePayload(
  value: ApiRequest['body']
): Partial<PlayerVoiceState> | null {
  if (!isObjectRecord(value)) {
    return null
  }

  const payload = value as PlayerVoicePayloadInput
  const { token, endpoint, sessionId, channelId } = payload

  if (typeof token !== 'string' || token.length === 0) {
    return null
  }

  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    return null
  }

  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return null
  }

  if (
    channelId !== undefined &&
    channelId !== null &&
    typeof channelId !== 'string'
  ) {
    return null
  }

  return {
    token,
    endpoint,
    sessionId,
    channelId: typeof channelId === 'string' ? channelId : undefined
  }
}

/**
 * Parses and validates a track update payload.
 *
 * @param value - Candidate track payload.
 * @param allowNullEncoded - Whether `encoded: null` is accepted.
 * @returns Valid track payload, `undefined` when absent, or `null` when invalid.
 */
function getTrackUpdateInput(
  value: ApiRequest['body'],
  allowNullEncoded: boolean
): PlayerTrackUpdateInput | undefined | null {
  if (value === undefined) {
    return undefined
  }

  if (value === null) {
    return allowNullEncoded ? undefined : null
  }

  if (!isObjectRecord(value)) {
    return null
  }

  const payload = value as PlayerTrackUpdateBodyInput
  const { encoded, identifier, userData, audioTrackId, language } = payload

  if (
    encoded !== undefined &&
    encoded !== null &&
    typeof encoded !== 'string'
  ) {
    return null
  }

  if (encoded === null && !allowNullEncoded) {
    return null
  }

  if (identifier !== undefined && typeof identifier !== 'string') {
    return null
  }

  if (
    audioTrackId !== undefined &&
    audioTrackId !== null &&
    typeof audioTrackId !== 'string'
  ) {
    return null
  }

  if (
    language !== undefined &&
    language !== null &&
    typeof language !== 'string'
  ) {
    return null
  }

  return {
    encoded: encoded as string | null | undefined,
    identifier: typeof identifier === 'string' ? identifier : undefined,
    userData,
    audioTrackId: typeof audioTrackId === 'string' ? audioTrackId : undefined,
    language: typeof language === 'string' ? language : undefined
  }
}

/**
 * Parses and validates the player patch payload.
 *
 * @param body - Parsed request body.
 * @returns Valid payload object, or `null` when validation fails.
 */
function getPlayerPatchPayload(
  body: ApiRequest['body']
): PlayerPatchPayload | null {
  if (!isObjectRecord(body)) {
    return null
  }

  const payload = body as PlayerPatchBodyInput

  const track = getTrackUpdateInput(payload.track, true)
  if (track === null) {
    return null
  }

  let nextTrack: PlayerTrackUpdateInput | null | undefined
  if (payload.nextTrack === null) {
    nextTrack = null
  } else {
    const parsedNextTrack = getTrackUpdateInput(payload.nextTrack, true)
    if (parsedNextTrack === null) {
      return null
    }
    nextTrack = parsedNextTrack
  }

  const encodedTrack = payload.encodedTrack
  if (
    encodedTrack !== undefined &&
    encodedTrack !== null &&
    typeof encodedTrack !== 'string'
  ) {
    return null
  }

  const position = payload.position
  if (
    position !== undefined &&
    (typeof position !== 'number' || !Number.isFinite(position) || position < 0)
  ) {
    return null
  }

  const endTime = payload.endTime
  if (
    endTime !== undefined &&
    endTime !== null &&
    (typeof endTime !== 'number' || !Number.isFinite(endTime) || endTime < 0)
  ) {
    return null
  }

  const volume = payload.volume
  if (
    volume !== undefined &&
    (typeof volume !== 'number' ||
      !Number.isFinite(volume) ||
      volume < 0 ||
      volume > 1000)
  ) {
    return null
  }

  const paused = payload.paused
  if (paused !== undefined && typeof paused !== 'boolean') {
    return null
  }

  const loudnessNormalizer = payload.loudnessNormalizer
  if (
    loudnessNormalizer !== undefined &&
    typeof loudnessNormalizer !== 'boolean'
  ) {
    return null
  }

  const filtersValue = payload.filters
  if (
    filtersValue !== undefined &&
    (!filtersValue ||
      typeof filtersValue !== 'object' ||
      Array.isArray(filtersValue))
  ) {
    return null
  }

  const fading = payload.fading
  if (
    fading !== undefined &&
    (!fading || typeof fading !== 'object' || Array.isArray(fading))
  ) {
    return null
  }

  const crossfade = payload.crossfade
  if (
    crossfade !== undefined &&
    (!crossfade || typeof crossfade !== 'object' || Array.isArray(crossfade))
  ) {
    return null
  }

  const voice =
    payload.voice === undefined ? undefined : getVoicePayload(payload.voice)
  if (payload.voice !== undefined && !voice) {
    return null
  }

  return {
    track,
    nextTrack,
    encodedTrack:
      typeof encodedTrack === 'string'
        ? encodedTrack
        : encodedTrack === null
          ? null
          : undefined,
    position,
    endTime:
      typeof endTime === 'number'
        ? endTime
        : endTime === null
          ? null
          : undefined,
    volume,
    paused,
    loudnessNormalizer,
    filters: filtersValue as FiltersState | undefined,
    fading,
    crossfade,
    voice: voice ?? undefined
  }
}

/**
 * Sanitizes the fading configuration to the runtime-supported shape.
 *
 * @param raw - Raw fading payload.
 * @returns Safe fading configuration object.
 */
function sanitizeFadingConfig(raw: ApiRequest['body']): FadingConfig {
  const safe: FadingConfig = {
    enabled: false,
    trackStart: { duration: 0, curve: 'linear', type: 'volume' },
    trackEnd: { duration: 0, curve: 'linear', type: 'volume' },
    trackStop: { duration: 0, curve: 'linear', type: 'volume' },
    seek: { duration: 0, curve: 'linear', type: 'volume' },
    pause: { duration: 0, curve: 'linear', type: 'volume' },
    resume: { duration: 0, curve: 'linear', type: 'volume' }
  }

  if (!isObjectRecord(raw)) {
    return safe
  }

  const payload = raw as FadingConfigInput
  safe.enabled = payload.enabled === true

  const updateSection = (
    key: keyof Pick<
      NonNullable<FadingConfig>,
      'trackStart' | 'trackEnd' | 'trackStop' | 'seek' | 'pause' | 'resume'
    >
  ): void => {
    const section = payload[key]
    const target = safe[key]
    if (!isObjectRecord(section) || !target) {
      return
    }

    const typedSection = section as FadingSectionInput
    const { duration, curve, type } = typedSection
    if (typeof duration === 'number' && Number.isFinite(duration)) {
      target.duration = Math.max(0, duration)
    }

    if (typeof curve === 'string') {
      target.curve = curve
    }

    if (
      type === 'volume' ||
      type === 'tape' ||
      type === 'scratch' ||
      type === 'both'
    ) {
      target.type = type
    }
  }

  updateSection('trackStart')
  updateSection('trackEnd')
  updateSection('trackStop')
  updateSection('seek')
  updateSection('pause')
  updateSection('resume')

  return safe
}

/**
 * Sanitizes the crossfade configuration to the runtime-supported shape.
 *
 * @param raw - Raw crossfade payload.
 * @returns Safe crossfade configuration object plus the route-only
 * `triggerNow` flag.
 */
function sanitizeCrossfadeConfig(
  raw: ApiRequest['body']
): SanitizedCrossfadeConfig {
  const safe: SanitizedCrossfadeConfig = {
    enabled: false,
    duration: 0,
    curve: 'sinusoidal',
    mode: 'preload',
    minBufferMs: 250,
    bufferMs: 0,
    triggerNow: false
  }

  if (!isObjectRecord(raw)) {
    return safe
  }

  const payload = raw as CrossfadeConfigInput
  safe.enabled = payload.enabled === true

  const duration = payload.duration
  if (typeof duration === 'number' && Number.isFinite(duration)) {
    safe.duration = Math.max(0, duration)
  }

  const curve = payload.curve
  if (typeof curve === 'string') {
    safe.curve = curve as CrossfadeConfig['curve']
  }

  const mode = payload.mode
  if (mode === 'stream' || mode === 'preload') {
    safe.mode = mode
  }

  const minBufferMs = payload.minBufferMs
  if (typeof minBufferMs === 'number' && Number.isFinite(minBufferMs)) {
    safe.minBufferMs = Math.max(0, minBufferMs)
  }

  const bufferMs = payload.bufferMs
  if (typeof bufferMs === 'number' && Number.isFinite(bufferMs)) {
    safe.bufferMs = Math.max(0, bufferMs)
  }

  safe.triggerNow = payload.triggerNow === true
  return safe
}

/**
 * Normalizes decoded track info into the stricter `TrackInfoExtended` shape
 * required by the player runtime.
 *
 * @param decodedTrack - Decoded track payload.
 * @returns Normalized track information.
 */
function normalizeTrackInfo(
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
 * Resolves the optional audio track identifier override.
 *
 * @param trackPayload - Track update payload.
 * @returns Audio track identifier or `undefined` when absent.
 */
function getAudioTrackId(
  trackPayload: PlayerTrackUpdateInput
): string | undefined {
  return trackPayload.language ?? trackPayload.audioTrackId ?? undefined
}

/**
 * Resolves a track update payload into a playable `PlayPayload`.
 *
 * @param nodelink - Players route runtime.
 * @param trackPayload - Track update payload.
 * @returns Resolved play payload, `null` when the track should stop playback,
 * or `undefined` when no track operation should occur.
 */
async function resolvePlayPayload(
  nodelink: PlayersRouteRuntime,
  trackPayload: PlayerTrackUpdateInput | undefined
): Promise<PlayPayload | null | undefined> {
  if (!trackPayload) {
    return undefined
  }

  if (trackPayload.encoded !== undefined) {
    if (trackPayload.encoded === null) {
      return null
    }

    const decodedTrack = decodeTrack(trackPayload.encoded.replace(/ /g, '+'))
    return {
      encoded: decodedTrack.encoded,
      info: normalizeTrackInfo(decodedTrack),
      audioTrackId: getAudioTrackId(trackPayload)
    }
  }

  if (trackPayload.identifier) {
    if (!nodelink.loadTrack) {
      throw new Error('Track identifier loading is not supported.')
    }

    const loadResult = await nodelink.loadTrack(trackPayload.identifier)
    if (loadResult.loadType !== 'track') {
      if (loadResult.loadType === 'empty') {
        throw new Error('Track identifier resolved to no tracks.')
      }

      throw new Error(
        `Track identifier resolved to ${loadResult.loadType}, expected 'track'.`
      )
    }

    return {
      encoded: loadResult.data.encoded,
      info: loadResult.data.info,
      audioTrackId: getAudioTrackId(trackPayload)
    }
  }

  return undefined
}

/**
 * Resolves a track update payload into a preloadable `PlayerTrack`.
 *
 * @param nodelink - Players route runtime.
 * @param trackPayload - Track update payload.
 * @returns Resolved player track payload, or `undefined` when no preload
 * should occur.
 */
async function resolvePreloadPayload(
  nodelink: PlayersRouteRuntime,
  trackPayload: PlayerTrackUpdateInput | undefined
): Promise<PlayerTrack | undefined> {
  if (!trackPayload) {
    return undefined
  }

  if (trackPayload.encoded !== undefined) {
    if (trackPayload.encoded === null) {
      return undefined
    }

    const decodedTrack = decodeTrack(trackPayload.encoded.replace(/ /g, '+'))
    return {
      encoded: decodedTrack.encoded,
      info: normalizeTrackInfo(decodedTrack),
      audioTrackId: getAudioTrackId(trackPayload),
      userData: trackPayload.userData
    }
  }

  if (trackPayload.identifier && nodelink.loadTrack) {
    const loadResult = await nodelink.loadTrack(trackPayload.identifier)
    if (loadResult.loadType === 'track') {
      return {
        encoded: loadResult.data.encoded,
        info: loadResult.data.info,
        audioTrackId: getAudioTrackId(trackPayload),
        userData: trackPayload.userData
      }
    }
  }

  return undefined
}

/**
 * Handles `GET /sessions/:id/players`.
 *
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @param session - Target session.
 * @param runtime - Players route runtime.
 * @param sendResponse - Helper responsible for JSON serialization and headers.
 * @returns Promise that resolves once the response has been written.
 */
async function handlePlayerListRequest(
  req: ApiRequest,
  res: ApiResponse,
  session: PlayersRouteSession,
  runtime: PlayersRouteRuntime,
  sendResponse: ApiSendResponse
): Promise<void> {
  if (runtime.workerManager) {
    const playerKeys = Array.from(runtime.workerManager.guildToWorker.keys())
    const sessionPlayerKeys = playerKeys.filter((key) =>
      key.startsWith(`${session.id}:`)
    )
    const guildIds = sessionPlayerKeys
      .map((key) => key.split(':')[1])
      .filter((guildId): guildId is string => typeof guildId === 'string')

    const players = await Promise.all(
      guildIds.map(async (guildId) => {
        try {
          return await session.players.toJSON(guildId)
        } catch (error) {
          const errorMessage =
            error instanceof Error
              ? error.message
              : 'Unknown player listing error'
          logger(
            'error',
            'PlayerList',
            `Failed to get player JSON for guild ${guildId}: ${errorMessage}`
          )
          return null
        }
      })
    )

    sendResponse(
      req,
      res,
      players.filter(
        (playerJson): playerJson is PlayerStateJSON => playerJson !== null
      ),
      200
    )
    return
  }

  const players = await Promise.all(
    Array.from(session.players.players.values()).map((player) =>
      session.players.toJSON(player.guildId)
    )
  )
  sendResponse(req, res, players, 200)
}

/**
 * Applies a player patch payload to the target guild player.
 *
 * @param runtime - Players route runtime.
 * @param session - Target session.
 * @param guildId - Target guild identifier.
 * @param payload - Validated patch payload.
 * @param query - Validated query parameters.
 * @returns Promise resolving to the updated player JSON payload.
 */
async function applyPlayerPatch(
  runtime: PlayersRouteRuntime,
  session: PlayersRouteSession,
  guildId: string,
  payload: PlayerPatchPayload,
  query: PlayerPatchQuery
): Promise<PlayerStateJSON> {
  await session.players.create(guildId)

  if (payload.voice) {
    await session.players.updateVoice(guildId, payload.voice)
  }

  if (payload.encodedTrack) {
    throw new Error(
      'The `encodedTrack` field is deprecated. Use `track.encoded` instead.'
    )
  }

  const trackToPlay = await resolvePlayPayload(runtime, payload.track)
  const stopPlayer = trackToPlay === null
  const shouldClearNextTrack =
    payload.nextTrack === null || payload.nextTrack?.encoded === null

  if (shouldClearNextTrack) {
    await session.players.clearNextTrack(guildId)
  } else if (payload.nextTrack) {
    const trackToPreload = await resolvePreloadPayload(
      runtime,
      payload.nextTrack
    )
    if (trackToPreload) {
      await session.players.preload(guildId, trackToPreload)
    }
  }

  if (stopPlayer) {
    await session.players.stop(guildId)
  }

  if (trackToPlay && trackToPlay !== null) {
    await session.players.play(guildId, {
      ...trackToPlay,
      userData: payload.track?.userData,
      noReplace: query.noReplace,
      startTime: payload.position,
      endTime: payload.endTime ?? undefined
    })
  }

  if (payload.volume !== undefined) {
    await session.players.volume(guildId, payload.volume)
  }

  if (payload.paused !== undefined) {
    await session.players.pause(guildId, payload.paused)
  }

  if (payload.position !== undefined && !trackToPlay) {
    await session.players.seek(guildId, payload.position)
  }

  if (payload.endTime !== undefined) {
    const playerState = await session.players.toJSON(guildId)
    await session.players.seek(
      guildId,
      playerState.state.position,
      payload.endTime ?? undefined
    )
  }

  if (payload.filters !== undefined) {
    await session.players.setFilters(guildId, payload.filters)
  }

  if (payload.fading !== undefined) {
    await session.players.setFading(
      guildId,
      sanitizeFadingConfig(payload.fading)
    )
  }

  if (payload.crossfade !== undefined) {
    const sanitizedCrossfade = sanitizeCrossfadeConfig(payload.crossfade)
    await session.players.setCrossfade(guildId, sanitizedCrossfade)

    if (sanitizedCrossfade.triggerNow) {
      const player = session.players.get(guildId)
      if (player?.triggerCrossfade) {
        const duration =
          typeof sanitizedCrossfade.duration === 'number' &&
          Number.isFinite(sanitizedCrossfade.duration)
            ? sanitizedCrossfade.duration
            : undefined
        await player.triggerCrossfade(duration)
      }
    }
  }

  if (payload.loudnessNormalizer !== undefined) {
    await session.players.setLoudnessNormalizer(
      guildId,
      payload.loudnessNormalizer
    )
  }

  return await session.players.toJSON(guildId)
}

/**
 * Handles requests for the players route.
 *
 * Supports:
 * - `GET /sessions/:id/players` to list players for a session
 * - `GET /sessions/:id/players/:guildId` to get player state
 * - `DELETE /sessions/:id/players/:guildId` to destroy a player
 * - `PATCH /sessions/:id/players/:guildId` to update player state
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
  const runtime = getPlayersRouteRuntime(nodelink)
  if (!runtime) {
    sendErrorResponse(
      req,
      res,
      500,
      'Internal Server Error',
      'Players runtime contract is incomplete.',
      parsedUrl.pathname,
      true
    )
    return
  }

  const pathParams = getPathParams(parsedUrl)
  if (!pathParams) {
    const errorMessage = 'Invalid path parameters'
    logger('warn', 'PlayerUpdate', `Invalid path parameters: ${errorMessage}`)
    sendErrorResponse(
      req,
      res,
      400,
      'Bad Request',
      errorMessage,
      parsedUrl.pathname
    )
    return
  }

  const session = runtime.sessions.get(pathParams.sessionId)
  if (!session) {
    sendErrorResponse(
      req,
      res,
      404,
      'Not Found',
      "The provided sessionId doesn't exist.",
      parsedUrl.pathname
    )
    return
  }

  if (!pathParams.guildId) {
    if (req.method === 'GET') {
      await handlePlayerListRequest(req, res, session, runtime, sendResponse)
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
    return
  }

  try {
    if (req.method === 'GET') {
      await session.players.create(pathParams.guildId)
      sendResponse(
        req,
        res,
        await session.players.toJSON(pathParams.guildId),
        200
      )
      return
    }

    if (req.method === 'DELETE') {
      await session.players.destroy(pathParams.guildId)
      sendResponse(req, res, null, 204)
      return
    }

    if (req.method === 'PATCH') {
      const payload = getPlayerPatchPayload(req.body)
      if (!payload) {
        const errorMessage = 'Invalid payload'
        logger(
          'warn',
          'PlayerUpdate',
          `Invalid payload for guild ${pathParams.guildId}: ${errorMessage}`
        )
        sendErrorResponse(
          req,
          res,
          400,
          'Bad Request',
          errorMessage,
          parsedUrl.pathname
        )
        return
      }

      const query = getQueryParams(parsedUrl)
      if (!query) {
        sendErrorResponse(
          req,
          res,
          400,
          'Bad Request',
          'Invalid query parameters',
          parsedUrl.pathname
        )
        return
      }

      const playerJson = await applyPlayerPatch(
        runtime,
        session,
        pathParams.guildId,
        payload,
        query
      )
      sendResponse(req, res, playerJson, 200)
      return
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unhandled player error'

    if (
      errorMessage.toLowerCase().includes('player not found') ||
      errorMessage.toLowerCase().includes('player not assigned')
    ) {
      sendErrorResponse(
        req,
        res,
        404,
        'Not Found',
        errorMessage,
        parsedUrl.pathname
      )
      return
    }

    logger('error', 'PlayerUpdate', `Unhandled error: ${errorMessage}`, error)
    sendErrorResponse(
      req,
      res,
      500,
      'Internal Server Error',
      errorMessage,
      parsedUrl.pathname,
      true
    )
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
 * Route module definition for the player route.
 */
const playersRoute: ApiRouteModule = {
  handler,
  methods: ['GET', 'DELETE', 'PATCH']
}

export default playersRoute
