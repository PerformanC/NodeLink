import { Buffer } from 'node:buffer';
/**
 * Text decoder instance for Protobuf string fields.
 * @internal
 */
const TD = new TextDecoder();
/**
 * Constant for empty byte arrays.
 * @internal
 */
const EMPTY_U8 = new Uint8Array(0);
/**
 * Low-level Protobuf wire-format writer.
 * @public
 */
export class ProtoWriter {
    /**
     * Accumulated binary chunks.
     * @internal
     */
    chunks = [];
    /**
     * Total length of the written data.
     * @public
     */
    length = 0;
    /**
     * Pushes a chunk or single byte to the internal buffer.
     * @param c - Data to push.
     * @internal
     */
    _push(c) {
        this.chunks.push(c);
        this.length += typeof c === 'number' ? 1 : c.length;
    }
    /**
     * Writes a varint-encoded 64-bit integer.
     * @param value - The value to encode.
     * @public
     */
    writeVarint(value) {
        let v = BigInt(value);
        while (v > 127n) {
            this._push(Number(v & 127n) | 128);
            v >>= 7n;
        }
        this._push(Number(v));
    }
    /**
     * Writes a Protobuf field tag.
     * @param fieldNumber - Field index.
     * @param wireType - Protobuf wire type.
     * @public
     */
    writeTag(fieldNumber, wireType) {
        this.writeVarint((fieldNumber << 3) | wireType);
    }
    /**
     * Writes a UTF-8 string field.
     * @param fieldNumber - Field index.
     * @param str - String value.
     * @public
     */
    writeString(fieldNumber, str) {
        if (!str)
            return;
        const buf = Buffer.from(str, 'utf8');
        this.writeTag(fieldNumber, 2);
        this.writeVarint(buf.length);
        this._push(buf);
    }
    /**
     * Writes a byte array field.
     * @param fieldNumber - Field index.
     * @param buffer - Data or base64 string.
     * @public
     */
    writeBytes(fieldNumber, buffer) {
        if (!buffer || buffer.length === 0)
            return;
        let data;
        if (typeof buffer === 'string') {
            try {
                data = base64ToU8(buffer);
            }
            catch {
                data = Buffer.from(buffer, 'utf8');
            }
        }
        else {
            data = buffer;
        }
        this.writeTag(fieldNumber, 2);
        this.writeVarint(data.length);
        this._push(data);
    }
    /**
     * Writes a 32-bit signed integer field.
     * @param fieldNumber - Field index.
     * @param value - Integer value.
     * @public
     */
    writeInt32(fieldNumber, value) {
        if (value === null || value === undefined || value === 0)
            return;
        this.writeTag(fieldNumber, 0);
        this.writeVarint(value);
    }
    /**
     * Writes a 64-bit signed integer field.
     * @param fieldNumber - Field index.
     * @param value - Integer value or string.
     * @public
     */
    writeInt64(fieldNumber, value) {
        if (!value || value === '0')
            return;
        this.writeTag(fieldNumber, 0);
        this.writeVarint(value);
    }
    /**
     * Writes a boolean field.
     * @param fieldNumber - Field index.
     * @param value - Boolean value.
     * @public
     */
    writeBool(fieldNumber, value) {
        if (!value)
            return;
        this.writeTag(fieldNumber, 0);
        this.writeVarint(1);
    }
    /**
     * Writes a 32-bit floating point field.
     * @param fieldNumber - Field index.
     * @param value - Float value.
     * @public
     */
    writeFloat(fieldNumber, value) {
        if (!value)
            return;
        this.writeTag(fieldNumber, 5);
        const buf = Buffer.alloc(4);
        buf.writeFloatLE(value);
        this._push(buf);
    }
    /**
     * Writes a nested message field.
     * @param fieldNumber - Field index.
     * @param writer - Sub-writer containing the message.
     * @public
     */
    writeMessage(fieldNumber, writer) {
        const buf = writer.finish();
        if (buf.length === 0)
            return;
        this.writeTag(fieldNumber, 2);
        this.writeVarint(buf.length);
        this._push(buf);
    }
    /**
     * Finalizes the writing process and returns the byte array.
     * @returns Concatenated binary data.
     * @public
     */
    finish() {
        const buf = new Uint8Array(this.length);
        let offset = 0;
        for (const c of this.chunks) {
            if (typeof c === 'number') {
                buf[offset++] = c;
            }
            else {
                buf.set(c, offset);
                offset += c.length;
            }
        }
        return buf;
    }
}
/**
 * Low-level Protobuf wire-format reader.
 * @public
 */
export class ProtoReader {
    /**
     * Data buffer to read from.
     * @public
     */
    buffer;
    /**
     * Current reading position.
     * @public
     */
    pos = 0;
    /**
     * Constructs a new ProtoReader.
     * @param buffer - Binary data.
     */
    constructor(buffer) {
        this.buffer = buffer;
    }
    /**
     * Reads a varint-encoded 64-bit integer.
     * @returns Decoded bigint.
     * @public
     */
    readVarint() {
        let result = 0n;
        let shift = 0n;
        while (true) {
            if (this.pos >= this.buffer.length)
                return result;
            const b = this.buffer[this.pos++];
            if (b === undefined)
                return result;
            result |= BigInt(b & 0x7f) << shift;
            shift += 7n;
            if ((b & 0x80) === 0)
                break;
        }
        return result;
    }
    /**
     * Reads a UTF-8 string field.
     * @returns Decoded string.
     * @public
     */
    readString() {
        const len = Number(this.readVarint());
        if (this.pos + len > this.buffer.length)
            return '';
        const str = TD.decode(this.buffer.subarray(this.pos, this.pos + len));
        this.pos += len;
        return str;
    }
    /**
     * Reads a byte array field.
     * @returns Field data as Uint8Array.
     * @public
     */
    readBytes() {
        const len = Number(this.readVarint());
        if (this.pos + len > this.buffer.length)
            return EMPTY_U8;
        const bytes = this.buffer.subarray(this.pos, this.pos + len);
        this.pos += len;
        return bytes;
    }
    /**
     * Skips a field based on its wire type.
     * @param wireType - Protobuf wire type.
     * @public
     */
    skip(wireType) {
        if (this.pos >= this.buffer.length)
            return;
        switch (wireType) {
            case 0:
                this.readVarint();
                break;
            case 1:
                this.pos = Math.min(this.pos + 8, this.buffer.length);
                break;
            case 2: {
                const len = Number(this.readVarint());
                this.pos = Math.min(this.pos + len, this.buffer.length);
                break;
            }
            case 5:
                this.pos = Math.min(this.pos + 4, this.buffer.length);
                break;
        }
    }
}
/**
 * Codec for FormatId Protobuf message.
 * @public
 */
export const FormatId = {
    encode(msg, writer) {
        writer.writeInt32(1, msg.itag);
        writer.writeInt64(2, msg.lastModified || msg.last_modified);
        writer.writeString(3, msg.xtags);
        return writer;
    },
    decode(reader, len) {
        const end = reader.pos + len;
        const msg = { itag: 0 };
        while (reader.pos < end) {
            const tag = Number(reader.readVarint());
            const field = tag >>> 3;
            if (field === 1)
                msg.itag = Number(reader.readVarint());
            else if (field === 2)
                msg.lastModified = reader.readVarint().toString();
            else if (field === 3)
                msg.xtags = reader.readString();
            else
                reader.skip(tag & 7);
        }
        return msg;
    }
};
/**
 * Codec for ClientAbrState Protobuf message.
 * @public
 */
export const ClientAbrState = {
    encode(msg, writer) {
        writer.writeInt32(16, msg.lastManualSelectedResolution);
        writer.writeInt32(21, msg.stickyResolution);
        writer.writeBool(22, msg.clientViewportIsFlexible);
        writer.writeInt64(23, msg.bandwidthEstimate);
        writer.writeInt64(28, msg.playerTimeMs);
        writer.writeInt32(34, msg.visibility);
        writer.writeFloat(35, msg.playbackRate);
        writer.writeInt64(39, msg.timeSinceLastActionMs);
        writer.writeInt32(40, msg.enabledTrackTypesBitfield);
        writer.writeInt64(44, msg.playerState);
        writer.writeBool(46, msg.drcEnabled);
        writer.writeString(69, msg.audioTrackId);
        return writer;
    }
};
/**
 * Codec for ClientInfo Protobuf message.
 * @public
 */
export const ClientInfo = {
    encode(msg, writer) {
        writer.writeInt32(16, msg.clientName);
        writer.writeString(17, msg.clientVersion);
        return writer;
    }
};
/**
 * Codec for VideoPlaybackAbrRequest Protobuf message.
 * @public
 */
export const VideoPlaybackAbrRequest = {
    encode(msg) {
        const writer = new ProtoWriter();
        if (msg.clientAbrState) {
            writer.writeMessage(1, ClientAbrState.encode(msg.clientAbrState, new ProtoWriter()));
        }
        if (msg.initializationFormatIds) {
            for (const f of msg.initializationFormatIds) {
                writer.writeMessage(2, FormatId.encode(f, new ProtoWriter()));
            }
        }
        if (msg.bufferedRanges) {
            for (const r of msg.bufferedRanges) {
                writer.writeMessage(3, BufferedRange.encode(r, new ProtoWriter()));
            }
        }
        writer.writeInt64(4, msg.playerTimeMs);
        writer.writeBytes(5, msg.videoPlaybackUstreamerConfig);
        if (msg.selectedAudioFormatIds) {
            for (const f of msg.selectedAudioFormatIds) {
                writer.writeMessage(16, FormatId.encode(f, new ProtoWriter()));
            }
        }
        if (msg.selectedVideoFormatIds) {
            for (const f of msg.selectedVideoFormatIds) {
                writer.writeMessage(17, FormatId.encode(f, new ProtoWriter()));
            }
        }
        if (msg.streamerContext) {
            writer.writeMessage(19, StreamerContext.encode(msg.streamerContext, new ProtoWriter()));
        }
        return writer.finish();
    }
};
/**
 * Codec for TimeRange Protobuf message.
 * @public
 */
export const TimeRange = {
    encode(msg, writer) {
        writer.writeInt64(1, msg.startTicks);
        writer.writeInt64(2, msg.durationTicks);
        writer.writeInt32(3, msg.timescale);
        return writer;
    },
    decode(reader, len) {
        const end = reader.pos + len;
        const msg = {
            startTicks: '0',
            durationTicks: '0',
            timescale: 0
        };
        while (reader.pos < end) {
            const tag = Number(reader.readVarint());
            const field = tag >>> 3;
            if (field === 1)
                msg.startTicks = reader.readVarint().toString();
            else if (field === 2)
                msg.durationTicks = reader.readVarint().toString();
            else if (field === 3)
                msg.timescale = Number(reader.readVarint());
            else
                reader.skip(tag & 7);
        }
        return msg;
    }
};
/**
 * Codec for BufferedRange Protobuf message.
 * @public
 */
export const BufferedRange = {
    encode(msg, writer) {
        if (msg.formatId) {
            writer.writeMessage(1, FormatId.encode(msg.formatId, new ProtoWriter()));
        }
        writer.writeInt64(2, msg.startTimeMs);
        writer.writeInt64(3, msg.durationMs);
        writer.writeInt32(4, msg.startSegmentIndex);
        writer.writeInt32(5, msg.endSegmentIndex);
        if (msg.timeRange) {
            writer.writeMessage(6, TimeRange.encode(msg.timeRange, new ProtoWriter()));
        }
        return writer;
    }
};
/**
 * Codec for MediaHeader Protobuf message.
 * @public
 */
export const MediaHeader = {
    decode(reader, len) {
        const end = reader.pos + len;
        const msg = {
            itag: 0,
            sequenceNumber: 0,
            isInitSeg: false,
            durationMs: '0',
            startMs: '0'
        };
        while (reader.pos < end) {
            const tag = Number(reader.readVarint());
            const field = tag >>> 3;
            if (field === 1)
                msg.headerId = Number(reader.readVarint());
            else if (field === 3)
                msg.itag = Number(reader.readVarint());
            else if (field === 4)
                msg.lmt = reader.readVarint().toString();
            else if (field === 5)
                msg.xtags = reader.readString();
            else if (field === 8)
                msg.isInitSeg = Boolean(reader.readVarint());
            else if (field === 9)
                msg.sequenceNumber = Number(reader.readVarint());
            else if (field === 11)
                msg.startMs = reader.readVarint().toString();
            else if (field === 12)
                msg.durationMs = reader.readVarint().toString();
            else if (field === 13) {
                const subLen = Number(reader.readVarint());
                msg.formatId = FormatId.decode(reader, subLen);
                msg.itag = msg.formatId.itag || msg.itag;
                msg.xtags = msg.formatId.xtags || msg.xtags;
            }
            else if (field === 14)
                msg.contentLength = reader.readVarint().toString();
            else if (field === 15) {
                const subLen = Number(reader.readVarint());
                msg.timeRange = TimeRange.decode(reader, subLen);
            }
            else
                reader.skip(tag & 7);
        }
        return msg;
    }
};
/**
 * Codec for FormatInitializationMetadata Protobuf message.
 * @public
 */
export const FormatInitializationMetadata = {
    decode(reader, len) {
        const end = reader.pos + len;
        const msg = {};
        while (reader.pos < end) {
            const tag = Number(reader.readVarint());
            const field = tag >>> 3;
            if (field === 2) {
                msg.formatId = FormatId.decode(reader, Number(reader.readVarint()));
                msg.itag = msg.formatId.itag;
            }
            else if (field === 4)
                msg.endSegmentNumber = reader.readVarint().toString();
            else if (field === 5)
                msg.mimeType = reader.readString();
            else if (field === 9)
                msg.durationUnits = reader.readVarint().toString();
            else if (field === 10)
                msg.durationTimescale = reader.readVarint().toString();
            else
                reader.skip(tag & 7);
        }
        return msg;
    }
};
/**
 * Codec for StreamProtectionStatus Protobuf message.
 * @public
 */
export const StreamProtectionStatus = {
    decode(reader, len) {
        const end = reader.pos + len;
        const msg = {};
        while (reader.pos < end) {
            const tag = Number(reader.readVarint());
            const field = tag >>> 3;
            if (field === 1)
                msg.status = Number(reader.readVarint());
            else
                reader.skip(tag & 7);
        }
        return msg;
    }
};
/**
 * Codec for SabrRedirect Protobuf message.
 * @public
 */
export const SabrRedirect = {
    decode(reader, len) {
        const end = reader.pos + len;
        const msg = {};
        while (reader.pos < end) {
            const tag = Number(reader.readVarint());
            const field = tag >>> 3;
            if (field === 1)
                msg.url = reader.readString();
            else
                reader.skip(tag & 7);
        }
        return msg;
    }
};
/**
 * Codec for SabrError Protobuf message.
 * @public
 */
export const SabrError = {
    decode(reader, len) {
        const end = reader.pos + len;
        const msg = {};
        while (reader.pos < end) {
            const tag = Number(reader.readVarint());
            const field = tag >>> 3;
            if (field === 1)
                msg.type = reader.readString();
            else if (field === 2)
                msg.code = Number(reader.readVarint());
            else
                reader.skip(tag & 7);
        }
        return msg;
    }
};
/**
 * Codec for SnackbarMessage Protobuf message.
 * @public
 */
export const SnackbarMessage = {
    decode(reader, len) {
        const end = reader.pos + len;
        const msg = {};
        while (reader.pos < end) {
            const tag = Number(reader.readVarint());
            const field = tag >>> 3;
            if (field === 1)
                msg.id = Number(reader.readVarint());
            else
                reader.skip(tag & 7);
        }
        return msg;
    }
};
/**
 * Codec for SabrContextUpdate Protobuf message.
 * @public
 */
export const SabrContextUpdate = {
    decode(reader, len) {
        const end = reader.pos + len;
        const msg = {};
        while (reader.pos < end) {
            const tag = Number(reader.readVarint());
            const field = tag >>> 3;
            if (field === 1)
                msg.type = Number(reader.readVarint());
            else if (field === 2)
                msg.scope = Number(reader.readVarint());
            else if (field === 3)
                msg.value = reader.readBytes();
            else if (field === 4)
                msg.sendByDefault = Boolean(reader.readVarint());
            else if (field === 5)
                msg.writePolicy = Number(reader.readVarint());
            else
                reader.skip(tag & 7);
        }
        return msg;
    }
};
/**
 * Codec for SabrContextSendingPolicy Protobuf message.
 * @public
 */
export const SabrContextSendingPolicy = {
    decode(reader, len) {
        const end = reader.pos + len;
        const msg = {
            startPolicy: [],
            stopPolicy: [],
            discardPolicy: []
        };
        while (reader.pos < end) {
            const tag = Number(reader.readVarint());
            const field = tag >>> 3;
            if (field === 1)
                msg.startPolicy.push(Number(reader.readVarint()));
            else if (field === 2)
                msg.stopPolicy.push(Number(reader.readVarint()));
            else if (field === 3)
                msg.discardPolicy.push(Number(reader.readVarint()));
            else
                reader.skip(tag & 7);
        }
        return msg;
    }
};
/**
 * Codec for NextRequestPolicy Protobuf message.
 * @public
 */
export const NextRequestPolicy = {
    decode(reader, len) {
        const end = reader.pos + len;
        const msg = {};
        while (reader.pos < end) {
            const tag = Number(reader.readVarint());
            const field = tag >>> 3;
            if (field === 1)
                msg.targetAudioReadaheadMs = Number(reader.readVarint());
            else if (field === 2)
                msg.targetVideoReadaheadMs = Number(reader.readVarint());
            else if (field === 3)
                msg.maxTimeSinceLastRequestMs = Number(reader.readVarint());
            else if (field === 4)
                msg.backoffTimeMs = Number(reader.readVarint());
            else if (field === 5)
                msg.minAudioReadaheadMs = Number(reader.readVarint());
            else if (field === 6)
                msg.minVideoReadaheadMs = Number(reader.readVarint());
            else if (field === 7)
                msg.playbackCookie = reader.readBytes();
            else
                reader.skip(tag & 7);
        }
        return msg;
    }
};
/**
 * Heuristic to check if a byte array is mostly printable UTF-8.
 * @param u8 - Input data.
 * @returns True if mostly printable.
 * @internal
 */
function isMostlyPrintableUtf8(u8) {
    if (!u8?.length)
        return false;
    try {
        const s = TD.decode(u8);
        if (!s)
            return false;
        let ok = 0;
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            if (c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126))
                ok++;
        }
        return ok / s.length > 0.9;
    }
    catch {
        return false;
    }
}
/**
 * Decodes a generic Protobuf message into a wire-level object.
 * @param reader - Input reader.
 * @param len - Message length.
 * @param depth - Recursion depth for nested messages.
 * @returns Record of fields.
 * @internal
 */
function decodeProtobufObject(reader, len, depth = 2) {
    const end = reader.pos + len;
    const msg = {};
    const push = (field, value) => {
        const k = String(field);
        if (!msg[k])
            msg[k] = [];
        msg[k].push(value);
    };
    while (reader.pos < end) {
        const tag = Number(reader.readVarint());
        if (!tag)
            break;
        const field = tag >>> 3;
        const wireType = tag & 7;
        if (wireType === 0) {
            const v = reader.readVarint();
            const n = v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
            push(field, n);
        }
        else if (wireType === 2) {
            const b = reader.readBytes();
            const entry = { len: b.length };
            if (isMostlyPrintableUtf8(b) && b.length <= 256)
                entry.utf8 = TD.decode(b);
            if (depth > 0 && b.length) {
                try {
                    const nested = decodeProtobufObject(new ProtoReader(b), b.length, depth - 1);
                    if (Object.keys(nested).length)
                        entry.pb = nested;
                }
                catch {
                    // Ignore parse errors for nested objects
                }
            }
            push(field, entry);
        }
        else {
            reader.skip(wireType);
        }
    }
    return msg;
}
/**
 * Codec for PlaybackStartPolicy Protobuf message.
 * @public
 */
export const PlaybackStartPolicy = {
    decode(reader, len) {
        return decodeProtobufObject(reader, len, 2);
    }
};
/**
 * Codec for RequestIdentifier Protobuf message.
 * @public
 */
export const RequestIdentifier = {
    decode(reader, len) {
        const end = reader.pos + len;
        const msg = {};
        while (reader.pos < end) {
            const tag = Number(reader.readVarint());
            const field = tag >>> 3;
            const wireType = tag & 7;
            if (field === 1 && wireType === 2)
                msg.id = reader.readString();
            else
                reader.skip(wireType);
        }
        return msg;
    }
};
/**
 * Codec for RequestCancellationPolicy Protobuf message.
 * @public
 */
export const RequestCancellationPolicy = {
    decode(reader, len) {
        return decodeProtobufObject(reader, len, 2);
    }
};
/**
 * Codec for ReloadPlaybackContext Protobuf message.
 * @public
 */
export const ReloadPlaybackContext = {
    decode(reader, len) {
        return decodeProtobufObject(reader, len, 2);
    }
};
/**
 * Codec for StreamerContext Protobuf message.
 * @public
 */
export const StreamerContext = {
    encode(msg, writer) {
        if (msg.clientInfo) {
            writer.writeMessage(1, ClientInfo.encode(msg.clientInfo, new ProtoWriter()));
        }
        writer.writeBytes(2, msg.poToken);
        if (msg.playbackCookie) {
            writer.writeBytes(3, msg.playbackCookie);
        }
        if (msg.sabrContexts) {
            for (const ctx of msg.sabrContexts) {
                const w = new ProtoWriter();
                w.writeInt32(1, ctx.type);
                w.writeBytes(2, ctx.value);
                writer.writeMessage(5, w);
            }
        }
        if (msg.unsentSabrContexts) {
            for (const type of msg.unsentSabrContexts) {
                writer.writeInt32(6, type);
            }
        }
        return writer;
    }
};
/**
 * Enumeration of track types enabled for playback.
 * @public
 */
export const EnabledTrackTypes = {
    VIDEO_AND_AUDIO: 0,
    AUDIO_ONLY: 1,
    VIDEO_ONLY: 2
};
/**
 * Mapping of UMP part identifiers to their numeric codes.
 * @public
 */
export const UMPPartId = {
    FORMAT_INITIALIZATION_METADATA: 42,
    NEXT_REQUEST_POLICY: 35,
    SABR_ERROR: 44,
    SABR_REDIRECT: 43,
    PLAYBACK_START_POLICY: 47,
    REQUEST_IDENTIFIER: 52,
    REQUEST_CANCELLATION_POLICY: 53,
    SABR_CONTEXT_UPDATE: 57,
    SABR_CONTEXT_SENDING_POLICY: 59,
    STREAM_PROTECTION_STATUS: 58,
    RELOAD_PLAYER_RESPONSE: 46,
    MEDIA_HEADER: 20,
    MEDIA: 21,
    MEDIA_END: 22,
    SNACKBAR_MESSAGE: 67
};
/**
 * Decodes a base64 or base64url string to Uint8Array.
 * @param base64 - Encoded string.
 * @returns Byte array.
 * @public
 */
export function base64ToU8(base64) {
    let s = base64;
    if (s.includes('-'))
        s = s.replaceAll('-', '+');
    if (s.includes('_'))
        s = s.replaceAll('_', '/');
    const mod = s.length & 3;
    if (mod)
        s += '='.repeat(4 - mod);
    return new Uint8Array(Buffer.from(s, 'base64'));
}
/**
 * Concatenates multiple Uint8Array chunks into one.
 * @param chunks - Array of byte arrays.
 * @returns Merged byte array.
 * @public
 */
export function concatenateChunks(chunks) {
    let totalLength = 0;
    const chunkCount = chunks.length;
    for (let i = 0; i < chunkCount; i++) {
        totalLength += chunks[i]?.length ?? 0;
    }
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (let i = 0; i < chunkCount; i++) {
        const chunk = chunks[i];
        if (!chunk)
            continue;
        result.set(chunk, offset);
        offset += chunk.length;
    }
    return result;
}
/**
 * Helper class for writing UMP (Unified Media Protocol) parts.
 * @public
 */
export class UMPWriter {
    /**
     * Accumulated binary chunks.
     * @internal
     */
    chunks = [];
    /**
     * Writes a part to the UMP sequence.
     * @param partType - Part ID from UMPPartId.
     * @param partData - Binary data for the part.
     * @public
     */
    write(partType, partData) {
        this.writeVarInt(partType);
        this.writeVarInt(partData.length);
        this.chunks.push(partData);
    }
    /**
     * Writes a varint value to the internal buffer.
     * @param value - Value to write.
     * @public
     */
    writeVarInt(value) {
        if (value < 0)
            throw new Error('VarInt value cannot be negative.');
        if (value < 128) {
            this.chunks.push(new Uint8Array([value]));
        }
        else if (value < 16384) {
            this.chunks.push(new Uint8Array([(value & 0x3f) | 0x80, value >> 6]));
        }
        else if (value < 2097152) {
            this.chunks.push(new Uint8Array([
                (value & 0x1f) | 0xc0,
                (value >> 5) & 0xff,
                value >> 13
            ]));
        }
        else if (value < 268435456) {
            this.chunks.push(new Uint8Array([
                (value & 0x0f) | 0xe0,
                (value >> 4) & 0xff,
                (value >> 12) & 0xff,
                value >> 20
            ]));
        }
        else {
            const data = new Uint8Array(5);
            const view = new DataView(data.buffer);
            data[0] = 0xf0;
            view.setUint32(1, value, true);
            this.chunks.push(data);
        }
    }
    /**
     * Finalizes the UMP sequence.
     * @returns Concatenated UMP data.
     * @public
     */
    finish() {
        return concatenateChunks(this.chunks);
    }
}
