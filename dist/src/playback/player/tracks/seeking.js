import { setTimeout as sleep } from 'node:timers/promises';
import { EndReasons, GatewayEvents } from '../../../constants.js';
import { logger } from '../../../utils.js';
import { AutoMixRegistry } from '../../processing/AutoMixRegistry.js';
import { createSeekeableAudioResource, getStreamProcessor, isWebmYouTubePlayback } from '../audio/resources.js';
const SEEK_CROSSFADE_SAFETY_MS = 15000;
/**
 * Selects and runs the existing seek strategies.
 * @internal
 */
export class PlayerSeeking {
    player;
    nodelink;
    dependencies;
    _isSeeking = false;
    constructor(player, nodelink, dependencies) {
        this.player = player;
        this.nodelink = nodelink;
        this.dependencies = dependencies;
    }
    get isSeeking() {
        return this._isSeeking;
    }
    /**
     * Performs a seek operation to the requested position.
     *
     * @param position - Target position in milliseconds. Uses current position when omitted.
     * @param endTime - Optional end time to enforce after the seek.
     * @returns True when the seek succeeds; false otherwise.
     */
    async seek(position, endTime, forceLegacy = false) {
        logger('debug', 'Player', `[Action: seek] Method invoked for guild ${this.player.guildId} with target position: ${position}ms`);
        if (this.player.destroying || !this.player.track) {
            logger('debug', 'Player', `[Action: seek] Aborted for guild ${this.player.guildId}: destroying=${this.player.destroying}, hasTrack=${!!this.player.track}`);
            return false;
        }
        const seekTrack = this.player.track;
        if (!this.player.track.info.isSeekable && !this.player.track.info.isStream)
            return false;
        const streamFormat = typeof this.player.streamInfo?.format === 'string'
            ? this.player.streamInfo.format.toLowerCase()
            : '';
        if (streamFormat.includes('flac')) {
            logger('warn', 'Player', `Seeking not supported for FLAC stream on guild ${this.player.guildId}`);
            return false;
        }
        const seekPosition = position ?? this.dependencies.clock._realPosition();
        if (seekPosition === 0 &&
            !this.dependencies.monitor.isRecovering &&
            this.dependencies.clock._realPosition() < 2000) {
            logger('debug', 'Player', 'Ignoring seek to 0 as track has just started.');
            return false;
        }
        if (seekPosition < 0 ||
            (this.player.track.info.length > 0 &&
                seekPosition > this.player.track.info.length))
            return false;
        this._isSeeking = true;
        try {
            const sourceName = this.player.track.info.sourceName;
            const resolvedSourceName = this.player.streamInfo?.newTrack?.info?.sourceName ?? sourceName;
            const unsupportedSources = ['local', 'deezer'];
            let seekPromise;
            if (!this.player.streamInfo?.url) {
                logger('debug', 'Player', 'No stream info URL available for seek. awaiting getTrackUrl.');
                await sleep(1600);
                if (this.player.destroying || this.player.track !== seekTrack)
                    return false;
                if (!this.player.streamInfo?.url) {
                    logger('debug', 'Player', 'Still no stream info URL available for seek.');
                    if (this.player.track) {
                        const trackInfo = {
                            ...this.player.track.info,
                            audioTrackId: this.player.track.audioTrackId
                        };
                        const urlData = await this.nodelink.sources.getTrackUrl(trackInfo);
                        if (this.player.destroying || this.player.track !== seekTrack)
                            return false;
                        this.player.streamInfo = {
                            ...urlData,
                            trackInfo: this.player.track.info
                        };
                        logger('debug', 'Player', 'Fetched stream info URL for seek after wait.');
                    }
                }
                else {
                    logger('debug', 'Player', 'Stream info URL became available during wait.');
                }
            }
            const source = this.nodelink.sources.getSource(resolvedSourceName);
            const hasSourceLoader = source?.loadStream;
            const canNativeSeek = !!hasSourceLoader &&
                (this.player.streamInfo?.protocol === 'sabr' ||
                    (sourceName === 'deezer' && resolvedSourceName === 'deezer') ||
                    isWebmYouTubePlayback(resolvedSourceName, this.player.streamInfo));
            if (forceLegacy) {
                seekPromise = this._legacySeek(seekPosition, endTime === null ? undefined : (endTime ?? this.player.track.endTime));
            }
            else if (canNativeSeek) {
                seekPromise = this._seekUsingSource(seekPosition, endTime === null ? undefined : (endTime ?? this.player.track.endTime));
            }
            else if (!unsupportedSources.includes(resolvedSourceName) &&
                this.player.streamInfo?.url &&
                this.player.streamInfo.protocol !== 'hls' &&
                this.player.streamInfo.protocol !== 'dash') {
                seekPromise = this._seekUsingSeekableStream(seekPosition, endTime === null ? undefined : (endTime ?? this.player.track.endTime));
            }
            else {
                seekPromise = this._legacySeek(seekPosition, endTime === null ? undefined : (endTime ?? this.player.track.endTime));
            }
            const startPosition = this.dependencies.clock._realPosition();
            const result = await seekPromise;
            if (this.player.destroying || this.player.track !== seekTrack)
                return false;
            if (result) {
                this.player.emitEvent(GatewayEvents.SEEK, {
                    position: this.player.position,
                    duration: this.player.position - startPosition
                });
                this.dependencies.lyrics._clearMarkerTimer();
                if (this.player.isLyricsSubscribed)
                    this.dependencies.lyrics._recalculateLyricsIndex(undefined, undefined, true);
                this.dependencies.fadingEffects._fading('seek');
                this.dependencies.fadingEffects._fading('trackEndSchedule', {
                    startPosition: this.player.position
                });
                if (this.dependencies.queue.nextResourceIsCrossfade) {
                    this.dependencies.queue._rescheduleAfterSeek(this.player.position, SEEK_CROSSFADE_SAFETY_MS);
                    const remainingMs = (this.player.track?.endTime ||
                        this.player.track?.info.length ||
                        0) - this.player.position;
                    if (remainingMs <= 40000 &&
                        this.player.track &&
                        this.player.streamInfo) {
                        const currentTrack = this.player.track;
                        const currentStreamInfo = this.player.streamInfo;
                        AutoMixRegistry.getInstance()
                            .requestOutroAnalysis({
                            track: currentTrack,
                            urlData: currentStreamInfo,
                            priority: 'IMMINENT_TRANSITION',
                            triggerSource: `player:${this.player.guildId}:seekImminent`,
                            fetchResource: (info, uData, windowStartMs, returnPcm) => this.dependencies.resources._fetchResource(info, uData, windowStartMs, returnPcm)
                        })
                            .catch(() => { });
                    }
                }
            }
            return result;
        }
        catch (e) {
            if (this.player.destroying || this.player.track !== seekTrack)
                return false;
            logger('error', 'Player', `Seek failed for guild ${this.player.guildId}`, e);
            this.dependencies._onError(e);
            return false;
        }
        finally {
            this._isSeeking = false;
        }
    }
    /**
     * Seeks using source-native capabilities (e.g., SABR/Deezer).
     */
    async _seekUsingSource(position, endTime) {
        if (!this.player.track)
            return false;
        const seekTrack = this.player.track;
        logger('debug', 'Player', `Seeking using source (native) to ${position}ms for guild ${this.player.guildId}`);
        this.player.position = position;
        this.player.track.endTime = endTime;
        let reuseUrlData = null;
        let seekHandoff = null;
        if (this.player.streamInfo?.protocol === 'sabr' &&
            this.player.connection?.audioStream) {
            const inputStream = this.player.connection.audioStream?.pipes?.[0];
            const previousSession = await inputStream?.beginSeekHandoff?.();
            if (this.player.destroying || this.player.track !== seekTrack) {
                inputStream?.cancelSeekHandoff?.();
                return false;
            }
            if (previousSession) {
                seekHandoff = inputStream?.cancelSeekHandoff
                    ? { cancelSeekHandoff: inputStream.cancelSeekHandoff }
                    : null;
                logger('debug', 'Player', `Extracted SABR session state: rn=${previousSession.requestNumber}, hasCookie=${!!previousSession.nextRequestPolicy?.playbackCookie}`);
                reuseUrlData = {
                    newTrack: this.player.streamInfo.newTrack,
                    protocol: this.player.streamInfo.protocol,
                    url: this.player.streamInfo.url,
                    additionalData: {
                        ...this.player.streamInfo.additionalData,
                        previousSession,
                        startTime: position
                    }
                };
                logger('debug', 'Player', `Reusing existing SABR streaming URL for seek to maintain session`);
            }
        }
        const trackInfo = {
            ...this.player.track.info,
            audioTrackId: this.player.track.audioTrackId
        };
        // Reuse the playing URL when it's a native WebM stream: resolving a
        // fresh URL hits the cipher on every seek. A stale URL just fails
        // here and falls through to the fresh resolve below.
        const seekSourceName = this.player.streamInfo?.newTrack?.info?.sourceName ?? this.player.track.info.sourceName;
        if (!reuseUrlData &&
            this.player.streamInfo?.protocol !== 'sabr' &&
            this.player.streamInfo?.protocol !== 'hls' &&
            this.player.streamInfo?.protocol !== 'dash' &&
            isWebmYouTubePlayback(seekSourceName, this.player.streamInfo) &&
            this.player.streamInfo?.url) {
            const cachedUrlData = this.player.streamInfo;
            const cachedResult = await this.dependencies.playback._connectAndPlayStream(cachedUrlData, position, 'source-seek', 'seekPrepare', `Playing resource for guild ${this.player.guildId} after source seek (cached URL)`, true, true);
            if (this.player.destroying || this.player.track !== seekTrack)
                return false;
            if (cachedResult)
                return true;
            logger('debug', 'Player', `Cached URL seek failed for guild ${this.player.guildId}, resolving fresh URL`);
        }
        const urlData = reuseUrlData || (await this.nodelink.sources.getTrackUrl(trackInfo));
        if (this.player.destroying || this.player.track !== seekTrack) {
            seekHandoff?.cancelSeekHandoff();
            return false;
        }
        this.player.streamInfo = { ...urlData, trackInfo: this.player.track.info };
        if (urlData.exception) {
            seekHandoff?.cancelSeekHandoff();
            const err = new Error(urlData.exception.message);
            this.dependencies._onError(err);
            return false;
        }
        try {
            const result = await this.dependencies.playback._connectAndPlayStream(urlData, position, 'source-seek', 'seekPrepare', `Playing resource for guild ${this.player.guildId} after source seek`, true);
            if (this.player.destroying || this.player.track !== seekTrack) {
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
    /**
     * Seeks using seekable-stream helper for compatible sources.
     */
    async _seekUsingSeekableStream(position, endTime) {
        if (this.nodelink.options?.playback.mix?.enabled !== false) {
            await this.dependencies.mixer._ensureAudioMixer();
        }
        await getStreamProcessor();
        const seekResourceFactory = createSeekeableAudioResource;
        if (!seekResourceFactory) {
            return this._legacySeek(position, endTime);
        }
        logger('debug', 'Player', `Seeking with Seekeable to ${position}ms for guild ${this.player.guildId}`);
        this.player.position = position;
        try {
            let url = this.player.streamInfo?.url;
            // Refresh YouTube URL before seek: mid-stream rotation updates
            // _streamChunkedHttp's currentUrl but player.streamInfo stays stale.
            // Re-resolving ensures seekable-stream fetches from the healthy client
            // (example: VisionOs after AndroidVR 403s) at the exact position.
            // Also needs to be the resolvedSourceName because it can be a mirror (spotify -> yt example.)
            const resolvedSourceName = this.player.streamInfo?.newTrack?.info?.sourceName ||
                this.player.track?.info?.sourceName;
            const isYouTubeStream = !!url &&
                resolvedSourceName &&
                ['youtube', 'ytmusic'].includes(resolvedSourceName);
            if (isYouTubeStream) {
                try {
                    const youtubeTrackInfo = this.player.streamInfo?.newTrack?.info
                        ? {
                            ...this.player.streamInfo.newTrack.info,
                            audioTrackId: this.player.track?.audioTrackId
                        }
                        : {
                            ...this.player.track?.info,
                            audioTrackId: this.player.track?.audioTrackId
                        };
                    const fresh = await this.nodelink.sources.getTrackUrl(youtubeTrackInfo, undefined, true);
                    if (!fresh.exception && fresh.url && this.player.track) {
                        const oldUrl = url;
                        this.player.streamInfo = {
                            ...fresh,
                            trackInfo: this.player.track.info
                        };
                        url = fresh.url;
                        logger('debug', 'Player', `Refreshed YouTube URL for seek to ${position}ms for guild ${this.player.guildId} (old c=${oldUrl.match(/[?&]c=([^&]+)/)?.[1] || '?'}, new c=${fresh.url.match(/[?&]c=([^&]+)/)?.[1] || '?'})`);
                    }
                    else if (fresh.exception) {
                        logger('debug', 'Player', `YouTube URL refresh for seek returned exception: ${fresh.exception.message}`);
                    }
                }
                catch (e) {
                    logger('debug', 'Player', `YouTube URL refresh for seek threw: ${e.message}`);
                }
            }
            if (!url)
                return false;
            const resourceResult = await seekResourceFactory(this.player.guildId, url, position, endTime, this.nodelink, this.player.filters, this.player, this.player.volumePercent / 100, this.player.audioMixer, false, this.player.loudnessNormalizer, this.dependencies.queue._getCrossfadeConfig() !== null);
            if (resourceResult.exception) {
                const exception = resourceResult.exception;
                logger('error', 'Player', `Seekeable resource creation failed for guild ${this.player.guildId}: ${exception.message}. Falling back to old method.`);
                this.player.emitEvent(GatewayEvents.TRACK_EXCEPTION, {
                    track: this.player.track,
                    exception
                });
                this.dependencies.events.emitTrackEnd(EndReasons.LOAD_FAILED);
                return this._legacySeek(position, endTime);
            }
            const resource = resourceResult;
            if (this.player.volumePercent !== 100) {
                resource.setVolume(this.player.volumePercent / 100);
            }
            this.dependencies.fadingEffects._fading('seekPrepare', { resource });
            resource.setFilters(this.player.filters);
            this.dependencies.queue._destroyCrossfadeResources(true);
            this.dependencies.clock._resetAudioConsumptionBaseline(position);
            const oldStream = this.player.connection?.play(resource);
            await this.player.waitEvent('playerStateChange', (s) => s.status === 'playing');
            if (oldStream) {
                oldStream.destroy();
            }
            this.dependencies.resources._replaceResource(resource);
            this.dependencies.clock._resetPacketBaseline(position);
            return true;
        }
        catch (e) {
            const err = e;
            logger('error', 'Player', `An unexpected error occurred during seekeable seek for guild ${this.player.guildId}: ${err.message}. Falling back to old method.`);
            this.player.emitEvent(GatewayEvents.TRACK_EXCEPTION, {
                track: this.player.track,
                exception: {
                    message: err.message,
                    severity: 'fault',
                    cause: 'UNKNOWN_ERROR'
                }
            });
            this.dependencies.events.emitTrackEnd(EndReasons.LOAD_FAILED);
            return this._legacySeek(position, endTime);
        }
    }
    /**
     * Seeks using legacy re-fetch strategy.
     */
    async _legacySeek(position, endTime) {
        if (!this.player.track)
            return false;
        if (position < 0 ||
            (this.player.track.info.length > 0 &&
                position > this.player.track.info.length))
            return false;
        logger('debug', 'Player', `Seeking with legacy method to ${position}ms for guild ${this.player.guildId}`);
        this.player.position = position;
        this.player.track.endTime = endTime;
        const trackInfo = {
            ...this.player.track.info,
            audioTrackId: this.player.track.audioTrackId
        };
        const urlData = await this.nodelink.sources.getTrackUrl(trackInfo, undefined, this.dependencies.monitor.isRecovering);
        if (!this.player.track)
            return false;
        this.player.streamInfo = { ...urlData, trackInfo: this.player.track.info };
        if (urlData.exception) {
            const err = new Error(urlData.exception.message);
            this.dependencies._onError(err);
            return false;
        }
        if (!this.player.connection) {
            this.dependencies.voiceConnection._initConnection();
        }
        if (!this.dependencies.voiceConnection._isVoiceReady()) {
            this.dependencies.voiceConnection._ensureVoiceConnection();
            try {
                await this.player.waitEvent('stateChange', (state) => this.dependencies.voiceConnection._isConnectionReady(state));
            }
            catch { }
        }
        if (!this.player.connection ||
            !this.dependencies.voiceConnection._isVoiceReady()) {
            this.dependencies._onError(new Error(`Voice connection timed out for guild ${this.player.guildId} (missing UDP info).`, { cause: 'VOICE_CONNECTION_TIMEOUT' }));
            return false;
        }
        const fetched = await this.dependencies.resources._fetchResource(this.player.track.info, urlData, position);
        if ('exception' in fetched) {
            const err = new Error(fetched.exception.message);
            this.dependencies._onError(err);
            return false;
        }
        this.dependencies.resources._cleanupCurrentAudioStream('legacy-seek', true);
        const resource = fetched.stream;
        if (this.player.volumePercent !== 100) {
            resource.setVolume(this.player.volumePercent / 100);
        }
        this.dependencies.fadingEffects._fading('seekPrepare', { resource });
        this.player.setFilters(this.player.filters);
        logger('debug', 'Player', `Playing resource for guild ${this.player.guildId} after legacy seek`);
        this.dependencies.resources._adoptResource(resource);
        this.player.connection.play(resource);
        // Connect ducking controller to the new audio stream
        if (this.player.duckingController && resource.fadeTo) {
            this.player.duckingController.attach(this.player.connection);
            this.player.duckingController.setStreamControl({
                fadeTo: (volume, durationMs, curve) => resource.fadeTo?.(volume, durationMs, curve)
            });
        }
        await this.player.waitEvent('playerStateChange', (s) => s.status === 'playing');
        this.dependencies.clock._resetPacketBaseline(position);
        return true;
    }
}
