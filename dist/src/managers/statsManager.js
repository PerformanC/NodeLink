import { logger } from '../utils.js';
const MAX_ENDPOINT_ENTRIES = 500;
const MAX_ENDPOINT_LENGTH = 200;
const safeNumber = (value) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
/**
 * Aggregates runtime statistics and Prometheus metrics for NodeLink.
 * @example
 * ```ts
 * const statsManager = new StatsManager(nodelink)
 * await statsManager.initialize()
 * statsManager.incrementApiRequest('/v4/stats')
 * ```
 * @public
 */
export default class StatsManager {
    nodelink;
    stats;
    initialized;
    /**
     * Prometheus registry (available when metrics are enabled).
     */
    promRegister;
    promCollectedStats;
    promApiRequests;
    promApiErrors;
    promSourceRequests;
    promPlaybackEvents;
    promPlayers;
    promPlayingPlayers;
    promUptime;
    promMemoryFree;
    promMemoryUsed;
    promMemoryAllocated;
    promMemoryReservable;
    promCpuCores;
    promCpuSystemLoad;
    promCpuNodelinkLoad;
    promFramesSent;
    promFramesNulled;
    promFramesDeficit;
    promFramesExpected;
    promWorkerPlayers;
    promWorkerPlayingPlayers;
    promWorkerMemoryUsed;
    promWorkerMemoryAllocated;
    promWorkerCpuLoad;
    promWorkerEventLoopLag;
    promWorkerCommandQueueLength;
    promWorkerFramesSent;
    promWorkerFramesNulled;
    promWorkerFramesDeficit;
    promWorkerFramesExpected;
    promWorkerUptime;
    promWorkerHealth;
    promTotalWorkers;
    promWorkerRestarts;
    promWorkerFailures;
    promCommandQueueSize;
    promCommandExecutionTime;
    promCommandTimeouts;
    promCommandRetries;
    promPlayerRestorations;
    promPlayerDestructions;
    promTrackLoads;
    promTrackLoadDuration;
    promStreamErrors;
    promPlayerStuck;
    promVoiceConnections;
    promVoiceConnectionErrors;
    promWebsocketConnections;
    promWebsocketMessages;
    promSessionResumes;
    promRoutePlannerIps;
    promRoutePlannerBannedIps;
    promLyricsRequests;
    promFilterUsage;
    promHttpRequestDuration;
    promRateLimitHits;
    promDosProtectionBlocks;
    /**
     * Creates a new stats manager instance.
     * @param nodelink - NodeLink runtime context.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.stats = {
            api: {
                requests: {},
                errors: {}
            },
            sources: {},
            playback: {
                events: {}
            }
        };
        this.initialized = false;
        logger('info', 'StatsManager', 'Initialized.');
    }
    /**
     * Initializes Prometheus metrics collectors.
     * @throws Error when prom-client is missing while metrics are enabled.
     */
    async initialize() {
        if (this.initialized)
            return;
        const metricsEnabled = this.nodelink.options.api.metrics?.enabled ?? false;
        if (!metricsEnabled) {
            this.initialized = true;
            return;
        }
        let promClient;
        try {
            promClient = (await import('prom-client'));
        }
        catch (_e) {
            logger('error', 'StatsManager', "Metrics are enabled in config but 'prom-client' is not installed.");
            logger('error', 'StatsManager', "Please install it using 'npm install prom-client' or disable metrics in config.");
            throw new Error("Optional dependency 'prom-client' is missing.");
        }
        const { collectDefaultMetrics, Registry, Counter, Gauge } = promClient;
        this.promRegister = new Registry();
        this.promCollectedStats = collectDefaultMetrics({
            register: this.promRegister
        });
        this.promApiRequests = new Counter({
            name: 'nodelink_api_requests_total',
            help: 'Total number of API requests',
            labelNames: ['endpoint'],
            registers: [this.promRegister]
        });
        this.promApiErrors = new Counter({
            name: 'nodelink_api_errors_total',
            help: 'Total number of API errors',
            labelNames: ['endpoint'],
            registers: [this.promRegister]
        });
        this.promSourceRequests = new Counter({
            name: 'nodelink_source_requests_total',
            help: 'Total number of source requests',
            labelNames: ['source', 'status'],
            registers: [this.promRegister]
        });
        this.promPlaybackEvents = new Counter({
            name: 'nodelink_playback_events_total',
            help: 'Total number of playback events',
            labelNames: ['event_type'],
            registers: [this.promRegister]
        });
        this.promPlayers = new Gauge({
            name: 'nodelink_players',
            help: 'Total number of players',
            registers: [this.promRegister]
        });
        this.promPlayingPlayers = new Gauge({
            name: 'nodelink_playing_players',
            help: 'Number of currently playing players',
            registers: [this.promRegister]
        });
        this.promUptime = new Gauge({
            name: 'nodelink_uptime_ms',
            help: 'Server uptime in milliseconds',
            registers: [this.promRegister]
        });
        this.promMemoryFree = new Gauge({
            name: 'nodelink_memory_free_bytes',
            help: 'Free system memory in bytes',
            registers: [this.promRegister]
        });
        this.promMemoryUsed = new Gauge({
            name: 'nodelink_memory_used_bytes',
            help: 'Used memory in bytes',
            registers: [this.promRegister]
        });
        this.promMemoryAllocated = new Gauge({
            name: 'nodelink_memory_allocated_bytes',
            help: 'Allocated memory in bytes',
            registers: [this.promRegister]
        });
        this.promMemoryReservable = new Gauge({
            name: 'nodelink_memory_reservable_bytes',
            help: 'Reservable memory in bytes',
            registers: [this.promRegister]
        });
        this.promCpuCores = new Gauge({
            name: 'nodelink_cpu_cores',
            help: 'Number of CPU cores',
            registers: [this.promRegister]
        });
        this.promCpuSystemLoad = new Gauge({
            name: 'nodelink_cpu_system_load',
            help: 'System CPU load average',
            registers: [this.promRegister]
        });
        this.promCpuNodelinkLoad = new Gauge({
            name: 'nodelink_cpu_nodelink_load',
            help: 'NodeLink CPU load',
            registers: [this.promRegister]
        });
        this.promFramesSent = new Gauge({
            name: 'nodelink_frames_sent',
            help: 'Total number of audio frames sent',
            registers: [this.promRegister]
        });
        this.promFramesNulled = new Gauge({
            name: 'nodelink_frames_nulled',
            help: 'Total number of nulled audio frames',
            registers: [this.promRegister]
        });
        this.promFramesDeficit = new Gauge({
            name: 'nodelink_frames_deficit',
            help: 'Audio frame deficit',
            registers: [this.promRegister]
        });
        this.promFramesExpected = new Gauge({
            name: 'nodelink_frames_expected',
            help: 'Total number of expected audio frames',
            registers: [this.promRegister]
        });
        this.promWorkerPlayers = new Gauge({
            name: 'nodelink_worker_players',
            help: 'Number of players per worker',
            labelNames: ['worker_id', 'worker_pid'],
            registers: [this.promRegister]
        });
        this.promWorkerPlayingPlayers = new Gauge({
            name: 'nodelink_worker_playing_players',
            help: 'Number of playing players per worker',
            labelNames: ['worker_id', 'worker_pid'],
            registers: [this.promRegister]
        });
        this.promWorkerMemoryUsed = new Gauge({
            name: 'nodelink_worker_memory_used_bytes',
            help: 'Worker memory used in bytes',
            labelNames: ['worker_id', 'worker_pid'],
            registers: [this.promRegister]
        });
        this.promWorkerMemoryAllocated = new Gauge({
            name: 'nodelink_worker_memory_allocated_bytes',
            help: 'Worker memory allocated in bytes',
            labelNames: ['worker_id', 'worker_pid'],
            registers: [this.promRegister]
        });
        this.promWorkerCpuLoad = new Gauge({
            name: 'nodelink_worker_cpu_load',
            help: 'Worker CPU load',
            labelNames: ['worker_id', 'worker_pid'],
            registers: [this.promRegister]
        });
        this.promWorkerEventLoopLag = new Gauge({
            name: 'nodelink_worker_event_loop_lag_ms',
            help: 'Worker event loop lag in milliseconds',
            labelNames: ['worker_id', 'worker_pid'],
            registers: [this.promRegister]
        });
        this.promWorkerCommandQueueLength = new Gauge({
            name: 'nodelink_worker_command_queue_length',
            help: 'Worker command queue length',
            labelNames: ['worker_id', 'worker_pid'],
            registers: [this.promRegister]
        });
        this.promWorkerFramesSent = new Gauge({
            name: 'nodelink_worker_frames_sent',
            help: 'Audio frames sent by worker',
            labelNames: ['worker_id', 'worker_pid'],
            registers: [this.promRegister]
        });
        this.promWorkerFramesNulled = new Gauge({
            name: 'nodelink_worker_frames_nulled',
            help: 'Audio frames nulled by worker',
            labelNames: ['worker_id', 'worker_pid'],
            registers: [this.promRegister]
        });
        this.promWorkerFramesDeficit = new Gauge({
            name: 'nodelink_worker_frames_deficit',
            help: 'Audio frame deficit by worker',
            labelNames: ['worker_id', 'worker_pid'],
            registers: [this.promRegister]
        });
        this.promWorkerFramesExpected = new Gauge({
            name: 'nodelink_worker_frames_expected',
            help: 'Audio frames expected by worker',
            labelNames: ['worker_id', 'worker_pid'],
            registers: [this.promRegister]
        });
        this.promWorkerUptime = new Gauge({
            name: 'nodelink_worker_uptime_seconds',
            help: 'Worker uptime in seconds',
            labelNames: ['worker_id', 'worker_pid'],
            registers: [this.promRegister]
        });
        this.promWorkerHealth = new Gauge({
            name: 'nodelink_worker_health',
            help: 'Worker health status (1 = healthy, 0 = unhealthy)',
            labelNames: ['worker_id', 'worker_pid'],
            registers: [this.promRegister]
        });
        this.promTotalWorkers = new Gauge({
            name: 'nodelink_total_workers',
            help: 'Total number of active workers',
            registers: [this.promRegister]
        });
        this.promWorkerRestarts = new Counter({
            name: 'nodelink_worker_restarts_total',
            help: 'Total number of worker restarts',
            labelNames: ['worker_id'],
            registers: [this.promRegister]
        });
        this.promWorkerFailures = new Counter({
            name: 'nodelink_worker_failures_total',
            help: 'Total number of worker failures',
            labelNames: ['worker_id', 'exit_code'],
            registers: [this.promRegister]
        });
        this.promCommandQueueSize = new Gauge({
            name: 'nodelink_command_queue_size',
            help: 'Total size of command queue across all workers',
            registers: [this.promRegister]
        });
        this.promCommandExecutionTime = new Gauge({
            name: 'nodelink_command_execution_time_ms',
            help: 'Command execution time in milliseconds',
            labelNames: ['command_type', 'worker_id'],
            registers: [this.promRegister]
        });
        this.promCommandTimeouts = new Counter({
            name: 'nodelink_command_timeouts_total',
            help: 'Total number of command timeouts',
            labelNames: ['command_type'],
            registers: [this.promRegister]
        });
        this.promCommandRetries = new Counter({
            name: 'nodelink_command_retries_total',
            help: 'Total number of command retries',
            labelNames: ['command_type'],
            registers: [this.promRegister]
        });
        this.promPlayerRestorations = new Counter({
            name: 'nodelink_player_restorations_total',
            help: 'Total number of player restorations',
            labelNames: ['worker_id'],
            registers: [this.promRegister]
        });
        this.promPlayerDestructions = new Counter({
            name: 'nodelink_player_destructions_total',
            help: 'Total number of player destructions',
            labelNames: ['session_id', 'reason'],
            registers: [this.promRegister]
        });
        this.promTrackLoads = new Counter({
            name: 'nodelink_track_loads_total',
            help: 'Total number of track loads',
            labelNames: ['source', 'status'],
            registers: [this.promRegister]
        });
        this.promTrackLoadDuration = new Gauge({
            name: 'nodelink_track_load_duration_ms',
            help: 'Track load duration in milliseconds',
            labelNames: ['source'],
            registers: [this.promRegister]
        });
        this.promStreamErrors = new Counter({
            name: 'nodelink_stream_errors_total',
            help: 'Total number of stream errors',
            labelNames: ['error_type', 'source'],
            registers: [this.promRegister]
        });
        this.promPlayerStuck = new Counter({
            name: 'nodelink_player_stuck_total',
            help: 'Total number of stuck players',
            labelNames: ['guild_id', 'reason'],
            registers: [this.promRegister]
        });
        this.promVoiceConnections = new Gauge({
            name: 'nodelink_voice_connections',
            help: 'Number of active voice connections',
            registers: [this.promRegister]
        });
        this.promVoiceConnectionErrors = new Counter({
            name: 'nodelink_voice_connection_errors_total',
            help: 'Total number of voice connection errors',
            labelNames: ['error_type'],
            registers: [this.promRegister]
        });
        this.promWebsocketConnections = new Gauge({
            name: 'nodelink_websocket_connections',
            help: 'Number of active WebSocket connections',
            registers: [this.promRegister]
        });
        this.promWebsocketMessages = new Counter({
            name: 'nodelink_websocket_messages_total',
            help: 'Total number of WebSocket messages',
            labelNames: ['direction', 'op_type'],
            registers: [this.promRegister]
        });
        this.promSessionResumes = new Counter({
            name: 'nodelink_session_resumes_total',
            help: 'Total number of session resumes',
            labelNames: ['client_name', 'success'],
            registers: [this.promRegister]
        });
        this.promRoutePlannerIps = new Gauge({
            name: 'nodelink_route_planner_ips',
            help: 'Number of available IPs in route planner',
            registers: [this.promRegister]
        });
        this.promRoutePlannerBannedIps = new Gauge({
            name: 'nodelink_route_planner_banned_ips',
            help: 'Number of banned IPs in route planner',
            registers: [this.promRegister]
        });
        this.promLyricsRequests = new Counter({
            name: 'nodelink_lyrics_requests_total',
            help: 'Total number of lyrics requests',
            labelNames: ['provider', 'status'],
            registers: [this.promRegister]
        });
        this.promFilterUsage = new Counter({
            name: 'nodelink_filter_usage_total',
            help: 'Total number of filter usage',
            labelNames: ['filter_type'],
            registers: [this.promRegister]
        });
        this.promHttpRequestDuration = new Gauge({
            name: 'nodelink_http_request_duration_ms',
            help: 'HTTP request duration in milliseconds',
            labelNames: ['endpoint', 'method', 'status_code'],
            registers: [this.promRegister]
        });
        this.promRateLimitHits = new Counter({
            name: 'nodelink_rate_limit_hits_total',
            help: 'Total number of rate limit hits',
            labelNames: ['endpoint', 'ip'],
            registers: [this.promRegister]
        });
        this.promDosProtectionBlocks = new Counter({
            name: 'nodelink_dos_protection_blocks_total',
            help: 'Total number of DoS protection blocks',
            labelNames: ['ip', 'reason'],
            registers: [this.promRegister]
        });
        this.initialized = true;
        logger('info', 'StatsManager', 'Prometheus metrics initialized.');
    }
    /**
     * Returns the Prometheus registry for custom metric registration.
     * @public
     */
    getRegistry() {
        return this.promRegister;
    }
    /**
     * Returns a deep-copied snapshot of internal counters.
     */
    getSnapshot() {
        return JSON.parse(JSON.stringify(this.stats));
    }
    /**
     * Increments the API request counter for an endpoint.
     * @param endpoint - Request path.
     */
    incrementApiRequest(endpoint) {
        const sanitized = this._sanitizeEndpoint(endpoint);
        this._incrementEndpointCounter(this.stats.api.requests, sanitized);
        if (this.promApiRequests) {
            this.promApiRequests.inc({ endpoint: sanitized });
        }
    }
    /**
     * Increments the API error counter for an endpoint.
     * @param endpoint - Request path.
     */
    incrementApiError(endpoint) {
        const sanitized = this._sanitizeEndpoint(endpoint);
        this._incrementEndpointCounter(this.stats.api.errors, sanitized);
        if (this.promApiErrors) {
            this.promApiErrors.inc({ endpoint: sanitized });
        }
    }
    /**
     * Increments the success counter for a source.
     * @param source - Source identifier.
     */
    incrementSourceSuccess(source) {
        const sourceKey = source || 'unknown';
        const entry = this._initSource(sourceKey);
        entry.success++;
        if (this.promSourceRequests) {
            this.promSourceRequests.inc({ source: sourceKey, status: 'success' });
        }
    }
    /**
     * Increments the failure counter for a source.
     * @param source - Source identifier.
     */
    incrementSourceFailure(source) {
        const sourceKey = source || 'unknown';
        const entry = this._initSource(sourceKey);
        entry.failure++;
        if (this.promSourceRequests) {
            this.promSourceRequests.inc({ source: sourceKey, status: 'failure' });
        }
    }
    /**
     * Increments the playback event counter.
     * @param eventType - Playback event name.
     */
    incrementPlaybackEvent(eventType) {
        const key = eventType || 'unknown';
        this.stats.playback.events[key] = (this.stats.playback.events[key] || 0) + 1;
        if (this.promPlaybackEvents) {
            this.promPlaybackEvents.inc({ event_type: key });
        }
    }
    /**
     * Updates gauge metrics using the latest stats payloads.
     * @param statsData - Aggregated server stats.
     * @param workerMetrics - Worker metrics payload.
     */
    updateStatsMetrics(statsData, workerMetrics = null) {
        if (!this.promPlayers)
            return;
        try {
            const stats = statsData;
            this.promPlayers.set(safeNumber(stats.players));
            this.promPlayingPlayers?.set(safeNumber(stats.playingPlayers));
            this.promUptime?.set(safeNumber(stats.uptime));
            if (stats.memory) {
                this.promMemoryFree?.set(safeNumber(stats.memory.free));
                this.promMemoryUsed?.set(safeNumber(stats.memory.used));
                this.promMemoryAllocated?.set(safeNumber(stats.memory.allocated));
                this.promMemoryReservable?.set(safeNumber(stats.memory.reservable));
            }
            if (stats.cpu) {
                this.promCpuCores?.set(safeNumber(stats.cpu.cores));
                this.promCpuSystemLoad?.set(safeNumber(stats.cpu.systemLoad));
                this.promCpuNodelinkLoad?.set(safeNumber(stats.cpu.nodelinkLoad));
            }
            if (stats.frameStats) {
                this.promFramesSent?.set(safeNumber(stats.frameStats.sent));
                this.promFramesNulled?.set(safeNumber(stats.frameStats.nulled));
                this.promFramesDeficit?.set(safeNumber(stats.frameStats.deficit));
                this.promFramesExpected?.set(safeNumber(stats.frameStats.expected));
            }
            else {
                this.promFramesSent?.set(0);
                this.promFramesNulled?.set(0);
                this.promFramesDeficit?.set(0);
                this.promFramesExpected?.set(0);
            }
            if (workerMetrics && this.promWorkerPlayers) {
                this._updateWorkerMetrics(workerMetrics);
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger('error', 'StatsManager', `Failed to update stats metrics: ${message}`);
        }
    }
    /**
     * Increments the worker restart counter.
     * @param workerId - Worker identifier.
     */
    incrementWorkerRestart(workerId) {
        if (this.promWorkerRestarts && workerId) {
            this.promWorkerRestarts.inc({ worker_id: String(workerId) });
        }
    }
    /**
     * Increments the worker failure counter.
     * @param workerId - Worker identifier.
     * @param exitCode - Exit code or error string.
     */
    incrementWorkerFailure(workerId, exitCode) {
        if (this.promWorkerFailures && workerId) {
            this.promWorkerFailures.inc({
                worker_id: String(workerId),
                exit_code: String(exitCode || 'unknown')
            });
        }
    }
    /**
     * Records the execution time of a worker command.
     * @param commandType - Command identifier.
     * @param workerId - Worker identifier.
     * @param durationMs - Execution time in milliseconds.
     */
    recordCommandExecutionTime(commandType, workerId, durationMs) {
        if (this.promCommandExecutionTime &&
            commandType &&
            workerId &&
            Number.isFinite(durationMs)) {
            this.promCommandExecutionTime.set({ command_type: commandType, worker_id: String(workerId) }, durationMs);
        }
    }
    /**
     * Increments the command timeout counter.
     * @param commandType - Command identifier.
     */
    incrementCommandTimeout(commandType) {
        if (this.promCommandTimeouts && commandType) {
            this.promCommandTimeouts.inc({ command_type: commandType });
        }
    }
    /**
     * Increments the command retry counter.
     * @param commandType - Command identifier.
     */
    incrementCommandRetry(commandType) {
        if (this.promCommandRetries && commandType) {
            this.promCommandRetries.inc({ command_type: commandType });
        }
    }
    /**
     * Increments the player restoration counter.
     * @param workerId - Worker identifier.
     */
    incrementPlayerRestoration(workerId) {
        if (this.promPlayerRestorations && workerId) {
            this.promPlayerRestorations.inc({ worker_id: String(workerId) });
        }
    }
    /**
     * Increments the player destruction counter.
     * @param sessionId - Session identifier.
     * @param reason - Destruction reason.
     */
    incrementPlayerDestruction(sessionId, reason) {
        if (this.promPlayerDestructions && sessionId) {
            const sanitizedSessionId = `session_${sessionId.substring(0, 4)}...`;
            this.promPlayerDestructions.inc({
                session_id: sanitizedSessionId,
                reason: reason || 'unknown'
            });
        }
    }
    /**
     * Increments the track load counter.
     * @param source - Source identifier.
     * @param status - Status label.
     */
    incrementTrackLoad(source, status) {
        if (this.promTrackLoads && source && status) {
            this.promTrackLoads.inc({ source, status });
        }
    }
    /**
     * Records the track load duration.
     * @param source - Source identifier.
     * @param durationMs - Duration in milliseconds.
     */
    recordTrackLoadDuration(source, durationMs) {
        if (this.promTrackLoadDuration && source && Number.isFinite(durationMs)) {
            this.promTrackLoadDuration.set({ source }, durationMs);
        }
    }
    /**
     * Increments stream error counters.
     * @param errorType - Error category.
     * @param source - Source identifier.
     */
    incrementStreamError(errorType, source) {
        if (this.promStreamErrors && errorType && source) {
            this.promStreamErrors.inc({ error_type: errorType, source });
        }
    }
    /**
     * Increments the player stuck counter.
     * @param guildId - Guild identifier.
     * @param reason - Stuck reason.
     */
    incrementPlayerStuck(guildId, reason) {
        if (this.promPlayerStuck && guildId && reason) {
            const sanitizedGuildId = `guild_${guildId.substring(0, 4)}...`;
            this.promPlayerStuck.inc({ guild_id: sanitizedGuildId, reason });
        }
    }
    /**
     * Updates the active voice connection gauge.
     * @param count - Active voice connection count.
     */
    setVoiceConnections(count) {
        if (this.promVoiceConnections && Number.isFinite(count)) {
            this.promVoiceConnections.set(count);
        }
    }
    /**
     * Increments voice connection error counter.
     * @param errorType - Error category.
     */
    incrementVoiceConnectionError(errorType) {
        if (this.promVoiceConnectionErrors && errorType) {
            this.promVoiceConnectionErrors.inc({ error_type: errorType });
        }
    }
    /**
     * Updates the active WebSocket connection gauge.
     * @param count - Active WebSocket connection count.
     */
    setWebsocketConnections(count) {
        if (this.promWebsocketConnections && Number.isFinite(count)) {
            this.promWebsocketConnections.set(count);
        }
    }
    /**
     * Increments the WebSocket message counter.
     * @param direction - Direction label (inbound/outbound).
     * @param opType - Operation type label.
     */
    incrementWebsocketMessage(direction, opType) {
        if (this.promWebsocketMessages && direction && opType) {
            this.promWebsocketMessages.inc({ direction, op_type: opType });
        }
    }
    /**
     * Increments session resume counters.
     * @param clientName - Client identifier.
     * @param success - Whether the resume succeeded.
     */
    incrementSessionResume(clientName, success) {
        if (this.promSessionResumes && clientName) {
            this.promSessionResumes.inc({
                client_name: clientName,
                success: success ? 'true' : 'false'
            });
        }
    }
    /**
     * Updates route planner IP counters.
     * @param available - Available IP count.
     * @param banned - Banned IP count.
     */
    setRoutePlannerIps(available, banned) {
        if (this.promRoutePlannerIps && Number.isFinite(available)) {
            this.promRoutePlannerIps.set(available);
        }
        if (this.promRoutePlannerBannedIps && Number.isFinite(banned)) {
            this.promRoutePlannerBannedIps.set(banned);
        }
    }
    /**
     * Increments lyrics provider request counters.
     * @param provider - Provider identifier.
     * @param status - Status label.
     */
    incrementLyricsRequest(provider, status) {
        if (this.promLyricsRequests && provider && status) {
            this.promLyricsRequests.inc({ provider, status });
        }
    }
    /**
     * Increments filter usage counters.
     * @param filterType - Filter identifier.
     */
    incrementFilterUsage(filterType) {
        if (this.promFilterUsage && filterType) {
            this.promFilterUsage.inc({ filter_type: filterType });
        }
    }
    /**
     * Records HTTP request duration for metrics.
     * @param endpoint - Request path.
     * @param method - HTTP method.
     * @param statusCode - HTTP status code.
     * @param durationMs - Request duration in milliseconds.
     */
    recordHttpRequestDuration(endpoint, method, statusCode, durationMs) {
        if (this.promHttpRequestDuration &&
            endpoint &&
            method &&
            statusCode &&
            Number.isFinite(durationMs)) {
            const sanitized = this._sanitizeEndpoint(endpoint);
            this.promHttpRequestDuration.set({ endpoint: sanitized, method, status_code: String(statusCode) }, durationMs);
        }
    }
    /**
     * Increments rate limit hit counters.
     * @param endpoint - Request path.
     * @param ip - Remote IP address.
     */
    incrementRateLimitHit(endpoint, ip) {
        if (this.promRateLimitHits && endpoint && ip) {
            const sanitized = this._sanitizeEndpoint(endpoint);
            const sanitizedIp = this._maskIp(ip);
            this.promRateLimitHits.inc({ endpoint: sanitized, ip: sanitizedIp });
        }
    }
    /**
     * Increments DoS protection block counters.
     * @param ip - Remote IP address.
     * @param reason - Block reason.
     */
    incrementDosProtectionBlock(ip, reason) {
        if (this.promDosProtectionBlocks && ip && reason) {
            const sanitizedIp = this._maskIp(ip);
            this.promDosProtectionBlocks.inc({ ip: sanitizedIp, reason });
        }
    }
    /**
     * Ensures a source stats entry exists and returns it.
     * @param source - Source identifier.
     * @returns The mutable stats entry for the source.
     * @internal
     */
    _initSource(source) {
        if (!this.stats.sources[source]) {
            this.stats.sources[source] = { success: 0, failure: 0 };
        }
        return this.stats.sources[source];
    }
    /**
     * Sanitizes an endpoint string to limit cardinality in metrics.
     * @param endpoint - Raw endpoint path.
     * @returns Normalized endpoint label.
     * @internal
     */
    _sanitizeEndpoint(endpoint) {
        if (!endpoint || typeof endpoint !== 'string')
            return 'unknown';
        const sanitized = endpoint
            .replace(/\/sessions\/[A-Za-z0-9]+/g, '/sessions/:sessionId')
            .replace(/\/players\/[0-9]+/g, '/players/:guildId')
            .replace(/\/tracks\/[A-Za-z0-9_-]+/g, '/tracks/:identifier');
        return sanitized.length > MAX_ENDPOINT_LENGTH
            ? sanitized.slice(0, MAX_ENDPOINT_LENGTH)
            : sanitized;
    }
    /**
     * Increments an endpoint counter with overflow handling.
     * @param counter - Counter map to mutate.
     * @param endpoint - Normalized endpoint label.
     * @internal
     */
    _incrementEndpointCounter(counter, endpoint) {
        if (Object.keys(counter).length > MAX_ENDPOINT_ENTRIES &&
            counter[endpoint] === undefined) {
            counter.others = (counter.others || 0) + 1;
            return;
        }
        counter[endpoint] = (counter[endpoint] || 0) + 1;
    }
    /**
     * Masks an IP address for use in metrics labels.
     * @param ip - Raw IP address.
     * @returns Masked IP label.
     * @internal
     */
    _maskIp(ip) {
        if (!ip)
            return 'unknown';
        if (ip.includes(':'))
            return '[IPv6]';
        const parts = ip.split('.');
        if (parts.length < 2)
            return ip;
        return `${parts.slice(0, 2).join('.')}.xxx.xxx`;
    }
    /**
     * Updates worker-specific metrics gauges from worker payloads.
     * @param workerMetrics - Metrics payload keyed by worker id.
     * @internal
     */
    _updateWorkerMetrics(workerMetrics) {
        if (!this.promWorkerPlayers)
            return;
        try {
            const totalQueueSize = Object.values(workerMetrics).reduce((sum, worker) => sum + safeNumber(worker.stats.commandQueueLength), 0);
            this.promCommandQueueSize?.set(totalQueueSize);
            this.promTotalWorkers?.set(Object.keys(workerMetrics).length);
            for (const [uniqueWorkerId, workerData] of Object.entries(workerMetrics)) {
                const { pid, stats, health, uptime } = workerData;
                const labels = {
                    worker_id: String(uniqueWorkerId),
                    worker_pid: String(pid ?? '')
                };
                this.promWorkerPlayers.set(labels, safeNumber(stats.players));
                this.promWorkerPlayingPlayers?.set(labels, safeNumber(stats.playingPlayers));
                if (stats.memory) {
                    this.promWorkerMemoryUsed?.set(labels, safeNumber(stats.memory.used));
                    this.promWorkerMemoryAllocated?.set(labels, safeNumber(stats.memory.allocated));
                }
                if (stats.cpu) {
                    this.promWorkerCpuLoad?.set(labels, safeNumber(stats.cpu.nodelinkLoad));
                }
                if (stats.eventLoopLag !== undefined && this.promWorkerEventLoopLag) {
                    this.promWorkerEventLoopLag.set(labels, safeNumber(stats.eventLoopLag));
                }
                if (stats.commandQueueLength !== undefined) {
                    this.promWorkerCommandQueueLength?.set(labels, safeNumber(stats.commandQueueLength));
                }
                if (stats.frameStats) {
                    this.promWorkerFramesSent?.set(labels, safeNumber(stats.frameStats.sent));
                    this.promWorkerFramesNulled?.set(labels, safeNumber(stats.frameStats.nulled));
                    this.promWorkerFramesDeficit?.set(labels, safeNumber(stats.frameStats.deficit));
                    this.promWorkerFramesExpected?.set(labels, safeNumber(stats.frameStats.expected));
                }
                if (uptime !== undefined) {
                    this.promWorkerUptime?.set(labels, safeNumber(uptime));
                }
                if (health !== undefined) {
                    this.promWorkerHealth?.set(labels, health ? 1 : 0);
                }
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger('error', 'StatsManager', `Failed to update worker metrics: ${message}`);
        }
    }
}
