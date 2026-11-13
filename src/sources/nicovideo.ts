import HLSHandler from '../playback/hls/HLSHandler.ts'
import type {
  SourceInstance,
  SourceResult,
  TrackInfo,
  TrackStreamResult,
  TrackUrlResult,
  WorkerNodeLink
} from '../typings/sources/source.types.ts'
import type {
  SourceTestCase,
  SourceTestStreamSpec,
  SourceTestVariant,
  SourceTestVariantResult,
  SourceVariantHandler
} from '../typings/sources/test.types.ts'
import type {
  HttpRequestResult,
  HttpResponseHeaders,
  TrackEncodeInput
} from '../typings/utils.types.ts'
import { encodeTrack, http1makeRequest, logger } from '../utils.ts'

/**
 * JSON-compatible scalar or nested value used for response narrowing.
 */
type JsonValue = JsonRecord | JsonValue[] | string | number | boolean | null

/**
 * Object-like JSON record used to safely inspect HTTP payloads.
 */
interface JsonRecord {
  [key: string]: JsonValue | undefined
}

/**
 * Header shape used by NicoVideo HTTP and HLS requests.
 */
type NicoVideoHeaders = Record<string, string> & {
  /**
   * Optional cookie header added for HLS playlist requests.
   */
  Cookie?: string
}

/**
 * Search entry returned by the NicoVideo snapshot API.
 */
interface NicoVideoSearchItem {
  /**
   * NicoVideo content identifier.
   */
  contentId: string

  /**
   * Search result title.
   */
  title: string

  /**
   * Numeric uploader user identifier.
   */
  userId?: number

  /**
   * Thumbnail URL exposed by the search API.
   */
  thumbnailUrl?: string | null

  /**
   * Track duration in seconds.
   */
  lengthSeconds: number
}

/**
 * Search response returned by NicoVideo snapshot API.
 */
interface NicoVideoSearchResponse {
  /**
   * Status code returned in snapshot metadata.
   */
  meta?: {
    status?: number
  }

  /**
   * Matching search results.
   */
  data?: NicoVideoSearchItem[]
}

/**
 * DMC audio entry returned by the watch page response.
 */
interface NicoVideoDmcAudio {
  /**
   * NicoVideo audio stream identifier.
   */
  id: string

  /**
   * Whether the audio stream is currently available.
   */
  isAvailable: boolean

  /**
   * Numeric quality level exposed by NicoVideo.
   */
  qualityLevel: number
}

/**
 * DMC video entry returned by the watch page response.
 */
interface NicoVideoDmcVideo {
  /**
   * NicoVideo video stream identifier.
   */
  id: string

  /**
   * Human-readable video quality label.
   */
  label: string

  /**
   * Whether the video stream is currently available.
   */
  isAvailable: boolean
}

/**
 * DMC media payload used to request HLS access rights.
 */
interface NicoVideoDmcMedia {
  /**
   * Access-right key required by the HLS rights endpoint.
   */
  accessRightKey?: string

  /**
   * Audio renditions attached to the track.
   */
  audios?: NicoVideoDmcAudio[]

  /**
   * Video renditions attached to the track.
   */
  videos?: NicoVideoDmcVideo[]
}

/**
 * Video metadata returned by the v3_guest watch API.
 */
interface NicoVideoV3Video {
  /**
   * Video identifier (e.g. sm9).
   */
  id: string

  /**
   * Video title.
   */
  title: string

  /**
   * Duration in seconds.
   */
  duration: number

  /**
   * Thumbnail variants.
   */
  thumbnail?: {
    url?: string | null
    player?: string | null
    ogp?: string | null
  }
}

/**
 * Owner metadata returned by the v3_guest watch API.
 */
interface NicoVideoV3Owner {
  id?: number
  nickname?: string
  iconUrl?: string
}

/**
 * v3_guest watch API response payload.
 */
interface NicoVideoV3Response {
  meta?: {
    status?: number
  }
  data?: {
    video?: NicoVideoV3Video
    owner?: NicoVideoV3Owner
    client?: {
      watchId?: string
      watchTrackId?: string
    }
    media?: {
      domand?: NicoVideoDmcMedia
    }
  }
}

/**
 * Access-right response returned by NicoVideo after requesting HLS playback.
 */
interface NicoVideoAccessRightsResponse {
  /**
   * Access-right payload.
   */
  data?: {
    /**
     * Master playlist URL returned by NicoVideo.
     */
    contentUrl?: string
  }
}

/**
 * Output pair expected by the NicoVideo HLS access endpoint.
 */
type NicoVideoOutputPair = [string, string]

/**
 * Additional HLS metadata cached alongside the resolved track URL.
 */
interface NicoVideoAdditionalData {
  /**
   * Extra metadata bucket kept compatible with the generic source contract.
   */
  [key: string]: string | number | boolean | null | undefined

  /**
   * Session cookie required for subsequent playlist requests.
   */
  cookie?: string | null

  /**
   * Stream start offset in milliseconds when resuming playback.
   */
  startTime?: number
}

/**
 * NicoVideo track payload passed to the shared encoder.
 */
interface NicoVideoTrackInfo extends TrackEncodeInput {
  [x: string]: unknown
  /**
   * Whether the encoded track supports seeking.
   */
  isSeekable: boolean

  /**
   * Canonical track URL.
   */
  uri: string

  /**
   * Best artwork URL found for the track.
   */
  artworkUrl: string | null

  /**
   * NicoVideo does not expose ISRC values in this source path.
   */
  isrc: string | null
}

/**
 * Encoded track payload returned by the source manager.
 */
interface NicoVideoTrackData {
  /**
   * Base64-encoded Lavalink-compatible track payload.
   */
  encoded: string

  /**
   * Human-readable track information.
   */
  info: NicoVideoTrackInfo

  /**
   * Source-specific plugin metadata.
   */
  pluginInfo: Record<string, unknown>
}

/**
 * NicoVideo source implementation.
 */
export default class NicoVideoSource
  implements SourceInstance, SourceVariantHandler
{
  /**
   * Declarative test suite for validating NicoVideo source behavior.
   */
  public static readonly _TESTS: SourceTestCase[] = [
    {
      id: 'nicovideo.watch.stream',
      name: 'NicoVideo standard watch video playback',
      input: {
        type: 'resolve',
        value: 'https://www.nicovideo.jp/watch/sm9'
      },
      matrix: {
        variants: [{ id: 'Standard' }]
      },
      expect: {
        result: {
          type: 'track'
        },
        metadata: {
          author: {
            op: 'matches',
            value: '中の'
          },
          sourceName: {
            op: 'equals',
            value: 'nicovideo'
          }
        },
        stream: {
          required: true,
          download: {
            mode: 'window',
            maxDurationMs: 10000,
            maxBytes: 512 * 1024
          },
          minBytes: 100000,
          validFormats: [{ container: 'mp4', codec: 'aac' }]
        }
      },
      forbid: {
        resultTypes: ['empty', 'error']
      }
    },
    {
      id: 'nicovideo.short.stream',
      name: 'NicoVideo short URL playback',
      input: {
        type: 'resolve',
        value: 'https://nico.ms/sm9'
      },
      matrix: {
        variants: [{ id: 'Standard' }]
      },
      expect: {
        result: {
          type: 'track'
        },
        metadata: {
          author: {
            op: 'matches',
            value: '中の'
          },
          sourceName: {
            op: 'equals',
            value: 'nicovideo'
          }
        },
        stream: {
          required: true,
          download: {
            mode: 'window',
            maxDurationMs: 10000,
            maxBytes: 512 * 1024
          },
          minBytes: 100000,
          validFormats: [{ container: 'mp4', codec: 'aac' }]
        }
      },
      forbid: {
        resultTypes: ['empty', 'error']
      }
    },
    {
      id: 'nicovideo.search',
      name: 'NicoVideo search query',
      input: {
        type: 'search',
        value: 'Bad Apple',
        searchType: 'ncsearch'
      },
      matrix: {
        variants: [{ id: 'Standard' }]
      },
      expect: {
        result: {
          type: 'search'
        },
        collection: {
          minItems: 1
        }
      },
      forbid: {
        resultTypes: ['empty', 'error']
      }
    }
  ]

  /**
   * Runtime worker context used by the source implementation.
   */
  public readonly nodelink: WorkerNodeLink

  /**
   * Search aliases supported by this source.
   */
  public readonly searchTerms: string[]

  /**
   * URL patterns handled by this source.
   */
  public readonly patterns: RegExp[]

  /**
   * Match priority used by the source manager.
   */
  public readonly priority: number

  /**
   * Creates a new NicoVideo source wrapper.
   *
   * @param nodelink - Worker runtime used by the source implementation.
   */
  public constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
    this.searchTerms = ['ncsearch', 'nicovideo']
    this.patterns = [
      /^https?:\/\/(?:www\.)?nicovideo\.jp\/watch\/(\w+)/,
      /^https?:\/\/nico\.ms\/(\w+)/
    ]
    this.priority = 75
  }

  /**
   * Validates whether a raw HTTP payload can be treated as an object record.
   *
   * @param value - Candidate HTTP response body.
   * @returns `true` when the value is a non-array, non-buffer object.
   */
  private isJsonRecord(value: HttpRequestResult['body']): value is JsonRecord {
    return (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !Buffer.isBuffer(value)
    )
  }

  /**
   * Narrows a NicoVideo search payload after a successful HTTP request.
   *
   * @param value - Raw response body returned by the search endpoint.
   * @returns Typed NicoVideo search response, or `null` when the payload is
   * not object-like.
   */
  private getSearchResponse(
    value: HttpRequestResult['body']
  ): NicoVideoSearchResponse | null {
    if (!this.isJsonRecord(value)) {
      return null
    }

    return value as NicoVideoSearchResponse
  }

  /**
   * Narrows the HLS access-right response returned by NicoVideo.
   *
   * @param value - Raw response body returned by the access-right request.
   * @returns Typed access-right response, or `null` when the payload is not
   * object-like.
   */
  private getAccessRightsResponse(
    value: HttpRequestResult['body']
  ): NicoVideoAccessRightsResponse | null {
    if (!this.isJsonRecord(value)) {
      return null
    }

    return value as NicoVideoAccessRightsResponse
  }

  /**
   * Extracts a NicoVideo watch identifier from a supported URL.
   *
   * @param url - Candidate NicoVideo URL.
   * @returns Extracted watch identifier, or `null` when the URL does not
   * match this source.
   */
  private getVideoId(url: string): string | null {
    const primaryPattern = this.patterns[0]
    const shortPattern = this.patterns[1]
    const primaryMatch = primaryPattern?.exec(url)

    if (typeof primaryMatch?.[1] === 'string') {
      return primaryMatch[1]
    }

    const shortMatch = shortPattern?.exec(url)
    return typeof shortMatch?.[1] === 'string' ? shortMatch[1] : null
  }

  /**
   * Builds the request headers required by NicoVideo endpoints.
   *
   * @param accessRightKey - Optional HLS access-right key for stream requests.
   * @returns Header object expected by NicoVideo HTTP endpoints.
   */
  private buildHeaders(accessRightKey?: string): NicoVideoHeaders {
    const headers: NicoVideoHeaders = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'X-Request-With': 'https://www.nicovideo.jp',
      Referer: 'https://www.nicovideo.jp/',
      'X-Frontend-Id': '6',
      'X-Frontend-Version': '0'
    }

    if (accessRightKey) {
      headers['x-access-right-key'] = accessRightKey
    }

    return headers
  }

  /**
   * Formats a request failure message from the utility HTTP client output.
   *
   * @param error - Text error returned by the HTTP helper.
   * @param statusCode - HTTP status code returned by the request.
   * @returns Human-readable request failure summary.
   */
  private getRequestFailureMessage(
    error: string | undefined,
    statusCode: number | undefined
  ): string {
    return error ?? String(statusCode ?? 'unknown error')
  }

  /**
   * Normalizes the `set-cookie` response header into a single header string.
   *
   * @param headers - Response headers returned by the HTTP helper.
   * @returns Cookie header string, or `null` when the response does not carry
   * cookies.
   */
  private getCookieHeaderValue(
    headers: HttpResponseHeaders | undefined
  ): string | null {
    const setCookie = headers?.['set-cookie']

    if (Array.isArray(setCookie)) {
      return setCookie.join('; ')
    }

    return typeof setCookie === 'string' ? setCookie : null
  }

  /**
   * Narrows cached additional stream metadata received by `loadStream(...)`.
   *
   * @param value - Additional data attached to a previously resolved track URL.
   * @returns Typed stream metadata limited to the fields this source uses.
   */
  private getAdditionalData(
    value: TrackUrlResult['additionalData'] | NicoVideoAdditionalData
  ): NicoVideoAdditionalData {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {}
    }

    const data = value as NicoVideoAdditionalData

    return {
      cookie:
        typeof data.cookie === 'string' || data.cookie === null
          ? data.cookie
          : undefined,
      startTime: typeof data.startTime === 'number' ? data.startTime : undefined
    }
  }

  /**
   * Builds the output pairs required by NicoVideo's HLS access endpoint.
   *
   * The current source logic keeps the best available audio rendition and pairs
   * it with each supported video quality.
   *
   * @param dmcMedia - Domand playback metadata returned by NicoVideo.
   * @returns Output pairs in the same order expected by the original source.
   */
  private buildOutputData(dmcMedia: NicoVideoDmcMedia): NicoVideoOutputPair[] {
    const quality = ['1080p', '720p', '480p', '360p', '144p']
    const outputs: NicoVideoOutputPair[] = []
    let topAudioId: string | null = null
    let topAudioQuality = -1

    for (const audio of dmcMedia.audios ?? []) {
      if (audio.isAvailable && audio.qualityLevel > topAudioQuality) {
        topAudioId = audio.id
        topAudioQuality = audio.qualityLevel
      }
    }

    if (!topAudioId) {
      return outputs
    }

    for (const video of dmcMedia.videos ?? []) {
      if (quality.includes(video.label) && video.isAvailable) {
        outputs.push([video.id, topAudioId])
      }
    }

    return outputs
  }

  /**
   * Initializes the source.
   *
   * NicoVideo does not require asynchronous bootstrapping beyond logging, so
   * setup always succeeds.
   *
   * @returns `true` once the source has been registered.
   */
  public async setup(): Promise<boolean> {
    logger('info', 'Sources', 'Loaded NicoVideo source.')
    return true
  }

  /**
   * Searches NicoVideo videos by title and tags.
   *
   * @param query - Search text provided by the caller.
   * @returns Search result payload containing encoded NicoVideo tracks, an
   * empty result, or an exception payload when the request fails.
   */
  public async search(query: string): Promise<SourceResult> {
    logger('debug', 'NicoVideo', `Searching for: ${query}`)

    const params = new URLSearchParams({
      q: query,
      targets: 'title,tags',
      fields: 'contentId,title,userId,thumbnailUrl,lengthSeconds',
      _sort: '-viewCounter',
      _context: 'NodeLink',
      _limit: '25'
    })

    const { body, error, statusCode } = await http1makeRequest(
      `https://snapshot.search.nicovideo.jp/api/v2/snapshot/video/contents/search?${params.toString()}`,
      { headers: this.buildHeaders() }
    )

    if (error || statusCode !== 200) {
      return {
        loadType: 'error',
        exception: {
          message: `Failed to search: ${this.getRequestFailureMessage(
            error,
            statusCode
          )}`,
          severity: 'fault'
        }
      }
    }

    const items = this.getSearchResponse(body)?.data ?? []
    if (items.length === 0) {
      return { loadType: 'empty', data: {} }
    }

    const tracks: NicoVideoTrackData[] = items.map((item) => {
      const trackInfo: NicoVideoTrackInfo = {
        identifier: item.contentId,
        isSeekable: true,
        author: item.userId ? `User ${item.userId}` : 'Unknown Artist',
        length: (item.lengthSeconds ?? 0) * 1000,
        isStream: false,
        position: 0,
        title: item.title,
        uri: `https://www.nicovideo.jp/watch/${item.contentId}`,
        artworkUrl: item.thumbnailUrl ?? null,
        isrc: null,
        sourceName: 'nicovideo',
        details: []
      }

      return {
        encoded: encodeTrack(trackInfo),
        info: trackInfo,
        pluginInfo: {} as Record<string, unknown>
      }
    })

    return { loadType: 'search', data: tracks }
  }

  /**
   * Resolves a NicoVideo watch URL into a single encoded track payload.
   *
   * @param url - Candidate NicoVideo watch URL.
   * @returns Track result payload, an empty result when the URL is unsupported,
   * or an exception payload when required metadata cannot be resolved.
   */
  public async resolve(url: string): Promise<SourceResult> {
    const videoId = this.getVideoId(url)
    if (!videoId) {
      return { loadType: 'empty', data: {} }
    }

    const actionTrackId = `AAAAAAAAAA_${Date.now()}`
    const apiUrl = `https://www.nicovideo.jp/api/watch/v3_guest/${videoId}?actionTrackId=${actionTrackId}`

    const { body, error, statusCode } = await http1makeRequest(apiUrl, {
      headers: this.buildHeaders()
    })

    if (error || statusCode !== 200) {
      return {
        loadType: 'error',
        exception: {
          message: `Failed to resolve URL: ${this.getRequestFailureMessage(
            error,
            statusCode
          )}`,
          severity: 'fault'
        }
      }
    }

    const response = (
      this.isJsonRecord(body) ? body : null
    ) as NicoVideoV3Response | null
    const video = response?.data?.video
    const owner = response?.data?.owner

    if (!video?.id) {
      return {
        loadType: 'error',
        exception: {
          message: 'Could not extract video information.',
          severity: 'common'
        }
      }
    }

    const track: NicoVideoTrackInfo = {
      identifier: video.id,
      isSeekable: true,
      author: owner?.nickname ?? 'Unknown Artist',
      length: (video.duration ?? 0) * 1000,
      isStream: false,
      position: 0,
      title: video.title ?? 'Unknown Title',
      uri: `https://www.nicovideo.jp/watch/${video.id}`,
      artworkUrl:
        video.thumbnail?.ogp ??
        video.thumbnail?.player ??
        video.thumbnail?.url ??
        null,
      isrc: null,
      sourceName: 'nicovideo',
      details: []
    }

    return {
      loadType: 'track',
      data: {
        encoded: encodeTrack(track),
        info: track,
        pluginInfo: {} as Record<string, unknown>
      }
    }
  }

  /**
   * Resolves the playable HLS playlist URL for a NicoVideo track.
   *
   * @param track - Decoded track information provided by the playback system.
   * @param forceRefresh - When `true`, bypasses the track cache and resolves a
   * fresh HLS session.
   * @returns Cached or freshly resolved HLS access data.
   */
  public async getTrackUrl(
    track: TrackInfo,
    _itag?: number,
    forceRefresh = false
  ): Promise<TrackUrlResult> {
    if (!forceRefresh) {
      const cached =
        this.nodelink.trackCacheManager?.get<TrackUrlResult>(
          'nicovideo',
          track.identifier
        ) ?? null

      if (cached) {
        return cached
      }
    }

    const videoId =
      track.identifier && /^[a-zA-Z0-9_-]+$/.test(track.identifier)
        ? track.identifier
        : this.getVideoId(track.uri || '')

    if (!videoId) {
      throw new Error('Invalid NicoVideo identifier or URL.')
    }

    const actionTrackId = `AAAAAAAAAA_${Date.now()}`
    const watchUrl = `https://www.nicovideo.jp/api/watch/v3_guest/${videoId}?actionTrackId=${actionTrackId}`

    const {
      body: pageData,
      error,
      statusCode
    } = await http1makeRequest(watchUrl, {
      headers: this.buildHeaders()
    })

    if (error || statusCode !== 200 || !this.isJsonRecord(pageData)) {
      throw new Error(
        `Failed to get track page: ${this.getRequestFailureMessage(
          error,
          statusCode
        )}`
      )
    }

    const response = pageData as NicoVideoV3Response
    const dmcMedia = response.data?.media?.domand
    const watchTrackId = response.data?.client?.watchTrackId
    const accessRightKey = dmcMedia?.accessRightKey

    if (!dmcMedia || !watchTrackId || !accessRightKey) {
      throw new Error('Failed to extract required DMC info for stream access.')
    }

    const streamRequestUrl =
      `https://nvapi.nicovideo.jp/v1/watch/${videoId}/access-rights/hls` +
      `?actionTrackId=${encodeURIComponent(watchTrackId)}&__retry=1`
    const postBody = { outputs: this.buildOutputData(dmcMedia) }

    const {
      body: streamData,
      headers: streamHeaders,
      error: streamError,
      statusCode: streamStatus
    } = await http1makeRequest(streamRequestUrl, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(accessRightKey),
        'Content-Type': 'application/json'
      },
      body: postBody,
      disableBodyCompression: true
    })

    if (streamError || streamStatus !== 201) {
      throw new Error(
        `Failed to get stream access rights: ${this.getRequestFailureMessage(
          streamError,
          streamStatus
        )}`
      )
    }

    const cookie = this.getCookieHeaderValue(streamHeaders)
    const masterPlaylistUrl =
      this.getAccessRightsResponse(streamData)?.data?.contentUrl

    if (!masterPlaylistUrl) {
      throw new Error('Failed to extract master playlist URL.')
    }

    const {
      body: masterPlaylistContent,
      error: masterError,
      statusCode: masterStatus
    } = await http1makeRequest(masterPlaylistUrl, {
      headers: {
        ...this.buildHeaders(),
        ...(cookie ? { Cookie: cookie } : {})
      }
    })

    if (
      masterError ||
      masterStatus !== 200 ||
      typeof masterPlaylistContent !== 'string'
    ) {
      throw new Error(
        `Failed to fetch master HLS playlist: ${this.getRequestFailureMessage(
          masterError,
          masterStatus
        )}`
      )
    }

    const lines = masterPlaylistContent.split('\n')
    const audioTag = lines.find(
      (line) => line.startsWith('#EXT-X-MEDIA') && line.includes('TYPE=AUDIO')
    )

    let playlistUrl = masterPlaylistUrl
    if (audioTag) {
      const audioUri = audioTag.match(/URI="([^"]+)"/)?.[1]
      if (audioUri) {
        playlistUrl = new URL(audioUri, masterPlaylistUrl).toString()
      }
    }

    const result: TrackUrlResult = {
      url: playlistUrl,
      protocol: 'hls',
      format: 'aac',
      additionalData: { cookie }
    }

    this.nodelink.trackCacheManager?.set(
      'nicovideo',
      track.identifier,
      result,
      1000 * 60 * 60
    )

    return result
  }

  /**
   * Opens the NicoVideo audio stream from a previously resolved HLS playlist.
   *
   * @param _track - Decoded track information passed by the playback system.
   * @param url - HLS playlist URL returned by `getTrackUrl(...)`.
   * @param protocol - Stream protocol returned by `getTrackUrl(...)`.
   * @param additionalData - Extra stream metadata such as cookies and resume
   * offsets.
   * @returns HLS stream payload, or an exception when the resolved protocol is
   * unsupported.
   */
  public async loadStream(
    _track: TrackInfo,
    url: string,
    protocol?: string,
    additionalData?: Record<string, unknown>
  ): Promise<TrackStreamResult> {
    if (protocol === 'hls') {
      const headers = this.buildHeaders()
      const streamData = this.getAdditionalData(additionalData)

      if (streamData.cookie) {
        headers.Cookie = streamData.cookie
      }

      const stream = new HLSHandler(url, {
        headers,
        type: 'fmp4',
        localAddress: this.nodelink.routePlanner?.getIP?.() ?? null,
        startTime: streamData.startTime ?? 0
      })

      return { stream, type: 'fmp4' }
    }

    throw new Error('Unsupported protocol')
  }

  /**
   * Executes a specific variant for testing.
   *
   * @param variant - The test variant to execute.
   * @param track - The track information.
   * @param streamSpec - Optional stream validation specifications.
   * @returns A result object detailing resolution and stream state.
   */
  public async executeVariant(
    variant: SourceTestVariant,
    track: TrackInfo,
    streamSpec?: SourceTestStreamSpec
  ): Promise<SourceTestVariantResult> {
    let urlData: TrackUrlResult
    try {
      urlData = await this.getTrackUrl(track)
    } catch (err) {
      return {
        variant: variant.id,
        resolved: false,
        error:
          err instanceof Error
            ? err.message
            : 'Failed to resolve track streaming URL'
      }
    }

    if (!urlData.url) {
      return {
        variant: variant.id,
        resolved: false,
        error: 'Failed to resolve track streaming URL'
      }
    }

    const container = 'mp4'
    const codec = 'aac'

    if (!streamSpec?.required) {
      return {
        variant: variant.id,
        resolved: true,
        track: urlData.newTrack?.info || track,
        container,
        codec
      }
    }

    let streamResult: TrackStreamResult
    try {
      streamResult = await this.loadStream(
        track,
        urlData.url,
        urlData.protocol,
        urlData.additionalData
      )
    } catch (err) {
      return {
        variant: variant.id,
        resolved: true,
        error:
          err instanceof Error ? err.message : 'Failed to load audio stream'
      }
    }

    if (!streamResult.stream) {
      return {
        variant: variant.id,
        resolved: true,
        error: 'Failed to load audio stream'
      }
    }

    return {
      variant: variant.id,
      resolved: true,
      track: urlData.newTrack?.info || track,
      stream: streamResult.stream,
      container,
      codec,
      httpStatus: 200
    }
  }
}
