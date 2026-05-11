import { SAMPLE_RATE } from "../../constants.js";
import { AnimatableFilter } from "./AnimatableFilter.js";
import { Float64DelayLine } from "./dsp/float64Delay.js";
const CHANNELS = 2;
const MAX_DELAY_MS = 2000;
const bufferSize = Math.ceil((SAMPLE_RATE * MAX_DELAY_MS) / 1000);
/**
 * Applies a high-quality echo effect using Float64 delay lines with
 * linear interpolation.
 *
 * Quality improvements over the original Int16 implementation:
 *  1. Float64 feedback path — no quantisation noise accumulation
 *     across feedback taps.  Int16 clipping in the write path caused
 *     audible degradation after ~3-4 repeats; Float64 preserves full
 *     precision (~300 dB dynamic range).
 *  2. Linear interpolation on fractional delay reads — eliminates
 *     one-sample pitch artefacts when delay doesn't land exactly on
 *     an integer sample boundary.
 *  3. Single clamp at final Int16 output write — keeps the internal
 *     mix / feedback arithmetic in full double-precision.
 *
 * Uses alpha for smooth animated transitions.
 * @public
 */
export default class Echo extends AnimatableFilter {
    priority = 10;
    delayLineL;
    delayLineR;
    delay = 0;
    feedback = 0;
    mix = 0;
    alpha = 0;
    constructor() {
        super();
        this.delayLineL = new Float64DelayLine(bufferSize);
        this.delayLineR = new Float64DelayLine(bufferSize);
    }
    /**
     * Updates the echo settings.
     * @param settings - Filter settings containing `echo`.
     */
    update(settings) {
        const e = settings?.echo || {};
        const isDisabled = e._disabled === true;
        this.delay = Math.max(0, Math.min(e.delay || 0, MAX_DELAY_MS));
        this.feedback = Math.max(0, Math.min(e.feedback || 0, 1.0));
        this.mix = Math.max(0, Math.min(e.mix || 0, 1.0));
        const isActive = this.delay > 0 && this.mix > 0;
        const targetAlpha = isDisabled ? 0.0 : isActive ? 1.0 : 0.0;
        super.applyAnimatedUpdate({
            echo: {
                alpha: targetAlpha
            }
        }, 'echo', { alpha: 0.0 });
    }
    onConfigChanged(config) {
        this.alpha = config.alpha ?? 0;
    }
    isConfigActive(config) {
        const a = config ? config.alpha : this.alpha;
        return (a ?? 0) > 0.001;
    }
    /**
     * Processes a PCM audio buffer.
     *
     * The delay lines store and return Float64 values.  Feedback is
     * accumulated in full double-precision — only the final output is
     * clamped to Int16 for the PCM buffer write.
     *
     * @param chunk - PCM audio chunk (interleaved Int16LE stereo).
     * @returns The processed PCM audio chunk.
     */
    process(chunk) {
        super.processAnimation(SAMPLE_RATE, chunk.length, CHANNELS);
        if (this.alpha <= 0.001) {
            return chunk;
        }
        const alpha = this.alpha;
        const delaySamples = (this.delay * SAMPLE_RATE) / 1000;
        const fb = this.feedback;
        const wet = this.mix;
        const dry = 1 - wet;
        for (let i = 0; i < chunk.length; i += 4) {
            const inL = chunk.readInt16LE(i);
            const inR = chunk.readInt16LE(i + 2);
            const delL = this.delayLineL.read(delaySamples);
            const delR = this.delayLineR.read(delaySamples);
            const fbL = inL + delL * fb;
            const fbR = inR + delR * fb;
            this.delayLineL.write(fbL > 65534 ? 65534 : fbL < -65534 ? -65534 : fbL);
            this.delayLineR.write(fbR > 65534 ? 65534 : fbR < -65534 ? -65534 : fbR);
            const echoL = inL * dry + delL * wet;
            const echoR = inR * dry + delR * wet;
            let outL = inL + alpha * (echoL - inL);
            let outR = inR + alpha * (echoR - inR);
            if (outL > 28000 || outL < -28000) {
                const absL = outL < 0 ? -outL : outL;
                const over = (absL - 28000) / 4767;
                outL = (outL < 0 ? -1 : 1) * (28000 + 4767 * (over / (1 + over)));
            }
            if (outR > 28000 || outR < -28000) {
                const absR = outR < 0 ? -outR : outR;
                const over = (absR - 28000) / 4767;
                outR = (outR < 0 ? -1 : 1) * (28000 + 4767 * (over / (1 + over)));
            }
            chunk.writeInt16LE(outL < -32768 ? -32768 : outL > 32767 ? 32767 : (outL + 0.5) | 0, i);
            chunk.writeInt16LE(outR < -32768 ? -32768 : outR > 32767 ? 32767 : (outR + 0.5) | 0, i + 2);
        }
        return chunk;
    }
    /**
     * Flushes any pending data.
     * @returns An empty Buffer.
     */
    flush() {
        this.delayLineL.clear();
        this.delayLineR.clear();
        return Buffer.alloc(0);
    }
    destroy() {
        this.delayLineL.destroy();
        this.delayLineR.destroy();
    }
}
