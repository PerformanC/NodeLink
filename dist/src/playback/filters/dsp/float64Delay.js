/**
 * High-precision Float64 delay line with linear interpolation.
 *
 * Inspired by TapeTransformer's approach to audio quality:
 *  1. Float64 storage — no Int16 quantization in the feedback path.
 *     Each pass through echo feedback loses ~96 dB of precision with
 *     Int16; Float64 preserves ~300 dB, eliminating cumulative noise.
 *  2. Linear interpolation — when delay is e.g. 234.7 samples, the
 *     old DelayLine truncated to 234 (Math.floor), causing pitch
 *     artifacts.  Linear interpolation between adjacent samples gives
 *     smooth, correct fractional delays.
 *  3. Float64Array — pre-allocated, no GC pressure, stable RSS.
 *
 * @public
 */
export class Float64DelayLine {
    buffer;
    size;
    writeIndex;
    constructor(size) {
        this.size = Math.max(1, Math.ceil(size));
        this.buffer = new Float64Array(this.size);
        this.writeIndex = 0;
    }
    /**
     * Writes a sample to the delay line.  Value is stored as Float64 —
     * no clamping or truncation.
     */
    write(sample) {
        const buf = this.buffer;
        if (!buf)
            return;
        buf[this.writeIndex] = sample;
        this.writeIndex = (this.writeIndex + 1) % this.size;
    }
    /**
     * Reads a sample with linear interpolation for fractional delays.
     *
     * When delayInSamples = 234.7:
     *   sample[234] × 0.3 + sample[235] × 0.7
     *
     * This eliminates the pitch artifacts caused by Math.floor truncation
     * in the old Int16 DelayLine.
     */
    read(delayInSamples) {
        if (delayInSamples <= 0) {
            // Reading current write position (most recent sample)
            const idx = (this.writeIndex - 1 + this.size) % this.size;
            return this.buffer?.[idx] ?? 0;
        }
        const clamped = Math.min(delayInSamples, this.size - 1);
        const intDelay = Math.floor(clamped);
        const frac = clamped - intDelay;
        const idx0 = (this.writeIndex - intDelay - 1 + this.size * 2) % this.size;
        const idx1 = (idx0 - 1 + this.size) % this.size;
        const s0 = this.buffer?.[idx0] ?? 0;
        const s1 = this.buffer?.[idx1] ?? 0;
        // Linear interpolation: (1-frac)×s0 + frac×s1
        return s0 + frac * (s1 - s0);
    }
    /**
     * Clears the delay line (zero-fill).
     */
    clear() {
        this.buffer?.fill(0);
    }
    destroy() {
        this.buffer = null;
    }
}
