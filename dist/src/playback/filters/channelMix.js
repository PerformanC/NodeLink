import { SAMPLE_RATE } from '../../constants.js';
import { AnimatableFilter } from './AnimatableFilter.js';
import { clamp16Bit } from './dsp/clamp16Bit.js';
const CHANNELS = 2;
/**
 * Mixes audio channels based on configurable weights.
 * @public
 */
export default class ChannelMix extends AnimatableFilter {
    priority = 10;
    leftToLeft = 1.0;
    leftToRight = 0.0;
    rightToLeft = 0.0;
    rightToRight = 1.0;
    /**
     * Updates the channel weights.
     * @param settings - Filter settings containing `channelMix`.
     */
    update(settings) {
        super.applyAnimatedUpdate(settings, 'channelMix', {
            leftToLeft: 1.0,
            leftToRight: 0.0,
            rightToLeft: 0.0,
            rightToRight: 1.0
        });
    }
    onConfigChanged(config) {
        this.leftToLeft = Math.max(0.0, Math.min(1.0, config.leftToLeft ?? 1.0));
        this.leftToRight = Math.max(0.0, Math.min(1.0, config.leftToRight ?? 0.0));
        this.rightToLeft = Math.max(0.0, Math.min(1.0, config.rightToLeft ?? 0.0));
        this.rightToRight = Math.max(0.0, Math.min(1.0, config.rightToRight ?? 1.0));
    }
    isConfigActive() {
        return (Math.abs(this.leftToLeft - 1.0) > 0.001 ||
            Math.abs(this.leftToRight - 0.0) > 0.001 ||
            Math.abs(this.rightToLeft - 0.0) > 0.001 ||
            Math.abs(this.rightToRight - 1.0) > 0.001);
    }
    /**
     * Processes a PCM audio buffer.
     * @param chunk - PCM audio chunk.
     * @returns The processed PCM audio chunk.
     */
    process(chunk) {
        super.processAnimation(SAMPLE_RATE, chunk.length, CHANNELS);
        if (this.leftToLeft >= 0.999 &&
            this.leftToRight <= 0.001 &&
            this.rightToLeft <= 0.001 &&
            this.rightToRight >= 0.999) {
            return chunk;
        }
        for (let i = 0; i < chunk.length; i += 4) {
            const left = chunk.readInt16LE(i);
            const right = chunk.readInt16LE(i + 2);
            const newLeft = left * this.leftToLeft + right * this.rightToLeft;
            const newRight = left * this.leftToRight + right * this.rightToRight;
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
        return Buffer.alloc(0);
    }
}
