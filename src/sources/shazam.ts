import type {
  SourceResult,
  TrackData,
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
  /^https?:\/\/(?:www\.)?shazam\.com\/song\/\d+(?:\/[^/?#]+)?\/?(?:[?#].*)?$/
const SHAZAM_SEARCH_BASE =
  'https://www.shazam.com/services/amapi/v1/catalog/US/search'
const APPLE_CATALOG_SEARCH_BASE =
  'https://api.music.apple.com/v1/catalog/US/search'
const APPLE_CATALOG_SONG_BASE =
  'https://api.music.apple.com/v1/catalog/US/songs'
const APPLE_MUSIC_BROWSE_URL = 'https://music.apple.com/us/browse'

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
  search?: {
    maxResults?: number
  }

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
  [x: string]: unknown
  /**
   * Linked Apple Music page extracted from the Shazam page when available.
   */
  appleMusicUrl?: string
}

/**
 * Track payload accepted by the shared encoder.
 */
interface ShazamTrackInfo extends TrackEncodeInput {
  [x: string]: unknown
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
  pluginInfo: ShazamTrackPluginInfo | Record<string, unknown>
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
   * Cached Apple Music media API token scraped from the web player.
   */
  private mediaApiToken: string | null = null

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
    const limit = options.search?.maxResults

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
      const normalizedQuery = query.trim()
      if (!normalizedQuery) {
        return { loadType: 'empty', data: {} }
      }

      const limit = this.getMaxSearchResults()
      const url =
        `${SHAZAM_SEARCH_BASE}?types=songs&term=${encodeURIComponent(normalizedQuery)}` +
        `&limit=${limit}`

      const { body, statusCode, error } = await http1makeRequest(url)
      if (error || statusCode !== 200) {
        return { loadType: 'empty', data: {} }
      }

      const songs = this.extractSearchSongs(body)
      if (songs.length === 0) {
        return { loadType: 'empty', data: {} }
      }

      const tracks: ShazamTrackData[] = []
      for (const item of songs) {
        const track = this.buildTrack(item)
        if (track) {
          tracks.push(track)
        }
      }

      return tracks.length > 0
        ? { loadType: 'search', data: tracks }
        : { loadType: 'empty', data: {} }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger('error', 'Shazam', `Search failed for ${query}: ${message}`)
      return { loadType: 'error', exception: { message, severity: 'fault' } }
    }
  }

  /**
   * Resolves a Shazam track URL via the Apple Music catalog API, falling
   * back to a slug-based catalog search when the ID lookup has no match.
   *
   * @param url Public Shazam song URL.
   * @returns A track, an empty payload, or a structured exception.
   */
  public async resolve(url: string): Promise<SourceResult> {
    try {
      if (!this.patterns.some((pattern) => pattern.test(url))) {
        return { loadType: 'empty', data: {} }
      }

      const cleanUrl = url.replace(/[?#].*$/, '').replace(/\/$/, '')
      const match = cleanUrl.match(/\/song\/(\d+)(?:\/[^/?#]+)?$/)
      const identifier = match?.[1]
      if (!identifier) {
        return { loadType: 'empty', data: {} }
      }

      const appleSong = await this.fetchAppleSongById(identifier)
      if (appleSong) {
        const appleMusicUrl = appleSong.attributes?.url
        const track = this.buildTrack(
          appleSong,
          cleanUrl,
          appleMusicUrl ? { appleMusicUrl } : {}
        )
        if (track) {
          return { loadType: 'track', data: track }
        }
      }

      return (
        (await this.resolveViaSlugSearch(url)) ?? {
          loadType: 'empty',
          data: {}
        }
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger('error', 'Shazam', `Failed to resolve ${url}: ${message}`)
      return { loadType: 'error', exception: { message, severity: 'fault' } }
    }
  }

  /**
   * Returns a cached Apple Music media API token, scraping a fresh one from
   * the web player when needed.
   *
   * @returns The media API token or `null` when scraping fails.
   */
  private async getMediaApiToken(): Promise<string | null> {
    if (this.mediaApiToken) {
      return this.mediaApiToken
    }

    try {
      const { body: html, statusCode } = await http1makeRequest(
        APPLE_MUSIC_BROWSE_URL
      )
      if (statusCode !== 200 || typeof html !== 'string') {
        return null
      }

      const scriptMatch = html.match(
        /<script\s+type="module"\s+crossorigin\s+src="([^"]+)"/
      )
      if (!scriptMatch?.[1]) {
        return null
      }

      const { body: jsData, statusCode: jsStatus } = await http1makeRequest(
        `https://music.apple.com${scriptMatch[1]}`
      )
      if (jsStatus !== 200 || typeof jsData !== 'string') {
        return null
      }

      const tokenMatch = jsData.match(
        /(?<token>(ey[\w-]+)\.([\w-]+)\.([\w-]+))/
      )
      const token = tokenMatch?.groups?.token
      if (!token) {
        return null
      }

      this.mediaApiToken = token
      return token
    } catch {
      return null
    }
  }

  /**
   * Fetches a single song from the Apple Music catalog API.
   *
   * @param identifier Apple Music / Shazam song identifier.
   * @returns A narrowed song item or `null` when unavailable.
   */
  private async fetchAppleSongById(
    identifier: string
  ): Promise<ShazamSongItem | null> {
    const token = await this.getMediaApiToken()
    if (!token) {
      return null
    }

    const { body, statusCode, error } = await http1makeRequest(
      `${APPLE_CATALOG_SONG_BASE}/${encodeURIComponent(identifier)}?l=en-us`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          Origin: 'https://music.apple.com'
        }
      }
    )

    if (statusCode === 401) {
      this.mediaApiToken = null
      return null
    }

    if (error || statusCode !== 200) {
      return null
    }

    const payload = this.parseJsonBody(body)
    const items = payload ? this.getArray(payload, 'data') : []
    for (const item of items) {
      const song = this.toSongItem(item)
      if (song?.id === identifier && song.attributes) {
        return song
      }
    }

    return null
  }

  /**
   * Falls back to a slug-based Apple Music catalog search when the ID
   * lookup has no match.
   *
   * @param url Public Shazam song URL.
   * @returns A track or `null` when no song matches the URL identifier.
   */
  private async resolveViaSlugSearch(
    url: string
  ): Promise<SourceResult | null> {
    try {
      const token = await this.getMediaApiToken()
      if (!token) {
        return null
      }

      const pathParts = new URL(url).pathname.split('/').filter(Boolean)
      const identifier = pathParts[1]
      const slug = pathParts[2]
      if (!identifier || !slug) return null

      const searchTerm = decodeURIComponent(slug).replace(/[-_]+/g, ' ')
      const searchUrl =
        `${APPLE_CATALOG_SEARCH_BASE}?limit=5&types=songs&term=` +
        encodeURIComponent(searchTerm)

      const searchRes = await http1makeRequest(searchUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          Origin: 'https://music.apple.com'
        }
      })

      if (!searchRes.error && searchRes.statusCode === 200) {
        const song = this.extractSearchSongs(searchRes.body).find(
          (s) => s.id === identifier
        )
        if (song) {
          const track = this.buildTrack(song)
          if (track) return { loadType: 'track', data: track }
        }
      }

      return null
    } catch {
      return null
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
  ): Promise<TrackUrlResult | SourceResult> {
    const sourceManager = this.getSourceManager()
    if (!sourceManager) {
      return {
        loadType: 'error',
        exception: {
          message: 'Source manager is not available for Shazam resolution.',
          severity: 'fault'
        }
      }
    }

    try {
      const query = `${decodedTrack.title} ${decodedTrack.author}`
      let searchResult = await sourceManager.searchWithDefault(
        decodedTrack.isrc ? `"${decodedTrack.isrc}"` : query
      )
      let searchTracks = this.extractTrackArray(searchResult)

      if (searchTracks.length === 0) {
        searchResult = await sourceManager.searchWithDefault(query)
        searchTracks = this.extractTrackArray(searchResult)
      }

      if (searchTracks.length === 0) {
        return {
          loadType: 'error',
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
          loadType: 'error',
          exception: { message: 'No suitable match.', severity: 'fault' }
        }
      }

      const stream = await sourceManager.getTrackUrl(bestMatch.info)
      return { newTrack: bestMatch, ...stream }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger('error', 'Shazam', `Failed to get track URL: ${message}`)
      return { loadType: 'error', exception: { message, severity: 'fault' } }
    }
  }

  /**
   * Converts a Shazam search-song entry into an encoded track payload.
   *
   * @param item Raw song item returned by the Shazam search API.
   * @param uri Optional canonical URI override (e.g. the Shazam page URL
   * when resolving, used verbatim instead of the API URL).
   * @param pluginInfo Optional Shazam-specific metadata.
   * @returns An encoded track entry or `null` when the song is incomplete.
   */
  private buildTrack(
    item: ShazamSongItem,
    uri?: string,
    pluginInfo: ShazamTrackPluginInfo | Record<string, unknown> = {}
  ): ShazamTrackData | null {
    if (!item.id || !item.attributes) {
      return null
    }

    const attributes = item.attributes
    const artwork = this.parseArtwork(attributes.artwork)
    const isExplicit = attributes.contentRating === 'explicit'

    let trackUri = uri ?? attributes.url ?? ''
    if (!uri && trackUri) {
      trackUri += `${trackUri.includes('?') ? '&' : '?'}explicit=${String(isExplicit)}`
    }

    return this.createTrack(
      {
        identifier: item.id,
        author: attributes.artistName || 'Unknown',
        length: attributes.durationInMillis ?? 0,
        title: attributes.name || 'Unknown',
        uri: trackUri,
        artworkUrl: artwork,
        isrc: attributes.isrc
      },
      pluginInfo
    )
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
    pluginInfo: ShazamTrackPluginInfo | Record<string, unknown> = {}
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

    const songsList: ShazamSongItem[] = []
    for (const value of data) {
      const item = this.toSongItem(value)
      if (item) {
        songsList.push(item)
      }
    }
    return songsList
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

    if (response.body instanceof Uint8Array) {
      return Buffer.from(response.body).toString('utf8')
    }

    return null
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
      !Buffer.isBuffer(body) &&
      !(body instanceof Uint8Array)
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
    if (result.loadType === 'search') {
      const resultData = result.data
      if (
        Array.isArray(resultData) &&
        resultData.every((item) => this.isTrackData(item))
      ) {
        return resultData as ShazamTrackData[]
      }
    }

    if (result.loadType === 'track') {
      const singleTrack = result.data as ShazamTrackData | undefined
      if (this.isTrackData(singleTrack)) {
        return [singleTrack]
      }
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
    value: JsonValue | ShazamTrackData | TrackData | undefined
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
}
