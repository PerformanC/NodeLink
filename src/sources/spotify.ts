import { getLocalToken } from '../modules/spotifyAuth.ts'
import { fetchCanvas } from '../modules/spotifyCanvas.ts'
import type { SpotifySourceConfig } from '../typings/config/config.types.ts'
import type {
  SourceInstance,
  SourceResult,
  TrackData,
  TrackInfo,
  TrackUrlResult,
  WorkerNodeLink
} from '../typings/sources/source.types.ts'
import type {
  SpotifyAlbum,
  SpotifyArtist,
  SpotifyGraphQLAlbumResponse,
  SpotifyGraphQLArtistResponse,
  SpotifyGraphQLOperation,
  SpotifyGraphQLPlaylistResponse,
  SpotifyGraphQLSearchResponse,
  SpotifyGraphQLTrack,
  SpotifyMetadataResponse,
  SpotifyPagingObject,
  SpotifyPlaylistItem,
  SpotifyTokenType,
  SpotifyTrack
} from '../typings/sources/spotify.types.ts'
import {
  encodeTrack,
  getBestMatch,
  http1makeRequest,
  logger
} from '../utils.ts'

/**
 * Base URL for the official Spotify Web API.
 * Used for standard catalog data and public resource resolution.
 * @internal
 */
const SPOTIFY_API_BASE_URL = 'https://api.spotify.com/v1'

/**
 * Base URL for the internal Spotify Client API.
 * Used for fetching advanced metadata (ISRC) and seed-based recommendations.
 * @internal
 */
const SPOTIFY_CLIENT_API_URL = 'https://spclient.wg.spotify.com'

/**
 * Base URL for the internal Spotify Pathfinder (GraphQL) API.
 * Provides granular control over metadata and access to internal resource nodes.
 * @internal
 */
const SPOTIFY_INTERNAL_API_URL =
  'https://api-partner.spotify.com/pathfinder/v2/query'

/**
 * Buffer duration in milliseconds to refresh tokens before actual expiry.
 * Prevents race conditions during high-concurrency request bursts.
 * @internal
 */
const TOKEN_REFRESH_MARGIN_MS = 300_000

/**
 * Predefined GraphQL operations for the Pathfinder API.
 * Each operation maps to a unique name and a persisted query hash.
 * @internal
 */
const QUERIES = {
  getTrack: {
    name: 'getTrack',
    hash: '612585ae06ba435ad26369870deaae23b5c8800a256cd8a57e08eddc25a37294'
  },
  getAlbum: {
    name: 'getAlbum',
    hash: 'b9bfabef66ed756e5e13f68a942deb60bd4125ec1f1be8cc42769dc0259b4b10'
  },
  getPlaylist: {
    name: 'fetchPlaylist',
    hash: 'e4b2953f160e58e38ac025d79b5a9b3aceee5c4c716598e9830bfceb69faff5f'
  },
  getArtist: {
    name: 'queryArtistOverview',
    hash: 'ae0e2958a4ab645b35ca19ac04d0495ae12d9c5d7b7286217674801a9aab281a'
  },
  getRecommendations: {
    name: 'internalLinkRecommenderTrack',
    hash: 'c77098ee9d6ee8ad3eb844938722db60570d040b49f41f5ec6e7be9160a7c86b'
  },
  searchDesktop: {
    name: 'searchDesktop',
    hash: 'db61238974d27839a136c9dc02bfdbe3fab7635f21cf85976ebff9a1ee281345'
  }
} as const satisfies Record<string, SpotifyGraphQLOperation>

/**
 * Comprehensive Spotify source implementation.
 *
 * This class handles integration with Spotify's various APIs using a tiered authentication system:
 * 1. **Official**: Client Credentials flow for catalog metadata.
 * 2. **Anonymous**: Internal Web Player tokens for rich resource structures.
 * 3. **Mobile**: Session cookie-based tokens for Canvas and advanced metadata.
 *
 * Implements sophisticated token locking, rate-limit backoff, and alternative source delegation.
 *
 * @public
 */
export default class SpotifySource implements SourceInstance {
  /**
   * The NodeLink worker context.
   * @internal
   */
  private readonly nodelink: WorkerNodeLink

  /**
   * Extracted Spotify configuration.
   * @internal
   */
  private readonly config: SpotifySourceConfig

  /**
   * Market code for catalog lookups.
   * @internal
   */
  private readonly market: string

  /**
   * Prefixes that identify search queries for this source.
   * @public
   */
  public readonly searchTerms = ['spsearch']

  /**
   * Prefix for recommendation (inspired-by) requests.
   * @public
   */
  public readonly recommendationTerm = ['sprec']

  /**
   * Regular expression patterns for Spotify URLs.
   * Supports standard resource URLs and local file formats.
   * @public
   */
  public readonly patterns = [
    /https?:\/\/(?:open\.)?spotify\.com\/(?:intl-[a-zA-Z]{2}\/)?(track|album|playlist|artist|episode|show)\/([a-zA-Z0-9]+)/,
    /https?:\/\/(?:open\.)?spotify\.com\/(?:intl-[a-zA-Z]{2}\/)?local\/[^?#]+/
  ]

  /**
   * Sorting priority for this source.
   * @public
   */
  public readonly priority = 95

  /**
   * Official API access token.
   * @internal
   */
  private accessToken: string | null = null

  /**
   * Official token expiration timestamp.
   * @internal
   */
  private accessTokenExpiry: number | null = null

  /**
   * Anonymous internal API access token.
   * @internal
   */
  private anonymousToken: string | null = null

  /**
   * Anonymous token expiration timestamp.
   * @internal
   */
  private anonymousTokenExpiry: number | null = null

  /**
   * Mobile access token (Canvas/ISRC support).
   * @internal
   */
  private mobileToken: string | null = null

  /**
   * Mobile token expiration timestamp.
   * @internal
   */
  private mobileTokenExpiry: number | null = null

  /**
   * Prevents concurrent token refreshes using a per-tier promise map.
   * @internal
   */
  private refreshPromises = new Map<SpotifyTokenType, Promise<boolean>>()

  /**
   * Predictive token refresh timers.
   * @internal
   */
  private tokenRefreshTimers = new Map<
    SpotifyTokenType,
    ReturnType<typeof setTimeout>
  >()

  /**
   * Creates a new SpotifySource instance.
   * @param nodelink - The worker context providing managers and options.
   */
  constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
    this.config = (nodelink.options.sources?.spotify || {
      enabled: false,
      playlistLoadLimit: 0,
      albumLoadLimit: 0,
      allowLocalFiles: false
    }) as SpotifySourceConfig
    this.market = this.config.market || 'US'
  }

  /**
   * Initializes the Spotify source by validating credentials and priming tokens.
   * Supports incremental tier activation based on available config.
   *
   * @returns A promise resolving to true if initialization succeeded.
   * @public
   */
  public async setup(): Promise<boolean> {
    const cm = this.nodelink.credentialManager
    if (!cm) return false

    const accessToken = cm.getEntry?.<string>('spotify_access_token')
    const anonymousToken = cm.getEntry?.<string>('spotify_anonymous_token')
    const mobileToken = cm.getEntry?.<string>('spotify_mobile_token')

    this.accessToken =
      accessToken?.value ?? cm.get<string>('spotify_access_token')
    this.accessTokenExpiry = accessToken?.expiresAt ?? null
    this.anonymousToken =
      anonymousToken?.value ?? cm.get<string>('spotify_anonymous_token')
    this.anonymousTokenExpiry = anonymousToken?.expiresAt ?? null
    this.mobileToken =
      mobileToken?.value ?? cm.get<string>('spotify_mobile_token')
    this.mobileTokenExpiry = mobileToken?.expiresAt ?? null

    const hasOfficial = !!(this.config.clientId && this.config.clientSecret)

    try {
      if (hasOfficial) await this._ensureToken('official')
      await this._ensureToken('anonymous')
      await this._ensureToken('mobile')

      const ok = !!(this.accessToken || this.anonymousToken || this.mobileToken)
      if (!ok) {
        logger(
          'warn',
          'Spotify',
          'Spotify source enabled but failed to initialize any authentication tier.'
        )
        return false
      }

      logger(
        'info',
        'Spotify',
        `Source initialized. Official: ${!!this.accessToken}, Anonymous: ${!!this.anonymousToken}, Mobile: ${!!this.mobileToken}`
      )
      return true
    } catch (e) {
      logger(
        'error',
        'Spotify',
        `Setup failed: ${e instanceof Error ? e.message : String(e)}`
      )
      return false
    }
  }

  /**
   * Validates and ensures a usable token for the requested authentication tier.
   * Implements a concurrency lock to prevent duplicate refresh calls.
   *
   * @param type - The target token tier.
   * @returns A promise resolving to true if a valid token is available.
   * @internal
   */
  private async _ensureToken(type: SpotifyTokenType): Promise<boolean> {
    const now = Date.now()
    let token: string | null = null
    let expiry: number | null = null

    if (type === 'official') {
      token = this.accessToken
      expiry = this.accessTokenExpiry
    } else if (type === 'anonymous') {
      token = this.anonymousToken
      expiry = this.anonymousTokenExpiry
    } else {
      token = this.mobileToken
      expiry = this.mobileTokenExpiry
    }

    if (
      token &&
      typeof expiry === 'number' &&
      now < expiry - TOKEN_REFRESH_MARGIN_MS
    ) {
      return true
    }

    const inflight = this.refreshPromises.get(type)
    if (inflight) return inflight

    const refreshPromise = this._refreshToken(type)
    this.refreshPromises.set(type, refreshPromise)

    try {
      return await refreshPromise
    } finally {
      this.refreshPromises.delete(type)
    }
  }

  /**
   * Schedules a background token refresh to prevent latency during playback.
   * @internal
   */
  private _scheduleTokenRefresh(type: SpotifyTokenType, expiry: number) {
    const existing = this.tokenRefreshTimers.get(type)
    if (existing) clearTimeout(existing)

    const now = Date.now()
    const timeUntilRefresh = expiry - now - TOKEN_REFRESH_MARGIN_MS

    if (timeUntilRefresh > 0) {
      const timer = setTimeout(() => {
        this._refreshToken(type).catch(() => {})
      }, timeUntilRefresh)
      timer.unref?.()
      this.tokenRefreshTimers.set(type, timer)
    }
  }

  /**
   * Implementation logic for refreshing various Spotify token tiers.
   * Handles Client Credentials flow, local Web Player generation, and session cookie flows.
   *
   * @param type - The token tier to refresh.
   * @returns A promise resolving to true if refresh succeeded.
   * @internal
   */
  private async _refreshToken(type: SpotifyTokenType): Promise<boolean> {
    const cm = this.nodelink.credentialManager
    if (!cm) return false

    try {
      if (type === 'official') {
        if (!this.config.clientId || !this.config.clientSecret) return false
        const auth = Buffer.from(
          `${this.config.clientId}:${this.config.clientSecret}`
        ).toString('base64')
        const res = await http1makeRequest(
          'https://accounts.spotify.com/api/token',
          {
            method: 'POST',
            headers: {
              Authorization: `Basic ${auth}`,
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'grant_type=client_credentials',
            disableBodyCompression: true
          }
        )

        const body = res.body as { access_token?: string; expires_in?: number }
        if (res.statusCode === 200 && body.access_token) {
          this.accessToken = body.access_token
          const ttl = (body.expires_in || 3600) * 1000
          this.accessTokenExpiry = Date.now() + ttl
          cm.set('spotify_access_token', this.accessToken, ttl)
          this._scheduleTokenRefresh('official', this.accessTokenExpiry)
          return true
        }
      }

      if (type === 'anonymous' || type === 'mobile') {
        try {
          const spDc = type === 'mobile' ? this.config.sp_dc : null
          const product = type === 'mobile' ? 'mobile-web-player' : 'web-player'
          const data = await getLocalToken(spDc, product)
          if (data?.accessToken) {
            const ttl = data.accessTokenExpirationTimestampMs
              ? data.accessTokenExpirationTimestampMs - Date.now()
              : 3600000
            const expiry = Date.now() + Math.max(ttl, 60000)

            if (type === 'mobile') {
              this.mobileToken = data.accessToken
              this.mobileTokenExpiry = expiry
              cm.set(
                'spotify_mobile_token',
                this.mobileToken,
                Math.max(ttl, 60000)
              )
              this._scheduleTokenRefresh('mobile', expiry)
            } else {
              this.anonymousToken = data.accessToken
              this.anonymousTokenExpiry = expiry
              cm.set(
                'spotify_anonymous_token',
                this.anonymousToken,
                Math.max(ttl, 60000)
              )
              this._scheduleTokenRefresh('anonymous', expiry)
            }
            return true
          }
        } catch (e) {
          logger(
            'debug',
            'Spotify',
            `${type} token request failed: ${e instanceof Error ? e.message : String(e)}`
          )
        }

        if (this.config.externalAuthUrl) {
          try {
            const res = await http1makeRequest(this.config.externalAuthUrl, {
              disableBodyCompression: true
            })
            const body = res.body as {
              accessToken?: string
              accessTokenExpirationTimestampMs?: number
            }
            if (res.statusCode === 200 && body.accessToken) {
              this.anonymousToken = body.accessToken
              const ttl = body.accessTokenExpirationTimestampMs
                ? body.accessTokenExpirationTimestampMs - Date.now()
                : 3600000
              this.anonymousTokenExpiry = Date.now() + Math.max(ttl, 60000)
              cm.set(
                'spotify_anonymous_token',
                this.anonymousToken,
                Math.max(ttl, 60000)
              )
              this._scheduleTokenRefresh('anonymous', this.anonymousTokenExpiry)
              return true
            }
          } catch (e) {
            logger(
              'debug',
              'Spotify',
              `External auth refresh failed: ${e instanceof Error ? e.message : String(e)}`
            )
          }
        }
      }

      return false
    } catch (e) {
      logger(
        'error',
        'Spotify',
        `Exception during ${type} refresh: ${e instanceof Error ? e.message : String(e)}`
      )
      return false
    }
  }

  /**
   * Cleans up all pending timers.
   * @public
   */
  public cleanup(): void {
    for (const timer of this.tokenRefreshTimers.values()) {
      clearTimeout(timer)
    }
    this.tokenRefreshTimers.clear()
  }

  /**
   * Unified HTTP client for executing Spotify API calls.
   * Handles tiered authentication selection, automatic retries on token failure,
   * and parsed rate-limit delays.
   *
   * @param path - Endpoint path or full URL.
   * @param useInternal - Use internal anonymous tier.
   * @param options - Extra request configuration.
   * @param retry - Current retry counter.
   * @returns Resolves to body T, or null on terminal failure.
   * @internal
   */
  private async _apiRequest<T>(
    path: string,
    tier: SpotifyTokenType = 'official',
    options: Record<string, unknown> = {},
    retry = 0
  ): Promise<T | null> {
    const ok = await this._ensureToken(tier)
    const token =
      tier === 'official'
        ? this.accessToken
        : tier === 'anonymous'
          ? this.anonymousToken
          : this.mobileToken

    if (!ok || !token) {
      const next =
        tier === 'official'
          ? 'anonymous'
          : tier === 'anonymous'
            ? 'mobile'
            : null
      if (next && retry < 3)
        return this._apiRequest<T>(path, next, options, retry + 1)
      return null
    }

    const url = path.startsWith('http')
      ? path
      : `${SPOTIFY_API_BASE_URL}${path}`
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...((options.headers as Record<string, string>) || {})
    }

    if (tier !== 'official') {
      Object.assign(headers, {
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'App-Platform': 'WebPlayer',
        'Spotify-App-Version': '1.2.87.221.ge160d899',
        Referer: 'https://open.spotify.com/'
      })
    }

    try {
      const res = await http1makeRequest(url, { ...options, headers })

      if (res.statusCode === 429) {
        if (retry >= 3) return null
        const next =
          tier === 'official'
            ? 'anonymous'
            : tier === 'anonymous'
              ? 'mobile'
              : null
        if (next) return this._apiRequest<T>(path, next, options, retry + 1)

        const wait = Number.parseInt(
          (res.headers as Record<string, string> | undefined)?.[
            'retry-after'
          ] || '5',
          10
        )
        logger(
          'warn',
          'Spotify',
          `Rate limited on ${path}. Waiting ${wait}s (retry ${retry + 1}/3)...`
        )
        await new Promise((r) => setTimeout(r, wait * 1000))
        return this._apiRequest<T>(path, tier, options, retry + 1)
      }

      if (res.statusCode === 401 || res.statusCode === 403) {
        if (tier === 'official') this.accessTokenExpiry = 0
        else if (tier === 'anonymous') this.anonymousTokenExpiry = 0
        else this.mobileTokenExpiry = 0

        const next =
          tier === 'official'
            ? 'anonymous'
            : tier === 'anonymous'
              ? 'mobile'
              : null
        if (next && retry < 3)
          return this._apiRequest<T>(path, next, options, retry + 1)
        if (retry < 3)
          return this._apiRequest<T>(path, tier, options, retry + 1)
      }

      if (res.statusCode !== 200 && res.statusCode !== 201) {
        if (
          retry < 1 &&
          !path.includes('pathfinder') &&
          !path.includes('spclient')
        ) {
          const next =
            tier === 'official'
              ? 'anonymous'
              : tier === 'anonymous'
                ? 'mobile'
                : null
          if (next) return this._apiRequest<T>(path, next, options, retry + 1)
        }
        return null
      }

      return res.body as T
    } catch (e) {
      logger(
        'error',
        'Spotify',
        `API Request failed for ${path}: ${e instanceof Error ? e.message : String(e)}`
      )
      return null
    }
  }

  /**
   * Executes a GraphQL persisted query against the Pathfinder API.
   *
   * @param operation - Name and SHA256 hash of the query.
   * @param variables - Input parameters for the GraphQL query.
   * @param retry - Internal retry counter.
   * @returns Resolves to typed data or null if errors were returned.
   * @internal
   */
  private async _internalApiRequest<T>(
    operation: SpotifyGraphQLOperation,
    variables: Record<string, unknown>,
    retry = 0
  ): Promise<T | null> {
    const res = await this._apiRequest<{ data?: T; errors?: Array<unknown> }>(
      SPOTIFY_INTERNAL_API_URL,
      'anonymous',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: {
          variables,
          operationName: operation.name,
          extensions: {
            persistedQuery: { version: 1, sha256Hash: operation.hash }
          }
        },
        disableBodyCompression: true
      },
      retry
    )

    if (res?.errors) {
      logger(
        'error',
        'Spotify',
        `Pathfinder error in ${operation.name}: ${JSON.stringify(res.errors)}`
      )
      return null
    }

    return res?.data || null
  }

  /**
   * Fetches advanced track metadata (including ISRC) using the internal Client API.
   * IDs must be converted to hex format for this legacy-oriented endpoint.
   *
   * @param id - Spotify Base62 ID.
   * @returns Resolves to metadata object or null.
   * @internal
   */
  private async _fetchTrackMetadata(
    id: string
  ): Promise<SpotifyMetadataResponse | null> {
    const hex = this._base62ToHex(id)
    const url = `${SPOTIFY_CLIENT_API_URL}/metadata/4/track/${hex}?market=from_token`
    const body = await this._apiRequest<unknown>(url, 'mobile', {
      responseType: 'buffer'
    })
    if (!body) return null

    if (Buffer.isBuffer(body)) {
      try {
        return JSON.parse(body.toString()) as SpotifyMetadataResponse
      } catch {
        const raw = body.toString()
        const isrc = raw.match(/[A-Z0-9]{12}/)
        if (isrc) return { external_id: [{ type: 'isrc', id: isrc[0] }] }
      }
    } else if (typeof body === 'object') {
      return body as SpotifyMetadataResponse
    }
    return null
  }

  /**
   * Transforms a Spotify Base62 identifier into a 32-character hex string.
   * @param id - Base62 encoded ID.
   * @returns Hex string.
   * @internal
   */
  private _base62ToHex(id: string): string {
    const alpha =
      '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
    let bn = 0n
    for (const char of id) bn = bn * 62n + BigInt(alpha.indexOf(char))
    return bn.toString(16).padStart(32, '0')
  }

  /**
   * Normalizes a GraphQL track structure into NodeLink's standard format.
   *
   * @param item - Node from internal GraphQL response.
   * @param artwork - Artwork URL override.
   * @returns TrackData or null if invalid.
   * @internal
   */
  private _buildTrackFromInternal(
    item: SpotifyGraphQLTrack,
    artwork: string | null = null
  ): TrackData | null {
    if (!item.uri || this._isLocalTrack(item)) return null
    const id = item.uri.split(':').pop() || ''
    const explicit =
      item.contentRating?.label === 'EXPLICIT' || item.explicit === true
    const info: TrackInfo = {
      identifier: id,
      isSeekable: true,
      author: this._getInternalTrackAuthor(item),
      length:
        item.duration?.totalMilliseconds ||
        item.trackDuration?.totalMilliseconds ||
        0,
      isStream: false,
      position: 0,
      title: item.name,
      uri: `https://open.spotify.com/track/${id}?explicit=${explicit}`,
      artworkUrl:
        artwork ||
        item.albumOfTrack?.coverArt?.sources?.[0]?.url ||
        item.album?.images?.[0]?.url ||
        null,
      isrc: item.externalIds?.isrc || null,
      sourceName: 'spotify'
    }
    return {
      encoded: encodeTrack({ ...info, details: [] }),
      info,
      pluginInfo: {}
    }
  }

  /**
   * Normalizes an official API track object into NodeLink's standard format.
   *
   * @param item - Node from official Web API response.
   * @param artwork - Artwork URL override.
   * @returns TrackData or null if invalid.
   * @internal
   */
  private _buildTrack(
    item: SpotifyTrack,
    artwork: string | null = null
  ): TrackData | null {
    if (!item.id || this._isLocalTrack(item)) return null
    const info: TrackInfo = {
      identifier: item.id,
      isSeekable: true,
      author: item.artists.map((a) => a.name).join(', ') || 'Unknown',
      length: item.duration_ms,
      isStream: false,
      position: 0,
      title: item.name,
      uri: `${item.external_urls.spotify}?explicit=${item.explicit}`,
      artworkUrl: artwork || item.album?.images?.[0]?.url || null,
      isrc: item.external_ids?.isrc || null,
      sourceName: 'spotify'
    }
    return {
      encoded: encodeTrack({ ...info, details: [] }),
      info,
      pluginInfo: {}
    }
  }

  /**
   * Orchestrates a catalog search using all available authentication tiers.
   * Automatically fetches advanced metadata for the top result when using internal search.
   *
   * @param query - The user search query.
   * @param term - The source trigger prefix.
   * @param type - Target type (track, album, playlist, artist).
   * @returns A promise resolving to the search payload.
   * @public
   */
  public async search(
    query: string,
    term?: string,
    type = 'track'
  ): Promise<SourceResult> {
    if (term && this.recommendationTerm.includes(term))
      return this.getRecommendations(query)

    try {
      const limit = Math.min(
        Math.max(this.nodelink.options.search.maxResults ?? 10, 1),
        50
      )

      // Priority 1: Internal Search (Rich nodes + Local matching)
      if (this.anonymousToken || this.config.sp_dc) {
        const data =
          await this._internalApiRequest<SpotifyGraphQLSearchResponse>(
            QUERIES.searchDesktop || {
              name: 'searchDesktop',
              hash: 'fcad5a3e0d5af727fb76966f06971c19cfa2275e6ff7671196753e008611873c'
            },
            {
              searchTerm: query,
              offset: 0,
              limit,
              numberOfTopResults: 5,
              includeAudiobooks: false,
              includeArtistHasConcertsField: false,
              includePreReleases: false
            }
          )
        if (data?.searchV2) {
          const results = this._processInternalSearch(data, type)
          if (results.length > 0) {
            const first = results[0]
            if (type === 'track' && first && !first.info.isrc) {
              const meta = await this._fetchTrackMetadata(first.info.identifier)
              const isrc = meta?.external_id?.find((e) => e.type === 'isrc')?.id
              if (isrc) {
                first.info.isrc = isrc
                first.encoded = encodeTrack({ ...first.info, details: [] })
              }
            }
            return { loadType: 'search', data: results }
          }
        }
      }

      // Priority 2: Official Catalog Search
      if (this.accessToken) {
        const res = await this._apiRequest<
          Record<string, SpotifyPagingObject<SpotifyTrack | SpotifyArtist>>
        >(
          `/search?q=${encodeURIComponent(query)}&type=${type}&limit=${limit}&market=${this.market}`
        )
        if (res) {
          const results = this._processOfficialSearch(res, type)
          return results.length
            ? { loadType: 'search', data: results }
            : { loadType: 'empty', data: {} }
        }
      }
      return { loadType: 'empty', data: {} }
    } catch (e) {
      return {
        loadType: 'error',
        exception: {
          message: e instanceof Error ? e.message : String(e),
          severity: 'fault'
        }
      }
    }
  }

  /**
   * Processes internal search result nodes into standardized TrackData items.
   *
   * @param data - Internal search payload.
   * @param type - Target type.
   * @returns Aggregated track list.
   * @internal
   */
  private _processInternalSearch(
    data: SpotifyGraphQLSearchResponse,
    type: string
  ): TrackData[] {
    const results: TrackData[] = []
    const searchV2 = data.searchV2
    if (!searchV2) return results

    if (type === 'track' && searchV2.tracksV2) {
      for (const it of searchV2.tracksV2.items) {
        const track = this._buildTrackFromInternal(it.item.data)
        if (track) results.push(track)
      }
    } else if (type === 'album' && searchV2.albumsV2) {
      for (const it of searchV2.albumsV2.items) {
        const album = it.data
        const id = album.uri.split(':').pop() || ''
        const info: TrackInfo = {
          title: album.name,
          author: album.artists.items.map((a) => a.profile.name).join(', '),
          length: 0,
          identifier: id,
          isSeekable: true,
          isStream: false,
          uri: `https://open.spotify.com/album/${id}`,
          artworkUrl: album.coverArt?.sources?.[0]?.url || null,
          isrc: null,
          sourceName: 'spotify',
          position: 0
        }
        results.push({
          encoded: encodeTrack({ ...info, details: [] }),
          info,
          pluginInfo: { type: 'album' }
        })
      }
    }
    return results
  }

  /**
   * Processes official paging response into standardized TrackData items.
   *
   * @param res - Official search payload.
   * @param type - Target type.
   * @returns Aggregated track list.
   * @internal
   */
  private _processOfficialSearch(
    res: Record<string, SpotifyPagingObject<SpotifyTrack | SpotifyArtist>>,
    type: string
  ): TrackData[] {
    const results: TrackData[] = []
    const paging = res[`${type}s`]
    if (!paging?.items) return results

    for (const it of paging.items) {
      if (type === 'track') {
        const track = this._buildTrack(it as SpotifyTrack)
        if (track) results.push(track)
      } else {
        const id = it.id
        const info: TrackInfo = {
          title: it.name,
          author:
            type === 'artist'
              ? 'Spotify'
              : (it as SpotifyTrack).artists?.map((a) => a.name).join(', ') ||
                (it as { owner?: { display_name?: string } }).owner
                  ?.display_name ||
                'Unknown',
          length: 0,
          identifier: id,
          isSeekable: type !== 'artist',
          isStream: false,
          uri:
            it.external_urls?.spotify ||
            `https://open.spotify.com/${type}/${id}`,
          artworkUrl:
            (type === 'track'
              ? (it as SpotifyTrack).album?.images?.[0]?.url
              : (it as SpotifyArtist).images?.[0]?.url) || null,
          isrc: null,
          sourceName: 'spotify',
          position: 0
        }
        results.push({
          encoded: encodeTrack({ ...info, details: [] }),
          info,
          pluginInfo: { type }
        })
      }
    }
    return results
  }

  /**
   * Resolves a Spotify URL into a resource.
   * Delegates to specialized internal resolvers based on path parameters.
   *
   * @param url - The absolute URL to resolve.
   * @returns Resolves to TrackData or PlaylistData result.
   * @public
   */
  public async resolve(url: string): Promise<SourceResult> {
    try {
      const pattern = this.patterns[0]
      if (this.patterns[1]?.test(url)) return await this._resolveLocalTrack(url)
      if (!pattern) return { loadType: 'empty', data: {} }

      const match = url.match(this.patterns[0] as RegExp)
      if (!match) return { loadType: 'empty', data: {} }

      const [, type, id] = match
      if (!id) return { loadType: 'empty', data: {} }

      switch (type) {
        case 'track':
          return await this._resolveTrack(id)
        case 'album':
          return await this._resolveAlbum(id)
        case 'playlist':
          return await this._resolvePlaylist(id)
        case 'artist':
          return await this._resolveArtist(id)
        case 'episode':
        case 'show':
          return {
            loadType: 'error',
            exception: {
              message: 'Episodes and podcasts are not supported.',
              severity: 'common'
            }
          }
        default:
          return { loadType: 'empty', data: {} }
      }
    } catch (e) {
      return {
        loadType: 'error',
        exception: {
          message: e instanceof Error ? e.message : String(e),
          severity: 'fault'
        }
      }
    }
  }

  /**
   * Resolves a track ID using internal and official tiers.
   *
   * @param id - Track identifier.
   * @returns Resolution result.
   * @internal
   */
  private async _resolveTrack(id: string): Promise<SourceResult> {
    if (this.anonymousToken || this.config.sp_dc) {
      const data = await this._internalApiRequest<{
        trackUnion: SpotifyGraphQLTrack & { __typename: string }
      }>(QUERIES.getTrack, { uri: `spotify:track:${id}` })
      if (data?.trackUnion && data.trackUnion.__typename !== 'NotFound') {
        const track = this._buildTrackFromInternal(data.trackUnion)
        if (track) {
          if (this.mobileToken) {
            const cv = await fetchCanvas(
              `spotify:track:${id}`,
              this.mobileToken
            )
            if (cv?.data?.canvasesList?.[0])
              track.pluginInfo.canvas = {
                canvasesList: [cv.data.canvasesList[0]]
              }
          }
          if (!track.info.isrc) {
            const meta = await this._fetchTrackMetadata(id)
            if (meta?.external_id?.[0]?.id) {
              track.info.isrc = meta.external_id[0].id
              track.encoded = encodeTrack({ ...track.info, details: [] })
            }
          }
          return { loadType: 'track', data: track }
        }
      }
    }

    if (this.accessToken) {
      const data = await this._apiRequest<SpotifyTrack>(
        `/tracks/${id}?market=${this.market}`
      )
      if (data) {
        const track = this._buildTrack(data)
        if (track) return { loadType: 'track', data: track }
      }
    }
    return { loadType: 'empty', data: {} }
  }

  /**
   * Resolves an album collection including all sub-tracks.
   *
   * @param id - Album identifier.
   * @returns Resolution result.
   * @internal
   */
  private async _resolveAlbum(id: string): Promise<SourceResult> {
    const maxTracks =
      (this.nodelink.options.playback.maxPlaylistLength as number) || 1000
    const tracks: TrackData[] = []
    let name = 'Unknown Album'

    if (this.anonymousToken || this.config.sp_dc) {
      let offset = 0
      const limit = 300
      let total = Infinity

      while (tracks.length < total && tracks.length < maxTracks) {
        const data =
          await this._internalApiRequest<SpotifyGraphQLAlbumResponse>(
            QUERIES.getAlbum,
            {
              uri: `spotify:album:${id}`,
              locale: 'en',
              offset,
              limit
            }
          )

        if (!data?.albumUnion || data.albumUnion.__typename === 'NotFound')
          break

        if (offset === 0) {
          name = data.albumUnion.name
          total = data.albumUnion.tracksV2?.totalCount || 0
        }

        const items = data.albumUnion.tracksV2?.items || []
        if (items.length === 0) break

        const artwork = data.albumUnion.coverArt?.sources?.[0]?.url || null
        for (const it of items) {
          const track = this._buildTrackFromInternal(it.track, artwork)
          if (track) tracks.push(track)
          if (tracks.length >= maxTracks) break
        }

        offset += items.length
        if (items.length < limit || tracks.length >= maxTracks) break
      }

      if (tracks.length > 0) {
        return {
          loadType: 'playlist',
          data: {
            info: { name, selectedTrack: 0 },
            tracks,
            pluginInfo: {}
          }
        }
      }
    }

    let nextUrl: string | null = `/albums/${id}?market=${this.market}`
    while (nextUrl && tracks.length < maxTracks) {
      const res: SpotifyAlbum | null =
        await this._apiRequest<SpotifyAlbum>(nextUrl)
      if (!res) break

      if (tracks.length === 0) name = res.name

      const items = res.tracks?.items || []
      if (items.length === 0) break

      for (const it of items) {
        const track = this._buildTrack(
          { ...it, album: { images: res.images, name: res.name } },
          res.images?.[0]?.url || null
        )
        if (track) tracks.push(track)
        if (tracks.length >= maxTracks) break
      }

      nextUrl = res.tracks?.next
        ? res.tracks.next.split('/v1')[1] || null
        : null
    }

    return tracks.length > 0
      ? {
          loadType: 'playlist',
          data: {
            info: { name, selectedTrack: 0 },
            tracks,
            pluginInfo: {}
          }
        }
      : { loadType: 'empty', data: {} }
  }

  /**
   * Resolves a playlist collection and its wrapped tracks.
   *
   * @param id - Playlist identifier.
   * @returns Resolution result.
   * @internal
   */
  private async _resolvePlaylist(id: string): Promise<SourceResult> {
    const maxTracks =
      (this.nodelink.options.playback.maxPlaylistLength as number) || 1000
    const tracks: TrackData[] = []
    let name = 'Unknown Playlist'

    if (this.anonymousToken || id.startsWith('37i9dQZ')) {
      let offset = 0
      const limit = 100
      let total = Infinity

      while (tracks.length < total && tracks.length < maxTracks) {
        const data =
          await this._internalApiRequest<SpotifyGraphQLPlaylistResponse>(
            QUERIES.getPlaylist,
            {
              uri: `spotify:playlist:${id}`,
              offset,
              limit,
              enableWatchFeedEntrypoint: false
            }
          )

        if (!data?.playlistV2 || data.playlistV2.__typename === 'NotFound')
          break

        if (offset === 0) {
          name = data.playlistV2.name
          total = data.playlistV2.content?.totalCount || 0
        }

        const items = data.playlistV2.content?.items || []
        if (items.length === 0) break

        for (const it of items) {
          const node = it.itemV2?.data
          if (!node) continue
          const track = this._isLocalTrack(node)
            ? await this._buildLocalTrack(node)
            : this._buildTrackFromInternal(node)
          if (track) tracks.push(track)
          if (tracks.length >= maxTracks) break
        }

        offset += items.length
        if (items.length < limit || tracks.length >= maxTracks) break
      }

      if (tracks.length > 0) {
        return {
          loadType: 'playlist',
          data: {
            info: { name, selectedTrack: 0 },
            tracks,
            pluginInfo: {}
          }
        }
      }
    }

    const metaRes = await this._apiRequest<{ name: string }>(
      `/playlists/${id}?market=${this.market}`
    )
    if (metaRes) name = metaRes.name

    let nextUrl: string | null = `/playlists/${id}/items?market=${this.market}`
    while (nextUrl && tracks.length < maxTracks) {
      const itemsRes: SpotifyPagingObject<SpotifyPlaylistItem> | null =
        await this._apiRequest<SpotifyPagingObject<SpotifyPlaylistItem>>(
          nextUrl
        )
      if (!itemsRes?.items || itemsRes.items.length === 0) break

      for (const it of itemsRes.items) {
        const node = it.item || it.track
        if (!node) continue
        const track = this._isLocalTrack(node, it)
          ? await this._buildLocalTrack(node)
          : this._buildTrack(node)
        if (track) tracks.push(track)
        if (tracks.length >= maxTracks) break
      }

      nextUrl = itemsRes.next ? itemsRes.next.split('/v1')[1] || null : null
    }

    return tracks.length > 0
      ? {
          loadType: 'playlist',
          data: {
            info: { name, selectedTrack: 0 },
            tracks,
            pluginInfo: {}
          }
        }
      : { loadType: 'empty', data: {} }
  }

  /**
   * Resolves an artist's top tracks.
   *
   * @param id - Artist identifier.
   * @returns Resolution result.
   * @internal
   */
  private async _resolveArtist(id: string): Promise<SourceResult> {
    await this._ensureToken('anonymous')

    if (this.anonymousToken) {
      const data = await this._internalApiRequest<SpotifyGraphQLArtistResponse>(
        QUERIES.getArtist,
        {
          uri: `spotify:artist:${id}`,
          locale: 'en',
          includePrerelease: false
        }
      )
      if (data?.artistUnion) {
        const tracks = (data.artistUnion.discography?.topTracks?.items || [])
          .map((it) => this._buildTrackFromInternal(it.track))
          .filter(Boolean) as TrackData[]
        return {
          loadType: 'playlist',
          data: {
            info: {
              name: `${data.artistUnion.profile.name}'s Top Tracks`,
              selectedTrack: 0
            },
            tracks,
            pluginInfo: {}
          }
        }
      }
    }

    return { loadType: 'empty', data: {} }
  }

  /**
   * Resolves a playback URL by delegating to alternative sources.
   *
   * @param track - Metadata of the Spotify track.
   * @returns Delegated stream URL result.
   * @public
   */
  public async getTrackUrl(track: TrackInfo): Promise<TrackUrlResult> {
    const sm = this.nodelink.sources
    if (!sm) {
      return {
        exception: {
          message: 'Source manager is not available.',
          severity: 'fault'
        }
      }
    }
    const query = `${track.title} ${track.author}`
    try {
      let res = await sm.searchWithDefault(
        track.isrc ? `"${track.isrc}"` : query
      )
      if (res.loadType !== 'search' || !res.data.length) {
        res = await sm.searchWithDefault(query)
      }
      if (res.loadType !== 'search' || !res.data.length) {
        return {
          exception: {
            message: 'No alternative stream found for this track.',
            severity: 'fault'
          }
        }
      }
      const best = getBestMatch(res.data, track, {
        allowExplicit: this.config.allowExplicit
      })
      if (!best) {
        return {
          exception: {
            message: 'No suitable matching alternative was found.',
            severity: 'fault'
          }
        }
      }
      const url = await sm.getTrackUrl(best.info as TrackInfo)
      return { newTrack: { info: best.info as TrackInfo }, ...url }
    } catch (e) {
      return {
        exception: {
          message: `Delegation failed: ${e instanceof Error ? e.message : String(e)}`,
          severity: 'fault'
        }
      }
    }
  }

  /**
   * Fetches an inspired mix based on a seed identifier.
   *
   * @param seed - Spotify identifier or seed query.
   * @returns Resolution result.
   * @public
   */
  public async getRecommendations(seed: string): Promise<SourceResult> {
    const token = this.anonymousToken || this.accessToken
    if (!token) return { loadType: 'empty', data: {} }
    try {
      let id = seed
      if (seed.includes('seed_tracks=')) {
        const parts = seed.split('seed_tracks=')
        if (parts[1]) id = parts[1].split('&')[0] || seed
      }
      const res = await http1makeRequest(
        `${SPOTIFY_CLIENT_API_URL}/inspiredby-mix/v2/seed_to_playlist/spotify:track:${id}?response-format=json`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      const body = res.body as { mediaItems?: Array<{ uri: string }> }
      if (res.statusCode === 200 && body.mediaItems?.[0]?.uri) {
        return this._resolvePlaylist(body.mediaItems[0].uri.split(':')[2] || '')
      }
      return { loadType: 'empty', data: {} }
    } catch {
      return { loadType: 'empty', data: {} }
    }
  }

  /**
   * Maps local metadata to a catalog-matched TrackData object.
   * @internal
   */
  private async _buildLocalTrack(
    it: SpotifyTrack | SpotifyGraphQLTrack
  ): Promise<TrackData | null> {
    if (!this.config.allowLocalFiles) return null
    const info: TrackInfo = {
      identifier: 'local',
      isSeekable: true,
      author: this._getInternalTrackAuthor(it),
      length:
        (it as SpotifyTrack).duration_ms ||
        (it as SpotifyGraphQLTrack).duration?.totalMilliseconds ||
        0,
      isStream: false,
      position: 0,
      title: it.name,
      uri: `spotify:local:${encodeURIComponent(it.name)}`,
      artworkUrl: null,
      isrc: null,
      sourceName: 'spotify'
    }
    return {
      encoded: encodeTrack({ ...info, details: [] }),
      info,
      pluginInfo: { localFile: true }
    }
  }

  /**
   * Resolution handler for local file URLs (Unsupported).
   * @internal
   */
  private async _resolveLocalTrack(_url: string): Promise<SourceResult> {
    return {
      loadType: 'error',
      exception: {
        message: 'Spotify local files are not supported for direct resolution.',
        severity: 'common'
      }
    }
  }

  /**
   * Identifies if a resource represents a local file.
   * @internal
   */
  private _isLocalTrack(
    it:
      | SpotifyTrack
      | SpotifyGraphQLTrack
      | (SpotifyTrack & { is_local?: boolean }),
    wrapper: { is_local?: boolean } | null = null
  ): boolean {
    if (!it) return false
    return (
      (it as { is_local?: boolean })?.is_local === true ||
      wrapper?.is_local === true ||
      !!(it as SpotifyTrack).uri?.startsWith('spotify:local:')
    )
  }

  /**
   * Aggregate internal artist structures into a flat string.
   * @internal
   */
  private _getInternalTrackAuthor(
    it: SpotifyTrack | SpotifyGraphQLTrack
  ): string {
    const artists = (it as SpotifyGraphQLTrack).artists?.items
    if (artists) {
      return (
        artists.map((a) => a.profile?.name || a.name).join(', ') || 'Unknown'
      )
    }
    const first = (it as SpotifyGraphQLTrack).firstArtist?.items?.[0]
    if (first) return first.profile?.name || 'Unknown'

    const official = (it as SpotifyTrack).artists
    if (official) return official.map((a) => a.name).join(', ')

    return 'Unknown'
  }
}
