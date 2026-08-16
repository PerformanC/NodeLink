/** biome-ignore-all assist/source/organizeImports: <no-op> */
import { PassThrough, Readable, Transform, pipeline } from 'node:stream';
import FAAD2NodeDecoder from '@ecliptia/faad2-wasm/faad2_node_decoder.js';
import { SeekError, seekableStream } from '@ecliptia/seekable-stream';
import { SymphoniaDecoder } from '@toddynnn/symphonia-decoder';
import { normalizeFormat, SupportedFormats } from '../../constants.js';
import { http1makeRequest, logger } from '../../utils.js';
import FlvDemuxer from '../demuxers/Flv.js';
import WebmOpusDemuxer from '../demuxers/WebmOpus.js';
import { Decoder as OpusDecoder, Encoder as OpusEncoder } from '../opus/Opus.js';
import { RingBuffer } from '../structs/RingBuffer.js';
import { FadeTransformer } from './FadeTransformer.js';
import { TapeTransformer } from './TapeTransformer.js';
import { ScratchTransformer } from './ScratchTransformer.js';
import { FlowController } from './FlowController.js';
import { FiltersManager } from './filtersManager.js';
import { VolumeTransformer } from './VolumeTransformer.js';
import { CrossfadeController } from './CrossfadeController.js';
import { SilenceDetector } from './SilenceDetector.js';
let libSampleRatePromise = null;
let mp4BoxPromise = null;
const getMP4Box = async () => {
    if (!mp4BoxPromise) {
        mp4BoxPromise = import('mp4box');
    }
    return mp4BoxPromise;
};
const getLibSampleRate = async () => {
    if (!libSampleRatePromise) {
        libSampleRatePromise = import('@alexanderolsen/libsamplerate-js').then((module) => (module.default || module));
    }
    return libSampleRatePromise;
};
const AUDIO_CONFIG = Object.freeze({
    sampleRate: 48000,
    channels: 2,
    frameSize: 960,
    highWaterMark: 19200
});
const BUFFER_THRESHOLDS = Object.freeze({
    maxCompressed: 256 * 1024,
    minCompressed: 128 * 1024
});
const parsePositiveIntEnv = (key, fallback) => {
    const raw = process.env[key];
    if (!raw)
        return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const AAC_BUFFER_SIZE = parsePositiveIntEnv('NODELINK_AAC_RING_BYTES', 512 * 1024);
const AUDIO_CONSTANTS = Object.freeze({
    pcmFloatFactor: 32767,
    maxDecodesPerTick: 5,
    decodeIntervalMs: 10
});
const MPEGTS_CONFIG = Object.freeze({
    syncByte: 0x47,
    packetSize: 188,
    aacStreamType: 0x0f,
    mp3StreamType: 0x03,
    mp3StreamType2: 0x04
});
const _DOWNMIX_COEFFICIENTS = Object.freeze({
    center: Math.SQRT1_2,
    surround: Math.SQRT1_2,
    lfe: 0.5
});
const SAMPLE_RATES = Object.freeze([
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
    8000, 7350
]);
const _parseAacSampleRate = (data) => {
    let bitOffset = 0;
    const readBits = (count) => {
        if (bitOffset + count > data.byteLength * 8)
            return null;
        let value = 0;
        for (let i = 0; i < count; i++) {
            const byte = data[bitOffset >> 3];
            if (byte === undefined)
                return null;
            value = (value << 1) | ((byte >> (7 - (bitOffset & 7))) & 1);
            bitOffset++;
        }
        return value;
    };
    const objectType = readBits(5);
    if (objectType === null)
        return null;
    if (objectType === 31 && readBits(6) === null)
        return null;
    const samplingIndex = readBits(4);
    if (samplingIndex === null)
        return null;
    if (samplingIndex === 15) {
        const explicitSampleRate = readBits(24);
        return explicitSampleRate && explicitSampleRate > 0
            ? explicitSampleRate
            : null;
    }
    return SAMPLE_RATES[samplingIndex] ?? null;
};
const EMPTY_BUFFER = Buffer.alloc(0);
const _getResamplerConverterType = (quality, libSampleRate) => {
    const types = libSampleRate.ConverterType;
    const qualityMap = {
        best: types.SRC_SINC_BEST_QUALITY,
        medium: types.SRC_SINC_MEDIUM_QUALITY,
        fastest: types.SRC_SINC_FASTEST,
        'zero order holder': types.SRC_ZERO_ORDER_HOLD,
        linear: types.SRC_LINEAR
    };
    return qualityMap[quality] || types.SRC_SINC_FASTEST;
};
const _clampSample = (value) => {
    if (value > 1)
        return 1;
    if (value < -1)
        return -1;
    return value;
};
const _floatToInt16Buffer = (floatArray) => {
    const length = floatArray.length;
    const output = new Int16Array(length);
    for (let i = 0; i < length; i++) {
        output[i] =
            _clampSample(floatArray[i] || 0) * AUDIO_CONSTANTS.pcmFloatFactor;
    }
    return Buffer.from(output.buffer, output.byteOffset, output.byteLength);
};
const _createAdtsHeader = (sampleLength, profile, samplingIndex, channelCount) => {
    const frameLength = sampleLength + 7;
    const profileIndex = profile - 1;
    return Buffer.from([
        0xff,
        0xf1,
        ((profileIndex & 0x03) << 6) |
            ((samplingIndex & 0x0f) << 2) |
            ((channelCount & 0x04) >> 2),
        ((channelCount & 0x03) << 6) | ((frameLength & 0x1800) >> 11),
        (frameLength & 0x7f8) >> 3,
        ((frameLength & 0x7) << 5) | 0x1f,
        0xfc
    ]);
};
const _parseBoxes = (buffer, offset = 0) => {
    const boxes = [];
    const bufferLength = buffer.length;
    while (offset + 8 <= bufferLength) {
        const size = buffer.readUInt32BE(offset);
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        if (size === 0 || size > bufferLength - offset)
            break;
        if (type === '\0\0\0\0')
            break;
        boxes.push({
            type,
            size,
            data: buffer.subarray(offset + 8, offset + size),
            offset
        });
        offset += size;
    }
    return boxes;
};
const _findNestedBox = (boxes, ...path) => {
    let current = boxes;
    for (const boxType of path) {
        const box = current.find((b) => b.type === boxType);
        if (!box)
            return null;
        current = _parseBoxes(box.data);
    }
    return current;
};
const _createErrorResponse = (message, cause = 'UNKNOWN') => ({
    exception: {
        message,
        severity: 'fault',
        cause
    }
});
const _isFmp4Format = (type) => type.indexOf('fmp4') !== -1 ||
    type.indexOf('hls') !== -1 ||
    type.indexOf('mpegurl') !== -1;
const _isMpegtsFormat = (type) => type.indexOf('mpegts') !== -1 || type.indexOf('video/mp2t') !== -1;
const _isMp4Format = (type) => type.indexOf('mp4') !== -1 ||
    type.indexOf('m4a') !== -1 ||
    type.indexOf('m4v') !== -1 ||
    type.indexOf('mov') !== -1 ||
    type.indexOf('quicktime') !== -1;
const _isWebmFormat = (type) => type.includes('webm') || type.includes('weba');
const _isFlvFormat = (type) => type.indexOf('flv') !== -1;
const _getSymphoniaCodecHint = (type) => {
    const lowerType = type.toLowerCase();
    if (lowerType.includes('flac'))
        return 'flac';
    if (lowerType.includes('mp3') || lowerType.includes('mpeg'))
        return 'mp3';
    if (lowerType.includes('ogg') || lowerType.includes('vorbis'))
        return 'ogg';
    if (lowerType.includes('wav') || lowerType.includes('wave'))
        return 'wav';
    if (lowerType.includes('alac') ||
        lowerType.includes('mp4') ||
        lowerType.includes('m4a'))
        return 'm4a';
    return null;
};
const _tightBuffer = (buf) => buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength
    ? buf
    : Buffer.from(buf);
const _toTightArrayBuffer = (buf) => {
    const backing = buf.buffer;
    if (backing instanceof ArrayBuffer &&
        buf.byteOffset === 0 &&
        buf.byteLength === backing.byteLength) {
        return backing;
    }
    return Uint8Array.from(buf).buffer;
};
const _extFromUrl = (url) => {
    try {
        const p = new URL(url).pathname;
        const m = p.match(/\.([a-z0-9]+)$/i);
        return (m?.[1] ?? '').toLowerCase();
    }
    catch {
        return '';
    }
};
const _toArrayBufferWithFileStart = (buf, fileStart) => {
    const ab = _toTightArrayBuffer(buf);
    ab.fileStart = fileStart;
    return ab;
};
const _isHttpProxyConfig = (value) => {
    if (!value || typeof value !== 'object')
        return false;
    const proxy = value;
    if (typeof proxy.url !== 'string' || proxy.url.length === 0)
        return false;
    if (proxy.username !== undefined && typeof proxy.username !== 'string')
        return false;
    if (proxy.password !== undefined && typeof proxy.password !== 'string')
        return false;
    if (proxy.type !== undefined &&
        proxy.type !== 'forward' &&
        proxy.type !== 'reverse')
        return false;
    return true;
};
const _extractSeekProxy = (streamInfo) => {
    const additionalData = streamInfo?.additionalData;
    return _isHttpProxyConfig(additionalData?.proxy)
        ? additionalData.proxy
        : undefined;
};
async function _fetchRange(url, start, endInclusive, proxy) {
    if (proxy) {
        const response = await http1makeRequest(url, {
            method: 'GET',
            headers: {
                Range: `bytes=${start}-${endInclusive}`
            },
            responseType: 'buffer',
            proxy
        });
        if (response.statusCode !== 200 && response.statusCode !== 206) {
            throw new Error(`HTTP ${response.statusCode ?? 0} while fetching range`);
        }
        if (Buffer.isBuffer(response.body)) {
            return response.body;
        }
        if (response.body instanceof Uint8Array) {
            return Buffer.from(response.body);
        }
        throw new Error('Invalid binary response body while fetching range');
    }
    const res = await fetch(url, {
        headers: { Range: `bytes=${start}-${endInclusive}` }
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} while fetching range`);
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
}
async function _openRangeStream(url, start, proxy) {
    if (proxy) {
        const response = await http1makeRequest(url, {
            method: 'GET',
            headers: {
                Range: `bytes=${start}-`
            },
            streamOnly: true,
            proxy
        });
        if ((response.statusCode !== 200 && response.statusCode !== 206) ||
            !response.stream) {
            throw new Error(`HTTP ${response.statusCode ?? 0} while opening range stream`);
        }
        return response.stream;
    }
    const res = await fetch(url, {
        headers: { Range: `bytes=${start}-` }
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} while opening range stream`);
    }
    // @ts-expect-error - Node.js Readable.fromWeb accepts ReadableStream
    return Readable.fromWeb(res.body);
}
const _seekOffset = (res) => {
    if (typeof res === 'number')
        return res;
    const off = res && typeof res === 'object' ? res.offset : undefined;
    return off ?? NaN;
};
async function _buildMp4SeekOptions(url, seekTimeMs, proxy) {
    const mp4Box = await getMP4Box();
    const mp4 = mp4Box.createFile();
    const prefetch = [];
    let readyInfo = null;
    let nextStart = 0;
    await new Promise(async (resolve, reject) => {
        mp4.onError = (e) => reject(new Error(`MP4Box init error: ${e}`));
        mp4.onReady = (info) => {
            readyInfo = info;
            resolve();
        };
        const CHUNK = 512 * 1024;
        const MAX_FETCHES = 40;
        try {
            for (let i = 0; i < MAX_FETCHES && !readyInfo; i++) {
                const buf = await _fetchRange(url, nextStart, nextStart + CHUNK - 1, proxy);
                const ab = _toArrayBufferWithFileStart(buf, nextStart);
                prefetch.push({ fileStart: nextStart, data: ab });
                const appended = mp4.appendBuffer(ab);
                if (typeof appended === 'number') {
                    nextStart = appended;
                }
                else {
                    nextStart += ab.byteLength;
                }
                if (!Number.isFinite(nextStart) || nextStart < 0)
                    break;
            }
            if (!readyInfo) {
                reject(new Error('Could not parse MP4 metadata (moov not found quickly).'));
            }
        }
        catch (e) {
            reject(e);
        }
    });
    const info = readyInfo;
    const audioTrack = info?.tracks.find((t) => t.codec?.startsWith('mp4a'));
    if (!audioTrack) {
        throw new Error('No AAC track found in MP4/M4A');
    }
    mp4.setExtractionOptions(audioTrack.id, null, { nbSamples: 1 });
    const seekTimeSec = seekTimeMs / 1000;
    const mp4boxFile = mp4;
    const seekRes = mp4boxFile.seek(seekTimeSec, true);
    const startOffset = _seekOffset(seekRes);
    try {
        mp4.stop();
    }
    catch { }
    if (!Number.isFinite(startOffset) || startOffset < 0) {
        throw new Error(`MP4Box seek returned invalid offset: ${JSON.stringify(seekRes)}`);
    }
    return {
        prefetch,
        baseFileStart: startOffset,
        seekTimeSec
    };
}
const _createSeekableProxyRequest = (proxy) => {
    if (!proxy)
        return undefined;
    return async (requestUrl, options) => {
        const response = await http1makeRequest(typeof requestUrl === 'string' ? requestUrl : requestUrl.toString(), {
            method: options?.method ?? 'GET',
            headers: (options?.headers ?? {}),
            streamOnly: true,
            proxy
        });
        if (!response.stream) {
            throw new Error('Failed to open proxied seek request stream');
        }
        const stream = response.stream;
        stream.statusCode = response.statusCode;
        stream.headers = response.headers;
        return stream;
    };
};
/**
 * Immutable counter of processed frames.
 * Ensures the song position in Lavalink doesn't break when using Nightcore/Vaporwave.
 */
class PCMFrameCounter extends Transform {
    totalFrames = 0;
    sampleRate;
    bytesPerFrame;
    constructor(sampleRate = 48000, channels = 2) {
        super();
        this.sampleRate = sampleRate;
        this.bytesPerFrame = channels * 2; // 16-bit PCM (2 bytes per channel)
    }
    _transform(chunk, _encoding, callback) {
        this.totalFrames += chunk.length / this.bytesPerFrame;
        this.push(chunk);
        callback();
    }
    getConsumedMs() {
        return (this.totalFrames / this.sampleRate) * 1000;
    }
}
class BaseAudioResource {
    pipes;
    stream;
    canStop;
    _destroyed;
    guildId;
    _forwardFinishBuffering = null;
    _finishBufferingEmitted;
    constructor(guildId) {
        this.guildId = guildId || 'api-stream';
        this.pipes = [];
        this.stream = null;
        this.canStop = false;
        this._destroyed = false;
        this._finishBufferingEmitted = false;
    }
    _assignStream(stream) {
        const voiceStream = stream;
        voiceStream.setVolume = (volume) => this.setVolume(volume);
        voiceStream.setFilters = (filters) => this.setFilters(filters);
        voiceStream.checkTapeRampCompleted = () => this.checkTapeRampCompleted();
        voiceStream.scratchTo = (durationMs, style) => this.scratchTo(durationMs, style);
        voiceStream.checkScratchEffectCompleted = () => this.checkScratchEffectCompleted();
        voiceStream.getEffectiveRate = () => this.getEffectiveRate();
        voiceStream.getRMS = () => this.getRMS();
        voiceStream.isSilent = () => this.isSilent();
        voiceStream.setFadeVolume = (volume) => this.setFadeVolume(volume);
        voiceStream.fadeTo = (volume, durationMs, curve) => this.fadeTo(volume, durationMs, curve);
        voiceStream.tapeTo = (durationMs, type, curve) => this.tapeTo(durationMs, type, curve);
        voiceStream.setLoudnessNormalizer = (enabled) => this.setLoudnessNormalizer(enabled);
        voiceStream.isPipelineFinished = () => this.isPipelineFinished();
        /*
         * This will prevent a race condition where fast CDN/network streams finish buffering and emit
         * 'finishBuffering' before the voice connection finishes starting and subscribes to the event.
         * Using 'newListener' event, if the voice player subscribes after the stream has
         * already buffered, we will re-emit 'finishBuffering' immediately, allowing the track to be stoppable
         * and transition to trackEnd naturally.
         *
         * ... i hate nodejs sometimes...
         */
        voiceStream.on('newListener', (event) => {
            if (event === 'finishBuffering' && this._finishBufferingEmitted) {
                setImmediate(() => {
                    voiceStream.emit('finishBuffering');
                });
            }
        });
        this.stream = voiceStream;
    }
    _end() {
        if (this._destroyed || !this.pipes)
            return;
        this._destroyed = true;
        const firstPipe = this.pipes[0];
        if (firstPipe?._cleanupListeners) {
            try {
                firstPipe._cleanupListeners();
            }
            catch { }
        }
        if (this._forwardFinishBuffering && firstPipe?._sourceStream) {
            try {
                firstPipe._sourceStream.off?.('finishBuffering', this._forwardFinishBuffering);
            }
            catch { }
        }
        if (firstPipe?.stopHls) {
            firstPipe.stopHls();
        }
        if (firstPipe?.responseStream?.destroyed === false) {
            firstPipe.responseStream.destroy();
        }
        if (firstPipe?._sourceStream && !firstPipe._sourceStream.destroyed) {
            try {
                firstPipe._sourceStream.destroy();
            }
            catch { }
            try {
                delete firstPipe._sourceStream;
            }
            catch { }
        }
        for (let i = this.pipes.length - 1; i >= 0; i--) {
            const pipe = this.pipes[i];
            pipe.abort?.();
            pipe.unpipe?.();
            pipe.destroy?.();
        }
        this.pipes.length = 0;
        this.stream = null;
        this.pipes = null;
    }
    destroy() {
        this._end();
    }
    getEffectiveRate() {
        return 1.0;
    }
    getRMS() {
        if (!this.pipes)
            return 0;
        const silenceDetector = this.pipes.find((p) => p instanceof SilenceDetector);
        return silenceDetector?.getRMS() ?? 0;
    }
    isSilent() {
        if (!this.pipes)
            return false;
        const silenceDetector = this.pipes.find((p) => p instanceof SilenceDetector);
        return silenceDetector?.isSilent() ?? false;
    }
    getMainEnergy() {
        return null;
    }
    checkTapeRampCompleted() {
        return false;
    }
    scratchTo(_durationMs, _style) { }
    checkScratchEffectCompleted() {
        return false;
    }
    tapeTo(_durationMs, _type, _curve) { }
    setLoudnessNormalizer(_enabled) { }
    prepareCrossfade(stream, options, onComplete) {
        const controller = this.pipes?.find((pipe) => pipe instanceof CrossfadeController);
        return controller?.prepareNextStream(stream, options, onComplete) ?? false;
    }
    startCrossfade(durationMs, curve, availableMs) {
        const controller = this.pipes?.find((pipe) => pipe instanceof CrossfadeController);
        return controller?.startCrossfade(durationMs, curve, availableMs) ?? false;
    }
    clearCrossfade() {
        const controller = this.pipes?.find((pipe) => pipe instanceof CrossfadeController);
        controller?.clearNext();
    }
    setCrossfadePaused(paused) {
        const controller = this.pipes?.find((pipe) => pipe instanceof CrossfadeController);
        controller?.setPaused(paused);
    }
    getCrossfadeState() {
        const controller = this.pipes?.find((pipe) => pipe instanceof CrossfadeController);
        return (controller?.getState() ?? {
            active: false,
            bufferedMs: 0,
            isBridging: false
        });
    }
    isPipelineFinished() {
        if (this._destroyed || !this.pipes)
            return true;
        const crossfadeController = this.pipes.find((pipe) => pipe instanceof CrossfadeController);
        if (crossfadeController?.getState().isBridging)
            return false;
        for (const pipe of this.pipes) {
            if (pipe.isFinished ||
                pipe.readableEnded) {
                return true;
            }
        }
        return false;
    }
    setVolume(volume) {
        if (!this.pipes)
            return;
        const flowController = this.pipes.find((p) => p instanceof FlowController);
        if (flowController) {
            flowController.setVolume(volume);
            return;
        }
        const volumeTransformer = this.pipes.find((p) => p instanceof VolumeTransformer);
        if (volumeTransformer) {
            volumeTransformer.setVolume(volume);
        }
    }
    setFilters(filters) {
        if (!this.pipes)
            return;
        const filterManager = this.pipes.find((p) => p instanceof FiltersManager);
        if (filterManager) {
            filterManager.update(filters);
            return;
        }
        const flowController = this.pipes.find((p) => p instanceof FlowController);
        if (flowController) {
            flowController.setFilters(filters);
            return;
        }
    }
    setFadeVolume(volume) {
        if (!this.pipes)
            return;
        const flowController = this.pipes.find((p) => p instanceof FlowController);
        if (flowController) {
            flowController.setFadeVolume(volume);
            return;
        }
        const fadeTransformer = this.pipes.find((p) => p instanceof FadeTransformer);
        if (fadeTransformer) {
            fadeTransformer.setGain(volume);
        }
    }
    fadeTo(volume, durationMs, curve) {
        if (!this.pipes)
            return;
        const flowController = this.pipes.find((p) => p instanceof FlowController);
        if (flowController) {
            flowController.fadeTo(volume, durationMs, curve);
            return;
        }
        const fadeTransformer = this.pipes.find((p) => p instanceof FadeTransformer);
        if (fadeTransformer) {
            fadeTransformer.fadeTo(volume, durationMs, curve);
        }
        else {
            throw new Error('FadeTransformer not found in the pipeline.');
        }
    }
    emit(event, ...args) {
        this.stream?.emit(event, ...args);
    }
    on(event, listener) {
        this.stream?.on(event, listener);
    }
    off(event, listener) {
        this.stream?.off(event, listener);
    }
    once(event, listener) {
        this.stream?.once(event, listener);
    }
    removeListener(event, listener) {
        this.stream?.removeListener(event, listener);
    }
    removeAllListeners() {
        if (!this.stream?.eventNames)
            return;
        for (const eventName of this.stream.eventNames()) {
            this.stream.removeAllListeners(eventName);
        }
    }
    read() {
        return this.stream?.read() ?? null;
    }
    resume() {
        this.stream?.resume();
    }
}
class SymphoniaDecoderStream extends Transform {
    decoder;
    codecRegistryHint;
    flushCallback;
    inputClosed;
    isFinished;
    _aborted;
    _isDecoding;
    _timeoutId;
    _immediateId;
    constructor(options = {}) {
        const { codecRegistryHint, ...streamOptions } = options;
        super({
            ...streamOptions,
            highWaterMark: options.highWaterMark ?? AUDIO_CONFIG.highWaterMark,
            objectMode: false
        });
        this.decoder = new SymphoniaDecoder();
        this.codecRegistryHint = codecRegistryHint ?? null;
        this.flushCallback = null;
        this.inputClosed = false;
        this.isFinished = false;
        this._aborted = false;
        this._isDecoding = false;
        this._timeoutId = null;
        this._immediateId = null;
    }
    abort() {
        this._aborted = true;
        this._cancelTimers();
    }
    _cancelTimers() {
        if (this._timeoutId) {
            clearTimeout(this._timeoutId);
            this._timeoutId = null;
        }
        if (this._immediateId) {
            clearImmediate(this._immediateId);
            this._immediateId = null;
        }
    }
    _isDecoderValid() {
        return this.decoder !== null && !this._aborted && !this.isFinished;
    }
    _transform(chunk, _encoding, callback) {
        if (this._aborted || !this.decoder) {
            callback();
            return;
        }
        try {
            this.decoder.push(chunk);
            if (!this.decoder.isProbed) {
                this.decoder.initialize(this.codecRegistryHint);
            }
            this._scheduleDecode();
            callback();
        }
        catch (err) {
            callback(err);
        }
    }
    _read(_size) {
        super._read(_size);
        if (this._isDecoderValid()) {
            this._scheduleDecode();
        }
    }
    _scheduleDecode(delayMs = 0) {
        if (this._immediateId || this._timeoutId || !this._isDecoderValid())
            return;
        if (delayMs > 0) {
            this._timeoutId = setTimeout(() => {
                this._timeoutId = null;
                this._decodeLoop();
            }, delayMs);
            return;
        }
        this._immediateId = setImmediate(() => {
            this._immediateId = null;
            this._decodeLoop();
        });
    }
    _decodeLoop() {
        if (this._isDecoding || !this._isDecoderValid())
            return;
        if (!this.decoder?.isProbed) {
            try {
                if (!this.decoder?.initialize(this.codecRegistryHint)) {
                    if (this.inputClosed)
                        this._finishDecode();
                    return;
                }
            }
            catch (err) {
                this._failDecode(err);
                return;
            }
        }
        if (this.readableLength >= this.readableHighWaterMark) {
            this._scheduleDecode(AUDIO_CONSTANTS.decodeIntervalMs);
            return;
        }
        this._isDecoding = true;
        try {
            let decodeCount = 0;
            while (decodeCount < AUDIO_CONSTANTS.maxDecodesPerTick &&
                this._isDecoderValid() &&
                this.readableLength < this.readableHighWaterMark) {
                const result = this.decoder?.decode();
                if (!result) {
                    if (this.inputClosed)
                        this._finishDecode();
                    return;
                }
                decodeCount++;
                if (result.samples.length === 0)
                    continue;
                if (!this.push(result.samples)) {
                    this._scheduleDecode(AUDIO_CONSTANTS.decodeIntervalMs);
                    return;
                }
            }
            this._scheduleDecode();
        }
        catch (err) {
            this._failDecode(err);
        }
        finally {
            this._isDecoding = false;
        }
    }
    _finishDecode() {
        const callback = this.flushCallback;
        this.flushCallback = null;
        this.isFinished = true;
        this._cleanup();
        callback?.();
    }
    _failDecode(err) {
        const callback = this.flushCallback;
        this.flushCallback = null;
        this.isFinished = true;
        this._cleanup();
        const error = err instanceof Error ? err : new Error(`Symphonia decode failed: ${err}`);
        if (callback) {
            callback(error);
        }
        else {
            this.emit('error', error);
        }
    }
    _flush(callback) {
        this._cancelTimers();
        if (this._aborted || !this.decoder) {
            this._cleanup();
            callback();
            return;
        }
        try {
            this.decoder.closeInput();
            this.inputClosed = true;
            this.flushCallback = callback;
            if (!this.decoder.initialize(this.codecRegistryHint)) {
                if ((this.decoder.bufferedBytes ?? 0) === 0) {
                    this._cleanup();
                    callback();
                    return;
                }
                throw new Error('Symphonia init failed: not enough input data');
            }
            this._decodeLoop();
        }
        catch (err) {
            this.flushCallback = null;
            this._cleanup();
            callback(err);
        }
    }
    _destroy(err, callback) {
        this._aborted = true;
        this.isFinished = true;
        this._cancelTimers();
        if (this.flushCallback) {
            const cb = this.flushCallback;
            this.flushCallback = null;
            cb(err);
        }
        this._cleanup();
        super._destroy(err, callback);
    }
    _cleanup() {
        this._cancelTimers();
        if (this.decoder) {
            try {
                this.decoder.free();
            }
            catch { }
            this.decoder = null;
        }
    }
}
class MPEGTSDemuxer extends Transform {
    ringBuffer;
    patPmtId;
    audioPid;
    audioPidFound;
    _aborted;
    pesChunks;
    pesSize;
    constructor(options) {
        super({
            ...options,
            highWaterMark: AUDIO_CONFIG.highWaterMark
        });
        this.ringBuffer = new RingBuffer(BUFFER_THRESHOLDS.maxCompressed);
        this.patPmtId = null;
        this.audioPid = null;
        this.audioPidFound = false;
        this._aborted = false;
        this.pesChunks = [];
        this.pesSize = 0;
    }
    abort() {
        this._aborted = true;
        this.ringBuffer.clear();
        this.pesChunks = [];
        this.pesSize = 0;
    }
    _transform(chunk, _encoding, callback) {
        if (this._aborted) {
            callback();
            return;
        }
        try {
            this.ringBuffer.write(chunk);
            while (this.ringBuffer.length >= MPEGTS_CONFIG.packetSize &&
                !this._aborted) {
                const head = this.ringBuffer.peek(1);
                if (!head || head.length === 0 || head[0] !== MPEGTS_CONFIG.syncByte) {
                    this.ringBuffer.skip(1);
                    continue;
                }
                const packet = this.ringBuffer.read(MPEGTS_CONFIG.packetSize);
                if (!packet || packet.length < MPEGTS_CONFIG.packetSize)
                    continue;
                try {
                    const pusi = !!((packet[1] ?? 0) & 0x40);
                    const pid = (((packet[1] ?? 0) & 0x1f) << 8) | (packet[2] ?? 0);
                    const afc = ((packet[3] ?? 0) & 0x30) >> 4;
                    let offset = 4;
                    if (afc > 1) {
                        offset = 5 + (packet[4] ?? 0);
                        if (offset >= MPEGTS_CONFIG.packetSize)
                            continue;
                    }
                    if (pid === 0 && pusi) {
                        this._processPAT(packet, offset);
                    }
                    else if (this.patPmtId && pid === this.patPmtId && pusi) {
                        this._processPMT(packet, offset);
                    }
                    else if (this.audioPid && pid === this.audioPid) {
                        this._processAudioPacket(packet, pusi, offset);
                    }
                }
                catch {
                    this._aborted = true;
                }
            }
            callback();
        }
        catch {
            callback();
        }
    }
    _processPAT(packet, offset) {
        offset += (packet[offset] || 0) + 1;
        if (offset + 11 < MPEGTS_CONFIG.packetSize) {
            this.patPmtId =
                (((packet[offset + 10] || 0) & 0x1f) << 8) | (packet[offset + 11] || 0);
        }
    }
    _processPMT(packet, offset) {
        offset += (packet[offset] || 0) + 1;
        const sectionLength = (((packet[offset + 1] || 0) & 0x0f) << 8) | (packet[offset + 2] || 0);
        const tableEnd = offset + 3 + sectionLength - 4;
        const programInfoLength = (((packet[offset + 10] || 0) & 0x0f) << 8) | (packet[offset + 11] || 0);
        offset += 12 + programInfoLength;
        while (offset < tableEnd && offset < MPEGTS_CONFIG.packetSize) {
            const streamType = packet[offset] || 0;
            const elementaryPid = (((packet[offset + 1] || 0) & 0x1f) << 8) | (packet[offset + 2] || 0);
            if ((streamType === MPEGTS_CONFIG.aacStreamType ||
                streamType === MPEGTS_CONFIG.mp3StreamType ||
                streamType === MPEGTS_CONFIG.mp3StreamType2) &&
                !this.audioPidFound) {
                this.audioPid = elementaryPid;
                this.audioPidFound = true;
                return;
            }
            const esInfoLen = (((packet[offset + 3] || 0) & 0x0f) << 8) | (packet[offset + 4] || 0);
            offset += 5 + esInfoLen;
        }
    }
    _processAudioPacket(packet, pusi, offset) {
        if (pusi) {
            if (this.pesSize > 0) {
                this._emitPES(Buffer.concat(this.pesChunks, this.pesSize));
                this.pesChunks = [];
                this.pesSize = 0;
            }
        }
        const payload = _tightBuffer(packet.subarray(offset));
        if (payload.length > 0) {
            this.pesChunks.push(payload);
            this.pesSize += payload.length;
        }
    }
    _emitPES(buffer) {
        if (buffer.length < 9)
            return;
        if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01) {
            const headerLength = buffer[8] || 0;
            const payloadOffset = 9 + headerLength;
            if (payloadOffset < buffer.length) {
                this.push(_tightBuffer(buffer.subarray(payloadOffset)));
            }
        }
    }
    _flush(callback) {
        if (this.pesSize > 0) {
            this._emitPES(Buffer.concat(this.pesChunks, this.pesSize));
        }
        this.pesChunks = [];
        this.pesSize = 0;
        this.ringBuffer.clear();
        callback();
    }
    _destroy(err, callback) {
        this._aborted = true;
        this.ringBuffer.dispose();
        this.pesChunks = [];
        this.pesSize = 0;
        super._destroy(err, callback);
    }
}
/**********************************************************************
 * ATENÇÃO: Não altere este trecho; ajustes aqui quebram a cadeia de decodificação.
 * WARNING: Do not edit this section; changes here will break the decoding pipeline.
 **********************************************************************/
class AACDecoderStream extends Transform {
    decoder;
    resampler;
    isDecoderReady;
    isConfigured;
    pendingChunks;
    ringBuffer;
    resamplingQuality;
    resamplerCreationPromise;
    static MAX_PENDING_CHUNKS = 200;
    state;
    constructor(options) {
        super({
            ...options,
            highWaterMark: AUDIO_CONFIG.highWaterMark
        });
        this.state = options.state ?? null;
        this.decoder = new FAAD2NodeDecoder();
        this.resampler = null;
        this.isDecoderReady = false;
        this.isConfigured = false;
        this.pendingChunks = [];
        this.ringBuffer = new RingBuffer(AAC_BUFFER_SIZE);
        this.resamplingQuality = options.resamplingQuality || 'fastest';
        this.resamplerCreationPromise = null;
        this.decoder.ready
            .then(() => {
            this.isDecoderReady = true;
            this._processPendingChunks();
        })
            .catch((err) => this.emit('error', err));
    }
    _destroy(err, cb) {
        this.ringBuffer.dispose();
        this.pendingChunks.length = 0;
        if (this.decoder)
            this.decoder.free?.();
        if (this.resampler) {
            this.resampler.destroy?.();
            this.resampler = null;
        }
        super._destroy(err, cb);
    }
    _downmixToStereo(interleavedPCM, channels, samplesPerChannel) {
        if (channels === 2)
            return interleavedPCM;
        const stereo = new Float32Array(samplesPerChannel * 2);
        if (channels === 1) {
            for (let i = 0; i < samplesPerChannel; i++) {
                const val = interleavedPCM[i] || 0;
                stereo[i * 2] = val;
                stereo[i * 2 + 1] = val;
            }
            return stereo;
        }
        const CENTER_MIX = Math.SQRT1_2;
        const SURROUND_MIX = Math.SQRT1_2;
        const LFE_MIX = 0.5;
        for (let i = 0; i < samplesPerChannel; i++) {
            let left = 0;
            let right = 0;
            const offset = i * channels;
            switch (channels) {
                case 3: {
                    const C = interleavedPCM[offset] || 0;
                    const L = interleavedPCM[offset + 1] || 0;
                    const R = interleavedPCM[offset + 2] || 0;
                    left = L + C * CENTER_MIX;
                    right = R + C * CENTER_MIX;
                    break;
                }
                case 4: {
                    const C = interleavedPCM[offset] || 0;
                    const L = interleavedPCM[offset + 1] || 0;
                    const R = interleavedPCM[offset + 2] || 0;
                    const Cs = interleavedPCM[offset + 3] || 0;
                    left = L + C * CENTER_MIX + Cs * SURROUND_MIX * 0.5;
                    right = R + C * CENTER_MIX + Cs * SURROUND_MIX * 0.5;
                    break;
                }
                case 5: {
                    const C = interleavedPCM[offset] || 0;
                    const L = interleavedPCM[offset + 1] || 0;
                    const R = interleavedPCM[offset + 2] || 0;
                    const Ls = interleavedPCM[offset + 3] || 0;
                    const Rs = interleavedPCM[offset + 4] || 0;
                    left = L + C * CENTER_MIX + Ls * SURROUND_MIX;
                    right = R + C * CENTER_MIX + Rs * SURROUND_MIX;
                    break;
                }
                case 6: {
                    const C = interleavedPCM[offset] || 0;
                    const L = interleavedPCM[offset + 1] || 0;
                    const R = interleavedPCM[offset + 2] || 0;
                    const Ls = interleavedPCM[offset + 3] || 0;
                    const Rs = interleavedPCM[offset + 4] || 0;
                    const LFE = interleavedPCM[offset + 5] || 0;
                    left = L + C * CENTER_MIX + Ls * SURROUND_MIX + LFE * LFE_MIX;
                    right = R + C * CENTER_MIX + Rs * SURROUND_MIX + LFE * LFE_MIX;
                    break;
                }
                default:
                    left = interleavedPCM[offset] || 0;
                    right = interleavedPCM[offset + 1] || left;
                    break;
            }
            if (left > 1.0)
                left = 1.0;
            else if (left < -1.0)
                left = -1.0;
            if (right > 1.0)
                right = 1.0;
            else if (right < -1.0)
                right = -1.0;
            stereo[i * 2] = left;
            stereo[i * 2 + 1] = right;
        }
        return stereo;
    }
    async _processPendingChunks() {
        if (!this.isDecoderReady || this.pendingChunks.length === 0)
            return;
        for (const item of this.pendingChunks) {
            await this._decodeChunk(item.chunk, item.encoding, item.callback);
        }
        this.pendingChunks = [];
    }
    _findADTSFrame() {
        const buffer = this.ringBuffer.peek(this.ringBuffer.length);
        if (!buffer)
            return null;
        const buf = buffer;
        for (let i = 0; i < buf.length - 7; i++) {
            const syncword = ((buf[i] ?? 0) << 4) | ((buf[i + 1] ?? 0) >> 4);
            if (syncword === 0xfff) {
                const frameLength = (((buf[i + 3] ?? 0) & 0x03) << 11) |
                    ((buf[i + 4] ?? 0) << 3) |
                    (((buf[i + 5] ?? 0) >> 5) & 0x07);
                if (buf.length >= i + frameLength) {
                    return {
                        start: i,
                        end: i + frameLength,
                        frame: buf.subarray(i, i + frameLength)
                    };
                }
            }
        }
        return null;
    }
    _transform(chunk, encoding, callback) {
        if (this.state?.isAlac) {
            this.push(chunk);
            callback();
            return;
        }
        if (!this.isDecoderReady || this.pendingChunks.length > 0) {
            if (this.pendingChunks.length >= AACDecoderStream.MAX_PENDING_CHUNKS) {
                this.pendingChunks.shift();
            }
            this.pendingChunks.push({ chunk, encoding, callback });
            return;
        }
        this._decodeChunk(chunk, encoding, callback);
    }
    async _decodeChunk(chunk, _encoding, callback) {
        try {
            this.ringBuffer.write(chunk);
            while (this.ringBuffer.length > 7) {
                const frameInfo = this._findADTSFrame();
                if (!frameInfo)
                    break;
                if (frameInfo.start > 0) {
                    this.ringBuffer.skip(frameInfo.start);
                }
                const adtsFrame = frameInfo.frame;
                if (!this.isConfigured) {
                    await this.decoder.configure(adtsFrame);
                    this.isConfigured = true;
                }
                try {
                    const result = this.decoder.decode(adtsFrame);
                    if (result?.pcm?.length) {
                        let { pcm, sampleRate, channels, samplesPerChannel } = result;
                        if (channels > 2 || channels === 1) {
                            pcm = this._downmixToStereo(pcm, channels, samplesPerChannel);
                            channels = 2;
                        }
                        if (sampleRate !== AUDIO_CONFIG.sampleRate) {
                            if (this.resampler) {
                                const resampled = this.resampler.full(pcm);
                                const pcmInt16 = new Int16Array(resampled.length);
                                for (let i = 0; i < resampled.length; i++) {
                                    pcmInt16[i] =
                                        Math.max(-1, Math.min(1, resampled[i] || 0)) * 32767;
                                }
                                this.push(Buffer.from(pcmInt16.buffer));
                            }
                            else {
                                if (!this.resamplerCreationPromise) {
                                    this.resamplerCreationPromise = getLibSampleRate()
                                        .then((libSampleRate) => libSampleRate.create(2, sampleRate, 48000, {
                                        converterType: _getResamplerConverterType(this.resamplingQuality, libSampleRate)
                                    }))
                                        .then((resampler) => {
                                        this.resampler = resampler;
                                        this.resamplerCreationPromise = null;
                                        return resampler;
                                    });
                                }
                                const resampler = await this.resamplerCreationPromise;
                                const resampled = resampler.full(pcm);
                                const pcmInt16 = new Int16Array(resampled.length);
                                for (let i = 0; i < resampled.length; i++) {
                                    pcmInt16[i] =
                                        Math.max(-1, Math.min(1, resampled[i] || 0)) * 32767;
                                }
                                this.push(Buffer.from(pcmInt16.buffer));
                            }
                        }
                        else {
                            const pcmInt16 = new Int16Array(pcm.length);
                            for (let i = 0; i < pcm.length; i++) {
                                pcmInt16[i] = Math.max(-1, Math.min(1, pcm[i] || 0)) * 32767;
                            }
                            this.push(Buffer.from(pcmInt16.buffer));
                        }
                    }
                }
                catch (_decodeErr) { }
                this.ringBuffer.skip(frameInfo.end);
            }
            callback();
        }
        catch (err) {
            callback(err);
        }
    }
    _flush(callback) {
        if (this.state?.isAlac) {
            callback();
            return;
        }
        if (this.ringBuffer.length > 0 && this.isConfigured) {
            try {
                const frameInfo = this._findADTSFrame();
                if (frameInfo) {
                    const result = this.decoder.decode(frameInfo.frame);
                    if (result?.pcm) {
                        const pcmInt16 = new Int16Array(result.pcm.length);
                        for (let i = 0; i < result.pcm.length; i++) {
                            pcmInt16[i] =
                                Math.max(-1, Math.min(1, result.pcm[i] || 0)) * 32767;
                        }
                        this.push(Buffer.from(pcmInt16.buffer));
                    }
                }
            }
            catch (_err) { }
        }
        if (this.resampler) {
            this.resampler.destroy?.();
            this.resampler = null;
        }
        if (this.decoder)
            this.decoder.destroy?.();
        callback();
    }
}
function patchMoovOffsets(moovBuffer, shift) {
    let idx = 0;
    while (true) {
        idx = moovBuffer.indexOf('stco', idx);
        if (idx === -1)
            break;
        const boxStart = idx - 4;
        if (boxStart >= 0) {
            const boxSize = moovBuffer.readUInt32BE(boxStart);
            const entryCount = moovBuffer.readUInt32BE(idx + 8);
            if (boxSize === 16 + entryCount * 4) {
                for (let i = 0; i < entryCount; i++) {
                    const offsetPos = idx + 12 + i * 4;
                    const originalOffset = moovBuffer.readUInt32BE(offsetPos);
                    moovBuffer.writeUInt32BE(originalOffset + shift, offsetPos);
                }
            }
        }
        idx += 4;
    }
    idx = 0;
    while (true) {
        idx = moovBuffer.indexOf('co64', idx);
        if (idx === -1)
            break;
        const boxStart = idx - 4;
        if (boxStart >= 0) {
            const boxSize = moovBuffer.readUInt32BE(boxStart);
            const entryCount = moovBuffer.readUInt32BE(idx + 8);
            if (boxSize === 16 + entryCount * 8) {
                for (let i = 0; i < entryCount; i++) {
                    const offsetPos = idx + 12 + i * 8;
                    const high = moovBuffer.readUInt32BE(offsetPos);
                    const low = moovBuffer.readUInt32BE(offsetPos + 4);
                    const originalOffset = high * 0x100000000 + low;
                    const newOffset = originalOffset + shift;
                    const newHigh = Math.floor(newOffset / 0x100000000);
                    const newLow = newOffset % 0x100000000;
                    moovBuffer.writeUInt32BE(newHigh, offsetPos);
                    moovBuffer.writeUInt32BE(newLow, offsetPos + 4);
                }
            }
        }
        idx += 4;
    }
}
/* INFO: for context of why i did this: https://github.com/pdeljanov/Symphonia/issues/289, still seems to be broken. */
function reorderMp4Boxes(originalBuffer) {
    const topBoxes = _parseBoxes(originalBuffer);
    const ftyp = topBoxes.find((b) => b.type === 'ftyp');
    const moov = topBoxes.find((b) => b.type === 'moov');
    const mdat = topBoxes.find((b) => b.type === 'mdat');
    if (!ftyp || !moov || !mdat) {
        return originalBuffer;
    }
    if (moov.offset < mdat.offset) {
        return originalBuffer;
    }
    const ftypBuffer = originalBuffer.subarray(ftyp.offset, ftyp.offset + ftyp.size);
    const moovBuffer = Buffer.from(originalBuffer.subarray(moov.offset, moov.offset + moov.size));
    patchMoovOffsets(moovBuffer, moov.size);
    const beforeMoov = originalBuffer.subarray(ftyp.offset + ftyp.size, moov.offset);
    const afterMoov = originalBuffer.subarray(moov.offset + moov.size);
    return Buffer.concat([ftypBuffer, moovBuffer, beforeMoov, afterMoov]);
}
class MP4ToAACStream extends Transform {
    mp4boxFile;
    audioConfig;
    offset;
    _aborted;
    _prefetchDone;
    _opts;
    _initPromise;
    state;
    symphoniaDecoder;
    headerChunks;
    constructor(options = {}) {
        super({ ...options, highWaterMark: AUDIO_CONFIG.highWaterMark });
        this._opts = options;
        this.mp4boxFile = null;
        this.audioConfig = null;
        this.offset = options.baseFileStart ?? 0;
        this._aborted = false;
        this._prefetchDone = false;
        this._initPromise = null;
        this.state = options.state ?? null;
        this.symphoniaDecoder = null;
        this.headerChunks = [];
    }
    async _initMp4Box() {
        if (this.mp4boxFile)
            return;
        if (this._initPromise) {
            await this._initPromise;
            return;
        }
        this._initPromise = (async () => {
            const mp4Box = await getMP4Box();
            this.mp4boxFile = mp4Box.createFile(false);
            this._setupMP4BoxHandlers();
        })();
        await this._initPromise;
    }
    abort() {
        this._aborted = true;
        this._cleanupMp4Box();
        if (this.symphoniaDecoder) {
            this.symphoniaDecoder.abort?.();
        }
    }
    _appendPrefetchIfNeeded() {
        if (this._prefetchDone || !this.mp4boxFile)
            return;
        this._prefetchDone = true;
        const prefetch = this._opts.prefetch ?? [];
        this._opts.prefetch = undefined;
        for (const chunk of prefetch) {
            const ab = chunk.data;
            ab.fileStart = chunk.fileStart;
            this.mp4boxFile.appendBuffer(ab);
        }
    }
    _setupMP4BoxHandlers() {
        if (!this.mp4boxFile)
            return;
        this.mp4boxFile.onError = (e) => {
            throw new Error(`MP4Box error: ${e}`);
        };
        this.mp4boxFile.onReady = (info) => {
            if (this._aborted || !this.mp4boxFile)
                return;
            const audioTrack = info.tracks.find((t) => t.codec?.startsWith('mp4a') || t.codec?.startsWith('alac'));
            if (!audioTrack) {
                throw new Error('No supported track found in MP4');
            }
            if (audioTrack.codec?.startsWith('alac')) {
                if (this.state)
                    this.state.isAlac = true;
                this._cleanupMp4Box();
                this.symphoniaDecoder = new SymphoniaDecoderStream({
                    codecRegistryHint: 'm4a'
                });
                this.symphoniaDecoder.on('data', (pcm) => {
                    this.push(pcm);
                });
                this.symphoniaDecoder.on('error', (err) => {
                    this.emit('error', err);
                });
                const fullBuffer = Buffer.concat(this.headerChunks);
                const reordered = reorderMp4Boxes(fullBuffer);
                this.headerChunks = [];
                this.symphoniaDecoder.write(reordered);
            }
            else {
                this.audioConfig = this._getAudioConfig(audioTrack);
                this.headerChunks = [];
                this.mp4boxFile.setExtractionOptions(audioTrack.id, null, {
                    nbSamples: 50
                });
                if (typeof this._opts.seekTimeSec === 'number') {
                    const mp4boxFile = this.mp4boxFile;
                    const seekRes = mp4boxFile.seek(this._opts.seekTimeSec, true);
                    const expectedOffset = _seekOffset(seekRes);
                    if (typeof this._opts.baseFileStart === 'number' &&
                        this._opts.baseFileStart !== expectedOffset) {
                        logger('warn', 'MP4ToAACStream', `MP4 seek mismatch: stream starts at ${this._opts.baseFileStart} but MP4Box requested ${expectedOffset}`);
                    }
                    if (typeof this._opts.baseFileStart !== 'number') {
                        this.offset = expectedOffset;
                    }
                }
                this.mp4boxFile.start();
            }
        };
        this.mp4boxFile.onSamples = (id, _user, samples) => {
            if (this._aborted || !this.mp4boxFile)
                return;
            if (!samples?.length)
                return;
            for (const sample of samples)
                this._emitSampleWithADTS(sample);
            const last = samples[samples.length - 1];
            if (last && typeof last === 'object' && 'number' in last) {
                const mp4boxFile = this.mp4boxFile;
                mp4boxFile.releaseUsedSamples(id, last.number + 1);
            }
        };
    }
    _emitSampleWithADTS(sample) {
        if (!this.audioConfig)
            return;
        const { profile, samplingIndex, channelCount } = this.audioConfig;
        const sampleData = Buffer.from(sample.data);
        this.push(_createAdtsHeader(sampleData.byteLength, profile, samplingIndex, channelCount));
        this.push(sampleData);
    }
    _getAudioConfig(track) {
        let profile = 2;
        const file = this.mp4boxFile;
        const entry = file?.getTrackById?.(track.id)?.mdia?.minf?.stbl?.stsd
            ?.entries?.[0];
        const decoderConfig = entry?.esds?.esd?.descs?.find((descriptor) => descriptor.tag === 4);
        const decoderSpecificInfo = decoderConfig?.descs?.find((descriptor) => descriptor.tag === 5)?.data;
        const adtsSampleRate = (decoderSpecificInfo && _parseAacSampleRate(decoderSpecificInfo)) ||
            track.audio.sample_rate;
        if (track.codec) {
            const codecParts = (String(track.codec) || '').split('.');
            if (codecParts.length >= 3) {
                const objectType = Number.parseInt(codecParts[2] || '0', 10);
                if (objectType === 5 || objectType === 29) {
                    // ADTS carries the AAC-LC core profile. FAAD detects the SBR/PS
                    // extension from the payload and exposes the higher output rate.
                    profile = 2;
                }
                else {
                    profile = objectType;
                }
            }
        }
        const samplingIndex = SAMPLE_RATES.indexOf(adtsSampleRate);
        if (samplingIndex === -1) {
            throw new Error('Unsupported sample rate for ADTS');
        }
        return {
            profile,
            samplingIndex,
            channelCount: track.audio.channel_count,
            sampleRate: adtsSampleRate
        };
    }
    async _transform(chunk, _encoding, callback) {
        if (this._aborted) {
            callback();
            return;
        }
        if (this.symphoniaDecoder) {
            this.symphoniaDecoder.write(chunk);
            callback();
            return;
        }
        if (!this.audioConfig)
            this.headerChunks.push(chunk);
        try {
            await this._initMp4Box();
            if (!this.mp4boxFile) {
                callback();
                return;
            }
            this._appendPrefetchIfNeeded();
            const arrayBuffer = chunk instanceof ArrayBuffer
                ? chunk
                : _toTightArrayBuffer(chunk);
            arrayBuffer.fileStart =
                this.offset;
            this.offset += arrayBuffer.byteLength;
            this.mp4boxFile.appendBuffer(arrayBuffer);
            callback();
        }
        catch (err) {
            callback(err);
        }
    }
    _flush(callback) {
        const decoderInstance = this
            .symphoniaDecoder;
        if (decoderInstance) {
            decoderInstance.end(callback);
            return;
        }
        if (!this._aborted && this.mp4boxFile) {
            try {
                this.mp4boxFile.flush();
            }
            catch { }
        }
        const decoderInstanceAfter = this
            .symphoniaDecoder;
        if (decoderInstanceAfter) {
            decoderInstanceAfter.end(callback);
            return;
        }
        this._cleanupMp4Box();
        callback();
    }
    _destroy(err, callback) {
        this._aborted = true;
        this._cleanupMp4Box();
        this.headerChunks = [];
        if (this.symphoniaDecoder) {
            this.symphoniaDecoder.destroy();
            this.symphoniaDecoder = null;
        }
        super._destroy(err, callback);
    }
    _cleanupMp4Box() {
        if (this.mp4boxFile) {
            try {
                this.mp4boxFile.stop();
                this.mp4boxFile.flush();
            }
            catch { }
            this.mp4boxFile.onReady = null;
            this.mp4boxFile.onSamples = null;
            this.mp4boxFile.onError = null;
            this.mp4boxFile = null;
        }
    }
}
/**********************************************************************
 * ATENÇÃO: Não altere este trecho; ajustes aqui quebram a cadeia de decodificação.
 * WARNING: Do not edit this section; changes here will break the decoding pipeline.
 **********************************************************************/
class FMP4ToAACStream extends Transform {
    audioConfig;
    initSegmentProcessed;
    bufferMode;
    buffer;
    _streamState;
    constructor(options = {}) {
        super(options);
        this.audioConfig = null;
        this.initSegmentProcessed = false;
        this.bufferMode = options.bufferMode || false;
        this.buffer = EMPTY_BUFFER;
        this._streamState = null;
    }
    _compactBuffer() {
        if (this.buffer.length === 0) {
            this.buffer = EMPTY_BUFFER;
            return;
        }
        if (this.buffer.byteOffset > 0 &&
            (this.buffer.byteOffset >= 256 * 1024 ||
                this.buffer.buffer.byteLength > this.buffer.length * 4)) {
            this.buffer = Buffer.from(this.buffer);
        }
    }
    _parseBoxes(buffer, offset = 0) {
        const boxes = [];
        while (offset < buffer.length) {
            if (offset + 8 > buffer.length)
                break;
            const size = buffer.readUInt32BE(offset);
            const type = buffer.toString('ascii', offset + 4, offset + 8);
            if (size === 0 || size > buffer.length - offset)
                break;
            if (type === '\0\0\0\0')
                break;
            const boxData = buffer.subarray(offset + 8, offset + size);
            boxes.push({ type, size, data: boxData, offset });
            offset += size;
        }
        return boxes;
    }
    _extractAudioConfigFromInit(initSegment) {
        const boxes = this._parseBoxes(initSegment);
        const moovBox = boxes.find((b) => b.type === 'moov');
        if (!moovBox)
            return null;
        const moovBoxes = this._parseBoxes(moovBox.data);
        const trakBox = moovBoxes.find((b) => b.type === 'trak');
        if (!trakBox)
            return null;
        const trakBoxes = this._parseBoxes(trakBox.data);
        const mdiaBox = trakBoxes.find((b) => b.type === 'mdia');
        if (!mdiaBox)
            return null;
        const mdiaBoxes = this._parseBoxes(mdiaBox.data);
        const minfBox = mdiaBoxes.find((b) => b.type === 'minf');
        if (!minfBox)
            return null;
        const minfBoxes = this._parseBoxes(minfBox.data);
        const stblBox = minfBoxes.find((b) => b.type === 'stbl');
        if (!stblBox)
            return null;
        const stblBoxes = this._parseBoxes(stblBox.data);
        const stsdBox = stblBoxes.find((b) => b.type === 'stsd');
        if (!stsdBox)
            return null;
        const stsd = stsdBox.data;
        if (stsd.length < 16)
            return null;
        const stsdBoxes = this._parseBoxes(stsd, 8);
        const mp4aBox = stsdBoxes.find((b) => b.type === 'mp4a');
        if (!mp4aBox)
            return null;
        const mp4a = mp4aBox.data;
        if (mp4a.length < 28)
            return null;
        const channelCount = mp4a.readUInt16BE(16);
        const sampleRate = mp4a.readUInt32BE(24) >> 16;
        const sampleRates = [
            96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000,
            11025, 8000, 7350
        ];
        const samplingIndex = sampleRates.indexOf(sampleRate);
        return {
            profile: 2,
            samplingIndex: samplingIndex !== -1 ? samplingIndex : 4,
            channelCount,
            sampleRate
        };
    }
    _createAdtsHeader(sampleLength, audioConfig) {
        const adts = Buffer.alloc(7);
        const frameLength = sampleLength + 7;
        const profile = (audioConfig.profile || 2) - 1;
        const samplingIndex = audioConfig.samplingIndex || 4;
        const channelCount = audioConfig.channelCount || 2;
        adts[0] = 0xff;
        adts[1] = 0xf1;
        adts[2] =
            ((profile & 0x03) << 6) |
                ((samplingIndex & 0x0f) << 2) |
                ((channelCount & 0x04) >> 2);
        adts[3] = ((channelCount & 0x03) << 6) | ((frameLength & 0x1800) >> 11);
        adts[4] = (frameLength & 0x7f8) >> 3;
        adts[5] = ((frameLength & 0x7) << 5) | 0x1f;
        adts[6] = 0xfc;
        return adts;
    }
    _extractAACFromSegment(buffer) {
        if (!this.audioConfig)
            return null;
        const boxes = this._parseBoxes(buffer);
        const mdatBox = boxes.find((b) => b.type === 'mdat');
        if (!mdatBox)
            return null;
        const aacData = mdatBox.data;
        const moofBox = boxes.find((b) => b.type === 'moof');
        if (!moofBox)
            return aacData;
        const moofBoxes = this._parseBoxes(moofBox.data);
        const trafBox = moofBoxes.find((b) => b.type === 'traf');
        if (!trafBox)
            return aacData;
        const trafBoxes = this._parseBoxes(trafBox?.data || EMPTY_BUFFER);
        const trunBox = trafBoxes.find((b) => b.type === 'trun');
        if (!trunBox)
            return aacData;
        const trun = trunBox.data;
        if (trun.length < 8)
            return aacData;
        const flags = ((trun[1] ?? 0) << 16) | ((trun[2] ?? 0) << 8) | (trun[3] ?? 0);
        const sampleCount = trun.readUInt32BE(4);
        let offset = 8;
        if (flags & 0x1)
            offset += 4;
        if (flags & 0x4)
            offset += 4;
        const sampleSizes = [];
        const hasSampleSize = flags & 0x200;
        for (let i = 0; i < sampleCount && offset < trun.length; i++) {
            if (flags & 0x100)
                offset += 4;
            if (hasSampleSize && offset + 4 <= trun.length) {
                sampleSizes.push(trun.readUInt32BE(offset));
                offset += 4;
            }
            if (flags & 0x400)
                offset += 4;
            if (flags & 0x800)
                offset += 4;
        }
        if (sampleSizes.length > 0) {
            const validSampleSizes = [];
            let totalBytes = 0;
            let dataOffset = 0;
            for (const sampleSize of sampleSizes) {
                if (dataOffset + sampleSize <= aacData.length) {
                    validSampleSizes.push(sampleSize);
                    totalBytes += 7 + sampleSize;
                    dataOffset += sampleSize;
                }
            }
            if (validSampleSizes.length === 0)
                return null;
            const out = Buffer.allocUnsafe(totalBytes);
            let inOffset = 0;
            let outOffset = 0;
            for (const sampleSize of validSampleSizes) {
                const adtsHeader = this._createAdtsHeader(sampleSize, this.audioConfig);
                adtsHeader.copy(out, outOffset);
                outOffset += adtsHeader.length;
                aacData.copy(out, outOffset, inOffset, inOffset + sampleSize);
                outOffset += sampleSize;
                inOffset += sampleSize;
            }
            return out;
        }
        return null;
    }
    _processBuffer() {
        while (this.buffer.length > 0) {
            if (!this._streamState) {
                this._streamState = {
                    mode: 'READ_HEADER',
                    offset: 0,
                    boxSize: 0,
                    boxType: '',
                    headerSize: 8,
                    moofBuffer: EMPTY_BUFFER,
                    samples: []
                };
            }
            const state = this._streamState;
            if (state.mode === 'READ_HEADER') {
                if (this.buffer.length < 8) {
                    this._compactBuffer();
                    break;
                }
                const size32 = this.buffer.readUInt32BE(0);
                const type = this.buffer.toString('ascii', 4, 8);
                let size = size32;
                let headerSize = 8;
                if (size === 1) {
                    if (this.buffer.length < 16) {
                        this._compactBuffer();
                        break;
                    }
                    size = Number(this.buffer.readBigUInt64BE(8));
                    headerSize = 16;
                }
                if (size === 0 || (size < headerSize && size !== 0)) {
                    this.buffer = this.buffer.subarray(1);
                    continue;
                }
                state.boxSize = size;
                state.boxType = type;
                state.headerSize = headerSize;
                this.buffer = this.buffer.subarray(headerSize);
                state.boxSize -= headerSize;
                if (type === 'mdat') {
                    state.mode = 'STREAM_MDAT';
                }
                else {
                    state.mode = 'READ_BODY';
                }
            }
            else if (state.mode === 'READ_BODY') {
                if (this.buffer.length < state.boxSize) {
                    this._compactBuffer();
                    break;
                }
                const body = this.buffer.subarray(0, state.boxSize);
                this.buffer = this.buffer.subarray(state.boxSize);
                const type = state.boxType;
                if (type === 'moov') {
                    if (!this.initSegmentProcessed) {
                        const header = Buffer.alloc(8);
                        header.writeUInt32BE(body.length + 8, 0);
                        header.write('moov', 4);
                        const fullBox = Buffer.concat([header, body]);
                        const config = this._extractAudioConfigFromInit(fullBox);
                        if (config) {
                            this.audioConfig = config;
                            this.initSegmentProcessed = true;
                        }
                        else {
                            logger('warn', 'FMP4', 'Failed to extract audio config from moov');
                        }
                    }
                }
                else if (type === 'ftyp') {
                }
                else if (type === 'moof') {
                    const sizes = this._parseMoof(body);
                    if (sizes && sizes.length > 0) {
                        this._streamState.samples = sizes;
                    }
                    else {
                    }
                }
                this._streamState.mode = 'READ_HEADER';
            }
            else if (this._streamState.mode === 'STREAM_MDAT') {
                const samples = this._streamState.samples;
                if (samples.length === 0) {
                    const toSkip = Math.min(this.buffer.length, this._streamState.boxSize);
                    this.buffer = this.buffer.subarray(toSkip);
                    this._streamState.boxSize -= toSkip;
                }
                else {
                    while (samples.length > 0 &&
                        samples[0] !== undefined &&
                        this.buffer.length >= samples[0]) {
                        const sampleSize = samples[0];
                        const sampleData = this.buffer.subarray(0, sampleSize);
                        this.buffer = this.buffer.subarray(sampleSize);
                        if (this.audioConfig) {
                            const adts = this._createAdtsHeader(sampleSize, this.audioConfig);
                            this.push(adts);
                            this.push(_tightBuffer(sampleData));
                        }
                        this._streamState.boxSize -= sampleSize;
                        samples.shift();
                    }
                }
                if (this._streamState.boxSize <= 0) {
                    this._streamState.mode = 'READ_HEADER';
                    this._streamState.samples = [];
                }
                else if (samples.length > 0 &&
                    samples[0] !== undefined &&
                    this.buffer.length < samples[0]) {
                    this._compactBuffer();
                    break;
                }
            }
            this._compactBuffer();
        }
    }
    _parseMoof(moofData) {
        const boxes = this._parseBoxes(moofData);
        const trafs = boxes.filter((b) => b.type === 'traf');
        const sizes = [];
        for (const traf of trafs) {
            const trafBoxes = this._parseBoxes(traf.data);
            const tfhd = trafBoxes.find((b) => b.type === 'tfhd');
            if (!tfhd || tfhd.data.length < 8)
                continue;
            const trackId = tfhd.data.readUInt32BE(4);
            if (trafs.length > 1 &&
                this.audioConfig &&
                trackId !== this.audioConfig.trackId) {
                continue;
            }
            if (!this.audioConfig)
                continue;
            const tfhdData = tfhd.data;
            const tfhdFlags = ((tfhdData[1] ?? 0) << 16) |
                ((tfhdData[2] ?? 0) << 8) |
                (tfhdData[3] ?? 0);
            let currentDefaultSize = this.audioConfig.defaultSampleSize || 0;
            let offset = 8;
            if (tfhdFlags & 0x01)
                offset += 8;
            if (tfhdFlags & 0x02)
                offset += 4;
            if (tfhdFlags & 0x08)
                offset += 4;
            if (tfhdFlags & 0x10 && offset + 4 <= tfhdData.length) {
                currentDefaultSize = tfhdData.readUInt32BE(offset);
                offset += 4;
            }
            const truns = trafBoxes.filter((b) => b.type === 'trun');
            for (const trun of truns) {
                const data = trun.data;
                if (data.length < 8)
                    continue;
                const flags = ((data[1] ?? 0) << 16) | ((data[2] ?? 0) << 8) | (data[3] ?? 0);
                const count = data.readUInt32BE(4);
                let trunOffset = 8;
                if (flags & 0x01)
                    trunOffset += 4;
                if (flags & 0x04)
                    trunOffset += 4;
                const hasDuration = flags & 0x100;
                const hasSize = flags & 0x200;
                const hasFlags = flags & 0x400;
                const hasCtOffset = flags & 0x800;
                for (let i = 0; i < count; i++) {
                    let sSize = currentDefaultSize;
                    if (hasDuration)
                        trunOffset += 4;
                    if (hasSize && trunOffset + 4 <= data.length) {
                        sSize = data.readUInt32BE(trunOffset);
                        trunOffset += 4;
                    }
                    if (hasFlags)
                        trunOffset += 4;
                    if (hasCtOffset)
                        trunOffset += 4;
                    if (sSize > 0)
                        sizes.push(sSize);
                }
            }
        }
        return sizes;
    }
    _transform(chunk, _encoding, callback) {
        try {
            if (this.bufferMode) {
                if (this.buffer.length === 0)
                    this.buffer = chunk;
                else if (chunk.length > 0)
                    this.buffer = Buffer.concat([this.buffer, chunk], this.buffer.length + chunk.length);
                this._processBuffer();
            }
            else {
                if (!this.initSegmentProcessed && chunk.length > 8) {
                    const boxType = chunk.toString('ascii', 4, 8);
                    if (boxType === 'ftyp') {
                        this.audioConfig = this._extractAudioConfigFromInit(chunk);
                        this.initSegmentProcessed = true;
                        callback();
                        return;
                    }
                }
                if (this.audioConfig) {
                    const aacData = this._extractAACFromSegment(chunk);
                    if (aacData)
                        this.push(aacData);
                }
            }
            callback();
        }
        catch (_err) {
            callback();
        }
    }
    _flush(callback) {
        if (this.bufferMode) {
            try {
                this._processBuffer();
            }
            catch (_err) { }
        }
        this.buffer = EMPTY_BUFFER;
        this._streamState = null;
        callback();
    }
    _destroy(err, callback) {
        this.buffer = EMPTY_BUFFER;
        this._streamState = null;
        super._destroy(err, callback);
    }
}
class FLVToAACStream extends Transform {
    demuxer;
    audioConfig;
    _aborted;
    constructor(options = {}) {
        super(options);
        this.demuxer = new FlvDemuxer();
        this.audioConfig = null;
        this._aborted = false;
        this.demuxer.on('data', (audioTag) => {
            if (this._aborted)
                return;
            this._processAudioTag(audioTag);
        });
        this.demuxer.on('error', (err) => {
            if (!this._aborted)
                this.emit('error', err);
        });
    }
    abort() {
        this._aborted = true;
        this.demuxer.destroy();
    }
    _processAudioTag(tag) {
        const header = tag[0] ?? 0;
        const format = (header & 0xf0) >> 4;
        if (format === 10) {
            const aacPacketType = tag[1];
            if (aacPacketType === 0) {
                this.audioConfig = this._parseAudioSpecificConfig(tag.subarray(2));
            }
            else if (aacPacketType === 1 && this.audioConfig) {
                const adtsHeader = _createAdtsHeader(tag.length - 2, this.audioConfig.profile || 2, this.audioConfig.samplingIndex || 4, this.audioConfig.channelCount || 2);
                this.push(adtsHeader);
                this.push(_tightBuffer(tag.subarray(2)));
            }
        }
        else if (format === 2) {
            this.push(_tightBuffer(tag.subarray(1)));
        }
    }
    _parseAudioSpecificConfig(data) {
        const objectType = ((data[0] ?? 0) & 0xf8) >> 3;
        const samplingIndex = (((data[0] ?? 0) & 0x07) << 1) | (((data[1] ?? 0) & 0x80) >> 7);
        const channelConfig = ((data[1] ?? 0) & 0x78) >> 3;
        return {
            profile: objectType,
            samplingIndex,
            channelCount: channelConfig
        };
    }
    _transform(chunk, encoding, callback) {
        this.demuxer.write(chunk, encoding, callback);
    }
    _flush(callback) {
        this.demuxer.end(callback);
    }
}
class StreamAudioResource extends BaseAudioResource {
    nodelink;
    frameCounter = null;
    constructor(guildId, stream, type, nodelink, initialFilters = {}, volume = 1.0, audioMixer = null, returnPCM = false, enableAGC = true, enableCrossfade = false) {
        super(guildId);
        this.nodelink = nodelink;
        this._validateInputStream(stream);
        const resamplingQuality = nodelink.options.playback.audio?.resamplingQuality || 'fastest';
        const normalizedType = normalizeFormat(type);
        this.pipes = [stream];
        const pcmStream = this._createDecoderPipeline(stream, type, normalizedType, resamplingQuality);
        if (returnPCM) {
            this._createPCMOutputPipeline(pcmStream, volume, enableAGC);
        }
        else {
            this._createOutputPipeline(pcmStream, nodelink, initialFilters, volume, audioMixer, enableAGC, enableCrossfade);
        }
        this._setupEventHandlers(stream);
    }
    _validateInputStream(stream) {
        if (!stream || !(stream instanceof Readable)) {
            throw new Error('Invalid stream provided');
        }
    }
    _createDecoderPipeline(stream, type, normalizedType, resamplingQuality) {
        if (type === 'pcm')
            return stream;
        switch (normalizedType) {
            case SupportedFormats.AAC:
                return this._createAACPipeline(stream, type, resamplingQuality);
            case SupportedFormats.FLV:
                return this._createFLVPipeline(stream, type, resamplingQuality);
            case SupportedFormats.MPEG:
            case SupportedFormats.FLAC:
            case SupportedFormats.OGG_VORBIS:
            case SupportedFormats.WAV:
            case SupportedFormats.ALAC:
                return this._createSymphoniaPipeline(stream, type);
            case SupportedFormats.OPUS:
                return this._createOpusPipeline(stream, type);
            default:
                throw this._createUnsupportedFormatError(type);
        }
    }
    _createFLVPipeline(stream, _type, resamplingQuality) {
        const demuxer = new FLVToAACStream();
        const decoder = new AACDecoderStream({
            resamplingQuality: resamplingQuality
        });
        this.pipes?.push(demuxer, decoder);
        pipeline(stream, demuxer, decoder, (err) => {
            if (err && !this._destroyed) {
                this.stream?.emit('error', err);
            }
        });
        return decoder;
    }
    _createAACPipeline(stream, type, resamplingQuality) {
        const lowerType = type.toLowerCase();
        const _aacStream = stream;
        const streams = [stream];
        const state = { isAlac: false };
        if (_isFmp4Format(lowerType)) {
            const bufferMode = lowerType.includes('fmp4-buffered');
            const demuxer = new FMP4ToAACStream({ bufferMode });
            streams.push(demuxer);
        }
        else if (_isMpegtsFormat(lowerType)) {
            const demuxer = new MPEGTSDemuxer();
            streams.push(demuxer);
            if (lowerType.includes('mp3') || lowerType.includes('mpeg')) {
                const decoder = new SymphoniaDecoderStream({
                    codecRegistryHint: _getSymphoniaCodecHint(lowerType)
                });
                streams.push(decoder);
                this.pipes?.push(...streams.slice(1));
                pipeline(streams, (err) => {
                    if (err && !this._destroyed) {
                        this.stream?.emit('error', err);
                    }
                });
                return decoder;
            }
        }
        else if (_isMp4Format(lowerType)) {
            const seekOpts = stream.__mp4SeekOptions;
            const demuxer = new MP4ToAACStream(seekOpts
                ? {
                    prefetch: seekOpts.prefetch,
                    baseFileStart: seekOpts.baseFileStart,
                    seekTimeSec: seekOpts.seekTimeSec,
                    state
                }
                : { state });
            streams.push(demuxer);
        }
        const decoder = new AACDecoderStream({
            resamplingQuality: resamplingQuality,
            state
        });
        streams.push(decoder);
        this.pipes?.push(...streams.slice(1));
        pipeline(streams, (err) => {
            if (err && !this._destroyed) {
                this.stream?.emit('error', err);
            }
        });
        return decoder;
    }
    _createSymphoniaPipeline(stream, type) {
        const decoder = new SymphoniaDecoderStream({
            codecRegistryHint: _getSymphoniaCodecHint(type)
        });
        this.pipes?.push(decoder);
        pipeline(stream, decoder, (err) => {
            if (err && !this._destroyed) {
                this.stream?.emit('error', err);
            }
        });
        return decoder;
    }
    _createOpusPipeline(stream, type) {
        const decoder = new OpusDecoder({
            rate: AUDIO_CONFIG.sampleRate,
            channels: AUDIO_CONFIG.channels
        });
        const streams = [stream];
        if (_isWebmFormat(type.toLowerCase())) {
            const demuxer = new WebmOpusDemuxer();
            streams.push(demuxer);
            this.pipes?.push(demuxer);
        }
        streams.push(decoder);
        this.pipes?.push(decoder);
        pipeline(streams, (err) => {
            if (err && !this._destroyed) {
                this.stream?.emit('error', err);
            }
        });
        return decoder;
    }
    _createOutputPipeline(pcmStream, nodelink, initialFilters, volume, audioMixer = null, enableAGC = true, enableCrossfade = false) {
        const frameCounter = new PCMFrameCounter(AUDIO_CONFIG.sampleRate, AUDIO_CONFIG.channels);
        this.frameCounter = frameCounter; // Saves the reference to get the time later
        const filters = new FiltersManager(nodelink, initialFilters);
        const volumeTransformer = new VolumeTransformer({
            type: 's16le',
            volume,
            enableAGC,
            lookaheadMs: nodelink.options.playback.audio?.lookaheadMs,
            gateThresholdLUFS: nodelink.options.playback.audio?.gateThresholdLUFS
        });
        const fadeTransformer = new FadeTransformer({
            type: 's16le',
            volume: 1.0,
            sampleRate: AUDIO_CONFIG.sampleRate,
            channels: AUDIO_CONFIG.channels
        });
        const tapeTransformer = new TapeTransformer({
            sampleRate: AUDIO_CONFIG.sampleRate,
            channels: AUDIO_CONFIG.channels
        });
        const scratchTransformer = new ScratchTransformer({
            sampleRate: AUDIO_CONFIG.sampleRate,
            channels: AUDIO_CONFIG.channels
        });
        const silenceDetector = new SilenceDetector({
            sampleRate: AUDIO_CONFIG.sampleRate,
            channels: AUDIO_CONFIG.channels,
            thresholdDb: nodelink.options.playback.audio?.automix?.silenceThresholdDb ?? -40
        });
        const flowController = new FlowController(volumeTransformer, fadeTransformer, tapeTransformer, scratchTransformer, audioMixer);
        const opusEncoder = new OpusEncoder({
            rate: AUDIO_CONFIG.sampleRate,
            channels: AUDIO_CONFIG.channels
        });
        opusEncoder.setDTX(false);
        const streams = [pcmStream];
        if (enableCrossfade) {
            const crossfadeController = new CrossfadeController();
            crossfadeController.on('bridgeStart', () => {
                this.canStop = false;
            });
            crossfadeController.on('bridgeEnd', () => {
                if (this._destroyed)
                    return;
                this.canStop = true;
                this._finishBufferingEmitted = true;
                this.stream?.emit('finishBuffering');
            });
            streams.push(crossfadeController);
            this.pipes?.push(crossfadeController);
        }
        streams.push(frameCounter, silenceDetector, filters, flowController);
        this.pipes?.push(frameCounter, silenceDetector, filters, flowController);
        if (nodelink.extensions?.audioInterceptors) {
            for (const interceptorFactory of nodelink.extensions.audioInterceptors) {
                try {
                    const interceptorStream = interceptorFactory();
                    if (interceptorStream) {
                        streams.push(interceptorStream);
                        this.pipes?.push(interceptorStream);
                    }
                }
                catch (e) {
                    logger('error', 'StreamProcessor', `Audio interceptor error: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
        }
        streams.push(opusEncoder);
        this.pipes?.push(opusEncoder);
        pipeline(streams, (err) => {
            if (err && !this._destroyed) {
                opusEncoder.emit('error', err);
            }
        });
        this._assignStream(opusEncoder);
    }
    getConsumedMs() {
        return this.frameCounter?.getConsumedMs() ?? 0;
    }
    getMainEnergy() {
        return null;
    }
    getEffectiveRate() {
        const filters = this.pipes?.find((p) => p instanceof FiltersManager);
        const flowController = this.pipes?.find((p) => p instanceof FlowController);
        return ((filters?.getRate() ?? 1.0) * (flowController?.getEffectiveRate() ?? 1.0));
    }
    checkTapeRampCompleted() {
        if (!this.pipes)
            return false;
        const flowController = this.pipes.find((p) => p instanceof FlowController);
        return flowController?.checkTapeRampCompleted() ?? false;
    }
    checkScratchEffectCompleted() {
        if (!this.pipes)
            return false;
        const flowController = this.pipes.find((p) => p instanceof FlowController);
        return flowController?.checkScratchEffectCompleted() ?? false;
    }
    tapeTo(durationMs, type, curve) {
        if (!this.pipes)
            return;
        const flowController = this.pipes.find((p) => p instanceof FlowController);
        if (flowController) {
            flowController.tapeTo(durationMs, type, curve);
        }
    }
    scratchTo(durationMs, style) {
        if (!this.pipes)
            return;
        const flowController = this.pipes.find((p) => p instanceof FlowController);
        if (flowController) {
            flowController.scratchTo(durationMs, style);
        }
    }
    setLoudnessNormalizer(enabled) {
        if (!this.pipes)
            return;
        const volumeTransformer = this.pipes.find((p) => p instanceof VolumeTransformer);
        if (volumeTransformer) {
            volumeTransformer.setAGCEnabled(enabled);
            return;
        }
        const flowController = this.pipes.find((p) => p instanceof FlowController);
        if (flowController) {
            flowController.setLoudnessNormalizer(enabled);
        }
    }
    _createPCMOutputPipeline(pcmStream, volume, enableAGC = true) {
        if (volume !== 1.0 || enableAGC) {
            const volumeTransformer = new VolumeTransformer({
                type: 's16le',
                volume,
                enableAGC,
                lookaheadMs: this.nodelink?.options?.audio?.lookaheadMs,
                gateThresholdLUFS: this.nodelink?.options?.audio?.gateThresholdLUFS
            });
            pipeline(pcmStream, volumeTransformer, (err) => {
                if (err && !this._destroyed) {
                    volumeTransformer.emit('error', err);
                }
            });
            this._assignStream(volumeTransformer);
        }
        else {
            this._assignStream(pcmStream);
        }
    }
    _setupEventHandlers(inputStream) {
        const forwardFinishBuffering = () => {
            if (this.getCrossfadeState().isBridging)
                return;
            if (!this._destroyed) {
                this._finishBufferingEmitted = true;
                this.stream?.emit('finishBuffering');
            }
        };
        this._forwardFinishBuffering = forwardFinishBuffering;
        inputStream.on('finishBuffering', forwardFinishBuffering);
        const wrappedSource = inputStream._sourceStream;
        wrappedSource?.on?.('finishBuffering', forwardFinishBuffering);
        inputStream.on('error', (err) => {
            this.stream?.emit('error', err);
        });
        if (this.pipes) {
            for (const pipe of this.pipes) {
                if (pipe !== this.stream) {
                    pipe.on?.('error', (err) => {
                        this.stream?.emit('error', err);
                    });
                }
            }
        }
        if (this.stream) {
            this.stream.on('error', () => {
                this._end();
            });
        }
    }
    _createUnsupportedFormatError(type) {
        const supportedFormats = [
            'MP3 (audio/mpeg)',
            'AAC (audio/aac, audio/aacp, video/quicktime, mp4, m4a, m4v, mov, hls, mpegurl, fmp4, mpegts)',
            'FLAC (audio/flac)',
            'OGG Vorbis (audio/ogg, audio/vorbis)',
            'WAV (audio/wav)',
            'Opus (webm/opus, ogg/opus, webm, weba)',
            'FLV (video/x-flv, flv)'
        ];
        return new Error(`Unsupported audio format: '${type}'.\n` +
            'Supported formats:\n' +
            supportedFormats.map((f) => `  • ${f}`).join('\n'));
    }
}
export const createAudioResource = (guildId, stream, type, nodelink, initialFilters = {}, volume = 1.0, audioMixer = null, returnPCM = false, enableAGC = true, enableCrossfade = false) => new StreamAudioResource(guildId, stream, type, nodelink, initialFilters, volume, audioMixer, returnPCM, enableAGC, enableCrossfade);
export const createSeekeableAudioResource = async (guildId, url, seekTime, endTime, nodelink, initialFilters, player, volume = 1.0, audioMixer = null, returnPCM = false, enableAGC = true, enableCrossfade = false) => {
    try {
        const hinted = String(player.streamInfo?.format ?? '').toLowerCase();
        const ext = _extFromUrl(url);
        const containerGuess = hinted || ext;
        const seekProxy = _extractSeekProxy(player.streamInfo);
        logger('debug', 'StreamProcessor', `createSeekeableAudioResource called for ${url} | seekTime: ${seekTime}ms | containerGuess: ${containerGuess}`);
        if (_isMp4Format(containerGuess)) {
            const mp4Seek = await _buildMp4SeekOptions(url, seekTime, seekProxy);
            const ranged = await _openRangeStream(url, mp4Seek.baseFileStart ?? 0, seekProxy);
            const passthroughStream = new PassThrough({
                highWaterMark: AUDIO_CONFIG.highWaterMark
            });
            passthroughStream.__mp4SeekOptions = mp4Seek;
            passthroughStream.once('finish', () => {
                passthroughStream.emit('finishBuffering');
            });
            pipeline(ranged, passthroughStream, (err) => {
                if (err)
                    passthroughStream.emit('error', err);
            });
            const format = hinted || (ext ? ext : 'm4a');
            return new StreamAudioResource(guildId, passthroughStream, format, nodelink, initialFilters, volume, audioMixer, returnPCM, returnPCM ? true : (player.loudnessNormalizer ?? enableAGC), enableCrossfade);
        }
        const { stream, meta } = (await seekableStream(url, seekTime, endTime, {}, _createSeekableProxyRequest(seekProxy)));
        const passthroughStream = new PassThrough({
            highWaterMark: AUDIO_CONFIG.highWaterMark
        });
        passthroughStream.once('finish', () => {
            passthroughStream.emit('finishBuffering');
        });
        pipeline(stream, passthroughStream, (err) => {
            if (err)
                passthroughStream.emit('error', err);
        });
        const format = meta.codec?.container || player.streamInfo?.format;
        return new StreamAudioResource(guildId, passthroughStream, format, nodelink, initialFilters, volume, audioMixer, returnPCM, returnPCM ? true : (player.loudnessNormalizer ?? enableAGC), enableCrossfade);
    }
    catch (err) {
        const cause = err instanceof SeekError ? err.code : 'UNKNOWN';
        return _createErrorResponse(err.message, cause);
    }
};
export const createPCMStream = (_guildId, stream, type, nodelink, volume = 1.0, filters = {}) => {
    const resamplingQuality = nodelink.options.playback.audio?.resamplingQuality || 'fastest';
    const normalizedType = normalizeFormat(type);
    const streams = [stream];
    switch (normalizedType) {
        case SupportedFormats.AAC: {
            const lowerType = type.toLowerCase();
            const state = { isAlac: false };
            if (_isFmp4Format(lowerType)) {
                const bufferMode = lowerType.includes('fmp4-buffered');
                streams.push(new FMP4ToAACStream({ bufferMode }));
            }
            else if (_isMpegtsFormat(lowerType)) {
                streams.push(new MPEGTSDemuxer());
                if (lowerType.includes('mp3') || lowerType.includes('mpeg')) {
                    streams.push(new SymphoniaDecoderStream({
                        codecRegistryHint: _getSymphoniaCodecHint(lowerType)
                    }));
                    break;
                }
            }
            else if (_isMp4Format(lowerType))
                streams.push(new MP4ToAACStream({ state }));
            streams.push(new AACDecoderStream({
                resamplingQuality: resamplingQuality,
                state
            }));
            break;
        }
        case SupportedFormats.FLV: {
            streams.push(new FLVToAACStream());
            streams.push(new AACDecoderStream({
                resamplingQuality: resamplingQuality
            }));
            break;
        }
        case SupportedFormats.MPEG:
        case SupportedFormats.FLAC:
        case SupportedFormats.OGG_VORBIS:
        case SupportedFormats.WAV:
        case SupportedFormats.ALAC: {
            streams.push(new SymphoniaDecoderStream({
                codecRegistryHint: _getSymphoniaCodecHint(type)
            }));
            break;
        }
        case SupportedFormats.OPUS: {
            if (_isWebmFormat(type.toLowerCase())) {
                streams.push(new WebmOpusDemuxer());
            }
            streams.push(new OpusDecoder({
                rate: AUDIO_CONFIG.sampleRate,
                channels: AUDIO_CONFIG.channels
            }));
            break;
        }
        default:
            throw new Error(`Unsupported audio format: '${type}'`);
    }
    streams.push(new VolumeTransformer({ type: 's16le', volume }));
    streams.push(new FiltersManager(nodelink, filters));
    for (const s of streams) {
        if (s !== stream) {
            ;
            s.on('error', (err) => logger('error', 'PCMStream', `Component error (${s.constructor.name}): ${err.message} (${err.code})`));
        }
    }
    pipeline(streams, (err) => {
        if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
            logger('error', 'PCMStream', `Internal processing pipeline failed: ${err.message}`);
        }
    });
    return streams[streams.length - 1];
};
