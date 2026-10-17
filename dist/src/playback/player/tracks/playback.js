import { EndReasons, GatewayEvents } from '../../../constants.js';
import { logger } from '../../../utils.js';
import { AutoMixRegistry } from '../../processing/AutoMixRegistry.js';
import { createSeekeableAudioResource, getStreamProcessor, isWebmYouTubePlayback } from '../audio/resources.js';
/**
 * Handles track commands, stream replacement, and pause/resume state.
 * @internal
 */
export class PlayerPlayback {
    player;
    nodelink;
    dependencies;
    _isResuming = false;
    _ignoreIdleStoppedUntil = 0;
    _pausedAtPosition = undefined;
    _resumePositionMs = null;
    constructor(player, nodelink, dependencies) {
        this.player = player;
        this.nodelink = nodelink;
        this.dependencies = dependencies;
    }
    get isResuming() {
        return this._isResuming;
    }
    _shouldIgnoreStoppedState() {
        return Date.now() < this._ignoreIdleStoppedUntil && this._isResuming;
    }
    /**
     * Completes a resume when voice reports playing; returns whether this was a resume.
     */
    _completeResume() {
        const wasResuming = this._isResuming;
        this._isResuming = false;
        this.player.isPaused = false;
        this.player._lastStreamDataTime = Date.now();
        if (wasResuming) {
            this.dependencies.fadingEffects._fading('trackEndSchedule', {
                startPosition: this._pausedAtPosition ?? this.dependencies.clock._realPosition()
            });
            this._pausedAtPosition = undefined;
        }
        return wasResuming;
    }
    _rememberReconnectPosition(position) {
        this._resumePositionMs = position;
    }
    /**
     * Consumes the reconnect position before starting the pending track.
     */
    _startPendingTrack() {
        const resumeAt = this._resumePositionMs;
        this._resumePositionMs = null;
        return this._startPlayback(resumeAt ?? 0);
    }
    _resetResumeState() {
        this._pausedAtPosition = undefined;
        this._resumePositionMs = null;
    }
    /**
     * Waits for voice readiness, creates a resource, and hands it to the connection.
     */
    async _connectAndPlayStream(urlData, position, cleanupReason, fadingAction, playLogMessage, preserveQueuedCrossfade = false, suppressErrorEvents = false) {
        if (!this.player.track)
            return false;
        const playbackTrack = this.player.track;
        if (!this.player.connection) {
            this.dependencies.voiceConnection._initConnection();
        }
        if (!this.dependencies.voiceConnection._isVoiceReady()) {
            this.dependencies.voiceConnection._ensureVoiceConnection();
        }
        if (!this.dependencies.voiceConnection._isVoiceReady()) {
            logger('debug', 'Player', `Waiting for voice connection to be ready for guild ${this.player.guildId}`);
            try {
                await this.player.waitEvent('stateChange', (state) => this.dependencies.voiceConnection._isConnectionReady(state));
            }
            catch (err) {
                logger('warn', 'Player', `Timeout or error while waiting for voice connection on guild ${this.player.guildId}:`, err);
            }
        }
        if (this.player.destroying || this.player.track !== playbackTrack)
            return false;
        if (!this.player.connection ||
            !this.dependencies.voiceConnection._isVoiceReady()) {
            if (!suppressErrorEvents) {
                this.dependencies._onError(new Error(`Voice connection timed out for guild ${this.player.guildId} (missing UDP info).`, { cause: 'VOICE_CONNECTION_TIMEOUT' }));
            }
            return false;
        }
        const resolvedSourceName = urlData.newTrack?.info
            ?.sourceName ?? this.player.track.info.sourceName;
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
            if (this.player.destroying || this.player.track !== playbackTrack)
                return false;
        }
        let resource;
        if (seekUrl && createSeekeableAudioResource) {
            logger('debug', 'Player', `Seeking with Seekeable to ${position}ms for guild ${this.player.guildId}`);
            const seekResult = await createSeekeableAudioResource(this.player.guildId, seekUrl, position, this.player.track?.endTime, this.nodelink, this.player.filters, this.player, this.player.volumePercent / 100, this.player.audioMixer, false, this.player.loudnessNormalizer, this.dependencies.queue._getCrossfadeConfig() !== null);
            if (this.player.destroying || this.player.track !== playbackTrack) {
                if (!('exception' in seekResult))
                    seekResult.destroy();
                return false;
            }
            if ('exception' in seekResult) {
                logger('error', 'Player', `Seekeable resource creation failed for guild ${this.player.guildId}: ${seekResult.exception.message}. Falling back to old method.`);
            }
            else {
                resource = seekResult;
            }
        }
        if (!resource) {
            const fetched = await this.dependencies.resources._fetchResource(this.player.track.info, urlData, position);
            if (this.player.destroying || this.player.track !== playbackTrack) {
                if (!('exception' in fetched))
                    fetched.stream.destroy();
                return false;
            }
            if ('exception' in fetched) {
                if (!suppressErrorEvents) {
                    const err = new Error(fetched.exception.message);
                    this.dependencies._onError(err);
                }
                return false;
            }
            resource = fetched.stream;
        }
        this.dependencies.resources._cleanupCurrentAudioStream(cleanupReason, preserveQueuedCrossfade);
        if (this.player.volumePercent !== 100) {
            resource.setVolume(this.player.volumePercent / 100);
        }
        this.dependencies.fadingEffects._fading(fadingAction, { resource });
        this.player.setFilters(this.player.filters);
        logger('debug', 'Player', playLogMessage);
        this.dependencies.resources._adoptResource(resource);
        this.dependencies.clock._resetAudioConsumptionBaseline(position);
        this.player.connection.play(resource);
        // Connect ducking controller to the new audio stream
        if (this.player.duckingController && resource.fadeTo) {
            this.player.duckingController.attach(this.player.connection);
            this.player.duckingController.setStreamControl({
                fadeTo: (volume, durationMs, curve) => resource.fadeTo?.(volume, durationMs, curve)
            });
        }
        await this.player.waitEvent('playerStateChange', (s) => s.status === 'playing');
        if (this.player.destroying || this.player.track !== playbackTrack)
            return false;
        this.dependencies.clock._resetPacketBaseline(position);
        return true;
    }
    async _startPlayback(startTime = 0) {
        if (!this.player.track)
            return false;
        const trackInfo = {
            ...this.player.track.info,
            audioTrackId: this.player.track.audioTrackId
        };
        const urlData = await this.nodelink.sources.getTrackUrl(trackInfo, undefined, this.dependencies.monitor.isRecovering);
        if (!this.player.track)
            return false;
        if (urlData.newTrack?.info &&
            urlData.newTrack.info.identifier !== trackInfo.identifier) {
            this.player.track.pluginInfo = {
                ...(this.player.track.pluginInfo || {}),
                mirroredTrack: urlData.newTrack.info
            };
        }
        this.player.streamInfo = { ...urlData, trackInfo: this.player.track.info };
        logger('debug', 'Player', `Got track URL for guild ${this.player.guildId}`, {
            urlData
        });
        if (urlData.exception) {
            const err = new Error(urlData.exception.message);
            this.dependencies._onError(err);
            return false;
        }
        const result = await this._connectAndPlayStream(urlData, startTime, 'start-playback', 'trackStartArm', `Playing resource for guild ${this.player.guildId}`);
        if (!result)
            return false;
        this.dependencies.fadingEffects._fading('trackEndSchedule', {
            startPosition: startTime || 0
        });
        this.dependencies.monitor._resetStuckTime();
        if (this.dependencies.queue.nextTrack &&
            this.dependencies.queue.nextResourceIsCrossfade) {
            this.dependencies.queue._scheduleCrossfadePreparation(startTime || 0);
        }
        const crossfadeConfig = this.dependencies.queue._getCrossfadeConfig();
        const trackDurationMs = this.player.track.endTime && this.player.track.endTime > 0
            ? this.player.track.endTime
            : this.player.track.info.length || 0;
        if (crossfadeConfig &&
            !this.player.track.info.isStream &&
            trackDurationMs > 30000) {
            const currentTrack = this.player.track;
            const currentUrlData = urlData;
            AutoMixRegistry.getInstance()
                .requestOutroAnalysis({
                track: currentTrack,
                urlData: currentUrlData,
                priority: 'CURRENT_OUTRO',
                triggerSource: `player:${this.player.guildId}:trackStart`,
                fetchResource: (info, uData, windowStartMs, returnPcm) => this.dependencies.resources._fetchResource(info, uData, windowStartMs, returnPcm)
            })
                .catch((err) => {
                logger('debug', 'Player', `[AutoMix] Background outro analysis failed for ${currentTrack.info.identifier}: ${err.message}`);
            });
        }
        const segmentRequest = this.dependencies.sponsorBlockFeature.prepareSegments(this.player.track);
        if (segmentRequest) {
            const { fetchSponsorBlockSegments } = await import('../../../utils.js');
            this.dependencies.sponsorBlockFeature.loadSegments(segmentRequest, fetchSponsorBlockSegments);
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
        logger('debug', 'Player', `[Action: play] Method invoked for guild ${this.player.guildId} with track ${info.identifier}`);
        return new Promise((resolve) => {
            this.player.isUpdatingTrack = true;
            try {
                if (this.player.destroying) {
                    logger('debug', 'Player', `play() aborted for guild ${this.player.guildId} because player is destroying`);
                    this.player.isUpdatingTrack = false;
                    return resolve(false);
                }
                logger('debug', 'Player', `play() called for guild ${this.player.guildId}`, {
                    encoded,
                    noReplace,
                    startTime,
                    endTime,
                    track: info
                });
                const isAlreadyPlaying = (!!this.player.track?.info.identifier &&
                    this.player.track.info.identifier === info.identifier) ||
                    (!!this.player.track?.encoded &&
                        this.player.track.encoded === encoded);
                if (this.player.track &&
                    this.player.connection?.audioStream &&
                    isAlreadyPlaying) {
                    logger('info', 'Player', `play() for guild ${this.player.guildId} adopted (already playing/transitioning ${info.identifier})`);
                    this.player.isUpdatingTrack = false;
                    return resolve(true);
                }
                if (noReplace &&
                    this.player.track &&
                    this.player.connection?.audioStream) {
                    logger('debug', 'Player', `play() aborted for guild ${this.player.guildId} due to noReplace=true and player is active`);
                    this.player.isUpdatingTrack = false;
                    return resolve(false);
                }
                if (this.player.track) {
                    this.dependencies.events.emitTrackEnd(EndReasons.REPLACED);
                    this.dependencies.resources._cleanupCurrentAudioStream('track-replaced');
                }
                this.player._lastStreamDataTime = 0;
                this.player.track = {
                    encoded,
                    info,
                    pluginInfo: {},
                    endTime,
                    userData: userData ?? {},
                    audioTrackId
                };
                this.dependencies.fadingEffects._fading('reset');
                if (!this.player.voice.endpoint || !this.player.voice.token) {
                    logger('debug', 'Player', `No voice state for guild ${this.player.guildId}, track is enqueued and will play when voice state is provided.`);
                    this.player.isUpdatingTrack = false;
                    return resolve(true);
                }
                this._startPlayback(startTime !== undefined
                    ? startTime === 0 && this.player.position < 1000
                        ? 0
                        : startTime
                    : 0)
                    .catch((err) => this.dependencies._onError(err))
                    .finally(() => {
                    this.player.isUpdatingTrack = false;
                });
                return resolve(true);
            }
            catch (e) {
                this.player.isUpdatingTrack = false;
                this.dependencies._onError(e);
                return resolve(false);
            }
        });
    }
    /**
     * Stops playback and emits STOPPED if applicable.
     *
     * @returns True when stop was executed; false when no active track.
     */
    stop() {
        logger('debug', 'Player', `[Action: stop] Executing stop for guild ${this.player.guildId}`);
        this.player.isUpdatingTrack = true;
        try {
            if (this.player.destroying || !this.player.track) {
                logger('debug', 'Player', `[Action: stop] Aborted for guild ${this.player.guildId}: destroying=${this.player.destroying}, hasTrack=${!!this.player.track}`);
                return false;
            }
            this.dependencies.queue._stopQueuedTrack();
            if (this.player.connection && this.player.connStatus !== 'destroyed') {
                if (this.player.connection.audioStream) {
                    this.dependencies.fadingEffects._stopPlayback();
                }
                else {
                    this.dependencies.events.emitTrackEnd(EndReasons.STOPPED);
                    this.dependencies._resetTrack();
                }
            }
            else {
                this.dependencies.events.emitTrackEnd(EndReasons.STOPPED);
                this.dependencies._resetTrack();
            }
            return true;
        }
        finally {
            this.player.isUpdatingTrack = false;
        }
    }
    /**
     * Pauses or resumes playback.
     *
     * @param shouldPause - True to pause, false to resume.
     * @returns True when state changed; false otherwise.
     */
    pause(shouldPause) {
        logger('debug', 'Player', `[Action: pause] Method invoked for guild ${this.player.guildId} with target: ${shouldPause}`);
        if (this.player.destroying || this.player.isPaused === shouldPause) {
            logger('debug', 'Player', `[Action: pause] Aborted for guild ${this.player.guildId}: destroying=${this.player.destroying}, alreadyPaused=${this.player.isPaused === shouldPause}`);
            return false;
        }
        logger('debug', 'Player', `Setting pause to ${shouldPause} for guild ${this.player.guildId}`);
        if (shouldPause) {
            this._pausedAtPosition = this.dependencies.clock._realPosition();
            this.dependencies.queue._pauseCrossfade();
            this.dependencies.fadingEffects._clearTrackEndTimer();
            if (this.dependencies.fadingEffects._fading('pause')) {
                this.player.isPaused = true;
                this.player.emitEvent(GatewayEvents.PAUSE, { paused: true });
                return true;
            }
            this.player.isPaused = true;
            this.player.connection?.pause?.('requested');
        }
        else {
            this.player.isPaused = false;
            this._isResuming = true;
            const audioStream = this.dependencies.voiceConnection._getAudioStream();
            audioStream?.setCrossfadePaused?.(false);
            this.dependencies.fadingEffects._fading('resume');
            if (audioStream)
                this.player.connection?.unpause?.('requested');
            this.dependencies.queue._rescheduleCrossfade(this._pausedAtPosition);
        }
        this.player.emitEvent(GatewayEvents.PAUSE, { paused: this.player.isPaused });
        return true;
    }
}
