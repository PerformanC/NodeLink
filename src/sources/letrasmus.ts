import type {
  SourceResult,
  TrackInfo,
  TrackStreamResult,
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

const LETRAS_PATTERN =
  /^https?:\/\/(?:www\.)?letras\.(?:mus\.br|com)\/[a-z0-9-]+\/[^/]+\/?/i
const ARTIST_PATTERN =
  /^https?:\/\/(?:www\.)?letras\.(?:mus\.br|com)\/([a-z0-9-]+)\//i
const SOLR_ENDPOINT = 'https://solr.sscdn.co/letras/m1/'
const RECOMMENDATION_ENDPOINT = 'https://api.letras.mus.br/v2/playlists/radio'

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
 * Runtime options consumed by the LetrasMus source.
 */
interface LetrasRuntimeOptions {
  /**
   * Maximum number of search results returned by the source.
   */
  maxSearchResults?: number
}

/**
 * Minimal OMQ lyric payload embedded in LetrasMus pages.
 */
interface LetrasOmqLyric {
  /**
   * Track title.
   */
  Name?: string

  /**
   * Artist name.
   */
  Artist?: string

  /**
   * YouTube video id linked to the page.
   */
  YoutubeID?: string
}

/**
 * Solr result document returned by the LetrasMus suggestion endpoint.
 */
interface LetrasSolrDoc {
  /**
   * Result type used by the Solr endpoint.
   */
  t?: string | null

  /**
   * Artist slug used to build the public URL.
   */
  dns?: string | null

  /**
   * Track slug used to build the public URL.
   */
  url?: string | null

  /**
   * Artist display name.
   */
  art?: string | null

  /**
   * Track title.
   */
  txt?: string | null

  /**
   * Artwork URL when available.
   */
  img?: string | null
}

/**
 * Recommendation item returned by the LetrasMus radio endpoint.
 */
interface LetrasRecommendationItem {
  /**
   * Artist slug used to build the public URL.
   */
  DNS?: string | null

  /**
   * Track slug used to build the public URL.
   */
  URL?: string | null

  /**
   * Artist display name.
   */
  Artist?: string | null

  /**
   * Track title.
   */
  Name?: string | null
}

/**
 * Track payload accepted by the shared encoder.
 */
interface LetrasTrackInfo extends TrackEncodeInput {
  /**
   * Whether the generated track can be seeked.
   */
  isSeekable: boolean

  /**
   * Canonical LetrasMus URL.
   */
  uri: string

  /**
   * Artwork URL when available.
   */
  artworkUrl: string | null

  /**
   * LetrasMus does not expose ISRC values directly.
   */
  isrc: null
}

/**
 * Encoded LetrasMus track payload returned to callers.
 */
interface LetrasTrackData extends BestMatchCandidate {
  /**
   * Base64-encoded Lavalink-compatible track payload.
   */
  encoded: string

  /**
   * Human-readable track information.
   */
  info: LetrasTrackInfo

  /**
   * LetrasMus does not currently attach plugin metadata here.
   */
  pluginInfo: Record<string, never>
}

/**
 * Source manager methods required by the LetrasMus source.
 */
interface LetrasSourceManager {
  /**
   * Resolves an arbitrary URL through the source manager.
   *
   * @param url URL to resolve.
   * @returns Source result returned by the manager.
   */
  resolve: (url: string) => Promise<SourceResult>

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

  /**
   * Loads the stream for a resolved track.
   *
   * @param track Track metadata.
   * @param url Resolved URL.
   * @param protocol Optional protocol hint.
   * @param additionalData Optional source-specific data.
   * @returns Track stream result.
   */
  getTrackStream: (
    track: TrackInfo,
    url: string,
    protocol?: string,
    additionalData?: Record<string, JsonValue>
  ) => Promise<TrackStreamResult & { type?: string }>
}

/**
 * Exception payload returned by LetrasMus operations.
 */
interface LetrasExceptionResult {
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
 * Decodes the small subset of HTML entities used by LetrasMus pages.
 *
 * @param text Raw HTML text.
 * @returns A decoded string, or the original value when empty.
 */
function decodeHtml(text: string | null): string | null {
  if (!text) return text

  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

/**
 * Parses a JSONP response returned by the LetrasMus Solr endpoint.
 *
 * @param body Raw response body.
 * @returns Parsed JSON value or `null` when parsing fails.
 */
function parseJsonp(body: string): JsonValue | null {
  const trimmed = body.trim()
  if (!trimmed) return null

  try {
    if (trimmed.startsWith('LetrasSug(') && trimmed.endsWith(')')) {
      return JSON.parse(trimmed.slice('LetrasSug('.length, -1)) as JsonValue
    }

    const start = trimmed.indexOf('(')
    const end = trimmed.lastIndexOf(')')
    if (start !== -1 && end > start) {
      return JSON.parse(trimmed.slice(start + 1, end)) as JsonValue
    }

    return JSON.parse(trimmed) as JsonValue
  } catch {
    return null
  }
}

/**
 * Extracts a meta-property content value from a LetrasMus page.
 *
 * @param html Raw page HTML.
 * @param property Open Graph property name to search.
 * @returns The decoded meta content, or `null` when absent.
 */
function extractMeta(html: string, property: string): string | null {
  const re1 = new RegExp(
    `<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    'i'
  )
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["'][^>]*>`,
    'i'
  )
  const match = html.match(re1) || html.match(re2)
  return match?.[1] ? decodeHtml(match[1]) : null
}

/**
 * Extracts the canonical URL from a LetrasMus page.
 *
 * @param html Raw page HTML.
 * @returns The canonical URL when available.
 */
function extractCanonicalUrl(html: string): string | null {
  const linkMatch = html.match(
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>/i
  )
  if (linkMatch?.[1]) {
    return decodeHtml(linkMatch[1])
  }

  return extractMeta(html, 'og:url')
}

/**
 * Extracts the `_omq.push(['ui/lyric', ...])` payload embedded in a LetrasMus
 * page.
 *
 * @param html Raw page HTML.
 * @returns Parsed lyric metadata or `null` when the payload is absent.
 */
function extractOmqLyric(html: string): LetrasOmqLyric | null {
  const match = html.match(/_omq\.push\(\['ui\/lyric',\s*({[\s\S]*?})\s*,/i)
  if (!match?.[1]) return null

  try {
    return JSON.parse(match[1]) as LetrasOmqLyric
  } catch {
    return null
  }
}

/**
 * Builds a public LetrasMus track URL from the artist and song slugs returned
 * by the APIs.
 *
 * @param dns Artist slug.
 * @param url Song slug.
 * @returns The canonical public track URL.
 */
function buildTrackUrl(dns: string, url: string): string {
  return `https://www.letras.mus.br/${dns}/${url}/`
}

/**
 * LetrasMus source implementation.
 */
export default class LetrasMusSource {
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
   * Search aliases handled by this source.
   */
  public readonly searchTerms: string[]

  /**
   * Recommendation aliases handled by this source.
   */
  public readonly recommendationTerm: string[]

  /**
   * Maximum number of search results returned by the source.
   */
  public readonly maxSearchResults: number

  /**
   * Creates a new LetrasMus source wrapper.
   *
   * @param nodelink Worker runtime used by the source implementation.
   */
  public constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
    this.priority = 40
    this.searchTerms = ['lmsearch']
    this.recommendationTerm = ['lmrec']
    this.patterns = [LETRAS_PATTERN]

    const options = nodelink.options as LetrasRuntimeOptions
    this.maxSearchResults =
      typeof options.maxSearchResults === 'number' &&
      Number.isInteger(options.maxSearchResults) &&
      options.maxSearchResults > 0
        ? options.maxSearchResults
        : 10
  }

  /**
   * Announces the source during worker initialization.
   *
   * @returns `true` when the source is ready to accept requests.
   */
  public async setup(): Promise<boolean> {
    logger('info', 'Sources', 'Loaded LetrasMus source.')
    return true
  }

  /**
   * Checks whether a URL belongs to a supported LetrasMus page.
   *
   * @param link Candidate URL.
   * @returns `true` when the URL matches the LetrasMus pattern.
   */
  public isLinkMatch(link: string): boolean {
    return LETRAS_PATTERN.test(link)
  }

  /**
   * Searches LetrasMus or returns radio-style recommendations depending on the
   * alias used by the source manager.
   *
   * @param query Search query or reference URL.
   * @param sourceTerm Search alias provided by the source manager.
   * @returns Search results, an empty payload, or a structured exception.
   */
  public async search(
    query: string,
    sourceTerm?: string
  ): Promise<SourceResult> {
    try {
      if (sourceTerm === 'lmrec') {
        return await this.recommend(query)
      }

      const tracks = await this.searchSolr(query)
      return tracks.length > 0
        ? { loadType: 'search', data: tracks }
        : { loadType: 'empty', data: {} }
    } catch (error) {
      return {
        exception: {
          message: error instanceof Error ? error.message : String(error),
          severity: 'fault'
        }
      }
    }
  }

  /**
   * Resolves a LetrasMus page into a metadata-only track and attempts to enrich
   * duration and artwork using the linked YouTube video when available.
   *
   * @param url Public LetrasMus page URL.
   * @returns A track, an empty payload, or a structured exception.
   */
  public async resolve(url: string): Promise<SourceResult> {
    if (!LETRAS_PATTERN.test(url)) {
      return { loadType: 'empty', data: {} }
    }

    try {
      const { body, statusCode, error } = await http1makeRequest(url, {
        method: 'GET'
      })

      const html = this.getTextBody({ body })
      if (error || statusCode !== 200 || !html) {
        return {
          exception: {
            message: `Failed to fetch Letras page: ${error ?? statusCode}`,
            severity: 'fault'
          }
        }
      }

      const omq = extractOmqLyric(html)
      const title = omq?.Name || extractMeta(html, 'og:title') || 'Unknown'
      const author = omq?.Artist || 'Unknown'
      const artworkUrl = extractMeta(html, 'og:image')
      const youtubeId = omq?.YoutubeID || null
      const canonical = extractCanonicalUrl(html) || url

      let length = 0
      let finalArtwork = artworkUrl || null

      if (youtubeId) {
        try {
          const youtubeUrl = `https://www.youtube.com/watch?v=${youtubeId}`
          const youtubeResult =
            await this.getSourceManager()?.resolve(youtubeUrl)
          const youtubeTrack = youtubeResult
            ? this.extractTrackFromResolveResult(youtubeResult)
            : null

          if (youtubeTrack) {
            if (Number.isFinite(youtubeTrack.info.length)) {
              length = youtubeTrack.info.length
            }

            if (!finalArtwork && youtubeTrack.info.artworkUrl) {
              finalArtwork = youtubeTrack.info.artworkUrl
            }
          }
        } catch {}
      }

      return {
        loadType: 'track',
        data: this.buildTrack({
          identifier: canonical,
          author,
          length,
          title,
          uri: canonical,
          artworkUrl: finalArtwork
        })
      }
    } catch (error) {
      return {
        exception: {
          message: error instanceof Error ? error.message : String(error),
          severity: 'fault'
        }
      }
    }
  }

  /**
   * Resolves a playable stream for a LetrasMus track by preferring the linked
   * YouTube id from the page and otherwise falling back to a search match.
   *
   * @param decodedTrack Decoded LetrasMus track information.
   * @returns Delegated track URL metadata or a structured exception.
   */
  public async getTrackUrl(
    decodedTrack: TrackInfo
  ): Promise<TrackUrlResult | LetrasExceptionResult> {
    const sourceManager = this.getSourceManager()
    if (!sourceManager) {
      return {
        exception: {
          message: 'Source manager is not available for LetrasMus resolution.',
          severity: 'fault'
        }
      }
    }

    try {
      const youtubeId = decodedTrack.uri
        ? await this.resolveYoutubeIdFromPage(decodedTrack.uri)
        : null

      if (youtubeId) {
        const youtubeUrl = `https://www.youtube.com/watch?v=${youtubeId}`
        const youtubeResult = await sourceManager.resolve(youtubeUrl)
        const youtubeTrack = this.extractTrackFromResolveResult(youtubeResult)

        if (youtubeTrack) {
          const streamInfo = await sourceManager.getTrackUrl(youtubeTrack.info)
          return { newTrack: youtubeTrack, ...streamInfo }
        }
      }

      const query = `${decodedTrack.title} ${decodedTrack.author}`.trim()
      let searchResult = await sourceManager.search('ytmsearch', query)
      let searchTracks = searchResult.data as
        | JsonValue
        | LetrasTrackData[]
        | undefined

      if (
        searchResult.loadType !== 'search' ||
        !this.isTrackDataArray(searchTracks)
      ) {
        searchResult = await sourceManager.searchWithDefault(query)
        searchTracks = searchResult.data as
          | JsonValue
          | LetrasTrackData[]
          | undefined
      }

      if (
        searchResult.loadType !== 'search' ||
        !this.isTrackDataArray(searchTracks) ||
        searchTracks.length === 0
      ) {
        return {
          exception: {
            message: 'No matching track found on default source.',
            severity: 'common'
          }
        }
      }

      const bestMatchCandidate = getBestMatch(searchTracks, decodedTrack)
      const bestMatch = bestMatchCandidate
        ? this.findTrackDataByCandidate(searchTracks, bestMatchCandidate)
        : null

      if (!bestMatch) {
        return {
          exception: {
            message: 'No suitable alternative found after filtering.',
            severity: 'common'
          }
        }
      }

      const streamInfo = await sourceManager.getTrackUrl(bestMatch.info)
      return { newTrack: bestMatch, ...streamInfo }
    } catch (error) {
      return {
        exception: {
          message: error instanceof Error ? error.message : String(error),
          severity: 'fault'
        }
      }
    }
  }

  /**
   * Loads a stream by delegating to the source manager entry that owns the
   * resolved playback URL.
   *
   * @param track Track metadata.
   * @param url Resolved playback URL.
   * @param protocol Optional protocol hint.
   * @param additionalData Optional source-specific data.
   * @returns The delegated track stream result.
   */
  public async loadStream(
    track: TrackInfo,
    url: string,
    protocol?: string,
    additionalData?: Record<string, JsonValue>
  ): Promise<TrackStreamResult & { type?: string }> {
    const sourceManager = this.getSourceManager()
    if (!sourceManager) {
      throw new Error('Source manager is not available for LetrasMus streaming')
    }

    return sourceManager.getTrackStream(track, url, protocol, additionalData)
  }

  /**
   * Searches the LetrasMus Solr endpoint and maps the response into encoded
   * track stubs.
   *
   * @param query Search query.
   * @returns Encoded track stubs returned by the Solr endpoint.
   */
  public async searchSolr(query: string): Promise<LetrasTrackData[]> {
    const url = `${SOLR_ENDPOINT}?q=${encodeURIComponent(query)}&wt=json&callback=LetrasSug`
    const { body, statusCode, error } = await http1makeRequest(url, {
      method: 'GET'
    })

    const text = this.getTextBody({ body })
    if (error || statusCode !== 200 || !text) {
      throw new Error(`Letras search failed: ${error ?? statusCode}`)
    }

    const parsed = parseJsonp(text)
    const responseRecord =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? this.getRecordFromValue(parsed)
        : null
    const responseData = responseRecord
      ? this.getRecord(responseRecord, 'response')
      : null
    const docs = responseData ? this.getArray(responseData, 'docs') : []

    return docs
      .map((value) => this.toSolrDoc(value))
      .filter((doc): doc is LetrasSolrDoc => doc !== null)
      .filter((doc) => doc.t === '2' && !!doc.dns && !!doc.url)
      .slice(0, this.maxSearchResults)
      .map((doc) => {
        const uri = buildTrackUrl(doc.dns as string, doc.url as string)
        return this.buildTrack({
          identifier: uri,
          author: doc.art || 'Unknown',
          length: 0,
          title: doc.txt || 'Unknown',
          uri,
          artworkUrl: doc.img || null
        })
      })
  }

  /**
   * Returns recommendation tracks for the artist associated with the query or
   * page URL.
   *
   * @param query Search query or LetrasMus URL.
   * @returns Search results, an empty payload, or a structured exception.
   */
  public async recommend(query: string): Promise<SourceResult> {
    let artistSlug = query.match(ARTIST_PATTERN)?.[1] || null

    if (!artistSlug) {
      try {
        const searchTracks = await this.searchSolr(query)
        const firstUri = searchTracks[0]?.info.uri
        artistSlug = firstUri?.match(ARTIST_PATTERN)?.[1] || null
      } catch {}
    }

    if (!artistSlug) {
      return { loadType: 'empty', data: {} }
    }

    const recUrl = `${RECOMMENDATION_ENDPOINT}/${artistSlug}/`
    const { body, statusCode, error } = await http1makeRequest(recUrl, {
      method: 'GET'
    })

    const payload =
      body &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      !Buffer.isBuffer(body)
        ? (body as JsonRecord)
        : null

    if (error || statusCode !== 200 || !payload) {
      return {
        exception: {
          message: `Letras recommendation failed: ${error ?? statusCode}`,
          severity: 'fault'
        }
      }
    }

    const songList = this.getArray(payload, 'SongList')
    const tracks = songList
      .map((item) => this.toRecommendationItem(item))
      .filter((item): item is LetrasRecommendationItem => item !== null)
      .filter((item) => !!item.DNS && !!item.URL)
      .slice(0, this.maxSearchResults)
      .map((item) => {
        const uri = buildTrackUrl(item.DNS as string, item.URL as string)
        return this.buildTrack({
          identifier: uri,
          author: item.Artist || 'Unknown',
          length: 0,
          title: item.Name || 'Unknown',
          uri,
          artworkUrl: null
        })
      })

    if (tracks.length === 0) {
      return { loadType: 'empty', data: {} }
    }

    return { loadType: 'search', data: tracks }
  }

  /**
   * Fetches a LetrasMus page and extracts the linked YouTube id from the
   * embedded lyric metadata.
   *
   * @param url LetrasMus page URL.
   * @returns The linked YouTube id or `null`.
   */
  private async resolveYoutubeIdFromPage(url: string): Promise<string | null> {
    try {
      const { body, statusCode, error } = await http1makeRequest(url, {
        method: 'GET'
      })

      const html = this.getTextBody({ body })
      if (error || statusCode !== 200 || !html) {
        return null
      }

      return extractOmqLyric(html)?.YoutubeID || null
    } catch {
      return null
    }
  }

  /**
   * Builds an encoded LetrasMus track payload.
   *
   * @param input Track fields collected from page resolution or search results.
   * @returns An encoded LetrasMus track entry.
   */
  private buildTrack(input: {
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
     * Canonical LetrasMus URL.
     */
    uri: string

    /**
     * Artwork URL when available.
     */
    artworkUrl: string | null
  }): LetrasTrackData {
    const info: LetrasTrackInfo = {
      identifier: input.identifier,
      isSeekable: true,
      author: input.author,
      length: input.length,
      isStream: false,
      position: 0,
      title: input.title,
      uri: input.uri,
      artworkUrl: input.artworkUrl,
      isrc: null,
      sourceName: 'letrasmus',
      details: []
    }

    return {
      encoded: encodeTrack(info),
      info,
      pluginInfo: {}
    }
  }

  /**
   * Extracts a single track from a delegated resolve result, supporting direct
   * track responses and the first track inside playlists.
   *
   * @param result Delegated source result.
   * @returns A usable track entry or `null`.
   */
  private extractTrackFromResolveResult(
    result: SourceResult
  ): LetrasTrackData | null {
    const trackData = result.data as JsonValue | LetrasTrackData | undefined
    if (result.loadType === 'track' && this.isTrackData(trackData)) {
      return trackData
    }

    const playlistData = result.data as
      | JsonValue
      | { tracks: LetrasTrackData[] }
      | undefined
    if (
      result.loadType === 'playlist' &&
      this.isPlaylistData(playlistData) &&
      playlistData.tracks.length > 0
    ) {
      return playlistData.tracks[0] ?? null
    }

    return null
  }

  /**
   * Returns the source manager narrowed to the methods used by this source.
   *
   * @returns The narrowed source manager or `null` when unavailable.
   */
  private getSourceManager(): LetrasSourceManager | null {
    const sourceManager = this.nodelink.sources as
      | LetrasSourceManager
      | undefined
    return sourceManager ?? null
  }

  /**
   * Converts a buffered HTTP body into text.
   *
   * @param response HTTP helper response carrying the buffered body.
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

    return null
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
   * Reads an array property from a JSON record.
   *
   * @param record Source record.
   * @param key Property name to read.
   * @returns The nested array or an empty array when the property is not an array.
   */
  private getArray(record: JsonRecord, key: string): JsonValue[] {
    const value = record[key]
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
    const value = record[key]

    if (typeof value === 'string') {
      return value
    }

    if (typeof value === 'number') {
      return String(value)
    }

    return null
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
   * Narrows a raw Solr response value to the subset used by this source.
   *
   * @param value Raw Solr item.
   * @returns A narrowed Solr document or `null`.
   */
  private toSolrDoc(value: JsonValue): LetrasSolrDoc | null {
    const record = this.getRecordFromValue(value)
    if (!record) {
      return null
    }

    return {
      t: this.getString(record, 't'),
      dns: this.getString(record, 'dns'),
      url: this.getString(record, 'url'),
      art: this.getString(record, 'art'),
      txt: this.getString(record, 'txt'),
      img: this.getString(record, 'img')
    }
  }

  /**
   * Narrows a raw recommendation item to the subset used by this source.
   *
   * @param value Raw recommendation item.
   * @returns A narrowed recommendation item or `null`.
   */
  private toRecommendationItem(
    value: JsonValue
  ): LetrasRecommendationItem | null {
    const record = this.getRecordFromValue(value)
    if (!record) {
      return null
    }

    return {
      DNS: this.getString(record, 'DNS'),
      URL: this.getString(record, 'URL'),
      Artist: this.getString(record, 'Artist'),
      Name: this.getString(record, 'Name')
    }
  }

  /**
   * Checks whether an arbitrary value is a valid encoded track payload.
   *
   * @param value Candidate value returned by delegated source calls.
   * @returns `true` when the value is a usable encoded track payload.
   */
  private isTrackData(
    value: JsonValue | LetrasTrackData | undefined
  ): value is LetrasTrackData {
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
   * Checks whether a value exposes a valid playlist-like `tracks` array.
   *
   * @param value Candidate source result payload.
   * @returns `true` when the value contains a valid `tracks` array.
   */
  private isPlaylistData(
    value: JsonValue | { tracks: LetrasTrackData[] } | undefined
  ): value is { tracks: LetrasTrackData[] } {
    const record = this.getRecordFromValue(value as JsonValue)
    if (!record) {
      return false
    }

    const tracks = this.getValue(record, 'tracks')
    return (
      Array.isArray(tracks) &&
      tracks.every((track) => this.isTrackData(track as JsonValue))
    )
  }

  /**
   * Checks whether a value is an array of track payloads usable by
   * `getBestMatch`.
   *
   * @param value Candidate search result payload.
   * @returns `true` when the payload is a valid track array.
   */
  private isTrackDataArray(
    value: JsonValue | LetrasTrackData[] | undefined
  ): value is LetrasTrackData[] {
    return Array.isArray(value) && value.every((item) => this.isTrackData(item))
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
    tracks: LetrasTrackData[],
    candidate: BestMatchCandidate
  ): LetrasTrackData | null {
    return (
      tracks.find(
        (track) =>
          track.info.title === candidate.info.title &&
          track.info.author === candidate.info.author &&
          track.info.uri === candidate.info.uri
      ) ?? null
    )
  }
}
