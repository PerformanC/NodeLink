import { Transform } from 'node:stream';
import { logger } from '../../utils.js';
import { RingBuffer } from '../structs/RingBuffer.js';
const TOO_SHORT = Symbol('TOO_SHORT');
const INVALID_VINT = Symbol('INVALID_VINT');
const parsePositiveIntEnv = (key, fallback) => {
    const raw = process.env[key];
    if (!raw)
        return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const BUFFER_SIZE = parsePositiveIntEnv('NODELINK_WEBM_DEMUX_RING_BYTES', 512 * 1024);
const TAGS = Object.freeze({
    '1a45dfa3': true,
    18538067: true,
    '1f43b675': true,
    '1654ae6b': true,
    '1c53bb6b': false,
    '1254c367': false,
    ae: true,
    d7: false,
    83: false,
    a3: false,
    '63a2': false,
    e7: false,
    a0: true,
    a1: false
});
const OPUS_HEAD = Buffer.from([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]);
const MAX_TAG_SIZE = 10 * 1024 * 1024;
const toTightBuffer = (buf) => Buffer.from(buf);
const webmOpusProfiler = {
    created: 0,
    destroyed: 0,
    active: 0,
    chunksIn: 0,
    bytesIn: 0,
    packetsOut: 0,
    packetBytesOut: 0,
    headPackets: 0,
    tooShortReads: 0,
    invalidVint: 0,
    skippedBytes: 0,
    ringPeakBytes: 0,
    maxTagBytesSeen: 0
};
export const getWebmOpusProfilerStats = () => ({
    ...webmOpusProfiler
});
/**
 * Reads the VINT length prefix from an EBML buffer.
 * @param buf - Source buffer to read from.
 * @param index - Byte offset to inspect.
 * @returns The VINT length (1-8 bytes) or a sentinel indicating failure.
 * @internal
 */
const readVintLength = (buf, index) => {
    if (index < 0 || index >= buf.length)
        return TOO_SHORT;
    const firstByte = buf[index];
    if (firstByte === undefined)
        return TOO_SHORT;
    if (firstByte === 0)
        return INVALID_VINT;
    let n = 0;
    for (; n < 8; n++)
        if ((1 << (7 - n)) & firstByte)
            break;
    n++;
    return index + n > buf.length ? TOO_SHORT : n;
};
/**
 * Reads an EBML variable-length integer (VINT).
 * @param buf - Source buffer containing the VINT.
 * @param start - Start index of the VINT.
 * @param end - End index (exclusive) of the VINT.
 * @returns Parsed bigint value or a sentinel when insufficient data exists.
 * @internal
 */
const readVint = (buf, start, end) => {
    if (end > buf.length)
        return TOO_SHORT;
    const len = readVintLength(buf, start);
    if (typeof len !== 'number')
        return TOO_SHORT;
    const mask = (1 << (8 - len)) - 1;
    const startByte = buf[start];
    if (startByte === undefined)
        return TOO_SHORT;
    let value = BigInt(startByte & mask);
    for (let i = start + 1; i < end; i++) {
        const nextByte = buf[i];
        if (nextByte === undefined)
            return TOO_SHORT;
        value = (value << 8n) | BigInt(nextByte);
    }
    return value;
};
/**
 * Base demuxer for WebM streams that emit Opus packets.
 * @remarks
 * This parser keeps a rolling ring buffer and scans EBML tags to locate
 * the Opus head payload and audio blocks.
 * @example
 * ```ts
 * const demuxer = new WebmOpusDemuxer()
 * inputStream.pipe(demuxer).on('data', (packet) => {
 *   // packet contains raw Opus frame bytes
 * })
 * ```
 * @internal
 */
class WebmBaseDemuxer extends Transform {
    ringBuffer;
    total;
    processed;
    skipUntil;
    currentTrack;
    pendingTrack;
    ebmlFound;
    /**
     * Creates a new WebM demuxer instance.
     * @param options - Transform stream options.
     */
    constructor(options = {}) {
        super({ readableObjectMode: true, ...options });
        this.on('error', (err) => {
            const code = err.code ? ` (${err.code})` : '';
            logger('error', 'WebmDemuxer', `Stream error: ${err.message}${code}`);
        });
        this.ringBuffer = new RingBuffer(BUFFER_SIZE);
        this.total = 0n;
        this.processed = 0n;
        this.skipUntil = null;
        this.currentTrack = null;
        this.pendingTrack = {};
        this.ebmlFound = false;
        webmOpusProfiler.created++;
        webmOpusProfiler.active++;
    }
    /**
     * Consumes incoming chunks and emits decoded Opus packets.
     * @param chunk - Incoming data chunk.
     * @param _encoding - Encoding (unused for Buffer input).
     * @param done - Callback to signal completion.
     */
    _transform(chunk, _encoding, done) {
        if (!chunk?.length) {
            done();
            return;
        }
        webmOpusProfiler.chunksIn++;
        webmOpusProfiler.bytesIn += chunk.length;
        this.ringBuffer.write(chunk);
        if (this.ringBuffer.length > webmOpusProfiler.ringPeakBytes) {
            webmOpusProfiler.ringPeakBytes = this.ringBuffer.length;
        }
        this.total += BigInt(chunk.length);
        if (this.skipUntil !== null) {
            const remainingToSkip = this.skipUntil - this.processed;
            const bufferLen = BigInt(this.ringBuffer.length);
            const toSkip = remainingToSkip < bufferLen ? remainingToSkip : bufferLen;
            if (toSkip > 0n) {
                const skipNum = toSkip > BigInt(Number.MAX_SAFE_INTEGER)
                    ? Number.MAX_SAFE_INTEGER
                    : Number(toSkip);
                this.ringBuffer.skip(skipNum);
                this.processed += BigInt(skipNum);
            }
            if (this.processed < this.skipUntil) {
                done();
                return;
            }
            this.skipUntil = null;
        }
        while (true) {
            const currentData = this.ringBuffer.getContiguous(this.ringBuffer.length);
            if (!currentData)
                break;
            let res;
            try {
                res = this._readTag(currentData, 0);
            }
            catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                logger('error', 'WebmDemuxer', `Error in _readTag: ${error.message}`);
                done(error);
                return;
            }
            if (res === TOO_SHORT) {
                webmOpusProfiler.tooShortReads++;
                break;
            }
            if (res._skipUntil) {
                const skipped = this.ringBuffer.length;
                if (skipped > 0)
                    webmOpusProfiler.skippedBytes += skipped;
                this.skipUntil = res._skipUntil;
                this.ringBuffer.skip(this.ringBuffer.length);
                this.processed += BigInt(this.ringBuffer.length);
                break;
            }
            if (res.offset) {
                if (res.offset > 0)
                    webmOpusProfiler.skippedBytes += res.offset;
                const offset = BigInt(res.offset);
                const skipNum = offset > BigInt(Number.MAX_SAFE_INTEGER)
                    ? Number.MAX_SAFE_INTEGER
                    : Number(offset);
                this.ringBuffer.skip(skipNum);
                this.processed += BigInt(skipNum);
            }
            else {
                break;
            }
        }
        if (this.total > 1000000000n && !this.skipUntil) {
            this.total = this.processed = 0n;
        }
        done();
    }
    /**
     * Reads the EBML tag ID from the provided buffer.
     * @param chunk - Buffer to scan.
     * @param offset - Offset to start reading from.
     * @returns Parsed tag ID or a sentinel when data is incomplete.
     */
    _readEBMLId(chunk, offset) {
        const len = readVintLength(chunk, offset);
        if (len === TOO_SHORT || len === INVALID_VINT)
            return len;
        return { id: chunk.subarray(offset, offset + len), offset: offset + len };
    }
    /**
     * Reads the EBML tag size.
     * @param chunk - Buffer to scan.
     * @param offset - Offset to start reading from.
     * @returns Parsed data length, including VINT metadata, or sentinel.
     */
    _readTagSize(chunk, offset) {
        const len = readVintLength(chunk, offset);
        if (len === TOO_SHORT || len === INVALID_VINT)
            return len;
        const dataLen = readVint(chunk, offset, offset + len);
        if (dataLen === TOO_SHORT)
            return TOO_SHORT;
        return { offset: offset + len, dataLen, vintLen: len };
    }
    /**
     * Parses a single EBML tag and emits audio when available.
     * @param chunk - Buffer to parse from.
     * @param offset - Offset into the buffer.
     * @returns Offsets to skip or a sentinel if more data is required.
     */
    _readTag(chunk, offset) {
        const idData = this._readEBMLId(chunk, offset);
        if (idData === TOO_SHORT)
            return TOO_SHORT;
        if (idData === INVALID_VINT) {
            webmOpusProfiler.invalidVint++;
            return { offset: 1 };
        }
        const tag = idData.id.toString('hex');
        if (!this.ebmlFound) {
            if (tag === '1a45dfa3' || tag === '1f43b675') {
                logger('debug', 'WebmDemuxer', `Header found: ${tag}`);
                this.ebmlFound = true;
            }
            else {
                return { offset: 1 };
            }
        }
        let currentOffset = idData.offset;
        const sizeData = this._readTagSize(chunk, currentOffset);
        if (sizeData === TOO_SHORT)
            return TOO_SHORT;
        if (sizeData === INVALID_VINT) {
            webmOpusProfiler.invalidVint++;
            return { offset: 1 };
        }
        const { dataLen, vintLen } = sizeData;
        const numericTagSize = Number(dataLen);
        if (Number.isFinite(numericTagSize) &&
            numericTagSize > webmOpusProfiler.maxTagBytesSeen) {
            webmOpusProfiler.maxTagBytesSeen = numericTagSize;
        }
        if (tag !== '18538067' && dataLen > BigInt(MAX_TAG_SIZE)) {
            const isUnknownSize = dataLen === 2n ** BigInt(7 * vintLen) - 1n;
            if (!isUnknownSize) {
                return { offset: 1 };
            }
        }
        currentOffset = sizeData.offset;
        if (!(tag in TAGS)) {
            const isUnknownSize = dataLen === 2n ** BigInt(7 * vintLen) - 1n;
            const numDataLen = Number(dataLen);
            if (isUnknownSize) {
                return { offset: 1 };
            }
            if (chunk.length > currentOffset + numDataLen)
                return { offset: currentOffset + numDataLen };
            return {
                offset: currentOffset,
                _skipUntil: this.processed + BigInt(currentOffset + numDataLen)
            };
        }
        const hasChildren = TAGS[tag];
        if (hasChildren)
            return { offset: currentOffset };
        const numDataLen = Number(dataLen);
        if (currentOffset + numDataLen > chunk.length)
            return TOO_SHORT;
        const data = chunk.subarray(currentOffset, currentOffset + numDataLen);
        if (!this.currentTrack) {
            if (tag === 'ae')
                this.pendingTrack = {};
            if (tag === 'd7')
                this.pendingTrack.number = data[0];
            if (tag === '83')
                this.pendingTrack.type = data[0];
            if (this.pendingTrack.type === 2 &&
                this.pendingTrack.number !== undefined)
                this.currentTrack = this.pendingTrack;
        }
        if (tag === '63a2') {
            try {
                this._checkHead(data);
                webmOpusProfiler.headPackets++;
                // Emit a tight copy so downstream listeners do not retain the ring backing store.
                this.emit('head', toTightBuffer(data));
            }
            catch (_e) { }
        }
        else if (tag === 'a3') {
            const firstByte = data[0];
            if (this.currentTrack &&
                firstByte !== undefined &&
                (firstByte & 0xf) === this.currentTrack.number) {
                // Avoid retaining large backing stores through subarray views.
                const packet = toTightBuffer(data.subarray(4));
                webmOpusProfiler.packetsOut++;
                webmOpusProfiler.packetBytesOut += packet.length;
                this.push(packet);
            }
        }
        return { offset: currentOffset + numDataLen };
    }
    /**
     * Cleans up internal buffers when destroyed.
     * @param err - Optional error.
     * @param cb - Callback invoked after cleanup.
     */
    _destroy(err, cb) {
        this._cleanup();
        cb(err ?? undefined);
    }
    /**
     * Cleans up internal buffers when the stream ends.
     * @param cb - Completion callback.
     */
    _final(cb) {
        this._cleanup();
        cb();
    }
    /**
     * Resets internal state and releases pooled buffers.
     */
    _cleanup() {
        webmOpusProfiler.destroyed++;
        webmOpusProfiler.active = Math.max(0, webmOpusProfiler.active - 1);
        this.ringBuffer.dispose();
        this.pendingTrack = {};
        this.currentTrack = null;
        this.ebmlFound = false;
        this.skipUntil = null;
    }
}
/**
 * Demuxer for WebM containers carrying Opus audio.
 * @example
 * ```ts
 * const demuxer = new WebmOpusDemuxer()
 * demuxer.on('head', (header) => console.log('Opus head', header))
 * sourceStream.pipe(demuxer)
 * ```
 * @public
 */
export class WebmOpusDemuxer extends WebmBaseDemuxer {
    /**
     * Ensures the Opus head packet is present.
     * @param data - Packet payload to validate.
     */
    _checkHead(data) {
        if (!data.subarray(0, 8).equals(OPUS_HEAD)) {
            throw new Error('Expected Opus audio stream');
        }
    }
}
export default WebmOpusDemuxer;
