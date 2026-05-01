import { PassThrough } from 'node:stream'

import type {
  SourceInstance,
  SourceResult,
  TrackData,
  TrackInfo,
  TrackStreamResult,
  TrackUrlResult,
  WorkerNodeLink
} from '../typings/sources/source.types.ts'
import type { TrackEncodeInput } from '../typings/utils.types.ts'
import { encodeTrack, http1makeRequest, logger } from '../utils.ts'

/**
 * Browser user agent sent with TikTok requests.
 * @internal
 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'

/**
 * TikTok player API endpoint used by embeds.
 * @internal
 */
const API_BASE = 'https://www.tiktok.com/player/api/v1/items'

/**
 * Regex pattern to extract the video ID from a TikTok URL.
 * @internal
 */
const VIDEO_ID_RE = /\/video\/(\d{15,})/

/**
 * JSON-compatible item structure returned by the TikTok player API.
 * @internal
 */
interface TikTokApiItem {
  author_info?: { nickname?: string }
  desc?: string
  video_info?: {
    meta?: { duration?: number }
    cover?: { url_list?: unknown[] }
    profiles?: Array<{ play_addr?: { url_list?: unknown[] } }>
    url_list?: unknown[]
  }
}

/**
 * Returns the first valid string from an array of unknown values.
 * @param list - Array of unknown values (usually strings from API).
 * @returns The first valid string, or an empty string if none found.
 * @internal
 */
function firstString(list: unknown): string {
  if (Array.isArray(list)) {
    for (const v of list) {
      if (typeof v === 'string' && v.length) return v
    }
  }
  return ''
}

/**
 * TikTok source implementation.
 *
 * Resolves `tiktok.com/@user/video/ID` URLs and extracts MP4 playback streams
 * using the TikTok player API endpoint.
 * @public
 */
export default class TiktokSource implements SourceInstance {
  /**
   * Runtime worker context.
   */
  public readonly nodelink: WorkerNodeLink

  /**
   * URL patterns this source handles.
   */
  public readonly patterns: RegExp[]

  /**
   * Match priority used by the source manager (higher wins).
   */
  public readonly priority: number

  /**
   * Creates a new TikTok source wrapper.
   * @param nodelink - Worker runtime context.
   */
  public constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
    this.patterns = [
      /^https?:\/\/(?:www\.)?tiktok\.com\/@[\w.-]+\/video\/(\d+)/i,
      /^https?:\/\/(?:www\.)?vm\.tiktok\.com\/([\w-]+)/i,
      /^https?:\/\/(?:www\.)?m\.tiktok\.com\/([\w-]+)/i
    ]
    this.priority = 60
  }

  /**
   * Initializes source resources. No async setup required.
   * @returns `true` when the source is ready to accept requests.
   */
  public async setup(): Promise<boolean> {
    logger('info', 'Sources', 'Loaded TikTok source.')
    return true
  }

  /**
   * TikTok does not support keyword search.
   * @param _query - Unused search query.
   * @param _sourceName - Unused source name.
   * @param _searchType - Unused search type.
   * @returns An empty result.
   */
  public async search(
    _query?: string,
    _sourceName?: string,
    _searchType?: string
  ): Promise<SourceResult> {
    return { loadType: 'empty', data: {} }
  }

  /**
   * Resolves a TikTok video URL into a playable track.
   *
   * Fetches metadata and playback URLs from the TikTok player API endpoint.
   * @param url - Public TikTok video URL.
   * @param _type - Unused type hint kept for source-manager compatibility.
   * @returns A track result, an empty payload, or a structured exception.
   */
  public async resolve(url: string, _type?: string): Promise<SourceResult> {
    const match = url.match(VIDEO_ID_RE)
    const videoId = match?.[1]
    if (!videoId) return { loadType: 'empty', data: {} }

    try {
      const params = new URLSearchParams({
        item_ids: videoId,
        language: 'en',
        aid: '1284',
        app_name: 'tiktok_web',
        device_platform: 'web_pc'
      })

      const response = await http1makeRequest(`${API_BASE}?${params}`, {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          Referer: `https://www.tiktok.com/player/v1/${videoId}`,
          Accept: 'application/json, text/plain, */*'
        }
      })

      if (response.error || response.statusCode !== 200) {
        return {
          loadType: 'error',
          exception: {
            message: `TikTok API failed: ${response.error || `Status ${response.statusCode}`}`,
            severity: 'fault'
          }
        }
      }

      let data = response.body
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data)
        } catch {
          return {
            loadType: 'error',
            exception: { message: 'Invalid TikTok JSON', severity: 'fault' }
          }
        }
      }

      const items = (data as Record<string, unknown>)?.items
      const item = (Array.isArray(items) ? items[0] : undefined) as
        | TikTokApiItem
        | undefined
      if (!item) return { loadType: 'empty', data: {} }

      const vi = item.video_info ?? {}

      const profile = Array.isArray(vi.profiles) ? vi.profiles[0] : null
      const directUrl: string =
        firstString(profile?.play_addr?.url_list) || firstString(vi.url_list)

      if (!directUrl) {
        return {
          loadType: 'error',
          exception: {
            message: 'No playback URL in TikTok response',
            severity: 'fault'
          }
        }
      }

      const author: string = item.author_info?.nickname || 'TikTok User'
      const desc: string = item.desc || ''
      const title: string = desc.split('#')[0]?.trim() || 'TikTok Video'

      const rawDuration: number = vi.meta?.duration ?? 0
      const durationMs: number =
        rawDuration > 0
          ? rawDuration < 1000
            ? rawDuration * 1000
            : rawDuration
          : -1

      const thumbnail: string | null = firstString(vi.cover?.url_list) || null

      const info: TrackEncodeInput = {
        identifier: videoId,
        isSeekable: true,
        author,
        length: durationMs,
        isStream: false,
        position: 0,
        title,
        uri: url,
        artworkUrl: thumbnail,
        isrc: null,
        sourceName: 'tiktok',
        details: []
      }

      const trackData: TrackData = {
        encoded: encodeTrack(info),
        info: info as unknown as TrackInfo,
        pluginInfo: { directUrl, videoId }
      }

      return { loadType: 'track', data: trackData }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger('error', 'TikTok', `Resolve failed: ${message}`)
      return { loadType: 'error', exception: { message, severity: 'fault' } }
    }
  }

  /**
   * Returns the cached or resolved direct playback URL.
   *
   * When the track already carries a `pluginInfo.directUrl`, the URL is
   * returned immediately. Otherwise the video is re-resolved.
   * @param trackInfo - Decoded TikTok track information.
   * @param _itag - Unused itag placeholder kept for source-manager compatibility.
   * @param _isRecovering - Whether this is a recovery attempt.
   * @returns Direct playback URL metadata or a structured exception.
   */
  public async getTrackUrl(
    trackInfo: TrackInfo,
    _itag?: number,
    _isRecovering?: boolean
  ): Promise<TrackUrlResult> {
    const pluginInfo = (trackInfo as { pluginInfo?: Record<string, unknown> })
      .pluginInfo
    const directUrl = pluginInfo?.directUrl as string | undefined

    if (directUrl && typeof directUrl === 'string') {
      return { url: directUrl, protocol: 'https', format: 'mp4' }
    }

    const uri = trackInfo.uri
    if (uri && VIDEO_ID_RE.test(uri)) {
      const result = await this.resolve(uri)
      if (result.loadType === 'track') {
        const trackData = result.data as TrackData
        const url = trackData?.pluginInfo?.directUrl as string | undefined
        if (url) return { url, protocol: 'https', format: 'mp4' }
      }
    }

    return {
      url: undefined,
      protocol: undefined,
      format: undefined,
      exception: {
        message: 'No playable URL for TikTok track',
        severity: 'fault'
      }
    }
  }

  /**
   * Loads the MP4 stream for a TikTok video.
   *
   * Proxies the direct playback URL through a `PassThrough` stream.
   * @param track - Decoded track information.
   * @param url - Resolved playback URL.
   * @param _protocol - Optional protocol hint (unused).
   * @param _additionalData - Optional additional data (unused).
   * @returns A readable stream or a structured exception.
   */
  public async loadStream(
    _track: TrackInfo,
    url: string,
    _protocol?: string,
    _additionalData?: Record<string, unknown>
  ): Promise<TrackStreamResult> {
    try {
      const response = await http1makeRequest(url, {
        method: 'GET',
        streamOnly: true,
        headers: {
          'User-Agent': USER_AGENT,
          Referer: 'https://www.tiktok.com/'
        }
      })

      if (response.error || !response.stream) {
        throw new Error(response.error || 'No stream returned')
      }

      const stream = new PassThrough()
      response.stream.on('data', (chunk: Buffer) => stream.write(chunk))
      response.stream.on('end', () => {
        stream.emit('finishBuffering')
        stream.end()
      })
      response.stream.on('error', (err: Error) => stream.destroy(err))

      return { stream, type: 'video/mp4' }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return {
        stream: undefined,
        type: undefined,
        exception: { message, severity: 'fault' }
      }
    }
  }
}
