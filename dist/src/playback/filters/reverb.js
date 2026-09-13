import { SAMPLE_RATE } from '../../constants.js';
import { AnimatableFilter } from './AnimatableFilter.js';
import { clamp16Bit } from './dsp/clamp16Bit.js';
const CHANNELS = 2;
const COMB_DELAYS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS_DELAYS = [556, 441, 341, 225];
const STEREO_SPREAD = 23;
const SCALE_DAMP = 0.4;
const SCALE_ROOM = 0.28;
const OFFSET_ROOM = 0.7;
/**
 * Comb filter component for Freeverb reverb.
 *
 * Uses Float64Array internally so the feedback loop never hard-clips.
 * The old Int16 DelayLine caused audible "8-bit / breaking speaker"
 * distortion when feedback × filterStore + input exceeded ±32767
 * (which happens at feedback > ~0.75 on loud material).
 */
class CombFilter {
    buffer;
    size;
    writeIndex = 0;
    filterStore = 0;
    damp1 = 0;
    damp2 = 0;
    feedback = 0;
    constructor(size) {
        this.size = Math.max(1, size);
        this.buffer = new Float64Array(this.size);
    }
    setDamp(val) {
        this.damp1 = val;
        this.damp2 = 1 - val;
    }
    setFeedback(val) {
        this.feedback = val;
    }
    /**
     * Processes a single sample through the comb feedback loop.
     * No clamping inside the loop — full Float64 precision.
     */
    process(input) {
        const buf = this.buffer;
        if (!buf)
            return 0;
        const output = buf[this.writeIndex] ?? 0;
        this.filterStore = output * this.damp2 + this.filterStore * this.damp1;
        buf[this.writeIndex] = input + this.filterStore * this.feedback;
        this.writeIndex = (this.writeIndex + 1) % this.size;
        return output;
    }
    clear() {
        this.buffer?.fill(0);
        this.filterStore = 0;
        this.writeIndex = 0;
    }
    destroy() {
        this.buffer = null;
        this.filterStore = 0;
    }
}
/**
 * Applies a Freeverb/Schroeder-based reverb effect.
 * Uses alpha for smooth animated transitions.
 * @public
 */
export default class Reverb extends AnimatableFilter {
    priority = 10;
    combFiltersL;
    combFiltersR;
    allpassBuffersL;
    allpassBuffersR;
    allpassWriteL;
    allpassWriteR;
    allpassCoeff = 0.5;
    allpassStateL;
    allpassStateR;
    customCombsL = [];
    customCombsR = [];
    isCustom = false;
    wetLPL = 0;
    wetLPR = 0;
    wetHPAccL = 0;
    wetHPAccR = 0;
    combNorm = 0.12;
    wet = 0;
    dry = 1.0;
    roomSize = 0.5;
    damping = 0.5;
    width = 1.0;
    alpha = 0;
    constructor() {
        super();
        this.combFiltersL = COMB_DELAYS.map((delay) => new CombFilter(Math.floor((delay * SAMPLE_RATE) / 44100)));
        this.combFiltersR = COMB_DELAYS.map((delay) => new CombFilter(Math.floor(((delay + STEREO_SPREAD) * SAMPLE_RATE) / 44100)));
        this.allpassBuffersL = ALLPASS_DELAYS.map((delay) => new Float64Array(Math.max(1, Math.floor((delay * SAMPLE_RATE) / 44100))));
        this.allpassBuffersR = ALLPASS_DELAYS.map((delay) => new Float64Array(Math.max(1, Math.floor(((delay + STEREO_SPREAD) * SAMPLE_RATE) / 44100))));
        this.allpassWriteL = ALLPASS_DELAYS.map(() => 0);
        this.allpassWriteR = ALLPASS_DELAYS.map(() => 0);
        this.allpassStateL = ALLPASS_DELAYS.map(() => 0);
        this.allpassStateR = ALLPASS_DELAYS.map(() => 0);
    }
    /**
     * Updates the reverb settings.
     * @param settings - Filter settings containing `reverb`.
     */
    update(settings) {
        const r = settings?.reverb || {};
        const isDisabled = r._disabled === true;
        const customDelays = r.delays || [];
        const customGains = r.gains || [];
        if (customDelays.length > 0 && customGains.length > 0) {
            this.isCustom = true;
            this.customCombsL = customDelays.map((d, i) => {
                const comb = new CombFilter(Math.floor(d * SAMPLE_RATE));
                comb.setFeedback(Math.min(customGains[i] ?? 0.5, 0.95));
                comb.setDamp(0.4);
                return comb;
            });
            this.customCombsR = customDelays.map((d, i) => {
                const comb = new CombFilter(Math.floor((d + 0.0005) * SAMPLE_RATE));
                comb.setFeedback(Math.min(customGains[i] ?? 0.5, 0.95));
                comb.setDamp(0.4);
                return comb;
            });
        }
        else {
            this.isCustom = false;
        }
        const mix = Math.max(0, Math.min(r.mix ?? 0.5, 1.0));
        this.wet = mix;
        this.dry = 1.0 - mix;
        this.roomSize = Math.max(0, Math.min(r.roomSize ?? 0.5, 1.0));
        const roomScaled = this.roomSize * SCALE_ROOM + OFFSET_ROOM;
        this.damping = Math.max(0, Math.min(r.damping ?? 0.5, 1.0));
        const dampScaled = this.damping * SCALE_DAMP;
        this.width = Math.max(0, Math.min(r.width ?? 1.0, 1.0));
        if (!this.isCustom) {
            for (const comb of [...this.combFiltersL, ...this.combFiltersR]) {
                comb.setFeedback(roomScaled);
                comb.setDamp(dampScaled);
            }
            this.combNorm = 0.12 * Math.max(0.02, 1 - roomScaled);
        }
        else {
            let maxFb = 0.5;
            for (let ci = 0; ci < customGains.length; ci++) {
                maxFb = Math.max(maxFb, Math.min(customGains[ci] ?? 0.5, 0.95));
            }
            const customCombCount = Math.max(1, this.customCombsL.length);
            this.combNorm = (1 / (customCombCount * 0.5)) * Math.max(0.02, 1 - maxFb);
        }
        const isActive = this.wet > 0;
        const targetAlpha = isDisabled ? 0.0 : isActive ? 1.0 : 0.0;
        super.applyAnimatedUpdate({
            reverb: {
                alpha: targetAlpha
            }
        }, 'reverb', { alpha: 0.0 });
    }
    onConfigChanged(config) {
        this.alpha = config.alpha ?? 0;
    }
    isConfigActive(config) {
        const a = config ? config.alpha : this.alpha;
        return (a ?? 0) > 0.001;
    }
    /**
     * Processes a single all-pass stage using Float64Array.
     * No Int16 clamping inside — full precision preserved.
     */
    processAllpass(input, buffer, writeIdx, idx, stateY, stateIdx) {
        const pos = writeIdx[idx] ?? 0;
        const delayed = buffer[pos] ?? 0;
        const output = -input + delayed + this.allpassCoeff * (input - (stateY[stateIdx] ?? 0));
        buffer[pos] = input;
        writeIdx[idx] = (pos + 1) % buffer.length;
        stateY[stateIdx] = output;
        return output;
    }
    /**
     * Processes a PCM audio buffer.
     * @param chunk - PCM audio chunk.
     * @returns The processed PCM audio chunk.
     */
    process(chunk) {
        super.processAnimation(SAMPLE_RATE, chunk.length, CHANNELS);
        if (this.alpha <= 0.001) {
            return chunk;
        }
        const alpha = this.alpha;
        for (let i = 0; i < chunk.length; i += 4) {
            const leftInput = chunk.readInt16LE(i);
            const rightInput = chunk.readInt16LE(i + 2);
            const monoInput = (leftInput + rightInput) * 0.5;
            let leftOut = 0;
            let rightOut = 0;
            if (this.isCustom) {
                for (let j = 0; j < this.customCombsL.length; j++) {
                    const combL = this.customCombsL[j];
                    const combR = this.customCombsR[j];
                    if (combL && combR) {
                        leftOut += combL.process(monoInput);
                        rightOut += combR.process(monoInput);
                    }
                }
                leftOut *= this.combNorm;
                rightOut *= this.combNorm;
            }
            else {
                for (let j = 0; j < this.combFiltersL.length; j++) {
                    const combL = this.combFiltersL[j];
                    const combR = this.combFiltersR[j];
                    if (combL && combR) {
                        leftOut += combL.process(monoInput);
                        rightOut += combR.process(monoInput);
                    }
                }
                for (let j = 0; j < this.allpassBuffersL.length; j++) {
                    const bufL = this.allpassBuffersL[j];
                    const bufR = this.allpassBuffersR[j];
                    if (bufL && bufR) {
                        leftOut = this.processAllpass(leftOut, bufL, this.allpassWriteL, j, this.allpassStateL, j);
                        rightOut = this.processAllpass(rightOut, bufR, this.allpassWriteR, j, this.allpassStateR, j);
                    }
                }
                leftOut *= this.combNorm;
                rightOut *= this.combNorm;
            }
            const INV_SAT = 1 / 32767;
            leftOut = Math.tanh(leftOut * INV_SAT) * 32767;
            rightOut = Math.tanh(rightOut * INV_SAT) * 32767;
            this.wetLPL += 0.2 * (leftOut - this.wetLPL);
            this.wetLPR += 0.2 * (rightOut - this.wetLPR);
            this.wetHPAccL += 0.011 * (this.wetLPL - this.wetHPAccL);
            this.wetHPAccR += 0.011 * (this.wetLPR - this.wetHPAccR);
            const wetFinalL = this.wetLPL - this.wetHPAccL;
            const wetFinalR = this.wetLPR - this.wetHPAccR;
            const wet1 = this.wet * (this.width * 0.5 + 0.5);
            const wet2 = this.wet * ((1.0 - this.width) * 0.5);
            const reverbLeft = leftInput * this.dry + (wetFinalL * wet1 + wetFinalR * wet2);
            const reverbRight = rightInput * this.dry + (wetFinalR * wet1 + wetFinalL * wet2);
            const finalLeft = leftInput + alpha * (reverbLeft - leftInput);
            const finalRight = rightInput + alpha * (reverbRight - rightInput);
            chunk.writeInt16LE(clamp16Bit(finalLeft), i);
            chunk.writeInt16LE(clamp16Bit(finalRight), i + 2);
        }
        return chunk;
    }
    /**
     * Clears the reverb state.
     */
    flush() {
        for (const comb of [
            ...this.combFiltersL,
            ...this.combFiltersR,
            ...this.customCombsL,
            ...this.customCombsR
        ]) {
            comb.clear();
        }
        for (const buf of [...this.allpassBuffersL, ...this.allpassBuffersR]) {
            buf.fill(0);
        }
        this.allpassWriteL.fill(0);
        this.allpassWriteR.fill(0);
        this.allpassStateL.fill(0);
        this.allpassStateR.fill(0);
        this.wetLPL = 0;
        this.wetLPR = 0;
        this.wetHPAccL = 0;
        this.wetHPAccR = 0;
        return Buffer.alloc(0);
    }
    destroy() {
        for (const comb of [
            ...this.combFiltersL,
            ...this.combFiltersR,
            ...this.customCombsL,
            ...this.customCombsR
        ]) {
            comb.destroy();
        }
        this.combFiltersL = [];
        this.combFiltersR = [];
        this.customCombsL = [];
        this.customCombsR = [];
        this.allpassBuffersL = [];
        this.allpassBuffersR = [];
    }
}
