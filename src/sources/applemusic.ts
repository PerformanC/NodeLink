import type { AppleMusicSourceConfig } from '../typings/config/config.types.ts'
import type {
  SourceInstance,
  SourceResult,
  TrackData,
  TrackInfo,
  TrackStreamResult,
  TrackUrlResult,
  WorkerNodeLink
} from '../typings/sources/source.types.ts'
import { encodeTrack, getBestMatch, http1makeRequest } from '../utils.ts'

/**
 * Metadata for Apple Music catalog resource attributes.
 * @internal
 */
interface AppleMusicAttributes {
  /** The name of the resource. */
  name?: string
  /** The name of the artist or curator. */
  artistName?: string
  /** The curator name specifically for playlists. */
  curatorName?: string
  /** The canonical Apple Music URL for the resource. */
  url?: string
  /** Artwork metadata including URL and dimensions. */
  artwork?: {
    /** The artwork URL with {w} and {h} placeholders. */
    url: string
    /** Original width. */
    width: number
    /** Original height. */
    height: number
  }
  /** Duration of the track in milliseconds. */
  durationInMillis?: number
  /** Content rating, typically used to identify explicit content. */
  contentRating?: string
  /** International Standard Recording Code for the track. */
  isrc?: string
  /** The name of the album associated with the track. */
  albumName?: string
  /** The number of tracks in a collection. */
  trackCount?: number
  /** Audio preview variants. */
  previews?: Array<{
    /** The preview audio URL. */
    url: string
  }>
  /** Editorial video metadata used for motion artwork. */
  editorialVideo?: {
    /** Square detail video variant. */
    motionDetailSquare?: { video: string }
    /** Tall detail video variant. */
    motionDetailTall?: { video: string }
    /** 1x1 square video variant. */
    motionSquareVideo1x1?: { video: string }
    /** 16x9 artist fullscreen video variant. */
    motionArtistFullscreen16x9?: { video: string }
    /** 1x1 artist square video variant. */
    motionArtistSquare1x1?: { video: string }
    /** Artist square video variant. */
    motionArtistSquare?: { video: string }
    /** Artist fullscreen video variant. */
    motionArtistFullscreen?: { video: string }
  }
}

/**
 * Generic shape of an Apple Music API resource.
 * @internal
 */
interface AppleMusicResource {
  /** Stable identifier for the resource. */
  id: string
  /** Resource type discriminator (e.g., 'songs', 'albums'). */
  type: string
  /** Resource attribute payload. */
  attributes?: AppleMusicAttributes
  /** Resource relationship graph. */
  relationships?: {
    /** Linked tracks connection. */
    tracks?: {
      /** Track data list. */
      data?: AppleMusicResource[]
      /** Metadata including total counts. */
      meta?: { total?: number }
    }
    /** Linked albums connection. */
    albums?: {
      /** Album data list. */
      data?: AppleMusicResource[]
    }
  }
}

/**
 * Apple Music source implementation.
 * Provides integration with the Apple Music Catalog API for track resolution and searching.
 * Supports delegated resolution via alternative sources for playback.
 * @public
 */
export default class AppleMusicSource implements SourceInstance {
  /**
   * The global worker NodeLink instance.
   * @internal
   */
  private readonly nodelink: WorkerNodeLink

  /**
   * The configuration bucket for Apple Music.
   * @internal
   */
  private readonly config: AppleMusicSourceConfig

  /**
   * Prefixes used to identify search queries targeting this source.
   * @public
   */
  public readonly searchTerms = ['amsearch']

  /**
   * Regular expression patterns used to match Apple Music URLs.
   * @public
   */
  public readonly patterns = [
    /https?:\/\/(?:www\.)?music\.apple\.com\/([a-z]{2})?\/?(album|playlist|artist|song)\/[^/]+\/([a-zA-Z0-9\-.]+)(?:\?i=(\d+))?/
  ]

  /**
   * Matching priority for this source.
   * @public
   */
  public readonly priority = 95

  /**
   * The currently cached Media API token.
   * @internal
   */
  private mediaApiToken: string | null = null

  /**
   * Unix timestamp (ms) when the current token expires.
   * @internal
   */
  private tokenExpiry: number | null = null

  /**
   * The primary market/country code for API requests.
   * @internal
   */
  private country = 'US'

  /**
   * Maximum number of pages to load for playlists.
   * @internal
   */
  private playlistPageLimit = 0

  /**
   * Maximum number of pages to load for albums.
   * @internal
   */
  private albumPageLimit = 0

  /**
   * Local preference for allowing explicit content in matches.
   * @internal
   */
  private allowExplicit = true

  /**
   * Flag indicating if the token system has been initialized.
   * @internal
   */
  private tokenInitialized = false

  /**
   * Flag indicating if a setup operation is currently in progress.
   * @internal
   */
  private settingUp = false

  /**
   * Constructs a new AppleMusicSource.
   * @param nodelink - The worker NodeLink context.
   */
  constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
    this.config = (nodelink.options.sources?.applemusic || {
      enabled: false,
      playlistLoadLimit: 0,
      albumLoadLimit: 0,
      allowExplicit: true
    }) as AppleMusicSourceConfig
  }

  /**
   * Initializes the source by obtaining a valid Media API token.
   * Attempts to read from CredentialManager, then config, and finally scrapes the web interface.
   * @returns A promise resolving to true if a token was obtained.
   * @public
   */
  public async setup(): Promise<boolean> {
    if (this.settingUp) return true
    this.settingUp = true

    try {
      this.country = this.config.market || 'US'
      this.playlistPageLimit = this.config.playlistLoadLimit ?? 0
      this.albumPageLimit = this.config.albumLoadLimit ?? 0
      this.allowExplicit = this.config.allowExplicit ?? true

      if (this.tokenInitialized && this.isTokenValid()) return true

      const cachedToken = this.nodelink.credentialManager?.get<string>(
        'apple_media_api_token'
      )
      if (cachedToken) {
        this.mediaApiToken = cachedToken
        this.parseToken(cachedToken)
        if (this.isTokenValid()) {
          this.tokenInitialized = true
          return true
        }
      }

      if (
        this.config.mediaApiToken &&
        this.config.mediaApiToken !== 'token_here'
      ) {
        this.mediaApiToken = this.config.mediaApiToken
        this.parseToken(this.mediaApiToken)
        if (this.isTokenValid()) {
          this.nodelink.credentialManager?.set(
            'apple_media_api_token',
            this.mediaApiToken,
            (this.tokenExpiry || 0) - Date.now()
          )
          this.tokenInitialized = true
          return true
        }
      }

      const newToken = await this.fetchNewToken()
      if (newToken) {
        this.mediaApiToken = newToken
        this.parseToken(newToken)
        this.nodelink.credentialManager?.set(
          'apple_media_api_token',
          newToken,
          (this.tokenExpiry || 0) - Date.now()
        )
        this.tokenInitialized = true
        return true
      }

      return false
    } finally {
      this.settingUp = false
    }
  }

  /**
   * Scrapes a new Media API token from the Apple Music browse page.
   * @returns A promise resolving to the token string or null.
   * @internal
   */
  private async fetchNewToken(): Promise<string | null> {
    try {
      const { body: html, statusCode } = await http1makeRequest(
        'https://music.apple.com/us/browse'
      )
      if (statusCode !== 200 || typeof html !== 'string') return null

      const scriptMatch = html.match(
        /<script\s+type="module"\s+crossorigin\s+src="([^"]+)"/
      )
      if (!scriptMatch?.[1]) return null

      const { body: jsData, statusCode: jsStatus } = await http1makeRequest(
        `https://music.apple.com${scriptMatch[1]}`
      )
      if (jsStatus !== 200 || typeof jsData !== 'string') return null

      const tokenMatch = jsData.match(
        /(?<token>(ey[\w-]+)\.([\w-]+)\.([\w-]+))/
      )
      return tokenMatch?.groups?.token || null
    } catch {
      return null
    }
  }

  /**
   * Validates if the current token is set and not expired.
   * @returns True if the token is valid.
   * @internal
   */
  private isTokenValid(): boolean {
    return (
      !!this.mediaApiToken &&
      (!this.tokenExpiry || Date.now() < this.tokenExpiry - 10000)
    )
  }

  /**
   * Decodes the JWT token to extract the expiration timestamp.
   * @param token - The Media API token.
   * @internal
   */
  private parseToken(token: string): void {
    try {
      const payload = token.split('.')[1]
      if (!payload) {
        this.tokenExpiry = null
        return
      }
      const decoded = JSON.parse(Buffer.from(payload, 'base64').toString())
      this.tokenExpiry = decoded.exp ? decoded.exp * 1000 : null
    } catch {
      this.tokenExpiry = null
    }
  }

  /**
   * Performs an authenticated request to the Apple Music API.
   * Automatically handles token refresh on 401 errors.
   * @param path - The API path or full URL.
   * @returns A promise resolving to the parsed response body or null.
   * @internal
   */
  private async apiRequest<T>(path: string): Promise<T | null> {
    if (!this.tokenInitialized || !this.isTokenValid()) {
      const ok = await this.setup()
      if (!ok) throw new Error('Apple Music token unavailable')
    }

    const url = path.startsWith('http')
      ? path
      : `https://amp-api.music.apple.com/v1${path}`
    const { body, statusCode } = await http1makeRequest(url, {
      headers: {
        Authorization: `Bearer ${this.mediaApiToken}`,
        Accept: 'application/json',
        Origin: 'https://music.apple.com'
      }
    })

    if (statusCode === 401) {
      this.tokenInitialized = false
      return this.apiRequest<T>(path)
    }

    return typeof statusCode === 'number' &&
      statusCode >= 200 &&
      statusCode < 300
      ? (body as T)
      : null
  }

  /**
   * Executes a catalog search for the given query.
   * @param query - The search query.
   * @param _sourceName - Unused source name parameter.
   * @param searchType - The target resource type ('track', 'album', 'playlist', 'artist').
   * @returns A promise resolving to a SourceResult.
   * @public
   */
  public async search(
    query: string,
    _sourceName?: string,
    searchType = 'track'
  ): Promise<SourceResult> {
    try {
      const limit = (this.nodelink.options.search.maxResults as number) || 10
      const typeMap: Record<string, string> = {
        track: 'songs',
        album: 'albums',
        playlist: 'playlists',
        artist: 'artists'
      }
      const apiType = typeMap[searchType] || 'songs'

      const data = await this.apiRequest<{
        results: Record<string, { data: AppleMusicResource[] }>
      }>(
        `/catalog/${this.country}/search?term=${encodeURIComponent(query)}&limit=${limit}&types=${apiType}&extend=artistUrl,editorialVideo`
      )

      const items: AppleMusicResource[] = data?.results?.[apiType]?.data || []
      if (items.length === 0) return { loadType: 'empty', data: {} }

      const results = items
        .map((item) => {
          if (searchType === 'track') return this.buildTrack(item)
          return this.buildMetadataCollection(item, searchType)
        })
        .filter((t): t is TrackData => !!t)

      return { loadType: 'search', data: results }
    } catch (e: unknown) {
      return {
        loadType: 'error',
        exception: { message: (e as Error).message, severity: 'fault' }
      }
    }
  }

  /**
   * Resolves an Apple Music URL to its corresponding resource.
   * @param url - The Apple Music URL.
   * @returns A promise resolving to a SourceResult.
   * @public
   */
  public async resolve(url: string): Promise<SourceResult> {
    const pattern = this.patterns[0]
    if (!pattern) return { loadType: 'empty', data: {} }

    const match = pattern.exec(url)
    if (!match) return { loadType: 'empty', data: {} }

    const country = match[1]?.toUpperCase() || this.country
    const type = match[2]
    const id = match[3]
    const altTrackId = match[4]

    if (!id) return { loadType: 'empty', data: {} }

    try {
      if (type === 'song' || (type === 'album' && altTrackId)) {
        return await this.resolveTrack(altTrackId || id, country)
      }
      if (type === 'album') return await this.resolveAlbum(id, country)
      if (type === 'playlist') return await this.resolvePlaylist(id, country)
      if (type === 'artist') return await this.resolveArtist(id, country)
      return { loadType: 'empty', data: {} }
    } catch (e: unknown) {
      return {
        loadType: 'error',
        exception: { message: (e as Error).message, severity: 'fault' }
      }
    }
  }

  /**
   * Resolves a single track by its ID.
   * @param id - The Apple Music track ID.
   * @param country - The market code.
   * @returns A promise resolving to a SourceResult.
   * @internal
   */
  private async resolveTrack(
    id: string,
    country: string
  ): Promise<SourceResult> {
    const data = await this.apiRequest<{ data: AppleMusicResource[] }>(
      `/catalog/${country}/songs/${id}?extend=artistUrl,editorialVideo&include=albums`
    )
    const song = data?.data?.[0]
    if (!song) return { loadType: 'empty', data: {} }

    const track = this.buildTrack(song)
    if (!track) return { loadType: 'empty', data: {} }

    return { loadType: 'track', data: track }
  }

  /**
   * Resolves an album by its ID and paginates through all tracks.
   * @param id - The Apple Music album ID.
   * @param country - The market code.
   * @returns A promise resolving to a SourceResult.
   * @internal
   */
  private async resolveAlbum(
    id: string,
    country: string
  ): Promise<SourceResult> {
    const data = await this.apiRequest<{ data: AppleMusicResource[] }>(
      `/catalog/${country}/albums/${id}?extend=artistUrl,editorialVideo`
    )
    const album = data?.data?.[0]
    if (!album) return { loadType: 'empty', data: {} }

    const tracks = await this.paginate(
      album,
      `/catalog/${country}/albums/${id}/tracks`
    )
    return {
      loadType: 'album',
      data: {
        info: {
          name: album.attributes?.name || 'Unknown Album',
          selectedTrack: 0
        },
        tracks,
        pluginInfo: {} as Record<string, unknown>
      }
    }
  }

  /**
   * Resolves a playlist by its ID and paginates through all tracks.
   * @param id - The Apple Music playlist ID.
   * @param country - The market code.
   * @returns A promise resolving to a SourceResult.
   * @internal
   */
  private async resolvePlaylist(
    id: string,
    country: string
  ): Promise<SourceResult> {
    const data = await this.apiRequest<{ data: AppleMusicResource[] }>(
      `/catalog/${country}/playlists/${id}?extend=editorialVideo`
    )
    const playlist = data?.data?.[0]
    if (!playlist) return { loadType: 'empty', data: {} }

    const tracks = await this.paginate(
      playlist,
      `/catalog/${country}/playlists/${id}/tracks?extend=artistUrl`
    )
    return {
      loadType: 'playlist',
      data: {
        info: {
          name: playlist.attributes?.name || 'Unknown Playlist',
          selectedTrack: 0
        },
        tracks,
        pluginInfo: {} as Record<string, unknown>
      }
    }
  }

  /**
   * Resolves an artist's top tracks by their ID.
   * @param id - The Apple Music artist ID.
   * @param country - The market code.
   * @returns A promise resolving to a SourceResult.
   * @internal
   */
  private async resolveArtist(
    id: string,
    country: string
  ): Promise<SourceResult> {
    const data = await this.apiRequest<{ data: AppleMusicResource[] }>(
      `/catalog/${country}/artists/${id}?extend=editorialVideo`
    )
    const artist = data?.data?.[0]
    if (!artist) return { loadType: 'empty', data: {} }

    const topSongs = await this.apiRequest<{ data: AppleMusicResource[] }>(
      `/catalog/${country}/artists/${id}/view/top-songs`
    )
    const tracks = (topSongs?.data || [])
      .map((t) => this.buildTrack(t))
      .filter((t): t is TrackData => !!t)

    return {
      loadType: 'artist',
      data: {
        info: {
          name: `${artist.attributes?.name}'s Top Tracks`,
          selectedTrack: 0
        },
        tracks,
        pluginInfo: {} as Record<string, unknown>
      }
    }
  }

  /**
   * Paginates through a parent resource's track relationship.
   * @param parent - The parent AppleMusicResource (album or playlist).
   * @param path - The API path to fetch tracks from.
   * @returns A promise resolving to an array of TrackData.
   * @internal
   */
  private async paginate(
    parent: AppleMusicResource,
    path: string
  ): Promise<TrackData[]> {
    const baseTracks = parent.relationships?.tracks?.data || []
    const total = parent.relationships?.tracks?.meta?.total || baseTracks.length
    const limit = 300
    const pages = Math.ceil(total / limit)
    const maxPages =
      parent.type === 'albums' ? this.albumPageLimit : this.playlistPageLimit
    const allowed = maxPages > 0 ? Math.min(pages, maxPages) : pages

    const artwork = this.parseArtwork(parent.attributes?.artwork)
    const editorialVideo = this.extractVideoUrl(parent.attributes)

    const results = baseTracks
      .map((t) => this.buildTrack(t, artwork, editorialVideo))
      .filter((t): t is TrackData => !!t)

    for (let i = 1; i < allowed; i++) {
      const pageData = await this.apiRequest<{ data: AppleMusicResource[] }>(
        `${path}${path.includes('?') ? '&' : '?'}limit=${limit}&offset=${i * limit}`
      )
      if (pageData?.data) {
        results.push(
          ...pageData.data
            .map((t) => this.buildTrack(t, artwork, editorialVideo))
            .filter((t): t is TrackData => !!t)
        )
      }
    }

    return results
  }

  /**
   * Normalizes an Apple Music resource into a TrackData object.
   * @param item - The track resource from the API.
   * @param artworkOverride - Optional artwork URL to override the resource's own.
   * @param videoOverride - Optional video URL to override the resource's own.
   * @returns The normalized TrackData or null if attributes are missing.
   * @internal
   */
  private buildTrack(
    item: AppleMusicResource,
    artworkOverride?: string | null,
    videoOverride?: string | null
  ): TrackData | null {
    const attr = item.attributes
    if (!attr) return null

    const artwork = artworkOverride || this.parseArtwork(attr.artwork)
    const isExplicit = attr.contentRating === 'explicit'
    const trackUri = attr.url
      ? `${attr.url}${attr.url.includes('?') ? '&' : '?'}explicit=${isExplicit}`
      : ''

    const info: TrackInfo = {
      identifier: item.id,
      isSeekable: true,
      author: attr.artistName || 'Unknown',
      length: attr.durationInMillis || 0,
      isStream: false,
      position: 0,
      title: attr.name || 'Unknown',
      uri: trackUri,
      artworkUrl: artwork,
      isrc: attr.isrc || null,
      sourceName: 'applemusic'
    }

    return {
      encoded: encodeTrack({ ...info, details: [] }),
      info,
      pluginInfo: {
        albumName: attr.albumName,
        previewUrl: attr.previews?.[0]?.url,
        hlsVideoUrl: videoOverride || this.extractVideoUrl(attr)
      }
    }
  }

  /**
   * Builds a metadata-only TrackData for collections like artists or empty containers.
   * @param item - The resource from the API.
   * @param type - The collection type.
   * @returns The normalized TrackData.
   * @internal
   */
  private buildMetadataCollection(
    item: AppleMusicResource,
    type: string
  ): TrackData {
    const attr = item.attributes
    const info: TrackInfo = {
      identifier: item.id,
      isSeekable: type !== 'artist',
      author: attr?.artistName || attr?.curatorName || 'Apple Music',
      length: 0,
      isStream: false,
      position: 0,
      title: attr?.name || 'Unknown',
      uri: attr?.url || '',
      artworkUrl: this.parseArtwork(attr?.artwork),
      isrc: null,
      sourceName: 'applemusic'
    }

    return {
      encoded: encodeTrack({ ...info, details: [] }),
      info,
      pluginInfo: { type, trackCount: attr?.trackCount }
    }
  }

  /**
   * Processes the artwork object into a usable URL.
   * @param artwork - The artwork attribute from the API.
   * @returns The formatted URL or null.
   * @internal
   */
  private parseArtwork(artwork?: {
    url: string
    width: number
    height: number
  }): string | null {
    if (!artwork?.url) return null
    return artwork.url
      .replace('{w}', artwork.width.toString())
      .replace('{h}', artwork.height.toString())
  }

  /**
   * Extracts the first available motion artwork video URL.
   * @param attr - The resource attributes.
   * @returns The video URL or null.
   * @internal
   */
  private extractVideoUrl(attr?: AppleMusicAttributes): string | null {
    const ev = attr?.editorialVideo
    if (!ev) return null
    return (
      ev.motionDetailSquare?.video ||
      ev.motionDetailTall?.video ||
      ev.motionSquareVideo1x1?.video ||
      ev.motionArtistFullscreen16x9?.video ||
      ev.motionArtistSquare1x1?.video ||
      ev.motionArtistSquare?.video ||
      ev.motionArtistFullscreen?.video ||
      null
    )
  }

  /**
   * Resolves a delegated Apple Music track metadata to a playable alternative stream.
   * Searches for the track on the default configured source using ISRC or metadata.
   * @param decodedTrack - The track metadata to resolve.
   * @returns A promise resolving to a result containing the alternative stream.
   * @public
   */
  public async getTrackUrl(decodedTrack: TrackInfo): Promise<TrackUrlResult> {
    const isExplicit = decodedTrack.uri?.includes('explicit=true')
    let query = `${decodedTrack.title} ${decodedTrack.author}`
    if (isExplicit)
      query += this.allowExplicit ? ' official video' : ' clean version'

    const sources = this.nodelink.sources
    if (!sources) {
      return {
        exception: { message: 'Sources not available.', severity: 'fault' }
      }
    }

    const searchResult = await sources.searchWithDefault(
      decodedTrack.isrc ? `"${decodedTrack.isrc}"` : query
    )
    const candidates =
      searchResult.loadType === 'search' ? searchResult.data : []
    const bestMatch = getBestMatch(candidates, decodedTrack, {
      allowExplicit: this.allowExplicit
    })

    if (!bestMatch) {
      return {
        exception: { message: 'No suitable match found.', severity: 'fault' }
      }
    }

    const stream = await sources.getTrackUrl(
      bestMatch.info as unknown as TrackInfo
    )
    return {
      newTrack: { info: bestMatch.info as unknown as TrackInfo },
      ...stream
    }
  }

  /**
   * This source does not handle direct stream loading.
   * @returns A promise resolving to an error result as direct streaming is unsupported.
   * @public
   */
  public async loadStream(): Promise<TrackStreamResult> {
    return {
      exception: {
        message:
          'Direct stream loading is not supported by Apple Music source.',
        severity: 'common'
      }
    }
  }
}
