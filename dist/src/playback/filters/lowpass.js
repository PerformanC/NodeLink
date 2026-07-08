import { SAMPLE_RATE } from '../../constants.js';
import { AnimatableFilter } from './AnimatableFilter.js';
import { clamp16Bit } from './dsp/clamp16Bit.js';
const CHANNELS = 2;
const BUTTERWORTH_Q = Math.SQRT1_2;
const SUB_BLOCK_FRAMES = 64;
const TWO_PI = 2 * Math.PI;
export default class Lowpass extends AnimatableFilter {
    priority = 10;
    s1L = 0;
    s2L = 0;
    s1R = 0;
    s2R = 0;
    b0 = 1;
    b1 = 0;
    b2 = 0;
    a1 = 0;
    a2 = 0;
    _currentLogSmoothing = 0;
    update(settings) {
        const rawConfig = settings.lowpass || {};
        const smoothing = rawConfig.smoothing ?? 0;
        const targetLogSmoothing = smoothing > 1.0 ? Math.log10(smoothing) : 0;
        super.applyAnimatedUpdate({
            lowpass: {
                logSmoothing: targetLogSmoothing
            }
        }, 'lowpass', { logSmoothing: 0 });
    }
    onConfigChanged(config) {
        const logSmoothing = config.logSmoothing ?? 0;
        this._currentLogSmoothing = logSmoothing;
        this._computeCoefficients(logSmoothing);
    }
    isConfigActive(config) {
        const logSmoothing = config ? config.logSmoothing : null;
        if (logSmoothing !== null && logSmoothing !== undefined) {
            return logSmoothing > 0.001;
        }
        return this._currentLogSmoothing > 0.001;
    }
    /**
     * Computes Butterworth biquad coefficients for a given logSmoothing value.
     * Maps logSmoothing to cutoff frequency: cutoff = 20000 / 10^logSmoothing
     * Floor at 60 Hz to prevent extreme sub-bass-only output that sounds
     * like silence/quantization noise (smoothing ≥ ~530 hits the floor).
     */
    _computeCoefficients(logSmoothing) {
        if (logSmoothing <= 0.001) {
            this.b0 = 1;
            this.b1 = 0;
            this.b2 = 0;
            this.a1 = 0;
            this.a2 = 0;
            return;
        }
        const cutoff = Math.max(200, Math.min(23000, 20000 / 10 ** logSmoothing));
        const omega0 = (TWO_PI * cutoff) / SAMPLE_RATE;
        const cos0 = Math.cos(omega0);
        const sin0 = Math.sin(omega0);
        const alpha = sin0 / (2 * BUTTERWORTH_Q);
        const a0inv = 1 / (1 + alpha);
        this.b0 = (1 - cos0) * 0.5 * a0inv;
        this.b1 = (1 - cos0) * a0inv;
        this.b2 = this.b0;
        this.a1 = -2 * cos0 * a0inv;
        this.a2 = (1 - alpha) * a0inv;
    }
    process(chunk) {
        const startLog = this._currentLogSmoothing;
        super.processAnimation(SAMPLE_RATE, chunk.length, CHANNELS);
        const endLog = this._currentLogSmoothing;
        if (startLog <= 0.001 && endLog <= 0.001) {
            this.s1L = this.s2L = this.s1R = this.s2R = 0;
            return chunk;
        }
        const totalFrames = chunk.length >> 2;
        const isAnimating = Math.abs(endLog - startLog) > 0.0001;
        if (!isAnimating) {
            this._computeCoefficients(endLog);
            this._processBlock(chunk, 0, totalFrames);
        }
        else {
            let frameOffset = 0;
            while (frameOffset < totalFrames) {
                const blockFrames = Math.min(SUB_BLOCK_FRAMES, totalFrames - frameOffset);
                const t = (frameOffset + blockFrames * 0.5) / totalFrames;
                const interpolatedLog = startLog + (endLog - startLog) * t;
                this._computeCoefficients(interpolatedLog);
                this._processBlock(chunk, frameOffset, blockFrames);
                frameOffset += blockFrames;
            }
        }
        return chunk;
    }
    /**
     * Processes a sub-block of frames using current biquad coefficients.
     * Direct Form II Transposed — the most numerically stable biquad topology:
     *
     *   y[n] = b0·x[n] + s1
     *   s1   = b1·x[n] − a1·y[n] + s2
     *   s2   = b2·x[n] − a2·y[n]
     *
     * State variables s1/s2 are Float64 (JavaScript number), avoiding the
     * Int16 quantization noise that plagued the old implementation's
     * state feedback.
     */
    _processBlock(chunk, frameOffset, frameCount) {
        const { b0, b1, b2, a1, a2 } = this;
        let { s1L, s2L, s1R, s2R } = this;
        let byteOffset = frameOffset << 2;
        for (let f = 0; f < frameCount; f++, byteOffset += 4) {
            const xL = chunk.readInt16LE(byteOffset);
            const yL = b0 * xL + s1L;
            s1L = b1 * xL - a1 * yL + s2L;
            s2L = b2 * xL - a2 * yL;
            chunk.writeInt16LE(clamp16Bit(yL), byteOffset);
            const xR = chunk.readInt16LE(byteOffset + 2);
            const yR = b0 * xR + s1R;
            s1R = b1 * xR - a1 * yR + s2R;
            s2R = b2 * xR - a2 * yR;
            chunk.writeInt16LE(clamp16Bit(yR), byteOffset + 2);
        }
        this.s1L = s1L;
        this.s2L = s2L;
        this.s1R = s1R;
        this.s2R = s2R;
    }
    flush() {
        this.s1L = this.s2L = this.s1R = this.s2R = 0;
        this._currentLogSmoothing = 0;
        return Buffer.alloc(0);
    }
}
