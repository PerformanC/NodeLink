import { SAMPLE_RATE } from '../../constants.js';
import { AnimatableFilter } from './AnimatableFilter.js';
import { clamp16Bit } from './dsp/clamp16Bit.js';
import LFO from './dsp/lfo.js';
const CHANNELS = 2;
export default class Tesseract extends AnimatableFilter {
    priority = 11;
    lfoTheta;
    lfoPhi;
    lfoGamma;
    rotationHz = 0;
    alpha = 0;
    delaySamples = Math.floor(SAMPLE_RATE * 0.015);
    delayBufferL = new Int16Array(this.delaySamples);
    delayBufferR = new Int16Array(this.delaySamples);
    delayIndex = 0;
    constructor() {
        super();
        this.lfoTheta = new LFO('SINE');
        this.lfoPhi = new LFO('SINE');
        this.lfoGamma = new LFO('SINE');
    }
    update(settings) {
        const r = settings?.tesseract || {};
        const isDisabled = r._disabled === true;
        this.rotationHz = r.rotationHz ?? 0;
        if (this.rotationHz > 0.001) {
            this.lfoTheta.update(this.rotationHz, 1);
            this.lfoPhi.update(this.rotationHz * 1.33, 1);
            this.lfoGamma.update(this.rotationHz * 0.77, 1);
        }
        const targetAlpha = isDisabled ? 0.0 : this.rotationHz > 0.001 ? 1.0 : 0.0;
        super.applyAnimatedUpdate({ tesseract: { alpha: targetAlpha } }, 'tesseract', { alpha: 0.0 });
    }
    onConfigChanged(config) {
        this.alpha = config.alpha ?? 0;
    }
    isConfigActive(config) {
        const a = config ? config.alpha : this.alpha;
        return (a ?? 0) > 0.001;
    }
    process(chunk) {
        super.processAnimation(SAMPLE_RATE, chunk.length, CHANNELS);
        if (this.alpha <= 0.001) {
            return chunk;
        }
        const alpha = this.alpha;
        for (let i = 0; i < chunk.length; i += 4) {
            const thetaVal = this.lfoTheta.getValue() * Math.PI;
            const phiVal = this.lfoPhi.getValue() * Math.PI;
            const gammaVal = this.lfoGamma.getValue() * Math.PI;
            const sinTheta = Math.sin(thetaVal);
            const cosTheta = Math.cos(thetaVal);
            const sinPhi = Math.sin(phiVal);
            const cosPhi = Math.cos(phiVal);
            const sinGamma = Math.sin(gammaVal);
            const cosGamma = Math.cos(gammaVal);
            const L = chunk.readInt16LE(i);
            const R = chunk.readInt16LE(i + 2);
            const Y = this.delayBufferL[this.delayIndex] ?? 0;
            const Z = this.delayBufferR[this.delayIndex] ?? 0;
            this.delayBufferL[this.delayIndex] = L;
            this.delayBufferR[this.delayIndex] = R;
            this.delayIndex = (this.delayIndex + 1) % this.delaySamples;
            const L_rot = L * cosTheta - Y * sinTheta;
            const R_rot = R * cosPhi - Z * sinPhi;
            const newLeft = L_rot * cosGamma - R_rot * sinGamma;
            const newRight = L_rot * sinGamma + R_rot * cosGamma;
            const finalLeft = L * (1 - alpha) + newLeft * alpha;
            const finalRight = R * (1 - alpha) + newRight * alpha;
            chunk.writeInt16LE(clamp16Bit(finalLeft), i);
            chunk.writeInt16LE(clamp16Bit(finalRight), i + 2);
        }
        return chunk;
    }
    flush() {
        this.lfoTheta.phase = 0;
        this.lfoPhi.phase = 0;
        this.lfoGamma.phase = 0;
        this.delayBufferL.fill(0);
        this.delayBufferR.fill(0);
        this.delayIndex = 0;
        return Buffer.alloc(0);
    }
}
