import type {
  SourceManager,
  SourceResult,
  TrackInfo as SourceTrackInfo,
  TrackData,
  TrackStreamResult,
  TrackUrlResult,
  WorkerNodeLink
} from '../typings/sources/source.types.ts'
import type {
  BestMatchCandidate,
  BestMatchTrackInfo
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
 * This resolves the 406 when fetching Last.fm tracks and playing them.

*/

interface LastFMConfig {
  apiKey?: string
}

/**
 * This function decodes common HTML entities in a string, such as &amp; for '&' and &quot; for '"'.
 */
function decodeHtml(text: string | null | undefined): string {
  if (!text) return text as string
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

/**
 * This function decodes URL-encoded strings and replaces '+' with spaces, which is common in query parameters. It also trims whitespace from the result.
 */
function sanitizeQuery(raw: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(raw.replace(/\+/g, ' '))
  } catch {
    decoded = raw.replace(/\+/g, ' ')
  }
  return decoded.trim()
}

/**
 * This heuristic determines if a Last.fm URL path corresponds to a track page or an album/artist page.
 * It checks the third segment of the path:
 * - If it starts with '+', it's an album page (e.g. /music/Artist/+Album).
 * - If it does not start with '+', it's a track page (e.g. /music/Artist/Track+Title).
 * If there are fewer than 3 segments, it defaults to treating it as an album/artist page.
 */
function segmentsAreTrack(segments: string[]): boolean {
  if (segments.length < 3) return false
  const thirdSegment = segments[2] ?? ''
  // If the third segment starts with '+', it's an album page, so return false. Otherwise, it's a track page, so return true.
  // This is a heuristic based on Last.fm's URL structure, where album pages have a '+' prefix in the third segment, while track pages do not.
  return !thirdSegment.startsWith('+')
}

export default class LastFMSource {
  nodelink: WorkerNodeLink
  config: LastFMConfig
  patterns: RegExp[]
  priority: number
  searchTerms: string[]
  maxSearchResults: number
  apiKey: string | null

  constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
    this.config = this.getConfig()
    this.patterns = [LASTFM_PATTERN]
    this.priority = 40
    this.searchTerms = ['lfsearch']
    this.maxSearchResults = this.getMaxSearchResults()
    this.apiKey = this.config.apiKey ?? null
  }

  getConfig(): LastFMConfig {
    const options = this.nodelink.options
    const config = options.sources?.lastfm as
      | { enabled?: boolean; apiKey?: string }
      | undefined
    return {
      apiKey:
        typeof config?.apiKey === 'string' && config.apiKey.length > 0
          ? config.apiKey
          : undefined
    }
  }

  getMaxSearchResults(): number {
    const options = this.nodelink.options
    const limit = options.search.maxResults
    return typeof limit === 'number' && Number.isInteger(limit) && limit > 0
      ? limit
      : 10
  }

  async setup(): Promise<boolean> {
    logger('info', 'Sources', 'Loaded Last.fm source.')
    return true
  }

  isLinkMatch(link: string): boolean {
    return LASTFM_PATTERN.test(link)
  }

  async search(
    query: string,
    _sourceTerm: string,
    searchType: string = 'track'
  ): Promise<SourceResult> {
    try {
      if (!this.apiKey) {
        if (searchType !== 'track') {
          return {
            loadType: 'error',
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
        loadType: 'error',
        exception: {
          message: error instanceof Error ? error.message : String(error),
          severity: 'fault'
        }
      }
    }
  }

  async resolve(url: string): Promise<SourceResult> {
    if (!LASTFM_PATTERN.test(url)) {
      return { loadType: 'empty', data: {} }
    }

    const path = this.parsePath(url)
    if (!path) {
      return { loadType: 'empty', data: {} }
    }

    try {
      // Determine if this is a track page or an album/artist page based on the URL segments and the presence of a '+' prefix in the third segment.
      const isTrack = segmentsAreTrack(path)

      // The artist segment is always the second segment in the path, e.g. /music/Artist/Track or /music/Artist/+Album. We decode it for use in search queries.
      const artist = sanitizeQuery(path[1] ?? 'Unknown')

      if (isTrack) {
        // For track pages, we attempt to resolve the track by searching YouTube with various query formulations based on the track title and artist.
        const rawTitle = path[2] ?? ''
        const fullTitle = sanitizeQuery(rawTitle)

        // We strip unknown "(feat. ...)" suffix from the title to create a "core title" for more effective searching, since YouTube often omits featured artists from the title.
        const coreTitle = fullTitle.replace(/\s*\(feat\..*?\)/i, '').trim()

        logger(
          'info',
          'LastFM',
          `Resolving track: "${fullTitle}" by "${artist}"`
        )

        // 1st attempt: core title + "official audio"
        if (coreTitle && coreTitle !== fullTitle) {
          const r1 = await this.searchPreferredTracks(
            `${artist} ${coreTitle} official audio`
          )
          if (r1[0]) {
            const t = this.rewrapDelegatedTrack(r1[0], url)
            logger(
              'info',
              'LastFM',
              `Resolved via core+official: ${t.info?.title}`
            )
            return { loadType: 'track', data: t }
          }
        }

        // 2nd attempt: full title + "official audio"
        const r2 = await this.searchPreferredTracks(
          `${artist} ${fullTitle} official audio`
        )
        if (r2[0]) {
          const t = this.rewrapDelegatedTrack(r2[0], url)
          logger(
            'info',
            'LastFM',
            `Resolved via full+official: ${t.info?.title}`
          )
          return { loadType: 'track', data: t }
        }

        // 3rd attempt: core title only
        if (coreTitle && coreTitle !== fullTitle) {
          const r3 = await this.searchPreferredTracks(`${artist} ${coreTitle}`)
          if (r3[0]) {
            const t = this.rewrapDelegatedTrack(r3[0], url)
            logger(
              'info',
              'LastFM',
              `Resolved via core title: ${t.info?.title}`
            )
            return { loadType: 'track', data: t }
          }
        }

        // 4th attempt: full title only (last resort)
        const r4 = await this.searchPreferredTracks(`${artist} ${fullTitle}`)
        if (r4[0]) {
          const t = this.rewrapDelegatedTrack(r4[0], url)
          logger(
            'info',
            'LastFM',
            `Resolved via full title fallback: ${t.info?.title}`
          )
          return { loadType: 'track', data: t }
        }

        logger(
          'error',
          'LastFM',
          `No tracks found for: "${fullTitle}" by "${artist}"`
        )
        return {
          loadType: 'error',
          exception: {
            message: 'No matching tracks found for this Last.fm track',
            severity: 'fault'
          }
        }
      }

      // For album/artist pages, we attempt to extract unknown linked YouTube URLs from the page HTML and resolve them as tracks. We treat the entire page as a "playlist" of these tracks.
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
          loadType: 'error',
          exception: {
            message: `Failed to fetch Last.fm page: ${error ?? statusCode}`,
            severity: 'fault'
          }
        }
      }

      // We use the artist name as the collection title for artist pages, and for album pages we use "Album Title - Artist". We also decode unknown URL-encoded characters and replace '+' with spaces for readability.
      let collectionTitle = artist
      if (path.length >= 3) {
        // Strip unknown leading '+' from the third segment (which indicates an album page) and decode it to get the album title, then combine it with the artist name for the collection title.
        collectionTitle = sanitizeQuery((path[2] ?? '').replace(/^\+/, ''))
      }

      const youtubeUrls = this.extractYouTubeUrls(html)
      const tracks: TrackData[] = []

      for (const youtubeUrl of youtubeUrls) {
        const youtubeResult = await this.getSourceManager()?.resolve(youtubeUrl)
        if (!youtubeResult) continue
        const delegatedTrack = this.extractTrackData(youtubeResult)
        if (!delegatedTrack) continue
        tracks.push(this.rewrapDelegatedTrack(delegatedTrack, url, youtubeUrl))
      }

      if (tracks.length > 0) {
        logger(
          'info',
          'LastFM',
          `Resolved playlist: "${collectionTitle}" - "${artist}" with ${tracks.length} tracks`
        )
        return {
          loadType: 'playlist',
          data: {
            info: { name: `${collectionTitle} - ${artist}`, selectedTrack: 0 },
            pluginInfo: {} as Record<string, unknown>,
            tracks
          }
        }
      }

      logger(
        'error',
        'LastFM',
        'Failed to resolve unknown tracks from Last.fm album/artist'
      )
      return {
        loadType: 'error',
        exception: {
          message: 'Failed to resolve tracks from Last.fm',
          severity: 'fault'
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger('error', 'LastFM', `Exception during resolve: ${message}`)
      return { loadType: 'error', exception: { message, severity: 'fault' } }
    }
  }

  async getTrackUrl(
    decodedTrack: SourceTrackInfo,
    trackData?: TrackData
  ): Promise<
    | (TrackUrlResult & { newTrack?: TrackData })
    | { exception: { message: string; severity: string } }
  > {
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
      const youtubeUrl = (
        trackData?.pluginInfo as Record<string, string | undefined>
      )?.youtubeUrl as string | undefined
      if (youtubeUrl) {
        const youtubeResult = await sourceManager.resolve(youtubeUrl)
        const delegatedTrack = this.extractTrackData(youtubeResult)
        if (delegatedTrack?.info) {
          const streamInfo = await sourceManager.getTrackUrl(
            delegatedTrack.info
          )
          return {
            ...streamInfo,
            newTrack: delegatedTrack
          } as unknown as TrackUrlResult & { newTrack?: TrackData }
        }
      }

      const query = `${decodedTrack.title} ${decodedTrack.author}`.trim()
      const searchResult = await sourceManager.searchWithDefault(query)
      const searchTracks = this.extractTrackArray(searchResult)

      if (searchTracks.length === 0) {
        return {
          exception: {
            message: 'No matching track found on default source.',
            severity: 'common'
          }
        }
      }

      const bestMatchCandidate = getBestMatch(
        searchTracks.map((t) => ({
          info: {
            title: t.info?.title || '',
            author: t.info?.author || '',
            length: t.info?.length || 0,
            uri: t.info?.uri
          }
        })),
        decodedTrack as BestMatchTrackInfo
      )
      const bestMatch = bestMatchCandidate
        ? searchTracks[
            searchTracks.findIndex(
              (t) =>
                t.info?.title === bestMatchCandidate.info.title &&
                t.info?.author === bestMatchCandidate.info.author
            )
          ]
        : null

      if (!bestMatch?.info) {
        return {
          exception: {
            message: 'No suitable alternative found after filtering.',
            severity: 'common'
          }
        }
      }

      const streamInfo = await sourceManager.getTrackUrl(bestMatch.info)
      return {
        ...streamInfo,
        newTrack: bestMatch
      } as unknown as TrackUrlResult & { newTrack?: TrackData }
    } catch (error) {
      return {
        exception: {
          message: error instanceof Error ? error.message : String(error),
          severity: 'fault'
        }
      }
    }
  }

  async loadStream(
    track: SourceTrackInfo,
    url: string,
    protocol?: string,
    additionalData?: unknown
  ): Promise<TrackStreamResult | { exception: { message: string } }> {
    const sourceManager = this.getSourceManager()
    if (!sourceManager) {
      throw new Error('Source manager is not available for Last.fm streaming')
    }
    return sourceManager.getTrackStream(
      track,
      url,
      protocol,
      additionalData as Record<string, unknown>
    )
  }

  /**
   * Parses a Last.fm URL into path segments with the 'music' prefix retained
   * and unknown locale prefix stripped, so callers always receive segments starting
   * at ['music', artist, ...].
   *
   * Examples:
   *   /music/Kodak+Black/ZEZE+...  → ['music', 'Kodak+Black', 'ZEZE+...']
   *   /fr/music/Artist/+Album      → ['music', 'Artist', '+Album']
   */
  parsePath(url: string): string[] | null {
    try {
      const urlObject = new URL(url)
      const path = urlObject.pathname.split('/').filter(Boolean)

      // Strip a leading 2-char locale prefix, e.g. /fr/music/...
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

  extractYouTubeUrls(html: string): string[] {
    const urls = new Set<string>()
    const playMatch = html.match(YOUTUBE_LINK_PATTERN)
    if (playMatch?.[1]) urls.add(playMatch[1])

    const regex = new RegExp(YOUTUBE_URL_PATTERN, 'g')
    let match: RegExpExecArray | null
    match = regex.exec(html)
    while (match !== null) {
      if (match[0]) urls.add(match[0])
      match = regex.exec(html)
    }
    return Array.from(urls)
  }

  async searchPreferredTracks(query: string): Promise<TrackData[]> {
    const sourceManager = this.getSourceManager()
    if (!sourceManager) return []

    const fallbackResult = await sourceManager.searchWithDefault(query)
    return this.extractTrackArray(fallbackResult)
  }

  async searchApi(query: string, searchType: string): Promise<SourceResult> {
    const typeMap: Record<string, { method: string; param: string }> = {
      track: { method: 'track.search', param: 'track' },
      album: { method: 'album.search', param: 'album' },
      artist: { method: 'artist.search', param: 'artist' }
    }
    const selected = typeMap[searchType]
    if (!selected) {
      return {
        loadType: 'error',
        exception: {
          message: `Unsupported Last.fm search type: ${searchType}`,
          severity: 'common'
        }
      }
    }

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
        loadType: 'error',
        exception: {
          message: `Last.fm API error: ${error ?? statusCode}`,
          severity: 'fault'
        }
      }
    }

    if (this.getValue(payload, 'error') !== undefined) {
      const message = this.getString(payload, 'message') ?? 'Last.fm API error'
      return { loadType: 'error', exception: { message, severity: 'fault' } }
    }

    const results = this.mapApiResults(payload, searchType)
    return results.length > 0
      ? { loadType: 'search', data: results }
      : { loadType: 'empty', data: {} }
  }

  mapApiResults(
    body: Record<string, unknown>,
    searchType: string
  ): TrackData[] {
    const results = this.getRecord(body, 'results')

    if (searchType === 'album') {
      const albumMatches = results
        ? this.getRecord(results, 'albummatches')
        : null
      const albums = albumMatches ? this.getArray(albumMatches, 'album') : []
      return albums
        .map((item) => this.getRecordFromValue(item))
        .filter((item): item is Record<string, unknown> => item !== null)
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
        .filter((item): item is Record<string, unknown> => item !== null)
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
      .filter((item): item is Record<string, unknown> => item !== null)
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

  async searchTracksHtml(query: string): Promise<SourceResult> {
    const url = `https://www.last.fm/search/tracks?q=${encodeURIComponent(query)}`
    const { body, statusCode, error } = await http1makeRequest(url, {
      method: 'GET'
    })
    const html = this.getTextBody({ body })

    if (error || statusCode !== 200 || !html) {
      return {
        loadType: 'error',
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

  parseTrackSearchHtml(html: string): TrackData[] {
    const results: TrackData[] = []
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
          ...(youtubeUrl ? { youtubeUrl } : {})
        })
      )
      match = regex.exec(html)
    }
    return results
  }

  buildTrackResult(
    title: string,
    artist: string,
    url: string,
    pluginInfo: Record<string, string | number | boolean> = {}
  ): TrackData {
    const info: TrackData['info'] = {
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
      sourceName: 'lastfm'
    }
    return { encoded: encodeTrack({ ...info, details: [] }), info, pluginInfo }
  }

  buildCollectionResult(
    title: string,
    author: string,
    url: string,
    type: string | number | boolean
  ): TrackData {
    const info: TrackData['info'] = {
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
      sourceName: 'lastfm'
    }
    return {
      encoded: encodeTrack({ ...info, details: [] }),
      info,
      pluginInfo: { type: String(type) }
    }
  }

  rewrapDelegatedTrack(
    track: TrackData,
    url: string,
    youtubeUrl?: string
  ): TrackData {
    if (!track.info) {
      throw new Error('Cannot rewrap track without info')
    }
    const pluginInfo = this.getPluginInfoRecord(track.pluginInfo)
    const storedYoutubeUrl = pluginInfo.youtubeUrl
    const lastFmPluginInfo: Record<string, string | number | boolean> = {
      youtubeUrl:
        youtubeUrl ||
        (typeof storedYoutubeUrl === 'string'
          ? storedYoutubeUrl
          : track.info.uri) ||
        ''
    }
    const info: TrackData['info'] = {
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
      sourceName: 'lastfm'
    }
    return {
      encoded: encodeTrack({ ...info, details: [] }),
      info,
      pluginInfo: lastFmPluginInfo
    }
  }

  extractTrackData(result: SourceResult): TrackData | null {
    if (result.loadType === 'track') {
      const trackData = result.data
      if (this.isTrackData(trackData)) {
        return trackData
      }
    }
    if (result.loadType === 'playlist') {
      const playlistData = result.data
      if (
        this.isTrackCollection(playlistData) &&
        playlistData.tracks.length > 0
      ) {
        return playlistData.tracks[0] ?? null
      }
    }
    return null
  }

  extractTrackArray(result: SourceResult): TrackData[] {
    if (result.loadType === 'search') {
      const resultData = result.data
      if (
        Array.isArray(resultData) &&
        resultData.every((item) => this.isTrackData(item))
      ) {
        return resultData
      }
    }
    return []
  }

  findTrackDataByCandidate(
    tracks: TrackData[],
    candidate: BestMatchCandidate
  ): TrackData | null {
    return (
      tracks.find(
        (track) =>
          track.info &&
          track.info.title === candidate.info.title &&
          track.info.author === candidate.info.author &&
          track.info.uri === candidate.info.uri
      ) ?? null
    )
  }

  getSourceManager(): SourceManager | null {
    return (this.nodelink as WorkerNodeLink).sources ?? null
  }

  getTextBody(response: { body: unknown }): string | null {
    if (typeof response.body === 'string') return response.body
    if (Buffer.isBuffer(response.body)) return response.body.toString('utf8')
    return null
  }

  parseJsonBody(body: unknown): Record<string, unknown> | null {
    if (
      body &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      !Buffer.isBuffer(body as Buffer)
    ) {
      return body as Record<string, unknown>
    }
    const textBody = this.getTextBody({ body })
    if (!textBody) return null
    try {
      const parsed = JSON.parse(textBody)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }

  getRecord(
    record: Record<string, unknown>,
    key: string
  ): Record<string, unknown> | null {
    return this.getRecordFromValue(record[key])
  }

  getRecordFromValue(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  }

  getValue(record: Record<string, unknown>, key: string): unknown {
    return record[key]
  }

  getArray(record: Record<string, unknown>, key: string): unknown[] {
    const value = this.getValue(record, key)
    return Array.isArray(value) ? value : []
  }

  getString(record: Record<string, unknown>, key: string): string | null {
    const value = this.getValue(record, key)
    if (typeof value === 'string') return value
    if (typeof value === 'number') return String(value)
    return null
  }

  getPluginInfoRecord(value: unknown): Record<string, string> {
    if (!value) return {}
    const result: Record<string, string> = {}
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>
    )) {
      if (typeof entry === 'string') result[key] = entry
      else if (typeof entry === 'number') result[key] = String(entry)
    }
    return result
  }

  isTrackData(value: unknown): value is TrackData {
    const record = this.getRecordFromValue(value)
    if (!record) return false
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

  isTrackCollection(value: unknown): value is { tracks: TrackData[] } {
    const record = this.getRecordFromValue(value)
    if (!record) return false
    const tracks = this.getValue(record, 'tracks')
    return (
      Array.isArray(tracks) && tracks.every((track) => this.isTrackData(track))
    )
  }
}
