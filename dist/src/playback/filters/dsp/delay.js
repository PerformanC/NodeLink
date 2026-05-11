/**
 * Simple delay line for audio signal processing.
 * @public
 */
export default class DelayLine {
    buffer;
    size;
    writeIndex;
    /**
     * Creates a new delay line.
     * @param size - The size of the delay line in samples.
     */
    constructor(size) {
        this.buffer = Buffer.alloc(size * 2);
        this.size = size;
        this.writeIndex = 0;
    }
    /**
     * Writes a sample to the delay line.
     * @param sample - The PCM sample to write.
     */
    write(sample) {
        this.buffer.writeInt16LE(sample, this.writeIndex * 2);
        this.writeIndex = (this.writeIndex + 1) % this.size;
    }
    /**
     * Reads a sample from the delay line with the specified delay.
     * @param delayInSamples - The delay in samples.
     * @returns The delayed sample.
     */
    read(delayInSamples) {
        const safeDelay = Math.max(0, Math.min(Math.floor(delayInSamples), this.size - 1));
        const readIndex = (this.writeIndex - safeDelay + this.size) % this.size;
        return this.buffer.readInt16LE(readIndex * 2);
    }
    /**
     * Clears the delay line buffer.
     */
    clear() {
        this.buffer.fill(0);
    }
    destroy() {
        // biome-ignore lint/suspicious/noExplicitAny: intentional null to release buffer
        ;
        this.buffer = null;
    }
}
