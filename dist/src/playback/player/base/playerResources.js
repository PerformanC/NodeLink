import { PassThrough } from 'node:stream';
import { GatewayEvents } from '../../../constants.js';
import { YOUTUBE_WEBM_ITAGS } from '../../../sources/youtube/common.js';
import { logger } from '../../../utils.js';
export let createAudioResource = null;
export let createSeekeableAudioResource = null;
export const trackFinishMemoryTraceEnabled = process.env.NODELINK_TRACK_FINISH_MEMORY_TRACE?.toLowerCase() === 'true';
export const SEEK_CROSSFADE_SAFETY_MS = 15000;
export const MIN_CROSSFADE_SELECTION_MS = 6000;
export const MAX_CROSSFADE_SELECTION_MS = 21000;
/**
 * True for YouTube/ytmusic streams served as WebM/opus. Those must skip
 * the generic seekable path: it keeps downloading the rest of the file
 * into RAM while voice plays in realtime (measured: a 180MB file cost
 * 2.8GB across 19 players). Unknown formats default to WebM, since
 * itag 251 dominates and itag is always present in practice.
 */
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
export function getCrossfadeSelectionWindowMs(durationMs) {
    return Math.min(MAX_CROSSFADE_SELECTION_MS, Math.max(MIN_CROSSFADE_SELECTION_MS, durationMs * 4.2));
}
export async function getStreamProcessor() {
    if (createAudioResource && createSeekeableAudioResource)
        return;
    const processor = await import('../../processing/streamProcessor.js');
    createAudioResource = processor.createAudioResource;
    createSeekeableAudioResource =
        processor.createSeekeableAudioResource;
}
export function isObjectRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export class PlayerResources {
    runtime;
    connectionController;
    transitionController;
    playback;
    mixController;
    clock;
    constructor(runtime) {
        this.runtime = runtime;
    }
    profilerStreamStats = {
        downloadedBytes: 0,
        totalBytes: null,
        lastChunkAt: null
    };
    _getAudioStream() {
        return (this.connectionController.connection
            ?.audioStream ?? null);
    }
    _traceTrackFinishMemory(stage) {
        if (!trackFinishMemoryTraceEnabled)
            return;
        const memory = process.memoryUsage();
        const toMegabytes = (value) => (value / 1024 / 1024).toFixed(2);
        logger('debug', 'Player', `[MEM][TrackFinish][${this.runtime.guildId}] ${stage} rss=${toMegabytes(memory.rss)}MB heapUsed=${toMegabytes(memory.heapUsed)}MB heapTotal=${toMegabytes(memory.heapTotal)}MB external=${toMegabytes(memory.external)}MB arrayBuffers=${toMegabytes(memory.arrayBuffers)}MB`);
    }
    _cleanupCurrentAudioStream(context, preserveCrossfade = false) {
        this.transitionController._destroyCrossfadeResources(preserveCrossfade);
        logger('debug', 'Player', `[Cleanup] Triggering stream cleanup for guild ${this.runtime.guildId}. Context: ${context}`);
        const conn = this.connectionController.connection;
        const audioStream = conn?.audioStream;
        if (this.playback.duckingController) {
            this.playback.duckingController.setStreamControl(null);
            this.playback.duckingController.detach();
        }
        if (this.playback._currentResource) {
            try {
                this.playback._currentResource.destroy();
            }
            catch (error) {
                logger('debug', 'Player', `Resource destroy failed during ${context} for guild ${this.runtime.guildId}: ${error?.message ?? String(error)}`);
            }
            this.playback._currentResource = null;
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
            audioStream.destroy();
            if (Array.isArray(audioStream.pipes)) {
                for (const pipe of audioStream.pipes) {
                    pipe.destroy();
                }
            }
        }
        catch (error) {
            logger('debug', 'Player', `Failed to destroy audio stream during ${context} for guild ${this.runtime.guildId}: ${error?.message ?? String(error)}`);
        }
        finally {
            if (conn)
                conn.audioStream = null;
        }
    }
    async _fetchResource(info, urlData, startTime, returnPCM = false) {
        if (this.runtime.nodelink.options?.playback.mix?.enabled !== false) {
            await this.mixController._ensureAudioMixer();
        }
        await getStreamProcessor();
        const audioResourceFactory = createAudioResource;
        if (!audioResourceFactory) {
            return { exception: { message: 'Stream processor not initialized' } };
        }
        const additionalData = {
            ...urlData.additionalData,
            ...(startTime !== undefined ? { startTime, position: startTime } : {}),
            guildId: this.runtime.guildId,
            positionCallback: (positionMs) => {
                if (!Number.isFinite(positionMs) || positionMs < 0)
                    return;
                this.clock.position = positionMs;
            },
            // specific to sabr protocol for now
            playbackPaused: () => this.playback.isPaused
        };
        const resolvedUrlData = {
            ...urlData,
            additionalData
        };
        const track = resolvedUrlData?.newTrack
            ? resolvedUrlData?.newTrack?.info
            : info;
        logger('debug', 'Player', `Fetching stream resource from source for guild ${this.runtime.guildId}`, {
            source: track.sourceName,
            url: resolvedUrlData.url
        });
        const fetched = await this.runtime.nodelink.sources.getTrackStream(track, resolvedUrlData.url, resolvedUrlData.protocol, additionalData);
        if (fetched.exception) {
            logger('error', 'Player', `Stream resource fetch failed for guild ${this.runtime.guildId}`, fetched.exception);
            return fetched;
        }
        logger('debug', 'Player', `Successfully fetched stream resource for guild ${this.runtime.guildId}`);
        const fetchedStream = fetched.stream;
        const totalBytesRaw = resolvedUrlData.additionalData?.contentLength ?? null;
        const totalBytesNum = Number(totalBytesRaw);
        this.profilerStreamStats = {
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
                    this.profilerStreamStats.downloadedBytes += size;
                this.profilerStreamStats.lastChunkAt = Date.now();
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
                this.runtime.emitEvent(GatewayEvents.ETERNALBOX_JUMP, {
                    track: this.playback.holoTrack || this.playback.track,
                    eternalbox: data
                });
            };
            const icyHandler = (data) => {
                this.runtime.emitEvent(GatewayEvents.STREAM_METADATA, {
                    track: this.playback.holoTrack || this.playback.track,
                    stream: data
                });
            };
            eventStream.on('eternalboxJump', eternalboxHandler);
            eventStream.on('icyMetadata', icyHandler);
            let listenersCleaned = false;
            const cleanupListeners = () => {
                if (listenersCleaned)
                    return;
                listenersCleaned = true;
                eventStream.off('eternalboxJump', eternalboxHandler);
                eventStream.off('icyMetadata', icyHandler);
                profilerTap.off('data', profilerHandler);
                streamForResource.off('close', cleanupListeners);
                streamForResource.off('error', cleanupListeners);
                streamForResource.off('end', cleanupListeners);
                const sourceStream = profilerTap._sourceStream;
                if (sourceStream && !sourceStream.destroyed) {
                    try {
                        sourceStream.destroy();
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
        const resource = audioResourceFactory(this.runtime.guildId, streamForResource, fetched.type || resolvedUrlData.format, this.runtime.nodelink, this.playback.filters, returnPCM ? 1 : this.playback.volumePercent / 100, returnPCM ? null : this.mixController.audioMixer, returnPCM, returnPCM ? false : this.playback.loudnessNormalizer, !returnPCM && this.transitionController._getCrossfadeConfig() !== null);
        return { stream: resource };
    }
}
