import { PassThrough } from 'node:stream'
import type {
  SourceResult,
  TrackInfo,
  TrackStreamResult,
  TrackUrlResult,
  WorkerNodeLink
} from '../typings/sources/source.types.ts'
import type { TrackEncodeInput } from '../typings/utils.types.ts'
import { encodeTrack, http1makeRequest, logger } from '../utils.ts'

/**
 * JSON-compatible object used for payload narrowing.
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
 * Pinterest video format entry returned by the pin API.
 */
interface PinterestVideoFormat {
  /**
   * Direct media URL for the format.
   */
  url?: string

  /**
   * Duration in milliseconds when reported by Pinterest.
   */
  duration?: number
}

/**
 * Pinterest video list keyed by quality label.
 */
interface PinterestVideoList {
  /**
   * 720p video entry when available.
   */
  V_720P?: PinterestVideoFormat

  /**
   * 540p video entry when available.
   */
  V_540P?: PinterestVideoFormat

  /**
   * 360p video entry when available.
   */
  V_360P?: PinterestVideoFormat

  /**
   * Additional Pinterest-specific video entries.
   */
  [key: string]: PinterestVideoFormat | undefined
}

/**
 * Story block payload that may contain a video list.
 */
interface PinterestStoryBlock {
  /**
   * Embedded video payload for the block.
   */
  video?: {
    video_list?: PinterestVideoList
  }
}

/**
 * Pinterest image payload keyed by image variant.
 */
interface PinterestImages {
  /**
   * Original-size image when reported by the API.
   */
  orig?: {
    url?: string
  }

  /**
   * Additional Pinterest-specific image entries.
   */
  [key: string]: { url?: string } | undefined
}

/**
 * Pin payload returned by the Pinterest resource endpoint.
 */
interface PinterestPinData {
  /**
   * Direct video variants for standard pins.
   */
  videos?: {
    video_list?: PinterestVideoList
  }

  /**
   * Story pin payload used by some Pinterest posts.
   */
  story_pin_data?: {
    pages?: Array<{
      blocks?: PinterestStoryBlock[]
    }>
  }

  /**
   * Image variants attached to the pin.
   */
  images?: PinterestImages

  /**
   * Attribution metadata for the pin author.
   */
  closeup_attribution?: {
    full_name?: string
  }

  /**
   * Fallback author metadata.
   */
  pinner?: {
    full_name?: string
  }

  /**
   * Primary title returned by the API.
   */
  title?: string

  /**
   * Secondary grid title returned by some pins.
   */
  grid_title?: string
}

/**
 * Narrowed API response returned by the Pinterest pin resource endpoint.
 */
interface PinterestApiResponse {
  /**
   * Nested resource response payload.
   */
  resource_response?: {
    data?: PinterestPinData
  }
}

/**
 * Stream error payload returned when streaming fails.
 */
interface PinterestStreamError {
  /**
   * Streaming exception returned to the caller.
   */
  exception: {
    message: string
    severity: string
  }
}

/**
 * Pinterest track payload compatible with both the shared encoder and the
 * source manager response contract.
 */
interface PinterestTrackInfo extends TrackEncodeInput {
  /**
   * Whether the generated track can be seeked.
   */
  isSeekable: boolean

  /**
   * Canonical Pinterest pin URL.
   */
  uri: string

  /**
   * Artwork URL attached to the pin.
   */
  artworkUrl: string | null

  /**
   * Pinterest does not expose ISRC values, so this stays `null`.
   */
  isrc: string | null
}

/**
 * Pinterest source implementation.
 */
export default class PinterestSource {
  /**
   * Runtime NodeLink context.
   */
  public readonly nodelink: WorkerNodeLink

  /**
   * Cached runtime configuration.
   */
  public readonly config: WorkerNodeLink['options']

  /**
   * URL patterns handled by the source.
   */
  public readonly patterns: RegExp[]

  /**
   * URL matching priority for the source manager.
   */
  public readonly priority: number

  /**
   * Creates the Pinterest source wrapper.
   *
   * @param nodelink - Worker runtime used by the source implementation.
   */
  public constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
    this.config = nodelink.options
    this.patterns = [
      /https?:\/\/(?:[^/]+\.)?pinterest\.(?:com|fr|de|ch|jp|cl|ca|it|co\.uk|nz|ru|com\.au|at|pt|co\.kr|es|com\.mx|dk|ph|th|com\.uy|co|nl|info|kr|ie|vn|com\.vn|ec|mx|in|pe|co\.at|hu|co\.in|co\.nz|id|com\.ec|com\.py|tw|be|uk|com\.bo|com\.pe)\/pin\/(?:[\w-]+--)?(\d+)/i
    ]
    this.priority = 100
  }

  /**
   * Validates whether the provided value is a plain object record.
   *
   * @param value - Candidate response payload.
   * @returns `true` when the value can be safely indexed.
   */
  private isObjectRecord(value: JsonRecord[string]): value is JsonRecord {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  }

  /**
   * Builds the Pinterest resource URL used to query pin metadata.
   *
   * @param videoId - Pinterest pin identifier.
   * @returns Fully qualified Pinterest resource URL.
   */
  private buildPinResourceUrl(videoId: string): string {
    return `https://www.pinterest.com/resource/PinResource/get/?data=${encodeURIComponent(
      JSON.stringify({
        options: {
          field_set_key: 'unauth_react_main_pin',
          id: videoId
        }
      })
    )}`
  }

  /**
   * Extracts the pin identifier from a Pinterest URL.
   *
   * @param url - Candidate Pinterest URL.
   * @returns Pin identifier, or `null` when the URL does not match the source
   * pattern.
   */
  private getVideoId(url: string): string | null {
    const pattern = this.patterns[0]
    if (!pattern) {
      return null
    }

    const match = url.match(pattern)
    return match?.[1] ?? null
  }

  /**
   * Narrows the raw HTTP response body returned by Pinterest.
   *
   * @param value - Raw response body.
   * @returns Typed Pinterest API response, or `null` when the payload does not
   * match the expected structure.
   */
  private getPinterestApiResponse(
    value: JsonRecord[string]
  ): PinterestApiResponse | null {
    if (!this.isObjectRecord(value)) {
      return null
    }

    const payload = value as {
      resource_response?: JsonRecord[string]
    }
    const resourceResponse = payload.resource_response
    if (!this.isObjectRecord(resourceResponse)) {
      return null
    }

    const data = (resourceResponse as { data?: JsonRecord[string] }).data
    if (!this.isObjectRecord(data)) {
      return null
    }

    const parsedData = this.getPinData(data)
    if (!parsedData) {
      return null
    }

    return {
      resource_response: {
        data: parsedData
      }
    }
  }

  /**
   * Narrows a raw pin payload from the Pinterest API.
   *
   * @param value - Candidate pin payload.
   * @returns Typed pin data, or `null` when the payload is not object-like.
   */
  private getPinData(value: JsonRecord[string]): PinterestPinData | null {
    if (!this.isObjectRecord(value)) {
      return null
    }

    return value as PinterestPinData
  }

  /**
   * Resolves the video list from either a standard pin or a story pin block.
   *
   * @param data - Typed pin payload.
   * @returns Available video list, or `null` when the pin has no playable
   * video payload.
   */
  private getVideoList(data: PinterestPinData): PinterestVideoList | null {
    if (data.videos?.video_list) {
      return data.videos.video_list
    }

    const blocks = data.story_pin_data?.pages?.[0]?.blocks
    if (!Array.isArray(blocks)) {
      return null
    }

    for (const block of blocks) {
      if (block.video?.video_list) {
        return block.video.video_list
      }
    }

    return null
  }

  /**
   * Selects the preferred playable video format from the Pinterest payload.
   *
   * @param videoList - Available Pinterest video variants.
   * @returns Preferred format, or `null` when no usable format exists.
   */
  private getPreferredFormat(
    videoList: PinterestVideoList | null
  ): PinterestVideoFormat | null {
    if (!videoList) {
      return null
    }

    return (
      videoList.V_720P ??
      videoList.V_540P ??
      videoList.V_360P ??
      Object.values(videoList)[0] ??
      null
    )
  }

  /**
   * Selects the first MP4-compatible format from the Pinterest payload.
   *
   * @param videoList - Available Pinterest video variants.
   * @returns First playable MP4-capable format, or `null` when none are found.
   */
  private getPlayableFormat(
    videoList: PinterestVideoList | null
  ): PinterestVideoFormat | null {
    if (!videoList) {
      return null
    }

    if (videoList.V_720P?.url) return videoList.V_720P
    if (videoList.V_540P?.url) return videoList.V_540P
    if (videoList.V_360P?.url) return videoList.V_360P

    for (const format of Object.values(videoList)) {
      if (format?.url?.endsWith('.mp4')) {
        return format
      }
    }

    return null
  }

  /**
   * Resolves the best artwork URL attached to the pin payload.
   *
   * @param images - Pinterest image variants.
   * @returns Artwork URL, or `null` when no image URL exists.
   */
  private getArtworkUrl(images: PinterestImages | undefined): string | null {
    if (typeof images?.orig?.url === 'string' && images.orig.url.length > 0) {
      return images.orig.url
    }

    if (!images) {
      return null
    }

    for (const image of Object.values(images)) {
      if (typeof image?.url === 'string' && image.url.length > 0) {
        return image.url
      }
    }

    return null
  }

  /**
   * Builds the encoded track information returned by the source manager.
   *
   * @param videoId - Pinterest pin identifier.
   * @param data - Typed pin payload.
   * @param format - Preferred playable format.
   * @returns Track payload compatible with the shared encoder.
   */
  private createTrackInfo(
    videoId: string,
    data: PinterestPinData,
    format: PinterestVideoFormat
  ): PinterestTrackInfo {
    return {
      identifier: videoId,
      isSeekable: true,
      author:
        data.closeup_attribution?.full_name ??
        data.pinner?.full_name ??
        'Unknown Artist',
      length:
        typeof format.duration === 'number' && Number.isFinite(format.duration)
          ? Math.round(format.duration)
          : 0,
      isStream: false,
      position: 0,
      title: data.title ?? data.grid_title ?? 'Pinterest Video',
      uri: `https://www.pinterest.com/pin/${videoId}/`,
      artworkUrl: this.getArtworkUrl(data.images),
      isrc: null,
      sourceName: 'pinterest',
      details: []
    }
  }

  /**
   * Fetches and narrows the Pinterest pin payload for a specific pin id.
   *
   * @param videoId - Pinterest pin identifier.
   * @returns Typed pin payload, or `null` when the API response is missing or
   * malformed.
   */
  private async fetchPinData(
    videoId: string
  ): Promise<PinterestPinData | null> {
    const response = await http1makeRequest(this.buildPinResourceUrl(videoId), {
      headers: {
        'X-Pinterest-PWS-Handler': 'www/[username].js'
      }
    })

    if (response.statusCode !== 200) {
      return null
    }

    return (
      this.getPinterestApiResponse(response.body as JsonRecord[string])
        ?.resource_response?.data ?? null
    )
  }

  /**
   * Initializes the source.
   *
   * The Pinterest source does not require any asynchronous bootstrapping, so
   * setup always succeeds.
   *
   * @returns `true` to indicate the source is ready.
   */
  public async setup(): Promise<boolean> {
    return true
  }

  /**
   * Resolves a Pinterest URL to a playable encoded track payload.
   *
   * @param url - Candidate Pinterest pin URL.
   * @returns Source resolution result describing either a playable track, an
   * empty response, or an error payload.
   */
  public async resolve(url: string): Promise<SourceResult> {
    const videoId = this.getVideoId(url)
    if (videoId === null) {
      return { loadType: 'empty', data: {} }
    }

    try {
      const data = await this.fetchPinData(videoId)
      if (!data) {
        return { loadType: 'empty', data: {} }
      }

      const bestFormat = this.getPreferredFormat(this.getVideoList(data))
      if (!bestFormat) {
        return { loadType: 'empty', data: {} }
      }

      const trackInfo = this.createTrackInfo(videoId, data, bestFormat)

      return {
        loadType: 'track',
        data: {
          encoded: encodeTrack(trackInfo),
          info: trackInfo
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Pinterest resolution failed.'
      logger('error', 'Pinterest', `Resolution failed: ${message}`)
      return {
        loadType: 'error',
        data: { message, severity: 'fault' }
      }
    }
  }

  /**
   * Resolves the direct stream URL for a Pinterest track.
   *
   * @param decodedTrack - Decoded track information previously returned by the
   * resolver.
   * @returns Direct HTTP track URL and its container metadata.
   * @throws Error when Pinterest does not expose a playable MP4 stream.
   */
  public async getTrackUrl(decodedTrack: TrackInfo): Promise<TrackUrlResult> {
    const videoId = decodedTrack.identifier

    try {
      const data = await this.fetchPinData(videoId)
      if (!data) {
        throw new Error('Failed to fetch Pinterest video URL')
      }

      const format = this.getPlayableFormat(this.getVideoList(data))
      if (!format?.url) {
        throw new Error('No MP4 format found for Pinterest video')
      }

      return { url: format.url, protocol: 'http', format: 'mp4' }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to get track URL.'
      logger('error', 'Pinterest', `Failed to get track URL: ${message}`)
      throw error
    }
  }

  /**
   * Opens a proxied stream for a Pinterest video URL.
   *
   * The upstream stream is piped through a local `PassThrough` so the player
   * can receive buffering lifecycle events without depending on the original
   * HTTP stream object.
   *
   * @param _decodedTrack - Decoded track metadata, unused by this source.
   * @param url - Direct media URL returned by `getTrackUrl(...)`.
   * @param _protocol - Protocol hint, unused by this source.
   * @param _additionalData - Additional stream metadata, unused by this source.
   * @returns Playable stream payload, or an exception object when the upstream
   * request fails.
   */
  public async loadStream(
    _decodedTrack: TrackInfo,
    url: string,
    _protocol?: string,
    _additionalData?: Record<string, object | string | number | boolean | null>
  ): Promise<TrackStreamResult | PinterestStreamError> {
    try {
      const response = await http1makeRequest(url, {
        method: 'GET',
        streamOnly: true,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3',
          Accept: '*/*'
        }
      })

      if (response.error || !response.stream) {
        throw new Error(
          typeof response.error === 'string' && response.error.length > 0
            ? response.error
            : 'Failed to get stream, no stream object returned.'
        )
      }

      const stream = new PassThrough()
      response.stream.on('data', (chunk: Buffer) => {
        stream.write(chunk)
      })
      response.stream.on('end', () => {
        stream.emit('finishBuffering')
      })
      response.stream.on('error', (error: Error) => {
        logger('error', 'Pinterest', `Upstream stream error: ${error.message}`)
        stream.emit('error', error)
        stream.emit('finishBuffering')
      })

      return { stream, type: 'mp4' }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to load stream.'
      logger('error', 'Pinterest', `Failed to load stream: ${message}`)
      return {
        exception: {
          message,
          severity: 'fault'
        }
      }
    }
  }
}
