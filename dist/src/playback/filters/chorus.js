import { SAMPLE_RATE } from '../../constants.js';
import { AnimatableFilter } from './AnimatableFilter.js';
import { clamp16Bit } from './dsp/clamp16Bit.js';
import DelayLine from './dsp/delay.js';
import LFO from './dsp/lfo.js';
const CHANNELS = 2;
const MAX_DELAY_MS = 50;
const bufferSize = Math.ceil((SAMPLE_RATE * MAX_DELAY_MS) / 1000);
/**
 * Applies a chorus effect to the audio.
 * Uses alpha for smooth animated transitions.
 * @public
 */
export default class Chorus extends AnimatableFilter {
    priority = 10;
    lfos;
    delays;
    rate = 0;
    depth = 0;
    delay = 25;
    mix = 0.5;
    feedback = 0;
    alpha = 0;
    constructor() {
        super();
        this.lfos = [
            new LFO('SINE'),
            new LFO('SINE'),
            new LFO('SINE'),
            new LFO('SINE')
        ];
        const lfos = this.lfos;
        if (lfos[0])
            lfos[0].phase = 0;
        if (lfos[1])
            lfos[1].phase = Math.PI / 2;
        if (lfos[2])
            lfos[2].phase = Math.PI;
        if (lfos[3])
            lfos[3].phase = (3 * Math.PI) / 2;
        this.delays = [
            new DelayLine(bufferSize),
            new DelayLine(bufferSize),
            new DelayLine(bufferSize),
            new DelayLine(bufferSize)
        ];
    }
    /**
     * Updates the chorus settings.
     * @param settings - Filter settings containing `chorus`.
     */
    update(settings) {
        const c = settings?.chorus || {};
        const isDisabled = c._disabled === true;
        this.rate = c.rate || 0;
        this.depth = Math.max(0, Math.min(c.depth || 0, 1.0));
        this.delay = Math.max(1, Math.min(c.delay || 25, MAX_DELAY_MS - 5));
        this.mix = Math.max(0, Math.min(c.mix ?? 0.5, 1.0));
        this.feedback = Math.max(0, Math.min(c.feedback || 0, 0.95));
        const rate2 = this.rate * 1.1;
        const lfos = this.lfos;
        if (lfos[0])
            lfos[0].update(this.rate, this.depth);
        if (lfos[1])
            lfos[1].update(this.rate, this.depth);
        if (lfos[2])
            lfos[2].update(rate2, this.depth);
        if (lfos[3])
            lfos[3].update(rate2, this.depth);
        const isActive = this.rate > 0 && this.depth > 0 && this.mix > 0;
        const targetAlpha = isDisabled ? 0.0 : isActive ? 1.0 : 0.0;
        super.applyAnimatedUpdate({
            chorus: {
                alpha: targetAlpha,
                transition: c.transition
            }
        }, 'chorus', { alpha: 0.0 });
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
        const delayWidth = this.depth * (SAMPLE_RATE * 0.004);
        const centerDelaySamples = this.delay * (SAMPLE_RATE / 1000);
        const centerDelaySamples2 = centerDelaySamples * 1.2;
        const lfos = this.lfos;
        const delays = this.delays;
        if (!lfos[0] ||
            !lfos[1] ||
            !lfos[2] ||
            !lfos[3] ||
            !delays[0] ||
            !delays[1] ||
            !delays[2] ||
            !delays[3]) {
            return chunk;
        }
        for (let i = 0; i < chunk.length; i += 4) {
            const leftSample = chunk.readInt16LE(i);
            const rightSample = chunk.readInt16LE(i + 2);
            const lfo1L = lfos[0].getValue();
            const lfo1R = lfos[1].getValue();
            const delay1L = centerDelaySamples + lfo1L * delayWidth;
            const delay1R = centerDelaySamples + lfo1R * delayWidth;
            const delayed1L = delays[0].read(delay1L);
            const delayed1R = delays[1].read(delay1R);
            const lfo2L = lfos[2].getValue();
            const lfo2R = lfos[3].getValue();
            const delay2L = centerDelaySamples2 + lfo2L * delayWidth;
            const delay2R = centerDelaySamples2 + lfo2R * delayWidth;
            const delayed2L = delays[2].read(delay2L);
            const delayed2R = delays[3].read(delay2R);
            const wetLeft = (delayed1L + delayed2L) * 0.5;
            const wetRight = (delayed1R + delayed2R) * 0.5;
            const chorusLeft = leftSample * (1 - this.mix) + wetLeft * this.mix;
            const chorusRight = rightSample * (1 - this.mix) + wetRight * this.mix;
            const finalLeft = leftSample + alpha * (chorusLeft - leftSample);
            const finalRight = rightSample + alpha * (chorusRight - rightSample);
            delays[0].write(clamp16Bit(leftSample + delayed1L * this.feedback));
            delays[1].write(clamp16Bit(rightSample + delayed1R * this.feedback));
            delays[2].write(clamp16Bit(leftSample + delayed2L * this.feedback));
            delays[3].write(clamp16Bit(rightSample + delayed2R * this.feedback));
            chunk.writeInt16LE(clamp16Bit(finalLeft), i);
            chunk.writeInt16LE(clamp16Bit(finalRight), i + 2);
        }
        return chunk;
    }
    /**
     * Clears the chorus state.
     */
    flush() {
        for (const delay of this.delays) {
            delay.clear();
        }
        const lfos = this.lfos;
        if (lfos[0])
            lfos[0].phase = 0;
        if (lfos[1])
            lfos[1].phase = Math.PI / 2;
        if (lfos[2])
            lfos[2].phase = Math.PI;
        if (lfos[3])
            lfos[3].phase = (3 * Math.PI) / 2;
        return Buffer.alloc(0);
    }
    destroy() {
        for (const delay of this.delays) {
            delay.destroy();
        }
    }
}
