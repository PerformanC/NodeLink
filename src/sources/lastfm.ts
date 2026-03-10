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

const LASTFM_PATTERN =
  /^https?:\/\/(?:www\.)?last\.fm\/(?:[a-z]{2}\/)?music\/.+/
const YOUTUBE_LINK_PATTERN =
  /header-new-playlink[^>]*href="([^"]*youtube\.com[^"]+)"/
const YOUTUBE_URL_PATTERN =
  /https?:\/\/(?:www\.)?youtube\.com\/watch\?v=[a-zA-Z0-9_-]+/

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
 * Last.fm search types supported by the API path.
 */
type LastFmSearchType = 'track' | 'album' | 'artist'

/**
 * Last.fm-specific runtime configuration.
 */
interface LastFmSourceConfig {
  /**
   * API key used for Last.fm REST search endpoints.
   */
  apiKey?: string
}

/**
 * Runtime options consumed by the Last.fm source.
 */
interface LastFmRuntimeOptions {
  /**
   * Global maximum search-result limit used by several sources.
   */
  maxSearchResults?: number

  /**
   * Source configuration keyed by source name.
   */
  sources?: {
    /**
     * Last.fm-specific configuration.
     */
    lastfm?: LastFmSourceConfig
  }
}

/**
 * Plugin metadata attached to Last.fm track results.
 */
interface LastFmTrackPluginInfo {
  /**
   * YouTube URL associated with the Last.fm entry when available.
   */
  youtubeUrl?: string

  /**
   * Collection type represented by metadata-only results.
   */
  type?: 'album' | 'artist'
}

/**
 * Track payload accepted by the shared encoder.
 */
interface LastFmTrackInfo extends TrackEncodeInput {
  /**
   * Whether the generated track can be seeked.
   */
  isSeekable: boolean

  /**
   * Canonical Last.fm URL.
   */
  uri: string

  /**
   * Artwork URL when available.
   */
  artworkUrl: string | null

  /**
   * Last.fm does not expose ISRC values directly in these paths.
   */
  isrc: string | null
}

/**
 * Encoded Last.fm track payload returned to callers.
 */
interface LastFmTrackData extends BestMatchCandidate {
  /**
   * Base64-encoded Lavalink-compatible track payload.
   */
  encoded: string

  /**
   * Human-readable track information.
   */
  info: LastFmTrackInfo

  /**
   * Last.fm-specific metadata used by follow-up fallbacks.
   */
  pluginInfo: LastFmTrackPluginInfo | Record<string, never>
}

/**
 * Playlist payload returned when Last.fm resolves an album or artist page.
 */
interface LastFmPlaylistData {
  /**
   * Playlist metadata block expected by the source manager.
   */
  info: {
    /**
     * Human-readable playlist name.
     */
    name: string

    /**
     * Default selected track index.
     */
    selectedTrack: number
  }

  /**
   * Source-specific playlist metadata.
   */
  pluginInfo: Record<string, never>

  /**
   * Tracks resolved from embedded YouTube URLs.
   */
  tracks: LastFmTrackData[]
}

/**
 * Generic delegated track shape returned by other sources.
 */
interface TrackDataLike extends BestMatchCandidate {
  /**
   * Encoded track string.
   */
  encoded: string

  /**
   * Human-readable track information.
   */
  info: TrackInfo

  /**
   * Source-specific metadata object.
   */
  pluginInfo?: Record<string, JsonValue>
}

/**
 * Source manager methods required by the Last.fm source.
 */
interface LastFmSourceManager {
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
   * Loads a track stream using the source manager.
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
 * Exception payload returned by Last.fm operations.
 */
interface LastFmExceptionResult {
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
 * Decodes the small subset of HTML entities used by Last.fm pages.
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
 * Last.fm source implementation.
 */
export default class LastFMSource {
  /**
   * Runtime worker context used by the source implementation.
   */
  public readonly nodelink: WorkerNodeLink

  /**
   * Sanitized Last.fm-specific configuration.
   */
  public readonly config: LastFmSourceConfig

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
   * Maximum number of search results returned by this source.
   */
  public readonly maxSearchResults: number

  /**
   * Optional Last.fm API key.
   */
  public readonly apiKey: string | null

  /**
   * Creates a new Last.fm source wrapper.
   *
   * @param nodelink Worker runtime used by the source implementation.
   */
  public constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
    this.config = this.getConfig()
    this.patterns = [LASTFM_PATTERN]
    this.priority = 40
    this.searchTerms = ['lfsearch']
    this.maxSearchResults = this.getMaxSearchResults()
    this.apiKey = this.config.apiKey ?? null
  }

  /**
   * Reads the Last.fm configuration from the shared runtime.
   *
   * @returns Sanitized Last.fm configuration limited to the fields used by this source.
   */
  private getConfig(): LastFmSourceConfig {
    const options = this.nodelink.options as LastFmRuntimeOptions
    const config = options.sources?.lastfm

    return {
      apiKey:
        typeof config?.apiKey === 'string' && config.apiKey.length > 0
          ? config.apiKey
          : undefined
    }
  }

  /**
   * Reads the configured maximum number of search results.
   *
   * @returns A positive integer limit used by this source.
   */
  private getMaxSearchResults(): number {
    const options = this.nodelink.options as LastFmRuntimeOptions
    const limit = options.maxSearchResults

    return typeof limit === 'number' && Number.isInteger(limit) && limit > 0
      ? limit
      : 10
  }

  /**
   * Announces the Last.fm source during worker initialization.
   *
   * @returns `true` when the source is ready to accept requests.
   */
  public async setup(): Promise<boolean> {
    logger('info', 'Sources', 'Loaded Last.fm source.')
    return true
  }

  /**
   * Checks whether a URL belongs to a supported Last.fm page.
   *
   * @param link Candidate URL.
   * @returns `true` when the URL matches the Last.fm pattern.
   */
  public isLinkMatch(link: string): boolean {
    return LASTFM_PATTERN.test(link)
  }

  /**
   * Searches Last.fm either through the public HTML track search or through the
   * REST API when an API key is configured.
   *
   * @param query Search query.
   * @param _sourceTerm Search alias provided by the source manager.
   * @param searchType Search type requested by the source manager.
   * @returns Search results, an empty payload, or a structured exception.
   */
  public async search(
    query: string,
    _sourceTerm?: string,
    searchType: LastFmSearchType = 'track'
  ): Promise<SourceResult> {
    try {
      if (!this.apiKey) {
        if (searchType !== 'track') {
          return {
            exception: {
              message:
                'Last.fm API key required for album/artist search. Configure sources.lastfm.apiKey.',
              severity: 'common'
            }
          }
        }

        return this.searchTracksHtml(query)
      }

      return this.searchApi(query, searchType)
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
   * Resolves a Last.fm track, album, or artist page into a track or playlist by
   * delegating embedded or inferred media to other sources.
   *
   * @param url Public Last.fm URL.
   * @returns A track, playlist, empty payload, or a structured exception.
   */
  public async resolve(url: string): Promise<SourceResult> {
    if (!LASTFM_PATTERN.test(url)) {
      return { loadType: 'empty', data: {} }
    }

    const path = this.parsePath(url)
    if (!path) {
      return { loadType: 'empty', data: {} }
    }

    try {
      const { body, error, statusCode } = await http1makeRequest(url, {
        method: 'GET'
      })

      const html = this.getTextBody({ body })
      if (error || statusCode !== 200 || !html) {
        logger(
          'error',
          'LastFM',
          `Failed to fetch Last.fm page: ${error ?? statusCode}`
        )
        return {
          exception: {
            message: `Failed to fetch Last.fm page: ${error ?? statusCode}`,
            severity: 'fault'
          }
        }
      }

      const artist = decodeURIComponent(
        (path[1] ?? 'Unknown').replace(/\+/g, ' ')
      )

      let trackTitle = 'Unknown'
      if (path[2] === '_' && path[3]) {
        trackTitle = decodeURIComponent(path[3].replace(/\+/g, ' '))
      } else if (path[2]) {
        trackTitle = decodeURIComponent(path[2].replace(/\+/g, ' '))
      }

      const isTrack = path.includes('_') || path.length >= 4
      if (isTrack) {
        const officialSearch = await this.searchPreferredTracks(
          `${artist} - ${trackTitle} official audio`
        )

        const officialTrack = officialSearch[0]
        if (officialTrack) {
          const bestTrack = this.rewrapDelegatedTrack(officialTrack, url)
          logger(
            'info',
            'LastFM',
            `Found official audio track: ${bestTrack.info.title} by ${bestTrack.info.author}`
          )
          return { loadType: 'track', data: bestTrack }
        }

        logger(
          'warn',
          'LastFM',
          'No official audio found, attempting to search without "official audio" qualifier'
        )

        const fallbackSearch = await this.searchPreferredTracks(
          `${artist} - ${trackTitle}`
        )

        const fallbackTrack = fallbackSearch[0]
        if (fallbackTrack) {
          const bestTrack = this.rewrapDelegatedTrack(fallbackTrack, url)
          logger(
            'info',
            'LastFM',
            `Found track via fallback: ${bestTrack.info.title} by ${bestTrack.info.author}`
          )
          return { loadType: 'track', data: bestTrack }
        }

        logger('error', 'LastFM', 'No tracks found for this Last.fm track')
        return {
          exception: {
            message: 'No matching tracks found for this Last.fm track',
            severity: 'fault'
          }
        }
      }

      const youtubeUrls = this.extractYouTubeUrls(html)
      const tracks: LastFmTrackData[] = []

      for (const youtubeUrl of youtubeUrls) {
        const youtubeResult = await this.getSourceManager()?.resolve(youtubeUrl)
        if (!youtubeResult) {
          continue
        }

        const delegatedTrack = this.extractTrackDataLike(youtubeResult)
        if (!delegatedTrack) {
          continue
        }

        tracks.push(this.rewrapDelegatedTrack(delegatedTrack, url, youtubeUrl))
      }

      if (tracks.length > 0) {
        logger(
          'info',
          'LastFM',
          `Resolved playlist: ${trackTitle} - ${artist} with ${tracks.length} tracks`
        )

        const playlist: LastFmPlaylistData = {
          info: { name: `${trackTitle} - ${artist}`, selectedTrack: 0 },
          pluginInfo: {},
          tracks
        }

        return { loadType: 'playlist', data: playlist }
      }

      logger(
        'error',
        'LastFM',
        'Failed to resolve any tracks from Last.fm album/artist'
      )
      return {
        exception: {
          message: 'Failed to resolve tracks from Last.fm',
          severity: 'fault'
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger('error', 'LastFM', `Exception during resolve: ${message}`)
      return { exception: { message, severity: 'fault' } }
    }
  }

  /**
   * Resolves a playable stream URL for a Last.fm track by preferring a stored
   * YouTube URL and otherwise falling back to YouTube Music or the configured
   * default search sources.
   *
   * @param decodedTrack Decoded Last.fm track information.
   * @returns Delegated track URL metadata or a structured exception.
   */
  public async getTrackUrl(
    decodedTrack: TrackInfo & { pluginInfo?: LastFmTrackPluginInfo }
  ): Promise<TrackUrlResult | LastFmExceptionResult> {
    const sourceManager = this.getSourceManager()
    if (!sourceManager) {
      return {
        exception: {
          message: 'Source manager is not available for Last.fm resolution.',
          severity: 'fault'
        }
      }
    }

    try {
      const youtubeUrl = decodedTrack.pluginInfo?.youtubeUrl
      if (youtubeUrl) {
        const youtubeResult = await sourceManager.resolve(youtubeUrl)
        const delegatedTrack = this.extractTrackDataLike(youtubeResult)

        if (delegatedTrack) {
          const streamInfo = await sourceManager.getTrackUrl(
            delegatedTrack.info
          )
          return { newTrack: delegatedTrack, ...streamInfo }
        }
      }

      const query = `${decodedTrack.title} ${decodedTrack.author}`.trim()
      let searchResult = await sourceManager.search('ytmsearch', query)
      let searchTracks = this.extractTrackArray(searchResult)

      if (searchTracks.length === 0) {
        searchResult = await sourceManager.searchWithDefault(query)
        searchTracks = this.extractTrackArray(searchResult)
      }

      if (searchTracks.length === 0) {
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
      throw new Error('Source manager is not available for Last.fm streaming')
    }

    return sourceManager.getTrackStream(track, url, protocol, additionalData)
  }

  /**
   * Parses a Last.fm URL into path segments relevant for this source.
   *
   * @param url Public Last.fm URL.
   * @returns Parsed path segments or `null` when the URL shape is unsupported.
   */
  private parsePath(url: string): string[] | null {
    try {
      const urlObject = new URL(url)
      const path = urlObject.pathname.split('/').filter(Boolean)

      if (path.length > 1 && path[0]?.length === 2 && path[1] === 'music') {
        path.shift()
      }

      return path[0] === 'music' && path.length >= 2 ? path : null
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger('error', 'LastFM', `Error parsing path: ${message}`)
      return null
    }
  }

  /**
   * Extracts all YouTube URLs embedded in a Last.fm page.
   *
   * @param html Raw Last.fm page HTML.
   * @returns Unique YouTube URLs found in the page.
   */
  private extractYouTubeUrls(html: string): string[] {
    const urls = new Set<string>()

    const playMatch = html.match(YOUTUBE_LINK_PATTERN)
    if (playMatch?.[1]) {
      urls.add(playMatch[1])
    }

    const regex = new RegExp(YOUTUBE_URL_PATTERN, 'g')
    let match: RegExpExecArray | null
    match = regex.exec(html)
    while (match !== null) {
      if (match[0]) {
        urls.add(match[0])
      }
      match = regex.exec(html)
    }

    return Array.from(urls)
  }

  /**
   * Searches preferred sources for a Last.fm-derived query, starting with
   * YouTube Music.
   *
   * @param query Search query.
   * @returns Resolved track array suitable for reuse or matching.
   */
  private async searchPreferredTracks(query: string): Promise<TrackDataLike[]> {
    const sourceManager = this.getSourceManager()
    if (!sourceManager) {
      return []
    }

    const searchResult = await sourceManager.search('ytmsearch', query)
    const preferredTracks = this.extractTrackArray(searchResult)
    if (preferredTracks.length > 0) {
      return preferredTracks
    }

    const fallbackResult = await sourceManager.searchWithDefault(query)
    return this.extractTrackArray(fallbackResult)
  }

  /**
   * Searches the Last.fm REST API.
   *
   * @param query Search query.
   * @param searchType Requested search type.
   * @returns Search results or a structured exception.
   */
  private async searchApi(
    query: string,
    searchType: LastFmSearchType
  ): Promise<SourceResult> {
    const typeMap: Record<
      LastFmSearchType,
      { method: string; param: 'track' | 'album' | 'artist' }
    > = {
      track: { method: 'track.search', param: 'track' },
      album: { method: 'album.search', param: 'album' },
      artist: { method: 'artist.search', param: 'artist' }
    }
    const selected = typeMap[searchType]

    const url =
      `https://ws.audioscrobbler.com/2.0/?method=${selected.method}` +
      `&${selected.param}=${encodeURIComponent(query)}` +
      `&limit=${this.maxSearchResults}&api_key=${this.apiKey}&format=json`

    const { body, statusCode, error } = await http1makeRequest(url, {
      method: 'GET'
    })

    const payload = this.parseJsonBody(body)
    if (error || statusCode !== 200 || !payload) {
      return {
        exception: {
          message: `Last.fm API error: ${error ?? statusCode}`,
          severity: 'fault'
        }
      }
    }

    if (this.getValue(payload, 'error') !== undefined) {
      const message = this.getString(payload, 'message') ?? 'Last.fm API error'
      return {
        exception: {
          message,
          severity: 'fault'
        }
      }
    }

    const results = this.mapApiResults(payload, searchType)
    return results.length > 0
      ? { loadType: 'search', data: results }
      : { loadType: 'empty', data: {} }
  }

  /**
   * Maps a Last.fm API response into encoded track or collection entries.
   *
   * @param body Parsed Last.fm API response.
   * @param searchType Requested search type.
   * @returns Encoded track-like results.
   */
  private mapApiResults(
    body: JsonRecord,
    searchType: LastFmSearchType
  ): LastFmTrackData[] {
    const results = this.getRecord(body, 'results')

    if (searchType === 'album') {
      const albumMatches = results
        ? this.getRecord(results, 'albummatches')
        : null
      const albums = albumMatches ? this.getArray(albumMatches, 'album') : []

      return albums
        .map((item) => this.getRecordFromValue(item))
        .filter((item): item is JsonRecord => item !== null)
        .filter(
          (item) =>
            typeof this.getValue(item, 'name') === 'string' &&
            typeof this.getValue(item, 'artist') === 'string'
        )
        .map((item) =>
          this.buildCollectionResult(
            this.getString(item, 'name') ?? 'Unknown',
            this.getString(item, 'artist') ?? 'Unknown',
            this.getString(item, 'url') ?? '',
            'album'
          )
        )
    }

    if (searchType === 'artist') {
      const artistMatches = results
        ? this.getRecord(results, 'artistmatches')
        : null
      const artists = artistMatches
        ? this.getArray(artistMatches, 'artist')
        : []

      return artists
        .map((item) => this.getRecordFromValue(item))
        .filter((item): item is JsonRecord => item !== null)
        .filter((item) => typeof this.getValue(item, 'name') === 'string')
        .map((item) =>
          this.buildCollectionResult(
            this.getString(item, 'name') ?? 'Unknown',
            'Last.fm',
            this.getString(item, 'url') ?? '',
            'artist'
          )
        )
    }

    const trackMatches = results
      ? this.getRecord(results, 'trackmatches')
      : null
    const tracks = trackMatches ? this.getArray(trackMatches, 'track') : []

    return tracks
      .map((item) => this.getRecordFromValue(item))
      .filter((item): item is JsonRecord => item !== null)
      .filter(
        (item) =>
          typeof this.getValue(item, 'name') === 'string' &&
          typeof this.getValue(item, 'artist') === 'string'
      )
      .map((item) =>
        this.buildTrackResult(
          this.getString(item, 'name') ?? 'Unknown',
          this.getString(item, 'artist') ?? 'Unknown',
          this.getString(item, 'url') ?? ''
        )
      )
  }

  /**
   * Searches the public Last.fm HTML track-search page when no API key is available.
   *
   * @param query Search query.
   * @returns Search results or a structured exception.
   */
  private async searchTracksHtml(query: string): Promise<SourceResult> {
    const url = `https://www.last.fm/search/tracks?q=${encodeURIComponent(query)}`
    const { body, statusCode, error } = await http1makeRequest(url, {
      method: 'GET'
    })

    const html = this.getTextBody({ body })
    if (error || statusCode !== 200 || !html) {
      return {
        exception: {
          message: `Failed to fetch Last.fm search page: ${error ?? statusCode}`,
          severity: 'fault'
        }
      }
    }

    const results = this.parseTrackSearchHtml(html)
    return results.length > 0
      ? { loadType: 'search', data: results.slice(0, this.maxSearchResults) }
      : { loadType: 'empty', data: {} }
  }

  /**
   * Parses the Last.fm HTML track-search page into encoded track entries.
   *
   * @param html Raw search-result HTML.
   * @returns Encoded track results.
   */
  private parseTrackSearchHtml(html: string): LastFmTrackData[] {
    const results: LastFmTrackData[] = []
    const regex =
      /data-youtube-url="([^"]+)"[\s\S]*?data-track-name="([^"]+)"[\s\S]*?data-track-url="([^"]+)"[\s\S]*?data-artist-name="([^"]+)"/g

    let match: RegExpExecArray | null
    match = regex.exec(html)
    while (match !== null) {
      const youtubeUrl = decodeHtml(match[1] ?? null) ?? ''
      const title = decodeHtml(match[2] ?? null) ?? 'Unknown'
      const trackUrl = decodeHtml(match[3] ?? null) ?? ''
      const artist = decodeHtml(match[4] ?? null) ?? 'Unknown'
      const fullUrl = trackUrl.startsWith('http')
        ? trackUrl
        : `https://www.last.fm${trackUrl}`

      results.push(
        this.buildTrackResult(title, artist, fullUrl, {
          youtubeUrl: youtubeUrl || undefined
        })
      )

      match = regex.exec(html)
    }

    return results
  }

  /**
   * Builds an encoded Last.fm track result.
   *
   * @param title Human-readable track title.
   * @param artist Human-readable artist name.
   * @param url Canonical Last.fm URL.
   * @param pluginInfo Optional track metadata.
   * @returns Encoded track payload.
   */
  private buildTrackResult(
    title: string,
    artist: string,
    url: string,
    pluginInfo: LastFmTrackPluginInfo | Record<string, never> = {}
  ): LastFmTrackData {
    const info: LastFmTrackInfo = {
      identifier: url || `${artist} - ${title}`,
      isSeekable: true,
      author: artist,
      length: 0,
      isStream: false,
      position: 0,
      title,
      uri: url,
      artworkUrl: null,
      isrc: null,
      sourceName: 'lastfm',
      details: []
    }

    return { encoded: encodeTrack(info), info, pluginInfo }
  }

  /**
   * Builds an encoded metadata-only collection result used for album and artist
   * search matches.
   *
   * @param title Human-readable collection title.
   * @param author Human-readable author label.
   * @param url Canonical Last.fm URL.
   * @param type Collection type stored in plugin metadata.
   * @returns Encoded track payload.
   */
  private buildCollectionResult(
    title: string,
    author: string,
    url: string,
    type: 'album' | 'artist'
  ): LastFmTrackData {
    const info: LastFmTrackInfo = {
      identifier: url || title,
      isSeekable: false,
      author,
      length: 0,
      isStream: false,
      position: 0,
      title,
      uri: url,
      artworkUrl: null,
      isrc: null,
      sourceName: 'lastfm',
      details: []
    }

    return { encoded: encodeTrack(info), info, pluginInfo: { type } }
  }

  /**
   * Rewraps a delegated track as a Last.fm track, preserving useful plugin
   * metadata and re-encoding the updated payload so `encoded` matches `info`.
   *
   * @param track Delegated track payload returned by another source.
   * @param url Canonical Last.fm URL that should become the public URI.
   * @param youtubeUrl Optional YouTube URL used for direct follow-up playback.
   * @returns A re-encoded Last.fm track payload.
   */
  private rewrapDelegatedTrack(
    track: TrackDataLike,
    url: string,
    youtubeUrl?: string
  ): LastFmTrackData {
    const pluginInfo = this.getPluginInfoRecord(track.pluginInfo)
    const storedYoutubeUrl = pluginInfo.youtubeUrl
    const lastFmPluginInfo: LastFmTrackPluginInfo = {
      youtubeUrl:
        youtubeUrl ||
        (typeof storedYoutubeUrl === 'string'
          ? storedYoutubeUrl
          : track.info.uri)
    }

    const info: LastFmTrackInfo = {
      identifier: track.info.identifier,
      isSeekable: track.info.isSeekable,
      author: track.info.author,
      length: track.info.length,
      isStream: track.info.isStream,
      position: track.info.position,
      title: track.info.title,
      uri: url,
      artworkUrl: track.info.artworkUrl ?? null,
      isrc: track.info.isrc ?? null,
      sourceName: 'lastfm',
      details: []
    }

    return {
      encoded: encodeTrack(info),
      info,
      pluginInfo: lastFmPluginInfo
    }
  }

  /**
   * Extracts a delegated track from a source-manager result, supporting direct
   * track responses and the first track inside playlists.
   *
   * @param result Delegated source result.
   * @returns A usable delegated track or `null`.
   */
  private extractTrackDataLike(result: SourceResult): TrackDataLike | null {
    const trackData = result.data as JsonValue | TrackDataLike | undefined
    if (result.loadType === 'track' && this.isTrackDataLike(trackData)) {
      return trackData
    }

    const playlistData = result.data as
      | JsonValue
      | { tracks: TrackDataLike[] }
      | undefined
    if (
      result.loadType === 'playlist' &&
      this.isTrackCollection(playlistData) &&
      playlistData.tracks.length > 0
    ) {
      return playlistData.tracks[0] ?? null
    }

    return null
  }

  /**
   * Extracts an array of delegated tracks from a source-manager search result.
   *
   * @param result Source-manager search result.
   * @returns Delegated track array suitable for best-match selection.
   */
  private extractTrackArray(result: SourceResult): TrackDataLike[] {
    const resultData = result.data as JsonValue | TrackDataLike[] | undefined

    if (
      result.loadType === 'search' &&
      Array.isArray(resultData) &&
      resultData.every((item) => this.isTrackDataLike(item))
    ) {
      return resultData
    }

    return []
  }

  /**
   * Maps a scored best-match candidate back to the original delegated track
   * payload returned by the search pipeline.
   *
   * @param tracks Candidate delegated tracks.
   * @param candidate Best-match candidate selected by the scoring helper.
   * @returns The original delegated track payload or `null` when no exact match exists.
   */
  private findTrackDataByCandidate(
    tracks: TrackDataLike[],
    candidate: BestMatchCandidate
  ): TrackDataLike | null {
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
   * Returns the source manager narrowed to the methods used by this source.
   *
   * @returns The narrowed source manager or `null` when unavailable.
   */
  private getSourceManager(): LastFmSourceManager | null {
    const sourceManager = this.nodelink.sources as
      | LastFmSourceManager
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
   * Converts an arbitrary plugin metadata value into a string-compatible record.
   *
   * @param value Plugin metadata value returned by a delegated source.
   * @returns A string-compatible record with invalid entries removed.
   */
  private getPluginInfoRecord(
    value?: Record<string, JsonValue>
  ): LastFmTrackPluginInfo & Record<string, string> {
    if (!value) {
      return {}
    }

    const result: LastFmTrackPluginInfo & Record<string, string> = {}

    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'string') {
        result[key] = entry
      } else if (typeof entry === 'number') {
        result[key] = String(entry)
      }
    }

    return result
  }

  /**
   * Checks whether an arbitrary value is a valid delegated track payload.
   *
   * @param value Candidate value returned by delegated source calls.
   * @returns `true` when the value is a usable delegated track payload.
   */
  private isTrackDataLike(
    value: JsonValue | TrackDataLike | undefined
  ): value is TrackDataLike {
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
  private isTrackCollection(
    value: JsonValue | { tracks: TrackDataLike[] } | undefined
  ): value is { tracks: TrackDataLike[] } {
    const record = this.getRecordFromValue(value as JsonValue)
    if (!record) {
      return false
    }

    const tracks = this.getValue(record, 'tracks')
    return (
      Array.isArray(tracks) &&
      tracks.every((track) => this.isTrackDataLike(track as JsonValue))
    )
  }
}
