import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import { logger } from '../../utils.js';
import { Encoder as OpusEncoder } from '../opus/Opus.js';
import { createInitSegment, createMediaSegment } from './FMP4Muxer.js';
/**
 * Lazy import for stream processor to prevent startup circular dependencies.
 */
let streamProcessorPromise = null;
function getStreamProcessorModule() {
    if (!streamProcessorPromise) {
        streamProcessorPromise = import('../processing/streamProcessor.js');
    }
    return streamProcessorPromise;
}
/**
 * Silence Opus packet (3 bytes) used when no audio frames are present.
 */
const OPUS_SILENCE_PACKET = Buffer.from([0xf8, 0xff, 0xfe]);
/**
 * Maximum number of segments retained in memory per session.
 */
const MAX_CACHED_SEGMENTS = 50;
/**
 * Inactivity TTL before an idle HLS session is destroyed (10 minutes).
 */
const SESSION_TTL_MS = 10 * 60 * 1000;
/**
 * Computes a deterministic 16-character session ID based on request parameters.
 *
 * @param encodedTrack - Base64 track string.
 * @param volume - Linear volume percent.
 * @param filters - Active audio filters.
 * @param segmentDuration - Segment length in seconds.
 * @returns Short hex digest.
 */
export function computeSessionId(encodedTrack, volume, filters, segmentDuration) {
    const hash = crypto.createHash('sha256');
    hash.update(encodedTrack);
    hash.update(`:${volume}`);
    hash.update(`:${segmentDuration}`);
    hash.update(`:${JSON.stringify(filters)}`);
    return hash.digest('hex').slice(0, 16);
}
/**
 * Generates an RFC 8216bis compliant M3U8 manifest.
 *
 * @param options - Manifest generation options.
 * @returns Formatted M3U8 string.
 */
export function buildPlaylist(options) {
    const { trackLengthMs, segmentDurationSec, isStream, sessionId, encodedTrack, baseUrl = '', version } = options;
    const targetDuration = Math.ceil(segmentDurationSec);
    const sessionQuery = sessionId
        ? `sessionId=${encodeURIComponent(sessionId)}`
        : `track=${encodeURIComponent(encodedTrack)}`;
    const versionQuery = version ? `&_v=${version}` : '';
    const initUri = `${baseUrl}init.mp4?${sessionQuery}${versionQuery}`;
    if (isStream || trackLengthMs <= 0) {
        const lines = [
            '#EXTM3U',
            '#EXT-X-VERSION:7',
            `#EXT-X-TARGETDURATION:${targetDuration}`,
            '#EXT-X-MEDIA-SEQUENCE:0',
            `#EXT-X-MAP:URI="${initUri}"`
        ];
        return `${lines.join('\n')}\n`;
    }
    const totalDurationSec = trackLengthMs / 1000;
    const totalSegments = Math.max(1, Math.ceil(totalDurationSec / segmentDurationSec));
    const lines = [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        `#EXT-X-TARGETDURATION:${targetDuration}`,
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-PLAYLIST-TYPE:VOD',
        `#EXT-X-MAP:URI="${initUri}"`
    ];
    for (let i = 0; i < totalSegments; i++) {
        const isLast = i === totalSegments - 1;
        const segDuration = isLast
            ? totalDurationSec - i * segmentDurationSec
            : segmentDurationSec;
        const actualDuration = Math.max(0.02, Number(segDuration.toFixed(3)));
        lines.push(`#EXTINF:${actualDuration.toFixed(3)},`);
        lines.push(`${baseUrl}segment.m4s?${sessionQuery}&segment=${i}${versionQuery}`);
    }
    lines.push('#EXT-X-ENDLIST');
    return `${lines.join('\n')}\n`;
}
/**
 * Core HLS streaming and session management service.
 */
export class HLSServer {
    static instance = null;
    sessions = new Map();
    cleanupInterval = null;
    constructor() {
        this.cleanupInterval = setInterval(() => this.sweepExpiredSessions(), 60_000);
        this.cleanupInterval.unref?.();
    }
    /**
     * Retrieves the singleton HLSServer instance.
     */
    static getInstance() {
        if (!HLSServer.instance) {
            HLSServer.instance = new HLSServer();
        }
        return HLSServer.instance;
    }
    /**
     * Retrieves an existing session by ID or creates a new one.
     *
     * @param options - Session options.
     * @returns Active HLS session.
     */
    getOrCreateSession(options) {
        const existing = this.sessions.get(options.sessionId);
        if (existing && !existing.destroyed) {
            existing.lastAccessedAt = Date.now();
            return existing;
        }
        const initSegment = createInitSegment({
            sampleRate: 48000,
            channels: 2,
            frameSize: 960,
            preSkip: 312
        });
        const newSession = {
            id: options.sessionId,
            encodedTrack: options.encodedTrack,
            track: options.track,
            segmentDurationSec: options.segmentDurationSec,
            volume: options.volume,
            filters: options.filters,
            initSegment,
            segments: new Map(),
            pendingSegments: new Map(),
            pendingResolvers: new Map(),
            pendingRejecters: new Map(),
            createdAt: Date.now(),
            lastAccessedAt: Date.now(),
            lastRequestedSegment: 0,
            feeder: null,
            feederStarting: null,
            livePackets: [],
            liveCurrentSeq: 0,
            destroyed: false,
            destroy: () => {
                newSession.destroyed = true;
                newSession.feeder?.destroy();
                newSession.feeder = null;
                newSession.segments.clear();
                newSession.pendingSegments.clear();
                newSession.pendingResolvers.clear();
                newSession.pendingRejecters.clear();
                newSession.livePackets = [];
            }
        };
        this.sessions.set(options.sessionId, newSession);
        return newSession;
    }
    /**
     * Retrieves a session by its session ID.
     *
     * @param sessionId - Session identifier.
     * @returns Session if found and active.
     */
    getSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session && !session.destroyed) {
            session.lastAccessedAt = Date.now();
            return session;
        }
        return undefined;
    }
    /**
     * Generates or fetches from cache an fMP4 media segment for the session.
     *
     * @param session - Target HLS session.
     * @param segmentIndex - 0-indexed segment sequence number.
     * @param runtime - Server runtime providing sources and stream processor.
     * @returns Promise resolving to the segment Buffer.
     */
    async getMediaSegment(session, segmentIndex, runtime) {
        session.lastAccessedAt = Date.now();
        session.lastRequestedSegment = Math.max(session.lastRequestedSegment, segmentIndex);
        const cached = session.segments.get(segmentIndex);
        if (cached) {
            if (session.feeder?.pcmStream?.isPaused?.()) {
                session.feeder.pcmStream.resume();
            }
            return cached;
        }
        const existingPending = session.pendingSegments.get(segmentIndex);
        if (existingPending) {
            return existingPending;
        }
        let resolvePromise;
        let rejectPromise;
        const promise = new Promise((resolve, reject) => {
            resolvePromise = resolve;
            rejectPromise = reject;
        });
        const timeoutId = setTimeout(() => {
            if (session.pendingSegments.has(segmentIndex)) {
                session.pendingSegments.delete(segmentIndex);
                session.pendingResolvers.delete(segmentIndex);
                session.pendingRejecters.delete(segmentIndex);
                rejectPromise(new Error(`HLS segment ${segmentIndex} generation timed out`));
            }
        }, 20_000);
        timeoutId.unref?.();
        session.pendingSegments.set(segmentIndex, promise);
        session.pendingResolvers.set(segmentIndex, (buf) => {
            clearTimeout(timeoutId);
            resolvePromise(buf);
        });
        session.pendingRejecters.set(segmentIndex, (err) => {
            clearTimeout(timeoutId);
            rejectPromise(err);
        });
        if (session.feederStarting) {
            try {
                await session.feederStarting;
            }
            catch { }
        }
        const nowCached = session.segments.get(segmentIndex);
        if (nowCached) {
            session.pendingSegments.delete(segmentIndex);
            session.pendingResolvers.delete(segmentIndex);
            session.pendingRejecters.delete(segmentIndex);
            clearTimeout(timeoutId);
            return nowCached;
        }
        const feeder = session.feeder;
        const needsNewFeeder = !feeder ||
            feeder.ended ||
            segmentIndex < feeder.startSegment ||
            segmentIndex > feeder.nextSegment + 5;
        if (needsNewFeeder) {
            session.feederStarting = this.startFeeder(session, segmentIndex, runtime).finally(() => {
                session.feederStarting = null;
            });
            await session.feederStarting;
        }
        else if (feeder.pcmStream?.isPaused?.()) {
            feeder.pcmStream.resume();
        }
        return promise;
    }
    /**
     * Bounds memory usage by retaining only the closest segments.
     */
    pruneSessionCache(session, currentIndex) {
        if (session.segments.size <= MAX_CACHED_SEGMENTS)
            return;
        for (const key of session.segments.keys()) {
            if (key < currentIndex - 15 || key > currentIndex + MAX_CACHED_SEGMENTS) {
                session.segments.delete(key);
            }
            if (session.segments.size <= MAX_CACHED_SEGMENTS)
                break;
        }
    }
    /**
     * Generates a silence media segment to fulfill a pending segment request past track end.
     */
    resolvePendingWithSilence(session, segmentIndex, targetFrames) {
        const silence = createMediaSegment(segmentIndex, [OPUS_SILENCE_PACKET.length], OPUS_SILENCE_PACKET, BigInt(segmentIndex) * BigInt(targetFrames * 960));
        session.segments.set(segmentIndex, silence);
        const resolver = session.pendingResolvers.get(segmentIndex);
        if (resolver) {
            session.pendingResolvers.delete(segmentIndex);
            session.pendingSegments.delete(segmentIndex);
            session.pendingRejecters.delete(segmentIndex);
            resolver(silence);
        }
        return silence;
    }
    /**
     * Creates the decoded PCM audio stream for the requested track start position.
     */
    async createPCMStream(session, startSegment, startTimeMs, urlResult, runtime) {
        const { createAudioResource, createSeekeableAudioResource } = await getStreamProcessorModule();
        const serverRuntime = runtime;
        const isHls = urlResult.protocol === 'hls';
        const isSabr = urlResult.protocol === 'sabr';
        const isLocal = session.track.info.sourceName === 'local';
        if (urlResult.url && !isHls && !isLocal && !isSabr) {
            const resource = (await createSeekeableAudioResource(`hls-${session.id}-${startSegment}`, urlResult.url, startTimeMs, undefined, serverRuntime, session.filters, {
                streamInfo: urlResult,
                loudnessNormalizer: serverRuntime.options?.playback?.audio?.loudnessNormalizer
            }, session.volume / 100, null, true));
            if ('exception' in resource) {
                throw new Error(resource.exception.message);
            }
            return { pcmStream: resource.stream, fetchedStream: null };
        }
        if (!serverRuntime.sources || !urlResult.url) {
            throw new Error('Sources manager unavailable for HLS segment extraction');
        }
        const additionalData = {
            ...(urlResult.additionalData ?? {}),
            startTime: startTimeMs
        };
        const fetched = await serverRuntime.sources.getTrackStream(urlResult.newTrack?.info ?? session.track.info, urlResult.url, urlResult.protocol, additionalData);
        if (fetched.exception || !fetched.stream) {
            throw new Error(fetched.exception?.message || 'Failed to fetch source stream');
        }
        const fetchedStream = fetched.stream;
        const resource = createAudioResource(`hls-${session.id}-${startSegment}`, fetched.stream, fetched.type ??
            (typeof urlResult.format === 'string' ? urlResult.format : 'unknown'), serverRuntime, session.filters, session.volume / 100, null, true, serverRuntime.options?.playback?.audio?.loudnessNormalizer);
        return { pcmStream: resource.stream, fetchedStream };
    }
    /**
     * Packages accumulated Opus frames into an fMP4 media segment and dispatches it to pending requests.
     */
    commitSegment(session, feeder) {
        if (feeder.currentPackets.length === 0)
            return;
        const segIndex = feeder.nextSegment;
        const sampleSizes = feeder.currentPackets.map((p) => p.length);
        const payload = Buffer.concat(feeder.currentPackets);
        const segData = createMediaSegment(segIndex, sampleSizes, payload, feeder.baseMediaDecodeTime);
        session.segments.set(segIndex, segData);
        this.pruneSessionCache(session, segIndex);
        const resolver = session.pendingResolvers.get(segIndex);
        if (resolver) {
            session.pendingResolvers.delete(segIndex);
            session.pendingSegments.delete(segIndex);
            session.pendingRejecters.delete(segIndex);
            resolver(segData);
        }
        feeder.baseMediaDecodeTime += BigInt(feeder.currentPackets.length * 960);
        feeder.nextSegment++;
        feeder.currentPackets = [];
    }
    /**
     * Initializes a continuous audio decoding pipeline feeding fMP4 media segments.
     */
    async startFeeder(session, startSegment, runtime) {
        if (session.destroyed)
            return;
        session.feeder?.destroy();
        session.feeder = null;
        const isVod = !session.track.info.isStream && session.track.info.length > 0;
        const trackLengthMs = session.track.info.length;
        const startTimeMs = startSegment * session.segmentDurationSec * 1000;
        const targetFrames = Math.max(1, Math.round((session.segmentDurationSec * 1000) / 20));
        if (isVod && startTimeMs >= trackLengthMs) {
            this.resolvePendingWithSilence(session, startSegment, targetFrames);
            return;
        }
        const urlResult = await this.resolveTrackUrl(runtime, session.track);
        if (session.destroyed)
            return;
        if (urlResult.exception || !urlResult.url) {
            throw new Error(urlResult.exception?.message || 'Failed to resolve track URL for HLS');
        }
        const { pcmStream, fetchedStream } = await this.createPCMStream(session, startSegment, startTimeMs, urlResult, runtime);
        const encoder = new OpusEncoder({
            rate: 48000,
            channels: 2,
            frameSize: 960,
            application: 'audio'
        });
        const initialDecodeTime = BigInt(startSegment) * BigInt(targetFrames * 960);
        const feeder = {
            startSegment,
            nextSegment: startSegment,
            baseMediaDecodeTime: initialDecodeTime,
            targetFrames,
            currentPackets: [],
            pcmStream,
            fetchedStream,
            encoder,
            ended: false,
            destroy: () => {
                feeder.ended = true;
                feeder.pcmStream?.destroy();
                feeder.fetchedStream?.destroy();
                feeder.encoder.destroy();
            }
        };
        session.feeder = feeder;
        const onData = (packet) => {
            if (feeder.ended || session.destroyed)
                return;
            feeder.currentPackets.push(packet);
            if (feeder.currentPackets.length >= feeder.targetFrames) {
                this.commitSegment(session, feeder);
                if (feeder.nextSegment - session.lastRequestedSegment > 15) {
                    feeder.pcmStream?.pause();
                }
            }
        };
        const onEnd = () => {
            if (feeder.ended || session.destroyed)
                return;
            this.commitSegment(session, feeder);
            feeder.ended = true;
            for (const pendingIdx of session.pendingResolvers.keys()) {
                if (pendingIdx >= feeder.nextSegment) {
                    this.resolvePendingWithSilence(session, pendingIdx, feeder.targetFrames);
                }
            }
        };
        const onError = (err) => {
            if (feeder.ended || session.destroyed)
                return;
            logger('warn', 'HLSServer', `Feeder error for session ${session.id}: ${err.message}`);
            feeder.destroy();
            for (const rejecter of session.pendingRejecters.values()) {
                rejecter(err);
            }
            session.pendingRejecters.clear();
            session.pendingResolvers.clear();
            session.pendingSegments.clear();
        };
        encoder.on('data', onData);
        encoder.on('finish', onEnd);
        encoder.on('end', onEnd);
        encoder.on('error', onError);
        pcmStream.on('error', onError);
        pcmStream.pipe(encoder);
    }
    /**
     * Resolves playable track URL from worker manager or local sources.
     */
    async resolveTrackUrl(runtime, track) {
        const serverRuntime = runtime;
        if (serverRuntime.workerManager) {
            const worker = serverRuntime.workerManager.getBestWorker();
            return await serverRuntime.workerManager.execute(worker, 'getTrackUrl', {
                decodedTrackInfo: track.info
            });
        }
        if (!serverRuntime.sources) {
            throw new Error('Sources manager is not available for HLS resolution.');
        }
        return await serverRuntime.sources.getTrackUrl(track.info);
    }
    /**
     * Cleans up idle sessions past their TTL.
     */
    sweepExpiredSessions() {
        const now = Date.now();
        for (const [id, session] of this.sessions.entries()) {
            if (now - session.lastAccessedAt > SESSION_TTL_MS) {
                session.destroy();
                this.sessions.delete(id);
            }
        }
    }
    /**
     * Releases all resources on server shutdown.
     */
    destroy() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        for (const session of this.sessions.values()) {
            session.destroy();
        }
        this.sessions.clear();
    }
}
