import { Transform } from 'node:stream';
import { IncrementalAnalysisEngine } from './IncrementalAnalysisEngine.js';
import { MusicalAnalyzer } from './MusicalAnalyzer.js';
const FRAME_BYTES = 3840; // 20 ms at 48 kHz stereo s16le.
const WINDOW_FRAMES = 600; // 12 seconds.
const UPDATE_FRAMES = 200; // 4 seconds.
/** Opt-in bounded output analysis using the node's existing estimators.
 * The clock is the output PCM clock, not the media position of an individual track.
 */
export class MusicAnalysis extends Transform {
    musical = new MusicalAnalyzer();
    temporal = new IncrementalAnalysisEngine({
        maxFeaturePoints: WINDOW_FRAMES
    });
    pending = Buffer.alloc(FRAME_BYTES);
    pendingBytes = 0;
    windowFrames = 0;
    totalFrames = 0;
    latest = null;
    failed = false;
    consume(frame) {
        if (this.windowFrames === WINDOW_FRAMES) {
            this.musical = new MusicalAnalyzer();
            this.temporal.reset();
            this.windowFrames = 0;
        }
        this.musical.pushPcm(frame);
        this.temporal.pushPcm(frame, this.windowFrames * 960);
        this.windowFrames++;
        this.totalFrames++;
        if (this.windowFrames % UPDATE_FRAMES !== 0)
            return;
        const profile = this.musical.getProfile();
        const points = this.temporal.getSnapshot().points;
        const silenceRatio = points.length
            ? points.filter((point) => point.isSilence).length / points.length
            : 1;
        const start = (this.totalFrames - this.windowFrames) * 20;
        const audible = silenceRatio < 0.95;
        this.latest = {
            scope: 'processed-output',
            capturedAt: Date.now(),
            outputWindowStartMs: start,
            outputWindowEndMs: this.totalFrames * 20,
            analyzedMs: this.windowFrames * 20,
            bpm: audible ? profile.bpm : null,
            bpmConfidence: audible ? profile.confidence : 0,
            key: audible ? profile.key : null,
            keyConfidence: audible ? profile.keyConfidence : 0,
            energy: profile.energy,
            estimatedLoudnessLufs: profile.loudnessLufs,
            peak: profile.peak,
            bands: { ...profile.bands },
            vocalActivityEstimate: profile.vocalActivity,
            brightness: profile.brightness,
            beatPositionsMs: points
                .filter((point) => point.beat)
                .slice(0, 128)
                .map((point) => start + point.timestampMs),
            onsetPositionsMs: points
                .filter((point) => point.onset)
                .slice(0, 128)
                .map((point) => start + point.timestampMs),
            silenceRatio
        };
    }
    _transform(chunk, _encoding, callback) {
        if (this.failed) {
            callback(null, chunk);
            return;
        }
        try {
            this.observe(chunk);
        }
        catch (error) {
            this.failed = true;
            this.latest = null;
            this.pendingBytes = 0;
            this.emit('analysisFailure', error);
        }
        callback(null, chunk);
    }
    observe(chunk) {
        let offset = 0;
        while (offset < chunk.length) {
            if (this.pendingBytes === 0 && offset + FRAME_BYTES <= chunk.length) {
                this.consume(chunk.subarray(offset, offset + FRAME_BYTES));
                offset += FRAME_BYTES;
                continue;
            }
            const count = Math.min(FRAME_BYTES - this.pendingBytes, chunk.length - offset);
            chunk.copy(this.pending, this.pendingBytes, offset, offset + count);
            this.pendingBytes += count;
            offset += count;
            if (this.pendingBytes === FRAME_BYTES) {
                this.consume(this.pending);
                this.pendingBytes = 0;
            }
        }
    }
    snapshot() {
        return this.latest && Date.now() - this.latest.capturedAt <= 8000
            ? structuredClone(this.latest)
            : null;
    }
}
