import type { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream'
import type {
  ApiNodelinkServer,
  ApiRequest,
  ApiResponse,
  ApiRouteModule,
  ApiSendResponse
} from '../typings/api/api.types.ts'
import type {
  AudioResource,
  FiltersState,
  LyricsManagerLike
} from '../typings/playback/player.types.ts'
import type {
  TrackInfo,
  TrackStreamResult,
  TrackUrlResult
} from '../typings/sources/source.types.ts'
import type { EncodedTrackPayload } from '../typings/utils.types.ts'
import { decodeTrack, logger, sendErrorResponse } from '../utils.ts'

/**
 * Cached dynamic import for the stream processor module.
 */
let streamProcessorModulePromise: Promise<StreamProcessorModule> | null = null

/**
 * Default headers returned by the raw PCM stream endpoint.
 */
const LOAD_STREAM_HEADERS = {
  'Content-Type': 'audio/l16;rate=48000;channels=2',
  'Transfer-Encoding': 'chunked',
  Connection: 'keep-alive'
} as const

/**
 * Request payload accepted by the load stream endpoint.
 */
interface LoadStreamInput {
  /**
   * Base64-encoded track payload.
   */
  encodedTrack: string

  /**
   * Playback volume as a percent value where `100` equals unity gain.
   */
  volume: number

  /**
   * Start position in milliseconds.
   */
  position: number

  /**
   * Optional filter state applied before streaming PCM to the client.
   */
  filters: FiltersState
}

/**
 * Body payload shape accepted by `POST /loadStream`.
 */
interface LoadStreamBodyPayload {
  /**
   * Base64-encoded track payload.
   */
  encodedTrack?: string

  /**
   * Playback volume as a percent value.
   */
  volume?: number

  /**
   * Start position in milliseconds.
   */
  position?: number

  /**
   * Optional filter state.
   */
  filters?: FiltersState
}

/**
 * Headers/options supported by delegated streaming operations.
 */
interface StreamDelegateOptions {
  /**
   * Optional status code to send before the delegated stream starts.
   */
  statusCode?: number

  /**
   * Optional response headers written before the delegated stream starts.
   */
  headers?: Record<string, string>
}

/**
 * Minimal source worker manager contract required by the endpoint.
 */
interface LoadStreamSourceWorkerManager {
  /**
   * Delegates the request to a source worker when available.
   *
   * @param req - Incoming HTTP request.
   * @param res - Outgoing HTTP response.
   * @param task - Delegated task name.
   * @param payload - Serialized task payload.
   * @param options - Stream response options applied before delegation.
   * @returns `true` when the request has been delegated.
   */
  delegate: (
    req: ApiRequest,
    res: ApiResponse,
    task: 'loadStream',
    payload: {
      decodedTrackInfo: EncodedTrackPayload['info']
      volume: number
      position: number
      filters: FiltersState
    },
    options?: StreamDelegateOptions
  ) => boolean
}

/**
 * Opaque worker reference used by the playback worker manager.
 */
type LoadStreamWorkerReference = object

/**
 * Minimal playback worker manager contract required by the endpoint.
 */
interface LoadStreamWorkerManager {
  /**
   * Delegates a raw PCM stream request to a playback worker.
   *
   * @param req - Incoming HTTP request.
   * @param res - Outgoing HTTP response.
   * @param payload - Serialized stream payload.
   * @param options - Stream response options applied before delegation.
   * @returns `true` when the request has been delegated.
   */
  delegateStream: (
    req: ApiRequest,
    res: ApiResponse,
    payload: {
      decodedTrackInfo: EncodedTrackPayload['info']
      volume: number
      position: number
      filters: FiltersState
    },
    options?: StreamDelegateOptions
  ) => boolean

  /**
   * Returns the best available playback worker.
   *
   * @returns Worker reference used for command execution.
   */
  getBestWorker: () => LoadStreamWorkerReference

  /**
   * Executes track URL resolution on a playback worker.
   *
   * @param worker - Target worker reference.
   * @param task - Worker command name.
   * @param payload - Serialized command payload.
   * @returns Promise resolving to the track URL response.
   */
  execute: (
    worker: LoadStreamWorkerReference,
    task: 'getTrackUrl',
    payload: {
      decodedTrackInfo: EncodedTrackPayload['info']
    }
  ) => Promise<TrackUrlResult>
}

/**
 * Minimal source manager contract required by the endpoint.
 */
interface LoadStreamSourceManager {
  /**
   * Resolves the track URL for a decoded track.
   *
   * @param trackInfo - Decoded track information.
   * @returns Promise resolving to the track URL response.
   */
  getTrackUrl: (
    trackInfo: EncodedTrackPayload['info']
  ) => Promise<TrackUrlResult>

  /**
   * Fetches the source stream for a resolved track URL.
   *
   * @param trackInfo - Decoded track information.
   * @param url - Resolved source URL.
   * @param protocol - Resolved transport protocol.
   * @param additionalData - Additional source-specific metadata.
   * @returns Promise resolving to the fetched track stream.
   */
  getTrackStream: (
    trackInfo: EncodedTrackPayload['info'] | TrackInfo,
    url: string,
    protocol?: string,
    additionalData?: TrackUrlResult['additionalData']
  ) => Promise<TrackStreamResult>

  /**
   * Returns the source instance for a given source name.
   *
   * @param name - Source identifier.
   * @returns Source instance or `null` when the source is unavailable.
   */
  getSource: (name: string) => object | null
}

/**
 * Writable HTTP response required by `pipeline(...)`.
 */
type StreamingApiResponse = ApiResponse &
  Writable & {
    /**
     * Whether the response has already been ended.
     */
    writableEnded: boolean
  }

/**
 * Readable stream with explicit destroy state checks.
 */
type DestroyableReadable = Readable & {
  /**
   * Indicates whether the stream has already been destroyed.
   */
  destroyed: boolean

  /**
   * Destroys the stream and releases underlying resources.
   */
  destroy: (error?: Error) => void
}

/**
 * Audio resource shape used by the stream endpoint.
 */
type StreamingAudioResource = AudioResource & {
  /**
   * PCM output stream produced by the audio resource.
   */
  stream: DestroyableReadable
}

/**
 * Minimal runtime surface required by the stream processor helpers.
 */
interface StreamProcessorRuntime {
  /**
   * Runtime options required by the stream processor.
   */
  options: LoadStreamRuntime['options']

  /**
   * Logger function used by the stream processor.
   */
  logger: typeof logger

  /**
   * Stats manager used by the stream processor.
   */
  statsManager: LoadStreamRuntime['statsManager']

  /**
   * Local source manager used for source-specific stream lookups.
   */
  sources: LoadStreamSourceManager | null

  /**
   * Optional lyrics manager referenced by the playback runtime contract.
   */
  lyrics: LyricsManagerLike | null

  /**
   * Optional extension registry consumed by audio interceptors.
   */
  extensions?: {
    /**
     * Optional audio interceptor list.
     */
    audioInterceptors?: Array<(stream: Readable) => void>
  }

  /**
   * Additional runtime fields exposed by the full NodeLink instance.
   */
  [key: string]: object | string | number | boolean | null | undefined
}

/**
 * Subset of stream processor exports used by the endpoint.
 */
interface StreamProcessorModule {
  /**
   * Creates a PCM-producing audio resource from an already opened source stream.
   *
   * @param stream - Source audio stream.
   * @param type - Source format or mime-type.
   * @param nodelink - Runtime surface required by the stream processor.
   * @param initialFilters - Initial filter state.
   * @param volume - Linear volume multiplier.
   * @param audioMixer - Optional mixer instance.
   * @param returnPCM - Whether the resource should output PCM.
   * @param enableAGC - Whether AGC should be enabled.
   * @returns PCM-capable audio resource.
   */
  createAudioResource: (
    stream: Readable,
    type: string,
    nodelink: StreamProcessorRuntime,
    initialFilters?: FiltersState,
    volume?: number,
    audioMixer?: null,
    returnPCM?: boolean,
    enableAGC?: boolean
  ) => StreamingAudioResource

  /**
   * Creates a seekable PCM resource from a remote URL.
   *
   * @param url - Remote source URL.
   * @param seekTime - Start position in milliseconds.
   * @param endTime - Optional end position.
   * @param nodelink - Runtime surface required by the stream processor.
   * @param initialFilters - Initial filter state.
   * @param player - Stream metadata used for format probing.
   * @param volume - Linear volume multiplier.
   * @param audioMixer - Optional mixer instance.
   * @param returnPCM - Whether the resource should output PCM.
   * @returns PCM audio resource or a serialized exception payload.
   */
  createSeekeableAudioResource: (
    url: string,
    seekTime: number,
    endTime: number | undefined,
    nodelink: StreamProcessorRuntime,
    initialFilters: FiltersState,
    player: {
      streamInfo: TrackUrlResult
      loudnessNormalizer?: boolean
    },
    volume?: number,
    audioMixer?: null,
    returnPCM?: boolean
  ) => Promise<StreamingAudioResource | { exception: { message: string } }>
}

/**
 * Runtime contract required by the load stream endpoint.
 */
interface LoadStreamRuntime extends ApiNodelinkServer {
  /**
   * Runtime options used by the endpoint.
   */
  options: ApiNodelinkServer['options'] & {
    enableLoadStreamEndpoint?: boolean
    audio?: {
      loudnessNormalizer?: boolean
    }
  }

  /**
   * Optional source worker manager used for request delegation.
   */
  sourceWorkerManager: LoadStreamSourceWorkerManager | null

  /**
   * Optional playback worker manager used in cluster mode.
   */
  workerManager: LoadStreamWorkerManager | null

  /**
   * Optional local source manager used in single-process mode.
   */
  sources: LoadStreamSourceManager | null

  /**
   * Stats manager extended with playback event instrumentation.
   */
  statsManager: ApiNodelinkServer['statsManager'] & {
    /**
     * Increments playback event counters.
     *
     * @param event - Playback event name.
     * @returns Nothing. Counters are updated as a side effect.
     */
    incrementPlaybackEvent: (event: string) => void
  }

  /**
   * Logger function exposed by the full runtime.
   */
  logger: typeof logger

  /**
   * Optional lyrics manager referenced by the playback runtime contract.
   */
  lyrics: LyricsManagerLike | null

  /**
   * Additional runtime fields exposed by the full NodeLink instance.
   */
  [key: string]: object | string | number | boolean | null | undefined
}

/**
 * Lazily imports and caches the stream processor module.
 *
 * @returns Promise resolving to the stream processor module exports.
 */
function getStreamProcessorModule(): Promise<StreamProcessorModule> {
  if (!streamProcessorModulePromise) {
    streamProcessorModulePromise = import(
      '../playback/processing/streamProcessor.ts'
    ) as Promise<StreamProcessorModule>
  }

  return streamProcessorModulePromise
}

/**
 * Builds a strongly typed runtime view for the load stream endpoint.
 *
 * @param nodelink - Router-facing runtime instance.
 * @returns Runtime compatible with the load stream endpoint, or `null` when
 * the required manager fields are unavailable.
 */
function getLoadStreamRuntime(
  nodelink: ApiNodelinkServer
): LoadStreamRuntime | null {
  const runtime = nodelink as ApiNodelinkServer & Partial<LoadStreamRuntime>

  if (
    runtime.sourceWorkerManager === undefined ||
    runtime.workerManager === undefined ||
    runtime.sources === undefined
  ) {
    return null
  }

  return runtime as LoadStreamRuntime
}

/**
 * Checks whether a value is a finite number.
 *
 * @param value - Candidate numeric value.
 * @returns `true` when the value is a finite number.
 */
function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Normalizes the optional filters payload.
 *
 * @param value - Candidate filters object.
 * @returns Valid filters payload, `false` when the value is invalid, or an
 * empty filter state when omitted.
 */
function normalizeFilters(
  value: FiltersState | ApiRequest['body'] | undefined
): FiltersState | false {
  if (value === undefined) {
    return {}
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  return value as FiltersState
}

/**
 * Extracts request data from a `POST` body payload.
 *
 * @param body - Parsed request body.
 * @returns Normalized request data, or `null` when validation fails.
 */
function getLoadStreamInputFromBody(
  body: ApiRequest['body']
): LoadStreamInput | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null
  }

  const payload = body as LoadStreamBodyPayload
  if (
    typeof payload.encodedTrack !== 'string' ||
    payload.encodedTrack.trim() === ''
  ) {
    return null
  }

  if (payload.volume !== undefined) {
    if (
      !isFiniteNumber(payload.volume) ||
      payload.volume < 0 ||
      payload.volume > 1000
    ) {
      return null
    }
  }

  if (payload.position !== undefined) {
    if (!isFiniteNumber(payload.position) || payload.position < 0) {
      return null
    }
  }

  const filters = normalizeFilters(payload.filters)
  if (filters === false) {
    return null
  }

  return {
    encodedTrack: payload.encodedTrack,
    volume: payload.volume ?? 100,
    position: payload.position ?? 0,
    filters
  }
}

/**
 * Parses the `filters` query parameter.
 *
 * Invalid JSON is ignored to preserve the historical behavior of the route.
 *
 * @param parsedUrl - Parsed request URL.
 * @returns Parsed filters payload or `undefined` when absent/invalid.
 */
function getFiltersFromQuery(parsedUrl: URL): FiltersState | undefined {
  const filtersRaw = parsedUrl.searchParams.get('filters')
  if (!filtersRaw) {
    return undefined
  }

  try {
    const parsed = JSON.parse(filtersRaw) as FiltersState
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Extracts request data from the query string used by `GET /loadStream`.
 *
 * @param parsedUrl - Parsed request URL.
 * @returns Normalized request data, or `null` when validation fails.
 */
function getLoadStreamInputFromQuery(parsedUrl: URL): LoadStreamInput | null {
  const encodedTrack = parsedUrl.searchParams.get('encodedTrack')?.trim()
  if (!encodedTrack) {
    return null
  }

  const volumeParam = parsedUrl.searchParams.get('volume')
  const positionParam =
    parsedUrl.searchParams.get('position') ?? parsedUrl.searchParams.get('t')

  const volume =
    volumeParam === null || volumeParam === '' ? 100 : Number(volumeParam)
  const position =
    positionParam === null || positionParam === '' ? 0 : Number(positionParam)

  if (!Number.isFinite(volume) || volume < 0 || volume > 1000) {
    return null
  }

  if (!Number.isFinite(position) || position < 0) {
    return null
  }

  const filters = getFiltersFromQuery(parsedUrl) ?? {}

  return {
    encodedTrack,
    volume,
    position,
    filters
  }
}

/**
 * Extracts normalized request data regardless of HTTP method.
 *
 * @param req - Incoming HTTP request.
 * @param parsedUrl - Parsed request URL.
 * @returns Normalized request data, or `null` when validation fails.
 */
function getLoadStreamInput(
  req: ApiRequest,
  parsedUrl: URL
): LoadStreamInput | null {
  return req.method === 'POST'
    ? getLoadStreamInputFromBody(req.body)
    : getLoadStreamInputFromQuery(parsedUrl)
}

/**
 * Casts the full runtime to the runtime contract required by the
 * stream processor.
 *
 * @param nodelink - Load stream runtime.
 * @returns Runtime view consumed by the stream processor.
 */
function getStreamProcessorRuntime(
  nodelink: LoadStreamRuntime
): StreamProcessorRuntime {
  return nodelink as StreamProcessorRuntime
}

/**
 * Resolves the track URL required for streaming.
 *
 * @param nodelink - Load stream runtime.
 * @param decodedTrack - Decoded track payload.
 * @returns Promise resolving to the track URL response.
 */
async function getTrackUrlResult(
  nodelink: LoadStreamRuntime,
  decodedTrack: EncodedTrackPayload
): Promise<TrackUrlResult> {
  if (nodelink.workerManager) {
    const worker = nodelink.workerManager.getBestWorker()
    return await nodelink.workerManager.execute(worker, 'getTrackUrl', {
      decodedTrackInfo: decodedTrack.info
    })
  }

  if (!nodelink.sources) {
    throw new Error('Sources manager is not available for loadStream.')
  }

  return await nodelink.sources.getTrackUrl(decodedTrack.info)
}

/**
 * Destroys a readable stream when it is still active.
 *
 * @param stream - Candidate stream.
 * @returns Nothing. The stream is destroyed as a side effect.
 */
function destroyStream(stream: DestroyableReadable | null): void {
  if (stream && !stream.destroyed) {
    stream.destroy()
  }
}

/**
 * Handles requests for the raw PCM stream endpoint.
 *
 * @param nodelink - Router-facing NodeLink runtime.
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @param _sendResponse - Unused route helper kept for handler signature
 * compatibility.
 * @param parsedUrl - Parsed request URL.
 * @returns Promise that resolves once the response has been written or the
 * stream has been delegated.
 */
async function handler(
  nodelink: ApiNodelinkServer,
  req: ApiRequest,
  res: ApiResponse,
  _sendResponse: ApiSendResponse,
  parsedUrl: URL
): Promise<void> {
  const runtime = getLoadStreamRuntime(nodelink)
  if (!runtime) {
    sendErrorResponse(
      req,
      res,
      500,
      'Internal Server Error',
      'Load stream runtime contract is incomplete.',
      parsedUrl.pathname,
      true
    )
    return
  }

  if (!runtime.options.enableLoadStreamEndpoint) {
    sendErrorResponse(
      req,
      res,
      404,
      'Not Found',
      'The requested route was not found.',
      parsedUrl.pathname
    )
    return
  }

  const input = getLoadStreamInput(req, parsedUrl)
  if (!input) {
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

  const encodedTrack = input.encodedTrack.replace(/ /g, '+')
  const streamResponse = res as StreamingApiResponse

  try {
    const decodedTrack = decodeTrack(encodedTrack)

    if (runtime.sourceWorkerManager) {
      const delegated = runtime.sourceWorkerManager.delegate(
        req,
        res,
        'loadStream',
        {
          decodedTrackInfo: decodedTrack.info,
          volume: input.volume,
          position: input.position,
          filters: input.filters
        },
        {
          headers: { ...LOAD_STREAM_HEADERS }
        }
      )
      if (delegated) {
        return
      }
    }

    if (!runtime.sources && runtime.workerManager) {
      const delegated = runtime.workerManager.delegateStream(
        req,
        res,
        {
          decodedTrackInfo: decodedTrack.info,
          volume: input.volume,
          position: input.position,
          filters: input.filters
        },
        {
          headers: { ...LOAD_STREAM_HEADERS }
        }
      )
      if (delegated) {
        return
      }

      sendErrorResponse(
        req,
        res,
        503,
        'Service Unavailable',
        'No available workers to stream audio.',
        parsedUrl.pathname
      )
      return
    }

    if (!runtime.sources && !runtime.workerManager) {
      sendErrorResponse(
        req,
        res,
        503,
        'Service Unavailable',
        'Sources manager is not available for loadStream.',
        parsedUrl.pathname
      )
      return
    }

    const urlResult = await getTrackUrlResult(runtime, decodedTrack)
    if (urlResult.exception) {
      sendErrorResponse(
        req,
        res,
        500,
        'Internal Server Error',
        urlResult.exception.message,
        parsedUrl.pathname
      )
      return
    }

    const { createAudioResource, createSeekeableAudioResource } =
      await getStreamProcessorModule()
    const streamProcessorRuntime = getStreamProcessorRuntime(runtime)
    const sourceName = decodedTrack.info.sourceName
    const isHls = urlResult.protocol === 'hls'
    const isSabr = urlResult.protocol === 'sabr'
    const isLocal = sourceName === 'local'

    let pcmStream: DestroyableReadable | null = null
    let fetchedStream: DestroyableReadable | null = null

    if (urlResult.url && !isHls && !isLocal && !isSabr) {
      const resource = (await createSeekeableAudioResource(
        urlResult.url,
        input.position,
        undefined,
        streamProcessorRuntime,
        input.filters,
        {
          streamInfo: urlResult,
          loudnessNormalizer: runtime.options.audio?.loudnessNormalizer
        },
        input.volume / 100,
        null,
        true
      )) as StreamingAudioResource | { exception: { message: string } }

      if ('exception' in resource) {
        sendErrorResponse(
          req,
          res,
          500,
          'Internal Server Error',
          resource.exception.message,
          parsedUrl.pathname
        )
        return
      }

      pcmStream = resource.stream
    } else {
      if (!runtime.sources || !urlResult.url) {
        throw new Error(
          'Unable to fetch source stream for the requested track.'
        )
      }

      const additionalData = {
        ...(urlResult.additionalData ?? {}),
        startTime: input.position
      }

      const fetched = await runtime.sources.getTrackStream(
        urlResult.newTrack?.info ?? decodedTrack.info,
        urlResult.url,
        urlResult.protocol,
        additionalData
      )

      if (fetched.exception) {
        sendErrorResponse(
          req,
          res,
          500,
          'Internal Server Error',
          fetched.exception.message,
          parsedUrl.pathname
        )
        return
      }

      fetchedStream = fetched.stream as DestroyableReadable

      const resource = createAudioResource(
        fetched.stream,
        fetched.type ?? urlResult.format ?? 'unknown',
        streamProcessorRuntime,
        input.filters,
        input.volume / 100,
        null,
        true,
        runtime.options.audio?.loudnessNormalizer
      ) as StreamingAudioResource

      pcmStream = resource.stream
    }

    pcmStream.on('error', (error: NodeJS.ErrnoException) => {
      logger(
        'error',
        'LoadStream',
        `Pipeline component error: ${error.message} (${error.code})`
      )
    })

    streamResponse.writeHead(200, { ...LOAD_STREAM_HEADERS })

    pipeline(
      pcmStream,
      streamResponse,
      (error: NodeJS.ErrnoException | null) => {
        if (error && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
          logger(
            'error',
            'LoadStream',
            `Pipeline output failed for ${decodedTrack.info.title}: ${error.message}`
          )
        }

        destroyStream(pcmStream)
        destroyStream(fetchedStream)
      }
    )

    streamResponse.on('close', () => {
      destroyStream(pcmStream)
      destroyStream(fetchedStream)
    })
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Fatal loadStream error.'
    logger('error', 'LoadStream', 'Fatal handler error:', error)
    if (!streamResponse.writableEnded) {
      sendErrorResponse(
        req,
        res,
        500,
        'Internal Server Error',
        errorMessage,
        parsedUrl.pathname
      )
    }
  }
}

/**
 * Route module definition for the raw PCM stream endpoint.
 */
const loadStreamRoute: ApiRouteModule = {
  handler,
  methods: ['GET', 'POST']
}

export default loadStreamRoute
