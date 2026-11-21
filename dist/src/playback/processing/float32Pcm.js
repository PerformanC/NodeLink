/**
 * Isolated PCM primitives for the opt-in Protected processing path.
 * This module is not connected to the production playback pipeline.
 */
const INT16_BYTES = 2;
const FLOAT32_BYTES = 4;
const MAX_PUBLIC_VOLUME = 1000;
const assertPcmBuffer = (data, bytesPerSample, name) => {
    if (!Buffer.isBuffer(data))
        throw new TypeError(`${name} must be a Buffer`);
    if (data.length % bytesPerSample !== 0) {
        throw new RangeError(`${name} length must be aligned to ${bytesPerSample}-byte samples`);
    }
};
const assertFiniteFloatSamples = (data) => {
    for (let offset = 0; offset < data.length; offset += FLOAT32_BYTES) {
        if (!Number.isFinite(data.readFloatLE(offset))) {
            throw new RangeError(`Float32 PCM contains a non-finite sample at byte offset ${offset}`);
        }
    }
};
/** Convert little-endian signed 16-bit PCM to little-endian Float32 PCM. */
export function int16PcmToFloat32Pcm(input) {
    assertPcmBuffer(input, INT16_BYTES, 'Int16 PCM');
    const output = Buffer.allocUnsafe((input.length / INT16_BYTES) * FLOAT32_BYTES);
    for (let sourceOffset = 0, targetOffset = 0; sourceOffset < input.length; sourceOffset += INT16_BYTES, targetOffset += FLOAT32_BYTES) {
        output.writeFloatLE(input.readInt16LE(sourceOffset) / 32768, targetOffset);
    }
    return output;
}
/**
 * Convert Float32 PCM to signed 16-bit PCM. This is a terminal conversion:
 * values outside [-1, 1) are saturated to the Int16 range here.
 */
export function float32PcmToInt16Pcm(input) {
    assertPcmBuffer(input, FLOAT32_BYTES, 'Float32 PCM');
    assertFiniteFloatSamples(input);
    const output = Buffer.allocUnsafe((input.length / FLOAT32_BYTES) * INT16_BYTES);
    for (let sourceOffset = 0, targetOffset = 0; sourceOffset < input.length; sourceOffset += FLOAT32_BYTES, targetOffset += INT16_BYTES) {
        const sample = input.readFloatLE(sourceOffset);
        const integer = sample <= -1 ? -32768 : sample >= 1 ? 32767 : Math.round(sample * 32768);
        output.writeInt16LE(integer, targetOffset);
    }
    return output;
}
/** Convert the public 0-1000 volume scale to its linear multiplier. */
export function publicVolumeToLinearGain(volume) {
    if (!Number.isFinite(volume) || volume < 0 || volume > MAX_PUBLIC_VOLUME) {
        throw new RangeError(`Volume must be between 0 and ${MAX_PUBLIC_VOLUME}`);
    }
    return volume / 100;
}
/** Apply a finite nonnegative linear gain while preserving Float32 headroom. */
export function applyFloat32LinearGain(input, gain) {
    assertPcmBuffer(input, FLOAT32_BYTES, 'Float32 PCM');
    if (!Number.isFinite(gain) || gain < 0) {
        throw new RangeError('Linear gain must be a finite nonnegative number');
    }
    assertFiniteFloatSamples(input);
    const output = Buffer.allocUnsafe(input.length);
    for (let offset = 0; offset < input.length; offset += FLOAT32_BYTES) {
        const result = input.readFloatLE(offset) * gain;
        if (!Number.isFinite(result) || Math.abs(result) > 3.4028234663852886e38) {
            throw new RangeError(`Float32 gain overflow at byte offset ${offset}`);
        }
        output.writeFloatLE(result, offset);
    }
    return output;
}
