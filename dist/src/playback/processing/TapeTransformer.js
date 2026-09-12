import { Buffer } from 'node:buffer';
import { Transform } from 'node:stream';
const SUPPORTED_CURVES = new Set([
    'linear',
    'exponential',
    'sinusoidal'
]);
const DEFAULT_CURVE = 'sinusoidal';
/**
 * Resampling audio transformer that implements tape-like start/stop effects.
 * Uses Cubic Hermite Spline interpolation for high-quality pitch/speed shifting.
 */
export class TapeTransformer extends Transform {
    sampleRate;
    channels;
    currentRate = 1.0;
    tape = null;
    _lastRampCompleted = false;
    inputBuffer = null;
    inputReadPos = 0;
    inputWritePos = 0;
    maxBufferSize;
    constructor(options = {}) {
        super();
        this.sampleRate = options.sampleRate ?? 48000;
        this.channels = options.channels ?? 2;
        this.maxBufferSize = this.sampleRate * this.channels * 10;
    }
    setRate(rate) {
        this.currentRate = Math.max(0.01, Math.min(2.0, rate));
        this.tape = null;
        this._lastRampCompleted = false;
    }
    tapeTo(durationMs, type, curve = DEFAULT_CURVE) {
        const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
        this._lastRampCompleted = false;
        if (duration > 0)
            this._ensureInputBuffer();
        if (type === 'start' && this.inputWritePos > 0) {
            const latencySamples = 1024 * this.channels;
            this.inputReadPos = Math.max(0, this.inputWritePos - latencySamples);
        }
        if (duration === 0) {
            this.currentRate = type === 'start' ? 1.0 : 0.01;
            this.tape = null;
            return;
        }
        this.tape = {
            startRate: this.currentRate,
            targetRate: type === 'start' ? 1.0 : 0.01,
            durationMs: duration,
            elapsedMs: 0,
            curve: (SUPPORTED_CURVES.has(curve)
                ? curve
                : DEFAULT_CURVE)
        };
    }
    isActive() {
        return (this.tape !== null ||
            Math.abs(this.currentRate - 1.0) > 0.001 ||
            this.inputWritePos > this.inputReadPos + this.channels);
    }
    checkRampCompleted() {
        if (this._lastRampCompleted) {
            this._lastRampCompleted = false;
            return true;
        }
        return false;
    }
    getRate() {
        return this.currentRate;
    }
    _ensureInputBuffer() {
        if (!this.inputBuffer) {
            this.inputBuffer = new Float32Array(this.maxBufferSize);
            this.inputReadPos = 0;
            this.inputWritePos = 0;
        }
        return this.inputBuffer;
    }
    _getCurveValue(t, curve) {
        switch (curve) {
            case 'linear':
                return t;
            case 'exponential':
                return t * t;
            case 'sinusoidal':
                return (1 - Math.cos(t * Math.PI)) / 2;
            default:
                return t;
        }
    }
    _transform(chunk, _encoding, callback) {
        if (chunk.length === 0) {
            callback();
            return;
        }
        const output = this.process(chunk);
        this.push(output);
        callback();
    }
    process(chunk) {
        if (chunk.length === 0)
            return chunk;
        if (!this.tape &&
            Math.abs(this.currentRate - 1.0) <= 0.001 &&
            this.inputWritePos <= this.inputReadPos + this.channels) {
            return chunk;
        }
        const incomingSamples = chunk.length / 2;
        const incomingFrames = incomingSamples / this.channels;
        const inputBuffer = this._ensureInputBuffer();
        if (this.inputWritePos + incomingSamples > this.maxBufferSize) {
            this._compact();
            if (this.inputWritePos + incomingSamples > this.maxBufferSize) {
                const samplesToDrop = Math.ceil(incomingSamples / this.channels) * this.channels;
                this.inputReadPos += samplesToDrop;
                this._compact();
            }
        }
        for (let i = 0; i < incomingSamples; i++) {
            inputBuffer[this.inputWritePos++] = chunk.readInt16LE(i * 2) / 32767;
        }
        const outI16 = new Int16Array(incomingSamples);
        const sampleDurationMs = 1000 / this.sampleRate;
        for (let f = 0; f < incomingFrames; f++) {
            if (this.tape) {
                this.tape.elapsedMs += sampleDurationMs;
                const t = Math.min(1.0, this.tape.elapsedMs / this.tape.durationMs);
                const curveT = this._getCurveValue(t, this.tape.curve);
                this.currentRate =
                    this.tape.startRate +
                        (this.tape.targetRate - this.tape.startRate) * curveT;
                if (t >= 1.0) {
                    this.currentRate = this.tape.targetRate;
                    this.tape = null;
                    this._lastRampCompleted = true;
                }
            }
            const iPos = Math.floor(this.inputReadPos / this.channels) * this.channels;
            if (iPos + this.channels * 3 >= this.inputWritePos)
                break;
            const frac = (this.inputReadPos - iPos) / this.channels;
            for (let c = 0; c < this.channels; c++) {
                const p0 = inputBuffer[iPos - this.channels + c] ?? inputBuffer[iPos + c] ?? 0;
                const p1 = inputBuffer[iPos + c] ?? 0;
                const p2 = inputBuffer[iPos + this.channels + c] ?? 0;
                const p3 = inputBuffer[iPos + this.channels * 2 + c] ?? 0;
                const val = 0.5 *
                    (2 * p1 +
                        (-p0 + p2) * frac +
                        (2 * p0 - 5 * p1 + 4 * p2 - p3) * frac * frac +
                        (-p0 + 3 * p1 - 3 * p2 + p3) * frac * frac * frac);
                outI16[f * this.channels + c] = Math.max(-32768, Math.min(32767, Math.round(val * 32767)));
            }
            this.inputReadPos += this.currentRate * this.channels;
        }
        if (this.inputReadPos > this.sampleRate * this.channels * 2) {
            this._compact();
        }
        return Buffer.from(outI16.buffer, outI16.byteOffset, outI16.byteLength);
    }
    _destroy(_err, cb) {
        this.inputBuffer = null;
        this.tape = null;
        cb(null);
    }
    _compact() {
        if (!this.inputBuffer)
            return;
        const integralReadPos = Math.floor(this.inputReadPos / this.channels) * this.channels;
        const fractionalReadPos = this.inputReadPos - integralReadPos;
        if (integralReadPos <= 0)
            return;
        const remaining = this.inputWritePos - integralReadPos;
        if (remaining > 0) {
            this.inputBuffer.copyWithin(0, integralReadPos, this.inputWritePos);
        }
        this.inputReadPos = fractionalReadPos;
        this.inputWritePos = Math.max(0, remaining);
    }
}
