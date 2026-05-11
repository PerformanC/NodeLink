import { SAMPLE_RATE } from "../../constants.js";
import { AnimatableFilter } from "./AnimatableFilter.js";
import { clamp16Bit } from "./dsp/clamp16Bit.js";
import DelayLine from "./dsp/delay.js";
import LFO from "./dsp/lfo.js";
const CHANNELS = 2;
const MAX_DELAY_MS = 10;
const bufferSize = Math.ceil((SAMPLE_RATE * MAX_DELAY_MS) / 1000);
/**
 * Applies a flanger effect through LFO-modulated delay.
 * Uses alpha for smooth animated transitions.
 * @public
 */
export default class Flanger extends AnimatableFilter {
    priority = 10;
    lfo;
    delayLine;
    rate = 0;
    depth = 0;
    feedback = 0;
    alpha = 0;
    constructor() {
        super();
        this.lfo = new LFO('SINE');
        this.delayLine = new DelayLine(bufferSize);
    }
    /**
     * Updates the flanger settings.
     * @param settings - Filter settings containing `flanger`.
     */
    update(settings) {
        const f = settings?.flanger || {};
        const isDisabled = f._disabled === true;
        this.rate = f.rate || 0;
        this.depth = Math.max(0, Math.min(f.depth || 0, 1.0));
        this.feedback = Math.max(0, Math.min(f.feedback || 0, 0.95));
        this.lfo.update(this.rate, this.depth);
        const isActive = this.rate > 0 && this.depth > 0;
        const targetAlpha = isDisabled ? 0.0 : isActive ? 1.0 : 0.0;
        super.applyAnimatedUpdate({
            flanger: {
                alpha: targetAlpha
            }
        }, 'flanger', { alpha: 0.0 });
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
        const maxDelayWidth = this.depth * (SAMPLE_RATE * 0.005);
        const centerDelay = maxDelayWidth;
        for (let i = 0; i < chunk.length; i += 2) {
            const sample = chunk.readInt16LE(i);
            const lfoValue = this.lfo.getValue();
            const delay = centerDelay + lfoValue * maxDelayWidth;
            const delayed = this.delayLine.read(delay);
            const input = sample + delayed * this.feedback;
            this.delayLine.write(clamp16Bit(input));
            const flangedOutput = sample + delayed;
            const output = sample + alpha * (flangedOutput - sample);
            chunk.writeInt16LE(clamp16Bit(output), i);
        }
        return chunk;
    }
    /**
     * Flushes any pending data.
     * @returns An empty Buffer.
     */
    flush() {
        this.delayLine.clear();
        this.lfo.phase = 0;
        return Buffer.alloc(0);
    }
    destroy() {
        this.delayLine.destroy();
    }
}
