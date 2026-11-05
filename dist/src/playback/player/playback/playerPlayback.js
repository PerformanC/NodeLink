import { SeekError } from '@ecliptia/seekable-stream';
import { EndReasons, GatewayEvents } from '../../../constants.js';
import { logger } from '../../../utils.js';
import { AutoMixRegistry } from '../../processing/AutoMixRegistry.js';
import { DuckingController } from '../../processing/DuckingController.js';
import { createSeekeableAudioResource, getStreamProcessor, isObjectRecord, isWebmYouTubePlayback } from '../base/playerResources.js';
export class PlayerPlayback {
    recovery;
    seeking;
    runtime;
    clock;
    connectionController;
    transitionController;
    resourceLoader;
    sponsorBlockController;
    lyricsController;
    mixController;
    constructor(runtime, transitions) {
        this.runtime = runtime;
        this.transitionController = transitions;
        this.volumePercent = runtime.nodelink.options.defaultVolume ?? 100;
        this.loudnessNormalizer =
            runtime.nodelink.options.playback.audio?.loudnessNormalizer ?? false;
        const duckingConfig = this._resolveDuckingConfig();
        if (duckingConfig.enabled)
            this.duckingController = new DuckingController(runtime.guildId, duckingConfig);
    }
    track = null;
    holoTrack = null;
    nextTrack = null;
    nextResource = null;
    _currentResource = null;
    nextStreamInfo = null;
    nextResourceIsCrossfade = false;
    _preloadRequest = 0;
    isPaused = false;
    volumePercent;
    filters = {};
    streamInfo = null;
    loudnessNormalizer;
    duckingController = null;
    _isResuming = false;
    _ignoreIdleStoppedUntil = 0;
    _resumePositionMs = null;
    destroying = false;
    isUpdatingTrack = false;
    _isRestoring = false;
    _isStopping = false;
    _pausedAtPosition = undefined;
    _getAudioOptions() {
        return this.runtime.nodelink.options.playback.audio;
    }
    _getFilterTransitions() {
        return this._getAudioOptions()?.filterTransitions;
    }
    _onPlay(state) {
        if (this.destroying)
            return;
        logger('debug', 'Player', `Player state change for guild ${this.runtime.guildId} in session ${this.runtime.session.id}: ${state.status} (reason: ${state.reason})`);
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
            logger('debug', 'Player', `Ignoring internal idle/stopped during stream swap for guild ${this.runtime.guildId}`);
            return;
        }
        if (state.status === 'idle' && state.reason === 'stuck') {
            logger('warn', 'Player', `Track became stuck for guild ${this.runtime.guildId}. Triggering immediate recovery.`);
            this.recovery._stuckTime =
                (this.runtime.nodelink.options.playback.trackStuckThresholdMs ?? 0) + 1;
            this.recovery._sendUpdate();
            return;
        }
        if (state.status === 'idle' && this.isUpdatingTrack) {
            if (endReason === EndReasons.STOPPED) {
                logger('debug', 'Player', `Processing stop completion during track update for guild ${this.runtime.guildId}`);
            }
            else {
                logger('debug', 'Player', `Ignoring idle event during track replacement for guild ${this.runtime.guildId}. Reason: ${state.reason}`);
                return;
            }
        }
        if (state.status === 'idle' &&
            this.track &&
            endReason &&
            endingReasons.includes(endReason)) {
            if (state.reason === EndReasons.FINISHED &&
                this.nextResource &&
                this.nextTrack &&
                !this.nextResourceIsCrossfade) {
                const resource = this.nextResource;
                const nextTrack = this.nextTrack;
                const nextStreamInfo = this.nextStreamInfo;
                this._emitTrackEnd(EndReasons.GAPLESS);
                this.track = nextTrack;
                this.nextTrack = null;
                this.nextResource = null;
                this.streamInfo = nextStreamInfo;
                this.nextStreamInfo = null;
                this.clock.position = 0;
                this.clock._resetAudioConsumptionBaseline(0);
                this.clock._lyricsBasePosition = 0;
                this.clock._lyricsBasePackets =
                    this.connectionController.connection?.statistics?.playbackPackets ?? 0;
                this.transitionController._fading('trackEndSchedule', {
                    startPosition: 0
                });
                const oldStream = this.connectionController.connection?.play(resource);
                if (oldStream)
                    oldStream.destroy();
                if (this._currentResource && this._currentResource !== resource) {
                    try {
                        this._currentResource.destroy();
                    }
                    catch { }
                }
                this._currentResource = resource;
                if (this.duckingController && this.connectionController.connection) {
                    this.duckingController.attach(this.connectionController.connection);
                    this.duckingController.setStreamControl({
                        fadeTo: (volume, durationMs, curve) => resource.fadeTo(volume, durationMs, curve)
                    });
                }
                return;
            }
            if ((this.isUpdatingTrack || this.seeking._isSeeking) &&
                state.reason === 'finished') {
                logger('debug', 'Player', `Ignoring spurious idle/finished event during track replacement/seek for guild ${this.runtime.guildId}.`);
                return;
            }
            logger('debug', 'Player', `Track ended for guild ${this.runtime.guildId}. Reason: ${state.reason}. Current position: ${this.clock._realPosition()}`);
            this.resourceLoader._traceTrackFinishMemory('before-cleanup');
            this.resourceLoader._cleanupCurrentAudioStream('track-end');
            this._emitTrackEnd(endReason);
            this._resetTrack();
            this.resourceLoader._traceTrackFinishMemory('after-reset');
        }
        else if (state.status === 'playing' &&
            this.track &&
            !this.seeking._isSeeking &&
            (['requested', 'reconnected', 'unpaused'].includes(state.reason ?? '') ||
                this.transitionController._pendingTrackStartFade)) {
            const wasResuming = this._isResuming;
            this._isResuming = false;
            this.isPaused = false;
            this.recovery._lastStreamDataTime = Date.now();
            if (wasResuming) {
                this.transitionController._fading('trackEndSchedule', {
                    startPosition: this._pausedAtPosition ?? this.clock._realPosition()
                });
                this._pausedAtPosition = undefined;
            }
            else if (!this._isRestoring) {
                this.clock._lyricsBasePackets =
                    this.connectionController.connection?.statistics?.playbackPackets ?? 0;
                this.transitionController._fading('trackStart');
                this._emitTrackStart().catch((error) => this._onError(error));
            }
        }
        else if (state.status === 'idle' &&
            (state.reason === 'paused' || state.reason === 'requested')) {
            this.isPaused = true;
        }
        else if (state.status === 'idle' && state.reason === 'reconnecting') {
            logger('info', 'Player', `Voice library reports reconnecting for guild ${this.runtime.guildId}`);
            this.runtime.emitEvent(GatewayEvents.PLAYER_RECONNECTING, {
                guildId: this.runtime.guildId,
                voice: structuredClone(this.connectionController.voice)
            });
        }
    }
    _onError(error) {
        if (this.destroying)
            return;
        if (this.track) {
            let severity = 'fault';
            let cause = 'UNKNOWN_ERROR';
            let shouldStop = true;
            logger('debug', 'Player', `Handling player error for guild ${this.runtime.guildId}: ${error.message}`);
            if (error.cause === 'VOICE_CONNECTION_TIMEOUT' ||
                error.message === 'Voice connection timed out') {
                logger('warn', 'Player', `Voice connection timed out for guild ${this.runtime.guildId}. Stopping this playback attempt.`);
                severity = 'suspicious';
                cause = 'VOICE_CONNECTION_TIMEOUT';
            }
            else if (error.cause === 'VOICE_STATE_TIMEOUT') {
                logger('warn', 'Player', `Voice playback state timed out for guild ${this.runtime.guildId}. Stopping this playback attempt.`);
                severity = 'suspicious';
                cause = 'VOICE_STATE_TIMEOUT';
            }
            else if (error.message.includes('stream') ||
                error.message.includes('timeout') ||
                error.message.includes('timed out') ||
                error.name === 'AbortError') {
                logger('warn', 'Player', `Stream error detected for guild ${this.runtime.guildId}. Stopping playback.`);
                severity = 'common';
                cause = 'STREAM_ERROR';
                shouldStop = true;
            }
            else if (error instanceof SeekError) {
                logger('error', 'Player', `Seek error for guild ${this.runtime.guildId}: ${error.message}. Stopping playback.`);
                severity = 'fault';
                cause = 'SEEK_ERROR';
                shouldStop = true;
            }
            else {
                logger('error', 'Player', `Unhandled player error for guild ${this.runtime.guildId}:`, error);
                severity = 'fault';
                cause = `${error.name || 'Error'}: ${error.message}`;
                shouldStop = true;
            }
            this.runtime.emitEvent(GatewayEvents.TRACK_EXCEPTION, {
                track: this.track,
                exception: {
                    message: error.message,
                    severity: severity,
                    cause: cause
                }
            });
            this.runtime.nodelink.pluginManager?.callHook('onTrackException', this.runtime.guildId, this.track, { message: error.message, severity, cause });
            if (shouldStop) {
                this._emitTrackEnd(EndReasons.LOAD_FAILED);
                this.stop();
            }
        }
    }
    _resetTrack() {
        this._preloadRequest += 1;
        this._isStopping = false;
        this.transitionController._destroyCrossfadeResources();
        this.transitionController._crossfadePreparationSafetyMs = 0;
        if (this.nextResource) {
            this.nextResource.destroy();
            this.nextResource = null;
            this.nextTrack = null;
            this.nextStreamInfo = null;
        }
        this.nextResourceIsCrossfade = false;
        this.nextTrack = null;
        this.nextStreamInfo = null;
        this.track = null;
        this.holoTrack = null;
        this.isPaused = false;
        this.clock.position = 0;
        this._pausedAtPosition = undefined;
        this._resumePositionMs = null;
        this.recovery._lastStreamDataTime = 0;
        this.streamInfo = null;
        this.sponsorBlockController.sponsorBlock.segments = [];
        this.lyricsController.currentLyrics = null;
        this.lyricsController.lyricsLineIndex = -1;
        this.transitionController._fading('reset');
        this.mixController._destroyAudioMixer();
        this.clock._lyricsBasePosition = 0;
        this.clock._lyricsBasePackets =
            this.connectionController.connection?.statistics?.playbackPackets ?? 0;
        if (this.lyricsController._lyricsMarkerTimer) {
            clearTimeout(this.lyricsController._lyricsMarkerTimer);
            this.lyricsController._lyricsMarkerTimer = null;
        }
    }
    async _emitTrackStart() {
        const trackToEmit = await this._resolveTrackForEvent(this.track);
        this.holoTrack = trackToEmit;
        const format = this.streamInfo?.format;
        const playingQuality = format && typeof format === 'object' && 'itag' in format
            ? (format.itag ?? null)
            : null;
        this.runtime.emitEvent(GatewayEvents.TRACK_START, {
            track: trackToEmit,
            playingQuality
        });
        this.runtime.nodelink.pluginManager?.callHook('onTrackStart', this.runtime.guildId, trackToEmit);
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
            this.runtime.emitEvent(GatewayEvents.ETERNALBOX_INFO, {
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
        if (this.lyricsController.isLyricsSubscribed) {
            await this.lyricsController._loadLyrics();
        }
    }
    _emitTrackEnd(reason, extra = {}) {
        const trackToEmit = this.holoTrack || this.track;
        this.runtime.emitEvent(GatewayEvents.TRACK_END, {
            track: trackToEmit,
            reason: reason,
            ...extra
        });
        this.runtime.nodelink.pluginManager?.callHook('onTrackEnd', this.runtime.guildId, trackToEmit, reason);
        if (this.mixController.audioMixer?.autoCleanup) {
            this.mixController.audioMixer.clearLayers('MAIN_ENDED');
        }
    }
    async _resolveTrackForEvent(track) {
        if (!track)
            return null;
        if (!this.runtime.nodelink.options.experimental.enableHoloTracks) {
            return track;
        }
        try {
            const source = this.runtime.nodelink.sources.getSource(track.info.sourceName);
            const resolveHoloTrack = source?.resolveHoloTrack;
            if (resolveHoloTrack) {
                const holoTrack = await resolveHoloTrack.call(source, track, {
                    fetchChannelInfo: this.runtime.nodelink.options.search.fetchChannelInfo,
                    resolveExternalLinks: this.runtime.nodelink.options.search.resolveExternalLinks
                });
                return holoTrack || track;
            }
        }
        catch (cause) {
            const error = cause;
            logger('warn', 'Player', `Failed to resolve Holo track: ${error.message}`);
        }
        return track;
    }
    async _connectAndPlayStream(urlData, position, cleanupReason, fadingAction, playLogMessage, preserveQueuedCrossfade = false, suppressErrorEvents = false) {
        if (!this.track)
            return false;
        const playbackTrack = this.track;
        if (!this.connectionController.connection) {
            this.connectionController._initConnection();
        }
        if (!this.connectionController._isVoiceReady()) {
            this.connectionController._ensureVoiceConnection();
        }
        if (!this.connectionController._isVoiceReady()) {
            logger('debug', 'Player', `Waiting for voice connection to be ready for guild ${this.runtime.guildId}`);
            try {
                await this.connectionController.waitForReady();
            }
            catch (error) {
                logger('warn', 'Player', `Timeout or error while waiting for voice connection on guild ${this.runtime.guildId}:`, error);
            }
        }
        if (this.destroying || this.track !== playbackTrack)
            return false;
        if (!this.connectionController.connection ||
            !this.connectionController._isVoiceReady()) {
            if (!suppressErrorEvents) {
                this._onError(new Error(`Voice connection timed out for guild ${this.runtime.guildId} (missing UDP info).`, { cause: 'VOICE_CONNECTION_TIMEOUT' }));
            }
            return false;
        }
        const resolvedSourceName = urlData.newTrack?.info
            ?.sourceName ?? this.track.info.sourceName;
        const unsupportedSeekSources = ['local', 'deezer'];
        const seekEligible = position > 0 &&
            !!urlData.url &&
            !unsupportedSeekSources.includes(resolvedSourceName) &&
            !isWebmYouTubePlayback(resolvedSourceName, urlData) &&
            urlData.protocol !== 'sabr' &&
            urlData.protocol !== 'hls' &&
            urlData.protocol !== 'dash';
        const seekUrl = seekEligible ? urlData.url : undefined;
        if (seekUrl) {
            await getStreamProcessor();
            if (this.destroying || this.track !== playbackTrack)
                return false;
        }
        let resource;
        if (seekUrl && createSeekeableAudioResource) {
            logger('debug', 'Player', `Seeking with Seekeable to ${position}ms for guild ${this.runtime.guildId}`);
            const seekResult = await createSeekeableAudioResource(this.runtime.guildId, seekUrl, position, this.track?.endTime, this.runtime.nodelink, this.filters, this, this.volumePercent / 100, this.mixController.audioMixer, false, this.loudnessNormalizer, this.transitionController._getCrossfadeConfig() !== null);
            if (this.destroying || this.track !== playbackTrack) {
                if (!('exception' in seekResult))
                    seekResult.destroy();
                return false;
            }
            if ('exception' in seekResult) {
                logger('error', 'Player', `Seekeable resource creation failed for guild ${this.runtime.guildId}: ${seekResult.exception.message}. Falling back to old method.`);
            }
            else {
                resource = seekResult;
            }
        }
        if (!resource) {
            const fetched = await this.resourceLoader._fetchResource(this.track.info, urlData, position);
            if (this.destroying || this.track !== playbackTrack) {
                if (!('exception' in fetched))
                    fetched.stream.destroy();
                return false;
            }
            if ('exception' in fetched) {
                if (!suppressErrorEvents) {
                    const error = new Error(fetched.exception.message);
                    this._onError(error);
                }
                return false;
            }
            resource = fetched.stream;
        }
        this.resourceLoader._cleanupCurrentAudioStream(cleanupReason, preserveQueuedCrossfade);
        if (this.volumePercent !== 100) {
            resource.setVolume(this.volumePercent / 100);
        }
        this.transitionController._fading(fadingAction, { resource });
        this.setFilters(this.filters);
        logger('debug', 'Player', playLogMessage);
        this._currentResource = resource;
        this.clock._resetAudioConsumptionBaseline(position);
        this.connectionController.connection.play(resource);
        // Connect ducking controller to the new audio stream
        if (this.duckingController) {
            this.duckingController.attach(this.connectionController.connection);
            this.duckingController.setStreamControl({
                fadeTo: (volume, durationMs, curve) => resource.fadeTo(volume, durationMs, curve)
            });
        }
        await this.connectionController.waitEvent('playerStateChange', (s) => s.status === 'playing');
        if (this.destroying || this.track !== playbackTrack)
            return false;
        this.clock._lyricsBasePosition = position;
        this.clock._lyricsBasePackets =
            this.connectionController.connection?.statistics?.playbackPackets ?? 0;
        return true;
    }
    async _startPlayback(startTime = 0) {
        if (!this.track)
            return false;
        const playbackTrack = this.track;
        const trackInfo = {
            ...this.track.info,
            audioTrackId: this.track.audioTrackId
        };
        const urlData = await this.runtime.nodelink.sources.getTrackUrl(trackInfo, undefined, this.recovery._isRecovering);
        if (this.destroying || this.track !== playbackTrack)
            return false;
        if (urlData.newTrack?.info &&
            urlData.newTrack.info.identifier !== trackInfo.identifier) {
            this.track.pluginInfo = {
                ...(this.track.pluginInfo || {}),
                mirroredTrack: urlData.newTrack.info
            };
        }
        this.streamInfo = { ...urlData, trackInfo: this.track.info };
        logger('debug', 'Player', `Got track URL for guild ${this.runtime.guildId}`, {
            urlData
        });
        if (urlData.exception) {
            const error = new Error(urlData.exception.message);
            this._onError(error);
            return false;
        }
        const result = await this._connectAndPlayStream(urlData, startTime, 'start-playback', 'trackStartArm', `Playing resource for guild ${this.runtime.guildId}`, true);
        if (!result)
            return false;
        this.transitionController._fading('trackEndSchedule', {
            startPosition: startTime || 0
        });
        this.recovery._stuckTime = 0;
        if (this.nextTrack && this.nextResourceIsCrossfade) {
            this.transitionController._scheduleCrossfadePreparation(startTime || 0);
        }
        const crossfadeConfig = this.transitionController._getCrossfadeConfig();
        const trackDurationMs = this.track.endTime && this.track.endTime > 0
            ? this.track.endTime
            : this.track.info.length || 0;
        if (crossfadeConfig &&
            !this.track.info.isStream &&
            trackDurationMs > 30000) {
            const currentTrack = this.track;
            const currentUrlData = urlData;
            AutoMixRegistry.getInstance()
                .requestOutroAnalysis({
                track: currentTrack,
                urlData: currentUrlData,
                priority: 'CURRENT_OUTRO',
                triggerSource: `player:${this.runtime.guildId}:trackStart`,
                fetchResource: (info, urlData, windowStartMs, returnPcm) => this.resourceLoader._fetchResource(info, urlData, windowStartMs, returnPcm)
            })
                .catch((error) => {
                logger('debug', 'Player', `[AutoMix] Background outro analysis failed for ${currentTrack.info.identifier}: ${error.message}`);
            });
        }
        if (this.track.info.sourceName === 'youtube' ||
            this.track.info.sourceName === 'ytmusic') {
            this.sponsorBlockController.sponsorBlock.segments = [];
            this.sponsorBlockController.sponsorBlock.lastSkippedUuid = null;
            const videoId = this.track.info.identifier;
            const sbConfig = this.runtime.nodelink.options.playback.sponsorblock;
            if (this.sponsorBlockController.sponsorBlock.enabled) {
                logger('debug', 'Player', `[SponsorBlock][${this.runtime.guildId}] Initiating segment fetch for video ${videoId}`);
                const { fetchSponsorBlockSegments } = await import('../../../utils.js');
                fetchSponsorBlockSegments(videoId, this.sponsorBlockController.sponsorBlock.categories, this.sponsorBlockController.sponsorBlock.actionTypes, sbConfig?.api)
                    .then((segments) => {
                    if (this.destroying ||
                        !this.track ||
                        this.track.info.identifier !== videoId) {
                        logger('debug', 'Player', `[SponsorBlock][${this.runtime.guildId}] Ignoring fetched segments for ${videoId} (track changed or player destroyed)`);
                        return;
                    }
                    this.sponsorBlockController.sponsorBlock.segments = segments;
                    logger('info', 'Player', `[SponsorBlock][${this.runtime.guildId}] Applied ${segments.length} segments for video ${videoId}`);
                    if (segments.length > 0) {
                        this.runtime.emitEvent(GatewayEvents.SPONSORBLOCK_SEGMENTS_LOADED, {
                            segments
                        });
                        // Immediate check after load
                        this.recovery._sendUpdate();
                    }
                })
                    .catch((error) => {
                    logger('error', 'Player', `[SponsorBlock][${this.runtime.guildId}] Error fetching segments for ${videoId}:`, error);
                });
            }
            else {
                logger('debug', 'Player', `[SponsorBlock][${this.runtime.guildId}] Auto-skip disabled, skipping segment fetch for ${videoId}`);
            }
        }
        return true;
    }
    _resumeRequestedPlayback(reason) {
        const connection = this.connectionController.connection;
        if (this.destroying || this.isPaused || !connection?.ready)
            return;
        if (connection.audioStream) {
            connection.unpause(reason);
        }
        else if (this.track && !this.isUpdatingTrack) {
            const playbackTrack = this.track;
            const position = this._resumePositionMs ?? 0;
            this._resumePositionMs = null;
            this.isUpdatingTrack = true;
            void this._startPlayback(position)
                .catch((error) => {
                if (this.track === playbackTrack)
                    this._onError(error);
            })
                .finally(() => {
                if (this.track === playbackTrack)
                    this.isUpdatingTrack = false;
            });
        }
    }
    async play({ encoded, info, userData, audioTrackId, noReplace = false, startTime, endTime = 0 }) {
        logger('debug', 'Player', `[Action: play] Method invoked for guild ${this.runtime.guildId} with track ${info.identifier}`);
        return new Promise((resolve) => {
            this.isUpdatingTrack = true;
            try {
                if (this.destroying) {
                    logger('debug', 'Player', `play() aborted for guild ${this.runtime.guildId} because player is destroying`);
                    this.isUpdatingTrack = false;
                    return resolve(false);
                }
                logger('debug', 'Player', `play() called for guild ${this.runtime.guildId}`, {
                    encoded,
                    noReplace,
                    startTime,
                    endTime,
                    track: info
                });
                const isAlreadyPlaying = (!!this.track?.info.identifier &&
                    this.track.info.identifier === info.identifier) ||
                    (!!this.track?.encoded && this.track.encoded === encoded);
                if (this.track &&
                    this.connectionController.connection?.audioStream &&
                    isAlreadyPlaying) {
                    logger('info', 'Player', `play() for guild ${this.runtime.guildId} adopted (already playing/transitioning ${info.identifier})`);
                    this.isUpdatingTrack = false;
                    return resolve(true);
                }
                if (noReplace &&
                    this.track &&
                    this.connectionController.connection?.audioStream) {
                    logger('debug', 'Player', `play() aborted for guild ${this.runtime.guildId} due to noReplace=true and player is active`);
                    this.isUpdatingTrack = false;
                    return resolve(false);
                }
                if (this.track) {
                    this._emitTrackEnd(EndReasons.REPLACED);
                    this.resourceLoader._cleanupCurrentAudioStream('track-replaced');
                }
                this.recovery._lastStreamDataTime = 0;
                this.track = {
                    encoded,
                    info,
                    pluginInfo: {},
                    endTime,
                    userData: userData ?? {},
                    audioTrackId
                };
                this.transitionController._fading('reset');
                if (!this.connectionController.voice.endpoint ||
                    !this.connectionController.voice.token ||
                    !this.connectionController.voice.sessionId ||
                    !this.connectionController.voice.channelId) {
                    this._resumePositionMs = startTime ?? 0;
                    logger('debug', 'Player', `No voice state for guild ${this.runtime.guildId}, track is enqueued and will play when voice state is provided.`);
                    this.isUpdatingTrack = false;
                    return resolve(true);
                }
                const playbackTrack = this.track;
                this._startPlayback(startTime !== undefined
                    ? startTime === 0 && this.clock.position < 1000
                        ? 0
                        : startTime
                    : 0)
                    .catch((error) => {
                    if (this.track === playbackTrack)
                        this._onError(error);
                })
                    .finally(() => {
                    if (this.track === playbackTrack)
                        this.isUpdatingTrack = false;
                });
                return resolve(true);
            }
            catch (error) {
                this.isUpdatingTrack = false;
                this._onError(error);
                return resolve(false);
            }
        });
    }
    stop() {
        logger('debug', 'Player', `[Action: stop] Executing stop for guild ${this.runtime.guildId}`);
        this.isUpdatingTrack = true;
        try {
            if (this.destroying || !this.track) {
                logger('debug', 'Player', `[Action: stop] Aborted for guild ${this.runtime.guildId}: destroying=${this.destroying}, hasTrack=${!!this.track}`);
                return false;
            }
            if (this.nextResource || this.nextResourceIsCrossfade) {
                if (this.nextResourceIsCrossfade) {
                    this.resourceLoader._getAudioStream()?.clearCrossfade();
                    this.transitionController._clearCrossfadeTimer();
                    this.transitionController._crossfadeToken += 1;
                }
                this.nextResource?.destroy();
                this.nextResource = null;
                this.nextTrack = null;
                this.nextStreamInfo = null;
                this.nextResourceIsCrossfade = false;
            }
            if (this.connectionController.connection &&
                this.connectionController.connStatus !== 'destroyed') {
                if (this.connectionController.connection.audioStream) {
                    this._isStopping = true;
                    if (this.transitionController._fading('trackStop'))
                        return true;
                    this._isStopping = false;
                    this.connectionController.connection.stop(EndReasons.STOPPED);
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
    async preload(payload) {
        logger('debug', 'Player', `[Action: preload] Method invoked for guild ${this.runtime.guildId} with track ${payload.info.identifier}`);
        if (this.destroying) {
            logger('debug', 'Player', `[Action: preload] Aborted for guild ${this.runtime.guildId}: player is destroying`);
            return false;
        }
        const sameEncoded = !!payload.encoded &&
            !!this.nextTrack?.encoded &&
            this.nextTrack.encoded === payload.encoded;
        const sameIdentifier = !!payload.info?.identifier &&
            !!this.nextTrack?.info?.identifier &&
            this.nextTrack.info.identifier === payload.info.identifier;
        const isDuplicatePreload = (sameEncoded || sameIdentifier) &&
            (!!this.nextResource || this.nextResourceIsCrossfade);
        if (isDuplicatePreload) {
            logger('debug', 'Player', `Skipping duplicate preload for ${this.runtime.guildId}`, {
                identifier: payload.info?.identifier,
                encodedMatch: sameEncoded,
                identifierMatch: sameIdentifier
            });
            if (this.nextResourceIsCrossfade)
                this.transitionController._rescheduleCrossfade();
            return true;
        }
        const preloadRequest = ++this._preloadRequest;
        if (this.nextResourceIsCrossfade) {
            this.resourceLoader._getAudioStream()?.clearCrossfade();
            this.transitionController._clearCrossfadeTimer();
            this.transitionController._crossfadeToken += 1;
        }
        if (this.nextResource) {
            this.nextResource.destroy();
            this.nextResource = null;
        }
        this.nextTrack = null;
        this.nextStreamInfo = null;
        this.nextResourceIsCrossfade = false;
        try {
            const crossfadeConfig = this.transitionController._getCrossfadeConfig();
            const currentLength = this.track?.endTime || this.track?.info.length || 0;
            const shouldCrossfade = !!crossfadeConfig &&
                !!this.track &&
                !this.track.info.isStream &&
                !payload.info.isStream &&
                Number.isFinite(currentLength) &&
                currentLength > 0;
            if (shouldCrossfade) {
                this.transitionController._crossfadeToken += 1;
                this.nextTrack = payload;
                this.nextResourceIsCrossfade = true;
                if (this.transitionController._fadeTimers.trackEnd) {
                    clearTimeout(this.transitionController._fadeTimers.trackEnd);
                    this.transitionController._fadeTimers.trackEnd = null;
                }
                this.transitionController._scheduleCrossfadePreparation();
                return true;
            }
            const trackInfo = {
                ...payload.info,
                audioTrackId: payload.audioTrackId
            };
            const urlData = await this.runtime.nodelink.sources.getTrackUrl(trackInfo);
            if (this.destroying || preloadRequest !== this._preloadRequest)
                return false;
            if (urlData.exception)
                return false;
            const fetched = await this.resourceLoader._fetchResource(payload.info, urlData, 0);
            if (this.destroying || preloadRequest !== this._preloadRequest) {
                if (!('exception' in fetched))
                    fetched.stream.destroy();
                return false;
            }
            if ('exception' in fetched)
                return false;
            this.nextTrack = payload;
            this.nextResource = fetched.stream;
            this.nextStreamInfo = { ...urlData, trackInfo: payload.info };
            this.nextResourceIsCrossfade = false;
            if (this.volumePercent !== 100) {
                this.nextResource.setVolume(this.volumePercent / 100);
            }
            this.nextResource.setFilters(this.filters);
            return true;
        }
        catch (cause) {
            if (this.destroying || preloadRequest !== this._preloadRequest)
                return false;
            const error = cause;
            logger('error', 'Player', `Preload failed for guild ${this.runtime.guildId}: ${error.message}`);
            return false;
        }
    }
    clearNextTrack() {
        logger('debug', 'Player', `[Action: clearNextTrack] Method invoked for guild ${this.runtime.guildId}`);
        if (this.destroying)
            return false;
        this._preloadRequest += 1;
        if (this.nextResource) {
            this.nextResource.destroy();
            this.nextResource = null;
        }
        this.nextTrack = null;
        this.nextStreamInfo = null;
        this.nextResourceIsCrossfade = false;
        return true;
    }
    pause(shouldPause) {
        logger('debug', 'Player', `[Action: pause] Method invoked for guild ${this.runtime.guildId} with target: ${shouldPause}`);
        if (this.destroying || this.isPaused === shouldPause) {
            logger('debug', 'Player', `[Action: pause] Aborted for guild ${this.runtime.guildId}: destroying=${this.destroying}, alreadyPaused=${this.isPaused === shouldPause}`);
            return false;
        }
        logger('debug', 'Player', `Setting pause to ${shouldPause} for guild ${this.runtime.guildId}`);
        if (shouldPause) {
            this._pausedAtPosition = this.clock._realPosition();
            const audioStream = this.resourceLoader._getAudioStream();
            audioStream?.setCrossfadePaused(true);
            this.transitionController._clearCrossfadeTimer();
            if (this.nextResourceIsCrossfade &&
                !audioStream?.getCrossfadeState().active) {
                this.transitionController._crossfadeToken += 1;
                audioStream?.clearCrossfade();
                this.nextResource?.destroy();
                this.nextResource = null;
                this.nextStreamInfo = null;
            }
            if (this.transitionController._fadeTimers?.trackEnd) {
                clearTimeout(this.transitionController._fadeTimers.trackEnd);
                this.transitionController._fadeTimers.trackEnd = null;
            }
            if (this.transitionController._fading('pause')) {
                this.isPaused = true;
                this.runtime.emitEvent(GatewayEvents.PAUSE, { paused: true });
                return true;
            }
            this.isPaused = true;
            this.connectionController.connection?.pause('requested');
        }
        else {
            this.isPaused = false;
            const audioStream = this.resourceLoader._getAudioStream();
            this._isResuming = audioStream !== null;
            audioStream?.setCrossfadePaused(false);
            this.transitionController._fading('resume');
            this._resumeRequestedPlayback('requested');
            this.transitionController._rescheduleCrossfade(this._pausedAtPosition);
        }
        this.runtime.emitEvent(GatewayEvents.PAUSE, { paused: this.isPaused });
        return true;
    }
    volume(level) {
        logger('debug', 'Player', `[Action: volume] Method invoked for guild ${this.runtime.guildId} with target: ${level}`);
        if (this.destroying) {
            logger('debug', 'Player', `[Action: volume] Aborted for guild ${this.runtime.guildId}: player is destroying`);
            return false;
        }
        logger('debug', 'Player', `Setting volume to ${level} for guild ${this.runtime.guildId}`);
        this.volumePercent = Math.max(0, Math.min(1000, level));
        this.connectionController.connection?.audioStream?.setVolume(this.volumePercent / 100);
        if (!this.nextResourceIsCrossfade) {
            this.nextResource?.setVolume(this.volumePercent / 100);
        }
        this.runtime.emitEvent(GatewayEvents.VOLUME_CHANGED, {
            volume: this.volumePercent
        });
        return true;
    }
    setLoudnessNormalizer(enabled) {
        logger('debug', 'Player', `[Action: setLoudnessNormalizer] Method invoked for guild ${this.runtime.guildId} to ${enabled}`);
        this.loudnessNormalizer = !!enabled;
        if (this.connectionController.connection?.audioStream) {
            this.connectionController.connection.audioStream.setLoudnessNormalizer(this.loudnessNormalizer);
        }
        return true;
    }
    _resolveDuckingConfig() {
        const fadingDucking = this.transitionController.fading?.ducking;
        const configDucking = this.runtime.nodelink.options?.playback?.audio?.fading?.ducking;
        const source = fadingDucking ?? configDucking;
        return {
            enabled: source?.enabled ?? false,
            duration: source?.duration ?? 500,
            targetVolume: source?.targetVolume ?? 0.15,
            curve: source?.curve ?? 'linear'
        };
    }
    setDucking(enabled) {
        logger('debug', 'Player', `[Action: setDucking] Method invoked for guild ${this.runtime.guildId} to ${enabled}`);
        if (enabled) {
            const duckingCfg = this._resolveDuckingConfig();
            duckingCfg.enabled = true;
            if (!this.duckingController) {
                this.duckingController = new DuckingController(this.runtime.guildId, duckingCfg);
            }
            else {
                this.duckingController.updateConfig(duckingCfg);
            }
            // Attach to current connection if available
            if (this.connectionController.connection) {
                this.duckingController.attach(this.connectionController.connection);
            }
            // Connect to current audio stream if available
            if (this.connectionController.connection?.audioStream?.fadeTo) {
                const stream = this.connectionController.connection.audioStream;
                this.duckingController.setStreamControl({
                    fadeTo: (volume, durationMs, curve) => stream.fadeTo(volume, durationMs, curve)
                });
            }
        }
        else {
            if (this.duckingController) {
                this.duckingController.detach();
                this.duckingController.destroy();
                this.duckingController = null;
            }
        }
        return true;
    }
    setFilters(filters) {
        logger('debug', 'Player', `[Action: setFilters] Method invoked for guild ${this.runtime.guildId}`);
        if (this.destroying || !this.track) {
            logger('debug', 'Player', `[Action: setFilters] Aborted for guild ${this.runtime.guildId}: destroying=${this.destroying}, hasTrack=${!!this.track}`);
            return false;
        }
        logger('debug', 'Player', `Applying filters for guild ${this.runtime.guildId}:`, filters);
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
        if (this.connectionController.connection?.audioStream) {
            this.clock._snapshotPosition();
            this.connectionController.connection.audioStream.setFilters(this.filters);
            this.transitionController._fading('trackEndSchedule', {
                startPosition: this.clock._realPosition()
            });
        }
        if (!this.nextResourceIsCrossfade) {
            this.nextResource?.setFilters(this.filters);
        }
        if (this.nextResourceIsCrossfade)
            this.transitionController._rescheduleCrossfade();
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
                cleanupTimer.unref();
            }
        }
        this.runtime.emitEvent(GatewayEvents.FILTERS_CHANGED, {
            filters: this.filters
        });
        return true;
    }
    destroy(emitClose = true) {
        logger('debug', 'Player', `[Action: destroy] Method invoked for guild ${this.runtime.guildId} with emitClose=${emitClose}`);
        if (this.destroying)
            return;
        this.destroying = true;
        this.resourceLoader._cleanupCurrentAudioStream('destroy');
        this.connectionController.destroy();
        this.duckingController?.destroy();
        this.duckingController = null;
        if (emitClose) {
            this.runtime.emitEvent(GatewayEvents.WEBSOCKET_CLOSED, {
                code: 1000,
                reason: 'destroyed by client',
                byRemote: false
            });
        }
        this.runtime.emitEvent(GatewayEvents.PLAYER_DESTROYED, {
            guildId: this.runtime.guildId
        });
        this.mixController._destroyAudioMixer();
        try {
            const yt = this.runtime.nodelink.sources.sources.get('youtube');
            yt?.abortGuildStreams(this.runtime.guildId);
        }
        catch { }
        if (this._currentResource) {
            try {
                this._currentResource.destroy();
            }
            catch { }
            this._currentResource = null;
        }
        this._resetTrack();
        this.connectionController.connStatus = 'destroyed';
        this.volumePercent = this.runtime.nodelink.options?.defaultVolume ?? 100;
    }
}
