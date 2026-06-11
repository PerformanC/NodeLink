import { PassThrough } from 'node:stream';
import { SeekError } from '@ecliptia/seekable-stream';
import discordVoice from '@performanc/voice';
import { EndReasons, GatewayEvents } from "../constants.js";
import { logger } from "../utils.js";
let createAudioResource = null;
let createSeekeableAudioResource = null;
const env = process.env;
const trackFinishMemoryTraceEnabled = env.NODELINK_TRACK_FINISH_MEMORY_TRACE?.toLowerCase() === 'true';
const trackFinishForceGcEnabled = env.NODELINK_TRACK_FINISH_FORCE_GC?.toLowerCase() === 'true';
async function getStreamProcessor() {
    if (createAudioResource && createSeekeableAudioResource)
        return;
    const processor = await import("./processing/streamProcessor.js");
    createAudioResource = processor.createAudioResource;
    createSeekeableAudioResource =
        processor.createSeekeableAudioResource;
}
function isObjectRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Core audio player responsible for voice connection management, stream handling,
 * filter application, fading, lyrics synchronization, mix layers, and stuck-track recovery.
 *
 * @remarks
 * - Establishes and monitors the Discord voice connection via @performanc/voice.
 * - Fetches stream URLs from sources, builds audio resources, and handles gapless playback.
 * - Applies filters, fading, loudness normalization, and PCM mixing through AudioMixer.
 * - Manages lyrics subscription, timing, and drift correction for synced events.
 * - Emits gateway events for all lifecycle transitions (start, end, pause, seek, exceptions).
 */
export class Player {
    nodelink;
    session;
    guildId;
    track = null;
    holoTrack = null;
    nextTrack = null;
    nextResource = null;
    nextStreamInfo = null;
    isPaused = false;
    volumePercent;
    filters = {};
    position = 0;
    connStatus = 'disconnected';
    connection = null;
    voice = {
        sessionId: null,
        token: null,
        endpoint: null,
        channelId: null
    };
    streamInfo = null;
    sponsorBlock;
    profilerStreamStats = {
        downloadedBytes: 0,
        totalBytes: null,
        lastChunkAt: null
    };
    lastManualReconnect = 0;
    audioMixer = null;
    fading;
    loudnessNormalizer;
    _fadeTimers = { trackEnd: null, pause: null, stop: null };
    _isResuming = false;
    _pendingTrackStartFade = false;
    _ignoreIdleStoppedUntil = 0;
    _lyricsBasePosition = 0;
    _lyricsBasePackets = 0;
    _lyricsMarkerTimer = null;
    _audioMixerInitPromise = null;
    isLyricsSubscribed = false;
    currentLyrics = null;
    lyricsLineIndex = -1;
    skipTrackSource = false;
    emitEvent;
    waitEvent;
    _lastPosition = 0;
    _stuckTime = 0;
    _lastStreamDataTime = 0;
    _isRecovering = false;
    destroying = false;
    isUpdatingTrack = false;
    _isRestoring = false;
    _isSeeking = false;
    _isStopping = false;
    _pausedAtPosition = undefined;
    stuckRecoveryCount = 0;
    _positionAtRecoveryStart = 0;
    static MAX_STUCK_RECOVERY_ATTEMPTS = 3;
    constructor(options) {
        if (!options.nodelink ||
            !options.session?.socket ||
            !options.session.userId ||
            !options.guildId) {
            throw new Error('Missing required options');
        }
        this.nodelink = options.nodelink;
        this.session = options.session;
        this.guildId = options.guildId;
        this.volumePercent = this.nodelink.options?.defaultVolume ?? 100;
        this.fading = this.nodelink.options?.playback.audio?.fading;
        this.loudnessNormalizer =
            this.nodelink.options?.playback.audio?.loudnessNormalizer ?? false;
        this.sponsorBlock = {
            enabled: this.nodelink.options.playback.sponsorblock?.enabled ?? false,
            categories: this.nodelink.options.playback.sponsorblock?.categories ?? [
                'sponsor',
                'selfpromo',
                'interaction',
                'intro',
                'outro',
                'preview',
                'music_offtopic',
                'filler'
            ],
            actionTypes: this.nodelink.options.playback.sponsorblock?.actionTypes ?? [
                'skip'
            ],
            segments: [],
            lastSkippedUuid: null,
            skipMarginMs: this.nodelink.options.playback.sponsorblock?.skipMarginMs ?? 150
        };
        logger('debug', 'Player', `New player created for guild ${this.guildId} in session ${this.session.id}`);
        this.emitEvent = (type, payload = {}) => {
            this.nodelink.statsManager.incrementPlaybackEvent(type);
            const eventData = JSON.stringify({
                op: 'event',
                type,
                guildId: this.guildId,
                ...payload
            });
            if (this.session.isPaused) {
                this.session.eventQueue.push(eventData);
                logger('debug', 'Player', `Queued event ${type} for paused session ${this.session.id}`);
                return;
            }
            try {
                this.session.socket.send(eventData);
            }
            catch { }
        };
        this.emitEvent(GatewayEvents.PLAYER_CREATED, {
            guildId: this.guildId,
            player: this.toJSON()
        });
        this.waitEvent = (event, filter, timeout = this.nodelink.options.playback.eventTimeoutMs ?? 15000) => new Promise((resolve, reject) => {
            const handler = (_, payload) => {
                const typedPayload = payload;
                if (!filter || filter(typedPayload)) {
                    clearTimeout(timeoutId);
                    this.connection?.off(event, handler);
                    resolve(typedPayload);
                }
            };
            const timeoutId = setTimeout(() => {
                this.connection?.off(event, handler);
                reject(new Error(`Event ${event} timed out after ${timeout}ms for guild ${this.guildId}`));
            }, timeout);
            this.connection?.on(event, handler);
        });
    }
    _getAudioOptions() {
        return this.nodelink.options.playback.audio;
    }
    _getFilterTransitions() {
        return this._getAudioOptions()?.filterTransitions;
    }
    _getAudioStream() {
        return this.connection?.audioStream ?? null;
    }
    /**
     * Initializes the audio mixer instance used for mix layers and fading.
     */
    async _initAudioMixer() {
        if (this.audioMixer)
            return;
        const { AudioMixer: Mixer } = await import("./processing/AudioMixer.js");
        this.audioMixer = new Mixer(this.nodelink.options?.playback.mix ?? {
            enabled: true,
            defaultVolume: 0.8,
            maxLayersMix: 5,
            autoCleanup: true
        });
        this.audioMixer.on('mixStarted', (data) => {
            this.emitEvent(GatewayEvents.MIX_STARTED, {
                mixId: data.id,
                track: data.track,
                volume: data.volume
            });
        });
        this.audioMixer.on('mixEnded', (data) => {
            this.emitEvent(GatewayEvents.MIX_ENDED, {
                mixId: data.id,
                reason: data.reason
            });
        });
        this.audioMixer.on('mixError', (data) => {
            const errorMessage = data.error ? data.error.message : 'Unknown mix error';
            logger('error', 'Player', `Mix error for ${data.id}: ${errorMessage}`);
        });
    }
    /**
     * Ensures the audio mixer is initialized only once on demand.
     */
    async _ensureAudioMixer() {
        if (this.audioMixer)
            return;
        if (!this._audioMixerInitPromise) {
            this._audioMixerInitPromise = this._initAudioMixer()
                .catch((err) => {
                this._audioMixerInitPromise = null;
                throw err;
            })
                .then(() => {
                this._audioMixerInitPromise = null;
            });
        }
        await this._audioMixerInitPromise;
    }
    /**
     * Establishes the voice connection and attaches event listeners.
     */
    _initConnection() {
        if (this.connection || this.destroying)
            return;
        this.connection = discordVoice.joinVoiceChannel({
            guildId: this.guildId,
            userId: this.session.userId,
            channelId: this.voice.channelId || this.guildId,
            encryption: this.nodelink.options?.playback.audio?.encryption ?? null
        });
        this.connection.stuckTimeout =
            Math.max(this.nodelink.options.playback.trackStuckThresholdMs ?? 10000, 30000) + 5000;
        this.connection.on('stateChange', (_, s) => {
            logger('debug', 'Player', `Voice connection state change for guild ${this.guildId} in session ${this.session.id}: ${s.status}`);
            this._onConn(s);
        });
        this.connection.on('playerStateChange', (_, s) => this._onPlay(s));
        this.connection.on('error', (err) => {
            logger('error', 'Player', `Voice connection error for guild ${this.guildId} in session ${this.session.id}:`, err);
            process.nextTick(() => {
                if (this.destroying)
                    return;
                const playerReason = this.connection?.playerState?.reason;
                if (playerReason === 'reconnecting') {
                    logger('warn', 'Player', `Voice connection error for guild ${this.guildId} is a recoverable reconnection (playerState.reason=${playerReason}). Deferring to library.`);
                    return;
                }
                this._onError(err);
            });
        });
        this.connection.on('stuck', () => {
            if (this.destroying)
                return;
            logger('warn', 'Player', `Voice library detected stuck stream for guild ${this.guildId}`);
        });
        if (this.nodelink.voiceRelay?.attach) {
            this.nodelink.voiceRelay.attach(this.connection, this.guildId);
        }
    }
    /**
     * Handles connection state transitions.
     */
    _onConn(state) {
        if (this.destroying)
            return;
        const previousStatus = this.connStatus;
        this.connStatus = state.status;
        if (state.status === 'connected') {
            logger('info', 'Player', `Voice connection established for guild ${this.guildId} in session ${this.session.id}`);
            this.emitEvent(GatewayEvents.PLAYER_CONNECTED, {
                guildId: this.guildId,
                voice: { ...this.voice }
            });
            if (this.track && this.isPaused && this.connection?.audioStream) {
                this.isPaused = false;
                this.connection.unpause?.('reconnected');
                logger('debug', 'Player', `Unpaused track on reconnection for guild ${this.guildId}`);
            }
        }
        else if (state.status === 'connecting') {
            if (previousStatus !== 'disconnected' || this.connection?.audioStream) {
                logger('info', 'Player', `Voice connection is reconnecting for guild ${this.guildId}`);
                this.emitEvent(GatewayEvents.PLAYER_RECONNECTING, {
                    guildId: this.guildId,
                    voice: { ...this.voice }
                });
            }
        }
        else if (state.status === 'disconnected') {
            const reason = state.reason;
            if (reason === 'reconnect_circuit_breaker') {
                logger('error', 'Player', `Voice connection circuit breaker triggered for guild ${this.guildId}. Too many reconnection attempts.`);
                this.emitEvent(GatewayEvents.TRACK_EXCEPTION, {
                    track: this.track,
                    exception: {
                        message: 'Voice reconnection circuit breaker triggered',
                        severity: 'fault',
                        cause: 'RECONNECT_CIRCUIT_BREAKER'
                    }
                });
            }
            this.emitEvent(GatewayEvents.WEBSOCKET_CLOSED, {
                code: state.code,
                reason: state.closeReason ?? state.reason,
                byRemote: true
            });
        }
        else if (state.status === 'destroyed') {
            logger('warn', 'Player', `Voice connection destroyed for guild ${this.guildId}`);
        }
        this._sendUpdate();
    }
    /**
     * Handles player state changes emitted by the voice connection.
     */
    _onPlay(state) {
        if (this.destroying)
            return;
        logger('debug', 'Player', `Player state change for guild ${this.guildId} in session ${this.session.id}: ${state.status} (reason: ${state.reason})`);
        const endReason = state.reason;
        const endingReasons = [
            EndReasons.STOPPED,
            EndReasons.FINISHED,
            EndReasons.LOAD_FAILED
        ];
        if (state.status === 'idle' &&
            endReason === EndReasons.STOPPED &&
            Date.now() < this._ignoreIdleStoppedUntil &&
            this._isResuming) {
            logger('debug', 'Player', `Ignoring internal idle/stopped during stream swap for guild ${this.guildId}`);
            return;
        }
        if (state.status === 'idle' && state.reason === 'stuck') {
            logger('warn', 'Player', `Track became stuck for guild ${this.guildId}. Triggering immediate recovery.`);
            this._stuckTime =
                (this.nodelink.options.playback.trackStuckThresholdMs ?? 0) + 1;
            this._sendUpdate();
            return;
        }
        if (state.status === 'idle' && this.isUpdatingTrack) {
            if (endReason === EndReasons.STOPPED) {
                logger('debug', 'Player', `Processing stop completion during track update for guild ${this.guildId}`);
            }
            else {
                logger('debug', 'Player', `Ignoring idle event during track replacement for guild ${this.guildId}. Reason: ${state.reason}`);
                return;
            }
        }
        if (state.status === 'idle' &&
            this.track &&
            endReason &&
            endingReasons.includes(endReason)) {
            if (state.reason === EndReasons.FINISHED &&
                this.nextResource &&
                this.nextTrack) {
                const resource = this.nextResource;
                const nextTrack = this.nextTrack;
                const nextStreamInfo = this.nextStreamInfo;
                this._emitTrackEnd(EndReasons.GAPLESS);
                this.track = nextTrack;
                this.nextTrack = null;
                this.nextResource = null;
                this.streamInfo = nextStreamInfo;
                this.nextStreamInfo = null;
                this.position = 0;
                this._lyricsBasePosition = 0;
                this._lyricsBasePackets =
                    this.connection?.statistics?.packetsExpected ?? 0;
                this.connection?.play(resource);
                return;
            }
            if ((this.isUpdatingTrack || this._isSeeking) &&
                state.reason === 'finished') {
                logger('debug', 'Player', `Ignoring spurious idle/finished event during track replacement/seek for guild ${this.guildId}.`);
                return;
            }
            logger('debug', 'Player', `Track ended for guild ${this.guildId}. Reason: ${state.reason}. Current position: ${this._realPosition()}`);
            this._traceTrackFinishMemory('before-cleanup');
            this._cleanupCurrentAudioStream('track-end');
            this._emitTrackEnd(endReason);
            this._resetTrack();
            this._traceTrackFinishMemory('after-reset');
            this._scheduleTrackFinishGcProbe();
        }
        else if (state.status === 'playing' &&
            this.track &&
            !this._isSeeking &&
            (['requested', 'reconnected', 'unpaused'].includes(state.reason ?? '') ||
                this._pendingTrackStartFade)) {
            const wasResuming = this._isResuming;
            this._isResuming = false;
            this.isPaused = false;
            this._lastStreamDataTime = Date.now();
            if (wasResuming) {
                this._fading('trackEndSchedule', {
                    startPosition: this._pausedAtPosition ?? this._realPosition()
                });
                this._pausedAtPosition = undefined;
            }
            else if (!this._isRestoring) {
                this._lyricsBasePackets =
                    this.connection?.statistics?.packetsExpected ?? 0;
                this._fading('trackStart');
                this._emitTrackStart().catch((err) => this._onError(err));
            }
        }
        else if (state.status === 'idle' && state.reason === 'paused') {
            this.isPaused = true;
        }
        else if (state.status === 'idle' && state.reason === 'reconnecting') {
            logger('info', 'Player', `Voice library reports reconnecting for guild ${this.guildId}`);
            this.emitEvent(GatewayEvents.PLAYER_RECONNECTING, {
                guildId: this.guildId,
                voice: { ...this.voice }
            });
        }
    }
    /**
     * Handles playback errors and emits exception events.
     */
    _onError(error) {
        if (this.destroying)
            return;
        if (this.track) {
            let severity = 'fault';
            let cause = 'UNKNOWN_ERROR';
            let shouldStop = true;
            logger('debug', 'Player', `Handling player error for guild ${this.guildId}: ${error.message}`);
            if (error.message.includes('ECONNRESET')) {
                const now = Date.now();
                const reconnectCooldown = 5000;
                if (now - (this.lastManualReconnect || 0) < reconnectCooldown) {
                    logger('warn', 'Player', `Voice connection reset for guild ${this.guildId}. Manual reconnect on cooldown. Relying on library.`);
                }
                else {
                    this.lastManualReconnect = now;
                    logger('warn', 'Player', `Voice connection reset for guild ${this.guildId}. Attempting to manually reconnect.`);
                    this.updateVoice(this.voice, true);
                }
                severity = 'suspicious';
                cause = 'VOICE_CONNECTION_RESET';
                shouldStop = false;
            }
            else if (error.message.includes('stream') ||
                error.message.includes('timeout') ||
                error.name === 'AbortError') {
                logger('warn', 'Player', `Stream error detected for guild ${this.guildId}. Stopping playback.`);
                severity = 'common';
                cause = 'STREAM_ERROR';
                shouldStop = true;
            }
            else if (error instanceof SeekError) {
                logger('error', 'Player', `Seek error for guild ${this.guildId}: ${error.message}. Stopping playback.`);
                severity = 'fault';
                cause = 'SEEK_ERROR';
                shouldStop = true;
            }
            else {
                logger('error', 'Player', `Unhandled player error for guild ${this.guildId}:`, error);
                severity = 'fault';
                cause = `${error.name || 'Error'}: ${error.message}`;
                shouldStop = true;
            }
            this.emitEvent(GatewayEvents.TRACK_EXCEPTION, {
                track: this.track,
                exception: {
                    message: error.message,
                    severity: severity,
                    cause: cause
                }
            });
            this.nodelink.pluginManager?.callHook('onTrackException', this.guildId, this.track, { message: error.message, severity, cause });
            if (shouldStop) {
                this._emitTrackEnd(EndReasons.LOAD_FAILED);
                this.stop();
            }
        }
    }
    /**
     * Resets track and lyric state after a track ends.
     */
    _resetTrack() {
        this._isStopping = false;
        if (this.nextResource) {
            this.nextResource.destroy();
            this.nextResource = null;
            this.nextTrack = null;
            this.nextStreamInfo = null;
        }
        this.track = null;
        this.holoTrack = null;
        this.isPaused = false;
        this.position = 0;
        this._pausedAtPosition = undefined;
        this._lastStreamDataTime = 0;
        this.currentLyrics = null;
        this.lyricsLineIndex = -1;
        this._fading('reset');
        this._lyricsBasePosition = 0;
        this._lyricsBasePackets = this.connection?.statistics?.packetsExpected ?? 0;
        if (this._lyricsMarkerTimer) {
            clearTimeout(this._lyricsMarkerTimer);
            this._lyricsMarkerTimer = null;
        }
    }
    /**
     * Logs memory snapshot for track-finish diagnostics when enabled.
     */
    _traceTrackFinishMemory(stage) {
        if (!trackFinishMemoryTraceEnabled)
            return;
        const m = process.memoryUsage();
        const toMB = (value) => (value / 1024 / 1024).toFixed(2);
        logger('debug', 'Player', `[MEM][TrackFinish][${this.guildId}] ${stage} rss=${toMB(m.rss)}MB heapUsed=${toMB(m.heapUsed)}MB heapTotal=${toMB(m.heapTotal)}MB external=${toMB(m.external)}MB arrayBuffers=${toMB(m.arrayBuffers)}MB`);
    }
    /**
     * Destroys and dereferences current audio stream to avoid lingering references.
     */
    _cleanupCurrentAudioStream(context) {
        const conn = this.connection;
        const audioStream = conn?.audioStream;
        if (!audioStream)
            return;
        try {
            audioStream._cleanupListeners?.();
        }
        catch {
            // Ignore cleanup errors
        }
        if (audioStream.destroyed) {
            if (conn)
                conn.audioStream = null;
            return;
        }
        try {
            audioStream.destroy?.();
            if (Array.isArray(audioStream.pipes)) {
                for (const pipe of audioStream.pipes) {
                    pipe.destroy?.();
                }
            }
            conn?.udp?.flush?.();
        }
        catch (err) {
            logger('debug', 'Player', `Failed to destroy audio stream during ${context} for guild ${this.guildId}: ${err?.message ?? String(err)}`);
        }
        finally {
            if (conn)
                conn.audioStream = null;
        }
    }
    /**
     * Optionally runs forced GC after finish for leak diagnostics.
     */
    _scheduleTrackFinishGcProbe() {
        if (!trackFinishForceGcEnabled)
            return;
        const gcFn = global.gc;
        if (typeof gcFn !== 'function')
            return;
        const timer = setTimeout(() => {
            try {
                gcFn();
                gcFn();
            }
            catch { }
            this._traceTrackFinishMemory('after-gc');
        }, 0);
        timer.unref?.();
    }
    /**
     * Emits TRACK_START and related events after resolving Holo tracks.
     */
    async _emitTrackStart() {
        const trackToEmit = await this._resolveTrackForEvent(this.track);
        this.holoTrack = trackToEmit;
        const format = this.streamInfo?.format;
        const playingQuality = format && typeof format === 'object' && 'itag' in format
            ? (format.itag ?? null)
            : null;
        this.emitEvent(GatewayEvents.TRACK_START, {
            track: trackToEmit,
            playingQuality
        });
        this.nodelink.pluginManager?.callHook('onTrackStart', this.guildId, trackToEmit);
        if (trackToEmit?.info?.sourceName === 'eternalbox') {
            const info = trackToEmit.info;
            const pluginInfo = (trackToEmit.pluginInfo ?? {});
            const spotify = pluginInfo.spotify;
            const links = {
                jukeboxPage: info.uri,
                analysisUrl: pluginInfo.analysisUrl || null,
                streamUrl: pluginInfo.streamUrl || null,
                ogAudioSource: pluginInfo.ogAudioSource || null,
                spotifyUrl: spotify?.url || info.uri || null
            };
            this.emitEvent(GatewayEvents.ETERNALBOX_INFO, {
                track: trackToEmit,
                eternalbox: {
                    id: info.identifier,
                    service: pluginInfo.service || null,
                    analysisSummary: pluginInfo.analysisSummary || null,
                    spotify: pluginInfo.spotify || null,
                    links
                }
            });
        }
        if (this.isLyricsSubscribed) {
            await this._loadLyrics();
        }
    }
    /**
     * Emits TRACK_END event and cleans up mixer layers.
     */
    _emitTrackEnd(reason, extra = {}) {
        const trackToEmit = this.holoTrack || this.track;
        this.emitEvent(GatewayEvents.TRACK_END, {
            track: trackToEmit,
            reason: reason,
            ...extra
        });
        this.nodelink.pluginManager?.callHook('onTrackEnd', this.guildId, trackToEmit, reason);
        if (this.audioMixer?.autoCleanup) {
            this.audioMixer.clearLayers('MAIN_ENDED');
        }
    }
    /**
     * Resolves optional Holo track data for events.
     */
    async _resolveTrackForEvent(track) {
        if (!track)
            return null;
        if (!this.nodelink.options.experimental.enableHoloTracks) {
            return track;
        }
        try {
            const source = this.nodelink.sources.getSource(track.info.sourceName);
            const resolveHoloTrack = source?.resolveHoloTrack;
            if (typeof resolveHoloTrack === 'function') {
                const holoTrack = await resolveHoloTrack.call(source, track, {
                    fetchChannelInfo: this.nodelink.options.search.fetchChannelInfo,
                    resolveExternalLinks: this.nodelink.options.search.resolveExternalLinks
                });
                return holoTrack || track;
            }
        }
        catch (err) {
            const error = err;
            logger('warn', 'Player', `Failed to resolve Holo track: ${error.message}`);
        }
        return track;
    }
    /**
     * Calculates the real playback position considering timescale filters.
     */
    _getTimescale() {
        const filterSettings = this.filters.filters;
        const timescale = filterSettings?.timescale || {};
        return {
            speed: typeof timescale.speed === 'number' ? timescale.speed : 1.0,
            rate: typeof timescale.rate === 'number' ? timescale.rate : 1.0
        };
    }
    _realPosition() {
        const audioStream = this._getAudioStream();
        const playbackSpeed = audioStream?.getEffectiveRate?.() ?? this._getTimescaleSpeed();
        const packets = this.connection?.statistics?.packetsExpected ?? this._lyricsBasePackets;
        const deltaPackets = Math.max(0, packets - this._lyricsBasePackets);
        return this._lyricsBasePosition + deltaPackets * 20 * playbackSpeed;
    }
    _getTimescaleSpeed() {
        const settings = (this.filters.filters ?? this.filters);
        const timescale = settings.timescale || {};
        return (timescale.speed ?? 1.0) * (timescale.rate ?? 1.0);
    }
    /**
     * Captures current position and packet count as a new baseline.
     * Call whenever playback speed changes (filters, tape, scratch).
     */
    _snapshotPosition() {
        if (!this.connection?.audioStream)
            return;
        this._lyricsBasePosition = this._realPosition();
        this._lyricsBasePackets = this.connection.statistics?.packetsExpected ?? 0;
    }
    /**
     * Fetches an audio resource for playback.
     */
    async _fetchResource(info, urlData, startTime) {
        if (this.nodelink.options?.playback.mix?.enabled !== false) {
            await this._ensureAudioMixer();
        }
        await getStreamProcessor();
        const audioResourceFactory = createAudioResource;
        if (!audioResourceFactory) {
            return { exception: { message: 'Stream processor not initialized' } };
        }
        const additionalData = {
            ...urlData.additionalData
        };
        if (startTime !== undefined) {
            additionalData.startTime = startTime;
            // Keep both keys for source compatibility while seek handling is unified.
            additionalData.position = startTime;
        }
        additionalData.guildId = this.guildId;
        additionalData.positionCallback = (positionMs) => {
            if (!Number.isFinite(positionMs) || positionMs < 0)
                return;
            this.position = positionMs;
        };
        urlData.additionalData = additionalData;
        const track = urlData?.newTrack
            ? urlData?.newTrack?.info
            : info;
        const fetched = await this.nodelink.sources.getTrackStream(track, urlData.url, urlData.protocol, additionalData);
        if (fetched.exception)
            return fetched;
        const fetchedStream = fetched.stream;
        const totalBytesRaw = urlData.additionalData?.contentLength ?? null;
        const totalBytesNum = Number(totalBytesRaw);
        this.profilerStreamStats = {
            downloadedBytes: 0,
            totalBytes: Number.isFinite(totalBytesNum) && totalBytesNum > 0
                ? totalBytesNum
                : null,
            lastChunkAt: null
        };
        let streamForResource = fetchedStream;
        if (typeof fetchedStream.on === 'function') {
            const eventStream = fetchedStream;
            const profilerTap = new PassThrough();
            const profilerHandler = (chunk) => {
                const size = typeof chunk === 'string'
                    ? Buffer.byteLength(chunk)
                    : Number(chunk?.length || 0);
                if (size > 0)
                    this.profilerStreamStats.downloadedBytes += size;
                this.profilerStreamStats.lastChunkAt = Date.now();
            };
            profilerTap.on('data', profilerHandler);
            streamForResource = fetchedStream.pipe(profilerTap);
            profilerTap._sourceStream =
                fetchedStream;
            const eternalboxHandler = (data) => {
                this.emitEvent(GatewayEvents.ETERNALBOX_JUMP, {
                    track: this.holoTrack || this.track,
                    eternalbox: data
                });
            };
            const icyHandler = (data) => {
                this.emitEvent(GatewayEvents.STREAM_METADATA, {
                    track: this.holoTrack || this.track,
                    stream: data
                });
            };
            eventStream.on?.('eternalboxJump', eternalboxHandler);
            eventStream.on?.('icyMetadata', icyHandler);
            const cleanupListeners = () => {
                eventStream.off?.('eternalboxJump', eternalboxHandler);
                eventStream.off?.('icyMetadata', icyHandler);
                profilerTap.off('data', profilerHandler);
                profilerTap.destroy();
            };
            streamForResource.on('close', cleanupListeners);
            streamForResource.on('error', cleanupListeners);
            streamForResource._cleanupListeners = cleanupListeners;
        }
        const resource = audioResourceFactory(this.guildId, streamForResource, fetched.type || urlData.format, this.nodelink, this.filters, this.volumePercent / 100, this.audioMixer, false, this.loudnessNormalizer);
        return { stream: resource };
    }
    /**
     * Sends player state updates to the client.
     */
    _sendUpdate() {
        if (!this.connection ||
            (this.isPaused && !this._fadeTimers.pause) ||
            this.connStatus === 'destroyed' ||
            this.destroying)
            return false;
        const position = this._realPosition();
        if (this.sponsorBlock.enabled && this.track) {
            // Periodic log to verify position and sb state
            if (Math.abs(position - this._lastPosition) > 1000 ||
                this._lastPosition === 0) {
                logger('debug', 'Player', `[SponsorBlock][${this.guildId}] Current position: ${Math.round(position)}ms, Segments: ${this.sponsorBlock.segments.length}, LastSkipped: ${this.sponsorBlock.lastSkippedUuid}`);
            }
        }
        const threshold = this.nodelink.options.playback.trackStuckThresholdMs ?? 0;
        if (threshold > 0 &&
            !this.isUpdatingTrack &&
            !this._isStopping &&
            this.track &&
            !this._isResuming &&
            !this.isPaused) {
            if (this._lastPosition === position) {
                this._stuckTime +=
                    this.nodelink.options.playback.playerUpdateInterval ?? 0;
                if (this._stuckTime >= threshold &&
                    !this._isRecovering &&
                    this.connStatus === 'connected') {
                    const stuckTime = this._stuckTime;
                    this._stuckTime = 0;
                    if (this.streamInfo?.format === 'mp4') {
                        logger('error', 'Player', `Player for guild ${this.guildId} is stuck on an MP4 track. Emitting TRACK_STUCK without recovery.`);
                        this.emitEvent(GatewayEvents.TRACK_STUCK, {
                            guildId: this.guildId,
                            track: this.track,
                            thresholdMs: threshold,
                            reason: 'Playback of MP4 track is stuck'
                        });
                        this.nodelink.pluginManager?.callHook('onTrackStuck', this.guildId, this.track, threshold, 'Playback of MP4 track is stuck');
                        this.stop();
                        return false;
                    }
                    if (!this.track.info.isSeekable) {
                        if (this.profilerStreamStats.lastChunkAt &&
                            Date.now() - this.profilerStreamStats.lastChunkAt < threshold) {
                            this._stuckTime = 0;
                            return true;
                        }
                        logger('warn', 'Player', `Player for guild ${this.guildId} is stuck on a non-seekable track. Stopping track.`);
                        this.emitEvent(GatewayEvents.TRACK_STUCK, {
                            guildId: this.guildId,
                            track: this.track,
                            thresholdMs: threshold,
                            reason: 'Track is not seekable'
                        });
                        this.stop();
                        return false;
                    }
                    // reason for this special check:
                    // monochrome does not send 200ms of the final segment (or tidal, idk) so the player thinks its gonna be a recovery
                    // this fixes it by treating as a natural "trackEnd"
                    // for example: an audio is 200000ms long, it will only play until 199800ms before triggering a recovery
                    const trackLength = this.track.info.length;
                    const audioStream = this._getAudioStream();
                    const playbackSpeed = audioStream?.getEffectiveRate?.() ?? this._getTimescaleSpeed();
                    const endThreshold = playbackSpeed < 1.0 ? 5000 : 2000;
                    if (trackLength > 0 && position >= trackLength - endThreshold) {
                        logger('debug', 'Player', `Player for guild ${this.guildId} is near track end (${position}/${trackLength}ms). Treating as natural finish instead of stuck.`);
                        this._emitTrackEnd(EndReasons.FINISHED);
                        this._resetTrack();
                        return false;
                    }
                    if (this.stuckRecoveryCount >= Player.MAX_STUCK_RECOVERY_ATTEMPTS) {
                        logger('error', 'Player', `Player for guild ${this.guildId} exceeded max recovery attempts (${Player.MAX_STUCK_RECOVERY_ATTEMPTS}). Stopping track.`);
                        this.emitEvent(GatewayEvents.TRACK_STUCK, {
                            guildId: this.guildId,
                            track: this.track,
                            thresholdMs: threshold,
                            reason: 'Max recovery attempts exceeded'
                        });
                        this.stop();
                        return false;
                    }
                    logger('warn', 'Player', `Player for guild ${this.guildId} is stuck. Attempting to recover... (attempt ${this.stuckRecoveryCount + 1}/${Player.MAX_STUCK_RECOVERY_ATTEMPTS})`, {
                        lastPosition: this._lastPosition,
                        currentPosition: position,
                        stuckTime: stuckTime,
                        threshold: threshold,
                        connStatus: this.connStatus,
                        lastStreamDataTime: this._lastStreamDataTime > 0
                            ? new Date(this._lastStreamDataTime).toISOString()
                            : 'never',
                        statistics: this.connection?.statistics
                    });
                    this._isRecovering = true;
                    this.stuckRecoveryCount++;
                    this._positionAtRecoveryStart = position;
                    if (this.track.info.identifier && this.track.info.sourceName) {
                        this.nodelink.trackCacheManager?.delete(this.track.info.sourceName, this.track.info.identifier);
                    }
                    const isStream = this.track.info.isStream;
                    const recoveryPosition = isStream ? 0 : this._lastPosition;
                    this.seek(recoveryPosition, this.track.endTime, true)
                        .then((success) => {
                        if (success) {
                            logger('info', 'Player', `Player for guild ${this.guildId} recovered successfully.`);
                        }
                        else {
                            logger('error', 'Player', `Player for guild ${this.guildId} recovery failed. Stopping track.`);
                            this.emitEvent(GatewayEvents.TRACK_STUCK, {
                                guildId: this.guildId,
                                track: this.track,
                                thresholdMs: threshold,
                                reason: 'Recovery attempt failed'
                            });
                            this.stop();
                        }
                        this._isRecovering = false;
                    })
                        .catch((err) => {
                        logger('error', 'Player', `Player for guild ${this.guildId} recovery attempt threw an error: ${err.message}. Stopping track.`);
                        this.emitEvent(GatewayEvents.TRACK_STUCK, {
                            guildId: this.guildId,
                            track: this.track,
                            thresholdMs: threshold,
                            reason: `Recovery attempt failed: ${err.message}`
                        });
                        this.stop();
                        this._isRecovering = false;
                    });
                }
            }
            else {
                this._stuckTime = 0;
                this._isRecovering = false;
            }
        }
        if (position !== this._lastPosition) {
            this._lastStreamDataTime = Date.now();
            if (this.stuckRecoveryCount > 0) {
                const meaningfulAdvance = 2000;
                if (position - this._positionAtRecoveryStart >= meaningfulAdvance) {
                    this.stuckRecoveryCount = 0;
                }
            }
        }
        this._lastPosition = position;
        this._syncLyrics();
        if (this.sponsorBlock.enabled &&
            !this.isPaused &&
            this.track &&
            !this._isResuming &&
            !this._isRecovering &&
            !this._isSeeking) {
            const segment = this.sponsorBlock.segments.find((s) => this.sponsorBlock.categories.includes(s.category) &&
                this.sponsorBlock.actionTypes.includes(s.actionType) &&
                position + this.sponsorBlock.skipMarginMs >= s.start &&
                position < s.end &&
                this.sponsorBlock.lastSkippedUuid !== s.uuid);
            if (segment) {
                this.sponsorBlock.lastSkippedUuid = segment.uuid;
                const skippedMs = segment.end - position;
                logger('info', 'Player', `[SponsorBlock][${this.guildId}] Skipping segment: uuid=${segment.uuid} category=${segment.category} start=${segment.start}ms end=${segment.end}ms (Skipped: ${skippedMs}ms) for video ${this.track.info.identifier}`);
                this.seek(segment.end)
                    .then((success) => {
                    if (success) {
                        logger('debug', 'Player', `[SponsorBlock][${this.guildId}] Successfully jumped to ${segment.end}ms`);
                        this.emitEvent(GatewayEvents.SPONSORBLOCK_SEGMENT_SKIPPED, {
                            track: this.track,
                            segment
                        });
                    }
                    else {
                        logger('warn', 'Player', `[SponsorBlock][${this.guildId}] Failed to jump to ${segment.end}ms for segment ${segment.uuid}`);
                        // fallback: temporarily mute or un-stick if it fails
                        this.sponsorBlock.lastSkippedUuid = null;
                    }
                })
                    .catch((err) => {
                    logger('error', 'Player', `[SponsorBlock][${this.guildId}] Error while seeking to segment end:`, err);
                    this.sponsorBlock.lastSkippedUuid = null;
                });
                return true;
            }
        }
        if (this._isSeeking)
            return true;
        this.session.socket.send(JSON.stringify({
            op: GatewayEvents.PLAYER_UPDATE,
            guildId: this.guildId,
            state: {
                time: Date.now(),
                position,
                connected: this.connStatus === 'connected',
                ping: this.connection && this.connection.ping >= 0
                    ? this.connection.ping
                    : 0
            }
        }));
        return true;
    }
    /**
     * Starts playback for the current track.
     */
    async _startPlayback(startTime = 0) {
        if (!this.track)
            return false;
        const trackInfo = {
            ...this.track.info,
            audioTrackId: this.track.audioTrackId
        };
        const urlData = await this.nodelink.sources.getTrackUrl(trackInfo, undefined, this._isRecovering);
        const urlDataWithFormats = urlData;
        if (!this.track)
            return false;
        this.streamInfo = { ...urlData, trackInfo: this.track.info };
        logger('debug', 'Player', `Got track URL for guild ${this.guildId}`, {
            urlData: {
                ...urlData,
                formats: urlDataWithFormats.formats
                    ? `[${urlDataWithFormats.formats.length} format(s) omitted]`
                    : undefined
            }
        });
        if (urlData.exception) {
            const err = new Error(urlData.exception.message);
            this._onError(err);
            return false;
        }
        if (!this.connection) {
            this._initConnection();
        }
        if (!this.connection?.udpInfo?.secretKey) {
            logger('debug', 'Player', `Waiting for voice connection to be ready for guild ${this.guildId}`);
            await this.waitEvent('stateChange', (s) => s.status === 'connected' && !!this.connection?.udpInfo?.secretKey);
        }
        if (!this.connection?.udpInfo?.secretKey) {
            logger('error', 'Player', `Voice connection for guild ${this.guildId} is not ready, cannot start playback.`);
            this._onError(new Error('Voice connection is not ready.'));
            return false;
        }
        const fetched = await this._fetchResource(this.track.info, urlData, startTime);
        if ('exception' in fetched) {
            const err = new Error(fetched.exception.message);
            this._onError(err);
            return false;
        }
        this._cleanupCurrentAudioStream('start-playback');
        const resource = fetched.stream;
        if (this.volumePercent !== 100) {
            resource.setVolume(this.volumePercent / 100);
        }
        this._fading('trackStartArm', { resource });
        this._fading('trackEndSchedule', { startPosition: startTime || 0 });
        this.setFilters(this.filters);
        logger('debug', 'Player', `Playing resource for guild ${this.guildId}`);
        this._stuckTime = 0;
        this.connection.play(resource);
        await this.waitEvent('playerStateChange', (s) => s.status === 'playing');
        this._lyricsBasePosition = startTime || 0;
        this._lyricsBasePackets = this.connection?.statistics?.packetsExpected ?? 0;
        if (this.track.info.sourceName === 'youtube' ||
            this.track.info.sourceName === 'ytmusic') {
            this.sponsorBlock.segments = [];
            this.sponsorBlock.lastSkippedUuid = null;
            const videoId = this.track.info.identifier;
            const sbConfig = this.nodelink.options.playback.sponsorblock;
            if (this.sponsorBlock.enabled) {
                logger('debug', 'Player', `[SponsorBlock][${this.guildId}] Initiating segment fetch for video ${videoId}`);
                const { fetchSponsorBlockSegments } = await import("../utils.js");
                fetchSponsorBlockSegments(videoId, this.sponsorBlock.categories, this.sponsorBlock.actionTypes, sbConfig?.api)
                    .then((segments) => {
                    if (this.destroying ||
                        !this.track ||
                        this.track.info.identifier !== videoId) {
                        logger('debug', 'Player', `[SponsorBlock][${this.guildId}] Ignoring fetched segments for ${videoId} (track changed or player destroyed)`);
                        return;
                    }
                    this.sponsorBlock.segments = segments;
                    logger('info', 'Player', `[SponsorBlock][${this.guildId}] Applied ${segments.length} segments for video ${videoId}`);
                    if (segments.length > 0) {
                        this.emitEvent(GatewayEvents.SPONSORBLOCK_SEGMENTS_LOADED, {
                            segments
                        });
                        // Immediate check after load
                        this._sendUpdate();
                    }
                })
                    .catch((err) => {
                    logger('error', 'Player', `[SponsorBlock][${this.guildId}] Error fetching segments for ${videoId}:`, err);
                });
            }
            else {
                logger('debug', 'Player', `[SponsorBlock][${this.guildId}] Auto-skip disabled, skipping segment fetch for ${videoId}`);
            }
        }
        return true;
    }
    /**
     * Starts playback for the provided track payload.
     *
     * @param payload - Track data plus playback options.
     * @param payload.noReplace - When true, keeps current track if already playing.
     * @param payload.startTime - Initial seek position in milliseconds.
     * @param payload.endTime - Optional end time to truncate playback.
     * @returns True when the request is accepted (actual start is async).
     */
    async play({ encoded, info, userData, audioTrackId, noReplace = false, startTime, endTime = 0 }) {
        return new Promise((resolve) => {
            this.isUpdatingTrack = true;
            try {
                if (this.destroying) {
                    logger('debug', 'Player', `play() aborted for guild ${this.guildId} because player is destroying`);
                    this.isUpdatingTrack = false;
                    return resolve(false);
                }
                logger('debug', 'Player', `play() called for guild ${this.guildId}`, {
                    encoded,
                    noReplace,
                    startTime,
                    endTime,
                    track: info
                });
                if (noReplace && this.track && this.connection?.audioStream) {
                    const isAlreadyPlaying = this.track?.info.identifier === info.identifier;
                    if (isAlreadyPlaying) {
                        logger('info', 'Player', `play() for guild ${this.guildId} adopted (already playing/transitioning ${info.identifier})`);
                        this.isUpdatingTrack = false;
                        return resolve(true);
                    }
                    logger('debug', 'Player', `play() aborted for guild ${this.guildId} due to noReplace=true and player is active`);
                    this.isUpdatingTrack = false;
                    return resolve(false);
                }
                if (this.track) {
                    this._emitTrackEnd(EndReasons.REPLACED);
                    this._cleanupCurrentAudioStream('track-replaced');
                }
                this._lastStreamDataTime = 0;
                this.track = { encoded, info, endTime, userData, audioTrackId };
                this._fading('reset');
                if (!this.voice.endpoint || !this.voice.token) {
                    logger('debug', 'Player', `No voice state for guild ${this.guildId}, track is enqueued and will play when voice state is provided.`);
                    this.isUpdatingTrack = false;
                    return resolve(true);
                }
                this._startPlayback(startTime !== undefined
                    ? startTime === 0 && this.position < 1000
                        ? 0
                        : startTime
                    : 0)
                    .catch((err) => this._onError(err))
                    .finally(() => {
                    this.isUpdatingTrack = false;
                });
                return resolve(true);
            }
            catch (e) {
                this.isUpdatingTrack = false;
                this._onError(e);
                return resolve(false);
            }
        });
    }
    /**
     * Performs a seek operation to the requested position.
     *
     * @param position - Target position in milliseconds. Uses current position when omitted.
     * @param endTime - Optional end time to enforce after the seek.
     * @returns True when the seek succeeds; false otherwise.
     */
    async seek(position, endTime, forceLegacy = false) {
        if (this.destroying || !this.track)
            return false;
        if (!this.track.info.isSeekable && !this.track.info.isStream)
            return false;
        const streamFormat = typeof this.streamInfo?.format === 'string'
            ? this.streamInfo.format.toLowerCase()
            : '';
        if (streamFormat.includes('flac')) {
            logger('warn', 'Player', `Seeking not supported for FLAC stream on guild ${this.guildId}`);
            return false;
        }
        const seekPosition = position ?? this._realPosition();
        if (seekPosition === 0 &&
            !this._isRecovering &&
            this._realPosition() < 2000) {
            logger('debug', 'Player', 'Ignoring seek to 0 as track has just started.');
            return false;
        }
        if (seekPosition < 0 ||
            (this.track.info.length > 0 && seekPosition > this.track.info.length))
            return false;
        this._isSeeking = true;
        try {
            const sourceName = this.track.info.sourceName;
            const resolvedSourceName = this.streamInfo?.newTrack
                ?.info?.sourceName ?? sourceName;
            const unsupportedSources = ['local', 'deezer'];
            let seekPromise;
            if (!this.streamInfo?.url) {
                logger('debug', 'Player', 'No stream info URL available for seek. awaiting getTrackUrl.');
                const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
                await sleep(1600);
                if (!this.streamInfo?.url) {
                    logger('debug', 'Player', 'Still no stream info URL available for seek.');
                    if (this.track) {
                        const trackInfo = {
                            ...this.track.info,
                            audioTrackId: this.track.audioTrackId
                        };
                        const urlData = await this.nodelink.sources.getTrackUrl(trackInfo);
                        if (!this.track)
                            return false;
                        this.streamInfo = { ...urlData, trackInfo: this.track.info };
                        logger('debug', 'Player', 'Fetched stream info URL for seek after wait.');
                    }
                }
                else {
                    logger('debug', 'Player', 'Stream info URL became available during wait.');
                }
            }
            const source = this.nodelink.sources.getSource(sourceName);
            const hasSourceLoader = source && typeof source.loadStream === 'function';
            const canNativeSeek = !!hasSourceLoader &&
                (this.streamInfo?.protocol === 'sabr' ||
                    (sourceName === 'deezer' && resolvedSourceName === 'deezer'));
            if (forceLegacy) {
                seekPromise = this._legacySeek(seekPosition, endTime !== undefined ? endTime : this.track.endTime);
            }
            else if (canNativeSeek) {
                seekPromise = this._seekUsingSource(seekPosition, endTime !== undefined ? endTime : this.track.endTime);
            }
            else if (!unsupportedSources.includes(resolvedSourceName) &&
                this.streamInfo?.url &&
                this.streamInfo.protocol !== 'hls' &&
                this.streamInfo.protocol !== 'dash') {
                seekPromise = this._seekeableSeek(seekPosition, endTime !== undefined ? endTime : this.track.endTime);
            }
            else {
                seekPromise = this._legacySeek(seekPosition, endTime !== undefined ? endTime : this.track.endTime);
            }
            const startPosition = this._realPosition();
            const result = await seekPromise;
            if (result) {
                this.emitEvent(GatewayEvents.SEEK, {
                    position: this.position,
                    duration: this.position - startPosition
                });
                if (this._lyricsMarkerTimer) {
                    clearTimeout(this._lyricsMarkerTimer);
                    this._lyricsMarkerTimer = null;
                }
                if (this.isLyricsSubscribed)
                    this._recalculateLyricsIndex(undefined, undefined, true);
                this._fading('seek');
                this._fading('trackEndSchedule', { startPosition: this.position });
            }
            return result;
        }
        finally {
            this._isSeeking = false;
        }
    }
    /**
     * Seeks using source-native capabilities (e.g., SABR/Deezer).
     */
    async _seekUsingSource(position, endTime) {
        if (!this.track)
            return false;
        logger('debug', 'Player', `Seeking using source (native) to ${position}ms for guild ${this.guildId}`);
        this.position = position;
        this.track.endTime = endTime;
        let previousSession = null;
        let reuseUrlData = null;
        if (this.streamInfo?.protocol === 'sabr' && this.connection?.audioStream) {
            const inputStream = this.connection.audioStream?.pipes?.[0];
            const previousSession = inputStream?.getSessionState?.();
            if (previousSession) {
                logger('debug', 'Player', `Extracted SABR session state: rn=${previousSession.requestNumber}, hasCookie=${!!previousSession.nextRequestPolicy?.playbackCookie}`);
                reuseUrlData = {
                    protocol: this.streamInfo.protocol,
                    url: this.streamInfo.url,
                    additionalData: {
                        ...this.streamInfo.additionalData,
                        previousSession,
                        startTime: position
                    }
                };
                logger('debug', 'Player', `Reusing existing SABR streaming URL for seek to maintain session`);
            }
        }
        const trackInfo = {
            ...this.track.info,
            audioTrackId: this.track.audioTrackId
        };
        const urlData = reuseUrlData || (await this.nodelink.sources.getTrackUrl(trackInfo));
        this.streamInfo = { ...urlData, trackInfo: this.track.info };
        if (urlData.exception) {
            const err = new Error(urlData.exception.message);
            this._onError(err);
            return false;
        }
        if (!this.connection) {
            this._initConnection();
        }
        if (!this.connection?.udpInfo?.secretKey) {
            await this.waitEvent('stateChange', (s) => s.status === 'connected' && !!this.connection?.udpInfo?.secretKey);
        }
        if (!this.connection?.udpInfo?.secretKey) {
            const errorMessage = `Voice connection for guild ${this.guildId} is not ready (missing UDP info). Aborting playback.`;
            logger('error', 'Player', errorMessage);
            this._onError(new Error(errorMessage));
            return false;
        }
        const fetched = await this._fetchResource(this.track.info, urlData, position);
        if ('exception' in fetched) {
            const err = new Error(fetched.exception.message);
            this._onError(err);
            return false;
        }
        this._cleanupCurrentAudioStream('source-seek');
        const resource = fetched.stream;
        if (this.volumePercent !== 100) {
            resource.setVolume(this.volumePercent / 100);
        }
        this._fading('seekPrepare', { resource });
        this.setFilters(this.filters);
        logger('debug', 'Player', `Playing resource for guild ${this.guildId} after source seek`);
        this.connection.play(resource);
        await this.waitEvent('playerStateChange', (s) => s.status === 'playing');
        this._lyricsBasePosition = position;
        this._lyricsBasePackets = this.connection?.statistics?.packetsExpected ?? 0;
        return true;
    }
    /**
     * Seeks using seekable-stream helper for compatible sources.
     */
    async _seekeableSeek(position, endTime) {
        if (this.nodelink.options?.playback.mix?.enabled !== false) {
            await this._ensureAudioMixer();
        }
        await getStreamProcessor();
        const seekResourceFactory = createSeekeableAudioResource;
        if (!seekResourceFactory) {
            return this._legacySeek(position, endTime);
        }
        logger('debug', 'Player', `Seeking with Seekeable to ${position}ms for guild ${this.guildId}`);
        this.position = position;
        try {
            const url = this.streamInfo?.url;
            if (!url)
                return false;
            const resourceResult = await seekResourceFactory(this.guildId, url, position, endTime, this.nodelink, this.filters, this, this.volumePercent / 100, this.audioMixer);
            if (resourceResult.exception) {
                const exception = resourceResult.exception;
                logger('error', 'Player', `Seekeable resource creation failed for guild ${this.guildId}: ${exception.message}. Falling back to old method.`);
                this.emitEvent(GatewayEvents.TRACK_EXCEPTION, {
                    track: this.track,
                    exception
                });
                this._emitTrackEnd(EndReasons.LOAD_FAILED);
                return this._legacySeek(position, endTime);
            }
            const resource = resourceResult;
            if (this.volumePercent !== 100) {
                resource.setVolume(this.volumePercent / 100);
            }
            this._fading('seekPrepare', { resource });
            resource.setFilters(this.filters);
            const oldStream = this.connection?.play(resource);
            await this.waitEvent('playerStateChange', (s) => s.status === 'playing');
            if (oldStream) {
                oldStream.destroy();
            }
            this._lyricsBasePosition = position;
            this._lyricsBasePackets =
                this.connection?.statistics?.packetsExpected ?? 0;
            return true;
        }
        catch (e) {
            const err = e;
            logger('error', 'Player', `An unexpected error occurred during seekeable seek for guild ${this.guildId}: ${err.message}. Falling back to old method.`);
            this.emitEvent(GatewayEvents.TRACK_EXCEPTION, {
                track: this.track,
                exception: {
                    message: err.message,
                    severity: 'fault',
                    cause: 'UNKNOWN_ERROR'
                }
            });
            this._emitTrackEnd(EndReasons.LOAD_FAILED);
            return this._legacySeek(position, endTime);
        }
    }
    /**
     * Seeks using legacy re-fetch strategy.
     */
    async _legacySeek(position, endTime) {
        if (!this.track)
            return false;
        if (position < 0 ||
            (this.track.info.length > 0 && position > this.track.info.length))
            return false;
        logger('debug', 'Player', `Seeking with legacy method to ${position}ms for guild ${this.guildId}`);
        this.position = position;
        this.track.endTime = endTime;
        const trackInfo = {
            ...this.track.info,
            audioTrackId: this.track.audioTrackId
        };
        const urlData = await this.nodelink.sources.getTrackUrl(trackInfo, undefined, this._isRecovering);
        if (!this.track)
            return false;
        this.streamInfo = { ...urlData, trackInfo: this.track.info };
        if (urlData.exception) {
            const err = new Error(urlData.exception.message);
            this._onError(err);
            return false;
        }
        if (!this.connection) {
            this._initConnection();
        }
        if (!this.connection?.udpInfo?.secretKey) {
            logger('debug', 'Player', `Waiting for voice connection to be ready for guild ${this.guildId}`);
            await this.waitEvent('stateChange', (s) => s.status === 'connected' && !!this.connection?.udpInfo?.secretKey);
        }
        if (!this.connection?.udpInfo?.secretKey) {
            const errorMessage = `Voice connection for guild ${this.guildId} is not ready (missing UDP info). Aborting playback.`;
            logger('error', 'Player', errorMessage);
            this._onError(new Error(errorMessage));
            return false;
        }
        const fetched = await this._fetchResource(this.track.info, urlData, position);
        if ('exception' in fetched) {
            const err = new Error(fetched.exception.message);
            this._onError(err);
            return false;
        }
        this._cleanupCurrentAudioStream('legacy-seek');
        const resource = fetched.stream;
        if (this.volumePercent !== 100) {
            resource.setVolume(this.volumePercent / 100);
        }
        this._fading('seekPrepare', { resource });
        this.setFilters(this.filters);
        logger('debug', 'Player', `Playing resource for guild ${this.guildId} after legacy seek`);
        this.connection.play(resource);
        await this.waitEvent('playerStateChange', (s) => s.status === 'playing');
        this._lyricsBasePosition = position;
        this._lyricsBasePackets = this.connection?.statistics?.packetsExpected ?? 0;
        return true;
    }
    /**
     * Stops playback and emits STOPPED if applicable.
     *
     * @returns True when stop was executed; false when no active track.
     */
    stop() {
        this.isUpdatingTrack = true;
        try {
            if (this.destroying || !this.track)
                return false;
            if (this.nextResource) {
                this.nextResource.destroy();
                this.nextResource = null;
                this.nextTrack = null;
                this.nextStreamInfo = null;
            }
            if (this.connection && this.connStatus !== 'destroyed') {
                if (this.connection.audioStream) {
                    this._isStopping = true;
                    if (this._fading('trackStop'))
                        return true;
                    this._isStopping = false;
                    this.connection.stop(EndReasons.STOPPED);
                }
                else {
                    this._emitTrackEnd(EndReasons.STOPPED);
                    this._resetTrack();
                }
            }
            else {
                this._emitTrackEnd(EndReasons.STOPPED);
                this._resetTrack();
            }
            return true;
        }
        finally {
            this.isUpdatingTrack = false;
        }
    }
    /**
     * Preloads the next track for gapless playback.
     *
     * @param payload - Track to prepare in advance.
     * @returns True when preload succeeded.
     */
    async preload(payload) {
        if (this.destroying)
            return false;
        const sameEncoded = !!payload.encoded &&
            !!this.nextTrack?.encoded &&
            this.nextTrack.encoded === payload.encoded;
        const sameIdentifier = !!payload.info?.identifier &&
            !!this.nextTrack?.info?.identifier &&
            this.nextTrack.info.identifier === payload.info.identifier;
        const isDuplicatePreload = (sameEncoded || sameIdentifier) && !!this.nextResource;
        if (isDuplicatePreload) {
            logger('debug', 'Player', `Skipping duplicate preload for ${this.guildId}`, {
                identifier: payload.info?.identifier,
                encodedMatch: sameEncoded,
                identifierMatch: sameIdentifier
            });
            return true;
        }
        if (this.nextResource) {
            this.nextResource.destroy();
            this.nextResource = null;
            this.nextTrack = null;
            this.nextStreamInfo = null;
        }
        try {
            const trackInfo = {
                ...payload.info,
                audioTrackId: payload.audioTrackId
            };
            const urlData = await this.nodelink.sources.getTrackUrl(trackInfo);
            if (urlData.exception)
                return false;
            const fetched = await this._fetchResource(payload.info, urlData, 0);
            if ('exception' in fetched)
                return false;
            this.nextTrack = payload;
            this.nextResource = fetched.stream;
            this.nextStreamInfo = { ...urlData, trackInfo: payload.info };
            if (this.volumePercent !== 100) {
                this.nextResource.setVolume(this.volumePercent / 100);
            }
            this.nextResource.setFilters(this.filters);
            return true;
        }
        catch (err) {
            const error = err;
            logger('error', 'Player', `Preload failed for guild ${this.guildId}: ${error.message}`);
            return false;
        }
    }
    /**
     * Clears any queued/preloaded next track.
     *
     * @returns True when state was cleared.
     */
    clearNextTrack() {
        if (this.destroying)
            return false;
        if (this.nextResource) {
            this.nextResource.destroy();
            this.nextResource = null;
        }
        this.nextTrack = null;
        this.nextStreamInfo = null;
        return true;
    }
    /**
     * Pauses or resumes playback.
     *
     * @param shouldPause - True to pause, false to resume.
     * @returns True when state changed; false otherwise.
     */
    pause(shouldPause) {
        if (this.destroying || this.isPaused === shouldPause)
            return false;
        logger('debug', 'Player', `Setting pause to ${shouldPause} for guild ${this.guildId}`);
        if (shouldPause) {
            this._pausedAtPosition = this._realPosition();
            if (this._fadeTimers?.trackEnd) {
                clearTimeout(this._fadeTimers.trackEnd);
                this._fadeTimers.trackEnd = null;
            }
            if (this._fading('pause')) {
                this.isPaused = true;
                this.emitEvent(GatewayEvents.PAUSE, { paused: true });
                return true;
            }
            this.isPaused = true;
            this.connection?.pause?.('requested');
        }
        else {
            this.isPaused = false;
            this._isResuming = true;
            this._fading('resume');
            this.connection?.unpause?.('requested');
        }
        this.emitEvent(GatewayEvents.PAUSE, { paused: this.isPaused });
        return true;
    }
    /**
     * Adjusts playback volume (0-1000).
     *
     * @param level - Volume percentage (0-1000).
     * @returns True when volume was updated.
     */
    volume(level) {
        if (this.destroying)
            return false;
        logger('debug', 'Player', `Setting volume to ${level} for guild ${this.guildId}`);
        this.volumePercent = Math.max(0, Math.min(1000, level));
        this.connection?.audioStream?.setVolume(this.volumePercent / 100);
        this.nextResource?.setVolume(this.volumePercent / 100);
        this.emitEvent(GatewayEvents.VOLUME_CHANGED, { volume: this.volumePercent });
        return true;
    }
    /**
     * Sets fading configuration.
     *
     * @param config - New fading config; disables fading when undefined.
     * @returns Always true.
     */
    setFading(config) {
        this.fading = config;
        return true;
    }
    /**
     * Toggles loudness normalization.
     *
     * @param enabled - Whether to enable loudness normalization.
     * @returns True when updated.
     */
    setLoudnessNormalizer(enabled) {
        this.loudnessNormalizer = !!enabled;
        if (this.connection?.audioStream) {
            this.connection.audioStream.setLoudnessNormalizer?.(this.loudnessNormalizer);
        }
        return true;
    }
    /**
     * Applies audio filters to the active stream.
     *
     * @param filters - Filter payload that replaces the active filter set.
     * @returns True when filters applied; false if player inactive.
     */
    setFilters(filters) {
        if (this.destroying || !this.track)
            return false;
        logger('debug', 'Player', `Applying filters for guild ${this.guildId}:`, filters);
        const payload = filters.filters ??
            filters;
        const filterTransitions = this._getFilterTransitions();
        const newFilterSettings = {};
        if (payload && Object.keys(payload).length > 0) {
            for (const key in payload) {
                const value = payload[key];
                if (value === null || value === undefined) {
                    continue;
                }
                if (key === 'equalizer') {
                    if (Array.isArray(value)) {
                        newFilterSettings[key] = { bands: value };
                    }
                    else {
                        newFilterSettings[key] = isObjectRecord(value)
                            ? value
                            : { value };
                    }
                }
                else {
                    const existing = this.filters.filters?.[key];
                    if (existing &&
                        typeof existing === 'object' &&
                        !Array.isArray(existing) &&
                        typeof value === 'object' &&
                        !Array.isArray(value)) {
                        const merged = {
                            ...existing,
                            ...value
                        };
                        const mergedFilter = merged;
                        if (mergedFilter._disabled) {
                            delete mergedFilter._disabled;
                        }
                        newFilterSettings[key] = mergedFilter;
                    }
                    else {
                        newFilterSettings[key] = {
                            ...value
                        };
                        const newFilter = newFilterSettings[key];
                        if (isObjectRecord(newFilter) && newFilter._disabled) {
                            delete newFilter._disabled;
                        }
                    }
                }
                const filterBlock = newFilterSettings[key];
                if (filterBlock &&
                    typeof filterBlock === 'object' &&
                    !filterBlock.transition &&
                    filterTransitions?.enabled) {
                    filterBlock.transition = {
                        durationMs: filterTransitions.durationMs ?? 4000,
                        curve: filterTransitions.curve ?? 'sinusoidal'
                    };
                }
            }
        }
        const oldFilters = this.filters.filters || {};
        for (const key in oldFilters) {
            if (!(key in newFilterSettings)) {
                const existingFilter = oldFilters[key];
                if (existingFilter?._disabled === true)
                    continue;
                newFilterSettings[key] = {
                    _disabled: true,
                    ...(filterTransitions?.enabled
                        ? {
                            transition: {
                                durationMs: filterTransitions.durationMs ?? 4000,
                                curve: filterTransitions.curve ?? 'sinusoidal'
                            }
                        }
                        : {})
                };
            }
        }
        this.filters = { ...this.filters, filters: newFilterSettings };
        if (this.connection?.audioStream) {
            this._snapshotPosition();
            this.connection.audioStream.setFilters(this.filters);
        }
        this.nextResource?.setFilters(this.filters);
        const disabledKeys = [];
        for (const key in newFilterSettings) {
            const val = newFilterSettings[key];
            if (val?._disabled === true) {
                disabledKeys.push(key);
            }
        }
        if (disabledKeys.length > 0) {
            const cleanupDisabledFilters = () => {
                const current = { ...(this.filters.filters ?? {}) };
                let changed = false;
                for (const key of disabledKeys) {
                    const entry = current[key];
                    if (entry?._disabled === true) {
                        delete current[key];
                        changed = true;
                    }
                }
                if (changed) {
                    this.filters = { ...this.filters, filters: current };
                }
            };
            const maxTransitionMs = Math.max(...disabledKeys.map((key) => {
                const val = newFilterSettings[key];
                const tr = val?.transition;
                return tr?.durationMs ?? 0;
            }));
            if (maxTransitionMs <= 0) {
                cleanupDisabledFilters();
            }
            else {
                const cleanupTimer = setTimeout(() => {
                    cleanupDisabledFilters();
                }, maxTransitionMs + 500);
                cleanupTimer.unref?.();
            }
        }
        this.emitEvent(GatewayEvents.FILTERS_CHANGED, { filters: this.filters });
        return true;
    }
    /**
     * Updates the voice state for this player.
     *
     * @param voicePayload - Session/token/endpoint/channel updates.
     * @param force - Forces reconnect even when unchanged.
     */
    updateVoice(voicePayload = {}, force = false) {
        if (this.destroying)
            return;
        const { sessionId, token, endpoint, channelId } = voicePayload;
        let changed = false;
        if (sessionId !== undefined && this.voice.sessionId !== sessionId) {
            this.voice.sessionId = sessionId;
            changed = true;
        }
        if (token !== undefined && this.voice.token !== token) {
            this.voice.token = token;
            changed = true;
        }
        if (endpoint !== undefined && this.voice.endpoint !== endpoint) {
            this.voice.endpoint = endpoint;
            changed = true;
        }
        if (channelId !== undefined && this.voice.channelId !== channelId) {
            this.voice.channelId = channelId;
            changed = true;
        }
        if (this.voice.sessionId && this.voice.token && this.voice.endpoint) {
            if (!changed && !force) {
                logger('debug', 'Player', `Voice state for guild ${this.guildId} is unchanged. Skipping update.`);
                return;
            }
            logger('debug', 'Player', `Updating voice state for guild ${this.guildId}`);
            if (!this.connection)
                this._initConnection();
            if (this.voice.channelId && this.connection) {
                this.connection.channelId = this.voice.channelId;
            }
            this.connection?.voiceStateUpdate({ session_id: this.voice.sessionId });
            if (force && this.connection?.voiceServer) {
                this.connection.voiceServer = null;
            }
            this.connection?.voiceServerUpdate({
                token: this.voice.token,
                endpoint: this.voice.endpoint
            });
            this.connection?.connect(async () => {
                if (this.destroying)
                    return;
                if (this.connection?.audioStream && !this.isPaused) {
                    this.connection.unpause?.('reconnected');
                }
                if (this.track &&
                    !this.connection?.audioStream &&
                    !this.isUpdatingTrack) {
                    logger('debug', 'Player', `Voice state updated for guild ${this.guildId}, starting pending track.`);
                    await this._startPlayback();
                }
            });
        }
        else {
            logger('warn', 'Player', `Incomplete voice update for guild ${this.guildId}. Missing sessionId, token, or endpoint.`);
        }
    }
    /**
     * Destroys the player and cleans up the voice connection.
     *
     * @param emitClose - Whether to emit WEBSOCKET_CLOSED to the client.
     */
    destroy(emitClose = true) {
        if (this.destroying)
            return;
        this.destroying = true;
        logger('debug', 'Player', `Destroying player for guild ${this.guildId}`);
        if (this.connection) {
            try {
                if (this.connection.audioStream) {
                    this.connection.stop(EndReasons.CLEANUP);
                    this._cleanupCurrentAudioStream('destroy');
                }
                this.connection.destroy();
                this.connection = null;
            }
            catch (err) {
                const error = err;
                logger('error', 'internal', `Failed to destroy connection for guild ${this.guildId}: ${error.message} `);
            }
        }
        if (emitClose) {
            this.emitEvent(GatewayEvents.WEBSOCKET_CLOSED, {
                code: 1000,
                reason: 'destroyed by client',
                byRemote: false
            });
        }
        this.emitEvent(GatewayEvents.PLAYER_DESTROYED, {
            guildId: this.guildId
        });
        if (this.audioMixer) {
            this.audioMixer.destroy();
            this.audioMixer = null;
        }
        this._audioMixerInitPromise = null;
        this._resetTrack();
        this.connStatus = 'destroyed';
        this.volumePercent = this.nodelink.options?.defaultVolume ?? 100;
    }
    /**
     * Adds an additional mix layer over the main stream.
     *
     * @param trackPayload - Track to mix in PCM form.
     * @param volume - Optional mix volume (0-1). Defaults to mix config.
     * @throws Error when no active main stream or mixer limits exceeded.
     */
    async addMix(trackPayload, volume = null) {
        if (!this.track || this.isPaused) {
            throw new Error('Cannot add mix without an active stream');
        }
        await this._ensureAudioMixer();
        if (!this.audioMixer)
            throw new Error('AudioMixer not initialized');
        const mixConfig = this.nodelink?.options?.playback.mix ?? {
            enabled: true,
            defaultVolume: 0.8,
            maxLayersMix: 5
        };
        if (this.audioMixer.mixLayers.size >= (mixConfig.maxLayersMix ?? 5)) {
            throw new Error(`Maximum number of mix layers(${mixConfig.maxLayersMix}) reached`);
        }
        const mixVolume = volume ?? mixConfig.defaultVolume ?? 0.8;
        const { createAudioResource: createResource } = await import("./processing/streamProcessor.js");
        const urlData = await this.nodelink.sources.getTrackUrl(trackPayload.info);
        if (!urlData?.url) {
            throw new Error('Failed to get stream URL for mix track');
        }
        const fetched = await this.nodelink.sources.getTrackStream(urlData.newTrack?.info || trackPayload.info, urlData.url, urlData.protocol, urlData.additionalData);
        if (fetched.exception) {
            throw new Error(fetched.exception.message);
        }
        const pcmResource = createResource(this.guildId, fetched.stream, fetched.type || urlData.format || 'unknown', this.nodelink, {}, mixVolume, null, true);
        const mixId = this.audioMixer.addLayer(pcmResource.stream, trackPayload, mixVolume);
        return {
            id: mixId,
            track: trackPayload,
            volume: mixVolume
        };
    }
    /**
     * Removes a mix layer by id.
     *
     * @param mixId - Identifier returned by addMix.
     * @returns True when removed.
     */
    removeMix(mixId) {
        if (!this.audioMixer) {
            return false;
        }
        return this.audioMixer.removeLayer(mixId);
    }
    /**
     * Updates the volume of a mix layer.
     *
     * @param mixId - Identifier of the mix layer.
     * @param volume - New volume (0-1).
     * @returns True when updated; false if layer missing.
     */
    updateMix(mixId, volume) {
        if (!this.audioMixer) {
            return false;
        }
        return this.audioMixer.updateLayerVolume(mixId, volume);
    }
    /**
     * Lists active mix layers.
     *
     * @returns Current mix layers with track and volume.
     */
    getMixes() {
        if (!this.audioMixer) {
            return [];
        }
        return this.audioMixer.getLayers();
    }
    /**
     * Subscribes to lyrics events for the current track.
     *
     * @param skipTrackSource - When true, skips track source provider before fetching lyrics.
     */
    async subscribeLyrics(skipTrackSource) {
        return new Promise((resolve) => {
            if (this.isLyricsSubscribed) {
                return resolve();
            }
            this.isLyricsSubscribed = true;
            this.skipTrackSource =
                skipTrackSource === 'true' || skipTrackSource === true;
            if (this.track && !this.isPaused) {
                this._loadLyrics().catch((error) => {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    logger('warn', 'Lyrics', `Failed to load lyrics for guild ${this.guildId}: ${errorMessage} `);
                });
            }
            return resolve();
        });
    }
    /**
     * Unsubscribes from lyrics events.
     */
    unsubscribeLyrics() {
        return new Promise((resolve) => {
            this.isLyricsSubscribed = false;
            this.skipTrackSource = false;
            this.currentLyrics = null;
            this.lyricsLineIndex = -1;
            if (this._lyricsMarkerTimer) {
                clearTimeout(this._lyricsMarkerTimer);
                this._lyricsMarkerTimer = null;
            }
            return resolve();
        });
    }
    /**
     * Returns current SponsorBlock state for the player.
     *
     * @returns Current segments and configuration.
     */
    getSponsorBlock() {
        return this.sponsorBlock;
    }
    /**
     * Updates SponsorBlock settings for the player.
     *
     * @param updates - Configuration updates.
     */
    updateSponsorBlock(updates) {
        if (updates.enabled !== undefined)
            this.sponsorBlock.enabled = updates.enabled;
        if (updates.categories !== undefined)
            this.sponsorBlock.categories = updates.categories;
        if (updates.actionTypes !== undefined)
            this.sponsorBlock.actionTypes = updates.actionTypes;
    }
    /**
     * Overrides SponsorBlock segments for the current track.
     *
     * @param segments - Array of segments to apply.
     */
    setSponsorBlockSegments(segments) {
        this.sponsorBlock.segments = segments;
        this.sponsorBlock.lastSkippedUuid = null;
    }
    /**
     * Clears SponsorBlock state for the player.
     */
    clearSponsorBlock() {
        this.sponsorBlock.segments = [];
        this.sponsorBlock.lastSkippedUuid = null;
    }
    /**
     * Loads lyrics for the current track and emits events.
     */
    async _loadLyrics() {
        if (!this.track)
            return;
        const lyricsManager = this.nodelink.lyrics ?? (await this.nodelink.getLyricsManager?.());
        if (!lyricsManager)
            return;
        const lyricsData = await lyricsManager.loadLyrics({ info: this.track.info }, undefined, this.skipTrackSource);
        if (lyricsData && lyricsData.loadType === 'lyrics') {
            const lines = lyricsData.data.lines.map((line) => ({
                timestamp: line.time,
                duration: line.duration || 0,
                line: line.text,
                words: line.words || [],
                plugin: {}
            }));
            for (let i = 0; i < lines.length - 1; i++) {
                const current = lines[i];
                const next = lines[i + 1];
                if (!current || !next)
                    continue;
                if (current.duration === 0) {
                    current.duration = next.timestamp - current.timestamp;
                }
            }
            const payload = {
                sourceName: this.track.info.sourceName,
                provider: lyricsData.data.provider,
                text: lyricsData.data.lines.map((l) => l.text).join('\n'),
                lines,
                plugin: {}
            };
            this.currentLyrics = payload;
            this.lyricsLineIndex = -1;
            this.emitEvent('LyricsFoundEvent', { lyrics: this.currentLyrics });
            if (this._lyricsMarkerTimer) {
                clearTimeout(this._lyricsMarkerTimer);
                this._lyricsMarkerTimer = null;
            }
            this._recalculateLyricsIndex(undefined, undefined, true);
            this._syncLyrics(true);
        }
        else {
            this.currentLyrics = null;
            this.emitEvent('LyricsNotFoundEvent');
        }
    }
    /**
     * Synchronizes lyrics with current playback position.
     */
    _syncLyrics(force = false) {
        if (!this.isLyricsSubscribed || !this.currentLyrics?.lines)
            return;
        if (this._lyricsMarkerTimer && !force)
            return;
        const timescale = this._getTimescale();
        const playbackSpeed = timescale.speed * timescale.rate;
        const position = this._getLyricsPosition(playbackSpeed);
        const lines = this.currentLyrics.lines;
        this._recalculateLyricsIndex(position, lines);
        const nextIndex = this.lyricsLineIndex + 1;
        const nextLine = lines[nextIndex];
        if (!nextLine)
            return;
        const nextTimestamp = nextLine.timestamp;
        const delayMs = Math.max(0, (nextTimestamp - position) / playbackSpeed);
        this._lyricsMarkerTimer = setTimeout(() => {
            this._lyricsMarkerTimer = null;
            if (!this.isLyricsSubscribed || !this.currentLyrics?.lines)
                return;
            const timedLine = this.currentLyrics.lines[nextIndex];
            if (!timedLine)
                return;
            const nowPosition = this._getLyricsPosition(playbackSpeed);
            const drift = nowPosition - nextTimestamp;
            if (drift < -15) {
                this._syncLyrics(true);
                return;
            }
            if (Math.abs(drift) > 100) {
                this._lyricsBasePosition -= drift * 0.25;
            }
            this.lyricsLineIndex = nextIndex;
            this.emitEvent('LyricsLineEvent', {
                lineIndex: nextIndex,
                line: timedLine,
                skipped: drift > 60
            });
            this._syncLyrics(true);
        }, delayMs);
    }
    /**
     * Computes current lyrics position based on packets received.
     */
    _getLyricsPosition(playbackSpeed) {
        const stats = this.connection?.statistics;
        const packets = stats?.packetsExpected ?? this._lyricsBasePackets;
        const deltaPackets = Math.max(0, packets - this._lyricsBasePackets);
        return this._lyricsBasePosition + deltaPackets * 20 * playbackSpeed;
    }
    /**
     * Recalculates the current lyric line index.
     */
    _recalculateLyricsIndex(positionOverride, linesOverride, allowBackward = false) {
        if (!this.currentLyrics?.lines)
            return;
        const lines = linesOverride || this.currentLyrics.lines;
        let position = positionOverride;
        if (position === undefined) {
            const timescale = this._getTimescale();
            const playbackSpeed = timescale.speed * timescale.rate;
            position = this._getLyricsPosition(playbackSpeed);
        }
        let foundIndex = -1;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line)
                continue;
            if (line.timestamp <= position) {
                foundIndex = i;
            }
            else {
                break;
            }
        }
        if (!allowBackward && foundIndex < this.lyricsLineIndex) {
            return;
        }
        if (foundIndex !== this.lyricsLineIndex) {
            const skipped = foundIndex > this.lyricsLineIndex + 1;
            this.lyricsLineIndex = foundIndex;
            if (foundIndex !== -1) {
                const line = lines[foundIndex];
                if (!line)
                    return;
                this.emitEvent('LyricsLineEvent', {
                    lineIndex: foundIndex,
                    line: line,
                    skipped
                });
            }
        }
    }
    /**
     * Serializes player state to JSON-safe object.
     */
    toJSON() {
        return {
            guildId: this.guildId,
            track: this.track,
            volume: this.volumePercent,
            fading: this.fading,
            loudnessNormalizer: this.loudnessNormalizer,
            paused: this.isPaused,
            filters: this.filters,
            state: {
                time: Date.now(),
                position: this._realPosition(),
                connected: this.connStatus === 'connected',
                ping: this.connection && this.connection.ping >= 0
                    ? this.connection.ping
                    : 0
            },
            voice: { ...this.voice }
        };
    }
    /**
     * Handles fading, tape, and scratch actions for start/stop/seek/pause events.
     */
    _fading(action, payload = {}) {
        const timers = this._fadeTimers;
        if (!timers)
            return false;
        if (action === 'reset') {
            if (timers.trackEnd)
                clearTimeout(timers.trackEnd);
            if (timers.pause) {
                if (timers.pause instanceof Object && 'interval' in timers.pause) {
                    clearInterval(timers.pause.interval);
                    if (timers.pause.timeout)
                        clearTimeout(timers.pause.timeout);
                }
                else {
                    clearTimeout(timers.pause);
                }
            }
            if (timers.stop) {
                if (typeof timers.stop === 'object' && 'interval' in timers.stop) {
                    clearInterval(timers.stop.interval);
                    if (timers.stop.timeout)
                        clearTimeout(timers.stop.timeout);
                }
                else {
                    clearTimeout(timers.stop);
                }
            }
            timers.trackEnd = null;
            timers.pause = null;
            timers.stop = null;
            this._pendingTrackStartFade = false;
            return false;
        }
        if (action === 'trackEndSchedule' && timers.trackEnd) {
            clearTimeout(timers.trackEnd);
            timers.trackEnd = null;
        }
        if (action === 'trackEndSchedule') {
            if (!this.track?.info)
                return false;
            const total = this.track.endTime && this.track.endTime > 0
                ? this.track.endTime
                : this.track.info.length || 0;
            if (!Number.isFinite(total) || total <= 0)
                return false;
            const startPosition = payload.startPosition || 0;
            const remaining = Math.max(0, total - startPosition);
            const teSection = this.fading?.trackEnd;
            const hasFade = teSection &&
                Number.isFinite(teSection.duration) &&
                teSection.duration > 0;
            const fadeDuration = hasFade ? Math.min(teSection.duration, remaining) : 0;
            const fadeType = hasFade ? teSection.type || 'volume' : 'volume';
            const delay = Math.max(0, remaining - fadeDuration);
            const scratchStyle = (hasFade ? teSection.curve : undefined);
            if (fadeType === 'tape' || fadeType === 'scratch') {
                this._snapshotPosition();
            }
            timers.trackEnd = setTimeout(() => {
                const stream = this.connection?.audioStream;
                if (stream) {
                    if (hasFade && teSection) {
                        if (fadeType === 'volume' || fadeType === 'both') {
                            stream.fadeTo?.(0, fadeDuration, teSection.curve);
                        }
                        if (fadeType === 'tape' || fadeType === 'both') {
                            stream.tapeTo?.(fadeDuration, 'stop', teSection.curve);
                        }
                        const effectiveScratchStyle = [
                            'wash',
                            'backspin',
                            'baby',
                            'stop'
                        ].includes(scratchStyle ?? '')
                            ? scratchStyle
                            : 'wash';
                        if (fadeType === 'scratch') {
                            stream.scratchTo?.(fadeDuration, effectiveScratchStyle);
                        }
                    }
                    if (fadeType !== 'volume' && hasFade) {
                        const safetyTimeout = fadeDuration * 2 + 1500;
                        const trackId = this.track?.info.identifier;
                        setTimeout(() => {
                            if (this.track?.info.identifier === trackId &&
                                !this.isUpdatingTrack &&
                                !this._isStopping) {
                                logger('debug', 'Player', `Safety stop triggered for guild ${this.guildId} after long fade-out ramp.`);
                                this.connection?.stop(EndReasons.FINISHED);
                            }
                        }, safetyTimeout).unref?.();
                    }
                    else if (fadeDuration === 0) {
                        if (this.track && !this.isUpdatingTrack && !this._isStopping) {
                            logger('debug', 'Player', `Scheduled track end for guild ${this.guildId} at ${this.track.info.length}ms`);
                            this.connection?.stop(EndReasons.FINISHED);
                        }
                    }
                    else {
                        const trackId = this.track?.info.identifier;
                        setTimeout(() => {
                            if (this.track?.info.identifier === trackId &&
                                !this.isUpdatingTrack &&
                                !this._isStopping) {
                                logger('debug', 'Player', `Track end after volume fade for guild ${this.guildId}`);
                                this.connection?.stop(EndReasons.FINISHED);
                            }
                        }, fadeDuration + 100).unref?.();
                    }
                }
                if (timers.trackEnd) {
                    clearTimeout(timers.trackEnd);
                    timers.trackEnd = null;
                }
            }, delay);
            return true;
        }
        if (!this.fading || this.fading.enabled !== true)
            return false;
        let section = null;
        if (action === 'trackStart' || action === 'trackStartArm')
            section = this.fading.trackStart;
        else if (action === 'trackStop')
            section = this.fading.trackStop;
        else if (action === 'seek' || action === 'seekPrepare')
            section = this.fading.seek;
        else if (action === 'pause')
            section = this.fading.pause;
        else if (action === 'resume')
            section = this.fading.resume;
        else
            return false;
        if (!section || !Number.isFinite(section.duration) || section.duration <= 0)
            return false;
        const fadeType = section.type || 'volume';
        const scratchStyle = section.curve ||
            'random';
        if (fadeType === 'tape' || fadeType === 'scratch') {
            this._snapshotPosition();
        }
        if (action === 'trackStartArm') {
            const resource = payload.resource;
            if (!resource)
                return false;
            if (fadeType === 'volume' || fadeType === 'both') {
                if (resource.setFadeVolume)
                    resource.setFadeVolume(0);
            }
            if (fadeType === 'tape' || fadeType === 'both') {
                if (resource.tapeTo)
                    resource.tapeTo(0, 'stop');
            }
            if (fadeType === 'scratch') {
                if (resource.scratchTo)
                    resource.scratchTo(0, 'stop');
            }
            this._pendingTrackStartFade = true;
            return true;
        }
        if (action === 'trackStart') {
            if (!this._pendingTrackStartFade)
                return false;
            const stream = payload.resource?.stream ||
                this.connection?.audioStream;
            if (!stream)
                return false;
            this._pendingTrackStartFade = false;
            if (fadeType === 'volume' || fadeType === 'both') {
                if (stream.fadeTo)
                    stream.fadeTo?.(1, section.duration, section.curve);
            }
            if (fadeType === 'tape' || fadeType === 'both') {
                if (stream.tapeTo)
                    stream.tapeTo?.(section.duration, 'start', section.curve);
            }
            if (fadeType === 'scratch') {
                if (stream.scratchTo)
                    stream.scratchTo?.(section.duration, scratchStyle);
            }
            return true;
        }
        if (action === 'seekPrepare') {
            const resource = payload.resource;
            if (!resource)
                return false;
            if (fadeType === 'volume' || fadeType === 'both') {
                if (resource.setFadeVolume)
                    resource.setFadeVolume(0);
            }
            if (fadeType === 'tape' || fadeType === 'both') {
                if (resource.tapeTo)
                    resource.tapeTo(0, 'stop');
            }
            if (fadeType === 'scratch') {
                if (resource.scratchTo)
                    resource.scratchTo(0, 'stop');
            }
            return true;
        }
        if (action === 'seek') {
            const stream = this.connection?.audioStream;
            if (!stream)
                return false;
            if (fadeType === 'volume' || fadeType === 'both') {
                if (stream.setFadeVolume)
                    stream.setFadeVolume(0);
                stream.fadeTo?.(1, section.duration, section.curve);
            }
            if (fadeType === 'tape' || fadeType === 'both') {
                stream.tapeTo?.(section.duration, 'start', section.curve);
            }
            if (fadeType === 'scratch') {
                stream.scratchTo?.(section.duration, 'start');
            }
            return true;
        }
        if (action === 'pause') {
            const stream = this.connection?.audioStream;
            if (!stream)
                return false;
            logger('debug', 'Player', `Pause fade triggered for guild ${this.guildId}`);
            if (timers.trackEnd) {
                clearTimeout(timers.trackEnd);
                timers.trackEnd = null;
            }
            if (timers.pause) {
                if (timers.pause instanceof Object && 'interval' in timers.pause) {
                    const pauseTimer = timers.pause;
                    clearInterval(pauseTimer.interval);
                    if (pauseTimer.timeout)
                        clearTimeout(pauseTimer.timeout);
                }
                else {
                    clearTimeout(timers.pause);
                }
            }
            if (fadeType === 'volume' || fadeType === 'both') {
                stream.fadeTo?.(0, section.duration, section.curve);
            }
            if (fadeType === 'tape' || fadeType === 'both') {
                stream.tapeTo?.(section.duration, 'stop', section.curve);
            }
            if (fadeType === 'scratch') {
                const style = ['wash', 'backspin', 'baby', 'stop'].includes(scratchStyle)
                    ? scratchStyle
                    : 'wash';
                stream.scratchTo?.(section.duration, style);
            }
            const startTime = Date.now();
            const checkInterval = setInterval(() => {
                const elapsed = Date.now() - startTime;
                const isTapeDone = stream.checkTapeRampCompleted?.();
                const isScratchDone = stream.checkScratchEffectCompleted?.();
                const effectsDone = (fadeType !== 'tape' || isTapeDone === true) &&
                    (fadeType !== 'scratch' || isScratchDone === true) &&
                    (fadeType !== 'both' ||
                        (isTapeDone === true && isScratchDone === true));
                const isRampDone = elapsed >= section.duration && effectsDone;
                const isTimeUp = elapsed > section.duration + 500; // Safety timeout
                if (isRampDone || isTimeUp) {
                    clearInterval(checkInterval);
                    const drainTimeout = setTimeout(() => {
                        this.connection?.pause?.('requested');
                        timers.pause = null;
                    }, 750);
                    const pauseTimer = timers.pause;
                    if (pauseTimer &&
                        typeof pauseTimer === 'object' &&
                        'interval' in pauseTimer) {
                        pauseTimer.timeout = drainTimeout;
                    }
                }
            }, 10);
            timers.pause = { interval: checkInterval };
            return true;
        }
        if (action === 'resume') {
            const stream = this.connection?.audioStream;
            if (!stream)
                return false;
            logger('debug', 'Player', `Resume fade triggered for guild ${this.guildId}`);
            if (fadeType === 'volume' || fadeType === 'both') {
                if (stream.setFadeVolume)
                    stream.setFadeVolume(0);
                stream.fadeTo?.(1, section.duration, section.curve);
            }
            if (fadeType === 'tape' || fadeType === 'both') {
                stream.tapeTo?.(0, 'stop');
                stream.tapeTo?.(section.duration, 'start', section.curve);
            }
            if (fadeType === 'scratch') {
                stream.scratchTo?.(0, 'stop');
                stream.scratchTo?.(section.duration, 'start');
            }
            return true;
        }
        if (action === 'trackStop') {
            const stream = this.connection?.audioStream;
            if (!stream)
                return false;
            if (timers.stop) {
                if (typeof timers.stop === 'object' && 'interval' in timers.stop) {
                    clearInterval(timers.stop.interval);
                    if (timers.stop.timeout)
                        clearTimeout(timers.stop.timeout);
                }
                else {
                    clearTimeout(timers.stop);
                }
            }
            if (fadeType === 'volume' || fadeType === 'both') {
                stream.fadeTo?.(0, section.duration, section.curve);
            }
            if (fadeType === 'tape' || fadeType === 'both') {
                stream.tapeTo?.(section.duration, 'stop', section.curve);
            }
            if (fadeType === 'scratch') {
                const style = ['wash', 'backspin', 'baby', 'stop'].includes(scratchStyle)
                    ? scratchStyle
                    : 'stop';
                stream.scratchTo?.(section.duration, style);
            }
            const startTime = Date.now();
            const checkInterval = setInterval(() => {
                const elapsed = Date.now() - startTime;
                const isRampDone = elapsed >= section.duration;
                const isTimeUp = elapsed > section.duration + 500; // Safety timeout
                if (isRampDone || isTimeUp) {
                    clearInterval(checkInterval);
                    const drainTimeout = setTimeout(() => {
                        this._isStopping = false;
                        this.connection?.stop(EndReasons.STOPPED);
                        timers.stop = null;
                    }, 750);
                    if (timers.stop &&
                        typeof timers.stop === 'object' &&
                        'interval' in timers.stop) {
                        timers.stop.timeout = drainTimeout;
                    }
                }
            }, 10);
            timers.stop = { interval: checkInterval };
            return true;
        }
        return false;
    }
}
