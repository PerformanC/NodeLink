import { EventEmitter } from 'node:events'
import type { NodelinkConfig } from '../typings/config/config.types.ts'
import type {
  CircuitBreakerConfig,
  CircuitBreakerState,
  SourceHealthAction,
  SourceHealthChangePayload,
  SourceHealthConfig,
  SourceHealthEntry,
  SourceHealthReason,
  SourceHealthSnapshotPayload,
  SourceHealthStatus,
  SourceHealthSummary,
  SourceLatencyMetrics
} from '../typings/sources/sourceHealth.types.ts'
import { logger } from '../utils.ts'

/**
 * Internal tracking record representing metric state for an audio source provider.
 * @internal
 */
interface SourceHealthRecord {
  sourceName: string
  status: SourceHealthStatus
  previousStatus: SourceHealthStatus
  reason: SourceHealthReason
  previousReason: SourceHealthReason
  message: string
  recommendedAction: SourceHealthAction
  previousAction: SourceHealthAction
  latencies: number[]
  totalRequests: number
  successfulRequests: number
  failedRequests: number
  consecutiveFailures: number
  consecutiveSuccesses: number
  lastSuccessAt: number | null
  lastFailureAt: number | null
  lastActivityAt: number | null
  lastHttpStatus: number | null
  lastErrorMessage: string | null
  baselineLatency: number | null
  circuitState: CircuitBreakerState
  circuitNextAttemptAt: number
  circuitBackoffExponent: number
  circuitHalfOpenAttempts: number
}

/**
 * NodeLink context dependency required by the SourceHealthManager.
 * @public
 */
export interface SourceHealthManagerContext {
  options: NodelinkConfig
}

/**
 * Default circuit breaker settings applied when not overridden in configuration.
 */
const DEFAULT_CIRCUIT_BREAKER_CONFIG: Required<CircuitBreakerConfig> = {
  enabled: true,
  resetTimeoutMs: 30000,
  maxResetTimeoutMs: 300000,
  backoffMultiplier: 2.0,
  halfOpenMaxAttempts: 1
}

/**
 * Default source health settings applied across all sources.
 */
const DEFAULT_SOURCE_HEALTH_CONFIG: Required<
  Omit<SourceHealthConfig, 'sources' | 'circuitBreaker' | 'activeProbes'>
> = {
  enabled: true,
  observationWindowSize: 50,
  minObservations: 3,
  idleThresholdMs: 600000,
  degradedLatencyThresholdMs: 2500,
  degradedJitterThresholdMs: 800,
  consecutiveFailureThreshold: 3,
  failureRateThreshold: 0.5,
  relativeLatencyMultiplier: 3.0,
  websocketNotifications: true
}

/**
 * Intelligent health evaluation and observability manager for NodeLink audio sources.
 *
 * Tracks in-flight request telemetry, calculates P50/P95 latencies and jitter,
 * manages circuit breaker protection, and emits WebSocket state transition events.
 *
 * @public
 */
export default class SourceHealthManager extends EventEmitter {
  private readonly nodelink: SourceHealthManagerContext
  private readonly records: Map<string, SourceHealthRecord> = new Map()
  private idleCheckInterval: NodeJS.Timeout | null = null

  /**
   * Creates an instance of the SourceHealthManager.
   * @param nodelink - Server runtime context.
   */
  constructor(nodelink: SourceHealthManagerContext) {
    super()
    this.nodelink = nodelink

    if (this.isEnabled) {
      this.idleCheckInterval = setInterval(
        () => this.evaluateIdleSources(),
        60000
      )
      this.idleCheckInterval.unref?.()
    }
  }

  /**
   * Indicates whether source health monitoring is enabled in the configuration.
   */
  public get isEnabled(): boolean {
    return Boolean(this.nodelink.options.sourceHealth?.enabled ?? true)
  }

  /**
   * Resolves configuration for a specific source, applying overrides when available.
   * @param sourceName - Source provider key.
   */
  private getSourceConfig(sourceName: string): {
    windowSize: number
    minObservations: number
    idleThresholdMs: number
    degradedLatencyThresholdMs: number
    degradedJitterThresholdMs: number
    consecutiveFailureThreshold: number
    failureRateThreshold: number
    relativeLatencyMultiplier: number
    circuitBreaker: Required<CircuitBreakerConfig>
    websocketNotifications: boolean
  } {
    const root = this.nodelink.options.sourceHealth
    const override = root?.sources?.[sourceName]

    const cbRoot = root?.circuitBreaker
    const cbOverride = override?.circuitBreaker

    const circuitBreaker: Required<CircuitBreakerConfig> = {
      enabled:
        cbOverride?.enabled ??
        cbRoot?.enabled ??
        DEFAULT_CIRCUIT_BREAKER_CONFIG.enabled,
      resetTimeoutMs:
        cbOverride?.resetTimeoutMs ??
        cbRoot?.resetTimeoutMs ??
        DEFAULT_CIRCUIT_BREAKER_CONFIG.resetTimeoutMs,
      maxResetTimeoutMs:
        cbOverride?.maxResetTimeoutMs ??
        cbRoot?.maxResetTimeoutMs ??
        DEFAULT_CIRCUIT_BREAKER_CONFIG.maxResetTimeoutMs,
      backoffMultiplier:
        cbOverride?.backoffMultiplier ??
        cbRoot?.backoffMultiplier ??
        DEFAULT_CIRCUIT_BREAKER_CONFIG.backoffMultiplier,
      halfOpenMaxAttempts:
        cbOverride?.halfOpenMaxAttempts ??
        cbRoot?.halfOpenMaxAttempts ??
        DEFAULT_CIRCUIT_BREAKER_CONFIG.halfOpenMaxAttempts
    }

    return {
      windowSize:
        override?.observationWindowSize ??
        root?.observationWindowSize ??
        DEFAULT_SOURCE_HEALTH_CONFIG.observationWindowSize,
      minObservations:
        override?.minObservations ??
        root?.minObservations ??
        DEFAULT_SOURCE_HEALTH_CONFIG.minObservations,
      idleThresholdMs:
        override?.idleThresholdMs ??
        root?.idleThresholdMs ??
        DEFAULT_SOURCE_HEALTH_CONFIG.idleThresholdMs,
      degradedLatencyThresholdMs:
        override?.degradedLatencyThresholdMs ??
        root?.degradedLatencyThresholdMs ??
        DEFAULT_SOURCE_HEALTH_CONFIG.degradedLatencyThresholdMs,
      degradedJitterThresholdMs:
        override?.degradedJitterThresholdMs ??
        root?.degradedJitterThresholdMs ??
        DEFAULT_SOURCE_HEALTH_CONFIG.degradedJitterThresholdMs,
      consecutiveFailureThreshold:
        override?.consecutiveFailureThreshold ??
        root?.consecutiveFailureThreshold ??
        DEFAULT_SOURCE_HEALTH_CONFIG.consecutiveFailureThreshold,
      failureRateThreshold:
        override?.failureRateThreshold ??
        root?.failureRateThreshold ??
        DEFAULT_SOURCE_HEALTH_CONFIG.failureRateThreshold,
      relativeLatencyMultiplier:
        override?.relativeLatencyMultiplier ??
        root?.relativeLatencyMultiplier ??
        DEFAULT_SOURCE_HEALTH_CONFIG.relativeLatencyMultiplier,
      circuitBreaker,
      websocketNotifications:
        override?.websocketNotifications ??
        root?.websocketNotifications ??
        DEFAULT_SOURCE_HEALTH_CONFIG.websocketNotifications
    }
  }

  /**
   * Registers a source provider identifier into the health registry.
   * @param sourceName - Source name (e.g., 'youtube', 'spotify', 'monochrome').
   */
  public registerSource(sourceName: string): void {
    if (this.records.has(sourceName)) return

    this.records.set(sourceName, {
      sourceName,
      status: 'unknown',
      previousStatus: 'unknown',
      reason: null,
      previousReason: null,
      message: 'Not enough information is available.',
      recommendedAction: null,
      previousAction: null,
      latencies: [],
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastActivityAt: null,
      lastHttpStatus: null,
      lastErrorMessage: null,
      baselineLatency: null,
      circuitState: 'CLOSED',
      circuitNextAttemptAt: 0,
      circuitBackoffExponent: 0,
      circuitHalfOpenAttempts: 0
    })
  }

  /**
   * Calculates percentile and jitter metrics from an array of observed latencies.
   * @param latencies - Array of observed response durations in milliseconds.
   */
  private calculateMetrics(latencies: number[]): SourceLatencyMetrics {
    if (latencies.length === 0) {
      return { p50: 0, p95: 0, jitter: 0, average: 0 }
    }

    const sorted = [...latencies].sort((a, b) => a - b)
    const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0
    const p95 =
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0
    const sum = sorted.reduce((acc, val) => acc + val, 0)
    const average = Math.round(sum / sorted.length)

    let jitterSum = 0
    for (let i = 1; i < latencies.length; i++) {
      const prev = latencies[i - 1]
      const curr = latencies[i]
      if (prev !== undefined && curr !== undefined) {
        jitterSum += Math.abs(curr - prev)
      }
    }

    const jitter =
      latencies.length > 1 ? Math.round(jitterSum / (latencies.length - 1)) : 0

    return { p50, p95, jitter, average }
  }

  /**
   * Diagnoses an error into structured health classification with root cause and action.
   * @param error - Caught error, HTTP status or failure description.
   * @param sourceName - Name of the source that triggered the error.
   */
  private diagnoseError(
    error: unknown,
    _sourceName: string
  ): {
    status: SourceHealthStatus
    reason: SourceHealthReason
    message: string
    recommendedAction: SourceHealthAction
  } {
    const rawMessage =
      typeof error === 'string'
        ? error
        : error instanceof Error
          ? error.message
          : ((error as { message?: string })?.message ?? String(error ?? ''))
    const msg = rawMessage.toLowerCase()

    let statusCode: number | null = null
    if (typeof (error as { statusCode?: number })?.statusCode === 'number') {
      statusCode = (error as { statusCode: number }).statusCode
    } else if (typeof (error as { status?: number })?.status === 'number') {
      statusCode = (error as { status: number }).status
    } else {
      const match = rawMessage.match(
        /(?:status\s*code|status|http)?\s*:?\s*(403|429|500|502|503|504)\b/i
      )
      if (match?.[1]) {
        statusCode = Number.parseInt(match[1], 10)
      }
    }

    // HTTP 429 Rate Limited
    if (
      statusCode === 429 ||
      msg.includes('429') ||
      msg.includes('rate limit') ||
      msg.includes('too many requests')
    ) {
      return {
        status: 'rate_limited',
        reason: 'rate_limited',
        message: 'Upstream service is rate limiting requests (HTTP 429).',
        recommendedAction: 'reduce_requests'
      }
    }

    // HTTP 403 Forbidden / Turnstile / Akamai / Regional / Authentication
    const isRegional =
      msg.includes('bm-verify') ||
      msg.includes('geoblock') ||
      msg.includes('geo-blocked') ||
      msg.includes('not available in your area') ||
      msg.includes('restricted in your country') ||
      msg.includes('region restriction')

    if (isRegional) {
      return {
        status: 'restricted',
        reason: 'regional_restriction',
        message: 'Access restricted from current server region or network IP.',
        recommendedAction: 'disable'
      }
    }

    const isBotProtection =
      msg.includes('turnstile') ||
      msg.includes('cf-chl') ||
      msg.includes('cloudflare') ||
      msg.includes('captcha') ||
      msg.includes('challenge') ||
      msg.includes('waf')

    if (isBotProtection) {
      return {
        status: 'restricted',
        reason: 'protection_challenge',
        message:
          'Upstream protection or bot verification challenge is blocking requests.',
        recommendedAction: 'disable_temporarily'
      }
    }

    const isAuthFailure =
      msg.includes('token expired') ||
      msg.includes('invalid credentials') ||
      msg.includes('unauthorized') ||
      msg.includes('authentication failed')

    if (isAuthFailure) {
      return {
        status: 'restricted',
        reason: 'authentication_failure',
        message:
          'Authentication failed or credentials rejected by upstream service.',
        recommendedAction: 'disable_temporarily'
      }
    }

    if (
      statusCode === 403 ||
      msg.includes('403') ||
      msg.includes('forbidden')
    ) {
      return {
        status: 'restricted',
        reason: 'protection_challenge',
        message: 'Upstream service returned HTTP 403 Forbidden.',
        recommendedAction: 'disable_temporarily'
      }
    }

    // Misconfigured / Missing Credentials
    if (
      msg.includes('missing credentials') ||
      msg.includes('unconfigured') ||
      msg.includes('not configured') ||
      msg.includes('requires client id')
    ) {
      return {
        status: 'misconfigured',
        reason: 'unconfigured',
        message: 'Source is missing required configuration or credentials.',
        recommendedAction: 'disable'
      }
    }

    // Timeouts
    if (
      msg.includes('etimedout') ||
      msg.includes('timeout') ||
      msg.includes('timed out') ||
      msg.includes('aborted')
    ) {
      return {
        status: 'unavailable',
        reason: 'service_timeout',
        message: 'Upstream request timed out.',
        recommendedAction: 'use_fallback'
      }
    }

    // Upstream 5xx / Connection failures
    if (
      (statusCode !== null && statusCode >= 500 && statusCode < 600) ||
      msg.includes('econnrefused') ||
      msg.includes('enotfound') ||
      msg.includes('fetch failed') ||
      msg.includes('internal api') ||
      msg.includes('service unavailable') ||
      msg.includes('bad gateway')
    ) {
      return {
        status: 'unavailable',
        reason: 'internal_api_unavailable',
        message:
          'The internal API or upstream service is currently unavailable.',
        recommendedAction: 'use_fallback'
      }
    }

    return {
      status: 'unavailable',
      reason: 'consecutive_failures',
      message: rawMessage || 'Upstream request encountered an error.',
      recommendedAction: 'use_fallback'
    }
  }

  /**
   * Checks if state has transitioned and emits a deduplicated WebSocket event.
   * @param record - Source tracking record.
   * @param forceNotify - Force notification regardless of deduplication.
   */
  private checkTransition(
    record: SourceHealthRecord,
    forceNotify = false
  ): void {
    const hasStatusChanged = record.status !== record.previousStatus
    const hasReasonChanged = record.reason !== record.previousReason
    const hasActionChanged = record.recommendedAction !== record.previousAction

    if (
      !forceNotify &&
      !hasStatusChanged &&
      !hasReasonChanged &&
      !hasActionChanged
    ) {
      return
    }

    const config = this.getSourceConfig(record.sourceName)
    const metrics = this.calculateMetrics(record.latencies)
    const totalInWindow = record.latencies.length
    const successRate =
      totalInWindow > 0
        ? Math.round((record.successfulRequests / record.totalRequests) * 100)
        : undefined

    const payload: SourceHealthChangePayload = {
      op: 'event',
      type: 'SourceHealthChangeEvent',
      source: record.sourceName,
      previousStatus: record.previousStatus,
      status: record.status,
      reason: record.reason,
      message: record.message,
      recommendedAction: record.recommendedAction,
      timestamp: Date.now(),
      latency:
        record.latencies.length >= config.minObservations
          ? {
              p50: metrics.p50,
              p95: metrics.p95,
              jitter: metrics.jitter,
              average: metrics.average
            }
          : undefined,
      successRate
    }

    const previousStatus = record.previousStatus
    record.previousStatus = record.status
    record.previousReason = record.reason
    record.previousAction = record.recommendedAction

    if (record.status === 'healthy' && previousStatus !== 'healthy') {
      logger(
        'info',
        'SourceHealth',
        `Source "${record.sourceName}" recovered and is now healthy.`
      )
    } else if (record.status !== 'healthy' && record.status !== 'idle') {
      logger(
        'warn',
        'SourceHealth',
        `Source "${record.sourceName}" transitioned to [${record.status}] (reason: ${record.reason ?? 'none'}): ${record.message}`
      )
    }

    if (config.websocketNotifications) {
      this.emit('statusChange', payload)
    }
  }

  /**
   * Records a successful operation for a source provider.
   * @param sourceName - Source provider key.
   * @param durationMs - Observed duration of the operation in milliseconds.
   */
  public recordSuccess(sourceName: string, durationMs: number): void {
    if (!this.isEnabled) return

    this.registerSource(sourceName)
    const record = this.records.get(sourceName)
    if (!record) return

    const config = this.getSourceConfig(sourceName)
    const duration = Math.max(1, Math.round(durationMs))

    record.latencies.push(duration)
    if (record.latencies.length > config.windowSize) {
      record.latencies.shift()
    }

    record.totalRequests++
    record.successfulRequests++
    record.consecutiveFailures = 0
    record.consecutiveSuccesses++
    record.lastSuccessAt = Date.now()
    record.lastActivityAt = Date.now()
    record.lastErrorMessage = null

    // Circuit breaker recovery logic
    if (record.circuitState === 'HALF_OPEN') {
      record.circuitState = 'CLOSED'
      record.circuitBackoffExponent = 0
      record.circuitHalfOpenAttempts = 0
    } else if (record.circuitState === 'OPEN') {
      record.circuitState = 'CLOSED'
      record.circuitBackoffExponent = 0
    }

    const wasUnhealthy =
      record.status === 'unavailable' ||
      record.status === 'degraded' ||
      record.status === 'rate_limited' ||
      record.status === 'restricted'

    // Health state evaluation
    if (record.latencies.length < config.minObservations && !wasUnhealthy) {
      record.status = 'unknown'
      record.reason = null
      record.message = 'Not enough information is available.'
      record.recommendedAction = null
    } else {
      const metrics = this.calculateMetrics(record.latencies)

      if (record.baselineLatency === null) {
        record.baselineLatency = metrics.average ?? duration
      } else if (metrics.average !== undefined) {
        record.baselineLatency = Math.round(
          record.baselineLatency * 0.9 + metrics.average * 0.1
        )
      }

      const isHighLatency = metrics.p95 >= config.degradedLatencyThresholdMs
      const isHighJitter = metrics.jitter >= config.degradedJitterThresholdMs
      const isSuddenSpike =
        metrics.average !== undefined &&
        record.baselineLatency !== null &&
        metrics.average >
          record.baselineLatency * config.relativeLatencyMultiplier &&
        metrics.average > 1000

      if (isHighLatency || isSuddenSpike) {
        record.status = 'degraded'
        record.reason = 'high_latency'
        record.message = `High latency observed (P95: ${metrics.p95}ms, Avg: ${metrics.average ?? 0}ms).`
        record.recommendedAction = 'prefer_alternative'
      } else if (isHighJitter) {
        record.status = 'degraded'
        record.reason = 'high_jitter'
        record.message = `High latency jitter observed (${metrics.jitter}ms).`
        record.recommendedAction = 'prefer_alternative'
      } else {
        record.status = 'healthy'
        record.reason = null
        record.message = wasUnhealthy
          ? 'The service has recovered.'
          : 'Operating normally.'
        record.recommendedAction = wasUnhealthy ? 'resume' : null
      }
    }

    this.checkTransition(record)
  }

  /**
   * Records a failed operation for a source provider.
   * @param sourceName - Source provider key.
   * @param durationMs - Observed duration before failure in milliseconds.
   * @param error - Caught error or exception payload.
   */
  public recordFailure(
    sourceName: string,
    durationMs: number,
    error: unknown
  ): void {
    if (!this.isEnabled) return

    this.registerSource(sourceName)
    const record = this.records.get(sourceName)
    if (!record) return

    const config = this.getSourceConfig(sourceName)
    const duration = Math.max(1, Math.round(durationMs))

    if (duration > 1) {
      record.latencies.push(duration)
      if (record.latencies.length > config.windowSize) {
        record.latencies.shift()
      }
    }

    record.totalRequests++
    record.failedRequests++
    record.consecutiveFailures++
    record.consecutiveSuccesses = 0
    record.lastFailureAt = Date.now()
    record.lastActivityAt = Date.now()
    record.lastErrorMessage =
      error instanceof Error
        ? error.message
        : String((error as { message?: string })?.message ?? error)

    const diagnosis = this.diagnoseError(error, sourceName)

    if (
      diagnosis.status === 'rate_limited' ||
      diagnosis.status === 'restricted' ||
      diagnosis.status === 'misconfigured' ||
      diagnosis.reason === 'internal_api_unavailable' ||
      diagnosis.reason === 'service_timeout'
    ) {
      record.status = diagnosis.status
      record.reason = diagnosis.reason
      record.message = diagnosis.message
      record.recommendedAction = diagnosis.recommendedAction
    } else if (
      record.consecutiveFailures >= config.consecutiveFailureThreshold
    ) {
      record.status = 'unavailable'
      record.reason = 'consecutive_failures'
      record.message = `Source failed ${record.consecutiveFailures} consecutive times.`
      record.recommendedAction = 'use_fallback'
    } else if (record.totalRequests >= config.minObservations) {
      const windowFailures = record.failedRequests
      const failureRate = windowFailures / record.totalRequests
      if (failureRate >= config.failureRateThreshold) {
        record.status = 'unavailable'
        record.reason = 'internal_api_unavailable'
        record.message = 'High failure rate detected on upstream service.'
        record.recommendedAction = 'use_fallback'
      }
    }

    // Circuit breaker tripping logic
    if (
      config.circuitBreaker.enabled &&
      (record.status === 'unavailable' ||
        record.status === 'rate_limited' ||
        record.status === 'restricted')
    ) {
      if (
        record.circuitState === 'CLOSED' ||
        record.circuitState === 'HALF_OPEN'
      ) {
        record.circuitState = 'OPEN'
        record.circuitBackoffExponent = Math.min(
          record.circuitBackoffExponent + 1,
          6
        )
        const randomJitter = Math.floor(Math.random() * 2000)
        const timeout =
          Math.min(
            config.circuitBreaker.maxResetTimeoutMs,
            config.circuitBreaker.resetTimeoutMs *
              config.circuitBreaker.backoffMultiplier **
                (record.circuitBackoffExponent - 1)
          ) + randomJitter
        record.circuitNextAttemptAt = Date.now() + timeout
      }
    }

    this.checkTransition(record)
  }

  /**
   * Checks whether the circuit breaker permits an operation against the given source.
   * @param sourceName - Source provider key.
   * @returns `true` if requests may proceed, `false` if short-circuited by an open circuit.
   */
  public canExecute(sourceName: string): boolean {
    if (!this.isEnabled) return true

    const record = this.records.get(sourceName)
    if (!record) return true

    const config = this.getSourceConfig(sourceName)
    if (!config.circuitBreaker.enabled) return true

    if (record.circuitState === 'CLOSED') {
      return true
    }

    const now = Date.now()
    if (record.circuitState === 'OPEN') {
      if (now >= record.circuitNextAttemptAt) {
        record.circuitState = 'HALF_OPEN'
        record.circuitHalfOpenAttempts = 1
        return true
      }
      return false
    }

    if (record.circuitState === 'HALF_OPEN') {
      if (
        record.circuitHalfOpenAttempts <
        config.circuitBreaker.halfOpenMaxAttempts
      ) {
        record.circuitHalfOpenAttempts++
        return true
      }
      return false
    }

    return true
  }

  /**
   * Evaluates inactivity across all sources and transitions unused sources to 'idle'.
   */
  public evaluateIdleSources(): void {
    if (!this.isEnabled) return

    const now = Date.now()
    for (const record of this.records.values()) {
      const config = this.getSourceConfig(record.sourceName)
      if (
        record.lastActivityAt !== null &&
        now - record.lastActivityAt > config.idleThresholdMs &&
        record.status !== 'idle'
      ) {
        record.status = 'idle'
        record.reason = null
        record.message = 'No recent activity to evaluate its health.'
        record.recommendedAction = null
        this.checkTransition(record)
      }
    }
  }

  /**
   * Builds an individual health report entry for a given source.
   * @param sourceName - Source provider key.
   */
  public getHealth(sourceName: string): SourceHealthEntry {
    const record = this.records.get(sourceName)
    if (!record) {
      return {
        status: 'unknown',
        reason: null,
        message: 'Source not registered or no observations recorded.',
        recommendedAction: null
      }
    }

    const config = this.getSourceConfig(sourceName)
    const metrics = this.calculateMetrics(record.latencies)
    const successRate =
      record.totalRequests > 0
        ? Math.round((record.successfulRequests / record.totalRequests) * 100)
        : undefined

    return {
      status: record.status,
      reason: record.reason,
      message: record.message,
      recommendedAction: record.recommendedAction,
      latency:
        record.latencies.length >= config.minObservations
          ? {
              p50: metrics.p50,
              p95: metrics.p95,
              jitter: metrics.jitter,
              average: metrics.average
            }
          : undefined,
      successRate,
      circuitBreaker: record.circuitState,
      totalRequests: record.totalRequests,
      consecutiveFailures: record.consecutiveFailures,
      lastActivityAt: record.lastActivityAt,
      lastSuccessAt: record.lastSuccessAt,
      lastFailureAt: record.lastFailureAt
    }
  }

  /**
   * Builds a consolidated map of health entries across all registered sources.
   */
  public getAllHealth(): Record<string, SourceHealthEntry> {
    const result: Record<string, SourceHealthEntry> = {}
    for (const key of this.records.keys()) {
      result[key] = this.getHealth(key)
    }
    return result
  }

  /**
   * Generates the WebSocket initial connection snapshot payload.
   */
  public getSnapshot(): SourceHealthSnapshotPayload {
    return {
      op: 'event',
      type: 'SourceHealthSnapshotEvent',
      sources: this.getAllHealth(),
      timestamp: Date.now()
    }
  }

  /**
   * Aggregates summary counters across all registered sources.
   */
  public getSummary(): SourceHealthSummary {
    const summary: SourceHealthSummary = {
      total: this.records.size,
      healthy: 0,
      degraded: 0,
      unavailable: 0,
      rate_limited: 0,
      restricted: 0,
      misconfigured: 0,
      idle: 0,
      unknown: 0
    }

    for (const record of this.records.values()) {
      switch (record.status) {
        case 'healthy':
          summary.healthy++
          break
        case 'degraded':
          summary.degraded++
          break
        case 'unavailable':
          summary.unavailable++
          break
        case 'rate_limited':
          summary.rate_limited++
          break
        case 'restricted':
          summary.restricted++
          break
        case 'misconfigured':
          summary.misconfigured++
          break
        case 'idle':
          summary.idle++
          break
        default:
          summary.unknown++
          break
      }
    }

    return summary
  }

  /**
   * Disposes of running timers and listeners.
   */
  public destroy(): void {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval)
      this.idleCheckInterval = null
    }
    this.removeAllListeners()
  }
}
