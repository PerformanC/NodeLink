import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { PassThrough } from 'node:stream';
import zlib from 'node:zlib';
import HLSHandler from '../playback/hls/HLSHandler.js';
import { encodeTrack, logger } from '../utils.js';
const VIMEO_PATTERNS = [
    /^https?:\/\/(?:www\.)?vimeo\.com\/(\d+)(?:|[/?#])/i,
    /^https?:\/\/player\.vimeo\.com\/video\/(\d+)(?:|[/?#])/i,
    /^https?:\/\/(?:www\.)?vimeo\.com\/channels\/[^/]+\/(\d+)(?:|[/?#])/i,
    /^https?:\/\/(?:www\.)?vimeo\.com\/groups\/[^/]+\/videos\/(\d+)(?:|[/?#])/i,
    /^https?:\/\/(?:www\.)?vimeo\.com\/album\/\d+\/video\/(\d+)(?:|[/?#])/i,
    /^https?:\/\/(?:www\.)?vimeo\.com\/showcase\/\d+\/video\/(\d+)(?:|[/?#])/i
];
const VIMEO_BASE = 'https://vimeo.com';
const VIMEO_PLAYER_BASE = 'https://player.vimeo.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';
const CDN_PRIORITY = ['akfire_interconnect_quic', 'fastly_skyfire'];
const REQUEST_TIMEOUT = 15000;
const MAX_REDIRECTS = 5;
const SEGMENT_HIGH_WATER_MARK = 64 * 1024;
const PROGRESSIVE_HIGH_WATER_MARK = 16 * 1024;
const HANDOFF_TTL = 15000;
const HANDOFF_MAX = 20;
const HTTP_AGENT = new http.Agent({
    keepAlive: true,
    maxSockets: 16,
    maxFreeSockets: 4
});
const HTTPS_AGENT = new https.Agent({
    keepAlive: true,
    maxSockets: 16,
    maxFreeSockets: 4
});
const _CONFIG_PATTERNS = [
    /window\.playerConfig\s*=\s*(\{[\s\S]*?\});\s*(?:window\.|<\/script>|if\s*\()/i,
    /window\.playerConfig\s*=\s*(\{[\s\S]*?"video"[\s\S]*?\})\s*;/i,
    /"config"\s*:\s*(\{[\s\S]*?"request"[\s\S]*?\})\s*[,}]/i
];
const _functions = {
    parseJson(data) {
        try {
            const str = Buffer.isBuffer(data) ? data.toString('utf8') : data;
            return JSON.parse(str);
        }
        catch {
            return null;
        }
    },
    unescapeString(text) {
        if (!text)
            return '';
        const s = String(text);
        return s
            .replaceAll('\\u002F', '/')
            .replaceAll('\\/', '/')
            .replaceAll('\\u0026', '&')
            .replaceAll('\\u003C', '<')
            .replaceAll('\\u003E', '>')
            .replaceAll('\\"', '"')
            .replaceAll('&amp;', '&');
    },
    extractVideoId(url) {
        if (!url)
            return null;
        for (const pattern of VIMEO_PATTERNS) {
            const match = url.match(pattern);
            if (match?.[1])
                return match[1];
        }
        return null;
    },
    extractHashParam(url) {
        try {
            return new URL(url).searchParams.get('h');
        }
        catch {
            return null;
        }
    },
    decompressBody(body, encoding) {
        if (!encoding || !body)
            return body;
        const enc = Array.isArray(encoding) ? encoding[0] : encoding;
        try {
            switch (enc) {
                case 'gzip':
                    return zlib.gunzipSync(body);
                case 'deflate':
                    return zlib.inflateSync(body);
                case 'br':
                    return zlib.brotliDecompressSync(body);
                default:
                    return body;
            }
        }
        catch {
            return body;
        }
    },
    sortTracksByQuality(tracks) {
        return [...tracks].sort((a, b) => {
            const aSampleRate = a.sample_rate || a.audio_sample_rate || 0;
            const bSampleRate = b.sample_rate || b.audio_sample_rate || 0;
            const aIs48k = aSampleRate >= 44100;
            const bIs48k = bSampleRate >= 44100;
            if (aIs48k && !bIs48k)
                return -1;
            if (bIs48k && !aIs48k)
                return 1;
            const aBitrate = a.avg_bitrate || a.bitrate || 0;
            const bBitrate = b.avg_bitrate || b.bitrate || 0;
            return bBitrate - aBitrate;
        });
    },
    selectBestAudioTrack(tracks) {
        if (!Array.isArray(tracks) || tracks.length === 0)
            return null;
        const validTracks = tracks.filter((t) => (t?.segments?.length ?? 0) > 0);
        if (validTracks.length === 0)
            return null;
        const mp42Aac = validTracks.filter((t) => {
            const codecs = t.codecs || '';
            const format = t.format || '';
            return (codecs.includes('mp4a') &&
                (format === 'mp42' || format === 'iso5' || format === 'iso6'));
        });
        if (mp42Aac.length)
            return _functions.sortTracksByQuality(mp42Aac)[0] ?? null;
        const aac = validTracks.filter((t) => (t.codecs || '').includes('mp4a'));
        if (aac.length)
            return _functions.sortTracksByQuality(aac)[0] ?? null;
        let best = validTracks[0] ?? null;
        for (const t of validTracks) {
            const bw = t?.avg_bitrate || t?.bitrate || 0;
            if (bw > ((best?.avg_bitrate ?? 0) || (best?.bitrate ?? 0))) {
                best = t;
            }
        }
        return best;
    },
    playlistDir(playlistUrl) {
        const urlWithoutQuery = playlistUrl.split('?')[0] || '';
        return urlWithoutQuery.substring(0, urlWithoutQuery.lastIndexOf('/') + 1);
    },
    buildSegmentUrl(playlistDir, basePath, trackPath, segmentPath) {
        try {
            const relativePath = (basePath || '') + (trackPath || '') + segmentPath;
            return new URL(relativePath, playlistDir).href;
        }
        catch (err) {
            logger('error', 'Sources', `[vimeo] Failed to build segment URL: ${err instanceof Error ? err.message : String(err)}`);
            return null;
        }
    },
    resolveRedirectUrl(currentUrl, location) {
        if (!location)
            return null;
        if (location.startsWith('/')) {
            const u = new URL(currentUrl);
            return `${u.protocol}//${u.host}${location}`;
        }
        return location;
    },
    makeHeaders(extra) {
        return {
            'User-Agent': USER_AGENT,
            Accept: '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            Connection: 'keep-alive',
            ...extra
        };
    },
    async httpRequest(url, options = {}) {
        let currentUrl = url;
        const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
        for (let i = 0; i <= maxRedirects; i++) {
            const urlObj = new URL(currentUrl);
            const isHttps = urlObj.protocol === 'https:';
            const httpLib = isHttps ? https : http;
            const headers = _functions.makeHeaders({
                'Accept-Encoding': 'gzip, deflate, br',
                ...options.headers
            });
            const { timeout = REQUEST_TIMEOUT } = options;
            const res = await new Promise((resolve, reject) => {
                const req = httpLib.request({
                    hostname: urlObj.hostname,
                    port: urlObj.port || (isHttps ? 443 : 80),
                    path: urlObj.pathname + urlObj.search,
                    method: options.method || 'GET',
                    headers,
                    timeout,
                    agent: isHttps ? HTTPS_AGENT : HTTP_AGENT
                }, resolve);
                req.once('error', reject);
                req.once('timeout', () => req.destroy(new Error('Request timeout')));
                req.end();
            });
            if (res.statusCode !== undefined &&
                res.statusCode >= 300 &&
                res.statusCode < 400 &&
                res.headers.location) {
                res.resume();
                const redirectUrl = _functions.resolveRedirectUrl(currentUrl, res.headers.location);
                if (!redirectUrl)
                    throw new Error('Redirect without location');
                currentUrl = redirectUrl;
                continue;
            }
            const chunks = [];
            let totalSize = 0;
            const maxSize = options.maxSize || 10 * 1024 * 1024;
            const statusCode = res.statusCode ?? 0;
            const resHeaders = res.headers;
            const body = await new Promise((resolve, reject) => {
                res.on('data', (chunk) => {
                    totalSize += chunk.length;
                    if (totalSize > maxSize) {
                        res.destroy(new Error('Response too large'));
                        return;
                    }
                    chunks.push(chunk);
                });
                res.once('error', (err) => {
                    chunks.length = 0;
                    reject(err);
                });
                res.once('end', () => {
                    const raw = Buffer.concat(chunks, totalSize);
                    chunks.length = 0;
                    resolve(_functions.decompressBody(raw, resHeaders['content-encoding']));
                });
            });
            return { statusCode, headers: resHeaders, body };
        }
        throw new Error('Too many redirects');
    },
    async pumpUrlToWritable(url, writable, options = {}) {
        let currentUrl = url;
        const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
        const timeout = options.timeout ?? REQUEST_TIMEOUT;
        const maxSize = options.maxSize ?? 0;
        let req = null;
        let res = null;
        let done = false;
        const cancel = (err) => {
            if (done)
                return;
            done = true;
            if (res && !res.destroyed)
                res.destroy(err);
            if (req && !req.destroyed)
                req.destroy(err);
        };
        const onWritableClose = () => cancel(new Error('Destination closed'));
        const onWritableError = (err) => cancel(err);
        writable.once('close', onWritableClose);
        writable.once('error', onWritableError);
        try {
            for (let i = 0; i <= maxRedirects; i++) {
                if (writable.destroyed)
                    throw new Error('Destination destroyed');
                const urlObj = new URL(currentUrl);
                const isHttps = urlObj.protocol === 'https:';
                const httpLib = isHttps ? https : http;
                const headers = _functions.makeHeaders({
                    'Accept-Encoding': 'identity',
                    ...options.headers
                });
                res = await new Promise((resolve, reject) => {
                    const newReq = httpLib.request({
                        hostname: urlObj.hostname,
                        port: urlObj.port || (isHttps ? 443 : 80),
                        path: urlObj.pathname + urlObj.search,
                        method: 'GET',
                        headers,
                        timeout,
                        agent: isHttps ? HTTPS_AGENT : HTTP_AGENT
                    }, resolve);
                    req = newReq;
                    newReq.once('error', reject);
                    newReq.once('timeout', () => newReq.destroy(new Error('Request timeout')));
                    newReq.end();
                });
                const code = res.statusCode ?? 0;
                if (code >= 300 && code < 400 && res.headers.location) {
                    res.resume();
                    const redirectUrl = _functions.resolveRedirectUrl(currentUrl, res.headers.location);
                    if (!redirectUrl)
                        throw new Error('Redirect without location');
                    currentUrl = redirectUrl;
                    req = null;
                    res = null;
                    continue;
                }
                if (code >= 400) {
                    res.resume();
                    throw new Error(`HTTP ${code}`);
                }
                const currentRes = res;
                const bytes = await new Promise((resolve, reject) => {
                    let total = 0;
                    let draining = false;
                    const cleanup = () => {
                        currentRes.removeListener('data', onData);
                        currentRes.removeListener('end', onEnd);
                        currentRes.removeListener('error', onErr);
                        currentRes.removeListener('close', onClose);
                        writable.removeListener('drain', onDrain);
                    };
                    const onDrain = () => {
                        draining = false;
                        if (!currentRes.destroyed && !writable.destroyed)
                            currentRes.resume();
                    };
                    const onData = (chunk) => {
                        total += chunk.length;
                        if (maxSize && total > maxSize) {
                            cleanup();
                            currentRes.destroy(new Error('Response too large'));
                            return;
                        }
                        if (writable.destroyed) {
                            cleanup();
                            currentRes.destroy(new Error('Destination destroyed'));
                            return;
                        }
                        if (!writable.write(chunk) && !draining) {
                            draining = true;
                            currentRes.pause();
                            writable.once('drain', onDrain);
                        }
                    };
                    const onEnd = () => {
                        cleanup();
                        resolve(total);
                    };
                    const onErr = (err) => {
                        cleanup();
                        reject(err);
                    };
                    const onClose = () => {
                        if (done)
                            return;
                        cleanup();
                        reject(new Error('Response closed early'));
                    };
                    currentRes.on('data', onData);
                    currentRes.once('end', onEnd);
                    currentRes.once('error', onErr);
                    currentRes.once('close', onClose);
                });
                return bytes;
            }
            throw new Error('Too many redirects');
        }
        finally {
            done = true;
            writable.removeListener('close', onWritableClose);
            writable.removeListener('error', onWritableError);
            req = null;
            res = null;
        }
    }
};
function curlRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const args = [
            '-s',
            '-L',
            '-A',
            USER_AGENT,
            '-H',
            'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            '-H',
            'Accept-Language: en-US,en;q=0.9',
            '-H',
            'Accept-Encoding: gzip, deflate, br',
            '-H',
            'DNT: 1',
            '-H',
            'Connection: keep-alive',
            '-H',
            'Upgrade-Insecure-Requests: 1',
            '-H',
            'Sec-Fetch-Dest: iframe',
            '-H',
            'Sec-Fetch-Mode: navigate',
            '-H',
            'Sec-Fetch-Site: cross-site',
            '--compressed',
            '-w',
            '\n%{http_code}',
            '-m',
            String(Math.floor(REQUEST_TIMEOUT / 1000))
        ];
        if (options.referer)
            args.push('-H', `Referer: ${options.referer}`);
        if (options.origin)
            args.push('-H', `Origin: ${options.origin}`);
        args.push(url);
        const curlProcess = spawn('curl', args);
        const outputChunks = [];
        let completed = false;
        const cleanup = () => {
            outputChunks.length = 0;
            curlProcess.stdout.removeAllListeners();
            curlProcess.stderr.removeAllListeners();
            curlProcess.removeAllListeners();
        };
        const timeoutId = setTimeout(() => {
            if (completed)
                return;
            completed = true;
            curlProcess.kill('SIGTERM');
            cleanup();
            reject(new Error('curl timeout'));
        }, REQUEST_TIMEOUT);
        timeoutId.unref?.();
        curlProcess.stdout.on('data', (chunk) => outputChunks.push(chunk));
        curlProcess.stderr.resume();
        curlProcess.once('error', (err) => {
            clearTimeout(timeoutId);
            if (completed)
                return;
            completed = true;
            cleanup();
            reject(err);
        });
        curlProcess.once('close', (exitCode) => {
            clearTimeout(timeoutId);
            if (completed)
                return;
            completed = true;
            if (exitCode !== 0) {
                cleanup();
                return reject(new Error(`curl exited with code ${exitCode}`));
            }
            const output = Buffer.concat(outputChunks).toString('utf8');
            outputChunks.length = 0;
            const lastNewlineIndex = output.lastIndexOf('\n');
            const statusCode = parseInt(output.slice(lastNewlineIndex + 1), 10) || 0;
            const bodyText = output.slice(0, lastNewlineIndex);
            cleanup();
            resolve({
                statusCode,
                headers: {},
                body: Buffer.from(bodyText, 'utf8')
            });
        });
    });
}
class SegmentStreamer {
    constructor(playlistData, outputStream) {
        this.playlistData = playlistData;
        this.outputStream = outputStream;
        this.aborted = false;
        this.segmentsFetched = 0;
        this.bytesWritten = 0;
        this._playlistDir = null;
    }
    abort() {
        this.aborted = true;
    }
    async start() {
        const { playlistUrl, basePath, trackPath, initSegment, segments, isDashFormat } = this.playlistData || {};
        if (!playlistUrl || !Array.isArray(segments) || !this.outputStream) {
            if (this.outputStream && !this.outputStream.destroyed) {
                this.outputStream.destroy(new Error('Invalid Vimeo playlist data'));
            }
            return;
        }
        const outputStream = this.outputStream;
        const playlistDir = _functions.playlistDir(playlistUrl);
        this._playlistDir = playlistDir;
        const onClose = () => this.abort();
        const onError = () => this.abort();
        outputStream.once('close', onClose);
        outputStream.once('error', onError);
        try {
            if (initSegment && !this.aborted) {
                const initBuffer = Buffer.from(initSegment, 'base64');
                logger('debug', 'Sources', `[vimeo] Writing init segment: ${initBuffer.length} bytes (dash: ${isDashFormat})`);
                if (outputStream.destroyed || this.aborted)
                    return;
                if (!outputStream.write(initBuffer)) {
                    await new Promise((resolve) => {
                        const onDrain = () => {
                            cleanup();
                            resolve();
                        };
                        const onClose2 = () => {
                            cleanup();
                            resolve();
                        };
                        const cleanup = () => {
                            outputStream.removeListener('drain', onDrain);
                            outputStream.removeListener('close', onClose2);
                        };
                        outputStream.once('drain', onDrain);
                        outputStream.once('close', onClose2);
                    });
                }
                this.bytesWritten += initBuffer.length;
            }
            for (let i = 0; i < segments.length; i++) {
                if (this.aborted || outputStream.destroyed)
                    break;
                const segmentPath = segments[i]?.url;
                if (!segmentPath)
                    continue;
                const segmentUrl = _functions.buildSegmentUrl(playlistDir, basePath || '', trackPath || '', segmentPath);
                if (!segmentUrl) {
                    logger('warn', 'Sources', `[vimeo] Failed to build segment URL: ${segmentPath}`);
                    continue;
                }
                try {
                    const bytes = await _functions.pumpUrlToWritable(segmentUrl, outputStream, {
                        headers: {
                            Accept: '*/*',
                            Origin: VIMEO_BASE,
                            Referer: `${VIMEO_BASE}/`,
                            'Sec-Fetch-Dest': 'empty',
                            'Sec-Fetch-Mode': 'cors',
                            'Sec-Fetch-Site': 'cross-site'
                        },
                        timeout: REQUEST_TIMEOUT,
                        maxSize: 5 * 1024 * 1024
                    });
                    if (this.aborted || outputStream.destroyed)
                        break;
                    if (bytes > 0) {
                        this.segmentsFetched++;
                        this.bytesWritten += bytes;
                    }
                    else {
                        logger('warn', 'Sources', `[vimeo] Empty segment ${i + 1}/${segments.length}`);
                    }
                }
                catch (err) {
                    if (this.aborted || outputStream.destroyed)
                        break;
                    logger('warn', 'Sources', `[vimeo] Segment fetch error (${i + 1}/${segments.length}): ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            logger('debug', 'Sources', `[vimeo] Streaming complete: ${this.segmentsFetched}/${segments.length} segments, ${this.bytesWritten} bytes`);
            if (!this.aborted && !outputStream.destroyed) {
                outputStream.emit('finishBuffering');
                outputStream.end();
            }
        }
        catch (error) {
            logger('error', 'Sources', `[vimeo] Segment streaming error: ${error instanceof Error ? error.message : String(error)}`);
            if (!outputStream.destroyed) {
                outputStream.destroy(error instanceof Error ? error : new Error(String(error)));
            }
        }
        finally {
            outputStream.removeListener('close', onClose);
            outputStream.removeListener('error', onError);
            this.cleanup();
        }
    }
    cleanup() {
        this.aborted = true;
        this.playlistData = null;
        this.outputStream = null;
        this._playlistDir = null;
    }
}
export default class VimeoSource {
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.config = nodelink.options;
        this.searchTerms = [];
        this.patterns = VIMEO_PATTERNS;
        this.priority = 70;
        this._curlAvailable = null;
        this._activeStreams = new Set();
        this._handoff = new Map();
    }
    _handoffGet(key) {
        const entry = this._handoff.get(key);
        if (!entry)
            return null;
        if (Date.now() >= entry.expiresAt) {
            this._handoff.delete(key);
            return null;
        }
        return entry.value;
    }
    _handoffSet(key, value) {
        const now = Date.now();
        for (const [k, v] of this._handoff) {
            if (now >= v.expiresAt)
                this._handoff.delete(k);
        }
        while (this._handoff.size >= HANDOFF_MAX) {
            const firstKey = this._handoff.keys().next().value;
            if (firstKey !== undefined)
                this._handoff.delete(firstKey);
        }
        this._handoff.set(key, { value, expiresAt: now + HANDOFF_TTL });
    }
    _handoffTake(key) {
        const value = this._handoffGet(key);
        if (value)
            this._handoff.delete(key);
        return value;
    }
    async _checkCurlAvailability() {
        if (this._curlAvailable !== null)
            return this._curlAvailable;
        return new Promise((resolve) => {
            const curlProcess = spawn('curl', ['--version']);
            curlProcess.once('error', () => {
                this._curlAvailable = false;
                resolve(false);
            });
            curlProcess.once('close', (code) => {
                this._curlAvailable = code === 0;
                resolve(this._curlAvailable);
            });
            curlProcess.stdout.resume();
            curlProcess.stderr.resume();
        });
    }
    async setup() {
        await this._checkCurlAvailability();
        return true;
    }
    match(url) {
        return _functions.extractVideoId(url) !== null;
    }
    async search() {
        return { loadType: 'empty', data: {} };
    }
    async resolve(url) {
        const videoId = _functions.extractVideoId(url);
        const hashParam = _functions.extractHashParam(url);
        if (!videoId)
            return { loadType: 'empty', data: {} };
        const metadata = await this._fetchVideoMetadata(videoId, hashParam);
        if (!metadata?.title)
            return { loadType: 'empty', data: {} };
        const trackInfo = {
            title: metadata.title,
            author: metadata.author || 'Unknown',
            length: metadata.durationMs || 0,
            identifier: videoId,
            isSeekable: true,
            isStream: false,
            uri: `https://vimeo.com/${videoId}${hashParam ? `?h=${hashParam}` : ''}`,
            artworkUrl: metadata.artworkUrl || null,
            isrc: null,
            sourceName: 'vimeo',
            position: 0,
            details: [],
            userData: hashParam ? { vimeo: { h: hashParam } } : undefined
        };
        return {
            loadType: 'track',
            data: {
                encoded: encodeTrack(trackInfo),
                info: trackInfo,
                pluginInfo: {}
            }
        };
    }
    async getTrackUrl(decodedTrack) {
        const videoId = decodedTrack?.identifier;
        const hashParam = decodedTrack?.userData?.vimeo?.h || null;
        if (!videoId) {
            return {
                exception: {
                    message: 'Invalid Vimeo track identifier',
                    severity: 'fault'
                }
            };
        }
        try {
            const result = await this._extractFromEmbed(videoId, hashParam);
            if (result && 'playlistData' in result && result.playlistData) {
                const key = `handoff:${videoId}:${hashParam || ''}`;
                this._handoffSet(key, result);
            }
            return result;
        }
        catch (err) {
            logger('warn', 'Sources', `[vimeo] Embed extraction failed for ${videoId}: ${err instanceof Error ? err.message : String(err)}`);
            return {
                exception: {
                    message: 'Failed to extract Vimeo stream. Video may be private or require authentication.',
                    severity: 'fault',
                    cause: 'Upstream'
                }
            };
        }
    }
    async loadStream(decodedTrack, url, protocol) {
        if (protocol === 'hls') {
            logger('debug', 'Sources', '[vimeo] Loading HLS stream');
            return {
                stream: new HLSHandler(url, {
                    headers: {
                        'User-Agent': USER_AGENT,
                        Referer: `${VIMEO_BASE}/`,
                        Origin: VIMEO_BASE
                    },
                    localAddress: this.nodelink.routePlanner?.getIP?.() ?? undefined,
                    type: 'mpegts'
                }),
                type: 'mpegts'
            };
        }
        const isProgressive = protocol === 'https' || protocol === 'http';
        const highWaterMark = isProgressive
            ? PROGRESSIVE_HIGH_WATER_MARK
            : SEGMENT_HIGH_WATER_MARK;
        const stream = new PassThrough({
            highWaterMark,
            emitClose: true,
            autoDestroy: true
        });
        this._activeStreams.add(stream);
        const cleanup = () => {
            this._activeStreams.delete(stream);
            stream._segmentStreamer = null;
        };
        stream.once('close', cleanup);
        stream.once('error', cleanup);
        if (isProgressive) {
            setImmediate(() => {
                _functions
                    .pumpUrlToWritable(url, stream, { timeout: REQUEST_TIMEOUT })
                    .then(() => {
                    if (!stream.destroyed) {
                        stream.emit('finishBuffering');
                        stream.end();
                    }
                })
                    .catch((err) => {
                    if (!stream.destroyed)
                        stream.destroy(err);
                });
            });
            return { stream };
        }
        if (protocol === 'segmented') {
            const videoId = decodedTrack?.identifier;
            const hashParam = decodedTrack?.userData?.vimeo?.h || '';
            const key = `handoff:${videoId}:${hashParam}`;
            setImmediate(async () => {
                try {
                    if (stream.destroyed)
                        return;
                    let playlistResult = this._handoffTake(key);
                    if (!playlistResult?.playlistData) {
                        playlistResult = await this._fetchPlaylist(url, videoId || 'unknown');
                    }
                    if (!playlistResult?.playlistData)
                        throw new Error('Vimeo playlistData not found');
                    const segmentStreamer = new SegmentStreamer(playlistResult.playlistData, stream);
                    stream._segmentStreamer = segmentStreamer;
                    await segmentStreamer.start();
                }
                catch (err) {
                    if (!stream.destroyed)
                        stream.destroy(err instanceof Error ? err : new Error(String(err)));
                }
            });
            return { stream };
        }
        stream.destroy(new Error(`Unsupported protocol: ${protocol}`));
        return { stream };
    }
    cleanupAllStreams() {
        for (const stream of this._activeStreams) {
            if (!stream.destroyed)
                stream.destroy();
        }
        this._activeStreams.clear();
        this._handoff.clear();
    }
    async _fetchVideoMetadata(videoId, hashParam) {
        try {
            const targetUrl = hashParam
                ? `https://vimeo.com/${videoId}?h=${hashParam}`
                : `https://vimeo.com/${videoId}`;
            const oembedUrl = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(targetUrl)}`;
            const response = await _functions.httpRequest(oembedUrl, {
                headers: { Accept: 'application/json' },
                maxSize: 1024 * 1024
            });
            if (response.statusCode >= 400)
                return this._fetchMetadataFromApiV2(videoId);
            const data = _functions.parseJson(response.body);
            if (!data?.title)
                return this._fetchMetadataFromApiV2(videoId);
            return {
                title: data.title,
                author: data.author_name || 'Unknown',
                durationMs: (data.duration || 0) * 1000,
                artworkUrl: data.thumbnail_url || null
            };
        }
        catch {
            return this._fetchMetadataFromApiV2(videoId);
        }
    }
    async _fetchMetadataFromApiV2(videoId) {
        try {
            const response = await _functions.httpRequest(`https://vimeo.com/api/v2/video/${videoId}.json`, {
                headers: { Accept: 'application/json' },
                maxSize: 1024 * 1024
            });
            if (response.statusCode >= 400)
                return null;
            const data = _functions.parseJson(response.body);
            if (!Array.isArray(data) || !data[0])
                return null;
            const video = data[0];
            return {
                title: video.title || 'Unknown',
                author: video.user_name || 'Unknown',
                durationMs: (video.duration || 0) * 1000,
                artworkUrl: video.thumbnail_large || video.thumbnail_medium || null
            };
        }
        catch {
            return null;
        }
    }
    async _extractFromEmbed(videoId, hashParam) {
        const playerUrl = hashParam
            ? `${VIMEO_PLAYER_BASE}/video/${videoId}?h=${hashParam}&app_id=122963`
            : `${VIMEO_PLAYER_BASE}/video/${videoId}?app_id=122963`;
        let response;
        if (this._curlAvailable) {
            try {
                response = await curlRequest(playerUrl, {
                    referer: `${VIMEO_BASE}/${videoId}`,
                    origin: VIMEO_BASE
                });
            }
            catch {
                response = (await _functions.httpRequest(playerUrl, {
                    headers: {
                        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Sec-Fetch-Dest': 'iframe',
                        'Sec-Fetch-Mode': 'navigate',
                        'Sec-Fetch-Site': 'cross-site',
                        Referer: `${VIMEO_BASE}/${videoId}`,
                        Origin: VIMEO_BASE
                    },
                    maxSize: 5 * 1024 * 1024
                }));
            }
        }
        else {
            response = (await _functions.httpRequest(playerUrl, {
                headers: {
                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Sec-Fetch-Dest': 'iframe',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'cross-site',
                    Referer: `${VIMEO_BASE}/${videoId}`,
                    Origin: VIMEO_BASE
                },
                maxSize: 5 * 1024 * 1024
            }));
        }
        if (response.statusCode >= 400)
            throw new Error(`HTTP ${response.statusCode}`);
        const html = response.body.toString('utf8');
        if (html.includes('Just a moment') || html.includes('challenge-platform')) {
            throw new Error('Cloudflare challenge detected');
        }
        return this._parsePageForConfig(html, playerUrl, videoId);
    }
    async _parsePageForConfig(html, refererUrl, videoId) {
        const cfgKeyIdx = html.indexOf('"config_url"');
        if (cfgKeyIdx !== -1) {
            const q1 = html.indexOf('"', html.indexOf(':', cfgKeyIdx) + 1);
            const q2 = q1 !== -1 ? html.indexOf('"', q1 + 1) : -1;
            if (q1 !== -1 && q2 !== -1) {
                const raw = html.slice(q1 + 1, q2);
                try {
                    const result = await this._fetchConfigFromUrl(_functions.unescapeString(raw), refererUrl, videoId);
                    if (result)
                        return result;
                }
                catch { }
            }
        }
        const cfgKeyIdx2 = html.indexOf('data-config-url="');
        if (cfgKeyIdx2 !== -1) {
            const start = cfgKeyIdx2 + 'data-config-url="'.length;
            const end = html.indexOf('"', start);
            if (end !== -1) {
                try {
                    const result = await this._fetchConfigFromUrl(_functions.unescapeString(html.slice(start, end)), refererUrl, videoId);
                    if (result)
                        return result;
                }
                catch { }
            }
        }
        for (const pattern of _CONFIG_PATTERNS) {
            const match = html.match(pattern);
            if (!match?.[1])
                continue;
            const config = this._parseJsonConfig(match[1]);
            if (!config)
                continue;
            const result = await this._extractPlaylistFromConfig(config, refererUrl, videoId);
            if (result)
                return result;
        }
        const cdnMatch = html.match(/(https?:\/\/[^"'\s\\]*vimeocdn\.com[^"'\s\\]*playlist\.json[^"'\s\\]*)/i);
        if (cdnMatch?.[1]) {
            try {
                const result = await this._fetchPlaylist(_functions.unescapeString(cdnMatch[1]), videoId);
                if (result)
                    return result;
            }
            catch { }
        }
        const progressiveMatch = html.match(/"progressive"\s*:\s*\[([\s\S]*?)\]/i);
        if (progressiveMatch?.[1]) {
            const result = this._handleProgressiveUrls(progressiveMatch[1], videoId);
            if (result)
                return result;
        }
        throw new Error('No config found in embed page');
    }
    _handleProgressiveUrls(progressiveJson, videoId) {
        try {
            const parsed = _functions.parseJson(`[${progressiveJson}]`);
            if (Array.isArray(parsed) && parsed.length) {
                const sorted = [...parsed].sort((a, b) => (a?.height || 0) - (b?.height || 0));
                const best = sorted.find((p) => (p?.height || 0) >= 360) ||
                    sorted[sorted.length - 1];
                if (best?.url) {
                    logger('warn', 'Sources', `[vimeo] Using progressive stream for ${videoId} (${best.height || 0}p)`);
                    return {
                        url: _functions.unescapeString(best.url),
                        protocol: 'https',
                        format: 'mp4',
                        additionalData: {
                            source: 'vimeo.progressive',
                            quality: best.quality,
                            height: best.height || 0
                        }
                    };
                }
            }
        }
        catch { }
        try {
            const urls = [];
            let pos = 0;
            while (true) {
                const urlStart = progressiveJson.indexOf('"url"', pos);
                if (urlStart === -1)
                    break;
                const valueStart = progressiveJson.indexOf('"', urlStart + 5);
                if (valueStart === -1)
                    break;
                const valueEnd = progressiveJson.indexOf('"', valueStart + 1);
                if (valueEnd === -1)
                    break;
                const url = _functions.unescapeString(progressiveJson.substring(valueStart + 1, valueEnd));
                let height = 0;
                const before = progressiveJson.substring(pos, urlStart);
                const heightKey = before.lastIndexOf('"height"');
                if (heightKey !== -1) {
                    const colon = before.indexOf(':', heightKey);
                    if (colon !== -1) {
                        const num = before
                            .slice(colon + 1)
                            .trim()
                            .split(',')[0] || '0';
                        height = parseInt(num, 10) || 0;
                    }
                }
                urls.push({ url, height });
                pos = valueEnd + 1;
            }
            urls.sort((a, b) => a.height - b.height);
            const best = urls.find((p) => p.height >= 360) || urls[urls.length - 1];
            if (best?.url) {
                logger('warn', 'Sources', `[vimeo] Using progressive stream for ${videoId} (${best.height}p)`);
                return {
                    url: best.url,
                    protocol: 'https',
                    format: 'mp4',
                    additionalData: { source: 'vimeo.progressive', height: best.height }
                };
            }
        }
        catch { }
        return null;
    }
    _parseJsonConfig(configString) {
        try {
            let braceDepth = 0;
            let endIndex = 0;
            for (let i = 0; i < configString.length; i++) {
                const c = configString[i];
                if (c === '{')
                    braceDepth++;
                else if (c === '}')
                    braceDepth--;
                if (braceDepth === 0 && i > 0) {
                    endIndex = i + 1;
                    break;
                }
            }
            return _functions.parseJson(configString.substring(0, endIndex || configString.length));
        }
        catch {
            return null;
        }
    }
    async _fetchConfigFromUrl(configUrl, refererUrl, videoId) {
        if (configUrl.startsWith('/')) {
            const refUrl = new URL(refererUrl);
            configUrl = `${refUrl.protocol}//${refUrl.host}${configUrl}`;
        }
        const response = await _functions.httpRequest(configUrl, {
            headers: {
                Accept: 'application/json',
                Referer: refererUrl,
                Origin: VIMEO_BASE
            },
            maxSize: 2 * 1024 * 1024
        });
        if (response.statusCode >= 400)
            throw new Error(`HTTP ${response.statusCode}`);
        const config = _functions.parseJson(response.body);
        if (!config)
            throw new Error('Invalid config JSON');
        return this._extractPlaylistFromConfig(config, configUrl, videoId);
    }
    async _extractPlaylistFromConfig(config, refererUrl, videoId) {
        let files = config?.request?.files;
        if (!files)
            files = config?.video?.files || config?.files || config?.clip?.files;
        if (!files) {
            const nested = config?.config || config?.player?.config || config?.data?.config;
            if (nested)
                return this._extractPlaylistFromConfig(nested, refererUrl, videoId);
        }
        if (!files)
            throw new Error('No files in config');
        const pickCdn = (cdns, def) => {
            for (const name of CDN_PRIORITY)
                if (cdns?.[name])
                    return cdns[name];
            return cdns?.[def || ''] ?? (cdns ? Object.values(cdns)[0] : null) ?? null;
        };
        const dash = files.dash;
        if (dash?.cdns) {
            const selected = pickCdn(dash.cdns, dash.default_cdn);
            if (selected) {
                let playlistUrl = _functions.unescapeString(selected.avc_url || selected.url || '');
                if (playlistUrl) {
                    if (!playlistUrl.includes('playlist.json') &&
                        !playlistUrl.includes('master.json')) {
                        playlistUrl = playlistUrl.replace(/\/[^/?]+(\?|$)/, '/playlist.json$1');
                    }
                    if (!playlistUrl.includes('omit=')) {
                        playlistUrl += `${playlistUrl.includes('?') ? '&' : '?'}omit=av1-hevc`;
                    }
                    try {
                        return await this._fetchPlaylist(playlistUrl, videoId);
                    }
                    catch { }
                }
            }
        }
        const hls = files.hls;
        if (hls?.cdns) {
            const selected = pickCdn(hls.cdns, hls.default_cdn);
            if (selected?.url) {
                return {
                    url: _functions.unescapeString(selected.url),
                    protocol: 'hls',
                    format: 'mpegts',
                    additionalData: { source: 'vimeo.hls' }
                };
            }
        }
        const progressive = files.progressive;
        if (Array.isArray(progressive) && progressive.length) {
            const sorted = [...progressive].sort((a, b) => (a.height || 0) - (b.height || 0));
            const best = sorted.find((p) => (p.height || 0) >= 360) || sorted[sorted.length - 1];
            if (best?.url) {
                logger('warn', 'Sources', `[vimeo] Using progressive stream for ${videoId}`);
                return {
                    url: best.url,
                    protocol: 'https',
                    format: 'mp4',
                    additionalData: {
                        source: 'vimeo.progressive',
                        quality: best.quality,
                        height: best.height
                    }
                };
            }
        }
        throw new Error('No playable streams in config');
    }
    async _fetchPlaylist(playlistUrl, _videoId) {
        const response = await _functions.httpRequest(playlistUrl, {
            headers: {
                Accept: '*/*',
                Origin: VIMEO_BASE,
                Referer: `${VIMEO_BASE}/`,
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Site': 'cross-site'
            },
            maxSize: 2 * 1024 * 1024
        });
        if (response.statusCode >= 400)
            throw new Error(`HTTP ${response.statusCode}`);
        const playlist = _functions.parseJson(response.body);
        if (!playlist)
            throw new Error('Invalid playlist JSON');
        if (playlist.audio?.length) {
            const audioTrack = _functions.selectBestAudioTrack(playlist.audio);
            if (audioTrack) {
                const segments = (audioTrack.segments || []).map((seg) => ({
                    url: seg.url,
                    start: seg.start,
                    end: seg.end,
                    size: seg.size
                }));
                const sampleRate = audioTrack.sample_rate || audioTrack.audio_sample_rate || 48000;
                const isDashFormat = audioTrack.format === 'dash';
                let basePath = playlist.base_url || '';
                let trackPath = audioTrack.base_url || '';
                if (!basePath && !trackPath)
                    basePath = '../../../../../';
                else if (basePath && !basePath.endsWith('/'))
                    basePath += '/';
                if (trackPath && !trackPath.endsWith('/'))
                    trackPath += '/';
                const playlistData = {
                    playlistUrl,
                    basePath,
                    trackPath,
                    initSegment: audioTrack.init_segment || null,
                    segments,
                    duration: audioTrack.duration,
                    bitrate: audioTrack.avg_bitrate || audioTrack.bitrate,
                    codecs: audioTrack.codecs,
                    sampleRate,
                    clipId: playlist.clip_id,
                    isDashFormat
                };
                logger('debug', 'Sources', `[vimeo] Using audio: ${audioTrack.codecs} @ ${playlistData.bitrate}bps, ${sampleRate}Hz, ${segments.length} segments, format: ${audioTrack.format}`);
                return {
                    url: playlistUrl,
                    protocol: 'segmented',
                    format: 'mp4',
                    playlistData,
                    additionalData: {
                        source: 'vimeo.adaptive',
                        bitrate: playlistData.bitrate,
                        codecs: playlistData.codecs,
                        segments: segments.length,
                        sampleRate,
                        format: audioTrack.format
                    }
                };
            }
        }
        if (playlist.video?.length) {
            logger('warn', 'Sources', `[vimeo] No compatible audio tracks, falling back to video track`);
            const video = playlist.video.reduce((best, v) => {
                const bw = v.avg_bitrate || v.bitrate || 0;
                return bw > (best?.avg_bitrate || best?.bitrate || 0) ? v : best;
            }, null);
            if (video?.segments?.length) {
                const segments = video.segments.map((seg) => ({
                    url: seg.url,
                    start: seg.start,
                    end: seg.end,
                    size: seg.size
                }));
                const playlistData = {
                    playlistUrl,
                    basePath: playlist.base_url || '',
                    trackPath: video.base_url || '',
                    initSegment: video.init_segment || null,
                    segments,
                    duration: video.duration,
                    bitrate: video.avg_bitrate || video.bitrate,
                    codecs: video.codecs,
                    clipId: playlist.clip_id,
                    isDashFormat: video.format === 'dash'
                };
                return {
                    url: playlistUrl,
                    protocol: 'segmented',
                    format: 'mp4',
                    playlistData,
                    additionalData: {
                        source: 'vimeo.video-only',
                        segments: segments.length
                    }
                };
            }
        }
        throw new Error('No compatible audio tracks in playlist');
    }
}
