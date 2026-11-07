import { getLocalToken } from '../modules/spotifyAuth.ts'
import { fetchCanvas } from '../modules/spotifyCanvas.ts'
import type { SpotifySourceConfig } from '../typings/config/config.types.ts'
import type {
  PlaylistPluginInfo,
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
  SpotifyGraphQLEpisodeResponse,
  SpotifyGraphQLOperation,
  SpotifyGraphQLPlaylistResponse,
  SpotifyGraphQLSearchResponse,
  SpotifyGraphQLShowResponse,
  SpotifyGraphQLTrack,
  SpotifyMetadataResponse,
  SpotifyPagingObject,
  SpotifyPlaylist,
  SpotifyPlaylistItem,
  SpotifyTokenType,
  SpotifyTrack
} from '../typings/sources/spotify.types.ts'
import type { SourceTestCase } from '../typings/sources/test.types.ts'
import {
  capTotalTracks,
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
  getEpisodeOrChapter: {
    name: 'getEpisodeOrChapter',
    hash: '5f77db47e5a2ce6680330bb61317aa09e17ddd1d189513cb218e7cd3e43288be'
  },
  queryPodcastEpisodes: {
    name: 'queryPodcastEpisodes',
    hash: '3539d746cf882f3909660de40b4ef472b3f5893a0761d617c282541de5d412c5'
  },
  queryBookChapters: {
    name: 'queryBookChapters',
    hash: '8f342d1c624755901657fa65cbb80dd3bacbcca2f6d802f570ae3269d59a403e'
  },
  fetchExtractedColors: {
    name: 'fetchExtractedColors',
    hash: '36e90fcaea00d47c695fce31874efeb2519b97d4cd0ee1abfb4f8dc9348596ea'
  },
  similarAlbumsBasedOnThisTrack: {
    name: 'similarAlbumsBasedOnThisTrack',
    hash: '1d1f93a737498adca2c892c73af87fc0b052afe4e1a33c989540c32413dfae17'
  },
  searchSuggestions: {
    name: 'searchSuggestions',
    hash: 'f244254b94c0e824d458ac216e0f8406a73f2f69a9ff52831a2f78fa774ff6ce'
  },
  fetchLibraryTracks: {
    name: 'fetchLibraryTracks',
    hash: '087278b20b743578a6262c2b0b4bcd20d879c503cc359a2285baf083ef944240'
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
  public readonly searchTerms = ['spsearch', 'spsuggest']

  /**
   * Prefix for recommendation (inspired-by) requests.
   * @public
   */
  public readonly recommendationTerm = ['sprec', 'spsimilar']

  /**
   * Regular expression patterns for Spotify URLs and URIs.
   * Supports standard resource URLs, embed URLs, legacy user playlists, URI schemes, and short links.
   * @public
   */
  public readonly patterns = [
    /^(?:https?:\/\/(?:open\.)?spotify\.com\/(?:(?:intl-[a-zA-Z0-9_-]+|embed)\/)*(?:user\/[^/?#]+\/)?|spotify:(?:user:[^:]+:)?)(track|album|playlist|artist|episode|show|audiobook|chapter|details|all|colors?|similar|collection)(?:\/|:)([a-zA-Z0-9_-]+)/,
    /^(?:https?:\/\/(?:open\.)?spotify\.com\/(?:intl-[a-zA-Z0-9_-]+\/)?local\/|spotify:local:)[^?#]+/,
    /^https?:\/\/(?:spotify\.link|spotify\.app\.link)\/[a-zA-Z0-9]+/
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
   * Prevents duplicate in-flight resolve calls for the same URL or URI.
   * @internal
   */
  private inFlightResolves = new Map<string, Promise<SourceResult>>()

  /**
   * Prevents duplicate in-flight track delegation lookups.
   * @internal
   */
  private inFlightTrackUrls = new Map<string, Promise<TrackUrlResult>>()

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
   * Cleans up all pending timers and in-flight operations.
   * @public
   */
  public cleanup(): void {
    for (const timer of this.tokenRefreshTimers.values()) {
      clearTimeout(timer)
    }
    this.tokenRefreshTimers.clear()
    this.inFlightResolves.clear()
    this.inFlightTrackUrls.clear()
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

        const rawWait = Number.parseInt(
          (res.headers as Record<string, string> | undefined)?.[
            'retry-after'
          ] || '5',
          10
        )
        const wait = Number.isFinite(rawWait) ? rawWait : 5
        if (wait > 10) {
          logger(
            'warn',
            'Spotify',
            `Rate limited on ${path} with excessive Retry-After (${wait}s). Skipping retry.`
          )
          return null
        }

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
   * @param tier - Authentication tier to use (defaults to anonymous).
   * @param retry - Internal retry counter.
   * @returns Resolves to typed data or null if errors were returned.
   * @internal
   */
  private async _internalApiRequest<T>(
    operation: SpotifyGraphQLOperation,
    variables: Record<string, unknown>,
    tier: SpotifyTokenType = 'anonymous',
    retry = 0
  ): Promise<T | null> {
    const res = await this._apiRequest<{ data?: T; errors?: Array<unknown> }>(
      SPOTIFY_INTERNAL_API_URL,
      tier,
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
    if (!hex) return null
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
   * @returns Hex string or empty string if identifier contains invalid characters.
   * @internal
   */
  private _base62ToHex(id: string): string {
    if (!/^[0-9a-zA-Z]+$/.test(id)) return ''
    const alpha =
      '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
    let bn = 0n
    for (const char of id) {
      const idx = alpha.indexOf(char)
      if (idx === -1) return ''
      bn = bn * 62n + BigInt(idx)
    }
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
    if (!item || !item.uri || !item.name || this._isLocalTrack(item)) return null
    const id = item.uri.split(':').pop() || ''
    if (!id) return null
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
        this._pickLargestImage(item.albumOfTrack?.coverArt?.sources) ||
        this._pickLargestImage(item.album?.images) ||
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
    if (!item || !item.id || !item.name || this._isLocalTrack(item)) return null
    const info: TrackInfo = {
      identifier: item.id,
      isSeekable: true,
      author:
        item.artists?.map((a) => a?.name).filter(Boolean).join(', ') ||
        'Unknown',
      length: typeof item.duration_ms === 'number' ? item.duration_ms : 0,
      isStream: false,
      position: 0,
      title: item.name,
      uri: `${item.external_urls?.spotify || `https://open.spotify.com/track/${item.id}`}?explicit=${Boolean(item.explicit)}`,
      artworkUrl:
        artwork ||
        this._pickLargestImage(item.album?.images) ||
        null,
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
    if (term === 'spsuggest' || query.startsWith('spsuggest:'))
      return await this._resolveSearchSuggestions(query.replace(/^spsuggest:/, '').trim())
    if (term === 'spsimilar' || query.startsWith('spsimilar:'))
      return await this._resolveSimilar(query.replace(/^spsimilar:/, '').trim())
    if (term && this.recommendationTerm.includes(term))
      return await this.getRecommendations(query)

    try {
      const limit = Math.min(
        Math.max(this.nodelink.options.search?.maxResults ?? 10, 1),
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
    } else if (type === 'playlist' && searchV2.playlists) {
      for (const item of searchV2.playlists.items) {
        const playlist = item.data
        const id = playlist.uri.split(':').pop() || ''
        const artwork = playlist.images?.items?.[0]?.sources?.[0]?.url || null
        const owner = playlist.ownerV2?.data?.name || 'Unknown'
        const info: TrackInfo = {
          title: playlist.name,
          author: owner,
          length: 0,
          identifier: id,
          isSeekable: false,
          isStream: false,
          uri: `https://open.spotify.com/playlist/${id}`,
          artworkUrl: artwork,
          isrc: null,
          sourceName: 'spotify',
          position: 0
        }
        results.push({
          encoded: encodeTrack({ ...info, details: [] }),
          info,
          pluginInfo: { type: 'playlist' }
        })
      }
    } else if (type === 'artist' && searchV2.artists) {
      for (const item of searchV2.artists.items) {
        const artist = item.data
        const id = artist.uri.split(':').pop() || ''
        const artwork = artist.visuals?.avatarImage?.sources?.[0]?.url || null
        const info: TrackInfo = {
          title: artist.profile.name,
          author: 'Spotify',
          length: 0,
          identifier: id,
          isSeekable: false,
          isStream: false,
          uri: `https://open.spotify.com/artist/${id}`,
          artworkUrl: artwork,
          isrc: null,
          sourceName: 'spotify',
          position: 0
        }
        results.push({
          encoded: encodeTrack({ ...info, details: [] }),
          info,
          pluginInfo: { type: 'artist' }
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
      const shortLinkPattern = this.patterns[2]
      if (shortLinkPattern?.test(url)) return await this._resolveShortLink(url)

      const localPattern = this.patterns[1]
      if (localPattern?.test(url)) return await this._resolveLocalTrack(url)

      const pattern = this.patterns[0]
      if (!pattern) return { loadType: 'empty', data: {} }

      const match = url.match(pattern)
      if (!match) return { loadType: 'empty', data: {} }

      const [, type, id] = match
      if (!type || !id) return { loadType: 'empty', data: {} }

      const inflight = this.inFlightResolves.get(url)
      if (inflight) return await inflight

      const resolvePromise = this._executeResolve(type, id)
      this.inFlightResolves.set(url, resolvePromise)

      try {
        return await resolvePromise
      } finally {
        this.inFlightResolves.delete(url)
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
   * Internal dispatcher for resource resolution.
   * @param type - Resource type (track, album, playlist, artist, episode, chapter, show, audiobook).
   * @param id - Spotify resource identifier.
   * @returns Resolution result.
   * @internal
   */
  private async _executeResolve(
    type: string,
    id: string
  ): Promise<SourceResult> {
    switch (type) {
      case 'track':
        return await this._resolveTrack(id)
      case 'details':
      case 'all':
      case 'color':
      case 'colors':
        return await this._resolveTrack(id, {
          extractColors: true,
          forceDetails: true
        })
      case 'similar':
        return await this._resolveSimilar(id)
      case 'collection':
        return await this._resolveCollection(id)
      case 'album':
        return await this._resolveAlbum(id)
      case 'playlist':
        return await this._resolvePlaylist(id)
      case 'artist':
        return await this._resolveArtist(id)
      case 'episode':
      case 'chapter':
        return await this._resolveEpisode(id, type as 'episode' | 'chapter')
      case 'show':
      case 'audiobook':
        return await this._resolveShow(id, type as 'show' | 'audiobook')
      default:
        return { loadType: 'empty', data: {} }
    }
  }

  /**
   * Resolves a track ID using internal and official tiers.
   *
   * @param id - Track identifier.
   * @param options - Resolution options (e.g. force color extraction or details).
   * @returns Resolution result.
   * @internal
   */
  private async _resolveTrack(
    id: string,
    options?: { extractColors?: boolean; forceDetails?: boolean }
  ): Promise<SourceResult> {
    if (this.anonymousToken || this.config.sp_dc) {
      const data = await this._internalApiRequest<{
        trackUnion: SpotifyGraphQLTrack & {
          __typename: string
          playcount?: string | number
        }
      }>(QUERIES.getTrack, { uri: `spotify:track:${id}` })
      if (data?.trackUnion && data.trackUnion.__typename !== 'NotFound') {
        const track = this._buildTrackFromInternal(data.trackUnion)
        if (track) {
          if (data.trackUnion.playcount) {
            track.pluginInfo.playcount = data.trackUnion.playcount
          }

          const shouldExtractColors =
            options?.extractColors ||
            options?.forceDetails ||
            this.config.extractColors === true

          const tasks: Promise<void>[] = []

          if (this.mobileToken) {
            tasks.push(
              fetchCanvas(`spotify:track:${id}`, this.mobileToken)
                .then((cv) => {
                  if (cv?.data?.canvasesList?.[0])
                    track.pluginInfo.canvas = {
                      canvasesList: [cv.data.canvasesList[0]]
                    }
                })
                .catch(() => {})
            )
          }

          if (!track.info.isrc) {
            tasks.push(
              this._fetchTrackMetadata(id)
                .then((meta) => {
                  if (meta?.external_id?.[0]?.id) {
                    track.info.isrc = meta.external_id[0].id
                    track.encoded = encodeTrack({ ...track.info, details: [] })
                  }
                })
                .catch(() => {})
            )
          }

          if (shouldExtractColors && track.info.artworkUrl) {
            tasks.push(
              this._fetchArtworkColors(track.info.artworkUrl)
                .then((colors) => {
                  if (colors) {
                    track.pluginInfo.colors = colors
                  }
                })
                .catch(() => {})
            )
          }

          if (tasks.length > 0) {
            await Promise.all(tasks)
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
      (this.nodelink.options.playback?.maxPlaylistLength as number) || 1000
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
   * Picks the highest-resolution image URL from a list of sources.
   * Sources without dimensions (e.g. user-uploaded playlist covers) count as
   * width 0, so the first one wins when none report a size.
   *
   * @param sources - Image sources from a Spotify GraphQL response.
   * @returns The best URL, or an empty string when there is none.
   * @internal
   */
  private _pickLargestImage(
    sources?: Array<{ url: string; width?: number | null }> | null
  ): string {
    let best = ''
    let bestWidth = -1
    for (const source of sources ?? []) {
      const width = source.width ?? 0
      if (source.url && width > bestWidth) {
        best = source.url
        bestWidth = width
      }
    }
    return best
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
      (this.nodelink.options.playback?.maxPlaylistLength as number) || 1000
    const tracks: TrackData[] = []
    let name = 'Unknown Playlist'
    let author = ''
    let thumbnail = ''
    let totalTracks = 0

    const buildPluginInfo = (): PlaylistPluginInfo => ({
      type: 'playlist',
      identifier: id,
      url: `https://open.spotify.com/playlist/${id}`,
      artworkUrl: thumbnail,
      author,
      totalTracks: capTotalTracks(totalTracks || tracks.length, maxTracks)
    })

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
          author = data.playlistV2.ownerV2?.data?.name?.trim() || ''
          thumbnail = this._pickLargestImage(
            data.playlistV2.images?.items?.[0]?.sources
          )
          total = data.playlistV2.content?.totalCount || 0
          totalTracks = total
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
            pluginInfo: buildPluginInfo()
          }
        }
      }
    }

    const metaRes = await this._apiRequest<
      Pick<SpotifyPlaylist, 'name' | 'owner' | 'images'>
    >(`/playlists/${id}?market=${this.market}`)
    if (metaRes) {
      name = metaRes.name
      author = metaRes.owner?.display_name?.trim() || author
      thumbnail = metaRes.images?.[0]?.url || thumbnail
    }

    let nextUrl: string | null = `/playlists/${id}/items?market=${this.market}`
    while (nextUrl && tracks.length < maxTracks) {
      const itemsRes: SpotifyPagingObject<SpotifyPlaylistItem> | null =
        await this._apiRequest<SpotifyPagingObject<SpotifyPlaylistItem>>(
          nextUrl
        )
      if (!itemsRes?.items || itemsRes.items.length === 0) break
      if (!totalTracks) totalTracks = itemsRes.total

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
            pluginInfo: buildPluginInfo()
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
      if (
        data?.artistUnion &&
        data.artistUnion.__typename !== 'NotFound' &&
        data.artistUnion.profile?.name
      ) {
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
            pluginInfo: {
              type: 'artist',
              identifier: id,
              url: `https://open.spotify.com/artist/${id}`,
              author: data.artistUnion.profile.name,
              totalTracks: tracks.length
            }
          }
        }
      }
    }

    if (this.accessToken) {
      const res = await this._apiRequest<{ tracks?: SpotifyTrack[] }>(
        `/artists/${id}/top-tracks?market=${this.market}`,
        'official'
      )
      if (res?.tracks && res.tracks.length > 0) {
        let artistName = 'Unknown Artist'
        const meta = await this._apiRequest<SpotifyArtist>(
          `/artists/${id}`,
          'official'
        )
        if (meta?.name) artistName = meta.name

        const tracks = res.tracks
          .map((t) => this._buildTrack(t))
          .filter(Boolean) as TrackData[]
        if (tracks.length > 0) {
          return {
            loadType: 'playlist',
            data: {
              info: {
                name: `${artistName}'s Top Tracks`,
                selectedTrack: 0
              },
              tracks,
              pluginInfo: {
                type: 'artist',
                identifier: id,
                url: `https://open.spotify.com/artist/${id}`,
                author: artistName,
                totalTracks: tracks.length
              }
            }
          }
        }
      }
    }

    return { loadType: 'empty', data: {} }
  }

  /**
   * Resolves Spotify shortlinks (spotify.link / spotify.app.link) by capturing redirects.
   *
   * @param url - Short URL.
   * @returns Resolution result from destination URL.
   * @internal
   */
  private async _resolveShortLink(url: string): Promise<SourceResult> {
    let targetUrl: string | null = null
    try {
      await http1makeRequest(url, {
        method: 'HEAD',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        shouldFollowRedirect: (nextUrl) => {
          targetUrl = nextUrl.href
          return false
        }
      })
    } catch {
      // shouldFollowRedirect = false aborts follow
    }

    if (!targetUrl) {
      try {
        const res = await http1makeRequest(url, {
          method: 'GET',
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          },
          shouldFollowRedirect: (nextUrl) => {
            targetUrl = nextUrl.href
            return false
          }
        })
        if (!targetUrl && res.statusCode === 200 && res.body) {
          const bodyStr =
            typeof res.body === 'string' ? res.body : res.body.toString()
          const ogMatch =
            bodyStr.match(
              /<meta\s+(?:property|name)=["']og:url["']\s+content=["'](https?:\/\/[^"']+)["']/i
            ) ||
            bodyStr.match(
              /<link\s+rel=["']canonical["']\s+href=["'](https?:\/\/[^"']+)["']/i
            )
          if (ogMatch?.[1]) {
            targetUrl = ogMatch[1]
          }
        }
      } catch {
        // shouldFollowRedirect abort
      }
    }

    if (targetUrl && targetUrl !== url) {
      return await this.resolve(targetUrl)
    }

    return { loadType: 'empty', data: {} }
  }

  /**
   * Resolves a podcast episode or audiobook chapter using the Pathfinder GraphQL API
   * with Spotify embed metadata and oEmbed fallbacks.
   *
   * @param id - Spotify Episode or Chapter identifier.
   * @param kind - Resource classification ('episode' or 'chapter').
   * @returns Resolution result.
   * @internal
   */
  private async _resolveEpisode(
    id: string,
    kind: 'episode' | 'chapter' = 'episode'
  ): Promise<SourceResult> {
    try {
      await this._ensureToken('anonymous')

      if (this.anonymousToken) {
        const data =
          await this._internalApiRequest<SpotifyGraphQLEpisodeResponse>(
            QUERIES.getEpisodeOrChapter,
            { uri: `spotify:episode:${id}` }
          )

        const ep = data?.episodeUnionV2
        if (ep && ep.__typename !== 'NotFound' && ep.name) {
          const title = ep.name
          const showName =
            ep.podcastV2?.data?.name ||
            ep.audiobookV2?.data?.name ||
            'Unknown Podcast'
          const duration = ep.duration?.totalMilliseconds ?? 0
          const artworkUrl =
            this._pickLargestImage(
              ep.coverArt?.sources?.map((s) => ({
                url: s.url,
                width: s.width ?? undefined
              }))
            ) || null
          const explicit = ep.contentRating?.label === 'EXPLICIT'
          const previewUrl = ep.audio?.items?.[0]?.url || null

          const info: TrackInfo = {
            identifier: id,
            isSeekable: true,
            author: showName,
            length: duration,
            isStream: false,
            position: 0,
            title,
            uri: `https://open.spotify.com/${kind}/${id}?explicit=${explicit}`,
            artworkUrl,
            isrc: null,
            sourceName: 'spotify'
          }

          return {
            loadType: 'track',
            data: {
              encoded: encodeTrack({ ...info, details: [] }),
              info,
              pluginInfo: {
                type: kind,
                show: showName,
                previewUrl
              }
            }
          }
        }
      }

      // Fallback 1: Embed metadata extraction
      const embedUrl = `https://open.spotify.com/embed/${kind}/${id}`
      const res = await http1makeRequest(embedUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      })

      if (res.statusCode === 200 && res.body) {
        const html =
          typeof res.body === 'string' ? res.body : res.body.toString()
        const nextDataMatch = html.match(
          /<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/
        )
        if (nextDataMatch?.[1]) {
          const parsed = JSON.parse(nextDataMatch[1]) as {
            props?: {
              pageProps?: {
                state?: {
                  data?: {
                    entity?: {
                      name?: string
                      title?: string
                      subtitle?: string
                      duration?: number
                      duration_ms?: number
                      isExplicit?: boolean
                      audioPreview?: { url?: string }
                      visualIdentity?: { image?: Array<{ url: string; maxWidth?: number }> }
                      relatedEntityCoverArt?: Array<{ url: string; maxWidth?: number }>
                    }
                  }
                }
              }
            }
          }
          const entity = parsed?.props?.pageProps?.state?.data?.entity
          if (entity && (entity.name || entity.title)) {
            const title = entity.name || entity.title || 'Unknown Episode'
            const showName = entity.subtitle || 'Unknown Podcast'
            const duration =
              typeof entity.duration === 'number'
                ? entity.duration
                : typeof entity.duration_ms === 'number'
                  ? entity.duration_ms
                  : 0
            const artworkUrl =
              this._pickLargestImage(
                entity.visualIdentity?.image?.map((i) => ({
                  url: i.url,
                  width: i.maxWidth
                }))
              ) ||
              this._pickLargestImage(
                entity.relatedEntityCoverArt?.map((i) => ({
                  url: i.url,
                  width: i.maxWidth
                }))
              ) ||
              null
            const explicit = Boolean(entity.isExplicit)

            const info: TrackInfo = {
              identifier: id,
              isSeekable: true,
              author: showName,
              length: duration,
              isStream: false,
              position: 0,
              title,
              uri: `https://open.spotify.com/${kind}/${id}?explicit=${explicit}`,
              artworkUrl,
              isrc: null,
              sourceName: 'spotify'
            }

            return {
              loadType: 'track',
              data: {
                encoded: encodeTrack({ ...info, details: [] }),
                info,
                pluginInfo: {
                  type: kind,
                  show: showName,
                  previewUrl: entity.audioPreview?.url || null
                }
              }
            }
          }
        }
      }

      // Fallback 2: oEmbed endpoint
      const oembedRes = await http1makeRequest(
        `https://open.spotify.com/oembed?url=https://open.spotify.com/${kind}/${id}`
      )
      if (oembedRes.statusCode === 200 && oembedRes.body) {
        const body =
          typeof oembedRes.body === 'string'
            ? (JSON.parse(oembedRes.body) as { title?: string; thumbnail_url?: string })
            : (oembedRes.body as { title?: string; thumbnail_url?: string })
        if (body?.title) {
          const info: TrackInfo = {
            identifier: id,
            isSeekable: true,
            author: 'Spotify Podcast',
            length: 0,
            isStream: false,
            position: 0,
            title: body.title,
            uri: `https://open.spotify.com/${kind}/${id}`,
            artworkUrl: body.thumbnail_url || null,
            isrc: null,
            sourceName: 'spotify'
          }

          return {
            loadType: 'track',
            data: {
              encoded: encodeTrack({ ...info, details: [] }),
              info,
              pluginInfo: {
                type: kind,
                show: 'Spotify Podcast',
                previewUrl: null
              }
            }
          }
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
   * Resolves a podcast show or audiobook using the Pathfinder GraphQL API
   * with Spotify embed metadata and oEmbed fallbacks.
   *
   * @param id - Spotify Show or Audiobook identifier.
   * @param kind - Resource classification ('show' or 'audiobook').
   * @returns Resolution result.
   * @internal
   */
  private async _resolveShow(
    id: string,
    kind: 'show' | 'audiobook' = 'show'
  ): Promise<SourceResult> {
    try {
      await this._ensureToken('anonymous')
      const maxTracks =
        this.nodelink.options.playback?.maxPlaylistLength ?? 1000

      if (this.anonymousToken) {
        let op =
          kind === 'audiobook'
            ? QUERIES.queryBookChapters
            : QUERIES.queryPodcastEpisodes
        let data =
          await this._internalApiRequest<SpotifyGraphQLShowResponse>(op, {
            uri: `spotify:show:${id}`,
            offset: 0,
            limit: Math.min(maxTracks, 100)
          })

        if (
          kind === 'show' &&
          data?.podcastUnionV2?.__typename === 'Audiobook'
        ) {
          op = QUERIES.queryBookChapters
          data = await this._internalApiRequest<SpotifyGraphQLShowResponse>(
            op,
            {
              uri: `spotify:show:${id}`,
              offset: 0,
              limit: Math.min(maxTracks, 100)
            }
          )
        }

        const show = data?.podcastUnionV2
        if (show && show.__typename !== 'NotFound' && show.name) {
          const showName = show.name
          const showArtwork =
            this._pickLargestImage(
              show.coverArt?.sources?.map((s) => ({
                url: s.url,
                width: s.width ?? undefined
              }))
            ) || null

          const isAudiobook = show.__typename === 'Audiobook'
          const initialItems = isAudiobook
            ? show.chaptersV2?.items ?? []
            : show.episodesV2?.items ?? []
          const totalCount = isAudiobook
            ? show.chaptersV2?.totalCount ?? initialItems.length
            : show.episodesV2?.totalCount ?? initialItems.length

          const tracks: TrackData[] = []

          const parseItem = (it: (typeof initialItems)[number]): void => {
            const ep = it.entity?.data
            if (!ep || !ep.name) return
            const epUri = ep.uri || it.entity?._uri || ''
            const epId = ep.id || epUri.split(':').pop() || id
            const epKind = ep.__typename === 'Chapter' ? 'chapter' : 'episode'
            const epArtwork =
              this._pickLargestImage(
                ep.coverArt?.sources?.map((s) => ({
                  url: s.url,
                  width: s.width ?? undefined
                }))
              ) || showArtwork
            const explicit = ep.contentRating?.label === 'EXPLICIT'
            const previewUrl =
              ep.audio?.items?.[0]?.url ||
              ep.previewPlayback?.audioPreview?.cdnUrl ||
              ep.audioPreview?.url ||
              null

            const info: TrackInfo = {
              identifier: epId,
              isSeekable: true,
              author:
                ep.podcastV2?.data?.name ||
                ep.audiobookV2?.data?.name ||
                showName,
              length: ep.duration?.totalMilliseconds ?? 0,
              isStream: false,
              position: 0,
              title: ep.name,
              uri: `https://open.spotify.com/${epKind}/${epId}?explicit=${explicit}`,
              artworkUrl: epArtwork,
              isrc: null,
              sourceName: 'spotify'
            }

            tracks.push({
              encoded: encodeTrack({ ...info, details: [] }),
              info,
              pluginInfo: {
                type: epKind,
                show: showName,
                previewUrl
              }
            })
          }

          for (const it of initialItems) {
            parseItem(it)
            if (tracks.length >= maxTracks) break
          }

          let offset = initialItems.length
          while (tracks.length < maxTracks && offset < totalCount) {
            const limit = Math.min(maxTracks - tracks.length, 100)
            const pageData =
              await this._internalApiRequest<SpotifyGraphQLShowResponse>(op, {
                uri: `spotify:show:${id}`,
                offset,
                limit
              })
            const pageItems = isAudiobook
              ? pageData?.podcastUnionV2?.chaptersV2?.items ?? []
              : pageData?.podcastUnionV2?.episodesV2?.items ?? []
            if (!pageItems.length) break

            for (const it of pageItems) {
              parseItem(it)
              if (tracks.length >= maxTracks) break
            }
            offset += pageItems.length
          }

          if (tracks.length > 0) {
            return {
              loadType: 'playlist',
              data: {
                info: {
                  name: showName,
                  selectedTrack: 0
                },
                tracks,
                pluginInfo: {
                  type: isAudiobook ? 'audiobook' : 'show',
                  identifier: id,
                  url: `https://open.spotify.com/${isAudiobook ? 'audiobook' : 'show'}/${id}`,
                  author: showName,
                  totalTracks: totalCount
                }
              }
            }
          }
        }
      }

      // Fallback 1: Embed metadata extraction
      const embedUrl = `https://open.spotify.com/embed/${kind}/${id}`
      const res = await http1makeRequest(embedUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      })

      if (res.statusCode === 200 && res.body) {
        const html =
          typeof res.body === 'string' ? res.body : res.body.toString()
        const nextDataMatch = html.match(
          /<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/
        )
        if (nextDataMatch?.[1]) {
          const parsed = JSON.parse(nextDataMatch[1]) as {
            props?: {
              pageProps?: {
                state?: {
                  data?: {
                    entity?: {
                      id?: string
                      name?: string
                      title?: string
                      subtitle?: string
                      duration?: number
                      duration_ms?: number
                      isExplicit?: boolean
                      audioPreview?: { url?: string }
                      visualIdentity?: { image?: Array<{ url: string; maxWidth?: number }> }
                      relatedEntityCoverArt?: Array<{ url: string; maxWidth?: number }>
                    }
                  }
                }
              }
            }
          }
          const entity = parsed?.props?.pageProps?.state?.data?.entity
          if (entity && (entity.name || entity.title)) {
            const title = entity.name || entity.title || 'Unknown Episode'
            const showName = entity.subtitle || 'Unknown Podcast'
            const epId = entity.id || id
            const duration =
              typeof entity.duration === 'number'
                ? entity.duration
                : typeof entity.duration_ms === 'number'
                  ? entity.duration_ms
                  : 0
            const artworkUrl =
              this._pickLargestImage(
                entity.visualIdentity?.image?.map((i) => ({
                  url: i.url,
                  width: i.maxWidth
                }))
              ) ||
              this._pickLargestImage(
                entity.relatedEntityCoverArt?.map((i) => ({
                  url: i.url,
                  width: i.maxWidth
                }))
              ) ||
              null
            const explicit = Boolean(entity.isExplicit)

            const info: TrackInfo = {
              identifier: epId,
              isSeekable: true,
              author: showName,
              length: duration,
              isStream: false,
              position: 0,
              title,
              uri: `https://open.spotify.com/episode/${epId}?explicit=${explicit}`,
              artworkUrl,
              isrc: null,
              sourceName: 'spotify'
            }

            const trackData: TrackData = {
              encoded: encodeTrack({ ...info, details: [] }),
              info,
              pluginInfo: {
                type: 'episode',
                show: showName,
                previewUrl: entity.audioPreview?.url || null
              }
            }

            return {
              loadType: 'playlist',
              data: {
                info: {
                  name: `${showName} (Latest Episode)`,
                  selectedTrack: 0
                },
                tracks: [trackData],
                pluginInfo: {
                  type: kind,
                  identifier: id,
                  url: `https://open.spotify.com/${kind}/${id}`,
                  author: showName,
                  totalTracks: 1
                }
              }
            }
          }
        }
      }

      // Fallback 2: oEmbed endpoint
      const oembedRes = await http1makeRequest(
        `https://open.spotify.com/oembed?url=https://open.spotify.com/${kind}/${id}`
      )
      if (oembedRes.statusCode === 200 && oembedRes.body) {
        const body =
          typeof oembedRes.body === 'string'
            ? (JSON.parse(oembedRes.body) as {
                title?: string
                thumbnail_url?: string
              })
            : (oembedRes.body as {
                title?: string
                thumbnail_url?: string
              })

        if (body?.title) {
          const info: TrackInfo = {
            identifier: id,
            isSeekable: true,
            author: body.title,
            length: 0,
            isStream: false,
            position: 0,
            title: body.title,
            uri: `https://open.spotify.com/${kind}/${id}`,
            artworkUrl: body.thumbnail_url || null,
            isrc: null,
            sourceName: 'spotify'
          }

          const trackData: TrackData = {
            encoded: encodeTrack({ ...info, details: [] }),
            info,
            pluginInfo: {
              type: kind,
              show: body.title,
              previewUrl: null
            }
          }

          return {
            loadType: 'playlist',
            data: {
              info: {
                name: body.title,
                selectedTrack: 0
              },
              tracks: [trackData],
              pluginInfo: {
                type: kind,
                identifier: id,
                url: `https://open.spotify.com/${kind}/${id}`,
                author: body.title,
                totalTracks: 1
              }
            }
          }
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
   * Resolves a playback URL by delegating to alternative sources.
   * Deduplicates concurrent in-flight delegation requests for the same track.
   *
   * @param track - Metadata of the Spotify track.
   * @returns Delegated stream URL result.
   * @public
   */
  public async getTrackUrl(track: TrackInfo): Promise<TrackUrlResult> {
    const cacheKey = track.identifier || track.uri
    const inflight = this.inFlightTrackUrls.get(cacheKey)
    if (inflight) return await inflight

    const trackUrlPromise = this._executeGetTrackUrl(track)
    this.inFlightTrackUrls.set(cacheKey, trackUrlPromise)

    try {
      return await trackUrlPromise
    } finally {
      this.inFlightTrackUrls.delete(cacheKey)
    }
  }

  /**
   * Internal executor for track URL resolution via delegation.
   * @internal
   */
  private async _executeGetTrackUrl(
    track: TrackInfo
  ): Promise<TrackUrlResult> {
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
        const cleanedTitle = track.title
          .replace(/[|#]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
        const fallbackQuery = `${track.author} ${cleanedTitle}`
        if (fallbackQuery !== query) {
          res = await sm.searchWithDefault(fallbackQuery)
        }
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

    let id = seed.trim()
    if (id.includes('seed_tracks=')) {
      const match = id.match(/seed_tracks=([A-Za-z0-9]+)/)
      if (match?.[1]) id = match[1]
    } else if (id.startsWith('http://') || id.startsWith('https://')) {
      const match = id.match(/\/track\/([A-Za-z0-9]+)/)
      if (match?.[1]) id = match[1]
    } else if (id.startsWith('spotify:track:')) {
      id = id.split(':')[2] || id
    } else if (id.includes(',')) {
      const first = id.split(',')[0]
      if (first) id = first.trim()
    }

    try {
      const res = await http1makeRequest(
        `${SPOTIFY_CLIENT_API_URL}/inspiredby-mix/v2/seed_to_playlist/spotify:track:${id}?response-format=json`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      const body = res.body as { mediaItems?: Array<{ uri: string }> }
      if (res.statusCode === 200 && body.mediaItems?.[0]?.uri) {
        const playlistResult = await this._resolvePlaylist(
          body.mediaItems[0].uri.split(':')[2] || ''
        )
        if (
          playlistResult.loadType === 'playlist' &&
          Array.isArray(
            (playlistResult.data as { tracks?: TrackData[] }).tracks
          ) &&
          (playlistResult.data as { tracks: TrackData[] }).tracks.length > 0
        ) {
          return playlistResult
        }
      }
    } catch (e) {
      logger(
        'debug',
        'Spotify',
        `Radio mix recommendations failed for ${id}: ${(e as Error).message}`
      )
    }

    try {
      const maxTracks =
        (this.nodelink.options.playback?.maxPlaylistLength as number) || 50
      const limit = Math.min(Math.max(maxTracks, 1), 50)

      const data = await this._internalApiRequest<{
        seoRecommendedTrack?: {
          items?: Array<{ data: SpotifyGraphQLTrack }>
        }
      }>(QUERIES.getRecommendations, {
        uri: `spotify:track:${id}`,
        limit
      })

      const items = data?.seoRecommendedTrack?.items || []
      if (items.length > 0) {
        const tracks: TrackData[] = []
        for (const item of items) {
          if (!item?.data) continue
          const track = this._isLocalTrack(item.data)
            ? await this._buildLocalTrack(item.data)
            : this._buildTrackFromInternal(item.data)
          if (track) tracks.push(track)
          if (tracks.length >= maxTracks) break
        }

        if (tracks.length > 0) {
          return {
            loadType: 'playlist',
            data: {
              info: {
                name: `Spotify Recommendations for ${id}`,
                selectedTrack: 0
              },
              tracks,
              pluginInfo: {}
            }
          }
        }
      }
    } catch (e) {
      logger(
        'debug',
        'Spotify',
        `GraphQL recommendations fallback failed for ${id}: ${(e as Error).message}`
      )
    }

    return { loadType: 'empty', data: {} }
  }

  /**
   * Resolves similar albums or recommendations based on a track identifier.
   *
   * @param seed - Track identifier or URI.
   * @returns Playlist containing similar albums or recommended tracks.
   * @internal
   */
  private async _resolveSimilar(seed: string): Promise<SourceResult> {
    await this._ensureToken('anonymous')
    if (!this.anonymousToken) return { loadType: 'empty', data: {} }

    let id = seed.trim()
    if (id.startsWith('spotify:similar:')) {
      id = id.split(':')[2] || id
    } else if (id.startsWith('spotify:track:')) {
      id = id.split(':')[2] || id
    } else if (id.includes('/track/')) {
      const match = id.match(/\/track\/([A-Za-z0-9]+)/)
      if (match?.[1]) id = match[1]
    }

    try {
      const data = await this._internalApiRequest<{
        seoRecommendedTrackAlbum?: {
          items?: Array<{
            data: {
              __typename: string
              name: string
              uri: string
              coverArt?: {
                sources?: Array<{
                  url: string
                  width?: number
                  height?: number
                }>
              }
              artists?: {
                items?: Array<{ profile?: { name: string }; uri?: string }>
              }
            }
          }>
        }
      }>(QUERIES.similarAlbumsBasedOnThisTrack, {
        uri: `spotify:track:${id}`,
        limit: 10
      })

      const items = data?.seoRecommendedTrackAlbum?.items || []
      if (items.length > 0) {
        const tracks: TrackData[] = []
        for (const item of items) {
          const a = item.data
          if (!a || !a.name) continue
          const albumId = a.uri?.split(':').pop() || ''
          const artistName =
            a.artists?.items
              ?.map((it) => it.profile?.name)
              .filter(Boolean)
              .join(', ') || 'Unknown'
          const artwork = this._pickLargestImage(a.coverArt?.sources) || null

          const info: TrackInfo = {
            title: a.name,
            author: artistName,
            length: 0,
            identifier: albumId,
            isSeekable: false,
            isStream: false,
            uri: `https://open.spotify.com/album/${albumId}`,
            artworkUrl: artwork,
            isrc: null,
            sourceName: 'spotify',
            position: 0
          }

          tracks.push({
            encoded: encodeTrack({ ...info, details: [] }),
            info,
            pluginInfo: { type: 'album' }
          })
        }

        if (tracks.length > 0) {
          return {
            loadType: 'playlist',
            data: {
              info: {
                name: `Similar to ${id}`,
                selectedTrack: 0
              },
              tracks,
              pluginInfo: {
                type: 'similar',
                identifier: id
              }
            }
          }
        }
      }
    } catch (e) {
      logger(
        'debug',
        'Spotify',
        `similarAlbumsBasedOnThisTrack failed for ${id}: ${(e as Error).message}`
      )
    }

    return await this.getRecommendations(id)
  }

  /**
   * Resolves query autocomplete suggestions via the Pathfinder searchSuggestions query.
   *
   * @param query - Search term.
   * @returns Search results containing autocomplete suggestions and top entities.
   * @internal
   */
  private async _resolveSearchSuggestions(
    query: string
  ): Promise<SourceResult> {
    await this._ensureToken('anonymous')
    if (!this.anonymousToken) return { loadType: 'empty', data: {} }

    try {
      const data = await this._internalApiRequest<{
        searchV2?: {
          topResultsV2?: {
            itemsV2?: Array<{
              __typename?: string
              item?: {
                __typename?: string
                data?: {
                  __typename?: string
                  id?: string
                  name?: string
                  text?: string
                  uri?: string
                  duration?: { totalMilliseconds?: number }
                  artists?: { items?: Array<{ profile?: { name: string } }> }
                  coverArt?: {
                    sources?: Array<{
                      url: string
                      width?: number
                      height?: number
                    }>
                  }
                  albumOfTrack?: {
                    coverArt?: {
                      sources?: Array<{
                        url: string
                        width?: number
                        height?: number
                      }>
                    }
                  }
                }
              }
            }>
          }
        }
      }>(QUERIES.searchSuggestions, { query })

      const items = data?.searchV2?.topResultsV2?.itemsV2 || []
      const tracks: TrackData[] = []

      for (const h of items) {
        const item = h.item
        if (!item) continue

        if (item.__typename === 'SearchAutoCompleteEntity') {
          const text = item.data?.text || ''
          const uri = item.data?.uri || ''
          const identifier = uri.split(':').pop() || text
          const info: TrackInfo = {
            identifier,
            isSeekable: false,
            author: 'Spotify Suggestion',
            length: 0,
            isStream: false,
            position: 0,
            title: text,
            uri: uri.startsWith('spotify:')
              ? `https://open.spotify.com/search/${encodeURIComponent(text)}`
              : uri,
            artworkUrl: null,
            isrc: null,
            sourceName: 'spotify'
          }
          tracks.push({
            encoded: encodeTrack({ ...info, details: [] }),
            info,
            pluginInfo: { type: 'suggestion', query: text }
          })
        } else if (item.data?.name) {
          const d = item.data
          const id = d.id || d.uri?.split(':').pop() || ''
          const author =
            d.artists?.items
              ?.map((a) => a.profile?.name)
              .filter(Boolean)
              .join(', ') || 'Unknown'
          const artwork =
            this._pickLargestImage(d.albumOfTrack?.coverArt?.sources) ||
            this._pickLargestImage(d.coverArt?.sources) ||
            null
          const duration = d.duration?.totalMilliseconds ?? 0
          const itemType = d.__typename?.toLowerCase() || 'track'

          const info: TrackInfo = {
            identifier: id,
            isSeekable: itemType === 'track',
            author,
            length: duration,
            isStream: false,
            position: 0,
            title: d.name || 'Unknown',
            uri: d.uri?.startsWith('spotify:track:')
              ? `https://open.spotify.com/track/${id}`
              : `https://open.spotify.com/search/${encodeURIComponent(d.name || '')}`,
            artworkUrl: artwork,
            isrc: null,
            sourceName: 'spotify'
          }
          tracks.push({
            encoded: encodeTrack({ ...info, details: [] }),
            info,
            pluginInfo: { type: itemType }
          })
        }
      }

      return tracks.length > 0
        ? {
            loadType: 'search',
            data: tracks
          }
        : { loadType: 'empty', data: {} }
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
   * Resolves the user's liked songs/collection tracks.
   * Requires an authenticated session via sp_dc.
   *
   * @param id - Collection identifier (e.g. 'tracks', 'your-episodes').
   * @returns Playlist containing user library tracks.
   * @internal
   */
  private async _resolveCollection(id: string): Promise<SourceResult> {
    if (!this.config.sp_dc && !this.mobileToken) {
      return {
        loadType: 'error',
        exception: {
          message:
            'Accessing Spotify user collection requires sp_dc cookie authentication.',
          severity: 'common'
        }
      }
    }

    try {
      const data = await this._internalApiRequest<{
        me?: {
          library?: {
            tracks?: {
              totalCount?: number
              items?: Array<{
                track?: {
                  data?: SpotifyGraphQLTrack
                }
              }>
            }
          }
        }
      }>(
        QUERIES.fetchLibraryTracks,
        { offset: 0, limit: 50 },
        this.mobileToken ? 'mobile' : 'anonymous'
      )

      const items = data?.me?.library?.tracks?.items || []
      const tracks: TrackData[] = []

      for (const it of items) {
        const trackData = it.track?.data
        if (!trackData) continue
        const track = this._buildTrackFromInternal(trackData)
        if (track) tracks.push(track)
      }

      if (tracks.length > 0) {
        return {
          loadType: 'playlist',
          data: {
            info: {
              name: 'Liked Songs',
              selectedTrack: 0
            },
            tracks,
            pluginInfo: {
              type: 'collection',
              identifier: id,
              totalTracks:
                data?.me?.library?.tracks?.totalCount ?? tracks.length
            }
          }
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
   * Extracts dominant color palette from album artwork using Pathfinder.
   *
   * @param artworkUrl - Image URL of the artwork.
   * @returns Color palette or null if extraction fails.
   * @internal
   */
  private async _fetchArtworkColors(
    artworkUrl: string | null
  ): Promise<{ dark?: string; light?: string; raw?: string } | null> {
    if (!artworkUrl) return null
    const match =
      artworkUrl.match(/\/image\/([a-f0-9]{32,40})/i) ||
      artworkUrl.match(/spotify:image:([a-f0-9]{32,40})/i)
    if (!match?.[1]) return null

    try {
      const data = await this._internalApiRequest<{
        extractedColors?: Array<{
          colorDark?: { hex?: string }
          colorLight?: { hex?: string }
          colorRaw?: { hex?: string }
        }>
      }>(QUERIES.fetchExtractedColors, {
        imageUris: [`spotify:image:${match[1]}`]
      })

      const palette = data?.extractedColors?.[0]
      if (!palette) return null

      return {
        dark: palette.colorDark?.hex,
        light: palette.colorLight?.hex,
        raw: palette.colorRaw?.hex
      }
    } catch {
      return null
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
        artists
          .map((a) => a?.profile?.name || a?.name)
          .filter(Boolean)
          .join(', ') || 'Unknown'
      )
    }
    const first = (it as SpotifyGraphQLTrack).firstArtist?.items?.[0]
    if (first) return first.profile?.name || 'Unknown'

    const official = (it as SpotifyTrack).artists
    if (official) {
      return (
        official
          .map((a) => a?.name)
          .filter(Boolean)
          .join(', ') || 'Unknown'
      )
    }

    return 'Unknown'
  }

  /**
   * Declarative test suite for Spotify source resolution and query variants.
   * @public
   */
  public static readonly _TESTS: readonly SourceTestCase[] = [
    {
      id: 'spotify.track.standard',
      name: 'Standard HTTPS Track resolution (Billie Eilish - ocean eyes)',
      input: {
        type: 'resolve',
        value: 'https://open.spotify.com/track/4eoOQgFQ0rLMKNP8KcUNWc'
      },
      expect: {
        result: { type: 'track' },
        metadata: {
          identifier: { op: 'equals', value: '4eoOQgFQ0rLMKNP8KcUNWc' },
          title: { op: 'matches', value: 'ocean eyes' },
          author: { op: 'matches', value: 'Billie Eilish' },
          sourceName: { op: 'equals', value: 'spotify' }
        }
      }
    },
    {
      id: 'spotify.track.uri',
      name: 'Spotify URI Track format resolution (spotify:track:ID)',
      input: {
        type: 'resolve',
        value: 'spotify:track:4eoOQgFQ0rLMKNP8KcUNWc'
      },
      expect: {
        result: { type: 'track' },
        metadata: {
          identifier: { op: 'equals', value: '4eoOQgFQ0rLMKNP8KcUNWc' },
          title: { op: 'matches', value: 'ocean eyes' },
          sourceName: { op: 'equals', value: 'spotify' }
        }
      }
    },
    {
      id: 'spotify.track.localized',
      name: 'Localized Regional URL Track resolution (/intl-pt/track/ID)',
      input: {
        type: 'resolve',
        value: 'https://open.spotify.com/intl-pt/track/4IpaCWsYoiRLG4CihCt1Pd'
      },
      expect: {
        result: { type: 'track' },
        metadata: {
          identifier: { op: 'equals', value: '4IpaCWsYoiRLG4CihCt1Pd' },
          sourceName: { op: 'equals', value: 'spotify' }
        }
      }
    },
    {
      id: 'spotify.track.embed',
      name: 'Embed URL Track resolution (/embed/track/ID)',
      input: {
        type: 'resolve',
        value: 'https://open.spotify.com/embed/track/6dOtVTDdiauQNBQEDOtlAB'
      },
      expect: {
        result: { type: 'track' },
        metadata: {
          identifier: { op: 'equals', value: '6dOtVTDdiauQNBQEDOtlAB' },
          sourceName: { op: 'equals', value: 'spotify' }
        }
      }
    },
    {
      id: 'spotify.album.standard',
      name: 'Standard HTTPS Album resolution (Billie Eilish - HIT ME HARD AND SOFT)',
      input: {
        type: 'resolve',
        value: 'https://open.spotify.com/album/7aJuG4TFXa2hmE4z1yxc3n'
      },
      expect: {
        result: { type: 'playlist' },
        collection: {
          minItems: 10,
          maxItems: 10
        }
      }
    },
    {
      id: 'spotify.album.uri',
      name: 'Spotify URI Album format resolution (spotify:album:ID)',
      input: {
        type: 'resolve',
        value: 'spotify:album:7aJuG4TFXa2hmE4z1yxc3n'
      },
      expect: {
        result: { type: 'playlist' },
        collection: {
          minItems: 10,
          maxItems: 10
        }
      }
    },
    {
      id: 'spotify.playlist.standard',
      name: 'Small playlist resolution (5 tracks)',
      input: {
        type: 'resolve',
        value: 'https://open.spotify.com/playlist/0Gf1aUizIT2TLKlu2qYlh2'
      },
      expect: {
        result: { type: 'playlist' },
        collection: {
          minItems: 5,
          maxItems: 5
        }
      }
    },
    {
      id: 'spotify.playlist.legacy_user',
      name: 'Legacy user playlist URL format (/user/<username>/playlist/ID)',
      input: {
        type: 'resolve',
        value: 'https://open.spotify.com/user/filtr.br/playlist/5HmZtuuIDMtIy21kylqhx6'
      },
      expect: {
        result: { type: 'playlist' },
        collection: {
          minItems: 1
        }
      }
    },
    {
      id: 'spotify.playlist.paginated',
      name: 'Multi-page paginated playlist (101 tracks capped by playback limit)',
      input: {
        type: 'resolve',
        value: 'https://open.spotify.com/playlist/5YFtKCsIIxyzCMZiZ29JDj'
      },
      expect: {
        result: { type: 'playlist' },
        collection: {
          minItems: 100,
          maxItems: 101
        }
      }
    },
    {
      id: 'spotify.playlist.uri',
      name: 'Spotify URI Playlist format resolution (spotify:playlist:ID)',
      input: {
        type: 'resolve',
        value: 'spotify:playlist:1QscjgKRfrGpiDFMyT9rwO'
      },
      expect: {
        result: { type: 'playlist' },
        collection: {
          minItems: 10
        }
      }
    },
    {
      id: 'spotify.artist.top_tracks',
      name: 'Artist top tracks resolution (Billie Eilish)',
      input: {
        type: 'resolve',
        value: 'https://open.spotify.com/artist/6qqNVTkY8uBg9cP3Jd7DAH'
      },
      expect: {
        result: { type: 'playlist' },
        collection: {
          minItems: 5,
          maxItems: 10
        }
      }
    },
    {
      id: 'spotify.artist.uri',
      name: 'Spotify URI Artist format resolution (spotify:artist:ID)',
      input: {
        type: 'resolve',
        value: 'spotify:artist:6qqNVTkY8uBg9cP3Jd7DAH'
      },
      expect: {
        result: { type: 'playlist' },
        collection: {
          minItems: 5,
          maxItems: 10
        }
      }
    },
    {
      id: 'spotify.search.track',
      name: 'Search track query prefix (spsearch:)',
      input: {
        type: 'search',
        value: 'ocean eyes billie eilish',
        searchType: 'spsearch'
      },
      expect: {
        result: { type: 'search' },
        collection: {
          minItems: 1
        }
      }
    },
    {
      id: 'spotify.recommendations',
      name: 'Recommendations seed query prefix (sprec:)',
      input: {
        type: 'search',
        value: '4eoOQgFQ0rLMKNP8KcUNWc',
        searchType: 'sprec'
      },
      expect: {
        result: { type: 'playlist' },
        collection: {
          minItems: 1
        }
      }
    },
    {
      id: 'spotify.episode.standard',
      name: 'Standard HTTPS Episode resolution (Café Com Crime #204)',
      input: {
        type: 'resolve',
        value: 'https://open.spotify.com/episode/4RYJrq9SflTVb5Mmt6SZzH'
      },
      expect: {
        result: { type: 'track' },
        metadata: {
          identifier: { op: 'equals', value: '4RYJrq9SflTVb5Mmt6SZzH' },
          title: { op: 'matches', value: 'ESTRANGULADOR DE VELHINHAS' },
          author: { op: 'matches', value: 'Café Com Crime' },
          sourceName: { op: 'equals', value: 'spotify' }
        }
      }
    },
    {
      id: 'spotify.episode.uri',
      name: 'Spotify URI Episode format resolution (spotify:episode:ID)',
      input: {
        type: 'resolve',
        value: 'spotify:episode:4RYJrq9SflTVb5Mmt6SZzH'
      },
      expect: {
        result: { type: 'track' },
        metadata: {
          identifier: { op: 'equals', value: '4RYJrq9SflTVb5Mmt6SZzH' },
          title: { op: 'matches', value: 'ESTRANGULADOR DE VELHINHAS' },
          sourceName: { op: 'equals', value: 'spotify' }
        }
      }
    },
    {
      id: 'spotify.show.standard',
      name: 'Standard HTTPS Show/Podcast resolution (The Daily Podcast)',
      input: {
        type: 'resolve',
        value: 'https://open.spotify.com/show/0F9gK0W6WXJSomup66hq03'
      },
      expect: {
        result: { type: 'playlist' },
        collection: {
          minItems: 1
        }
      }
    },
    {
      id: 'spotify.show.uri',
      name: 'Spotify URI Show/Podcast format resolution (spotify:show:ID)',
      input: {
        type: 'resolve',
        value: 'spotify:show:0F9gK0W6WXJSomup66hq03'
      },
      expect: {
        result: { type: 'playlist' },
        collection: {
          minItems: 1
        }
      }
    },
    {
      id: 'spotify.playlist.legacy_uri',
      name: 'Spotify Legacy User Playlist URI resolution (spotify:user:USER:playlist:ID)',
      input: {
        type: 'resolve',
        value: 'spotify:user:filtr.br:playlist:5HmZtuuIDMtIy21kylqhx6'
      },
      expect: {
        result: { type: 'playlist' },
        collection: {
          minItems: 1
        }
      }
    },
    {
      id: 'spotify.audiobook.standard',
      name: 'Standard HTTPS Audiobook resolution (É para o meu bem)',
      input: {
        type: 'resolve',
        value: 'https://open.spotify.com/audiobook/4qZuZTP75A5J1o5vilMrYG'
      },
      expect: {
        result: { type: 'playlist' },
        collection: {
          minItems: 1
        }
      }
    },
    {
      id: 'spotify.audiobook.uri',
      name: 'Spotify URI Audiobook format resolution (spotify:audiobook:ID)',
      input: {
        type: 'resolve',
        value: 'spotify:audiobook:4qZuZTP75A5J1o5vilMrYG'
      },
      expect: {
        result: { type: 'playlist' },
        collection: {
          minItems: 1
        }
      }
    },
    {
      id: 'spotify.chapter.standard',
      name: 'Standard HTTPS Chapter resolution',
      input: {
        type: 'resolve',
        value: 'https://open.spotify.com/chapter/0aSCVEDpxaoHjIEzUcsXbz'
      },
      expect: {
        result: { type: 'track' },
        metadata: {
          identifier: { op: 'equals', value: '0aSCVEDpxaoHjIEzUcsXbz' },
          sourceName: { op: 'equals', value: 'spotify' }
        }
      }
    },
    {
      id: 'spotify.chapter.uri',
      name: 'Spotify URI Chapter format resolution (spotify:chapter:ID)',
      input: {
        type: 'resolve',
        value: 'spotify:chapter:0aSCVEDpxaoHjIEzUcsXbz'
      },
      expect: {
        result: { type: 'track' },
        metadata: {
          identifier: { op: 'equals', value: '0aSCVEDpxaoHjIEzUcsXbz' },
          sourceName: { op: 'equals', value: 'spotify' }
        }
      }
    },
    {
      id: 'spotify.details.uri',
      name: 'Spotify URI Details format with palette extraction (spotify:details:ID)',
      input: {
        type: 'resolve',
        value: 'spotify:details:4eoOQgFQ0rLMKNP8KcUNWc'
      },
      expect: {
        result: { type: 'track' },
        metadata: {
          identifier: { op: 'equals', value: '4eoOQgFQ0rLMKNP8KcUNWc' },
          title: { op: 'matches', value: 'ocean eyes' },
          sourceName: { op: 'equals', value: 'spotify' }
        }
      }
    },
    {
      id: 'spotify.similar.uri',
      name: 'Spotify URI Similar format resolution (spotify:similar:ID)',
      input: {
        type: 'resolve',
        value: 'spotify:similar:4eoOQgFQ0rLMKNP8KcUNWc'
      },
      expect: {
        result: { type: 'playlist' },
        collection: {
          minItems: 1
        }
      }
    },
    {
      id: 'spotify.search.suggest',
      name: 'Spotify Autocomplete suggestions prefix (spsuggest:)',
      input: {
        type: 'search',
        value: 'ocean eyes',
        searchType: 'spsuggest'
      },
      expect: {
        result: { type: 'search' },
        collection: {
          minItems: 1
        }
      }
    },
    {
      id: 'spotify.search.similar',
      name: 'Spotify Similar recommendations prefix (spsimilar:)',
      input: {
        type: 'search',
        value: '4eoOQgFQ0rLMKNP8KcUNWc',
        searchType: 'spsimilar'
      },
      expect: {
        result: { type: 'playlist' },
        collection: {
          minItems: 1
        }
      }
    }
  ]
}
