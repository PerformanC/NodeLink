import { Buffer } from 'node:buffer';
import process from 'node:process';
import { PassThrough } from 'node:stream';
import { GatewayEvents } from '../../../constants.js';
import { YOUTUBE_WEBM_ITAGS } from '../../../sources/youtube/common.js';
import { logger } from '../../../utils.js';
const trackFinishMemoryTraceEnabled = process.env.NODELINK_TRACK_FINISH_MEMORY_TRACE?.toLowerCase() === 'true';
export let createAudioResource = null;
export let createSeekeableAudioResource = null;
export function isWebmYouTubePlayback(sourceName, data) {
    if (sourceName !== 'youtube' && sourceName !== 'ytmusic')
        return false;
    const itag = data?.additionalData?.itag;
    if (typeof itag === 'number')
        return YOUTUBE_WEBM_ITAGS.has(itag);
    const format = data?.format;
    if (typeof format === 'string')
        return format.toLowerCase().includes('webm');
    if (typeof format?.itag === 'number')
        return YOUTUBE_WEBM_ITAGS.has(format.itag);
    return true;
}
export async function getStreamProcessor() {
    if (createAudioResource && createSeekeableAudioResource)
        return;
    const processor = await import('../../processing/streamProcessor.js');
    createAudioResource = processor.createAudioResource;
    createSeekeableAudioResource =
        processor.createSeekeableAudioResource;
}
/**
 * Builds audio resources and cleans up their streams.
 * @internal
 */
export class PlayerResources {
    player;
    nodelink;
    dependencies;
    _currentResource = null;
    constructor(player, nodelink, dependencies) {
        this.player = player;
        this.nodelink = nodelink;
        this.dependencies = dependencies;
    }
    /**
     * Logs a memory snapshot for track-finish diagnostics when enabled.
     */
    _traceTrackFinishMemory(stage) {
        if (!trackFinishMemoryTraceEnabled)
            return;
        const memoryUsage = process.memoryUsage();
        const toMegabytes = (value) => (value / 1024 / 1024).toFixed(2);
        logger('debug', 'Player', `[MEM][TrackFinish][${this.player.guildId}] ${stage} rss=${toMegabytes(memoryUsage.rss)}MB heapUsed=${toMegabytes(memoryUsage.heapUsed)}MB heapTotal=${toMegabytes(memoryUsage.heapTotal)}MB external=${toMegabytes(memoryUsage.external)}MB arrayBuffers=${toMegabytes(memoryUsage.arrayBuffers)}MB`);
    }
    /**
     * Records which resource belongs to the current stream.
     */
    _adoptResource(resource) {
        this._currentResource = resource;
    }
    _replaceResource(resource) {
        if (this._currentResource && this._currentResource !== resource) {
            try {
                this._currentResource.destroy();
            }
            catch { }
        }
        this._currentResource = resource;
    }
    _abortYouTubeStreams() {
        try {
            const youtube = this.nodelink.sources.sources.get('youtube');
            youtube?.abortGuildStreams(this.player.guildId);
        }
        catch { }
    }
    _releaseResource() {
        if (this._currentResource) {
            try {
                this._currentResource.destroy();
            }
            catch { }
            this._currentResource = null;
        }
    }
    /**
     * Fetches an audio resource for playback.
     */
    async _fetchResource(info, urlData, startTime, returnPCM = false) {
        if (this.nodelink.options?.playback.mix?.enabled !== false) {
            await this.dependencies.mixer._ensureAudioMixer();
        }
        await getStreamProcessor();
        const audioResourceFactory = createAudioResource;
        if (!audioResourceFactory) {
            return { exception: { message: 'Stream processor not initialized' } };
        }
        const additionalData = {
            ...urlData.additionalData,
            ...(startTime !== undefined ? { startTime, position: startTime } : {}),
            guildId: this.player.guildId,
            positionCallback: (positionMs) => {
                if (!Number.isFinite(positionMs) || positionMs < 0)
                    return;
                this.player.position = positionMs;
            },
            // specific to sabr protocol for now
            playbackPaused: () => this.player.isPaused
        };
        const resolvedUrlData = {
            ...urlData,
            additionalData
        };
        const track = resolvedUrlData?.newTrack
            ? resolvedUrlData?.newTrack?.info
            : info;
        logger('debug', 'Player', `Fetching stream resource from source for guild ${this.player.guildId}`, {
            source: track.sourceName,
            url: resolvedUrlData.url
        });
        const fetched = await this.nodelink.sources.getTrackStream(track, resolvedUrlData.url, resolvedUrlData.protocol, additionalData);
        if (fetched.exception) {
            logger('error', 'Player', `Stream resource fetch failed for guild ${this.player.guildId}`, fetched.exception);
            return fetched;
        }
        logger('debug', 'Player', `Successfully fetched stream resource for guild ${this.player.guildId}`);
        const fetchedStream = fetched.stream;
        const totalBytesRaw = resolvedUrlData.additionalData?.contentLength ?? null;
        const totalBytesNum = Number(totalBytesRaw);
        this.player.profilerStreamStats = {
            downloadedBytes: 0,
            totalBytes: Number.isFinite(totalBytesNum) && totalBytesNum > 0
                ? totalBytesNum
                : null,
            lastChunkAt: null
        };
        let streamForResource = fetchedStream;
        if (fetchedStream.on) {
            const eventStream = fetchedStream;
            const profilerTap = new PassThrough();
            const profilerHandler = (chunk) => {
                const size = typeof chunk === 'string'
                    ? Buffer.byteLength(chunk)
                    : Number(chunk?.length || 0);
                if (size > 0)
                    this.player.profilerStreamStats.downloadedBytes += size;
                this.player.profilerStreamStats.lastChunkAt = Date.now();
            };
            profilerTap.on('data', profilerHandler);
            streamForResource = fetchedStream.pipe(profilerTap);
            profilerTap._sourceStream =
                fetchedStream;
            const seekControl = fetchedStream;
            const beginSeekHandoff = seekControl.beginSeekHandoff;
            if (beginSeekHandoff) {
                ;
                profilerTap.beginSeekHandoff = () => beginSeekHandoff();
            }
            const cancelSeekHandoff = seekControl.cancelSeekHandoff;
            if (cancelSeekHandoff) {
                ;
                profilerTap.cancelSeekHandoff = () => cancelSeekHandoff();
            }
            const eternalboxHandler = (data) => {
                this.player.emitEvent(GatewayEvents.ETERNALBOX_JUMP, {
                    track: this.dependencies.events.resolvedTrack || this.player.track,
                    eternalbox: data
                });
            };
            const icyHandler = (data) => {
                this.player.emitEvent(GatewayEvents.STREAM_METADATA, {
                    track: this.dependencies.events.resolvedTrack || this.player.track,
                    stream: data
                });
            };
            eventStream.on?.('eternalboxJump', eternalboxHandler);
            eventStream.on?.('icyMetadata', icyHandler);
            let listenersCleaned = false;
            const cleanupListeners = () => {
                if (listenersCleaned)
                    return;
                listenersCleaned = true;
                eventStream.off?.('eternalboxJump', eternalboxHandler);
                eventStream.off?.('icyMetadata', icyHandler);
                profilerTap.off('data', profilerHandler);
                streamForResource.off('close', cleanupListeners);
                streamForResource.off('error', cleanupListeners);
                streamForResource.off('end', cleanupListeners);
                const src = profilerTap
                    ._sourceStream;
                if (src && !src.destroyed) {
                    try {
                        src.destroy();
                    }
                    catch { }
                }
                delete profilerTap._sourceStream;
                if (!profilerTap.destroyed) {
                    try {
                        profilerTap.destroy();
                    }
                    catch { }
                }
            };
            streamForResource.on('close', cleanupListeners);
            streamForResource.on('error', cleanupListeners);
            streamForResource.on('end', cleanupListeners);
            streamForResource._cleanupListeners = cleanupListeners;
        }
        const resource = audioResourceFactory(this.player.guildId, streamForResource, fetched.type || resolvedUrlData.format, this.nodelink, this.player.filters, returnPCM ? 1 : this.player.volumePercent / 100, returnPCM ? null : this.player.audioMixer, returnPCM, returnPCM ? false : this.player.loudnessNormalizer, !returnPCM && this.dependencies.isCrossfadeEnabled());
        return { stream: resource };
    }
    /**
     * Destroys and dereferences current audio stream to avoid lingering references.
     */
    _cleanupCurrentAudioStream(context, preserveCrossfade = false) {
        this.dependencies.cleanupCrossfade(preserveCrossfade);
        logger('debug', 'Player', `[Cleanup] Triggering stream cleanup for guild ${this.player.guildId}. Context: ${context}`);
        const conn = this.player.connection;
        this.dependencies.voiceConnection.clearPendingKeyPackage();
        const audioStream = conn?.audioStream;
        if (this.player.duckingController) {
            this.player.duckingController.setStreamControl(null);
            this.player.duckingController.detach();
        }
        if (this._currentResource) {
            try {
                this._currentResource.destroy();
            }
            catch (err) {
                logger('debug', 'Player', `Resource destroy failed during ${context} for guild ${this.player.guildId}: ${err?.message ?? String(err)}`);
            }
            this._currentResource = null;
        }
        if (!audioStream) {
            return;
        }
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
            this.dependencies.voiceConnection.flush(conn);
        }
        catch (err) {
            logger('debug', 'Player', `Failed to destroy audio stream during ${context} for guild ${this.player.guildId}: ${err?.message ?? String(err)}`);
        }
        finally {
            if (conn)
                conn.audioStream = null;
        }
    }
}
