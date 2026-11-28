/**
 * Rate limit rule configuration.
 * @public
 */
export interface RateLimitRule {
  /**
   * Maximum number of requests allowed in the window.
   */
  maxRequests: number

  /**
   * Rolling time window in milliseconds.
   */
  timeWindowMs: number
}

/**
 * Ignore list configuration for rate limiting.
 * @public
 */
export interface RateLimitIgnore {
  /**
   * User IDs to bypass rate limits.
   */
  userIds?: string[]

  /**
   * Guild IDs to bypass rate limits.
   */
  guildIds?: string[]

  /**
   * IPs to bypass rate limits.
   */
  ips?: string[]

  /**
   * Paths to bypass rate limits.
   */
  paths?: string[]
}

/**
 * Rate limit configuration shape.
 * @public
 */
export interface RateLimitConfig {
  /**
   * Whether rate limiting is enabled.
   */
  enabled: boolean

  /**
   * Global rate limit rule.
   */
  global: RateLimitRule

  /**
   * Per-IP rate limit rule.
   */
  perIp: RateLimitRule

  /**
   * Per-user rate limit rule.
   */
  perUserId?: RateLimitRule

  /**
   * Per-guild rate limit rule.
   */
  perGuildId?: RateLimitRule

  /**
   * Rate limit rule for WebSocket upgrade handshakes.
   */
  upgrade?: RateLimitRule

  /**
   * Cost weights per route pathname prefix (e.g. { '/v4/loadtracks': 5 }).
   */
  routeWeights?: Record<string, number>

  /**
   * Default cost consumed per request when not matched in routeWeights.
   * @defaultValue 1
   */
  defaultCost?: number

  /**
   * Subnet mask size for grouping IPv6 addresses (e.g. 64 for /64).
   * @defaultValue 64
   */
  ipv6SubnetMask?: number

  /**
   * Paths to bypass rate limits.
   */
  ignorePaths?: string[]

  /**
   * Ignore list configuration.
   */
  ignore?: RateLimitIgnore

  /**
   * Whether to trust proxy headers for IP resolution.
   */
  trustProxy?: boolean

  /**
   * List of trusted proxy IPs or CIDR blocks when trustProxy is enabled.
   */
  trustedProxies?: string[]

  /**
   * Maximum number of tracked keys before LRU eviction.
   */
  maxEntries?: number
}

/**
 * Runtime tracking data for a rate limit key (Token Bucket).
 * @public
 */
export interface RateLimitEntry {
  /**
   * Current number of available tokens in bucket.
   */
  tokens: number

  /**
   * Timestamp of the last token refill.
   */
  lastRefill: number

  /**
   * Last time the key was seen.
   */
  lastSeen: number

  /**
   * Optional legacy requests list for backwards compatibility.
   */
  requests?: number[]

  /**
   * Optional legacy head index for backwards compatibility.
   */
  head?: number
}
