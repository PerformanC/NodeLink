import { PassThrough } from 'node:stream';
import { DASHHandler } from "../playback/dash/DASHHandler.js";
import HLSHandler from "../playback/hls/HLSHandler.js";
import { encodeTrack, http1makeRequest, logger } from "../utils.js";
/**
 * NodeLink audio source provider for Monochrome (Tidal proxy).
 *
 * This source implements a full-scale proxy engine ported from the Monochrome JS/TS reference.
 * Features include:
 * - Health-based instance rotation with exponential backoff.
 * - Robust pagination for Tidal collections (albums/playlists).
 * - Advanced manifest resolution with quality prioritization (FLAC > Lossless > AAC).
 * - Extraction of ReplayGain and Peak metadata for audio normalization.
 * - Full support for HLS and Progressive streaming via loadStream.
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
    /**
     * Initializes the Monochrome source with health-tracked instance pools.
     * @param nodelink - The worker server context.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        const sources = nodelink.options?.sources;
        this.config =
            sources?.monochrome || {
                enabled: false
            };
        const defaultUrls = [
            'https://tidal-api.binimum.org',
            'https://eu-central.monochrome.tf',
            'https://us-west.monochrome.tf',
            'https://triton.squid.wtf',
            'https://hifi.geeked.wtf',
            'https://wolf.qqdl.site',
            'https://vogel.qqdl.site',
            'https://katze.qqdl.site',
            'https://hund.qqdl.site',
            'https://api.monochrome.tf'
        ];
        const defaultQobuzUrls = [
            'https://qobuz.kennyy.com.br',
            'https://trypt-hifi-dl-456461932686.us-west1.run.app'
        ];
        const initPool = (urls) => urls.map((url) => ({
            url: url.replace(/\/$/, ''),
            score: 100,
            lastFailure: 0,
            failures: 0,
            activeRequests: 0,
            version: undefined
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
            /^https?:\/\/monochrome\.tf\/(track|album|playlist|artist|video)\/[\w-]+/,
            /^https?:\/\/(?:www\.)?tidal\.com\/(?:browse\/)?(track|album|playlist|artist|video)\/[\w-]+/
        ];
    }
    /**
     * Performs provider-specific resource initialization.
     * Runs an initial latency check to score instances.
     * @returns A promise resolving to true if initialized.
     */
    async setup() {
        try {
            const apiCount = this.apiInstances.length;
            const streamCount = this.streamingInstances.length;
            if (apiCount === 0) {
                logger('warn', 'Monochrome', 'Source failed to initialize: No instances available.');
                return false;
            }
            logger('info', 'Monochrome', `Initializing latency check for ${apiCount} instances...`);
            const checkInstance = async (instance) => {
                const start = Date.now();
                try {
                    const { statusCode } = await http1makeRequest(`${instance.url}/`, {
                        method: 'GET',
                        timeout: 3000
                    });
                    const latency = Date.now() - start;
                    if (statusCode === 200 || statusCode === 404 || statusCode === 302) {
                        // Success (or at least reachable)
                        if (latency < 500)
                            instance.score = 100;
                        else if (latency < 1500)
                            instance.score = 80;
                        else if (latency < 3000)
                            instance.score = 50;
                        else
                            instance.score = 20;
                        logger('debug', 'Monochrome', `Instance ${instance.url} - Latency: ${latency}ms, Initial Score: ${instance.score}`);
                    }
                    else {
                        instance.score = 0;
                        instance.lastFailure = Date.now();
                        logger('debug', 'Monochrome', `Instance ${instance.url} - Error: Status ${statusCode}, Score: 0`);
                    }
                }
                catch (_e) {
                    instance.score = 0;
                    instance.lastFailure = Date.now();
                    logger('debug', 'Monochrome', `Instance ${instance.url} - Connection Failed, Score: 0`);
                }
            };
            await Promise.allSettled(this.apiInstances.map(checkInstance));
            // Sync streaming scores if they use the same URLs
            for (const s of this.streamingInstances) {
                const api = this.apiInstances.find((a) => a.url === s.url);
                if (api)
                    s.score = api.score;
            }
            const reachable = this.apiInstances.filter((i) => i.score > 0).length;
            logger('info', 'Monochrome', `Source is ready with ${apiCount} API (${reachable} reachable) and ${streamCount} streaming instances.`);
            if (reachable === 0) {
                logger('warn', 'Monochrome', 'No reachable Monochrome instances at startup. Source will stay loaded but degraded.');
            }
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
     * @param minVersion - Optional minimum API version required.
     * @returns Health-tracked instance metadata.
     * @private
     */
    getBestInstance(type = 'api', minVersion) {
        const pool = type === 'streaming' ? this.streamingInstances : this.apiInstances;
        const now = Date.now();
        let candidates = pool.filter((i) => (i.score > 0 || now - i.lastFailure > 60_000) &&
            (!minVersion || (i.version && i.version >= minVersion)));
        if (candidates.length === 0 && minVersion) {
            candidates = pool.filter((i) => i.score > 0 || now - i.lastFailure > 60_000);
        }
        const activePool = candidates.length > 0 ? candidates : pool;
        const sorted = activePool.sort((a, b) => b.score - a.score || a.activeRequests - b.activeRequests);
        // Increase randomization factor to 5 to avoid overloading the very best one
        const instance = sorted[Math.floor(Math.random() * Math.min(sorted.length, 5))] || pool[0];
        if (!instance) {
            throw new Error('No instances available in pool');
        }
        return instance;
    }
    /**
     * Executes a request with automatic retries across the instance pool.
     * @param path - API path with parameters.
     * @param type - Instance pool to use.
     * @param minVersion - Optional minimum API version required.
     * @returns Parsed response or null after all retries fail.
     * @private
     */
    async fetchWithRetry(path, type = 'api', minVersion) {
        const pool = type === 'streaming' ? this.streamingInstances : this.apiInstances;
        const maxAttempts = Math.min(pool.length * 2, 5);
        let lastError = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const instance = this.getBestInstance(type, minVersion);
            const url = `${instance.url}${path}`;
            instance.activeRequests++;
            try {
                const { body, error, statusCode } = await http1makeRequest(url, {
                    timeout: 5000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36',
                        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
                        Referer: 'https://monochrome.tf/'
                    }
                });
                instance.activeRequests--;
                if (statusCode === 200 && body) {
                    instance.score = Math.min(instance.score + 5, 100);
                    const res = body;
                    if (res.version)
                        instance.version = res.version;
                    return res || res.data;
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
     * Searches for tracks, videos or other types using Tidal's API proxy.
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
        let endpoint = '/search/';
        switch (searchType) {
            case 'album':
                endpoint += `?al=${encodeURIComponent(query)}`;
                break;
            case 'artist':
                endpoint += `?a=${encodeURIComponent(query)}`;
                break;
            case 'playlist':
                endpoint += `?p=${encodeURIComponent(query)}`;
                break;
            case 'video':
                endpoint += `?v=${encodeURIComponent(query)}`;
                break;
            default:
                endpoint += `?s=${encodeURIComponent(query)}`;
                break;
        }
        const response = await this.fetchWithRetry(endpoint);
        if (!response)
            return { loadType: 'empty', data: {} };
        const results = [];
        if (searchType === 'track' && response.data?.tracks?.items) {
            for (const t of response.data.tracks.items) {
                if (this.isTrackUnavailable(t))
                    continue;
                const info = this.prepareTrackInfo(t);
                results.push({
                    encoded: encodeTrack({ ...info, details: [] }),
                    info,
                    pluginInfo: {}
                });
            }
        }
        else if (searchType === 'video' && response.data?.videos?.items) {
            for (const v of response.data.videos.items) {
                const info = this.prepareVideoInfo(v);
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
     * Resolves a URL to a track, album or playlist with full pagination support.
     * @param url - The resource URL or ISRC identifier.
     * @returns Resolved data payload.
     */
    async resolve(url) {
        logger('debug', 'Monochrome', `Resolving URL: ${url}`);
        // 1. Mirror Support (ISRC)
        if (url.startsWith('isrc:')) {
            const isrc = url.substring(5);
            logger('debug', 'Monochrome', `Resolving ISRC: ${isrc}`);
            const res = await this.fetchWithRetry(`/search/?s=${encodeURIComponent(isrc)}`);
            const best = res?.data?.tracks?.items?.find((t) => t.isrc === isrc) ||
                res?.data?.tracks?.items?.[0];
            if (!best || this.isTrackUnavailable(best))
                return { loadType: 'empty', data: {} };
            const info = this.prepareTrackInfo(best);
            return {
                loadType: 'track',
                data: {
                    encoded: encodeTrack({ ...info, details: [] }),
                    info,
                    pluginInfo: {}
                }
            };
        }
        // 2. Direct Track/Video resolution
        const directMatch = url.match(/(track|video)\/(\d+)/);
        if (directMatch) {
            const type = directMatch[1] === 'video' ? 'video' : 'info';
            const id = directMatch[2];
            logger('debug', 'Monochrome', `Matched direct ${type} resolution for ID: ${id}`);
            const res = await this.fetchWithRetry(`/${type}/?id=${id}`);
            const data = res?.data;
            if (!data)
                return { loadType: 'empty', data: {} };
            const info = directMatch[1] === 'video'
                ? this.prepareVideoInfo(data)
                : this.prepareTrackInfo(data);
            return {
                loadType: 'track',
                data: {
                    encoded: encodeTrack({ ...info, details: [] }),
                    info,
                    pluginInfo: {}
                }
            };
        }
        // 3. Collection resolution (Album/Playlist) with exaustive pagination
        const collectionMatch = url.match(/(album|playlist)\/([a-f0-9-]+|\d+)/);
        if (collectionMatch) {
            const type = collectionMatch[1] || '';
            const id = collectionMatch[2] || '';
            logger('debug', 'Monochrome', `Matched ${type} resolution for ID: ${id}`);
            const tracks = [];
            let offset = 0;
            const limit = 100;
            let total = Infinity;
            let name = 'Unknown Collection';
            while (tracks.length < total &&
                tracks.length <
                    (this.nodelink.options.maxAlbumPlaylistLength || 1000)) {
                const res = await this.fetchWithRetry(`/${type}/?id=${id}&offset=${offset}&limit=${limit}`);
                if (!res)
                    break;
                const data = res.data;
                if (offset === 0) {
                    name = data.title || data.playlist?.title || 'Monochrome Collection';
                    total = data.numberOfTracks || data.playlist?.numberOfTracks || 0;
                }
                const items = data.items || [];
                if (items.length === 0)
                    break;
                for (const entry of items) {
                    const t = entry.item || entry;
                    if (!t.id || this.isTrackUnavailable(t))
                        continue;
                    const info = this.prepareTrackInfo(t);
                    tracks.push({
                        encoded: encodeTrack({ ...info, details: [] }),
                        info,
                        pluginInfo: {}
                    });
                }
                if (items.length < limit)
                    break;
                offset += items.length;
            }
            logger('debug', 'Monochrome', `Resolved ${type} "${name}" with ${tracks.length} tracks.`);
            return tracks.length > 0
                ? {
                    loadType: 'playlist',
                    data: { info: { name, selectedTrack: 0 }, pluginInfo: {}, tracks }
                }
                : { loadType: 'empty', data: {} };
        }
        return { loadType: 'empty', data: {} };
    }
    /**
     * Resolves the final manifest and streaming URI for a track.
     * Handles DASH manifest parsing and audio normalization extraction.
     * @param track - Normalized track metadata.
     * @returns Streaming result with URI and ReplayGain data.
     */
    async getTrackUrl(track) {
        const isVideo = track.uri.includes('/video/');
        if (!isVideo && track.isrc) {
            const qobuzUrl = await this.fetchQobuzProxyUrl(track.isrc);
            if (qobuzUrl) {
                return {
                    url: qobuzUrl,
                    protocol: 'https'
                };
            }
        }
        const quality = this.config.quality || 'LOSSLESS';
        const params = new URLSearchParams({
            id: track.identifier,
            adaptive: 'true',
            manifestType: 'MPEG_DASH',
            uriScheme: 'HTTPS',
            usage: 'PLAYBACK'
        });
        if (isVideo) {
            params.set('quality', 'HIGH');
        }
        else {
            const formats = ['HEAACV1', 'AACLC', 'FLAC'];
            if (quality === 'HI_RES_LOSSLESS')
                formats.push('FLAC_HIRES');
            for (const f of formats)
                params.append('formats', f);
        }
        const endpoint = isVideo
            ? `/video/?${params.toString()}`
            : `/trackManifests/?${params.toString()}`;
        const response = await this.fetchWithRetry(endpoint, 'streaming', '2.7');
        if (response) {
            const uri = this.extractStreamUrl(response);
            if (uri) {
                const attr = response?.data?.data?.attributes;
                if (attr?.trackAudioNormalizationData) {
                    logger('debug', 'Monochrome', `Normalization for ${track.identifier}: Gain ${attr.trackAudioNormalizationData.replayGain} dB, Peak ${attr.trackAudioNormalizationData.peakAmplitude}`);
                }
                return {
                    url: uri,
                    protocol: uri.includes('.mpd')
                        ? 'dash'
                        : uri.includes('.m3u8')
                            ? 'hls'
                            : 'http'
                };
            }
        }
        return {
            exception: {
                message: 'Failed to fetch playback manifest',
                severity: 'fault'
            }
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
                    Referer: 'https://tidal.com/'
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
        const res = await http1makeRequest(url, {
            method: 'GET',
            streamOnly: true,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        if (res.error || !res.stream) {
            throw new Error(res.error || 'Failed to fetch stream');
        }
        const passthrough = new PassThrough();
        const sourceStream = res.stream;
        sourceStream.on('data', (chunk) => passthrough.write(chunk));
        sourceStream.on('end', () => {
            passthrough.emit('finishBuffering');
            passthrough.end();
        });
        sourceStream.on('error', (err) => passthrough.destroy(err));
        let type = 'audio/mpeg';
        if (url.includes('.flac'))
            type = 'audio/flac';
        else if (url.includes('.m4a') || url.includes('.mp4'))
            type = 'audio/mp4';
        else if (url.includes('.ogg') || url.includes('.opus'))
            type = 'audio/ogg';
        return { stream: passthrough, type };
    }
    /**
     * Implements the site's extractStreamUrlFromManifest logic.
     * @param data - Raw manifest response.
     * @returns Final stream URL or null.
     * @private
     */
    extractStreamUrl(data) {
        let uri = null;
        let manifest = null;
        if ('data' in data &&
            data.data &&
            typeof data.data === 'object' &&
            'data' in data.data) {
            const internalData = data.data;
            const attr = internalData.data?.attributes || internalData.attributes;
            uri = attr?.uri || null;
            manifest = attr?.manifest || null;
        }
        else {
            const internalData = data;
            uri = internalData.attributes?.uri || null;
            manifest =
                internalData.manifest ||
                    internalData.Manifest ||
                    internalData.attributes?.manifest ||
                    null;
        }
        if (uri)
            return uri;
        if (!manifest) {
            const internalData = data;
            return (internalData.OriginalTrackUrl || internalData.originalTrackUrl || null);
        }
        try {
            const decoded = Buffer.from(manifest, 'base64').toString();
            if (decoded.includes('<MPD'))
                return `data:application/dash+xml;base64,${manifest}`;
            const parsed = JSON.parse(decoded);
            return parsed.urls?.[0] || null;
        }
        catch {
            return null;
        }
    }
    /**
     * Fetches a direct stream URL from the Qobuz proxy instances.
     * Steps: search by ISRC → get track ID → download music.
     * @param isrc - Track ISRC code.
     * @returns Direct stream URL or null.
     * @private
     */
    async fetchQobuzProxyUrl(isrc) {
        const pool = this.qobuzInstances.filter((i) => i.score > 0);
        if (pool.length === 0) {
            logger('warn', 'Monochrome', 'No Qobuz proxy instances available.');
            return null;
        }
        const proxyHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
            Accept: '*/*',
            'Accept-Language': 'en;q=0.8',
            Origin: 'https://monochrome.tf',
            Referer: 'https://monochrome.tf/',
            Pragma: 'no-cache',
            'Cache-Control': 'no-cache'
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
                if (!track) {
                    instance.score = Math.max(instance.score - 5, 0);
                    continue;
                }
                const trackId = track.id;
                if (!trackId) {
                    instance.score = Math.max(instance.score - 5, 0);
                    continue;
                }
                const downloadUrl = `${instance.url}/api/download-music?track_id=${trackId}&quality=5`;
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
     * Normalizes a raw track object into NodeLink's TrackInfo structure.
     * @param t - Raw Tidal track data.
     * @returns Normalized metadata.
     * @private
     */
    prepareTrackInfo(t) {
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
            uri: `https://monochrome.tf/track/${t.id}`,
            artworkUrl: coverPath
                ? `https://resources.tidal.com/images/${coverPath}/1280x1280.jpg`
                : null,
            isrc: t.isrc,
            sourceName: 'monochrome'
        };
    }
    /**
     * Normalizes a raw video object into NodeLink's TrackInfo structure.
     * @param v - Raw Tidal video data.
     * @returns Normalized metadata.
     * @private
     */
    prepareVideoInfo(v) {
        const imagePath = v.image?.replace(/-/g, '/');
        return {
            identifier: v.id.toString(),
            isSeekable: true,
            author: v.artist?.name || 'Unknown Artist',
            length: v.duration * 1000,
            isStream: false,
            position: 0,
            title: v.title,
            uri: `https://monochrome.tf/video/${v.id}`,
            artworkUrl: imagePath
                ? `https://resources.tidal.com/images/${imagePath}/1280x720.jpg`
                : null,
            isrc: null,
            sourceName: 'monochrome'
        };
    }
    /**
     * Checks if a track is unavailable for streaming based on site rules.
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
