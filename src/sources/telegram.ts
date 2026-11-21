import { PassThrough } from 'node:stream'
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
import type { TrackEncodeInput } from '../typings/utils.types.ts'
import { encodeTrack, http1makeRequest, logger } from '../utils.ts'

/**
 * Telegram-specific plugin payload attached to resolved tracks.
 */
interface TelegramTrackPluginInfo {
  [x: string]: unknown
  /**
   * Direct Telegram media URL extracted from the embed page.
   */
  directUrl: string
}

/**
 * Track payload compatible with the shared encoder.
 */
interface TelegramTrackInfo extends TrackEncodeInput {
  [x: string]: unknown
  /**
   * Whether the generated track can be seeked.
   */
  isSeekable: boolean

  /**
   * Canonical Telegram message URL.
   */
  uri: string

  /**
   * Best thumbnail URL found for the Telegram post.
   */
  artworkUrl: string | null

  /**
   * Telegram does not expose ISRC values in this source path.
   */
  isrc: null
}

/**
 * Encoded Telegram track payload returned to the source manager.
 */
interface TelegramTrackData {
  /**
   * Base64-encoded Lavalink-compatible track payload.
   */
  encoded: string

  /**
   * Human-readable track information.
   */
  info: TelegramTrackInfo

  /**
   * Telegram-specific metadata for the resolved message.
   */
  pluginInfo: TelegramTrackPluginInfo
}

/**
 * Playlist payload returned when a Telegram message contains multiple videos.
 */
interface TelegramPlaylistData {
  /**
   * Playlist metadata block expected by the source manager.
   */
  info: {
    /**
     * Playlist name built from the message title.
     */
    name: string

    /**
     * Default selected track index.
     */
    selectedTrack: number
  }

  /**
   * Telegram playlist payload does not currently attach extra metadata.
   */
  pluginInfo: Record<string, unknown>

  /**
   * Video tracks extracted from the Telegram message.
   */
  tracks: TelegramTrackData[]
}

/**
 * Telegram source implementation.
 */
export default class TelegramSource
  implements SourceInstance, SourceVariantHandler
{
  /**
   * Test suite cases validating Telegram video resolution and playback.
   */
  public static readonly _TESTS: SourceTestCase[] = [
    {
      id: 'telegram.video.stream',
      name: 'Telegram standard t.me video playback',
      input: {
        type: 'resolve',
        value: 'https://t.me/telegram/207'
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
            value: 'Telegram'
          },
          sourceName: {
            op: 'equals',
            value: 'telegram'
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
      id: 'telegram.domain.short',
      name: 'Telegram short domain telegram.me',
      input: {
        type: 'resolve',
        value: 'https://telegram.me/telegram/207'
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
            value: 'Telegram'
          },
          sourceName: {
            op: 'equals',
            value: 'telegram'
          }
        }
      }
    },
    {
      id: 'telegram.domain.alternate',
      name: 'Telegram alternate domain telegram.dog',
      input: {
        type: 'resolve',
        value: 'https://telegram.dog/telegram/207'
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
            value: 'Telegram'
          },
          sourceName: {
            op: 'equals',
            value: 'telegram'
          }
        }
      }
    }
  ]
  /**
   * Runtime worker context used by the source implementation.
   */
  public readonly nodelink: WorkerNodeLink

  /**
   * URL patterns supported by this source.
   */
  public readonly patterns: RegExp[]

  /**
   * Search aliases handled by this source.
   */
  public readonly searchTerms: string[]

  /**
   * Match priority used by the source manager.
   */
  public readonly priority: number

  /**
   * Creates a new Telegram source wrapper.
   *
   * @param nodelink - Worker runtime used by the source implementation.
   */
  public constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
    this.patterns = [
      /^https?:\/\/(?:t\.me|telegram\.me|telegram\.dog)\/([^/?#]+)\/(\d+)(?:\/|[?#].*)?$/i
    ]
    this.searchTerms = []
    this.priority = 80
  }

  /**
   * Initializes the source.
   *
   * @returns `true` once the source has been registered.
   */
  public async setup(): Promise<boolean> {
    logger('info', 'Sources', 'Loaded Telegram source.')
    return true
  }

  /**
   * Telegram does not support text search in this source.
   *
   * @param _query - Ignored search query.
   * @returns Empty search result.
   */
  public async search(_query: string): Promise<SourceResult> {
    return { loadType: 'empty', data: {} }
  }

  /**
   * Validates whether a candidate URL belongs to Telegram domains.
   *
   * @param candidate - Candidate URL or string to validate.
   * @returns `true` when the host matches official Telegram domains.
   */
  private _isTelegramUrl(candidate: URL | string): boolean {
    try {
      const parsed =
        typeof candidate === 'string' ? new URL(candidate) : candidate
      return (
        (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
        ['t.me', 'telegram.me', 'telegram.dog'].includes(
          parsed.hostname.toLowerCase()
        )
      )
    } catch {
      return false
    }
  }

  /**
   * Resolves a Telegram message URL into one or more playable tracks.
   *
   * @param url - Candidate Telegram message URL.
   * @returns Track or playlist payload, an empty result when the message has no
   * embedded media, or an exception payload when the request fails.
   */
  public async resolve(url: string): Promise<SourceResult> {
    const messagePattern = this.patterns[0]
    const match = messagePattern?.exec(url)
    if (!match?.[1] || !match[2]) {
      return { loadType: 'empty', data: {} }
    }

    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch {
      return { loadType: 'empty', data: {} }
    }

    if (!this._isTelegramUrl(parsedUrl)) {
      return { loadType: 'empty', data: {} }
    }

    const channelId = match[1]
    const messageId = match[2]
    const embedUrl = new URL(
      `https://${parsedUrl.hostname}/${encodeURIComponent(channelId)}/${encodeURIComponent(messageId)}?embed=1`
    )

    try {
      const { body, error, statusCode } = await http1makeRequest(
        embedUrl.toString(),
        {
          method: 'GET',
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Encoding': 'identity'
          },
          shouldFollowRedirect: (nextUrl) => this._isTelegramUrl(nextUrl)
        }
      )

      if (error || statusCode !== 200 || typeof body !== 'string') {
        return {
          loadType: 'error',
          exception: {
            message:
              error || `Telegram embed request returned status ${statusCode}`,
            severity: 'fault'
          }
        }
      }

      const author = this.extractAuthor(body)
      const description = this.extractDescription(body)
      const title = description.split('\n')[0] || `Telegram Video ${messageId}`
      const videoBlocks = Array.from(
        body.matchAll(
          /<a class="tgme_widget_message_video_player([\s\S]*?)<\/time>/g
        )
      )

      if (videoBlocks.length === 0) {
        return { loadType: 'empty', data: {} }
      }

      const tracks: TelegramTrackData[] = []
      for (const [index, block] of videoBlocks.entries()) {
        const content = block[0]
        const videoUrl = content.match(/<video[^>]+src="([^"]+)"/)?.[1]
        if (!videoUrl) {
          continue
        }

        const artworkUrl =
          content.match(
            /tgme_widget_message_video_thumb"[^>]+background-image:url\('([^']+)'\)/
          )?.[1] ?? null

        const trackInfo: TelegramTrackInfo = {
          identifier: `${channelId}/${messageId}/${index}`,
          isSeekable: true,
          author,
          length: this.parseDurationMs(content),
          isStream: false,
          position: 0,
          title: index === 0 ? title : `${title} (Video ${index + 1})`,
          uri: url,
          artworkUrl,
          isrc: null,
          sourceName: 'telegram',
          details: []
        }

        tracks.push({
          encoded: encodeTrack(trackInfo),
          info: trackInfo,
          pluginInfo: {
            directUrl: videoUrl
          }
        })
      }

      if (tracks.length === 0) {
        return { loadType: 'empty', data: {} }
      }

      const isSingle = url.includes('?single') || url.includes('&single')
      if (isSingle || tracks.length === 1) {
        const firstTrack = tracks[0]
        return firstTrack
          ? { loadType: 'track', data: firstTrack }
          : { loadType: 'empty', data: {} }
      }

      const playlistData: TelegramPlaylistData = {
        info: {
          name: title,
          selectedTrack: 0
        },
        pluginInfo: {} as Record<string, unknown>,
        tracks
      }

      return {
        loadType: 'playlist',
        data: playlistData
      }
    } catch (error) {
      return {
        loadType: 'error',
        exception: {
          message:
            error instanceof Error
              ? error.message
              : 'Telegram resolution failed.',
          severity: 'fault'
        }
      }
    }
  }

  /**
   * Resolves the direct media URL for a Telegram track.
   *
   * @param track - Decoded Telegram track information.
   * @param _itag - Unused itag placeholder kept for source-manager compatibility.
   * @param _isRecovering - Whether this is a recovery attempt.
   * @returns Direct Telegram media URL descriptor.
   */
  public async getTrackUrl(
    track: TrackInfo,
    _itag?: number,
    _isRecovering?: boolean
  ): Promise<TrackUrlResult> {
    const pluginInfo = (track as { pluginInfo?: TelegramTrackPluginInfo })
      .pluginInfo
    if (pluginInfo?.directUrl) {
      return {
        url: pluginInfo.directUrl,
        protocol: 'https',
        format: 'mp4'
      }
    }

    const result = await this.resolve(track.uri)
    const resultData = result as {
      loadType?: string
      data?: TelegramTrackData | TelegramPlaylistData
    }

    if (resultData.loadType === 'track') {
      const singleTrack = resultData.data as TelegramTrackData
      return {
        url: singleTrack.pluginInfo.directUrl,
        protocol: 'https',
        format: 'mp4'
      }
    }

    if (resultData.loadType === 'playlist') {
      const playlist = resultData.data as TelegramPlaylistData
      const parts = track.identifier.split('/')
      const lastPart = parts[parts.length - 1]
      const index = Number.parseInt(lastPart ?? '0', 10)
      const selectedTrack = playlist.tracks[index] ?? playlist.tracks[0]

      if (selectedTrack) {
        return {
          url: selectedTrack.pluginInfo.directUrl,
          protocol: 'https',
          format: 'mp4'
        }
      }
    }

    throw new Error('Failed to get track URL')
  }

  /**
   * Opens a Telegram media stream from the direct media URL.
   *
   * @param _decodedTrack - Decoded track metadata, unused by this source.
   * @param url - Direct Telegram media URL.
   * @param _protocol - Optional protocol hint (unused).
   * @param _additionalData - Optional additional data (unused).
   * @returns Playable stream payload.
   */
  public async loadStream(
    _decodedTrack: TrackInfo,
    url: string,
    _protocol?: string,
    _additionalData?: Record<string, unknown>
  ): Promise<TrackStreamResult> {
    const response = await http1makeRequest(url, {
      method: 'GET',
      streamOnly: true,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://t.me/'
      }
    })

    if (response.error || !response.stream) {
      throw new Error(response.error || 'Failed to get stream')
    }

    if (response.statusCode && response.statusCode >= 400) {
      throw new Error(`Telegram returned status ${response.statusCode}`)
    }

    const stream = new PassThrough()
    const upstream = response.stream

    upstream.on('data', (chunk: Buffer) => {
      if (!stream.write(chunk)) {
        upstream.pause()
      }
    })

    stream.on('drain', () => {
      if (!stream.destroyed) {
        upstream.resume()
      }
    })

    upstream.on('end', () => {
      if (!stream.writableEnded) {
        stream.emit('finishBuffering')
        stream.end()
      }
    })

    upstream.on('error', (err: Error) => {
      if (!stream.destroyed) {
        stream.destroy(err)
      }
    })

    return { stream, type: 'video/mp4' }
  }

  /**
   * Executes a test variant against the Telegram source.
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
      streamResult = await this.loadStream(track, urlData.url)
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
   * Extracts the author name from the Telegram embed HTML.
   *
   * @param html - Telegram embed page HTML.
   * @returns Human-readable author name, or a channel fallback.
   */
  private extractAuthor(html: string): string {
    return (
      html
        .match(
          /class="tgme_widget_message_author[^>]*>[\s\S]*?<span dir="auto">([^<]+)<\/span>/
        )?.[1]
        ?.trim() ?? 'Telegram Channel'
    )
  }

  /**
   * Extracts the visible message text from the Telegram embed HTML.
   *
   * @param html - Telegram embed page HTML.
   * @returns Plain-text description for the message.
   */
  private extractDescription(html: string): string {
    const text = html.match(
      /class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/
    )?.[1]
    if (!text) {
      return ''
    }

    return text
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .trim()
  }

  /**
   * Parses the duration string embedded in a Telegram video block.
   *
   * @param html - Raw Telegram video block HTML.
   * @returns Duration in milliseconds, or `0` when the block has no duration.
   */
  private parseDurationMs(html: string): number {
    const durationText =
      html.match(/<time[^>]+duration[^>]*>([\d:]+)<\/time>/)?.[1] ??
      html.match(
        /class="tgme_widget_message_video_duration">([\d:]+)<\/time>/
      )?.[1]

    if (!durationText) {
      return 0
    }

    const parts = durationText
      .split(':')
      .map((part) => Number.parseInt(part, 10))
    if (parts.some((part) => Number.isNaN(part))) {
      return 0
    }

    const [first, second, third] = parts
    if (
      parts.length === 3 &&
      first !== undefined &&
      second !== undefined &&
      third !== undefined
    ) {
      return (first * 3600 + second * 60 + third) * 1000
    }

    if (parts.length === 2 && first !== undefined && second !== undefined) {
      return (first * 60 + second) * 1000
    }

    return 0
  }
}
