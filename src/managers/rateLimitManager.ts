import type {
  ApiRateLimitResult,
  ApiRequest
} from '../typings/api/api.types.ts'
import type {
  RateLimitConfig,
  RateLimitEntry,
  RateLimitRule
} from '../typings/api/rateLimit.types.ts'
import { logger } from '../utils.ts'

type RateLimitContext = {
  options?: {
    rateLimit?: Partial<RateLimitConfig>
    api?: {
      rateLimit?: Partial<RateLimitConfig>
      [key: string]: unknown
    }
    security?: {
      rateLimit?: Partial<RateLimitConfig>
      [key: string]: unknown
    }
  }
}

const DEFAULT_PER_USER: RateLimitRule = {
  maxRequests: 50,
  timeWindowMs: 5000
}

const DEFAULT_PER_GUILD: RateLimitRule = {
  maxRequests: 20,
  timeWindowMs: 5000
}

const DEFAULT_UPGRADE_RULE: RateLimitRule = {
  maxRequests: 30,
  timeWindowMs: 10000
}

const DEFAULT_CONFIG: RateLimitConfig = {
  enabled: true,
  global: {
    maxRequests: 1000,
    timeWindowMs: 60000
  },
  perIp: {
    maxRequests: 100,
    timeWindowMs: 10000
  },
  perUserId: DEFAULT_PER_USER,
  perGuildId: DEFAULT_PER_GUILD,
  upgrade: DEFAULT_UPGRADE_RULE,
  routeWeights: {
    '/loadtracks': 5,
    '/loadstream': 5,
    '/loadlyrics': 3,
    '/meaning': 3,
    '/decodetracks': 2
  },
  defaultCost: 1,
  ipv6SubnetMask: 64,
  ignorePaths: [],
  ignore: {
    userIds: [],
    guildIds: [],
    ips: [],
    paths: []
  },
  trustProxy: false,
  trustedProxies: [],
  maxEntries: 10000
}

const MIN_WINDOW_MS = 1000
const MIN_CLEANUP_INTERVAL_MS = 1000
const MAX_CLEANUP_INTERVAL_MS = 60000

/**
 * Enforces Token Bucket rate limits across global, IP, user, guild, and WebSocket scopes.
 * @remarks O(1) memory and CPU per key with LRU cache eviction and IPv6 subnet grouping.
 * @public
 */
export default class RateLimitManager {
  private readonly nodelink: RateLimitContext
  private config: RateLimitConfig
  private store: Map<string, RateLimitEntry>
  private cleanupInterval: NodeJS.Timeout | null

  /**
   * Creates a new rate limit manager instance.
   * @param nodelink - NodeLink runtime context.
   */
  constructor(nodelink: RateLimitContext) {
    this.nodelink = nodelink
    this.config = this._resolveConfig(
      nodelink.options?.api?.rateLimit ??
        nodelink.options?.security?.rateLimit ??
        nodelink.options?.rateLimit
    )
    this.store = new Map()
    this.cleanupInterval = setInterval(
      () => this._cleanup(),
      this._resolveCleanupInterval()
    )
    this.cleanupInterval?.unref?.()
  }

  /**
   * Checks the incoming REST request against configured rate limits.
   * @param req - Incoming API request.
   * @param parsedUrl - Parsed request URL.
   */
  check(req: ApiRequest, parsedUrl: URL): ApiRateLimitResult {
    const isEnabled = this.config.enabled
    if (!isEnabled) {
      return { allowed: true }
    }

    const pathname = parsedUrl.pathname ?? ''
    const isIgnored = this._isIgnoredPath(pathname)
    if (isIgnored) {
      return { allowed: true }
    }

    const now = Date.now()
    const remoteAddress = this._resolveRemoteAddress(req)
    const userId = this._getHeaderValue(req.headers, 'user-id')
    const guildId = this._extractGuildId(pathname)

    const shouldBypass = this._shouldIgnore(
      pathname,
      remoteAddress,
      userId,
      guildId
    )
    if (shouldBypass) {
      return { allowed: true }
    }

    const cost = this._resolveRouteCost(pathname)
    let bestResult: ApiRateLimitResult | null = null

    const globalResult = this._checkAndConsumeToken(
      'global',
      'all',
      this.config.global,
      cost,
      now
    )
    if (!globalResult.allowed) {
      logger(
        'warn',
        'RateLimit',
        `Global rate limit exceeded for ${remoteAddress ?? 'unknown'}`
      )
      return globalResult
    }
    bestResult = this._pickBestResult(bestResult, globalResult)

    if (remoteAddress) {
      const ipResult = this._checkAndConsumeToken(
        'ip',
        remoteAddress,
        this.config.perIp,
        cost,
        now
      )
      if (!ipResult.allowed) {
        logger(
          'warn',
          'RateLimit',
          `IP rate limit exceeded for ${remoteAddress}`
        )
        return ipResult
      }
      bestResult = this._pickBestResult(bestResult, ipResult)
    }

    const userRule = this.config.perUserId
    if (userId && userRule) {
      const userResult = this._checkAndConsumeToken(
        'userId',
        userId,
        userRule,
        cost,
        now
      )
      if (!userResult.allowed) {
        logger(
          'warn',
          'RateLimit',
          `User-Id rate limit exceeded for ${userId} (IP: ${remoteAddress ?? 'unknown'})`
        )
        return userResult
      }
      bestResult = this._pickBestResult(bestResult, userResult)
    }

    const guildRule = this.config.perGuildId
    if (guildId && guildRule) {
      const guildResult = this._checkAndConsumeToken(
        'guildId',
        guildId,
        guildRule,
        cost,
        now
      )
      if (!guildResult.allowed) {
        logger(
          'warn',
          'RateLimit',
          `Guild-Id rate limit exceeded for ${guildId} (IP: ${remoteAddress ?? 'unknown'}, User: ${userId ?? 'unknown'})`
        )
        return guildResult
      }
      bestResult = this._pickBestResult(bestResult, guildResult)
    }

    return bestResult ?? { allowed: true }
  }

  /**
   * Checks incoming WebSocket upgrade requests against rate limits.
   * @param req - Incoming HTTP upgrade request.
   * @param parsedUrl - Parsed URL.
   */
  checkUpgrade(req: ApiRequest, parsedUrl: URL): ApiRateLimitResult {
    const isEnabled = this.config.enabled
    if (!isEnabled) {
      return { allowed: true }
    }

    const upgradeRule = this.config.upgrade ?? DEFAULT_UPGRADE_RULE
    const now = Date.now()
    const remoteAddress = this._resolveRemoteAddress(req)
    const userId = this._getHeaderValue(req.headers, 'user-id')

    const shouldBypass = this._shouldIgnore(
      parsedUrl.pathname,
      remoteAddress,
      userId,
      null
    )
    if (shouldBypass) {
      return { allowed: true }
    }

    if (remoteAddress) {
      const result = this._checkAndConsumeToken(
        'wsUpgrade',
        remoteAddress,
        upgradeRule,
        1,
        now
      )
      if (!result.allowed) {
        logger(
          'warn',
          'RateLimit',
          `WebSocket upgrade rate limit exceeded for ${remoteAddress}`
        )
        return result
      }
      return result
    }

    return { allowed: true }
  }

  /**
   * Clears all tracked rate limit entries.
   */
  clear(): void {
    this.store.clear()
  }

  /**
   * Stops cleanup timers and clears state.
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    this.store.clear()
  }

  /**
   * Resolves the token cost for a specific route.
   * @param pathname - Request pathname.
   * @internal
   */
  private _resolveRouteCost(pathname: string): number {
    const weights = this.config.routeWeights ?? {}
    const entries = Object.entries(weights)

    for (const [routePrefix, weight] of entries) {
      const matches = pathname.includes(routePrefix)
      if (matches) {
        return Math.max(1, weight)
      }
    }

    return this.config.defaultCost ?? 1
  }

  /**
   * Builds a rate limit key for storage.
   * @param type - Bucket type.
   * @param id - Identifier value.
   * @internal
   */
  private _getKey(type: string, id: string): string {
    return `${type}:${id}`
  }

  /**
   * Applies the Token Bucket algorithm to consume tokens and enforce limits.
   * @param type - Bucket type.
   * @param id - Bucket identifier.
   * @param rule - Rate limit rule.
   * @param cost - Tokens to consume.
   * @param now - Current timestamp.
   * @internal
   */
  private _checkAndConsumeToken(
    type: string,
    id: string,
    rule: RateLimitRule,
    cost: number,
    now: number
  ): ApiRateLimitResult {
    const maxRequests = Math.max(1, rule.maxRequests)
    const timeWindowMs = Math.max(MIN_WINDOW_MS, rule.timeWindowMs)
    const key = this._getKey(type, id)

    const entry = this._getOrCreateEntry(key, maxRequests, now)
    const elapsed = Math.max(0, now - entry.lastRefill)
    const refillRate = maxRequests / timeWindowMs
    const replenishedTokens = Math.min(
      maxRequests,
      entry.tokens + elapsed * refillRate
    )

    entry.tokens = replenishedTokens
    entry.lastRefill = now
    entry.lastSeen = now

    // Re-insert into Map to maintain true O(1) LRU order
    this.store.delete(key)
    this.store.set(key, entry)

    const hasEnoughTokens = entry.tokens >= cost
    if (!hasEnoughTokens) {
      const missingTokens = cost - entry.tokens
      const waitMs = Math.ceil(missingTokens / refillRate)
      const resetTimestamp = now + waitMs

      return {
        allowed: false,
        limit: maxRequests,
        remaining: 0,
        reset: resetTimestamp
      }
    }

    entry.tokens -= cost
    const remainingTokens = Math.floor(entry.tokens)
    const fullRefillMs = Math.ceil((maxRequests - entry.tokens) / refillRate)
    const resetTimestamp = now + fullRefillMs

    return {
      allowed: true,
      limit: maxRequests,
      remaining: remainingTokens,
      reset: resetTimestamp
    }
  }

  /**
   * Chooses the strictest rate limit result for header reporting.
   * @param current - Current best result.
   * @param candidate - Candidate result.
   * @internal
   */
  private _pickBestResult(
    current: ApiRateLimitResult | null,
    candidate: ApiRateLimitResult
  ): ApiRateLimitResult {
    const candRem = candidate.remaining
    const candLim = candidate.limit
    const candReset = candidate.reset

    if (
      candRem === undefined ||
      candLim === undefined ||
      candReset === undefined
    ) {
      return current ?? candidate
    }

    const currRem = current?.remaining
    if (currRem === undefined || current === null) {
      return candidate
    }

    if (candRem < currRem) {
      return candidate
    }

    const currReset = current.reset ?? Infinity
    if (candRem === currRem && candReset < currReset) {
      return candidate
    }

    return current
  }

  /**
   * Resolves and normalizes config values with defaults.
   * @param config - Partial config overrides.
   * @internal
   */
  private _resolveConfig(config?: Partial<RateLimitConfig>): RateLimitConfig {
    const globalRule = config?.global ?? DEFAULT_CONFIG.global
    const perIpRule = config?.perIp ?? DEFAULT_CONFIG.perIp
    const perUserId = config?.perUserId ?? DEFAULT_CONFIG.perUserId
    const perGuildId = config?.perGuildId ?? DEFAULT_CONFIG.perGuildId
    const perUserFallback = DEFAULT_CONFIG.perUserId ?? DEFAULT_PER_USER
    const perGuildFallback = DEFAULT_CONFIG.perGuildId ?? DEFAULT_PER_GUILD

    return {
      enabled: config?.enabled ?? DEFAULT_CONFIG.enabled,
      global: this._normalizeRule(globalRule, DEFAULT_CONFIG.global),
      perIp: this._normalizeRule(perIpRule, DEFAULT_CONFIG.perIp),
      perUserId: perUserId
        ? this._normalizeRule(perUserId, perUserFallback)
        : undefined,
      perGuildId: perGuildId
        ? this._normalizeRule(perGuildId, perGuildFallback)
        : undefined,
      upgrade: config?.upgrade
        ? this._normalizeRule(config.upgrade, DEFAULT_UPGRADE_RULE)
        : DEFAULT_UPGRADE_RULE,
      routeWeights: config?.routeWeights ?? DEFAULT_CONFIG.routeWeights,
      defaultCost: Math.max(1, config?.defaultCost ?? 1),
      ipv6SubnetMask: config?.ipv6SubnetMask ?? 64,
      ignorePaths: config?.ignorePaths ?? DEFAULT_CONFIG.ignorePaths,
      ignore: {
        userIds:
          config?.ignore?.userIds ?? DEFAULT_CONFIG.ignore?.userIds ?? [],
        guildIds:
          config?.ignore?.guildIds ?? DEFAULT_CONFIG.ignore?.guildIds ?? [],
        ips: config?.ignore?.ips ?? DEFAULT_CONFIG.ignore?.ips ?? [],
        paths: config?.ignore?.paths ?? DEFAULT_CONFIG.ignore?.paths ?? []
      },
      trustProxy: config?.trustProxy ?? DEFAULT_CONFIG.trustProxy,
      trustedProxies:
        config?.trustedProxies ?? DEFAULT_CONFIG.trustedProxies ?? [],
      maxEntries: Math.max(
        100,
        Number(config?.maxEntries ?? DEFAULT_CONFIG.maxEntries)
      )
    }
  }

  /**
   * Normalizes rate limit rules and enforces minimums.
   * @param rule - Raw rule.
   * @param fallback - Fallback rule.
   * @internal
   */
  private _normalizeRule(
    rule: RateLimitRule,
    fallback: RateLimitRule
  ): RateLimitRule {
    return {
      maxRequests: Math.max(
        1,
        Number(rule?.maxRequests ?? fallback.maxRequests)
      ),
      timeWindowMs: Math.max(
        MIN_WINDOW_MS,
        Number(rule?.timeWindowMs ?? fallback.timeWindowMs)
      )
    }
  }

  /**
   * Checks whether a pathname should bypass limits.
   * @param pathname - Request pathname.
   * @internal
   */
  private _isIgnoredPath(pathname: string): boolean {
    if (!pathname) return false

    const ignorePaths = this.config.ignorePaths ?? []
    const isDirectIgnored = ignorePaths.some((path) =>
      pathname.startsWith(path)
    )
    if (isDirectIgnored) return true

    const ignoreList = this.config.ignore?.paths ?? []
    return ignoreList.some((path) => pathname.startsWith(path))
  }

  /**
   * Checks whether identifiers match ignore lists.
   * @param pathname - Request pathname.
   * @param ip - Normalized IP address.
   * @param userId - User ID header.
   * @param guildId - Guild identifier.
   * @internal
   */
  private _shouldIgnore(
    pathname: string,
    ip: string | null,
    userId: string | undefined,
    guildId: string | null
  ): boolean {
    const ignore = this.config.ignore
    if (!ignore) return false

    const isIpIgnored = Boolean(ip && ignore.ips?.includes(ip))
    if (isIpIgnored) return true

    const isUserIgnored = Boolean(userId && ignore.userIds?.includes(userId))
    if (isUserIgnored) return true

    const isGuildIgnored = Boolean(
      guildId && ignore.guildIds?.includes(guildId)
    )
    if (isGuildIgnored) return true

    const pathList = ignore.paths ?? []
    const isPathIgnored = Boolean(
      pathname && pathList.some((path) => pathname.startsWith(path))
    )
    return isPathIgnored
  }

  /**
   * Resolves the remote address from the request securely.
   * @param req - Incoming API request.
   * @internal
   */
  private _resolveRemoteAddress(req: ApiRequest): string | null {
    const socketAddress = req.socket?.remoteAddress

    const trustProxyEnabled = this.config.trustProxy === true
    if (!trustProxyEnabled) {
      return this._normalizeIp(socketAddress)
    }

    const headers = req.headers
    const cfConnectingIp = this._getHeaderValue(headers, 'cf-connecting-ip')
    const trueClientIp = this._getHeaderValue(headers, 'true-client-ip')
    const xRealIp = this._getHeaderValue(headers, 'x-real-ip')
    const forwardedFor = this._getHeaderValue(headers, 'x-forwarded-for')

    const proxyCandidate =
      cfConnectingIp ??
      trueClientIp ??
      xRealIp ??
      forwardedFor?.split(',')?.[0]?.trim() ??
      socketAddress

    return this._normalizeIp(proxyCandidate)
  }

  /**
   * Normalizes IP addresses for consistent keys, including IPv6 subnet masking.
   * @param ip - Raw IP string.
   * @internal
   */
  private _normalizeIp(ip: string | undefined | null): string | null {
    if (!ip) return null
    let normalized = ip.trim()
    if (!normalized) return null

    const hasIpv4MappedPrefix = normalized.startsWith('::ffff:')
    if (hasIpv4MappedPrefix) {
      normalized = normalized.slice(7)
    }

    const hasBrackets = normalized.startsWith('[') && normalized.endsWith(']')
    if (hasBrackets) {
      normalized = normalized.slice(1, -1)
    }

    const isIpv6 = normalized.includes(':')
    if (isIpv6) {
      return this._maskIpv6(normalized)
    }

    return normalized || null
  }

  /**
   * Masks IPv6 addresses to group /64 subnets together.
   * @param ipv6 - Cleaned IPv6 string.
   * @internal
   */
  private _maskIpv6(ipv6: string): string {
    const segments = ipv6.split(':')
    const maskSize = this.config.ipv6SubnetMask ?? 64

    // A /64 subnet corresponds to the first 4 segments
    const segmentCount = Math.min(8, Math.max(1, Math.floor(maskSize / 16)))
    const prefix = segments.slice(0, segmentCount).join(':')
    return `${prefix}::/${maskSize}`
  }

  /**
   * Extracts a header value as a string.
   * @param headers - Request headers.
   * @param name - Header name.
   * @internal
   */
  private _getHeaderValue(
    headers: ApiRequest['headers'],
    name: string
  ): string | undefined {
    const raw = headers[name] ?? headers[name.toLowerCase()]
    const isArray = Array.isArray(raw)
    return isArray ? raw[0] : raw
  }

  /**
   * Extracts a guild ID from the request path.
   * @param pathname - Request pathname.
   * @internal
   */
  private _extractGuildId(pathname: string): string | null {
    if (!pathname) return null
    const match = pathname.match(/\/players\/(\d+)/)
    return match?.[1] ?? null
  }

  /**
   * Retrieves an existing entry or creates a new Token Bucket entry.
   * @param key - Storage key.
   * @param maxRequests - Max bucket capacity.
   * @param now - Current timestamp.
   * @internal
   */
  private _getOrCreateEntry(
    key: string,
    maxRequests: number,
    now: number
  ): RateLimitEntry {
    const existing = this.store.get(key)
    if (existing) {
      return existing
    }

    const entry: RateLimitEntry = {
      tokens: maxRequests,
      lastRefill: now,
      lastSeen: now
    }
    this.store.set(key, entry)
    this._enforceMaxEntries()
    return entry
  }

  /**
   * Resolves the configured time window for a specific rate limit key.
   * @param key - Storage key.
   * @internal
   */
  private _getWindowForKey(key: string): number {
    const prefix = key.split(':')[0]
    switch (prefix) {
      case 'global':
        return this.config.global.timeWindowMs
      case 'ip':
        return this.config.perIp.timeWindowMs
      case 'userId':
        return this.config.perUserId?.timeWindowMs ?? MIN_WINDOW_MS
      case 'guildId':
        return this.config.perGuildId?.timeWindowMs ?? MIN_WINDOW_MS
      case 'wsUpgrade':
        return this.config.upgrade?.timeWindowMs ?? MIN_WINDOW_MS
      default:
        return MIN_WINDOW_MS
    }
  }

  /**
   * Cleans up stale keys based on idle duration.
   * @internal
   */
  private _cleanup(): void {
    const now = Date.now()

    for (const [key, entry] of this.store.entries()) {
      const windowMs = this._getWindowForKey(key)
      const pruneThreshold = windowMs * 3
      const isIdle = now - entry.lastSeen > pruneThreshold

      if (isIdle) {
        this.store.delete(key)
      }
    }

    this._enforceMaxEntries()
  }

  /**
   * Enforces max entries using true O(1) LRU eviction without sorting.
   * @internal
   */
  private _enforceMaxEntries(): void {
    const maxEntries =
      this.config.maxEntries ?? DEFAULT_CONFIG.maxEntries ?? 10000
    const isExceeded = this.store.size > maxEntries
    if (!isExceeded) return

    const overflowCount = this.store.size - maxEntries
    const iterator = this.store.keys()

    for (let i = 0; i < overflowCount; i++) {
      const oldestKey = iterator.next().value
      if (!oldestKey) break
      this.store.delete(oldestKey)
    }
  }

  /**
   * Resolves the cleanup interval based on the shortest rule window.
   * @internal
   */
  private _resolveCleanupInterval(): number {
    const windows = [
      this.config.global.timeWindowMs,
      this.config.perIp.timeWindowMs,
      this.config.perUserId?.timeWindowMs,
      this.config.perGuildId?.timeWindowMs,
      this.config.upgrade?.timeWindowMs
    ].filter((value): value is number => typeof value === 'number')

    const shortestWindow =
      windows.length > 0 ? Math.min(...windows) : MIN_WINDOW_MS
    const clampedInterval = Math.min(shortestWindow, MAX_CLEANUP_INTERVAL_MS)
    return Math.max(clampedInterval, MIN_CLEANUP_INTERVAL_MS)
  }
}
