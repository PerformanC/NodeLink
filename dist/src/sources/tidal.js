/**
 * Tidal source with direct hifi streaming support when available.
 * @public
 */
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { encodeTrack, getBestMatch, http1makeRequest, logger, makeRequest } from "../utils.js";
const API_BASE = 'https://api.tidal.com/v1/';
const CACHE_VALIDITY_DAYS = 7;
const TIDAL_ASSET_URL = 'https://tidal.com/assets/index-CJ0DsMmf.js';
const DEFAULT_HIFI_QUALITIES = ['HI_RES_LOSSLESS', 'LOSSLESS', 'HIGH', 'LOW'];
/**
 * Tidal source implementation.
 * @public
 */
export default class TidalSource {
    /**
     * Runtime NodeLink context.
     */
    nodelink;
    /**
     * Tidal source configuration block.
     */
    config;
    /**
     * Search aliases handled by this source.
     */
    searchTerms;
    /**
     * Recommendation aliases handled by this source.
     */
    recommendationTerm;
    /**
     * URL patterns handled by this source.
     */
    patterns;
    /**
     * URL resolution priority.
     */
    priority;
    /**
     * Tidal client token.
     */
    token;
    /**
     * Tidal country code.
     */
    countryCode;
    /**
     * Maximum number of playlist pages to fetch.
     */
    playlistLoadLimit;
    /**
     * Playlist page request batch size.
     */
    playlistPageLoadConcurrency;
    /**
     * Legacy token cache path (kept for compatibility).
     */
    tokenCachePath;
    /**
     * Configured hifi API endpoints.
     */
    hifiApis;
    /**
     * Hifi quality priority list.
     */
    hifiQualities;
    /**
     * Creates a Tidal source instance.
     * @param nodelink - Runtime NodeLink context.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        const sourceConfig = this.asRecord(this.nodelink.options.sources?.tidal);
        this.config = sourceConfig || {};
        this.searchTerms = ['tdsearch'];
        this.recommendationTerm = ['tdrec'];
        this.patterns = [
            /^https?:\/\/(?:(?:listen|www)\.)?tidal\.com\/(?:browse\/)?(?<type>album|track|playlist|mix|artist)\/(?<id>[a-zA-Z0-9-]+)(?:\/[a-zA-Z0-9/_-]*)?(?:\?.*)?$/
        ];
        this.priority = 90;
        this.token = this.asString(this.config.token);
        this.countryCode = this.asString(this.config.countryCode) || 'US';
        this.playlistLoadLimit = this.asNumber(this.config.playlistLoadLimit) ?? 2;
        this.playlistPageLoadConcurrency =
            this.asNumber(this.config.playlistPageLoadConcurrency) ?? 5;
        this.tokenCachePath = path.join(process.cwd(), '.cache', 'tidal_token.json');
        this.hifiApis = this.toStringArray(this.config.hifiApis).map((url) => url.replace(/\/$/, ''));
        const configuredQualities = this.toStringArray(this.config.hifiQualities);
        this.hifiQualities =
            configuredQualities.length > 0
                ? configuredQualities
                : DEFAULT_HIFI_QUALITIES;
    }
    /**
     * Initializes source token state.
     * @returns True when setup finishes.
     */
    async setup() {
        if (this.token && this.token !== 'token_here')
            return true;
        const cachedToken = this.nodelink.credentialManager?.get('tidal_token');
        if (cachedToken) {
            this.token = cachedToken;
            logger('info', 'Tidal', 'Loaded valid token from CredentialManager.');
            return true;
        }
        try {
            const res = await fetch(TIDAL_ASSET_URL);
            if (!res.ok)
                throw new Error(`Status ${res.status}`);
            const token = this.extractSecondClientId(await res.text());
            if (token) {
                this.token = token;
                logger('info', 'Tidal', 'Fetched new token.');
                this.nodelink.credentialManager?.set('tidal_token', token, CACHE_VALIDITY_DAYS * 24 * 60 * 60 * 1000);
            }
            else {
                logger('warn', 'Tidal', 'No clientId found in remote asset');
            }
        }
        catch (error) {
            logger('warn', 'Tidal', `Token fetch failed: ${this.getErrorMessage(error)}`);
        }
        return true;
    }
    /**
     * Searches tracks on Tidal.
     * @param query - Search query.
     * @param sourceTerm - Source alias.
     * @returns Search result payload.
     */
    async search(query, sourceTerm) {
        if (sourceTerm && this.recommendationTerm.includes(sourceTerm)) {
            return this.getRecommendations(query);
        }
        try {
            const limit = this.asNumber(this.nodelink.options.search.maxResults) ?? 10;
            const data = await this.getJson('search', {
                query,
                limit,
                types: 'TRACKS'
            });
            const tracksBlock = this.asRecord(data?.tracks);
            const items = this.asArrayRecords(tracksBlock?.items);
            if (items.length === 0)
                return { loadType: 'empty', data: {} };
            const tracks = items
                .map((item) => this.buildTrack(item))
                .filter((item) => item !== null);
            return { loadType: 'search', data: tracks };
        }
        catch (error) {
            return {
                loadType: 'error',
                exception: { message: this.getErrorMessage(error), severity: 'fault' }
            };
        }
    }
    /**
     * Resolves a Tidal URL.
     * @param url - Tidal URL.
     * @returns Track/playlist/empty payload.
     */
    async resolve(url) {
        const pattern = this.patterns[0];
        if (!pattern)
            return { loadType: 'empty', data: {} };
        const match = url.match(pattern);
        if (!match?.groups)
            return { loadType: 'empty', data: {} };
        let type = match.groups.type;
        let id = match.groups.id;
        const nestedTrack = url.match(/\/album\/[a-zA-Z0-9-]+\/track\/(?<trackId>[a-zA-Z0-9-]+)/);
        if (nestedTrack?.groups?.trackId) {
            type = 'track';
            id = nestedTrack.groups.trackId;
        }
        if (!type || !id)
            return { loadType: 'empty', data: {} };
        try {
            switch (type) {
                case 'track':
                    return this.resolveTrack(id);
                case 'album':
                    return this.resolveAlbum(id);
                case 'mix':
                    return this.getMix(id);
                case 'playlist':
                    return this.resolvePlaylist(id);
                case 'artist':
                    return this.resolveArtist(id);
                default:
                    return { loadType: 'empty', data: {} };
            }
        }
        catch (error) {
            return {
                loadType: 'error',
                exception: { message: this.getErrorMessage(error), severity: 'fault' }
            };
        }
    }
    /**
     * Resolves a recommendation query.
     * @param query - Track id or search text.
     * @returns Recommendation playlist or empty payload.
     */
    async getRecommendations(query) {
        let trackId = query;
        if (!/^[0-9]+$/.test(query)) {
            const searchRes = await this.search(query, 'tdsearch');
            if (searchRes.loadType !== 'search') {
                return { loadType: 'empty', data: {} };
            }
            const tracks = this.toTrackInfoArray(searchRes.data);
            if (tracks.length > 0) {
                trackId = tracks[0]?.identifier || trackId;
            }
            else {
                return { loadType: 'empty', data: {} };
            }
        }
        try {
            const data = await this.getJson(`tracks/${trackId}`);
            const mixes = this.asRecord(data?.mixes);
            const mixId = this.asString(mixes?.TRACK_MIX);
            if (!mixId)
                return { loadType: 'empty', data: {} };
            return this.getMix(mixId);
        }
        catch (error) {
            return {
                loadType: 'error',
                exception: { message: this.getErrorMessage(error), severity: 'fault' }
            };
        }
    }
    /**
     * Resolves a mix by ID.
     * @param mixId - Tidal mix ID.
     * @returns Playlist payload.
     */
    async getMix(mixId) {
        try {
            const data = await this.getJson(`mixes/${mixId}/items`, { limit: 100 });
            const items = this.asArrayRecords(data?.items);
            if (items.length === 0)
                return { loadType: 'empty', data: {} };
            const tracks = items
                .map((item) => this.asRecord(item.item) || item)
                .map((item) => this.buildTrack(item))
                .filter((item) => item !== null);
            return {
                loadType: 'playlist',
                data: {
                    info: { name: `Mix: ${mixId}`, selectedTrack: 0 },
                    pluginInfo: { type: 'recommendations' },
                    tracks
                }
            };
        }
        catch (error) {
            return {
                loadType: 'error',
                exception: { message: this.getErrorMessage(error), severity: 'fault' }
            };
        }
    }
    /**
     * Resolves playback URL for a track.
     * @param decodedTrack - Decoded track metadata.
     * @param itag - Preferred format itag.
     * @param forceRefresh - Whether to bypass source URL cache.
     * @returns Stream URL payload or exception.
     */
    async getTrackUrl(decodedTrack, itag, forceRefresh = false) {
        try {
            logger('debug', 'Tidal', `Attempting direct hifi for: ${decodedTrack.title} [${decodedTrack.identifier}]`);
            const direct = await this.getHifiStreamUrl(decodedTrack.identifier);
            if (direct) {
                return { url: direct.url, protocol: 'https', format: direct.format };
            }
            logger('debug', 'Tidal', `Falling back to default search mirror for: ${decodedTrack.title}`);
            const query = `${decodedTrack.title} ${decodedTrack.author}`;
            if (!this.nodelink.sources) {
                return {
                    exception: {
                        message: 'Default source search is not available.',
                        severity: 'fault'
                    }
                };
            }
            let searchResult = await this.nodelink.sources.searchWithDefault(decodedTrack.isrc ? `"${decodedTrack.isrc}"` : query);
            if (searchResult.loadType !== 'search' ||
                searchResult.data.length === 0) {
                searchResult = await this.nodelink.sources.searchWithDefault(query);
            }
            if (searchResult.loadType !== 'search' ||
                searchResult.data.length === 0) {
                return {
                    exception: {
                        message: 'No matching track found on default source.',
                        severity: 'common'
                    }
                };
            }
            const tracks = this.toTrackInfoArray(searchResult.data);
            const candidates = tracks.map((track) => ({
                info: track
            }));
            const bestMatch = getBestMatch(candidates, decodedTrack);
            if (!bestMatch) {
                return {
                    exception: {
                        message: 'No suitable alternative found after filtering.',
                        severity: 'common'
                    }
                };
            }
            const fallbackTrack = tracks.find((track) => track.title === bestMatch.info.title &&
                track.author === bestMatch.info.author &&
                track.length === bestMatch.info.length);
            if (!fallbackTrack) {
                return {
                    exception: {
                        message: 'No suitable alternative found after filtering.',
                        severity: 'common'
                    }
                };
            }
            const sourceManager = this.nodelink.sources;
            if (!sourceManager) {
                return {
                    exception: {
                        message: 'Source manager is not available.',
                        severity: 'fault'
                    }
                };
            }
            const streamInfo = await sourceManager.getTrackUrl(fallbackTrack, itag, forceRefresh);
            return { newTrack: { info: fallbackTrack }, ...streamInfo };
        }
        catch (error) {
            const message = this.getErrorMessage(error);
            logger('error', 'Tidal', `getTrackUrl failed for "${decodedTrack.title}": ${message}`);
            return { exception: { message, severity: 'fault' } };
        }
    }
    /**
     * Loads audio stream from direct URL.
     * @param decodedTrack - Decoded track metadata.
     * @param url - Stream URL.
     * @returns Stream result or exception.
     */
    async loadStream(decodedTrack, url) {
        try {
            const { stream, error, statusCode } = await makeRequest(url, {
                method: 'GET',
                streamOnly: true
            });
            if (error || (statusCode !== 200 && statusCode !== 206) || !stream) {
                const message = error || `Status ${statusCode}`;
                logger('error', 'Tidal', `Stream fetch failed for ${decodedTrack.title}: ${message}`);
                return { exception: { message, severity: 'fault' } };
            }
            const passthrough = new PassThrough();
            stream.on('data', (chunk) => {
                if (!passthrough.write(chunk))
                    stream.pause();
            });
            passthrough.on('drain', () => {
                stream.resume();
            });
            stream.on('end', () => {
                if (!passthrough.writableEnded) {
                    passthrough.emit('finishBuffering');
                    passthrough.end();
                }
            });
            stream.on('error', (err) => {
                const streamError = err instanceof Error ? err : new Error(String(err));
                if (!passthrough.destroyed)
                    passthrough.destroy(streamError);
            });
            logger('debug', 'Tidal', `Streaming ${decodedTrack.title} directly`);
            return { stream: passthrough };
        }
        catch (error) {
            const message = this.getErrorMessage(error);
            logger('error', 'Tidal', `loadStream error for ${decodedTrack.title}: ${message}`);
            return { exception: { message, severity: 'fault' } };
        }
    }
    /**
     * Resolves a track by ID.
     * @param id - Tidal track ID.
     * @returns Track payload.
     */
    async resolveTrack(id) {
        const data = await this.getJson(`tracks/${id}`);
        if (!data)
            return { loadType: 'empty', data: {} };
        const track = this.buildTrack(data);
        if (!track)
            return { loadType: 'empty', data: {} };
        return { loadType: 'track', data: track };
    }
    /**
     * Resolves an album by ID.
     * @param id - Tidal album ID.
     * @returns Playlist payload.
     */
    async resolveAlbum(id) {
        const albumData = await this.getJson(`albums/${id}`);
        const tracksData = await this.getJson(`albums/${id}/tracks`, { limit: 100 });
        const items = this.asArrayRecords(tracksData?.items);
        if (!albumData || items.length === 0)
            return { loadType: 'empty', data: {} };
        const tracks = items
            .map((item) => this.buildTrack(item))
            .filter((item) => item !== null);
        return {
            loadType: 'playlist',
            data: {
                info: {
                    name: this.asString(albumData.title) || 'Unknown Album',
                    selectedTrack: 0
                },
                tracks,
                pluginInfo: {}
            }
        };
    }
    /**
     * Resolves a playlist by ID.
     * @param id - Tidal playlist ID.
     * @returns Playlist payload.
     */
    async resolvePlaylist(id) {
        const playlistData = await this.getJson(`playlists/${id}`);
        const totalTracks = this.asNumber(playlistData?.numberOfTracks) ?? 0;
        if (!playlistData || totalTracks === 0)
            return { loadType: 'empty', data: {} };
        const firstPageData = await this.getJson(`playlists/${id}/tracks`, {
            limit: 50,
            offset: 0
        });
        const firstItems = this.asArrayRecords(firstPageData?.items);
        if (firstItems.length === 0)
            return { loadType: 'empty', data: {} };
        const allItems = [...firstItems];
        const limit = 50;
        let pagesToFetch = Math.ceil(totalTracks / limit);
        if (this.playlistLoadLimit > 0) {
            pagesToFetch = Math.min(pagesToFetch, this.playlistLoadLimit);
        }
        const pageRequests = [];
        for (let i = 1; i < pagesToFetch; i++) {
            const offset = i * limit;
            pageRequests.push(this.getJson(`playlists/${id}/tracks`, { limit, offset }));
        }
        if (pageRequests.length > 0) {
            const batchSize = this.playlistPageLoadConcurrency;
            for (let i = 0; i < pageRequests.length; i += batchSize) {
                const batch = pageRequests.slice(i, i + batchSize);
                try {
                    const results = await Promise.all(batch);
                    for (const page of results) {
                        allItems.push(...this.asArrayRecords(page?.items));
                    }
                }
                catch (error) {
                    logger('warn', 'Tidal', `Failed to fetch a batch of playlist pages: ${this.getErrorMessage(error)}`);
                }
            }
        }
        const tracks = allItems
            .map((item) => this.asRecord(item.item) || item)
            .map((item) => this.buildTrack(item))
            .filter((item) => item !== null);
        logger('info', 'Tidal', `Loaded ${tracks.length} of ${totalTracks} tracks from playlist "${this.asString(playlistData.title) || 'Unknown Playlist'}".`);
        return {
            loadType: 'playlist',
            data: {
                info: {
                    name: this.asString(playlistData.title) || 'Unknown Playlist',
                    selectedTrack: 0
                },
                tracks,
                pluginInfo: {}
            }
        };
    }
    /**
     * Resolves artist top tracks by ID.
     * @param id - Tidal artist ID.
     * @returns Playlist payload.
     */
    async resolveArtist(id) {
        if (this.hifiApis.length === 0) {
            logger('warn', 'Tidal', `No hifi APIs configured, cannot load artist ${id}`);
            return { loadType: 'empty', data: {} };
        }
        const baseUrl = this.hifiApis[0];
        if (!baseUrl)
            return { loadType: 'empty', data: {} };
        logger('debug', 'Tidal', `Fetching artist data via hifi for: ${id}`);
        const [infoRes, tracksRes] = await Promise.all([
            http1makeRequest(`${baseUrl}/artist/?id=${id}`, {}),
            http1makeRequest(`${baseUrl}/artist/?f=${id}&skip_tracks=true`, {})
        ]);
        const tracksBody = this.asRecord(tracksRes.body);
        const tracksList = this.asArrayRecords(tracksBody?.tracks);
        if (tracksRes.error ||
            tracksRes.statusCode !== 200 ||
            tracksList.length === 0) {
            logger('warn', 'Tidal', `hifi artist tracks fetch failed for ${id}: ${tracksRes.error || tracksRes.statusCode}`);
            return { loadType: 'empty', data: {} };
        }
        const infoBody = this.asRecord(infoRes.body);
        const artist = this.asRecord(infoBody?.artist);
        const name = this.asString(artist?.name) || `Artist ${id}`;
        const tracks = tracksList
            .map((item) => this.buildTrack(item))
            .filter((item) => item !== null);
        logger('debug', 'Tidal', `Loaded ${tracks.length} tracks for artist "${name}"`);
        return {
            loadType: 'playlist',
            data: {
                info: { name, selectedTrack: 0 },
                tracks,
                pluginInfo: {}
            }
        };
    }
    /**
     * Performs a Tidal API request.
     * @param endpoint - API endpoint path.
     * @param params - Query params.
     * @returns Parsed JSON payload.
     */
    async getJson(endpoint, params = {}) {
        const url = new URL(`${API_BASE}${endpoint}`);
        const queryParams = { ...params, countryCode: this.countryCode };
        for (const [key, value] of Object.entries(queryParams)) {
            url.searchParams.append(key, String(value));
        }
        const { body, error, statusCode } = await http1makeRequest(url.toString(), {
            headers: {
                'x-tidal-token': this.token || '',
                'User-Agent': 'TIDAL/3704 CFNetwork/1220.1 Darwin/20.3.0'
            }
        });
        if (error || statusCode !== 200) {
            throw new Error(`Failed to fetch from Tidal API: ${error || `Status ${statusCode}`}`);
        }
        if (typeof body === 'string') {
            try {
                return this.asRecord(JSON.parse(body));
            }
            catch {
                return null;
            }
        }
        return this.asRecord(body);
    }
    /**
     * Creates encoded track payload from raw Tidal item.
     * @param item - Raw Tidal track object.
     * @returns Encoded track payload.
     */
    buildTrack(item) {
        const idRaw = item.id;
        if (idRaw === undefined || idRaw === null)
            return null;
        const identifier = String(idRaw);
        const artists = this.asArrayRecords(item.artists)
            .map((artist) => this.asString(artist.name))
            .filter((name) => Boolean(name));
        const album = this.asRecord(item.album);
        const cover = this.asString(album?.cover);
        const trackInfo = {
            identifier,
            isSeekable: true,
            author: artists.join(', ') || 'Unknown Artist',
            length: (this.asNumber(item.duration) ?? 0) * 1000,
            isStream: false,
            position: 0,
            title: this.asString(item.title) || 'Unknown Title',
            uri: this.asString(item.url) ||
                `https://tidal.com/browse/track/${identifier}`,
            artworkUrl: cover
                ? `https://resources.tidal.com/images/${cover.replace(/-/g, '/')}/1280x1280.jpg`
                : null,
            isrc: this.asString(item.isrc) || null,
            sourceName: 'tidal'
        };
        const encodedInput = { ...trackInfo, details: [] };
        return {
            encoded: encodeTrack(encodedInput),
            info: trackInfo,
            pluginInfo: {}
        };
    }
    /**
     * Tries direct hifi APIs and returns first playable URL.
     * @param trackId - Tidal track ID.
     * @returns Direct stream metadata or null.
     */
    async getHifiStreamUrl(trackId) {
        if (this.hifiApis.length === 0) {
            logger('warn', 'Tidal', 'No hifi APIs configured, skipping direct stream');
            return null;
        }
        for (const baseUrl of this.hifiApis) {
            for (const quality of this.hifiQualities) {
                const url = `${baseUrl}/track/?id=${trackId}&quality=${quality}`;
                logger('debug', 'Tidal', `Trying hifi: ${url}`);
                try {
                    const { body, error, statusCode } = await http1makeRequest(url, {});
                    if (error || statusCode !== 200 || !body) {
                        logger('debug', 'Tidal', `  ✗ ${quality} @ ${baseUrl} → ${error || statusCode}`);
                        continue;
                    }
                    const bodyObject = this.asRecord(body);
                    const data = this.asRecord(bodyObject?.data);
                    const rawManifest = this.asString(data?.manifest);
                    if (!rawManifest) {
                        logger('debug', 'Tidal', `  ✗ ${quality} @ ${baseUrl} → no manifest field`);
                        continue;
                    }
                    const manifest = this.asRecord(JSON.parse(Buffer.from(rawManifest, 'base64').toString('utf8')));
                    const urls = this.toStringArray(manifest?.urls);
                    const streamUrl = urls[0];
                    if (!streamUrl) {
                        logger('debug', 'Tidal', `  ✗ ${quality} @ ${baseUrl} → no URL in manifest`);
                        continue;
                    }
                    const mimeType = this.asString(manifest?.mimeType) || '';
                    const format = mimeType.includes('flac') ? 'flac' : 'mp4';
                    const codecs = this.asString(manifest?.codecs) || 'unknown';
                    logger('debug', 'Tidal', `  ✓ Direct stream: quality=${quality} format=${format} codec=${codecs} api=${baseUrl}`);
                    return { url: streamUrl, quality, format };
                }
                catch (error) {
                    logger('debug', 'Tidal', `  ✗ ${quality} @ ${baseUrl} → ${this.getErrorMessage(error)}`);
                }
            }
        }
        logger('warn', 'Tidal', `All hifi APIs exhausted for track ${trackId}, will mirror`);
        return null;
    }
    /**
     * Extracts the second client ID from Tidal asset source.
     * @param text - Asset file content.
     * @returns Client ID or null.
     */
    extractSecondClientId(text) {
        const regex = /clientId\s*[:=]\s*"([^"]+)"/g;
        let count = 0;
        for (const match of text.matchAll(regex)) {
            count += 1;
            if (count === 2)
                return match[1] || null;
        }
        return null;
    }
    /**
     * Converts unknown search payload into TrackInfo array.
     * @param data - Search result data.
     * @returns Track list.
     */
    toTrackInfoArray(data) {
        if (!Array.isArray(data))
            return [];
        const tracks = [];
        for (const item of data) {
            const itemRecord = this.asRecord(item);
            const info = this.asRecord(itemRecord?.info);
            if (!info)
                continue;
            const identifier = this.asString(info.identifier);
            const isSeekable = this.asBoolean(info.isSeekable);
            const author = this.asString(info.author);
            const length = this.asNumber(info.length);
            const isStream = this.asBoolean(info.isStream);
            const position = this.asNumber(info.position);
            const title = this.asString(info.title);
            const uri = this.asString(info.uri);
            const sourceName = this.asString(info.sourceName);
            if (identifier === null ||
                isSeekable === null ||
                author === null ||
                length === null ||
                isStream === null ||
                position === null ||
                title === null ||
                uri === null ||
                sourceName === null) {
                continue;
            }
            tracks.push({
                identifier,
                isSeekable,
                author,
                length,
                isStream,
                position,
                title,
                uri,
                artworkUrl: this.asString(info.artworkUrl) || null,
                isrc: this.asString(info.isrc) || null,
                sourceName
            });
        }
        return tracks;
    }
    /**
     * Casts unknown value to record.
     * @param value - Unknown value.
     * @returns Record or null.
     */
    asRecord(value) {
        return value && typeof value === 'object' && !Array.isArray(value)
            ? value
            : null;
    }
    /**
     * Casts unknown value to string.
     * @param value - Unknown value.
     * @returns String or null.
     */
    asString(value) {
        return typeof value === 'string' ? value : null;
    }
    /**
     * Casts unknown value to finite number.
     * @param value - Unknown value.
     * @returns Number or null.
     */
    asNumber(value) {
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }
    /**
     * Casts unknown value to boolean.
     * @param value - Unknown value.
     * @returns Boolean or null.
     */
    asBoolean(value) {
        return typeof value === 'boolean' ? value : null;
    }
    /**
     * Casts unknown value to record array.
     * @param value - Unknown value.
     * @returns Record array.
     */
    asArrayRecords(value) {
        if (!Array.isArray(value))
            return [];
        return value
            .map((item) => this.asRecord(item))
            .filter((item) => item !== null);
    }
    /**
     * Casts unknown value to string array.
     * @param value - Unknown value.
     * @returns String array.
     */
    toStringArray(value) {
        if (!Array.isArray(value))
            return [];
        return value.filter((item) => typeof item === 'string');
    }
    /**
     * Normalizes unknown errors to message string.
     * @param error - Unknown error.
     * @returns Error message.
     */
    getErrorMessage(error) {
        return error instanceof Error ? error.message : String(error);
    }
}
