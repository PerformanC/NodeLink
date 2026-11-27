import { bufferPool } from './BufferPool.js';
/**
 * A bounded circular buffer for audio chunks.
 * Uses BufferPool for memory management to reduce GC pressure.
 * @public
 */
export class RingBuffer {
    buffer;
    size;
    capacity;
    writeOffset;
    readOffset;
    _length;
    /**
     * Gets the number of bytes currently available in the buffer.
     */
    get length() {
        return this._length;
    }
    /**
     * Creates a new RingBuffer.
     * @param size - The maximum size of the buffer in bytes.
     * @param initialSize - Initial allocation size, defaulting to the maximum.
     */
    constructor(size, initialSize = size) {
        this.buffer = bufferPool.acquire(Math.min(initialSize, size));
        this.size = size;
        this.capacity = Math.min(this.buffer.length, size);
        this.writeOffset = 0;
        this.readOffset = 0;
        this._length = 0;
    }
    /**
     * Releases the internal buffer back to the pool.
     */
    dispose() {
        if (this.buffer) {
            bufferPool.release(this.buffer);
            this.buffer = null;
        }
    }
    /**
     * Writes a chunk of data to the buffer.
     * If the buffer is full, it overwrites the oldest data.
     * Chunks larger than the buffer size are truncated to fit.
     * @param chunk - The data chunk to write.
     */
    write(chunk) {
        let buffer = this.buffer;
        if (!buffer)
            return;
        const bytesToWrite = Math.min(chunk.length, this.size);
        const newLength = this._length + bytesToWrite;
        if (newLength > this.capacity && this.capacity < this.size) {
            const grown = bufferPool.acquire(Math.min(this.size, Math.max(newLength, this.capacity * 2)));
            const firstPart = Math.min(this._length, this.capacity - this.readOffset);
            buffer.copy(grown, 0, this.readOffset, this.readOffset + firstPart);
            buffer.copy(grown, firstPart, 0, this._length - firstPart);
            bufferPool.release(buffer);
            this.buffer = buffer = grown;
            this.capacity = Math.min(grown.length, this.size);
            this.readOffset = 0;
            this.writeOffset = this._length;
        }
        const availableAtEnd = this.capacity - this.writeOffset;
        if (bytesToWrite <= availableAtEnd) {
            chunk.copy(buffer, this.writeOffset, 0, bytesToWrite);
        }
        else {
            chunk.copy(buffer, this.writeOffset, 0, availableAtEnd);
            chunk.copy(buffer, 0, availableAtEnd, bytesToWrite);
        }
        if (newLength > this.size) {
            this.readOffset = (this.readOffset + (newLength - this.size)) % this.size;
            this._length = this.size;
        }
        else {
            this._length = newLength;
        }
        this.writeOffset = (this.writeOffset + bytesToWrite) % this.capacity;
    }
    /**
     * Reads up to n bytes from the buffer.
     * @param n - The maximum number of bytes to read.
     * @returns A Buffer containing the data, or null if empty or disposed.
     */
    read(n) {
        if (!this.buffer)
            return null;
        const bytesToRead = Math.min(Math.max(0, n), this._length);
        if (bytesToRead === 0)
            return null;
        const out = Buffer.allocUnsafe(bytesToRead);
        const availableAtEnd = this.capacity - this.readOffset;
        if (bytesToRead <= availableAtEnd) {
            this.buffer.copy(out, 0, this.readOffset, this.readOffset + bytesToRead);
        }
        else {
            this.buffer.copy(out, 0, this.readOffset, this.capacity);
            this.buffer.copy(out, availableAtEnd, 0, bytesToRead - availableAtEnd);
        }
        this.readOffset = (this.readOffset + bytesToRead) % this.capacity;
        this._length -= bytesToRead;
        return out;
    }
    /**
     * Skips n bytes in the buffer.
     * @param n - The number of bytes to skip.
     * @returns The number of bytes actually skipped.
     */
    skip(n) {
        const bytesToSkip = Math.min(Math.max(0, n), this._length);
        this.readOffset = (this.readOffset + bytesToSkip) % this.capacity;
        this._length -= bytesToSkip;
        return bytesToSkip;
    }
    /**
     * Peeks up to n bytes from the buffer without advancing the read offset.
     * @param n - The maximum number of bytes to peek.
     * @returns A new Buffer containing the data, or null if empty or disposed.
     */
    peek(n) {
        if (!this.buffer)
            return null;
        const bytesToPeek = Math.min(Math.max(0, n), this._length);
        if (bytesToPeek === 0)
            return null;
        const availableAtEnd = this.capacity - this.readOffset;
        if (bytesToPeek <= availableAtEnd) {
            return this.buffer.subarray(this.readOffset, this.readOffset + bytesToPeek);
        }
        const out = Buffer.allocUnsafe(bytesToPeek);
        this.buffer.copy(out, 0, this.readOffset, this.capacity);
        this.buffer.copy(out, availableAtEnd, 0, bytesToPeek - availableAtEnd);
        return out;
    }
    /**
     * Gets up to n contiguous bytes from the buffer.
     * @param n - The maximum number of bytes to get.
     * @returns A Buffer subarray or a new Buffer, or null if empty or disposed.
     */
    getContiguous(n) {
        if (!this.buffer)
            return null;
        const bytesToGet = Math.min(Math.max(0, n), this._length);
        if (bytesToGet === 0)
            return null;
        const availableAtEnd = this.capacity - this.readOffset;
        if (bytesToGet <= availableAtEnd) {
            return this.buffer.subarray(this.readOffset, this.readOffset + bytesToGet);
        }
        const out = Buffer.allocUnsafe(bytesToGet);
        this.buffer.copy(out, 0, this.readOffset, this.capacity);
        this.buffer.copy(out, availableAtEnd, 0, bytesToGet - availableAtEnd);
        return out;
    }
    /**
     * Clears the buffer.
     */
    clear() {
        this.writeOffset = 0;
        this.readOffset = 0;
        this._length = 0;
    }
}
