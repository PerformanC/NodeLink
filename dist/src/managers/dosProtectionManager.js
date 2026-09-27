import process from 'node:process';
import { logger } from '../utils.js';
const DEFAULT_CONFIG = {
    enabled: true,
    thresholds: {
        burstRequests: 50,
        timeWindowMs: 10000,
        warnRatio: 0.5,
        maxEntries: 10000
    },
    mitigation: {
        action: 'reject',
        blockDurationMs: 300000,
        backoffMultiplier: 2,
        maxBlockDurationMs: 2400000
    },
    maxConcurrentConnectionsPerIp: 25,
    authProtection: {
        enabled: true,
        maxFailures: 5,
        timeWindowMs: 60000,
        banDurationMs: 900000
    },
    syncCluster: true,
    ipv6SubnetMask: 64,
    ignore: {
        userIds: [],
        guildIds: [],
        ips: [],
        paths: []
    },
    trustProxy: false,
    trustedProxies: []
};
const MIN_CLEANUP_INTERVAL_MS = 1000;
const MAX_CLEANUP_INTERVAL_MS = 60000;
const DEFAULT_BLOCK_MESSAGE = 'Forbidden';
/**
 * Protects the server against burst floods, DoS, brute-force auth, and socket exhaustion.
 * @remarks Uses Token Bucket burst tracking, O(1) LRU eviction, and IPv6 subnet grouping.
 * @public
 */
export default class DosProtectionManager {
    nodelink;
    config;
    ipRequestCounts;
    activeSockets;
    authFailures;
    cleanupInterval;
    /**
     * Creates a new DoS protection manager.
     * @param nodelink - NodeLink runtime context.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.config = this._resolveConfig(nodelink.options?.api?.dosProtection ??
            nodelink.options?.security?.dosProtection ??
            nodelink.options?.dosProtection);
        this.ipRequestCounts = new Map();
        this.activeSockets = new Map();
        this.authFailures = new Map();
        this.cleanupInterval = setInterval(() => this._cleanup(), this._resolveCleanupInterval());
        this.cleanupInterval?.unref?.();
    }
    /**
     * Checks incoming request against DoS burst limits and active IP blocks.
     * @param req - Incoming API request.
     */
    check(req) {
        const isEnabled = this.config.enabled;
        if (!isEnabled) {
            return { allowed: true };
        }
        const remoteAddress = this._resolveRemoteAddress(req);
        if (!remoteAddress) {
            return { allowed: true };
        }
        const shouldBypass = this._shouldIgnore(req, remoteAddress);
        if (shouldBypass) {
            return { allowed: true };
        }
        const now = Date.now();
        const entry = this._getOrCreateEntry(remoteAddress, now);
        const isCurrentlyBlocked = now < entry.blockedUntil;
        if (isCurrentlyBlocked) {
            logger('warn', 'DosProtection', `Blocked IP ${remoteAddress} rejected.`);
            return this._buildBlockedResult(req);
        }
        // Check if banned by auth brute-force protection
        const authEntry = this.authFailures.get(remoteAddress);
        const isAuthBanned = Boolean(authEntry && now < authEntry.blockedUntil);
        if (isAuthBanned) {
            logger('warn', 'DosProtection', `Auth-jailed IP ${remoteAddress} rejected.`);
            return this._buildBlockedResult(req);
        }
        // Token Bucket burst check
        const burstCapacity = this.config.thresholds.burstRequests;
        const timeWindowMs = this.config.thresholds.timeWindowMs;
        const elapsed = Math.max(0, now - entry.lastRefill);
        const refillRate = burstCapacity / timeWindowMs;
        const replenishedTokens = Math.min(burstCapacity, entry.tokens + elapsed * refillRate);
        entry.tokens = replenishedTokens;
        entry.lastRefill = now;
        entry.lastSeen = now;
        // Re-insert into Map to maintain true O(1) LRU order
        this.ipRequestCounts.delete(remoteAddress);
        this.ipRequestCounts.set(remoteAddress, entry);
        const hasAvailableTokens = entry.tokens >= 1;
        if (!hasAvailableTokens) {
            entry.strikes += 1;
            const blockDuration = this._calculateBlockDuration(entry.strikes);
            entry.blockedUntil = now + blockDuration;
            logger('warn', 'DosProtection', `IP ${remoteAddress} exceeded burst limit (${burstCapacity} reqs/${timeWindowMs}ms). Blocking for ${blockDuration}ms.`);
            this._broadcastClusterBlock(remoteAddress, blockDuration);
            return this._buildBlockedResult(req);
        }
        entry.tokens -= 1;
        return { allowed: true };
    }
    /**
     * Records a failed password attempt and applies ban if threshold is exceeded.
     * @param rawAddress - IP address that failed authentication.
     */
    recordAuthFailure(rawAddress) {
        const isAuthProtectionEnabled = this.config.authProtection?.enabled === true;
        if (!isAuthProtectionEnabled) {
            return false;
        }
        const remoteAddress = this._normalizeIp(rawAddress);
        if (!remoteAddress) {
            return false;
        }
        const now = Date.now();
        const maxFailures = this.config.authProtection?.maxFailures ?? 5;
        const windowMs = this.config.authProtection?.timeWindowMs ?? 60000;
        const banDurationMs = this.config.authProtection?.banDurationMs ?? 900000;
        let authEntry = this.authFailures.get(remoteAddress);
        if (!authEntry) {
            authEntry = { count: 0, lastReset: now, blockedUntil: 0 };
            this.authFailures.set(remoteAddress, authEntry);
        }
        const isWindowExpired = now - authEntry.lastReset > windowMs;
        if (isWindowExpired) {
            authEntry.count = 0;
            authEntry.lastReset = now;
        }
        authEntry.count += 1;
        const isThresholdBreached = authEntry.count >= maxFailures;
        if (isThresholdBreached) {
            authEntry.blockedUntil = now + banDurationMs;
            logger('warn', 'DosProtection', `IP ${remoteAddress} exceeded auth failure limit (${authEntry.count}/${maxFailures}). Jailing for ${banDurationMs}ms.`);
            this.blockIp(remoteAddress, banDurationMs, true);
            return true;
        }
        return false;
    }
    /**
     * Tracks an open TCP socket for an IP. Returns false if connection limit exceeded.
     * @param rawAddress - Client remote IP address.
     */
    incrementActiveSockets(rawAddress) {
        const remoteAddress = this._normalizeIp(rawAddress);
        if (!remoteAddress) {
            return true;
        }
        const maxSockets = this.config.maxConcurrentConnectionsPerIp ?? 25;
        const currentCount = this.activeSockets.get(remoteAddress) ?? 0;
        const isLimitExceeded = currentCount >= maxSockets;
        if (isLimitExceeded) {
            logger('warn', 'DosProtection', `IP ${remoteAddress} exceeded max concurrent sockets (${currentCount}/${maxSockets}). Dropping connection.`);
            return false;
        }
        this.activeSockets.set(remoteAddress, currentCount + 1);
        return true;
    }
    /**
     * Decrements active TCP socket count when a connection closes.
     * @param rawAddress - Client remote IP address.
     */
    decrementActiveSockets(rawAddress) {
        const remoteAddress = this._normalizeIp(rawAddress);
        if (!remoteAddress) {
            return;
        }
        const currentCount = this.activeSockets.get(remoteAddress) ?? 0;
        const nextCount = Math.max(0, currentCount - 1);
        const hasNoSocketsLeft = nextCount === 0;
        if (hasNoSocketsLeft) {
            this.activeSockets.delete(remoteAddress);
            return;
        }
        this.activeSockets.set(remoteAddress, nextCount);
    }
    /**
     * Checks whether an IP address is currently blocked.
     * @param rawAddress - Remote IP address.
     */
    isIpBlocked(rawAddress) {
        const remoteAddress = this._normalizeIp(rawAddress);
        if (!remoteAddress) {
            return false;
        }
        const now = Date.now();
        const entry = this.ipRequestCounts.get(remoteAddress);
        const isEntryBlocked = Boolean(entry && now < entry.blockedUntil);
        if (isEntryBlocked) {
            return true;
        }
        const authEntry = this.authFailures.get(remoteAddress);
        const isAuthBlocked = Boolean(authEntry && now < authEntry.blockedUntil);
        return isAuthBlocked;
    }
    /**
     * Programmatically blocks an IP address for a specified duration.
     * @param rawAddress - IP address to block.
     * @param durationMs - Duration in milliseconds.
     * @param broadcast - Whether to sync across cluster workers.
     */
    blockIp(rawAddress, durationMs, broadcast = true) {
        const remoteAddress = this._normalizeIp(rawAddress);
        if (!remoteAddress) {
            return;
        }
        const now = Date.now();
        const entry = this._getOrCreateEntry(remoteAddress, now);
        entry.blockedUntil = now + durationMs;
        entry.strikes += 1;
        if (broadcast) {
            this._broadcastClusterBlock(remoteAddress, durationMs);
        }
    }
    /**
     * Stops the cleanup interval and clears tracking data.
     */
    destroy() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        this.ipRequestCounts.clear();
        this.activeSockets.clear();
        this.authFailures.clear();
    }
    /**
     * Broadcasts an IP block event to peer workers when running in Cluster mode.
     * @param ip - Blocked IP.
     * @param durationMs - Duration.
     * @internal
     */
    _broadcastClusterBlock(ip, durationMs) {
        const shouldSync = this.config.syncCluster === true;
        if (!shouldSync) {
            return;
        }
        const hasSendMethod = Boolean(process.send);
        if (hasSendMethod) {
            process.send?.({
                type: 'ipBlock',
                ip,
                durationMs
            });
        }
    }
    /**
     * Builds an immediate blocked response and optionally destroys the socket.
     * @param req - Incoming request.
     * @internal
     */
    _buildBlockedResult(req) {
        const mitigationAction = this.config.mitigation.action ?? 'reject';
        switch (mitigationAction) {
            case 'destroy':
                req.socket?.destroy?.();
                return {
                    allowed: false,
                    status: 403,
                    message: DEFAULT_BLOCK_MESSAGE
                };
            case 'reject':
                return {
                    allowed: false,
                    status: 429,
                    message: 'Too Many Requests'
                };
            default:
                return {
                    allowed: false,
                    status: 429,
                    message: 'Too Many Requests'
                };
        }
    }
    /**
     * Normalizes the provided configuration with safe defaults.
     * @param config - Raw configuration overrides.
     * @internal
     */
    _resolveConfig(config) {
        const thresholds = config?.thresholds ?? {};
        const mitigation = config?.mitigation ?? {};
        const authProtection = config?.authProtection ??
            {};
        return {
            enabled: config?.enabled ?? DEFAULT_CONFIG.enabled,
            thresholds: {
                burstRequests: Math.max(1, Number(thresholds.burstRequests ?? DEFAULT_CONFIG.thresholds.burstRequests)),
                timeWindowMs: Math.max(1000, Number(thresholds.timeWindowMs ?? DEFAULT_CONFIG.thresholds.timeWindowMs)),
                warnRatio: thresholds.warnRatio ?? DEFAULT_CONFIG.thresholds.warnRatio,
                maxEntries: Math.max(100, Number(thresholds.maxEntries ?? DEFAULT_CONFIG.thresholds.maxEntries))
            },
            mitigation: {
                action: mitigation.action ?? DEFAULT_CONFIG.mitigation.action,
                blockDurationMs: Math.max(1000, Number(mitigation.blockDurationMs ??
                    DEFAULT_CONFIG.mitigation.blockDurationMs)),
                backoffMultiplier: mitigation.backoffMultiplier ??
                    DEFAULT_CONFIG.mitigation.backoffMultiplier,
                maxBlockDurationMs: mitigation.maxBlockDurationMs ??
                    DEFAULT_CONFIG.mitigation.maxBlockDurationMs,
                delayMs: 0
            },
            maxConcurrentConnectionsPerIp: Math.max(1, Number(config?.maxConcurrentConnectionsPerIp ??
                DEFAULT_CONFIG.maxConcurrentConnectionsPerIp)),
            authProtection: {
                enabled: authProtection.enabled ?? DEFAULT_CONFIG.authProtection?.enabled,
                maxFailures: Math.max(1, authProtection.maxFailures ?? 5),
                timeWindowMs: Math.max(1000, authProtection.timeWindowMs ?? 60000),
                banDurationMs: Math.max(1000, authProtection.banDurationMs ?? 900000)
            },
            syncCluster: config?.syncCluster ?? DEFAULT_CONFIG.syncCluster,
            ipv6SubnetMask: config?.ipv6SubnetMask ?? 64,
            ignore: {
                userIds: config?.ignore?.userIds ?? DEFAULT_CONFIG.ignore?.userIds ?? [],
                guildIds: config?.ignore?.guildIds ?? DEFAULT_CONFIG.ignore?.guildIds ?? [],
                ips: config?.ignore?.ips ?? DEFAULT_CONFIG.ignore?.ips ?? [],
                paths: config?.ignore?.paths ?? DEFAULT_CONFIG.ignore?.paths ?? []
            },
            trustProxy: config?.trustProxy ?? DEFAULT_CONFIG.trustProxy,
            trustedProxies: config?.trustedProxies ?? DEFAULT_CONFIG.trustedProxies ?? []
        };
    }
    /**
     * Resolves the cleanup interval duration based on configuration.
     * @internal
     */
    _resolveCleanupInterval() {
        const interval = this.config.thresholds.timeWindowMs;
        const clamped = Math.min(interval, MAX_CLEANUP_INTERVAL_MS);
        return Math.max(clamped, MIN_CLEANUP_INTERVAL_MS);
    }
    /**
     * Determines whether a request should bypass DoS protection.
     * @param req - Incoming API request.
     * @param remoteAddress - Normalized remote address.
     * @internal
     */
    _shouldIgnore(req, remoteAddress) {
        const ignore = this.config.ignore;
        if (!ignore)
            return false;
        const isIpIgnored = Boolean(ignore.ips?.includes(remoteAddress));
        if (isIpIgnored)
            return true;
        const userId = this._getHeaderValue(req.headers, 'user-id');
        const isUserIgnored = Boolean(userId && ignore.userIds?.includes(userId));
        if (isUserIgnored)
            return true;
        const guildId = this._extractGuildId(req.url);
        const isGuildIgnored = Boolean(guildId && ignore.guildIds?.includes(guildId));
        if (isGuildIgnored)
            return true;
        const pathList = ignore.paths ?? [];
        const isPathIgnored = Boolean(req.url && pathList.some((path) => req.url?.startsWith(path)));
        return isPathIgnored;
    }
    /**
     * Extracts a normalized IP address from the request.
     * @param req - Incoming API request.
     * @internal
     */
    _resolveRemoteAddress(req) {
        const socketAddress = req.socket?.remoteAddress;
        const trustProxyEnabled = this.config.trustProxy === true;
        if (!trustProxyEnabled) {
            return this._normalizeIp(socketAddress);
        }
        const headers = req.headers;
        const cfConnectingIp = this._getHeaderValue(headers, 'cf-connecting-ip');
        const trueClientIp = this._getHeaderValue(headers, 'true-client-ip');
        const xRealIp = this._getHeaderValue(headers, 'x-real-ip');
        const forwardedFor = this._getHeaderValue(headers, 'x-forwarded-for');
        const proxyCandidate = cfConnectingIp ??
            trueClientIp ??
            xRealIp ??
            forwardedFor?.split(',')?.[0]?.trim() ??
            socketAddress;
        return this._normalizeIp(proxyCandidate);
    }
    /**
     * Normalizes IP address formats for consistent tracking, grouping IPv6 by subnet.
     * @param ip - Raw IP string.
     * @internal
     */
    _normalizeIp(ip) {
        if (!ip)
            return null;
        let normalized = ip.trim();
        if (!normalized)
            return null;
        const hasIpv4MappedPrefix = normalized.startsWith('::ffff:');
        if (hasIpv4MappedPrefix) {
            normalized = normalized.slice(7);
        }
        const hasBrackets = normalized.startsWith('[') && normalized.endsWith(']');
        if (hasBrackets) {
            normalized = normalized.slice(1, -1);
        }
        const isIpv6 = normalized.includes(':');
        if (isIpv6) {
            return this._maskIpv6(normalized);
        }
        return normalized || null;
    }
    /**
     * Masks IPv6 addresses to group /64 subnets together.
     * @param ipv6 - Cleaned IPv6 string.
     * @internal
     */
    _maskIpv6(ipv6) {
        const segments = ipv6.split(':');
        const maskSize = this.config.ipv6SubnetMask ?? 64;
        const segmentCount = Math.min(8, Math.max(1, Math.floor(maskSize / 16)));
        const prefix = segments.slice(0, segmentCount).join(':');
        return `${prefix}::/${maskSize}`;
    }
    /**
     * Extracts a header value as a string.
     * @param headers - Request headers.
     * @param name - Header name.
     * @internal
     */
    _getHeaderValue(headers, name) {
        const raw = headers[name] ?? headers[name.toLowerCase()];
        const isArray = Array.isArray(raw);
        return isArray ? raw[0] : raw;
    }
    /**
     * Extracts a guild ID from the request URL.
     * @param url - Request URL.
     * @internal
     */
    _extractGuildId(url) {
        if (!url)
            return null;
        const match = url.match(/\/players\/(\d+)/);
        return match?.[1] ?? null;
    }
    /**
     * Retrieves or creates an IP entry for Token Bucket burst tracking.
     * @param ip - Normalized IP address.
     * @param now - Current timestamp.
     * @internal
     */
    _getOrCreateEntry(ip, now) {
        const existing = this.ipRequestCounts.get(ip);
        if (existing) {
            return existing;
        }
        const burstCapacity = this.config.thresholds.burstRequests;
        const entry = {
            tokens: burstCapacity,
            lastRefill: now,
            lastSeen: now,
            blockedUntil: 0,
            strikes: 0
        };
        this.ipRequestCounts.set(ip, entry);
        this._enforceMaxEntries();
        return entry;
    }
    /**
     * Calculates the next block duration with exponential backoff.
     * @param strikes - Number of strikes recorded.
     * @internal
     */
    _calculateBlockDuration(strikes) {
        const base = this.config.mitigation.blockDurationMs;
        const multiplier = this.config.mitigation.backoffMultiplier ?? 2;
        const max = this.config.mitigation.maxBlockDurationMs ?? base * 8;
        const duration = base * multiplier ** Math.max(0, strikes - 1);
        return Math.min(duration, max);
    }
    /**
     * Cleans up idle or expired IP entries and auth failure entries.
     * @internal
     */
    _cleanup() {
        const now = Date.now();
        const timeWindowMs = this.config.thresholds.timeWindowMs;
        const pruneThreshold = timeWindowMs * 3;
        for (const [ip, data] of this.ipRequestCounts.entries()) {
            const isUnblocked = now > data.blockedUntil;
            const isIdle = now - data.lastSeen > pruneThreshold;
            if (isUnblocked && isIdle) {
                this.ipRequestCounts.delete(ip);
            }
        }
        for (const [ip, data] of this.authFailures.entries()) {
            const isUnblocked = now > data.blockedUntil;
            const isIdle = now - data.lastReset > pruneThreshold;
            if (isUnblocked && isIdle) {
                this.authFailures.delete(ip);
            }
        }
        this._enforceMaxEntries();
    }
    /**
     * Enforces maximum entries using true O(1) LRU eviction without sorting.
     * @internal
     */
    _enforceMaxEntries() {
        const maxEntries = this.config.thresholds.maxEntries ?? 10000;
        const isExceeded = this.ipRequestCounts.size > maxEntries;
        if (!isExceeded)
            return;
        const overflowCount = this.ipRequestCounts.size - maxEntries;
        const iterator = this.ipRequestCounts.keys();
        for (let i = 0; i < overflowCount; i++) {
            const oldestKey = iterator.next().value;
            if (!oldestKey)
                break;
            this.ipRequestCounts.delete(oldestKey);
        }
    }
}
