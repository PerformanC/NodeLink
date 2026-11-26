import { createHash } from 'node:crypto';
import { readCanvasResponse } from './spotifyCanvasResponse.js';
/**
 * Reads a protobuf varint from the provided buffer.
 * @param buffer - Input binary payload.
 * @param offset - Start offset.
 * @returns Decoded varint value and next cursor offset.
 * @throws Error when offset is outside buffer bounds.
 * @internal
 */
function readVarint(buffer, offset) {
    let val = 0;
    let current = offset;
    for (let shift = 0; shift <= 28; shift += 7) {
        if (current >= buffer.length)
            throw new Error('Varint out of bounds');
        const byte = buffer[current++] ?? 0;
        if (shift === 28 && byte > 15)
            throw new Error('Varint exceeds uint32');
        val += (byte & 127) * 2 ** shift;
        if (!(byte & 128))
            return { val, next: current };
    }
    throw new Error('Invalid varint');
}
/**
 * Skips a protobuf field by wire type.
 * @param buffer - Input binary payload.
 * @param offset - Field offset.
 * @param wireType - Protobuf wire type.
 * @returns Next cursor offset after skipping the field.
 * @throws Error when wire type is unsupported.
 * @internal
 */
function skipField(buffer, offset, wireType) {
    if (wireType === 0) {
        for (let i = 0; i < 10; i++) {
            if (offset >= buffer.length)
                throw new Error('Varint out of bounds');
            const byte = buffer[offset++] ?? 0;
            if (i === 9 && byte > 1)
                throw new Error('Varint exceeds uint64');
            if (!(byte & 128))
                return offset;
        }
        throw new Error('Invalid varint');
    }
    let end;
    if (wireType === 1)
        end = offset + 8;
    else if (wireType === 2) {
        const len = readVarint(buffer, offset);
        end = len.next + len.val;
    }
    else if (wireType === 5)
        end = offset + 4;
    else
        throw new Error(`Unsupported wire type: ${wireType}`);
    if (end > buffer.length)
        throw new Error('Truncated field');
    return end;
}
/**
 * Decodes an embedded artist protobuf message.
 * @param buffer - Artist message payload.
 * @returns Parsed artist metadata.
 * @internal
 */
function decodeArtist(buffer) {
    let offset = 0;
    const artist = {
        artistUri: '',
        artistName: '',
        artistImgUrl: ''
    };
    while (offset < buffer.length) {
        try {
            const key = readVarint(buffer, offset);
            offset = key.next;
            const wireType = key.val & 7;
            const fieldNumber = key.val >>> 3;
            if (wireType !== 2) {
                offset = skipField(buffer, offset, wireType);
                continue;
            }
            const len = readVarint(buffer, offset);
            offset = len.next;
            if (len.val > buffer.length - offset)
                throw new Error('Truncated field');
            const valBuf = buffer.subarray(offset, offset + len.val);
            offset += len.val;
            switch (fieldNumber) {
                case 1:
                    artist.artistUri = valBuf.toString('utf8');
                    break;
                case 2:
                    artist.artistName = valBuf.toString('utf8');
                    break;
                case 3:
                    artist.artistImgUrl = valBuf.toString('utf8');
                    break;
            }
        }
        catch {
            throw new Error('Malformed artist message');
        }
    }
    return artist;
}
/**
 * Decodes a single canvas protobuf message.
 * @param buffer - Canvas message payload.
 * @returns Parsed canvas entry.
 * @internal
 */
function decodeCanvas(buffer) {
    let offset = 0;
    const canvas = {
        id: '',
        canvasUrl: '',
        trackUri: '',
        artist: {
            artistUri: '',
            artistName: '',
            artistImgUrl: ''
        },
        canvasUri: ''
    };
    while (offset < buffer.length) {
        try {
            const key = readVarint(buffer, offset);
            offset = key.next;
            const wireType = key.val & 7;
            const fieldNumber = key.val >>> 3;
            if (wireType !== 2) {
                offset = skipField(buffer, offset, wireType);
                continue;
            }
            const len = readVarint(buffer, offset);
            offset = len.next;
            if (len.val > buffer.length - offset)
                throw new Error('Truncated field');
            const valBuf = buffer.subarray(offset, offset + len.val);
            offset += len.val;
            switch (fieldNumber) {
                case 1:
                    canvas.id = valBuf.toString('utf8');
                    break;
                case 2:
                    canvas.canvasUrl = valBuf.toString('utf8');
                    break;
                case 5:
                    canvas.trackUri = valBuf.toString('utf8');
                    break;
                case 6:
                    canvas.artist = decodeArtist(valBuf);
                    break;
                case 9:
                    canvas.otherId = valBuf.toString('utf8');
                    break;
                case 11:
                    canvas.canvasUri = valBuf.toString('utf8');
                    break;
            }
        }
        catch {
            throw new Error('Malformed Canvas message');
        }
    }
    return canvas;
}
/**
 * Decodes the canvaz service response payload.
 * @param buffer - Full protobuf response payload.
 * @returns Decoded canvas list object.
 * @internal
 */
function decodeCanvasResponse(buffer) {
    let offset = 0;
    const canvases = [];
    while (offset < buffer.length) {
        try {
            const key = readVarint(buffer, offset);
            offset = key.next;
            const wireType = key.val & 7;
            const fieldNumber = key.val >>> 3;
            if (fieldNumber === 1 && wireType === 2) {
                const len = readVarint(buffer, offset);
                offset = len.next;
                if (len.val > buffer.length - offset)
                    throw new Error('Truncated Canvas');
                const canvasBuf = buffer.subarray(offset, offset + len.val);
                offset += len.val;
                canvases.push(decodeCanvas(canvasBuf));
            }
            else {
                offset = skipField(buffer, offset, wireType);
            }
        }
        catch {
            break;
        }
    }
    return { canvasesList: canvases };
}
/** Summarizes only field tags in a short response, never field values. */
function summarizeShortResponse(buffer) {
    const fields = [];
    let offset = 0;
    try {
        while (offset < buffer.length) {
            const key = readVarint(buffer, offset);
            const number = key.val >>> 3;
            const wireType = key.val & 7;
            if (number === 0)
                return { fields, complete: false };
            fields.push({ number, wireType });
            const next = skipField(buffer, key.next, wireType);
            if (next <= offset || next > buffer.length) {
                return { fields, complete: false };
            }
            offset = next;
        }
        return { fields, complete: true };
    }
    catch {
        return { fields, complete: false };
    }
}
// Negative entries only: never cache a media URL or an HTTP/transport error.
const MAX_NEGATIVE_ENTRIES = 512;
const MAX_NEGATIVE_TTL_SECONDS = 3600;
const negativeCache = new Map();
/** Accept only a complete TTL-only response (field 2, int64). */
function readEmptyResponseTtl(buffer) {
    if (buffer.length < 2 || buffer.length > 11 || buffer[0] !== 0x10)
        return;
    let ttl = 0n;
    for (let i = 1; i < buffer.length; i++) {
        const byte = buffer[i] ?? 0;
        ttl |= BigInt(byte & 127) << BigInt((i - 1) * 7);
        if (!(byte & 128)) {
            if (i !== buffer.length - 1 || ttl <= 0n || ttl > 0x7fffffffffffffffn)
                return;
            return Number(ttl > BigInt(MAX_NEGATIVE_TTL_SECONDS)
                ? BigInt(MAX_NEGATIVE_TTL_SECONDS)
                : ttl);
        }
    }
}
/**
 * Fetches Spotify canvas metadata for a track URI.
 * @param trackUri - Spotify track URI (`spotify:track:...`).
 * @param token - Spotify bearer token.
 * @param onDiagnostic - Optional callback for non-sensitive request diagnostics.
 * @returns Decoded canvas payload or null when unavailable.
 * @public
 */
export async function fetchCanvas(trackUri, token, onDiagnostic) {
    try {
        const cacheKey = createHash('sha256')
            .update(token)
            .update('\0')
            .update(trackUri)
            .digest('hex');
        const now = Date.now();
        const expiresAt = negativeCache.get(cacheKey);
        if (expiresAt !== undefined) {
            if (expiresAt > now) {
                onDiagnostic?.({
                    kind: 'negative-cache-hit',
                    remainingSeconds: Math.ceil((expiresAt - now) / 1000)
                });
                return { data: { canvasesList: [] } };
            }
            negativeCache.delete(cacheKey);
        }
        const trackUriBuf = Buffer.from(trackUri);
        const trackBuf = Buffer.concat([
            Buffer.from([0x0a, trackUriBuf.length]),
            trackUriBuf
        ]);
        const requestBuf = Buffer.concat([
            Buffer.from([0x0a, trackBuf.length]),
            trackBuf
        ]);
        const res = await fetch('https://spclient.wg.spotify.com/canvaz-cache/v0/canvases', {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(8000),
            body: requestBuf,
            headers: {
                Accept: 'application/protobuf',
                'Content-Type': 'application/protobuf',
                'User-Agent': 'Spotify/9.0.34.593 iOS/18.4 (iPhone15,3)',
                Authorization: `Bearer ${token}`
            }
        });
        onDiagnostic?.({ kind: 'http', status: res.status });
        if (!res.ok) {
            await res.body?.cancel();
            return null;
        }
        const buffer = await readCanvasResponse(res, 1024 * 1024);
        const data = decodeCanvasResponse(buffer);
        onDiagnostic?.({
            kind: 'decoded',
            bytes: buffer.length,
            entries: data.canvasesList.length,
            matching: data.canvasesList.filter((entry) => entry.trackUri === trackUri)
                .length,
            withUrl: data.canvasesList.filter((entry) => Boolean(entry.canvasUrl))
                .length
        });
        if (buffer.length > 0 && buffer.length <= 16 && !data.canvasesList.length) {
            onDiagnostic?.({
                kind: 'short-response',
                ...summarizeShortResponse(buffer)
            });
        }
        const ttlSeconds = data.canvasesList.length === 0 ? readEmptyResponseTtl(buffer) : undefined;
        if (ttlSeconds !== undefined) {
            // Keep cache bounded per worker; scope to the current credential and track.
            if (negativeCache.size >= MAX_NEGATIVE_ENTRIES) {
                const oldest = negativeCache.keys().next().value;
                if (oldest !== undefined)
                    negativeCache.delete(oldest);
            }
            negativeCache.set(cacheKey, Date.now() + ttlSeconds * 1000);
            onDiagnostic?.({ kind: 'negative-cache', ttlSeconds });
        }
        return { data };
    }
    catch {
        onDiagnostic?.({ kind: 'request-error' });
        return null;
    }
}
