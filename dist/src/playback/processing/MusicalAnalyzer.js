// Copyright (C) 2026 NodeLink.
// This file is part of NodeLink and is protected under the GNU General Public License v3 (GPLv3).
// All parts of this project are protected by this license. See LICENSE for details.
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const FRAME_DURATION_MS = 20;
const FRAME_BYTES = (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * FRAME_DURATION_MS) / 1000;
const MIN_BPM = 60;
const MAX_BPM = 200;
const HISTORY_FRAMES = 1000;
const LOW_BAND_HZ = 150;
const NOTE_NAMES = [
    'C',
    'Db',
    'D',
    'Eb',
    'E',
    'F',
    'Gb',
    'G',
    'Ab',
    'A',
    'Bb',
    'B'
];
const MAJOR_CAMELOT = [
    '8B',
    '3B',
    '10B',
    '5B',
    '12B',
    '7B',
    '2B',
    '9B',
    '4B',
    '11B',
    '6B',
    '1B'
];
const MINOR_CAMELOT = [
    '5A',
    '12A',
    '7A',
    '2A',
    '9A',
    '4A',
    '11A',
    '6A',
    '1A',
    '8A',
    '3A',
    '10A'
];
const MAJOR_PROFILE = [
    6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88
];
const MINOR_PROFILE = [
    6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17
];
function metricalPrior(bpm) {
    if (bpm <= 0)
        return 0;
    const octaves = Math.log2(bpm / 120.0) / 0.7;
    return Math.exp(-0.5 * octaves * octaves);
}
// [AI Notice]: Rhythmic tempo detection, downbeat estimation, and harmonic key profiling
// in this class are part of NodeLink and licensed under GNU GPLv3. See LICENSE.
export class MusicalAnalyzer {
    pending = Buffer.alloc(0);
    onsets = [];
    lowOnsets = [];
    previousRms = 0;
    previousLowRms = 0;
    energy = 0;
    sectionEnergy = 0;
    referenceEnergy = 0;
    impact = 0;
    peak = 0;
    lowEnergy = 0;
    midEnergy = 0;
    highEnergy = 0;
    vocalActivity = 0;
    kWeightedSum = 0;
    kWeightedCount = 0;
    lowFilterLeft = 0;
    lowFilterRight = 0;
    bodyFilterLeft = 0;
    bodyFilterRight = 0;
    totalFrames = 0;
    framesSinceEstimate = 0;
    estimate = null;
    keyEstimate = null;
    chromaAccumulator = new Float32Array(12);
    chromaFilters;
    lowFilterAlpha;
    bodyFilterAlpha;
    constructor(sampleRate = SAMPLE_RATE) {
        const boundedSampleRate = Math.max(8000, sampleRate);
        const analysisSampleRate = boundedSampleRate / 4;
        this.lowFilterAlpha = Math.exp((-2 * Math.PI * LOW_BAND_HZ) / analysisSampleRate);
        this.bodyFilterAlpha = Math.exp((-2 * Math.PI * 2500) / analysisSampleRate);
        this.chromaFilters = Array.from({ length: 12 }, (_, i) => {
            const f = 261.63 * 2 ** (i / 12);
            const w0 = (2 * Math.PI * f) / analysisSampleRate;
            const q = 16;
            const alpha = Math.sin(w0) / (2 * q);
            const a0 = 1 + alpha;
            return {
                b0: alpha / a0,
                b2: -alpha / a0,
                a1: (-2 * Math.cos(w0)) / a0,
                a2: (1 - alpha) / a0,
                x1: 0,
                x2: 0,
                y1: 0,
                y2: 0
            };
        });
    }
    /** Adds decoded PCM to the analyzer. */
    pushPcm(chunk) {
        if (chunk.length === 0)
            return;
        let data = chunk;
        if (this.pending.length > 0) {
            data = Buffer.concat([this.pending, chunk]);
            this.pending = Buffer.alloc(0);
        }
        let offset = 0;
        while (offset + FRAME_BYTES <= data.length) {
            this._pushFrame(data.subarray(offset, offset + FRAME_BYTES));
            offset += FRAME_BYTES;
        }
        if (offset < data.length)
            this.pending = Buffer.from(data.subarray(offset));
    }
    /** Returns the latest musical estimate. */
    getProfile() {
        if (this.onsets.length >= 200 &&
            (!this.estimate || this.framesSinceEstimate >= 50)) {
            this.estimate = this._estimateTempo();
            this.keyEstimate = this._estimateKey();
            this.framesSinceEstimate = 0;
        }
        const meanK = this.kWeightedCount > 0
            ? this.kWeightedSum / this.kWeightedCount
            : this.energy * this.energy;
        const lufs = -0.691 + 10 * Math.log10(Math.max(1e-9, meanK));
        const totalEnergy = this.lowEnergy + this.midEnergy + this.highEnergy;
        const brightness = totalEnergy > 0.001
            ? this.highEnergy / Math.max(0.001, this.lowEnergy + this.midEnergy)
            : 0.25;
        return {
            bpm: this.estimate?.bpm ?? null,
            confidence: this.estimate?.confidence ?? 0,
            phase: this.estimate?.phase ?? 0,
            downbeatPhase: this.estimate?.downbeatPhase ?? 0,
            energy: this.energy,
            transitionConfidence: Math.max(0, Math.min(1, (this.referenceEnergy - this.sectionEnergy) /
                Math.max(0.006, this.referenceEnergy * 0.35))),
            impact: this.impact,
            peak: this.peak,
            bands: {
                low: this.lowEnergy,
                mid: this.midEnergy,
                high: this.highEnergy
            },
            durationMs: this.totalFrames * FRAME_DURATION_MS,
            vocalActivity: Math.round(this.vocalActivity * 100) / 100,
            loudnessLufs: Math.max(-70, Math.min(0, Math.round(lufs * 10) / 10)),
            key: this.keyEstimate?.key ?? null,
            keyConfidence: this.keyEstimate?.confidence ?? 0,
            brightness: Math.round(brightness * 100) / 100
        };
    }
    _pushFrame(frame) {
        let sumSquares = 0;
        let lowSquares = 0;
        let midSquares = 0;
        let highSquares = 0;
        let peakSample = 0;
        let count = 0;
        for (let offset = 0; offset + 3 < frame.length; offset += 16) {
            const left = frame.readInt16LE(offset);
            const right = frame.readInt16LE(offset + 2);
            const mono = (left + right) * 0.5;
            this.lowFilterLeft =
                left + this.lowFilterAlpha * (this.lowFilterLeft - left);
            this.lowFilterRight =
                right + this.lowFilterAlpha * (this.lowFilterRight - right);
            this.bodyFilterLeft =
                left + this.bodyFilterAlpha * (this.bodyFilterLeft - left);
            this.bodyFilterRight =
                right + this.bodyFilterAlpha * (this.bodyFilterRight - right);
            const midLeft = this.bodyFilterLeft - this.lowFilterLeft;
            const midRight = this.bodyFilterRight - this.lowFilterRight;
            const highLeft = left - this.bodyFilterLeft;
            const highRight = right - this.bodyFilterRight;
            const absolute = Math.max(Math.abs(left), Math.abs(right));
            sumSquares += mono * mono;
            lowSquares +=
                (this.lowFilterLeft * this.lowFilterLeft +
                    this.lowFilterRight * this.lowFilterRight) *
                    0.5;
            midSquares += (midLeft * midLeft + midRight * midRight) * 0.5;
            highSquares += (highLeft * highLeft + highRight * highRight) * 0.5;
            if (absolute > peakSample)
                peakSample = absolute;
            const normalizedMono = mono / 32768;
            for (let i = 0; i < 12; i++) {
                const filter = this.chromaFilters[i];
                if (!filter)
                    continue;
                const y = filter.b0 * normalizedMono +
                    filter.b2 * filter.x2 -
                    filter.a1 * filter.y1 -
                    filter.a2 * filter.y2;
                filter.x2 = filter.x1;
                filter.x1 = normalizedMono;
                filter.y2 = filter.y1;
                const current = this.chromaAccumulator[i] ?? 0;
                this.chromaAccumulator[i] = current + y * y;
            }
            count += 1;
        }
        if (count === 0)
            return;
        const rms = Math.sqrt(sumSquares / count) / 32768;
        const lowRms = Math.sqrt(lowSquares / count) / 32768;
        const midRms = Math.sqrt(midSquares / count) / 32768;
        const highRms = Math.sqrt(highSquares / count) / 32768;
        const onset = Math.max(0, rms - this.previousRms);
        this.previousRms = rms;
        const lowOnset = Math.max(0, lowRms - this.previousLowRms);
        this.previousLowRms = lowRms;
        this.energy = this.totalFrames === 0 ? rms : this.energy * 0.92 + rms * 0.08;
        this.sectionEnergy =
            this.totalFrames === 0 ? rms : this.sectionEnergy * 0.99 + rms * 0.01;
        this.referenceEnergy =
            this.totalFrames < 250
                ? (this.referenceEnergy * this.totalFrames + rms) /
                    (this.totalFrames + 1)
                : this.referenceEnergy * 0.999 + rms * 0.001;
        const normalizedImpact = onset / Math.max(0.006, this.referenceEnergy * 0.25);
        this.impact = Math.max(normalizedImpact, this.impact * 0.5);
        this.peak = Math.max(this.peak * 0.998, peakSample / 32768);
        this.lowEnergy =
            this.totalFrames === 0 ? lowRms : this.lowEnergy * 0.92 + lowRms * 0.08;
        this.midEnergy =
            this.totalFrames === 0 ? midRms : this.midEnergy * 0.92 + midRms * 0.08;
        this.highEnergy =
            this.totalFrames === 0 ? highRms : this.highEnergy * 0.92 + highRms * 0.08;
        const totalBandEnergy = lowRms + midRms + highRms;
        const vocalRatio = midRms / Math.max(0.001, totalBandEnergy);
        const isVocalDominant = vocalRatio > 0.46 && midRms > 0.02;
        if (isVocalDominant) {
            this.vocalActivity = Math.min(1, this.vocalActivity * 0.85 + 0.15);
        }
        else {
            this.vocalActivity = Math.max(0, this.vocalActivity * 0.98);
        }
        const kWeight = midSquares * 1.4 + highSquares * 1.1 + lowSquares * 0.5;
        this.kWeightedSum += kWeight / (count * 32768 * 32768);
        this.kWeightedCount += 1;
        this.onsets.push(onset);
        this.lowOnsets.push(lowOnset);
        if (this.onsets.length > HISTORY_FRAMES)
            this.onsets.shift();
        if (this.lowOnsets.length > HISTORY_FRAMES)
            this.lowOnsets.shift();
        this.totalFrames += 1;
        this.framesSinceEstimate += 1;
    }
    _estimateKey() {
        if (this.totalFrames < 100)
            return null;
        let chromaSum = 0;
        for (let i = 0; i < 12; i++) {
            chromaSum += this.chromaAccumulator[i] ?? 0;
        }
        if (chromaSum < 1e-6)
            return null;
        const chroma = new Float32Array(12);
        for (let i = 0; i < 12; i++) {
            chroma[i] = (this.chromaAccumulator[i] ?? 0) / chromaSum;
        }
        let bestScore = -1;
        let bestKey = '';
        let secondScore = -1;
        for (let root = 0; root < 12; root++) {
            let majorCorr = 0;
            for (let i = 0; i < 12; i++) {
                const noteIdx = (root + i) % 12;
                majorCorr += (chroma[noteIdx] ?? 0) * (MAJOR_PROFILE[i] ?? 0);
            }
            const majorKeyName = `${NOTE_NAMES[root]} Major (${MAJOR_CAMELOT[root]})`;
            if (majorCorr > bestScore) {
                secondScore = bestScore;
                bestScore = majorCorr;
                bestKey = majorKeyName;
            }
            else if (majorCorr > secondScore) {
                secondScore = majorCorr;
            }
            let minorCorr = 0;
            for (let i = 0; i < 12; i++) {
                const noteIdx = (root + i) % 12;
                minorCorr += (chroma[noteIdx] ?? 0) * (MINOR_PROFILE[i] ?? 0);
            }
            const minorKeyName = `${NOTE_NAMES[root]} Minor (${MINOR_CAMELOT[root]})`;
            if (minorCorr > bestScore) {
                secondScore = bestScore;
                bestScore = minorCorr;
                bestKey = minorKeyName;
            }
            else if (minorCorr > secondScore) {
                secondScore = minorCorr;
            }
        }
        const separation = Math.max(0, (bestScore - Math.max(0, secondScore)) / Math.max(bestScore, 1e-6));
        const confidence = Math.max(0, Math.min(1, separation * 3.5));
        return {
            key: bestKey,
            confidence: Math.round(confidence * 100) / 100
        };
    }
    _estimateTempo() {
        const onset = this._normalizedOnsets();
        const lowOnset = this._normalizedLowOnsets();
        const framesPerSecond = 1000 / FRAME_DURATION_MS;
        const minimumLag = Math.max(1, Math.round((framesPerSecond * 60) / MAX_BPM));
        const maximumLag = Math.min(onset.length - 2, Math.round((framesPerSecond * 60) / MIN_BPM));
        if (maximumLag <= minimumLag)
            return null;
        const correlations = new Float32Array(maximumLag + 1);
        let correlationMean = 0;
        let correlationCount = 0;
        for (let lag = minimumLag; lag <= maximumLag; lag++) {
            let product = 0;
            let leftPower = 0;
            let rightPower = 0;
            for (let index = lag; index < onset.length; index++) {
                const left = onset[index] ?? 0;
                const right = onset[index - lag] ?? 0;
                product += left * right;
                leftPower += left * left;
                rightPower += right * right;
            }
            const denominator = Math.sqrt(leftPower * rightPower);
            const correlation = denominator > 1e-12 ? product / denominator : 0;
            correlations[lag] = correlation;
            correlationMean += correlation;
            correlationCount += 1;
        }
        correlationMean /= Math.max(1, correlationCount);
        let bestLag = minimumLag;
        let bestScore = -1;
        for (let lag = minimumLag; lag <= maximumLag; lag++) {
            const bpm = (framesPerSecond * 60) / lag;
            const tempoPrior = Math.exp(-(((bpm - 118) / 75) ** 2));
            const doubleLag = lag * 2;
            const doubleLagCorrelation = doubleLag <= maximumLag ? (correlations[doubleLag] ?? 0) : 0;
            const score = (correlations[lag] ?? 0) +
                0.42 * doubleLagCorrelation +
                0.08 * tempoPrior;
            if (score > bestScore) {
                bestScore = score;
                bestLag = lag;
            }
        }
        let bestMetrical = -1;
        let metricalLag = bestLag;
        for (const ratio of [0.5, 1.0, 2.0]) {
            const candidate = Math.round(bestLag * ratio);
            if (candidate < minimumLag || candidate > maximumLag)
                continue;
            const bpm = (framesPerSecond * 60) / candidate;
            const score = (correlations[candidate] ?? 0) * metricalPrior(bpm);
            if (score > bestMetrical) {
                bestMetrical = score;
                metricalLag = candidate;
            }
        }
        bestLag = metricalLag;
        let refinedLag = bestLag;
        if (bestLag > minimumLag && bestLag < maximumLag) {
            const left = correlations[bestLag - 1] ?? 0;
            const center = correlations[bestLag] ?? 0;
            const right = correlations[bestLag + 1] ?? 0;
            const denominator = left - 2 * center + right;
            if (Math.abs(denominator) > 1e-9) {
                refinedLag += Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / denominator));
            }
        }
        let secondScore = -1;
        for (let lag = minimumLag; lag <= maximumLag; lag++) {
            if (Math.abs(lag - bestLag) > 2) {
                const s = correlations[lag] ?? 0;
                if (s > secondScore)
                    secondScore = s;
            }
        }
        if (bestScore < 0.08)
            return null;
        const separation = Math.max(0, (bestScore - Math.max(correlationMean, secondScore)) /
            Math.max(bestScore, 1e-6));
        const confidence = Math.max(0, Math.min(1, bestScore * 0.72 + separation * 0.28));
        const phase = this._estimatePhase(onset, refinedLag);
        const downbeatPhase = this._estimateDownbeatPhase(lowOnset, refinedLag);
        return {
            bpm: Math.round(((framesPerSecond * 60) / refinedLag) * 10) / 10,
            confidence,
            phase,
            downbeatPhase
        };
    }
    _normalizedOnsets() {
        const normalized = new Float32Array(this.onsets.length);
        const meanWindow = 10;
        let rolling = 0;
        for (let index = 0; index < this.onsets.length; index++) {
            const current = this.onsets[index] ?? 0;
            if (index > 0)
                rolling += this.onsets[index - 1] ?? 0;
            if (index > meanWindow)
                rolling -= this.onsets[index - meanWindow - 1] ?? 0;
            const count = Math.min(index, meanWindow);
            const mean = count > 0 ? rolling / count : 0;
            normalized[index] = Math.max(0, current - mean);
        }
        return normalized;
    }
    _normalizedLowOnsets() {
        const normalized = new Float32Array(this.lowOnsets.length);
        const meanWindow = 10;
        let rolling = 0;
        for (let index = 0; index < this.lowOnsets.length; index++) {
            const current = this.lowOnsets[index] ?? 0;
            if (index > 0)
                rolling += this.lowOnsets[index - 1] ?? 0;
            if (index > meanWindow)
                rolling -= this.lowOnsets[index - meanWindow - 1] ?? 0;
            const count = Math.min(index, meanWindow);
            const mean = count > 0 ? rolling / count : 0;
            normalized[index] = Math.max(0, current - mean);
        }
        return normalized;
    }
    _estimatePhase(onsets, lag) {
        let bestPhase = 0;
        let bestScore = -1;
        for (let phase = 0; phase < lag; phase++) {
            let score = 0;
            let weight = 0.35;
            for (let index = phase; index < onsets.length; index += lag) {
                score += (onsets[index] ?? 0) * weight;
                weight = Math.min(1, weight + 0.08);
            }
            if (score > bestScore) {
                bestScore = score;
                bestPhase = phase;
            }
        }
        const current = onsets.length - 1;
        const phaseFrames = (((current - bestPhase) % lag) + lag) % lag;
        return phaseFrames / lag;
    }
    _estimateDownbeatPhase(lowOnsets, lag) {
        const barLag = lag * 4;
        if (barLag <= 0 || lowOnsets.length < barLag)
            return 0;
        let bestOffset = 0;
        let bestScore = -1;
        for (let offset = 0; offset < 4; offset++) {
            let score = 0;
            let count = 0;
            for (let index = Math.round(offset * lag); index < lowOnsets.length; index += Math.round(barLag)) {
                score += lowOnsets[index] ?? 0;
                count += 1;
            }
            const meanScore = count > 0 ? score / count : 0;
            if (meanScore > bestScore) {
                bestScore = meanScore;
                bestOffset = offset;
            }
        }
        const current = lowOnsets.length - 1;
        const phaseFrames = (((current - Math.round(bestOffset * lag)) % barLag) + barLag) % barLag;
        return phaseFrames / barLag;
    }
}
/** Calculates normalized RMS for a PCM interval. */
export function calculatePcmRms(pcm, startByte, lengthBytes) {
    const end = Math.min(pcm.length, startByte + lengthBytes);
    let sumSquares = 0;
    let count = 0;
    for (let offset = startByte; offset + 3 < end; offset += 16) {
        const left = pcm.readInt16LE(offset);
        const right = pcm.readInt16LE(offset + 2);
        sumSquares += (left * left + right * right) * 0.5;
        count += 1;
    }
    return count > 0 ? Math.sqrt(sumSquares / count) / 32768 : 0;
}
/** Calculates integrated perceived LUFS for a PCM interval. */
export function calculatePcmLoudness(pcm, startByte, lengthBytes) {
    const end = Math.min(pcm.length, startByte + lengthBytes);
    let sumSquares = 0;
    let count = 0;
    for (let offset = startByte; offset + 3 < end; offset += 16) {
        const left = pcm.readInt16LE(offset);
        const right = pcm.readInt16LE(offset + 2);
        sumSquares += (left * left + right * right) * 0.5;
        count += 1;
    }
    if (count === 0)
        return -70;
    const rms = Math.sqrt(sumSquares / count) / 32768;
    const lufs = -0.691 + 10 * Math.log10(Math.max(1e-9, rms * rms));
    return Math.max(-70, Math.min(0, Math.round(lufs * 10) / 10));
}
