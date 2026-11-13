import { PassThrough } from 'node:stream';
import { DASHHandler } from '../playback/dash/DASHHandler.js';
import HLSHandler from '../playback/hls/HLSHandler.js';
import { encodeTrack, http1makeRequest, logger } from '../utils.js';
/**
 * NodeLink audio source provider for Monochrome (Lossless FLAC proxy).
 *
 * This source connects to the Monochrome v2.10 infrastructure (tracks.monochrome.st)
 * and supports custom user-configured instances with health-tracked pool management.
 *
 * @public
 */
class MonochromeSource {
    /** Master NodeLink instance reference. */
    nodelink;
    /** Source configuration object. */
    config;
    /** Registered search terms for identifier routing. */
    searchTerms = ['mcsearch'];
    /** URL regex patterns this source can handle. */
    patterns;
    /** Source priority for URL matching. */
    priority = 100;
    apiInstances = [];
    streamingInstances = [];
    qobuzInstances = [];
    trackMetadataCache = new Map();
    /**
     * Declarative test suite validating Monochrome search, track, release, and artist resolution.
     */
    static _TESTS = [
        {
            id: 'monochrome.search',
            name: 'Monochrome track search (Two Birds Regina Spektor)',
            input: {
                type: 'search',
                value: 'Two Birds Regina Spektor'
            },
            expect: {
                result: { type: 'search' },
                collection: { minItems: 1 },
                metadata: {
                    title: {
                        op: 'matches',
                        value: /Two Birds/i
                    },
                    author: {
                        op: 'matches',
                        value: /Regina Spektor/i
                    },
                    sourceName: {
                        op: 'equals',
                        value: 'monochrome'
                    }
                }
            }
        },
        {
            id: 'monochrome.track.resolve',
            name: 'Monochrome track resolution and FLAC probe (/track/ID)',
            input: {
                type: 'resolve',
                value: 'https://monochrome.st/track/166687134672957440'
            },
            matrix: {
                variants: [
                    {
                        id: 'flac',
                        label: 'Direct FLAC Stream'
                    }
                ]
            },
            expect: {
                result: { type: 'track' },
                metadata: {
                    title: {
                        op: 'matches',
                        value: /Two Birds/i
                    },
                    author: {
                        op: 'matches',
                        value: /Regina Spektor/i
                    },
                    sourceName: {
                        op: 'equals',
                        value: 'monochrome'
                    }
                },
                stream: {
                    required: true,
                    download: 'complete',
                    validFormats: [{ container: 'flac', codec: 'flac' }]
                }
            }
        },
        {
            id: 'monochrome.release.resolve',
            name: 'Monochrome release/album resolution (/releases/ID)',
            input: {
                type: 'resolve',
                value: 'https://monochrome.st/releases/165928667498364928'
            },
            expect: {
                result: { type: 'playlist' },
                collection: { minItems: 10 }
            }
        },
        {
            id: 'monochrome.artist.resolve',
            name: 'Monochrome artist top tracks resolution (/artist/ID)',
            input: {
                type: 'resolve',
                value: 'https://monochrome.st/artist/152961233077669888'
            },
            expect: {
                result: { type: 'playlist' },
                collection: { minItems: 1 }
            }
        }
    ];
    /**
     * Initializes the Monochrome source with health-tracked instance pools.
     * @param nodelink - The worker server context.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        const sources = nodelink.options?.sources;
        this.config = sources?.monochrome || {
            enabled: false
        };
        const defaultUrls = ['https://tracks.monochrome.st'];
        const defaultQobuzUrls = [];
        const initPool = (urls) => urls.map((url) => ({
            url: url.replace(/\/$/, ''),
            score: 100,
            lastFailure: 0,
            failures: 0,
            activeRequests: 0,
            version: '2.10'
        }));
        const instances = this.config.instances?.length
            ? this.config.instances
            : defaultUrls;
        const streamingInstances = this.config.streamingInstances?.length
            ? this.config.streamingInstances
            : instances;
        const qobuzInstances = this.config.qobuzInstances?.length
            ? this.config.qobuzInstances
            : defaultQobuzUrls;
        this.apiInstances = initPool(instances);
        this.streamingInstances = initPool(streamingInstances);
        this.qobuzInstances = initPool(qobuzInstances);
        this.patterns = [
            /^https?:\/\/(?:www\.)?(?:monochrome\.(?:st|tf)|tracks\.monochrome\.st)\/(track|tracks|releases?|album|playlist|artist|video)\/([\w-]+)/i,
            /^https?:\/\/(?:www\.)?tidal\.com\/(?:browse\/)?(track|album|playlist|artist|video)\/([\w-]+)/i
        ];
    }
    /**
     * Performs provider-specific resource initialization.
     * Emits a deprecation warning regarding source instability.
     * @returns A promise resolving to true if initialized.
     */
    async setup() {
        try {
            logger('warn', 'Monochrome', 'Monochrome source is unstable and may experience disruptions. Please consider disabling it as it is not actively maintained by developers.');
            const apiCount = this.apiInstances.length;
            const streamCount = this.streamingInstances.length;
            if (apiCount === 0) {
                logger('warn', 'Monochrome', 'Source failed to initialize: No instances available.');
                return false;
            }
            logger('info', 'Monochrome', `Source is ready with ${apiCount} API and ${streamCount} streaming instances.`);
            return true;
        }
        catch (error) {
            logger('error', 'Monochrome', `Setup failed without crashing the worker: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }
    /**
     * Selects the healthiest instance from the pool using a scored random strategy.
     * @param type - Whether to pick an API or streaming instance.
     * @returns Health-tracked instance metadata.
     * @private
     */
    getBestInstance(type = 'api') {
        const pool = type === 'streaming' ? this.streamingInstances : this.apiInstances;
        const now = Date.now();
        const candidates = pool.filter((i) => i.score > 0 || now - i.lastFailure > 60_000);
        const activePool = candidates.length > 0 ? candidates : pool;
        const sorted = activePool.sort((a, b) => b.score - a.score || a.activeRequests - b.activeRequests);
        const instance = sorted[Math.floor(Math.random() * Math.min(sorted.length, 3))] || pool[0];
        if (!instance) {
            throw new Error('No instances available in pool');
        }
        return instance;
    }
    /**
     * Executes an API request with automatic retries across the instance pool.
     * @param path - API path with parameters.
     * @param type - Instance pool to use.
     * @returns Parsed response or null after all retries fail.
     * @private
     */
    async fetchWithRetry(path, type = 'api') {
        const pool = type === 'streaming' ? this.streamingInstances : this.apiInstances;
        const maxAttempts = Math.min(pool.length * 2, 4);
        let lastError = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const instance = this.getBestInstance(type);
            const url = `${instance.url}${path}`;
            instance.activeRequests++;
            try {
                const { body, error, statusCode } = await http1makeRequest(url, {
                    timeout: 6000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        Accept: 'application/json, text/plain, */*',
                        Referer: 'https://monochrome.st/'
                    }
                });
                instance.activeRequests--;
                if (statusCode === 200 && body) {
                    instance.score = Math.min(instance.score + 5, 100);
                    if (typeof body === 'string') {
                        try {
                            return JSON.parse(body);
                        }
                        catch {
                            return body;
                        }
                    }
                    return body;
                }
                if (statusCode === 429) {
                    instance.score = Math.max(instance.score - 20, 0);
                    await new Promise((r) => setTimeout(r, 500));
                }
                else if (statusCode === 401 || statusCode === 403) {
                    instance.score = 0;
                }
                else {
                    instance.score = Math.max(instance.score - 10, 0);
                }
                instance.failures++;
                instance.lastFailure = Date.now();
                lastError = error || `Status ${statusCode}`;
            }
            catch (e) {
                instance.activeRequests--;
                instance.score = Math.max(instance.score - 30, 0);
                instance.lastFailure = Date.now();
                lastError = e instanceof Error ? e.message : String(e);
            }
        }
        logger('error', 'Monochrome', `Exhausted all retries for ${path}. Last failure: ${lastError}`);
        return null;
    }
    /**
     * Reads the FLAC header and Vorbis comments from the audio stream.
     * @param trackId - Identifier of the track.
     * @param instanceUrl - Base URL of the streaming instance.
     * @returns Extracted FLAC metadata or null on failure.
     */
    async fetchFlacMetadata(trackId, instanceUrl) {
        try {
            const url = `${instanceUrl}/track/${trackId}`;
            const res = await http1makeRequest(url, {
                method: 'GET',
                responseType: 'buffer',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    Accept: '*/*',
                    Range: 'bytes=0-65535',
                    'Sec-Fetch-Dest': 'audio',
                    'Sec-Fetch-Mode': 'no-cors',
                    'Sec-Fetch-Site': 'cross-site',
                    Referer: 'https://monochrome.st/'
                }
            });
            if ((res.statusCode !== 200 && res.statusCode !== 206) ||
                !res.body ||
                !Buffer.isBuffer(res.body)) {
                return null;
            }
            const buf = res.body;
            if (buf.length < 4 || buf.toString('ascii', 0, 4) !== 'fLaC') {
                return null;
            }
            let offset = 4;
            let isLast = false;
            const metadata = {
                title: null,
                artist: null,
                album: null,
                isrc: null,
                durationMs: 0
            };
            while (!isLast && offset + 4 <= buf.length) {
                const header = buf.readUInt32BE(offset);
                isLast = (header & 0x80000000) !== 0;
                const blockType = (header >> 24) & 0x7f;
                const blockLength = header & 0x00ffffff;
                offset += 4;
                if (offset + blockLength > buf.length)
                    break;
                if (blockType === 0 && blockLength >= 18) {
                    const b10 = buf.readUInt8(offset + 10);
                    const b11 = buf.readUInt8(offset + 11);
                    const b12 = buf.readUInt8(offset + 12);
                    const b13 = buf.readUInt8(offset + 13);
                    const sampleRate = (b10 << 12) | (b11 << 4) | (b12 >> 4);
                    const b14 = buf.readUInt8(offset + 14);
                    const b15 = buf.readUInt8(offset + 15);
                    const b16 = buf.readUInt8(offset + 16);
                    const b17 = buf.readUInt8(offset + 17);
                    const totalSamples = (BigInt(b13 & 0x0f) << 32n) |
                        (BigInt(b14) << 24n) |
                        (BigInt(b15) << 16n) |
                        (BigInt(b16) << 8n) |
                        BigInt(b17);
                    if (sampleRate > 0) {
                        metadata.durationMs = Number((totalSamples * 1000n) / BigInt(sampleRate));
                    }
                }
                else if (blockType === 4) {
                    let commentOffset = offset;
                    if (commentOffset + 4 <= offset + blockLength) {
                        const vendorLen = buf.readUInt32LE(commentOffset);
                        commentOffset += 4 + vendorLen;
                        if (commentOffset + 4 <= offset + blockLength) {
                            const userCommentCount = buf.readUInt32LE(commentOffset);
                            commentOffset += 4;
                            for (let i = 0; i < userCommentCount &&
                                commentOffset + 4 <= offset + blockLength; i++) {
                                const commentLen = buf.readUInt32LE(commentOffset);
                                commentOffset += 4;
                                if (commentOffset + commentLen > offset + blockLength)
                                    break;
                                const comment = buf.toString('utf8', commentOffset, commentOffset + commentLen);
                                commentOffset += commentLen;
                                const eqIdx = comment.indexOf('=');
                                if (eqIdx !== -1) {
                                    const key = comment.substring(0, eqIdx).toUpperCase();
                                    const val = comment.substring(eqIdx + 1);
                                    if (key === 'TITLE' && !metadata.title)
                                        metadata.title = val;
                                    else if ((key === 'ARTIST' || key === 'PERFORMER') &&
                                        !metadata.artist)
                                        metadata.artist = val;
                                    else if (key === 'ALBUM' && !metadata.album)
                                        metadata.album = val;
                                    else if (key === 'ISRC' && !metadata.isrc)
                                        metadata.isrc = val;
                                }
                            }
                        }
                    }
                }
                offset += blockLength;
            }
            return metadata;
        }
        catch {
            return null;
        }
    }
    /**
     * Searches for tracks, releases or artists using Monochrome's API proxy.
     * @param query - The user search query.
     * @param _sourceName - Ignored.
     * @param searchType - Type of result to prioritize.
     * @returns Search result payload.
     */
    async search(query, _sourceName, searchType = 'track') {
        logger('debug', 'Monochrome', `Searching for ${searchType}: "${query}"`);
        const cacheKey = `search:${searchType}:${query}`;
        const cached = this.nodelink.trackCacheManager?.get('monochrome', cacheKey);
        if (cached)
            return cached;
        let endpoint;
        switch (searchType) {
            case 'album':
                endpoint = `/search/releases?q=${encodeURIComponent(query)}&limit=20`;
                break;
            case 'artist':
                endpoint = `/search/artists?q=${encodeURIComponent(query)}&limit=20`;
                break;
            default:
                endpoint = `/search/tracks?q=${encodeURIComponent(query)}&limit=20`;
                break;
        }
        const response = await this.fetchWithRetry(endpoint);
        if (!response)
            return { loadType: 'empty', data: {} };
        const results = [];
        if (Array.isArray(response.tracks) && response.tracks.length > 0) {
            for (const t of response.tracks) {
                const info = this.prepareV2TrackInfo(t);
                results.push({
                    encoded: encodeTrack({ ...info, details: [] }),
                    info,
                    pluginInfo: {}
                });
            }
        }
        else if (response.data?.tracks?.items) {
            for (const t of response.data.tracks.items) {
                if (this.isTrackUnavailable(t))
                    continue;
                const info = this.prepareLegacyTrackInfo(t);
                results.push({
                    encoded: encodeTrack({ ...info, details: [] }),
                    info,
                    pluginInfo: {}
                });
            }
        }
        const finalResult = results.length > 0
            ? { loadType: 'search', data: results }
            : { loadType: 'empty', data: {} };
        logger('debug', 'Monochrome', `Search for "${query}" returned ${results.length} results.`);
        this.nodelink.trackCacheManager?.set('monochrome', cacheKey, finalResult, 1800_000);
        return finalResult;
    }
    /**
     * Resolves a URL to a track, release or artist collection.
     * @param url - The resource URL or ISRC identifier.
     * @returns Resolved data payload.
     */
    async resolve(url) {
        logger('debug', 'Monochrome', `Resolving URL: ${url}`);
        // 1. Mirror Support (ISRC)
        if (url.startsWith('isrc:')) {
            const isrc = url.substring(5);
            logger('debug', 'Monochrome', `Resolving ISRC: ${isrc}`);
            const res = await this.fetchWithRetry(`/search/tracks?q=${encodeURIComponent(isrc)}&limit=5`);
            const best = res?.tracks?.find((t) => t.isrc === isrc) || res?.tracks?.[0];
            if (!best)
                return { loadType: 'empty', data: {} };
            const info = this.prepareV2TrackInfo(best);
            return {
                loadType: 'track',
                data: {
                    encoded: encodeTrack({ ...info, details: [] }),
                    info,
                    pluginInfo: {}
                }
            };
        }
        // 2. Direct Track resolution
        const trackMatch = url.match(/(?:track|tracks)\/([\w-]+)/i);
        if (trackMatch) {
            const trackId = trackMatch[1];
            if (!trackId)
                return { loadType: 'empty', data: {} };
            logger('debug', 'Monochrome', `Resolving track ID: ${trackId}`);
            const cachedTrack = this.trackMetadataCache.get(trackId);
            if (cachedTrack) {
                return {
                    loadType: 'track',
                    data: {
                        encoded: encodeTrack({ ...cachedTrack, details: [] }),
                        info: cachedTrack,
                        pluginInfo: {}
                    }
                };
            }
            const instance = this.getBestInstance('streaming');
            const flacMeta = await this.fetchFlacMetadata(trackId, instance.url);
            if (flacMeta) {
                let artworkUrl = null;
                try {
                    if (flacMeta.title) {
                        const searchRes = await this.fetchWithRetry(`/search/tracks?q=${encodeURIComponent(flacMeta.title)}&limit=5`);
                        const matched = searchRes?.tracks?.find((t) => t.trackId === trackId || String(t.id) === trackId);
                        artworkUrl =
                            matched?.artwork || searchRes?.tracks?.[0]?.artwork || null;
                    }
                }
                catch {
                    artworkUrl = null;
                }
                const info = {
                    identifier: trackId,
                    isSeekable: true,
                    author: flacMeta.artist || 'Unknown Artist',
                    length: flacMeta.durationMs || 0,
                    isStream: false,
                    position: 0,
                    title: flacMeta.title || `Track ${trackId}`,
                    uri: `https://monochrome.st/track/${trackId}`,
                    artworkUrl,
                    isrc: flacMeta.isrc || null,
                    sourceName: 'monochrome'
                };
                this.trackMetadataCache.set(trackId, info);
                return {
                    loadType: 'track',
                    data: {
                        encoded: encodeTrack({ ...info, details: [] }),
                        info,
                        pluginInfo: {}
                    }
                };
            }
            // Fallback: Legacy /info/ lookup
            const legacyRes = await this.fetchWithRetry(`/info/?id=${trackId}`);
            if (legacyRes?.data) {
                const info = this.prepareLegacyTrackInfo(legacyRes.data);
                this.trackMetadataCache.set(trackId, info);
                return {
                    loadType: 'track',
                    data: {
                        encoded: encodeTrack({ ...info, details: [] }),
                        info,
                        pluginInfo: {}
                    }
                };
            }
            // Fallback: Direct playable track reference
            const fallbackInfo = {
                identifier: trackId,
                isSeekable: true,
                author: 'Monochrome',
                length: 0,
                isStream: false,
                position: 0,
                title: `Track ${trackId}`,
                uri: `https://monochrome.st/track/${trackId}`,
                artworkUrl: null,
                isrc: null,
                sourceName: 'monochrome'
            };
            this.trackMetadataCache.set(trackId, fallbackInfo);
            return {
                loadType: 'track',
                data: {
                    encoded: encodeTrack({ ...fallbackInfo, details: [] }),
                    info: fallbackInfo,
                    pluginInfo: {}
                }
            };
        }
        // 3. Release / Album resolution
        const releaseMatch = url.match(/(?:releases?|album)\/([\w-]+)/i);
        if (releaseMatch) {
            const releaseId = releaseMatch[1];
            if (!releaseId)
                return { loadType: 'empty', data: {} };
            logger('debug', 'Monochrome', `Resolving release ID: ${releaseId}`);
            const releaseRes = await this.fetchWithRetry(`/releases/${releaseId}`);
            if (releaseRes?.title && Array.isArray(releaseRes.tracks)) {
                const name = releaseRes.title;
                const tracks = [];
                for (const t of releaseRes.tracks) {
                    const author = t.artists?.[0]?.name ||
                        t.artistNames?.[0] ||
                        releaseRes.artists?.[0]?.name ||
                        'Unknown Artist';
                    const id = t.trackId || String(t.id);
                    const info = {
                        identifier: id,
                        isSeekable: true,
                        author,
                        length: t.duration || 0,
                        isStream: false,
                        position: 0,
                        title: t.title,
                        uri: `https://monochrome.st/track/${id}`,
                        artworkUrl: t.artwork || releaseRes.artwork || null,
                        isrc: t.isrc || null,
                        sourceName: 'monochrome'
                    };
                    tracks.push({
                        encoded: encodeTrack({ ...info, details: [] }),
                        info,
                        pluginInfo: {}
                    });
                }
                logger('debug', 'Monochrome', `Resolved release "${name}" with ${tracks.length} tracks.`);
                return tracks.length > 0
                    ? {
                        loadType: 'playlist',
                        data: {
                            info: { name, selectedTrack: 0 },
                            pluginInfo: {},
                            tracks
                        }
                    }
                    : { loadType: 'empty', data: {} };
            }
        }
        // 4. Artist top tracks resolution
        const artistMatch = url.match(/(?:artist|artists)\/([\w-]+)/i);
        if (artistMatch) {
            const artistId = artistMatch[1];
            if (!artistId)
                return { loadType: 'empty', data: {} };
            logger('debug', 'Monochrome', `Resolving artist ID: ${artistId}`);
            const artistRes = await this.fetchWithRetry(`/artists/${artistId}`);
            if (artistRes?.name) {
                const name = artistRes.name || artistRes.displayName || 'Unknown Artist';
                const rawTracks = artistRes.topTracks && artistRes.topTracks.length > 0
                    ? artistRes.topTracks
                    : [];
                if (rawTracks.length === 0 && Array.isArray(artistRes.albums)) {
                    for (const album of artistRes.albums) {
                        if (Array.isArray(album.tracks)) {
                            rawTracks.push(...album.tracks);
                            if (rawTracks.length >= 10)
                                break;
                        }
                    }
                }
                const tracks = [];
                for (const t of rawTracks) {
                    const id = t.trackId || String(t.id);
                    const info = {
                        identifier: id,
                        isSeekable: true,
                        author: name,
                        length: t.duration || 0,
                        isStream: false,
                        position: 0,
                        title: t.title,
                        uri: `https://monochrome.st/track/${id}`,
                        artworkUrl: t.artwork || artistRes.avatar || null,
                        isrc: t.isrc || null,
                        sourceName: 'monochrome'
                    };
                    tracks.push({
                        encoded: encodeTrack({ ...info, details: [] }),
                        info,
                        pluginInfo: {}
                    });
                }
                logger('debug', 'Monochrome', `Resolved artist "${name}" with ${tracks.length} tracks.`);
                return tracks.length > 0
                    ? {
                        loadType: 'playlist',
                        data: {
                            info: { name, selectedTrack: 0 },
                            pluginInfo: {},
                            tracks
                        }
                    }
                    : { loadType: 'empty', data: {} };
            }
        }
        return { loadType: 'empty', data: {} };
    }
    /**
     * Resolves the final streaming URI for a track.
     * @param track - Normalized track metadata.
     * @returns Streaming result with URI and format.
     */
    async getTrackUrl(track) {
        const isVideo = track.uri.includes('/video/');
        if (!isVideo && track.isrc) {
            const qobuzQuality = this.config.qobuzQuality ?? 6;
            const qobuzUrl = await this.fetchQobuzProxyUrl(track.isrc, qobuzQuality);
            if (qobuzUrl) {
                return {
                    url: qobuzUrl,
                    protocol: 'https',
                    format: qobuzQuality > 5 ? 'audio/flac' : 'audio/mpeg'
                };
            }
        }
        const instance = this.getBestInstance('streaming');
        const streamUrl = `${instance.url}/track/${track.identifier}`;
        return {
            url: streamUrl,
            protocol: 'http',
            format: 'audio/flac'
        };
    }
    /**
     * Opens a readable audio stream for the given track.
     * @param decodedTrack - Track metadata.
     * @param url - Resolved playback URL.
     * @param protocol - Streaming protocol identifier.
     * @param additionalData - Optional payload for seeking support.
     * @returns A promise resolving to the stream result.
     */
    async loadStream(decodedTrack, url, protocol, additionalData) {
        if (protocol === 'dash' || url.includes('.mpd')) {
            logger('debug', 'Monochrome', `Loading DASH stream for ${decodedTrack.identifier}`);
            const dash = new DASHHandler(url, {
                localAddress: this.nodelink.routePlanner?.getIP?.() || undefined,
                startTime: additionalData?.startTime || 0,
                expectedDuration: decodedTrack.length,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });
            const passthrough = new PassThrough({ highWaterMark: 256 * 1024 });
            let finishBufferingEmitted = false;
            dash.pipe(passthrough);
            const emitFinishBuffering = () => {
                if (finishBufferingEmitted)
                    return;
                finishBufferingEmitted = true;
                passthrough.emit('finishBuffering');
            };
            dash.on('data', () => emitFinishBuffering());
            dash.once('end', emitFinishBuffering);
            passthrough.once('end', emitFinishBuffering);
            dash.on('error', (err) => {
                if (!passthrough.destroyed)
                    passthrough.destroy(err);
            });
            passthrough.on('error', () => {
                if (!dash.destroyed)
                    dash.destroy();
            });
            dash.start().catch((err) => {
                logger('error', 'Monochrome', `DASH stream error: ${err.message}`);
                passthrough.destroy(err);
            });
            return {
                stream: passthrough,
                type: 'fmp4-buffered'
            };
        }
        if (protocol === 'hls' || url.includes('.m3u8')) {
            logger('debug', 'Monochrome', `Loading HLS stream for ${decodedTrack.identifier}`);
            const type = 'fmp4-buffered';
            const hls = new HLSHandler(url, {
                type,
                localAddress: this.nodelink.routePlanner?.getIP?.() || undefined,
                startTime: additionalData?.startTime || 0,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    Referer: 'https://monochrome.st/'
                }
            });
            const passthrough = new PassThrough({ highWaterMark: 256 * 1024 });
            let finishBufferingEmitted = false;
            hls.pipe(passthrough);
            const emitFinishBuffering = () => {
                if (finishBufferingEmitted)
                    return;
                finishBufferingEmitted = true;
                passthrough.emit('finishBuffering');
            };
            hls.once('end', emitFinishBuffering);
            passthrough.once('end', emitFinishBuffering);
            hls.on('error', (err) => {
                if (!passthrough.destroyed)
                    passthrough.destroy(err);
            });
            passthrough.on('error', () => {
                if (!hls.destroyed)
                    hls.destroy();
            });
            // @ts-expect-error - Internal property for cleanup
            passthrough._sourceStream = hls;
            return {
                stream: passthrough,
                type
            };
        }
        logger('debug', 'Monochrome', `Loading progressive stream for ${decodedTrack.identifier}`);
        const rangeHeader = additionalData?.startTime
            ? `bytes=${Math.floor((additionalData.startTime / (decodedTrack.length || 1)) * 1000)}-`
            : 'bytes=0-';
        const res = await http1makeRequest(url, {
            method: 'GET',
            streamOnly: true,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                Accept: '*/*',
                'Accept-Encoding': 'identity;q=1, *;q=0',
                Range: rangeHeader,
                'Sec-Fetch-Dest': 'audio',
                'Sec-Fetch-Mode': 'no-cors',
                'Sec-Fetch-Site': 'cross-site',
                Referer: 'https://monochrome.st/'
            }
        });
        if (res.error || !res.stream) {
            throw new Error(res.error || 'Failed to fetch stream');
        }
        const passthrough = new PassThrough();
        const sourceStream = res.stream;
        sourceStream.on('data', (chunk) => {
            if (!passthrough.write(chunk))
                sourceStream.pause();
        });
        passthrough.on('drain', () => {
            sourceStream.resume();
        });
        sourceStream.on('end', () => {
            if (!passthrough.writableEnded) {
                passthrough.emit('finishBuffering');
                passthrough.end();
            }
        });
        sourceStream.on('error', (err) => passthrough.destroy(err));
        let type = 'audio/flac';
        if (url.includes('.mp3'))
            type = 'audio/mpeg';
        else if (url.includes('.m4a') || url.includes('.mp4'))
            type = 'audio/mp4';
        else if (url.includes('.ogg') || url.includes('.opus'))
            type = 'audio/ogg';
        return { stream: passthrough, type };
    }
    /**
     * Executes a variant operation in test suites.
     */
    async executeVariant(variant, track, _streamSpec) {
        try {
            const { url } = await this.getTrackUrl(track);
            if (!url) {
                return {
                    variant: variant.id,
                    resolved: false,
                    error: 'No stream URL available'
                };
            }
            const streamRes = await this.loadStream(track, url);
            return {
                variant: variant.id,
                resolved: true,
                track,
                stream: streamRes.stream,
                container: 'flac',
                codec: 'flac',
                httpStatus: 200
            };
        }
        catch (err) {
            return {
                variant: variant.id,
                resolved: false,
                error: err instanceof Error ? err : new Error(String(err))
            };
        }
    }
    /**
     * Fetches a direct stream URL from the Qobuz proxy instances.
     * @param isrc - Track ISRC code.
     * @param quality - Desired audio quality.
     * @returns Direct stream URL or null.
     * @private
     */
    async fetchQobuzProxyUrl(isrc, quality = 6) {
        const pool = this.qobuzInstances.filter((i) => i.score > 0);
        if (pool.length === 0) {
            return null;
        }
        const proxyHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: '*/*',
            Referer: 'https://monochrome.st/'
        };
        for (const instance of pool) {
            instance.activeRequests++;
            try {
                const searchUrl = `${instance.url}/api/get-music?q=${encodeURIComponent(isrc)}&offset=0`;
                const { body: searchBody, statusCode: searchStatus } = await http1makeRequest(searchUrl, {
                    method: 'GET',
                    timeout: 5000,
                    headers: proxyHeaders
                });
                if (searchStatus !== 200 || !searchBody) {
                    instance.score = Math.max(instance.score - 10, 0);
                    instance.failures++;
                    instance.lastFailure = Date.now();
                    continue;
                }
                const searchData = typeof searchBody === 'string'
                    ? JSON.parse(searchBody)
                    : searchBody;
                const tracks = searchData?.data
                    ?.tracks;
                const items = tracks?.items;
                const track = items?.[0];
                if (!track?.id) {
                    instance.score = Math.max(instance.score - 5, 0);
                    continue;
                }
                const trackId = track.id;
                const downloadUrl = `${instance.url}/api/download-music?track_id=${trackId}&quality=${quality}`;
                const { body: downloadBody, statusCode: downloadStatus } = await http1makeRequest(downloadUrl, {
                    method: 'GET',
                    timeout: 5000,
                    headers: proxyHeaders
                });
                if (downloadStatus !== 200 || !downloadBody) {
                    instance.score = Math.max(instance.score - 10, 0);
                    instance.failures++;
                    instance.lastFailure = Date.now();
                    continue;
                }
                const downloadData = typeof downloadBody === 'string'
                    ? JSON.parse(downloadBody)
                    : downloadBody;
                const url = downloadData?.data
                    ?.url;
                if (url) {
                    instance.score = Math.min(instance.score + 5, 100);
                    logger('debug', 'Monochrome', `Qobuz proxy resolved track ${isrc} via ${instance.url}`);
                    return url;
                }
                instance.score = Math.max(instance.score - 5, 0);
            }
            catch (e) {
                instance.score = Math.max(instance.score - 20, 0);
                instance.lastFailure = Date.now();
                logger('error', 'Monochrome', `Qobuz proxy error for ${isrc} on ${instance.url}: ${e instanceof Error ? e.message : String(e)}`);
            }
            finally {
                instance.activeRequests--;
            }
        }
        return null;
    }
    /**
     * Normalizes a modern Monochrome v2.10 track into NodeLink's TrackInfo structure.
     * @param t - Modern Monochrome track.
     * @returns Normalized TrackInfo.
     * @private
     */
    prepareV2TrackInfo(t) {
        const author = t.artists?.[0]?.name ||
            t.artistNames?.[0] ||
            t.artists?.[0]?.displayName ||
            'Unknown Artist';
        const id = t.trackId || String(t.id);
        const info = {
            identifier: id,
            isSeekable: true,
            author,
            length: t.duration || 0,
            isStream: false,
            position: 0,
            title: t.title,
            uri: `https://monochrome.st/track/${id}`,
            artworkUrl: t.artwork || null,
            isrc: t.isrc || null,
            sourceName: 'monochrome'
        };
        this.trackMetadataCache.set(id, info);
        return info;
    }
    /**
     * Normalizes a legacy Tidal-style track into NodeLink's TrackInfo structure.
     * @param t - Raw legacy track data.
     * @returns Normalized TrackInfo.
     * @private
     */
    prepareLegacyTrackInfo(t) {
        const coverPath = t.album?.cover?.replace(/-/g, '/');
        const title = t.version ? `${t.title} (${t.version})` : t.title;
        return {
            identifier: t.id.toString(),
            isSeekable: true,
            author: t.artist?.name || 'Unknown Artist',
            length: t.duration * 1000,
            isStream: false,
            position: 0,
            title,
            uri: `https://monochrome.st/track/${t.id}`,
            artworkUrl: coverPath
                ? `https://resources.tidal.com/images/${coverPath}/1280x1280.jpg`
                : null,
            isrc: t.isrc,
            sourceName: 'monochrome'
        };
    }
    /**
     * Checks if a legacy track is unavailable for streaming.
     * @param t - Raw track data.
     * @returns True if the track cannot be played.
     * @private
     */
    isTrackUnavailable(t) {
        if (!t)
            return true;
        return (t.allowStreaming === false ||
            t.streamReady === false ||
            t.title === 'Unavailable');
    }
}
export default MonochromeSource;
