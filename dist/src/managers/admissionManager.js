import { normalizeAddress, resolveClientAddress, TrustedProxyList } from '../utils/clientAddress.js';
import { logger } from '../utils.js';
const DEFAULT_CONFIG = {
    enabled: true,
    trustProxy: false,
    trustedProxies: [],
    guild: {
        baseCapacity: 30,
        refillRatePerSecond: 10,
        maxConcurrency: 2,
        quarantineScoreThreshold: 10,
        quarantineRecoveryThreshold: 4,
        quarantineDurationMs: 15000,
        scoreDecayHalfLifeSeconds: 8,
        maxGuildStates: 10000
    },
    session: {
        baseCapacity: 150,
        tokensPerActivePlayer: 1.5,
        refillRatePerSecond: 30,
        refillRatePerPlayerPerSecond: 0.2,
        quarantineScoreThreshold: 20,
        quarantineDurationMs: 30000,
        maxPlayerChurnPerMinute: 60,
        anomalyBurstMultiplier: 4,
        reconciliationMultiplier: 1.5,
        organicGrowthFactor: 0.2,
        organicGrowthFloor: 25,
        flappingThresholdMs: 120000,
        warmupDurationMs: 45000,
        maxReconciliationsPerWindow: 3,
        reconciliationWindowMs: 3600000
    },
    global: {
        baseCapacity: 300,
        refillRatePerSecond: 60
    },
    ip: {
        baseCapacity: 500,
        refillRatePerSecond: 100,
        maxConcurrentSockets: 25,
        maxProxySockets: 1024,
        ipv6SubnetMask: 64,
        blockScoreThreshold: 30,
        blockDurationMs: 300000,
        backoffMultiplier: 2,
        maxBlockDurationMs: 2400000,
        authProtection: {
            enabled: true,
            maxFailures: 5,
            windowMs: 60000,
            banDurationMs: 900000
        }
    },
    operationCosts: {
        PLAYER_PLAY: 4,
        PLAYER_STOP: 1,
        PLAYER_PAUSE: 1,
        PLAYER_SEEK: 2,
        PLAYER_VOLUME: 1,
        PLAYER_FILTERS: 3,
        PLAYER_VOICE: 2,
        PLAYER_GET: 1,
        PLAYER_DESTROY: 3,
        LOAD_TRACKS: 5,
        LOAD_STREAM: 6,
        LOAD_LYRICS: 3,
        DECODE_TRACK: 2,
        ENCODE_TRACK: 2,
        AI_MEANING: 4,
        SESSION_UPGRADE: 5,
        SESSION_UPDATE: 2,
        SESSION_PLAYERS_LIST: 1,
        GROUPS_OP: 2,
        METADATA_GET: 1,
        GENERIC_REST: 1
    }
};
/**
 * Unified Admission & Adaptive Protection Manager for NodeLink.
 *
 * Implements a 3-tier concentric defense-in-depth model:
 * - L0 / L1 Guild Layer: Execution protection (player, decoder, audio pipeline, DSP)
 * - L2 Session Layer: Context aggregation (shard, player churn, EWMA rate)
 * - L3 IP Layer: Network edge (TCP socket pool, auth brute-force, DDoS)
 *
 * @public
 */
export default class AdmissionManager {
    nodelink;
    config;
    guildStates;
    sessionStates;
    ipStates;
    proxySockets;
    trustedProxies;
    globalState;
    cleanupInterval;
    constructor(nodelink, config) {
        this.nodelink = nodelink;
        this.config = this._mergeConfig(config);
        this.guildStates = new Map();
        this.sessionStates = new Map();
        this.ipStates = new Map();
        this.proxySockets = new Map();
        this.trustedProxies = this._buildTrustedProxies();
        const now = performance.now();
        this.globalState = {
            tokens: 300,
            lastRefill: now,
            score: 0,
            lastScoreUpdate: now,
            consecutiveViolations: 0,
            quarantineUntil: 0,
            lastSeen: now
        };
        this.cleanupInterval = setInterval(() => {
            this._pruneExpiredStates();
        }, 15000);
        this.cleanupInterval?.unref?.();
    }
    /**
     * Resolves the complete semantic admission context from an incoming request.
     * @param req - Raw or shimmed API request.
     * @param parsedUrl - Parsed URL instance.
     * @param body - Optional pre-parsed JSON body.
     */
    resolveContext(req, parsedUrl, body) {
        const pathname = parsedUrl.pathname ?? '/';
        const method = (req.method ?? 'GET').toUpperCase();
        const ip = this._resolveIp(req);
        const rawSessionId = this._extractSessionId(pathname, req.headers);
        const guildId = this._extractGuildId(pathname);
        const userId = this._getHeader(req.headers, 'user-id') ?? null;
        const sessionId = rawSessionId && this._isSessionProven(rawSessionId, userId)
            ? rawSessionId
            : null;
        const transport = this._resolveTransport(req, pathname);
        const operation = this._classifyOperation(method, pathname, body);
        const cost = this._resolveCost(operation);
        const resource = this._classifyResource(operation);
        const authenticated = this._checkAuth(req.headers);
        return {
            ip,
            sessionId,
            guildId,
            userId,
            transport,
            operation,
            cost,
            resource,
            authenticated,
            pathname,
            method
        };
    }
    /**
     * Evaluates admission across L3 IP -> L2 Session -> L1 Guild.
     * Applies the blast radius containment principle: isolates issues at the lowest possible layer.
     * @param context - Resolved request admission context.
     */
    admit(context) {
        const isEnabled = this.config.enabled;
        if (!isEnabled) {
            return this._buildAllowedDecision('ip', 100, 100);
        }
        const isBypassed = this._isIgnored(context);
        if (isBypassed) {
            return this._buildAllowedDecision('ip', 100, 100);
        }
        const now = performance.now();
        let lastDecision = null;
        if (context.ip) {
            const ipDecision = this._evaluateIpLayer(context.ip, context, now);
            const ipBlocked = !ipDecision.allowed;
            if (ipBlocked) {
                return ipDecision;
            }
            lastDecision = ipDecision;
        }
        if (context.sessionId) {
            const sessionDecision = this._evaluateSessionLayer(context.sessionId, context, now);
            const sessionBlocked = !sessionDecision.allowed;
            if (sessionBlocked) {
                return sessionDecision;
            }
            lastDecision = sessionDecision;
        }
        else if (context.authenticated &&
            context.cost > 1 &&
            context.transport === 'http') {
            const globalDecision = this._evaluateGlobalLayer(context, now);
            const globalBlocked = !globalDecision.allowed;
            if (globalBlocked) {
                return globalDecision;
            }
            lastDecision = globalDecision;
        }
        if (context.guildId && context.sessionId) {
            const guildDecision = this._evaluateGuildLayer(context.sessionId, context.guildId, context, now);
            const guildBlocked = !guildDecision.allowed;
            if (guildBlocked) {
                const sessionState = this.sessionStates.get(context.sessionId);
                if (sessionState) {
                    sessionState.tokens += context.cost;
                }
                return guildDecision;
            }
            return guildDecision;
        }
        if (lastDecision) {
            return lastDecision;
        }
        return this._buildAllowedDecision('ip', 100, 100);
    }
    /**
     * Resolves the originating client address, honoring forwarding headers only
     * from trusted proxies. Unlike admission keys, the result is not subnet-masked.
     * @param req - Raw or shimmed API request.
     */
    resolveClientAddress(req) {
        return resolveClientAddress(req.socket?.remoteAddress, req.headers, this.trustedProxies);
    }
    /**
     * Checks whether a TCP peer is a configured trusted proxy.
     * @param rawAddress - Peer address.
     */
    isTrustedProxy(rawAddress) {
        return this.trustedProxies.contains(rawAddress);
    }
    /**
     * Admits a new TCP connection. Trusted proxies share one aggregate pool, since
     * per-client bans and limits are enforced per request once headers are known.
     * Other peers are checked against their own block state and socket pool.
     * @param rawAddress - Peer address.
     * @returns Whether the connection may proceed; call releaseConnection on close.
     */
    admitConnection(rawAddress) {
        if (!this.trustedProxies.contains(rawAddress)) {
            if (this.isIpBlocked(rawAddress))
                return false;
            return this.incrementActiveSockets(rawAddress);
        }
        const proxy = normalizeAddress(rawAddress);
        const active = this.proxySockets.get(proxy) ?? 0;
        const maxSockets = this.config.ip.maxProxySockets;
        if (active >= maxSockets) {
            logger('warn', 'AdmissionManager', `Trusted proxy ${proxy} exceeded aggregate socket pool (${active}/${maxSockets}). Dropping connection.`);
            return false;
        }
        this.proxySockets.set(proxy, active + 1);
        return true;
    }
    /**
     * Releases a connection admitted by admitConnection.
     * @param rawAddress - Peer address.
     */
    releaseConnection(rawAddress) {
        if (!this.trustedProxies.contains(rawAddress)) {
            this.decrementActiveSockets(rawAddress);
            return;
        }
        const proxy = normalizeAddress(rawAddress);
        const next = (this.proxySockets.get(proxy) ?? 0) - 1;
        if (next > 0) {
            this.proxySockets.set(proxy, next);
        }
        else {
            this.proxySockets.delete(proxy);
        }
    }
    /**
     * Tracks an incoming TCP socket. Returns false if IP connection pool is exhausted.
     * @param rawAddress - Remote IP address.
     */
    incrementActiveSockets(rawAddress) {
        const ip = this._normalizeIp(rawAddress);
        if (!ip)
            return true;
        const state = this._getOrCreateIpState(ip, performance.now());
        const maxSockets = this.config.ip.maxConcurrentSockets;
        const isExhausted = state.activeSockets >= maxSockets;
        if (isExhausted) {
            logger('warn', 'AdmissionManager', `IP ${ip} exceeded concurrent socket pool (${state.activeSockets}/${maxSockets}). Dropping connection.`);
            return false;
        }
        state.activeSockets += 1;
        return true;
    }
    /**
     * Decrements active TCP socket count for an IP.
     * @param rawAddress - Remote IP address.
     */
    decrementActiveSockets(rawAddress) {
        const ip = this._normalizeIp(rawAddress);
        if (!ip)
            return;
        const state = this.ipStates.get(ip);
        if (!state)
            return;
        state.activeSockets = Math.max(0, state.activeSockets - 1);
    }
    /**
     * Records a failed authentication attempt and blocks IP if threshold is breached.
     * @param rawAddress - Remote IP address.
     */
    recordAuthFailure(rawAddress) {
        const authConfig = this.config.ip.authProtection;
        const isEnabled = authConfig.enabled;
        if (!isEnabled)
            return false;
        const ip = this._normalizeIp(rawAddress);
        if (!ip)
            return false;
        const now = performance.now();
        const state = this._getOrCreateIpState(ip, now);
        const isWindowExpired = now - state.authWindowReset > authConfig.windowMs;
        if (isWindowExpired) {
            state.authFailures = 0;
            state.authWindowReset = now;
        }
        state.authFailures += 1;
        const isBreached = state.authFailures >= authConfig.maxFailures;
        if (isBreached) {
            state.blockedUntil = now + authConfig.banDurationMs;
            logger('warn', 'AdmissionManager', `IP ${ip} jailed for brute force password attempts (${state.authFailures}/${authConfig.maxFailures}) for ${authConfig.banDurationMs}ms.`);
            this._broadcastIpBlock(ip, authConfig.banDurationMs);
            return true;
        }
        return false;
    }
    /**
     * Checks whether an IP is currently blocked or jailed.
     * @param rawAddress - Remote IP address.
     */
    isIpBlocked(rawAddress) {
        const ip = this._normalizeIp(rawAddress);
        if (!ip)
            return false;
        const state = this.ipStates.get(ip);
        if (!state)
            return false;
        const now = performance.now();
        const isBlocked = now < state.blockedUntil;
        return isBlocked;
    }
    /**
     * Manually blocks an IP for a specified duration.
     * @param rawAddress - Remote IP address.
     * @param durationMs - Duration in milliseconds.
     * @param broadcast - Whether to sync across cluster workers.
     */
    blockIp(rawAddress, durationMs, broadcast = false) {
        const ip = this._normalizeIp(rawAddress);
        if (!ip)
            return;
        const now = performance.now();
        const state = this._getOrCreateIpState(ip, now);
        state.blockedUntil = now + durationMs;
        if (broadcast) {
            this._broadcastIpBlock(ip, durationMs);
        }
    }
    /**
     * Records player creation in a session for churn tracking.
     * @param sessionId - Session identifier.
     */
    recordPlayerCreate(sessionId) {
        const state = this.sessionStates.get(sessionId);
        if (!state)
            return;
        state.playerCreates += 1;
        state.activePlayers += 1;
    }
    /**
     * Records player destruction in a session for churn tracking.
     * @param sessionId - Session identifier.
     */
    recordPlayerDestroy(sessionId) {
        const state = this.sessionStates.get(sessionId);
        if (!state)
            return;
        state.playerDestroys += 1;
        state.activePlayers = Math.max(0, state.activePlayers - 1);
    }
    /**
     * Records a session resume event, computing reconciliation budget and organic headroom.
     * Enforces anti-flapping protection to avoid exploitation of the reconnection credit.
     *
     * @param sessionId - Restored session identifier.
     */
    recordSessionResume(sessionId) {
        const now = performance.now();
        const state = this._getOrCreateSessionState(sessionId, now);
        const config = this.config.session;
        const hasPreviousResume = state.lastResumeTimestamp > 0;
        const elapsedSinceLastResume = now - state.lastResumeTimestamp;
        const isFlapping = hasPreviousResume && elapsedSinceLastResume < config.flappingThresholdMs;
        if (isFlapping) {
            state.score += 5;
            logger('warn', 'AdmissionManager', `Session ${sessionId} flagged for connection flapping (${Math.round(elapsedSinceLastResume)}ms since previous resume). Credit denied.`);
            return;
        }
        state.lastResumeTimestamp = now;
        state.resumeCount += 1;
        const windowElapsed = now - state.reconciliationWindowReset;
        if (windowElapsed > config.reconciliationWindowMs) {
            state.reconciliationGrantsInWindow = 0;
            state.reconciliationWindowReset = now;
        }
        const hasQuota = state.reconciliationGrantsInWindow < config.maxReconciliationsPerWindow;
        const existingPlayers = this._resolveSessionPlayersCount(sessionId);
        const organicHeadroom = Math.max(config.organicGrowthFloor, Math.round(existingPlayers * config.organicGrowthFactor));
        const adaptiveCapacity = Math.max(config.baseCapacity, Math.round(config.baseCapacity + existingPlayers * config.tokensPerActivePlayer));
        if (hasQuota) {
            state.reconciliationGrantsInWindow += 1;
            const targetTokens = Math.round(existingPlayers * config.reconciliationMultiplier + organicHeadroom);
            state.tokens = Math.min(adaptiveCapacity, Math.max(state.tokens, targetTokens));
            state.warmupUntil = now + config.warmupDurationMs;
            state.warmupChurnBudget = existingPlayers + organicHeadroom;
            logger('info', 'AdmissionManager', `Session ${sessionId} resumed with ${existingPlayers} active players. Top-up target: ${targetTokens} tokens (headroom: ${organicHeadroom}). Warmup active for ${config.warmupDurationMs}ms.`);
        }
        else {
            logger('warn', 'AdmissionManager', `Session ${sessionId} reached reconciliation grant quota (${state.reconciliationGrantsInWindow}/${config.maxReconciliationsPerWindow}) for current window. Operating with natural refill.`);
        }
    }
    /**
     * Initializes admission state when a new session connects.
     *
     * @param sessionId - New session identifier.
     */
    recordSessionConnect(sessionId) {
        const now = performance.now();
        const state = this._getOrCreateSessionState(sessionId, now);
        state.lastSeen = now;
    }
    /**
     * Destroys resources and intervals upon shutdown.
     */
    destroy() {
        clearInterval(this.cleanupInterval);
        this.guildStates.clear();
        this.sessionStates.clear();
        this.ipStates.clear();
    }
    /**
     * Evaluates L1 Guild Execution Layer (and L0 Concurrency).
     * @internal
     */
    _evaluateGuildLayer(sessionId, guildId, context, now) {
        const isExecutionOperation = context.operation.startsWith('PLAYER_');
        const isReadOnly = context.operation === 'PLAYER_GET';
        const isRegistered = this._isGuildPlayerRegistered(sessionId, guildId);
        const key = `${sessionId}:${guildId}`;
        const existing = this.guildStates.get(key);
        if (!existing && !isRegistered && isReadOnly) {
            return this._buildAllowedDecision('guild', this.config.guild.baseCapacity, this.config.guild.baseCapacity);
        }
        const state = this._getOrCreateGuildState(key, now);
        const config = this.config.guild;
        this._applyScoreDecay(state, now, config.scoreDecayHalfLifeSeconds);
        const isInQuarantine = now < state.quarantineUntil;
        if (isInQuarantine) {
            const remainingMs = state.quarantineUntil - now;
            const retryAfter = Math.ceil(remainingMs / 1000);
            return {
                allowed: false,
                action: 'quarantine',
                scope: 'guild',
                status: 429,
                message: `Guild ${guildId} player is quarantined due to excessive command abuse.`,
                retryAfterSeconds: Math.max(1, retryAfter)
            };
        }
        const hasRecovered = state.score <= config.quarantineRecoveryThreshold;
        if (hasRecovered && state.quarantineUntil > 0) {
            state.quarantineUntil = 0;
            state.consecutiveViolations = 0;
        }
        const hasHighConcurrency = isExecutionOperation && state.activeConcurrency >= config.maxConcurrency;
        if (hasHighConcurrency) {
            state.score += 2;
            return {
                allowed: false,
                action: 'limit',
                scope: 'operation',
                status: 429,
                message: `Guild ${guildId} player concurrency limit reached (${state.activeConcurrency}/${config.maxConcurrency}). Wait for previous action to finish.`,
                retryAfterSeconds: 1
            };
        }
        const elapsedSeconds = Math.max(0, (now - state.lastRefill) / 1000);
        const replenished = state.tokens + elapsedSeconds * config.refillRatePerSecond;
        const capacity = config.baseCapacity;
        state.tokens = Math.min(capacity, Math.max(0, replenished));
        state.lastRefill = now;
        state.lastSeen = now;
        const cost = context.cost;
        const hasTokens = state.tokens >= cost;
        if (!hasTokens) {
            state.consecutiveViolations += 1;
            const isRetryStorm = now - state.last429Timestamp < 250;
            state.last429Timestamp = now;
            if (isRetryStorm) {
                state.score += 3;
            }
            else {
                state.score += 1;
            }
            const shouldQuarantine = state.score >= config.quarantineScoreThreshold;
            if (shouldQuarantine) {
                state.quarantineUntil = now + config.quarantineDurationMs;
                logger('warn', 'AdmissionManager', `Guild ${guildId} placed in quarantine for ${config.quarantineDurationMs}ms (score: ${state.score.toFixed(1)}).`);
                this._escalateToSession(sessionId, 4);
            }
            const missingTokens = cost - state.tokens;
            const waitSeconds = Math.ceil(missingTokens / config.refillRatePerSecond);
            return {
                allowed: false,
                action: 'limit',
                scope: 'guild',
                status: 429,
                message: `Guild ${guildId} rate limit exceeded.`,
                retryAfterSeconds: Math.max(1, waitSeconds),
                remainingTokens: 0,
                capacityLimit: capacity,
                resetTimestamp: Date.now() + waitSeconds * 1000
            };
        }
        state.tokens = Math.max(0, state.tokens - cost);
        state.consecutiveViolations = 0;
        if (isExecutionOperation) {
            state.activeConcurrency += 1;
        }
        const releaseConcurrency = isExecutionOperation
            ? () => {
                state.activeConcurrency = Math.max(0, state.activeConcurrency - 1);
            }
            : undefined;
        const waitSeconds = Math.ceil((capacity - state.tokens) / config.refillRatePerSecond);
        return {
            allowed: true,
            action: 'allow',
            scope: 'guild',
            status: 200,
            message: 'OK',
            retryAfterSeconds: 0,
            remainingTokens: Math.floor(state.tokens),
            capacityLimit: capacity,
            resetTimestamp: Date.now() + waitSeconds * 1000,
            releaseConcurrency
        };
    }
    /**
     * Evaluates L2 Session Context Layer.
     * @internal
     */
    _evaluateSessionLayer(sessionId, context, now) {
        const state = this._getOrCreateSessionState(sessionId, now);
        const config = this.config.session;
        const halfLife = 12;
        this._applyScoreDecay(state, now, halfLife);
        const isQuarantined = now < state.quarantineUntil;
        if (isQuarantined) {
            const remainingMs = state.quarantineUntil - now;
            const retryAfter = Math.ceil(remainingMs / 1000);
            return {
                allowed: false,
                action: 'quarantine',
                scope: 'session',
                status: 429,
                message: `Session ${sessionId} is in quarantine due to sustained aggregate pressure.`,
                retryAfterSeconds: Math.max(1, retryAfter)
            };
        }
        const churnWindowMs = 60000;
        const isChurnWindowExpired = now - state.churnWindowReset > churnWindowMs;
        const activePlayersCount = this._resolveSessionPlayersCount(sessionId);
        state.activePlayers = activePlayersCount;
        if (isChurnWindowExpired) {
            state.playerCreates = 0;
            state.playerDestroys = 0;
            state.churnWindowReset = now;
            state.stablePlayersBaseline = activePlayersCount;
        }
        const isWarmup = now < state.warmupUntil;
        const effectiveChurnLimit = isWarmup
            ? config.maxPlayerChurnPerMinute + state.warmupChurnBudget
            : config.maxPlayerChurnPerMinute;
        const totalChurn = state.playerCreates + state.playerDestroys;
        const isChurnAbusive = totalChurn > effectiveChurnLimit;
        let effectivePlayerCount = activePlayersCount;
        if (isChurnAbusive) {
            state.score += 5;
            effectivePlayerCount = Math.min(activePlayersCount, state.stablePlayersBaseline);
            logger('warn', 'AdmissionManager', `Session ${sessionId} exceeded player churn threshold (${totalChurn}/${effectiveChurnLimit}). Capacity expansion dampened.`);
        }
        else {
            state.stablePlayersBaseline = activePlayersCount;
        }
        const adaptiveCapacity = Math.max(config.baseCapacity, Math.round(config.baseCapacity +
            effectivePlayerCount * config.tokensPerActivePlayer));
        const adaptiveRefillRate = Math.max(config.refillRatePerSecond, config.refillRatePerSecond +
            effectivePlayerCount * config.refillRatePerPlayerPerSecond);
        const elapsedSeconds = Math.max(0, (now - state.lastRefill) / 1000);
        const replenished = state.tokens + elapsedSeconds * adaptiveRefillRate;
        state.tokens = Math.min(adaptiveCapacity, Math.max(0, replenished));
        state.lastRefill = now;
        state.lastSeen = now;
        this._updateSessionEwma(state, now);
        const cost = context.cost;
        const hasTokens = state.tokens >= cost;
        if (!hasTokens) {
            state.consecutiveViolations += 1;
            state.score += 2;
            const isBreached = state.score >= config.quarantineScoreThreshold;
            if (isBreached) {
                state.quarantineUntil = now + config.quarantineDurationMs;
                logger('warn', 'AdmissionManager', `Session ${sessionId} placed in quarantine for ${config.quarantineDurationMs}ms.`);
                if (context.ip) {
                    this._escalateToIp(context.ip, 6);
                }
            }
            const missingTokens = cost - state.tokens;
            const waitSeconds = Math.ceil(missingTokens / adaptiveRefillRate);
            return {
                allowed: false,
                action: 'limit',
                scope: 'session',
                status: 429,
                message: `Session ${sessionId} rate limit exceeded.`,
                retryAfterSeconds: Math.max(1, waitSeconds),
                remainingTokens: 0,
                capacityLimit: adaptiveCapacity,
                resetTimestamp: Date.now() + waitSeconds * 1000
            };
        }
        state.tokens = Math.max(0, state.tokens - cost);
        const waitSeconds = Math.ceil((adaptiveCapacity - state.tokens) / adaptiveRefillRate);
        return {
            allowed: true,
            action: 'allow',
            scope: 'session',
            status: 200,
            message: 'OK',
            retryAfterSeconds: 0,
            remainingTokens: Math.floor(state.tokens),
            capacityLimit: adaptiveCapacity,
            resetTimestamp: Date.now() + waitSeconds * 1000
        };
    }
    /**
     * Evaluates L3 IP Edge Layer.
     * @internal
     */
    _evaluateIpLayer(ip, context, now) {
        const state = this._getOrCreateIpState(ip, now);
        const config = this.config.ip;
        const isBlocked = now < state.blockedUntil;
        if (isBlocked) {
            const remainingMs = state.blockedUntil - now;
            const retryAfter = Math.ceil(remainingMs / 1000);
            return {
                allowed: false,
                action: 'drop',
                scope: 'ip',
                status: 403,
                message: 'Forbidden: IP address is temporarily blocked.',
                retryAfterSeconds: Math.max(1, retryAfter)
            };
        }
        const halfLife = 20;
        this._applyScoreDecay(state, now, halfLife);
        const capacity = config.baseCapacity;
        const elapsedSeconds = Math.max(0, (now - state.lastRefill) / 1000);
        const replenished = state.tokens + elapsedSeconds * config.refillRatePerSecond;
        state.tokens = Math.min(capacity, Math.max(0, replenished));
        state.lastRefill = now;
        state.lastSeen = now;
        const effectiveCost = context.authenticated ? 1 : context.cost;
        const hasTokens = state.tokens >= effectiveCost;
        if (!hasTokens) {
            state.consecutiveViolations += 1;
            state.score += 2;
            const shouldBlock = state.score >= config.blockScoreThreshold;
            if (shouldBlock) {
                state.blockedUntil = now + config.blockDurationMs;
                logger('warn', 'AdmissionManager', `IP ${ip} temporarily blocked for ${config.blockDurationMs}ms (score: ${state.score.toFixed(1)}).`);
                this._broadcastIpBlock(ip, config.blockDurationMs);
            }
            const missingTokens = effectiveCost - state.tokens;
            const waitSeconds = Math.ceil(missingTokens / config.refillRatePerSecond);
            return {
                allowed: false,
                action: 'limit',
                scope: 'ip',
                status: 429,
                message: 'IP rate limit exceeded.',
                retryAfterSeconds: Math.max(1, waitSeconds),
                remainingTokens: 0,
                capacityLimit: capacity,
                resetTimestamp: Date.now() + waitSeconds * 1000
            };
        }
        state.tokens = Math.max(0, state.tokens - effectiveCost);
        const waitSeconds = Math.ceil((capacity - state.tokens) / config.refillRatePerSecond);
        return {
            allowed: true,
            action: 'allow',
            scope: 'ip',
            status: 200,
            message: 'OK',
            retryAfterSeconds: 0,
            remainingTokens: Math.floor(state.tokens),
            capacityLimit: capacity,
            resetTimestamp: Date.now() + waitSeconds * 1000
        };
    }
    /**
     * Applies continuous exponential decay to strike scores: S(t) = S(t0) * 0.5^(dt / halfLife)
     * @internal
     */
    _applyScoreDecay(state, now, halfLifeSeconds) {
        const elapsedSeconds = Math.max(0, (now - state.lastScoreUpdate) / 1000);
        if (elapsedSeconds <= 0)
            return;
        const decayFactor = 0.5 ** (elapsedSeconds / halfLifeSeconds);
        state.score *= decayFactor;
        state.lastScoreUpdate = now;
    }
    /**
     * Escalates child guild strike signal to parent session.
     * @internal
     */
    _escalateToSession(sessionId, strikePoints) {
        const state = this.sessionStates.get(sessionId);
        if (!state)
            return;
        state.score += strikePoints;
    }
    /**
     * Escalates session strike signal to IP.
     * @internal
     */
    _escalateToIp(ip, strikePoints) {
        const state = this.ipStates.get(ip);
        if (!state)
            return;
        state.score += strikePoints;
    }
    /**
     * Classifies request into a granular AdmissionOperation.
     * @internal
     */
    _classifyOperation(method, pathname, body) {
        const hasPlayerInPath = pathname.includes('/players/');
        if (hasPlayerInPath) {
            switch (method) {
                case 'DELETE':
                    return 'PLAYER_DESTROY';
                case 'GET':
                    return 'PLAYER_GET';
                case 'PATCH':
                    return this._classifyPlayerPatchOperation(body);
                default:
                    return 'GENERIC_REST';
            }
        }
        const segments = pathname.split('/');
        const primary = segments[2] ?? segments[1] ?? '';
        switch (primary) {
            case 'loadtracks':
                return 'LOAD_TRACKS';
            case 'loadstream':
                return 'LOAD_STREAM';
            case 'loadlyrics':
                return 'LOAD_LYRICS';
            case 'meaning':
                return 'AI_MEANING';
            case 'decodetrack':
            case 'decodetracks':
                return 'DECODE_TRACK';
            case 'encodetrack':
            case 'encodetracks':
                return 'ENCODE_TRACK';
            case 'websocket':
                return 'SESSION_UPGRADE';
            case 'sessions':
                return this._classifySessionOperation(pathname, method);
            case 'info':
            case 'version':
            case 'stats':
                return 'METADATA_GET';
            default:
                return 'GENERIC_REST';
        }
    }
    /**
     * Distinguishes player patch sub-actions based on payload body fields.
     * @internal
     */
    _classifyPlayerPatchOperation(body) {
        if (!body || typeof body !== 'object')
            return 'PLAYER_PLAY';
        const payload = body;
        if (payload.filters !== undefined)
            return 'PLAYER_FILTERS';
        if (payload.position !== undefined)
            return 'PLAYER_SEEK';
        if (payload.voice !== undefined)
            return 'PLAYER_VOICE';
        if (payload.paused !== undefined)
            return 'PLAYER_PAUSE';
        if (payload.volume !== undefined)
            return 'PLAYER_VOLUME';
        if (payload.track !== undefined)
            return 'PLAYER_PLAY';
        return 'PLAYER_PLAY';
    }
    /**
     * Distinguishes session-level operations.
     * @internal
     */
    _classifySessionOperation(pathname, method) {
        const isPlayersList = pathname.endsWith('/players') && method === 'GET';
        if (isPlayersList)
            return 'SESSION_PLAYERS_LIST';
        const isGroups = pathname.includes('/groups');
        if (isGroups)
            return 'GROUPS_OP';
        return 'SESSION_UPDATE';
    }
    /**
     * Maps operation to primary impacted resource category.
     * @internal
     */
    _classifyResource(operation) {
        switch (operation) {
            case 'PLAYER_PLAY':
            case 'DECODE_TRACK':
                return 'decoder';
            case 'PLAYER_FILTERS':
                return 'dsp_filters';
            case 'PLAYER_SEEK':
            case 'PLAYER_STOP':
            case 'PLAYER_PAUSE':
            case 'PLAYER_VOLUME':
            case 'PLAYER_VOICE':
            case 'PLAYER_DESTROY':
                return 'audio_pipeline';
            case 'LOAD_TRACKS':
            case 'LOAD_STREAM':
            case 'LOAD_LYRICS':
            case 'AI_MEANING':
                return 'external_source';
            case 'SESSION_UPGRADE':
            case 'SESSION_UPDATE':
            case 'SESSION_PLAYERS_LIST':
                return 'session_pool';
            default:
                return 'metadata';
        }
    }
    /**
     * Resolves computational cost for the operation.
     * @internal
     */
    _resolveCost(operation) {
        const customCost = this.config.operationCosts?.[operation];
        if (customCost !== undefined) {
            return customCost;
        }
        const defaultCost = DEFAULT_CONFIG.operationCosts?.[operation];
        return defaultCost ?? 1;
    }
    /**
     * Resolves transport mode.
     * @internal
     */
    _resolveTransport(req, pathname) {
        const isUpgrade = req.headers.upgrade === 'websocket' || pathname.endsWith('/websocket');
        return isUpgrade ? 'ws-upgrade' : 'http';
    }
    /**
     * Validates authorization header against server password.
     * @internal
     */
    _checkAuth(headers) {
        const authHeader = this._getHeader(headers, 'authorization');
        const serverPassword = this.nodelink.options.server?.password;
        if (!serverPassword)
            return true;
        const isValid = authHeader === serverPassword || authHeader === `Bearer ${serverPassword}`;
        return isValid;
    }
    /**
     * Extracts session identifier from URL pathname or headers.
     * @internal
     */
    _extractSessionId(pathname, headers) {
        const match = pathname.match(/\/sessions\/([a-zA-Z0-9_-]+)/);
        if (match?.[1]) {
            return match[1];
        }
        const headerSessionId = this._getHeader(headers, 'session-id');
        return headerSessionId ?? null;
    }
    /**
     * Validates that a session identifier exists and is registered in NodeLink.
     * Prevents rate limit evasion and state memory exhaustion via forged or rotated Session-Id headers.
     * @internal
     */
    _isSessionProven(sessionId, userId) {
        if (!sessionId)
            return false;
        const sessions = this.nodelink.sessions;
        if (!sessions)
            return false;
        const session = sessions.get?.(sessionId) ??
            sessions.activeSessions?.get?.(sessionId) ??
            sessions.resumableSessions?.get?.(sessionId);
        if (!session)
            return false;
        if (userId && session.userId) {
            const sessionUserId = Array.isArray(session.userId)
                ? session.userId[0]
                : session.userId;
            if (sessionUserId && userId !== sessionUserId) {
                return false;
            }
        }
        return true;
    }
    /**
     * Extracts guild identifier from URL pathname.
     * @internal
     */
    _extractGuildId(pathname) {
        const match = pathname.match(/\/players\/([0-9]+)/);
        return match?.[1] ?? null;
    }
    /**
     * Resolves the admission key for a request's client address.
     * @internal
     */
    _resolveIp(req) {
        return this._normalizeIp(this.resolveClientAddress(req));
    }
    /**
     * Builds the trusted proxy matcher and reports misconfiguration.
     * @internal
     */
    _buildTrustedProxies() {
        const { trustProxy, trustedProxies } = this.config;
        if (!trustProxy) {
            if (trustedProxies.length > 0) {
                logger('warn', 'AdmissionManager', 'admission.trustedProxies is set but admission.trustProxy is false; forwarding headers are ignored.');
            }
            return new TrustedProxyList();
        }
        const list = new TrustedProxyList(trustedProxies);
        for (const entry of list.invalidEntries) {
            logger('warn', 'AdmissionManager', `Ignoring invalid admission.trustedProxies entry: ${entry}`);
        }
        if (list.size === 0) {
            logger('warn', 'AdmissionManager', 'admission.trustProxy is enabled but admission.trustedProxies has no valid entries; forwarding headers are ignored.');
        }
        return list;
    }
    /**
     * Normalizes IP and applies IPv6 /64 subnet mask.
     * @internal
     */
    _normalizeIp(ip) {
        if (!ip)
            return null;
        let normalized = ip.trim();
        if (!normalized)
            return null;
        const hasIpv4Mapped = normalized.startsWith('::ffff:');
        if (hasIpv4Mapped) {
            normalized = normalized.slice(7);
        }
        const hasBrackets = normalized.startsWith('[') && normalized.endsWith(']');
        if (hasBrackets) {
            normalized = normalized.slice(1, -1);
        }
        const isIpv6 = normalized.includes(':');
        if (isIpv6) {
            const segments = normalized.split(':');
            const maskSize = this.config.ip.ipv6SubnetMask ?? 64;
            const segmentCount = Math.min(8, Math.max(1, Math.floor(maskSize / 16)));
            const prefix = segments.slice(0, segmentCount).join(':');
            return `${prefix}::/${maskSize}`;
        }
        return normalized || null;
    }
    /**
     * Checks whether the request identifiers match any configured ignore list.
     * @internal
     */
    _isIgnored(context) {
        const ignore = this.config.ignore;
        if (!ignore)
            return false;
        if (context.ip && ignore.ips?.includes(context.ip))
            return true;
        if (context.userId && ignore.userIds?.includes(context.userId))
            return true;
        if (context.guildId && ignore.guildIds?.includes(context.guildId))
            return true;
        if (context.sessionId && ignore.sessionIds?.includes(context.sessionId))
            return true;
        const paths = ignore.paths ?? [];
        const isPathIgnored = paths.some((path) => context.pathname.startsWith(path));
        return isPathIgnored;
    }
    /**
     * Safely reads a header value as a string.
     * @internal
     */
    _getHeader(headers, name) {
        const raw = headers[name] ?? headers[name.toLowerCase()];
        const isArray = Array.isArray(raw);
        return isArray ? raw[0] : raw;
    }
    /**
     * Retrieves active players count for a session from nodelink sessions manager.
     * @internal
     */
    _resolveSessionPlayersCount(sessionId) {
        const session = this.nodelink.sessions?.get?.(sessionId);
        const playersCount = session?.players?.players?.size ?? 0;
        return playersCount;
    }
    /**
     * Updates EWMA rate for a session.
     * @internal
     */
    _updateSessionEwma(state, now) {
        const elapsedSeconds = (now - state.lastEwmaUpdate) / 1000;
        if (elapsedSeconds >= 1) {
            const instantRate = state.currentIntervalRequests / elapsedSeconds;
            const alpha = 0.15;
            state.ewmaRate = alpha * instantRate + (1 - alpha) * state.ewmaRate;
            state.currentIntervalRequests = 0;
            state.lastEwmaUpdate = now;
        }
        state.currentIntervalRequests += 1;
    }
    _getOrCreateGuildState(key, now) {
        const existing = this.guildStates.get(key);
        if (existing) {
            this.guildStates.delete(key);
            this.guildStates.set(key, existing);
            return existing;
        }
        if (this.guildStates.size >= this.config.guild.maxGuildStates) {
            this._evictOldestGuildStates(now);
        }
        const state = {
            tokens: this.config.guild.baseCapacity,
            lastRefill: now,
            score: 0,
            lastScoreUpdate: now,
            consecutiveViolations: 0,
            activeConcurrency: 0,
            quarantineUntil: 0,
            lastSeen: now,
            last429Timestamp: 0
        };
        this.guildStates.set(key, state);
        return state;
    }
    _getOrCreateSessionState(sessionId, now) {
        const existing = this.sessionStates.get(sessionId);
        if (existing) {
            return existing;
        }
        const state = {
            tokens: this.config.session.baseCapacity,
            lastRefill: now,
            score: 0,
            lastScoreUpdate: now,
            consecutiveViolations: 0,
            activePlayers: 0,
            playerCreates: 0,
            playerDestroys: 0,
            churnWindowReset: now,
            stablePlayersBaseline: 0,
            ewmaRate: 10,
            lastEwmaUpdate: now,
            currentIntervalRequests: 0,
            quarantineUntil: 0,
            lastSeen: now,
            lastResumeTimestamp: 0,
            resumeCount: 0,
            reconciliationWindowReset: now,
            reconciliationGrantsInWindow: 0,
            warmupUntil: 0,
            warmupChurnBudget: 0
        };
        this.sessionStates.set(sessionId, state);
        return state;
    }
    _getOrCreateIpState(ip, now) {
        const existing = this.ipStates.get(ip);
        if (existing) {
            return existing;
        }
        const state = {
            tokens: this.config.ip.baseCapacity,
            lastRefill: now,
            score: 0,
            lastScoreUpdate: now,
            consecutiveViolations: 0,
            activeSockets: 0,
            authFailures: 0,
            authWindowReset: now,
            ewmaRate: 20,
            lastEwmaUpdate: now,
            currentIntervalRequests: 0,
            blockedUntil: 0,
            lastSeen: now
        };
        this.ipStates.set(ip, state);
        return state;
    }
    /**
     * Broadcasts an IP block event to peer workers when running in Cluster mode.
     * @param ip - Normalized IP address.
     * @param durationMs - Block duration in milliseconds.
     * @internal
     */
    _broadcastIpBlock(ip, durationMs) {
        process.send?.({
            type: 'ipBlock',
            ip,
            durationMs
        });
    }
    /**
     * Checks whether a player exists for a given session and guild.
     * @param sessionId - Session identifier.
     * @param guildId - Guild identifier.
     * @internal
     */
    _isGuildPlayerRegistered(sessionId, guildId) {
        const session = this.nodelink.sessions?.get?.(sessionId);
        if (!session)
            return false;
        const player = session.players?.get?.(guildId);
        return player !== undefined;
    }
    /**
     * Evaluates server-wide global admission for heavy operations when no session context is present.
     * @internal
     */
    _evaluateGlobalLayer(context, now) {
        const state = this.globalState;
        const config = this.config.global;
        const baseCapacity = config.baseCapacity;
        const refillRate = config.refillRatePerSecond;
        this._applyScoreDecay(state, now, 15);
        const elapsedSeconds = Math.max(0, (now - state.lastRefill) / 1000);
        const replenished = state.tokens + elapsedSeconds * refillRate;
        state.tokens = Math.min(baseCapacity, Math.max(0, replenished));
        state.lastRefill = now;
        state.lastSeen = now;
        const cost = context.cost;
        const hasTokens = state.tokens >= cost;
        if (!hasTokens) {
            state.consecutiveViolations += 1;
            state.score += 1;
            const missingTokens = cost - state.tokens;
            const waitSeconds = Math.ceil(missingTokens / refillRate);
            return {
                allowed: false,
                action: 'limit',
                scope: 'operation',
                status: 429,
                message: 'Global operation rate limit exceeded. Please retry shortly.',
                retryAfterSeconds: Math.max(1, waitSeconds),
                remainingTokens: 0,
                capacityLimit: baseCapacity,
                resetTimestamp: Date.now() + waitSeconds * 1000
            };
        }
        state.tokens = Math.max(0, state.tokens - cost);
        const waitSeconds = Math.ceil((baseCapacity - state.tokens) / refillRate);
        return {
            allowed: true,
            action: 'allow',
            scope: 'operation',
            status: 200,
            message: 'OK',
            retryAfterSeconds: 0,
            remainingTokens: Math.floor(state.tokens),
            capacityLimit: baseCapacity,
            resetTimestamp: Date.now() + waitSeconds * 1000
        };
    }
    /**
     * Evicts least recently used idle guild admission states when capacity ceiling is met.
     * @param now - Monotonic timestamp.
     * @internal
     */
    _evictOldestGuildStates(now) {
        const targetEvictions = Math.max(1, Math.floor(this.config.guild.maxGuildStates * 0.05));
        let evictedCount = 0;
        for (const [key, state] of this.guildStates.entries()) {
            const isEligible = now > state.quarantineUntil && state.activeConcurrency === 0;
            if (isEligible) {
                this.guildStates.delete(key);
                evictedCount += 1;
                if (evictedCount >= targetEvictions) {
                    break;
                }
            }
        }
    }
    /**
     * Prunes idle states across guild, session, and ip stores.
     * @internal
     */
    _pruneExpiredStates() {
        const now = performance.now();
        const idleThreshold = 120000;
        for (const [key, state] of this.guildStates.entries()) {
            const isIdle = now - state.lastSeen > idleThreshold;
            const notQuarantined = now > state.quarantineUntil;
            const noConcurrency = state.activeConcurrency === 0;
            if (isIdle && notQuarantined && noConcurrency) {
                this.guildStates.delete(key);
            }
        }
        for (const [sessionId, state] of this.sessionStates.entries()) {
            const isIdle = now - state.lastSeen > idleThreshold;
            const notQuarantined = now > state.quarantineUntil;
            const isDead = !this._isSessionProven(sessionId);
            if ((isIdle || isDead) && notQuarantined) {
                this.sessionStates.delete(sessionId);
            }
        }
        for (const [ip, state] of this.ipStates.entries()) {
            const isIdle = now - state.lastSeen > idleThreshold * 2;
            const notBlocked = now > state.blockedUntil;
            const noSockets = state.activeSockets === 0;
            if (isIdle && notBlocked && noSockets) {
                this.ipStates.delete(ip);
            }
        }
    }
    _buildAllowedDecision(scope, remaining, limit) {
        return {
            allowed: true,
            action: 'allow',
            scope,
            status: 200,
            message: 'OK',
            retryAfterSeconds: 0,
            remainingTokens: remaining,
            capacityLimit: limit
        };
    }
    _mergeConfig(partial) {
        return {
            enabled: partial?.enabled ?? DEFAULT_CONFIG.enabled,
            trustProxy: partial?.trustProxy ?? DEFAULT_CONFIG.trustProxy,
            trustedProxies: partial?.trustedProxies ?? DEFAULT_CONFIG.trustedProxies,
            guild: {
                ...DEFAULT_CONFIG.guild,
                ...partial?.guild
            },
            session: {
                ...DEFAULT_CONFIG.session,
                ...partial?.session
            },
            global: {
                ...DEFAULT_CONFIG.global,
                ...partial?.global
            },
            ip: {
                ...DEFAULT_CONFIG.ip,
                ...partial?.ip,
                authProtection: {
                    ...DEFAULT_CONFIG.ip.authProtection,
                    ...partial?.ip?.authProtection
                }
            },
            operationCosts: {
                ...DEFAULT_CONFIG.operationCosts,
                ...partial?.operationCosts
            },
            ignore: {
                ips: partial?.ignore?.ips ?? [],
                userIds: partial?.ignore?.userIds ?? [],
                guildIds: partial?.ignore?.guildIds ?? [],
                sessionIds: partial?.ignore?.sessionIds ?? [],
                paths: partial?.ignore?.paths ?? []
            }
        };
    }
}
