import FloatFifoBuffer from "./floatFifoBuffer.js";
const DEFAULT_FRAME_SIZE = 1024;
const DEFAULT_OVERLAP = 256;
const DEFAULT_SEARCH = 128;
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
 * Time-stretching logic using the WSOLA algorithm.
 * @public
 */
export default class TimeStretch {
    sampleRate;
    channels;
    frameSize;
    overlap;
    search;
    _analysisHop;
    _tempo = 1.0;
    _inputPos = 0;
    _prevOverlap = null;
    _buffer;
    /**
     * Creates a new time stretch instance.
     * @param options - Configuration options.
     */
    constructor({ sampleRate, channels, frameSize = DEFAULT_FRAME_SIZE, overlap = DEFAULT_OVERLAP, search = DEFAULT_SEARCH }) {
        this.sampleRate = sampleRate;
        this.channels = channels;
        this.frameSize = frameSize;
        this.overlap = Math.min(overlap, frameSize - 1);
        this.search = Math.max(0, Math.floor(search));
        this._analysisHop = this.frameSize - this.overlap;
        this._buffer = new FloatFifoBuffer(channels);
    }
    /**
     * Sets the playback tempo.
     * @param tempo - The tempo factor (e.g., 0.5 for half speed).
     */
    setTempo(tempo) {
        this._tempo = tempo;
    }
    /**
     * Resets the time stretch state.
     */
    reset() {
        this._buffer.clear();
        this._inputPos = 0;
        this._prevOverlap = null;
    }
    destroy() {
        this._buffer.destroy();
        this._prevOverlap = null;
    }
    /**
     * Processes new audio samples.
     * @param samples - The input Float32Array of samples.
     * @returns The time-stretched Float32Array of samples.
     */
    process(samples) {
        if (samples && samples.length > 0) {
            this._buffer.push(samples);
        }
        return this._drain(false);
    }
    /**
     * Flushes any remaining samples in the buffer.
     * @returns The final time-stretched samples.
     */
    flush() {
        const output = this._drain(false);
        const start = this._selectStart(true);
        if (start === null) {
            const chunks = [output];
            if (this._prevOverlap)
                chunks.push(this._prevOverlap);
            const fallback = concatFloat32(chunks);
            this.reset();
            return fallback;
        }
        const segment = this._readSegment(start, true);
        if (!segment) {
            const chunks = [output];
            if (this._prevOverlap)
                chunks.push(this._prevOverlap);
            const fallback = concatFloat32(chunks);
            this.reset();
            return fallback;
        }
        const mixed = this._mixSegment(segment);
        const combined = concatFloat32([output, mixed]);
        this.reset();
        return combined;
    }
    /**
     * Drains processed segments from the buffer.
     * @param allowPartial - Whether to allow partial segments.
     */
    _drain(allowPartial) {
        const outputChunks = [];
        while (true) {
            const start = this._selectStart(allowPartial);
            if (start === null)
                break;
            const segment = this._readSegment(start, allowPartial);
            if (!segment)
                break;
            const mixed = this._mixSegment(segment);
            const emitFrames = allowPartial ? this.frameSize : this._analysisHop;
            outputChunks.push(mixed.subarray(0, emitFrames * this.channels));
            this._advance(start);
            if (allowPartial)
                break;
        }
        return concatFloat32(outputChunks);
    }
    /**
     * Selects the best starting frame for the next segment using correlation.
     * @param allowPartial - Whether to allow partial segments.
     */
    _selectStart(allowPartial) {
        const available = this._buffer.frameCount;
        if (this._prevOverlap === null) {
            if (available < this.frameSize && !allowPartial)
                return null;
            if (available === 0)
                return null;
            return 0;
        }
        const expected = this._inputPos;
        const minStart = Math.max(0, Math.floor(expected - this.search));
        const maxStart = Math.min(Math.floor(expected + this.search), available - this.frameSize);
        if (maxStart < minStart) {
            if (!allowPartial)
                return null;
            return Math.max(0, available - this.frameSize);
        }
        let bestStart = minStart;
        let bestScore = Number.NEGATIVE_INFINITY;
        for (let start = minStart; start <= maxStart; start++) {
            const score = this._correlation(start);
            if (score > bestScore) {
                bestScore = score;
                bestStart = start;
            }
        }
        return bestStart;
    }
    /**
     * Calculates the cross-correlation between the previous overlap and a potential segment.
     * @param startFrame - Potential segment start frame.
     */
    _correlation(startFrame) {
        const overlapSamples = this.overlap * this.channels;
        const base = (this._buffer.startFrame + startFrame) * this.channels;
        const samples = this._buffer.buffer;
        const prev = this._prevOverlap;
        let score = 0;
        if (prev) {
            for (let i = 0; i < overlapSamples; i++) {
                score += (prev[i] ?? 0) * (samples[base + i] ?? 0);
            }
        }
        return score;
    }
    /**
     * Reads a segment of audio from the buffer.
     * @param startFrame - Starting frame index.
     * @param allowPartial - Whether to allow partial segments.
     */
    _readSegment(startFrame, allowPartial) {
        const available = this._buffer.frameCount - startFrame;
        if (available <= 0)
            return null;
        const framesToCopy = Math.min(this.frameSize, available);
        const segment = new Float32Array(this.frameSize * this.channels);
        this._buffer.copyTo(segment, startFrame, framesToCopy);
        if (framesToCopy < this.frameSize && !allowPartial)
            return null;
        return segment;
    }
    /**
     * Mixes the new segment with the previous overlap using a linear blend.
     * @param segment - The new audio segment.
     */
    _mixSegment(segment) {
        const mixed = new Float32Array(segment.length);
        const prev = this._prevOverlap;
        if (!prev) {
            mixed.set(segment);
        }
        else {
            const overlapSamples = this.overlap * this.channels;
            for (let i = 0; i < overlapSamples; i++) {
                const frameIndex = Math.floor(i / this.channels);
                const fadeIn = this.overlap > 1 ? frameIndex / (this.overlap - 1) : 1;
                const fadeOut = 1 - fadeIn;
                mixed[i] = (prev[i] ?? 0) * fadeOut + (segment[i] ?? 0) * fadeIn;
            }
            mixed.set(segment.subarray(overlapSamples), overlapSamples);
        }
        const overlapStart = this._analysisHop * this.channels;
        this._prevOverlap = new Float32Array(this.overlap * this.channels);
        this._prevOverlap.set(mixed.subarray(overlapStart, overlapStart + this._prevOverlap.length));
        return mixed;
    }
    /**
     * Advances the internal input position and discards old buffer data.
     * @param startFrame - The chosen start frame for the segment.
     */
    _advance(startFrame) {
        const inputHop = this._analysisHop * this._tempo;
        this._inputPos = startFrame + inputHop;
        const discard = Math.max(0, Math.floor(this._inputPos) - this.search);
        if (discard > 0) {
            this._buffer.discard(discard);
            this._inputPos -= discard;
        }
    }
}
