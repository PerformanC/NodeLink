import type {
  NeteaseAlbumResponse,
  NeteaseArtist,
  NeteaseArtistResponse,
  NeteaseDecodedTrack,
  NeteaseLoadStreamResult,
  NeteaseNodeLinkContext,
  NeteasePlaylistResponse,
  NeteaseSearchResponse,
  NeteaseSearchType,
  NeteaseSong,
  NeteaseSongDetailResponse,
  NeteaseSourceOptions,
  NeteaseSourceResult,
  NeteaseTrackData,
  NeteaseTrackUrlResult
} from '../typings/sources/netease.types.ts'
import type { TrackInfo } from '../typings/sources/source.types.ts'
import type {
  BestMatchCandidate,
  TrackEncodeInput
} from '../typings/utils.types.ts'
import {
  encodeTrack,
  getBestMatch,
  http1makeRequest,
  logger
} from '../utils.ts'

const NETEASE_TRACK_PATTERN =
  /^https?:\/\/(?:www\.)?music\.163\.com\/?#?\/song\?id=(\d+)/
const NETEASE_ALBUM_PATTERN =
  /^https?:\/\/(?:www\.)?music\.163\.com\/?#?\/album\?id=(\d+)/
const NETEASE_PLAYLIST_PATTERN =
  /^https?:\/\/(?:www\.)?music\.163\.com\/?#?\/playlist\?id=(\d+)/
const NETEASE_ARTIST_PATTERN =
  /^https?:\/\/(?:www\.)?music\.163\.com\/?#?\/artist\?id=(\d+)/

const STREAM_URL = 'https://music.163.com/song/media/outer/url?id='

const ANDROID_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  Referer: 'http://music.163.com',
  'Content-Type': 'application/x-www-form-urlencoded',
  Cookie: 'appver=2.0.2; os=pc;'
}

const GET_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Referer: 'http://music.163.com',
  Accept: 'application/json, text/plain, */*',
  'Accept-Encoding': 'identity'
}

/**
 * Netease Cloud Music source implementation.
 * @public
 */
export default class NeteaseSource {
  /**
   * Runtime NodeLink context.
   */
  public readonly nodelink: NeteaseNodeLinkContext

  /**
   * Source configuration.
   */
  public readonly config: NeteaseSourceOptions

  /**
   * URL patterns accepted by this source.
   */
  public readonly patterns: RegExp[]

  /**
   * URL resolution priority.
   */
  public readonly priority: number

  /**
   * Search aliases handled by this source.
   */
  public readonly searchTerms: string[]

  /**
   * Max search results used by Netease API.
   */
  public readonly maxSearchResults: number

  /**
   * Creates a new Netease source.
   * @param nodelink - Runtime NodeLink context.
   */
  public constructor(nodelink: NeteaseNodeLinkContext) {
    this.nodelink = nodelink
    this.config = nodelink.options.sources?.netease || {}
    this.patterns = [
      NETEASE_TRACK_PATTERN,
      NETEASE_ALBUM_PATTERN,
      NETEASE_PLAYLIST_PATTERN,
      NETEASE_ARTIST_PATTERN
    ]
    this.priority = 45
    this.searchTerms = ['ntsearch']
    this.maxSearchResults = nodelink.options.search.maxResults || 10
  }

  /**
   * Initializes Netease source.
   * @returns Always true.
   */
  public async setup(): Promise<boolean> {
    logger('info', 'Sources', 'Loaded Netease Cloud Music source.')
    return true
  }

  /**
   * Returns whether a URL matches supported Netease patterns.
   * @param link - URL candidate.
   * @returns True when URL belongs to Netease.
   */
  public isLinkMatch(link: string): boolean {
    return (
      NETEASE_TRACK_PATTERN.test(link) ||
      NETEASE_ALBUM_PATTERN.test(link) ||
      NETEASE_PLAYLIST_PATTERN.test(link) ||
      NETEASE_ARTIST_PATTERN.test(link)
    )
  }

  /**
   * Searches tracks/albums/artists/playlists on Netease.
   * @param query - Search query.
   * @param _sourceTerm - Search alias from manager.
   * @param searchType - Search category.
   * @returns Search result payload.
   */
  public async search(
    query: string,
    _sourceTerm?: string,
    searchType: NeteaseSearchType = 'track'
  ): Promise<NeteaseSourceResult> {
    try {
      const typeMap: Record<NeteaseSearchType, number> = {
        track: 1,
        album: 10,
        artist: 100,
        playlist: 1000
      }
      const type = typeMap[searchType]

      const postBody = `s=${encodeURIComponent(query)}&limit=${this.maxSearchResults}&type=${type}&offset=0`

      const { body, statusCode, error } = await http1makeRequest(
        'https://music.163.com/api/search/get/',
        {
          method: 'POST',
          body: postBody,
          disableBodyCompression: true,
          headers: {
            ...ANDROID_HEADERS,
            'Content-Length': String(Buffer.byteLength(postBody))
          }
        }
      )

      const parsedBody = this.parseBody<NeteaseSearchResponse>(body)
      if (error || statusCode !== 200 || !parsedBody) {
        return this.exceptionResult(
          `Netease search failed: ${statusCode || 'unknown'}`
        )
      }

      let results = this._mapSearchResults(parsedBody, searchType)

      if (searchType === 'track' && results.length > 0) {
        const ids = results.map((item) => item.info.identifier).filter(Boolean)
        const detailMap = await this._batchFetchDetails(ids)

        results = results.map((item) => {
          const detail = detailMap[item.info.identifier]
          const artworkUrl =
            this.toSong(detail)?.album?.picUrl || item.info.artworkUrl || null
          if (artworkUrl !== item.info.artworkUrl) {
            item.info.artworkUrl = artworkUrl
            const encodedInput: TrackEncodeInput = { ...item.info, details: [] }
            item.encoded = encodeTrack(encodedInput)
          }
          return item
        })
      }

      return results.length > 0
        ? { loadType: 'search', data: results }
        : this.emptyResult()
    } catch (error) {
      return this.exceptionResult(this.getErrorMessage(error))
    }
  }

  /**
   * Fetches detail metadata for a list of track IDs.
   * @param ids - Netease track identifiers.
   * @returns Map keyed by song ID.
   */
  private async _batchFetchDetails(
    ids: string[]
  ): Promise<Record<string, unknown>> {
    if (!ids.length) return {}

    try {
      const idsParam = `[${ids.join(',')}]`
      const { body, statusCode, error } = await http1makeRequest(
        `https://music.163.com/api/song/detail/?id=${ids[0]}&ids=${idsParam}`,
        { method: 'GET', headers: GET_HEADERS }
      )

      if (error || statusCode !== 200 || !body) return {}

      const parsed = this.parseBody<NeteaseSongDetailResponse>(body)
      if (!parsed || !Array.isArray(parsed.songs)) return {}

      return Object.fromEntries(
        parsed.songs
          .map((song) => this.toSong(song))
          .filter(
            (song): song is NeteaseSong =>
              song !== null && song.id !== undefined
          )
          .map((song) => [String(song.id), song])
      )
    } catch {
      return {}
    }
  }

  /**
   * Resolves a Netease URL.
   * @param url - Netease URL.
   * @returns Track/playlist result.
   */
  public async resolve(url: string): Promise<NeteaseSourceResult> {
    try {
      const trackMatch = url.match(NETEASE_TRACK_PATTERN)
      if (trackMatch?.[1]) return await this._resolveTrack(trackMatch[1], url)

      const albumMatch = url.match(NETEASE_ALBUM_PATTERN)
      if (albumMatch?.[1]) return await this._resolveAlbum(albumMatch[1], url)

      const playlistMatch = url.match(NETEASE_PLAYLIST_PATTERN)
      if (playlistMatch?.[1])
        return await this._resolvePlaylist(playlistMatch[1], url)

      const artistMatch = url.match(NETEASE_ARTIST_PATTERN)
      if (artistMatch?.[1])
        return await this._resolveArtist(artistMatch[1], url)

      return this.emptyResult()
    } catch (error) {
      const message = this.getErrorMessage(error)
      logger('error', 'Netease', `Exception during resolve: ${message}`)
      return this.exceptionResult(message)
    }
  }

  /**
   * Resolves a single Netease track URL.
   * @param id - Song ID.
   * @param originalUrl - Original URL.
   * @returns Track result payload.
   */
  private async _resolveTrack(
    id: string,
    originalUrl: string
  ): Promise<NeteaseSourceResult> {
    const { body, statusCode, error } = await http1makeRequest(
      `https://music.163.com/api/song/detail/?id=${id}&ids=[${id}]`,
      { method: 'GET', headers: GET_HEADERS }
    )

    const parsed = this.parseBody<NeteaseSongDetailResponse>(body)
    if (error || statusCode !== 200 || !parsed) {
      return this.exceptionResult(
        `Failed to fetch Netease track: ${error || statusCode || 'unknown'}`
      )
    }

    const songs = Array.isArray(parsed.songs) ? parsed.songs : []
    const song = this.toSong(songs[0])
    if (!song) return this.emptyResult()

    const track = this._buildTrackResult(song, originalUrl)
    logger(
      'info',
      'Netease',
      `Resolved track: ${song.name} by ${this._getArtists(song)}`
    )
    return { loadType: 'track', data: track }
  }

  /**
   * Resolves a Netease album URL.
   * @param id - Album ID.
   * @param originalUrl - Original URL.
   * @returns Playlist payload.
   */
  private async _resolveAlbum(
    id: string,
    originalUrl: string
  ): Promise<NeteaseSourceResult> {
    const { body, statusCode, error } = await http1makeRequest(
      `https://music.163.com/api/album?id=${id}`,
      { method: 'GET', headers: GET_HEADERS }
    )

    const parsed = this.parseBody<NeteaseAlbumResponse>(body)
    if (error || statusCode !== 200 || !parsed) {
      return this.exceptionResult(
        `Failed to fetch Netease album: ${error || statusCode || 'unknown'}`
      )
    }

    const songs = Array.isArray(parsed.songs) ? parsed.songs : []
    const tracks = songs
      .map((song) => this.toSong(song))
      .filter((song): song is NeteaseSong => song !== null)
      .map((song) => this._buildTrackResult(song, originalUrl))

    if (tracks.length === 0) return this.emptyResult()

    const name = parsed.album?.name || 'Unknown Album'
    const artist = parsed.album?.artist?.name || 'Unknown Artist'

    logger(
      'info',
      'Netease',
      `Resolved album: ${name} with ${tracks.length} tracks`
    )
    return {
      loadType: 'playlist',
      data: {
        info: { name: `${name} — ${artist}`, selectedTrack: 0 },
        pluginInfo: {} as Record<string, unknown> as Record<string, unknown>,
        tracks
      }
    }
  }

  /**
   * Resolves a Netease playlist URL.
   * @param id - Playlist ID.
   * @param originalUrl - Original URL.
   * @returns Playlist payload.
   */
  private async _resolvePlaylist(
    id: string,
    originalUrl: string
  ): Promise<NeteaseSourceResult> {
    const { body, statusCode, error } = await http1makeRequest(
      `https://music.163.com/api/playlist/detail?id=${id}`,
      { method: 'GET', headers: GET_HEADERS }
    )

    const parsed = this.parseBody<NeteasePlaylistResponse>(body)
    if (error || statusCode !== 200 || !parsed) {
      return this.exceptionResult(
        `Failed to fetch Netease playlist: ${error || statusCode || 'unknown'}`
      )
    }

    const playlist = parsed.result || parsed.playlist
    const songs = Array.isArray(playlist?.tracks) ? playlist.tracks : []
    const tracks = songs
      .map((song) => this.toSong(song))
      .filter((song): song is NeteaseSong => song !== null)
      .map((song) => this._buildTrackResult(song, originalUrl))

    if (tracks.length === 0) return this.emptyResult()

    const name = playlist?.name || 'Unknown Playlist'
    logger(
      'info',
      'Netease',
      `Resolved playlist: ${name} with ${tracks.length} tracks`
    )
    return {
      loadType: 'playlist',
      data: {
        info: { name, selectedTrack: 0 },
        pluginInfo: {} as Record<string, unknown> as Record<string, unknown>,
        tracks
      }
    }
  }

  /**
   * Resolves a Netease artist URL.
   * @param id - Artist ID.
   * @param originalUrl - Original URL.
   * @returns Playlist payload with top tracks.
   */
  private async _resolveArtist(
    id: string,
    originalUrl: string
  ): Promise<NeteaseSourceResult> {
    const { body, statusCode, error } = await http1makeRequest(
      `https://music.163.com/api/artist/top?id=${id}&limit=${this.maxSearchResults}&offset=0&total=false`,
      { method: 'GET', headers: GET_HEADERS }
    )

    const parsed = this.parseBody<NeteaseArtistResponse>(body)
    if (error || statusCode !== 200 || !parsed) {
      return this.exceptionResult(
        `Failed to fetch Netease artist: ${error || statusCode || 'unknown'}`
      )
    }

    const songs = Array.isArray(parsed.hotSongs) ? parsed.hotSongs : []
    const tracks = songs
      .map((song) => this.toSong(song))
      .filter((song): song is NeteaseSong => song !== null)
      .map((song) => this._buildTrackResult(song, originalUrl))

    if (tracks.length === 0) return this.emptyResult()

    const name = parsed.artist?.name || 'Unknown Artist'
    logger(
      'info',
      'Netease',
      `Resolved artist top tracks: ${name} with ${tracks.length} tracks`
    )
    return {
      loadType: 'playlist',
      data: {
        info: { name: `${name} — Top Tracks`, selectedTrack: 0 },
        pluginInfo: {} as Record<string, unknown> as Record<string, unknown>,
        tracks
      }
    }
  }

  /**
   * Maps a search response payload to track-like result list.
   * @param body - Parsed response payload.
   * @param searchType - Search category.
   * @returns Encoded search list.
   */
  private _mapSearchResults(
    body: NeteaseSearchResponse,
    searchType: NeteaseSearchType
  ): NeteaseTrackData[] {
    const result = body.result || {}

    if (searchType === 'album') {
      const albums = Array.isArray(result.albums) ? result.albums : []
      return albums.map((album) =>
        this._buildCollectionResult(
          album.name || 'Unknown Album',
          album.artist?.name || 'Unknown',
          `https://music.163.com/#/album?id=${album.id}`,
          'album'
        )
      )
    }

    if (searchType === 'artist') {
      const artists = Array.isArray(result.artists) ? result.artists : []
      return artists.map((artist) =>
        this._buildCollectionResult(
          artist.name || 'Unknown Artist',
          'Netease',
          `https://music.163.com/#/artist?id=${artist.id}`,
          'artist'
        )
      )
    }

    if (searchType === 'playlist') {
      const playlists = Array.isArray(result.playlists) ? result.playlists : []
      return playlists.map((playlist) =>
        this._buildCollectionResult(
          playlist.name || 'Unknown Playlist',
          playlist.creator?.nickname || 'Unknown',
          `https://music.163.com/#/playlist?id=${playlist.id}`,
          'playlist'
        )
      )
    }

    const songs = Array.isArray(result.songs) ? result.songs : []
    return songs
      .map((song) => this.toSong(song))
      .filter((song): song is NeteaseSong => song !== null)
      .map((song) =>
        this._buildTrackResult(song, `https://music.163.com/song?id=${song.id}`)
      )
  }

  /**
   * Converts a song payload to track result.
   * @param song - Netease song payload.
   * @param uri - Canonical URI.
   * @returns Encoded track data.
   */
  private _buildTrackResult(song: NeteaseSong, uri: string): NeteaseTrackData {
    const artist = this._getArtists(song)
    const duration = song.duration || song.dt || 0
    const artworkUrl = song.album?.picUrl || song.al?.picUrl || null

    const info: TrackInfo = {
      identifier: String(song.id || uri),
      isSeekable: true,
      author: artist,
      length: duration,
      isStream: false,
      position: 0,
      title: song.name || 'Unknown',
      uri: uri || `https://music.163.com/song?id=${song.id}`,
      artworkUrl,
      isrc: null,
      sourceName: 'netease'
    }

    const encodedInput: TrackEncodeInput = { ...info, details: [] }
    return {
      encoded: encodeTrack(encodedInput),
      info,
      pluginInfo: { neteaseId: String(song.id || '') }
    }
  }

  /**
   * Builds collection result payload for search album/artist/playlist.
   * @param title - Collection title.
   * @param author - Collection author.
   * @param url - Collection URL.
   * @param type - Collection type marker.
   * @returns Encoded pseudo-track payload.
   */
  private _buildCollectionResult(
    title: string,
    author: string,
    url: string,
    type: string
  ): NeteaseTrackData {
    const info: TrackInfo = {
      identifier: url,
      isSeekable: false,
      author,
      length: 0,
      isStream: false,
      position: 0,
      title,
      uri: url,
      artworkUrl: null,
      isrc: null,
      sourceName: 'netease'
    }

    const encodedInput: TrackEncodeInput = { ...info, details: [] }
    return { encoded: encodeTrack(encodedInput), info, pluginInfo: { type } }
  }

  /**
   * Extracts artist names from Netease song payload.
   * @param song - Song payload.
   * @returns Joined artist string.
   */
  private _getArtists(song: NeteaseSong): string {
    const list = Array.isArray(song.artists)
      ? song.artists
      : Array.isArray(song.ar)
        ? song.ar
        : []

    if (list.length > 0) {
      return list
        .map((artist: NeteaseArtist) => artist.name || 'Unknown')
        .join(', ')
    }

    return song.artist?.name || 'Unknown'
  }

  /**
   * Resolves a playable URL for Netease tracks.
   * @param decodedTrack - Decoded track metadata.
   * @returns URL payload or exception.
   */
  public async getTrackUrl(
    decodedTrack: NeteaseDecodedTrack
  ): Promise<NeteaseTrackUrlResult> {
    try {
      const neteaseId =
        decodedTrack.pluginInfo?.neteaseId || decodedTrack.identifier

      if (neteaseId && /^\d+$/.test(neteaseId)) {
        const streamUrl = `${STREAM_URL}${neteaseId}.mp3`
        logger('info', 'Netease', `Returning stream URL for id ${neteaseId}`)
        return { url: streamUrl, protocol: 'https' }
      }

      const query = `${decodedTrack.title} ${decodedTrack.author}`.trim()
      const searchResult = await this.nodelink.sources.searchWithDefault(query)

      if (
        searchResult.loadType !== 'search' ||
        searchResult.data.length === 0
      ) {
        return this.exceptionTrackResult(
          'No matching track found on fallback source.',
          'common'
        )
      }

      const candidates = this.toBestMatchCandidates(searchResult.data)
      const bestMatch = getBestMatch(candidates, decodedTrack)
      if (!bestMatch) {
        return this.exceptionTrackResult(
          'No suitable alternative found after filtering.',
          'common'
        )
      }

      const fallback = candidates.find(
        (candidate) =>
          candidate.info.title === bestMatch.info.title &&
          candidate.info.author === bestMatch.info.author &&
          candidate.info.length === bestMatch.info.length
      )
      if (!fallback) {
        return this.exceptionTrackResult(
          'No suitable alternative found.',
          'common'
        )
      }

      const streamInfo = await this.nodelink.sources.getTrackUrl(
        fallback.info as TrackInfo
      )
      return { newTrack: { info: fallback.info as TrackInfo }, ...streamInfo }
    } catch (error) {
      return this.exceptionTrackResult(this.getErrorMessage(error))
    }
  }

  /**
   * Delegates stream loading to source manager.
   * @param track - Track payload.
   * @param url - Stream URL.
   * @param protocol - Protocol hint.
   * @param additionalData - Additional stream metadata.
   * @returns Stream payload.
   */
  public async loadStream(
    track: TrackInfo,
    url: string,
    protocol?: string,
    additionalData?: Record<string, unknown>
  ): Promise<NeteaseLoadStreamResult> {
    return this.nodelink.sources.getTrackStream(
      track,
      url,
      protocol,
      additionalData
    )
  }

  /**
   * Converts unknown payload to song shape.
   * @param value - Unknown payload.
   * @returns Song payload or null.
   */
  private toSong(value: unknown): NeteaseSong | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as NeteaseSong)
      : null
  }

  /**
   * Parses unknown body into expected response object.
   * @param body - Unknown HTTP response body.
   * @returns Parsed response payload or null.
   */
  private parseBody<T extends object>(body: unknown): T | null {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      return body as T
    }

    if (typeof body === 'string') {
      try {
        const parsed = JSON.parse(body)
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as T)
          : null
      } catch {
        return null
      }
    }

    return null
  }

  /**
   * Converts unknown search data array into best-match candidates.
   * @param data - Unknown search data.
   * @returns Best-match candidate list.
   */
  private toBestMatchCandidates(data: unknown[]): BestMatchCandidate[] {
    return data
      .map((item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? (item as Record<string, unknown>)
          : null
      )
      .map((item) =>
        item?.info && this.isTrackInfo(item.info)
          ? ({ info: item.info } as BestMatchCandidate)
          : null
      )
      .filter((item): item is BestMatchCandidate => item !== null)
  }

  /**
   * Validates canonical track info payload shape.
   * @param value - Unknown value.
   * @returns True when value is a track info object.
   */
  private isTrackInfo(value: unknown): value is TrackInfo {
    const info =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null

    return (
      info !== null &&
      typeof info.identifier === 'string' &&
      typeof info.title === 'string' &&
      typeof info.author === 'string' &&
      typeof info.length === 'number' &&
      typeof info.uri === 'string' &&
      typeof info.sourceName === 'string'
    )
  }

  /**
   * Returns a typed empty result payload.
   * @returns Empty result.
   */
  private emptyResult(): NeteaseSourceResult {
    return { loadType: 'empty', data: {} }
  }

  /**
   * Returns a typed exception payload for source result.
   * @param message - Error message.
   * @param severity - Error severity.
   * @returns Exception result.
   */
  private exceptionResult(
    message: string,
    severity = 'fault'
  ): NeteaseSourceResult {
    return { exception: { message, severity } }
  }

  /**
   * Returns a typed exception payload for track URL resolution.
   * @param message - Error message.
   * @param severity - Error severity.
   * @returns Exception result.
   */
  private exceptionTrackResult(
    message: string,
    severity = 'fault'
  ): NeteaseTrackUrlResult {
    return { exception: { message, severity } }
  }

  /**
   * Extracts human-readable message from unknown errors.
   * @param error - Unknown error value.
   * @returns Error message string.
   */
  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}
