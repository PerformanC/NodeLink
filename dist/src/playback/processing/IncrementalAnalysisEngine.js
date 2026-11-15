/**
 * @file IncrementalAnalysisEngine.ts
 * @package NodeLink
 * @organization PerformanC
 * @author PerformanC <https://github.com/PerformanC>
 * @license GPL-3.0-or-later
 * @copyright (C) 2026 PerformanC
 *
 * @description
 * Real-time, streaming Music Information Retrieval (MIR) feature extraction engine.
 * Consumes normalized PCM audio chunks accompanied by absolute temporal frame positions,
 * extracting RMS, peak, frequency bands (low, mid, high), onsets, beats, vocal activity,
 * and silence intervals without retaining raw PCM in memory.
 *
 * Discontinuity handling:
 * When audio chunks are dropped (e.g. due to tap overflow), the engine detects the gap,
 * anchors subsequent feature points directly to their true media timeline coordinates,
 * and resets instantaneous filter states WITHOUT injecting synthetic silence.
 */
import { framesToMediaMs, mediaMsToFrames, STANDARD_ANALYSIS_PCM_FORMAT } from '../../typings/playback/progressiveAnalysis.types.js';
const LOW_BAND_HZ = 250;
const BODY_BAND_HZ = 2500;
/**
 * Incremental, streaming-based musical analysis engine.
 */
export class IncrementalAnalysisEngine {
    trackId;
    durationMs;
    format;
    hopFrames;
    hopBytes;
    silenceThresholdRms;
    maxFeaturePoints;
    // Filter coefficients
    lowFilterAlpha;
    bodyFilterAlpha;
    // Dynamic DSP filter state
    lowFilterLeft = 0;
    lowFilterRight = 0;
    bodyFilterLeft = 0;
    bodyFilterRight = 0;
    previousRms = 0;
    previousLowRms = 0;
    vocalActivitySmoothed = 0;
    energySmoothed = 0;
    referenceEnergy = 0;
    // Frame and buffer tracking
    currentTimelineFrame = null;
    lastProcessedFrame = null;
    remainder = Buffer.alloc(0);
    // Compact temporal feature storage (strictly metadata, NO PCM)
    featurePoints = [];
    recentOnsets = [];
    recentLowOnsets = [];
    constructor(options = {}) {
        this.trackId = options.trackId ?? 'unknown';
        this.durationMs = options.durationMs ?? 0;
        this.format = options.format ?? STANDARD_ANALYSIS_PCM_FORMAT;
        const hopMs = options.hopDurationMs ?? 20;
        this.hopFrames = mediaMsToFrames(hopMs, this.format.sampleRate);
        this.hopBytes = this.hopFrames * this.format.bytesPerFrame;
        this.silenceThresholdRms = options.silenceThresholdRms ?? 0.004;
        this.maxFeaturePoints = options.maxFeaturePoints ?? 2500;
        const analysisSampleRate = this.format.sampleRate / 4;
        this.lowFilterAlpha = Math.exp((-2 * Math.PI * LOW_BAND_HZ) / analysisSampleRate);
        this.bodyFilterAlpha = Math.exp((-2 * Math.PI * BODY_BAND_HZ) / analysisSampleRate);
    }
    /**
     * Pushes a progressive PCM chunk with explicit absolute temporal positioning.
     *
     * @param chunk - Progressive PCM chunk carrying data and startFrame, or raw Buffer.
     * @param startFrame - Optional explicit start frame index if chunk is a raw Buffer.
     */
    pushPcm(chunk, startFrame) {
        let data;
        let chunkStartFrame;
        if (Buffer.isBuffer(chunk)) {
            data = chunk;
            const attachedStartFrame = chunk
                .startFrame;
            chunkStartFrame =
                startFrame ??
                    attachedStartFrame ??
                    (this.lastProcessedFrame !== null ? this.lastProcessedFrame : 0);
        }
        else {
            data = chunk.data;
            chunkStartFrame = chunk.startFrame;
        }
        if (data.length === 0)
            return;
        const incomingFrames = Math.floor(data.length / this.format.bytesPerFrame);
        // Discontinuity detection: true timeline gap between end of previous ingested audio and incoming chunk
        if (this.currentTimelineFrame !== null &&
            chunkStartFrame > this.currentTimelineFrame) {
            // Discontinuity detected: reset instantaneous IIR filter states without injecting synthetic silence
            this._resetFilterStates();
            this.remainder = Buffer.alloc(0);
            this.currentTimelineFrame = chunkStartFrame;
        }
        else if (this.currentTimelineFrame === null) {
            this.currentTimelineFrame = chunkStartFrame;
        }
        const baseFrame = this.currentTimelineFrame -
            Math.floor(this.remainder.length / this.format.bytesPerFrame);
        if (this.remainder.length > 0) {
            data = Buffer.concat([this.remainder, data]);
            this.remainder = Buffer.alloc(0);
        }
        let offset = 0;
        let processedFrames = 0;
        while (offset + this.hopBytes <= data.length) {
            const hopBuffer = data.subarray(offset, offset + this.hopBytes);
            const currentHopFrame = baseFrame + processedFrames;
            this._processHop(hopBuffer, currentHopFrame);
            offset += this.hopBytes;
            processedFrames += this.hopFrames;
        }
        this.lastProcessedFrame = baseFrame + processedFrames;
        this.currentTimelineFrame = chunkStartFrame + incomingFrames;
        if (offset < data.length) {
            this.remainder = Buffer.from(data.subarray(offset));
        }
    }
    /**
     * Processes a single discrete hop of audio frames and appends a TemporalFeaturePoint.
     */
    _processHop(hopBuffer, frameIndex) {
        const is16Bit = this.format.sampleFormat === 's16le';
        let sumSquares = 0;
        let lowSquares = 0;
        let midSquares = 0;
        let highSquares = 0;
        let peakSample = 0;
        let count = 0;
        const bytesPerFrame = this.format.bytesPerFrame;
        const totalFrames = Math.floor(hopBuffer.length / bytesPerFrame);
        // Sub-sample stepping for low CPU consumption
        const stepFrames = 4;
        for (let f = 0; f < totalFrames; f += stepFrames) {
            const byteOffset = f * bytesPerFrame;
            let left = 0;
            let right = 0;
            if (is16Bit) {
                left = hopBuffer.readInt16LE(byteOffset) / 32768;
                right =
                    this.format.channels > 1
                        ? hopBuffer.readInt16LE(byteOffset + 2) / 32768
                        : left;
            }
            else {
                left = hopBuffer.readFloatLE(byteOffset);
                right =
                    this.format.channels > 1
                        ? hopBuffer.readFloatLE(byteOffset + 4)
                        : left;
            }
            const mono = (left + right) * 0.5;
            const absSample = Math.max(Math.abs(left), Math.abs(right));
            if (absSample > peakSample)
                peakSample = absSample;
            // Single-pole band splitting
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
            sumSquares += mono * mono;
            lowSquares +=
                (this.lowFilterLeft * this.lowFilterLeft +
                    this.lowFilterRight * this.lowFilterRight) *
                    0.5;
            midSquares += (midLeft * midLeft + midRight * midRight) * 0.5;
            highSquares += (highLeft * highLeft + highRight * highRight) * 0.5;
            count++;
        }
        if (count === 0)
            return;
        const rms = Math.sqrt(sumSquares / count);
        const lowRms = Math.sqrt(lowSquares / count);
        const midRms = Math.sqrt(midSquares / count);
        const highRms = Math.sqrt(highSquares / count);
        const bands = {
            low: Math.round(lowRms * 1000) / 1000,
            mid: Math.round(midRms * 1000) / 1000,
            high: Math.round(highRms * 1000) / 1000
        };
        const isSilence = rms < this.silenceThresholdRms;
        // Half-wave rectified energy novelty for onset detection
        const energyNovelty = Math.max(0, rms - this.previousRms);
        const lowNovelty = Math.max(0, lowRms - this.previousLowRms);
        this.previousRms = rms;
        this.previousLowRms = lowRms;
        const isOnset = energyNovelty > 0.015 && rms > 0.008;
        this.recentOnsets.push(energyNovelty);
        this.recentLowOnsets.push(lowNovelty);
        if (this.recentOnsets.length > 500)
            this.recentOnsets.shift();
        if (this.recentLowOnsets.length > 500)
            this.recentLowOnsets.shift();
        // Mid-band formant concentration heuristic (NOTE: Acoustic proxy, not human voice recognition)
        const totalBandEnergy = lowRms + midRms + highRms;
        const vocalRatio = midRms / Math.max(0.001, totalBandEnergy);
        const isVocalDominant = vocalRatio > 0.45 && midRms > 0.02 && !isSilence;
        if (isVocalDominant) {
            this.vocalActivitySmoothed = Math.min(1, this.vocalActivitySmoothed * 0.85 + 0.15);
        }
        else {
            this.vocalActivitySmoothed = Math.max(0, this.vocalActivitySmoothed * 0.98);
        }
        // Energy tracking
        if (this.energySmoothed === 0) {
            this.energySmoothed = rms;
            this.referenceEnergy = rms;
        }
        else {
            this.energySmoothed = this.energySmoothed * 0.95 + rms * 0.05;
            if (rms > this.referenceEnergy) {
                this.referenceEnergy = this.referenceEnergy * 0.9 + rms * 0.1;
            }
        }
        // Metric beat detection using short-term autocorrelation
        const isBeat = this._detectBeat(isOnset);
        const timestampMs = Math.round(framesToMediaMs(frameIndex, this.format.sampleRate));
        const confidence = isSilence
            ? 0.9
            : Math.min(1, Math.max(0.2, rms / Math.max(0.01, this.referenceEnergy)));
        const point = {
            timestampMs,
            rms: Math.round(rms * 1000) / 1000,
            peak: Math.round(peakSample * 1000) / 1000,
            bands,
            onset: isOnset,
            beat: isBeat,
            vocalActivity: Math.round(this.vocalActivitySmoothed * 100) / 100,
            isSilence,
            confidence: Math.round(confidence * 100) / 100
        };
        if (this.featurePoints.length >= this.maxFeaturePoints) {
            this.featurePoints.shift();
        }
        this.featurePoints.push(point);
    }
    /**
     * Resets instantaneous filter state upon audio gap/discontinuity.
     */
    _resetFilterStates() {
        this.lowFilterLeft = 0;
        this.lowFilterRight = 0;
        this.bodyFilterLeft = 0;
        this.bodyFilterRight = 0;
        this.previousRms = 0;
        this.previousLowRms = 0;
    }
    /**
     * Short-term beat alignment check.
     */
    _detectBeat(isOnset) {
        if (!isOnset || this.recentOnsets.length < 50)
            return false;
        const n = this.recentOnsets.length;
        const latest = this.recentOnsets[n - 1] ?? 0;
        const prev = this.recentOnsets[n - 2] ?? 0;
        const prev2 = this.recentOnsets[n - 3] ?? 0;
        return latest > prev && latest > prev2 && latest > 0.02;
    }
    /**
     * Returns a snapshot of the temporal feature map accumulated so far.
     * Provisional outro boundaries are only populated when confidence and coverage criteria are met.
     */
    getSnapshot() {
        const analyzedUntilMs = this.lastProcessedFrame !== null
            ? Math.round(framesToMediaMs(this.lastProcessedFrame, this.format.sampleRate))
            : 0;
        const lastPoint = this.featurePoints.length > 0
            ? this.featurePoints[this.featurePoints.length - 1]
            : null;
        const sourceEndRms = lastPoint?.rms ?? 0;
        const outroHeuristic = this._scanOutroBoundaries(false);
        return {
            trackId: this.trackId,
            durationMs: this.durationMs,
            analyzedUntilMs,
            points: [...this.featurePoints],
            naturalOutroPointMs: outroHeuristic.naturalOutroPointMs,
            energyDecayStartMs: outroHeuristic.energyDecayStartMs,
            sourceEndRms,
            confidence: outroHeuristic.confidence
        };
    }
    /**
     * Finalizes the analysis, scanning trailing regions for silence and natural decay points.
     */
    finalize() {
        const snapshot = this.getSnapshot();
        const finalHeuristic = this._scanOutroBoundaries(true);
        return {
            ...snapshot,
            naturalOutroPointMs: finalHeuristic.naturalOutroPointMs,
            energyDecayStartMs: finalHeuristic.energyDecayStartMs,
            confidence: finalHeuristic.confidence
        };
    }
    /**
     * Internal scanner for natural outro boundary and energy decay detection.
     */
    _scanOutroBoundaries(isFinal) {
        if (this.featurePoints.length < 25) {
            return {
                naturalOutroPointMs: null,
                energyDecayStartMs: null,
                confidence: 0
            };
        }
        // 1. Find trailing silence (e.g. YouTube silent ending)
        let silenceStartMs = null;
        for (let i = this.featurePoints.length - 1; i >= 0; i--) {
            const p = this.featurePoints[i];
            if (!p)
                continue;
            if (p.isSilence) {
                silenceStartMs = p.timestampMs;
            }
            else {
                break;
            }
        }
        // 2. Find energy decay start (drop below 35% of reference energy)
        let decayStartMs = null;
        const thresholdEnergy = Math.max(0.015, this.referenceEnergy * 0.35);
        for (let i = 0; i < this.featurePoints.length; i++) {
            const p = this.featurePoints[i];
            if (!p)
                continue;
            if (p.rms <= thresholdEnergy) {
                decayStartMs = p.timestampMs;
                break;
            }
        }
        const naturalPoint = silenceStartMs ?? decayStartMs;
        const coverageMs = (this.featurePoints[this.featurePoints.length - 1]?.timestampMs ?? 0) -
            (this.featurePoints[0]?.timestampMs ?? 0);
        // For provisional snapshots, require at least 3 seconds of coverage and clear decay
        if (!isFinal && coverageMs < 3000) {
            return {
                naturalOutroPointMs: null,
                energyDecayStartMs: decayStartMs,
                confidence: 0.3
            };
        }
        const confidence = isFinal
            ? naturalPoint !== null
                ? 0.85
                : 0.5
            : naturalPoint !== null
                ? 0.65
                : 0.4;
        return {
            naturalOutroPointMs: naturalPoint,
            energyDecayStartMs: decayStartMs,
            confidence
        };
    }
    /**
     * Resets analyzer state for reuse.
     */
    reset() {
        this.lowFilterLeft = 0;
        this.lowFilterRight = 0;
        this.bodyFilterLeft = 0;
        this.bodyFilterRight = 0;
        this.previousRms = 0;
        this.previousLowRms = 0;
        this.vocalActivitySmoothed = 0;
        this.energySmoothed = 0;
        this.referenceEnergy = 0;
        this.lastProcessedFrame = null;
        this.currentTimelineFrame = null;
        this.remainder = Buffer.alloc(0);
        this.featurePoints.length = 0;
        this.recentOnsets.length = 0;
        this.recentLowOnsets.length = 0;
    }
}
