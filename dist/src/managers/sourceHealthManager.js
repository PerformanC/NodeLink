import { EventEmitter } from 'node:events';
import { logger } from '../utils.js';
/**
 * Default circuit breaker settings applied when not overridden in configuration.
 */
const DEFAULT_CIRCUIT_BREAKER_CONFIG = {
    enabled: true,
    resetTimeoutMs: 30000,
    maxResetTimeoutMs: 300000,
    backoffMultiplier: 2.0,
    halfOpenMaxAttempts: 1
};
/**
 * Default active health probe settings applied when not overridden in configuration.
 */
const DEFAULT_ACTIVE_PROBE_CONFIG = {
    enabled: true,
    startupProbe: true,
    maxConcurrent: 2,
    intervalMs: 120000
};
/**
 * Default source health settings applied across all sources.
 */
const DEFAULT_SOURCE_HEALTH_CONFIG = {
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
};
/**
 * Intelligent health evaluation and observability manager for NodeLink audio sources.
 *
 * Tracks in-flight request telemetry, calculates P50/P95 latencies and jitter,
 * manages circuit breaker protection, and emits WebSocket state transition events.
 *
 * @public
 */
export default class SourceHealthManager extends EventEmitter {
    nodelink;
    records = new Map();
    idleCheckInterval = null;
    probeInterval = null;
    isProbing = false;
    probeRunner = null;
    probeSources = new Set();
    probeCursor = 0;
    nextProbeAt = null;
    lastProbeAt = null;
    activeProbeSources = new Map();
    /**
     * Creates an instance of the SourceHealthManager.
     * @param nodelink - Server runtime context.
     */
    constructor(nodelink) {
        super();
        this.nodelink = nodelink;
        if (this.isEnabled) {
            this.idleCheckInterval = setInterval(() => this.evaluateIdleSources(), 60000);
            this.idleCheckInterval.unref?.();
            this.bootstrapSources();
            const probeConfig = this.getActiveProbeConfig();
            if (probeConfig.enabled && probeConfig.intervalMs > 0) {
                this.nextProbeAt = Date.now() + probeConfig.intervalMs;
                this.probeInterval = setInterval(() => {
                    this.nextProbeAt = Date.now() + probeConfig.intervalMs;
                    this.runProbes().catch((err) => {
                        const msg = err instanceof Error ? err.message : String(err);
                        logger('error', 'SourceHealth', `Periodic probe execution failed: ${msg}`);
                    });
                }, probeConfig.intervalMs);
                this.probeInterval.unref?.();
            }
        }
    }
    /** Attaches the source-test-backed lightweight probe runner once providers are loaded. */
    setProbeRunner(runner, sources) {
        this.probeRunner = runner;
        this.probeSources = new Set(sources);
        const config = this.getActiveProbeConfig();
        if (config.enabled && config.startupProbe) {
            setImmediate(() => void this.runProbes().catch((err) => {
                logger('error', 'SourceHealth', `Startup probe execution failed: ${String(err)}`);
            }));
        }
    }
    /** Updates declarative probe cases reported by a source worker. */
    setProbeSources(sources) {
        this.probeSources = new Set(sources);
        this.probeCursor = 0;
        if (sources.length > 0 && this.lastProbeAt === null) {
            setImmediate(() => void this.runProbes());
        }
    }
    /**
     * Indicates whether source health monitoring is enabled in the configuration.
     */
    get isEnabled() {
        return Boolean(this.nodelink.options.sourceHealth?.enabled ?? true);
    }
    /**
     * Resolves active health probe configuration applying defaults.
     */
    getActiveProbeConfig() {
        const root = this.nodelink.options.sourceHealth?.activeProbes;
        return {
            enabled: root?.enabled ?? DEFAULT_ACTIVE_PROBE_CONFIG.enabled,
            startupProbe: root?.startupProbe ?? DEFAULT_ACTIVE_PROBE_CONFIG.startupProbe,
            maxConcurrent: root?.maxConcurrent ?? DEFAULT_ACTIVE_PROBE_CONFIG.maxConcurrent,
            intervalMs: root?.intervalMs ?? DEFAULT_ACTIVE_PROBE_CONFIG.intervalMs
        };
    }
    /**
     * Registers all enabled sources from configuration and evaluates their static configuration state.
     */
    bootstrapSources() {
        const sources = this.nodelink.options.sources;
        if (!sources || typeof sources !== 'object')
            return;
        for (const [rawKey, rawVal] of Object.entries(sources)) {
            const sourceName = rawKey.toLowerCase();
            const val = rawVal;
            if (val && typeof val === 'object' && val.enabled) {
                this.registerSource(sourceName);
                this.evaluateStaticConfiguration(sourceName, val);
            }
        }
    }
    /**
     * Performs pre-flight static configuration checks to detect misconfigured sources without network requests.
     * @param sourceName - Source provider key.
     * @param config - Source configuration block.
     */
    evaluateStaticConfiguration(sourceName, config) {
        const record = this.records.get(sourceName);
        if (!record)
            return;
        if (sourceName === 'spotify') {
            const clientId = String(config.clientId ?? '').trim();
            const clientSecret = String(config.clientSecret ?? '').trim();
            const isMissing = !clientId ||
                !clientSecret ||
                clientId.startsWith('<') ||
                clientId.includes('your_client_id');
            if (isMissing) {
                record.status = 'misconfigured';
                record.reason = 'unconfigured';
                record.message =
                    'Spotify is enabled but client credentials (clientId/clientSecret) are missing or set to default placeholders.';
                record.recommendedAction = 'disable';
                record.previousStatus = 'misconfigured';
                record.previousReason = 'unconfigured';
                record.previousAction = 'disable';
            }
        }
    }
    /**
     * Performs a lightweight active health probe against a specific source provider.
     * @param sourceName - Name of the source to probe.
     */
    async probeSource(sourceName) {
        const record = this.records.get(sourceName);
        if (!record || record.status === 'misconfigured' || !this.probeRunner)
            return;
        const start = performance.now();
        this.activeProbeSources.set(sourceName, Date.now());
        try {
            await this.probeRunner(sourceName);
            this.recordSuccess(sourceName, Math.round(performance.now() - start));
        }
        catch (err) {
            this.recordFailure(sourceName, Math.round(performance.now() - start), err);
        }
        finally {
            this.activeProbeSources.delete(sourceName);
        }
    }
    /**
     * Executes active health probes across registered candidate sources.
     * @param sourcesToProbe - Optional subset of sources to probe.
     */
    async runProbes(sourcesToProbe) {
        if (!this.isEnabled || this.isProbing)
            return;
        this.isProbing = true;
        try {
            const probeConfig = this.getActiveProbeConfig();
            const candidates = (sourcesToProbe ?? Array.from(this.records.keys())).filter((key) => {
                const rec = this.records.get(key);
                return rec && rec.status !== 'misconfigured';
            });
            const eligible = candidates.filter((c) => this.probeSources.has(c));
            if (eligible.length === 0)
                return;
            const batchSize = Math.max(1, probeConfig.maxConcurrent * 2);
            const startIndex = this.probeCursor % eligible.length;
            const toProbe = Array.from({ length: Math.min(batchSize, eligible.length) }, (_, offset) => eligible[(startIndex + offset) % eligible.length]).filter((source) => Boolean(source));
            this.probeCursor = (startIndex + toProbe.length) % eligible.length;
            if (toProbe.length === 0)
                return;
            this.lastProbeAt = Date.now();
            const concurrency = Math.max(1, probeConfig.maxConcurrent);
            const queue = [...toProbe];
            const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
                while (queue.length > 0) {
                    const source = queue.shift();
                    if (!source)
                        break;
                    await this.probeSource(source).catch(() => { });
                }
            });
            await Promise.all(workers);
        }
        finally {
            this.isProbing = false;
        }
    }
    /** Reports active and scheduled probe work for the health API. */
    getProbeStatus() {
        const probeConfig = this.getActiveProbeConfig();
        const names = Array.from(this.probeSources);
        const nextSources = names.length
            ? Array.from({
                length: Math.min(names.length, Math.max(1, probeConfig.maxConcurrent * 2))
            }, (_, offset) => names[(this.probeCursor + offset) % names.length]).filter((source) => Boolean(source))
            : [];
        return {
            enabled: probeConfig.enabled && Boolean(this.probeRunner),
            intervalMs: probeConfig.intervalMs,
            nextRunAt: this.nextProbeAt,
            lastRunAt: this.lastProbeAt,
            running: this.isProbing,
            currentSources: Array.from(this.activeProbeSources, ([source, startedAt]) => ({
                source,
                startedAt
            })),
            nextSources,
            eligibleSources: this.probeSources.size
        };
    }
    getSourceConfig(sourceName) {
        const root = this.nodelink.options.sourceHealth;
        const override = root?.sources?.[sourceName];
        const cbRoot = root?.circuitBreaker;
        const cbOverride = override?.circuitBreaker;
        const measuredProviderDefaults = sourceName === 'spotify'
            ? { degradedLatencyThresholdMs: 5000, degradedJitterThresholdMs: 2000 }
            : sourceName === 'youtube'
                ? {
                    degradedLatencyThresholdMs: 3500,
                    degradedJitterThresholdMs: 1500
                }
                : null;
        const circuitBreaker = {
            enabled: cbOverride?.enabled ??
                cbRoot?.enabled ??
                DEFAULT_CIRCUIT_BREAKER_CONFIG.enabled,
            resetTimeoutMs: cbOverride?.resetTimeoutMs ??
                cbRoot?.resetTimeoutMs ??
                DEFAULT_CIRCUIT_BREAKER_CONFIG.resetTimeoutMs,
            maxResetTimeoutMs: cbOverride?.maxResetTimeoutMs ??
                cbRoot?.maxResetTimeoutMs ??
                DEFAULT_CIRCUIT_BREAKER_CONFIG.maxResetTimeoutMs,
            backoffMultiplier: cbOverride?.backoffMultiplier ??
                cbRoot?.backoffMultiplier ??
                DEFAULT_CIRCUIT_BREAKER_CONFIG.backoffMultiplier,
            halfOpenMaxAttempts: cbOverride?.halfOpenMaxAttempts ??
                cbRoot?.halfOpenMaxAttempts ??
                DEFAULT_CIRCUIT_BREAKER_CONFIG.halfOpenMaxAttempts
        };
        return {
            windowSize: override?.observationWindowSize ??
                root?.observationWindowSize ??
                DEFAULT_SOURCE_HEALTH_CONFIG.observationWindowSize,
            minObservations: override?.minObservations ??
                root?.minObservations ??
                DEFAULT_SOURCE_HEALTH_CONFIG.minObservations,
            idleThresholdMs: override?.idleThresholdMs ??
                root?.idleThresholdMs ??
                DEFAULT_SOURCE_HEALTH_CONFIG.idleThresholdMs,
            degradedLatencyThresholdMs: override?.degradedLatencyThresholdMs ??
                (root?.degradedLatencyThresholdMs !==
                    DEFAULT_SOURCE_HEALTH_CONFIG.degradedLatencyThresholdMs
                    ? root?.degradedLatencyThresholdMs
                    : undefined) ??
                measuredProviderDefaults?.degradedLatencyThresholdMs ??
                root?.degradedLatencyThresholdMs ??
                DEFAULT_SOURCE_HEALTH_CONFIG.degradedLatencyThresholdMs,
            degradedJitterThresholdMs: override?.degradedJitterThresholdMs ??
                (root?.degradedJitterThresholdMs !==
                    DEFAULT_SOURCE_HEALTH_CONFIG.degradedJitterThresholdMs
                    ? root?.degradedJitterThresholdMs
                    : undefined) ??
                measuredProviderDefaults?.degradedJitterThresholdMs ??
                root?.degradedJitterThresholdMs ??
                DEFAULT_SOURCE_HEALTH_CONFIG.degradedJitterThresholdMs,
            consecutiveFailureThreshold: override?.consecutiveFailureThreshold ??
                root?.consecutiveFailureThreshold ??
                DEFAULT_SOURCE_HEALTH_CONFIG.consecutiveFailureThreshold,
            failureRateThreshold: override?.failureRateThreshold ??
                root?.failureRateThreshold ??
                DEFAULT_SOURCE_HEALTH_CONFIG.failureRateThreshold,
            relativeLatencyMultiplier: override?.relativeLatencyMultiplier ??
                root?.relativeLatencyMultiplier ??
                DEFAULT_SOURCE_HEALTH_CONFIG.relativeLatencyMultiplier,
            circuitBreaker,
            websocketNotifications: override?.websocketNotifications ??
                root?.websocketNotifications ??
                DEFAULT_SOURCE_HEALTH_CONFIG.websocketNotifications
        };
    }
    /**
     * Registers a source provider identifier into the health registry.
     * @param sourceName - Source name (e.g., 'youtube', 'spotify', 'monochrome').
     */
    registerSource(sourceName) {
        sourceName = this.normalizeSourceName(sourceName);
        if (this.records.has(sourceName))
            return;
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
        });
    }
    /** Maps alternate identifiers to the provider's canonical health record. */
    normalizeSourceName(sourceName) {
        return sourceName === 'ytmusic' ? 'youtube' : sourceName;
    }
    /**
     * Calculates percentile and jitter metrics from an array of observed latencies.
     * @param latencies - Array of observed response durations in milliseconds.
     */
    calculateMetrics(latencies) {
        if (latencies.length === 0) {
            return { p50: 0, p95: 0, jitter: 0, average: 0 };
        }
        const sorted = [...latencies].sort((a, b) => a - b);
        const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
        const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
        const sum = sorted.reduce((acc, val) => acc + val, 0);
        const average = Math.round(sum / sorted.length);
        let jitterSum = 0;
        for (let i = 1; i < latencies.length; i++) {
            const prev = latencies[i - 1];
            const curr = latencies[i];
            if (prev !== undefined && curr !== undefined) {
                jitterSum += Math.abs(curr - prev);
            }
        }
        const jitter = latencies.length > 1 ? Math.round(jitterSum / (latencies.length - 1)) : 0;
        return { p50, p95, jitter, average };
    }
    /**
     * Diagnoses an error into structured health classification with root cause and action.
     * @param error - Caught error, HTTP status or failure description.
     * @param sourceName - Name of the source that triggered the error.
     */
    diagnoseError(error, _sourceName) {
        const rawMessage = typeof error === 'string'
            ? error
            : error instanceof Error
                ? error.message
                : (error?.message ?? String(error ?? ''));
        const msg = rawMessage.toLowerCase();
        let statusCode = null;
        if (typeof error?.statusCode === 'number') {
            statusCode = error.statusCode;
        }
        else if (typeof error?.status === 'number') {
            statusCode = error.status;
        }
        else {
            const match = rawMessage.match(/(?:status\s*code|status|http)?\s*:?\s*(403|429|500|502|503|504)\b/i);
            if (match?.[1]) {
                statusCode = Number.parseInt(match[1], 10);
            }
        }
        // HTTP 429 Rate Limited
        if (statusCode === 429 ||
            msg.includes('429') ||
            msg.includes('rate limit') ||
            msg.includes('too many requests')) {
            return {
                status: 'rate_limited',
                reason: 'rate_limited',
                message: 'Upstream service is rate limiting requests (HTTP 429).',
                recommendedAction: 'reduce_requests'
            };
        }
        // HTTP 403 Forbidden / Turnstile / Akamai / Regional / Authentication
        const isRegional = msg.includes('bm-verify') ||
            msg.includes('geoblock') ||
            msg.includes('geo-blocked') ||
            msg.includes('not available in your area') ||
            msg.includes('restricted in your country') ||
            msg.includes('region restriction');
        if (isRegional) {
            return {
                status: 'restricted',
                reason: 'regional_restriction',
                message: 'Access restricted from current server region or network IP.',
                recommendedAction: 'disable'
            };
        }
        const isBotProtection = msg.includes('turnstile') ||
            msg.includes('cf-chl') ||
            msg.includes('cloudflare') ||
            msg.includes('captcha') ||
            msg.includes('challenge') ||
            msg.includes('waf');
        if (isBotProtection) {
            return {
                status: 'restricted',
                reason: 'protection_challenge',
                message: 'Upstream protection or bot verification challenge is blocking requests.',
                recommendedAction: 'disable_temporarily'
            };
        }
        const isAuthFailure = msg.includes('token expired') ||
            msg.includes('invalid credentials') ||
            msg.includes('unauthorized') ||
            msg.includes('authentication failed');
        if (isAuthFailure) {
            return {
                status: 'restricted',
                reason: 'authentication_failure',
                message: 'Authentication failed or credentials rejected by upstream service.',
                recommendedAction: 'disable_temporarily'
            };
        }
        if (statusCode === 403 ||
            msg.includes('403') ||
            msg.includes('forbidden')) {
            return {
                status: 'restricted',
                reason: 'protection_challenge',
                message: 'Upstream service returned HTTP 403 Forbidden.',
                recommendedAction: 'disable_temporarily'
            };
        }
        // Misconfigured / Missing Credentials
        if (msg.includes('missing credentials') ||
            msg.includes('unconfigured') ||
            msg.includes('not configured') ||
            msg.includes('requires client id')) {
            return {
                status: 'misconfigured',
                reason: 'unconfigured',
                message: 'Source is missing required configuration or credentials.',
                recommendedAction: 'disable'
            };
        }
        // Timeouts
        if (msg.includes('etimedout') ||
            msg.includes('timeout') ||
            msg.includes('timed out') ||
            msg.includes('aborted')) {
            return {
                status: 'unavailable',
                reason: 'service_timeout',
                message: 'Upstream request timed out.',
                recommendedAction: 'use_fallback'
            };
        }
        // Upstream 5xx / Connection failures
        if ((statusCode !== null && statusCode >= 500 && statusCode < 600) ||
            msg.includes('econnrefused') ||
            msg.includes('enotfound') ||
            msg.includes('fetch failed') ||
            msg.includes('internal api') ||
            msg.includes('api interna') ||
            msg.includes('service unavailable') ||
            msg.includes('bad gateway')) {
            return {
                status: 'unavailable',
                reason: 'internal_api_unavailable',
                message: 'The internal API or upstream service is currently unavailable.',
                recommendedAction: 'use_fallback'
            };
        }
        return {
            status: 'unavailable',
            reason: 'consecutive_failures',
            message: rawMessage || 'Upstream request encountered an error.',
            recommendedAction: 'use_fallback'
        };
    }
    /**
     * Checks if state has transitioned and emits a deduplicated WebSocket event.
     * @param record - Source tracking record.
     * @param forceNotify - Force notification regardless of deduplication.
     */
    checkTransition(record, forceNotify = false) {
        const hasStatusChanged = record.status !== record.previousStatus;
        const hasReasonChanged = record.reason !== record.previousReason;
        const hasActionChanged = record.recommendedAction !== record.previousAction;
        if (!forceNotify &&
            !hasStatusChanged &&
            !hasReasonChanged &&
            !hasActionChanged) {
            return;
        }
        const config = this.getSourceConfig(record.sourceName);
        const metrics = this.calculateMetrics(record.latencies);
        const totalInWindow = record.latencies.length;
        const successRate = totalInWindow > 0
            ? Math.round((record.successfulRequests / record.totalRequests) * 100)
            : undefined;
        const payload = {
            op: 'event',
            type: 'SourceHealthChangeEvent',
            source: record.sourceName,
            previousStatus: record.previousStatus,
            status: record.status,
            reason: record.reason,
            message: record.message,
            recommendedAction: record.recommendedAction,
            timestamp: Date.now(),
            latency: record.latencies.length >= config.minObservations
                ? {
                    p50: metrics.p50,
                    p95: metrics.p95,
                    jitter: metrics.jitter,
                    average: metrics.average
                }
                : undefined,
            successRate
        };
        const previousStatus = record.previousStatus;
        record.previousStatus = record.status;
        record.previousReason = record.reason;
        record.previousAction = record.recommendedAction;
        if (record.status === 'healthy' && previousStatus !== 'healthy') {
            logger('info', 'SourceHealth', `Source "${record.sourceName}" recovered and is now healthy.`);
        }
        else if (record.status !== 'healthy' && record.status !== 'idle') {
            logger('warn', 'SourceHealth', `Source "${record.sourceName}" transitioned to [${record.status}] (reason: ${record.reason ?? 'none'}): ${record.message}`);
        }
        if (config.websocketNotifications) {
            this.emit('statusChange', payload);
        }
    }
    /**
     * Records a successful operation for a source provider.
     * @param sourceName - Source provider key.
     * @param durationMs - Observed duration of the operation in milliseconds.
     */
    recordSuccess(sourceName, durationMs) {
        if (!this.isEnabled)
            return;
        sourceName = this.normalizeSourceName(sourceName);
        this.registerSource(sourceName);
        const record = this.records.get(sourceName);
        if (!record)
            return;
        const config = this.getSourceConfig(sourceName);
        const duration = Math.max(1, Math.round(durationMs));
        record.latencies.push(duration);
        if (record.latencies.length > config.windowSize) {
            record.latencies.shift();
        }
        record.totalRequests++;
        record.successfulRequests++;
        record.consecutiveFailures = 0;
        record.consecutiveSuccesses++;
        record.lastSuccessAt = Date.now();
        record.lastActivityAt = Date.now();
        record.lastErrorMessage = null;
        // Circuit breaker recovery logic
        if (record.circuitState === 'HALF_OPEN') {
            record.circuitState = 'CLOSED';
            record.circuitBackoffExponent = 0;
            record.circuitHalfOpenAttempts = 0;
        }
        else if (record.circuitState === 'OPEN') {
            record.circuitState = 'CLOSED';
            record.circuitBackoffExponent = 0;
        }
        const wasUnhealthy = record.status === 'unavailable' ||
            record.status === 'degraded' ||
            record.status === 'rate_limited' ||
            record.status === 'restricted';
        // Health state evaluation
        if (record.latencies.length < config.minObservations &&
            !wasUnhealthy &&
            record.consecutiveSuccesses === 0) {
            record.status = 'unknown';
            record.reason = null;
            record.message = 'Not enough information is available.';
            record.recommendedAction = null;
        }
        else {
            const metrics = this.calculateMetrics(record.latencies);
            const recentLatencies = record.latencies.slice(-Math.max(config.minObservations, 5));
            const sustainedSlowObservations = recentLatencies.filter((latency) => latency >= config.degradedLatencyThresholdMs).length;
            const sustainedSlow = sustainedSlowObservations >= config.minObservations;
            if (record.baselineLatency === null) {
                record.baselineLatency = metrics.average ?? duration;
            }
            else if (metrics.average !== undefined) {
                record.baselineLatency = Math.round(record.baselineLatency * 0.9 + metrics.average * 0.1);
            }
            const isHighLatency = metrics.p95 >= config.degradedLatencyThresholdMs && sustainedSlow;
            const isHighJitter = metrics.jitter >= config.degradedJitterThresholdMs && sustainedSlow;
            const isSuddenSpike = sustainedSlow &&
                metrics.average !== undefined &&
                record.baselineLatency !== null &&
                metrics.average >
                    record.baselineLatency * config.relativeLatencyMultiplier &&
                metrics.average > 1000;
            if (isHighLatency || isSuddenSpike) {
                record.status = 'degraded';
                record.reason = 'high_latency';
                record.message = `High latency observed (P95: ${metrics.p95}ms, Avg: ${metrics.average ?? 0}ms).`;
                record.recommendedAction = 'prefer_alternative';
            }
            else if (isHighJitter) {
                record.status = 'degraded';
                record.reason = 'high_jitter';
                record.message = `High latency jitter observed (${metrics.jitter}ms).`;
                record.recommendedAction = 'prefer_alternative';
            }
            else {
                record.status = 'healthy';
                record.reason = null;
                record.message = wasUnhealthy
                    ? 'The service has recovered.'
                    : 'Operating normally.';
                record.recommendedAction = wasUnhealthy ? 'resume' : null;
            }
        }
        this.checkTransition(record);
    }
    /**
     * Records a failed operation for a source provider.
     * @param sourceName - Source provider key.
     * @param durationMs - Observed duration before failure in milliseconds.
     * @param error - Caught error or exception payload.
     */
    recordFailure(sourceName, durationMs, error) {
        if (!this.isEnabled)
            return;
        sourceName = this.normalizeSourceName(sourceName);
        this.registerSource(sourceName);
        const record = this.records.get(sourceName);
        if (!record)
            return;
        const config = this.getSourceConfig(sourceName);
        const duration = Math.max(1, Math.round(durationMs));
        if (duration > 1) {
            record.latencies.push(duration);
            if (record.latencies.length > config.windowSize) {
                record.latencies.shift();
            }
        }
        record.totalRequests++;
        record.failedRequests++;
        record.consecutiveFailures++;
        record.consecutiveSuccesses = 0;
        record.lastFailureAt = Date.now();
        record.lastActivityAt = Date.now();
        record.lastErrorMessage =
            error instanceof Error
                ? error.message
                : String(error?.message ?? error);
        const diagnosis = this.diagnoseError(error, sourceName);
        if (diagnosis.status === 'rate_limited' ||
            diagnosis.status === 'restricted' ||
            diagnosis.status === 'misconfigured') {
            record.status = diagnosis.status;
            record.reason = diagnosis.reason;
            record.message = diagnosis.message;
            record.recommendedAction = diagnosis.recommendedAction;
        }
        else if (record.consecutiveFailures >= config.consecutiveFailureThreshold) {
            record.status = 'unavailable';
            record.reason = 'consecutive_failures';
            record.message = `Source failed ${record.consecutiveFailures} consecutive times.`;
            record.recommendedAction = 'use_fallback';
        }
        else if (record.totalRequests >= config.minObservations) {
            const windowFailures = record.failedRequests;
            const failureRate = windowFailures / record.totalRequests;
            if (failureRate >= config.failureRateThreshold) {
                record.status = 'unavailable';
                record.reason = 'internal_api_unavailable';
                record.message = 'High failure rate detected on upstream service.';
                record.recommendedAction = 'use_fallback';
            }
        }
        // Circuit breaker tripping logic
        if (config.circuitBreaker.enabled &&
            (record.status === 'unavailable' ||
                record.status === 'rate_limited' ||
                record.status === 'restricted')) {
            if (record.circuitState === 'CLOSED' ||
                record.circuitState === 'HALF_OPEN') {
                record.circuitState = 'OPEN';
                record.circuitBackoffExponent = Math.min(record.circuitBackoffExponent + 1, 6);
                const randomJitter = Math.floor(Math.random() * 2000);
                const timeout = Math.min(config.circuitBreaker.maxResetTimeoutMs, config.circuitBreaker.resetTimeoutMs *
                    config.circuitBreaker.backoffMultiplier **
                        (record.circuitBackoffExponent - 1)) + randomJitter;
                record.circuitNextAttemptAt = Date.now() + timeout;
            }
        }
        this.checkTransition(record);
    }
    /**
     * Checks whether the circuit breaker permits an operation against the given source.
     * @param sourceName - Source provider key.
     * @returns `true` if requests may proceed, `false` if short-circuited by an open circuit.
     */
    canExecute(sourceName) {
        if (!this.isEnabled)
            return true;
        const record = this.records.get(sourceName);
        if (!record)
            return true;
        const config = this.getSourceConfig(sourceName);
        if (!config.circuitBreaker.enabled)
            return true;
        if (record.circuitState === 'CLOSED') {
            return true;
        }
        const now = Date.now();
        if (record.circuitState === 'OPEN') {
            if (now >= record.circuitNextAttemptAt) {
                record.circuitState = 'HALF_OPEN';
                record.circuitHalfOpenAttempts = 1;
                return true;
            }
            return false;
        }
        if (record.circuitState === 'HALF_OPEN') {
            if (record.circuitHalfOpenAttempts <
                config.circuitBreaker.halfOpenMaxAttempts) {
                record.circuitHalfOpenAttempts++;
                return true;
            }
            return false;
        }
        return true;
    }
    /**
     * Evaluates inactivity across all sources and transitions unused sources to 'idle'.
     */
    evaluateIdleSources() {
        if (!this.isEnabled)
            return;
        const now = Date.now();
        const probeConfig = this.getActiveProbeConfig();
        const probeBatchSize = Math.max(1, probeConfig.maxConcurrent * 2);
        const probeCycleMs = probeConfig.enabled && this.probeRunner && this.probeSources.size > 0
            ? Math.ceil(this.probeSources.size / probeBatchSize) *
                probeConfig.intervalMs
            : 0;
        for (const record of this.records.values()) {
            const config = this.getSourceConfig(record.sourceName);
            const isProbeMonitored = this.probeSources.has(record.sourceName);
            const idleThresholdMs = isProbeMonitored
                ? Math.max(config.idleThresholdMs, probeCycleMs * 1.5)
                : config.idleThresholdMs;
            const hasUnresolvedFailure = record.status === 'unavailable' ||
                record.status === 'degraded' ||
                record.status === 'rate_limited' ||
                record.status === 'restricted' ||
                record.status === 'misconfigured';
            if (!hasUnresolvedFailure &&
                record.lastActivityAt !== null &&
                now - record.lastActivityAt > idleThresholdMs &&
                record.status !== 'idle') {
                record.status = 'idle';
                record.reason = null;
                record.message = 'No recent activity to evaluate its health.';
                record.recommendedAction = null;
                this.checkTransition(record);
            }
        }
    }
    /**
     * Builds an individual health report entry for a given source.
     * @param sourceName - Source provider key.
     */
    getHealth(sourceName) {
        sourceName = this.normalizeSourceName(sourceName);
        const record = this.records.get(sourceName);
        if (!record) {
            return {
                status: 'unknown',
                reason: null,
                message: 'Source not registered or no observations recorded.',
                recommendedAction: null
            };
        }
        const config = this.getSourceConfig(sourceName);
        const metrics = this.calculateMetrics(record.latencies);
        const successRate = record.totalRequests > 0
            ? Math.round((record.successfulRequests / record.totalRequests) * 100)
            : undefined;
        return {
            status: record.status,
            reason: record.reason,
            message: record.message,
            recommendedAction: record.recommendedAction,
            latency: record.latencies.length >= config.minObservations
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
        };
    }
    /**
     * Builds a consolidated map of health entries across all registered sources.
     */
    getAllHealth() {
        const result = {};
        for (const key of this.records.keys()) {
            result[key] = this.getHealth(key);
        }
        return result;
    }
    /**
     * Generates the WebSocket initial connection snapshot payload.
     */
    getSnapshot() {
        return {
            op: 'event',
            type: 'SourceHealthSnapshotEvent',
            sources: this.getAllHealth(),
            timestamp: Date.now()
        };
    }
    /**
     * Aggregates summary counters across all registered sources.
     */
    getSummary() {
        const summary = {
            total: this.records.size,
            healthy: 0,
            degraded: 0,
            unavailable: 0,
            rate_limited: 0,
            restricted: 0,
            misconfigured: 0,
            idle: 0,
            unknown: 0
        };
        for (const record of this.records.values()) {
            switch (record.status) {
                case 'healthy':
                    summary.healthy++;
                    break;
                case 'degraded':
                    summary.degraded++;
                    break;
                case 'unavailable':
                    summary.unavailable++;
                    break;
                case 'rate_limited':
                    summary.rate_limited++;
                    break;
                case 'restricted':
                    summary.restricted++;
                    break;
                case 'misconfigured':
                    summary.misconfigured++;
                    break;
                case 'idle':
                    summary.idle++;
                    break;
                default:
                    summary.unknown++;
                    break;
            }
        }
        return summary;
    }
    /**
     * Disposes of running timers and listeners.
     */
    destroy() {
        if (this.idleCheckInterval) {
            clearInterval(this.idleCheckInterval);
            this.idleCheckInterval = null;
        }
        if (this.probeInterval) {
            clearInterval(this.probeInterval);
            this.probeInterval = null;
        }
        this.removeAllListeners();
    }
}
