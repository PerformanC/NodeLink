import { SAMPLE_RATE } from '../../constants.js';
import { AnimatableFilter } from './AnimatableFilter.js';
import { clamp16Bit } from './dsp/clamp16Bit.js';
const CHANNELS = 2;
const BANDS = [
    25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000,
    16000
];
/**
 * Multi-band biquad equalizer filter.
 * Supports smooth per-band animation.
 * @public
 */
export default class Equalizer extends AnimatableFilter {
    priority = 5;
    bandGains;
    filtersL;
    filtersR;
    constructor() {
        super();
        this.bandGains = new Array(BANDS.length).fill(1.0);
        this.filtersL = BANDS.map((freq) => this._createFilter(freq));
        this.filtersR = BANDS.map((freq) => this._createFilter(freq));
    }
    _createFilter(freq) {
        const omega = (2 * Math.PI * freq) / SAMPLE_RATE;
        const sin = Math.sin(omega);
        const cos = Math.cos(omega);
        const alpha = sin / (2 * 1);
        const a0 = 1 + alpha;
        return {
            b0: alpha / a0,
            b1: 0,
            b2: -alpha / a0,
            a1: (-2 * cos) / a0,
            a2: (1 - alpha) / a0,
            x1: 0,
            x2: 0,
            y1: 0,
            y2: 0
        };
    }
    update(settings) {
        const eq = settings.equalizer || {};
        const bands = eq.bands || [];
        const defaults = {};
        for (let i = 0; i < BANDS.length; i++) {
            defaults[`band_${i}`] = 1.0;
        }
        const mappedConfig = { transition: eq.transition };
        for (const band of bands) {
            if (band.band >= 0 && band.band < BANDS.length) {
                mappedConfig[`band_${band.band}`] = Math.max(0, Math.min(band.gain + 1.0, 2.0));
            }
        }
        super.applyAnimatedUpdate({ equalizer: mappedConfig }, 'equalizer', defaults);
    }
    onConfigChanged(config) {
        for (let i = 0; i < BANDS.length; i++) {
            const val = config[`band_${i}`];
            if (val !== undefined)
                this.bandGains[i] = val;
        }
        for (let i = 0; i < BANDS.length; i++) {
            const freq = BANDS[i];
            const gain = this.bandGains[i];
            const filterL = this.filtersL[i];
            const filterR = this.filtersR[i];
            if (freq === undefined || gain === undefined || !filterL || !filterR)
                continue;
            const omega = (2 * Math.PI * freq) / SAMPLE_RATE;
            const sin = Math.sin(omega);
            const cos = Math.cos(omega);
            const alpha = sin / (2 * 1);
            const A = Math.sqrt(gain);
            const b0 = (1 + alpha * A) / (1 + alpha / A);
            const b1 = (-2 * cos) / (1 + alpha / A);
            const b2 = (1 - alpha * A) / (1 + alpha / A);
            const a1 = (-2 * cos) / (1 + alpha / A);
            const a2 = (1 - alpha / A) / (1 + alpha / A);
            filterL.b0 = b0;
            filterL.b1 = b1;
            filterL.b2 = b2;
            filterL.a1 = a1;
            filterL.a2 = a2;
            filterR.b0 = b0;
            filterR.b1 = b1;
            filterR.b2 = b2;
            filterR.a1 = a1;
            filterR.a2 = a2;
        }
    }
    isConfigActive(config) {
        if (config) {
            for (let i = 0; i < BANDS.length; i++) {
                if (Math.abs((config[`band_${i}`] ?? 1.0) - 1.0) > 0.001)
                    return true;
            }
            return false;
        }
        for (const gain of this.bandGains) {
            if (Math.abs(gain - 1.0) > 0.001)
                return true;
        }
        return false;
    }
    process(chunk) {
        super.processAnimation(SAMPLE_RATE, chunk.length, CHANNELS);
        for (let i = 0; i < chunk.length; i += 4) {
            let left = chunk.readInt16LE(i);
            let right = chunk.readInt16LE(i + 2);
            for (let j = 0; j < BANDS.length; j++) {
                const fl = this.filtersL[j];
                const fr = this.filtersR[j];
                if (!fl || !fr)
                    continue;
                const outL = fl.b0 * left +
                    fl.b1 * fl.x1 +
                    fl.b2 * fl.x2 -
                    fl.a1 * fl.y1 -
                    fl.a2 * fl.y2;
                fl.x2 = fl.x1;
                fl.x1 = left;
                fl.y2 = fl.y1;
                fl.y1 = outL;
                left = outL;
                const outR = fr.b0 * right +
                    fr.b1 * fr.x1 +
                    fr.b2 * fr.x2 -
                    fr.a1 * fr.y1 -
                    fr.a2 * fr.y2;
                fr.x2 = fr.x1;
                fr.x1 = right;
                fr.y2 = fr.y1;
                fr.y1 = outR;
                right = outR;
            }
            chunk.writeInt16LE(clamp16Bit(left), i);
            chunk.writeInt16LE(clamp16Bit(right), i + 2);
        }
        return chunk;
    }
    flush() {
        for (const filter of this.filtersL) {
            filter.x1 = filter.x2 = filter.y1 = filter.y2 = 0;
        }
        for (const filter of this.filtersR) {
            filter.x1 = filter.x2 = filter.y1 = filter.y2 = 0;
        }
        return Buffer.alloc(0);
    }
}
