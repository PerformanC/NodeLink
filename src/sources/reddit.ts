import { PassThrough } from 'node:stream'
import type {
  SourceResult,
  TrackInfo,
  TrackStreamResult,
  TrackUrlResult,
  WorkerNodeLink
} from '../typings/sources/source.types.ts'
import type {
  HttpResponseHeaders,
  TrackEncodeInput
} from '../typings/utils.types.ts'
import { encodeTrack, logger, makeRequest } from '../utils.ts'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3'
const REDDIT_BASE = 'https://www.reddit.com'
const COMMENTS_REGEX = /\/comments\/([^/?]+)/
const VIDEO_REGEX = /\/video\/([^/?]+)/
const SHARE_REGEX = /\/r\/([^/]+)\/s\/([^/?]+)/

/**
 * Parsed Reddit URL components used by this source.
 */
interface RedditUrlParams {
  /**
   * Post id extracted from a canonical comments URL.
   */
  id?: string

  /**
   * Short id extracted from a `/video/` URL.
   */
  shortId?: string

  /**
   * Share id extracted from a `/r/.../s/...` URL.
   */
  shareId?: string

  /**
   * Subreddit name extracted from a share URL.
   */
  sub?: string
}

/**
 * Reddit video metadata returned by the listing JSON.
 */
interface RedditVideoPayload {
  /**
   * Fallback video URL returned by Reddit.
   */
  fallback_url?: string

  /**
   * Duration in seconds.
   */
  duration?: number
}

/**
 * Preview image payload returned by Reddit.
 */
interface RedditPreviewImage {
  /**
   * Source image payload.
   */
  source?: {
    /**
     * Image URL.
     */
    url?: string
  }
}

/**
 * Reddit post payload used by this source.
 */
interface RedditPostData {
  /**
   * Public Reddit post URL.
   */
  url?: string

  /**
   * Post title.
   */
  title?: string

  /**
   * Reddit author username.
   */
  author?: string

  /**
   * Thumbnail URL returned by the listing API.
   */
  thumbnail?: string

  /**
   * Preview images attached to the post.
   */
  preview?: {
    /**
     * Preview image list.
     */
    images?: RedditPreviewImage[]
  }

  /**
   * Secure media payload for hosted Reddit videos.
   */
  secure_media?: {
    /**
     * Reddit-hosted video payload.
     */
    reddit_video?: RedditVideoPayload
  }
}

/**
 * Track plugin payload attached to resolved Reddit tracks.
 */
interface RedditTrackPluginInfo {
  /**
   * Whether the media uses a direct redirect URL or a video/audio pair.
   */
  typeId: 'redirect' | 'tunnel'

  /**
   * Direct video URL or `[video, audio]` tuple.
   */
  urls: string | [string, string]

  /**
   * Merge type used by the legacy source when audio and video are separate.
   */
  type?: 'merge'

  /**
   * Output audio filename used by downstream tooling.
   */
  audioFilename?: string

  /**
   * Output merged filename used by downstream tooling.
   */
  filename?: string
}

/**
 * Track payload compatible with the shared encoder.
 */
interface RedditTrackInfo extends TrackEncodeInput {
  /**
   * Whether the generated track can be seeked.
   */
  isSeekable: boolean

  /**
   * Canonical Reddit post URL.
   */
  uri: string

  /**
   * Best thumbnail URL found for the post.
   */
  artworkUrl: string | null

  /**
   * Reddit does not expose ISRC values in this source path.
   */
  isrc: null
}

/**
 * Encoded Reddit track payload returned to the source manager.
 */
interface RedditTrackData {
  /**
   * Base64-encoded Lavalink-compatible track payload.
   */
  encoded: string

  /**
   * Human-readable track information.
   */
  info: RedditTrackInfo

  /**
   * Reddit-specific media metadata.
   */
  pluginInfo: RedditTrackPluginInfo
}

/**
 * Successful Reddit media resolution result.
 */
interface RedditMediaResult {
  /**
   * Final canonical Reddit post id.
   */
  resolvedId: string

  /**
   * Direct redirect URL or `[video, audio]` tuple.
   */
  urls: string | [string, string]

  /**
   * Resolution type used by the source.
   */
  typeId: 'redirect' | 'tunnel'

  /**
   * Merge type used when both video and audio streams are required.
   */
  type?: 'merge'

  /**
   * Output audio filename used by downstream tooling.
   */
  audioFilename?: string

  /**
   * Output merged filename used by downstream tooling.
   */
  filename?: string

  /**
   * Human-readable post title.
   */
  title: string

  /**
   * Human-readable author name.
   */
  author: string

  /**
   * Thumbnail URL when available.
   */
  thumbnail: string | null

  /**
   * Media duration in milliseconds.
   */
  duration: number
}

/**
 * Exception payload returned by Reddit operations.
 */
interface RedditExceptionResult {
  /**
   * Structured source exception metadata.
   */
  exception: {
    /**
     * Human-readable failure reason.
     */
    message: string

    /**
     * Error severity used by the source pipeline.
     */
    severity: string

    /**
     * Optional failure origin.
     */
    cause?: string
  }
}

/**
 * Extracts a redirect target from the helper response headers.
 *
 * @param headers - Response headers returned by the request helper.
 * @returns Redirect location, or `null` when the header is missing.
 */
function getLocationHeader(
  headers: HttpResponseHeaders | undefined
): string | null {
  const location = headers?.location
  if (Array.isArray(location)) {
    return location[0] ?? null
  }

  return typeof location === 'string' ? location : null
}

/**
 * Resolves a short Reddit URL into the canonical post id.
 *
 * @param url - Redirecting Reddit URL.
 * @param headers - Request headers forwarded to the helper.
 * @returns Canonical Reddit post id, or `null` when no redirect target exists.
 */
async function resolveRedirectingUrl(
  url: string,
  headers: Record<string, string>
): Promise<string | null> {
  const response = await makeRequest(url, { method: 'HEAD', headers })
  const location = getLocationHeader(response.headers)
  if (!location) {
    return null
  }

  const finalUrl = new URL(location, url).toString()
  return COMMENTS_REGEX.exec(finalUrl)?.[1] ?? null
}

/**
 * Reddit source implementation.
 */
export default class RedditSource {
  /**
   * Runtime worker context used by the source implementation.
   */
  public readonly nodelink: WorkerNodeLink

  /**
   * URL patterns supported by this source.
   */
  public readonly patterns: RegExp[]

  /**
   * Match priority used by the source manager.
   */
  public readonly priority: number

  /**
   * Creates a new Reddit source wrapper.
   *
   * @param nodelink - Worker runtime used by the source implementation.
   */
  public constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
    this.patterns = [
      /^https?:\/\/(?:www\.)?reddit\.com\/r\/[^/]+\/comments\/[^/]+/,
      /^https?:\/\/(?:www\.)?reddit\.com\/video\/[^/]+/,
      /^https?:\/\/(?:www\.)?reddit\.com\/r\/[^/]+\/s\/[^/]+/
    ]
    this.priority = 65
  }

  /**
   * Initializes the source.
   *
   * @returns `true` once the source has been registered.
   */
  public async setup(): Promise<boolean> {
    return true
  }

  /**
   * Reddit does not support text search in this source.
   *
   * @returns Exception payload describing the unsupported operation.
   */
  public async search(): Promise<SourceResult> {
    return {
      exception: {
        message: 'Search not supported for Reddit',
        severity: 'common'
      }
    }
  }

  /**
   * Resolves a Reddit post URL into a single playable track.
   *
   * @param url - Candidate Reddit URL.
   * @returns Track payload or an exception payload when the post cannot be
   * resolved into playable media.
   */
  public async resolve(url: string): Promise<SourceResult> {
    const params = this.parseUrl(url)
    const result = await this.getRedditTrack(params)

    if ('error' in result) {
      return {
        exception: {
          message: result.error,
          severity: 'fault'
        }
      }
    }

    const track = this.buildTrack({
      identifier:
        result.resolvedId ||
        params.id ||
        params.shortId ||
        params.shareId ||
        url,
      title: result.title || 'Reddit Video',
      author: result.author || 'Reddit',
      uri: url,
      length: result.duration || -1,
      isSeekable: true,
      isStream: false,
      artworkUrl: result.thumbnail,
      pluginInfo: {
        typeId: result.typeId,
        urls: result.urls,
        type: result.type,
        audioFilename: result.audioFilename,
        filename: result.filename
      }
    })

    return { loadType: 'track', data: track }
  }

  /**
   * Resolves the direct media URL for a Reddit track.
   *
   * @param track - Decoded Reddit track information.
   * @returns Direct media URL descriptor or an exception payload when the post
   * cannot be re-resolved.
   */
  public async getTrackUrl(
    track: TrackInfo
  ): Promise<TrackUrlResult | RedditExceptionResult> {
    const result = await this.getRedditTrack(this.parseUrl(track.uri))

    if ('error' in result) {
      return { exception: { message: result.error, severity: 'fault' } }
    }

    if (result.typeId === 'tunnel') {
      const audioUrl = result.urls[1]
      return {
        url: audioUrl,
        protocol: 'https',
        format: 'mp3'
      }
    }

    const directUrl = Array.isArray(result.urls) ? result.urls[0] : result.urls
    return {
      url: directUrl,
      protocol: 'https',
      format: 'mp4'
    }
  }

  /**
   * Opens a Reddit media stream from a direct media URL.
   *
   * @param decodedTrack - Decoded track metadata being played.
   * @param url - Direct Reddit media URL.
   * @returns Playable stream payload or an exception payload when the upstream
   * request fails.
   */
  public async loadStream(
    decodedTrack: TrackInfo,
    url: string
  ): Promise<TrackStreamResult | RedditExceptionResult> {
    logger(
      'debug',
      'Sources',
      `Loading Reddit stream for "${decodedTrack.title}"`
    )

    try {
      const response = await makeRequest(url, {
        method: 'GET',
        streamOnly: true
      })

      if (response.error || !response.stream) {
        throw new Error(
          response.error || 'Failed to get stream, no stream object returned.'
        )
      }

      if (response.statusCode !== 200) {
        throw new Error(`Reddit returned status ${response.statusCode}`)
      }

      const stream = new PassThrough()
      response.stream.pipe(stream)

      const type = url.endsWith('.mp3') ? 'mp3' : 'mp4'
      return { stream, type }
    } catch (error) {
      return {
        exception: {
          message:
            error instanceof Error ? error.message : 'Failed to load stream.',
          severity: 'common',
          cause: 'Upstream'
        }
      }
    }
  }

  /**
   * Parses a Reddit URL into the identifier components used by this source.
   *
   * @param url - Candidate Reddit URL.
   * @returns Parsed Reddit URL components.
   */
  private parseUrl(url: string): RedditUrlParams {
    const videoMatch = VIDEO_REGEX.exec(url)
    if (videoMatch?.[1]) {
      return { shortId: videoMatch[1] }
    }

    const commentsMatch = COMMENTS_REGEX.exec(url)
    if (commentsMatch?.[1]) {
      return { id: commentsMatch[1] }
    }

    const shareMatch = SHARE_REGEX.exec(url)
    if (shareMatch?.[1] && shareMatch[2]) {
      return { sub: shareMatch[1], shareId: shareMatch[2] }
    }

    return {}
  }

  /**
   * Fetches and resolves the Reddit media metadata for a given URL parameter
   * set.
   *
   * @param params - Parsed Reddit URL components.
   * @returns Resolved Reddit media payload or an `{ error }` result when media
   * resolution fails.
   */
  private async getRedditTrack(
    params: RedditUrlParams
  ): Promise<RedditMediaResult | { error: string }> {
    const headers = {
      'user-agent': USER_AGENT,
      accept: 'application/json'
    }
    let currentParams: RedditUrlParams = { ...params }

    if (currentParams.shortId) {
      const id = await resolveRedirectingUrl(
        `${REDDIT_BASE}/video/${currentParams.shortId}`,
        headers
      )
      if (id) {
        currentParams = { id }
      }
    }

    if (!currentParams.id && currentParams.shareId && currentParams.sub) {
      const id = await resolveRedirectingUrl(
        `${REDDIT_BASE}/r/${currentParams.sub}/s/${currentParams.shareId}`,
        headers
      )
      if (id) {
        currentParams = { ...currentParams, id }
      }
    }

    if (!currentParams.id) {
      return { error: 'fetch.short_link' }
    }

    const response = await makeRequest(
      `${REDDIT_BASE}/comments/${currentParams.id}.json`,
      { method: 'GET', headers }
    )

    if (
      response.error ||
      response.statusCode !== 200 ||
      !Array.isArray(response.body)
    ) {
      return { error: 'fetch.fail' }
    }

    const postData = this.getPostData(response.body)
    if (!postData) {
      return { error: 'fetch.fail' }
    }

    if (postData.url?.endsWith('.gif')) {
      return { error: 'gifs are not supported' }
    }

    const redditVideo = postData.secure_media?.reddit_video
    if (!redditVideo?.fallback_url) {
      return { error: 'fetch.empty' }
    }

    const videoUrl = redditVideo.fallback_url.split('?')[0]
    if (!videoUrl) {
      return { error: 'fetch.empty' }
    }

    const audioUrl = await this.findAudioUrl(videoUrl)
    const author =
      typeof postData.author === 'string' && postData.author.length > 0
        ? `u/${postData.author}`
        : 'Reddit'
    const thumbnail =
      postData.thumbnail || postData.preview?.images?.[0]?.source?.url || null
    const commonData = {
      resolvedId: currentParams.id,
      title: postData.title || 'Reddit Video',
      author,
      thumbnail,
      duration: (redditVideo.duration || 0) * 1000
    }

    if (!audioUrl) {
      return {
        typeId: 'redirect',
        urls: videoUrl,
        ...commonData
      }
    }

    const sourceId = currentParams.sub
      ? `${currentParams.sub.toLowerCase()}_${currentParams.id}`
      : currentParams.id

    return {
      typeId: 'tunnel',
      type: 'merge',
      urls: [videoUrl, audioUrl],
      audioFilename: `reddit_${sourceId}_audio`,
      filename: `reddit_${sourceId}.mp4`,
      ...commonData
    }
  }

  /**
   * Extracts the Reddit post data block from the listing response.
   *
   * @param responseBody - Parsed JSON body returned by Reddit.
   * @returns Reddit post payload, or `null` when the expected listing shape is
   * missing.
   */
  private getPostData(responseBody: object[]): RedditPostData | null {
    const firstListing = responseBody[0] as {
      data?: {
        children?: Array<{
          data?: RedditPostData
        }>
      }
    }

    return firstListing.data?.children?.[0]?.data ?? null
  }

  /**
   * Looks for the best matching audio URL alongside a Reddit DASH video URL.
   *
   * @param videoUrl - Direct Reddit fallback video URL.
   * @returns Matching audio URL, or `null` when no accessible audio variant is
   * found.
   */
  private async findAudioUrl(videoUrl: string): Promise<string | null> {
    const baseUrl = videoUrl.split('_')[0] ?? videoUrl
    const dashPrefix = videoUrl.split('DASH')[0] ?? videoUrl
    const audioVariants = [
      videoUrl.includes('.mp4') ? `${baseUrl}_audio.mp4` : `${dashPrefix}audio`,
      `${baseUrl}_AUDIO_128.mp4`,
      `${baseUrl}_audio.mp3`,
      `${baseUrl}_AUDIO_128.mp3`
    ]

    for (const audioUrl of audioVariants) {
      const response = await makeRequest(audioUrl, { method: 'HEAD' })
      if (response.statusCode === 200) {
        return audioUrl
      }
    }

    return null
  }

  /**
   * Builds the encoded track payload for a Reddit post.
   *
   * @param partialInfo - Track metadata and plugin payload used by the encoder.
   * @returns Track payload compatible with the shared encoder and source
   * manager contracts.
   */
  private buildTrack(partialInfo: {
    identifier: string
    title: string
    author: string
    uri: string
    length: number
    isSeekable: boolean
    isStream: boolean
    artworkUrl: string | null
    pluginInfo: RedditTrackPluginInfo
  }): RedditTrackData {
    const track: RedditTrackInfo = {
      identifier: partialInfo.identifier,
      isSeekable: !partialInfo.isStream,
      author: partialInfo.author,
      length: partialInfo.length,
      isStream: partialInfo.isStream,
      position: 0,
      title: partialInfo.title,
      uri: partialInfo.uri,
      artworkUrl: partialInfo.artworkUrl,
      isrc: null,
      sourceName: 'reddit',
      details: []
    }

    return {
      encoded: encodeTrack(track),
      info: track,
      pluginInfo: partialInfo.pluginInfo
    }
  }
}
