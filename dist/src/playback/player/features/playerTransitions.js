import { EndReasons } from '../../../constants.js';
import { logger } from '../../../utils.js';
import { getCrossfadeSelectionWindowMs } from '../base/playerResources.js';
export class PlayerTransitions {
    recovery;
    runtime;
    playback;
    resourceLoader;
    clock;
    connectionController;
    sponsorBlockController;
    constructor(runtime) {
        this.runtime = runtime;
        this.fading = runtime.nodelink.options.playback.audio?.fading;
        this.crossfade = runtime.nodelink.options.playback.audio?.crossfade;
    }
    _crossfadeToken = 0;
    _crossfadeTimer = null;
    _crossfadePrepareTimer = null;
    _crossfadeCurrentResource = null;
    _crossfadePreparationSafetyMs = 0;
    crossfade;
    fading;
    _fadeTimers = { trackEnd: null, pause: null, stop: null };
    _pendingTrackStartFade = false;
    setFading(config) {
        logger('debug', 'Player', `[Action: setFading] Method invoked for guild ${this.runtime.guildId}`);
        this.fading = config;
        return true;
    }
    _fading(action, payload = {}) {
        logger('debug', 'Player', `[Fading] Executing fading action '${action}' for guild ${this.runtime.guildId}`);
        const timers = this._fadeTimers;
        if (action === 'reset') {
            if (timers.trackEnd)
                clearTimeout(timers.trackEnd);
            if (timers.pause) {
                clearInterval(timers.pause.interval);
                if (timers.pause.timeout)
                    clearTimeout(timers.pause.timeout);
            }
            if (timers.stop) {
                clearInterval(timers.stop.interval);
                if (timers.stop.timeout)
                    clearTimeout(timers.stop.timeout);
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
            if (!this.playback.track?.info)
                return false;
            const total = this.playback.track.endTime && this.playback.track.endTime > 0
                ? this.playback.track.endTime
                : this.playback.track.info.length || 0;
            if (!Number.isFinite(total) || total <= 0)
                return false;
            const startPosition = payload.startPosition || 0;
            const playbackSpeed = this.resourceLoader._getAudioStream()?.getEffectiveRate() ??
                this.clock._getTimescaleSpeed();
            const remaining = Math.max(0, total - startPosition) /
                (playbackSpeed > 0 ? playbackSpeed : 1);
            const trackEndSection = this.fading?.trackEnd;
            const hasFade = trackEndSection &&
                Number.isFinite(trackEndSection.duration) &&
                trackEndSection.duration > 0;
            const fadeDuration = hasFade
                ? Math.min(trackEndSection.duration, remaining)
                : 0;
            const fadeType = hasFade ? trackEndSection.type || 'volume' : 'volume';
            const delay = Math.max(0, remaining - fadeDuration);
            const scratchStyle = (hasFade ? trackEndSection.curve : undefined);
            if (fadeType === 'tape' || fadeType === 'scratch') {
                this.clock._snapshotPosition();
            }
            timers.trackEnd = setTimeout(() => {
                timers.trackEnd = null;
                const stream = this.connectionController.connection?.audioStream;
                if (stream) {
                    if (hasFade && trackEndSection) {
                        if (fadeType === 'volume' || fadeType === 'both') {
                            stream.fadeTo(0, fadeDuration, trackEndSection.curve);
                        }
                        if (fadeType === 'tape' || fadeType === 'both') {
                            stream.tapeTo(fadeDuration, 'stop', trackEndSection.curve);
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
                            stream.scratchTo(fadeDuration, effectiveScratchStyle);
                        }
                    }
                    if (fadeType !== 'volume' && hasFade) {
                        const safetyTimeout = fadeDuration * 2 + 1500;
                        const trackId = this.playback.track?.info.identifier;
                        timers.trackEnd = setTimeout(() => {
                            timers.trackEnd = null;
                            if (this.playback.track?.info.identifier === trackId &&
                                !this.playback.isUpdatingTrack &&
                                !this.playback._isStopping) {
                                logger('debug', 'Player', `Safety stop triggered for guild ${this.runtime.guildId} after long fade-out ramp.`);
                                this.connectionController.connection?.stop(EndReasons.FINISHED);
                            }
                        }, safetyTimeout).unref();
                    }
                    else if (fadeDuration === 0) {
                        if (this.playback.track &&
                            !this.playback.isUpdatingTrack &&
                            !this.playback._isStopping) {
                            logger('debug', 'Player', `Scheduled track end for guild ${this.runtime.guildId} at ${this.playback.track.info.length}ms`);
                            this.connectionController.connection?.stop(EndReasons.FINISHED);
                        }
                    }
                    else {
                        const trackId = this.playback.track?.info.identifier;
                        timers.trackEnd = setTimeout(() => {
                            timers.trackEnd = null;
                            if (this.playback.track?.info.identifier === trackId &&
                                !this.playback.isUpdatingTrack &&
                                !this.playback._isStopping) {
                                logger('debug', 'Player', `Track end after volume fade for guild ${this.runtime.guildId}`);
                                this.connectionController.connection?.stop(EndReasons.FINISHED);
                            }
                        }, fadeDuration + 100).unref();
                    }
                }
            }, delay);
            return true;
        }
        if (this.fading?.enabled !== true)
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
            this.clock._snapshotPosition();
        }
        if (action === 'trackStartArm') {
            const resource = payload.resource;
            if (!resource)
                return false;
            if (fadeType === 'volume' || fadeType === 'both') {
                resource.setFadeVolume(0);
            }
            if (fadeType === 'tape' || fadeType === 'both') {
                resource.tapeTo(0, 'stop');
            }
            if (fadeType === 'scratch') {
                resource.scratchTo(0, 'stop');
            }
            this._pendingTrackStartFade = true;
            return true;
        }
        if (action === 'trackStart') {
            if (!this._pendingTrackStartFade)
                return false;
            const stream = payload.resource?.stream ||
                this.connectionController.connection?.audioStream;
            if (!stream)
                return false;
            this._pendingTrackStartFade = false;
            if (fadeType === 'volume' || fadeType === 'both') {
                const targetVolume = this.playback.duckingController?.getTargetVolume(1) ?? 1;
                stream.fadeTo(targetVolume, section.duration, section.curve);
            }
            if (fadeType === 'tape' || fadeType === 'both') {
                stream.tapeTo(section.duration, 'start', section.curve);
            }
            if (fadeType === 'scratch') {
                stream.scratchTo(section.duration, scratchStyle);
            }
            return true;
        }
        if (action === 'seekPrepare') {
            const resource = payload.resource;
            if (!resource)
                return false;
            if (fadeType === 'volume' || fadeType === 'both') {
                resource.setFadeVolume(0);
            }
            if (fadeType === 'tape' || fadeType === 'both') {
                resource.tapeTo(0, 'stop');
            }
            if (fadeType === 'scratch') {
                resource.scratchTo(0, 'stop');
            }
            return true;
        }
        if (action === 'seek') {
            const stream = this.connectionController.connection?.audioStream;
            if (!stream)
                return false;
            if (fadeType === 'volume' || fadeType === 'both') {
                const targetVolume = this.playback.duckingController?.getTargetVolume(1) ?? 1;
                stream.setFadeVolume(0);
                stream.fadeTo(targetVolume, section.duration, section.curve);
            }
            if (fadeType === 'tape' || fadeType === 'both') {
                stream.tapeTo(section.duration, 'start', section.curve);
            }
            if (fadeType === 'scratch') {
                stream.scratchTo(section.duration, 'start');
            }
            return true;
        }
        if (action === 'pause') {
            const stream = this.connectionController.connection?.audioStream;
            if (!stream)
                return false;
            logger('debug', 'Player', `Pause fade triggered for guild ${this.runtime.guildId}`);
            if (timers.trackEnd) {
                clearTimeout(timers.trackEnd);
                timers.trackEnd = null;
            }
            if (timers.pause) {
                clearInterval(timers.pause.interval);
                if (timers.pause.timeout)
                    clearTimeout(timers.pause.timeout);
            }
            if (fadeType === 'volume' || fadeType === 'both') {
                stream.fadeTo(0, section.duration, section.curve);
            }
            if (fadeType === 'tape' || fadeType === 'both') {
                stream.tapeTo(section.duration, 'stop', section.curve);
            }
            if (fadeType === 'scratch') {
                const style = ['wash', 'backspin', 'baby', 'stop'].includes(scratchStyle)
                    ? scratchStyle
                    : 'wash';
                stream.scratchTo(section.duration, style);
            }
            const startTime = Date.now();
            const checkInterval = setInterval(() => {
                const elapsed = Date.now() - startTime;
                const isTapeDone = stream.checkTapeRampCompleted();
                const isScratchDone = stream.checkScratchEffectCompleted();
                const effectsDone = (fadeType !== 'tape' || isTapeDone === true) &&
                    (fadeType !== 'scratch' || isScratchDone === true) &&
                    (fadeType !== 'both' ||
                        (isTapeDone === true && isScratchDone === true));
                const isRampDone = elapsed >= section.duration && effectsDone;
                const isTimeUp = elapsed > section.duration + 500; // Safety timeout
                if (isRampDone || isTimeUp) {
                    clearInterval(checkInterval);
                    const drainTimeout = setTimeout(() => {
                        this.connectionController.connection?.pause('requested');
                        timers.pause = null;
                    }, 750);
                    if (timers.pause)
                        timers.pause.timeout = drainTimeout;
                }
            }, 10);
            timers.pause = { interval: checkInterval };
            return true;
        }
        if (action === 'resume') {
            if (timers.pause) {
                clearInterval(timers.pause.interval);
                if (timers.pause.timeout)
                    clearTimeout(timers.pause.timeout);
                timers.pause = null;
            }
            const stream = this.connectionController.connection?.audioStream;
            if (!stream)
                return false;
            logger('debug', 'Player', `Resume fade triggered for guild ${this.runtime.guildId}`);
            if (fadeType === 'volume' || fadeType === 'both') {
                stream.setFadeVolume(0);
                stream.fadeTo(1, section.duration, section.curve);
            }
            if (fadeType === 'tape' || fadeType === 'both') {
                stream.tapeTo(0, 'stop');
                stream.tapeTo(section.duration, 'start', section.curve);
            }
            if (fadeType === 'scratch') {
                stream.scratchTo(0, 'stop');
                stream.scratchTo(section.duration, 'start');
            }
            return true;
        }
        if (action === 'trackStop') {
            const stream = this.connectionController.connection?.audioStream;
            if (!stream)
                return false;
            if (timers.stop) {
                clearInterval(timers.stop.interval);
                if (timers.stop.timeout)
                    clearTimeout(timers.stop.timeout);
            }
            if (fadeType === 'volume' || fadeType === 'both') {
                stream.fadeTo(0, section.duration, section.curve);
            }
            if (fadeType === 'tape' || fadeType === 'both') {
                stream.tapeTo(section.duration, 'stop', section.curve);
            }
            if (fadeType === 'scratch') {
                const style = ['wash', 'backspin', 'baby', 'stop'].includes(scratchStyle)
                    ? scratchStyle
                    : 'stop';
                stream.scratchTo(section.duration, style);
            }
            const startTime = Date.now();
            const checkInterval = setInterval(() => {
                const elapsed = Date.now() - startTime;
                const isRampDone = elapsed >= section.duration;
                const isTimeUp = elapsed > section.duration + 500; // Safety timeout
                if (isRampDone || isTimeUp) {
                    clearInterval(checkInterval);
                    const drainTimeout = setTimeout(() => {
                        this.playback._isStopping = false;
                        this.connectionController.connection?.stop(EndReasons.STOPPED);
                        timers.stop = null;
                    }, 750);
                    if (timers.stop)
                        timers.stop.timeout = drainTimeout;
                }
            }, 10);
            timers.stop = { interval: checkInterval };
            return true;
        }
        return false;
    }
    _getCrossfadeConfig() {
        const config = this.crossfade;
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
        const stream = this.resourceLoader._getAudioStream();
        if (!config ||
            !this.playback.track ||
            !this.playback.nextTrack ||
            !this.playback.nextResourceIsCrossfade ||
            this.playback.nextResource ||
            !stream ||
            this.playback.isPaused) {
            return false;
        }
        const total = this.playback.track.endTime && this.playback.track.endTime > 0
            ? this.playback.track.endTime
            : this.playback.track.info.length;
        if (!Number.isFinite(total) || total <= 0)
            return false;
        const delay = 0;
        const token = this._crossfadeToken;
        const payload = this.playback.nextTrack;
        logger('debug', 'Crossfade', `Preparing next track for guild ${this.runtime.guildId} (early warm-up)`);
        this._crossfadePrepareTimer = setTimeout(() => {
            this._crossfadePrepareTimer = null;
            this._prepareCrossfadeResource(token, payload).catch((error) => {
                logger('error', 'Crossfade', `Early crossfade preload failed for guild ${this.runtime.guildId}: ${error.message}`);
            });
        }, delay);
        this._crossfadePrepareTimer.unref();
        return true;
    }
    async _prepareCrossfadeResource(token, payload) {
        const config = this._getCrossfadeConfig();
        const audioStream = this.resourceLoader._getAudioStream();
        const currentTrack = this.playback.track;
        if (token !== this._crossfadeToken ||
            !config ||
            !currentTrack ||
            !audioStream ||
            this.playback.nextTrack !== payload ||
            this.playback.nextResource) {
            return;
        }
        const trackInfo = {
            ...payload.info,
            audioTrackId: payload.audioTrackId
        };
        logger('debug', 'Crossfade', `Preparing ${payload.info.identifier} for guild ${this.runtime.guildId}`);
        const urlData = await this.runtime.nodelink.sources.getTrackUrl(trackInfo);
        if (urlData.exception || token !== this._crossfadeToken)
            return;
        const fetched = await this.resourceLoader._fetchResource(payload.info, urlData, 0, true);
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
        this.playback.nextResource = fetched.stream;
        this.playback.nextStreamInfo = { ...urlData, trackInfo: payload.info };
        logger('debug', 'Crossfade', `Attached ${payload.info.identifier} to the PCM bridge for guild ${this.runtime.guildId}`);
        this._scheduleCrossfade();
    }
    _scheduleCrossfade(startPosition) {
        if (this._crossfadeTimer)
            clearTimeout(this._crossfadeTimer);
        this._crossfadeTimer = null;
        const config = this._getCrossfadeConfig();
        const stream = this.resourceLoader._getAudioStream();
        if (!config ||
            !this.playback.track ||
            !this.playback.nextTrack ||
            !this.playback.nextResourceIsCrossfade ||
            !this.playback.nextResource ||
            !stream ||
            this.playback.isPaused ||
            this.playback.track.info.isStream) {
            return false;
        }
        const total = this.playback.track.endTime && this.playback.track.endTime > 0
            ? this.playback.track.endTime
            : this.playback.track.info.length;
        if (!Number.isFinite(total) || total <= 0)
            return false;
        const position = startPosition ?? this.clock._realPosition();
        const duration = Math.min(config.duration, Math.max(1, total - position));
        const selectionWindow = getCrossfadeSelectionWindowMs(duration);
        const transitionWindow = duration + selectionWindow;
        const playbackRate = Math.max(0.01, stream.getEffectiveRate() ?? 1);
        const pipelineLead = this.clock._getPipelineLeadMs(stream, position);
        const delay = Math.max(0, (total - position - transitionWindow - pipelineLead) / playbackRate);
        const token = this._crossfadeToken;
        this._crossfadeTimer = setTimeout(() => {
            this._crossfadeTimer = null;
            if (token !== this._crossfadeToken || this.playback.isPaused)
                return;
            const attemptStart = () => {
                if (token !== this._crossfadeToken || this.playback.isPaused)
                    return;
                const currentPosition = this.clock._realPosition();
                const remaining = Math.max(1, total - currentPosition);
                const currentPipelineLead = this.clock._getPipelineLeadMs(stream, currentPosition);
                const sourceRemaining = Math.max(1, remaining - currentPipelineLead);
                const waitMs = sourceRemaining - transitionWindow;
                if (waitMs > 20) {
                    this._crossfadeTimer = setTimeout(attemptStart, Math.min(250, waitMs / playbackRate));
                    this._crossfadeTimer.unref();
                    return;
                }
                const started = stream.startCrossfade(Math.min(duration, sourceRemaining), config.curve, sourceRemaining) ?? false;
                if (started) {
                    logger('debug', 'Crossfade', `Armed musical selection window for guild ${this.runtime.guildId} with ${Math.round(sourceRemaining)}ms remaining and ${Math.round(currentPipelineLead)}ms pipeline lead`);
                    return;
                }
                if (sourceRemaining <= 20) {
                    logger('debug', 'Crossfade', `Next track was not ready at the transition point for guild ${this.runtime.guildId}`);
                    return;
                }
                this._crossfadeTimer = setTimeout(attemptStart, 20);
                this._crossfadeTimer.unref();
            };
            attemptStart();
        }, delay);
        this._crossfadeTimer.unref();
        return true;
    }
    _rescheduleCrossfade(startPosition) {
        if (this.playback.nextResourceIsCrossfade && this._fadeTimers.trackEnd) {
            clearTimeout(this._fadeTimers.trackEnd);
            this._fadeTimers.trackEnd = null;
        }
        if (this.resourceLoader._getAudioStream()?.getCrossfadeState().active)
            return true;
        return this.playback.nextResource
            ? this._scheduleCrossfade(startPosition)
            : this._scheduleCrossfadePreparation(startPosition);
    }
    _completeCrossfade(token, consumedMs) {
        if (token !== this._crossfadeToken ||
            !this.playback.track ||
            !this.playback.nextTrack ||
            !this.playback.nextResource ||
            !this.playback.nextResourceIsCrossfade) {
            return;
        }
        const previousTrack = this.playback.track;
        const promotedTrack = this.playback.nextTrack;
        const promotedResource = this.playback.nextResource;
        const promotedStreamInfo = this.playback.nextStreamInfo;
        this._clearCrossfadeTimer();
        this.playback._emitTrackEnd(EndReasons.CROSSFADE);
        if (this._crossfadeCurrentResource) {
            this._crossfadeCurrentResource.destroy();
        }
        this.playback.track = promotedTrack;
        this.playback.nextTrack = null;
        this.playback.nextResource = null;
        this.playback.nextStreamInfo = null;
        this.playback.nextResourceIsCrossfade = false;
        this._crossfadePreparationSafetyMs = 0;
        this._crossfadeCurrentResource = promotedResource;
        this.playback.streamInfo = promotedStreamInfo;
        this.clock._resetAudioConsumptionBaseline(consumedMs, this.resourceLoader._getAudioStream()?.getConsumedMs() ?? 0);
        this.clock.position = consumedMs;
        this.clock._lyricsBasePosition = consumedMs;
        this.clock._lyricsBasePackets =
            this.connectionController.connection?.statistics?.playbackPackets ??
                this.clock._lyricsBasePackets;
        this.recovery._lastPosition = consumedMs;
        this.sponsorBlockController.sponsorBlock.segments = [];
        this.sponsorBlockController.sponsorBlock.lastSkippedUuid = null;
        logger('info', 'Crossfade', `Transitioned ${previousTrack.info.identifier} to ${promotedTrack.info.identifier} for guild ${this.runtime.guildId}`);
        this.playback
            ._emitTrackStart()
            .catch((error) => this.playback._onError(error));
        this._fading('trackEndSchedule', { startPosition: consumedMs });
    }
    _destroyCrossfadeResources(preserveQueuedTrack = false) {
        const keepQueuedTrack = preserveQueuedTrack &&
            this.playback.nextResourceIsCrossfade &&
            this.playback.nextTrack !== null;
        this._clearCrossfadeTimer();
        this._crossfadeToken += 1;
        this.resourceLoader._getAudioStream()?.clearCrossfade();
        if (this._crossfadeCurrentResource) {
            this._crossfadeCurrentResource.destroy();
            this._crossfadeCurrentResource = null;
        }
        if (this.playback.nextResourceIsCrossfade && this.playback.nextResource) {
            this.playback.nextResource.destroy();
        }
        if (this.playback.nextResourceIsCrossfade) {
            this.playback.nextResource = null;
            this.playback.nextStreamInfo = null;
            if (!keepQueuedTrack)
                this.playback.nextTrack = null;
        }
        this.playback.nextResourceIsCrossfade = keepQueuedTrack;
    }
    setCrossfade(config) {
        logger('debug', 'Player', `[Action: setCrossfade] Method invoked for guild ${this.runtime.guildId}`);
        this.crossfade = config;
        this._clearCrossfadeTimer();
        if (this.playback.nextResourceIsCrossfade && !this._getCrossfadeConfig()) {
            this.playback.clearNextTrack();
            this._fading('trackEndSchedule', {
                startPosition: this.clock._realPosition()
            });
        }
        else if (this.playback.nextResourceIsCrossfade) {
            this._rescheduleCrossfade();
        }
        return true;
    }
}
