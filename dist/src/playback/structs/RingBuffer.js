import { bufferPool } from "./BufferPool.js";
/**
 * A fast, fixed-size circular buffer for audio chunks.
 * Uses BufferPool for memory management to reduce GC pressure.
 * @public
 */
export class RingBuffer {
    buffer;
    size;
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
     * @param size - The size of the buffer in bytes.
     */
    constructor(size) {
        this.buffer = bufferPool.acquire(size);
        this.size = size;
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
        if (!this.buffer)
            return;
        const bytesToWrite = Math.min(chunk.length, this.size);
        const availableAtEnd = this.size - this.writeOffset;
        if (bytesToWrite <= availableAtEnd) {
            chunk.copy(this.buffer, this.writeOffset, 0, bytesToWrite);
        }
        else {
            chunk.copy(this.buffer, this.writeOffset, 0, availableAtEnd);
            chunk.copy(this.buffer, 0, availableAtEnd, bytesToWrite);
        }
        const newLength = this._length + bytesToWrite;
        if (newLength > this.size) {
            this.readOffset = (this.readOffset + (newLength - this.size)) % this.size;
            this._length = this.size;
        }
        else {
            this._length = newLength;
        }
        this.writeOffset = (this.writeOffset + bytesToWrite) % this.size;
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
        this.readTo(out);
        return out;
    }
    /**
     * Reads bytes from the ring buffer directly into the target buffer.
     * @param target - The target buffer to write into.
     * @param targetOffset - Offset in the target buffer.
     * @returns The number of bytes actually read.
     */
    readTo(target, targetOffset = 0) {
        if (!this.buffer)
            return 0;
        const bytesToRead = Math.min(target.length - targetOffset, this._length);
        if (bytesToRead <= 0)
            return 0;
        const availableAtEnd = this.size - this.readOffset;
        if (bytesToRead <= availableAtEnd) {
            this.buffer.copy(target, targetOffset, this.readOffset, this.readOffset + bytesToRead);
        }
        else {
            this.buffer.copy(target, targetOffset, this.readOffset, this.size);
            this.buffer.copy(target, targetOffset + availableAtEnd, 0, bytesToRead - availableAtEnd);
        }
        this.readOffset = (this.readOffset + bytesToRead) % this.size;
        this._length -= bytesToRead;
        return bytesToRead;
    }
    /**
     * Skips n bytes in the buffer.
     * @param n - The number of bytes to skip.
     * @returns The number of bytes actually skipped.
     */
    skip(n) {
        const bytesToSkip = Math.min(Math.max(0, n), this._length);
        this.readOffset = (this.readOffset + bytesToSkip) % this.size;
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
        const availableAtEnd = this.size - this.readOffset;
        if (bytesToPeek <= availableAtEnd) {
            return this.buffer.subarray(this.readOffset, this.readOffset + bytesToPeek);
        }
        const out = Buffer.allocUnsafe(bytesToPeek);
        this.buffer.copy(out, 0, this.readOffset, this.size);
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
        const availableAtEnd = this.size - this.readOffset;
        if (bytesToGet <= availableAtEnd) {
            return this.buffer.subarray(this.readOffset, this.readOffset + bytesToGet);
        }
        const out = Buffer.allocUnsafe(bytesToGet);
        this.buffer.copy(out, 0, this.readOffset, this.size);
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
