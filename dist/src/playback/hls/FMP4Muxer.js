import { Buffer } from 'node:buffer';
/**
 * Builds an MP4 ISO base box (size + type + payload).
 */
function box(type, ...payloads) {
    let payloadLen = 0;
    for (const p of payloads) {
        payloadLen += p.length;
    }
    const size = 8 + payloadLen;
    const header = Buffer.allocUnsafe(8);
    header.writeUInt32BE(size, 0);
    header.write(type, 4, 4, 'ascii');
    return Buffer.concat([header, ...payloads], size);
}
/**
 * Creates the ftyp box for an fMP4 CMAF initialization segment.
 */
function createFtypBox() {
    const b = Buffer.allocUnsafe(24);
    b.write('iso8', 0, 4, 'ascii');
    b.writeUInt32BE(1, 4);
    b.write('iso8', 8, 4, 'ascii');
    b.write('mp41', 12, 4, 'ascii');
    b.write('cmfc', 16, 4, 'ascii');
    b.write('dash', 20, 4, 'ascii');
    return box('ftyp', b);
}
/**
 * Creates the mvhd box with audio timescale.
 */
function createMvhdBox(timescale) {
    const b = Buffer.alloc(100);
    b.writeUInt32BE(timescale, 12);
    b.writeUInt32BE(0x00010000, 20);
    b.writeUInt16BE(0x0100, 24);
    b.writeUInt32BE(0x00010000, 36);
    b.writeUInt32BE(0x00010000, 52);
    b.writeUInt32BE(0x40000000, 68);
    b.writeUInt32BE(2, 96);
    return box('mvhd', b);
}
/**
 * Creates the trex box inside mvex.
 */
function createTrexBox(defaultDuration) {
    const b = Buffer.alloc(24);
    b.writeUInt32BE(1, 4);
    b.writeUInt32BE(1, 8);
    b.writeUInt32BE(defaultDuration, 12);
    b.writeUInt32BE(0x02000000, 20);
    return box('trex', b);
}
/**
 * Creates the tkhd box for audio track 1.
 */
function createTkhdBox() {
    const b = Buffer.alloc(84);
    b.writeUInt32BE(0x00000007, 0);
    b.writeUInt32BE(1, 12);
    b.writeUInt16BE(0x0100, 36);
    b.writeUInt32BE(0x00010000, 40);
    b.writeUInt32BE(0x00010000, 56);
    b.writeUInt32BE(0x40000000, 72);
    return box('tkhd', b);
}
/**
 * Creates the mdhd box.
 */
function createMdhdBox(timescale) {
    const b = Buffer.alloc(24);
    b.writeUInt32BE(timescale, 12);
    b.writeUInt16BE(0x55c4, 20);
    return box('mdhd', b);
}
/**
 * Creates the hdlr box for audio.
 */
function createHdlrBox() {
    const b = Buffer.alloc(37);
    b.write('soun', 8, 4, 'ascii');
    b.write('SoundHandler\0', 24, 13, 'ascii');
    return box('hdlr', b);
}
/**
 * Creates the smhd box.
 */
function createSmhdBox() {
    const b = Buffer.alloc(8);
    return box('smhd', b);
}
/**
 * Creates the dinf box with standard dref table.
 */
function createDinfBox() {
    const urlBox = box('url ', Buffer.from([0, 0, 0, 1]));
    const drefPayload = Buffer.alloc(8);
    drefPayload.writeUInt32BE(1, 4);
    const drefBox = box('dref', drefPayload, urlBox);
    return box('dinf', drefBox);
}
/**
 * Creates the stsd box with Opus audio sample description and dOps descriptor.
 */
function createStsdBox(channels, sampleRate, preSkip) {
    const dOpsPayload = Buffer.alloc(11);
    dOpsPayload.writeUInt8(0, 0);
    dOpsPayload.writeUInt8(channels, 1);
    dOpsPayload.writeUInt16BE(preSkip, 2);
    dOpsPayload.writeUInt32BE(sampleRate, 4);
    dOpsPayload.writeInt16BE(0, 8);
    dOpsPayload.writeUInt8(0, 10);
    const dOpsBox = box('dOps', dOpsPayload);
    const opusHeader = Buffer.alloc(28);
    opusHeader.writeUInt16BE(1, 6);
    opusHeader.writeUInt16BE(channels, 16);
    opusHeader.writeUInt16BE(16, 18);
    opusHeader.writeUInt32BE((sampleRate * 65536) >>> 0, 24);
    const opusEntry = box('Opus', opusHeader, dOpsBox);
    const stsdPayload = Buffer.alloc(8);
    stsdPayload.writeUInt32BE(1, 4);
    return box('stsd', stsdPayload, opusEntry);
}
/**
 * Creates empty table boxes (stts, stsc, stco).
 */
function createEmptyTableBox(type) {
    const b = Buffer.alloc(8);
    return box(type, b);
}
/**
 * Creates empty stsz box.
 */
function createStszBox() {
    const b = Buffer.alloc(12);
    return box('stsz', b);
}
/**
 * Creates the stbl box for Opus audio.
 */
function createStblBox(channels, sampleRate, preSkip) {
    return box('stbl', createStsdBox(channels, sampleRate, preSkip), createEmptyTableBox('stts'), createEmptyTableBox('stsc'), createStszBox(), createEmptyTableBox('stco'));
}
/**
 * Generates an fMP4 CMAF initialization segment (`init.mp4`) containing ftyp and moov boxes.
 *
 * @param config - Audio and Opus format parameters.
 * @returns Self-contained initialization segment buffer.
 */
export function createInitSegment(config) {
    const sampleRate = config?.sampleRate ?? 48000;
    const channels = config?.channels ?? 2;
    const frameSize = config?.frameSize ?? 960;
    const preSkip = config?.preSkip ?? 312;
    const ftyp = createFtypBox();
    const mvhd = createMvhdBox(sampleRate);
    const trex = createTrexBox(frameSize);
    const mvex = box('mvex', trex);
    const tkhd = createTkhdBox();
    const mdhd = createMdhdBox(sampleRate);
    const hdlr = createHdlrBox();
    const smhd = createSmhdBox();
    const dinf = createDinfBox();
    const stbl = createStblBox(channels, sampleRate, preSkip);
    const minf = box('minf', smhd, dinf, stbl);
    const mdia = box('mdia', mdhd, hdlr, minf);
    const trak = box('trak', tkhd, mdia);
    const moov = box('moov', mvhd, mvex, trak);
    return Buffer.concat([ftyp, moov], ftyp.length + moov.length);
}
/**
 * Generates an fMP4 media segment (`segment.m4s`) containing styp, moof, and mdat boxes.
 *
 * @param sequence - Segment sequence number (0-indexed).
 * @param sampleSizes - Array of individual Opus packet byte lengths.
 * @param payload - Concatenated raw Opus packets.
 * @param baseMediaDecodeTime - Media decode start time in timescale units (samples).
 * @returns Fully encoded fMP4 segment buffer.
 */
export function createMediaSegment(sequence, sampleSizes, payload, baseMediaDecodeTime) {
    const styp = box('styp', Buffer.from([
        0x6d, 0x73, 0x64, 0x68, 0x00, 0x00, 0x00, 0x00, 0x6d, 0x73, 0x64, 0x68,
        0x6d, 0x73, 0x69, 0x78
    ]));
    const mfhdPayload = Buffer.alloc(8);
    mfhdPayload.writeUInt32BE(sequence + 1, 4);
    const mfhd = box('mfhd', mfhdPayload);
    const tfhdPayload = Buffer.alloc(8);
    tfhdPayload.writeUInt32BE(0x020000, 0);
    tfhdPayload.writeUInt32BE(1, 4);
    const tfhd = box('tfhd', tfhdPayload);
    const tfdtPayload = Buffer.alloc(12);
    tfdtPayload.writeUInt8(1, 0);
    tfdtPayload.writeBigUInt64BE(baseMediaDecodeTime, 4);
    const tfdt = box('tfdt', tfdtPayload);
    const sampleCount = sampleSizes.length;
    const trunHeader = Buffer.alloc(12 + sampleCount * 4);
    trunHeader.writeUInt32BE(0x000201, 0);
    trunHeader.writeUInt32BE(sampleCount, 4);
    const trunBoxSize = 8 + trunHeader.length;
    const trafBoxSize = 8 + tfhd.length + tfdt.length + trunBoxSize;
    const moofBoxSize = 8 + mfhd.length + trafBoxSize;
    const dataOffset = moofBoxSize + 8;
    trunHeader.writeInt32BE(dataOffset, 8);
    let offset = 12;
    for (const s of sampleSizes) {
        trunHeader.writeUInt32BE(s, offset);
        offset += 4;
    }
    const trun = box('trun', trunHeader);
    const traf = box('traf', tfhd, tfdt, trun);
    const moof = box('moof', mfhd, traf);
    const mdat = box('mdat', payload);
    return Buffer.concat([styp, moof, mdat], styp.length + moof.length + mdat.length);
}
