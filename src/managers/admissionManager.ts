import type {
  AdmissionConfig,
  AdmissionContext,
  AdmissionDecision,
  AdmissionOperation,
  AdmissionResourceType,
  AdmissionScope,
  GuildAdmissionState,
  IpAdmissionState,
  SessionAdmissionState
} from '../typings/admission/admission.types.ts'
import type { ApiRequest } from '../typings/api/api.types.ts'
import { logger } from '../utils.ts'

type NodelinkServerLike = import('../index.ts').default

const DEFAULT_CONFIG: AdmissionConfig = {
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
  ip: {
    baseCapacity: 500,
    refillRatePerSecond: 100,
    maxConcurrentSockets: 25,
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
}

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
  private readonly nodelink: NodelinkServerLike
  public readonly config: AdmissionConfig

  private readonly guildStates: Map<string, GuildAdmissionState>
  private readonly sessionStates: Map<string, SessionAdmissionState>
  private readonly ipStates: Map<string, IpAdmissionState>

  private readonly cleanupInterval: NodeJS.Timeout

  constructor(nodelink: NodelinkServerLike, config?: Partial<AdmissionConfig>) {
    this.nodelink = nodelink
    this.config = this._mergeConfig(config)

    this.guildStates = new Map()
    this.sessionStates = new Map()
    this.ipStates = new Map()

    this.cleanupInterval = setInterval(() => {
      this._pruneExpiredStates()
    }, 15000)
    this.cleanupInterval?.unref?.()
  }

  /**
   * Resolves the complete semantic admission context from an incoming request.
   * @param req - Raw or shimmed API request.
   * @param parsedUrl - Parsed URL instance.
   * @param body - Optional pre-parsed JSON body.
   */
  resolveContext(
    req: ApiRequest,
    parsedUrl: URL,
    body?: unknown
  ): AdmissionContext {
    const pathname = parsedUrl.pathname ?? '/'
    const method = (req.method ?? 'GET').toUpperCase()

    const ip = this._resolveIp(req)
    const sessionId = this._extractSessionId(pathname, req.headers)
    const guildId = this._extractGuildId(pathname)
    const userId = this._getHeader(req.headers, 'user-id') ?? null

    const transport = this._resolveTransport(req, pathname)
    const operation = this._classifyOperation(method, pathname, body)
    const cost = this._resolveCost(operation)
    const resource = this._classifyResource(operation)
    const authenticated = this._checkAuth(req.headers)

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
    }
  }

  /**
   * Evaluates admission across L3 IP -> L2 Session -> L1 Guild.
   * Applies the blast radius containment principle: isolates issues at the lowest possible layer.
   * @param context - Resolved request admission context.
   */
  admit(context: AdmissionContext): AdmissionDecision {
    const isEnabled = this.config.enabled
    if (!isEnabled) {
      return this._buildAllowedDecision('ip', 100, 100)
    }

    const isBypassed = this._isIgnored(context)
    if (isBypassed) {
      return this._buildAllowedDecision('ip', 100, 100)
    }

    const now = performance.now()
    let lastDecision: AdmissionDecision | null = null

    if (context.ip) {
      const ipDecision = this._evaluateIpLayer(context.ip, context, now)
      const ipBlocked = !ipDecision.allowed
      if (ipBlocked) {
        return ipDecision
      }
      lastDecision = ipDecision
    }

    if (context.sessionId) {
      const sessionDecision = this._evaluateSessionLayer(
        context.sessionId,
        context,
        now
      )
      const sessionBlocked = !sessionDecision.allowed
      if (sessionBlocked) {
        return sessionDecision
      }
      lastDecision = sessionDecision
    }

    if (context.guildId && context.sessionId) {
      const guildDecision = this._evaluateGuildLayer(
        context.sessionId,
        context.guildId,
        context,
        now
      )
      const guildBlocked = !guildDecision.allowed
      if (guildBlocked) {
        return guildDecision
      }

      return guildDecision
    }

    if (lastDecision) {
      return lastDecision
    }

    return this._buildAllowedDecision('ip', 100, 100)
  }

  /**
   * Tracks an incoming TCP socket. Returns false if IP connection pool is exhausted.
   * @param rawAddress - Remote IP address.
   */
  incrementActiveSockets(rawAddress?: string | null): boolean {
    const ip = this._normalizeIp(rawAddress)
    if (!ip) return true

    const state = this._getOrCreateIpState(ip, performance.now())
    const maxSockets = this.config.ip.maxConcurrentSockets
    const isExhausted = state.activeSockets >= maxSockets

    if (isExhausted) {
      logger(
        'warn',
        'AdmissionManager',
        `IP ${ip} exceeded concurrent socket pool (${state.activeSockets}/${maxSockets}). Dropping connection.`
      )
      return false
    }

    state.activeSockets += 1
    return true
  }

  /**
   * Decrements active TCP socket count for an IP.
   * @param rawAddress - Remote IP address.
   */
  decrementActiveSockets(rawAddress?: string | null): void {
    const ip = this._normalizeIp(rawAddress)
    if (!ip) return

    const state = this.ipStates.get(ip)
    if (!state) return

    state.activeSockets = Math.max(0, state.activeSockets - 1)
  }

  /**
   * Records a failed authentication attempt and blocks IP if threshold is breached.
   * @param rawAddress - Remote IP address.
   */
  recordAuthFailure(rawAddress?: string | null): boolean {
    const authConfig = this.config.ip.authProtection
    const isEnabled = authConfig.enabled
    if (!isEnabled) return false

    const ip = this._normalizeIp(rawAddress)
    if (!ip) return false

    const now = performance.now()
    const state = this._getOrCreateIpState(ip, now)

    const isWindowExpired = now - state.authWindowReset > authConfig.windowMs
    if (isWindowExpired) {
      state.authFailures = 0
      state.authWindowReset = now
    }

    state.authFailures += 1

    const isBreached = state.authFailures >= authConfig.maxFailures
    if (isBreached) {
      state.blockedUntil = now + authConfig.banDurationMs
      logger(
        'warn',
        'AdmissionManager',
        `IP ${ip} jailed for brute force password attempts (${state.authFailures}/${authConfig.maxFailures}) for ${authConfig.banDurationMs}ms.`
      )
      this._broadcastIpBlock(ip, authConfig.banDurationMs)
      return true
    }

    return false
  }

  /**
   * Checks whether an IP is currently blocked or jailed.
   * @param rawAddress - Remote IP address.
   */
  isIpBlocked(rawAddress?: string | null): boolean {
    const ip = this._normalizeIp(rawAddress)
    if (!ip) return false

    const state = this.ipStates.get(ip)
    if (!state) return false

    const now = performance.now()
    const isBlocked = now < state.blockedUntil
    return isBlocked
  }

  /**
   * Manually blocks an IP for a specified duration.
   * @param rawAddress - Remote IP address.
   * @param durationMs - Duration in milliseconds.
   * @param broadcast - Whether to sync across cluster workers.
   */
  blockIp(
    rawAddress: string,
    durationMs: number,
    broadcast: boolean = false
  ): void {
    const ip = this._normalizeIp(rawAddress)
    if (!ip) return

    const now = performance.now()
    const state = this._getOrCreateIpState(ip, now)
    state.blockedUntil = now + durationMs

    if (broadcast) {
      this._broadcastIpBlock(ip, durationMs)
    }
  }

  /**
   * Records player creation in a session for churn tracking.
   * @param sessionId - Session identifier.
   */
  recordPlayerCreate(sessionId: string): void {
    const state = this.sessionStates.get(sessionId)
    if (!state) return

    state.playerCreates += 1
    state.activePlayers += 1
  }

  /**
   * Records player destruction in a session for churn tracking.
   * @param sessionId - Session identifier.
   */
  recordPlayerDestroy(sessionId: string): void {
    const state = this.sessionStates.get(sessionId)
    if (!state) return

    state.playerDestroys += 1
    state.activePlayers = Math.max(0, state.activePlayers - 1)
  }

  /**
   * Records a session resume event, computing reconciliation budget and organic headroom.
   * Enforces anti-flapping protection to avoid exploitation of the reconnection credit.
   *
   * @param sessionId - Restored session identifier.
   */
  recordSessionResume(sessionId: string): void {
    const now = performance.now()
    const state = this._getOrCreateSessionState(sessionId, now)
    const config = this.config.session

    const hasPreviousResume = state.lastResumeTimestamp > 0
    const elapsedSinceLastResume = now - state.lastResumeTimestamp
    const isFlapping =
      hasPreviousResume && elapsedSinceLastResume < config.flappingThresholdMs

    if (isFlapping) {
      state.score += 5
      logger(
        'warn',
        'AdmissionManager',
        `Session ${sessionId} flagged for connection flapping (${Math.round(elapsedSinceLastResume)}ms since previous resume). Credit denied.`
      )
      return
    }

    state.lastResumeTimestamp = now
    state.resumeCount += 1

    const windowElapsed = now - state.reconciliationWindowReset
    if (windowElapsed > config.reconciliationWindowMs) {
      state.reconciliationGrantsInWindow = 0
      state.reconciliationWindowReset = now
    }

    const hasQuota =
      state.reconciliationGrantsInWindow < config.maxReconciliationsPerWindow

    const existingPlayers = this._resolveSessionPlayersCount(sessionId)
    const organicHeadroom = Math.max(
      config.organicGrowthFloor,
      Math.round(existingPlayers * config.organicGrowthFactor)
    )

    const adaptiveCapacity = Math.max(
      config.baseCapacity,
      Math.round(
        config.baseCapacity + existingPlayers * config.tokensPerActivePlayer
      )
    )

    if (hasQuota) {
      state.reconciliationGrantsInWindow += 1

      const targetTokens = Math.round(
        existingPlayers * config.reconciliationMultiplier + organicHeadroom
      )

      state.tokens = Math.min(
        adaptiveCapacity,
        Math.max(state.tokens, targetTokens)
      )
      state.warmupUntil = now + config.warmupDurationMs
      state.warmupChurnBudget = existingPlayers + organicHeadroom

      logger(
        'info',
        'AdmissionManager',
        `Session ${sessionId} resumed with ${existingPlayers} active players. Top-up target: ${targetTokens} tokens (headroom: ${organicHeadroom}). Warmup active for ${config.warmupDurationMs}ms.`
      )
    } else {
      logger(
        'warn',
        'AdmissionManager',
        `Session ${sessionId} reached reconciliation grant quota (${state.reconciliationGrantsInWindow}/${config.maxReconciliationsPerWindow}) for current window. Operating with natural refill.`
      )
    }
  }

  /**
   * Initializes admission state when a new session connects.
   *
   * @param sessionId - New session identifier.
   */
  recordSessionConnect(sessionId: string): void {
    const now = performance.now()
    const state = this._getOrCreateSessionState(sessionId, now)
    state.lastSeen = now
  }

  /**
   * Destroys resources and intervals upon shutdown.
   */
  destroy(): void {
    clearInterval(this.cleanupInterval)
    this.guildStates.clear()
    this.sessionStates.clear()
    this.ipStates.clear()
  }

  /**
   * Evaluates L1 Guild Execution Layer (and L0 Concurrency).
   * @internal
   */
  private _evaluateGuildLayer(
    sessionId: string,
    guildId: string,
    context: AdmissionContext,
    now: number
  ): AdmissionDecision {
    const isExecutionOperation = context.operation.startsWith('PLAYER_')
    const isReadOnly = context.operation === 'PLAYER_GET'
    const isRegistered = this._isGuildPlayerRegistered(sessionId, guildId)
    const key = `${sessionId}:${guildId}`
    const existing = this.guildStates.get(key)

    if (!existing && !isRegistered && isReadOnly) {
      return this._buildAllowedDecision(
        'guild',
        this.config.guild.baseCapacity,
        this.config.guild.baseCapacity
      )
    }

    const state = this._getOrCreateGuildState(key, now)
    const config = this.config.guild

    this._applyScoreDecay(state, now, config.scoreDecayHalfLifeSeconds)

    const isInQuarantine = now < state.quarantineUntil
    if (isInQuarantine) {
      const remainingMs = state.quarantineUntil - now
      const retryAfter = Math.ceil(remainingMs / 1000)

      return {
        allowed: false,
        action: 'quarantine',
        scope: 'guild',
        status: 429,
        message: `Guild ${guildId} player is quarantined due to excessive command abuse.`,
        retryAfterSeconds: Math.max(1, retryAfter)
      }
    }

    const hasRecovered = state.score <= config.quarantineRecoveryThreshold
    if (hasRecovered && state.quarantineUntil > 0) {
      state.quarantineUntil = 0
      state.consecutiveViolations = 0
    }

    const hasHighConcurrency =
      isExecutionOperation && state.activeConcurrency >= config.maxConcurrency

    if (hasHighConcurrency) {
      state.score += 2
      return {
        allowed: false,
        action: 'limit',
        scope: 'operation',
        status: 429,
        message: `Guild ${guildId} player concurrency limit reached (${state.activeConcurrency}/${config.maxConcurrency}). Wait for previous action to finish.`,
        retryAfterSeconds: 1
      }
    }

    const elapsedSeconds = Math.max(0, (now - state.lastRefill) / 1000)
    const replenished =
      state.tokens + elapsedSeconds * config.refillRatePerSecond
    const capacity = config.baseCapacity
    state.tokens = Math.min(capacity, Math.max(0, replenished))
    state.lastRefill = now
    state.lastSeen = now

    const cost = context.cost
    const hasTokens = state.tokens >= cost

    if (!hasTokens) {
      state.consecutiveViolations += 1

      const isRetryStorm = now - state.last429Timestamp < 250
      state.last429Timestamp = now

      if (isRetryStorm) {
        state.score += 3
      } else {
        state.score += 1
      }

      const shouldQuarantine = state.score >= config.quarantineScoreThreshold
      if (shouldQuarantine) {
        state.quarantineUntil = now + config.quarantineDurationMs
        logger(
          'warn',
          'AdmissionManager',
          `Guild ${guildId} placed in quarantine for ${config.quarantineDurationMs}ms (score: ${state.score.toFixed(1)}).`
        )

        this._escalateToSession(sessionId, 4)
      }

      const missingTokens = cost - state.tokens
      const waitSeconds = Math.ceil(missingTokens / config.refillRatePerSecond)

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
      }
    }

    state.tokens = Math.max(0, state.tokens - cost)
    state.consecutiveViolations = 0

    if (isExecutionOperation) {
      state.activeConcurrency += 1
    }

    const releaseConcurrency = isExecutionOperation
      ? () => {
          state.activeConcurrency = Math.max(0, state.activeConcurrency - 1)
        }
      : undefined

    const waitSeconds = Math.ceil(
      (capacity - state.tokens) / config.refillRatePerSecond
    )

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
    }
  }

  /**
   * Evaluates L2 Session Context Layer.
   * @internal
   */
  private _evaluateSessionLayer(
    sessionId: string,
    context: AdmissionContext,
    now: number
  ): AdmissionDecision {
    const state = this._getOrCreateSessionState(sessionId, now)
    const config = this.config.session

    const halfLife = 12
    this._applyScoreDecay(state, now, halfLife)

    const isQuarantined = now < state.quarantineUntil
    if (isQuarantined) {
      const remainingMs = state.quarantineUntil - now
      const retryAfter = Math.ceil(remainingMs / 1000)

      return {
        allowed: false,
        action: 'quarantine',
        scope: 'session',
        status: 429,
        message: `Session ${sessionId} is in quarantine due to sustained aggregate pressure.`,
        retryAfterSeconds: Math.max(1, retryAfter)
      }
    }

    const churnWindowMs = 60000
    const isChurnWindowExpired = now - state.churnWindowReset > churnWindowMs
    const activePlayersCount = this._resolveSessionPlayersCount(sessionId)
    state.activePlayers = activePlayersCount

    if (isChurnWindowExpired) {
      state.playerCreates = 0
      state.playerDestroys = 0
      state.churnWindowReset = now
      state.stablePlayersBaseline = activePlayersCount
    }

    const isWarmup = now < state.warmupUntil
    const effectiveChurnLimit = isWarmup
      ? config.maxPlayerChurnPerMinute + state.warmupChurnBudget
      : config.maxPlayerChurnPerMinute

    const totalChurn = state.playerCreates + state.playerDestroys
    const isChurnAbusive = totalChurn > effectiveChurnLimit
    let effectivePlayerCount = activePlayersCount

    if (isChurnAbusive) {
      state.score += 5
      effectivePlayerCount = Math.min(
        activePlayersCount,
        state.stablePlayersBaseline
      )
      logger(
        'warn',
        'AdmissionManager',
        `Session ${sessionId} exceeded player churn threshold (${totalChurn}/${effectiveChurnLimit}). Capacity expansion dampened.`
      )
    } else {
      state.stablePlayersBaseline = activePlayersCount
    }

    const adaptiveCapacity = Math.max(
      config.baseCapacity,
      Math.round(
        config.baseCapacity +
          effectivePlayerCount * config.tokensPerActivePlayer
      )
    )

    const adaptiveRefillRate = Math.max(
      config.refillRatePerSecond,
      config.refillRatePerSecond +
        effectivePlayerCount * config.refillRatePerPlayerPerSecond
    )

    const elapsedSeconds = Math.max(0, (now - state.lastRefill) / 1000)
    const replenished = state.tokens + elapsedSeconds * adaptiveRefillRate
    state.tokens = Math.min(adaptiveCapacity, Math.max(0, replenished))
    state.lastRefill = now
    state.lastSeen = now

    this._updateSessionEwma(state, now)

    const cost = context.cost
    const hasTokens = state.tokens >= cost

    if (!hasTokens) {
      state.consecutiveViolations += 1
      state.score += 2

      const isBreached = state.score >= config.quarantineScoreThreshold
      if (isBreached) {
        state.quarantineUntil = now + config.quarantineDurationMs
        logger(
          'warn',
          'AdmissionManager',
          `Session ${sessionId} placed in quarantine for ${config.quarantineDurationMs}ms.`
        )

        if (context.ip) {
          this._escalateToIp(context.ip, 6)
        }
      }

      const missingTokens = cost - state.tokens
      const waitSeconds = Math.ceil(missingTokens / adaptiveRefillRate)

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
      }
    }

    state.tokens = Math.max(0, state.tokens - cost)
    const waitSeconds = Math.ceil(
      (adaptiveCapacity - state.tokens) / adaptiveRefillRate
    )

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
    }
  }

  /**
   * Evaluates L3 IP Edge Layer.
   * @internal
   */
  private _evaluateIpLayer(
    ip: string,
    context: AdmissionContext,
    now: number
  ): AdmissionDecision {
    const state = this._getOrCreateIpState(ip, now)
    const config = this.config.ip

    const isBlocked = now < state.blockedUntil
    if (isBlocked) {
      const remainingMs = state.blockedUntil - now
      const retryAfter = Math.ceil(remainingMs / 1000)

      return {
        allowed: false,
        action: 'drop',
        scope: 'ip',
        status: 403,
        message: 'Forbidden: IP address is temporarily blocked.',
        retryAfterSeconds: Math.max(1, retryAfter)
      }
    }

    const halfLife = 20
    this._applyScoreDecay(state, now, halfLife)

    const capacity = config.baseCapacity
    const elapsedSeconds = Math.max(0, (now - state.lastRefill) / 1000)
    const replenished =
      state.tokens + elapsedSeconds * config.refillRatePerSecond
    state.tokens = Math.min(capacity, Math.max(0, replenished))
    state.lastRefill = now
    state.lastSeen = now

    const effectiveCost = context.authenticated ? 1 : context.cost
    const hasTokens = state.tokens >= effectiveCost

    if (!hasTokens) {
      state.consecutiveViolations += 1
      state.score += 2

      const shouldBlock = state.score >= config.blockScoreThreshold
      if (shouldBlock) {
        state.blockedUntil = now + config.blockDurationMs
        logger(
          'warn',
          'AdmissionManager',
          `IP ${ip} temporarily blocked for ${config.blockDurationMs}ms (score: ${state.score.toFixed(1)}).`
        )
        this._broadcastIpBlock(ip, config.blockDurationMs)
      }

      const missingTokens = effectiveCost - state.tokens
      const waitSeconds = Math.ceil(missingTokens / config.refillRatePerSecond)

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
      }
    }

    state.tokens = Math.max(0, state.tokens - effectiveCost)
    const waitSeconds = Math.ceil(
      (capacity - state.tokens) / config.refillRatePerSecond
    )

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
    }
  }

  /**
   * Applies continuous exponential decay to strike scores: S(t) = S(t0) * 0.5^(dt / halfLife)
   * @internal
   */
  private _applyScoreDecay(
    state: { score: number; lastScoreUpdate: number },
    now: number,
    halfLifeSeconds: number
  ): void {
    const elapsedSeconds = Math.max(0, (now - state.lastScoreUpdate) / 1000)
    if (elapsedSeconds <= 0) return

    const decayFactor = 0.5 ** (elapsedSeconds / halfLifeSeconds)
    state.score *= decayFactor
    state.lastScoreUpdate = now
  }

  /**
   * Escalates child guild strike signal to parent session.
   * @internal
   */
  private _escalateToSession(sessionId: string, strikePoints: number): void {
    const state = this.sessionStates.get(sessionId)
    if (!state) return

    state.score += strikePoints
  }

  /**
   * Escalates session strike signal to IP.
   * @internal
   */
  private _escalateToIp(ip: string, strikePoints: number): void {
    const state = this.ipStates.get(ip)
    if (!state) return

    state.score += strikePoints
  }

  /**
   * Classifies request into a granular AdmissionOperation.
   * @internal
   */
  private _classifyOperation(
    method: string,
    pathname: string,
    body?: unknown
  ): AdmissionOperation {
    const hasPlayerInPath = pathname.includes('/players/')
    if (hasPlayerInPath) {
      switch (method) {
        case 'DELETE':
          return 'PLAYER_DESTROY'
        case 'GET':
          return 'PLAYER_GET'
        case 'PATCH':
          return this._classifyPlayerPatchOperation(body)
        default:
          return 'GENERIC_REST'
      }
    }

    const segments = pathname.split('/')
    const primary = segments[2] ?? segments[1] ?? ''

    switch (primary) {
      case 'loadtracks':
        return 'LOAD_TRACKS'
      case 'loadstream':
        return 'LOAD_STREAM'
      case 'loadlyrics':
        return 'LOAD_LYRICS'
      case 'meaning':
        return 'AI_MEANING'
      case 'decodetrack':
      case 'decodetracks':
        return 'DECODE_TRACK'
      case 'encodetrack':
      case 'encodetracks':
        return 'ENCODE_TRACK'
      case 'websocket':
        return 'SESSION_UPGRADE'
      case 'sessions':
        return this._classifySessionOperation(pathname, method)
      case 'info':
      case 'version':
      case 'stats':
        return 'METADATA_GET'
      default:
        return 'GENERIC_REST'
    }
  }

  /**
   * Distinguishes player patch sub-actions based on payload body fields.
   * @internal
   */
  private _classifyPlayerPatchOperation(body: unknown): AdmissionOperation {
    if (!body || typeof body !== 'object') return 'PLAYER_PLAY'

    const payload = body as Record<string, unknown>

    if (payload.filters !== undefined) return 'PLAYER_FILTERS'
    if (payload.position !== undefined) return 'PLAYER_SEEK'
    if (payload.voice !== undefined) return 'PLAYER_VOICE'
    if (payload.paused !== undefined) return 'PLAYER_PAUSE'
    if (payload.volume !== undefined) return 'PLAYER_VOLUME'
    if (payload.track !== undefined) return 'PLAYER_PLAY'

    return 'PLAYER_PLAY'
  }

  /**
   * Distinguishes session-level operations.
   * @internal
   */
  private _classifySessionOperation(
    pathname: string,
    method: string
  ): AdmissionOperation {
    const isPlayersList = pathname.endsWith('/players') && method === 'GET'
    if (isPlayersList) return 'SESSION_PLAYERS_LIST'

    const isGroups = pathname.includes('/groups')
    if (isGroups) return 'GROUPS_OP'

    return 'SESSION_UPDATE'
  }

  /**
   * Maps operation to primary impacted resource category.
   * @internal
   */
  private _classifyResource(
    operation: AdmissionOperation
  ): AdmissionResourceType {
    switch (operation) {
      case 'PLAYER_PLAY':
      case 'DECODE_TRACK':
        return 'decoder'
      case 'PLAYER_FILTERS':
        return 'dsp_filters'
      case 'PLAYER_SEEK':
      case 'PLAYER_STOP':
      case 'PLAYER_PAUSE':
      case 'PLAYER_VOLUME':
      case 'PLAYER_VOICE':
      case 'PLAYER_DESTROY':
        return 'audio_pipeline'
      case 'LOAD_TRACKS':
      case 'LOAD_STREAM':
      case 'LOAD_LYRICS':
      case 'AI_MEANING':
        return 'external_source'
      case 'SESSION_UPGRADE':
      case 'SESSION_UPDATE':
      case 'SESSION_PLAYERS_LIST':
        return 'session_pool'
      default:
        return 'metadata'
    }
  }

  /**
   * Resolves computational cost for the operation.
   * @internal
   */
  private _resolveCost(operation: AdmissionOperation): number {
    const customCost = this.config.operationCosts?.[operation]
    if (customCost !== undefined) {
      return customCost
    }

    const defaultCost = DEFAULT_CONFIG.operationCosts?.[operation]
    return defaultCost ?? 1
  }

  /**
   * Resolves transport mode.
   * @internal
   */
  private _resolveTransport(
    req: ApiRequest,
    pathname: string
  ): 'http' | 'ws-upgrade' | 'ws-message' {
    const isUpgrade =
      req.headers.upgrade === 'websocket' || pathname.endsWith('/websocket')
    return isUpgrade ? 'ws-upgrade' : 'http'
  }

  /**
   * Validates authorization header against server password.
   * @internal
   */
  private _checkAuth(headers: ApiRequest['headers']): boolean {
    const authHeader = this._getHeader(headers, 'authorization')
    const serverPassword = this.nodelink.options.server?.password
    if (!serverPassword) return true

    const isValid =
      authHeader === serverPassword || authHeader === `Bearer ${serverPassword}`
    return isValid
  }

  /**
   * Extracts session identifier from URL pathname or headers.
   * @internal
   */
  private _extractSessionId(
    pathname: string,
    headers: ApiRequest['headers']
  ): string | null {
    const match = pathname.match(/\/sessions\/([a-zA-Z0-9_-]+)/)
    if (match?.[1]) {
      return match[1]
    }

    const headerSessionId = this._getHeader(headers, 'session-id')
    return headerSessionId ?? null
  }

  /**
   * Extracts guild identifier from URL pathname.
   * @internal
   */
  private _extractGuildId(pathname: string): string | null {
    const match = pathname.match(/\/players\/([0-9]+)/)
    return match?.[1] ?? null
  }

  /**
   * Resolves remote IP with edge proxy header precedence.
   * @internal
   */
  private _resolveIp(req: ApiRequest): string | null {
    const socketAddress = req.socket?.remoteAddress

    const trustProxyEnabled = this.config.trustProxy === true
    if (!trustProxyEnabled) {
      return this._normalizeIp(socketAddress)
    }

    const headers = req.headers
    const cfConnectingIp = this._getHeader(headers, 'cf-connecting-ip')
    const trueClientIp = this._getHeader(headers, 'true-client-ip')
    const xRealIp = this._getHeader(headers, 'x-real-ip')
    const forwardedFor = this._getHeader(headers, 'x-forwarded-for')

    const candidate =
      cfConnectingIp ??
      trueClientIp ??
      xRealIp ??
      forwardedFor?.split(',')?.[0]?.trim() ??
      socketAddress

    return this._normalizeIp(candidate)
  }

  /**
   * Normalizes IP and applies IPv6 /64 subnet mask.
   * @internal
   */
  private _normalizeIp(ip?: string | null): string | null {
    if (!ip) return null
    let normalized = ip.trim()
    if (!normalized) return null

    const hasIpv4Mapped = normalized.startsWith('::ffff:')
    if (hasIpv4Mapped) {
      normalized = normalized.slice(7)
    }

    const hasBrackets = normalized.startsWith('[') && normalized.endsWith(']')
    if (hasBrackets) {
      normalized = normalized.slice(1, -1)
    }

    const isIpv6 = normalized.includes(':')
    if (isIpv6) {
      const segments = normalized.split(':')
      const maskSize = this.config.ip.ipv6SubnetMask ?? 64
      const segmentCount = Math.min(8, Math.max(1, Math.floor(maskSize / 16)))
      const prefix = segments.slice(0, segmentCount).join(':')
      return `${prefix}::/${maskSize}`
    }

    return normalized || null
  }

  /**
   * Checks whether the request identifiers match any configured ignore list.
   * @internal
   */
  private _isIgnored(context: AdmissionContext): boolean {
    const ignore = this.config.ignore
    if (!ignore) return false

    if (context.ip && ignore.ips?.includes(context.ip)) return true
    if (context.userId && ignore.userIds?.includes(context.userId)) return true
    if (context.guildId && ignore.guildIds?.includes(context.guildId))
      return true
    if (context.sessionId && ignore.sessionIds?.includes(context.sessionId))
      return true

    const paths = ignore.paths ?? []
    const isPathIgnored = paths.some((path) =>
      context.pathname.startsWith(path)
    )
    return isPathIgnored
  }

  /**
   * Safely reads a header value as a string.
   * @internal
   */
  private _getHeader(
    headers: ApiRequest['headers'],
    name: string
  ): string | undefined {
    const raw = headers[name] ?? headers[name.toLowerCase()]
    const isArray = Array.isArray(raw)
    return isArray ? raw[0] : raw
  }

  /**
   * Retrieves active players count for a session from nodelink sessions manager.
   * @internal
   */
  private _resolveSessionPlayersCount(sessionId: string): number {
    const session = this.nodelink.sessions?.get?.(sessionId)
    const playersCount = session?.players?.players?.size ?? 0
    return playersCount
  }

  /**
   * Updates EWMA rate for a session.
   * @internal
   */
  private _updateSessionEwma(state: SessionAdmissionState, now: number): void {
    const elapsedSeconds = (now - state.lastEwmaUpdate) / 1000
    if (elapsedSeconds >= 1) {
      const instantRate = state.currentIntervalRequests / elapsedSeconds
      const alpha = 0.15
      state.ewmaRate = alpha * instantRate + (1 - alpha) * state.ewmaRate
      state.currentIntervalRequests = 0
      state.lastEwmaUpdate = now
    }

    state.currentIntervalRequests += 1
  }

  private _getOrCreateGuildState(
    key: string,
    now: number
  ): GuildAdmissionState {
    const existing = this.guildStates.get(key)
    if (existing) {
      this.guildStates.delete(key)
      this.guildStates.set(key, existing)
      return existing
    }

    if (this.guildStates.size >= this.config.guild.maxGuildStates) {
      this._evictOldestGuildStates(now)
    }

    const state: GuildAdmissionState = {
      tokens: this.config.guild.baseCapacity,
      lastRefill: now,
      score: 0,
      lastScoreUpdate: now,
      consecutiveViolations: 0,
      activeConcurrency: 0,
      quarantineUntil: 0,
      lastSeen: now,
      last429Timestamp: 0
    }
    this.guildStates.set(key, state)
    return state
  }

  private _getOrCreateSessionState(
    sessionId: string,
    now: number
  ): SessionAdmissionState {
    const existing = this.sessionStates.get(sessionId)
    if (existing) {
      return existing
    }

    const state: SessionAdmissionState = {
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
    }
    this.sessionStates.set(sessionId, state)
    return state
  }

  private _getOrCreateIpState(ip: string, now: number): IpAdmissionState {
    const existing = this.ipStates.get(ip)
    if (existing) {
      return existing
    }

    const state: IpAdmissionState = {
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
    }
    this.ipStates.set(ip, state)
    return state
  }

  /**
   * Broadcasts an IP block event to peer workers when running in Cluster mode.
   * @param ip - Normalized IP address.
   * @param durationMs - Block duration in milliseconds.
   * @internal
   */
  private _broadcastIpBlock(ip: string, durationMs: number): void {
    process.send?.({
      type: 'ipBlock',
      ip,
      durationMs
    })
  }

  /**
   * Checks whether a player exists for a given session and guild.
   * @param sessionId - Session identifier.
   * @param guildId - Guild identifier.
   * @internal
   */
  private _isGuildPlayerRegistered(
    sessionId: string,
    guildId: string
  ): boolean {
    const session = this.nodelink.sessions?.get?.(sessionId)
    if (!session) return false
    const player = session.players?.get?.(guildId)
    return player !== undefined
  }

  /**
   * Evicts least recently used idle guild admission states when capacity ceiling is met.
   * @param now - Monotonic timestamp.
   * @internal
   */
  private _evictOldestGuildStates(now: number): void {
    const targetEvictions = Math.max(
      1,
      Math.floor(this.config.guild.maxGuildStates * 0.05)
    )
    let evictedCount = 0

    for (const [key, state] of this.guildStates.entries()) {
      const isEligible =
        now > state.quarantineUntil && state.activeConcurrency === 0

      if (isEligible) {
        this.guildStates.delete(key)
        evictedCount += 1
        if (evictedCount >= targetEvictions) {
          break
        }
      }
    }
  }

  /**
   * Prunes idle states across guild, session, and ip stores.
   * @internal
   */
  private _pruneExpiredStates(): void {
    const now = performance.now()
    const idleThreshold = 120000

    for (const [key, state] of this.guildStates.entries()) {
      const isIdle = now - state.lastSeen > idleThreshold
      const notQuarantined = now > state.quarantineUntil
      const noConcurrency = state.activeConcurrency === 0

      if (isIdle && notQuarantined && noConcurrency) {
        this.guildStates.delete(key)
      }
    }

    for (const [sessionId, state] of this.sessionStates.entries()) {
      const isIdle = now - state.lastSeen > idleThreshold
      const notQuarantined = now > state.quarantineUntil

      if (isIdle && notQuarantined) {
        this.sessionStates.delete(sessionId)
      }
    }

    for (const [ip, state] of this.ipStates.entries()) {
      const isIdle = now - state.lastSeen > idleThreshold * 2
      const notBlocked = now > state.blockedUntil
      const noSockets = state.activeSockets === 0

      if (isIdle && notBlocked && noSockets) {
        this.ipStates.delete(ip)
      }
    }
  }

  private _buildAllowedDecision(
    scope: AdmissionScope,
    remaining: number,
    limit: number
  ): AdmissionDecision {
    return {
      allowed: true,
      action: 'allow',
      scope,
      status: 200,
      message: 'OK',
      retryAfterSeconds: 0,
      remainingTokens: remaining,
      capacityLimit: limit
    }
  }

  private _mergeConfig(partial?: Partial<AdmissionConfig>): AdmissionConfig {
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
    }
  }
}
