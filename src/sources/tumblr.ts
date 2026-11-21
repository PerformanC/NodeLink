import { PassThrough } from 'node:stream'
import type { TrackInfo } from '../typings/sources/source.types.ts'
import type { SourceTestCase } from '../typings/sources/test.types.ts'
import type {
  TumblrDecodedTrack,
  TumblrInitialState,
  TumblrLoadStreamResult,
  TumblrNodeLinkContext,
  TumblrPluginInfo,
  TumblrResolveResult,
  TumblrTrackData,
  TumblrTrackUrlResult,
  TumblrUrlInfo
} from '../typings/sources/tumblr.types.ts'
import type { TrackEncodeInput } from '../typings/utils.types.ts'
import { encodeTrack, http1makeRequest, logger } from '../utils.ts'

const TUMBLR_USER_AGENT = 'WhatsApp/2.0'
const TUMBLR_STREAM_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export default class TumblrSource {
  /**
   * Declarative test suite for validating Tumblr source behavior.
   * @public
   */
  public static readonly _TESTS: SourceTestCase[] = [
    {
      id: 'tumblr.post.resolve',
      name: 'Tumblr Post URL resolution',
      input: {
        type: 'resolve',
        value: 'https://www.tumblr.com/tatianamaslanydaily/54196191430'
      },
      expect: {
        result: { type: 'track' },
        metadata: {
          title: { op: 'matches', value: 'Orphan Black' },
          author: { op: 'matches', value: 'tatianamaslanydaily' },
          sourceName: { op: 'equals', value: 'tumblr' }
        }
      }
    },
    {
      id: 'tumblr.subdomain.resolve',
      name: 'Tumblr Subdomain URL resolution',
      input: {
        type: 'resolve',
        value: 'http://tatianamaslanydaily.tumblr.com/post/54196191430'
      },
      expect: {
        result: { type: 'track' },
        metadata: {
          title: { op: 'matches', value: 'Orphan Black' },
          author: { op: 'matches', value: 'tatianamaslanydaily' },
          sourceName: { op: 'equals', value: 'tumblr' }
        }
      }
    }
  ]

  public readonly nodelink: TumblrNodeLinkContext
  public readonly config: TumblrNodeLinkContext['options']
  public readonly patterns: RegExp[]
  public readonly priority: number

  public constructor(nodelink: TumblrNodeLinkContext) {
    this.nodelink = nodelink
    this.config = nodelink.options
    this.patterns = [
      /^https?:\/\/([^/?#&]+)\.tumblr\.com\/(?:post|video|([a-zA-Z\d-]+))\/(\d+)(?:\/|[?#].*)?$/i,
      /^https?:\/\/(?:www\.)?tumblr\.com\/([^/?#&]+)\/(\d+)(?:\/|[?#].*)?$/i
    ]
    this.priority = 60
  }

  public async setup(): Promise<boolean> {
    logger('info', 'Sources', 'Loaded Tumblr source.')
    return true
  }

  private _extractInfo(url: string): TumblrUrlInfo | null {
    for (const pattern of this.patterns) {
      const match = url.match(pattern)
      if (!match) continue

      if (match.length === 4) {
        const blog = match[2] || match[1]
        const id = match[3]
        if (blog && id) return { blog, id }
      } else {
        const blog = match[1]
        const id = match[2]
        if (blog && id) return { blog, id }
      }
    }
    return null
  }

  private _buildTrackData(
    info: TrackInfo,
    pluginInfo: TumblrPluginInfo
  ): TumblrTrackData {
    const encodedInput: TrackEncodeInput = { ...info, details: [] }
    return {
      encoded: encodeTrack(encodedInput),
      info,
      pluginInfo
    }
  }

  private _getMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  private _isTrackResult(
    result: TumblrResolveResult
  ): result is { loadType: 'track'; data: TumblrTrackData } {
    return (
      result.loadType === 'track' &&
      typeof result.data === 'object' &&
      result.data !== null &&
      'pluginInfo' in result.data
    )
  }

  private _buildTrackFromPost(
    post: {
      idString?: string
      id?: string | number
      blogName?: string
      duration?: number
      summary?: string
      postUrl?: string
      poster?: Array<{ url?: string }>
      thumbnail?: string
    },
    fallbackBlog: string,
    fallbackUrl: string,
    directUrl: string
  ): TumblrTrackData {
    const info: TrackInfo = {
      identifier: String(post.idString || post.id || fallbackUrl),
      isSeekable: true,
      author: post.blogName || fallbackBlog,
      length: (post.duration || 0) * 1000,
      isStream: false,
      position: 0,
      title: post.summary || 'Tumblr Content',
      uri: post.postUrl || fallbackUrl,
      artworkUrl: post.poster?.[0]?.url || post.thumbnail || null,
      isrc: null,
      sourceName: 'tumblr'
    }

    return this._buildTrackData(info, { directUrl })
  }

  private _isTumblrUrl(candidate: URL | string): boolean {
    try {
      const parsed =
        typeof candidate === 'string' ? new URL(candidate) : candidate
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return false
      }
      const host = parsed.hostname.toLowerCase()
      return host === 'tumblr.com' || host.endsWith('.tumblr.com')
    } catch {
      return false
    }
  }

  public async resolve(url: string): Promise<TumblrResolveResult> {
    if (!this._isTumblrUrl(url)) return { loadType: 'empty', data: {} }

    const info = this._extractInfo(url)
    if (!info) return { loadType: 'empty', data: {} }

    const targetUrl = `https://www.tumblr.com/${info.blog}/${info.id}`

    try {
      const { body, statusCode } = await http1makeRequest(targetUrl, {
        headers: { 'User-Agent': TUMBLR_USER_AGENT },
        shouldFollowRedirect: (nextUrl) => this._isTumblrUrl(nextUrl)
      })

      const html = typeof body === 'string' ? body : String(body || '')
      if (statusCode !== 200 || !html) return { loadType: 'empty', data: {} }

      const initialStateMatch = html.match(
        /id="___INITIAL_STATE___">\s*({.*?})\s*<\/script>/
      )

      if (initialStateMatch?.[1]) {
        try {
          const state = JSON.parse(initialStateMatch[1]) as TumblrInitialState
          const post = state.PeeprRoute?.initialTimeline?.objects?.find(
            (obj) => obj.objectType === 'post'
          )

          if (post) {
            const videoContent = post.content?.find(
              (entry) => entry.type === 'video'
            )
            const audioContent = post.content?.find(
              (entry) => entry.type === 'audio'
            )
            const media = videoContent || audioContent
            const directUrl = media?.url || media?.media?.url

            if (directUrl) {
              return {
                loadType: 'track',
                data: this._buildTrackFromPost(post, info.blog, url, directUrl)
              }
            }
          }
        } catch (error) {
          logger(
            'debug',
            'Tumblr',
            `Failed to parse initial state: ${this._getMessage(error)}`
          )
        }
      }

      const youtubeMatch =
        html.match(/https?:\/\/(?:www\.)?youtube\.com\/embed\/([^"?]+)/) ||
        html.match(/https?:\/\/www\.youtube\.com\/watch\?v=([^"&?]+)/)

      if (youtubeMatch?.[1]) {
        return await this.nodelink.sources.resolve(
          `https://www.youtube.com/watch?v=${youtubeMatch[1]}`
        )
      }

      const vimeoMatch = html.match(
        /https?:\/\/player\.vimeo\.com\/video\/(\d+)/
      )
      if (vimeoMatch?.[1]) {
        return await this.nodelink.sources.resolve(
          `https://vimeo.com/${vimeoMatch[1]}`
        )
      }

      const titleMatch =
        html.match(/<title data-rh="true">(.*?)<\/title>/i) ||
        html.match(/<title>(.*?)<\/title>/i)
      const title = titleMatch?.[1]
        ? titleMatch[1]
            .replace(' – @', ' by @')
            .replace(' on Tumblr', '')
            .trim()
        : 'Tumblr Content'

      const videoUrl =
        html.match(
          /<meta data-rh="" content="(.*?)" property="og:video"/i
        )?.[1] || html.match(/<meta property="og:video" content="(.*?)"/i)?.[1]

      if (videoUrl) {
        const trackInfo: TrackInfo = {
          identifier: info.id,
          isSeekable: true,
          author: info.blog,
          length: 0,
          isStream: false,
          position: 0,
          title,
          uri: url,
          artworkUrl:
            html.match(/<meta property="og:image" content="(.*?)"/i)?.[1] ||
            null,
          isrc: null,
          sourceName: 'tumblr'
        }

        return {
          loadType: 'track',
          data: this._buildTrackData(trackInfo, { directUrl: videoUrl })
        }
      }

      logger(
        'debug',
        'Tumblr',
        `No native media or supported embed found in ${url}`
      )
      return { loadType: 'empty', data: {} }
    } catch (error) {
      const message = this._getMessage(error)
      logger('error', 'Tumblr', `Resolution failed: ${message}`)
      return {
        loadType: 'error',
        exception: { message, severity: 'fault' }
      }
    }
  }

  public async getTrackUrl(
    decodedTrack: TumblrDecodedTrack
  ): Promise<TumblrTrackUrlResult> {
    const directUrl = decodedTrack.pluginInfo?.directUrl

    if (typeof directUrl === 'string' && directUrl.length > 0) {
      return {
        url: directUrl,
        protocol: 'https',
        format: directUrl.includes('.mp3') ? 'mp3' : 'mp4'
      }
    }

    const res = await this.resolve(decodedTrack.uri)
    if (this._isTrackResult(res)) {
      const resolvedUrl = res.data.pluginInfo.directUrl
      return {
        url: resolvedUrl,
        protocol: 'https',
        format: resolvedUrl.includes('.mp3') ? 'mp3' : 'mp4'
      }
    }

    throw new Error('Failed to extract Tumblr media URL')
  }

  public async loadStream(
    _decodedTrack: unknown,
    url: string,
    _protocol?: string,
    _additionalData?: Record<string, unknown>
  ): Promise<TumblrLoadStreamResult> {
    try {
      const response = await http1makeRequest(url, {
        method: 'GET',
        streamOnly: true,
        headers: {
          'User-Agent': TUMBLR_STREAM_USER_AGENT,
          Referer: 'https://www.tumblr.com/'
        }
      })

      if (response.error || !response.stream) {
        throw new Error(
          typeof response.error === 'string'
            ? response.error
            : 'Failed to get stream'
        )
      }

      const stream = new PassThrough()

      response.stream.on('data', (chunk) => {
        if (!stream.destroyed) stream.write(chunk)
      })

      response.stream.on('end', () => {
        if (!stream.destroyed) {
          stream.emit('finishBuffering')
          stream.end()
        }
      })

      response.stream.on('error', (error) => {
        logger(
          'error',
          'Tumblr',
          `External stream error: ${this._getMessage(error)}`
        )
        if (!stream.destroyed) {
          stream.destroy(
            error instanceof Error ? error : new Error(String(error))
          )
        }
      })

      return {
        stream,
        type: url.includes('.mp3') ? 'audio/mpeg' : 'video/mp4'
      }
    } catch (error) {
      const message = this._getMessage(error)
      logger('error', 'Tumblr', `Failed to load stream: ${message}`)
      return { exception: { message, severity: 'fault' } }
    }
  }
}
