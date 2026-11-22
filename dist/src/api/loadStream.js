import { Buffer } from 'node:buffer';
import { Readable, pipeline } from 'node:stream';
import { decodeTrack, logger, sendErrorResponse } from '../utils.js';
/**
 * Cached dynamic import for the stream processor module.
 */
let streamProcessorModulePromise = null;
/**
 * PCM output contract produced by StreamProcessor.
 * 48 kHz * 2 channels * 16-bit samples = 192,000 bytes per second.
 */
const PCM_SAMPLE_RATE = 48000;
const PCM_CHANNELS = 2;
const PCM_BITS_PER_SAMPLE = 16;
const PCM_BLOCK_ALIGN = PCM_CHANNELS * (PCM_BITS_PER_SAMPLE / 8);
const PCM_BYTES_PER_SECOND = PCM_SAMPLE_RATE * PCM_CHANNELS * (PCM_BITS_PER_SAMPLE / 8);
const PCM_BYTES_PER_MS = PCM_BYTES_PER_SECOND / 1000;
const WAV_HEADER_SIZE = 44;
/**
 * Default headers returned by the raw PCM stream endpoint.
 * Transfer-Encoding and Connection are intentionally omitted: Node manages
 * framing for HTTP/1.1 and HTTP/2 has no chunked transfer-encoding header.
 */
const LOAD_STREAM_HEADERS = {
    'Content-Type': 'audio/l16;rate=48000;channels=2',
    'Accept-Ranges': 'bytes'
};
/**
 * Builds a 44-byte RIFF/WAVE header for 16-bit 48 kHz stereo PCM.
 * Pass null when the stream length is unknown (live streams).
 */
function createWavHeader(totalAudioBytes) {
    const buffer = Buffer.alloc(WAV_HEADER_SIZE);
    const byteRate = PCM_BYTES_PER_SECOND;
    const dataSize = totalAudioBytes ?? 0x7ffffff0;
    const maxRiffDataSize = 0xffffffff - 36;
    if (!Number.isSafeInteger(dataSize) ||
        dataSize < 0 ||
        dataSize > maxRiffDataSize) {
        throw new RangeError('WAV audio data exceeds the RIFF/WAVE size limit.');
    }
    buffer.write('RIFF', 0, 'ascii');
    buffer.writeUInt32LE(dataSize + 36, 4);
    buffer.write('WAVE', 8, 'ascii');
    buffer.write('fmt ', 12, 'ascii');
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(PCM_CHANNELS, 22);
    buffer.writeUInt32LE(PCM_SAMPLE_RATE, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(PCM_BLOCK_ALIGN, 32);
    buffer.writeUInt16LE(PCM_BITS_PER_SAMPLE, 34);
    buffer.write('data', 36, 'ascii');
    buffer.writeUInt32LE(dataSize, 40);
    return buffer;
}
/**
 * Lazily imports and caches the stream processor module.
 *
 * @returns Promise resolving to the stream processor module exports.
 */
function getStreamProcessorModule() {
    if (!streamProcessorModulePromise) {
        streamProcessorModulePromise = import('../playback/processing/streamProcessor.js');
    }
    return streamProcessorModulePromise;
}
/**
 * Builds a strongly typed runtime view for the load stream endpoint.
 *
 * @param nodelink - Router-facing runtime instance.
 * @returns Runtime compatible with the load stream endpoint, or `null` when
 * the required manager fields are unavailable.
 */
function getLoadStreamRuntime(nodelink) {
    const runtime = nodelink;
    if (runtime.sourceWorkerManager === undefined ||
        runtime.workerManager === undefined ||
        runtime.sources === undefined) {
        return null;
    }
    return runtime;
}
/**
 * Checks whether a value is a finite number.
 *
 * @param value - Candidate numeric value.
 * @returns `true` when the value is a finite number.
 */
function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
/**
 * Normalizes the optional filters payload.
 *
 * @param value - Candidate filters object.
 * @returns Valid filters payload, `false` when the value is invalid, or an
 * empty filter state when omitted.
 */
function normalizeFilters(value) {
    if (value === undefined) {
        return {};
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    return value;
}
/**
 * Extracts request data from a `POST` body payload.
 *
 * @param body - Parsed request body.
 * @returns Normalized request data, or `null` when validation fails.
 */
function getLoadStreamInputFromBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return null;
    }
    const payload = body;
    if (typeof payload.encodedTrack !== 'string' ||
        payload.encodedTrack.trim() === '') {
        return null;
    }
    if (payload.volume !== undefined) {
        if (!isFiniteNumber(payload.volume) ||
            payload.volume < 0 ||
            payload.volume > 1000) {
            return null;
        }
    }
    if (payload.position !== undefined) {
        if (!isFiniteNumber(payload.position) || payload.position < 0) {
            return null;
        }
    }
    const filters = normalizeFilters(payload.filters);
    if (filters === false) {
        return null;
    }
    const formatValue = payload.format;
    const format = normalizeOutputFormat(formatValue);
    if (!format) {
        return null;
    }
    return {
        encodedTrack: payload.encodedTrack,
        volume: payload.volume ?? 100,
        position: payload.position ?? 0,
        filters,
        format
    };
}
/**
 * Parses the `filters` query parameter.
 *
 * Invalid JSON is ignored to preserve the historical behavior of the route.
 *
 * @param parsedUrl - Parsed request URL.
 * @returns Parsed filters payload or `undefined` when absent/invalid.
 */
function getFiltersFromQuery(parsedUrl) {
    const filtersRaw = parsedUrl.searchParams.get('filters');
    if (!filtersRaw) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(filtersRaw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Normalizes the requested representation. The format must stay identical
 * across the initial request and every subsequent Range request.
 */
function normalizeOutputFormat(value) {
    if (value === undefined || value === null || value === '') {
        return 'raw';
    }
    if (typeof value !== 'string') {
        return null;
    }
    const format = value.trim().toLowerCase();
    return format === 'raw' || format === 'wav' ? format : null;
}
/**
 * Parses one RFC 9110 byte range. Multi-range and malformed Range headers are
 * ignored (the caller sends the complete representation with status 200).
 */
function parseSingleByteRange(header, totalSize) {
    if (!header) {
        return { kind: 'none' };
    }
    const value = header.trim();
    if (!/^bytes=/i.test(value) || value.includes(',')) {
        return { kind: 'ignore' };
    }
    const match = /^bytes=(\d*)-(\d*)$/i.exec(value);
    if (!match || (!match[1] && !match[2])) {
        return { kind: 'ignore' };
    }
    if (!Number.isSafeInteger(totalSize) || totalSize <= 0) {
        return { kind: 'unsatisfiable' };
    }
    const first = match[1];
    const last = match[2];
    // Suffix range: bytes=-N (the last N bytes).
    if (!first) {
        const suffixLength = Number(last);
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
            return { kind: 'unsatisfiable' };
        }
        return {
            kind: 'range',
            start: Math.max(totalSize - suffixLength, 0),
            end: totalSize - 1
        };
    }
    const start = Number(first);
    const requestedEnd = last ? Number(last) : totalSize - 1;
    if (!Number.isSafeInteger(start) ||
        !Number.isSafeInteger(requestedEnd) ||
        start < 0 ||
        requestedEnd < 0) {
        return { kind: 'ignore' };
    }
    if (start >= totalSize || requestedEnd < start) {
        return { kind: 'unsatisfiable' };
    }
    return {
        kind: 'range',
        start,
        end: Math.min(requestedEnd, totalSize - 1)
    };
}
/**
 * Creates a stream that skips an exact number of source bytes and emits no
 * more than the requested byte count. It keeps backpressure through the
 * Readable async iterator and destroys the source on early termination.
 */
function createPcmRangeStream(source, bytesToSkip, bytesToSend) {
    return Readable.from((async function* () {
        let skipRemaining = bytesToSkip;
        let sendRemaining = bytesToSend;
        for await (const value of source) {
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            let offset = 0;
            if (skipRemaining > 0) {
                const skipped = Math.min(skipRemaining, chunk.length);
                skipRemaining -= skipped;
                offset += skipped;
            }
            if (offset >= chunk.length || sendRemaining <= 0) {
                if (sendRemaining <= 0) {
                    break;
                }
                continue;
            }
            const available = chunk.length - offset;
            const count = Math.min(available, sendRemaining);
            if (count > 0) {
                yield chunk.subarray(offset, offset + count);
                sendRemaining -= count;
            }
            if (sendRemaining <= 0) {
                break;
            }
        }
        if (skipRemaining > 0 || sendRemaining > 0) {
            throw new Error(`PCM range ended early (skip remaining: ${skipRemaining}, bytes remaining: ${sendRemaining}).`);
        }
    })(), {
        objectMode: false,
        highWaterMark: 19200
    });
}
/**
 * Extracts request data from the query string used by `GET /loadStream`.
 *
 * @param parsedUrl - Parsed request URL.
 * @returns Normalized request data, or `null` when validation fails.
 */
function getLoadStreamInputFromQuery(parsedUrl) {
    const encodedTrack = parsedUrl.searchParams.get('encodedTrack')?.trim();
    if (!encodedTrack) {
        return null;
    }
    const volumeParam = parsedUrl.searchParams.get('volume');
    const positionParam = parsedUrl.searchParams.get('position') ?? parsedUrl.searchParams.get('t');
    const volume = volumeParam === null || volumeParam === '' ? 100 : Number(volumeParam);
    const position = positionParam === null || positionParam === '' ? 0 : Number(positionParam);
    if (!Number.isFinite(volume) || volume < 0 || volume > 1000) {
        return null;
    }
    if (!Number.isFinite(position) || position < 0) {
        return null;
    }
    const filters = getFiltersFromQuery(parsedUrl) ?? {};
    const formatParam = parsedUrl.searchParams.get('format');
    const format = normalizeOutputFormat(formatParam ?? undefined);
    if (!format) {
        return null;
    }
    return {
        encodedTrack,
        volume,
        position,
        filters,
        format
    };
}
/**
 * Extracts normalized request data regardless of HTTP method.
 *
 * @param req - Incoming HTTP request.
 * @param parsedUrl - Parsed request URL.
 * @returns Normalized request data, or `null` when validation fails.
 */
function getLoadStreamInput(req, parsedUrl) {
    const input = req.method === 'POST'
        ? getLoadStreamInputFromBody(req.body)
        : getLoadStreamInputFromQuery(parsedUrl);
    if (!input)
        return null;
    return input;
}
/**
 * Casts the full runtime to the runtime contract required by the
 * stream processor.
 *
 * @param nodelink - Load stream runtime.
 * @returns Runtime view consumed by the stream processor.
 */
function getStreamProcessorRuntime(nodelink) {
    return nodelink;
}
/**
 * Resolves the track URL required for streaming.
 *
 * @param nodelink - Load stream runtime.
 * @param decodedTrack - Decoded track payload.
 * @returns Promise resolving to the track URL response.
 */
async function getTrackUrlResult(nodelink, decodedTrack) {
    if (nodelink.workerManager) {
        const worker = nodelink.workerManager.getBestWorker();
        return await nodelink.workerManager.execute(worker, 'getTrackUrl', {
            decodedTrackInfo: decodedTrack.info
        });
    }
    if (!nodelink.sources) {
        throw new Error('Sources manager is not available for loadStream.');
    }
    return await nodelink.sources.getTrackUrl(decodedTrack.info);
}
/**
 * Destroys a readable stream when it is still active.
 *
 * @param stream - Candidate stream.
 * @returns Nothing. The stream is destroyed as a side effect.
 */
function destroyStream(stream) {
    if (stream && !stream.destroyed) {
        stream.destroy();
    }
}
/**
 * Handles requests for the PCM/WAV stream endpoint.
 *
 * @param nodelink - Router-facing NodeLink runtime.
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @param _sendResponse - Unused route helper kept for handler signature
 * compatibility.
 * @param parsedUrl - Parsed request URL.
 * @returns Promise that resolves once the response has been written or the
 * stream has been delegated.
 */
async function handler(nodelink, req, res, _sendResponse, parsedUrl) {
    const streamResponse = res;
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length'
        });
        res.end();
        return;
    }
    const runtime = getLoadStreamRuntime(nodelink);
    if (!runtime) {
        sendErrorResponse(req, res, 500, 'Internal Server Error', 'Load stream runtime contract is incomplete.', parsedUrl.pathname, true);
        return;
    }
    if (!runtime.options.api.enableLoadStreamEndpoint) {
        sendErrorResponse(req, res, 404, 'Not Found', 'The requested route was not found.', parsedUrl.pathname);
        return;
    }
    const input = getLoadStreamInput(req, parsedUrl);
    if (!input) {
        sendErrorResponse(req, res, 400, 'Bad Request', 'Invalid parameters. `format` must be `raw` or `wav`.', parsedUrl.pathname);
        return;
    }
    const encodedTrack = input.encodedTrack.replace(/ /g, '+');
    let pcmStream = null;
    let fetchedStream = null;
    let clientClosed = false;
    const cleanup = () => {
        destroyStream(pcmStream);
        destroyStream(fetchedStream);
    };
    const onResponseClose = () => {
        if (!streamResponse.writableEnded) {
            clientClosed = true;
            cleanup();
        }
    };
    streamResponse.once('close', onResponseClose);
    try {
        const decodedTrack = decodeTrack(encodedTrack);
        const isWav = input.format === 'wav';
        const trackDurationMs = Number(decodedTrack.info.length);
        const isLiveStream = Boolean(decodedTrack.info.isStream) ||
            !Number.isFinite(trackDurationMs) ||
            trackDurationMs <= 0;
        // A valid HTTP Range addresses the complete representation, starting at
        // byte zero. The body/query `position` is only used when there is no valid
        // Range header; adding it to the Range offset would seek twice.
        let totalTrackFrames = isLiveStream
            ? 0
            : Math.max(0, Math.floor(trackDurationMs * (PCM_SAMPLE_RATE / 1000)));
        let fullTrackPcmBytes = totalTrackFrames * PCM_BLOCK_ALIGN;
        let fullTrackFileSize = isLiveStream
            ? 0
            : fullTrackPcmBytes + (isWav ? WAV_HEADER_SIZE : 0);
        if (!isLiveStream &&
            (!Number.isSafeInteger(fullTrackPcmBytes) ||
                fullTrackPcmBytes < 0 ||
                (isWav && fullTrackPcmBytes > 0xffffffff - 36))) {
            sendErrorResponse(req, res, 413, 'Payload Too Large', 'The generated audio representation exceeds the supported size.', parsedUrl.pathname);
            return;
        }
        const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range.trim() : '';
        // `bytes=0-` requests the complete representation. Sending it as a normal
        // 200 stream avoids claiming an exact Content-Length based only on track
        // metadata; the decoder remains free to finish at its actual EOF.
        const isFullOpenEndedRange = !isLiveStream &&
            fullTrackFileSize > 0 &&
            /^bytes=0-$/i.test(rangeHeader);
        let parsedRange = isLiveStream
            ? { kind: 'ignore' }
            : parseSingleByteRange(rangeHeader || undefined, fullTrackFileSize);
        if (parsedRange.kind === 'unsatisfiable') {
            streamResponse.writeHead(416, {
                'Content-Range': `bytes */${fullTrackFileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Type': 'text/plain',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length'
            });
            streamResponse.end('Requested range not satisfiable');
            return;
        }
        let isRangeRequest = parsedRange.kind === 'range' && !isFullOpenEndedRange;
        const requestedStartFrame = Math.max(0, Math.floor(input.position * (PCM_SAMPLE_RATE / 1000)));
        let baseFrame = isLiveStream
            ? requestedStartFrame
            : isRangeRequest || isFullOpenEndedRange
                ? 0
                : Math.min(requestedStartFrame, totalTrackFrames);
        let basePositionMs = isLiveStream
            ? input.position
            : baseFrame / (PCM_SAMPLE_RATE / 1000);
        let totalPcmBytes = isLiveStream
            ? 0
            : fullTrackPcmBytes - baseFrame * PCM_BLOCK_ALIGN;
        let totalFileSize = isLiveStream
            ? 0
            : totalPcmBytes + (isWav ? WAV_HEADER_SIZE : 0);
        const activeRange = parsedRange.kind === 'range' && !isFullOpenEndedRange ? parsedRange : null;
        let rangeStart = activeRange ? activeRange.start : 0;
        let rangeEnd = activeRange
            ? activeRange.end
            : Math.max(totalFileSize - 1, 0);
        let rangeLength = isRangeRequest
            ? rangeEnd - rangeStart + 1
            : totalFileSize;
        let rangeHeaderBytesToSend = null;
        let pcmSkipBytes = 0;
        let pcmBytesToSend = rangeLength;
        let streamStartPositionMs = basePositionMs;
        if (isRangeRequest) {
            let pcmByteOffset = rangeStart;
            if (isWav) {
                const wavHeader = createWavHeader(fullTrackPcmBytes);
                if (rangeStart < WAV_HEADER_SIZE) {
                    const headerEnd = Math.min(WAV_HEADER_SIZE, rangeEnd + 1);
                    rangeHeaderBytesToSend = wavHeader.subarray(rangeStart, headerEnd);
                    pcmBytesToSend -= rangeHeaderBytesToSend.length;
                    pcmByteOffset = 0;
                }
                else {
                    pcmByteOffset = rangeStart - WAV_HEADER_SIZE;
                }
            }
            if (pcmBytesToSend > 0) {
                // The PCM stream can seek only to millisecond boundaries. Seek to the
                // preceding millisecond and discard the exact remaining byte offset.
                // 48 kHz stereo S16LE produces exactly 192 PCM bytes per millisecond.
                const seekPositionMs = Math.floor(pcmByteOffset / PCM_BYTES_PER_MS);
                const seekByteOffset = seekPositionMs * PCM_BYTES_PER_MS;
                pcmSkipBytes = pcmByteOffset - seekByteOffset;
                streamStartPositionMs = seekPositionMs;
            }
        }
        const commonHeaders = {
            'Content-Type': isWav
                ? 'audio/wav'
                : LOAD_STREAM_HEADERS['Content-Type'],
            'Accept-Ranges': isLiveStream ? 'none' : 'bytes',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length'
        };
        const buildEffectiveHeaders = () => isRangeRequest
            ? {
                ...commonHeaders,
                'Content-Range': `bytes ${rangeStart}-${rangeEnd}/${totalFileSize}`,
                'Content-Length': String(rangeLength)
            }
            : {
                ...commonHeaders,
                ...(!isLiveStream && !isFullOpenEndedRange
                    ? { 'Content-Length': String(totalFileSize) }
                    : {})
            };
        let effectiveHeaders = buildEffectiveHeaders();
        const recalculateFiniteRepresentation = (durationMs) => {
            if (!Number.isFinite(durationMs) || durationMs <= 0 || isLiveStream) {
                return true;
            }
            totalTrackFrames = Math.max(0, Math.floor(durationMs * (PCM_SAMPLE_RATE / 1000)));
            fullTrackPcmBytes = totalTrackFrames * PCM_BLOCK_ALIGN;
            fullTrackFileSize = fullTrackPcmBytes + (isWav ? WAV_HEADER_SIZE : 0);
            parsedRange = parseSingleByteRange(rangeHeader || undefined, fullTrackFileSize);
            if (parsedRange.kind === 'unsatisfiable')
                return false;
            isRangeRequest =
                parsedRange.kind === 'range' && !isFullOpenEndedRange;
            baseFrame = isRangeRequest || isFullOpenEndedRange
                ? 0
                : Math.min(requestedStartFrame, totalTrackFrames);
            basePositionMs = baseFrame / (PCM_SAMPLE_RATE / 1000);
            totalPcmBytes = fullTrackPcmBytes - baseFrame * PCM_BLOCK_ALIGN;
            totalFileSize = totalPcmBytes + (isWav ? WAV_HEADER_SIZE : 0);
            const nextActiveRange = parsedRange.kind === 'range' && !isFullOpenEndedRange
                ? parsedRange
                : null;
            rangeStart = nextActiveRange ? nextActiveRange.start : 0;
            rangeEnd = nextActiveRange
                ? nextActiveRange.end
                : Math.max(totalFileSize - 1, 0);
            rangeLength = isRangeRequest
                ? rangeEnd - rangeStart + 1
                : totalFileSize;
            rangeHeaderBytesToSend = null;
            pcmSkipBytes = 0;
            pcmBytesToSend = rangeLength;
            streamStartPositionMs = basePositionMs;
            if (isRangeRequest) {
                let pcmByteOffset = rangeStart;
                if (isWav) {
                    const wavHeader = createWavHeader(fullTrackPcmBytes);
                    if (rangeStart < WAV_HEADER_SIZE) {
                        const headerEnd = Math.min(WAV_HEADER_SIZE, rangeEnd + 1);
                        rangeHeaderBytesToSend = wavHeader.subarray(rangeStart, headerEnd);
                        pcmBytesToSend -= rangeHeaderBytesToSend.length;
                        pcmByteOffset = 0;
                    }
                    else {
                        pcmByteOffset = rangeStart - WAV_HEADER_SIZE;
                    }
                }
                if (pcmBytesToSend > 0) {
                    const seekPositionMs = Math.floor(pcmByteOffset / PCM_BYTES_PER_MS);
                    const seekByteOffset = seekPositionMs * PCM_BYTES_PER_MS;
                    pcmSkipBytes = pcmByteOffset - seekByteOffset;
                    streamStartPositionMs = seekPositionMs;
                }
            }
            effectiveHeaders = buildEffectiveHeaders();
            return true;
        };
        // HEAD must not resolve sources, open remote connections or instantiate a
        // decoder. The same representation headers are returned without a body.
        if (req.method === 'HEAD') {
            streamResponse.writeHead(isRangeRequest ? 206 : 200, effectiveHeaders);
            streamResponse.end();
            return;
        }
        // A request wholly contained in the WAV header needs no source connection.
        if (isRangeRequest &&
            isWav &&
            rangeEnd < WAV_HEADER_SIZE &&
            rangeHeaderBytesToSend) {
            streamResponse.writeHead(206, effectiveHeaders);
            streamResponse.end(rangeHeaderBytesToSend);
            return;
        }
        // Empty finite representations can be completed without contacting a
        // source.
        if (!isLiveStream && totalPcmBytes === 0 && !isRangeRequest) {
            streamResponse.writeHead(200, effectiveHeaders);
            if (isWav) {
                streamResponse.end(createWavHeader(0));
            }
            else {
                streamResponse.end();
            }
            return;
        }
        if (clientClosed) {
            return;
        }
        if (runtime.sourceWorkerManager) {
            const delegated = runtime.sourceWorkerManager.delegate(req, res, 'loadStream', {
                decodedTrackInfo: decodedTrack.info,
                volume: input.volume,
                position: streamStartPositionMs,
                filters: input.filters
            }, {
                statusCode: isRangeRequest ? 206 : 200,
                headers: effectiveHeaders
            });
            if (delegated) {
                return;
            }
        }
        if (!runtime.sources && runtime.workerManager) {
            const delegated = runtime.workerManager.delegateStream(req, res, {
                decodedTrackInfo: decodedTrack.info,
                volume: input.volume,
                position: streamStartPositionMs,
                filters: input.filters
            }, {
                statusCode: isRangeRequest ? 206 : 200,
                headers: effectiveHeaders
            });
            if (delegated) {
                return;
            }
            sendErrorResponse(req, res, 503, 'Service Unavailable', 'No available workers to stream audio.', parsedUrl.pathname);
            return;
        }
        if (!runtime.sources && !runtime.workerManager) {
            sendErrorResponse(req, res, 503, 'Service Unavailable', 'Sources manager is not available for loadStream.', parsedUrl.pathname);
            return;
        }
        const urlResult = await getTrackUrlResult(runtime, decodedTrack);
        if (clientClosed) {
            return;
        }
        if (urlResult.exception) {
            sendErrorResponse(req, res, 500, 'Internal Server Error', urlResult.exception.message, parsedUrl.pathname);
            return;
        }
        const { createAudioResource, createSeekeableAudioResource } = await getStreamProcessorModule();
        if (clientClosed) {
            return;
        }
        const streamProcessorRuntime = getStreamProcessorRuntime(runtime);
        const sourceName = decodedTrack.info.sourceName;
        const isHls = urlResult.protocol === 'hls';
        const isSabr = urlResult.protocol === 'sabr';
        const isLocal = sourceName === 'local';
        if (urlResult.url && !isHls && !isLocal && !isSabr) {
            const resource = (await createSeekeableAudioResource(input.guildId || 'api-stream', urlResult.url, streamStartPositionMs, undefined, streamProcessorRuntime, input.filters, {
                streamInfo: urlResult,
                loudnessNormalizer: runtime.options.playback.audio?.loudnessNormalizer
            }, input.volume / 100, null, true));
            if (clientClosed) {
                if (!('exception' in resource)) {
                    destroyStream(resource.stream);
                }
                return;
            }
            if ('exception' in resource) {
                sendErrorResponse(req, res, 500, 'Internal Server Error', resource.exception.message, parsedUrl.pathname);
                return;
            }
            pcmStream = resource.stream;
            const sourceDurationMs = resource.sourceDurationMs;
            if (!isLiveStream &&
                typeof sourceDurationMs === 'number' &&
                Number.isFinite(sourceDurationMs) &&
                sourceDurationMs > 0 &&
                sourceDurationMs < trackDurationMs - 1) {
                if (!recalculateFiniteRepresentation(sourceDurationMs)) {
                    destroyStream(pcmStream);
                    pcmStream = null;
                    streamResponse.writeHead(416, {
                        'Content-Range': `bytes */${fullTrackFileSize}`,
                        'Accept-Ranges': 'bytes',
                        'Content-Type': 'text/plain',
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length'
                    });
                    streamResponse.end('Requested range not satisfiable');
                    return;
                }
            }
        }
        else {
            if (!runtime.sources || !urlResult.url) {
                throw new Error('Unable to fetch source stream for the requested track.');
            }
            const additionalData = {
                ...(urlResult.additionalData ?? {}),
                startTime: streamStartPositionMs
            };
            const fetched = await runtime.sources.getTrackStream(urlResult.newTrack?.info ?? decodedTrack.info, urlResult.url, urlResult.protocol, additionalData);
            if (clientClosed) {
                if (fetched.stream) {
                    destroyStream(fetched.stream);
                }
                return;
            }
            if (fetched.exception || !fetched.stream) {
                sendErrorResponse(req, res, 500, 'Internal Server Error', fetched.exception?.message || 'Failed to fetch stream', parsedUrl.pathname);
                return;
            }
            fetchedStream = fetched.stream;
            if (clientClosed) {
                destroyStream(fetchedStream);
                return;
            }
            const resource = createAudioResource(input.guildId || 'api-stream', fetched.stream, fetched.type ??
                (typeof urlResult.format === 'string' ? urlResult.format : 'unknown'), streamProcessorRuntime, input.filters, input.volume / 100, null, true, runtime.options.playback.audio?.loudnessNormalizer);
            pcmStream = resource.stream;
        }
        if (clientClosed) {
            cleanup();
            return;
        }
        if (!pcmStream) {
            throw new Error('The audio processor did not return a PCM stream.');
        }
        pcmStream.on('error', (error) => {
            // A client closing its response is a normal cancellation path. Do not
            // report the resulting premature-close as a playback/source failure.
            if (clientClosed || error.code === 'ERR_STREAM_PREMATURE_CLOSE') {
                return;
            }
            logger('error', 'LoadStream', `Pipeline component error: ${error.message} (${error.code})`);
        });
        streamResponse.writeHead(isRangeRequest ? 206 : 200, effectiveHeaders);
        if (isRangeRequest) {
            const outputStreams = [];
            if (rangeHeaderBytesToSend?.length) {
                outputStreams.push(Readable.from([rangeHeaderBytesToSend]));
            }
            if (pcmBytesToSend > 0) {
                outputStreams.push(createPcmRangeStream(pcmStream, pcmSkipBytes, pcmBytesToSend));
            }
            else {
                destroyStream(pcmStream);
            }
            const responseBody = Readable.from((async function* () {
                for (const output of outputStreams) {
                    for await (const chunk of output) {
                        yield chunk;
                    }
                }
            })(), { objectMode: false, highWaterMark: 19200 });
            pipeline(responseBody, streamResponse, (error) => {
                if (error && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
                    logger('error', 'LoadStream', `Range output failed for ${decodedTrack.info.title}: ${error.message}`);
                }
                cleanup();
            });
        }
        else {
            const output = isWav
                ? Readable.from((async function* () {
                    yield createWavHeader(isLiveStream ? null : totalPcmBytes);
                    for await (const chunk of pcmStream) {
                        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                    }
                })(), { objectMode: false, highWaterMark: 19200 })
                : pcmStream;
            pipeline(output, streamResponse, (error) => {
                if (error && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
                    logger('error', 'LoadStream', `Pipeline output failed for ${decodedTrack.info.title}: ${error.message}`);
                }
                cleanup();
            });
        }
    }
    catch (error) {
        cleanup();
        const errorMessage = error instanceof Error ? error.message : 'Fatal loadStream error.';
        logger('error', 'LoadStream', 'Fatal handler error:', error);
        if (!clientClosed &&
            !streamResponse.writableEnded &&
            !streamResponse.headersSent) {
            sendErrorResponse(req, res, 500, 'Internal Server Error', errorMessage, parsedUrl.pathname);
        }
        else if (!clientClosed && !streamResponse.writableEnded) {
            streamResponse.destroy(error instanceof Error ? error : new Error(errorMessage));
        }
    }
}
/**
 * Route module definition for the raw PCM stream endpoint.
 */
const loadStreamRoute = {
    handler,
    methods: ['GET', 'POST', 'HEAD', 'OPTIONS']
};
export default loadStreamRoute;
