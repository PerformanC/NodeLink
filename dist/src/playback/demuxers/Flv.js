import { Transform } from 'node:stream';
import { logger } from '../../utils.js';
import { bufferPool } from '../structs/BufferPool.js';
import { RingBuffer } from '../structs/RingBuffer.js';
const STATE_HEADER = 0;
const STATE_TAG_HEADER = 1;
const STATE_TAG_BODY = 2;
const TAG_TYPE_AUDIO = 8;
const BUFFER_SIZE = 2 * 1024 * 1024; // 2MB
const FLV_SIGNATURE = 'FLV';
const FLV_HEADER_SIZE = 9;
const FLV_HEADER_TOTAL_BYTES = 13;
const FLV_TAG_HEADER_SIZE = 11;
const FLV_PREVIOUS_TAG_SIZE_BYTES = 4;
/**
 * Transform stream that demultiplexes FLV containers and emits audio tag payloads.
 * @remarks
 * The demuxer validates the "FLV" signature, skips non-audio tags, and pushes
 * only the raw audio payload (excluding tag headers and previous tag sizes).
 * @example
 * ```ts
 * const demuxer = new FlvDemuxer()
 * sourceStream.pipe(demuxer).on('data', (audioTag) => {
 *   // audioTag contains the FLV audio payload
 * })
 * ```
 * @public
 */
export class FlvDemuxer extends Transform {
    ringBuffer;
    state;
    expectedSize;
    currentTag;
    /**
     * Creates a new FLV demuxer transform.
     * @param options - Node.js transform options applied to the demuxer.
     */
    constructor(options = {}) {
        super({ ...options, readableObjectMode: true });
        this.on('error', (err) => {
            const code = typeof err === 'object' && err && 'code' in err
                ? String(err.code)
                : '';
            const suffix = code ? ` (${code})` : '';
            logger('error', 'FlvDemuxer', `Stream error: ${err.message}${suffix}`);
        });
        this.ringBuffer = new RingBuffer(BUFFER_SIZE);
        this.state = STATE_HEADER;
        this.expectedSize = FLV_HEADER_SIZE;
        this.currentTag = null;
    }
    /**
     * Parses incoming FLV data and emits audio tag payloads when available.
     * @param chunk - Incoming FLV bytes.
     * @param _encoding - Ignored encoding (buffer mode).
     * @param callback - Called when processing completes.
     * @internal
     */
    _transform(chunk, _encoding, callback) {
        this.ringBuffer.write(chunk);
        while (this.ringBuffer.length >= this.expectedSize) {
            if (this.state === STATE_HEADER) {
                const header = this.ringBuffer.peek(3);
                if (!header || header.toString('ascii') !== FLV_SIGNATURE) {
                    callback(new Error('Invalid FLV header'));
                    return;
                }
                this.ringBuffer.skip(FLV_HEADER_TOTAL_BYTES);
                this.state = STATE_TAG_HEADER;
                this.expectedSize = FLV_TAG_HEADER_SIZE;
            }
            else if (this.state === STATE_TAG_HEADER) {
                const header = this.ringBuffer.read(FLV_TAG_HEADER_SIZE);
                if (!header) {
                    callback(new Error('Missing FLV tag header'));
                    return;
                }
                const type = header.readUInt8(0);
                const size = header.readUIntBE(1, 3);
                bufferPool.release(header);
                this.currentTag = { type, size };
                this.state = STATE_TAG_BODY;
                this.expectedSize = size + FLV_PREVIOUS_TAG_SIZE_BYTES;
            }
            else if (this.state === STATE_TAG_BODY) {
                if (!this.currentTag) {
                    callback(new Error('Missing FLV tag header'));
                    return;
                }
                const body = this.ringBuffer.read(this.currentTag.size);
                if (!body) {
                    callback(new Error('Missing FLV tag body'));
                    return;
                }
                this.ringBuffer.skip(FLV_PREVIOUS_TAG_SIZE_BYTES);
                if (this.currentTag.type === TAG_TYPE_AUDIO) {
                    this.push(Buffer.from(body));
                }
                bufferPool.release(body);
                this.state = STATE_TAG_HEADER;
                this.expectedSize = FLV_TAG_HEADER_SIZE;
            }
        }
        callback();
    }
    /**
     * Releases ring buffer resources when the stream is destroyed.
     * @param err - Optional error that caused destruction.
     * @param cb - Callback invoked after cleanup.
     * @internal
     */
    _destroy(err, cb) {
        this.ringBuffer.dispose();
        cb(err);
    }
}
export default FlvDemuxer;
