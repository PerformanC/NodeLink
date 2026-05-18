import { logger } from "../utils.js";
const DEFAULT_PER_USER = {
    maxRequests: 50,
    timeWindowMs: 5000
};
const DEFAULT_PER_GUILD = {
    maxRequests: 20,
    timeWindowMs: 5000
};
const DEFAULT_CONFIG = {
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
    ignorePaths: [],
    ignore: {
        userIds: [],
        guildIds: [],
        ips: [],
        paths: []
    },
    trustProxy: false,
    maxEntries: 10000
};
const MIN_WINDOW_MS = 1000;
const MIN_CLEANUP_INTERVAL_MS = 1000;
const MAX_CLEANUP_INTERVAL_MS = 60000;
/**
 * Enforces per-scope rate limits (global, IP, user, guild).
 * @remarks Uses a rolling window with cleanup and bounded storage.
 * @public
 */
export default class RateLimitManager {
    nodelink;
    config;
    store;
    cleanupInterval;
    /**
     * Creates a new rate limit manager instance.
     * @param nodelink - NodeLink runtime context.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.config = this._resolveConfig(nodelink.options?.api?.rateLimit ??
            nodelink.options?.security?.rateLimit ??
            nodelink.options?.rateLimit);
        this.store = new Map();
        this.cleanupInterval = setInterval(() => this._cleanup(), this._resolveCleanupInterval());
        this.cleanupInterval.unref?.();
    }
    /**
     * Checks the incoming request against configured rate limits.
     * @param req - Incoming API request.
     * @param parsedUrl - Parsed request URL.
     */
    check(req, parsedUrl) {
        if (!this.config.enabled) {
            return { allowed: true };
        }
        const pathname = parsedUrl.pathname || '';
        if (this._isIgnoredPath(pathname)) {
            return { allowed: true };
        }
        const now = Date.now();
        const remoteAddress = this._resolveRemoteAddress(req);
        const userId = this._getHeaderValue(req.headers, 'user-id');
        const guildId = this._extractGuildId(pathname);
        if (this._shouldIgnore(pathname, remoteAddress, userId, guildId)) {
            return { allowed: true };
        }
        let bestResult = null;
        const globalResult = this._checkAndIncrement('global', 'all', this.config.global, now);
        if (!globalResult.allowed) {
            logger('warn', 'RateLimit', `Global rate limit exceeded for ${remoteAddress}`);
            return globalResult;
        }
        bestResult = this._pickBestResult(bestResult, globalResult);
        if (remoteAddress) {
            const ipResult = this._checkAndIncrement('ip', remoteAddress, this.config.perIp, now);
            if (!ipResult.allowed) {
                logger('warn', 'RateLimit', `IP rate limit exceeded for ${remoteAddress}`);
                return ipResult;
            }
            bestResult = this._pickBestResult(bestResult, ipResult);
        }
        if (userId && this.config.perUserId) {
            const userResult = this._checkAndIncrement('userId', userId, this.config.perUserId, now);
            if (!userResult.allowed) {
                logger('warn', 'RateLimit', `User-Id rate limit exceeded for ${userId} (IP: ${remoteAddress || 'unknown'})`);
                return userResult;
            }
            bestResult = this._pickBestResult(bestResult, userResult);
        }
        if (guildId && this.config.perGuildId) {
            const guildResult = this._checkAndIncrement('guildId', guildId, this.config.perGuildId, now);
            if (!guildResult.allowed) {
                logger('warn', 'RateLimit', `Guild-Id rate limit exceeded for ${guildId} (IP: ${remoteAddress || 'unknown'}, User: ${userId || 'unknown'})`);
                return guildResult;
            }
            bestResult = this._pickBestResult(bestResult, guildResult);
        }
        return bestResult ?? { allowed: true };
    }
    /**
     * Clears all tracked rate limit entries.
     */
    clear() {
        this.store.clear();
    }
    /**
     * Stops cleanup timers and clears state.
     */
    destroy() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        this.store.clear();
    }
    /**
     * Builds a rate limit key for storage.
     * @param type - Bucket type.
     * @param id - Identifier value.
     * @internal
     */
    _getKey(type, id) {
        return `${type}:${id}`;
    }
    /**
     * Applies a single rate limit rule and updates tracking counters.
     * @param type - Bucket type.
     * @param id - Bucket identifier.
     * @param rule - Rate limit rule.
     * @param now - Current timestamp.
     * @internal
     */
    _checkAndIncrement(type, id, rule, now) {
        const maxRequests = Math.max(1, rule.maxRequests);
        const timeWindowMs = Math.max(MIN_WINDOW_MS, rule.timeWindowMs);
        const key = this._getKey(type, id);
        const entry = this._getOrCreateEntry(key, now);
        const activeCount = this._pruneEntry(entry, timeWindowMs, now);
        const remainingBefore = Math.max(0, maxRequests - activeCount);
        const firstRequest = entry.requests[entry.head];
        const reset = typeof firstRequest === 'number'
            ? firstRequest + timeWindowMs
            : now + timeWindowMs;
        if (activeCount >= maxRequests) {
            return { allowed: false, limit: maxRequests, remaining: 0, reset };
        }
        entry.requests.push(now);
        entry.lastSeen = now;
        return {
            allowed: true,
            limit: maxRequests,
            remaining: Math.max(0, remainingBefore - 1),
            reset
        };
    }
    /**
     * Chooses the strictest rate limit result for header reporting.
     * @param current - Current best result.
     * @param candidate - Candidate result.
     * @internal
     */
    _pickBestResult(current, candidate) {
        if (candidate.limit === undefined ||
            candidate.remaining === undefined ||
            candidate.reset === undefined) {
            return current ?? candidate;
        }
        if (!current || current.remaining === undefined) {
            return candidate;
        }
        if (candidate.remaining < current.remaining) {
            return candidate;
        }
        if (candidate.remaining === current.remaining &&
            candidate.reset !== undefined &&
            current.reset !== undefined &&
            candidate.reset < current.reset) {
            return candidate;
        }
        return current;
    }
    /**
     * Resolves and normalizes config values with defaults.
     * @param config - Partial config overrides.
     * @internal
     */
    _resolveConfig(config) {
        const globalRule = config?.global ?? DEFAULT_CONFIG.global;
        const perIpRule = config?.perIp ?? DEFAULT_CONFIG.perIp;
        const perUserId = config?.perUserId ?? DEFAULT_CONFIG.perUserId;
        const perGuildId = config?.perGuildId ?? DEFAULT_CONFIG.perGuildId;
        const perUserFallback = DEFAULT_CONFIG.perUserId ?? DEFAULT_PER_USER;
        const perGuildFallback = DEFAULT_CONFIG.perGuildId ?? DEFAULT_PER_GUILD;
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
            ignorePaths: config?.ignorePaths ?? DEFAULT_CONFIG.ignorePaths,
            ignore: {
                userIds: config?.ignore?.userIds ?? DEFAULT_CONFIG.ignore?.userIds ?? [],
                guildIds: config?.ignore?.guildIds ?? DEFAULT_CONFIG.ignore?.guildIds ?? [],
                ips: config?.ignore?.ips ?? DEFAULT_CONFIG.ignore?.ips ?? [],
                paths: config?.ignore?.paths ?? DEFAULT_CONFIG.ignore?.paths ?? []
            },
            trustProxy: config?.trustProxy ?? DEFAULT_CONFIG.trustProxy,
            maxEntries: Math.max(100, Number(config?.maxEntries ?? DEFAULT_CONFIG.maxEntries))
        };
    }
    /**
     * Normalizes rate limit rules and enforces minimums.
     * @param rule - Raw rule.
     * @param fallback - Fallback rule.
     * @internal
     */
    _normalizeRule(rule, fallback) {
        return {
            maxRequests: Math.max(1, Number(rule?.maxRequests ?? fallback.maxRequests)),
            timeWindowMs: Math.max(MIN_WINDOW_MS, Number(rule?.timeWindowMs ?? fallback.timeWindowMs))
        };
    }
    /**
     * Checks whether a pathname should bypass limits.
     * @param pathname - Request pathname.
     * @internal
     */
    _isIgnoredPath(pathname) {
        if (!pathname)
            return false;
        const ignorePaths = this.config.ignorePaths ?? [];
        if (ignorePaths.some((path) => pathname.startsWith(path))) {
            return true;
        }
        const ignoreList = this.config.ignore?.paths ?? [];
        if (ignoreList.some((path) => pathname.startsWith(path))) {
            return true;
        }
        return false;
    }
    /**
     * Checks whether identifiers match ignore lists.
     * @param pathname - Request pathname.
     * @param ip - Normalized IP address.
     * @param userId - User ID header.
     * @param guildId - Guild identifier.
     * @internal
     */
    _shouldIgnore(pathname, ip, userId, guildId) {
        const ignore = this.config.ignore;
        if (!ignore)
            return false;
        if (ip && ignore.ips?.includes(ip))
            return true;
        if (userId && ignore.userIds?.includes(userId))
            return true;
        if (guildId && ignore.guildIds?.includes(guildId))
            return true;
        if (pathname && ignore.paths?.length) {
            return ignore.paths.some((path) => pathname.startsWith(path));
        }
        return false;
    }
    /**
     * Resolves the remote address from the request.
     * @param req - Incoming API request.
     * @internal
     */
    _resolveRemoteAddress(req) {
        const socketAddress = req.socket?.remoteAddress;
        const forwardedFor = this._getHeaderValue(req.headers, 'x-forwarded-for');
        const candidate = this.config.trustProxy && forwardedFor
            ? forwardedFor.split(',')[0]?.trim()
            : socketAddress || forwardedFor;
        return this._normalizeIp(candidate);
    }
    /**
     * Normalizes IP addresses for consistent keys.
     * @param ip - Raw IP string.
     * @internal
     */
    _normalizeIp(ip) {
        if (!ip)
            return null;
        let normalized = ip.trim();
        if (!normalized)
            return null;
        if (normalized.startsWith('::ffff:')) {
            normalized = normalized.slice(7);
        }
        if (normalized.startsWith('[') && normalized.endsWith(']')) {
            normalized = normalized.slice(1, -1);
        }
        const colonCount = normalized.split(':').length - 1;
        if (colonCount === 1 && normalized.includes('.')) {
            const [ipv4] = normalized.split(':');
            if (ipv4) {
                normalized = ipv4;
            }
        }
        return normalized || null;
    }
    /**
     * Extracts a header value as a string.
     * @param headers - Request headers.
     * @param name - Header name.
     * @internal
     */
    _getHeaderValue(headers, name) {
        const raw = headers[name] ?? headers[name.toLowerCase()];
        if (Array.isArray(raw))
            return raw[0];
        return raw;
    }
    /**
     * Extracts a guild ID from the request path.
     * @param pathname - Request pathname.
     * @internal
     */
    _extractGuildId(pathname) {
        if (!pathname)
            return null;
        const match = pathname.match(/\/players\/(\d+)/);
        return match?.[1] ?? null;
    }
    /**
     * Retrieves an existing entry or creates a new one.
     * @param key - Storage key.
     * @param now - Current timestamp.
     * @internal
     */
    _getOrCreateEntry(key, now) {
        const existing = this.store.get(key);
        if (existing)
            return existing;
        const entry = { requests: [], head: 0, lastSeen: now };
        this.store.set(key, entry);
        return entry;
    }
    /**
     * Cleans up stale keys and enforces storage limits.
     * @internal
     */
    _cleanup() {
        const now = Date.now();
        const windowMs = this._resolveShortestWindow();
        const pruneAfterMs = windowMs * 3;
        for (const [key, entry] of this.store.entries()) {
            const activeCount = this._pruneEntry(entry, windowMs, now);
            if (activeCount === 0 && now - entry.lastSeen > pruneAfterMs) {
                this.store.delete(key);
            }
        }
        this._enforceMaxEntries();
    }
    /**
     * Enforces the maximum entry count by evicting oldest entries.
     * @internal
     */
    _enforceMaxEntries() {
        const maxEntries = this.config.maxEntries ?? DEFAULT_CONFIG.maxEntries;
        if (!maxEntries || this.store.size <= maxEntries)
            return;
        const entries = Array.from(this.store.entries()).sort((a, b) => a[1].lastSeen - b[1].lastSeen);
        const overflow = this.store.size - maxEntries;
        for (let i = 0; i < overflow && i < entries.length; i++) {
            const entry = entries[i];
            if (entry) {
                this.store.delete(entry[0]);
            }
        }
    }
    /**
     * Resolves the cleanup interval based on the shortest rule window.
     * @internal
     */
    _resolveCleanupInterval() {
        const interval = this._resolveShortestWindow();
        const clamped = Math.min(interval, MAX_CLEANUP_INTERVAL_MS);
        return Math.max(clamped, MIN_CLEANUP_INTERVAL_MS);
    }
    /**
     * Finds the shortest configured rate limit window.
     * @internal
     */
    _resolveShortestWindow() {
        const windows = [
            this.config.global.timeWindowMs,
            this.config.perIp.timeWindowMs,
            this.config.perUserId?.timeWindowMs,
            this.config.perGuildId?.timeWindowMs
        ].filter((value) => typeof value === 'number');
        return windows.length > 0 ? Math.min(...windows) : MIN_WINDOW_MS;
    }
    /**
     * Prunes expired timestamps from an entry using a sliding window.
     * @param entry - Rate limit entry to prune.
     * @param windowMs - Rolling time window in milliseconds.
     * @param now - Current timestamp.
     * @returns Number of active timestamps after pruning.
     * @internal
     */
    _pruneEntry(entry, windowMs, now) {
        const cutoff = now - windowMs;
        let head = entry.head;
        const requests = entry.requests;
        while (head < requests.length) {
            const current = requests[head];
            if (typeof current === 'number' && current <= cutoff) {
                head += 1;
                continue;
            }
            break;
        }
        if (head !== entry.head) {
            entry.head = head;
        }
        if (entry.head > 0 &&
            (entry.head > 1000 || entry.head > requests.length / 2)) {
            entry.requests = requests.slice(entry.head);
            entry.head = 0;
        }
        return entry.requests.length - entry.head;
    }
}
