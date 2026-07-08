/**
 * SABR Stream Implementation
 *
 * Server-side Adaptive Bitrate (SABR) streaming client for YouTube.
 * Handles UMP (Unified Media Protocol) parsing, media segment assembly,
 * and adaptive quality selection.
 *
 * @packageDocumentation
 * @module SabrStream
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { logger } from '../../../utils.js';
import { poTokenManager } from './potoken.js';
import { base64ToU8, concatenateChunks, FormatInitializationMetadata, MediaHeader, NextRequestPolicy, PlaybackStartPolicy, ProtoReader, ReloadPlaybackContext, RequestCancellationPolicy, RequestIdentifier, SabrContextSendingPolicy, SabrContextUpdate, SabrError, SabrRedirect, StreamProtectionStatus, UMPPartId, VideoPlaybackAbrRequest } from './protor.js';
/**
 * Default User-Agent header for SABR HTTP requests.
 * @internal
 */
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';
/**
 * Maximum bytes to buffer before pausing read operations.
 * @internal
 */
const MAX_BUFFER_BYTES = 512 * 1024;
/**
 * Minimum interval between consecutive ABR requests in milliseconds.
 * @internal
 */
const MIN_REQUEST_INTERVAL_MS = 500;
/**
 * Computes the SHA-256 hash of a byte array as a hex string.
 * @param u8 - Input byte array.
 * @returns Hex-encoded SHA-256 hash.
 * @internal
 */
function sha256Hex(u8) {
    const h = createHash('sha256');
    h.update(u8);
    return h.digest('hex');
}
/**
 * Encodes a byte array as base64, optionally truncating to a maximum length.
 * @param u8 - Input byte array.
 * @param maxBytes - Maximum bytes to encode.
 * @returns Base64-encoded string.
 * @internal
 */
function b64Trunc(u8, maxBytes) {
    const slice = u8.length > maxBytes ? u8.subarray(0, maxBytes) : u8;
    return Buffer.from(slice).toString('base64');
}
/**
 * Returns the human-readable name for a UMP part type identifier.
 * @param type - UMP part type constant from {@link UMPPartId}.
 * @returns Human-readable part name.
 * @internal
 */
function umpPartName(type) {
    switch (type) {
        case UMPPartId.FORMAT_INITIALIZATION_METADATA:
            return 'FORMAT_INITIALIZATION_METADATA';
        case UMPPartId.NEXT_REQUEST_POLICY:
            return 'NEXT_REQUEST_POLICY';
        case UMPPartId.SABR_ERROR:
            return 'SABR_ERROR';
        case UMPPartId.SABR_REDIRECT:
            return 'SABR_REDIRECT';
        case UMPPartId.PLAYBACK_START_POLICY:
            return 'PLAYBACK_START_POLICY';
        case UMPPartId.REQUEST_IDENTIFIER:
            return 'REQUEST_IDENTIFIER';
        case UMPPartId.REQUEST_CANCELLATION_POLICY:
            return 'REQUEST_CANCELLATION_POLICY';
        case UMPPartId.SABR_CONTEXT_UPDATE:
            return 'SABR_CONTEXT_UPDATE';
        case UMPPartId.SABR_CONTEXT_SENDING_POLICY:
            return 'SABR_CONTEXT_SENDING_POLICY';
        case UMPPartId.STREAM_PROTECTION_STATUS:
            return 'STREAM_PROTECTION_STATUS';
        case UMPPartId.RELOAD_PLAYER_RESPONSE:
            return 'RELOAD_PLAYER_RESPONSE';
        case UMPPartId.MEDIA_HEADER:
            return 'MEDIA_HEADER';
        case UMPPartId.MEDIA:
            return 'MEDIA';
        case UMPPartId.MEDIA_END:
            return 'MEDIA_END';
        case UMPPartId.SNACKBAR_MESSAGE:
            return 'SNACKBAR_MESSAGE';
        default:
            return `UNKNOWN_${type}`;
    }
}
/**
 * Returns a promise that resolves after a specified delay.
 * Supports early resolution via an AbortSignal.
 * @param ms - Delay in milliseconds.
 * @param signal - Optional AbortSignal for early resolution.
 * @internal
 */
function wait(ms, signal) {
    if (ms <= 0)
        return Promise.resolve();
    return new Promise((resolve) => {
        if (signal?.aborted)
            return resolve();
        let t;
        const onAbort = () => {
            if (t)
                clearTimeout(t);
            signal?.removeEventListener('abort', onAbort);
            resolve();
        };
        t = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        t.unref?.();
        if (signal)
            signal.addEventListener('abort', onAbort);
    });
}
/**
 * Creates a composite format key from itag and xtags.
 * @param itag - Format itag number.
 * @param xtags - Optional xtags string.
 * @returns Composite key string.
 * @internal
 */
function createKey(itag, xtags) {
    return `${itag ?? ''}:${xtags ?? ''}`;
}
/**
 * Utility functions for extracting format keys from decoded messages.
 * @internal
 */
const FormatKeyUtils = {
    /**
     * Extracts a format key from a FormatInitializationMetadata message.
     * @param meta - The decoded metadata message.
     * @returns Composite format key.
     */
    fromFormatInitializationMetadata(meta) {
        const itag = meta.formatId?.itag ?? meta.itag;
        const xtags = meta.formatId?.xtags ?? meta.xtags;
        return createKey(itag, xtags);
    },
    /**
     * Extracts a format key from a MediaHeader message.
     * @param mediaHeader - The decoded media header.
     * @returns Composite format key.
     */
    fromMediaHeader(mediaHeader) {
        const itag = mediaHeader.formatId?.itag ?? mediaHeader.itag;
        const xtags = mediaHeader.formatId?.xtags ?? mediaHeader.xtags;
        return createKey(itag, xtags);
    }
};
/**
 * Multi-chunk byte buffer for zero-copy UMP parsing.
 *
 * Wraps multiple `Uint8Array` chunks and provides position-based access
 * without requiring a contiguous memory allocation. This avoids copying
 * when data arrives in multiple network chunks.
 *
 * @public
 */
export class CompositeBuffer {
    /** Ordered array of byte chunks. */
    chunks = [];
    /** Cumulative byte offset of the current chunk under focus. */
    currentChunkOffset = 0;
    /** Index of the current chunk under focus. */
    currentChunkIndex = 0;
    /** Total byte length across all chunks. */
    totalLength = 0;
    /**
     * Constructs a CompositeBuffer from an optional array of chunks.
     * @param chunks - Initial byte chunks to append.
     */
    constructor(chunks = []) {
        for (const chunk of chunks) {
            this.append(chunk);
        }
    }
    /**
     * Appends a byte chunk or merges another CompositeBuffer.
     * @param chunk - Data to append.
     */
    append(chunk) {
        if (chunk instanceof Uint8Array) {
            this.chunks.push(chunk);
            this.totalLength += chunk.length;
        }
        else if (chunk instanceof CompositeBuffer) {
            for (const c of chunk.chunks) {
                this.append(c);
            }
        }
    }
    /**
     * Splits the buffer at the given position.
     * @param position - Byte position to split at.
     * @returns Object with extracted data before position and remaining data after.
     */
    split(position) {
        const extractedBuffer = new CompositeBuffer();
        const remainingBuffer = new CompositeBuffer();
        let remainingPos = position;
        for (const chunk of this.chunks) {
            if (remainingPos >= chunk.length) {
                extractedBuffer.append(chunk);
                remainingPos -= chunk.length;
            }
            else if (remainingPos > 0) {
                extractedBuffer.append(chunk.subarray(0, remainingPos));
                remainingBuffer.append(chunk.subarray(remainingPos));
                remainingPos = 0;
            }
            else {
                remainingBuffer.append(chunk);
            }
        }
        return { extractedBuffer, remainingBuffer };
    }
    /**
     * Checks if enough bytes are available starting from a position.
     * @param position - Starting byte position.
     * @param length - Number of bytes needed.
     * @returns True if the bytes are available.
     */
    canReadBytes(position, length) {
        return position + length <= this.totalLength;
    }
    /**
     * Reads a single byte at the given position.
     * @param position - Byte position to read from.
     * @returns The byte value at that position.
     */
    getUint8(position) {
        this.focus(position);
        const chunk = this.chunks[this.currentChunkIndex];
        if (!chunk)
            return 0;
        return chunk[position - this.currentChunkOffset] ?? 0;
    }
    /**
     * Returns the total byte length of the buffer.
     * @returns Total byte count.
     */
    getLength() {
        return this.totalLength;
    }
    /**
     * Advances the internal focus to the chunk containing a position.
     * @param position - Target byte position.
     */
    focus(position) {
        if (position < this.currentChunkOffset)
            this.resetFocus();
        while (this.currentChunkIndex < this.chunks.length &&
            this.currentChunkOffset +
                (this.chunks[this.currentChunkIndex]?.length ?? 0) <=
                position) {
            const chunk = this.chunks[this.currentChunkIndex];
            if (chunk) {
                this.currentChunkOffset += chunk.length;
            }
            this.currentChunkIndex += 1;
        }
    }
    /**
     * Resets focus to the first chunk.
     */
    resetFocus() {
        this.currentChunkIndex = 0;
        this.currentChunkOffset = 0;
    }
}
/**
 * UMP (Unified Media Protocol) binary stream parser.
 *
 * Reads UMP-encoded binary data from a CompositeBuffer and yields
 * individual parts with their type identifiers and payloads.
 *
 * @internal
 */
class UmpReader {
    /**
     * The composite buffer being read.
     * This reference is updated externally as new data arrives.
     */
    compositeBuffer;
    /**
     * Constructs a UMP reader for the given buffer.
     * @param compositeBuffer - Buffer to read from.
     */
    constructor(compositeBuffer) {
        this.compositeBuffer = compositeBuffer;
    }
    /**
     * Reads parts from the buffer and invokes the handler for each complete part.
     * @param handlePart - Callback invoked for each complete part.
     * @returns An incomplete part result if data is insufficient, otherwise undefined.
     */
    read(handlePart) {
        while (true) {
            const offset = 0;
            const [partType, nextOffset] = this.readVarInt(offset);
            if (partType < 0)
                break;
            const [partSize, finalOffset] = this.readVarInt(nextOffset);
            if (partSize < 0)
                break;
            if (!this.compositeBuffer.canReadBytes(finalOffset, partSize)) {
                const split = this.compositeBuffer.split(finalOffset);
                return {
                    type: partType,
                    size: partSize,
                    headerSize: finalOffset,
                    data: split.remainingBuffer,
                    incomplete: true
                };
            }
            const splitResult = this.compositeBuffer
                .split(finalOffset)
                .remainingBuffer.split(partSize);
            handlePart({
                type: partType,
                size: partSize,
                data: splitResult.extractedBuffer
            });
            this.compositeBuffer = splitResult.remainingBuffer;
        }
        return undefined;
    }
    /**
     * Reads a varint-encoded integer from the buffer.
     * @param offset - Starting byte offset.
     * @returns Tuple of [value, nextOffset], or [-1, offset] if insufficient data.
     */
    readVarInt(offset) {
        let byteLength;
        if (this.compositeBuffer.canReadBytes(offset, 1)) {
            const firstByte = this.compositeBuffer.getUint8(offset);
            byteLength =
                firstByte < 128
                    ? 1
                    : firstByte < 192
                        ? 2
                        : firstByte < 224
                            ? 3
                            : firstByte < 240
                                ? 4
                                : 5;
        }
        else {
            byteLength = 0;
        }
        if (byteLength < 1 ||
            !this.compositeBuffer.canReadBytes(offset, byteLength))
            return [-1, offset];
        let value;
        switch (byteLength) {
            case 1: {
                value = this.compositeBuffer.getUint8(offset++);
                break;
            }
            case 2: {
                const b1 = this.compositeBuffer.getUint8(offset++);
                const b2 = this.compositeBuffer.getUint8(offset++);
                value = (b1 & 0x3f) + 64 * b2;
                break;
            }
            case 3: {
                const b1 = this.compositeBuffer.getUint8(offset++);
                const b2 = this.compositeBuffer.getUint8(offset++);
                const b3 = this.compositeBuffer.getUint8(offset++);
                value = (b1 & 0x1f) + 32 * (b2 + 256 * b3);
                break;
            }
            case 4: {
                const b1 = this.compositeBuffer.getUint8(offset++);
                const b2 = this.compositeBuffer.getUint8(offset++);
                const b3 = this.compositeBuffer.getUint8(offset++);
                const b4 = this.compositeBuffer.getUint8(offset++);
                value = (b1 & 0x0f) + 16 * (b2 + 256 * (b3 + 256 * b4));
                break;
            }
            default: {
                offset++;
                const b1 = this.compositeBuffer.getUint8(offset++);
                const b2 = this.compositeBuffer.getUint8(offset++);
                const b3 = this.compositeBuffer.getUint8(offset++);
                const b4 = this.compositeBuffer.getUint8(offset++);
                value = b1 + 256 * (b2 + 256 * (b3 + 256 * b4));
                break;
            }
        }
        return [value, offset];
    }
}
/**
 * Server-side Adaptive Bitrate (SABR) streaming client for YouTube.
 *
 * Extends `PassThrough` to provide a readable stream of audio data
 * while internally managing UMP parsing, media segment assembly,
 * and adaptive quality selection.
 *
 * @example
 * ```typescript
 * const sabrStream = new SabrStream({
 *   videoId: 'dQw4w9WgXcQ',
 *   serverAbrStreamingUrl: playerResponse.streamingData.serverAbrStreamingUrl,
 *   videoPlaybackUstreamerConfig: playerResponse.streamingData.videoPlaybackUstreamerConfig,
 *   clientInfo: { clientName: 1, clientVersion: '2.20260114.01.00' },
 *   formats: [{ itag: 251, mimeType: 'audio/webm' }],
 *   poToken: '...',
 * });
 *
 * sabrStream.on('data', (chunk) => { /* audio chunk *\/ });
 * sabrStream.on('finishBuffering', () => { /* stream complete *\/ });
 * sabrStream.start(251); // Start with audio itag
 * ```
 *
 * @public
 */
export class SabrStream extends PassThrough {
    /** Configuration passed to the constructor. */
    config;
    /** YouTube video identifier. */
    videoId;
    /** Map of UMP part type IDs to handler functions. */
    umpPartHandlers;
    /** Format keys to their initialization metadata. */
    initializedFormatsMap;
    /** In-flight segments keyed by header ID. */
    partialSegmentQueue;
    /** SABR contexts keyed by type identifier. */
    sabrContexts;
    /** Context types that should be sent by default. */
    activeSabrContextTypes;
    /** Current request sequence number. */
    requestNumber;
    /** Whether media headers have been processed. */
    mediaHeadersProcessed;
    /** Flag indicating the stream has been aborted. */
    _aborted;
    /** Last sequence number per itag. */
    formatSequenceCounters;
    /** Downloaded segments per itag, keyed by segment number. */
    downloadedSegmentsByItag;
    /** End segment number per itag. */
    endSegmentNumbers;
    /** Whether the stream has finished. */
    streamFinished;
    /** Decoded PO token bytes. */
    poToken;
    /** Visitor data token. */
    visitorData;
    /** Server-side ABR streaming URL with parameters. */
    serverAbrStreamingUrl;
    /** Video playback ustreamer configuration. */
    videoPlaybackUstreamerConfig;
    /** Client info for ABR requests. */
    clientInfo;
    /** Available format entries. */
    formatIds;
    /** Start time offset in milliseconds. */
    startTime;
    /** Position callback for reporting playback progress. */
    positionCallback;
    /** User-Agent header for HTTP requests. */
    userAgent;
    /** Whether a recovery operation is pending. */
    recoveryPending;
    /** Flag to prevent duplicate PO token generation. */
    poTokenGenerated;
    /** Flag to prevent repeated stall emissions. */
    stallEmitted;
    /** Total downloaded duration in milliseconds. */
    totalDownloadedMs;
    /** Virtual player time for ABR state tracking. */
    virtualPlayerTimeMs;
    /** Timestamp of the last virtual player advance. */
    lastVirtualAdvanceAt;
    /** Pending media headers for buffered ranges. */
    pendingRangesHeaders;
    /** Cached buffered ranges. */
    cachedBufferedRanges;
    /** Last reported buffered range keys. */
    lastReportedRanges;
    /** Whether traffic logging is enabled. */
    enableTrafficLog;
    /** Path to the traffic log file. */
    trafficLogPath;
    /** Whether traffic dump is enabled. */
    enableTrafficDump;
    /** Maximum bytes to dump per request/response. */
    trafficDumpMaxBytes;
    /** Current bandwidth estimate in bits per second. */
    bandwidthEstimate;
    /** Timestamp of the last bandwidth log. */
    lastBandwidthLogAt;
    /** Consecutive iterations without receiving media data. */
    noMediaStreak;
    /** Abort controller for cancelling fetch operations. */
    abortController;
    /** Timestamp of the last ABR request. */
    lastRequestAt;
    /** Last received next request policy. */
    nextRequestPolicy;
    /** Last stream protection status. */
    lastStreamProtectionStatus;
    /** Timestamp of the last stream protection log. */
    lastStreamProtectionLogAt;
    /** Timestamp of the last detailed state log. */
    lastDetailedLogAt;
    /** Last policy backoff time for deduping logs. */
    _lastPolicyBackoff;
    /** Last policy cookie length for deduping logs. */
    _lastPolicyCookieLen;
    /** Timestamp of the last policy log. */
    _lastPolicyLogAt;
    /** Cumulative downloaded milliseconds (used during seek). */
    cumulativeDownloadedMs;
    /**
     * Constructs a new SABR stream.
     * @param config - Stream configuration options.
     */
    constructor(config = {}) {
        super();
        this.config = config;
        this.videoId = config.videoId;
        this.umpPartHandlers = new Map([
            [
                UMPPartId.FORMAT_INITIALIZATION_METADATA,
                this.handleFormatInitializationMetadata.bind(this)
            ],
            [UMPPartId.NEXT_REQUEST_POLICY, this.handleNextRequestPolicy.bind(this)],
            [
                UMPPartId.PLAYBACK_START_POLICY,
                this.handlePlaybackStartPolicy.bind(this)
            ],
            [UMPPartId.REQUEST_IDENTIFIER, this.handleRequestIdentifier.bind(this)],
            [
                UMPPartId.REQUEST_CANCELLATION_POLICY,
                this.handleRequestCancellationPolicy.bind(this)
            ],
            [UMPPartId.SABR_ERROR, this.handleSabrError.bind(this)],
            [UMPPartId.SABR_REDIRECT, this.handleSabrRedirect.bind(this)],
            [UMPPartId.SABR_CONTEXT_UPDATE, this.handleSabrContextUpdate.bind(this)],
            [
                UMPPartId.SABR_CONTEXT_SENDING_POLICY,
                this.handleSabrContextSendingPolicy.bind(this)
            ],
            [
                UMPPartId.STREAM_PROTECTION_STATUS,
                this.handleStreamProtectionStatus.bind(this)
            ],
            [
                UMPPartId.RELOAD_PLAYER_RESPONSE,
                this.handleReloadPlayerResponse.bind(this)
            ],
            [UMPPartId.MEDIA_HEADER, this.handleMediaHeader.bind(this)],
            [UMPPartId.MEDIA, this.handleMedia.bind(this)],
            [UMPPartId.MEDIA_END, this.handleMediaEnd.bind(this)],
            [UMPPartId.SNACKBAR_MESSAGE, this.handleSnackbarMessage.bind(this)]
        ]);
        this.initializedFormatsMap = new Map();
        this.partialSegmentQueue = new Map();
        this.sabrContexts = new Map();
        this.activeSabrContextTypes = new Set();
        this.requestNumber = 0;
        this.mediaHeadersProcessed = false;
        this._aborted = false;
        this.formatSequenceCounters = new Map();
        this.downloadedSegmentsByItag = new Map();
        this.endSegmentNumbers = new Map();
        this.streamFinished = false;
        this.poToken = null;
        this.visitorData = config.visitorData;
        this.serverAbrStreamingUrl = config.serverAbrStreamingUrl;
        if (this.serverAbrStreamingUrl) {
            const url = new URL(this.serverAbrStreamingUrl);
            url.searchParams.set('alr', 'yes');
            url.searchParams.set('ump', '1');
            url.searchParams.set('srfvp', '1');
            this.serverAbrStreamingUrl = url.toString();
        }
        this.videoPlaybackUstreamerConfig = config.videoPlaybackUstreamerConfig;
        this.clientInfo = config.clientInfo;
        this.formatIds = config.formats ?? [];
        this.startTime = config.startTime ?? 0;
        this.positionCallback = config.positionCallback;
        this.userAgent = config.userAgent ?? USER_AGENT;
        this.recoveryPending = false;
        this.poTokenGenerated = false;
        this.stallEmitted = false;
        this.totalDownloadedMs = 0;
        this.virtualPlayerTimeMs = 0;
        this.lastVirtualAdvanceAt = 0;
        this.pendingRangesHeaders = new Map();
        this.cachedBufferedRanges = null;
        this.lastReportedRanges = new Set();
        this.enableTrafficLog = false;
        this.trafficLogPath = path.join(process.cwd(), 'sabr_traffic.jsonl');
        this.enableTrafficDump = true;
        this.trafficDumpMaxBytes = 64 * 1024;
        this.bandwidthEstimate = 5_000_000;
        this.lastBandwidthLogAt = 0;
        this.noMediaStreak = 0;
        this.abortController = new AbortController();
        if (typeof config.poToken === 'string') {
            try {
                this.poToken = base64ToU8(config.poToken);
            }
            catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                logger('error', 'SABR', `Failed to decode PO token: ${message}`);
                this.poToken = null;
            }
        }
        else if (config.poToken instanceof Uint8Array) {
            this.poToken = config.poToken;
        }
        if (config.previousSession) {
            const ps = config.previousSession;
            this.requestNumber = ps.requestNumber ?? 0;
            this.bandwidthEstimate = ps.bandwidthEstimate ?? 5_000_000;
            this.nextRequestPolicy = ps.nextRequestPolicy;
            logger('info', 'SABR', `Session state transferred: rn=${this.requestNumber}, bw=${(this.bandwidthEstimate / 1_000_000).toFixed(2)}Mbps, hasCookie=${!!this.nextRequestPolicy?.playbackCookie}`);
        }
        this.lastRequestAt = 0;
        this.lastStreamProtectionStatus = undefined;
        this.lastStreamProtectionLogAt = 0;
        this.lastDetailedLogAt = 0;
        this._lastPolicyBackoff = undefined;
        this._lastPolicyCookieLen = undefined;
        this._lastPolicyLogAt = 0;
        this.cumulativeDownloadedMs = this.startTime;
    }
    /**
     * Exports current session state for transfer to a new SABR stream.
     *
     * Used during seek operations to avoid session recreation penalty.
     *
     * @returns Session state object.
     */
    getSessionState() {
        return {
            requestNumber: this.requestNumber,
            bandwidthEstimate: this.bandwidthEstimate,
            nextRequestPolicy: this.nextRequestPolicy
        };
    }
    /**
     * Writes a traffic log entry to the log file.
     * @param entry - Log entry to write.
     */
    logTraffic(entry) {
        if (!this.enableTrafficLog)
            return;
        void appendFile(this.trafficLogPath, `${JSON.stringify(entry)}\n`).catch(() => { });
    }
    /**
     * Updates the bandwidth estimate using an exponentially weighted moving average.
     * @param bytes - Bytes transferred.
     * @param durationMs - Transfer duration in milliseconds.
     */
    updateBandwidthEstimate(bytes, durationMs) {
        if (bytes <= 0 || durationMs <= 0)
            return;
        const bits = bytes * 8;
        const throughput = (bits / durationMs) * 1000;
        const alpha = 0.15;
        this.bandwidthEstimate =
            alpha * throughput + (1 - alpha) * this.bandwidthEstimate;
        if (Date.now() - this.lastBandwidthLogAt > 2000) {
            this.lastBandwidthLogAt = Date.now();
            logger('debug', 'SABR', `Bandwidth Update: measured=${(throughput / 1_000_000).toFixed(2)}Mbps est=${(this.bandwidthEstimate / 1_000_000).toFixed(2)}Mbps`);
        }
    }
    /**
     * Starts streaming with the specified audio itag.
     * @param audioItag - Audio format itag to stream.
     */
    start(audioItag) {
        const audioFormat = this.formatIds.find((f) => f.itag === audioItag);
        if (!audioFormat) {
            this.emit('error', new Error('Audio format not found in sabr config'));
            return;
        }
        this.loop(audioFormat);
    }
    /**
     * Main streaming loop that fetches and processes segments.
     * @param audioFormat - Audio format configuration.
     */
    async loop(audioFormat) {
        const signal = this.abortController.signal;
        try {
            if (this.lastVirtualAdvanceAt === 0)
                this.lastVirtualAdvanceAt = Date.now();
            while (!this._aborted && !this.destroyed && !this.streamFinished) {
                if (this.recoveryPending) {
                    await wait(500, signal);
                    continue;
                }
                if (this.requestNumber === 0 && !this.poTokenGenerated) {
                    this.poTokenGenerated = true;
                    try {
                        const tokenData = await poTokenManager.generate(this.videoId, this.visitorData ?? undefined);
                        if (this._aborted || this.destroyed)
                            break;
                        if (tokenData.poToken) {
                            this.poToken = base64ToU8(tokenData.poToken);
                            if (tokenData.visitorData && !this.visitorData) {
                                this.visitorData = tokenData.visitorData;
                            }
                            logger('debug', 'SABR', `Generated PO Token for session start. Used existing VD: ${!!this.visitorData}`);
                        }
                    }
                    catch (e) {
                        const message = e instanceof Error ? e.message : String(e);
                        logger('warn', 'SABR', `Failed to generate PO Token: ${message}`);
                    }
                }
                const now = Date.now();
                const prevPlayerTime = this.virtualPlayerTimeMs;
                if (this.totalDownloadedMs > this.virtualPlayerTimeMs) {
                    if (this.lastVirtualAdvanceAt > 0) {
                        this.virtualPlayerTimeMs += now - this.lastVirtualAdvanceAt;
                    }
                    this.lastVirtualAdvanceAt = now;
                }
                else {
                    if (this.totalDownloadedMs > 0) {
                        if (this.lastVirtualAdvanceAt > 0) {
                            const advance = now - this.lastVirtualAdvanceAt;
                            this.virtualPlayerTimeMs = Math.min(this.virtualPlayerTimeMs + advance, this.totalDownloadedMs);
                        }
                        this.lastVirtualAdvanceAt = now;
                    }
                }
                if (Math.floor(this.virtualPlayerTimeMs / 1000) !==
                    Math.floor(prevPlayerTime / 1000)) {
                    logger('debug', 'SABR', `Tracking: downloaded=${Math.floor(this.totalDownloadedMs)}ms virtualPlayerTime=${Math.floor(prevPlayerTime)}ms -> ${Math.floor(this.virtualPlayerTimeMs)}ms`);
                }
                const baseTimeMs = this.startTime ?? 0;
                const reportedPlayerTime = Math.floor(this.virtualPlayerTimeMs + baseTimeMs);
                if (this.readableLength > MAX_BUFFER_BYTES) {
                    await wait(250, signal);
                    continue;
                }
                if (this.mediaHeadersProcessed && this.positionCallback) {
                    this.positionCallback(reportedPlayerTime);
                }
                if (this.lastRequestAt) {
                    const since = now - this.lastRequestAt;
                    if (since < MIN_REQUEST_INTERVAL_MS)
                        await wait(MIN_REQUEST_INTERVAL_MS - since, signal);
                }
                this.lastRequestAt = Date.now();
                try {
                    await this.fetchAndProcessSegments({
                        playerTimeMs: Math.floor(this.totalDownloadedMs + baseTimeMs),
                        bandwidthEstimate: Math.max(Math.floor(this.bandwidthEstimate), 500_000),
                        enabledTrackTypesBitfield: 1,
                        audioTrackId: audioFormat.audioTrackId ?? '',
                        playerState: 1n,
                        visibility: 1,
                        playbackRate: 1.0,
                        stickyResolution: 1080,
                        lastManualSelectedResolution: 1080,
                        clientViewportIsFlexible: false
                    }, audioFormat);
                }
                catch (e) {
                    if (this._aborted || this.destroyed)
                        break;
                    const message = e instanceof Error ? e.message : String(e);
                    if (message.includes('sabr.malformed_config') ||
                        message.includes('sabr.media_serving_enforcement_id_error')) {
                        logger('warn', 'SABR', `Recoverable error detected: ${message}. Triggering recovery signal...`);
                        if (message.includes('media_serving_enforcement_id_error')) {
                            logger('warn', 'SABR', 'Enforcement ID error detected. Clearing SABR contexts to force fresh state.');
                            this.sabrContexts.clear();
                            this.activeSabrContextTypes.clear();
                        }
                        this.emit('stall');
                        const currentRn = this.requestNumber;
                        while (this.requestNumber === currentRn &&
                            !this._aborted &&
                            !this.destroyed) {
                            await wait(500, signal);
                        }
                        continue;
                    }
                    throw e;
                }
                if (!this.nextRequestPolicy?.backoffTimeMs &&
                    this.initializedFormatsMap.size === 0) {
                    await wait(250, signal);
                }
            }
        }
        catch (e) {
            if (!this.destroyed)
                this.destroy(e instanceof Error ? e : new Error(String(e)));
        }
    }
    /**
     * Destroys the stream and aborts all pending operations.
     * @param err - Optional error to emit.
     */
    destroy(err) {
        if (this._aborted)
            return this;
        this._aborted = true;
        this.abortController.abort();
        this.initializedFormatsMap.clear();
        this.partialSegmentQueue.clear();
        this.sabrContexts.clear();
        this.activeSabrContextTypes.clear();
        this.formatSequenceCounters.clear();
        this.downloadedSegmentsByItag.clear();
        this.endSegmentNumbers.clear();
        this.pendingRangesHeaders.clear();
        this.cachedBufferedRanges = null;
        this.lastReportedRanges.clear();
        this.nextRequestPolicy = undefined;
        this.formatIds = [];
        this.poToken = null;
        this.videoPlaybackUstreamerConfig = undefined;
        this.clientInfo = undefined;
        this.config = {};
        super.destroy(err);
        return this;
    }
    /**
     * Updates the session with new configuration.
     *
     * Called when the streaming URL or other parameters need to be refreshed
     * without recreating the entire stream.
     *
     * @param config - Updated configuration values.
     */
    updateSession(config) {
        if (config.serverAbrStreamingUrl) {
            const url = new URL(config.serverAbrStreamingUrl);
            url.searchParams.set('alr', 'yes');
            url.searchParams.set('ump', '1');
            url.searchParams.set('srfvp', '1');
            this.serverAbrStreamingUrl = url.toString();
        }
        if (config.videoPlaybackUstreamerConfig) {
            this.videoPlaybackUstreamerConfig = config.videoPlaybackUstreamerConfig;
        }
        if (config.poToken) {
            try {
                this.poToken =
                    typeof config.poToken === 'string'
                        ? base64ToU8(config.poToken)
                        : config.poToken;
            }
            catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                logger('error', 'SABR', `Failed to decode PO token (session update): ${message}`);
            }
        }
        if (config.visitorData) {
            this.visitorData = config.visitorData;
        }
        if (config.clientInfo) {
            this.clientInfo = config.clientInfo;
        }
        if (config.formats) {
            this.formatIds = config.formats;
        }
        if (config.userAgent) {
            this.userAgent = config.userAgent;
        }
        if (config.playbackCookie) {
            if (!this.nextRequestPolicy)
                this.nextRequestPolicy = {};
            this.nextRequestPolicy.playbackCookie =
                config.playbackCookie instanceof Uint8Array
                    ? config.playbackCookie
                    : base64ToU8(config.playbackCookie);
        }
        else if (this.nextRequestPolicy) {
            delete this.nextRequestPolicy.playbackCookie;
        }
        this.requestNumber = 0;
        this.noMediaStreak = 0;
        this.pendingRangesHeaders.clear();
        this.recoveryPending = false;
        this.poTokenGenerated = false;
        this.stallEmitted = false;
        logger('info', 'SABR', `Session updated. Continuing with RN=${this.requestNumber}, URL=${this.serverAbrStreamingUrl?.slice(0, 50)}...`);
    }
    /**
     * Clears all buffer state for recovery.
     *
     * Preserves timeline position to allow resuming from the same point.
     */
    clearBuffers() {
        this.initializedFormatsMap.clear();
        this.downloadedSegmentsByItag.clear();
        this.formatSequenceCounters.clear();
        this.partialSegmentQueue.clear();
        this.mediaHeadersProcessed = false;
        this.pendingRangesHeaders.clear();
        this.cachedBufferedRanges = null;
        this.lastReportedRanges.clear();
        this.sabrContexts.clear();
        this.activeSabrContextTypes.clear();
        logger('info', 'SABR', `Buffers cleared for recovery. Preserving timeline position: ${this.cumulativeDownloadedMs}ms, totalDownloaded: ${this.totalDownloadedMs}ms`);
    }
    /**
     * Seeks to a specific position in the stream.
     *
     * Clears segment buffers and resets tracking state while preserving
     * session state (request number, bandwidth estimate, playback cookie).
     *
     * @param positionMs - Target position in milliseconds.
     * @returns True if the seek was initiated successfully.
     */
    seekTo(positionMs) {
        if (this._aborted || this.destroyed) {
            logger('warn', 'SABR', 'Cannot seek: stream is destroyed or aborted');
            return false;
        }
        logger('info', 'SABR', `Seeking to ${positionMs}ms (from startTime=${this.startTime}ms)`);
        this.startTime = positionMs;
        this.downloadedSegmentsByItag.clear();
        this.formatSequenceCounters.clear();
        this.partialSegmentQueue.clear();
        this.initializedFormatsMap.clear();
        this.totalDownloadedMs = 0;
        this.virtualPlayerTimeMs = 0;
        this.cumulativeDownloadedMs = positionMs;
        this.lastVirtualAdvanceAt = Date.now();
        this.pendingRangesHeaders.clear();
        this.cachedBufferedRanges = null;
        this.lastReportedRanges.clear();
        this.mediaHeadersProcessed = false;
        this.streamFinished = false;
        this.noMediaStreak = 0;
        logger('debug', 'SABR', `Seek to ${positionMs}ms complete. Session preserved (rn=${this.requestNumber})`);
        return true;
    }
    /**
     * Decodes a UMP part using a protobuf decoder.
     * @param part - UMP part to decode.
     * @param decoder - Decoder object with a decode method.
     * @returns Decoded message or undefined on error.
     */
    decodePart(part, decoder) {
        try {
            const chunks = part.data.chunks;
            const data = chunks.length === 1
                ? chunks[0]
                : concatenateChunks(chunks);
            return decoder.decode(new ProtoReader(data), data.length);
        }
        catch {
            return undefined;
        }
    }
    /**
     * Resolves the format ID for a format entry for use in ABR requests.
     * @param format - Format entry to resolve.
     * @returns Resolved format ID or undefined.
     */
    resolveFormatIdForRequest(format) {
        if (!format)
            return undefined;
        if (format.xtags) {
            return {
                itag: format.itag,
                lastModified: format.lastModified,
                xtags: format.xtags
            };
        }
        const prefix = `${format.itag}:`;
        for (const [k, v] of this.initializedFormatsMap.entries()) {
            if (!k.startsWith(prefix))
                continue;
            const fid = v?.formatInitializationMetadata?.formatId;
            if (fid?.itag) {
                return {
                    itag: fid.itag,
                    lastModified: (fid.lastModified ??
                        fid.last_modified ??
                        format.lastModified),
                    xtags: fid.xtags
                };
            }
        }
        return {
            itag: format.itag,
            lastModified: format.lastModified,
            xtags: format.xtags
        };
    }
    /**
     * Handles FORMAT_INITIALIZATION_METADATA UMP parts.
     * @param part - The UMP part.
     */
    handleFormatInitializationMetadata(part) {
        const m = this.decodePart(part, FormatInitializationMetadata);
        if (!m)
            return;
        const k = FormatKeyUtils.fromFormatInitializationMetadata(m);
        if (!this.initializedFormatsMap.has(k)) {
            this.initializedFormatsMap.set(k, { formatInitializationMetadata: m });
            logger('debug', 'SABR', `Format init: key=${k} mime=${m.mimeType ?? ''} endSeg=${m.endSegmentNumber ?? ''}`);
            const itag = m.formatId?.itag ?? m.itag;
            if (itag &&
                m.endSegmentNumber !== undefined &&
                Number(m.endSegmentNumber) > 0) {
                this.endSegmentNumbers.set(itag, Number(m.endSegmentNumber));
                logger('debug', 'SABR', `Tracking completion: itag=${itag} will finish at segment ${m.endSegmentNumber}`);
            }
        }
    }
    /**
     * Handles SABR_ERROR UMP parts.
     * @param part - The UMP part.
     */
    handleSabrError(part) {
        const err = this.decodePart(part, SabrError);
        if (err) {
            const error = new Error(`SABR Error: ${err.code} ${err.type}`);
            error.code = err.code;
            error.type = err.type;
            if (this._aborted || this.destroyed)
                return;
            throw error;
        }
    }
    /**
     * Handles SABR_REDIRECT UMP parts.
     * @param part - The UMP part.
     */
    handleSabrRedirect(part) {
        const red = this.decodePart(part, SabrRedirect);
        if (red?.url) {
            this.serverAbrStreamingUrl = red.url;
        }
    }
    /**
     * Handles STREAM_PROTECTION_STATUS UMP parts.
     * @param part - The UMP part.
     */
    handleStreamProtectionStatus(part) {
        const status = this.decodePart(part, StreamProtectionStatus);
        if (!status)
            return;
        const now = Date.now();
        const changed = this.lastStreamProtectionStatus !== status.status;
        const shouldLog = changed ||
            !this.lastStreamProtectionLogAt ||
            now - this.lastStreamProtectionLogAt > 5000;
        this.lastStreamProtectionStatus = status.status;
        if (!shouldLog)
            return;
        this.lastStreamProtectionLogAt = now;
        if (status.status === 3) {
            logger('debug', 'SABR', `Stream Protection Status: ${status.status} (Attestation pending/required)`);
            return;
        }
        if (status.status === 2) {
            if (this.stallEmitted)
                return;
            this.stallEmitted = true;
            logger('warn', 'SABR', `Stream Protection Status: ${status.status} (Limited Playback). Triggering token refresh...`);
            poTokenManager.reset();
            this.recoveryPending = true;
            this.emit('stall');
            return;
        }
        logger('warn', 'SABR', `Stream Protection Status: ${status.status}`);
    }
    /**
     * Handles partial media data chunks.
     * @param buffer - The data buffer.
     * @param headerId - Header ID identifying the segment.
     * @param isFirstChunk - Whether this is the first chunk.
     */
    handleMediaPartial(buffer, headerId, isFirstChunk) {
        const s = this.partialSegmentQueue.get(headerId);
        if (s) {
            let dataToPush = buffer;
            if (isFirstChunk) {
                if (buffer.getLength() > 1) {
                    dataToPush = buffer.split(1).remainingBuffer;
                }
                else if (buffer.getLength() === 1) {
                    return;
                }
            }
            const bytes = dataToPush.getLength();
            s.loadedBytes = (s.loadedBytes ?? 0) + bytes;
            for (const c of dataToPush.chunks)
                this.push(c);
        }
    }
    /**
     * Handles MEDIA UMP parts.
     * @param part - The UMP part.
     */
    handleMedia(part) {
        const headerId = part.data.getUint8(0);
        const s = this.partialSegmentQueue.get(headerId);
        if (s) {
            const d = part.data.split(1).remainingBuffer;
            const bytes = d.getLength();
            s.loadedBytes = (s.loadedBytes ?? 0) + bytes;
            for (const c of d.chunks)
                this.push(c);
            if (bytes > 0) {
                logger('debug', 'SABR', `Media data: id=${headerId} bytes=${bytes} total=${s.loadedBytes}/${s.mediaHeader?.contentLength ?? '?'}`);
            }
        }
        else {
            logger('trace', 'SABR', `Media data for unknown headerId: ${headerId}`);
        }
    }
    /**
     * Handles MEDIA_HEADER UMP parts.
     * @param part - The UMP part.
     */
    handleMediaHeader(part) {
        const h = this.decodePart(part, MediaHeader);
        if (h) {
            const key = FormatKeyUtils.fromMediaHeader(h);
            const headerId = h.headerId ?? 0;
            let segmentNumber = h.sequenceNumber;
            if (h.isInitSeg) {
                segmentNumber = 0;
            }
            else if (segmentNumber === undefined || segmentNumber === 0) {
                const count = (this.formatSequenceCounters.get(h.itag) ?? 0) + 1;
                this.formatSequenceCounters.set(h.itag, count);
                segmentNumber = count;
            }
            else {
                this.formatSequenceCounters.set(h.itag, segmentNumber);
            }
            if (!h.durationMs || h.durationMs === '0') {
                if (h.timeRange && h.timeRange.timescale > 0) {
                    h.durationMs = Math.ceil((Number(h.timeRange.durationTicks ?? 0n) / h.timeRange.timescale) *
                        1000).toString();
                }
            }
            const mediaHeader = h;
            const formatIdKey = key;
            if (!this.pendingRangesHeaders.has(formatIdKey)) {
                this.pendingRangesHeaders.set(formatIdKey, []);
            }
            this.pendingRangesHeaders.get(formatIdKey)?.push(mediaHeader);
            logger('debug', 'SABR', `MediaHeader: id=${headerId} itag=${h.itag} seq=${segmentNumber} dur=${h.durationMs}ms`);
            this.partialSegmentQueue.set(headerId, {
                formatIdKey: key,
                segmentNumber,
                mediaHeader: h,
                durationMs: h.durationMs,
                loadedBytes: 0
            });
        }
        else {
            logger('warn', 'SABR', 'Failed to decode MediaHeader');
        }
    }
    /**
     * Handles MEDIA_END UMP parts.
     * @param part - The UMP part.
     */
    handleMediaEnd(part) {
        const id = part.data.getUint8(0);
        const s = this.partialSegmentQueue.get(id);
        if (s) {
            logger('debug', 'SABR', `MediaEnd: id=${id} seq=${s.segmentNumber} totalBytes=${s.loadedBytes}`);
            const itag = s.mediaHeader?.itag ?? s.mediaHeader?.formatId?.itag;
            let segmentDuration = 0;
            if (s.durationMs) {
                segmentDuration = Number(s.durationMs);
            }
            else if (s.mediaHeader?.timeRange &&
                s.mediaHeader.timeRange.timescale > 0) {
                segmentDuration = Math.ceil((Number(s.mediaHeader.timeRange.durationTicks ?? 0n) /
                    s.mediaHeader.timeRange.timescale) *
                    1000);
            }
            if (segmentDuration > 0) {
                this.totalDownloadedMs += segmentDuration;
                this.mediaHeadersProcessed = true;
                logger('debug', 'SABR', `Segment received: itag=${itag} seq=${s.segmentNumber} dur=${segmentDuration}ms totalDownloaded=${Math.floor(this.totalDownloadedMs)}ms`);
            }
            if (itag) {
                if (!this.downloadedSegmentsByItag.has(itag)) {
                    this.downloadedSegmentsByItag.set(itag, new Map());
                }
                const segMap = this.downloadedSegmentsByItag.get(itag);
                if (segMap?.has(s.segmentNumber)) {
                    logger('warn', 'SABR', `Ignoring duplicate segment ${s.segmentNumber} for itag ${itag}`);
                }
                else if (segMap) {
                    let startMs = Number(s.mediaHeader.startMs ?? 0);
                    if (startMs === 0 &&
                        s.mediaHeader.timeRange &&
                        s.mediaHeader.timeRange.timescale > 0) {
                        startMs = Number((BigInt(s.mediaHeader.timeRange.startTicks ?? 0n) * 1000n) /
                            BigInt(s.mediaHeader.timeRange.timescale));
                    }
                    const endMs = startMs + segmentDuration;
                    segMap.set(s.segmentNumber, {
                        segmentNumber: s.segmentNumber,
                        durationMs: segmentDuration,
                        byteLength: s.loadedBytes ?? 0,
                        mediaHeader: s.mediaHeader,
                        startMs,
                        endMs
                    });
                    let maxEdge = this.cumulativeDownloadedMs ?? 0;
                    if (endMs > maxEdge)
                        maxEdge = endMs;
                    this.cumulativeDownloadedMs = maxEdge;
                    const endSegmentNumber = this.endSegmentNumbers.get(itag);
                    if (endSegmentNumber !== undefined &&
                        s.segmentNumber >= endSegmentNumber &&
                        !this.streamFinished) {
                        this.streamFinished = true;
                        logger('info', 'SABR', `Stream complete: received final segment ${s.segmentNumber}/${endSegmentNumber} for itag ${itag}`);
                        setImmediate(() => {
                            if (!this.destroyed && !this._aborted) {
                                logger('info', 'SABR', 'Emitting finishBuffering event');
                                this.emit('finishBuffering');
                                this.end();
                            }
                        });
                    }
                }
            }
            this.partialSegmentQueue.delete(id);
        }
    }
    /**
     * Handles PLAYBACK_START_POLICY UMP parts.
     * @param part - The UMP part.
     */
    handlePlaybackStartPolicy(part) {
        this.decodePart(part, PlaybackStartPolicy);
    }
    /**
     * Handles REQUEST_IDENTIFIER UMP parts.
     * @param part - The UMP part.
     */
    handleRequestIdentifier(part) {
        this.decodePart(part, RequestIdentifier);
    }
    /**
     * Handles REQUEST_CANCELLATION_POLICY UMP parts.
     * @param part - The UMP part.
     */
    handleRequestCancellationPolicy(part) {
        this.decodePart(part, RequestCancellationPolicy);
    }
    /**
     * Handles NEXT_REQUEST_POLICY UMP parts.
     * @param part - The UMP part.
     */
    handleNextRequestPolicy(part) {
        const policy = this.decodePart(part, NextRequestPolicy);
        if (!policy)
            return;
        this.nextRequestPolicy = policy;
        const cookieLen = policy.playbackCookie?.length ?? 0;
        const backoff = policy.backoffTimeMs ?? 0;
        const now = Date.now();
        const changed = this._lastPolicyBackoff !== backoff ||
            this._lastPolicyCookieLen !== cookieLen;
        const shouldLog = changed || !this._lastPolicyLogAt || now - this._lastPolicyLogAt > 2000;
        this._lastPolicyBackoff = backoff;
        this._lastPolicyCookieLen = cookieLen;
        if (!shouldLog)
            return;
        this._lastPolicyLogAt = now;
        logger('debug', 'SABR', `NextRequestPolicy: backoff=${backoff}ms cookieLen=${cookieLen}`);
    }
    /**
     * Handles SABR_CONTEXT_UPDATE UMP parts.
     * @param part - The UMP part.
     */
    handleSabrContextUpdate(part) {
        const ctx = this.decodePart(part, SabrContextUpdate);
        if (ctx && ctx.type !== undefined && ctx.value?.length) {
            this.sabrContexts.set(ctx.type, {
                type: ctx.type,
                value: ctx.value,
                sendByDefault: ctx.sendByDefault
            });
            if (ctx.sendByDefault)
                this.activeSabrContextTypes.add(ctx.type);
            logger('debug', 'SABR', `Received context update type=${ctx.type} len=${ctx.value?.length} sendByDefault=${ctx.sendByDefault}`);
        }
    }
    /**
     * Handles SABR_CONTEXT_SENDING_POLICY UMP parts.
     * @param part - The UMP part.
     */
    handleSabrContextSendingPolicy(part) {
        const policy = this.decodePart(part, SabrContextSendingPolicy);
        if (policy) {
            for (const type of policy.startPolicy)
                this.activeSabrContextTypes.add(type);
            for (const type of policy.stopPolicy)
                this.activeSabrContextTypes.delete(type);
            for (const type of policy.discardPolicy)
                this.sabrContexts.delete(type);
        }
    }
    /**
     * Handles SNACKBAR_MESSAGE UMP parts (no-op).
     * @param _part - The UMP part.
     */
    handleSnackbarMessage(_part) { }
    /**
     * Handles RELOAD_PLAYER_RESPONSE UMP parts.
     * @param part - The UMP part.
     */
    handleReloadPlayerResponse(part) {
        const reloadContext = this.decodePart(part, ReloadPlaybackContext);
        if (reloadContext) {
            const reason = reloadContext.reason;
            logger('warn', 'SABR', `Reload requested by server. Reason: ${reason ?? 'unknown'}`);
            this.emit('stall');
        }
    }
    /**
     * Logs detailed state for debugging.
     * @param params - State parameters to log.
     */
    logDetailedState(params) {
        const { abrState, audioFormat, videoFormat, selectedFormatIds, preferredAudioFormatIds, bufferedRanges, contexts, unsent } = params;
        const now = Date.now();
        if (this.lastDetailedLogAt && now - this.lastDetailedLogAt < 2000)
            return;
        this.lastDetailedLogAt = now;
        const cookieLen = this.nextRequestPolicy?.playbackCookie?.length ?? 0;
        const initKeys = Array.from(this.initializedFormatsMap.keys()).slice(0, 5);
        const segMap = audioFormat
            ? this.downloadedSegmentsByItag.get(audioFormat.itag)
            : undefined;
        const segs = segMap ? Array.from(segMap.values()) : [];
        const downloadedMs = segs.reduce((sum, s) => sum + parseInt(s.durationMs?.toString() ?? '0', 10), 0);
        const aheadMs = abrState?.playerTimeMs !== undefined
            ? downloadedMs - abrState.playerTimeMs
            : undefined;
        const fmt = (f) => f ? `${f.itag}:${f.xtags ?? ''}` : 'none';
        logger('debug', 'SABR', `State rn=${this.requestNumber} playerTimeMs=${abrState?.playerTimeMs} startTime=${this.startTime} readable=${this.readableLength}/${MAX_BUFFER_BYTES} initKeys=[${initKeys.join(',')}] downloadedMs=${downloadedMs} aheadMs=${aheadMs}`);
        logger('debug', 'SABR', `Req formats audio=${fmt(audioFormat)} video=${fmt(videoFormat)} selected=[${(selectedFormatIds ?? []).map(String).join(',')}] preferredA=[${(preferredAudioFormatIds ?? []).map(String).join(',')}] bufferedRanges=${bufferedRanges?.length ?? 0} ctx=${contexts?.length ?? 0} unsentCtx=${unsent?.length ?? 0} backoff=${this.nextRequestPolicy?.backoffTimeMs ?? 0} cookieLen=${cookieLen}`);
        if (bufferedRanges?.length) {
            const br = bufferedRanges[0];
            if (br) {
                logger('debug', 'SABR', `BufferedRange[0]: itag=${br.formatId?.itag} xtags=${br.formatId?.xtags ?? ''} startMs=${br.startTimeMs ?? ''} durMs=${br.durationMs ?? ''} seg=[${br.startSegmentIndex ?? ''},${br.endSegmentIndex ?? ''}] ts=${br.timeRange?.timescale ?? ''} durTicks=${br.timeRange?.durationTicks ?? ''}`);
            }
        }
    }
    /**
     * Builds buffered ranges for the ABR request.
     * @param vFormat - Video format (optional).
     * @param aFormat - Audio format.
     * @returns Array of buffered range summaries.
     */
    buildBufferedRanges(vFormat, aFormat) {
        const bufferedRanges = [];
        const formats = [vFormat, aFormat].filter((f) => f !== undefined);
        for (const format of formats) {
            const itag = format.itag;
            const formatIdKey = createKey(itag, format.xtags);
            const headers = this.pendingRangesHeaders.get(formatIdKey);
            if (!headers || headers.length === 0)
                continue;
            const durationMs = headers.reduce((sum, h) => sum + parseInt(h.durationMs ?? '0', 10), 0);
            const startH = headers[0];
            const endH = headers[headers.length - 1];
            if (!startH || !endH)
                continue;
            bufferedRanges.push({
                durationMs: durationMs.toString(),
                formatId: this.resolveFormatIdForRequest(format),
                startTimeMs: (startH.startMs ?? '0').toString(),
                startSegmentIndex: startH.sequenceNumber ?? 1,
                endSegmentIndex: endH.sequenceNumber ?? 1,
                timeRange: {
                    durationTicks: ((BigInt(durationMs) * BigInt(startH.timeRange?.timescale ?? 1000)) /
                        1000n).toString(),
                    startTicks: (startH.startMs ?? '0').toString(),
                    timescale: startH.timeRange?.timescale ?? 1000
                }
            });
            this.pendingRangesHeaders.set(formatIdKey, []);
        }
        return bufferedRanges;
    }
    /**
     * Fetches and processes media segments from the SABR server.
     * @param abrState - ABR request state.
     * @param audioFormat - Audio format configuration.
     * @param videoFormat - Video format configuration (optional).
     */
    async fetchAndProcessSegments(abrState, audioFormat, videoFormat) {
        if (!this.videoPlaybackUstreamerConfig || !this.clientInfo)
            throw new Error('Missing config');
        if (this.nextRequestPolicy?.backoffTimeMs &&
            this.nextRequestPolicy.backoffTimeMs > 0) {
            const backoff = this.nextRequestPolicy.backoffTimeMs;
            logger('warn', 'SABR', `Waiting for backoff: ${backoff}ms`);
            await wait(backoff, this.abortController.signal);
            this.nextRequestPolicy.backoffTimeMs = 0;
        }
        const formats = [videoFormat, audioFormat].filter((f) => f !== undefined);
        const formatsInitialized = this.initializedFormatsMap.size > 0;
        const requestFormatIds = formats
            .map((f) => this.resolveFormatIdForRequest(f))
            .filter((f) => f !== undefined);
        const selectedFormatIds = formatsInitialized ? requestFormatIds : [];
        if (!this.cachedBufferedRanges) {
            this.cachedBufferedRanges = this.buildBufferedRanges(videoFormat, audioFormat);
        }
        const contexts = [];
        const unsent = [];
        for (const ctx of this.sabrContexts.values()) {
            if (this.activeSabrContextTypes.has(ctx.type)) {
                contexts.push({ type: ctx.type, value: ctx.value });
            }
            else {
                unsent.push(ctx.type);
            }
        }
        const preferredAudioFormatIds = audioFormat
            ? [this.resolveFormatIdForRequest(audioFormat)].filter((f) => f !== undefined)
            : [];
        const preferredVideoFormatIds = videoFormat
            ? [this.resolveFormatIdForRequest(videoFormat)].filter((f) => f !== undefined)
            : [];
        const bufferedRanges = this.cachedBufferedRanges ?? [];
        this.logDetailedState({
            abrState,
            audioFormat,
            videoFormat,
            selectedFormatIds,
            preferredAudioFormatIds,
            preferredVideoFormatIds,
            bufferedRanges,
            contexts,
            unsent
        });
        const requestBody = VideoPlaybackAbrRequest.encode({
            clientAbrState: {
                ...abrState,
                playerTimeMs: BigInt(abrState.playerTimeMs ?? 0).toString(),
                bandwidthEstimate: BigInt(abrState.bandwidthEstimate ?? 0).toString(),
                timeSinceLastActionMs: 0n
            },
            selectedFormatIds: selectedFormatIds,
            bufferedRanges: bufferedRanges.map((r) => ({
                formatId: r.formatId,
                startTimeMs: r.startTimeMs ?? '0',
                durationMs: r.durationMs ?? '0',
                startSegmentIndex: r.startSegmentIndex ?? 1,
                endSegmentIndex: r.endSegmentIndex ?? 1,
                timeRange: r.timeRange
                    ? {
                        startTicks: r.timeRange.startTicks ?? '0',
                        durationTicks: r.timeRange.durationTicks ?? '0',
                        timescale: r.timeRange.timescale ?? 1000
                    }
                    : undefined
            })),
            videoPlaybackUstreamerConfig: typeof this.videoPlaybackUstreamerConfig === 'string'
                ? base64ToU8(this.videoPlaybackUstreamerConfig)
                : this.videoPlaybackUstreamerConfig,
            preferredAudioFormatIds,
            preferredVideoFormatIds,
            streamerContext: {
                poToken: this.poToken ?? undefined,
                playbackCookie: this.nextRequestPolicy?.playbackCookie,
                clientInfo: this.clientInfo,
                sabrContexts: contexts,
                unsentSabrContexts: unsent
            }
        });
        const trafficReq = {
            ts: new Date().toISOString(),
            dir: 'client->yt',
            rn: this.requestNumber,
            url: this.serverAbrStreamingUrl,
            playerTimeMs: abrState.playerTimeMs,
            requestBodyBytes: requestBody.length,
            requestBodySha256: sha256Hex(requestBody),
            requestBodyB64: this.enableTrafficDump
                ? b64Trunc(requestBody, this.trafficDumpMaxBytes)
                : undefined,
            requestBodyB64Truncated: this.enableTrafficDump
                ? requestBody.length > this.trafficDumpMaxBytes
                : undefined,
            preferredAudioItags: preferredAudioFormatIds.map((f) => f.itag),
            selectedItags: selectedFormatIds.map((f) => f.itag),
            bufferedRanges: bufferedRanges.map((r) => ({
                itag: r.formatId?.itag,
                startMs: r.startTimeMs ?? '0',
                durMs: r.durationMs ?? '0',
                seg: [r.startSegmentIndex ?? 0, r.endSegmentIndex ?? 0]
            })),
            cookieLen: this.nextRequestPolicy?.playbackCookie?.length ?? 0,
            contexts: contexts.map((c) => ({
                type: c.type,
                valueLen: c.value.length
            })),
            unsentContexts: unsent
        };
        this.logTraffic(trafficReq);
        logger('debug', 'SABR', `Traffic -> rn=${trafficReq.rn} body=${trafficReq.requestBodyBytes}B br=${trafficReq.bufferedRanges?.length ?? 0} cookieLen=${trafficReq.cookieLen} sha256=${trafficReq.requestBodySha256}`);
        logger('debug', 'SABR', `Traffic -> rn=${trafficReq.rn} abrState(playerTimeMs=${trafficReq.playerTimeMs} enabled=${abrState.enabledTrackTypesBitfield} visibility=${abrState.visibility} rate=${abrState.playbackRate}) ctx=${trafficReq.contexts?.length ?? 0} unsentCtx=${trafficReq.unsentContexts?.length ?? 0}`);
        const reqPreviewB64 = b64Trunc(requestBody, 1024);
        logger('debug', 'SABR', `Traffic -> rn=${trafficReq.rn} bodyB64[1024B]=${reqPreviewB64.length > 260 ? `${reqPreviewB64.slice(0, 260)}...` : reqPreviewB64} (full in sabr_traffic.jsonl)`);
        const rn = this.requestNumber;
        const url = new URL(this.serverAbrStreamingUrl ?? '');
        url.searchParams.set('rn', rn.toString());
        this.requestNumber++;
        const headers = {
            'content-type': 'application/x-protobuf',
            accept: 'application/vnd.yt-ump',
            'x-goog-visitor-id': this.visitorData ?? '',
            'x-youtube-client-name': String(this.clientInfo?.clientName ?? '1'),
            'x-youtube-client-version': this.clientInfo?.clientVersion ?? '',
            origin: 'https://www.youtube.com',
            referer: `https://www.youtube.com/watch?v=${this.videoId}`,
            'user-agent': this.userAgent
        };
        if (this.config.accessToken) {
            headers.Authorization = `Bearer ${this.config.accessToken}`;
        }
        const t0 = Date.now();
        const res = await fetch(url.toString(), {
            method: 'POST',
            headers,
            body: Buffer.from(requestBody),
            signal: this.abortController.signal
        });
        if (!res.ok) {
            let errorText = '';
            try {
                errorText = await res.text();
            }
            catch {
                errorText = '(Failed to read response body)';
            }
            this.logTraffic({
                ts: new Date().toISOString(),
                dir: 'yt->client',
                rn,
                status: res.status,
                ok: false,
                statusText: res.statusText,
                url: url.toString(),
                durationMs: Date.now() - t0,
                responseBytes: (errorText ?? '').length,
                errorText: errorText.slice(0, 2000)
            });
            logger('error', 'SABR', `Fetch failed: ${res.status} ${res.statusText}`);
            logger('error', 'SABR', `URL: ${url.toString()}`);
            logger('error', 'SABR', `Response Body: ${errorText}`);
            throw new Error(`HTTP ${res.status}: ${errorText}`);
        }
        const signal = this.abortController.signal;
        if (!res.body)
            throw new Error('Missing response body');
        const reader = res.body.getReader();
        let buffer = new CompositeBuffer();
        const ump = new UmpReader(buffer);
        let responseBytes = 0;
        const responseHash = createHash('sha256');
        const responseDumpChunks = [];
        let responseDumpBytes = 0;
        const partCounts = Object.create(null);
        const partSeq = [];
        const partDumps = [];
        const saw = {
            media: false,
            mediaHeader: false,
            mediaEnd: false,
            nextRequestPolicy: false,
            playbackStartPolicy: false,
            requestIdentifier: false,
            requestCancellationPolicy: false,
            sabrError: false,
            sabrRedirect: false,
            sabrContextUpdate: false,
            streamProtectionStatus: false
        };
        this.mediaHeadersProcessed = false;
        let activePartial = null;
        try {
            while (!this._aborted && !this.destroyed) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                responseBytes += value.length;
                responseHash.update(value);
                if (this.enableTrafficDump &&
                    this.trafficDumpMaxBytes > 0 &&
                    responseDumpBytes < this.trafficDumpMaxBytes) {
                    const take = Math.min(value.length, this.trafficDumpMaxBytes - responseDumpBytes);
                    if (take > 0) {
                        responseDumpChunks.push(value.subarray(0, take));
                        responseDumpBytes += take;
                    }
                }
                buffer.append(value);
                ump.compositeBuffer = buffer;
                const incomplete = ump.read((part) => {
                    if (this._aborted)
                        return;
                    let handled = false;
                    if (part.type === UMPPartId.MEDIA &&
                        activePartial &&
                        activePartial.type === UMPPartId.MEDIA) {
                        const alreadyPushed = activePartial.processedBytes;
                        const remainder = part.data.split(alreadyPushed).remainingBuffer;
                        const headerId = activePartial.id ??
                            (part.data.getLength() > 0 ? part.data.getUint8(0) : 0);
                        const isFirst = alreadyPushed === 0;
                        this.handleMediaPartial(remainder, headerId, isFirst);
                        handled = true;
                        activePartial = null;
                    }
                    if (activePartial)
                        activePartial = null;
                    partCounts[part.type] = (partCounts[part.type] ?? 0) + 1;
                    partSeq.push({
                        type: part.type,
                        name: umpPartName(part.type),
                        size: part.size
                    });
                    if (part.type === UMPPartId.MEDIA)
                        saw.media = true;
                    else if (part.type === UMPPartId.MEDIA_HEADER)
                        saw.mediaHeader = true;
                    else if (part.type === UMPPartId.MEDIA_END)
                        saw.mediaEnd = true;
                    else if (part.type === UMPPartId.NEXT_REQUEST_POLICY)
                        saw.nextRequestPolicy = true;
                    else if (part.type === UMPPartId.PLAYBACK_START_POLICY)
                        saw.playbackStartPolicy = true;
                    else if (part.type === UMPPartId.REQUEST_IDENTIFIER)
                        saw.requestIdentifier = true;
                    else if (part.type === UMPPartId.REQUEST_CANCELLATION_POLICY)
                        saw.requestCancellationPolicy = true;
                    else if (part.type === UMPPartId.SABR_ERROR)
                        saw.sabrError = true;
                    else if (part.type === UMPPartId.SABR_REDIRECT)
                        saw.sabrRedirect = true;
                    else if (part.type === UMPPartId.SABR_CONTEXT_UPDATE)
                        saw.sabrContextUpdate = true;
                    else if (part.type === UMPPartId.STREAM_PROTECTION_STATUS)
                        saw.streamProtectionStatus = true;
                    if (this.enableTrafficDump && this.trafficDumpMaxBytes > 0) {
                        const shouldDumpPayload = part.type !== UMPPartId.MEDIA &&
                            part.type !== UMPPartId.MEDIA_HEADER &&
                            part.type !== UMPPartId.MEDIA_END;
                        if (shouldDumpPayload && part.size <= this.trafficDumpMaxBytes) {
                            try {
                                const payload = concatenateChunks(part.data.chunks);
                                let decoded;
                                try {
                                    if (part.type === UMPPartId.PLAYBACK_START_POLICY)
                                        decoded = PlaybackStartPolicy.decode(new ProtoReader(payload), payload.length);
                                    else if (part.type === UMPPartId.REQUEST_IDENTIFIER)
                                        decoded = RequestIdentifier.decode(new ProtoReader(payload), payload.length);
                                    else if (part.type === UMPPartId.REQUEST_CANCELLATION_POLICY)
                                        decoded = RequestCancellationPolicy.decode(new ProtoReader(payload), payload.length);
                                }
                                catch { }
                                partDumps.push({
                                    type: part.type,
                                    name: umpPartName(part.type),
                                    size: part.size,
                                    sha256: sha256Hex(payload),
                                    payloadB64: b64Trunc(payload, this.trafficDumpMaxBytes),
                                    payloadB64Truncated: payload.length > this.trafficDumpMaxBytes,
                                    decoded
                                });
                            }
                            catch { }
                        }
                    }
                    if (!handled) {
                        const handler = this.umpPartHandlers.get(part.type);
                        if (handler)
                            handler(part);
                    }
                });
                if (ump.compositeBuffer) {
                    if (activePartial) {
                        // Logic for maintaining partial state between reads
                    }
                    const res = incomplete;
                    if (res?.incomplete) {
                        if (!activePartial) {
                            activePartial = {
                                type: res.type,
                                totalSize: res.size,
                                headerSize: res.headerSize,
                                processedBytes: 0,
                                id: undefined
                            };
                        }
                        if (res.type === UMPPartId.MEDIA) {
                            const available = res.data.getLength();
                            const newBytesCount = available - activePartial.processedBytes;
                            if (newBytesCount > 0) {
                                const split = res.data.split(activePartial.processedBytes);
                                const newChunk = split.remainingBuffer;
                                let headerId = activePartial.id;
                                if (activePartial.processedBytes === 0 &&
                                    newChunk.getLength() >= 1) {
                                    headerId = newChunk.getUint8(0);
                                    activePartial.id = headerId;
                                }
                                if (headerId !== undefined) {
                                    const isFirst = activePartial.processedBytes === 0;
                                    this.handleMediaPartial(newChunk, headerId, isFirst);
                                }
                                activePartial.processedBytes += newBytesCount;
                            }
                        }
                    }
                    buffer = ump.compositeBuffer;
                }
            }
        }
        catch (err) {
            if (!(this._aborted || this.destroyed || signal.aborted))
                throw err;
        }
        finally {
            try {
                await reader.cancel();
            }
            catch { }
            try {
                reader.releaseLock();
            }
            catch { }
            const totalDuration = Date.now() - t0;
            if (responseBytes > 0 && totalDuration > 0) {
                if (saw.media || responseBytes > 5000) {
                    this.updateBandwidthEstimate(responseBytes, totalDuration);
                }
            }
        }
        const responseDump = this.enableTrafficDump && responseDumpChunks.length
            ? concatenateChunks(responseDumpChunks)
            : undefined;
        const trafficRes = {
            ts: new Date().toISOString(),
            dir: 'yt->client',
            rn,
            status: res.status,
            ok: true,
            url: url.toString(),
            durationMs: Date.now() - t0,
            responseBytes,
            responseSha256: responseHash.digest('hex'),
            responseBodyB64: responseDump
                ? Buffer.from(responseDump).toString('base64')
                : undefined,
            responseBodyB64Truncated: this.enableTrafficDump
                ? responseBytes > this.trafficDumpMaxBytes
                : undefined,
            contentType: res.headers.get('content-type') ?? '',
            contentLength: res.headers.get('content-length') ?? '',
            parts: partCounts,
            partSeq,
            partDumps: partDumps.length ? partDumps : undefined,
            saw,
            policy: {
                backoffTimeMs: this.nextRequestPolicy?.backoffTimeMs ?? 0,
                cookieLen: this.nextRequestPolicy?.playbackCookie?.length ?? 0,
                targetAudioReadaheadMs: this.nextRequestPolicy?.targetAudioReadaheadMs,
                minAudioReadaheadMs: this.nextRequestPolicy?.minAudioReadaheadMs,
                maxTimeSinceLastRequestMs: this.nextRequestPolicy?.maxTimeSinceLastRequestMs
            }
        };
        this.logTraffic(trafficRes);
        logger('debug', 'SABR', `Traffic <- rn=${rn} status=${res.status} bytes=${responseBytes} parts=${Object.keys(partCounts).length} hasMedia=${saw.media} backoff=${trafficRes.policy?.backoffTimeMs} cookieLen=${trafficRes.policy?.cookieLen}`);
        if (saw.media) {
            this.mediaHeadersProcessed = true;
            this.cachedBufferedRanges = null;
            this.noMediaStreak = 0;
        }
        else if (trafficRes.policy && trafficRes.policy.backoffTimeMs > 0) {
            this.noMediaStreak++;
            this.cachedBufferedRanges = null;
            if (this.noMediaStreak >= 12) {
                logger('warn', 'SABR', `Stall detected (noMediaStreak=${this.noMediaStreak}). Signaling for re-resolution.`);
                this.emit('stall');
                this.noMediaStreak = 0;
            }
        }
    }
}
