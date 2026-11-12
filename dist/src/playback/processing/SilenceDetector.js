import { Transform } from 'node:stream';
/**
 * A pass-through Transform that monitors RMS energy of PCM audio.
 * Uses an exponential moving average to avoid false triggers from
 * brief dynamic dips.
 */
export class SilenceDetector extends Transform {
    thresholdLinear;
    _smoothedRms = 0;
    /** EMA smoothing factor (0–1). Lower = smoother. */
    _alpha;
    /** How many consecutive silent chunks we've seen */
    _silentStreak = 0;
    /** Require N consecutive silent reads before reporting silent */
    _silentStreakThreshold;
    sampleFormat;
    bytesPerSample;
    constructor(options = {}) {
        super();
        const thresholdDb = options.thresholdDb ?? -40;
        this.thresholdLinear = 10 ** (thresholdDb / 20);
        this.sampleFormat = options.sampleFormat ?? 's16le';
        this.bytesPerSample = this.sampleFormat === 'f32le' ? 4 : 2;
        // At 48kHz with 20ms Opus frames (960 samples per channel),
        // each chunk represents ~20ms. Alpha = 0.15 gives ~130ms smoothing.
        this._alpha = 0.15;
        // Require ~500ms of continuous silence (25 chunks × 20ms)
        this._silentStreakThreshold = 25;
    }
    getRMS() {
        return this._smoothedRms;
    }
    isSilent() {
        return this._silentStreak >= this._silentStreakThreshold;
    }
    _transform(chunk, _encoding, callback) {
        if (chunk.length === 0) {
            this.push(chunk);
            callback();
            return;
        }
        if (chunk.length % this.bytesPerSample !== 0) {
            callback(new RangeError(`SilenceDetector input is not aligned to ${this.sampleFormat} samples`));
            return;
        }
        const samples = chunk.length / this.bytesPerSample;
        if (samples > 0) {
            let sumSquares = 0;
            for (let i = 0; i < samples; i++) {
                const s = this.sampleFormat === 'f32le'
                    ? chunk.readFloatLE(i * 4)
                    : chunk.readInt16LE(i * 2) / 32768;
                sumSquares += s * s;
            }
            const instantRms = Math.sqrt(sumSquares / samples);
            // Exponential moving average
            this._smoothedRms =
                this._alpha * instantRms + (1 - this._alpha) * this._smoothedRms;
        }
        if (this._smoothedRms <= this.thresholdLinear) {
            this._silentStreak++;
        }
        else {
            this._silentStreak = 0;
        }
        this.push(chunk);
        callback();
    }
}
