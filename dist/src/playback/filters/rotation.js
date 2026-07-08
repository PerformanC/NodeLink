import { SAMPLE_RATE } from '../../constants.js';
import { AnimatableFilter } from './AnimatableFilter.js';
import { clamp16Bit } from './dsp/clamp16Bit.js';
import LFO from './dsp/lfo.js';
const CHANNELS = 2;
/**
 * Rotates audio between left and right channels at a specific frequency.
 * Uses an alpha property for smooth fade-in/out transitions.
 * @public
 */
export default class Rotation extends AnimatableFilter {
    priority = 10;
    lfo;
    rotationHz = 0;
    alpha = 0;
    constructor() {
        super();
        this.lfo = new LFO('SINE');
    }
    /**
     * Updates the rotation settings.
     * @param settings - Filter settings containing `rotation`.
     */
    update(settings) {
        const r = settings?.rotation || {};
        const isDisabled = r._disabled === true;
        this.rotationHz = r.rotationHz ?? 0;
        if (this.rotationHz > 0.001) {
            this.lfo.update(this.rotationHz, 1);
        }
        const targetAlpha = isDisabled ? 0.0 : this.rotationHz > 0.001 ? 1.0 : 0.0;
        super.applyAnimatedUpdate({
            rotation: {
                alpha: targetAlpha
            }
        }, 'rotation', { alpha: 0.0 });
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
        for (let i = 0; i < chunk.length; i += 4) {
            const lfoValue = this.lfo.getValue();
            const leftFactor = Math.sqrt((1 - lfoValue) / 2);
            const rightFactor = Math.sqrt((1 + lfoValue) / 2);
            const currentLeft = chunk.readInt16LE(i);
            const currentRight = chunk.readInt16LE(i + 2);
            const newLeft = currentLeft * (1 - alpha + alpha * leftFactor);
            const newRight = currentRight * (1 - alpha + alpha * rightFactor);
            chunk.writeInt16LE(clamp16Bit(newLeft), i);
            chunk.writeInt16LE(clamp16Bit(newRight), i + 2);
        }
        return chunk;
    }
    /**
     * Flushes any pending data.
     * @returns An empty Buffer.
     */
    flush() {
        this.lfo.phase = 0;
        return Buffer.alloc(0);
    }
}
