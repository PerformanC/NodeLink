import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import { PassThrough, type Readable } from 'node:stream'
import BlowfishCBC from '../decrypters/blowfish-cbc.ts'
import type {
  SourceResult,
  TrackInfo,
  TrackStreamResult,
  TrackUrlResult,
  WorkerNodeLink
} from '../typings/sources/source.types.ts'
import type {
  BestMatchCandidate,
  HttpRequestHeaders,
  HttpRequestResult,
  HttpResponseHeaders,
  TrackEncodeInput
} from '../typings/utils.types.ts'
import {
  encodeTrack,
  getBestMatch,
  http1makeRequest,
  logger,
  makeRequest
} from '../utils.ts'

/**
 * Static IV used by Deezer's Blowfish-CBC chunk decryption scheme.
 */
const IV = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7])

/**
 * Accepts plain ISRCs and `isrc:`-prefixed queries with optional hyphens.
 */
const ISRC_REGEX = /^(?:isrc:)?([A-Z]{2}-?[A-Z0-9]{3}-?\d{2}-?\d{5})$/i

/**
 * TTL used when persisting Deezer gateway credentials.
 */
const CREDENTIAL_TTL_MS = 24 * 60 * 60 * 1000

/**
 * TTL used for cached direct-stream resolutions.
 */
const TRACK_CACHE_TTL_MS = 4 * 60 * 60 * 1000

/**
 * JSON-compatible scalar or nested value used for response narrowing.
 */
type JsonValue = JsonRecord | JsonValue[] | string | number | boolean | null

/**
 * Object-like JSON record used to safely inspect unknown payloads.
 */
interface JsonRecord {
  [key: string]: JsonValue | undefined
}

/**
 * Search types supported by Deezer's public search API.
 */
type DeezerSearchType = 'track' | 'album' | 'playlist' | 'artist'

/**
 * Direct stream formats returned by Deezer's media endpoint.
 */
type DeezerTrackFormat = 'flac' | 'mp3'

/**
 * Runtime options subset consumed by the Deezer source.
 */
interface DeezerRuntimeOptions {
  /**
   * Maximum number of search results returned to the caller.
   */
  maxSearchResults?: number

  /**
   * Maximum number of tracks loaded for albums, playlists, and artists.
   */
  maxAlbumPlaylistLength?: number
  search?: {
    maxResults?: number
  }
  playback?: {
    maxPlaylistLength?: number
  }

  /**
   * Source-specific configuration map.
   */
  sources?: {
    /**
     * Deezer-specific settings used by this source.
     */
    deezer?: {
      /**
       * Optional Deezer `arl` cookie used for authenticated gateway access.
       */
      arl?: string

      /**
       * Static 16-byte Blowfish key used to decrypt direct streams.
       */
      decryptionKey?: string
    }
  }
}

/**
 * Error payload returned by Deezer REST endpoints.
 */
interface DeezerApiError {
  /**
   * Deezer error code when available.
   */
  code?: number

  /**
   * Human-readable failure message.
   */
  message?: string
}

/**
 * Minimal Deezer artist payload used by search, resolve, and track builders.
 */
interface DeezerArtistSummary {
  /**
   * Stable Deezer artist identifier.
   */
  id?: number | string

  /**
   * Human-readable artist name.
   */
  name?: string

  /**
   * Largest artist artwork variant.
   */
  picture_xl?: string | null

  /**
   * Medium artist artwork fallback.
   */
  picture_big?: string | null

  /**
   * Smaller artist artwork fallback.
   */
  picture_medium?: string | null
}

/**
 * Minimal Deezer album payload used by track and collection builders.
 */
interface DeezerAlbumSummary {
  /**
   * Stable Deezer album identifier.
   */
  id?: number | string

  /**
   * Human-readable album title.
   */
  title?: string

  /**
   * Largest album artwork variant.
   */
  cover_xl?: string | null

  /**
   * Medium album artwork fallback.
   */
  cover_big?: string | null

  /**
   * Smaller album artwork fallback.
   */
  cover_medium?: string | null
}

/**
 * Unified Deezer entity shape used across public API responses.
 */
interface DeezerEntity {
  /**
   * Stable Deezer entity identifier.
   */
  id?: number | string

  /**
   * Search-result type returned by Deezer.
   */
  type?: string

  /**
   * Whether the entity is readable as a track.
   */
  readable?: boolean

  /**
   * Track, album, or playlist title.
   */
  title?: string

  /**
   * Artist display name used by artist responses.
   */
  name?: string

  /**
   * Duration in seconds.
   */
  duration?: number | string

  /**
   * Canonical Deezer URL.
   */
  link?: string

  /**
   * ISRC exposed by Deezer when available.
   */
  isrc?: string | null

  /**
   * Thirty-second preview URL.
   */
  preview?: string | null

  /**
   * Tracklist URL for albums and playlists.
   */
  tracklist?: string

  /**
   * Number of tracks in a collection result.
   */
  nb_tracks?: number

  /**
   * Largest collection artwork variant.
   */
  cover_xl?: string | null

  /**
   * Medium collection artwork fallback.
   */
  cover_big?: string | null

  /**
   * Smaller collection artwork fallback.
   */
  cover_medium?: string | null

  /**
   * Largest playlist or artist artwork variant.
   */
  picture_xl?: string | null

  /**
   * Medium playlist or artist artwork fallback.
   */
  picture_big?: string | null

  /**
   * Smaller playlist or artist artwork fallback.
   */
  picture_medium?: string | null

  /**
   * Deezer REST error wrapper.
   */
  error?: DeezerApiError

  /**
   * Nested album metadata for track responses.
   */
  album?: DeezerAlbumSummary | null

  /**
   * Nested artist metadata for track responses.
   */
  artist?: DeezerArtistSummary | null

  /**
   * Playlist owner metadata returned by some responses.
   */
  user?: { name?: string | null } | null

  /**
   * Alternate playlist creator metadata.
   */
  creator?: { name?: string | null } | null
}

/**
 * Generic Deezer REST list response.
 */
interface DeezerListResponse<T> {
  /**
   * Total number of matches returned by Deezer.
   */
  total?: number

  /**
   * Payload list returned by Deezer.
   */
  data?: T[]

  /**
   * Deezer REST error wrapper.
   */
  error?: DeezerApiError
}

/**
 * Deezer gateway user-data response used during source setup.
 */
interface DeezerUserDataResponse {
  /**
   * Gateway result bucket.
   */
  results?: {
    /**
     * CSRF token required by Deezer gateway requests.
     */
    checkForm?: string

    /**
     * Nested user metadata bag.
     */
    USER?: {
      /**
       * Deezer account options.
       */
      OPTIONS?: {
        /**
         * License token consumed by the media API.
         */
        license_token?: string
      }
    }
  }
}

/**
 * Recommendation item returned by Deezer gateway radio endpoints.
 */
interface DeezerRecommendationItem {
  /**
   * Stable Deezer song identifier.
   */
  SNG_ID?: number | string

  /**
   * Human-readable artist name.
   */
  ART_NAME?: string

  /**
   * Track duration in seconds.
   */
  DURATION?: number

  /**
   * Human-readable track title.
   */
  SNG_TITLE?: string

  /**
   * Album artwork hash used to build Deezer cover URLs.
   */
  ALB_PICTURE?: string

  /**
   * ISRC when Deezer exposes it for the recommendation item.
   */
  ISRC?: string | null
}

/**
 * Generic Deezer gateway response wrapper.
 */
interface DeezerGatewayListResponse<T> {
  /**
   * Gateway result bucket.
   */
  results?: {
    /**
     * Result list returned by the gateway endpoint.
     */
    data?: T[]
  }

  /**
   * Gateway error payload when Deezer rejects the request.
   */
  error?: JsonRecord | string[] | string | null
}

/**
 * Deezer gateway track metadata cached between URL resolution and stream load.
 */
interface DeezerGatewayTrackData extends Record<string, JsonValue | undefined> {
  /**
   * Stable Deezer song identifier.
   */
  SNG_ID?: number | string

  /**
   * Media token consumed by Deezer's direct media endpoint.
   */
  TRACK_TOKEN?: string

  /**
   * File size used to estimate seek offsets.
   */
  FILESIZE?: number | string

  /**
   * Track duration in seconds.
   */
  DURATION?: number | string

  /**
   * Resume position in milliseconds.
   */
  startTime?: number
}

/**
 * Deezer direct media response returned by `media.deezer.com`.
 */
interface DeezerMediaResponse {
  /**
   * Media payload returned for the requested track.
   */
  data?: Array<{
    /**
     * Available media entries ordered by preference.
     */
    media?: Array<{
      /**
       * Deezer format label such as `FLAC` or `MP3_256`.
       */
      format?: string

      /**
       * Direct encrypted media sources for the selected format.
       */
      sources?: Array<{ url?: string }>
    }>
  }>
}

/**
 * Deezer track payload accepted by the shared encoder.
 */
interface DeezerTrackInfo extends TrackEncodeInput {
  [x: string]: unknown
  /**
   * Whether the resolved item can be seeked.
   */
  isSeekable: boolean

  /**
   * Canonical Deezer URL.
   */
  uri: string

  /**
   * Artwork URL exposed to clients.
   */
  artworkUrl: string | null

  /**
   * Deezer ISRC when available.
   */
  isrc: string | null
}

/**
 * Deezer-specific plugin metadata attached to encoded tracks.
 */
interface DeezerTrackPluginInfo {
  [x: string]: unknown
  /**
   * Collection type used by metadata-only search results.
   */
  type?: 'album' | 'artist' | 'playlist' | 'recommendations'

  /**
   * Number of tracks in the collection when available.
   */
  trackCount?: number | null

  /**
   * Human-readable album title.
   */
  albumName?: string

  /**
   * Canonical Deezer album URL.
   */
  albumUrl?: string

  /**
   * Canonical Deezer artist URL.
   */
  artistUrl?: string

  /**
   * Artist artwork URL exposed by Deezer.
   */
  artistArtworkUrl?: string

  /**
   * Deezer thirty-second preview URL.
   */
  previewUrl?: string
}

/**
 * Encoded Deezer track payload returned to the source manager.
 */
interface DeezerTrackData extends BestMatchCandidate {
  /**
   * Base64-encoded Lavalink-compatible track payload.
   */
  encoded: string

  /**
   * Human-readable track information.
   */
  info: DeezerTrackInfo

  /**
   * Deezer-specific plugin metadata.
   */
  pluginInfo: DeezerTrackPluginInfo | Record<string, unknown>
}

/**
 * Playlist-style Deezer payload used for recommendations and collections.
 */
interface DeezerPlaylistData {
  /**
   * Playlist metadata shown to the client.
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
  pluginInfo: DeezerTrackPluginInfo | Record<string, unknown>

  /**
   * Tracks returned for the collection.
   */
  tracks: DeezerTrackData[]
}

/**
 * Successful Deezer direct-track URL descriptor.
 */
interface DeezerTrackUrlSuccess extends TrackUrlResult {
  /**
   * Direct encrypted Deezer stream URL.
   */
  url: string

  /**
   * Deezer direct streams are fetched over HTTPS.
   */
  protocol: 'https'

  /**
   * Selected direct-stream format.
   */
  format: DeezerTrackFormat

  /**
   * Gateway metadata needed later by `loadStream(...)`.
   */
  additionalData: DeezerGatewayTrackData
}

/**
 * Source-manager methods required by Deezer's delegated fallback flow.
 */
interface DeezerSourceManager {
  /**
   * Searches a specific source alias or source name.
   */
  search: (sourceTerm: string, query: string) => Promise<SourceResult>

  /**
   * Searches the configured default source pipeline.
   */
  searchWithDefault: (query: string) => Promise<SourceResult>

  /**
   * Resolves a playable URL for a delegated track.
   */
  getTrackUrl: (track: TrackInfo) => Promise<TrackUrlResult>
}

/**
 * Deezer source with typed REST/gateway payloads and stricter stream cleanup.
 */
export default class DeezerSource {
  /**
   * Runtime worker context used by the source implementation.
   */
  public readonly nodelink: WorkerNodeLink

  /**
   * Sanitized Deezer-specific runtime options.
   */
  private readonly config: DeezerRuntimeOptions

  /**
   * Search aliases handled by this source.
   */
  public readonly searchTerms = ['dzsearch', 'dzisrc']

  /**
   * Recommendation aliases handled by this source.
   */
  public readonly recommendationTerm = ['dzrec']

  /**
   * Deezer URL patterns resolved by this source.
   */
  public readonly patterns: RegExp[] = [
    /^https?:\/\/(?:www\.)?deezer\.com\/(?:[a-z]+(?:-[a-z]+)?\/)?(track|album|playlist|artist)\/(\d+)(?:\?.*)?$/,
    /^https?:\/\/link\.deezer\.com\/s\/([a-zA-Z0-9]+)/
  ]

  /**
   * Match priority used by the source manager.
   */
  public readonly priority = 80

  /**
   * Deezer session cookie used by authenticated gateway requests.
   */
  private cookie: string | null = null

  /**
   * Gateway CSRF token returned by Deezer user-data requests.
   */
  private csrfToken: string | null = null

  /**
   * License token required by Deezer's direct media API.
   */
  private licenseToken: string | null = null

  /**
   * In-flight setup promise used to serialize initialization work.
   */
  private setupPromise: Promise<boolean> | null = null

  /**
   * Creates a new Deezer source wrapper.
   *
   * @param nodelink Worker runtime used by the source implementation.
   */
  public constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
    this.config = nodelink.options as DeezerRuntimeOptions
  }

  /**
   * Initializes Deezer gateway credentials and caches them for later use.
   *
   * Concurrent setup calls are serialized so credential refreshes cannot race
   * and overwrite cookies or tokens mid-boot.
   *
   * @returns `true` when the source is ready to accept requests.
   */
  public async setup(): Promise<boolean> {
    if (this.setupPromise) return this.setupPromise

    const currentSetup = this.performSetup()
    this.setupPromise = currentSetup

    try {
      return await currentSetup
    } finally {
      if (this.setupPromise === currentSetup) {
        this.setupPromise = null
      }
    }
  }

  /**
   * Searches Deezer tracks, albums, playlists, artists, or recommendation
   * mixes depending on the routed source alias.
   *
   * @param query Search text supplied by the source manager.
   * @param sourceTerm Source alias that routed the request.
   * @param searchType Search type inferred by the source manager.
   * @returns Search results, an empty payload, or a structured exception.
   */
  public async search(
    query: string,
    sourceTerm?: string,
    searchType = 'track'
  ): Promise<SourceResult> {
    if (sourceTerm && this.recommendationTerm.includes(sourceTerm)) {
      return this.getRecommendations(query)
    }

    const isrc = this.extractIsrc(query)
    if (isrc) {
      try {
        const track = await this.fetchTrackByIsrc(isrc)
        const builtTrack = track ? this.buildTrack(track) : null
        return builtTrack
          ? { loadType: 'search', data: [builtTrack] }
          : { loadType: 'empty', data: {} }
      } catch (error) {
        logger(
          'warn',
          'Deezer',
          `ISRC lookup failed for ${isrc}: ${this.getErrorMessage(error)}`
        )
        return { loadType: 'empty', data: {} }
      }
    }

    const effectiveSearchType = this.isSearchType(searchType)
      ? searchType
      : 'track'
    const { body, error } = await makeRequest(
      `https://api.deezer.com/2.0/search/${effectiveSearchType}?q=${encodeURIComponent(query)}`,
      { method: 'GET' }
    )
    const response = this.getJsonBody<DeezerListResponse<DeezerEntity>>(body)

    if (error || response?.error) {
      return this.createException(
        error ?? response?.error?.message ?? 'Failed to search Deezer.',
        'common'
      )
    }

    const items = Array.isArray(response?.data)
      ? response.data.slice(0, this.getMaxSearchResults())
      : []

    if ((response?.total ?? items.length) === 0 || items.length === 0) {
      return { loadType: 'empty', data: {} }
    }

    const results: DeezerTrackData[] = []
    if (effectiveSearchType === 'track') {
      for (const item of items) {
        if (item.type === 'track' && item.readable !== false) {
          const track = this.buildTrack(item)
          if (track) results.push(track)
        }
      }
    } else {
      for (const item of items) {
        const track = this.buildMetadataTrack(item, effectiveSearchType)
        if (track) results.push(track)
      }
    }

    return results.length > 0
      ? { loadType: 'search', data: results }
      : { loadType: 'empty', data: {} }
  }

  /**
   * Loads Deezer recommendation mixes from the gateway radio endpoints.
   *
   * @param query Track seed, artist seed, or free-text query.
   * @returns Playlist-style recommendation payload, an empty payload, or a
   * structured exception.
   */
  public async getRecommendations(query: string): Promise<SourceResult> {
    if (!this.cookie || !this.csrfToken) {
      return this.createException(
        'Deezer gateway credentials are not available.',
        'fault'
      )
    }

    try {
      let method: 'song.getSearchTrackMix' | 'song.getSmartRadio' =
        'song.getSearchTrackMix'
      let payload: Record<string, string> = {
        sng_id: query,
        start_with_input_track: 'true'
      }

      if (query.startsWith('artist=')) {
        const artistId = query.slice('artist='.length).trim()
        if (!artistId) return { loadType: 'empty', data: {} }
        method = 'song.getSmartRadio'
        payload = { art_id: artistId }
      } else if (query.startsWith('track=')) {
        const trackId = query.slice('track='.length).trim()
        if (!trackId) return { loadType: 'empty', data: {} }
        payload = { sng_id: trackId, start_with_input_track: 'true' }
      } else if (!/^\d+$/.test(query)) {
        const searchResult = await this.search(query, 'dzsearch', 'track')
        const tracks = this.extractTrackData(searchResult)
        const firstTrack = tracks[0]
        if (!firstTrack) return { loadType: 'empty', data: {} }
        payload = {
          sng_id: firstTrack.info.identifier,
          start_with_input_track: 'true'
        }
      }

      const { body, error } = await makeRequest(
        `https://www.deezer.com/ajax/gw-light.php?method=${method}&input=3&api_version=1.0&api_token=${this.csrfToken}`,
        {
          method: 'POST',
          headers: { Cookie: this.cookie },
          body: payload,
          disableBodyCompression: true
        }
      )
      const response =
        this.getJsonBody<DeezerGatewayListResponse<DeezerRecommendationItem>>(
          body
        )

      if (error) return this.createException(error, 'fault')

      const items = response?.results?.data
      if (!Array.isArray(items) || items.length === 0) {
        return { loadType: 'empty', data: {} }
      }

      const tracks = items
        .map((item) => this.buildRecommendationTrack(item))
        .filter((track): track is DeezerTrackData => track !== null)

      if (tracks.length === 0) return { loadType: 'empty', data: {} }

      const playlist: DeezerPlaylistData = {
        info: { name: 'Deezer Recommendations', selectedTrack: 0 },
        pluginInfo: { type: 'recommendations' },
        tracks
      }

      return { loadType: 'playlist', data: playlist }
    } catch (error) {
      return this.createException(this.getErrorMessage(error), 'fault')
    }
  }

  /**
   * Resolves Deezer track, album, playlist, and artist URLs.
   *
   * @param url Candidate Deezer URL.
   * @returns Track or playlist-style payload, an empty payload, or a
   * structured exception.
   */
  public async resolve(url: string): Promise<SourceResult> {
    if (url.includes('link.deezer.com')) {
      const response = await http1makeRequest(url, { method: 'GET' })
      const resolvedBody = this.getTextBody(response.body)
      const match = resolvedBody?.match(
        /\/(track|album|playlist|artist)\/(\d+)/
      )

      if (!match) return { loadType: 'empty', data: {} }
      return this.resolve(`https://www.deezer.com/${match[1]}/${match[2]}`)
    }

    const match = this.patterns[0]?.exec(url)
    if (!match) return { loadType: 'empty', data: {} }

    const type = match[1]
    const id = match[2]
    if (!type || !id || !this.isSearchType(type)) {
      return { loadType: 'empty', data: {} }
    }
    const { body, error } = await makeRequest(
      `https://api.deezer.com/2.0/${type}/${id}`,
      { method: 'GET' }
    )
    const entity = this.getJsonBody<DeezerEntity>(body)

    if (error || entity?.error) {
      if (entity?.error?.code === 800) {
        return { loadType: 'empty', data: {} }
      }

      return this.createException(
        error ?? entity?.error?.message ?? 'Failed to resolve Deezer URL.',
        'fault'
      )
    }

    if (!entity) return { loadType: 'empty', data: {} }

    switch (type) {
      case 'track': {
        const track = this.buildTrack(entity)
        return track
          ? { loadType: 'track', data: track }
          : { loadType: 'empty', data: {} }
      }
      case 'album':
      case 'playlist': {
        if (!entity.tracklist) {
          return this.createException(
            'Could not fetch playlist tracks.',
            'common'
          )
        }

        const { body: tracksBody, error: tracksError } = await makeRequest(
          `${entity.tracklist}?limit=${this.getMaxCollectionLength(1000)}`,
          { method: 'GET' }
        )
        const tracksResponse =
          this.getJsonBody<DeezerListResponse<DeezerEntity>>(tracksBody)

        if (
          tracksError ||
          !Array.isArray(tracksResponse?.data) ||
          tracksResponse.data.length === 0
        ) {
          return this.createException(
            tracksError ?? 'Could not fetch playlist tracks.',
            'common'
          )
        }

        const artworkUrl = entity.cover_xl ?? entity.picture_xl ?? null
        const tracks = tracksResponse.data
          .map((item) => this.buildTrack(item, artworkUrl))
          .filter((track): track is DeezerTrackData => track !== null)

        if (tracks.length === 0) return { loadType: 'empty', data: {} }

        return {
          loadType: 'playlist',
          data: {
            info: {
              name: entity.title ?? 'Unknown Deezer Collection',
              selectedTrack: 0
            },
            pluginInfo: {} as Record<string, unknown>,
            tracks
          } satisfies DeezerPlaylistData
        }
      }
      case 'artist': {
        const { body: topTracksBody, error: topTracksError } =
          await makeRequest(
            `https://api.deezer.com/2.0/artist/${id}/top?limit=${this.getMaxCollectionLength(25)}`,
            { method: 'GET' }
          )
        const topTracksResponse =
          this.getJsonBody<DeezerListResponse<DeezerEntity>>(topTracksBody)

        if (topTracksError || topTracksResponse?.error) {
          return this.createException(
            topTracksError ??
              topTracksResponse?.error?.message ??
              'Failed to fetch Deezer artist top tracks.',
            'common'
          )
        }

        const tracks = (topTracksResponse?.data ?? [])
          .map((item) => this.buildTrack(item, entity.picture_xl ?? null))
          .filter((track): track is DeezerTrackData => track !== null)

        if (tracks.length === 0) return { loadType: 'empty', data: {} }

        return {
          loadType: 'artist',
          data: {
            info: {
              name: `${entity.name ?? 'Unknown Artist'}'s Top Tracks`,
              selectedTrack: 0
            },
            pluginInfo: {} as Record<string, unknown>,
            tracks
          } satisfies DeezerPlaylistData
        }
      }
    }
  }

  /**
   * Resolves a direct Deezer stream URL and falls back to delegated search when
   * the direct media path is unavailable.
   *
   * @param decodedTrack Decoded Deezer track metadata.
   * @param _itag Unused format selector kept for source-manager compatibility.
   * @param forceRefresh When `true`, bypasses the track-url cache.
   * @returns Direct stream metadata, delegated fallback metadata, or a
   * structured exception.
   */
  public async getTrackUrl(
    decodedTrack: TrackInfo,
    _itag?: number,
    forceRefresh = false
  ): Promise<TrackUrlResult | SourceResult> {
    const cacheManager = this.nodelink.trackCacheManager
    if (!forceRefresh) {
      const cached = cacheManager?.get<DeezerTrackUrlSuccess>(
        'deezer',
        decodedTrack.identifier
      )
      if (cached) return cached
    }

    if (this.cookie && this.csrfToken && this.licenseToken) {
      try {
        const { body: trackBody, error: trackError } = await makeRequest(
          `https://www.deezer.com/ajax/gw-light.php?method=song.getListData&input=3&api_version=1.0&api_token=${this.csrfToken}`,
          {
            method: 'POST',
            headers: { Cookie: this.cookie },
            body: { sng_ids: [decodedTrack.identifier] },
            disableBodyCompression: true
          }
        )
        const trackResponse =
          this.getJsonBody<DeezerGatewayListResponse<DeezerGatewayTrackData>>(
            trackBody
          )
        const gatewayError = this.getGatewayErrorMessage(trackResponse?.error)

        if (trackError || gatewayError) {
          throw new Error(
            trackError ?? gatewayError ?? 'Deezer gateway failed.'
          )
        }

        const trackInfo = trackResponse?.results?.data?.[0]
        if (!trackInfo?.TRACK_TOKEN) {
          throw new Error('Deezer track token was not found.')
        }

        const { body: streamBody, error: streamError } = await makeRequest(
          'https://media.deezer.com/v1/get_url',
          {
            method: 'POST',
            body: {
              license_token: this.licenseToken,
              media: [
                {
                  type: 'FULL',
                  formats: [
                    { cipher: 'BF_CBC_STRIPE', format: 'FLAC' },
                    { cipher: 'BF_CBC_STRIPE', format: 'MP3_256' },
                    { cipher: 'BF_CBC_STRIPE', format: 'MP3_128' },
                    { cipher: 'BF_CBC_STRIPE', format: 'MP3_MISC' }
                  ]
                }
              ],
              track_tokens: [trackInfo.TRACK_TOKEN]
            },
            disableBodyCompression: true
          }
        )
        const streamResponse = this.getJsonBody<DeezerMediaResponse>(streamBody)

        if (streamError) throw new Error(streamError)

        const media = streamResponse?.data?.[0]?.media?.[0]
        const streamUrl = media?.sources?.[0]?.url
        if (media?.format && streamUrl) {
          const result: DeezerTrackUrlSuccess = {
            url: streamUrl,
            protocol: 'https',
            format: media.format.startsWith('MP3') ? 'mp3' : 'flac',
            additionalData: { ...trackInfo }
          }

          cacheManager?.set(
            'deezer',
            decodedTrack.identifier,
            result,
            TRACK_CACHE_TTL_MS
          )
          return result
        }
      } catch (error) {
        const errMsg = this.getErrorMessage(error)
        if (
          errMsg.toLowerCase().includes('csrf') &&
          !forceRefresh
        ) {
          logger(
            'warn',
            'Deezer',
            `CSRF token expired (${errMsg}). Evicting cache and refreshing credentials...`
          )
          const cm = this.nodelink.credentialManager
          cm?.delete?.('deezer_csrf_token')
          cm?.delete?.('deezer_license_token')
          cm?.delete?.('deezer_cookie')
          this.csrfToken = null
          this.licenseToken = null
          this.cookie = null
          const success = await this.performSetup()
          if (success && this.cookie && this.csrfToken && this.licenseToken) {
            logger(
              'info',
              'Deezer',
              'Credentials refreshed. Retrying direct stream...'
            )
            return this.getTrackUrl(decodedTrack, _itag, true)
          }
          logger(
            'warn',
            'Deezer',
            'Failed to refresh credentials. Falling back to search.'
          )
        } else {
          logger(
            'warn',
            'Deezer',
            `Direct stream failed for ${decodedTrack.title}: ${errMsg}. Falling back to default search.`
          )
        }
      }
    }

    const sourceManager = this.getSourceManager()
    if (!sourceManager) {
      return this.createException(
        'No source manager is available for fallback resolution.',
        'fault',
        'StreamLink'
      )
    }

    const query = `${decodedTrack.title} ${decodedTrack.author}`
    let searchResult = await sourceManager.searchWithDefault(
      decodedTrack.isrc ? `"${decodedTrack.isrc}"` : query
    )

    if (this.extractTrackData(searchResult).length === 0) {
      searchResult = await sourceManager.searchWithDefault(query)
    }

    const candidates = this.extractTrackData(searchResult)
    const bestMatch = getBestMatch(
      candidates,
      decodedTrack
    ) as DeezerTrackData | null

    if (!bestMatch) {
      return this.createException(
        'No suitable alternative found.',
        'fault',
        'StreamLink'
      )
    }

    const streamInfo = await sourceManager.getTrackUrl(bestMatch.info)
    return { newTrack: bestMatch, ...streamInfo }
  }

  /**
   * Opens and decrypts Deezer direct streams with explicit listener cleanup.
   *
   * The rewritten implementation also tears down upstream listeners when the
   * downstream stream closes or errors, which avoids leaking listeners across
   * interrupted playback attempts.
   *
   * @param decodedTrack Decoded Deezer track metadata being played.
   * @param url Direct encrypted stream URL returned by `getTrackUrl(...)`.
   * @param _format Unused direct-stream format hint.
   * @param additionalData Deezer gateway metadata cached during URL resolution.
   * @returns Decrypted stream payload, or a structured exception.
   */
  public async loadStream(
    decodedTrack: TrackInfo,
    url: string,
    _format?: string,
    additionalData?: TrackUrlResult['additionalData']
  ): Promise<TrackStreamResult | SourceResult> {
    try {
      const streamData = this.getAdditionalData(additionalData)
      if (!streamData.SNG_ID) {
        return this.createException(
          'Deezer stream metadata is missing the song identifier.',
          'fault'
        )
      }

      const outputStream = new PassThrough()
      const trackKey = this.calculateKey(streamData.SNG_ID)
      const headers: HttpRequestHeaders & { Range?: string } = {}
      const bufferSize = 2048
      let chunkIndex = 0
      let remainder = Buffer.alloc(0)

      if (
        typeof streamData.startTime === 'number' &&
        streamData.startTime > 0 &&
        streamData.FILESIZE !== undefined &&
        streamData.DURATION !== undefined
      ) {
        const durationSeconds = this.toNumber(streamData.DURATION)
        const fileSize = this.toNumber(streamData.FILESIZE)

        if (
          durationSeconds &&
          fileSize &&
          durationSeconds > 0 &&
          fileSize > 0
        ) {
          const byteRate = fileSize / (durationSeconds * 1000)
          const rawOffset = streamData.startTime * byteRate
          const initialChunkIndex = Math.floor(rawOffset / bufferSize)
          const byteOffset = initialChunkIndex * bufferSize

          if (byteOffset > 0) {
            headers.Range = `bytes=${byteOffset}-`
          }
          chunkIndex = initialChunkIndex
        }
      }

      const response = await makeRequest(url, {
        method: 'GET',
        streamOnly: true,
        headers
      })

      if (
        response.error ||
        (response.statusCode !== 200 && response.statusCode !== 206) ||
        !response.stream
      ) {
        const message =
          response.error ??
          `Request failed with status ${response.statusCode ?? 'unknown'}`
        return this.createException(message, 'fault', 'Upstream')
      }

      if (response.statusCode === 200) {
        chunkIndex = 0
      }

      const sourceStream = response.stream as Readable
      const blowfish = new BlowfishCBC(trackKey)
      let cleanedUp = false

      const cleanup = (): void => {
        if (cleanedUp) return
        cleanedUp = true
        sourceStream.removeListener('data', handleData)
        sourceStream.removeListener('end', handleEnd)
        sourceStream.removeListener('error', handleSourceError)
        outputStream.removeListener('close', handleOutputClose)
        outputStream.removeListener('error', handleOutputError)
      }

      const destroySource = (error?: Error): void => {
        if (!sourceStream.destroyed) {
          sourceStream.destroy(error)
        }
      }

      const handleData = (chunk: Buffer): void => {
        try {
          let data = chunk
          if (remainder.length > 0) {
            data = Buffer.concat([remainder, chunk])
            remainder = Buffer.alloc(0)
          }

          let offset = 0
          while (offset + bufferSize <= data.length) {
            const encryptedBlock = data.subarray(offset, offset + bufferSize)
            if (chunkIndex % 3 === 0) {
              blowfish.setIv(IV)
              outputStream.push(Buffer.from(blowfish.decode(encryptedBlock)))
            } else {
              outputStream.push(encryptedBlock)
            }
            chunkIndex++
            offset += bufferSize
          }

          if (offset < data.length) {
            remainder = Buffer.from(data.subarray(offset))
          }
        } catch (error) {
          const streamError =
            error instanceof Error ? error : new Error(String(error))
          cleanup()
          if (!outputStream.destroyed) {
            outputStream.destroy(streamError)
          }
          destroySource(streamError)
        }
      }

      const handleEnd = (): void => {
        cleanup()
        if (remainder.length > 0 && !outputStream.destroyed) {
          outputStream.push(remainder)
          remainder = Buffer.alloc(0)
        }
        if (!outputStream.destroyed) {
          outputStream.emit('finishBuffering')
          outputStream.end()
        }
      }

      const handleSourceError = (error: Error): void => {
        cleanup()
        logger(
          'error',
          'Sources',
          `Error in Deezer source stream for track ${decodedTrack.title}: ${error.message}`
        )
        if (!outputStream.destroyed) {
          outputStream.destroy(error)
        }
      }

      const handleOutputClose = (): void => {
        cleanup()
        destroySource()
      }

      const handleOutputError = (): void => {
        cleanup()
        destroySource()
      }

      sourceStream.on('data', handleData)
      sourceStream.once('end', handleEnd)
      sourceStream.once('error', handleSourceError)
      outputStream.once('close', handleOutputClose)
      outputStream.once('error', handleOutputError)

      return { stream: outputStream }
    } catch (error) {
      logger(
        'error',
        'Sources',
        `Failed to load Deezer stream for ${decodedTrack.identifier}: ${this.getErrorMessage(error)}`
      )
      return this.createException(this.getErrorMessage(error), 'fault')
    }
  }

  /**
   * Performs the Deezer credential bootstrap after setup serialization has
   * been applied.
   *
   * @returns `true` when Deezer gateway credentials were loaded successfully.
   */
  private async performSetup(): Promise<boolean> {
    logger('info', 'Sources', 'Initializing Deezer source...')

    const credentialManager = this.nodelink.credentialManager
    const cachedCsrf = credentialManager?.get<string>('deezer_csrf_token')
    const cachedLicense = credentialManager?.get<string>('deezer_license_token')
    const cachedCookie = credentialManager?.get<string>('deezer_cookie')

    if (cachedCsrf && cachedLicense && cachedCookie) {
      this.csrfToken = cachedCsrf
      this.licenseToken = cachedLicense
      this.cookie = cachedCookie
      logger(
        'info',
        'Sources',
        'Loaded Deezer credentials from CredentialManager.'
      )
      return true
    }

    try {
      const arl = this.config.sources?.deezer?.arl
      const initialCookie =
        typeof arl === 'string' && arl.length > 0 ? `arl=${arl}` : ''

      const response = await http1makeRequest(
        'https://www.deezer.com/ajax/gw-light.php?method=deezer.getUserData&input=3&api_version=1.0&api_token=',
        {
          method: 'GET',
          headers: initialCookie ? { Cookie: initialCookie } : undefined
        }
      )
      const userData = this.getJsonBody<DeezerUserDataResponse>(response.body)

      if (response.error || !userData?.results) {
        throw new Error(response.error ?? 'Failed to fetch Deezer user data.')
      }

      const responseCookies = this.getCookieHeaderValue(response.headers)
      this.cookie = initialCookie
        ? responseCookies
          ? `${initialCookie}; ${responseCookies}`
          : initialCookie
        : responseCookies
      this.csrfToken = userData.results.checkForm ?? null
      this.licenseToken = userData.results.USER?.OPTIONS?.license_token ?? null

      if (!this.cookie || !this.csrfToken || !this.licenseToken) {
        throw new Error('CSRF token, license token, or cookie was missing.')
      }

      credentialManager?.set(
        'deezer_csrf_token',
        this.csrfToken,
        CREDENTIAL_TTL_MS
      )
      credentialManager?.set(
        'deezer_license_token',
        this.licenseToken,
        CREDENTIAL_TTL_MS
      )
      credentialManager?.set('deezer_cookie', this.cookie, CREDENTIAL_TTL_MS)

      logger('info', 'Sources', 'Deezer source setup successfully.')
      return true
    } catch (error) {
      logger(
        'error',
        'Sources',
        `Failed to setup Deezer source: ${this.getErrorMessage(error)}`
      )
      return false
    }
  }

  /**
   * Builds a metadata-only encoded track for album, playlist, and artist
   * search results.
   *
   * @param item Raw Deezer entity returned by the public API.
   * @param type Collection type represented by the entity.
   * @returns Encoded metadata track, or `null` when the entity is incomplete.
   */
  private buildMetadataTrack(
    item: DeezerEntity,
    type: Exclude<DeezerSearchType, 'track'>
  ): DeezerTrackData | null {
    if (item.id === undefined || item.id === null || item.id === '') return null

    const identifier = String(item.id)
    const artworkUrl =
      item.cover_xl ??
      item.cover_big ??
      item.cover_medium ??
      item.picture_xl ??
      item.picture_big ??
      item.picture_medium ??
      null

    const info: DeezerTrackInfo = {
      title:
        type === 'artist'
          ? item.name?.trim() || 'Unknown Artist'
          : item.title?.trim() || 'Unknown Title',
      author:
        type === 'album'
          ? item.artist?.name?.trim() || 'Unknown Artist'
          : type === 'playlist'
            ? item.user?.name?.trim() || item.creator?.name?.trim() || 'Deezer'
            : 'Deezer',
      length: 0,
      identifier,
      isStream: false,
      uri:
        item.link ||
        `https://www.deezer.com/${type}/${encodeURIComponent(identifier)}`,
      artworkUrl,
      isrc: null,
      sourceName: 'deezer',
      position: 0,
      details: [],
      isSeekable: type !== 'artist'
    }

    const pluginInfo: DeezerTrackPluginInfo = { type }
    if (typeof item.nb_tracks === 'number') {
      pluginInfo.trackCount = item.nb_tracks
    }

    return { encoded: encodeTrack(info), info, pluginInfo }
  }

  /**
   * Converts a raw Deezer track payload into an encoded track object.
   *
   * @param item Raw Deezer track metadata.
   * @param artworkUrl Optional artwork override used by playlist and artist
   * resolution paths.
   * @returns Encoded Deezer track, or `null` when the input is incomplete.
   */
  private buildTrack(
    item: DeezerEntity,
    artworkUrl: string | null = null
  ): DeezerTrackData | null {
    if (item.id === undefined || item.id === null || item.id === '') return null

    const trackInfo: DeezerTrackInfo = {
      identifier: String(item.id),
      isSeekable: true,
      author: item.artist?.name?.trim() || 'Unknown Artist',
      length: this.toMilliseconds(item.duration),
      isStream: false,
      position: 0,
      title: item.title?.trim() || 'Unknown Title',
      uri:
        item.link ||
        `https://www.deezer.com/track/${encodeURIComponent(String(item.id))}`,
      artworkUrl:
        artworkUrl ??
        item.album?.cover_xl ??
        item.album?.cover_big ??
        item.album?.cover_medium ??
        null,
      isrc: item.isrc ?? null,
      sourceName: 'deezer',
      details: []
    }

    const pluginInfo: DeezerTrackPluginInfo = {}
    if (item.album?.title?.trim())
      pluginInfo.albumName = item.album.title.trim()
    if (
      item.album?.id !== undefined &&
      item.album.id !== null &&
      item.album.id !== ''
    ) {
      pluginInfo.albumUrl = `https://www.deezer.com/album/${item.album.id}`
    }
    if (
      item.artist?.id !== undefined &&
      item.artist.id !== null &&
      item.artist.id !== ''
    ) {
      pluginInfo.artistUrl = `https://www.deezer.com/artist/${item.artist.id}`
    }
    if (item.artist?.picture_xl)
      pluginInfo.artistArtworkUrl = item.artist.picture_xl
    if (item.preview) pluginInfo.previewUrl = item.preview

    return { encoded: encodeTrack(trackInfo), info: trackInfo, pluginInfo }
  }

  /**
   * Converts a Deezer recommendation item into an encoded track payload.
   *
   * @param item Raw recommendation item returned by the gateway API.
   * @returns Encoded recommendation track, or `null` when required fields are
   * missing.
   */
  private buildRecommendationTrack(
    item: DeezerRecommendationItem
  ): DeezerTrackData | null {
    if (item.SNG_ID === undefined || item.SNG_ID === null) return null

    const info: DeezerTrackInfo = {
      identifier: String(item.SNG_ID),
      isSeekable: true,
      author: item.ART_NAME?.trim() || 'Unknown Artist',
      length: this.toMilliseconds(item.DURATION),
      isStream: false,
      position: 0,
      title: item.SNG_TITLE?.trim() || 'Unknown Title',
      uri: `https://www.deezer.com/track/${item.SNG_ID}`,
      artworkUrl: item.ALB_PICTURE
        ? `https://e-cdns-images.dzcdn.net/images/cover/${item.ALB_PICTURE}/1000x1000-000000-80-0-0.jpg`
        : null,
      isrc: item.ISRC ?? null,
      sourceName: 'deezer',
      details: []
    }

    return {
      encoded: encodeTrack(info),
      info,
      pluginInfo: {} as Record<string, unknown>
    }
  }

  /**
   * Extracts and normalizes an ISRC from a free-text query.
   *
   * @param input Candidate query text.
   * @returns Uppercase ISRC without separators, or `null` when absent.
   */
  private extractIsrc(input: string): string | null {
    const match = input.trim().match(ISRC_REGEX)
    return match?.[1] ? match[1].replace(/-/g, '').toUpperCase() : null
  }

  /**
   * Resolves a Deezer track directly by ISRC.
   *
   * @param isrc Normalized ISRC value.
   * @returns Deezer track metadata, or `null` when the ISRC is not found.
   */
  private async fetchTrackByIsrc(isrc: string): Promise<DeezerEntity | null> {
    const { body, error } = await makeRequest(
      `https://api.deezer.com/2.0/track/isrc:${isrc}`,
      { method: 'GET' }
    )
    const track = this.getJsonBody<DeezerEntity>(body)

    if (error || track?.error) {
      if (track?.error?.code === 800) return null
      throw new Error(
        error ?? track?.error?.message ?? 'Failed to fetch track by ISRC.'
      )
    }

    return track
  }

  /**
   * Checks whether a raw string is one of Deezer's supported search types.
   *
   * @param value Candidate search type.
   * @returns `true` when the string is a supported search type.
   */
  private isSearchType(value: string): value is DeezerSearchType {
    return (
      value === 'track' ||
      value === 'album' ||
      value === 'playlist' ||
      value === 'artist'
    )
  }

  /**
   * Narrows a raw HTTP body into an object-like JSON payload.
   *
   * @param body Raw body returned by the shared HTTP helpers.
   * @returns Typed payload, or `null` when the body is not object-like.
   */
  private getJsonBody<T>(body: HttpRequestResult['body']): T | null {
    if (
      body === null ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Buffer.isBuffer(body)
    ) {
      return null
    }

    return body as T
  }

  /**
   * Converts a raw HTTP body into text when possible.
   *
   * @param body Raw body returned by the shared HTTP helpers.
   * @returns Text body, or `null` when the payload is not text-like.
   */
  private getTextBody(body: HttpRequestResult['body']): string | null {
    if (typeof body === 'string') return body
    if (Buffer.isBuffer(body)) return body.toString('utf8')
    return null
  }

  /**
   * Normalizes `set-cookie` response headers into a single cookie string.
   *
   * @param headers Response headers returned by the HTTP helper.
   * @returns Joined cookie header value, or an empty string when absent.
   */
  private getCookieHeaderValue(
    headers: HttpResponseHeaders | undefined
  ): string {
    const setCookie = headers?.['set-cookie']
    if (Array.isArray(setCookie)) return setCookie.join('; ')
    return typeof setCookie === 'string' ? setCookie : ''
  }

  /**
   * Converts Deezer gateway error payloads into a readable error string.
   *
   * @param errorPayload Raw gateway error payload.
   * @returns Human-readable message, or `null` when the payload is empty.
   */
  private getGatewayErrorMessage(
    errorPayload: DeezerGatewayListResponse<unknown>['error']
  ): string | null {
    if (!errorPayload) return null
    if (typeof errorPayload === 'string') return errorPayload || null
    if (Array.isArray(errorPayload)) {
      const messages = errorPayload.filter(
        (value): value is string =>
          typeof value === 'string' && value.length > 0
      )
      return messages.length > 0 ? messages.join('; ') : null
    }

    const values = Object.values(errorPayload).filter(
      (value): value is string => typeof value === 'string' && value.length > 0
    )
    return values.length > 0 ? values.join('; ') : null
  }

  /**
   * Narrows cached additional stream metadata to the fields used by Deezer.
   *
   * @param value Additional data attached to a resolved track URL.
   * @returns Normalized Deezer gateway track metadata.
   */
  private getAdditionalData(
    value: TrackUrlResult['additionalData']
  ): DeezerGatewayTrackData {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

    const data = value as DeezerGatewayTrackData
    return {
      SNG_ID:
        typeof data.SNG_ID === 'string' || typeof data.SNG_ID === 'number'
          ? data.SNG_ID
          : undefined,
      TRACK_TOKEN:
        typeof data.TRACK_TOKEN === 'string' ? data.TRACK_TOKEN : undefined,
      FILESIZE:
        typeof data.FILESIZE === 'string' || typeof data.FILESIZE === 'number'
          ? data.FILESIZE
          : undefined,
      DURATION:
        typeof data.DURATION === 'string' || typeof data.DURATION === 'number'
          ? data.DURATION
          : undefined,
      startTime: typeof data.startTime === 'number' ? data.startTime : undefined
    }
  }

  /**
   * Extracts encoded track candidates from a generic source result.
   *
   * @param result Source result returned by a search flow.
   * @returns Deezer-compatible track candidates for best-match scoring.
   */
  private extractTrackData(result: SourceResult): DeezerTrackData[] {
    if (result.loadType !== 'search' || !Array.isArray(result.data)) return []
    return result.data.filter((item): item is DeezerTrackData =>
      this.isTrackData(item)
    )
  }

  /**
   * Checks whether an unknown value exposes a valid encoded track shape.
   *
   * @param value Candidate search result item.
   * @returns `true` when the value is a usable encoded track payload.
   */
  private isTrackData(value: unknown): value is DeezerTrackData {
    if (!value || typeof value !== 'object') return false

    const record = value as {
      encoded?: unknown
      info?: Partial<TrackInfo>
    }

    return (
      typeof record.encoded === 'string' &&
      typeof record.info?.identifier === 'string' &&
      typeof record.info.title === 'string' &&
      typeof record.info.author === 'string' &&
      typeof record.info.length === 'number' &&
      typeof record.info.uri === 'string' &&
      typeof record.info.sourceName === 'string'
    )
  }

  /**
   * Returns the source manager narrowed to the fallback methods used here.
   *
   * @returns Narrowed source manager, or `null` when unavailable.
   */
  private getSourceManager(): DeezerSourceManager | null {
    const sourceManager = this.nodelink.sources as
      | DeezerSourceManager
      | undefined
    return sourceManager ?? null
  }

  /**
   * Creates a standardized exception payload for Deezer operations.
   *
   * @param message Human-readable failure message.
   * @param severity Source-defined error severity.
   * @param cause Optional failure origin.
   * @returns Structured exception payload.
   */
  private createException(
    message: string,
    severity: string,
    cause?: string
  ): SourceResult {
    return { loadType: 'error', exception: { message, severity, cause } }
  }

  /**
   * Converts an unknown thrown value into a readable message string.
   *
   * @param error Unknown runtime failure.
   * @returns Human-readable error message.
   */
  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  /**
   * Converts a numeric-like seconds value into milliseconds.
   *
   * @param value Numeric-like duration expressed in seconds.
   * @returns Duration in milliseconds, or `0` when unavailable.
   */
  private toMilliseconds(value: number | string | undefined): number {
    const numericValue = this.toNumber(value)
    return numericValue ? numericValue * 1000 : 0
  }

  /**
   * Converts a numeric-like value into a finite number.
   *
   * @param value Candidate numeric value.
   * @returns Finite number, or `null` when the value is invalid.
   */
  private toNumber(value: number | string | undefined): number | null {
    if (value === undefined || value === null || value === '') return null
    const numericValue = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(numericValue) ? numericValue : null
  }

  /**
   * Returns the configured Deezer search-result limit.
   *
   * @returns Maximum number of search results to return.
   */
  private getMaxSearchResults(): number {
    const limit = this.config.search?.maxResults
    return typeof limit === 'number' && limit > 0 ? limit : 10
  }

  /**
   * Returns the configured collection-size limit, or the supplied fallback.
   *
   * @param fallback Default limit used when the config does not define one.
   * @returns Maximum collection length for albums, playlists, or artists.
   */
  private getMaxCollectionLength(fallback: number): number {
    const limit = this.config.playback?.maxPlaylistLength
    return typeof limit === 'number' && limit > 0 ? limit : fallback
  }

  /**
   * Computes the Blowfish decryption key for a Deezer song identifier.
   *
   * @param songId Deezer song identifier.
   * @returns Raw 16-byte Blowfish key.
   */
  private calculateKey(songId: number | string): Buffer {
    const key = this.config.sources?.deezer?.decryptionKey
    if (typeof key !== 'string' || key.length !== 16) {
      throw new Error(
        'A valid 16-character Deezer decryptionKey is not provided in the configuration.'
      )
    }

    const songIdHash = crypto
      .createHash('md5')
      .update(String(songId), 'ascii')
      .digest('hex')
    const trackKey = Buffer.alloc(16)

    for (let index = 0; index < 16; index++) {
      trackKey[index] =
        songIdHash.charCodeAt(index) ^
        songIdHash.charCodeAt(index + 16) ^
        key.charCodeAt(index)
    }

    return trackKey
  }
}
