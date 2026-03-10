import { PassThrough } from 'node:stream'
import type {
  SourceResult,
  TrackInfo,
  TrackStreamResult,
  TrackUrlResult,
  WorkerNodeLink
} from '../typings/sources/source.types.ts'
import type {
  HttpRequestResult,
  TrackEncodeInput
} from '../typings/utils.types.ts'
import { encodeTrack, logger, makeRequest } from '../utils.ts'

const BANDCAMP_BASE_URL = 'https://bandcamp.com'
const BANDCAMP_TRACK_PATTERN =
  /^https?:\/\/([^/]+)\.bandcamp\.com\/(track|album)\/([^/?]+)/
const SEARCH_RESULT_REGEX =
  /<li class="searchresult data-search"[\s\S]*?<\/li>/g
const SEARCH_URL_REGEX = /<a class="artcont" href="([^"]+)">/
const SEARCH_TITLE_REGEX = /<div class="heading">\s*<a[^>]*>\s*(.+?)\s*<\/a>/
const SEARCH_SUBHEAD_REGEX = /<div class="subhead">([\s\S]*?)<\/div>/
const SEARCH_ARTWORK_REGEX = /<div class="art">\s*<img src="([^"]+)"/
const STREAM_URL_REGEX = /https?:\/\/t4\.bcbits\.com\/stream\/[^"'\\\s]+/
const TRALBUM_REGEX = /data-tralbum=(["'])([\s\S]+?)\1/

/**
 * Runtime options used by the Bandcamp source.
 */
interface BandcampRuntimeOptions {
  /**
   * Maximum number of tracks returned for search operations.
   */
  maxSearchResults?: number
}

/**
 * Minimal Bandcamp track payload used by `data-tralbum`.
 */
interface BandcampTralbumTrack {
  /**
   * Internal track identifier exposed by Bandcamp.
   */
  track_id?: string | number

  /**
   * Secondary internal identifier used by some pages.
   */
  id?: string | number

  /**
   * Relative per-track page URL when the payload represents an album.
   */
  title_link?: string

  /**
   * Human-readable track title.
   */
  title?: string

  /**
   * Duration in seconds.
   */
  duration?: number
}

/**
 * Minimal Bandcamp page payload used by the source.
 */
interface BandcampTralbumData {
  /**
   * Artist name extracted from the page payload.
   */
  artist?: string

  /**
   * Artwork identifier used to build the public image URL.
   */
  art_id?: string | number

  /**
   * Current page metadata.
   */
  current?: {
    /**
     * Album or track title.
     */
    title?: string
  }

  /**
   * Track list present on the page.
   */
  trackinfo?: BandcampTralbumTrack[]
}

/**
 * Raw search result values parsed from the Bandcamp search page.
 */
interface BandcampSearchResult {
  /**
   * Result title.
   */
  title: string

  /**
   * Result artist name.
   */
  author: string

  /**
   * Canonical Bandcamp page URL.
   */
  uri: string

  /**
   * Search thumbnail when available.
   */
  artworkUrl: string | null
}

/**
 * Track fields required to build an encoded Bandcamp track.
 */
interface BandcampTrackBuildInput {
  /**
   * Stable track identifier when already known.
   */
  identifier?: string | null

  /**
   * Whether the track can be seeked.
   */
  isSeekable?: boolean

  /**
   * Track author.
   */
  author?: string | null

  /**
   * Track duration in milliseconds.
   */
  length?: number

  /**
   * Whether the track is a stream.
   */
  isStream?: boolean

  /**
   * Track title.
   */
  title?: string | null

  /**
   * Canonical public URL.
   */
  uri: string

  /**
   * Artwork URL when available.
   */
  artworkUrl: string | null
}

/**
 * Encodable Bandcamp track payload.
 */
interface BandcampTrackInfo extends TrackEncodeInput {
  /**
   * Whether the resolved item can be seeked.
   */
  isSeekable: boolean

  /**
   * Canonical Bandcamp page URL.
   */
  uri: string

  /**
   * Artwork URL returned by Bandcamp.
   */
  artworkUrl: string | null

  /**
   * Bandcamp does not expose ISRC in this path.
   */
  isrc: null
}

/**
 * Encoded Bandcamp track returned by the source manager.
 */
interface BandcampTrackData {
  /**
   * Base64-encoded Lavalink-compatible track payload.
   */
  encoded: string

  /**
   * Human-readable track information.
   */
  info: BandcampTrackInfo

  /**
   * Bandcamp does not currently attach plugin metadata here.
   */
  pluginInfo: Record<string, never>
}

/**
 * Playlist payload returned when an album resolves to multiple tracks.
 */
interface BandcampPlaylistData {
  /**
   * Playlist metadata shown to the client.
   */
  info: {
    /**
     * Album title.
     */
    name: string

    /**
     * Index of the selected track.
     */
    selectedTrack: number
  }

  /**
   * Source-specific playlist metadata.
   */
  pluginInfo: Record<string, never>

  /**
   * Encoded tracks that belong to the album.
   */
  tracks: BandcampTrackData[]
}

/**
 * Direct playback URL descriptor returned by Bandcamp.
 */
interface BandcampTrackUrlSuccess extends TrackUrlResult {
  /**
   * Final MP3 stream URL extracted from the page.
   */
  url: string

  /**
   * Bandcamp playback is resolved as HTTPS.
   */
  protocol: 'https'

  /**
   * Bandcamp stream format used by this extractor.
   */
  format: 'mp3'
}

/**
 * Structured exception payload used by the Bandcamp source.
 */
interface BandcampExceptionResult {
  /**
   * Failure metadata returned to the source manager.
   */
  exception: {
    /**
     * Human-readable error message.
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
 * Bandcamp source implementation.
 */
export default class BandcampSource {
  /**
   * Shared worker runtime provided by the source manager.
   */
  public readonly nodelink: WorkerNodeLink

  /**
   * Base Bandcamp URL used for search requests.
   */
  public readonly baseUrl = BANDCAMP_BASE_URL

  /**
   * URL patterns supported by this source.
   */
  public readonly patterns: RegExp[] = [BANDCAMP_TRACK_PATTERN]

  /**
   * Search prefixes routed to this source.
   */
  public readonly searchTerms = ['bcsearch']

  /**
   * Source priority used for URL matching.
   */
  public readonly priority = 90

  /**
   * Creates a Bandcamp source bound to the worker runtime.
   *
   * @param nodelink Worker runtime shared with all sources.
   */
  public constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
  }

  /**
   * Announces the Bandcamp source during worker initialization.
   *
   * @returns `true` when the source is ready to accept requests.
   */
  public async setup(): Promise<boolean> {
    logger('info', 'Sources', 'Loaded BandCamp source.')
    return true
  }

  /**
   * Checks whether a URL matches one of the Bandcamp patterns.
   *
   * @param link Candidate URL provided by the source manager.
   * @returns `true` when the URL belongs to a supported Bandcamp page.
   */
  public isLinkMatch(link: string): boolean {
    return this.patterns.some((pattern) => pattern.test(link))
  }

  /**
   * Searches Bandcamp track results for a plain-text query.
   *
   * @param query Search string received from the API or unified search flow.
   * @returns Search results, an empty payload, or a structured exception.
   */
  public async search(query: string): Promise<SourceResult> {
    try {
      const request = await makeRequest(
        `${this.baseUrl}/search?q=${encodeURIComponent(query)}&item_type=t&from=results`,
        { method: 'GET' }
      )

      if (request.error || request.statusCode !== 200) {
        return {
          exception: {
            message:
              request.error ??
              `BandCamp returned an invalid status: ${request.statusCode}`,
            severity: 'fault',
            cause: 'Request Failed'
          }
        }
      }

      const body = this.getResponseText(request)
      if (body === null) {
        return this.createSourceException(
          'BandCamp search returned an unreadable response body.',
          'fault',
          'Invalid Response'
        )
      }

      const resultBlocks = body.match(SEARCH_RESULT_REGEX)

      if (!resultBlocks || resultBlocks.length === 0) {
        logger(
          'debug',
          'Sources',
          `No results found on BandCamp for: "${query}"`
        )
        return { loadType: 'empty', data: {} }
      }

      const tracks: BandcampTrackData[] = []
      const maxResults = this.getMaxSearchResults()

      for (const block of resultBlocks) {
        if (tracks.length >= maxResults) break

        const result = this.parseSearchResult(block)
        if (!result) continue

        tracks.push(this.buildTrack(result))
      }

      if (tracks.length === 0) {
        logger(
          'warn',
          'Sources',
          'Search results found on BandCamp, but no tracks could be parsed.'
        )
        return { loadType: 'empty', data: {} }
      }

      logger(
        'debug',
        'Sources',
        `Found ${tracks.length} tracks on BandCamp for: "${query}"`
      )
      return { loadType: 'search', data: tracks }
    } catch (error) {
      return this.createSourceException(
        error instanceof Error ? error.message : 'BandCamp search failed.',
        'fault',
        'Exception'
      )
    }
  }

  /**
   * Resolves a Bandcamp track or album URL into a track or playlist payload.
   *
   * @param url Canonical Bandcamp URL to resolve.
   * @returns A track, playlist, empty result, or a structured exception.
   */
  public async resolve(url: string): Promise<SourceResult> {
    try {
      const tralbumData = await this.extractTralbumData(url)
      if (
        !tralbumData ||
        !tralbumData.trackinfo ||
        tralbumData.trackinfo.length === 0
      ) {
        logger(
          'warn',
          'Sources',
          `No 'tralbum' data found on BandCamp for: ${url}`
        )
        return { loadType: 'empty', data: {} }
      }

      const artworkUrl = this.createArtworkUrl(tralbumData.art_id)
      const author = this.normalizeText(tralbumData.artist) ?? 'Unknown Artist'

      if (tralbumData.trackinfo.length > 1) {
        const tracks: BandcampTrackData[] = []

        for (const item of tralbumData.trackinfo) {
          const trackUrl = item.title_link
            ? this.buildAbsoluteTrackUrl(item.title_link, url)
            : null

          if (!trackUrl) continue

          tracks.push(
            this.buildTrack({
              identifier: this.getTrackIdentifier(item, trackUrl),
              isSeekable: true,
              author,
              length: this.toDurationMilliseconds(item.duration),
              isStream: false,
              title: this.normalizeText(item.title),
              uri: trackUrl,
              artworkUrl
            })
          )
        }

        if (tracks.length === 0) {
          return { loadType: 'empty', data: {} }
        }

        const playlist: BandcampPlaylistData = {
          info: {
            name:
              this.normalizeText(tralbumData.current?.title) ??
              'BandCamp Playlist',
            selectedTrack: 0
          },
          pluginInfo: {},
          tracks
        }

        return { loadType: 'playlist', data: playlist }
      }

      const trackData = tralbumData.trackinfo[0]
      if (!trackData) {
        return { loadType: 'empty', data: {} }
      }

      const track = this.buildTrack({
        identifier: this.getTrackIdentifier(trackData, url),
        isSeekable: true,
        author,
        length: this.toDurationMilliseconds(trackData.duration),
        isStream: false,
        title: this.normalizeText(trackData.title),
        uri: url,
        artworkUrl
      })

      return { loadType: 'track', data: track }
    } catch (error) {
      return this.createSourceException(
        error instanceof Error ? error.message : 'BandCamp resolve failed.',
        'fault',
        'Exception'
      )
    }
  }

  /**
   * Extracts the direct Bandcamp MP3 stream URL from a track page.
   *
   * @param track Decoded track information produced by the source manager.
   * @returns A direct stream URL descriptor or a structured exception.
   */
  public async getTrackUrl(
    track: TrackInfo
  ): Promise<BandcampTrackUrlSuccess | BandcampExceptionResult> {
    try {
      const { body, error, statusCode } = await makeRequest(track.uri, {
        method: 'GET'
      })

      if (error || statusCode !== 200) {
        return {
          exception: {
            message: `Failed to fetch track page: ${error ?? statusCode}`,
            severity: 'fault',
            cause: 'Request Failed'
          }
        }
      }

      const page = this.getResponseText({ body })
      if (page === null) {
        return {
          exception: {
            message: 'BandCamp returned an unreadable track page.',
            severity: 'fault',
            cause: 'Invalid Response'
          }
        }
      }

      const streamUrlMatch = page.match(STREAM_URL_REGEX)

      if (!streamUrlMatch) {
        return {
          exception: {
            message: 'No stream URL was found in the page content.',
            severity: 'fault',
            cause: 'Stream Extraction Failed'
          }
        }
      }

      return {
        url: this.decodeHtmlEntities(streamUrlMatch[0]),
        protocol: 'https',
        format: 'mp3'
      }
    } catch (error) {
      return {
        exception: {
          message:
            error instanceof Error
              ? error.message
              : 'BandCamp stream extraction failed.',
          severity: 'fault',
          cause: 'Stream Extraction Failed'
        }
      }
    }
  }

  /**
   * Opens the resolved Bandcamp audio stream for playback.
   *
   * @param decodedTrack Decoded track used only for logging context.
   * @param url Direct playback URL returned by `getTrackUrl`.
   * @returns A readable stream or a structured exception.
   */
  public async loadStream(
    decodedTrack: TrackInfo,
    url: string
  ): Promise<TrackStreamResult | BandcampExceptionResult> {
    logger(
      'debug',
      'Sources',
      `Loading BandCamp stream for "${decodedTrack.title}"`
    )

    try {
      const response = await makeRequest(url, {
        method: 'GET',
        streamOnly: true
      })

      if (response.error || response.statusCode !== 200 || !response.stream) {
        return {
          exception: {
            message:
              response.error ??
              `BandCamp returned an invalid stream status: ${response.statusCode}`,
            severity: 'common',
            cause: 'Upstream'
          }
        }
      }

      const stream = new PassThrough()
      response.stream.pipe(stream)

      return { stream }
    } catch (error) {
      logger(
        'error',
        'Sources',
        `Failed to load BandCamp stream: ${error instanceof Error ? error.message : 'unknown error'}`
      )
      return {
        exception: {
          message:
            error instanceof Error
              ? error.message
              : 'Failed to load BandCamp stream.',
          severity: 'common',
          cause: 'Upstream'
        }
      }
    }
  }

  /**
   * Fetches and parses the `data-tralbum` payload from a Bandcamp page.
   *
   * @param url Bandcamp track or album URL.
   * @returns Parsed `data-tralbum` content or `null` when extraction fails.
   */
  public async extractTralbumData(
    url: string
  ): Promise<BandcampTralbumData | null> {
    const { body, error, statusCode } = await makeRequest(url, {
      method: 'GET'
    })

    if (error || statusCode !== 200) {
      logger(
        'error',
        'Sources',
        `Failed to fetch BandCamp page: ${error ?? statusCode}`
      )
      return null
    }

    const page = this.getResponseText({ body })
    if (page === null) return null

    const match = page.match(TRALBUM_REGEX)
    if (!match || !match[2]) return null

    try {
      const decodedString = this.decodeHtmlEntities(match[2])
      return JSON.parse(decodedString) as BandcampTralbumData
    } catch (error) {
      logger(
        'warn',
        'Sources',
        `Failed to parse BandCamp tralbum payload for ${url}: ${error instanceof Error ? error.message : 'invalid JSON'}`
      )
      return null
    }
  }

  /**
   * Converts parsed Bandcamp metadata into an encoded track payload.
   *
   * @param partialInfo Track fields collected from search or page resolution.
   * @returns An encoded track entry compatible with the source manager.
   */
  public buildTrack(partialInfo: BandcampTrackBuildInput): BandcampTrackData {
    const track: BandcampTrackInfo = {
      identifier:
        partialInfo.identifier?.trim() ||
        this.getIdentifierFromUrl(partialInfo.uri),
      isSeekable: partialInfo.isSeekable ?? true,
      author: partialInfo.author?.trim() || 'Unknown Artist',
      length: partialInfo.length ?? -1,
      isStream: partialInfo.isStream ?? false,
      position: 0,
      title: partialInfo.title?.trim() || 'Unknown Title',
      uri: partialInfo.uri,
      artworkUrl: partialInfo.artworkUrl,
      isrc: null,
      sourceName: 'bandcamp',
      details: []
    }

    return {
      encoded: encodeTrack(track),
      info: track,
      pluginInfo: {}
    }
  }

  /**
   * Derives a stable identifier from a Bandcamp URL.
   *
   * @param url Bandcamp track or album URL.
   * @returns A hostname-and-slug identifier, or the URL itself as fallback.
   */
  public getIdentifierFromUrl(url: string): string {
    const match = url.match(BANDCAMP_TRACK_PATTERN)
    return match ? `${match[1]}:${match[3]}` : url
  }

  /**
   * Extracts a usable search result from a raw Bandcamp HTML block.
   *
   * @param block Raw HTML fragment for a single search result entry.
   * @returns Parsed search metadata or `null` when the entry is incomplete.
   */
  private parseSearchResult(block: string): BandcampSearchResult | null {
    const urlMatch = block.match(SEARCH_URL_REGEX)
    const titleMatch = block.match(SEARCH_TITLE_REGEX)
    const subheadMatch = block.match(SEARCH_SUBHEAD_REGEX)
    const artworkMatch = block.match(SEARCH_ARTWORK_REGEX)

    if (
      !titleMatch ||
      !titleMatch[1] ||
      !subheadMatch ||
      !subheadMatch[1] ||
      !urlMatch ||
      !urlMatch[1]
    ) {
      return null
    }

    const rawTitle = titleMatch[1]
    const rawSubhead = subheadMatch[1]
    const rawUri = urlMatch[1]
    const title = this.normalizeText(this.stripHtml(rawTitle))
    const fullSubhead = this.normalizeText(this.stripHtml(rawSubhead))
    const uri = rawUri.split('?')[0]

    if (!title || !fullSubhead || !uri) {
      return null
    }

    const artistSegments = fullSubhead.split(' de ')
    const author =
      artistSegments[artistSegments.length - 1]?.trim() || 'Unknown Artist'

    return {
      title,
      author,
      uri,
      artworkUrl: artworkMatch?.[1] ?? null
    }
  }

  /**
   * Converts an HTTP helper response body into UTF-8 text.
   *
   * @param response HTTP helper response containing a buffered body.
   * @returns The normalized text body, or `null` when the payload is not text-like.
   */
  private getResponseText(
    response: Pick<HttpRequestResult, 'body'>
  ): string | null {
    if (typeof response.body === 'string') {
      return response.body
    }

    if (Buffer.isBuffer(response.body)) {
      return response.body.toString('utf8')
    }

    return null
  }

  /**
   * Decodes the small subset of HTML entities used by the Bandcamp pages this
   * source parses.
   *
   * @param value Raw HTML fragment or encoded attribute value.
   * @returns A decoded string safe to use in URLs and titles.
   */
  private decodeHtmlEntities(value: string): string {
    return value
      .replaceAll('&quot;', '"')
      .replaceAll('&#34;', '"')
      .replaceAll('&#39;', "'")
      .replaceAll('&apos;', "'")
      .replaceAll('&amp;', '&')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
  }

  /**
   * Removes HTML tags from a fragment extracted from the Bandcamp search page.
   *
   * @param value Raw HTML fragment.
   * @returns Plain-text content with tags removed.
   */
  private stripHtml(value: string): string {
    return value.replace(/<[^>]+>/g, ' ')
  }

  /**
   * Normalizes parsed HTML text into a trimmed human-readable value.
   *
   * @param value Raw string extracted from HTML or JSON payloads.
   * @returns Normalized text, or `null` when the input becomes empty.
   */
  private normalizeText(value?: string | null): string | null {
    if (!value) return null

    const normalized = this.decodeHtmlEntities(value)
      .replace(/\s+/g, ' ')
      .trim()
    return normalized ? normalized : null
  }

  /**
   * Converts Bandcamp duration values from seconds to milliseconds.
   *
   * @param durationSeconds Duration in seconds provided by Bandcamp.
   * @returns Duration in milliseconds, or `-1` when duration is missing.
   */
  private toDurationMilliseconds(durationSeconds?: number): number {
    return durationSeconds ? Math.round(durationSeconds * 1000) : -1
  }

  /**
   * Builds the public Bandcamp artwork URL from an `art_id` value.
   *
   * @param artId Artwork identifier exposed by `data-tralbum`.
   * @returns The public image URL or `null` when no artwork exists.
   */
  private createArtworkUrl(artId?: string | number): string | null {
    if (artId === undefined || artId === null || artId === '') {
      return null
    }

    return `https://f4.bcbits.com/img/a${String(artId)}_10.jpg`
  }

  /**
   * Builds an absolute Bandcamp track URL from a relative album entry link.
   *
   * @param titleLink Relative or absolute track path exposed by Bandcamp.
   * @param parentUrl Canonical album URL used as the base.
   * @returns The absolute track URL or `null` when the input is invalid.
   */
  private buildAbsoluteTrackUrl(
    titleLink: string,
    parentUrl: string
  ): string | null {
    try {
      return new URL(titleLink, parentUrl).href
    } catch {
      return null
    }
  }

  /**
   * Chooses the best stable identifier available for a Bandcamp track.
   *
   * @param track Page payload entry returned by `data-tralbum`.
   * @param fallbackUrl Fallback public URL used when no numeric identifier exists.
   * @returns A stable identifier string for the encoded payload.
   */
  private getTrackIdentifier(
    track: BandcampTralbumTrack,
    fallbackUrl: string
  ): string {
    const identifier = track.track_id ?? track.id
    return identifier !== undefined && identifier !== null && identifier !== ''
      ? String(identifier)
      : this.getIdentifierFromUrl(fallbackUrl)
  }

  /**
   * Reads and normalizes the configured maximum number of search results.
   *
   * @returns A positive integer limit used when parsing search results.
   */
  private getMaxSearchResults(): number {
    const options = this.nodelink.options as BandcampRuntimeOptions
    const limit = options.maxSearchResults

    return typeof limit === 'number' && Number.isInteger(limit) && limit > 0
      ? limit
      : 10
  }

  /**
   * Creates a standardized source exception payload for search and resolve flows.
   *
   * @param message Human-readable failure message.
   * @param severity Error severity used by the source pipeline.
   * @param cause Optional failure origin.
   * @returns A source result containing only exception metadata.
   */
  private createSourceException(
    message: string,
    severity: string,
    cause?: string
  ): SourceResult {
    return {
      exception: {
        message,
        severity,
        cause
      }
    }
  }
}
