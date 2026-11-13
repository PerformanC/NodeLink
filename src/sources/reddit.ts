import { PassThrough } from 'node:stream'
import HLSHandler from '../playback/hls/HLSHandler.ts'
import type {
  SourceInstance,
  SourceResult,
  TrackData,
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
import { encodeTrack, logger, makeRequest } from '../utils.ts'

/**
 * Desktop user agent used for Reddit embed page requests.
 * @internal
 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * Reddit embed domain used for anonymous embed rendering without anti-bot challenges.
 * @internal
 */
const REDDITMEDIA_BASE = 'https://www.redditmedia.com'

/**
 * Regex matching direct v.redd.it URLs.
 * @internal
 */
const V_REDDIT_REGEX = /^https?:\/\/v\.redd\.it\/([a-zA-Z0-9]+)/i

/**
 * Supported Reddit URL patterns.
 * @internal
 */
const REDDIT_PATTERNS = [
  /^https?:\/\/(?:(?:www|old|new|embed)\.)?(?:reddit|redditmedia)\.com\/(?:(?:r|user)\/[^/]+\/)?comments\/[^/?#&]+/i,
  /^https?:\/\/(?:(?:www|old|new)\.)?reddit\.com\/video\/[^/?#&]+/i,
  /^https?:\/\/(?:(?:www|old|new)\.)?reddit\.com\/r\/[^/]+\/s\/[^/?#&]+/i,
  /^https?:\/\/v\.redd\.it\/[^/?#&]+/i
]

/**
 * Reddit source implementation.
 *
 * Resolves public Reddit video submissions through the anonymous embed flow
 * (`redditmedia.com`) and streams audio via HLS manifests.
 *
 * @public
 */
export default class RedditSource
  implements SourceInstance, SourceVariantHandler
{
  /**
   * NodeLink worker context.
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
   * Test suite cases validating Reddit video resolution and playback.
   */
  public static readonly _TESTS: SourceTestCase[] = [
    {
      id: 'reddit.video.cringe',
      name: 'Reddit video playback (cringe)',
      input: {
        type: 'resolve',
        value:
          'https://www.reddit.com/r/dumbfuckers_club/comments/zjjw82/cringe/'
      },
      matrix: {
        variants: [{ id: 'Standard' }]
      },
      expect: {
        result: {
          type: 'track'
        },
        metadata: {
          title: {
            op: 'matches',
            value: 'Cringe'
          },
          sourceName: {
            op: 'equals',
            value: 'reddit'
          }
        },
        stream: {
          required: true,
          download: 'complete',
          minBytes: 100000,
          validFormats: [{ container: 'mp4', codec: 'aac' }]
        }
      }
    },
    {
      id: 'reddit.video.heart_attack',
      name: 'Reddit video resolution (small heart attack)',
      input: {
        type: 'resolve',
        value:
          'https://www.reddit.com/r/videos/comments/6rrwyj/that_small_heart_attack/'
      },
      matrix: {
        variants: [{ id: 'Standard' }]
      },
      expect: {
        result: {
          type: 'track'
        },
        metadata: {
          title: {
            op: 'matches',
            value: 'heart attack'
          },
          sourceName: {
            op: 'equals',
            value: 'reddit'
          }
        }
      }
    }
  ]

  /**
   * Creates a new Reddit source wrapper.
   *
   * @param nodelink - Worker runtime context.
   */
  public constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
    this.patterns = REDDIT_PATTERNS
    this.priority = 65
  }

  /**
   * Initializes the source.
   *
   * @returns `true` once registered.
   */
  public async setup(): Promise<boolean> {
    logger('info', 'Sources', 'Loaded Reddit source.')
    return true
  }

  /**
   * Text search is not supported by Reddit.
   *
   * @returns Empty search result.
   */
  public async search(): Promise<SourceResult> {
    return { loadType: 'empty', data: {} }
  }

  /**
   * Resolves a Reddit post or direct video URL into a playable track.
   *
   * @param url - Candidate Reddit URL.
   * @returns Track payload or an empty/error result.
   */
  public async resolve(url: string): Promise<SourceResult> {
    try {
      const vRedditMatch = V_REDDIT_REGEX.exec(url)
      if (vRedditMatch?.[1]) {
        const videoId = vRedditMatch[1]
        const hlsUrl = `https://v.redd.it/${videoId}/HLSPlaylist.m3u8`
        const trackInfo: TrackInfo = {
          identifier: videoId,
          isSeekable: true,
          author: 'Reddit',
          length: 0,
          isStream: false,
          position: 0,
          title: 'Reddit Video',
          uri: url,
          artworkUrl: null,
          isrc: null,
          sourceName: 'reddit'
        }

        return {
          loadType: 'track',
          data: {
            encoded: encodeTrack({ ...trackInfo, details: [] }),
            info: trackInfo,
            pluginInfo: { directUrl: hlsUrl, isHLS: true, videoId }
          }
        }
      }

      let canonicalUrl = url
      if (url.includes('/s/') || url.includes('/video/')) {
        const redirected = await this.resolveRedirect(url)
        if (redirected) canonicalUrl = redirected
      }

      const embedUrl = this.buildEmbedUrl(canonicalUrl)
      const response = await makeRequest(embedUrl, {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      })

      if (response.error || response.statusCode !== 200) {
        return {
          loadType: 'error',
          exception: {
            message:
              response.error ||
              `Reddit embed returned HTTP ${response.statusCode}`,
            severity: 'fault'
          }
        }
      }

      const html = String(response.body || '')
      const videoMatch = html.match(/https:\/\/v\.redd\.it\/([a-zA-Z0-9]+)/)
      const videoId = videoMatch?.[1]

      if (!videoId) {
        return { loadType: 'empty', data: {} }
      }

      const title =
        html.match(/<h1[^>]*>([^<]+)<\/h1>/)?.[1]?.trim() ||
        html.match(/<title>([^<]+)<\/title>/)?.[1]?.trim() ||
        'Reddit Video'

      const rawAuthor =
        html.match(/href="https:\/\/www\.reddit\.com\/user\/([^/"]+)\//)?.[1] ||
        html.match(/posted by\s*<a[^>]*>([^<]+)<\/a>/i)?.[1] ||
        'Reddit'
      const author = rawAuthor.startsWith('u/') ? rawAuthor : `u/${rawAuthor}`

      const artworkUrl =
        html.match(/poster="([^"]+)"/)?.[1] ||
        html.match(/preview="([^"]+)"/)?.[1] ||
        null

      const hlsUrl = `https://v.redd.it/${videoId}/HLSPlaylist.m3u8`
      const trackInfo: TrackInfo = {
        identifier: videoId,
        isSeekable: true,
        author,
        length: 0,
        isStream: false,
        position: 0,
        title,
        uri: url,
        artworkUrl,
        isrc: null,
        sourceName: 'reddit'
      }

      return {
        loadType: 'track',
        data: {
          encoded: encodeTrack({ ...trackInfo, details: [] }),
          info: trackInfo,
          pluginInfo: { directUrl: hlsUrl, isHLS: true, videoId }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger('error', 'Reddit', `Resolution failed for ${url}: ${message}`)
      return { loadType: 'error', exception: { message, severity: 'fault' } }
    }
  }

  /**
   * Resolves the direct streaming URL for a Reddit track.
   *
   * @param track - Decoded Reddit track information.
   * @param _itag - Unused itag placeholder kept for compatibility.
   * @param _isRecovering - Whether this is a recovery attempt.
   * @returns Direct streaming URL descriptor.
   */
  public async getTrackUrl(
    track: TrackInfo,
    _itag?: number,
    _isRecovering?: boolean
  ): Promise<TrackUrlResult> {
    const pluginInfo = (
      track as unknown as { pluginInfo?: { directUrl?: string } }
    ).pluginInfo
    if (pluginInfo?.directUrl) {
      return {
        url: pluginInfo.directUrl,
        protocol: 'hls',
        format: 'fmp4'
      }
    }

    const res = await this.resolve(track.uri)
    if (res.loadType === 'track') {
      const trackData = res.data as TrackData
      const directUrl = (trackData?.pluginInfo as { directUrl?: string })
        ?.directUrl
      if (directUrl) {
        return {
          url: directUrl,
          protocol: 'hls',
          format: 'fmp4'
        }
      }
    }

    if (track.identifier && /^[a-zA-Z0-9]+$/.test(track.identifier)) {
      return {
        url: `https://v.redd.it/${track.identifier}/HLSPlaylist.m3u8`,
        protocol: 'hls',
        format: 'fmp4'
      }
    }

    throw new Error('Failed to resolve Reddit track URL')
  }

  /**
   * Opens a media stream for a Reddit track.
   *
   * @param _decodedTrack - Decoded track metadata.
   * @param url - Direct playback URL.
   * @param protocol - Stream protocol hint.
   * @param additionalData - Optional playback metadata.
   * @returns Playable stream result.
   */
  public async loadStream(
    _decodedTrack: TrackInfo,
    url: string,
    protocol?: string,
    additionalData?: Record<string, unknown>
  ): Promise<TrackStreamResult> {
    if (protocol === 'hls' || url.includes('.m3u8')) {
      return {
        stream: new HLSHandler(url, {
          headers: {
            'User-Agent': USER_AGENT,
            Referer: 'https://www.reddit.com/'
          },
          type: 'fmp4',
          strategy: 'segmented',
          localAddress: this.nodelink.routePlanner?.getIP?.() || undefined,
          startTime: (additionalData?.startTime as number) || 0
        }),
        type: 'fmp4'
      }
    }

    const response = await makeRequest(url, {
      method: 'GET',
      streamOnly: true,
      headers: {
        'User-Agent': USER_AGENT,
        Referer: 'https://www.reddit.com/'
      }
    })

    if (response.error || !response.stream) {
      throw new Error(response.error || 'Failed to get Reddit stream')
    }

    const stream = new PassThrough()
    const upstream = response.stream

    upstream.on('data', (chunk: Buffer) => {
      if (!stream.write(chunk)) upstream.pause()
    })
    stream.on('drain', () => {
      if (!stream.destroyed) upstream.resume()
    })
    upstream.on('end', () => {
      if (!stream.writableEnded) {
        stream.emit('finishBuffering')
        stream.end()
      }
    })
    upstream.on('error', (err: Error) => {
      if (!stream.destroyed) stream.destroy(err)
    })

    const type = url.endsWith('.mp3') ? 'mp3' : 'mp4'
    return { stream, type }
  }

  /**
   * Executes a test variant against the Reddit source.
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

  /**
   * Converts a Reddit URL into the embed URL format.
   *
   * @param url - Canonical Reddit URL.
   * @returns Embed URL on `redditmedia.com`.
   * @internal
   */
  private buildEmbedUrl(url: string): string {
    const embedHost = url
      .replace(/^https?:\/\/(?:www\.)?reddit\.com/i, REDDITMEDIA_BASE)
      .replace(/^https?:\/\/old\.reddit\.com/i, REDDITMEDIA_BASE)
    const separator = embedHost.includes('?') ? '&' : '?'
    return `${embedHost}${separator}ref_source=embed&ref=share&embed=true`
  }

  /**
   * Resolves a redirecting short Reddit URL via HEAD request.
   *
   * @param url - Short Reddit URL.
   * @returns Final target URL or `null`.
   * @internal
   */
  private async resolveRedirect(url: string): Promise<string | null> {
    try {
      const response = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        headers: { 'User-Agent': USER_AGENT }
      })
      return response.url || null
    } catch {
      return null
    }
  }
}
