import { SAMPLE_RATE } from '../../constants.js';
import { AnimatableFilter } from './AnimatableFilter.js';
import { clamp16Bit } from './dsp/clamp16Bit.js';
const CHANNELS = 2;
// biome-ignore lint/style/useExponentiationOperator: <Math.pow is more readable here>
const dbToGain = (db) => Math.pow(10, db / 20);
const gainToDb = (gain) => 20 * Math.log10(Math.max(1e-10, gain));
/**
 * Applies dynamic range compression to audio.
 * Uses alpha for smooth animated transitions.
 * @public
 */
export default class Compressor extends AnimatableFilter {
    priority = 11;
    threshold = -24;
    ratio = 4;
    attack = 0.01;
    release = 0.1;
    makeupGain = 0;
    alpha = 0;
    envelope = 0;
    /**
     * Updates the compressor settings.
     * @param settings - Filter settings containing `compressor`.
     */
    update(settings) {
        const comp = settings?.compressor || {};
        const isDisabled = comp._disabled === true;
        this.threshold = comp.threshold ?? -24;
        this.ratio = Math.max(1, comp.ratio ?? 4);
        this.attack = Math.max(0.001, comp.attack ?? 0.01);
        this.release = Math.max(0.01, comp.release ?? 0.1);
        this.makeupGain = comp.makeupGain ?? 0;
        const targetAlpha = isDisabled ? 0.0 : 1.0;
        super.applyAnimatedUpdate({
            compressor: {
                alpha: targetAlpha,
                transition: comp.transition
            }
        }, 'compressor', { alpha: 0.0 });
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
        const attackCoef = Math.exp(-1 / (this.attack * 44100));
        const releaseCoef = Math.exp(-1 / (this.release * 44100));
        const makeupGain = dbToGain(this.makeupGain);
        for (let i = 0; i < chunk.length; i += 4) {
            const left = chunk.readInt16LE(i) / 32768;
            const right = chunk.readInt16LE(i + 2) / 32768;
            const absSample = Math.max(Math.abs(left), Math.abs(right));
            if (absSample > this.envelope) {
                this.envelope = attackCoef * (this.envelope - absSample) + absSample;
            }
            else {
                this.envelope = releaseCoef * (this.envelope - absSample) + absSample;
            }
            const envelopeDb = gainToDb(this.envelope);
            let reductionDb = 0;
            if (envelopeDb > this.threshold) {
                reductionDb = (this.threshold - envelopeDb) * (1 - 1 / this.ratio);
            }
            const gain = dbToGain(reductionDb) * makeupGain;
            const effectiveGain = 1.0 + alpha * (gain - 1.0);
            chunk.writeInt16LE(clamp16Bit(left * effectiveGain * 32768), i);
            chunk.writeInt16LE(clamp16Bit(right * effectiveGain * 32768), i + 2);
        }
        return chunk;
    }
    /**
     * Flushes any pending data.
     * @returns An empty Buffer.
     */
    flush() {
        this.envelope = 0;
        return Buffer.alloc(0);
    }
}
