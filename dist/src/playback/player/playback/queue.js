import { EndReasons } from '../../../constants.js';
import { logger } from '../../../utils.js';
const MIN_CROSSFADE_SELECTION_MS = 6000;
const MAX_CROSSFADE_SELECTION_MS = 21000;
function getCrossfadeSelectionWindowMs(durationMs) {
    return Math.min(MAX_CROSSFADE_SELECTION_MS, Math.max(MIN_CROSSFADE_SELECTION_MS, durationMs * 4.2));
}
/**
 * Owns the next track, gapless handoff, and crossfade preparation.
 * @internal
 */
export class PlayerQueue {
    player;
    nodelink;
    dependencies;
    _nextTrack = null;
    _nextResource = null;
    _nextStreamInfo = null;
    _nextResourceIsCrossfade = false;
    _crossfadeToken = 0;
    _crossfadeTimer = null;
    _crossfadePrepareTimer = null;
    _crossfadeCurrentResource = null;
    _crossfadePreparationSafetyMs = 0;
    constructor(player, nodelink, dependencies) {
        this.player = player;
        this.nodelink = nodelink;
        this.dependencies = dependencies;
    }
    get nextTrack() {
        return this._nextTrack;
    }
    get nextResource() {
        return this._nextResource;
    }
    get nextResourceIsCrossfade() {
        return this._nextResourceIsCrossfade;
    }
    _rescheduleAfterSeek(position, safetyMs) {
        this._crossfadePreparationSafetyMs = safetyMs;
        this._rescheduleCrossfade(position);
    }
    /**
     * Promotes a prepared gapless track after voice reports a natural finish.
     * Captures it before emitting the end event, which can invoke plugin hooks.
     */
    _playGaplessTrack() {
        if (!this._nextResource ||
            !this._nextTrack ||
            this._nextResourceIsCrossfade)
            return false;
        const resource = this._nextResource;
        const nextTrack = this._nextTrack;
        const nextStreamInfo = this._nextStreamInfo;
        this.dependencies.events.emitTrackEnd(EndReasons.GAPLESS);
        this.player.track = nextTrack;
        this._nextTrack = null;
        this._nextResource = null;
        this.player.streamInfo = nextStreamInfo;
        this._nextStreamInfo = null;
        this.player.position = 0;
        this.dependencies.clock._resetAudioConsumptionBaseline(0);
        this.dependencies.clock._resetPacketBaseline(0);
        this.dependencies.transitions._fading('trackEndSchedule', {
            startPosition: 0
        });
        const oldStream = this.player.connection?.play(resource);
        if (oldStream)
            oldStream.destroy();
        this.dependencies.resources._replaceResource(resource);
        if (this.player.duckingController &&
            this.player.connection &&
            resource.fadeTo) {
            this.player.duckingController.attach(this.player.connection);
            this.player.duckingController.setStreamControl({
                fadeTo: (volume, durationMs, curve) => resource.fadeTo?.(volume, durationMs, curve)
            });
        }
        return true;
    }
    _pauseCrossfade() {
        const audioStream = this.dependencies.voiceConnection._getAudioStream();
        audioStream?.setCrossfadePaused?.(true);
        this._clearCrossfadeTimer();
        if (this._nextResourceIsCrossfade &&
            !audioStream?.getCrossfadeState?.().active) {
            this._crossfadeToken += 1;
            audioStream?.clearCrossfade?.();
            this._nextResource?.destroy();
            this._nextResource = null;
            this._nextStreamInfo = null;
        }
    }
    _stopQueuedTrack() {
        if (this._nextResource || this._nextResourceIsCrossfade) {
            if (this._nextResourceIsCrossfade) {
                this.dependencies.voiceConnection._getAudioStream()?.clearCrossfade?.();
                this._clearCrossfadeTimer();
                this._crossfadeToken += 1;
            }
            this._nextResource?.destroy();
            this._nextResource = null;
            this._nextTrack = null;
            this._nextStreamInfo = null;
            this._nextResourceIsCrossfade = false;
        }
    }
    _resetQueue() {
        this._destroyCrossfadeResources();
        this._crossfadePreparationSafetyMs = 0;
        if (this._nextResource) {
            this._nextResource.destroy();
            this._nextResource = null;
            this._nextTrack = null;
            this._nextStreamInfo = null;
        }
        this._nextResourceIsCrossfade = false;
    }
    /**
     * Prepares the next resource or schedules its crossfade warm-up.
     * @param payload - Track to queue.
     * @returns Whether the preload request succeeded.
     */
    async preload(payload) {
        logger('debug', 'Player', `[Action: preload] Method invoked for guild ${this.player.guildId} with track ${payload.info.identifier}`);
        if (this.player.destroying) {
            logger('debug', 'Player', `[Action: preload] Aborted for guild ${this.player.guildId}: player is destroying`);
            return false;
        }
        const sameEncoded = !!payload.encoded &&
            !!this._nextTrack?.encoded &&
            this._nextTrack.encoded === payload.encoded;
        const sameIdentifier = !!payload.info?.identifier &&
            !!this._nextTrack?.info?.identifier &&
            this._nextTrack.info.identifier === payload.info.identifier;
        const isDuplicatePreload = (sameEncoded || sameIdentifier) &&
            (!!this._nextResource || this._nextResourceIsCrossfade);
        if (isDuplicatePreload) {
            logger('debug', 'Player', `Skipping duplicate preload for ${this.player.guildId}`, {
                identifier: payload.info?.identifier,
                encodedMatch: sameEncoded,
                identifierMatch: sameIdentifier
            });
            if (this._nextResourceIsCrossfade)
                this._rescheduleCrossfade();
            return true;
        }
        if (this._nextResourceIsCrossfade) {
            this.dependencies.voiceConnection._getAudioStream()?.clearCrossfade?.();
            this._clearCrossfadeTimer();
            this._crossfadeToken += 1;
        }
        if (this._nextResource) {
            this._nextResource.destroy();
            this._nextResource = null;
        }
        this._nextTrack = null;
        this._nextStreamInfo = null;
        this._nextResourceIsCrossfade = false;
        try {
            const crossfadeConfig = this._getCrossfadeConfig();
            const audioStream = this.dependencies.voiceConnection._getAudioStream();
            const currentLength = this.player.track?.endTime || this.player.track?.info.length || 0;
            const shouldCrossfade = !!crossfadeConfig &&
                !!this.player.track &&
                !this.player.track.info.isStream &&
                !payload.info.isStream &&
                Number.isFinite(currentLength) &&
                currentLength > 0 &&
                !!audioStream?.prepareCrossfade;
            if (shouldCrossfade) {
                this._crossfadeToken += 1;
                this._nextTrack = payload;
                this._nextResourceIsCrossfade = true;
                this.dependencies.transitions._clearTrackEndTimer();
                this._scheduleCrossfadePreparation();
                return true;
            }
            const trackInfo = {
                ...payload.info,
                audioTrackId: payload.audioTrackId
            };
            const urlData = await this.nodelink.sources.getTrackUrl(trackInfo);
            if (urlData.exception)
                return false;
            const fetched = await this.dependencies.resources._fetchResource(payload.info, urlData, 0);
            if ('exception' in fetched)
                return false;
            this._nextTrack = payload;
            this._nextResource = fetched.stream;
            this._nextStreamInfo = { ...urlData, trackInfo: payload.info };
            this._nextResourceIsCrossfade = false;
            if (this.player.volumePercent !== 100) {
                this._nextResource.setVolume(this.player.volumePercent / 100);
            }
            this._nextResource.setFilters(this.player.filters);
            return true;
        }
        catch (err) {
            const error = err;
            logger('error', 'Player', `Preload failed for guild ${this.player.guildId}: ${error.message}`);
            return false;
        }
    }
    /**
     * Clears the queued track with the existing resource disposal order.
     * @returns False while the player is being destroyed.
     */
    clearNextTrack() {
        logger('debug', 'Player', `[Action: clearNextTrack] Method invoked for guild ${this.player.guildId}`);
        if (this.player.destroying)
            return false;
        if (this._nextResource) {
            this._nextResource.destroy();
            this._nextResource = null;
        }
        this._nextTrack = null;
        this._nextStreamInfo = null;
        this._nextResourceIsCrossfade = false;
        return true;
    }
    _getCrossfadeConfig() {
        const config = this.player.crossfade;
        const duration = Number(config?.duration);
        if (config?.enabled !== true ||
            !Number.isFinite(duration) ||
            duration <= 0) {
            return null;
        }
        const boundedDuration = Math.min(30000, Math.round(duration));
        const minBufferMs = Math.max(20, Math.min(boundedDuration, Math.round(Number(config.minBufferMs) || 250)));
        const mode = config.mode === 'stream'
            ? 'stream'
            : config.mode === 'smart'
                ? 'smart'
                : 'preload';
        const configuredBuffer = Math.round(Number(config.bufferMs) || 0);
        const bufferMs = Math.max(minBufferMs, configuredBuffer > 0
            ? configuredBuffer
            : mode === 'stream'
                ? minBufferMs
                : Math.min(30000, boundedDuration + Math.min(4000, boundedDuration)));
        return {
            enabled: true,
            duration: boundedDuration,
            curve: config.curve === 'linear' || config.curve === 'sine'
                ? config.curve
                : 'sinusoidal',
            mode,
            minBufferMs,
            bufferMs
        };
    }
    _clearCrossfadeTimer() {
        if (this._crossfadeTimer)
            clearTimeout(this._crossfadeTimer);
        if (this._crossfadePrepareTimer)
            clearTimeout(this._crossfadePrepareTimer);
        this._crossfadeTimer = null;
        this._crossfadePrepareTimer = null;
    }
    _scheduleCrossfadePreparation(_startPosition) {
        if (this._crossfadePrepareTimer) {
            clearTimeout(this._crossfadePrepareTimer);
            this._crossfadePrepareTimer = null;
        }
        const config = this._getCrossfadeConfig();
        const stream = this.dependencies.voiceConnection._getAudioStream();
        if (!config ||
            !this.player.track ||
            !this._nextTrack ||
            !this._nextResourceIsCrossfade ||
            this._nextResource ||
            !stream?.prepareCrossfade ||
            this.player.isPaused) {
            return false;
        }
        const total = this.player.track.endTime && this.player.track.endTime > 0
            ? this.player.track.endTime
            : this.player.track.info.length;
        if (!Number.isFinite(total) || total <= 0)
            return false;
        const delay = 0;
        const token = this._crossfadeToken;
        const payload = this._nextTrack;
        logger('debug', 'Crossfade', `Preparing next track for guild ${this.player.guildId} (early warm-up)`);
        this._crossfadePrepareTimer = setTimeout(() => {
            this._crossfadePrepareTimer = null;
            this._prepareCrossfadeResource(token, payload).catch((error) => {
                logger('error', 'Crossfade', `Early crossfade preload failed for guild ${this.player.guildId}: ${error.message}`);
            });
        }, delay);
        this._crossfadePrepareTimer.unref?.();
        return true;
    }
    async _prepareCrossfadeResource(token, payload) {
        const config = this._getCrossfadeConfig();
        const audioStream = this.dependencies.voiceConnection._getAudioStream();
        const currentTrack = this.player.track;
        if (token !== this._crossfadeToken ||
            !config ||
            !currentTrack ||
            !audioStream?.prepareCrossfade ||
            this._nextTrack !== payload ||
            this._nextResource) {
            return;
        }
        const trackInfo = {
            ...payload.info,
            audioTrackId: payload.audioTrackId
        };
        logger('debug', 'Crossfade', `Preparing ${payload.info.identifier} for guild ${this.player.guildId}`);
        const urlData = await this.nodelink.sources.getTrackUrl(trackInfo);
        if (urlData.exception || token !== this._crossfadeToken)
            return;
        const fetched = await this.dependencies.resources._fetchResource(payload.info, urlData, 0, true);
        if ('exception' in fetched || token !== this._crossfadeToken) {
            if (!('exception' in fetched))
                fetched.stream.destroy();
            return;
        }
        if (!fetched.stream.stream) {
            fetched.stream.destroy();
            return;
        }
        const prepared = audioStream.prepareCrossfade(fetched.stream.stream, {
            durationMs: config.duration,
            minBufferMs: config.minBufferMs,
            bufferMs: Math.min(30000, Math.max(config.bufferMs, Math.min(16000, config.duration * 2 + 4000), this._crossfadePreparationSafetyMs + config.minBufferMs))
        }, (consumedMs) => this._completeCrossfade(token, consumedMs));
        if (!prepared || token !== this._crossfadeToken) {
            fetched.stream.destroy();
            return;
        }
        this._nextResource = fetched.stream;
        this._nextStreamInfo = {
            ...urlData,
            trackInfo: payload.info
        };
        logger('debug', 'Crossfade', `Attached ${payload.info.identifier} to the PCM bridge for guild ${this.player.guildId}`);
        this._scheduleCrossfade();
    }
    _scheduleCrossfade(startPosition) {
        if (this._crossfadeTimer)
            clearTimeout(this._crossfadeTimer);
        this._crossfadeTimer = null;
        const config = this._getCrossfadeConfig();
        const stream = this.dependencies.voiceConnection._getAudioStream();
        if (!config ||
            !this.player.track ||
            !this._nextTrack ||
            !this._nextResourceIsCrossfade ||
            !this._nextResource ||
            !stream?.startCrossfade ||
            this.player.isPaused ||
            this.player.track.info.isStream) {
            return false;
        }
        const total = this.player.track.endTime && this.player.track.endTime > 0
            ? this.player.track.endTime
            : this.player.track.info.length;
        if (!Number.isFinite(total) || total <= 0)
            return false;
        const position = startPosition ?? this.dependencies.clock._realPosition();
        const duration = Math.min(config.duration, Math.max(1, total - position));
        const selectionWindow = getCrossfadeSelectionWindowMs(duration);
        const transitionWindow = duration + selectionWindow;
        const playbackRate = Math.max(0.01, stream.getEffectiveRate?.() ?? 1);
        const pipelineLead = this.dependencies.clock._getPipelineLeadMs(stream, position);
        const delay = Math.max(0, (total - position - transitionWindow - pipelineLead) / playbackRate);
        const token = this._crossfadeToken;
        this._crossfadeTimer = setTimeout(() => {
            this._crossfadeTimer = null;
            if (token !== this._crossfadeToken || this.player.isPaused)
                return;
            const attemptStart = () => {
                if (token !== this._crossfadeToken || this.player.isPaused)
                    return;
                const currentPosition = this.dependencies.clock._realPosition();
                const remaining = Math.max(1, total - currentPosition);
                const currentPipelineLead = this.dependencies.clock._getPipelineLeadMs(stream, currentPosition);
                const sourceRemaining = Math.max(1, remaining - currentPipelineLead);
                const waitMs = sourceRemaining - transitionWindow;
                if (waitMs > 20) {
                    this._crossfadeTimer = setTimeout(attemptStart, Math.min(250, waitMs / playbackRate));
                    this._crossfadeTimer.unref?.();
                    return;
                }
                const started = stream.startCrossfade?.(Math.min(duration, sourceRemaining), config.curve, sourceRemaining) ?? false;
                if (started) {
                    logger('debug', 'Crossfade', `Armed musical selection window for guild ${this.player.guildId} with ${Math.round(sourceRemaining)}ms remaining and ${Math.round(currentPipelineLead)}ms pipeline lead`);
                    return;
                }
                if (sourceRemaining <= 20) {
                    logger('debug', 'Crossfade', `Next track was not ready at the transition point for guild ${this.player.guildId}`);
                    return;
                }
                this._crossfadeTimer = setTimeout(attemptStart, 20);
                this._crossfadeTimer.unref?.();
            };
            attemptStart();
        }, delay);
        this._crossfadeTimer.unref?.();
        return true;
    }
    _rescheduleCrossfade(startPosition) {
        if (this._nextResourceIsCrossfade)
            this.dependencies.transitions._clearTrackEndTimer();
        if (this.dependencies.voiceConnection._getAudioStream()?.getCrossfadeState?.()
            .active)
            return true;
        return this._nextResource
            ? this._scheduleCrossfade(startPosition)
            : this._scheduleCrossfadePreparation(startPosition);
    }
    _completeCrossfade(token, consumedMs) {
        if (token !== this._crossfadeToken ||
            !this.player.track ||
            !this._nextTrack ||
            !this._nextResource ||
            !this._nextResourceIsCrossfade) {
            return;
        }
        const previousTrack = this.player.track;
        const promotedTrack = this._nextTrack;
        const promotedResource = this._nextResource;
        const promotedStreamInfo = this._nextStreamInfo;
        this._clearCrossfadeTimer();
        this.dependencies.events.emitTrackEnd(EndReasons.CROSSFADE);
        if (this._crossfadeCurrentResource) {
            this._crossfadeCurrentResource.destroy();
        }
        this.player.track = promotedTrack;
        this._nextTrack = null;
        this._nextResource = null;
        this._nextStreamInfo = null;
        this._nextResourceIsCrossfade = false;
        this._crossfadePreparationSafetyMs = 0;
        this._crossfadeCurrentResource = promotedResource;
        this.player.streamInfo = promotedStreamInfo;
        this.dependencies.clock._resetAudioConsumptionBaseline(consumedMs, this.dependencies.voiceConnection._getAudioStream()?.getConsumedMs?.() ??
            0);
        this.player.position = consumedMs;
        this.dependencies.clock._continuePacketBaseline(consumedMs);
        this.dependencies.recovery._recordPosition(consumedMs);
        this.player.sponsorBlock.segments = [];
        this.player.sponsorBlock.lastSkippedUuid = null;
        logger('info', 'Crossfade', `Transitioned ${previousTrack.info.identifier} to ${promotedTrack.info.identifier} for guild ${this.player.guildId}`);
        this.dependencies.events
            .emitTrackStart()
            .catch((error) => this.dependencies._onError(error));
        this.dependencies.transitions._fading('trackEndSchedule', {
            startPosition: consumedMs
        });
    }
    _destroyCrossfadeResources(preserveQueuedTrack = false) {
        const keepQueuedTrack = preserveQueuedTrack &&
            this._nextResourceIsCrossfade &&
            this._nextTrack !== null;
        this._clearCrossfadeTimer();
        this._crossfadeToken += 1;
        this.dependencies.voiceConnection._getAudioStream()?.clearCrossfade?.();
        if (this._crossfadeCurrentResource) {
            this._crossfadeCurrentResource.destroy();
            this._crossfadeCurrentResource = null;
        }
        if (this._nextResourceIsCrossfade && this._nextResource) {
            this._nextResource.destroy();
        }
        if (this._nextResourceIsCrossfade) {
            this._nextResource = null;
            this._nextStreamInfo = null;
            if (!keepQueuedTrack)
                this._nextTrack = null;
        }
        this._nextResourceIsCrossfade = keepQueuedTrack;
    }
    setCrossfade(config) {
        logger('debug', 'Player', `[Action: setCrossfade] Method invoked for guild ${this.player.guildId}`);
        this.player.crossfade = config;
        this._clearCrossfadeTimer();
        if (this._nextResourceIsCrossfade && !this._getCrossfadeConfig()) {
            this.player.clearNextTrack();
            this.dependencies.transitions._fading('trackEndSchedule', {
                startPosition: this.dependencies.clock._realPosition()
            });
        }
        else if (this._nextResourceIsCrossfade) {
            this._rescheduleCrossfade();
        }
        return true;
    }
}
