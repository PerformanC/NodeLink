import type {
  SourceResult,
  TrackInfo,
  TrackUrlResult,
  WorkerNodeLink
} from '../typings/sources/source.types.ts'
import type {
  BestMatchCandidate,
  HttpRequestResult,
  TrackEncodeInput
} from '../typings/utils.types.ts'
import {
  encodeTrack,
  getBestMatch,
  http1makeRequest,
  logger
} from '../utils.ts'

const SHAZAM_PATTERN =
  /https?:\/\/(?:www\.)?shazam\.com\/song\/\d+(?:\/[^/?#]+)?/
const SHAZAM_SEARCH_BASE =
  'https://www.shazam.com/services/amapi/v1/catalog/US/search'

/**
 * JSON-compatible scalar or nested value used for payload narrowing.
 */
type JsonValue = JsonRecord | JsonValue[] | string | number | boolean | null

/**
 * Object-like JSON record used to safely inspect HTTP payloads.
 */
interface JsonRecord {
  [key: string]: JsonValue | undefined
}

/**
 * Runtime configuration accepted by the Shazam source.
 */
interface ShazamSourceConfig {
  /**
   * Whether explicit tracks can be selected by the best-match fallback.
   */
  allowExplicit?: boolean
}

/**
 * Runtime options consumed by the Shazam source.
 */
interface ShazamRuntimeOptions {
  /**
   * Global maximum search-result limit used by several sources.
   */
  maxSearchResults?: number

  /**
   * Source configuration keyed by source name.
   */
  sources?: {
    /**
     * Shazam-specific configuration.
     */
    shazam?: ShazamSourceConfig
  }
}

/**
 * Artwork payload returned by the Shazam search API.
 */
interface ShazamArtwork {
  /**
   * Artwork template URL.
   */
  url: string | null

  /**
   * Template width placeholder value.
   */
  width: string | number | null

  /**
   * Template height placeholder value.
   */
  height: string | number | null
}

/**
 * Song attributes returned by the Shazam search API.
 */
interface ShazamSongAttributes {
  /**
   * Artist display name.
   */
  artistName: string | null

  /**
   * Track duration in milliseconds.
   */
  durationInMillis: number | null

  /**
   * Track display name.
   */
  name: string | null

  /**
   * Canonical public URL.
   */
  url: string | null

  /**
   * Track artwork payload.
   */
  artwork: ShazamArtwork | null

  /**
   * Whether the track is marked explicit by the API.
   */
  contentRating: string | null

  /**
   * ISRC returned by the API.
   */
  isrc: string | null
}

/**
 * Song item returned by the Shazam search API.
 */
interface ShazamSongItem {
  /**
   * Stable Shazam track identifier.
   */
  id: string | null

  /**
   * Track attributes block.
   */
  attributes: ShazamSongAttributes | null
}

/**
 * Track plugin metadata attached to Shazam results.
 */
interface ShazamTrackPluginInfo {
  /**
   * Linked Apple Music page extracted from the Shazam page when available.
   */
  appleMusicUrl?: string
}

/**
 * Track payload accepted by the shared encoder.
 */
interface ShazamTrackInfo extends TrackEncodeInput {
  /**
   * Whether the generated track can be seeked.
   */
  isSeekable: boolean

  /**
   * Canonical Shazam URL or public track URL.
   */
  uri: string

  /**
   * Artwork URL when available.
   */
  artworkUrl: string | null

  /**
   * ISRC when available.
   */
  isrc: string | null
}

/**
 * Encoded Shazam track payload returned to callers.
 */
interface ShazamTrackData extends BestMatchCandidate {
  /**
   * Base64-encoded Lavalink-compatible track payload.
   */
  encoded: string

  /**
   * Human-readable track information.
   */
  info: ShazamTrackInfo

  /**
   * Shazam-specific plugin metadata.
   */
  pluginInfo: ShazamTrackPluginInfo | Record<string, never>
}

/**
 * Source manager methods required by the Shazam source.
 */
interface ShazamSourceManager {
  /**
   * Searches a source alias or source name through the manager.
   *
   * @param sourceTerm Search alias or source name.
   * @param query Search query.
   * @returns Source result returned by the manager.
   */
  search: (sourceTerm: string, query: string) => Promise<SourceResult>

  /**
   * Searches using the configured default search sources.
   *
   * @param query Search query.
   * @returns Source result returned by the manager.
   */
  searchWithDefault: (query: string) => Promise<SourceResult>

  /**
   * Resolves a playable URL for a track.
   *
   * @param track Track information to resolve.
   * @returns Track URL metadata.
   */
  getTrackUrl: (track: TrackInfo) => Promise<TrackUrlResult>
}

/**
 * Exception payload returned by Shazam operations.
 */
interface ShazamExceptionResult {
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
  }
}

/**
 * Shazam source implementation.
 */
export default class ShazamSource {
  /**
   * Runtime worker context used by the source implementation.
   */
  public readonly nodelink: WorkerNodeLink

  /**
   * Search aliases handled by this source.
   */
  public readonly searchTerms: string[]

  /**
   * URL patterns supported by this source.
   */
  public readonly patterns: RegExp[]

  /**
   * Match priority used by the source manager.
   */
  public readonly priority: number

  /**
   * Whether explicit tracks are allowed during best-match selection.
   */
  public allowExplicit: boolean

  /**
   * Creates a new Shazam source wrapper.
   *
   * @param nodelink Worker runtime used by the source implementation.
   */
  public constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
    this.searchTerms = ['shsearch', 'szsearch']
    this.patterns = [SHAZAM_PATTERN]
    this.priority = 90
    this.allowExplicit = true
  }

  /**
   * Reads the Shazam configuration from the shared runtime.
   *
   * @returns Sanitized Shazam configuration limited to the fields used by this source.
   */
  private getConfig(): ShazamSourceConfig {
    const options = this.nodelink.options as ShazamRuntimeOptions
    const config = options.sources?.shazam

    return {
      allowExplicit:
        typeof config?.allowExplicit === 'boolean'
          ? config.allowExplicit
          : undefined
    }
  }

  /**
   * Reads the configured maximum number of search results.
   *
   * @returns A positive integer limit used for search requests.
   */
  private getMaxSearchResults(): number {
    const options = this.nodelink.options as ShazamRuntimeOptions
    const limit = options.maxSearchResults

    return typeof limit === 'number' && Number.isInteger(limit) && limit > 0
      ? limit
      : 10
  }

  /**
   * Initializes the source using the runtime configuration.
   *
   * @returns `true` when the source is ready to accept requests.
   */
  public async setup(): Promise<boolean> {
    const shazamConfig = this.getConfig()
    this.allowExplicit = shazamConfig.allowExplicit ?? true
    return true
  }

  /**
   * Searches the Shazam catalog for songs matching the provided query.
   *
   * @param query Search query.
   * @returns Search results, an empty payload, or a structured exception.
   */
  public async search(query: string): Promise<SourceResult> {
    try {
      const limit = this.getMaxSearchResults()
      const url =
        `${SHAZAM_SEARCH_BASE}?types=songs&term=${encodeURIComponent(query)}` +
        `&limit=${limit}`

      const { body, statusCode, error } = await http1makeRequest(url)
      if (error || statusCode !== 200) {
        return { loadType: 'empty', data: {} }
      }

      const songs = this.extractSearchSongs(body)
      if (songs.length === 0) {
        return { loadType: 'empty', data: {} }
      }

      const tracks = songs
        .map((item) => this.buildTrack(item))
        .filter((track): track is ShazamTrackData => track !== null)

      return tracks.length > 0
        ? { loadType: 'search', data: tracks }
        : { loadType: 'empty', data: {} }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger('error', 'Shazam', `Search failed for ${query}: ${message}`)
      return { exception: { message, severity: 'fault' } }
    }
  }

  /**
   * Resolves a Shazam track page into a metadata-only track that later falls
   * back to a playable source.
   *
   * @param url Public Shazam song URL.
   * @returns A track, an empty payload, or a structured exception.
   */
  public async resolve(url: string): Promise<SourceResult> {
    try {
      const response = await http1makeRequest(url)
      if (response.statusCode !== 200) {
        return { loadType: 'empty', data: {} }
      }

      const html = this.getTextBody(response)
      if (!html) {
        return { loadType: 'empty', data: {} }
      }

      const appleMusicUrl = this.extractHrefStartingAt(
        html,
        'href="https://www.shazam.com/applemusic/song/'
      )
      const durationMs = this.extractDurationMs(html)
      const isrc = this.extractIsrcFromHtml(html)

      let title = this.extractTextAfterClass(
        html,
        'NewTrackPageHeader_trackTitle__'
      )
      let artist = this.extractTextAfterClass(
        html,
        'TrackPageArtistLink_artistNameText__'
      )
      let artworkUrl = this.extractArtworkFromImgAlt(html)

      if (!title || title === 'Unknown') {
        const ogTitle = this.extractMetaContent(html, 'og:title')
        if (ogTitle) {
          const titleMatch = ogTitle.match(/^(.+?) - (.+?):/)
          if (titleMatch?.[1] && titleMatch?.[2]) {
            title = titleMatch[1]
            artist = titleMatch[2]
          } else {
            title = ogTitle
          }
        }
      }

      if (!title) title = 'Unknown'
      if (!artist) artist = 'Unknown'

      if (!artworkUrl) {
        artworkUrl = this.extractMetaContent(html, 'og:image')
      }

      if (title === 'Unknown' && !appleMusicUrl) {
        return { loadType: 'empty', data: {} }
      }

      const cleanUrl = url.endsWith('/') ? url.slice(0, -1) : url
      const identifier = cleanUrl.slice(cleanUrl.lastIndexOf('/') + 1)
      const track = this.createTrack(
        {
          identifier,
          author: artist,
          length: durationMs || 0,
          title,
          uri: url,
          artworkUrl,
          isrc
        },
        appleMusicUrl ? { appleMusicUrl } : {}
      )

      return { loadType: 'track', data: track }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger('error', 'Shazam', `Failed to resolve ${url}: ${message}`)
      return { exception: { message, severity: 'fault' } }
    }
  }

  /**
   * Resolves a playable stream URL for a Shazam track by searching other
   * sources. It prefers ISRC-based YouTube Music matches when available and
   * falls back to a text query plus default-search sources.
   *
   * @param decodedTrack Decoded Shazam track information.
   * @returns Delegated track URL metadata or a structured exception.
   */
  public async getTrackUrl(
    decodedTrack: TrackInfo
  ): Promise<TrackUrlResult | ShazamExceptionResult> {
    const sourceManager = this.getSourceManager()
    if (!sourceManager) {
      return {
        exception: {
          message: 'Source manager is not available for Shazam resolution.',
          severity: 'fault'
        }
      }
    }

    try {
      const query = `${decodedTrack.title} ${decodedTrack.author}`
      let searchResult: SourceResult = { loadType: 'empty', data: {} }
      let searchTracks: ShazamTrackData[] = []

      if (decodedTrack.isrc) {
        searchResult = await sourceManager.search(
          'ytmsearch',
          `"${decodedTrack.isrc}"`
        )
        searchTracks = this.extractTrackArray(searchResult)

        if (searchTracks.length > 0) {
          logger(
            'debug',
            'Shazam',
            `Found result via ISRC: ${decodedTrack.isrc}`
          )
        }
      }

      if (searchTracks.length === 0) {
        if (decodedTrack.isrc) {
          logger(
            'debug',
            'Shazam',
            `ISRC search failed for ${decodedTrack.isrc}, falling back to text query`
          )
        }

        searchResult = await sourceManager.search('ytmsearch', query)
        searchTracks = this.extractTrackArray(searchResult)
      }

      if (searchTracks.length === 0) {
        searchResult = await sourceManager.searchWithDefault(query)
        searchTracks = this.extractTrackArray(searchResult)
      }

      if (searchTracks.length === 0) {
        return {
          exception: { message: 'No alternative found.', severity: 'fault' }
        }
      }

      const bestMatchCandidate = getBestMatch(searchTracks, decodedTrack, {
        allowExplicit: this.allowExplicit
      })
      const bestMatch = bestMatchCandidate
        ? this.findTrackDataByCandidate(searchTracks, bestMatchCandidate)
        : null

      if (!bestMatch) {
        return {
          exception: { message: 'No suitable match.', severity: 'fault' }
        }
      }

      const stream = await sourceManager.getTrackUrl(bestMatch.info)
      return { newTrack: bestMatch, ...stream }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger('error', 'Shazam', `Failed to get track URL: ${message}`)
      return { exception: { message, severity: 'fault' } }
    }
  }

  /**
   * Converts a Shazam search-song entry into an encoded track payload.
   *
   * @param item Raw song item returned by the Shazam search API.
   * @returns An encoded track entry or `null` when the song is incomplete.
   */
  private buildTrack(item: ShazamSongItem): ShazamTrackData | null {
    if (!item.id || !item.attributes) {
      return null
    }

    const attributes = item.attributes
    const artwork = this.parseArtwork(attributes.artwork)
    const isExplicit = attributes.contentRating === 'explicit'

    let trackUri = attributes.url || ''
    if (trackUri) {
      trackUri += `${trackUri.includes('?') ? '&' : '?'}explicit=${String(isExplicit)}`
    }

    return this.createTrack({
      identifier: item.id,
      author: attributes.artistName || 'Unknown',
      length: attributes.durationInMillis ?? 0,
      title: attributes.name || 'Unknown',
      uri: trackUri,
      artworkUrl: artwork,
      isrc: attributes.isrc
    })
  }

  /**
   * Creates an encoded Shazam track payload.
   *
   * @param input Track fields collected during search or page resolution.
   * @param pluginInfo Optional Shazam-specific metadata.
   * @returns A normalized encoded track payload.
   */
  private createTrack(
    input: {
      /**
       * Stable track identifier.
       */
      identifier: string

      /**
       * Human-readable artist name.
       */
      author: string

      /**
       * Track duration in milliseconds.
       */
      length: number

      /**
       * Human-readable track title.
       */
      title: string

      /**
       * Canonical Shazam or public track URL.
       */
      uri: string

      /**
       * Artwork URL when available.
       */
      artworkUrl: string | null

      /**
       * ISRC when available.
       */
      isrc: string | null
    },
    pluginInfo: ShazamTrackPluginInfo | Record<string, never> = {}
  ): ShazamTrackData {
    const info: ShazamTrackInfo = {
      identifier: input.identifier,
      isSeekable: true,
      author: input.author,
      length: input.length,
      isStream: false,
      position: 0,
      title: input.title,
      uri: input.uri,
      artworkUrl: input.artworkUrl,
      isrc: input.isrc,
      sourceName: 'shazam',
      details: []
    }

    return {
      encoded: encodeTrack(info),
      info,
      pluginInfo
    }
  }

  /**
   * Extracts Shazam search-song entries from a raw API response body.
   *
   * @param body Raw HTTP response body.
   * @returns Normalized Shazam song entries.
   */
  private extractSearchSongs(
    body: HttpRequestResult['body']
  ): ShazamSongItem[] {
    const payload = this.parseJsonBody(body)
    if (!payload) {
      return []
    }

    const results = this.getRecord(payload, 'results')
    const songs = results ? this.getRecord(results, 'songs') : null
    const data = songs ? this.getArray(songs, 'data') : []

    return data
      .map((value) => this.toSongItem(value))
      .filter((item): item is ShazamSongItem => item !== null)
  }

  /**
   * Converts a raw API item into the narrowed Shazam song shape.
   *
   * @param value Raw API value.
   * @returns A narrowed Shazam song item or `null`.
   */
  private toSongItem(value: JsonValue): ShazamSongItem | null {
    const record = this.getRecordFromValue(value)
    if (!record) {
      return null
    }

    const attributesRecord = this.getRecord(record, 'attributes')
    const attributes = attributesRecord
      ? this.toSongAttributes(attributesRecord)
      : null

    return {
      id: this.getString(record, 'id'),
      attributes
    }
  }

  /**
   * Converts a raw attributes record into the narrowed song-attributes shape.
   *
   * @param record Raw Shazam attributes record.
   * @returns A narrowed attributes object.
   */
  private toSongAttributes(record: JsonRecord): ShazamSongAttributes {
    return {
      artistName: this.getString(record, 'artistName'),
      durationInMillis: this.getNumber(record, 'durationInMillis'),
      name: this.getString(record, 'name'),
      url: this.getString(record, 'url'),
      artwork: this.toArtwork(this.getValue(record, 'artwork')),
      contentRating: this.getString(record, 'contentRating'),
      isrc: this.getString(record, 'isrc')
    }
  }

  /**
   * Converts a raw artwork payload into the narrowed artwork shape.
   *
   * @param value Raw artwork value.
   * @returns A narrowed artwork payload or `null`.
   */
  private toArtwork(value?: JsonValue): ShazamArtwork | null {
    const record = this.getRecordFromValue(value)
    if (!record) {
      return null
    }

    return {
      url: this.getString(record, 'url'),
      width: this.getString(record, 'width') ?? this.getNumber(record, 'width'),
      height:
        this.getString(record, 'height') ?? this.getNumber(record, 'height')
    }
  }

  /**
   * Parses a Shazam artwork payload into a concrete image URL.
   *
   * @param artworkData Artwork payload returned by the search API.
   * @returns The resolved artwork URL or `null`.
   */
  private parseArtwork(artworkData: ShazamArtwork | null): string | null {
    if (
      !artworkData?.url ||
      artworkData.width === null ||
      artworkData.height === null
    ) {
      return null
    }

    return artworkData.url
      .replace('{w}', String(artworkData.width))
      .replace('{h}', String(artworkData.height))
  }

  /**
   * Extracts human-readable text that appears immediately after an element
   * containing the provided class fragment.
   *
   * @param html Raw Shazam page HTML.
   * @param classPart Class fragment to locate.
   * @returns Extracted text or `null` when not found.
   */
  private extractTextAfterClass(
    html: string,
    classPart: string
  ): string | null {
    let from = 0

    while (true) {
      const classIndex = html.indexOf('class="', from)
      if (classIndex === -1) return null

      const quoteIndex = html.indexOf('"', classIndex + 7)
      if (quoteIndex === -1) return null

      const classValue = html.slice(classIndex + 7, quoteIndex)
      if (classValue.includes(classPart)) {
        const start = html.indexOf('>', quoteIndex)
        if (start === -1) return null

        const end = html.indexOf('<', start + 1)
        if (end === -1) return null

        const text = html.slice(start + 1, end).trim()
        return text || null
      }

      from = quoteIndex + 1
    }
  }

  /**
   * Extracts the first href value starting with the provided prefix.
   *
   * @param html Raw Shazam page HTML.
   * @param hrefPrefix Prefix used to locate the href.
   * @returns The href value or `null`.
   */
  private extractHrefStartingAt(
    html: string,
    hrefPrefix: string
  ): string | null {
    const index = html.indexOf(hrefPrefix)
    if (index === -1) return null

    const start = index + 6
    const end = html.indexOf('"', start)
    return end > start ? html.slice(start, end) : null
  }

  /**
   * Extracts artwork from either the Open Graph image meta tag or the cover
   * image srcset used by the Shazam page.
   *
   * @param html Raw Shazam page HTML.
   * @returns The best artwork URL or `null`.
   */
  private extractArtworkFromImgAlt(html: string): string | null {
    const ogImageMatch = html.match(
      /<meta property="og:image" content="([^"]+)"/
    )
    if (ogImageMatch?.[1]) {
      return ogImageMatch[1]
    }

    let altIndex = html.indexOf('alt="album cover"')
    if (altIndex === -1) {
      altIndex = html.indexOf('alt="song thumbnail"')
    }
    if (altIndex === -1) {
      return null
    }

    const imageStart = html.lastIndexOf('<img', altIndex)
    if (imageStart === -1) {
      return null
    }

    const imageEnd = html.indexOf('>', altIndex)
    if (imageEnd === -1) {
      return null
    }

    const tag = html.slice(imageStart, imageEnd + 1)
    const srcsetIndex = tag.indexOf('srcset="')
    if (srcsetIndex === -1) {
      return null
    }

    const valueStart = srcsetIndex + 8
    const valueEnd = tag.indexOf('"', valueStart)
    if (valueEnd === -1) {
      return null
    }

    const srcset = tag.slice(valueStart, valueEnd)
    const spaceIndex = srcset.indexOf(' ')
    return (spaceIndex === -1 ? srcset : srcset.slice(0, spaceIndex)) || null
  }

  /**
   * Extracts an ISRC from the Shazam page HTML.
   *
   * @param html Raw Shazam page HTML.
   * @returns The extracted ISRC or `null`.
   */
  private extractIsrcFromHtml(html: string): string | null {
    const tokens = ['"isrc"', '\\"isrc\\"']

    for (const token of tokens) {
      let from = 0

      while (true) {
        const tokenIndex = html.indexOf(token, from)
        if (tokenIndex === -1) break
        from = tokenIndex + token.length

        let index = html.indexOf(':', from)
        if (index === -1) break
        index++

        while (index < html.length) {
          const code = html.charCodeAt(index)
          if (code !== 32 && code !== 9 && code !== 10 && code !== 13) break
          index++
        }

        while (html.charCodeAt(index) === 92) index++
        if (html.charCodeAt(index) !== 34) continue
        index++

        if (index + 12 > html.length) continue

        if (
          !this.isUppercaseCode(html.charCodeAt(index)) ||
          !this.isUppercaseCode(html.charCodeAt(index + 1))
        ) {
          continue
        }

        if (
          !this.isUppercaseOrDigitCode(html.charCodeAt(index + 2)) ||
          !this.isUppercaseOrDigitCode(html.charCodeAt(index + 3)) ||
          !this.isUppercaseOrDigitCode(html.charCodeAt(index + 4))
        ) {
          continue
        }

        let valid = true
        for (let offset = 5; offset < 12; offset++) {
          if (!this.isDigitCode(html.charCodeAt(index + offset))) {
            valid = false
            break
          }
        }

        if (valid) {
          return html.slice(index, index + 12)
        }
      }
    }

    return null
  }

  /**
   * Extracts and parses an ISO-8601 duration from the Shazam page.
   *
   * @param html Raw Shazam page HTML.
   * @returns Duration in milliseconds.
   */
  private extractDurationMs(html: string): number {
    const needles = [
      '"duration":"PT',
      '"duration": "PT',
      '\\"duration\\":\\"PT'
    ]

    let isoDuration: string | null = null
    for (const needle of needles) {
      const index = html.indexOf(needle)
      if (index === -1) {
        continue
      }

      const start = index + needle.length - 2
      const end = needle.startsWith('\\')
        ? html.indexOf('\\"', start)
        : html.indexOf('"', start)
      isoDuration = end === -1 ? null : html.slice(start, end)
      break
    }

    if (!isoDuration) {
      return 0
    }

    const separatorIndex = isoDuration.indexOf('T')
    if (separatorIndex === -1) {
      return 0
    }

    let milliseconds = 0
    let numberValue = 0
    let fractionValue = 0
    let fractionDivisor = 1
    let inFraction = false

    for (let index = separatorIndex + 1; index < isoDuration.length; index++) {
      const code = isoDuration.charCodeAt(index)

      if (code >= 48 && code <= 57) {
        const digit = code - 48
        if (inFraction) {
          fractionValue = fractionValue * 10 + digit
          fractionDivisor *= 10
        } else {
          numberValue = numberValue * 10 + digit
        }
        continue
      }

      if (code === 46) {
        inFraction = true
        continue
      }

      const value = inFraction
        ? numberValue + fractionValue / fractionDivisor
        : numberValue

      if (code === 72) {
        milliseconds += value * 3600000
      } else if (code === 77) {
        milliseconds += value * 60000
      } else if (code === 83) {
        milliseconds += value * 1000
      } else {
        break
      }

      numberValue = 0
      fractionValue = 0
      fractionDivisor = 1
      inFraction = false
    }

    return milliseconds ? Math.round(milliseconds) : 0
  }

  /**
   * Extracts a meta-property content value from the Shazam page.
   *
   * @param html Raw page HTML.
   * @param property Open Graph property name.
   * @returns The meta content or `null`.
   */
  private extractMetaContent(html: string, property: string): string | null {
    const regex = new RegExp(`<meta property="${property}" content="([^"]+)"`)
    const match = html.match(regex)
    return match?.[1] ?? null
  }

  /**
   * Extracts a text body from an HTTP response payload.
   *
   * @param response HTTP response payload.
   * @returns A UTF-8 string when the body is text-like, otherwise `null`.
   */
  private getTextBody(
    response: Pick<HttpRequestResult, 'body'>
  ): string | null {
    if (typeof response.body === 'string') {
      return response.body
    }

    if (Buffer.isBuffer(response.body)) {
      return response.body.toString('utf8')
    }

    return response.body !== undefined && response.body !== null
      ? String(response.body)
      : null
  }

  /**
   * Parses a JSON-capable response body into a record.
   *
   * @param body Raw HTTP response body.
   * @returns A JSON record or `null` when the payload is not object-like.
   */
  private parseJsonBody(body: HttpRequestResult['body']): JsonRecord | null {
    if (
      body &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      !Buffer.isBuffer(body)
    ) {
      return body as JsonRecord
    }

    const textBody = this.getTextBody({ body })
    if (!textBody) {
      return null
    }

    try {
      const parsed = JSON.parse(textBody)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as JsonRecord)
        : null
    } catch {
      return null
    }
  }

  /**
   * Returns the source manager narrowed to the methods used by this source.
   *
   * @returns The narrowed source manager or `null` when unavailable.
   */
  private getSourceManager(): ShazamSourceManager | null {
    const sourceManager = this.nodelink.sources as
      | ShazamSourceManager
      | undefined
    return sourceManager ?? null
  }

  /**
   * Reads a nested record property from a JSON record.
   *
   * @param record Source record.
   * @param key Property name to read.
   * @returns The nested record or `null` when the property is not an object.
   */
  private getRecord(record: JsonRecord, key: string): JsonRecord | null {
    return this.getRecordFromValue(record[key])
  }

  /**
   * Converts a JSON value into a record when possible.
   *
   * @param value Candidate JSON value.
   * @returns The record representation or `null`.
   */
  private getRecordFromValue(value?: JsonValue): JsonRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as JsonRecord)
      : null
  }

  /**
   * Reads an arbitrary property value from a JSON record.
   *
   * @param record Source record.
   * @param key Property name to read.
   * @returns The property value or `undefined` when absent.
   */
  private getValue(record: JsonRecord, key: string): JsonValue | undefined {
    return record[key]
  }

  /**
   * Reads an array property from a JSON record.
   *
   * @param record Source record.
   * @param key Property name to read.
   * @returns The nested array or an empty array when the property is not an array.
   */
  private getArray(record: JsonRecord, key: string): JsonValue[] {
    const value = this.getValue(record, key)
    return Array.isArray(value) ? value : []
  }

  /**
   * Reads a string-like field from a JSON record.
   *
   * @param record Source record.
   * @param key Property name to read.
   * @returns The normalized string value or `null`.
   */
  private getString(record: JsonRecord, key: string): string | null {
    const value = this.getValue(record, key)

    if (typeof value === 'string') {
      return value
    }

    if (typeof value === 'number') {
      return String(value)
    }

    return null
  }

  /**
   * Reads a numeric field from a JSON record.
   *
   * @param record Source record.
   * @param key Property name to read.
   * @returns The numeric value or `null`.
   */
  private getNumber(record: JsonRecord, key: string): number | null {
    const value = this.getValue(record, key)
    return typeof value === 'number' ? value : null
  }

  /**
   * Extracts an array of encoded tracks from a source-manager search result.
   *
   * @param result Source-manager search result.
   * @returns Track array suitable for best-match selection.
   */
  private extractTrackArray(result: SourceResult): ShazamTrackData[] {
    const resultData = result.data as JsonValue | ShazamTrackData[] | undefined

    if (
      result.loadType === 'search' &&
      Array.isArray(resultData) &&
      resultData.every((item) => this.isTrackData(item))
    ) {
      return resultData
    }

    return []
  }

  /**
   * Checks whether an arbitrary value is a valid encoded track payload.
   *
   * @param value Candidate value returned by delegated source calls.
   * @returns `true` when the value is a usable encoded track payload.
   */
  private isTrackData(
    value: JsonValue | ShazamTrackData | undefined
  ): value is ShazamTrackData {
    const record = this.getRecordFromValue(value as JsonValue)
    if (!record) {
      return false
    }

    const encoded = this.getValue(record, 'encoded')
    const info = this.getRecord(record, 'info')
    const title = info ? this.getValue(info, 'title') : undefined
    const author = info ? this.getValue(info, 'author') : undefined
    const length = info ? this.getValue(info, 'length') : undefined
    const uri = info ? this.getValue(info, 'uri') : undefined

    return (
      typeof encoded === 'string' &&
      !!info &&
      typeof title === 'string' &&
      typeof author === 'string' &&
      typeof length === 'number' &&
      typeof uri === 'string'
    )
  }

  /**
   * Maps a scored best-match candidate back to the original encoded track
   * payload returned by the search pipeline.
   *
   * @param tracks Candidate encoded tracks.
   * @param candidate Best-match candidate selected by the scoring helper.
   * @returns The original encoded track payload or `null` when no exact match exists.
   */
  private findTrackDataByCandidate(
    tracks: ShazamTrackData[],
    candidate: BestMatchCandidate
  ): ShazamTrackData | null {
    return (
      tracks.find(
        (track) =>
          track.info.title === candidate.info.title &&
          track.info.author === candidate.info.author &&
          track.info.uri === candidate.info.uri
      ) ?? null
    )
  }

  /**
   * Checks whether a character code is an uppercase ASCII letter.
   *
   * @param code Character code.
   * @returns `true` when the code is an uppercase ASCII letter.
   */
  private isUppercaseCode(code: number): boolean {
    return code >= 65 && code <= 90
  }

  /**
   * Checks whether a character code is an ASCII digit.
   *
   * @param code Character code.
   * @returns `true` when the code is an ASCII digit.
   */
  private isDigitCode(code: number): boolean {
    return code >= 48 && code <= 57
  }

  /**
   * Checks whether a character code is an uppercase ASCII letter or digit.
   *
   * @param code Character code.
   * @returns `true` when the code is an uppercase letter or digit.
   */
  private isUppercaseOrDigitCode(code: number): boolean {
    return this.isUppercaseCode(code) || this.isDigitCode(code)
  }
}
