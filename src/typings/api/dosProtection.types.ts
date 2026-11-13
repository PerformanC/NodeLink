/**
 * DoS protection threshold configuration.
 * @public
 */
export interface DosProtectionThresholds {
  /**
   * Maximum burst requests allowed within the time window.
   */
  burstRequests: number

  /**
   * Rolling time window in milliseconds.
   */
  timeWindowMs: number

  /**
   * Ratio of the burst limit that should trigger mitigation.
   * @defaultValue 0.5
   */
  warnRatio?: number

  /**
   * Maximum number of tracked IP entries before LRU eviction.
   * @defaultValue 10000
   */
  maxEntries?: number
}

/**
 * DoS protection mitigation settings.
 * @public
 */
export interface DosProtectionMitigation {
  /**
   * Action taken when an abusive IP exceeds burst limit:
   * - 'reject': immediate 429 / 403 error response.
   * - 'destroy': immediately abort/destroy the underlying TCP socket.
   * @defaultValue 'reject'
   */
  action?: 'reject' | 'destroy'

  /**
   * Base block duration in milliseconds.
   */
  blockDurationMs: number

  /**
   * Exponential backoff multiplier applied on repeated offenses.
   * @defaultValue 2
   */
  backoffMultiplier?: number

  /**
   * Maximum block duration in milliseconds.
   * @defaultValue blockDurationMs * 8
   */
  maxBlockDurationMs?: number

  /**
   * Legacy delay duration (deprecated in favor of early reject/destroy).
   */
  delayMs?: number
}

/**
 * Brute-force protection for invalid password / unauthorized attempts.
 * @public
 */
export interface DosProtectionAuth {
  /**
   * Whether brute-force auth protection is enabled.
   */
  enabled?: boolean

  /**
   * Maximum failed authentication attempts allowed within window.
   * @defaultValue 5
   */
  maxFailures?: number

  /**
   * Time window in milliseconds for tracking failures.
   * @defaultValue 60000
   */
  timeWindowMs?: number

  /**
   * Ban duration in milliseconds when threshold is breached.
   * @defaultValue 900000 (15 minutes)
   */
  banDurationMs?: number
}

/**
 * Ignore list configuration for DoS protection.
 * @public
 */
export interface DosProtectionIgnore {
  /**
   * User IDs to bypass DoS checks.
   */
  userIds?: string[]

  /**
   * Guild IDs to bypass DoS checks.
   */
  guildIds?: string[]

  /**
   * IP addresses to bypass DoS checks.
   */
  ips?: string[]

  /**
   * Paths to bypass DoS checks.
   */
  paths?: string[]
}

/**
 * DoS protection configuration object.
 * @public
 */
export interface DosProtectionConfig {
  /**
   * Whether DoS protection is enabled.
   */
  enabled: boolean

  /**
   * Threshold configuration.
   */
  thresholds: DosProtectionThresholds

  /**
   * Mitigation settings.
   */
  mitigation: DosProtectionMitigation

  /**
   * Maximum concurrent TCP socket connections allowed from a single IP.
   * @defaultValue 25
   */
  maxConcurrentConnectionsPerIp?: number

  /**
   * Protection against password brute-forcing.
   */
  authProtection?: DosProtectionAuth

  /**
   * Whether to synchronize blocked IPs across cluster workers via IPC.
   * @defaultValue true
   */
  syncCluster?: boolean

  /**
   * Subnet mask size for grouping IPv6 addresses (e.g. 64 for /64).
   * @defaultValue 64
   */
  ipv6SubnetMask?: number

  /**
   * List of trusted proxy IPs or CIDR blocks when trustProxy is enabled.
   */
  trustedProxies?: string[]

  /**
   * Ignore list configuration.
   */
  ignore?: DosProtectionIgnore

  /**
   * Whether to trust proxy headers (x-forwarded-for, cf-connecting-ip, etc).
   */
  trustProxy?: boolean
}

/**
 * Runtime tracking data for a single IP address (Token Bucket Burst).
 * @public
 */
export interface DosProtectionEntry {
  /**
   * Current burst tokens remaining in bucket.
   */
  tokens: number

  /**
   * Timestamp of the last token refill.
   */
  lastRefill: number

  /**
   * Timestamp for the last request.
   */
  lastSeen: number

  /**
   * Timestamp until which the IP remains blocked.
   */
  blockedUntil: number

  /**
   * Number of block strikes recorded.
   */
  strikes: number

  /**
   * Legacy count field for backwards compatibility.
   */
  count?: number

  /**
   * Legacy lastReset field for backwards compatibility.
   */
  lastReset?: number
}
