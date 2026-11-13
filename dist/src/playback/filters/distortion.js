import { SAMPLE_RATE } from '../../constants.js';
import { AnimatableFilter } from './AnimatableFilter.js';
import { clamp16Bit } from './dsp/clamp16Bit.js';
const CHANNELS = 2;
/**
 * Applies various distortion effects (sin, cos, tan, etc.).
 * Uses alpha for smooth animated transitions.
 * @public
 */
export default class Distortion extends AnimatableFilter {
    priority = 10;
    audioCapabilities = {
        sampleFormats: ['f32le'],
        amplitudeBehavior: 'bounded',
        amplitudeProcessing: 'nonlinear',
        amplitudeBounds: {
            min: -1,
            max: 1,
            method: 'hard-clamp',
            intentional: true
        }
    };
    sinOffset = 0;
    sinScale = 1;
    cosOffset = 0;
    cosScale = 1;
    tanOffset = 0;
    tanScale = 1;
    offset = 0;
    scale = 1;
    alpha = 0;
    /**
     * Updates the distortion settings.
     * @param settings - Filter settings containing `distortion`.
     */
    update(settings) {
        const dist = settings?.distortion || {};
        const isDisabled = dist._disabled === true;
        this.sinOffset = dist.sinOffset ?? 0;
        this.sinScale = dist.sinScale ?? 1;
        this.cosOffset = dist.cosOffset ?? 0;
        this.cosScale = dist.cosScale ?? 1;
        this.tanOffset = dist.tanOffset ?? 0;
        this.tanScale = dist.tanScale ?? 1;
        this.offset = dist.offset ?? 0;
        this.scale = dist.scale ?? 1;
        const isActive = !(this.sinOffset === 0 &&
            this.sinScale === 1 &&
            this.cosOffset === 0 &&
            this.cosScale === 1 &&
            this.tanOffset === 0 &&
            this.tanScale === 1 &&
            this.offset === 0 &&
            this.scale === 1);
        const targetAlpha = isDisabled ? 0.0 : isActive ? 1.0 : 0.0;
        super.applyAnimatedUpdate({
            distortion: {
                alpha: targetAlpha,
                transition: dist.transition
            }
        }, 'distortion', { alpha: 0.0 });
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
        for (let i = 0; i < chunk.length; i += 2) {
            const sample = chunk.readInt16LE(i) / 32768;
            let processed = Math.sin(sample * this.sinScale + this.sinOffset) +
                Math.cos(sample * this.cosScale + this.cosOffset) +
                Math.tan(sample * this.tanScale + this.tanOffset) +
                (sample * this.scale + this.offset);
            processed = Math.max(-1, Math.min(1, processed));
            const out = sample + alpha * (processed - sample);
            chunk.writeInt16LE(clamp16Bit(out * 32768), i);
        }
        return chunk;
    }
    /** Float32 distortion path; its explicit hard clamp is the configured effect. */
    processFloat32(chunk) {
        if (chunk.length % 4 !== 0)
            throw new RangeError('Distortion Float32 input must contain complete samples');
        super.processAnimation(SAMPLE_RATE, chunk.length, CHANNELS, 'f32le');
        if (this.alpha <= 0.001)
            return chunk;
        for (let i = 0; i < chunk.length; i += 4) {
            const sample = chunk.readFloatLE(i);
            let processed = Math.sin(sample * this.sinScale + this.sinOffset) +
                Math.cos(sample * this.cosScale + this.cosOffset) +
                Math.tan(sample * this.tanScale + this.tanOffset) +
                sample * this.scale +
                this.offset;
            processed = Math.max(-1, Math.min(1, processed));
            chunk.writeFloatLE(sample + this.alpha * (processed - sample), i);
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
