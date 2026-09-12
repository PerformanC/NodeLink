/**
 * FIFO buffer for Float32 audio samples, organized by frames.
 * @public
 */
export default class FloatFifoBuffer {
    _channels;
    _buffer;
    _startFrame;
    _frames;
    /**
     * Creates a new FIFO buffer.
     * @param channels - Number of audio channels.
     */
    constructor(channels) {
        this._channels = channels;
        this._buffer = new Float32Array(0);
        this._startFrame = 0;
        this._frames = 0;
    }
    /**
     * Returns the current number of frames in the buffer.
     */
    get frameCount() {
        return this._frames;
    }
    /**
     * Returns the starting frame index.
     */
    get startFrame() {
        return this._startFrame;
    }
    /**
     * Returns the number of channels.
     */
    get channels() {
        return this._channels;
    }
    /**
     * Returns the raw Float32Array buffer.
     */
    get buffer() {
        return this._buffer;
    }
    /**
     * Clears the buffer.
     */
    clear() {
        this._buffer = new Float32Array(0);
        this._startFrame = 0;
        this._frames = 0;
    }
    destroy() {
        // biome-ignore lint/suspicious/noExplicitAny: intentional null to release buffer
        ;
        this._buffer = null;
        this._frames = 0;
    }
    /**
     * Calculates the starting sample index.
     */
    _startIndex() {
        return this._startFrame * this._channels;
    }
    /**
     * Calculates the ending sample index.
     */
    _endIndex() {
        return (this._startFrame + this._frames) * this._channels;
    }
    /**
     * Ensures the buffer has enough capacity for the target number of frames.
     * @param targetFrames - The total frames needed.
     */
    _ensureCapacity(targetFrames) {
        const requiredSamples = targetFrames * this._channels;
        if (this._buffer.length < requiredSamples) {
            const next = new Float32Array(requiredSamples);
            if (this._frames > 0) {
                next.set(this._buffer.subarray(this._startIndex(), this._endIndex()));
            }
            this._buffer = next;
            this._startFrame = 0;
            return;
        }
        if (this._startFrame > 0) {
            this._buffer.set(this._buffer.subarray(this._startIndex(), this._endIndex()));
            this._startFrame = 0;
        }
    }
    /**
     * Pushes new samples into the buffer.
     * @param samples - The Float32Array of samples to push.
     */
    push(samples) {
        const frames = Math.floor(samples.length / this._channels);
        if (frames <= 0)
            return;
        const sampleCount = frames * this._channels;
        this._ensureCapacity(this._frames + frames);
        this._buffer.set(samples.subarray(0, sampleCount), this._endIndex());
        this._frames += frames;
    }
    /**
     * Copies frames from the buffer to a target Float32Array.
     * @param target - The destination Float32Array.
     * @param startFrame - The starting frame to copy from.
     * @param frameCount - The number of frames to copy.
     */
    copyTo(target, startFrame, frameCount) {
        if (frameCount <= 0)
            return;
        const startIndex = (this._startFrame + startFrame) * this._channels;
        const sampleCount = frameCount * this._channels;
        target.set(this._buffer.subarray(startIndex, startIndex + sampleCount), 0);
    }
    /**
     * Discards frames from the front of the buffer.
     * @param frames - The number of frames to discard.
     */
    discard(frames) {
        if (frames <= 0)
            return;
        if (frames >= this._frames) {
            this.clear();
            return;
        }
        this._startFrame += frames;
        this._frames -= frames;
    }
}
