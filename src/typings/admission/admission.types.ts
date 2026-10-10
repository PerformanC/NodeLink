/**
 * Granular admission operations recognized by the engine.
 * @public
 */
export type AdmissionOperation =
  | 'PLAYER_PLAY'
  | 'PLAYER_STOP'
  | 'PLAYER_PAUSE'
  | 'PLAYER_SEEK'
  | 'PLAYER_VOLUME'
  | 'PLAYER_FILTERS'
  | 'PLAYER_VOICE'
  | 'PLAYER_GET'
  | 'PLAYER_DESTROY'
  | 'LOAD_TRACKS'
  | 'LOAD_STREAM'
  | 'LOAD_LYRICS'
  | 'DECODE_TRACK'
  | 'ENCODE_TRACK'
  | 'AI_MEANING'
  | 'SESSION_UPGRADE'
  | 'SESSION_UPDATE'
  | 'SESSION_PLAYERS_LIST'
  | 'GROUPS_OP'
  | 'METADATA_GET'
  | 'GENERIC_REST'

/**
 * System resource categories impacted by operations.
 * @public
 */
export type AdmissionResourceType =
  | 'audio_pipeline'
  | 'decoder'
  | 'dsp_filters'
  | 'external_source'
  | 'session_pool'
  | 'network_io'
  | 'metadata'

/**
 * Hierarchical protection scopes:
 * - 'operation': L0 immediate concurrency guard
 * - 'guild': L1 execution layer (audio pipeline, player state)
 * - 'session': L2 context layer (shard, aggregate of guilds)
 * - 'ip': L3 edge layer (TCP, network, auth brute force)
 * @public
 */
export type AdmissionScope = 'operation' | 'guild' | 'session' | 'ip'

/**
 * Enforcement actions returned by the admission manager.
 * @public
 */
export type AdmissionAction = 'allow' | 'limit' | 'quarantine' | 'drop'

/**
 * Complete admission context resolved from an incoming request.
 * @public
 */
export interface AdmissionContext {
  /** Resolved client IP address. */
  ip: string | null

  /** Session identifier (from URL path or header). */
  sessionId: string | null

  /** Guild identifier (from URL path or body). */
  guildId: string | null

  /** User identifier header. */
  userId: string | null

  /** Transport type. */
  transport: 'http' | 'ws-upgrade' | 'ws-message'

  /** Classified operation. */
  operation: AdmissionOperation

  /** Normalized computational cost for this operation. */
  cost: number

  /** Primary hardware/runtime resource category affected. */
  resource: AdmissionResourceType

  /** Whether the request carries a valid server authentication header. */
  authenticated: boolean

  /** Target URL pathname. */
  pathname: string

  /** HTTP method. */
  method: string
}

/**
 * Decision returned by the admission manager for a request.
 * @public
 */
export interface AdmissionDecision {
  /** Whether the request is admitted for execution. */
  allowed: boolean

  /** Enforcement action. */
  action: AdmissionAction

  /** Scope that produced the governing decision. */
  scope: AdmissionScope

  /** HTTP status code (e.g. 429, 403). */
  status: number

  /** Human-readable explanation. */
  message: string

  /** Retry-After duration in seconds. */
  retryAfterSeconds: number

  /** Token balance remaining for the governing scope. */
  remainingTokens?: number

  /** Total capacity for the governing scope. */
  capacityLimit?: number

  /** Reset epoch timestamp in milliseconds. */
  resetTimestamp?: number

  /** Release function called when operation completes (for concurrency tracking). */
  releaseConcurrency?: () => void
}

/**
 * Mutable state tracked for a single Guild (L1 - Execution).
 * @internal
 */
export interface GuildAdmissionState {
  /** Available tokens in token bucket. */
  tokens: number

  /** Epoch timestamp of last token refill. */
  lastRefill: number

  /** Anomaly strike score with continuous exponential decay. */
  score: number

  /** Last timestamp when score was evaluated. */
  lastScoreUpdate: number

  /** Number of consecutive rate/burst violations. */
  consecutiveViolations: number

  /** Active concurrent operations running on this guild player. */
  activeConcurrency: number

  /** Epoch timestamp until which guild is in quarantine (0 = not quarantined). */
  quarantineUntil: number

  /** Epoch timestamp of last request seen. */
  lastSeen: number

  /** Timestamp of most recent 429 emitted (used to detect rapid retry storms). */
  last429Timestamp: number
}

/**
 * Mutable state tracked for a Session (L2 - Context).
 * @internal
 */
export interface SessionAdmissionState {
  /** Available tokens in token bucket. */
  tokens: number

  /** Epoch timestamp of last token refill. */
  lastRefill: number

  /** Anomaly strike score with continuous exponential decay. */
  score: number

  /** Last timestamp when score was evaluated. */
  lastScoreUpdate: number

  /** Number of consecutive violations. */
  consecutiveViolations: number

  /** Active player count cached for adaptive capacity. */
  activePlayers: number

  /** Player creations in rolling window. */
  playerCreates: number

  /** Player destructions in rolling window. */
  playerDestroys: number

  /** Last churn window reset timestamp. */
  churnWindowReset: number

  /** Exponentially weighted moving average of request rate. */
  ewmaRate: number

  /** Last timestamp EWMA was updated. */
  lastEwmaUpdate: number

  /** Requests in current 1-second interval. */
  currentIntervalRequests: number

  /** Epoch timestamp until which session is quarantined. */
  quarantineUntil: number

  /** Epoch timestamp of last request seen. */
  lastSeen: number

  /** Epoch timestamp of the last successful session resume. */
  lastResumeTimestamp: number

  /** Cumulative count of resumes recorded for this session. */
  resumeCount: number

  /** Epoch timestamp until which the warmup/reconciliation grace period is active. */
  warmupUntil: number

  /** Dynamic churn allowance granted during the active warmup period. */
  warmupChurnBudget: number

  /** Monotonic timestamp when reconciliation grant window resets. */
  reconciliationWindowReset: number

  /** Number of reconciliation grants issued in the current window. */
  reconciliationGrantsInWindow: number

  /** Baseline player count captured prior to churn spikes for capacity dampening. */
  stablePlayersBaseline: number
}

/**
 * Mutable state tracked for an IP (L3 - Edge).
 * @internal
 */
export interface IpAdmissionState {
  /** Available tokens in token bucket. */
  tokens: number

  /** Epoch timestamp of last token refill. */
  lastRefill: number

  /** Anomaly strike score with continuous exponential decay. */
  score: number

  /** Last timestamp when score was evaluated. */
  lastScoreUpdate: number

  /** Number of consecutive violations. */
  consecutiveViolations: number

  /** Active concurrent TCP sockets. */
  activeSockets: number

  /** Failed password attempts. */
  authFailures: number

  /** Last auth failure window reset timestamp. */
  authWindowReset: number

  /** Exponentially weighted moving average of request rate. */
  ewmaRate: number

  /** Last timestamp EWMA was updated. */
  lastEwmaUpdate: number

  /** Requests in current 1-second interval. */
  currentIntervalRequests: number

  /** Epoch timestamp until which IP is blocked (0 = not blocked). */
  blockedUntil: number

  /** Epoch timestamp of last request seen. */
  lastSeen: number
}

/**
 * Configuration for Guild-level admission and execution protection.
 * @public
 */
export interface GuildAdmissionConfig {
  /** Base token capacity for a guild player. */
  baseCapacity: number

  /** Refill rate: tokens added per second. */
  refillRatePerSecond: number

  /** Maximum concurrent heavy operations per guild player. */
  maxConcurrency: number

  /** Strike score threshold to enter quarantine. */
  quarantineScoreThreshold: number

  /** Strike score recovery threshold to exit quarantine. */
  quarantineRecoveryThreshold: number

  /** Duration of guild quarantine in milliseconds. */
  quarantineDurationMs: number

  /** Half-life of strike score decay in seconds. */
  scoreDecayHalfLifeSeconds: number

  /** Maximum distinct guild states retained in memory before triggering safe LRU eviction. */
  maxGuildStates: number
}

/**
 * Configuration for Session-level admission and context protection.
 * @public
 */
export interface SessionAdmissionConfig {
  /** Base token capacity for a session. */
  baseCapacity: number

  /** Extra tokens granted per active player in the session. */
  tokensPerActivePlayer: number

  /** Refill rate: tokens added per second. */
  refillRatePerSecond: number

  /** Strike score threshold to enter session quarantine. */
  quarantineScoreThreshold: number

  /** Duration of session quarantine in milliseconds. */
  quarantineDurationMs: number

  /** Maximum player churn (creates + destroys) per minute before strike. */
  maxPlayerChurnPerMinute: number

  /** Burst multiplier threshold compared to learned EWMA rate. */
  anomalyBurstMultiplier: number

  /** Additional token refill rate per second per active player in the session. */
  refillRatePerPlayerPerSecond: number

  /** Multiplier applied to existing players to compute reconciliation token grants. */
  reconciliationMultiplier: number

  /** Percentage factor of existing fleet allowed as organic growth headroom. */
  organicGrowthFactor: number

  /** Absolute minimum organic growth token headroom granted on resume. */
  organicGrowthFloor: number

  /** Minimum milliseconds required between resumes before flagging connection flapping. */
  flappingThresholdMs: number

  /** Duration in milliseconds of the post-resume warmup period. */
  warmupDurationMs: number

  /** Maximum full reconciliation grants allowed per rolling window to prevent resume loop farming. */
  maxReconciliationsPerWindow: number

  /** Rolling window duration for tracking reconciliation grants in milliseconds. */
  reconciliationWindowMs: number
}

/**
 * Configuration for IP-level admission and edge protection.
 * @public
 */
export interface IpAdmissionConfig {
  /** Base token capacity for an IP. */
  baseCapacity: number

  /** Refill rate: tokens added per second. */
  refillRatePerSecond: number

  /**
   * Maximum concurrent TCP connections per client IP. Behind a trusted proxy
   * this applies to WebSocket upgrades of each forwarded client.
   */
  maxConcurrentSockets: number

  /** Maximum concurrent TCP connections from a single trusted proxy (aggregate). */
  maxProxySockets: number

  /** Subnet mask for IPv6 grouping (e.g. 64). */
  ipv6SubnetMask: number

  /** Strike score threshold to trigger temporary IP block. */
  blockScoreThreshold: number

  /** Base block duration in milliseconds. */
  blockDurationMs: number

  /** Backoff multiplier for repeated blocks. */
  backoffMultiplier: number

  /** Maximum block duration in milliseconds. */
  maxBlockDurationMs: number

  /** Password brute-force protection settings. */
  authProtection: {
    enabled: boolean
    maxFailures: number
    windowMs: number
    banDurationMs: number
  }
}

/**
 * Configuration for server-wide Global admission and non-contextual operations.
 * @public
 */
export interface GlobalAdmissionConfig {
  /** Maximum burst tokens available in the global non-context pool. */
  baseCapacity: number

  /** Continuous token refill rate per second for the global pool. */
  refillRatePerSecond: number
}

/**
 * Root configuration for AdmissionManager.
 * @public
 */
export interface AdmissionConfig {
  /** Master toggle for the entire admission manager. */
  enabled: boolean

  /**
   * Whether to resolve client IPs from X-Forwarded-For / X-Real-IP.
   * Only honored for peers listed in trustedProxies.
   */
  trustProxy: boolean

  /** Trusted reverse proxy IPs or CIDR blocks (e.g. '127.0.0.1', '10.0.0.0/8'). */
  trustedProxies: string[]

  /** Guild execution layer config. */
  guild: GuildAdmissionConfig

  /** Session context layer config. */
  session: SessionAdmissionConfig

  /** Global admission config for non-contextual heavy operations. */
  global: GlobalAdmissionConfig

  /** IP edge layer config. */
  ip: IpAdmissionConfig

  /** Custom operation costs overrides. */
  operationCosts?: Partial<Record<AdmissionOperation, number>>

  /** Bypass lists. */
  ignore?: {
    ips?: string[]
    userIds?: string[]
    guildIds?: string[]
    sessionIds?: string[]
    paths?: string[]
  }
}
