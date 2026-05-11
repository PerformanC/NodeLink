import { SAMPLE_RATE } from "../../constants.js";
import { AnimatableFilter } from "./AnimatableFilter.js";
import { clamp16Bit } from "./dsp/clamp16Bit.js";
import { resample } from "./timescale/resampler.js";
import TimeStretch from "./timescale/timeStretch.js";
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const FRAME_SIZE = CHANNELS * BYTES_PER_SAMPLE;
const FLOAT_DENOMINATOR = 32768;
const FLOAT_TO_INT_SCALE = 32767;
const EMPTY_BUFFER = Buffer.alloc(0);
/**
 * Concatenates multiple Float32Arrays into one.
 * @param chunks - Array of Float32Arrays.
 * @returns Combined Float32Array.
 */
const concatFloat32 = (chunks) => {
    if (chunks.length === 0)
        return new Float32Array(0);
    if (chunks.length === 1 && chunks[0])
        return chunks[0];
    let total = 0;
    for (const chunk of chunks)
        total += chunk.length;
    const output = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.length;
    }
    return output;
};
/**
 * Converts Int16 audio samples to Float32.
 * @param input - The Int16Array of samples.
 * @returns The Float32Array of samples.
 */
const int16ToFloat = (input) => {
    const output = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
        output[i] = (input[i] ?? 0) / FLOAT_DENOMINATOR;
    }
    return output;
};
/**
 * Converts Float32 audio samples to a 16-bit PCM Buffer.
 * @param input - The Float32Array of samples.
 * @returns The PCM Buffer.
 */
const floatToInt16Buffer = (input) => {
    const output = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
        output[i] = clamp16Bit((input[i] ?? 0) * FLOAT_TO_INT_SCALE);
    }
    return Buffer.from(output.buffer, output.byteOffset, output.byteLength);
};
/**
 * Modulates playback speed, pitch, and rate.
 * @public
 */
export default class Timescale extends AnimatableFilter {
    priority = 1;
    speed = 1.0;
    pitch = 1.0;
    rate = 1.0;
    _pending = EMPTY_BUFFER;
    _bypass = true;
    _silence = false;
    _effectiveTempo = 1.0;
    _effectiveRate = 1.0;
    _usesStretch = false;
    _timeStretch;
    constructor() {
        super();
        this._timeStretch = new TimeStretch({
            sampleRate: SAMPLE_RATE,
            channels: CHANNELS
        });
    }
    /**
     * Updates the timescale settings.
     * @param settings - Filter settings containing `timescale`.
     */
    update(settings) {
        super.applyAnimatedUpdate(settings, 'timescale', {
            speed: 1.0,
            pitch: 1.0,
            rate: 1.0
        });
    }
    onConfigChanged(config) {
        const speed = config.speed ?? 1.0;
        const pitch = config.pitch ?? 1.0;
        const rate = config.rate ?? 1.0;
        const bypass = speed === 1.0 && pitch === 1.0 && rate === 1.0;
        const silence = speed <= 0 || pitch <= 0 || rate <= 0;
        const wasBypassed = this._bypass || this._silence;
        this.speed = speed;
        this.pitch = pitch;
        this.rate = rate;
        this._bypass = bypass;
        this._silence = silence;
        if (this._bypass || this._silence) {
            if (!this._bypass)
                this._reset();
            return;
        }
        const tempo = speed / pitch;
        const rateScale = rate * pitch;
        const usesStretch = tempo !== 1.0;
        const needsReset = wasBypassed || usesStretch !== this._usesStretch;
        this._effectiveTempo = tempo;
        this._effectiveRate = rateScale;
        this._usesStretch = usesStretch;
        if (needsReset) {
            this._reset();
        }
        if (this._usesStretch) {
            this._timeStretch.setTempo(this._effectiveTempo);
        }
    }
    isConfigActive() {
        return !this._bypass;
    }
    /**
     * Returns the current effective playback rate.
     */
    getRate() {
        return this.speed * this.rate;
    }
    /**
     * Resets the timescale state.
     */
    _reset() {
        this._pending = EMPTY_BUFFER;
        this._timeStretch.reset();
    }
    /**
     * Processes Float32 samples through time stretching and resampling.
     * @param samples - The input Float32 samples.
     */
    _processFloat(samples) {
        if (samples.length === 0)
            return samples;
        if (this._effectiveRate > 1) {
            const stretched = this._usesStretch
                ? this._timeStretch.process(samples)
                : samples;
            return this._effectiveRate !== 1
                ? resample(stretched, CHANNELS, this._effectiveRate)
                : stretched;
        }
        const resampled = this._effectiveRate !== 1
            ? resample(samples, CHANNELS, this._effectiveRate)
            : samples;
        return this._usesStretch ? this._timeStretch.process(resampled) : resampled;
    }
    /**
     * Processes a PCM audio buffer.
     * @param chunk - PCM audio chunk.
     * @returns The processed PCM audio chunk.
     */
    process(chunk) {
        super.processAnimation(SAMPLE_RATE, chunk.length, CHANNELS);
        if (this._bypass)
            return chunk;
        if (this._silence)
            return EMPTY_BUFFER;
        if (!chunk || chunk.length === 0)
            return EMPTY_BUFFER;
        const inputBuffer = this._pending.length > 0 ? Buffer.concat([this._pending, chunk]) : chunk;
        const totalFrames = Math.floor(inputBuffer.length / FRAME_SIZE);
        if (totalFrames === 0) {
            this._pending = Buffer.from(inputBuffer);
            return EMPTY_BUFFER;
        }
        const bytesToProcess = totalFrames * FRAME_SIZE;
        const processBuffer = bytesToProcess === inputBuffer.length
            ? inputBuffer
            : inputBuffer.subarray(0, bytesToProcess);
        this._pending =
            bytesToProcess === inputBuffer.length
                ? EMPTY_BUFFER
                : Buffer.from(inputBuffer.subarray(bytesToProcess));
        const int16 = new Int16Array(processBuffer.buffer, processBuffer.byteOffset, processBuffer.byteLength / 2);
        const floatInput = int16ToFloat(int16);
        const processed = this._processFloat(floatInput);
        return processed.length === 0 ? EMPTY_BUFFER : floatToInt16Buffer(processed);
    }
    /**
     * Flushes any pending data from the timescale state.
     */
    flush() {
        if (this._bypass || this._silence)
            return EMPTY_BUFFER;
        const outputChunks = [];
        if (this._pending.length > 0) {
            const int16 = new Int16Array(this._pending.buffer, this._pending.byteOffset, this._pending.byteLength / 2);
            this._pending = EMPTY_BUFFER;
            const processed = this._processFloat(int16ToFloat(int16));
            if (processed.length > 0)
                outputChunks.push(processed);
        }
        if (this._usesStretch) {
            let tail = this._timeStretch.flush();
            if (this._effectiveRate > 1 && tail.length > 0) {
                tail = resample(tail, CHANNELS, this._effectiveRate);
            }
            if (tail.length > 0)
                outputChunks.push(tail);
        }
        if (outputChunks.length === 0) {
            this._reset();
            return EMPTY_BUFFER;
        }
        const combined = concatFloat32(outputChunks);
        this._reset();
        return floatToInt16Buffer(combined);
    }
    destroy() {
        this._timeStretch.destroy();
    }
}
