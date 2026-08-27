import { SAMPLE_RATE } from '../../constants.js';
import { AnimatableFilter } from './AnimatableFilter.js';
import Allpass from './dsp/allpass.js';
import { clamp16Bit } from './dsp/clamp16Bit.js';
import LFO from './dsp/lfo.js';
const CHANNELS = 2;
const MAX_STAGES = 12;
/**
 * Applies a phaser effect to the audio.
 * Uses alpha for smooth animated transitions.
 * @public
 */
export default class Phaser extends AnimatableFilter {
    priority = 10;
    leftLfo;
    rightLfo;
    stages = 4;
    rate = 0;
    depth = 1.0;
    feedback = 0;
    mix = 0.5;
    minFrequency = 100;
    maxFrequency = 2500;
    alpha = 0;
    leftFilters;
    rightFilters;
    lastLeftFeedback = 0;
    lastRightFeedback = 0;
    constructor() {
        super();
        this.leftLfo = new LFO('SINE');
        this.rightLfo = new LFO('SINE');
        this.rightLfo.phase = Math.PI / 2;
        this.leftFilters = Array.from({ length: MAX_STAGES }, () => new Allpass());
        this.rightFilters = Array.from({ length: MAX_STAGES }, () => new Allpass());
    }
    /**
     * Updates the phaser settings.
     * @param settings - Filter settings containing `phaser`.
     */
    update(settings) {
        const p = settings?.phaser || {};
        const isDisabled = p._disabled === true;
        this.stages = Math.max(2, Math.min(p.stages || 4, MAX_STAGES));
        this.rate = p.rate || 0;
        this.depth = Math.max(0, Math.min(p.depth ?? 1.0, 1.0));
        this.feedback = Math.max(0, Math.min(p.feedback || 0, 0.9));
        this.mix = Math.max(0, Math.min(p.mix ?? 0.5, 1.0));
        this.minFrequency = p.minFrequency || 100;
        this.maxFrequency = p.maxFrequency || 2500;
        this.leftLfo.update(this.rate, this.depth);
        this.rightLfo.update(this.rate, this.depth);
        const isActive = this.rate > 0 && this.depth > 0 && this.mix > 0;
        const targetAlpha = isDisabled ? 0.0 : isActive ? 1.0 : 0.0;
        super.applyAnimatedUpdate({
            phaser: {
                alpha: targetAlpha,
                transition: p.transition
            }
        }, 'phaser', { alpha: 0.0 });
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
        const sweepRange = this.maxFrequency - this.minFrequency;
        for (let i = 0; i < chunk.length; i += 4) {
            const leftSample = chunk.readInt16LE(i);
            const rightSample = chunk.readInt16LE(i + 2);
            const leftLfoValue = (this.leftLfo.getValue() + 1) / 2;
            const rightLfoValue = (this.rightLfo.getValue() + 1) / 2;
            const currentLeftFreq = this.minFrequency + sweepRange * leftLfoValue;
            const currentRightFreq = this.minFrequency + sweepRange * rightLfoValue;
            const tanLeft = Math.tan((Math.PI * currentLeftFreq) / SAMPLE_RATE);
            const a_left = (1 - tanLeft) / (1 + tanLeft);
            const tanRight = Math.tan((Math.PI * currentRightFreq) / SAMPLE_RATE);
            const a_right = (1 - tanRight) / (1 + tanRight);
            let wetLeft = leftSample + this.lastLeftFeedback * this.feedback;
            for (let j = 0; j < this.stages; j++) {
                const filter = this.leftFilters[j];
                if (filter) {
                    filter.setCoefficient(a_left);
                    wetLeft = filter.process(wetLeft);
                }
            }
            this.lastLeftFeedback = wetLeft;
            const phasedLeft = leftSample * (1 - this.mix) + wetLeft * this.mix;
            let wetRight = rightSample + this.lastRightFeedback * this.feedback;
            for (let j = 0; j < this.stages; j++) {
                const filter = this.rightFilters[j];
                if (filter) {
                    filter.setCoefficient(a_right);
                    wetRight = filter.process(wetRight);
                }
            }
            this.lastRightFeedback = wetRight;
            const phasedRight = rightSample * (1 - this.mix) + wetRight * this.mix;
            const finalLeft = leftSample + alpha * (phasedLeft - leftSample);
            const finalRight = rightSample + alpha * (phasedRight - rightSample);
            chunk.writeInt16LE(clamp16Bit(finalLeft), i);
            chunk.writeInt16LE(clamp16Bit(finalRight), i + 2);
        }
        return chunk;
    }
    /**
     * Clears the phaser state.
     */
    flush() {
        for (const filter of [...this.leftFilters, ...this.rightFilters]) {
            filter.x1 = 0;
            filter.y1 = 0;
        }
        this.lastLeftFeedback = 0;
        this.lastRightFeedback = 0;
        this.leftLfo.phase = 0;
        this.rightLfo.phase = Math.PI / 2;
        return Buffer.alloc(0);
    }
}
