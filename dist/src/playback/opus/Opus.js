import { createRequire } from 'node:module';
import { Transform } from 'node:stream';
import { bufferPool } from "../structs/BufferPool.js";
const require = createRequire(import.meta.url);
const OPUS_CTL = {
    BITRATE: 4002,
    FEC: 4012,
    PLP: 4014,
    DTX: 4016
};
let ACTIVE_LIB = null;
const _getLib = () => {
    if (ACTIVE_LIB)
        return ACTIVE_LIB;
    const libs = [
        // biome-ignore lint: TypeScript requires bracket access for index signatures
        { name: '@toddynnn/voice-opus', pick: (m) => m['OpusEncoder'] },
        // biome-ignore lint: TypeScript requires bracket access for index signatures
        { name: 'toddy-mediaplex', pick: (m) => m['OpusEncoder'] },
        // biome-ignore lint: TypeScript requires bracket access for index signatures
        { name: '@discordjs/opus', pick: (m) => m['OpusEncoder'] },
        { name: 'opusscript', pick: (m) => m }
    ];
    for (const l of libs) {
        try {
            const mod = require(l.name);
            const Encoder = l.pick(mod);
            if (typeof Encoder === 'function') {
                ACTIVE_LIB = { name: l.name, Encoder };
                return ACTIVE_LIB;
            }
        }
        catch (e) {
            if (e instanceof Error &&
                // biome-ignore lint/complexity/useLiteralKeys: index signature requires bracket access
                e['code'] !== 'MODULE_NOT_FOUND')
                throw e;
        }
    }
    throw new Error('No compatible Opus library found.');
};
const _createInstance = (rate, channels, app) => {
    const lib = _getLib();
    const { name, Encoder } = lib;
    let type = app;
    if (name === 'opusscript' && typeof app === 'string') {
        type =
            Encoder.Application[app.toUpperCase()] ??
                // biome-ignore lint/complexity/useLiteralKeys: index signature requires bracket access
                Encoder.Application['VOIP'] ??
                2048;
    }
    return { instance: new Encoder(rate, channels, type), lib };
};
const _applyCtl = (enc, _libName, id, val) => {
    if (!enc)
        throw new Error('Encoder not ready.');
    if (id === OPUS_CTL.BITRATE) {
        enc.setBitrate(val);
        return;
    }
    const fn = enc.applyEncoderCTL || enc.applyEncoderCtl || enc.encoderCTL;
    if (typeof fn === 'function')
        fn.call(enc, id, val);
};
export class Encoder extends Transform {
    enc;
    lib;
    frameSize;
    frameBytes;
    leftover;
    constructor({ rate = 48000, channels = 2, frameSize = 960, application = 'audio' } = {}) {
        super({ readableObjectMode: true });
        const { instance, lib } = _createInstance(rate, channels, application);
        this.enc = instance;
        this.lib = lib;
        this.frameSize = frameSize;
        this.frameBytes = frameSize * channels * 2;
        this.leftover = null;
    }
    _transform(chunk, _encoding, cb) {
        if (!chunk?.length) {
            cb();
            return;
        }
        if (!this.enc) {
            cb(new Error('Encoder destroyed.'));
            return;
        }
        let buf;
        let pooledBuf = null;
        if (this.leftover?.length) {
            const totalLen = this.leftover.length + chunk.length;
            pooledBuf = bufferPool.acquire(totalLen);
            this.leftover.copy(pooledBuf, 0);
            chunk.copy(pooledBuf, this.leftover.length);
            bufferPool.release(this.leftover);
            this.leftover = null;
            buf = pooledBuf;
        }
        else {
            buf = chunk;
        }
        const frames = Math.floor(buf.length / this.frameBytes);
        const consumed = frames * this.frameBytes;
        for (let i = 0; i < frames; i++) {
            const off = i * this.frameBytes;
            const frame = buf.subarray(off, off + this.frameBytes);
            try {
                const encoded = this.lib.name === 'opusscript'
                    ? this.enc.encode(frame, this.frameSize)
                    : this.enc.encode(frame);
                this.push(encoded);
            }
            catch (e) {
                this.leftover = null;
                if (pooledBuf)
                    bufferPool.release(pooledBuf);
                cb(e instanceof Error ? e : new Error(String(e)));
                return;
            }
        }
        if (consumed < buf.length) {
            const remaining = buf.subarray(consumed);
            this.leftover = bufferPool.acquire(remaining.length);
            remaining.copy(this.leftover, 0, 0, remaining.length);
        }
        // Release the temporary concatenation buffer back to the pool
        if (pooledBuf)
            bufferPool.release(pooledBuf);
        cb();
    }
    _flush(cb) {
        if (this.leftover) {
            bufferPool.release(this.leftover);
            this.leftover = null;
        }
        cb();
    }
    _destroy(err, cb) {
        if (this.lib.name === 'opusscript' && this.enc && this.enc.delete) {
            this.enc.delete();
        }
        this.enc = null;
        if (this.leftover) {
            bufferPool.release(this.leftover);
            this.leftover = null;
        }
        cb(err);
    }
    setBitrate(v) {
        const val = v < 500 ? 500 : v > 512000 ? 512000 : v;
        if (this.enc)
            _applyCtl(this.enc, this.lib.name, OPUS_CTL.BITRATE, val);
    }
    setFEC(enabled = true) {
        if (this.enc)
            _applyCtl(this.enc, this.lib.name, OPUS_CTL.FEC, enabled ? 1 : 0);
    }
    setPLP(percent) {
        const p = percent <= 1 ? percent * 100 : percent;
        const val = p < 0 ? 0 : p > 100 ? 100 : Math.round(p);
        if (this.enc)
            _applyCtl(this.enc, this.lib.name, OPUS_CTL.PLP, val);
    }
    setDTX(enabled = false) {
        if (this.enc)
            _applyCtl(this.enc, this.lib.name, OPUS_CTL.DTX, enabled ? 1 : 0);
    }
}
export class Decoder extends Transform {
    dec;
    lib;
    constructor({ rate = 48000, channels = 2 } = {}) {
        super({ readableObjectMode: false });
        const { instance, lib } = _createInstance(rate, channels, 'voip');
        this.dec = instance;
        this.lib = lib;
    }
    _transform(chunk, _encoding, cb) {
        try {
            if (!this.dec)
                throw new Error('Decoder not ready.');
            this.push(this.dec.decode(chunk));
            cb();
        }
        catch (e) {
            cb(e instanceof Error ? e : new Error(String(e)));
        }
    }
    _destroy(err, cb) {
        if (this.lib.name === 'opusscript' && this.dec && this.dec.delete) {
            this.dec.delete();
        }
        this.dec = null;
        cb(err);
    }
}
