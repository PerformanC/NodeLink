import type {
  ApiDosProtectionResult,
  ApiRequest
} from '../typings/api/api.types.ts'
import type {
  DosProtectionConfig,
  DosProtectionEntry
} from '../typings/api/dosProtection.types.ts'
import { logger } from '../utils.ts'

type DosProtectionContext = {
  options?: {
    dosProtection?: Partial<DosProtectionConfig>
    api?: {
      dosProtection?: Partial<DosProtectionConfig>
      [key: string]: unknown
    }
    security?: {
      dosProtection?: Partial<DosProtectionConfig>
      [key: string]: unknown
    }
  }
}

const DEFAULT_CONFIG: DosProtectionConfig = {
  enabled: true,
  thresholds: {
    burstRequests: 50,
    timeWindowMs: 10000,
    warnRatio: 0.5,
    maxEntries: 10000
  },
  mitigation: {
    delayMs: 500,
    blockDurationMs: 300000,
    backoffMultiplier: 2,
    maxBlockDurationMs: 300000 * 8
  },
  ignore: {
    userIds: [],
    guildIds: [],
    ips: [],
    paths: []
  },
  trustProxy: false
}

const MIN_CLEANUP_INTERVAL_MS = 1000
const MAX_CLEANUP_INTERVAL_MS = 60000
const DEFAULT_BLOCK_MESSAGE = 'Forbidden'

/**
 * Protects the API from bursts of abusive traffic.
 * @remarks Uses a rolling window with optional delay and block mitigation.
 * @public
 */
export default class DosProtectionManager {
  private readonly nodelink: DosProtectionContext
  private config: DosProtectionConfig
  private ipRequestCounts: Map<string, DosProtectionEntry>
  private cleanupInterval: NodeJS.Timeout | null

  /**
   * Creates a new DoS protection manager.
   * @param nodelink - NodeLink runtime context.
   */
  constructor(nodelink: DosProtectionContext) {
    this.nodelink = nodelink
    this.config = this._resolveConfig(
      nodelink.options?.api?.dosProtection ??
        nodelink.options?.security?.dosProtection ??
        nodelink.options?.dosProtection
    )
    this.ipRequestCounts = new Map()
    this.cleanupInterval = setInterval(
      () => this._cleanup(),
      this._resolveCleanupInterval()
    )
    this.cleanupInterval.unref?.()
  }

  /**
   * Checks the incoming request against DoS protection rules.
   * @param req - Incoming API request.
   */
  check(req: ApiRequest): ApiDosProtectionResult {
    if (!this.config.enabled) {
      return { allowed: true }
    }

    const now = Date.now()
    const remoteAddress = this._resolveRemoteAddress(req)
    if (!remoteAddress) {
      return { allowed: true }
    }

    if (this._shouldIgnore(req, remoteAddress)) {
      return { allowed: true }
    }

    const entry = this._getOrCreateEntry(remoteAddress, now)

    if (now < entry.blockedUntil) {
      logger(
        'warn',
        'DosProtection',
        `IP ${remoteAddress} is temporarily blocked.`
      )
      return {
        allowed: false,
        status: 403,
        message: DEFAULT_BLOCK_MESSAGE
      }
    }

    const timeWindowMs = this.config.thresholds.timeWindowMs
    if (now - entry.lastReset > timeWindowMs) {
      entry.count = 0
      entry.lastReset = now
      if (entry.strikes > 0 && now - entry.lastSeen > timeWindowMs * 2) {
        entry.strikes -= 1
      }
    }

    entry.count += 1
    entry.lastSeen = now

    const burstLimit = this.config.thresholds.burstRequests
    const warnRatio = this.config.thresholds.warnRatio ?? 0.5
    const warnThreshold = Math.max(1, Math.floor(burstLimit * warnRatio))

    if (entry.count > burstLimit) {
      entry.strikes += 1
      const blockDuration = this._calculateBlockDuration(entry.strikes)
      entry.blockedUntil = now + blockDuration
      logger(
        'warn',
        'DosProtection',
        `IP ${remoteAddress} exceeded burst limit. Blocking for ${blockDuration}ms.`
      )
      return {
        allowed: false,
        status: 403,
        message: DEFAULT_BLOCK_MESSAGE
      }
    }

    if (entry.count >= warnThreshold && this.config.mitigation.delayMs > 0) {
      logger(
        'debug',
        'DosProtection',
        `IP ${remoteAddress} is nearing burst limit. Introducing delay.`
      )
      return { allowed: true, delay: this.config.mitigation.delayMs }
    }

    return { allowed: true }
  }

  /**
   * Stops the cleanup interval and clears tracking data.
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    this.ipRequestCounts.clear()
  }

  /**
   * Normalizes the provided configuration with safe defaults.
   * @param config - Raw configuration overrides.
   * @internal
   */
  private _resolveConfig(
    config?: Partial<DosProtectionConfig>
  ): DosProtectionConfig {
    const thresholds =
      config?.thresholds ?? ({} as Partial<DosProtectionConfig['thresholds']>)
    const mitigation =
      config?.mitigation ?? ({} as Partial<DosProtectionConfig['mitigation']>)

    return {
      enabled: config?.enabled ?? DEFAULT_CONFIG.enabled,
      thresholds: {
        burstRequests: Math.max(
          1,
          Number(
            thresholds.burstRequests ?? DEFAULT_CONFIG.thresholds.burstRequests
          )
        ),
        timeWindowMs: Math.max(
          1000,
          Number(
            thresholds.timeWindowMs ?? DEFAULT_CONFIG.thresholds.timeWindowMs
          )
        ),
        warnRatio:
          typeof thresholds.warnRatio === 'number'
            ? Math.min(Math.max(thresholds.warnRatio, 0.1), 1)
            : DEFAULT_CONFIG.thresholds.warnRatio,
        maxEntries: Math.max(
          100,
          Number(thresholds.maxEntries ?? DEFAULT_CONFIG.thresholds.maxEntries)
        )
      },
      mitigation: {
        delayMs: Math.max(
          0,
          Number(mitigation.delayMs ?? DEFAULT_CONFIG.mitigation.delayMs)
        ),
        blockDurationMs: Math.max(
          1000,
          Number(
            mitigation.blockDurationMs ??
              DEFAULT_CONFIG.mitigation.blockDurationMs
          )
        ),
        backoffMultiplier:
          typeof mitigation.backoffMultiplier === 'number' &&
          mitigation.backoffMultiplier > 0
            ? mitigation.backoffMultiplier
            : DEFAULT_CONFIG.mitigation.backoffMultiplier,
        maxBlockDurationMs:
          typeof mitigation.maxBlockDurationMs === 'number' &&
          mitigation.maxBlockDurationMs > 0
            ? mitigation.maxBlockDurationMs
            : DEFAULT_CONFIG.mitigation.maxBlockDurationMs
      },
      ignore: {
        userIds:
          config?.ignore?.userIds ?? DEFAULT_CONFIG.ignore?.userIds ?? [],
        guildIds:
          config?.ignore?.guildIds ?? DEFAULT_CONFIG.ignore?.guildIds ?? [],
        ips: config?.ignore?.ips ?? DEFAULT_CONFIG.ignore?.ips ?? [],
        paths: config?.ignore?.paths ?? DEFAULT_CONFIG.ignore?.paths ?? []
      },
      trustProxy: config?.trustProxy ?? DEFAULT_CONFIG.trustProxy
    }
  }

  /**
   * Resolves the cleanup interval duration based on configuration.
   * @internal
   */
  private _resolveCleanupInterval(): number {
    const interval = this.config.thresholds.timeWindowMs
    const clamped = Math.min(interval, MAX_CLEANUP_INTERVAL_MS)
    return Math.max(clamped, MIN_CLEANUP_INTERVAL_MS)
  }

  /**
   * Determines whether a request should bypass DoS protection.
   * @param req - Incoming API request.
   * @param remoteAddress - Normalized remote address.
   * @internal
   */
  private _shouldIgnore(req: ApiRequest, remoteAddress: string): boolean {
    const ignore = this.config.ignore
    if (!ignore) return false

    if (ignore.ips?.includes(remoteAddress)) return true

    const userId = this._getHeaderValue(req.headers, 'user-id')
    if (userId && ignore.userIds?.includes(userId)) return true

    const guildId = this._extractGuildId(req.url)
    if (guildId && ignore.guildIds?.includes(guildId)) return true

    if (req.url && ignore.paths?.length) {
      if (ignore.paths.some((path) => req.url?.startsWith(path))) {
        return true
      }
    }

    return false
  }

  /**
   * Extracts a normalized IP address from the request.
   * @param req - Incoming API request.
   * @internal
   */
  private _resolveRemoteAddress(req: ApiRequest): string | null {
    const socketAddress = req.socket?.remoteAddress
    const forwardedFor = this._getHeaderValue(req.headers, 'x-forwarded-for')
    const candidate =
      this.config.trustProxy && forwardedFor
        ? forwardedFor.split(',')[0]?.trim()
        : socketAddress || forwardedFor
    return this._normalizeIp(candidate)
  }

  /**
   * Normalizes IP address formats for consistent tracking.
   * @param ip - Raw IP string.
   * @internal
   */
  private _normalizeIp(ip: string | undefined | null): string | null {
    if (!ip) return null
    let normalized = ip.trim()
    if (!normalized) return null

    if (normalized.startsWith('::ffff:')) {
      normalized = normalized.slice(7)
    }

    if (normalized.startsWith('[') && normalized.endsWith(']')) {
      normalized = normalized.slice(1, -1)
    }

    const colonCount = normalized.split(':').length - 1
    if (colonCount === 1 && normalized.includes('.')) {
      const [ipv4] = normalized.split(':')
      if (ipv4) {
        normalized = ipv4
      }
    }

    return normalized || null
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
    if (Array.isArray(raw)) return raw[0]
    return raw
  }

  /**
   * Extracts a guild ID from the request URL.
   * @param url - Request URL.
   * @internal
   */
  private _extractGuildId(url?: string): string | null {
    if (!url) return null
    const match = url.match(/\/players\/(\d+)/)
    return match?.[1] ?? null
  }

  /**
   * Retrieves or creates an IP entry for tracking.
   * @param ip - Normalized IP address.
   * @param now - Current timestamp.
   * @internal
   */
  private _getOrCreateEntry(ip: string, now: number): DosProtectionEntry {
    const existing = this.ipRequestCounts.get(ip)
    if (existing) return existing

    const entry = {
      count: 0,
      lastReset: now,
      lastSeen: now,
      blockedUntil: 0,
      strikes: 0
    }
    this.ipRequestCounts.set(ip, entry)
    return entry
  }

  /**
   * Calculates the next block duration with exponential backoff.
   * @param strikes - Number of strikes recorded.
   * @internal
   */
  private _calculateBlockDuration(strikes: number): number {
    const base = this.config.mitigation.blockDurationMs
    const multiplier = this.config.mitigation.backoffMultiplier ?? 2
    const max = this.config.mitigation.maxBlockDurationMs ?? base * 8
    const duration = base * multiplier ** Math.max(0, strikes - 1)
    return Math.min(duration, max)
  }

  /**
   * Cleans up idle or expired IP entries.
   * @internal
   */
  private _cleanup(): void {
    const now = Date.now()
    const timeWindowMs = this.config.thresholds.timeWindowMs
    const pruneAfterMs = timeWindowMs * 3

    for (const [ip, data] of this.ipRequestCounts.entries()) {
      if (now > data.blockedUntil && now - data.lastSeen > pruneAfterMs) {
        this.ipRequestCounts.delete(ip)
        continue
      }

      if (now - data.lastReset > timeWindowMs) {
        data.count = 0
        data.lastReset = now
      }
    }

    const maxEntries = this.config.thresholds.maxEntries ?? 10000
    if (this.ipRequestCounts.size <= maxEntries) return

    const entries = Array.from(this.ipRequestCounts.entries()).sort(
      (a, b) => a[1].lastSeen - b[1].lastSeen
    )
    const overflow = this.ipRequestCounts.size - maxEntries
    for (let i = 0; i < overflow && i < entries.length; i++) {
      const entry = entries[i]
      if (entry) {
        this.ipRequestCounts.delete(entry[0])
      }
    }
  }
}
