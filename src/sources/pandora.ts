/**
 * Pandora music source implementation.
 * Provides search, playlist, station, artist, and podcast resolution.
 * @module sources/pandora
 */

import type {
  PandoraAnnotateResponse,
  PandoraApiError,
  PandoraArtistGraphQLResponse,
  PandoraAuthResponse,
  PandoraCatalogDetailsResponse,
  PandoraCsrfToken,
  PandoraPlaylistResponse,
  PandoraPodcastDetails,
  PandoraPodcastEpisodesResponse,
  PandoraRemoteTokenResponse,
  PandoraSearchResult,
  PandoraSourceConfig,
  PandoraStationDetails,
  PandoraStationPlaylistResponse,
  PandoraTrackAnnotation,
  PandoraTrackData,
  PandoraTrackInfo
} from '../typings/sources/pandora.types.ts'
import type {
  SourceInstance,
  SourceResult,
  TrackInfo,
  TrackStreamResult,
  TrackUrlResult,
  WorkerNodeLink
} from '../typings/sources/source.types.ts'
import type { TrackEncodeInput } from '../typings/utils.types.ts'
import {
  encodeTrack,
  getBestMatch,
  http1makeRequest,
  logger,
  makeRequest
} from '../utils.ts'

/**
 * Default credential cache TTL (24 hours).
 * @internal
 */
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Pandora content image CDN base URL.
 * @internal
 */
const PANDORA_CDN_BASE = 'https://content-images.p-cdn.com/'

/**
 * Pandora web base URL.
 * @internal
 */
const PANDORA_BASE_URL = 'https://www.pandora.com'

/**
 * Pandora music source.
 * Integrates with the Pandora web API for search, playlists, stations, artists, and podcasts.
 * @public
 */
export default class PandoraSource implements SourceInstance {
  /**
   * Runtime NodeLink context.
   * @internal
   */
  private readonly nodelink: WorkerNodeLink

  /**
   * Pandora source configuration.
   * @internal
   */
  private readonly config: PandoraSourceConfig

  /**
   * NodeLink options reference.
   * @internal
   */
  private readonly options: WorkerNodeLink['options']

  /**
   * Search aliases handled by this source.
   * @public
   */
  public readonly searchTerms: string[] = ['pdsearch']

  /**
   * URL patterns handled by this source.
   * @public
   */
  public readonly patterns: RegExp[] = [
    /^https?:\/\/(?:www\.)?pandora\.com\/(?:playlist|station|podcast|artist)\/.+/
  ]

  /**
   * URL resolution priority.
   * @public
   */
  public readonly priority: number = 80

  /**
   * Pre-configured CSRF token from config.
   * @internal
   */
  private readonly csrfTokenConfig: string | null

  /**
   * Active CSRF token.
   * @internal
   */
  private csrfToken: PandoraCsrfToken | null = null

  /**
   * Active authentication token.
   * @internal
   */
  private authToken: string | null = null

  /**
   * Setup promise to prevent duplicate initialization.
   * @internal
   */
  private setupPromise: Promise<boolean> | null = null

  /**
   * Constructs a new PandoraSource instance.
   * @param nodelink - The worker NodeLink context.
   */
  constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
    this.options = nodelink.options
    this.config = (nodelink.options.sources?.pandora ??
      {}) as PandoraSourceConfig
    this.csrfTokenConfig = this.config.csrfToken ?? null
  }

  /**
   * Initializes the Pandora source by obtaining authentication tokens.
   * @returns Promise resolving to true if setup succeeded.
   * @public
   */
  public async setup(): Promise<boolean> {
    if (this.authToken) return true
    if (this.setupPromise) return this.setupPromise

    this.setupPromise = this.performSetup()
    return this.setupPromise
  }

  /**
   * Performs the actual setup logic.
   * @returns Promise resolving to true if setup succeeded.
   * @internal
   */
  private async performSetup(): Promise<boolean> {
    try {
      const credMgr = this.nodelink.credentialManager
      if (credMgr) {
        const cachedAuth = credMgr.get('pandora_auth_token') as
          | string
          | undefined
        const cachedCsrf = credMgr.get('pandora_csrf_token') as
          | PandoraCsrfToken
          | undefined

        if (cachedAuth && cachedCsrf) {
          this.authToken = cachedAuth
          this.csrfToken = cachedCsrf
          logger(
            'info',
            'Pandora',
            'Loaded Pandora credentials from CredentialManager.'
          )
          return true
        }
      }

      logger('debug', 'Pandora', 'Setting Pandora auth and CSRF token.')

      if (await this.tryRemoteTokenProvider()) {
        return true
      }

      if (!(await this.initializeCsrfToken())) {
        return false
      }

      if (!(await this.performAnonymousLogin())) {
        return false
      }

      this.cacheCredentials(DEFAULT_CACHE_TTL_MS)
      logger('info', 'Pandora', 'Successfully set Pandora auth and CSRF token.')
      return true
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger('error', 'Pandora', `Setup failed: ${message}`)
      return false
    } finally {
      this.setupPromise = null
    }
  }

  /**
   * Attempts to fetch tokens from a remote provider.
   * @returns Promise resolving to true if remote tokens were obtained.
   * @internal
   */
  private async tryRemoteTokenProvider(): Promise<boolean> {
    const remoteUrl = this.config.remoteTokenUrl
    if (!remoteUrl) return false

    logger(
      'info',
      'Pandora',
      `Fetching tokens from remote provider: ${remoteUrl}`
    )

    try {
      const response = await makeRequest(remoteUrl, { method: 'GET' })
      const body = response.body as PandoraRemoteTokenResponse | undefined

      if (
        !response.error &&
        response.statusCode === 200 &&
        body?.success &&
        body.authToken &&
        body.csrfToken
      ) {
        this.authToken = body.authToken
        this.csrfToken = {
          raw: `csrftoken=${body.csrfToken};Path=/;Domain=.pandora.com;Secure`,
          parsed: body.csrfToken
        }

        const cacheTtlMs = (body.expires_in_seconds ?? 3600) * 1000
        this.cacheCredentials(cacheTtlMs)

        logger(
          'info',
          'Pandora',
          'Successfully initialized with remote tokens (bypass active).'
        )
        return true
      }

      logger(
        'warn',
        'Pandora',
        `Remote provider failed (Status: ${response.statusCode}). Falling back to local login.`
      )
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger(
        'warn',
        'Pandora',
        `Exception during remote token fetch: ${message}. Falling back to local login.`
      )
    }

    return false
  }

  /**
   * Initializes the CSRF token from config or Pandora website.
   * @returns Promise resolving to true if CSRF token was obtained.
   * @internal
   */
  private async initializeCsrfToken(): Promise<boolean> {
    if (this.csrfTokenConfig) {
      this.csrfToken = {
        raw: `csrftoken=${this.csrfTokenConfig};Path=/;Domain=.pandora.com;Secure`,
        parsed: this.csrfTokenConfig
      }
      return true
    }

    const response = await makeRequest(PANDORA_BASE_URL, { method: 'HEAD' })

    if (response.error) {
      logger('error', 'Pandora', 'Failed to set CSRF token from Pandora.')
      return false
    }

    const cookies = response.headers?.['set-cookie'] as string[] | undefined
    const csrfCookie = cookies?.find((cookie) =>
      cookie.startsWith('csrftoken=')
    )

    if (!csrfCookie) {
      logger('error', 'Pandora', 'Failed to find CSRF token cookie.')
      return false
    }

    const csrfMatch = /csrftoken=([a-f0-9]{16})/.exec(csrfCookie)
    if (!csrfMatch?.[1]) {
      logger('error', 'Pandora', 'Failed to parse CSRF token.')
      return false
    }

    this.csrfToken = {
      raw: csrfCookie.split(';')[0] ?? '',
      parsed: csrfMatch[1]
    }

    return true
  }

  /**
   * Performs anonymous login to obtain auth token.
   * @returns Promise resolving to true if login succeeded.
   * @internal
   */
  private async performAnonymousLogin(): Promise<boolean> {
    if (!this.csrfToken) return false

    const response = await makeRequest(
      `${PANDORA_BASE_URL}/api/v1/auth/anonymousLogin`,
      {
        headers: {
          Cookie: this.csrfToken.raw,
          'Content-Type': 'application/json',
          Accept: '*/*',
          'X-CsrfToken': this.csrfToken.parsed
        },
        method: 'POST'
      }
    )

    const body = response.body as PandoraAuthResponse | undefined

    if (response.error || body?.errorCode === 0) {
      logger('error', 'Pandora', 'Failed to set auth token from Pandora.')
      return false
    }

    this.authToken = body?.authToken ?? null
    return this.authToken !== null
  }

  /**
   * Caches credentials in the credential manager.
   * @param ttlMs - Time to live in milliseconds.
   * @internal
   */
  private cacheCredentials(ttlMs: number): void {
    const credMgr = this.nodelink.credentialManager
    if (!credMgr) return

    if (this.authToken) {
      credMgr.set('pandora_auth_token', this.authToken, ttlMs)
    }
    if (this.csrfToken) {
      credMgr.set('pandora_csrf_token', this.csrfToken, ttlMs)
    }
  }

  /**
   * Searches for tracks on Pandora.
   * @param query - Search query string.
   * @returns Promise resolving to search results.
   * @public
   */
  public async search(query: string): Promise<SourceResult> {
    const authError = await this.ensureAuth()
    if (authError) return authError

    logger('debug', 'Pandora', `Searching for: ${query}`)

    const body = {
      query,
      types: ['TR'],
      listener: null,
      start: 0,
      count: this.options.search.maxResults ?? 10,
      annotate: true,
      searchTime: 0,
      annotationRecipe: 'CLASS_OF_2019'
    }

    const response = await makeRequest(
      `${PANDORA_BASE_URL}/api/v3/sod/search`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: '*/*'
        },
        body,
        disableBodyCompression: true
      }
    )

    if (response.error) {
      return this.buildException(response.error)
    }

    const data = response.body as PandoraSearchResult | undefined
    if (!data?.results || data.results.length === 0) {
      return { loadType: 'empty', data: {} }
    }

    const tracks: PandoraTrackData[] = []
    const annotations = data.annotations ?? {}

    for (const key of Object.keys(annotations)) {
      const item = annotations[key]
      if (item?.type === 'TR') {
        tracks.push(this.buildTrack(item))
      }
    }

    return { loadType: 'search', data: tracks }
  }

  /**
   * Resolves a Pandora URL to track/playlist data.
   * @param url - The Pandora URL to resolve.
   * @returns Promise resolving to the resolved content.
   * @public
   */
  public async resolve(url: string): Promise<SourceResult> {
    const authError = await this.ensureAuth()
    if (authError) return authError

    const typeMatch =
      /^(https:\/\/www\.pandora\.com\/)((playlist)|(station)|(podcast)|(artist))\/.+/.exec(
        url
      )

    if (!typeMatch) {
      return { loadType: 'empty', data: {} }
    }

    const type = typeMatch[2]
    const lastPart = url.split('/').pop() ?? ''

    logger('debug', 'Pandora', `Resolving ${type} with ID: ${lastPart}`)

    switch (type) {
      case 'artist':
        return this.resolveArtist(lastPart)
      case 'playlist':
        return this.resolvePlaylist(lastPart)
      case 'station':
        return this.resolveStation(lastPart)
      case 'podcast':
        return this.resolvePodcast(lastPart)
      default:
        return { loadType: 'empty', data: {} }
    }
  }

  /**
   * Ensures authentication is available.
   * @returns Null if authenticated, exception result otherwise.
   * @internal
   */
  private async ensureAuth(): Promise<SourceResult | null> {
    if (!this.authToken) {
      await this.setup()
    }

    if (!this.authToken) {
      return {
        loadType: 'error',
        exception: {
          message: 'Pandora source is not available.',
          severity: 'common',
          cause: 'Auth Failed'
        }
      }
    }

    return null
  }

  /**
   * Builds an exception result.
   * @param error - Error object or undefined.
   * @param data - Additional data with message.
   * @returns SourceResult with exception.
   * @internal
   */
  private buildException(
    error?: string | { message?: string } | null,
    data?: PandoraApiError | null
  ): SourceResult {
    const errorMessage =
      typeof error === 'string' ? error : (error?.message ?? null)

    return {
      loadType: 'error',
      exception: {
        message: errorMessage ?? data?.message ?? 'Unknown error',
        severity: 'common'
      }
    }
  }

  /**
   * Builds request headers for Pandora API.
   * @returns Headers object.
   * @internal
   */
  private getHeaders(): Record<string, string> {
    return {
      Cookie: this.csrfToken?.raw ?? '',
      'X-CsrfToken': this.csrfToken?.parsed ?? '',
      'X-AuthToken': this.authToken ?? '',
      'Content-Type': 'application/json'
    }
  }

  /**
   * Builds a full artwork URL.
   * @param artwork - Partial or full artwork URL.
   * @returns Full artwork URL or null.
   * @internal
   */
  private buildArtworkUrl(artwork?: string | null): string | null {
    if (!artwork) return null
    return artwork.startsWith('http')
      ? artwork
      : `${PANDORA_CDN_BASE}${artwork}`
  }

  /**
   * Builds a full URI from a shareable path.
   * @param shareableUrlPath - Partial or full URL path.
   * @returns Full URI.
   * @internal
   */
  private buildUri(shareableUrlPath?: string | null): string {
    if (!shareableUrlPath) return ''
    return shareableUrlPath.startsWith('http')
      ? shareableUrlPath
      : `${PANDORA_BASE_URL}${shareableUrlPath}`
  }

  /**
   * Limits array to specified length.
   * @param arr - Array to limit.
   * @param limit - Maximum length.
   * @returns Limited array.
   * @internal
   */
  private limitArray<T>(arr: T[], limit: number): T[] {
    return arr.length > limit ? arr.slice(0, limit) : arr
  }

  /**
   * Gets the maximum playlist/album length from config.
   * @returns Maximum length.
   * @internal
   */
  private getMaxPlaylistLength(): number {
    return (this.options.playback.maxPlaylistLength as number | undefined) ?? 100
  }

  /**
   * Resolves an artist, album, or track by ID.
   * @param id - Pandora ID.
   * @returns Promise resolving to the content.
   * @internal
   */
  private async resolveArtist(id: string): Promise<SourceResult> {
    const response = await http1makeRequest(
      `${PANDORA_BASE_URL}/api/v4/catalog/annotateObjectsSimple`,
      {
        body: JSON.stringify({ pandoraIds: [id] }),
        headers: this.getHeaders(),
        method: 'POST',
        disableBodyCompression: true
      }
    )

    const trackData = this.parseJsonBody<
      Record<string, PandoraTrackAnnotation>
    >(response.body)

    if (response.error || this.hasApiError(trackData)) {
      return this.buildException(
        response.error,
        trackData as { message?: string }
      )
    }

    const keys = Object.keys(trackData ?? {})
    if (keys.length === 0 || !keys[0]) return { loadType: 'empty', data: {} }

    const item = trackData?.[keys[0]]
    if (!item) return { loadType: 'empty', data: {} }

    if (item.type === 'TR') {
      const track = this.buildTrack(item)
      return { loadType: 'track', data: track }
    }

    if (item.type === 'AL' && item.pandoraId) {
      return this.resolveAlbumDetails(
        item.pandoraId,
        item.name ?? 'Unknown Album'
      )
    }

    if (item.type === 'AR' && item.pandoraId) {
      return this.resolveArtistDetails(item.pandoraId)
    }

    return { loadType: 'empty', data: {} }
  }

  /**
   * Resolves album details.
   * @param id - Album ID.
   * @param name - Album name.
   * @returns Promise resolving to album tracks.
   * @internal
   */
  private async resolveAlbumDetails(
    id: string,
    name: string
  ): Promise<SourceResult> {
    const response = await http1makeRequest(
      `${PANDORA_BASE_URL}/api/v4/catalog/getDetails`,
      {
        body: JSON.stringify({ pandoraId: id }),
        headers: this.getHeaders(),
        method: 'POST',
        disableBodyCompression: true
      }
    )

    const data = this.parseJsonBody<PandoraCatalogDetailsResponse>(
      response.body
    )

    if (response.error || data?.errors) {
      return this.buildException(response.error, {
        message: 'Unknown album error'
      })
    }

    const annotations = data?.annotations ?? {}
    const trackKeys = this.limitArray(
      Object.keys(annotations),
      this.getMaxPlaylistLength()
    )
    const tracks = trackKeys
      .map((key) => annotations[key])
      .filter((item): item is PandoraTrackAnnotation => item !== undefined)
      .map((item) => this.buildTrack(item))

    return {
      loadType: 'album',
      data: {
        info: { name, selectedTrack: 0 },
        tracks,
        pluginInfo: {}
      }
    }
  }

  /**
   * Resolves artist top tracks via GraphQL.
   * @param id - Artist ID.
   * @returns Promise resolving to artist tracks.
   * @internal
   */
  private async resolveArtistDetails(id: string): Promise<SourceResult> {
    const graphqlQuery = `query GetArtistDetailsWithCuratorsWeb($pandoraId: String!) {
      entity(id: $pandoraId) {
        ... on Artist {
          name
          topTracksWithCollaborations {
            ...TrackFragment
            __typename
          }
          __typename
        }
      }
    }
    fragment ArtFragment on Art {
      artId
      dominantColor
      artUrl: url(size: WIDTH_500)
    }
    fragment TrackFragment on Track {
      pandoraId: id
      type
      name
      duration
      shareableUrlPath: urlPath
      artistName: artist {
        name
        __typename
      }
      icon: art {
        ...ArtFragment
        __typename
      }
    }`

    const response = await http1makeRequest(
      `${PANDORA_BASE_URL}/api/v1/graphql/graphql`,
      {
        body: JSON.stringify({
          operationName: 'GetArtistDetailsWithCuratorsWeb',
          query: graphqlQuery,
          variables: { pandoraId: id }
        }),
        headers: this.getHeaders(),
        method: 'POST',
        disableBodyCompression: true
      }
    )

    const data = this.parseJsonBody<PandoraArtistGraphQLResponse>(response.body)

    if (response.error || data?.errors) {
      return this.buildException(response.error, {
        message: 'Unknown artist error'
      })
    }

    const topTracks = data?.data?.entity?.topTracksWithCollaborations ?? []
    const items = this.limitArray(topTracks, this.getMaxPlaylistLength())

    const tracks = items.map((item) =>
      this.buildTrack({
        name: item.name,
        artistName:
          typeof item.artistName === 'object'
            ? item.artistName?.name
            : item.artistName,
        shareableUrlPath: item.shareableUrlPath,
        icon: item.icon,
        pandoraId: item.pandoraId,
        duration: item.duration
      })
    )

    const artistName = data?.data?.entity?.name ?? 'Unknown Artist'

    return {
      loadType: 'artist',
      data: {
        info: {
          name: `${artistName}'s Top Tracks`,
          selectedTrack: 0
        },
        tracks,
        pluginInfo: {}
      }
    }
  }

  /**
   * Resolves a playlist by ID.
   * @param id - Playlist ID.
   * @returns Promise resolving to playlist tracks.
   * @internal
   */
  private async resolvePlaylist(id: string): Promise<SourceResult> {
    const maxLength = this.getMaxPlaylistLength()
    const body = {
      request: {
        pandoraId: id,
        playlistVersion: 0,
        offset: 0,
        limit: maxLength,
        annotationLimit: maxLength,
        allowedTypes: ['TR', 'AM'],
        bypassPrivacyRules: true
      }
    }

    const response = await makeRequest(
      `${PANDORA_BASE_URL}/api/v7/playlists/getTracks`,
      {
        method: 'POST',
        headers: this.getHeaders(),
        body,
        disableBodyCompression: true
      }
    )

    if (response.error) {
      return this.buildException(response.error)
    }

    const data = response.body as PandoraPlaylistResponse | undefined
    const annotations = data?.annotations ?? {}

    const keys = Object.keys(annotations).filter((key) => key.includes('TR:'))
    const tracks = keys
      .map((key) => annotations[key])
      .filter((item): item is PandoraTrackAnnotation => item !== undefined)
      .map((item) => this.buildTrack(item))

    return {
      loadType: 'playlist',
      data: {
        info: { name: data?.name ?? 'Playlist', selectedTrack: 0 },
        tracks,
        pluginInfo: {}
      }
    }
  }

  /**
   * Resolves a station by ID.
   * @param id - Station ID.
   * @returns Promise resolving to station tracks.
   * @internal
   */
  private async resolveStation(id: string): Promise<SourceResult> {
    const response = await http1makeRequest(
      `${PANDORA_BASE_URL}/api/v1/station/getStationDetails`,
      {
        body: JSON.stringify({ stationId: id }),
        headers: this.getHeaders(),
        method: 'POST',
        disableBodyCompression: true
      }
    )

    const stationData = this.parseJsonBody<PandoraStationDetails>(response.body)

    if (response.error || stationData?.message) {
      return this.buildException(response.error, stationData)
    }

    const tracks = await this.fetchStationTracks(id, stationData)

    return {
      loadType: 'station',
      data: {
        info: { name: stationData?.name ?? 'Station', selectedTrack: 0 },
        tracks,
        pluginInfo: {}
      }
    }
  }

  /**
   * Fetches tracks for a station.
   * @param id - Station ID.
   * @param stationData - Station details.
   * @returns Promise resolving to track array.
   * @internal
   */
  private async fetchStationTracks(
    id: string,
    stationData?: PandoraStationDetails
  ): Promise<PandoraTrackData[]> {
    const tracks: PandoraTrackData[] = []

    try {
      const response = await http1makeRequest(
        `${PANDORA_BASE_URL}/api/v1/playlist/getPlaylist`,
        {
          body: JSON.stringify({ stationId: id }),
          headers: this.getHeaders(),
          method: 'POST',
          disableBodyCompression: true
        }
      )

      const playlistData = this.parseJsonBody<PandoraStationPlaylistResponse>(
        response.body
      )

      if (playlistData?.items && Array.isArray(playlistData.items)) {
        for (const item of playlistData.items) {
          if (!item.songName) continue

          tracks.push(
            this.buildTrack({
              name: item.songName,
              artistName: item.artistName,
              shareableUrlPath: item.songDetailUrl,
              icon: { artUrl: item.albumArtUrl },
              pandoraId: item.songId,
              duration: item.trackLength
            })
          )
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger('debug', 'Pandora', `Failed to fetch station playlist: ${message}`)
    }

    if (tracks.length === 0 && stationData?.seeds) {
      const seeds = this.limitArray(
        stationData.seeds,
        this.getMaxPlaylistLength()
      )

      for (const seed of seeds) {
        if (!seed.song) continue

        const artUrl = seed.art?.[seed.art.length - 1]?.url
        tracks.push(
          this.buildTrack({
            name: seed.song.songTitle,
            artistName: seed.song.artistSummary,
            shareableUrlPath: seed.song.songDetailUrl,
            icon: { artUrl },
            pandoraId: seed.song.songId
          })
        )
      }
    }

    return tracks
  }

  /**
   * Resolves a podcast by ID.
   * @param id - Podcast ID.
   * @returns Promise resolving to podcast content.
   * @internal
   */
  private async resolvePodcast(id: string): Promise<SourceResult> {
    const response = await http1makeRequest(
      `${PANDORA_BASE_URL}/api/v1/aesop/getDetails`,
      {
        body: JSON.stringify({ catalogVersion: 4, pandoraId: id }),
        headers: this.getHeaders(),
        method: 'POST',
        disableBodyCompression: true
      }
    )

    const podcastData = this.parseJsonBody<PandoraPodcastDetails>(response.body)

    if (response.error || podcastData?.message) {
      return this.buildException(response.error, podcastData)
    }

    const details = podcastData?.details
    const type =
      details?.podcastProgramDetails?.type ??
      details?.podcastEpisodeDetails?.type

    if (type === 'PE') {
      const epId = details?.podcastEpisodeDetails?.pandoraId
      if (epId && details?.annotations?.[epId]) {
        const ep = details.annotations[epId]
        const track = this.buildTrack(ep)
        return { loadType: 'track', data: track }
      }
    }

    if (type === 'PC') {
      return this.resolvePodcastEpisodes(id)
    }

    return { loadType: 'empty', data: {} }
  }

  /**
   * Resolves podcast episodes.
   * @param id - Podcast program ID.
   * @returns Promise resolving to episode tracks.
   * @internal
   */
  private async resolvePodcastEpisodes(id: string): Promise<SourceResult> {
    const idsResponse = await http1makeRequest(
      `${PANDORA_BASE_URL}/api/v1/aesop/getAllEpisodesByPodcastProgram`,
      {
        body: JSON.stringify({ catalogVersion: 4, pandoraId: id }),
        headers: this.getHeaders(),
        method: 'POST',
        disableBodyCompression: true
      }
    )

    const idsData = this.parseJsonBody<PandoraPodcastEpisodesResponse>(
      idsResponse.body
    )

    if (idsResponse.error || idsData?.message) {
      return this.buildException(idsResponse.error, idsData)
    }

    const episodeLabels = idsData?.episodes?.episodesWithLabel ?? []
    const allEpisodeIds = this.limitArray(
      episodeLabels.flatMap((yearInfo) => yearInfo.episodes ?? []),
      this.getMaxPlaylistLength()
    )

    const episodesResponse = await http1makeRequest(
      `${PANDORA_BASE_URL}/api/v1/aesop/annotateObjects`,
      {
        body: JSON.stringify({ catalogVersion: 4, pandoraIds: allEpisodeIds }),
        headers: this.getHeaders(),
        method: 'POST',
        disableBodyCompression: true
      }
    )

    const episodesData = this.parseJsonBody<PandoraAnnotateResponse>(
      episodesResponse.body
    )

    if (episodesResponse.error || episodesData?.message) {
      return this.buildException(episodesResponse.error, episodesData)
    }

    const annotations = episodesData?.annotations ?? {}
    const episodeKeys = Object.keys(annotations)
    const tracks = episodeKeys
      .map((key) => annotations[key])
      .filter((item): item is PandoraTrackAnnotation => item !== undefined)
      .map((item) => this.buildTrack(item))

    const programId = episodeKeys.find((key) => annotations[key]?.type === 'PC')
    const programName = programId ? annotations[programId]?.name : 'Podcast'

    return {
      loadType: 'podcast',
      data: {
        info: { name: programName ?? 'Podcast', selectedTrack: 0 },
        tracks,
        pluginInfo: {}
      }
    }
  }

  /**
   * Builds a track data object from annotation.
   * @param item - Pandora track annotation.
   * @returns Encoded track data.
   * @internal
   */
  private buildTrack(item: PandoraTrackAnnotation): PandoraTrackData {
    const artwork = this.buildArtworkUrl(item.icon?.artUrl)
    const uri = this.buildUri(item.shareableUrlPath ?? item.urlPath)
    const duration = item.duration ?? item.trackLength ?? item.length ?? 0

    const artistName =
      typeof item.artistName === 'object'
        ? item.artistName?.name
        : item.artistName

    const trackInfo: PandoraTrackInfo = {
      identifier: item.pandoraId ?? item.id ?? 'unknown',
      isSeekable: true,
      author: artistName ?? item.programName ?? 'Unknown Artist',
      length: duration * 1000,
      isStream: false,
      position: 0,
      title: item.name ?? 'Unknown Title',
      uri,
      artworkUrl: artwork,
      isrc: item.isrc ?? null,
      sourceName: 'pandora'
    }

    const encodeInput: TrackEncodeInput = { ...trackInfo, details: [] }

    return {
      encoded: encodeTrack(encodeInput),
      info: trackInfo,
      pluginInfo: {}
    }
  }

  /**
   * Resolves a track URL by searching on default source.
   * @param decodedTrack - The decoded track to resolve.
   * @returns Promise resolving to track URL result.
   * @public
   */
  public async getTrackUrl(decodedTrack: TrackInfo): Promise<TrackUrlResult> {
    const query = `${decodedTrack.title} ${decodedTrack.author}`
    const sources = this.nodelink.sources

    if (!sources) {
      return {
        exception: {
          message: 'Source manager is not available.',
          severity: 'fault'
        }
      }
    }

    try {
      let searchResult = await sources.searchWithDefault(
        decodedTrack.isrc ? `"${decodedTrack.isrc}"` : query
      )

      if (
        !searchResult ||
        searchResult.loadType !== 'search' ||
        !Array.isArray(searchResult.data) ||
        searchResult.data.length === 0
      ) {
        searchResult = await sources.searchWithDefault(query)
      }

      if (
        searchResult.loadType !== 'search' ||
        !Array.isArray(searchResult.data) ||
        searchResult.data.length === 0
      ) {
        return {
          exception: {
            message: 'No matching track found on default source.',
            severity: 'common'
          }
        }
      }

      const candidates = searchResult.data as PandoraTrackData[]
      const bestMatch = getBestMatch(candidates, decodedTrack)

      if (!bestMatch) {
        return {
          exception: {
            message: 'No suitable alternative found after filtering.',
            severity: 'common'
          }
        }
      }

      const trackInfo = bestMatch.info as TrackInfo
      const streamInfo = await sources.getTrackUrl(trackInfo)
      return { newTrack: bestMatch as PandoraTrackData, ...streamInfo }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger('error', 'Pandora', `Failed to mirror track: ${message}`)
      return { exception: { message, severity: 'fault' } }
    }
  }

  /**
   * Direct stream loading is not supported.
   * @returns Exception result.
   * @public
   */
  public async loadStream(): Promise<TrackStreamResult> {
    return {
      exception: {
        message: 'Direct stream loading is not supported by Pandora source.',
        severity: 'common'
      }
    }
  }

  /**
   * Parses JSON body safely.
   * @param body - Response body (string or object).
   * @returns Parsed object or undefined.
   * @internal
   */
  private parseJsonBody<T>(body: unknown): T | undefined {
    if (typeof body === 'string') {
      try {
        return JSON.parse(body) as T
      } catch {
        return undefined
      }
    }
    return body as T | undefined
  }

  /**
   * Checks if response has API error.
   * @param data - Response data.
   * @returns True if error present.
   * @internal
   */
  private hasApiError(data: unknown): boolean {
    if (!data || typeof data !== 'object') return false
    return (
      'message' in data &&
      typeof (data as { message?: unknown }).message === 'string'
    )
  }
}
