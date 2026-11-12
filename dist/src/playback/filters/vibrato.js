import { SAMPLE_RATE } from '../../constants.js';
import { FLOAT32_HEADROOM_CAPABILITIES } from '../processing/audioContract.js';
import { AnimatableFilter } from './AnimatableFilter.js';
import { clamp16Bit } from './dsp/clamp16Bit.js';
import DelayLine from './dsp/delay.js';
import { Float64DelayLine } from './dsp/float64Delay.js';
import LFO from './dsp/lfo.js';
const CHANNELS = 2;
const MAX_DELAY_MS = 20;
const bufferSize = Math.ceil((SAMPLE_RATE * MAX_DELAY_MS) / 1000);
/**
 * Applies a vibrato effect (pitch modulation) using an LFO.
 * Uses alpha for smooth animated transitions.
 * @public
 */
export default class Vibrato extends AnimatableFilter {
    audioCapabilities = FLOAT32_HEADROOM_CAPABILITIES;
    priority = 10;
    lfo;
    leftDelay;
    rightDelay;
    leftDelayFloat = null;
    rightDelayFloat = null;
    targetFrequency = 0;
    targetDepth = 0;
    alpha = 0;
    constructor() {
        super();
        this.lfo = new LFO('SINE');
        this.leftDelay = new DelayLine(bufferSize);
        this.rightDelay = new DelayLine(bufferSize);
    }
    /**
     * Updates the vibrato settings.
     * @param settings - Filter settings containing `vibrato`.
     */
    update(settings) {
        const v = settings?.vibrato || {};
        const isDisabled = v._disabled === true;
        this.targetFrequency = v.frequency || 0;
        this.targetDepth = Math.max(0, Math.min(v.depth ?? 0, 2.0));
        if (this.targetFrequency > 0 && this.targetDepth > 0) {
            this.lfo.update(this.targetFrequency, this.targetDepth);
        }
        const targetAlpha = isDisabled
            ? 0.0
            : this.targetFrequency > 0 && this.targetDepth > 0
                ? 1.0
                : 0.0;
        super.applyAnimatedUpdate({
            vibrato: {
                alpha: targetAlpha,
                transition: v.transition
            }
        }, 'vibrato', { alpha: 0.0 });
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
     * @param chunk - PCM audio chunk.
     * @returns The processed PCM audio chunk.
     */
    process(chunk) {
        super.processAnimation(SAMPLE_RATE, chunk.length, CHANNELS);
        if (this.alpha <= 0.001) {
            return chunk;
        }
        const alpha = this.alpha;
        const maxDelayWidth = this.lfo.depth * (SAMPLE_RATE * 0.005);
        const centerDelay = maxDelayWidth;
        for (let i = 0; i < chunk.length; i += 4) {
            const lfoValue = this.lfo.getValue();
            const delay = centerDelay + lfoValue * maxDelayWidth;
            const leftSample = chunk.readInt16LE(i);
            this.leftDelay.write(leftSample);
            const delayedLeft = this.leftDelay.read(delay);
            const outLeft = leftSample + alpha * (delayedLeft - leftSample);
            chunk.writeInt16LE(clamp16Bit(outLeft), i);
            const rightSample = chunk.readInt16LE(i + 2);
            this.rightDelay.write(rightSample);
            const delayedRight = this.rightDelay.read(delay);
            const outRight = rightSample + alpha * (delayedRight - rightSample);
            chunk.writeInt16LE(clamp16Bit(outRight), i + 2);
        }
        return chunk;
    }
    processFloat32(chunk) {
        if (chunk.length % 8 !== 0)
            throw new RangeError('Vibrato Float32 input must contain complete stereo frames');
        super.processAnimation(SAMPLE_RATE, chunk.length, CHANNELS, 'f32le');
        if (this.alpha <= 0.001)
            return chunk;
        this.leftDelayFloat ??= new Float64DelayLine(bufferSize);
        this.rightDelayFloat ??= new Float64DelayLine(bufferSize);
        const maxDelayWidth = this.lfo.depth * (SAMPLE_RATE * 0.005);
        for (let i = 0; i < chunk.length; i += 8) {
            const delay = maxDelayWidth + this.lfo.getValue() * maxDelayWidth;
            const left = chunk.readFloatLE(i);
            this.leftDelayFloat.write(left);
            const delayedLeft = this.leftDelayFloat.read(delay);
            chunk.writeFloatLE(left + this.alpha * (delayedLeft - left), i);
            const right = chunk.readFloatLE(i + 4);
            this.rightDelayFloat.write(right);
            const delayedRight = this.rightDelayFloat.read(delay);
            chunk.writeFloatLE(right + this.alpha * (delayedRight - right), i + 4);
        }
        return chunk;
    }
    /**
     * Clears the vibrato state.
     */
    flush() {
        this.leftDelay.clear();
        this.rightDelay.clear();
        this.leftDelayFloat?.clear();
        this.rightDelayFloat?.clear();
        this.lfo.phase = 0;
        return Buffer.alloc(0);
    }
    destroy() {
        this.leftDelay.destroy();
        this.rightDelay.destroy();
        this.leftDelayFloat?.destroy();
        this.rightDelayFloat?.destroy();
    }
}
