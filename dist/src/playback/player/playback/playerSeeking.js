import { setTimeout as sleep } from 'node:timers/promises';
import { EndReasons, GatewayEvents } from '../../../constants.js';
import { logger } from '../../../utils.js';
import { AutoMixRegistry } from '../../processing/AutoMixRegistry.js';
import { createSeekeableAudioResource, getStreamProcessor, isWebmYouTubePlayback, SEEK_CROSSFADE_SAFETY_MS } from '../base/playerResources.js';
/** Owns source-specific seek operations. @internal */
export class PlayerSeeking {
    runtime;
    clock;
    connectionController;
    transitionController;
    resourceLoader;
    lyricsController;
    mixController;
    playback;
    recovery;
    constructor(runtime) {
        this.runtime = runtime;
    }
    _isSeeking = false;
    async seek(position, endTime, forceLegacy = false) {
        logger('debug', 'Player', `[Action: seek] Method invoked for guild ${this.runtime.guildId} with target position: ${position}ms`);
        if (this.playback.destroying || !this.playback.track) {
            logger('debug', 'Player', `[Action: seek] Aborted for guild ${this.runtime.guildId}: destroying=${this.playback.destroying}, hasTrack=${!!this.playback.track}`);
            return false;
        }
        const seekTrack = this.playback.track;
        if (!this.playback.track.info.isSeekable &&
            !this.playback.track.info.isStream)
            return false;
        const streamFormat = typeof this.playback.streamInfo?.format === 'string'
            ? this.playback.streamInfo.format.toLowerCase()
            : '';
        if (streamFormat.includes('flac')) {
            logger('warn', 'Player', `Seeking not supported for FLAC stream on guild ${this.runtime.guildId}`);
            return false;
        }
        const seekPosition = position ?? this.clock._realPosition();
        if (seekPosition === 0 &&
            !this.recovery._isRecovering &&
            this.clock._realPosition() < 2000) {
            logger('debug', 'Player', 'Ignoring seek to 0 as track has just started.');
            return false;
        }
        if (seekPosition < 0 ||
            (this.playback.track.info.length > 0 &&
                seekPosition > this.playback.track.info.length))
            return false;
        this._isSeeking = true;
        try {
            const sourceName = this.playback.track.info.sourceName;
            const resolvedSourceName = this.playback.streamInfo?.newTrack?.info?.sourceName ?? sourceName;
            const unsupportedSources = ['local', 'deezer'];
            let seekPromise;
            if (!this.playback.streamInfo?.url) {
                logger('debug', 'Player', 'No stream info URL available for seek. awaiting getTrackUrl.');
                await sleep(1600);
                if (this.playback.destroying || this.playback.track !== seekTrack)
                    return false;
                if (!this.playback.streamInfo?.url) {
                    logger('debug', 'Player', 'Still no stream info URL available for seek.');
                    if (this.playback.track) {
                        const trackInfo = {
                            ...this.playback.track.info,
                            audioTrackId: this.playback.track.audioTrackId
                        };
                        const urlData = await this.runtime.nodelink.sources.getTrackUrl(trackInfo);
                        if (this.playback.destroying || this.playback.track !== seekTrack)
                            return false;
                        this.playback.streamInfo = {
                            ...urlData,
                            trackInfo: this.playback.track.info
                        };
                        logger('debug', 'Player', 'Fetched stream info URL for seek after wait.');
                    }
                }
                else {
                    logger('debug', 'Player', 'Stream info URL became available during wait.');
                }
            }
            const source = this.runtime.nodelink.sources.getSource(resolvedSourceName);
            const hasSourceLoader = source?.loadStream;
            const canNativeSeek = !!hasSourceLoader &&
                (this.playback.streamInfo?.protocol === 'sabr' ||
                    (sourceName === 'deezer' && resolvedSourceName === 'deezer') ||
                    isWebmYouTubePlayback(resolvedSourceName, this.playback.streamInfo));
            if (forceLegacy) {
                seekPromise = this._restartSeek(seekPosition, endTime === null
                    ? undefined
                    : (endTime ?? this.playback.track.endTime));
            }
            else if (canNativeSeek) {
                seekPromise = this._seekUsingSource(seekPosition, endTime === null
                    ? undefined
                    : (endTime ?? this.playback.track.endTime));
            }
            else if (!unsupportedSources.includes(resolvedSourceName) &&
                this.playback.streamInfo?.url &&
                this.playback.streamInfo.protocol !== 'hls' &&
                this.playback.streamInfo.protocol !== 'dash') {
                seekPromise = this._seekeableSeek(seekPosition, endTime === null
                    ? undefined
                    : (endTime ?? this.playback.track.endTime));
            }
            else {
                seekPromise = this._restartSeek(seekPosition, endTime === null
                    ? undefined
                    : (endTime ?? this.playback.track.endTime));
            }
            const startPosition = this.clock._realPosition();
            const result = await seekPromise;
            if (this.playback.destroying || this.playback.track !== seekTrack)
                return false;
            if (result) {
                this.runtime.emitEvent(GatewayEvents.SEEK, {
                    position: this.clock.position,
                    duration: this.clock.position - startPosition
                });
                if (this.lyricsController._lyricsMarkerTimer) {
                    clearTimeout(this.lyricsController._lyricsMarkerTimer);
                    this.lyricsController._lyricsMarkerTimer = null;
                }
                if (this.lyricsController.isLyricsSubscribed)
                    this.lyricsController._recalculateLyricsIndex(undefined, undefined, true);
                this.transitionController._fading('seek');
                this.transitionController._fading('trackEndSchedule', {
                    startPosition: this.clock.position
                });
                if (this.playback.nextResourceIsCrossfade) {
                    this.transitionController._crossfadePreparationSafetyMs =
                        SEEK_CROSSFADE_SAFETY_MS;
                    this.transitionController._rescheduleCrossfade(this.clock.position);
                    const remainingMs = (this.playback.track?.endTime ||
                        this.playback.track?.info.length ||
                        0) - this.clock.position;
                    if (remainingMs <= 40000 &&
                        this.playback.track &&
                        this.playback.streamInfo) {
                        const currentTrack = this.playback.track;
                        const currentStreamInfo = this.playback.streamInfo;
                        AutoMixRegistry.getInstance()
                            .requestOutroAnalysis({
                            track: currentTrack,
                            urlData: currentStreamInfo,
                            priority: 'IMMINENT_TRANSITION',
                            triggerSource: `player:${this.runtime.guildId}:seekImminent`,
                            fetchResource: (info, urlData, windowStartMs, returnPcm) => this.resourceLoader._fetchResource(info, urlData, windowStartMs, returnPcm)
                        })
                            .catch(() => { });
                    }
                }
            }
            return result;
        }
        catch (error) {
            if (this.playback.destroying || this.playback.track !== seekTrack)
                return false;
            logger('error', 'Player', `Seek failed for guild ${this.runtime.guildId}`, error);
            this.playback._onError(error);
            return false;
        }
        finally {
            this._isSeeking = false;
        }
    }
    async _seekUsingSource(position, endTime) {
        if (!this.playback.track)
            return false;
        const seekTrack = this.playback.track;
        logger('debug', 'Player', `Seeking using source (native) to ${position}ms for guild ${this.runtime.guildId}`);
        this.clock.position = position;
        this.playback.track.endTime = endTime;
        let reuseUrlData = null;
        let seekHandoff = null;
        if (this.playback.streamInfo?.protocol === 'sabr' &&
            this.connectionController.connection?.audioStream) {
            const inputStream = this.connectionController.connection.audioStream?.pipes?.[0];
            const previousSession = await inputStream?.beginSeekHandoff?.();
            if (this.playback.destroying || this.playback.track !== seekTrack) {
                inputStream?.cancelSeekHandoff?.();
                return false;
            }
            if (previousSession) {
                seekHandoff = inputStream?.cancelSeekHandoff
                    ? { cancelSeekHandoff: inputStream.cancelSeekHandoff }
                    : null;
                logger('debug', 'Player', `Extracted SABR session state: rn=${previousSession.requestNumber}, hasCookie=${!!previousSession.nextRequestPolicy?.playbackCookie}`);
                reuseUrlData = {
                    newTrack: this.playback.streamInfo.newTrack,
                    protocol: this.playback.streamInfo.protocol,
                    url: this.playback.streamInfo.url,
                    additionalData: {
                        ...this.playback.streamInfo.additionalData,
                        previousSession,
                        startTime: position
                    }
                };
                logger('debug', 'Player', `Reusing existing SABR streaming URL for seek to maintain session`);
            }
        }
        const trackInfo = {
            ...this.playback.track.info,
            audioTrackId: this.playback.track.audioTrackId
        };
        // Reuse the playing URL when it's a native WebM stream: resolving a
        // fresh URL hits the cipher on every seek. A stale URL just fails
        // here and falls through to the fresh resolve below.
        const seekSourceName = this.playback.streamInfo?.newTrack?.info?.sourceName ?? this.playback.track.info.sourceName;
        if (!reuseUrlData &&
            this.playback.streamInfo?.protocol !== 'sabr' &&
            this.playback.streamInfo?.protocol !== 'hls' &&
            this.playback.streamInfo?.protocol !== 'dash' &&
            isWebmYouTubePlayback(seekSourceName, this.playback.streamInfo) &&
            this.playback.streamInfo?.url) {
            const cachedUrlData = this.playback
                .streamInfo;
            const cachedResult = await this.playback._connectAndPlayStream(cachedUrlData, position, 'source-seek', 'seekPrepare', `Playing resource for guild ${this.runtime.guildId} after source seek (cached URL)`, true, true);
            if (this.playback.destroying || this.playback.track !== seekTrack)
                return false;
            if (cachedResult)
                return true;
            logger('debug', 'Player', `Cached URL seek failed for guild ${this.runtime.guildId}, resolving fresh URL`);
        }
        const urlData = reuseUrlData ||
            (await this.runtime.nodelink.sources.getTrackUrl(trackInfo));
        if (this.playback.destroying || this.playback.track !== seekTrack) {
            seekHandoff?.cancelSeekHandoff();
            return false;
        }
        this.playback.streamInfo = {
            ...urlData,
            trackInfo: this.playback.track.info
        };
        if (urlData.exception) {
            seekHandoff?.cancelSeekHandoff();
            const error = new Error(urlData.exception.message);
            this.playback._onError(error);
            return false;
        }
        try {
            const result = await this.playback._connectAndPlayStream(urlData, position, 'source-seek', 'seekPrepare', `Playing resource for guild ${this.runtime.guildId} after source seek`, true);
            if (this.playback.destroying || this.playback.track !== seekTrack) {
                seekHandoff?.cancelSeekHandoff();
                return false;
            }
            if (!result)
                seekHandoff?.cancelSeekHandoff();
            return result;
        }
        catch (error) {
            seekHandoff?.cancelSeekHandoff();
            throw error;
        }
    }
    async _seekeableSeek(position, endTime) {
        const seekTrack = this.playback.track;
        if (!seekTrack || this.playback.destroying)
            return false;
        if (this.runtime.nodelink.options?.playback.mix?.enabled !== false) {
            await this.mixController._ensureAudioMixer();
            if (this.playback.destroying || this.playback.track !== seekTrack)
                return false;
        }
        await getStreamProcessor();
        if (this.playback.destroying || this.playback.track !== seekTrack)
            return false;
        const seekResourceFactory = createSeekeableAudioResource;
        if (!seekResourceFactory) {
            return this._restartSeek(position, endTime);
        }
        logger('debug', 'Player', `Seeking with Seekeable to ${position}ms for guild ${this.runtime.guildId}`);
        this.clock.position = position;
        try {
            let url = this.playback.streamInfo?.url;
            // Refresh YouTube URL before seek: mid-stream rotation updates
            // _streamChunkedHttp's currentUrl but player.streamInfo stays stale.
            // Re-resolving ensures seekable-stream fetches from the healthy client
            // (example: VisionOs after AndroidVR 403s) at the exact position.
            // Also needs to be the resolvedSourceName because it can be a mirror (spotify -> yt example.)
            const resolvedSourceName = this.playback.streamInfo?.newTrack?.info?.sourceName ||
                this.playback.track?.info?.sourceName;
            const isYouTubeStream = !!url &&
                resolvedSourceName &&
                ['youtube', 'ytmusic'].includes(resolvedSourceName);
            if (isYouTubeStream) {
                try {
                    const youtubeTrackInfo = this.playback.streamInfo?.newTrack?.info
                        ? {
                            ...this.playback.streamInfo.newTrack.info,
                            audioTrackId: this.playback.track?.audioTrackId
                        }
                        : {
                            ...this.playback.track?.info,
                            audioTrackId: this.playback.track?.audioTrackId
                        };
                    const fresh = await this.runtime.nodelink.sources.getTrackUrl(youtubeTrackInfo, undefined, true);
                    if (this.playback.destroying || this.playback.track !== seekTrack)
                        return false;
                    if (!fresh.exception && fresh.url && this.playback.track) {
                        const oldUrl = url;
                        this.playback.streamInfo = {
                            ...fresh,
                            trackInfo: this.playback.track.info
                        };
                        url = fresh.url;
                        logger('debug', 'Player', `Refreshed YouTube URL for seek to ${position}ms for guild ${this.runtime.guildId} (old c=${oldUrl.match(/[?&]c=([^&]+)/)?.[1] || '?'}, new c=${fresh.url.match(/[?&]c=([^&]+)/)?.[1] || '?'})`);
                    }
                    else if (fresh.exception) {
                        logger('debug', 'Player', `YouTube URL refresh for seek returned exception: ${fresh.exception.message}`);
                    }
                }
                catch (error) {
                    if (this.playback.destroying || this.playback.track !== seekTrack)
                        return false;
                    logger('debug', 'Player', `YouTube URL refresh for seek threw: ${error.message}`);
                }
            }
            if (!url)
                return false;
            const resourceResult = await seekResourceFactory(this.runtime.guildId, url, position, endTime, this.runtime.nodelink, this.playback.filters, this.playback, this.playback.volumePercent / 100, this.mixController.audioMixer, false, this.playback.loudnessNormalizer, this.transitionController._getCrossfadeConfig() !== null);
            if (this.playback.destroying || this.playback.track !== seekTrack) {
                if (!('exception' in resourceResult))
                    resourceResult.destroy();
                return false;
            }
            if (resourceResult.exception) {
                const exception = resourceResult.exception;
                logger('error', 'Player', `Seekeable resource creation failed for guild ${this.runtime.guildId}: ${exception.message}. Falling back to old method.`);
                this.runtime.emitEvent(GatewayEvents.TRACK_EXCEPTION, {
                    track: this.playback.track,
                    exception
                });
                this.playback._emitTrackEnd(EndReasons.LOAD_FAILED);
                return this._restartSeek(position, endTime);
            }
            const resource = resourceResult;
            if (this.playback.volumePercent !== 100) {
                resource.setVolume(this.playback.volumePercent / 100);
            }
            this.transitionController._fading('seekPrepare', { resource });
            resource.setFilters(this.playback.filters);
            this.transitionController._destroyCrossfadeResources(true);
            this.clock._resetAudioConsumptionBaseline(position);
            const oldStream = this.connectionController.connection?.play(resource);
            this.playback._currentResource = resource;
            if (oldStream && oldStream !== resource)
                oldStream.destroy();
            await this.connectionController.waitEvent('playerStateChange', (s) => s.status === 'playing');
            if (this.playback.destroying || this.playback.track !== seekTrack)
                return false;
            this.clock._lyricsBasePosition = position;
            this.clock._lyricsBasePackets =
                this.connectionController.connection?.statistics?.playbackPackets ?? 0;
            return true;
        }
        catch (cause) {
            if (this.playback.destroying || this.playback.track !== seekTrack)
                return false;
            const error = cause;
            logger('error', 'Player', `An unexpected error occurred during seekeable seek for guild ${this.runtime.guildId}: ${error.message}. Falling back to old method.`);
            this.runtime.emitEvent(GatewayEvents.TRACK_EXCEPTION, {
                track: this.playback.track,
                exception: {
                    message: error.message,
                    severity: 'fault',
                    cause: 'UNKNOWN_ERROR'
                }
            });
            this.playback._emitTrackEnd(EndReasons.LOAD_FAILED);
            return this._restartSeek(position, endTime);
        }
    }
    async _restartSeek(position, endTime) {
        if (!this.playback.track)
            return false;
        const seekTrack = this.playback.track;
        if (position < 0 ||
            (this.playback.track.info.length > 0 &&
                position > this.playback.track.info.length))
            return false;
        logger('debug', 'Player', `Seeking with legacy method to ${position}ms for guild ${this.runtime.guildId}`);
        this.clock.position = position;
        this.playback.track.endTime = endTime;
        const trackInfo = {
            ...this.playback.track.info,
            audioTrackId: this.playback.track.audioTrackId
        };
        const urlData = await this.runtime.nodelink.sources.getTrackUrl(trackInfo, undefined, this.recovery._isRecovering);
        if (this.playback.destroying || this.playback.track !== seekTrack)
            return false;
        this.playback.streamInfo = {
            ...urlData,
            trackInfo: this.playback.track.info
        };
        if (urlData.exception) {
            const error = new Error(urlData.exception.message);
            this.playback._onError(error);
            return false;
        }
        if (!this.connectionController.connection) {
            this.connectionController._initConnection();
        }
        if (!this.connectionController._isVoiceReady()) {
            this.connectionController._ensureVoiceConnection();
            try {
                await this.connectionController.waitForReady();
            }
            catch { }
        }
        if (this.playback.destroying || this.playback.track !== seekTrack)
            return false;
        if (!this.connectionController.connection ||
            !this.connectionController._isVoiceReady()) {
            this.playback._onError(new Error(`Voice connection timed out for guild ${this.runtime.guildId} (missing UDP info).`, { cause: 'VOICE_CONNECTION_TIMEOUT' }));
            return false;
        }
        const fetched = await this.resourceLoader._fetchResource(this.playback.track.info, urlData, position);
        if (this.playback.destroying || this.playback.track !== seekTrack) {
            if (!('exception' in fetched))
                fetched.stream.destroy();
            return false;
        }
        if ('exception' in fetched) {
            const error = new Error(fetched.exception.message);
            this.playback._onError(error);
            return false;
        }
        this.resourceLoader._cleanupCurrentAudioStream('legacy-seek', true);
        const resource = fetched.stream;
        if (this.playback.volumePercent !== 100) {
            resource.setVolume(this.playback.volumePercent / 100);
        }
        this.transitionController._fading('seekPrepare', { resource });
        this.playback.setFilters(this.playback.filters);
        logger('debug', 'Player', `Playing resource for guild ${this.runtime.guildId} after legacy seek`);
        this.playback._currentResource = resource;
        this.connectionController.connection.play(resource);
        // Connect ducking controller to the new audio stream
        if (this.playback.duckingController) {
            this.playback.duckingController.attach(this.connectionController.connection);
            this.playback.duckingController.setStreamControl({
                fadeTo: (volume, durationMs, curve) => resource.fadeTo(volume, durationMs, curve)
            });
        }
        await this.connectionController.waitEvent('playerStateChange', (s) => s.status === 'playing');
        if (this.playback.destroying || this.playback.track !== seekTrack)
            return false;
        this.clock._lyricsBasePosition = position;
        this.clock._lyricsBasePackets =
            this.connectionController.connection?.statistics?.playbackPackets ?? 0;
        return true;
    }
}
