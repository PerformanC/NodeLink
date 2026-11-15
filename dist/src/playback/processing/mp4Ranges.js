import { Readable } from 'node:stream';
const BATCH_SIZE = 32;
const MAX_BATCH_BYTES = BATCH_SIZE * (4096 + 512);
async function fetchBatch(url, ranges, totalBytes, signal) {
    const response = await fetch(url, {
        headers: {
            Range: `bytes=${ranges.map(({ start, length }) => `${start}-${start + length - 1}`).join(',')}`,
            'Accept-Encoding': 'identity'
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(20000)])
    });
    const contentType = response.headers.get('content-type') ?? '';
    const boundary = /^multipart\/byteranges\s*;\s*boundary="?([\w-]{1,70})"?(?:\s*;|\s*$)/i.exec(contentType)?.[1];
    const body = response.body;
    if (!body)
        return;
    if (response.status !== 206 || !boundary) {
        await body.cancel();
        return;
    }
    let length = 0;
    const chunks = [];
    for await (const chunk of Readable.fromWeb(body)) {
        length += chunk.length;
        if (length > MAX_BATCH_BYTES)
            return;
        chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks, length);
    const separator = Buffer.from(`--${boundary}`);
    const packets = [];
    let cursor = bytes.subarray(0, 2).equals(Buffer.from('\r\n')) ? 2 : 0;
    for (const range of ranges) {
        if (!bytes.subarray(cursor, cursor + separator.length).equals(separator))
            return;
        const headerEnd = bytes.indexOf('\r\n\r\n', cursor + separator.length);
        if (headerEnd < 0 || headerEnd - cursor > 512)
            return;
        const header = bytes.toString('ascii', cursor + separator.length, headerEnd);
        const field = /^content-range:\s*bytes (\d+)-(\d+)\/(\d+)\s*$/im.exec(header);
        if (Number(field?.[1]) !== range.start ||
            Number(field?.[2]) !== range.start + range.length - 1 ||
            Number(field?.[3]) !== totalBytes)
            return;
        const start = headerEnd + 4;
        cursor = start + range.length;
        if (bytes.toString('ascii', cursor, cursor + 2) !== '\r\n')
            return;
        packets.push(bytes.subarray(start, cursor));
        cursor += 2;
    }
    if (!bytes.subarray(cursor, cursor + separator.length).equals(separator) ||
        bytes.toString('ascii', cursor + separator.length, cursor + separator.length + 2) !== '--')
        return;
    return packets;
}
/**
 * Reads indexed audio packets in batches. The native reader has already removed
 * the video tracks, so gaps between audio packets can be returned as zeros.
 * @internal
 * @param url - URL used for the validated MP4 byte ranges.
 * @param ranges - Ordered, non-overlapping packet ranges from the native addon.
 * @param totalBytes - Complete representation length.
 * @param signal - Transport cancellation signal.
 * @returns A reader that falls back to ordinary ranges when batching is unavailable.
 */
export function createAudioRangeReader(url, ranges, totalBytes, signal) {
    let batchStart = -1;
    let packets = [];
    let batchingAvailable = true;
    const last = ranges[ranges.length - 1];
    return async (start, length) => {
        const end = start + length;
        if (!batchingAvailable || !last || end > last.start + last.length)
            return;
        let low = 0;
        let high = ranges.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            const range = ranges[middle];
            if (range && range.start <= start)
                low = middle + 1;
            else
                high = middle;
        }
        const first = ranges[low - 1];
        if (!first || start >= first.start + first.length)
            return;
        const nextBatch = ranges[low - 1 + BATCH_SIZE];
        if (nextBatch && nextBatch.start < end)
            return;
        const output = Buffer.alloc(length);
        for (let index = low - 1; index < ranges.length; index++) {
            const range = ranges[index];
            if (!range || range.start >= end)
                break;
            let packet = packets[index - batchStart];
            if (!packet) {
                const batch = ranges.slice(index, index + BATCH_SIZE);
                if (batch.length < 2)
                    return;
                const result = await fetchBatch(url, batch, totalBytes, signal).catch(() => {
                    signal.throwIfAborted();
                    return undefined;
                });
                if (!result) {
                    batchingAvailable = false;
                    packets = [];
                    return;
                }
                batchStart = index;
                packets = result;
                packet = packets[0];
            }
            packet?.copy(output, Math.max(0, range.start - start), Math.max(0, start - range.start));
        }
        return output;
    };
}
