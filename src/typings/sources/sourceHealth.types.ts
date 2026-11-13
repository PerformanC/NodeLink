/**
 * Type definitions for NodeLink Source Health & Observability System
 * @module typings/sources/sourceHealth.types
 */

/**
 * High-level health status classification for a registered audio source.
 * @public
 */
export type SourceHealthStatus =
  | 'unknown'
  | 'idle'
  | 'healthy'
  | 'degraded'
  | 'unavailable'
  | 'rate_limited'
  | 'restricted'
  | 'misconfigured'

/**
 * Underlying diagnostic reason for a health status or state transition.
 * @public
 */
export type SourceHealthReason =
  | 'internal_api_unavailable'
  | 'high_latency'
  | 'high_jitter'
  | 'rate_limited'
  | 'regional_restriction'
  | 'protection_challenge'
  | 'authentication_failure'
  | 'service_timeout'
  | 'consecutive_failures'
  | 'unconfigured'
  | null

/**
 * Action recommended to the client to mitigate source issues.
 * @public
 */
export type SourceHealthAction =
  | 'use_fallback'
  | 'disable_temporarily'
  | 'prefer_alternative'
  | 'reduce_requests'
  | 'disable'
  | 'resume'
  | null

/**
 * Circuit breaker states for upstream service protection.
 * @public
 */
export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

/**
 * Latency metrics calculated from a window of observed requests.
 * @public
 */
export interface SourceLatencyMetrics {
  /** 50th percentile response time in milliseconds (median). */
  p50: number
  /** 95th percentile response time in milliseconds. */
  p95: number
  /** Mean deviation / jitter across consecutive requests in milliseconds. */
  jitter: number
  /** Arithmetic mean response time in milliseconds. */
  average?: number
}

/**
 * Health information entry representing the current condition of a single source.
 * @public
 */
export interface SourceHealthEntry {
  /** Current health state. */
  status: SourceHealthStatus
  /** Diagnostic reason code if problematic, or null if healthy. */
  reason?: SourceHealthReason
  /** Human-readable explanation of current status. */
  message?: string
  /** Recommended action for connected clients. */
  recommendedAction?: SourceHealthAction
  /** Observed latency statistics if enough samples exist. */
  latency?: SourceLatencyMetrics
  /** Success percentage (0 to 100) within the observation window. */
  successRate?: number
  /** Current circuit breaker state. */
  circuitBreaker?: CircuitBreakerState
  /** Total lifetime observations recorded for this source. */
  totalRequests?: number
  /** Number of consecutive failed requests since last success. */
  consecutiveFailures?: number
  /** Timestamp of the most recent observed activity. */
  lastActivityAt?: number | null
  /** Timestamp of the most recent successful request. */
  lastSuccessAt?: number | null
  /** Timestamp of the most recent failed request. */
  lastFailureAt?: number | null
}

/**
 * Circuit breaker configuration parameters.
 * @public
 */
export interface CircuitBreakerConfig {
  /** Whether the circuit breaker is active. */
  enabled: boolean
  /** Initial cooldown in milliseconds before testing recovery in HALF_OPEN. */
  resetTimeoutMs: number
  /** Maximum reset cooldown cap in milliseconds. */
  maxResetTimeoutMs?: number
  /** Exponential backoff factor on repeated trips. */
  backoffMultiplier?: number
  /** Maximum trial requests permitted in HALF_OPEN state. */
  halfOpenMaxAttempts?: number
}

/**
 * Active probing configuration parameters.
 * @public
 */
export interface ActiveProbeConfig {
  /** Whether periodic active health probes are enabled. */
  enabled: boolean
  /** Whether to probe sources immediately upon startup. Defaults to true when enabled. */
  startupProbe?: boolean
  /** Maximum simultaneous probe requests across all sources. */
  maxConcurrent?: number
  /** Probe check interval in milliseconds. */
  intervalMs?: number
}

/**
 * Configuration options for the source health and observability subsystem.
 * @public
 */
export interface SourceHealthConfig {
  /** Whether health tracking and reporting is enabled. */
  enabled: boolean
  /** Maximum number of observed requests retained in the sliding metrics window. */
  observationWindowSize?: number
  /** Minimum number of requests required before moving from 'unknown' to active health states. */
  minObservations?: number
  /** Duration in milliseconds of inactivity before marking an unused source as 'idle'. */
  idleThresholdMs?: number
  /** Latency threshold in milliseconds above which a source is considered degraded. */
  degradedLatencyThresholdMs?: number
  /** Jitter threshold in milliseconds above which a source is considered degraded. */
  degradedJitterThresholdMs?: number
  /** Consecutive failures required to transition source to unavailable or trip circuit breaker. */
  consecutiveFailureThreshold?: number
  /** Failure rate (0.0 to 1.0) within sliding window to mark source as unavailable. */
  failureRateThreshold?: number
  /** Relative multiplier above baseline latency to trigger degraded warning. */
  relativeLatencyMultiplier?: number
  /** Circuit breaker subsystem configuration. */
  circuitBreaker?: CircuitBreakerConfig
  /** Active probe subsystem configuration. */
  activeProbes?: ActiveProbeConfig
  /** Whether to broadcast state transitions and initial snapshots via WebSocket. */
  websocketNotifications?: boolean
  /** Source-specific configuration overrides. */
  sources?: Record<string, Partial<SourceHealthConfig>>
}

/**
 * WebSocket event payload emitted upon connection handshake or reconnect.
 * @public
 */
export interface SourceHealthSnapshotPayload {
  op: 'event'
  type: 'SourceHealthSnapshotEvent'
  sources: Record<string, SourceHealthEntry>
  timestamp?: number
}

/**
 * WebSocket event payload emitted when a source transitions state or diagnostic reason.
 * @public
 */
export interface SourceHealthChangePayload {
  op: 'event'
  type: 'SourceHealthChangeEvent'
  source: string
  previousStatus: SourceHealthStatus
  status: SourceHealthStatus
  reason: SourceHealthReason
  message: string
  recommendedAction: SourceHealthAction
  timestamp: number
  latency?: SourceLatencyMetrics
  successRate?: number
}

/**
 * Aggregated summary counters for all registered sources.
 * @public
 */
export interface SourceHealthSummary {
  total: number
  healthy: number
  degraded: number
  unavailable: number
  rate_limited: number
  restricted: number
  misconfigured: number
  idle: number
  unknown: number
}

/**
 * Response shape for the REST endpoint GET /v4/sources/health.
 * @public
 */
export interface SourceHealthApiResponse {
  enabled: boolean
  timestamp: number
  summary: SourceHealthSummary
  sources: Record<string, SourceHealthEntry>
  probe: {
    enabled: boolean
    intervalMs: number
    nextRunAt: number | null
    lastRunAt: number | null
    running: boolean
    currentSources: Array<{ source: string; startedAt: number }>
    nextSources: string[]
    eligibleSources: number
  }
}

/**
 * Metric payload transmitted across processes and worker threads to update source health telemetry.
 * @public
 */
export interface SourceHealthMetricPayload {
  sourceName: string
  success: boolean
  duration: number
  error?: string
  httpStatus?: number | null
}
