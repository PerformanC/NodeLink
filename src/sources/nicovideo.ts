import HLSHandler from '../playback/hls/HLSHandler.ts'
import type {
  SourceResult,
  TrackInfo,
  TrackStreamResult,
  TrackUrlResult,
  WorkerNodeLink
} from '../typings/sources/source.types.ts'
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
 * Owner payload returned by NicoVideo search results.
 */
interface NicoVideoOwner {
  /**
   * Display name of the uploader when NicoVideo provides it.
   */
  name?: string
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
   * Optional uploader metadata.
   */
  owner?: NicoVideoOwner

  /**
   * Thumbnail URL exposed by the search API.
   */
  thumbnailUrl?: string | null

  /**
   * Track duration in seconds.
   */
  duration: number
}

/**
 * Search response returned by NicoVideo.
 */
interface NicoVideoSearchResponse {
  /**
   * Matching search results.
   */
  data?: NicoVideoSearchItem[]
}

/**
 * JSON-LD author payload embedded in the watch page response.
 */
interface NicoVideoJsonLdAuthor {
  /**
   * Display name of the video author.
   */
  name?: string
}

/**
 * JSON-LD video payload embedded in the NicoVideo watch page.
 */
interface NicoVideoJsonLd {
  /**
   * Schema.org entry type.
   */
  '@type'?: string

  /**
   * ISO-8601 duration string returned by NicoVideo.
   */
  duration?: string

  /**
   * Author metadata attached to the track.
   */
  author?: NicoVideoJsonLdAuthor

  /**
   * Video title.
   */
  name?: string

  /**
   * Canonical NicoVideo URL.
   */
  '@id'?: string

  /**
   * Thumbnail variants attached to the video.
   */
  thumbnailUrl?: string[]
}

/**
 * Metadata wrapper returned by the watch page response.
 */
interface NicoVideoWatchMetadata {
  /**
   * Available JSON-LD entries extracted from the watch page.
   */
  jsonLds?: NicoVideoJsonLd[]
}

/**
 * Client metadata returned by the NicoVideo watch page.
 */
interface NicoVideoClientResponse {
  /**
   * Canonical watch identifier used by the page response.
   */
  watchId?: string

  /**
   * Playback tracking identifier required to request HLS access.
   */
  watchTrackId?: string
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
 * Media wrapper returned by the watch page response.
 */
interface NicoVideoMediaResponse {
  /**
   * Domand playback payload used for HLS access.
   */
  domand?: NicoVideoDmcMedia
}

/**
 * Response payload returned by the NicoVideo watch page.
 */
interface NicoVideoWatchResponsePayload {
  /**
   * Client metadata for the current watch page.
   */
  client?: NicoVideoClientResponse

  /**
   * Stream metadata for the current watch page.
   */
  media?: NicoVideoMediaResponse
}

/**
 * Watch page response returned by `?responseType=json`.
 */
interface NicoVideoWatchPageResponse {
  /**
   * Parsed data payload returned by NicoVideo.
   */
  data?: {
    /**
     * Watch page metadata block.
     */
    metadata?: NicoVideoWatchMetadata

    /**
     * Playback response block.
     */
    response?: NicoVideoWatchResponsePayload
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
 * Successful track URL payload stored in the NodeLink track cache.
 */
interface NicoVideoTrackUrlSuccess {
  /**
   * NicoVideo streams are resolved as HLS playlists.
   */
  url: string

  /**
   * NicoVideo streams are resolved as HLS playlists.
   */
  protocol: 'hls'

  /**
   * NicoVideo HLS audio is treated as AAC in the source pipeline.
   */
  format: 'aac'

  /**
   * Additional metadata needed when opening the stream.
   */
  additionalData: NicoVideoAdditionalData
}

/**
 * NicoVideo track payload passed to the shared encoder.
 */
interface NicoVideoTrackInfo extends TrackEncodeInput {
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
  pluginInfo: Record<string, never>
}

/**
 * Exception payload returned by NicoVideo when an operation fails.
 */
interface NicoVideoExceptionResult {
  /**
   * Structured source exception metadata.
   */
  exception: {
    /**
     * Human-readable failure reason.
     */
    message: string

    /**
     * Source-defined error severity.
     */
    severity: string
  }
}

/**
 * NicoVideo source implementation.
 */
export default class NicoVideoSource {
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
   * Narrows the NicoVideo watch page payload returned by `responseType=json`.
   *
   * @param value - Raw response body returned by the watch page request.
   * @returns Typed watch page response, or `null` when the payload is not
   * object-like.
   */
  private getWatchPageResponse(
    value: HttpRequestResult['body']
  ): NicoVideoWatchPageResponse | null {
    if (!this.isJsonRecord(value)) {
      return null
    }

    return value as NicoVideoWatchPageResponse
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
      'User-Agent': 'NodeLink',
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
   * Converts the limited NicoVideo duration string into milliseconds.
   *
   * This preserves the source's current behavior, which only reads the final
   * seconds segment from NicoVideo's duration string.
   *
   * @param duration - NicoVideo ISO-8601 duration string.
   * @returns Duration in milliseconds based on the parsed seconds component.
   */
  private parseDurationMillis(duration?: string): number {
    if (!duration) {
      return 0
    }

    const seconds = duration.match(/(\d+)S/)?.[1]
    return Number.parseInt(seconds ?? '0', 10) * 1000
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
      fields: 'contentId,title,owner,thumbnailUrl,duration',
      _sort: '-viewCounter',
      _context: 'NodeLink',
      _limit: '25'
    })

    const { body, error, statusCode } = await http1makeRequest(
      `https://api.search.nicovideo.jp/api/v2/snapshot/video/contents/search?${params.toString()}`
    )

    if (error || statusCode !== 200) {
      return {
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
        author: item.owner?.name ?? 'Unknown Artist',
        length: item.duration * 1000,
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
        pluginInfo: {}
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

    const { body, error, statusCode } = await http1makeRequest(
      `https://www.nicovideo.jp/watch/${videoId}?responseType=json`,
      { headers: this.buildHeaders() }
    )

    if (error || statusCode !== 200) {
      return {
        exception: {
          message: `Failed to resolve URL: ${this.getRequestFailureMessage(
            error,
            statusCode
          )}`,
          severity: 'fault'
        }
      }
    }

    const watchPage = this.getWatchPageResponse(body)
    const jsonLd = watchPage?.data?.metadata?.jsonLds?.find(
      (entry) => entry['@type'] === 'VideoObject'
    )
    const videoIdFromApi = watchPage?.data?.response?.client?.watchId

    if (!jsonLd || !videoIdFromApi) {
      return {
        exception: {
          message: 'Could not extract video information.',
          severity: 'common'
        }
      }
    }

    const track: NicoVideoTrackInfo = {
      identifier: videoIdFromApi,
      isSeekable: true,
      author: jsonLd.author?.name ?? 'Unknown Artist',
      length: this.parseDurationMillis(jsonLd.duration),
      isStream: false,
      position: 0,
      title: jsonLd.name ?? 'Unknown Title',
      uri: jsonLd['@id'] ?? `https://www.nicovideo.jp/watch/${videoIdFromApi}`,
      artworkUrl: jsonLd.thumbnailUrl?.[0] ?? null,
      isrc: null,
      sourceName: 'nicovideo',
      details: []
    }

    return {
      loadType: 'track',
      data: {
        encoded: encodeTrack(track),
        info: track,
        pluginInfo: {}
      }
    }
  }

  /**
   * Resolves the playable HLS playlist URL for a NicoVideo track.
   *
   * @param track - Decoded track information provided by the playback system.
   * @param forceRefresh - When `true`, bypasses the track cache and resolves a
   * fresh HLS session.
   * @returns Cached or freshly resolved HLS access data, or an exception
   * payload when playback rights cannot be established.
   */
  public async getTrackUrl(
    track: TrackInfo,
    forceRefresh = false
  ): Promise<TrackUrlResult | NicoVideoExceptionResult> {
    if (!forceRefresh) {
      const cached =
        this.nodelink.trackCacheManager?.get<NicoVideoTrackUrlSuccess>(
          'nicovideo',
          track.identifier
        ) ?? null

      if (cached) {
        return cached
      }
    }

    const {
      body: pageData,
      error,
      statusCode
    } = await http1makeRequest(`${track.uri}?responseType=json`, {
      headers: this.buildHeaders()
    })

    if (error || statusCode !== 200) {
      return {
        exception: {
          message: `Failed to get track page: ${this.getRequestFailureMessage(
            error,
            statusCode
          )}`,
          severity: 'fault'
        }
      }
    }

    const response = this.getWatchPageResponse(pageData)?.data?.response
    if (!response) {
      return {
        exception: {
          message: 'Failed to extract response data from page',
          severity: 'fault'
        }
      }
    }

    const dmcMedia = response.media?.domand
    const watchTrackId = response.client?.watchTrackId
    const accessRightKey = dmcMedia?.accessRightKey

    if (!dmcMedia || !watchTrackId || !accessRightKey) {
      return {
        exception: {
          message: 'Failed to extract required DMC info for stream access',
          severity: 'fault'
        }
      }
    }

    const streamRequestUrl =
      `https://nvapi.nicovideo.jp/v1/watch/${track.identifier}/access-rights/hls` +
      `?actionTrackId=${encodeURIComponent(watchTrackId)}&__retry=1`
    const postBody = { outputs: this.buildOutputData(dmcMedia) }

    const {
      body: streamData,
      headers: streamHeaders,
      error: streamError,
      statusCode: streamStatus
    } = await http1makeRequest(streamRequestUrl, {
      method: 'POST',
      headers: this.buildHeaders(accessRightKey),
      body: postBody,
      disableBodyCompression: true
    })

    if (streamError || streamStatus !== 201) {
      return {
        exception: {
          message: `Failed to get stream access rights: ${this.getRequestFailureMessage(
            streamError,
            streamStatus
          )}`,
          severity: 'fault'
        }
      }
    }

    const cookie = this.getCookieHeaderValue(streamHeaders)
    const masterPlaylistUrl =
      this.getAccessRightsResponse(streamData)?.data?.contentUrl

    if (!masterPlaylistUrl) {
      return {
        exception: {
          message: 'Failed to extract master playlist URL',
          severity: 'fault'
        }
      }
    }

    const {
      body: masterPlaylistContent,
      error: masterError,
      statusCode: masterStatus
    } = await http1makeRequest(masterPlaylistUrl, {
      headers: { Cookie: cookie ?? '' }
    })

    if (masterError || masterStatus !== 200) {
      return {
        exception: {
          message: `Failed to fetch master HLS playlist: ${this.getRequestFailureMessage(
            masterError,
            masterStatus
          )}`,
          severity: 'fault'
        }
      }
    }

    if (typeof masterPlaylistContent !== 'string') {
      return {
        exception: {
          message: 'Master playlist response was not returned as text',
          severity: 'fault'
        }
      }
    }

    const lines = masterPlaylistContent.split('\n')
    const audioTag = lines.find(
      (line) => line.startsWith('#EXT-X-MEDIA') && line.includes('TYPE=AUDIO')
    )

    if (!audioTag) {
      const result: NicoVideoTrackUrlSuccess = {
        url: masterPlaylistUrl,
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

    const audioUri = audioTag.match(/URI="([^"]+)"/)?.[1]
    if (!audioUri) {
      return {
        exception: {
          message: 'Could not parse audio URI from master playlist',
          severity: 'fault'
        }
      }
    }

    const audioPlaylistUrl = new URL(audioUri, masterPlaylistUrl).toString()
    const result: NicoVideoTrackUrlSuccess = {
      url: audioPlaylistUrl,
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
   * The current implementation does not need it after URL resolution.
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
    additionalData?: TrackUrlResult['additionalData']
  ): Promise<TrackStreamResult | NicoVideoExceptionResult> {
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

    return {
      exception: {
        message: 'Unsupported protocol',
        severity: 'common'
      }
    }
  }
}
