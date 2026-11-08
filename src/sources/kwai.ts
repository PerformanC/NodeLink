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
import { encodeTrack, http1makeRequest, logger, makeRequest } from '../utils.ts'

/**
 * Video metadata extracted from a Kwai page.
 */
interface KwaiVideoData {
  /**
   * Display name used as the track author.
   */
  author: string

  /**
   * Human-readable track title.
   */
  title: string

  /**
   * Video duration in milliseconds.
   */
  length: number

  /**
   * Thumbnail URL for the Kwai video when available.
   */
  thumbnail: string | null

  /**
   * Direct video playback URL.
   */
  videoUrl: string | null
}

/**
 * Track payload compatible with the shared encoder.
 */
interface KwaiTrackInfo extends TrackEncodeInput {
  [x: string]: unknown
  /**
   * Whether the generated track can be seeked.
   */
  isSeekable: boolean

  /**
   * Canonical Kwai page URL.
   */
  uri: string

  /**
   * Best thumbnail URL found for the Kwai video.
   */
  artworkUrl: string | null

  /**
   * Kwai does not expose ISRC values in this source path.
   */
  isrc: null
}

/**
 * Encoded Kwai track payload returned to the source manager.
 */
interface KwaiTrackData {
  /**
   * Base64-encoded Lavalink-compatible track payload.
   */
  encoded: string

  /**
   * Human-readable track information.
   */
  info: KwaiTrackInfo

  /**
   * Kwai does not currently attach extra plugin metadata.
   */
  pluginInfo: Record<string, unknown>
}

/**
 * Kwai source implementation.
 */
export default class KwaiSource
  implements SourceInstance, SourceVariantHandler
{
  /**
   * Declarative test suite for validating Kwai source behavior.
   */
  public static readonly _TESTS: SourceTestCase[] = [
    {
      id: 'kwai.video.stream',
      name: 'Kwai native video stream playback',
      input: {
        type: 'resolve',
        value: 'https://www.kwai.com/video/5215881428622069111'
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
            value: 'Vida na natureza'
          },
          sourceName: {
            op: 'equals',
            value: 'kwai'
          }
        },
        stream: {
          required: true,
          download: 'complete',
          minBytes: 100000,
          validFormats: [{ container: 'mp4', codec: 'aac' }],
          decodeToEnd: true
        }
      },
      forbid: {
        resultTypes: ['empty', 'error']
      }
    },
    {
      id: 'kwai.video.short_domain',
      name: 'Kwai video resolution without www prefix',
      input: {
        type: 'resolve',
        value: 'https://kwai.com/video/5215881428622069111'
      },
      expect: {
        result: {
          type: 'track'
        },
        metadata: {
          author: {
            op: 'matches',
            value: 'Vida na natureza'
          },
          sourceName: {
            op: 'equals',
            value: 'kwai'
          }
        }
      },
      forbid: {
        resultTypes: ['empty', 'error']
      }
    },
    {
      id: 'kwai.video.user_handle',
      name: 'Kwai video resolution with user handle in path',
      input: {
        type: 'resolve',
        value: 'https://www.kwai.com/@frmrt264/video/5215881428622069111'
      },
      expect: {
        result: {
          type: 'track'
        },
        metadata: {
          author: {
            op: 'matches',
            value: 'Vida na natureza'
          },
          sourceName: {
            op: 'equals',
            value: 'kwai'
          }
        }
      },
      forbid: {
        resultTypes: ['empty', 'error']
      }
    },
    {
      id: 'kwai.video.user_handle_short_domain',
      name: 'Kwai video resolution with user handle on short domain',
      input: {
        type: 'resolve',
        value: 'https://kwai.com/@frmrt264/video/5215881428622069111'
      },
      expect: {
        result: {
          type: 'track'
        },
        metadata: {
          author: {
            op: 'matches',
            value: 'Vida na natureza'
          },
          sourceName: {
            op: 'equals',
            value: 'kwai'
          }
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
   * URL patterns supported by this source.
   */
  public readonly patterns: RegExp[]

  /**
   * Match priority used by the source manager.
   */
  public readonly priority: number

  /**
   * Creates a new Kwai source wrapper.
   *
   * @param nodelink - Worker runtime used by the source implementation.
   */
  public constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
    this.patterns = [
      /^https?:\/\/(?:www\.)?kwai\.com\/(?:@[\w-]+\/)?video\/(\d+)/
    ]
    this.priority = 60
  }

  /**
   * Initializes the source.
   *
   * @returns `true` once the source has been registered.
   */
  public async setup(): Promise<boolean> {
    logger('info', 'Sources', 'Loaded Kwai source.')
    return true
  }

  /**
   * Kwai does not support text search in this source.
   *
   * @param _query - Ignored search query.
   * @returns Exception payload describing the unsupported operation.
   */
  public async search(_query: string): Promise<SourceResult> {
    return {
      loadType: 'error',
      exception: {
        message: 'Search not supported for Kwai',
        severity: 'fault',
        cause: 'Kwai Source'
      }
    }
  }

  /**
   * Resolves a Kwai URL into a single playable track.
   *
   * @param queryUrl - Candidate Kwai video URL.
   * @returns Track payload or an exception payload when resolution fails.
   */
  public async resolve(queryUrl: string): Promise<SourceResult> {
    try {
      const videoId = this.getVideoId(queryUrl)
      const videoData = await this.getVideoInfo(videoId)
      const track = this.buildTrack(videoData, queryUrl, videoId)

      return { loadType: 'track', data: track }
    } catch (error) {
      return {
        loadType: 'error',
        exception: {
          message: error instanceof Error ? error.message : 'Invalid Kwai URL',
          severity: 'fault',
          cause: 'Kwai Source'
        }
      }
    }
  }

  /**
   * Resolves the direct playback URL for a Kwai track.
   *
   * @param track - Decoded Kwai track information.
   * @returns Direct media URL descriptor or an exception payload when Kwai does
   * not expose the video URL anymore.
   */
  public async getTrackUrl(track: TrackInfo): Promise<TrackUrlResult> {
    try {
      const videoData = await this.getVideoInfo(track.identifier)

      if (!videoData.videoUrl) {
        return {
          exception: {
            message: 'Video URL not found',
            severity: 'fault',
            cause: 'StreamLink'
          }
        }
      }

      return {
        url: videoData.videoUrl,
        protocol: videoData.videoUrl.startsWith('https:') ? 'https' : 'http',
        format: 'mp4'
      }
    } catch (error) {
      return {
        exception: {
          message:
            error instanceof Error ? error.message : 'Failed to get video URL',
          severity: 'fault',
          cause: 'StreamLink'
        }
      }
    }
  }

  /**
   * Opens a Kwai media stream from the direct media URL.
   *
   * @param _decodedTrack - Decoded track metadata, unused by this source.
   * @param url - Direct Kwai media URL.
   * @returns Playable stream payload or an exception payload when the upstream
   * request fails.
   */
  public async loadStream(
    _decodedTrack: TrackInfo,
    url: string
  ): Promise<TrackStreamResult> {
    try {
      const response = await http1makeRequest(url, {
        method: 'GET',
        streamOnly: true,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3',
          Accept: '*/*'
        },
        disableBodyCompression: true
      })

      if (response.error || !response.stream) {
        return {
          exception: {
            message:
              response.error ||
              'Failed to get stream, no stream object returned.',
            severity: 'fault'
          }
        }
      }

      if (response.statusCode !== 200) {
        return {
          exception: {
            message: `Kwai returned status ${response.statusCode}`,
            severity: 'fault'
          }
        }
      }

      const upstream = response.stream
      const stream = new PassThrough()

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

      return { stream, type: 'mp4' }
    } catch (error) {
      return {
        exception: {
          message:
            error instanceof Error ? error.message : 'Failed to load stream',
          severity: 'fault'
        }
      }
    }
  }

  /**
   * Executes a test variant for Kwai source testing.
   *
   * @param variant - Test variant definition.
   * @param track - Resolved track info.
   * @param streamSpec - Optional stream validation specification.
   * @returns Test variant result payload.
   */
  public async executeVariant(
    variant: SourceTestVariant,
    track: TrackInfo,
    streamSpec?: SourceTestStreamSpec
  ): Promise<SourceTestVariantResult> {
    const urlData = await this.getTrackUrl(track)
    if (!urlData || 'exception' in urlData || !urlData.url) {
      const errorMsg =
        urlData && 'exception' in urlData && urlData.exception?.message
          ? urlData.exception.message
          : 'Failed to resolve track streaming URL'
      return {
        variant: variant.id,
        resolved: false,
        error: errorMsg
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

    const streamResult = await this.loadStream(track, urlData.url)
    if (!('stream' in streamResult) || !streamResult.stream) {
      const errorMsg =
        'exception' in streamResult && streamResult.exception?.message
          ? streamResult.exception.message
          : 'Failed to load audio stream'
      return {
        variant: variant.id,
        resolved: true,
        error: errorMsg
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
   * Extracts the Kwai video identifier from a URL.
   *
   * @param url - Candidate Kwai URL.
   * @returns Parsed Kwai video id.
   * @throws Error when the URL is missing or does not contain a video id.
   */
  private getVideoId(url: string): string {
    if (!url) {
      throw new Error('Kwai URL not provided')
    }

    const match = url.match(/\/video\/(\d+)/)
    if (!match?.[1]) {
      throw new Error('Kwai video ID not found')
    }

    return match[1]
  }

  /**
   * Decodes common HTML entities in a string.
   *
   * @param value - String potentially containing HTML entities.
   * @returns Decoded string or original value.
   */
  private decodeHtmlEntities(value: string | null): string | null {
    if (!value) return value
    return value
      .replace(/&amp;/g, '&')
      .replace(/&ugrave;/g, 'ù')
      .replace(/&uacute;/g, 'ú')
      .replace(/&aacute;/g, 'á')
      .replace(/&eacute;/g, 'é')
      .replace(/&iacute;/g, 'í')
      .replace(/&oacute;/g, 'ó')
      .replace(/&atilde;/g, 'ã')
      .replace(/&otilde;/g, 'õ')
      .replace(/&ccedil;/g, 'ç')
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
        String.fromCodePoint(Number.parseInt(hex, 16))
      )
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim()
  }

  /**
   * Decodes JavaScript-style unicode escape sequences.
   *
   * @param value - Raw string that may contain `\\uXXXX` sequences.
   * @returns Decoded string, or `null` when the input is empty.
   */
  private decodeUnicodeEscapes(value: string | null): string | null {
    if (!value) {
      return null
    }

    try {
      return JSON.parse(`"${value}"`) as string
    } catch {
      return value
    }
  }

  /**
   * Fetches and parses the Kwai page metadata used by this source.
   *
   * @param videoId - Kwai video identifier.
   * @returns Parsed Kwai video metadata.
   * @throws Error when the page request fails or required media URLs are
   * missing.
   */
  private async getVideoInfo(videoId: string): Promise<KwaiVideoData> {
    const url = `https://www.kwai.com/video/${videoId}?responseType=json`

    const response = await makeRequest(url, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
        Accept: '*/*'
      }
    })

    if (response.statusCode !== 200) {
      throw new Error(`Request failed with code ${response.statusCode}`)
    }

    if (typeof response.body !== 'string' || response.body.length === 0) {
      throw new Error('Error fetching video info')
    }

    const body = response.body
    const photoIndex = body.indexOf(`photo_id_str:"${videoId}"`)
    if (photoIndex === -1) {
      throw new Error('Video data not found in response')
    }

    const entryStart = body.lastIndexOf(']={', photoIndex)
    const entryEnd = body.indexOf('};', photoIndex)
    const videoData = body.slice(entryStart + 3, entryEnd)
    const videoUrl = this.decodeUnicodeEscapes(
      videoData.match(/main_mv_urls:\[\{[^}]*url:"((?:\\.|[^"])*)"/)?.[1] ??
        null
    )
    if (!videoUrl) {
      throw new Error('Video URL not found in response')
    }

    const author =
      this.decodeUnicodeEscapes(
        videoData.match(/user_name:"((?:\\.|[^"])*)"/)?.[1] ?? null
      ) ?? 'Unknown'
    const rawTitle =
      this.decodeUnicodeEscapes(
        videoData.match(/caption:"((?:\\.|[^"])*)"/)?.[1] ?? null
      ) ?? (author === 'Unknown' ? 'Kwai Video' : `Kwai - ${author}`)
    const title = this.decodeHtmlEntities(rawTitle) ?? rawTitle
    const durationText = videoData.match(/ext_params:\{[^}]*sound:(\d+)/)?.[1]
    const thumbnail = this.decodeUnicodeEscapes(
      videoData.match(
        /cover_thumbnail_urls:\[\{[^}]*url:"((?:\\.|[^"])*)"/
      )?.[1] ?? null
    )

    return {
      author,
      title,
      length: durationText ? Number.parseInt(durationText, 10) : 0,
      thumbnail,
      videoUrl
    }
  }

  /**
   * Builds the encoded track payload for a Kwai video.
   *
   * @param videoData - Parsed Kwai metadata.
   * @param queryUrl - Original Kwai page URL.
   * @param videoId - Kwai video identifier.
   * @returns Track payload compatible with the shared encoder and source
   * manager contracts.
   */
  private buildTrack(
    videoData: KwaiVideoData,
    queryUrl: string,
    videoId: string
  ): KwaiTrackData {
    const trackInfo: KwaiTrackInfo = {
      identifier: videoId,
      title: videoData.title,
      author: videoData.author,
      length: videoData.length,
      sourceName: 'kwai',
      artworkUrl: videoData.thumbnail,
      uri: queryUrl,
      isStream: false,
      isSeekable: true,
      position: 0,
      isrc: null,
      details: []
    }

    return {
      encoded: encodeTrack(trackInfo),
      info: trackInfo,
      pluginInfo: {} as Record<string, unknown>
    }
  }
}
