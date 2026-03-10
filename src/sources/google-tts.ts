import { PassThrough } from 'node:stream'
import type {
  SourceResult,
  TrackInfo,
  TrackStreamResult,
  TrackUrlResult,
  WorkerNodeLink
} from '../typings/sources/source.types.ts'
import type { TrackEncodeInput } from '../typings/utils.types.ts'
import { encodeTrack, logger, makeRequest } from '../utils.ts'

/**
 * Runtime configuration accepted by the Google TTS source.
 */
interface GoogleTtsSourceConfig {
  /**
   * Whether the source is enabled in the main configuration.
   */
  enabled?: boolean

  /**
   * Language code sent to the Google TTS endpoint.
   */
  language?: string
}

/**
 * Track input required to construct a Google TTS encoded track.
 */
interface GoogleTtsTrackInput {
  /**
   * Track identifier stored in the encoded payload.
   */
  identifier: string

  /**
   * User-facing track title.
   */
  title: string

  /**
   * Resolved Google TTS URL used for playback.
   */
  uri: string
}

/**
 * Google TTS track payload compatible with the shared encoder.
 */
interface GoogleTtsTrackInfo extends TrackEncodeInput {
  /**
   * Whether the generated track can be seeked.
   */
  isSeekable: boolean

  /**
   * Canonical Google TTS playback URL.
   */
  uri: string

  /**
   * Google TTS does not expose artwork in this source path.
   */
  artworkUrl: null

  /**
   * Google TTS does not expose ISRC values.
   */
  isrc: null
}

/**
 * Encoded Google TTS track payload returned to the source manager.
 */
interface GoogleTtsTrackData {
  /**
   * Base64-encoded Lavalink-compatible track payload.
   */
  encoded: string

  /**
   * Human-readable track information.
   */
  info: GoogleTtsTrackInfo

  /**
   * Source-specific plugin metadata.
   */
  pluginInfo: Record<string, never>
}

/**
 * Successful Google TTS track URL descriptor.
 */
interface GoogleTtsTrackUrlResult extends TrackUrlResult {
  /**
   * Direct Google TTS playback URL.
   */
  url: string

  /**
   * Google TTS is resolved as a direct HTTPS resource.
   */
  protocol: 'https'

  /**
   * Google TTS audio is returned as MP3.
   */
  format: 'mp3'
}

/**
 * Exception payload returned by Google TTS operations.
 */
interface GoogleTtsExceptionResult {
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
 * Google TTS source implementation.
 */
export default class GoogleTTSSource {
  /**
   * Runtime worker context used by the source implementation.
   */
  public readonly nodelink: WorkerNodeLink

  /**
   * Sanitized Google TTS-specific configuration.
   */
  public readonly config: GoogleTtsSourceConfig

  /**
   * Language code sent to the Google TTS endpoint.
   */
  public readonly language: string

  /**
   * Search aliases handled by this source.
   */
  public readonly searchTerms: string[]

  /**
   * Base Google TTS endpoint host.
   */
  public readonly baseUrl: string

  /**
   * Match priority used by the source manager.
   */
  public readonly priority: number

  /**
   * Creates a new Google TTS source wrapper.
   *
   * @param nodelink - Worker runtime used by the source implementation.
   */
  public constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
    this.config = this.getConfig()
    this.language = this.config.language ?? 'en-US'
    this.searchTerms = ['gtts', 'speak']
    this.baseUrl = 'https://translate.google.com'
    this.priority = 50
  }

  /**
   * Reads and normalizes the Google TTS configuration from the shared runtime.
   *
   * This intentionally reads the existing `'google-tts'` config key instead of
   * the incorrect camelCase key used by the legacy JavaScript source.
   *
   * @returns Sanitized Google TTS configuration limited to the fields used by
   * this source.
   */
  private getConfig(): GoogleTtsSourceConfig {
    const sourceKey = 'google-tts'
    const rawConfig = this.nodelink.options.sources?.[sourceKey] as
      | GoogleTtsSourceConfig
      | undefined

    return {
      enabled: rawConfig?.enabled === true,
      language:
        typeof rawConfig?.language === 'string' && rawConfig.language.length > 0
          ? rawConfig.language
          : undefined
    }
  }

  /**
   * Extracts a readable error message from a runtime failure or helper error.
   *
   * @param error - Caught runtime failure or helper error text.
   * @returns Human-readable message suitable for logs and exception payloads.
   */
  private getErrorMessage(error: Error | string): string {
    return error instanceof Error ? error.message : error
  }

  /**
   * Builds the title shown for a Google TTS synthesized track.
   *
   * @param text - Requested TTS text.
   * @returns Original text, prefixed and truncated to the same 50-character
   * policy used by the legacy source.
   */
  private buildTitle(text: string): string {
    const visibleText = text.length > 50 ? `${text.substring(0, 47)}...` : text
    return `TTS: ${visibleText}`
  }

  /**
   * Builds the Google TTS endpoint URL for a given text request.
   *
   * @param text - Text that should be synthesized.
   * @returns Fully qualified Google TTS URL with the configured language.
   */
  private buildUrl(text: string): string {
    const queryParams = new URLSearchParams({
      ie: 'UTF-8',
      q: text,
      tl: this.language,
      total: '1',
      idx: '0',
      textlen: String(text.length),
      client: 'gtx'
    })

    return `${this.baseUrl}/translate_tts?${queryParams.toString()}`
  }

  /**
   * Builds the encoded track payload for a Google TTS request.
   *
   * @param trackInput - Identifier, title, and URL used to build the track.
   * @returns Track payload compatible with the shared encoder and source
   * manager contracts.
   */
  private buildTrack(trackInput: GoogleTtsTrackInput): GoogleTtsTrackData {
    const track: GoogleTtsTrackInfo = {
      identifier: trackInput.identifier,
      isSeekable: true,
      author: 'Google TTS',
      length: -1,
      isStream: false,
      position: 0,
      title: trackInput.title,
      uri: trackInput.uri,
      artworkUrl: null,
      isrc: null,
      sourceName: 'google-tts',
      details: []
    }

    return {
      encoded: encodeTrack(track),
      info: track,
      pluginInfo: {}
    }
  }

  /**
   * Initializes the source.
   *
   * @returns `true` once the source has been registered.
   */
  public async setup(): Promise<boolean> {
    logger('info', 'Sources', 'Loaded Google TTS source.')
    return true
  }

  /**
   * Converts a Google TTS search query into a single synthetic track.
   *
   * @param query - Raw TTS text supplied by the caller.
   * @returns Track result payload, an empty result for blank input, or an
   * exception payload when URL construction fails.
   */
  public async search(query: string): Promise<SourceResult> {
    if (!query) {
      return { loadType: 'empty', data: {} }
    }

    try {
      const url = this.buildUrl(query)
      const track = this.buildTrack({
        title: this.buildTitle(query),
        uri: url,
        identifier: `gtts:${query}`
      })

      return {
        loadType: 'track',
        data: track
      }
    } catch (error) {
      return {
        exception: {
          message: this.getErrorMessage(
            error instanceof Error ? error : String(error)
          ),
          severity: 'fault',
          cause: 'Exception'
        }
      }
    }
  }

  /**
   * Resolves a Google TTS request into a synthetic track payload.
   *
   * The legacy source treats resolve and search the same way, so this method
   * delegates to {@link search}.
   *
   * @param query - Raw Google TTS text.
   * @returns Same payload produced by {@link search}.
   */
  public async resolve(query: string): Promise<SourceResult> {
    return this.search(query)
  }

  /**
   * Resolves the direct playback URL for a Google TTS track.
   *
   * This method also fixes an incoherent cache behavior from the original
   * source: it now writes the resolved URL into the track cache instead of only
   * attempting a read.
   *
   * @param track - Decoded Google TTS track information.
   * @param _itag - Unused format selector, kept for source-manager
   * compatibility.
   * @param forceRefresh - When `true`, bypasses the cache and rebuilds the URL
   * immediately.
   * @returns Direct HTTPS playback URL for the Google TTS request.
   */
  public async getTrackUrl(
    track: TrackInfo,
    _itag?: number,
    forceRefresh = false
  ): Promise<TrackUrlResult> {
    if (!forceRefresh) {
      const cached =
        this.nodelink.trackCacheManager?.get<GoogleTtsTrackUrlResult>(
          'google-tts',
          track.identifier
        ) ?? null

      if (cached) {
        return cached
      }
    }

    const result: GoogleTtsTrackUrlResult = {
      url: track.uri,
      protocol: 'https',
      format: 'mp3'
    }

    try {
      this.nodelink.trackCacheManager?.set(
        'google-tts',
        track.identifier,
        result
      )
    } catch {
      // Best-effort cache writes are intentionally ignored.
    }

    return result
  }

  /**
   * Opens a proxied audio stream for a Google TTS playback URL.
   *
   * This preserves the original streaming behavior but also rejects non-`200`
   * upstream responses, which prevents HTML or error pages from being treated
   * as playable audio.
   *
   * @param decodedTrack - Decoded track metadata being played.
   * @param url - Direct playback URL returned by `getTrackUrl(...)`.
   * @param _protocol - Protocol hint, unused by this source.
   * @param _additionalData - Additional stream metadata, unused by this source.
   * @returns Playable stream payload, or an exception payload when the
   * upstream request fails.
   */
  public async loadStream(
    decodedTrack: TrackInfo,
    url: string,
    _protocol?: string,
    _additionalData?: Record<string, object | string | number | boolean | null>
  ): Promise<TrackStreamResult | GoogleTtsExceptionResult> {
    logger(
      'debug',
      'Sources',
      `Loading Google TTS stream for "${decodedTrack.title}"`
    )

    try {
      const response = await makeRequest(url, {
        method: 'GET',
        streamOnly: true,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
        }
      })

      if (response.error || !response.stream) {
        throw new Error(
          response.error || 'Failed to get stream, no stream object returned.'
        )
      }

      if (response.statusCode !== 200) {
        throw new Error(`Google TTS returned status ${response.statusCode}`)
      }

      const stream = new PassThrough()
      response.stream.pipe(stream)

      response.stream.on('end', () => {
        stream.emit('finishBuffering')
      })

      response.stream.on('error', (error: Error) => {
        logger('error', 'Sources', `Google TTS stream error: ${error.message}`)
        if (!stream.destroyed) {
          stream.destroy(error)
        }
      })

      return { stream }
    } catch (error) {
      const message = this.getErrorMessage(
        error instanceof Error ? error : String(error)
      )

      logger('error', 'Sources', `Failed to load Google TTS stream: ${message}`)

      return {
        exception: {
          message,
          severity: 'common',
          cause: 'Upstream'
        }
      }
    }
  }
}
