import { Transform } from 'node:stream';
const WINDOW = 1024;
const HOP = 4800;
const SAMPLE_RATE = 48000;
const frequencies = [125, 250, 500, 1000, 2000, 4000, 8000, 12000];
const coefficients = frequencies.map((hz) => 2 * Math.cos((2 * Math.PI * hz) / SAMPLE_RATE));
const hann = Float64Array.from({ length: WINDOW }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WINDOW - 1)));
/** Observes final stereo s16le PCM. Never mutates or retains full audio chunks. */
export class AudioVisualization extends Transform {
    left = new Float32Array(WINDOW);
    right = new Float32Array(WINDOW);
    carry = Buffer.alloc(4);
    carryLength = 0;
    frame = 0;
    latest = null;
    ingest(l, r) {
        const slot = this.frame % HOP;
        if (slot < WINDOW) {
            this.left[slot] = l / 32768;
            this.right[slot] = r / 32768;
        }
        this.frame++;
        if (slot !== WINDOW - 1)
            return;
        let sumL = 0, sumR = 0, peakL = 0, peakR = 0;
        const waveform = Array(32).fill(0);
        for (let i = 0; i < WINDOW; i++) {
            const l = this.left[i] ?? 0, r = this.right[i] ?? 0;
            sumL += l * l;
            sumR += r * r;
            peakL = Math.max(peakL, Math.abs(l));
            peakR = Math.max(peakR, Math.abs(r));
            const group = Math.floor(i / 32);
            waveform[group] = Math.max(waveform[group] ?? 0, Math.abs(l), Math.abs(r));
        }
        const spectrum = frequencies.map((hz, j) => {
            // Channel-separated probes avoid cancellation of anti-phase material.
            let al = 0, bl = 0, ar = 0, br = 0;
            const coefficient = coefficients[j] ?? 0;
            for (let i = 0; i < WINDOW; i++) {
                const w = hann[i] ?? 0;
                const nl = (this.left[i] ?? 0) * w + coefficient * al - bl;
                const nr = (this.right[i] ?? 0) * w + coefficient * ar - br;
                bl = al;
                al = nl;
                br = ar;
                ar = nr;
            }
            const l = Math.max(0, al * al + bl * bl - coefficient * al * bl);
            const r = Math.max(0, ar * ar + br * br - coefficient * ar * br);
            return { hz, magnitude: (Math.sqrt((l + r) / 2) * 4) / WINDOW };
        });
        this.latest = {
            capturedAt: Date.now(),
            outputFrame: this.frame,
            sampleRate: SAMPLE_RATE,
            rms: [Math.sqrt(sumL / WINDOW), Math.sqrt(sumR / WINDOW)],
            peak: [peakL, peakR],
            waveform,
            spectrum
        };
    }
    _transform(chunk, _encoding, callback) {
        let offset = 0;
        if (this.carryLength) {
            const count = Math.min(4 - this.carryLength, chunk.length);
            chunk.copy(this.carry, this.carryLength, 0, count);
            this.carryLength += count;
            offset = count;
            if (this.carryLength === 4) {
                this.ingest(this.carry.readInt16LE(0), this.carry.readInt16LE(2));
                this.carryLength = 0;
            }
        }
        for (; offset + 4 <= chunk.length; offset += 4)
            this.ingest(chunk.readInt16LE(offset), chunk.readInt16LE(offset + 2));
        if (offset < chunk.length && this.carryLength === 0) {
            chunk.copy(this.carry, 0, offset);
            this.carryLength = chunk.length - offset;
        }
        callback(null, chunk);
    }
    snapshot() {
        return this.latest && Date.now() - this.latest.capturedAt <= 1000
            ? structuredClone(this.latest)
            : null;
    }
}
