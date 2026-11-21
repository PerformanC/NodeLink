import { assertProtectedInternalAudioFormat, createAudioFormat, isLimiterTelemetryActive } from './audioContract.js';
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 4;
const BYTES_PER_FRAME = CHANNELS * BYTES_PER_SAMPLE;
const FIR_PAST_FRAMES = 3;
const FIR_FUTURE_FRAMES = 4;
const FIR_HISTORY_FRAMES = FIR_PAST_FRAMES + FIR_FUTURE_FRAMES;
const FIR_SAFETY_MARGIN_DB = 0.1;
const FIR_OFFSETS = [-3, -2, -1, 0, 1, 2, 3, 4];
const MAX_FLOAT32 = 3.4028234663852886e38;
const makeEmptyMetrics = () => ({
    frames: 0,
    duration_ms: 0,
    peak_gain_reduction_db: 0,
    average_gain_reduction_db: 0,
    applied_gain: 1,
    average_applied_gain: 1,
    true_peak_detected: 0,
    active: false
});
const sinc = (x) => Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
/** Eight-tap Blackman-windowed sinc, normalized for unity DC response. */
const makeFirPhase = (phase) => {
    if (phase === 0)
        return [0, 0, 0, 1, 0, 0, 0, 0];
    const weights = FIR_OFFSETS.map((offset) => {
        const distance = phase - offset;
        const window = Math.abs(distance) >= 4
            ? 0
            : 0.42 +
                0.5 * Math.cos((Math.PI * distance) / 4) +
                0.08 * Math.cos((Math.PI * distance) / 2);
        return sinc(distance) * window;
    });
    const sum = weights.reduce((total, value) => total + value, 0);
    return weights.map((value) => value / sum);
};
const assertFinitePcm = (pcm) => {
    if (!Buffer.isBuffer(pcm))
        throw new TypeError('Limiter input must be a Buffer');
    if (pcm.length % BYTES_PER_FRAME !== 0) {
        throw new RangeError(`Limiter PCM must contain complete ${BYTES_PER_FRAME}-byte stereo frames`);
    }
    for (let offset = 0; offset < pcm.length; offset += BYTES_PER_SAMPLE) {
        if (!Number.isFinite(pcm.readFloatLE(offset))) {
            throw new RangeError(`Limiter input contains a non-finite sample at byte offset ${offset}`);
        }
    }
};
/** Measure stereo PCM using the same FIR true-peak estimate as the limiter. */
export function measureTruePeakF32Stereo(pcm, oversampling = 4) {
    assertFinitePcm(pcm);
    if (oversampling !== 2 && oversampling !== 4) {
        throw new RangeError('oversampling must be 2x or 4x');
    }
    const frameCount = pcm.length / BYTES_PER_FRAME;
    const phases = Array.from({ length: oversampling }, (_, phase) => makeFirPhase(phase / oversampling));
    let peak = 0;
    for (let interval = -FIR_FUTURE_FRAMES; interval < frameCount; interval++) {
        for (const weights of phases) {
            let left = 0;
            let right = 0;
            for (let tap = 0; tap < FIR_OFFSETS.length; tap++) {
                const frame = interval + FIR_OFFSETS[tap];
                if (frame < 0 || frame >= frameCount)
                    continue;
                const offset = frame * BYTES_PER_FRAME;
                left += pcm.readFloatLE(offset) * weights[tap];
                right += pcm.readFloatLE(offset + BYTES_PER_SAMPLE) * weights[tap];
            }
            peak = Math.max(peak, Math.abs(left), Math.abs(right));
        }
    }
    return peak;
}
/**
 * Stateful, isolated Protected-mode limiter. It accepts and emits interleaved
 * Float32 PCM; the production playback pipeline does not instantiate it yet.
 *
 * The detector uses 4x (or 2x) fractional phases of an 8-tap,
 * Blackman-windowed sinc interpolator, normalized for unity DC response. It
 * estimates reconstructed intersample peaks; it is not a sample-peak detector.
 * The FIR has approximately zero-phase alignment and needs 3 preceding plus 4
 * future source frames.
 * Streaming latency is lookaheadFrames + 4 frames (lookahead plus FIR future
 * context), with no Int16 conversion. Its finite, windowed response is an
 * approximation to ideal band-limited reconstruction, not a standards-certified
 * true-peak meter. An internal 0.1 dB guard below the requested ceiling absorbs
 * small interpolation and time-varying-gain errors in this experimental FIR.
 */
export class TruePeakLookaheadLimiter {
    format;
    lookaheadFrames;
    detectorFutureFrames = FIR_FUTURE_FRAMES;
    latencyFrames;
    oversampling;
    ceiling;
    guardedCeiling;
    attackFrames;
    releaseCoefficient;
    phases;
    pending = [];
    history = Array(FIR_HISTORY_FRAMES * CHANNELS).fill(0);
    currentGain = 1;
    closed = false;
    destroyed = false;
    constructor(options = {}) {
        const format = createAudioFormat({
            sampleFormat: options.sampleFormat ?? 'f32le',
            sampleRate: options.sampleRate ?? SAMPLE_RATE,
            channels: options.channels ?? CHANNELS,
            channelLayout: options.channelLayout ?? 'stereo',
            interleaved: options.interleaved ?? true
        });
        assertProtectedInternalAudioFormat(format);
        this.format = format;
        const lookaheadMs = options.lookaheadMs ?? 5;
        const attackMs = options.attackMs ?? 2;
        const releaseMs = options.releaseMs ?? 80;
        const ceilingDbTP = options.ceilingDbTP ?? -1;
        const oversampling = options.oversampling ?? 4;
        if (!Number.isFinite(lookaheadMs) || lookaheadMs < 0) {
            throw new RangeError('lookaheadMs must be finite and nonnegative');
        }
        if (!Number.isFinite(attackMs) || attackMs < 0) {
            throw new RangeError('attackMs must be finite and nonnegative');
        }
        if (!Number.isFinite(releaseMs) || releaseMs <= 0) {
            throw new RangeError('releaseMs must be finite and positive');
        }
        if (!Number.isFinite(ceilingDbTP) || ceilingDbTP > 0) {
            throw new RangeError('ceilingDbTP must be finite and no greater than 0 dBTP');
        }
        if (oversampling !== 2 && oversampling !== 4) {
            throw new RangeError('oversampling must be 2x or 4x');
        }
        this.lookaheadFrames = Math.ceil((lookaheadMs * SAMPLE_RATE) / 1000);
        this.attackFrames = Math.ceil((attackMs * SAMPLE_RATE) / 1000);
        this.releaseCoefficient = Math.exp(-1 / ((releaseMs / 1000) * SAMPLE_RATE));
        this.ceiling = 10 ** (ceilingDbTP / 20);
        this.guardedCeiling = this.ceiling * 10 ** (-FIR_SAFETY_MARGIN_DB / 20);
        this.oversampling = oversampling;
        this.latencyFrames = this.lookaheadFrames + FIR_FUTURE_FRAMES;
        this.phases = Array.from({ length: oversampling }, (_, phase) => makeFirPhase(phase / oversampling));
    }
    process(input) {
        this.assertOpen();
        assertFinitePcm(input);
        const incoming = this.bufferToSamples(input);
        const pendingFrames = this.pending.length / CHANNELS;
        const inputFrames = incoming.length / CHANNELS;
        const combined = [...this.history, ...this.pending, ...incoming];
        const historyFrames = this.history.length / CHANNELS;
        const availableFrames = pendingFrames + inputFrames;
        const outputFrames = Math.max(0, availableFrames - this.lookaheadFrames - FIR_FUTURE_FRAMES);
        const result = this.render(combined, historyFrames, outputFrames);
        const nextPendingStart = historyFrames + outputFrames;
        this.history = combined.slice(Math.max(0, nextPendingStart - FIR_HISTORY_FRAMES) * CHANNELS, nextPendingStart * CHANNELS);
        while (this.history.length < FIR_HISTORY_FRAMES * CHANNELS)
            this.history.unshift(0);
        this.pending = combined.slice(nextPendingStart * CHANNELS);
        return result;
    }
    /** Emit all buffered audio, using zero extension only for detector context. */
    flush() {
        if (this.destroyed || this.closed)
            return { data: Buffer.alloc(0), metrics: makeEmptyMetrics() };
        this.closed = true;
        const pendingFrames = this.pending.length / CHANNELS;
        if (pendingFrames === 0) {
            this.pending = [];
            return { data: Buffer.alloc(0), metrics: makeEmptyMetrics() };
        }
        const historyFrames = this.history.length / CHANNELS;
        const combined = [...this.history, ...this.pending];
        const padded = combined.concat(Array((this.lookaheadFrames + FIR_FUTURE_FRAMES) * CHANNELS).fill(0));
        const result = this.render(padded, historyFrames, pendingFrames);
        this.pending = [];
        this.history = Array(FIR_HISTORY_FRAMES * CHANNELS).fill(0);
        return result;
    }
    /** Clear buffered audio and gain history; the instance becomes usable again. */
    reset() {
        this.pending = [];
        this.history = Array(FIR_HISTORY_FRAMES * CHANNELS).fill(0);
        this.currentGain = 1;
        this.closed = false;
        this.destroyed = false;
    }
    /** Drop all buffered audio without emitting it. */
    destroy() {
        this.pending = [];
        this.history = [];
        this.currentGain = 1;
        this.closed = true;
        this.destroyed = true;
    }
    render(combined, historyFrames, frames) {
        if (frames === 0)
            return { data: Buffer.alloc(0), metrics: makeEmptyMetrics() };
        const output = Buffer.allocUnsafe(frames * BYTES_PER_FRAME);
        const firstInterval = -FIR_FUTURE_FRAMES;
        const lastInterval = frames - 1 + this.lookaheadFrames;
        const intervalPeaks = new Float64Array(lastInterval - firstInterval + 1);
        for (let interval = firstInterval; interval <= lastInterval; interval++) {
            intervalPeaks[interval - firstInterval] = this.measureInterval(combined, historyFrames, interval);
        }
        let peakReduction = 0;
        let reductionSum = 0;
        let gainSum = 0;
        let detectedPeak = 0;
        const maximumDeque = [];
        let dequeHead = 0;
        let nextIntervalToAdd = firstInterval;
        for (let frame = 0; frame < frames; frame++) {
            const windowStart = frame - FIR_FUTURE_FRAMES;
            const windowEnd = frame + this.lookaheadFrames;
            while (nextIntervalToAdd <= windowEnd) {
                const value = intervalPeaks[nextIntervalToAdd - firstInterval];
                while (maximumDeque.length > dequeHead) {
                    const lastIntervalIndex = maximumDeque[maximumDeque.length - 1];
                    if (intervalPeaks[lastIntervalIndex - firstInterval] > value)
                        break;
                    maximumDeque.pop();
                }
                maximumDeque.push(nextIntervalToAdd);
                nextIntervalToAdd++;
            }
            while (maximumDeque.length > dequeHead &&
                maximumDeque[dequeHead] < windowStart) {
                dequeHead++;
            }
            const peakInterval = maximumDeque[dequeHead] ?? frame;
            const peak = intervalPeaks[peakInterval - firstInterval] ?? 0;
            let supportPeak = 0;
            for (let interval = windowStart; interval <= Math.min(frame + FIR_PAST_FRAMES, windowEnd); interval++) {
                supportPeak = Math.max(supportPeak, intervalPeaks[interval - firstInterval] ?? 0);
            }
            const currentPeak = intervalPeaks[frame - firstInterval] ?? 0;
            detectedPeak = Math.max(detectedPeak, currentPeak);
            const target = peak > this.guardedCeiling ? this.guardedCeiling / peak : 1;
            const supportBound = supportPeak > this.guardedCeiling
                ? this.guardedCeiling / supportPeak
                : 1;
            const distanceToPeak = Math.max(0, peakInterval - frame);
            const attackFraction = this.attackFrames === 0
                ? 0
                : Math.min(1, distanceToPeak / this.attackFrames);
            const attackBound = target + (1 - target) * attackFraction;
            const safeBound = Math.min(supportBound, attackBound);
            if (safeBound < this.currentGain) {
                this.currentGain = safeBound;
            }
            else {
                this.currentGain = Math.min(safeBound, safeBound + (this.currentGain - safeBound) * this.releaseCoefficient);
            }
            const reduction = this.currentGain > 0 ? -20 * Math.log10(this.currentGain) : Infinity;
            peakReduction = Math.max(peakReduction, reduction);
            reductionSum += reduction;
            gainSum += this.currentGain;
            const inputOffset = (historyFrames + frame) * CHANNELS;
            const outputOffset = frame * BYTES_PER_FRAME;
            for (let channel = 0; channel < CHANNELS; channel++) {
                const sample = combined[inputOffset + channel] ?? 0;
                const limited = sample * this.currentGain;
                if (!Number.isFinite(limited) || Math.abs(limited) > MAX_FLOAT32) {
                    throw new RangeError(`Limiter output overflow at frame ${frame}`);
                }
                output.writeFloatLE(limited, outputOffset + channel * BYTES_PER_SAMPLE);
            }
        }
        const averageReduction = reductionSum / frames;
        const averageGain = gainSum / frames;
        const metrics = {
            frames,
            duration_ms: (frames / SAMPLE_RATE) * 1000,
            peak_gain_reduction_db: peakReduction,
            average_gain_reduction_db: averageReduction,
            applied_gain: this.currentGain,
            average_applied_gain: averageGain,
            true_peak_detected: detectedPeak,
            active: isLimiterTelemetryActive(peakReduction)
        };
        return { data: output, metrics };
    }
    measureInterval(combined, historyFrames, interval) {
        let peak = 0;
        for (const weights of this.phases) {
            let left = 0;
            let right = 0;
            for (let tap = 0; tap < FIR_OFFSETS.length; tap++) {
                const frame = historyFrames + interval + FIR_OFFSETS[tap];
                const offset = frame * CHANNELS;
                const coefficient = weights[tap];
                left += (combined[offset] ?? 0) * coefficient;
                right += (combined[offset + 1] ?? 0) * coefficient;
            }
            peak = Math.max(peak, Math.abs(left), Math.abs(right));
        }
        return peak;
    }
    bufferToSamples(buffer) {
        const values = new Array(buffer.length / BYTES_PER_SAMPLE);
        for (let offset = 0; offset < buffer.length; offset += BYTES_PER_SAMPLE) {
            values[offset / BYTES_PER_SAMPLE] = buffer.readFloatLE(offset);
        }
        return values;
    }
    assertOpen() {
        if (this.destroyed)
            throw new Error('Limiter has been destroyed; call reset() before reuse');
        if (this.closed)
            throw new Error('Limiter has been flushed; call reset() before reuse');
    }
}
