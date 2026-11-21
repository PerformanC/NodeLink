import { Transform } from 'node:stream';
import { Float32AudioMixer } from './Float32AudioMixer.js';
import { int16PcmToFloat32Pcm } from './float32Pcm.js';
const FRAME_SIZE = 3840;
const EMPTY_BUFFER = Buffer.alloc(0);
const PROTECTED_FRAME_SIZE = FRAME_SIZE * 2;
/**
 * Controller that coordinates filters, volume, fading, scratching, and mixing in a single stream.
 * @public
 */
export class FlowController extends Transform {
    volume;
    fade;
    tape;
    scratch;
    audioMixer;
    pendingBuffer;
    pendingLength;
    processingMode;
    frameSize;
    float32Mixer;
    /**
     * Creates a new FlowController.
     * @param volume - The VolumeTransformer instance.
     * @param fade - The FadeTransformer instance.
     * @param tape - The TapeTransformer instance.
     * @param scratch - The ScratchTransformer instance.
     * @param audioMixer - Optional AudioMixer instance.
     */
    constructor(volume, fade, tape, scratch, audioMixer = null, processingMode = 'legacy') {
        super({
            highWaterMark: (processingMode === 'protected' ? PROTECTED_FRAME_SIZE : FRAME_SIZE) * 4
        });
        this.volume = volume;
        this.fade = fade;
        this.tape = tape;
        this.scratch = scratch;
        this.audioMixer = audioMixer;
        this.processingMode = processingMode;
        this.frameSize =
            processingMode === 'protected' ? PROTECTED_FRAME_SIZE : FRAME_SIZE;
        this.float32Mixer =
            processingMode === 'protected' ? new Float32AudioMixer() : null;
        this.pendingBuffer = Buffer.allocUnsafe(this.frameSize);
        this.pendingLength = 0;
    }
    _processFrame(frame) {
        let output = frame;
        if (this.processingMode === 'protected') {
            const tapeFloat = this.tape.processFloat32;
            const scratchFloat = this.scratch.processFloat32;
            if (this.tape.isActive() && !tapeFloat)
                throw new Error('TapeTransformer does not support Protected Float32 processing');
            if (this.scratch.isActive() && !scratchFloat)
                throw new Error('ScratchTransformer does not support Protected Float32 processing');
            output = tapeFloat ? tapeFloat.call(this.tape, output) : output;
            output = scratchFloat ? scratchFloat.call(this.scratch, output) : output;
            const volumeFloat = this.volume.processFloat32;
            const fadeFloat = this.fade.processFloat32;
            if (!volumeFloat || !fadeFloat)
                throw new Error('Protected flow component lacks Float32 support');
            output = volumeFloat.call(this.volume, output);
            output = fadeFloat.call(this.fade, output);
            output = this._mixProtected(output);
            this.push(output);
            return;
        }
        output = this.tape.process(output);
        output = this.scratch.process(output);
        output = this.volume.process(output);
        output = this.fade.process(output);
        if (this.audioMixer &&
            this.audioMixer.enabled !== false &&
            this.audioMixer.hasActiveLayers()) {
            try {
                const layerChunks = this.audioMixer.readLayerChunks(output.length);
                output = this.audioMixer.mixBuffers(output, layerChunks);
            }
            catch (_error) { }
        }
        this.push(output);
    }
    _mixProtected(output) {
        if (!this.audioMixer || this.audioMixer.enabled === false)
            return output;
        const layerChunks = this.audioMixer.readLayerChunksAligned(output.length / 8);
        if (layerChunks.size === 0)
            return output;
        const format = this.float32Mixer.format;
        const sources = [{ data: output, gain: 1, format }];
        for (const layer of layerChunks.values()) {
            sources.push({
                data: int16PcmToFloat32Pcm(layer.buffer),
                gain: layer.volume,
                format
            });
        }
        return this.float32Mixer.mix(sources);
    }
    /**
     * Sets the volume gain.
     * @param volume - New volume level.
     */
    setVolume(volume) {
        this.volume.setVolume(volume);
    }
    /**
     * Calculates the combined playback rate of internal effects (tape, scratch).
     */
    getEffectiveRate() {
        return this.tape.getRate() * this.scratch.getRate();
    }
    /**
     * Sets the fade gain immediately.
     * @param volume - New fade volume.
     */
    setFadeVolume(volume) {
        this.fade.setGain(volume);
    }
    /**
     * Schedules a fade effect.
     * @param volume - Target volume.
     * @param durationMs - Duration of the fade in milliseconds.
     * @param curve - Fading curve type.
     */
    fadeTo(volume, durationMs, curve) {
        this.fade.fadeTo(volume, durationMs, curve);
    }
    /**
     * Schedules a tape effect.
     * @param durationMs - Duration of the ramp in milliseconds.
     * @param type - Ramp type ('start' or 'stop').
     * @param curve - Fading curve type.
     */
    tapeTo(durationMs, type, curve) {
        if (this.processingMode === 'protected' &&
            !('processFloat32' in this.tape)) {
            throw new Error('Tape effects are not available in Protected mode until Float32 resampling is supported');
        }
        this.tape.tapeTo(durationMs, type, curve);
    }
    /**
     * Schedules a scratch effect.
     * @param durationMs - Duration of the scratch movement.
     * @param style - The style of scratch to apply.
     */
    scratchTo(durationMs, style) {
        if (this.processingMode === 'protected' &&
            !('processFloat32' in this.scratch)) {
            throw new Error('Scratch effects are not available in Protected mode until Float32 resampling is supported');
        }
        this.scratch.scratchTo(durationMs, style);
    }
    checkTapeRampCompleted() {
        return this.tape.checkRampCompleted();
    }
    checkScratchEffectCompleted() {
        return this.scratch.checkEffectCompleted();
    }
    setLoudnessNormalizer(enabled) {
        if ('setAGCEnabled' in this.volume) {
            ;
            this.volume.setAGCEnabled?.(enabled);
        }
    }
    /**
     * Updates filters in the pipeline via the FlowController.
     * Note: FlowController currently doesn't manage filters itself,
     * this is a no-op placeholder to match the expected interface.
     * @param _filters - The filter settings.
     */
    setFilters(_filters) {
        // This exists to satisfy streamProcessor's type check and avoid 'as any'
    }
    _transform(chunk, _encoding, callback) {
        if (!this.pendingBuffer) {
            callback();
            return;
        }
        let offset = 0;
        if (this.pendingLength > 0) {
            const needed = this.frameSize - this.pendingLength;
            const toCopy = Math.min(needed, chunk.length);
            chunk.copy(this.pendingBuffer, this.pendingLength, 0, toCopy);
            this.pendingLength += toCopy;
            offset += toCopy;
            if (this.pendingLength === this.frameSize) {
                this._processFrame(this.pendingBuffer);
                this.pendingLength = 0;
            }
        }
        const remaining = chunk.length - offset;
        const fullFrameBytes = remaining - (remaining % this.frameSize);
        const end = offset + fullFrameBytes;
        for (let i = offset; i < end; i += this.frameSize) {
            this._processFrame(chunk.subarray(i, i + this.frameSize));
        }
        if (end < chunk.length) {
            this.pendingLength = chunk.length - end;
            chunk.copy(this.pendingBuffer, 0, end);
        }
        callback();
    }
    _flush(callback) {
        let remaining = this.pendingLength > 0
            ? (this.pendingBuffer?.subarray(0, this.pendingLength) ?? EMPTY_BUFFER)
            : EMPTY_BUFFER;
        this.pendingLength = 0;
        if (remaining.length > 0) {
            if (this.processingMode === 'protected') {
                const tapeFloat = this.tape.processFloat32;
                const scratchFloat = this.scratch.processFloat32;
                const volumeFloat = this.volume.processFloat32;
                const fadeFloat = this.fade.processFloat32;
                if (this.tape.isActive() && !tapeFloat)
                    throw new Error('TapeTransformer does not support Protected Float32 processing');
                if (this.scratch.isActive() && !scratchFloat)
                    throw new Error('ScratchTransformer does not support Protected Float32 processing');
                if (!volumeFloat || !fadeFloat)
                    throw new Error('Protected flow component lacks Float32 support');
                remaining = tapeFloat ? tapeFloat.call(this.tape, remaining) : remaining;
                remaining = scratchFloat
                    ? scratchFloat.call(this.scratch, remaining)
                    : remaining;
                remaining = volumeFloat.call(this.volume, remaining);
                remaining = fadeFloat.call(this.fade, remaining);
                remaining = this._mixProtected(remaining);
            }
            else {
                remaining = this.tape.process(remaining);
                remaining = this.scratch.process(remaining);
                remaining = this.volume.process(remaining);
                remaining = this.fade.process(remaining);
            }
            if (this.processingMode !== 'protected' &&
                this.audioMixer &&
                this.audioMixer.enabled !== false &&
                this.audioMixer.hasActiveLayers()) {
                try {
                    const layerChunks = this.audioMixer.readLayerChunks(remaining.length);
                    remaining = this.audioMixer.mixBuffers(remaining, layerChunks);
                }
                catch (_error) { }
            }
            const finalRemainder = remaining.length % (this.processingMode === 'protected' ? 8 : 4);
            if (finalRemainder > 0) {
                remaining = remaining.subarray(0, remaining.length - finalRemainder);
            }
            if (remaining.length > 0)
                this.push(remaining);
        }
        const silence = Buffer.alloc(this.frameSize, 0);
        let drainLimit = 500;
        while ((this.scratch.isActive() || this.tape.isActive()) &&
            drainLimit-- > 0) {
            this._processFrame(silence);
        }
        callback();
    }
    _destroy(_err, cb) {
        this.pendingBuffer = null;
        cb(null);
    }
}
