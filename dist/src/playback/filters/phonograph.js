import { SAMPLE_RATE } from '../../constants.js';
import { AnimatableFilter } from './AnimatableFilter.js';
import { clamp16Bit } from './dsp/clamp16Bit.js';
import LFO from './dsp/lfo.js';
const MAX_DELAY_MS = 60;
const MAX_DELAY_SAMPLES = Math.ceil((SAMPLE_RATE * MAX_DELAY_MS) / 1000);
class XorShift32 {
    s = 0x12345678 | 0;
    constructor(seed = 0xc0ffee) {
        this.s = seed | 0;
    }
    nextU32() {
        let x = this.s | 0;
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        this.s = x | 0;
        return x >>> 0;
    }
    next01() {
        return this.nextU32() / 0x100000000;
    }
    next11() {
        return this.next01() * 2 - 1;
    }
    nextNoise() {
        return (this.next11() + this.next11() + this.next11()) / 3;
    }
}
class InterpDelayLine {
    buf;
    w = 0;
    constructor(size) {
        this.buf = new Float32Array(size);
    }
    clear() {
        this.buf?.fill(0);
        this.w = 0;
    }
    destroy() {
        this.buf = null;
    }
    write(x) {
        const buf = this.buf;
        if (!buf)
            return;
        buf[this.w] = x;
        this.w = (this.w + 1) % buf.length;
    }
    read(delaySamples) {
        const buf = this.buf;
        if (!buf)
            return 0;
        const n = buf.length;
        let r = this.w - delaySamples;
        while (r < 0)
            r += n;
        while (r >= n)
            r -= n;
        const i0 = r | 0;
        const i1 = (i0 + 1) % n;
        const frac = r - i0;
        return (buf[i0] ?? 0) * (1 - frac) + (buf[i1] ?? 0) * frac;
    }
}
class Biquad {
    b0 = 1;
    b1 = 0;
    b2 = 0;
    a1 = 0;
    a2 = 0;
    z1 = 0;
    z2 = 0;
    reset() {
        this.z1 = 0;
        this.z2 = 0;
    }
    setCoeffs(b0, b1, b2, a0, a1, a2) {
        const invA0 = 1 / a0;
        this.b0 = b0 * invA0;
        this.b1 = b1 * invA0;
        this.b2 = b2 * invA0;
        this.a1 = a1 * invA0;
        this.a2 = a2 * invA0;
    }
    process(x) {
        const y = this.b0 * x + this.z1;
        this.z1 = this.b1 * x - this.a1 * y + this.z2;
        this.z2 = this.b2 * x - this.a2 * y;
        return y;
    }
    static lowpass(fc, q, fs, out) {
        const w0 = 2 * Math.PI * (fc / fs);
        const c = Math.cos(w0);
        const s = Math.sin(w0);
        const alpha = s / (2 * q);
        const b0 = (1 - c) / 2;
        const b1 = 1 - c;
        const b2 = (1 - c) / 2;
        const a0 = 1 + alpha;
        const a1 = -2 * c;
        const a2 = 1 - alpha;
        out.setCoeffs(b0, b1, b2, a0, a1, a2);
    }
    static highpass(fc, q, fs, out) {
        const w0 = 2 * Math.PI * (fc / fs);
        const c = Math.cos(w0);
        const s = Math.sin(w0);
        const alpha = s / (2 * q);
        const b0 = (1 + c) / 2;
        const b1 = -(1 + c);
        const b2 = (1 + c) / 2;
        const a0 = 1 + alpha;
        const a1 = -2 * c;
        const a2 = 1 - alpha;
        out.setCoeffs(b0, b1, b2, a0, a1, a2);
    }
    static peaking(fc, q, gainDb, fs, out) {
        const A = 10 ** (gainDb / 40);
        const w0 = 2 * Math.PI * (fc / fs);
        const c = Math.cos(w0);
        const s = Math.sin(w0);
        const alpha = s / (2 * q);
        const b0 = 1 + alpha * A;
        const b1 = -2 * c;
        const b2 = 1 - alpha * A;
        const a0 = 1 + alpha / A;
        const a1 = -2 * c;
        const a2 = 1 - alpha / A;
        out.setCoeffs(b0, b1, b2, a0, a1, a2);
    }
}
function softClip(x) {
    const x2 = x * x;
    return (x * (27 + x2)) / (27 + 9 * x2);
}
/**
 * Advanced simulation of an early 20th-century phonograph.
 * Includes biquad filtering, wow & flutter, early reflections, and mic AGC.
 * @public
 */
export default class Phonograph extends AnimatableFilter {
    priority = 10;
    frequency = 0.8;
    depth = 0.25;
    crackle = 0.18;
    flutter = 0.18;
    room = 0.22;
    micAgc = 0.25;
    drive = 0.25;
    wowLfo = new LFO('SINE');
    flutterLfo = new LFO('SINE');
    drift = 0;
    delay = new InterpDelayLine(MAX_DELAY_SAMPLES);
    hp1 = new Biquad();
    hp2 = new Biquad();
    lp1 = new Biquad();
    lp2 = new Biquad();
    peak1 = new Biquad();
    peak2 = new Biquad();
    hissHp = new Biquad();
    hissLp = new Biquad();
    r1 = new InterpDelayLine(Math.ceil(SAMPLE_RATE * 0.03));
    r2 = new InterpDelayLine(Math.ceil(SAMPLE_RATE * 0.03));
    r3 = new InterpDelayLine(Math.ceil(SAMPLE_RATE * 0.03));
    roomDamp = 0;
    tickEnv = 0;
    tickAmp = 0;
    scratchEnv = 0;
    scratchAmp = 0;
    env = 0;
    agcGain = 1;
    rng = new XorShift32(0x1a2b3c4d);
    constructor() {
        super();
        this.recomputeFilters(1.0);
        this.wowLfo.update(this.frequency, 1);
        this.flutterLfo.update(7.5, 1);
    }
    recomputeFilters(a) {
        const fs = SAMPLE_RATE;
        const q = Math.SQRT1_2;
        const hpFreq = 2 + (260 - 2) * a;
        const lpFreq = 22000 - (22000 - 3300) * a;
        Biquad.highpass(hpFreq, q, fs, this.hp1);
        Biquad.highpass(hpFreq, q, fs, this.hp2);
        Biquad.lowpass(lpFreq, q, fs, this.lp1);
        Biquad.lowpass(lpFreq, q, fs, this.lp2);
        Biquad.peaking(950, 1.1, 7.0 * a, fs, this.peak1);
        Biquad.peaking(2400, 1.6, 3.5 * a, fs, this.peak2);
        Biquad.highpass(1800, q, fs, this.hissHp);
        Biquad.lowpass(6500, q, fs, this.hissLp);
    }
    targetDepth = 0.25;
    targetCrackle = 0.18;
    targetFlutter = 0.18;
    targetRoom = 0.22;
    targetMicAgc = 0.25;
    targetDrive = 0.25;
    alpha = 1.0;
    update(settings) {
        const phono = settings.phonograph || {};
        const isDisabled = phono._disabled === true;
        this.frequency = phono.frequency ?? 0.8;
        this.targetDepth = Math.max(0, Math.min(phono.depth ?? 0.25, 1.0));
        this.targetCrackle = Math.max(0, Math.min(phono.crackle ?? 0.18, 1.0));
        this.targetFlutter = Math.max(0, Math.min(phono.flutter ?? 0.18, 1.0));
        this.targetRoom = Math.max(0, Math.min(phono.room ?? 0.22, 1.0));
        this.targetMicAgc = Math.max(0, Math.min(phono.micAgc ?? 0.25, 1.0));
        this.targetDrive = Math.max(0, Math.min(phono.drive ?? 0.25, 1.0));
        this.wowLfo.update(this.frequency, 1);
        this.flutterLfo.update(4.5, 0.45);
        const targetAlpha = isDisabled ? 0.0 : 1.0;
        super.applyAnimatedUpdate({
            phonograph: {
                alpha: targetAlpha
            }
        }, 'phonograph', { alpha: 0.0 });
    }
    onConfigChanged(config) {
        this.alpha = config.alpha ?? 1.0;
        this.depth = this.targetDepth * this.alpha;
        this.crackle = this.targetCrackle * this.alpha;
        this.flutter = this.targetFlutter * this.alpha;
        this.room = this.targetRoom * this.alpha;
        this.micAgc = this.targetMicAgc * this.alpha;
        this.drive = this.targetDrive * this.alpha;
    }
    isConfigActive(config) {
        const a = config ? config.alpha : this.alpha;
        return (a ?? 1.0) > 0.001;
    }
    process(chunk) {
        super.processAnimation(SAMPLE_RATE, chunk.length, 2);
        if (this.alpha <= 0.001) {
            return chunk;
        }
        this.recomputeFilters(this.alpha);
        const fs = SAMPLE_RATE;
        const wowMax = this.depth * 0.014 * fs;
        const flutterMax = this.flutter * 0.0022 * fs;
        const center = 1 + wowMax + flutterMax;
        const driftAmount = this.depth * 0.0012 * fs;
        const driftSmooth = 0.00015;
        const hissGain = 0.01 * this.crackle;
        const tickRate = 0.00002 * this.crackle;
        const scratchRate = 0.0000025 * this.crackle;
        const d1 = (7.5 / 1000) * fs;
        const d2 = (12.0 / 1000) * fs;
        const d3 = (17.5 / 1000) * fs;
        const roomMix = 0.35 * this.room;
        const agcOn = this.micAgc > 0;
        const target = 0.22;
        const atk = 0.006 + 0.01 * this.micAgc;
        const rel = 0.0006 + 0.0012 * this.micAgc;
        for (let i = 0; i < chunk.length; i += 4) {
            const l = chunk.readInt16LE(i);
            const r = chunk.readInt16LE(i + 2);
            let x = ((l + r) * 0.5) / 32768;
            const dNoise = this.rng.nextNoise();
            this.drift += (dNoise * driftAmount - this.drift) * driftSmooth;
            const wow = this.wowLfo.getValue();
            const flt = this.flutterLfo.getValue();
            let dly = center + wow * wowMax + flt * flutterMax + this.drift;
            if (dly < 1)
                dly = 1;
            if (dly > MAX_DELAY_SAMPLES - 2)
                dly = MAX_DELAY_SAMPLES - 2;
            this.delay.write(x);
            x = this.delay.read(dly);
            if (this.drive > 0) {
                const g = 1 + this.drive * 6.0;
                x = softClip(x * g) / softClip(g);
            }
            x = this.hp1.process(x);
            x = this.hp2.process(x);
            x = this.lp1.process(x);
            x = this.lp2.process(x);
            x = this.peak1.process(x);
            x = this.peak2.process(x);
            if (this.crackle > 0) {
                let n = this.rng.nextNoise();
                n = this.hissHp.process(n);
                n = this.hissLp.process(n);
                x += n * hissGain;
                if (this.rng.next01() < tickRate) {
                    this.tickEnv = 1;
                    this.tickAmp = this.rng.next11() * (0.45 + this.crackle);
                }
                this.tickEnv *= 0.965;
                x += this.tickAmp * this.tickEnv * 0.18;
                if (this.rng.next01() < scratchRate) {
                    this.scratchEnv = 1;
                    this.scratchAmp = this.rng.next11() * (0.35 + this.crackle);
                }
                this.scratchEnv *= 0.992;
                x += this.scratchAmp * this.scratchEnv * 0.06;
            }
            if (this.room > 0) {
                this.roomDamp += 0.08 * (x - this.roomDamp);
                this.r1.write(this.roomDamp);
                this.r2.write(this.roomDamp);
                this.r3.write(this.roomDamp);
                const a = this.r1.read(d1);
                const b = this.r2.read(d2);
                const c = this.r3.read(d3);
                x = x * (1 - roomMix) + (a + b + c) * (roomMix / 3);
            }
            if (agcOn) {
                const ax = Math.abs(x);
                const coeff = ax > this.env ? atk : rel;
                this.env += (ax - this.env) * coeff;
                const desired = target / (this.env + 1e-6);
                this.agcGain += (desired - this.agcGain) * 0.0015;
                const g = Math.max(0.35, Math.min(this.agcGain, 2.8));
                x *= g;
            }
            const out = clamp16Bit((x * 32768) | 0);
            chunk.writeInt16LE(out, i);
            chunk.writeInt16LE(out, i + 2);
        }
        return chunk;
    }
    flush() {
        this.delay.clear();
        this.r1.clear();
        this.r2.clear();
        this.r3.clear();
        this.wowLfo.phase = 0;
        this.flutterLfo.phase = 0;
        this.drift = 0;
        this.hp1.reset();
        this.hp2.reset();
        this.lp1.reset();
        this.lp2.reset();
        this.peak1.reset();
        this.peak2.reset();
        this.hissHp.reset();
        this.hissLp.reset();
        this.tickEnv = 0;
        this.tickAmp = 0;
        this.scratchEnv = 0;
        this.scratchAmp = 0;
        this.roomDamp = 0;
        this.env = 0;
        this.agcGain = 1;
        return Buffer.alloc(0);
    }
    destroy() {
        this.delay.destroy();
        this.r1.destroy();
        this.r2.destroy();
        this.r3.destroy();
    }
}
