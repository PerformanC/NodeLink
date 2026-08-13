/**
 * YouTube cipher/signature manager.
 *
 * Centralizes player-script discovery, STS caching, remote cipher-service
 * integration, and proxy health reporting for YouTube playback URL recovery.
 *
 * @packageDocumentation
 * @module YouTubeCipherManager
 */
import type {
  SourceInstance,
  WorkerNodeLink
} from '../../typings/sources/source.types.ts'
import type {
  ICachedPlayerScript,
  ICipherManager,
  ProxySnapshot,
  YouTubeContext
} from '../../typings/sources/youtube.types.ts'
import type {
  YouTubeCipherConfig,
  YouTubeCipherServiceResponse,
  YouTubeSourceProxyRuntime
} from '../../typings/sources/youtubeClient.types.ts'
import type { HttpRequestHeaders } from '../../typings/utils.types.ts'
import {
  getVersion,
  http1makeRequest,
  logger,
  makeRequest
} from '../../utils.ts'

const CACHE_DURATION_MS = 12 * 60 * 60 * 1000
const VERSION = getVersion()

/**
 * Runtime type guard for source instances exposing YouTube proxy helpers.
 *
 * @param value - Source instance returned by the source manager.
 * @returns `true` when the instance exposes proxy selection or reporting hooks.
 */
function isYouTubeSourceProxyRuntime(
  value: SourceInstance | null | undefined
): value is SourceInstance & YouTubeSourceProxyRuntime {
  if (!value) {
    return false
  }
  const maybeProxyRuntime = value as SourceInstance & YouTubeSourceProxyRuntime

  return !!maybeProxyRuntime.getProxy || !!maybeProxyRuntime.reportProxyStatus
}

/**
 * Cached player script descriptor with a fixed TTL.
 *
 * @internal
 */
class CachedPlayerScript implements ICachedPlayerScript {
  url: string
  expireTimestampMs: number

  /**
   * Creates a cached player script descriptor.
   *
   * @param url - Absolute or relative YouTube player script URL.
   */
  constructor(url: string) {
    this.url = url.startsWith('http') ? url : `https://www.youtube.com${url}`
    this.expireTimestampMs = Date.now() + CACHE_DURATION_MS
  }
}

/**
 * Helper responsible for player-script discovery and cipher-service access.
 *
 * It keeps the active player script cached, resolves signature timestamps,
 * proxies remote cipher-service requests, and forwards proxy health feedback
 * to the main YouTube source.
 *
 * @example
 * ```typescript
 * const cipherManager = new CipherManager(nodelink)
 * const playerScript = await cipherManager.getCachedPlayerScript()
 * ```
 *
 * @public
 */
export default class CipherManager implements ICipherManager {
  /** Worker runtime used for configuration, credentials, and source access. */
  nodelink: WorkerNodeLink
  /** Remote cipher-service configuration loaded from the YouTube source config. */
  config: YouTubeCipherConfig
  /** Lazily refreshed player script descriptor discovered from YouTube. */
  cachedPlayerScript: ICachedPlayerScript | null
  /** Cooperative lock preventing concurrent player-script discovery. */
  cipherLoadLock: boolean
  /** Explicitly configured player script descriptor that overrides discovery. */
  explicitPlayerScriptUrl: ICachedPlayerScript | null
  /** User-Agent sent to the remote cipher service. */
  userAgent: string
  /** In-memory cache of STS values keyed by player script URL. */
  stsCache: Map<string, string>
  /** Periodic timer used to clear the STS cache. */
  stsCacheInterval: ReturnType<typeof setInterval> | null

  /**
   * Creates a cipher manager bound to the active NodeLink YouTube runtime.
   *
   * @param nodelink - Worker runtime used for config, credentials, and proxy hooks.
   */
  constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
    this.config = {
      ...((
        (
          nodelink.options.sources as unknown as
            | Record<string, unknown>
            | undefined
        )?.youtube as { cipher?: YouTubeCipherConfig } | undefined
      )?.cipher ?? {})
    }
    if (this.config.url) {
      this.config.url = this.config.url.replace(/\/+$/, '')
    }

    this.cachedPlayerScript = null
    this.cipherLoadLock = false
    this.explicitPlayerScriptUrl = null
    this.userAgent = `nodelink/${VERSION} (https://github.com/PerformanC/NodeLink)`
    this.stsCache = new Map()
    this.stsCacheInterval = setInterval(() => {
      this.stsCache.clear()
      logger('debug', 'YouTube-Cipher', 'Cleared STS cache (12h interval)')
    }, CACHE_DURATION_MS)
    this.stsCacheInterval.unref()
  }

  private getYouTubeSource(): YouTubeSourceProxyRuntime | null {
    const source = this.nodelink.sources?.getSource?.('youtube')
    return isYouTubeSourceProxyRuntime(source) ? source : null
  }

  private pickProxy(rotate = true): ProxySnapshot | undefined {
    return this.getYouTubeSource()?.getProxy?.(rotate)
  }

  private reportProxyStatus(
    proxy: ProxySnapshot | undefined,
    success: boolean,
    status: number,
    latency = 0
  ): void {
    this.getYouTubeSource()?.reportProxyStatus?.(
      proxy,
      success,
      status,
      latency
    )
  }

  /**
   * Releases timers and in-memory caches held by the cipher manager.
   */
  cleanup(): void {
    if (this.stsCacheInterval) {
      clearInterval(this.stsCacheInterval)
      this.stsCacheInterval = null
    }
    this.stsCache.clear()
  }

  /**
   * Forces the cipher manager to use a specific player script URL.
   *
   * @param url - Absolute or relative player script URL.
   */
  setPlayerScriptUrl(url: string): void {
    this.explicitPlayerScriptUrl = new CachedPlayerScript(url)
    logger(
      'debug',
      'YouTube-Cipher',
      `Explicit player script URL set: ${this.explicitPlayerScriptUrl.url}`
    )
  }

  /**
   * Loads the current player script URL, refreshing it when the cache expires.
   *
   * Resolution order:
   * 1. Explicitly configured player script URL
   * 2. Credential-manager cache
   * 3. Watch-page discovery fallback
   *
   * @example
   * ```typescript
   * const playerScript = await cipherManager.getPlayerScript()
   * console.log(playerScript?.url)
   * ```
   *
   * @returns Cached player script descriptor, or `null` when discovery fails.
   */
  async getPlayerScript(): Promise<ICachedPlayerScript | null> {
    if (this.cipherLoadLock) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      return this.getCachedPlayerScript()
    }

    const cachedUrl = this.nodelink.credentialManager?.get(
      'yt_player_script_url'
    )
    if (
      typeof cachedUrl === 'string' &&
      cachedUrl &&
      !this.explicitPlayerScriptUrl
    ) {
      this.cachedPlayerScript = new CachedPlayerScript(cachedUrl)
      return this.cachedPlayerScript
    }

    this.cipherLoadLock = true
    try {
      if (
        this.explicitPlayerScriptUrl &&
        Date.now() < this.explicitPlayerScriptUrl.expireTimestampMs
      ) {
        logger(
          'debug',
          'YouTube-Cipher',
          `Using explicit player script URL: ${this.explicitPlayerScriptUrl.url}`
        )
        this.cachedPlayerScript = this.explicitPlayerScriptUrl
        return this.cachedPlayerScript
      }

      const scriptUrl = await this.fetchPlayerScriptFromWatchPage('dQw4w9WgXcQ')
      if (!scriptUrl) {
        logger(
          'warn',
          'YouTube-Cipher',
          'Failed to obtain player script URL. Cipher manager might not function correctly.'
        )
        return null
      }

      this.cachedPlayerScript = new CachedPlayerScript(scriptUrl)
      logger(
        'debug',
        'YouTube-Cipher',
        `Obtained player script from watch page: ${this.cachedPlayerScript.url}`
      )
      return this.cachedPlayerScript
    } finally {
      this.cipherLoadLock = false
    }
  }

  /**
   * Returns the active player script descriptor, refreshing it if necessary.
   *
   * @example
   * ```typescript
   * const playerScript = await cipherManager.getCachedPlayerScript()
   * ```
   *
   * @returns Cached player script descriptor, or `null` when unavailable.
   */
  async getCachedPlayerScript(): Promise<ICachedPlayerScript | null> {
    if (
      this.explicitPlayerScriptUrl &&
      Date.now() < this.explicitPlayerScriptUrl.expireTimestampMs
    ) {
      return this.explicitPlayerScriptUrl
    }

    if (
      !this.cachedPlayerScript ||
      Date.now() >= this.cachedPlayerScript.expireTimestampMs
    ) {
      return this.getPlayerScript()
    }

    return this.cachedPlayerScript
  }

  /**
   * Resolves the signature timestamp associated with a player script URL.
   *
   * The timestamp is read from the in-memory cache, the credential manager, the
   * local player script body, or the configured remote cipher service.
   *
   * @param playerUrl - Fully qualified YouTube player script URL.
   *
   * @example
   * ```typescript
   * const sts = await cipherManager.getTimestamp(playerScriptUrl)
   * ```
   *
   * @returns Signature timestamp string used in innertube playback requests.
   */
  async getTimestamp(playerUrl: string): Promise<string> {
    const cachedSts = this.stsCache.get(playerUrl)
    if (cachedSts) {
      return cachedSts
    }

    const persistedSts = this.nodelink.credentialManager?.get(
      `yt_sts_${playerUrl}`
    )
    if (typeof persistedSts === 'string' && persistedSts) {
      this.stsCache.set(playerUrl, persistedSts)
      return persistedSts
    }

    if (!this.config.url) {
      const proxy = this.pickProxy(true)
      const startTime = Date.now()
      let response: Awaited<ReturnType<typeof makeRequest>>
      try {
        response = await makeRequest(playerUrl, { method: 'GET', proxy })
      } catch (error) {
        this.reportProxyStatus(proxy, false, 500, Date.now() - startTime)
        throw error
      }

      const { body, error, statusCode } = response
      this.reportProxyStatus(
        proxy,
        !error && statusCode === 200,
        statusCode ?? 500,
        Date.now() - startTime
      )

      const scriptContent = typeof body === 'string' ? body : ''
      if (error || statusCode !== 200 || !scriptContent) {
        const reason = error || `Status ${statusCode ?? 'unknown'}`
        logger(
          'error',
          'YouTube-Cipher',
          `Failed to fetch player script for timestamp: ${reason}`
        )
        throw new Error(
          `Failed to fetch player script for timestamp: ${reason}`
        )
      }

      const timestampMatch = scriptContent.match(
        /(?:signatureTimestamp|sts):(\d+)/
      )
      const sts = timestampMatch?.[1]
      if (!sts) {
        logger(
          'error',
          'YouTube-Cipher',
          `Timestamp not found in player script: ${playerUrl}`
        )
        throw new Error(`Timestamp not found in player script: ${playerUrl}`)
      }

      logger(
        'debug',
        'YouTube-Cipher',
        `Extracted timestamp from player script: ${sts}`
      )
      this.stsCache.set(playerUrl, sts)
      this.nodelink.credentialManager?.set(
        `yt_sts_${playerUrl}`,
        sts,
        CACHE_DURATION_MS
      )
      return sts
    }

    const headers: HttpRequestHeaders = {
      'Content-Type': 'application/json',
      'User-Agent': this.userAgent
    }
    if (this.config.token) {
      headers.Authorization = this.config.token
    }

    logger('debug', 'YouTube-Cipher', `Fetching STS via /get_sts: ${playerUrl}`)

    const proxy = this.pickProxy(true)
    const startTime = Date.now()
    let response: Awaited<ReturnType<typeof makeRequest>>
    try {
      response = await makeRequest(`${this.config.url}/get_sts`, {
        method: 'POST',
        headers,
        body: { player_url: playerUrl },
        disableBodyCompression: true,
        proxy
      })
    } catch (error) {
      this.reportProxyStatus(proxy, false, 500, Date.now() - startTime)
      throw error
    }

    const { body, error, statusCode } = response
    this.reportProxyStatus(
      proxy,
      !error && statusCode === 200,
      statusCode ?? 500,
      Date.now() - startTime
    )

    const parsedBody = (body ?? {}) as YouTubeCipherServiceResponse
    if (error || statusCode !== 200 || !parsedBody.sts) {
      const detail =
        error ||
        parsedBody.message ||
        (typeof body === 'object' ? JSON.stringify(body) : body) ||
        'Invalid response'
      logger(
        'error',
        'YouTube-Cipher',
        `Failed to get STS from cipher service (Status: ${statusCode ?? 'unknown'}): ${detail}`
      )
      throw new Error(`Failed to get STS: ${detail}`)
    }

    logger('debug', 'YouTube-Cipher', `Received STS: ${parsedBody.sts}`)
    this.stsCache.set(playerUrl, parsedBody.sts)
    return parsedBody.sts
  }

  /**
   * Checks whether the configured remote cipher service is reachable.
   *
   * @example
   * ```typescript
   * const online = await cipherManager.checkCipherServerStatus()
   * ```
   *
   * @returns `true` when the service responds with HTTP 200; otherwise `false`.
   */
  async checkCipherServerStatus(): Promise<boolean> {
    if (!this.config.url) {
      logger(
        'warn',
        'YouTube-Cipher',
        'Remote cipher URL is not configured. Skipping online check.'
      )
      return false
    }

    try {
      const headers: HttpRequestHeaders = {
        'User-Agent': this.userAgent
      }
      if (this.config.token) {
        headers.Authorization = this.config.token
      }

      const proxy = this.pickProxy(true)
      const startTime = Date.now()
      const { statusCode, error } = await http1makeRequest(
        `${this.config.url}/`,
        {
          method: 'GET',
          timeout: 5000,
          headers,
          proxy
        }
      )

      this.reportProxyStatus(
        proxy,
        !error && statusCode === 200,
        statusCode ?? 500,
        Date.now() - startTime
      )

      if (error || statusCode !== 200) {
        logger(
          'warn',
          'YouTube-Cipher',
          `Cipher server at ${this.config.url} is offline or unreachable. Status: ${statusCode || 'N/A'}`
        )
        return false
      }

      logger(
        'info',
        'YouTube-Cipher',
        `Cipher server at ${this.config.url} is online.`
      )
      return true
    } catch {
      this.reportProxyStatus(undefined, false, 500, 0)
      logger(
        'warn',
        'YouTube-Cipher',
        `Cipher server at ${this.config.url} is offline or unreachable.`
      )
      return false
    }
  }

  /**
   * Resolves a cipher-protected YouTube playback URL through the remote service.
   *
   * @param streamUrl - Original playback URL returned by YouTube.
   * @param encryptedSignature - Encrypted signature payload, when present.
   * @param nParam - Obfuscated `n` token requiring transformation.
   * @param signatureKey - Query-string key used for the resolved signature.
   * @param playerScript - Player script metadata used by the remote resolver.
   * @param _context - Optional YouTube context reserved for future use.
   *
   * @example
   * ```typescript
   * const url = await cipherManager.resolveUrl(
   *   streamUrl,
   *   encryptedSignature,
   *   nParam,
   *   signatureKey,
   *   playerScript
   * )
   * ```
   *
   * @returns Final playable URL returned by the cipher service.
   */
  async resolveUrl(
    streamUrl: string,
    encryptedSignature: string | null,
    nParam: string | null,
    signatureKey: string | null,
    playerScript: ICachedPlayerScript,
    _context?: YouTubeContext
  ): Promise<string> {
    if (!this.config.url) {
      throw new Error('Remote cipher URL is not configured.')
    }

    const requestBody: Record<string, string> = {
      stream_url: streamUrl,
      player_url: playerScript.url
    }

    if (encryptedSignature) {
      requestBody.encrypted_signature = encryptedSignature
      requestBody.signature_key = signatureKey || 'sig'
    }

    if (nParam) {
      requestBody.n_param = nParam
    }

    const headers: HttpRequestHeaders = {
      'Content-Type': 'application/json',
      'User-Agent': this.userAgent
    }
    if (this.config.token) {
      headers.Authorization = this.config.token
    }

    logger(
      'debug',
      'YouTube-Cipher',
      `Resolving URL via /resolve_url: ${streamUrl}`
    )
    logger(
      'debug',
      'YouTube-Cipher',
      `Sending to cipher service for player ${playerScript.url}`
    )

    const proxy = this.pickProxy(true)
    const startTime = Date.now()
    let response: Awaited<ReturnType<typeof makeRequest>>
    try {
      response = await makeRequest(`${this.config.url}/resolve_url`, {
        method: 'POST',
        headers,
        body: requestBody,
        disableBodyCompression: true,
        proxy
      })
    } catch (error) {
      this.reportProxyStatus(proxy, false, 500, Date.now() - startTime)
      throw error
    }

    const { body, error, statusCode } = response
    this.reportProxyStatus(
      proxy,
      !error && statusCode === 200,
      statusCode ?? 500,
      Date.now() - startTime
    )

    const parsedBody = (body ?? {}) as YouTubeCipherServiceResponse
    if (error || statusCode !== 200 || !parsedBody.resolved_url) {
      const detail =
        error ||
        parsedBody.message ||
        (typeof body === 'object' ? JSON.stringify(body) : body) ||
        'Invalid response'
      logger(
        'error',
        'YouTube-Cipher',
        `Failed to resolve URL via cipher service (Status: ${statusCode ?? 'unknown'}): ${detail}`
      )
      throw new Error(`Failed to resolve URL: ${detail}`)
    }

    logger(
      'debug',
      'YouTube-Cipher',
      `Received from cipher service (Status: ${statusCode}): ${parsedBody.resolved_url}`
    )

    logger(
      'debug',
      'YouTube-Cipher',
      `Resolved URL: ${parsedBody.resolved_url}`
    )
    return parsedBody.resolved_url
  }

  /**
   * Fetches the player script URL directly from a YouTube watch page.
   *
   * @param videoId - Video identifier used to build the watch-page URL.
   *
   * @example
   * ```typescript
   * const playerScriptUrl =
   *   await cipherManager.fetchPlayerScriptFromWatchPage('dQw4w9WgXcQ')
   * ```
   *
   * @returns Fully qualified player script URL, or `null` if not found.
   */
  private async fetchPlayerScriptFromWatchPage(
    videoId: string
  ): Promise<string | null> {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`
    const proxy = this.pickProxy(true)
    const startTime = Date.now()
    let response: Awaited<ReturnType<typeof makeRequest>>
    try {
      response = await makeRequest(watchUrl, {
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
        },
        proxy
      })
    } catch (error) {
      this.reportProxyStatus(proxy, false, 500, Date.now() - startTime)
      throw error
    }

    const { body, error, statusCode } = response
    this.reportProxyStatus(
      proxy,
      !error && statusCode === 200,
      statusCode ?? 500,
      Date.now() - startTime
    )

    const watchPage = typeof body === 'string' ? body : ''
    if (error || statusCode !== 200 || !watchPage) {
      const reason = error || `Status ${statusCode ?? 'unknown'}`
      throw new Error(`Failed to fetch watch page for player script: ${reason}`)
    }

    const jsUrlMatch = watchPage.match(/"jsUrl":"([^"]+)"/)
    const scriptUrl = jsUrlMatch?.[1]
    if (!scriptUrl) {
      logger(
        'warn',
        'YouTube-Cipher',
        'Could not find jsUrl in watch page. Player script fetching failed.'
      )
      return null
    }

    return `https://www.youtube.com${scriptUrl.replace(/\/[a-z]{2}_[A-Z]{2}\//, '/en_US/')}`
  }
}
