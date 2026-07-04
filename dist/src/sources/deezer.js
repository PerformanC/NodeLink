import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import BlowfishCBC from "../decrypters/blowfish-cbc.js";
import { encodeTrack, getBestMatch, http1makeRequest, logger, makeRequest } from "../utils.js";
/**
 * Static IV used by Deezer's Blowfish-CBC chunk decryption scheme.
 */
const IV = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);
/**
 * Accepts plain ISRCs and `isrc:`-prefixed queries with optional hyphens.
 */
const ISRC_REGEX = /^(?:isrc:)?([A-Z]{2}-?[A-Z0-9]{3}-?\d{2}-?\d{5})$/i;
/**
 * TTL used when persisting Deezer gateway credentials.
 */
const CREDENTIAL_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * TTL used for cached direct-stream resolutions.
 */
const TRACK_CACHE_TTL_MS = 4 * 60 * 60 * 1000;
/**
 * Deezer source with typed REST/gateway payloads and stricter stream cleanup.
 */
export default class DeezerSource {
    /**
     * Runtime worker context used by the source implementation.
     */
    nodelink;
    /**
     * Sanitized Deezer-specific runtime options.
     */
    config;
    /**
     * Search aliases handled by this source.
     */
    searchTerms = ['dzsearch', 'dzisrc'];
    /**
     * Recommendation aliases handled by this source.
     */
    recommendationTerm = ['dzrec'];
    /**
     * Deezer URL patterns resolved by this source.
     */
    patterns = [
        /^https?:\/\/(?:www\.)?deezer\.com\/(?:[a-z]+(?:-[a-z]+)?\/)?(track|album|playlist|artist)\/(\d+)(?:\?.*)?$/,
        /^https?:\/\/link\.deezer\.com\/s\/([a-zA-Z0-9]+)/
    ];
    /**
     * Match priority used by the source manager.
     */
    priority = 80;
    /**
     * Deezer session cookie used by authenticated gateway requests.
     */
    cookie = null;
    /**
     * Gateway CSRF token returned by Deezer user-data requests.
     */
    csrfToken = null;
    /**
     * License token required by Deezer's direct media API.
     */
    licenseToken = null;
    /**
     * In-flight setup promise used to serialize initialization work.
     */
    setupPromise = null;
    /**
     * Creates a new Deezer source wrapper.
     *
     * @param nodelink Worker runtime used by the source implementation.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.config = nodelink.options;
    }
    /**
     * Initializes Deezer gateway credentials and caches them for later use.
     *
     * Concurrent setup calls are serialized so credential refreshes cannot race
     * and overwrite cookies or tokens mid-boot.
     *
     * @returns `true` when the source is ready to accept requests.
     */
    async setup() {
        if (this.setupPromise)
            return this.setupPromise;
        const currentSetup = this.performSetup();
        this.setupPromise = currentSetup;
        try {
            return await currentSetup;
        }
        finally {
            if (this.setupPromise === currentSetup) {
                this.setupPromise = null;
            }
        }
    }
    /**
     * Searches Deezer tracks, albums, playlists, artists, or recommendation
     * mixes depending on the routed source alias.
     *
     * @param query Search text supplied by the source manager.
     * @param sourceTerm Source alias that routed the request.
     * @param searchType Search type inferred by the source manager.
     * @returns Search results, an empty payload, or a structured exception.
     */
    async search(query, sourceTerm, searchType = 'track') {
        if (sourceTerm && this.recommendationTerm.includes(sourceTerm)) {
            return this.getRecommendations(query);
        }
        const isrc = this.extractIsrc(query);
        if (isrc) {
            try {
                const track = await this.fetchTrackByIsrc(isrc);
                const builtTrack = track ? this.buildTrack(track) : null;
                return builtTrack
                    ? { loadType: 'search', data: [builtTrack] }
                    : { loadType: 'empty', data: {} };
            }
            catch (error) {
                logger('warn', 'Deezer', `ISRC lookup failed for ${isrc}: ${this.getErrorMessage(error)}`);
                return { loadType: 'empty', data: {} };
            }
        }
        const effectiveSearchType = this.isSearchType(searchType)
            ? searchType
            : 'track';
        const { body, error } = await makeRequest(`https://api.deezer.com/2.0/search/${effectiveSearchType}?q=${encodeURIComponent(query)}`, { method: 'GET' });
        const response = this.getJsonBody(body);
        if (error || response?.error) {
            return this.createException(error ?? response?.error?.message ?? 'Failed to search Deezer.', 'common');
        }
        const items = Array.isArray(response?.data)
            ? response.data.slice(0, this.getMaxSearchResults())
            : [];
        if ((response?.total ?? items.length) === 0 || items.length === 0) {
            return { loadType: 'empty', data: {} };
        }
        const results = [];
        if (effectiveSearchType === 'track') {
            for (const item of items) {
                if (item.type === 'track' && item.readable !== false) {
                    const track = this.buildTrack(item);
                    if (track)
                        results.push(track);
                }
            }
        }
        else {
            for (const item of items) {
                const track = this.buildMetadataTrack(item, effectiveSearchType);
                if (track)
                    results.push(track);
            }
        }
        return results.length > 0
            ? { loadType: 'search', data: results }
            : { loadType: 'empty', data: {} };
    }
    /**
     * Loads Deezer recommendation mixes from the gateway radio endpoints.
     *
     * @param query Track seed, artist seed, or free-text query.
     * @returns Playlist-style recommendation payload, an empty payload, or a
     * structured exception.
     */
    async getRecommendations(query) {
        if (!this.cookie || !this.csrfToken) {
            return this.createException('Deezer gateway credentials are not available.', 'fault');
        }
        try {
            let method = 'song.getSearchTrackMix';
            let payload = {
                sng_id: query,
                start_with_input_track: 'true'
            };
            if (query.startsWith('artist=')) {
                const artistId = query.slice('artist='.length).trim();
                if (!artistId)
                    return { loadType: 'empty', data: {} };
                method = 'song.getSmartRadio';
                payload = { art_id: artistId };
            }
            else if (query.startsWith('track=')) {
                const trackId = query.slice('track='.length).trim();
                if (!trackId)
                    return { loadType: 'empty', data: {} };
                payload = { sng_id: trackId, start_with_input_track: 'true' };
            }
            else if (!/^\d+$/.test(query)) {
                const searchResult = await this.search(query, 'dzsearch', 'track');
                const tracks = this.extractTrackData(searchResult);
                const firstTrack = tracks[0];
                if (!firstTrack)
                    return { loadType: 'empty', data: {} };
                payload = {
                    sng_id: firstTrack.info.identifier,
                    start_with_input_track: 'true'
                };
            }
            const { body, error } = await makeRequest(`https://www.deezer.com/ajax/gw-light.php?method=${method}&input=3&api_version=1.0&api_token=${this.csrfToken}`, {
                method: 'POST',
                headers: { Cookie: this.cookie },
                body: payload,
                disableBodyCompression: true
            });
            const response = this.getJsonBody(body);
            if (error)
                return this.createException(error, 'fault');
            const items = response?.results?.data;
            if (!Array.isArray(items) || items.length === 0) {
                return { loadType: 'empty', data: {} };
            }
            const tracks = items
                .map((item) => this.buildRecommendationTrack(item))
                .filter((track) => track !== null);
            if (tracks.length === 0)
                return { loadType: 'empty', data: {} };
            const playlist = {
                info: { name: 'Deezer Recommendations', selectedTrack: 0 },
                pluginInfo: { type: 'recommendations' },
                tracks
            };
            return { loadType: 'playlist', data: playlist };
        }
        catch (error) {
            return this.createException(this.getErrorMessage(error), 'fault');
        }
    }
    /**
     * Resolves Deezer track, album, playlist, and artist URLs.
     *
     * @param url Candidate Deezer URL.
     * @returns Track or playlist-style payload, an empty payload, or a
     * structured exception.
     */
    async resolve(url) {
        if (url.includes('link.deezer.com')) {
            const response = await http1makeRequest(url, { method: 'GET' });
            const resolvedBody = this.getTextBody(response.body);
            const match = resolvedBody?.match(/\/(track|album|playlist|artist)\/(\d+)/);
            if (!match)
                return { loadType: 'empty', data: {} };
            return this.resolve(`https://www.deezer.com/${match[1]}/${match[2]}`);
        }
        const match = this.patterns[0]?.exec(url);
        if (!match)
            return { loadType: 'empty', data: {} };
        const type = match[1];
        const id = match[2];
        if (!type || !id || !this.isSearchType(type)) {
            return { loadType: 'empty', data: {} };
        }
        const { body, error } = await makeRequest(`https://api.deezer.com/2.0/${type}/${id}`, { method: 'GET' });
        const entity = this.getJsonBody(body);
        if (error || entity?.error) {
            if (entity?.error?.code === 800) {
                return { loadType: 'empty', data: {} };
            }
            return this.createException(error ?? entity?.error?.message ?? 'Failed to resolve Deezer URL.', 'fault');
        }
        if (!entity)
            return { loadType: 'empty', data: {} };
        switch (type) {
            case 'track': {
                const track = this.buildTrack(entity);
                return track
                    ? { loadType: 'track', data: track }
                    : { loadType: 'empty', data: {} };
            }
            case 'album':
            case 'playlist': {
                if (!entity.tracklist) {
                    return this.createException('Could not fetch playlist tracks.', 'common');
                }
                const { body: tracksBody, error: tracksError } = await makeRequest(`${entity.tracklist}?limit=${this.getMaxCollectionLength(1000)}`, { method: 'GET' });
                const tracksResponse = this.getJsonBody(tracksBody);
                if (tracksError ||
                    !Array.isArray(tracksResponse?.data) ||
                    tracksResponse.data.length === 0) {
                    return this.createException(tracksError ?? 'Could not fetch playlist tracks.', 'common');
                }
                const artworkUrl = entity.cover_xl ?? entity.picture_xl ?? null;
                const tracks = tracksResponse.data
                    .map((item) => this.buildTrack(item, artworkUrl))
                    .filter((track) => track !== null);
                if (tracks.length === 0)
                    return { loadType: 'empty', data: {} };
                return {
                    loadType: type,
                    data: {
                        info: {
                            name: entity.title ?? 'Unknown Deezer Collection',
                            selectedTrack: 0
                        },
                        pluginInfo: {},
                        tracks
                    }
                };
            }
            case 'artist': {
                const { body: topTracksBody, error: topTracksError } = await makeRequest(`https://api.deezer.com/2.0/artist/${id}/top?limit=${this.getMaxCollectionLength(25)}`, { method: 'GET' });
                const topTracksResponse = this.getJsonBody(topTracksBody);
                if (topTracksError || topTracksResponse?.error) {
                    return this.createException(topTracksError ??
                        topTracksResponse?.error?.message ??
                        'Failed to fetch Deezer artist top tracks.', 'common');
                }
                const tracks = (topTracksResponse?.data ?? [])
                    .map((item) => this.buildTrack(item, entity.picture_xl ?? null))
                    .filter((track) => track !== null);
                if (tracks.length === 0)
                    return { loadType: 'empty', data: {} };
                return {
                    loadType: 'artist',
                    data: {
                        info: {
                            name: `${entity.name ?? 'Unknown Artist'}'s Top Tracks`,
                            selectedTrack: 0
                        },
                        pluginInfo: {},
                        tracks
                    }
                };
            }
        }
    }
    /**
     * Resolves a direct Deezer stream URL and falls back to delegated search when
     * the direct media path is unavailable.
     *
     * @param decodedTrack Decoded Deezer track metadata.
     * @param _itag Unused format selector kept for source-manager compatibility.
     * @param forceRefresh When `true`, bypasses the track-url cache.
     * @returns Direct stream metadata, delegated fallback metadata, or a
     * structured exception.
     */
    async getTrackUrl(decodedTrack, _itag, forceRefresh = false) {
        const cacheManager = this.nodelink.trackCacheManager;
        if (!forceRefresh) {
            const cached = cacheManager?.get('deezer', decodedTrack.identifier);
            if (cached)
                return cached;
        }
        if (this.cookie && this.csrfToken && this.licenseToken) {
            try {
                const { body: trackBody, error: trackError } = await makeRequest(`https://www.deezer.com/ajax/gw-light.php?method=song.getListData&input=3&api_version=1.0&api_token=${this.csrfToken}`, {
                    method: 'POST',
                    headers: { Cookie: this.cookie },
                    body: { sng_ids: [decodedTrack.identifier] },
                    disableBodyCompression: true
                });
                const trackResponse = this.getJsonBody(trackBody);
                const gatewayError = this.getGatewayErrorMessage(trackResponse?.error);
                if (trackError || gatewayError) {
                    throw new Error(trackError ?? gatewayError ?? 'Deezer gateway failed.');
                }
                const trackInfo = trackResponse?.results?.data?.[0];
                if (!trackInfo?.TRACK_TOKEN) {
                    throw new Error('Deezer track token was not found.');
                }
                const { body: streamBody, error: streamError } = await makeRequest('https://media.deezer.com/v1/get_url', {
                    method: 'POST',
                    body: {
                        license_token: this.licenseToken,
                        media: [
                            {
                                type: 'FULL',
                                formats: [
                                    { cipher: 'BF_CBC_STRIPE', format: 'FLAC' },
                                    { cipher: 'BF_CBC_STRIPE', format: 'MP3_256' },
                                    { cipher: 'BF_CBC_STRIPE', format: 'MP3_128' },
                                    { cipher: 'BF_CBC_STRIPE', format: 'MP3_MISC' }
                                ]
                            }
                        ],
                        track_tokens: [trackInfo.TRACK_TOKEN]
                    },
                    disableBodyCompression: true
                });
                const streamResponse = this.getJsonBody(streamBody);
                if (streamError)
                    throw new Error(streamError);
                const media = streamResponse?.data?.[0]?.media?.[0];
                const streamUrl = media?.sources?.[0]?.url;
                if (media?.format && streamUrl) {
                    const result = {
                        url: streamUrl,
                        protocol: 'https',
                        format: media.format.startsWith('MP3') ? 'mp3' : 'flac',
                        additionalData: { ...trackInfo }
                    };
                    cacheManager?.set('deezer', decodedTrack.identifier, result, TRACK_CACHE_TTL_MS);
                    return result;
                }
            }
            catch (error) {
                const errMsg = this.getErrorMessage(error);
                if (errMsg.toLowerCase().includes('csrf') &&
                    !forceRefresh) {
                    logger('warn', 'Deezer', `CSRF token expired (${errMsg}). Evicting cache and refreshing credentials...`);
                    const cm = this.nodelink.credentialManager;
                    cm?.delete?.('deezer_csrf_token');
                    cm?.delete?.('deezer_license_token');
                    cm?.delete?.('deezer_cookie');
                    this.csrfToken = null;
                    this.licenseToken = null;
                    this.cookie = null;
                    const success = await this.performSetup();
                    if (success && this.cookie && this.csrfToken && this.licenseToken) {
                        logger('info', 'Deezer', 'Credentials refreshed. Retrying direct stream...');
                        return this.getTrackUrl(decodedTrack, _itag, true);
                    }
                    logger('warn', 'Deezer', 'Failed to refresh credentials. Falling back to search.');
                }
                else {
                    logger('warn', 'Deezer', `Direct stream failed for ${decodedTrack.title}: ${errMsg}. Falling back to default search.`);
                }
            }
        }
        const sourceManager = this.getSourceManager();
        if (!sourceManager) {
            return this.createException('No source manager is available for fallback resolution.', 'fault', 'StreamLink');
        }
        const query = `${decodedTrack.title} ${decodedTrack.author}`;
        let searchResult = await sourceManager.searchWithDefault(decodedTrack.isrc ? `"${decodedTrack.isrc}"` : query);
        if (this.extractTrackData(searchResult).length === 0) {
            searchResult = await sourceManager.searchWithDefault(query);
        }
        const candidates = this.extractTrackData(searchResult);
        const bestMatch = getBestMatch(candidates, decodedTrack);
        if (!bestMatch) {
            return this.createException('No suitable alternative found.', 'fault', 'StreamLink');
        }
        const streamInfo = await sourceManager.getTrackUrl(bestMatch.info);
        return { newTrack: bestMatch, ...streamInfo };
    }
    /**
     * Opens and decrypts Deezer direct streams with explicit listener cleanup.
     *
     * The rewritten implementation also tears down upstream listeners when the
     * downstream stream closes or errors, which avoids leaking listeners across
     * interrupted playback attempts.
     *
     * @param decodedTrack Decoded Deezer track metadata being played.
     * @param url Direct encrypted stream URL returned by `getTrackUrl(...)`.
     * @param _format Unused direct-stream format hint.
     * @param additionalData Deezer gateway metadata cached during URL resolution.
     * @returns Decrypted stream payload, or a structured exception.
     */
    async loadStream(decodedTrack, url, _format, additionalData) {
        try {
            const streamData = this.getAdditionalData(additionalData);
            if (!streamData.SNG_ID) {
                return this.createException('Deezer stream metadata is missing the song identifier.', 'fault');
            }
            const outputStream = new PassThrough();
            const trackKey = this.calculateKey(streamData.SNG_ID);
            const headers = {};
            const bufferSize = 2048;
            let chunkIndex = 0;
            let remainder = Buffer.alloc(0);
            if (typeof streamData.startTime === 'number' &&
                streamData.startTime > 0 &&
                streamData.FILESIZE !== undefined &&
                streamData.DURATION !== undefined) {
                const durationSeconds = this.toNumber(streamData.DURATION);
                const fileSize = this.toNumber(streamData.FILESIZE);
                if (durationSeconds &&
                    fileSize &&
                    durationSeconds > 0 &&
                    fileSize > 0) {
                    const byteRate = fileSize / (durationSeconds * 1000);
                    const rawOffset = streamData.startTime * byteRate;
                    const initialChunkIndex = Math.floor(rawOffset / bufferSize);
                    const byteOffset = initialChunkIndex * bufferSize;
                    if (byteOffset > 0) {
                        headers.Range = `bytes=${byteOffset}-`;
                    }
                    chunkIndex = initialChunkIndex;
                }
            }
            const response = await makeRequest(url, {
                method: 'GET',
                streamOnly: true,
                headers
            });
            if (response.error ||
                (response.statusCode !== 200 && response.statusCode !== 206) ||
                !response.stream) {
                const message = response.error ??
                    `Request failed with status ${response.statusCode ?? 'unknown'}`;
                return this.createException(message, 'fault', 'Upstream');
            }
            if (response.statusCode === 200) {
                chunkIndex = 0;
            }
            const sourceStream = response.stream;
            const blowfish = new BlowfishCBC(trackKey);
            let cleanedUp = false;
            const cleanup = () => {
                if (cleanedUp)
                    return;
                cleanedUp = true;
                sourceStream.removeListener('data', handleData);
                sourceStream.removeListener('end', handleEnd);
                sourceStream.removeListener('error', handleSourceError);
                outputStream.removeListener('close', handleOutputClose);
                outputStream.removeListener('error', handleOutputError);
            };
            const destroySource = (error) => {
                if (!sourceStream.destroyed) {
                    sourceStream.destroy(error);
                }
            };
            const handleData = (chunk) => {
                try {
                    let data = chunk;
                    if (remainder.length > 0) {
                        data = Buffer.concat([remainder, chunk]);
                        remainder = Buffer.alloc(0);
                    }
                    let offset = 0;
                    while (offset + bufferSize <= data.length) {
                        const encryptedBlock = data.subarray(offset, offset + bufferSize);
                        if (chunkIndex % 3 === 0) {
                            blowfish.setIv(IV);
                            outputStream.push(Buffer.from(blowfish.decode(encryptedBlock)));
                        }
                        else {
                            outputStream.push(encryptedBlock);
                        }
                        chunkIndex++;
                        offset += bufferSize;
                    }
                    if (offset < data.length) {
                        remainder = Buffer.from(data.subarray(offset));
                    }
                }
                catch (error) {
                    const streamError = error instanceof Error ? error : new Error(String(error));
                    cleanup();
                    if (!outputStream.destroyed) {
                        outputStream.destroy(streamError);
                    }
                    destroySource(streamError);
                }
            };
            const handleEnd = () => {
                cleanup();
                if (remainder.length > 0 && !outputStream.destroyed) {
                    outputStream.push(remainder);
                    remainder = Buffer.alloc(0);
                }
                if (!outputStream.destroyed) {
                    outputStream.emit('finishBuffering');
                    outputStream.end();
                }
            };
            const handleSourceError = (error) => {
                cleanup();
                logger('error', 'Sources', `Error in Deezer source stream for track ${decodedTrack.title}: ${error.message}`);
                if (!outputStream.destroyed) {
                    outputStream.destroy(error);
                }
            };
            const handleOutputClose = () => {
                cleanup();
                destroySource();
            };
            const handleOutputError = () => {
                cleanup();
                destroySource();
            };
            sourceStream.on('data', handleData);
            sourceStream.once('end', handleEnd);
            sourceStream.once('error', handleSourceError);
            outputStream.once('close', handleOutputClose);
            outputStream.once('error', handleOutputError);
            return { stream: outputStream };
        }
        catch (error) {
            logger('error', 'Sources', `Failed to load Deezer stream for ${decodedTrack.identifier}: ${this.getErrorMessage(error)}`);
            return this.createException(this.getErrorMessage(error), 'fault');
        }
    }
    /**
     * Performs the Deezer credential bootstrap after setup serialization has
     * been applied.
     *
     * @returns `true` when Deezer gateway credentials were loaded successfully.
     */
    async performSetup() {
        logger('info', 'Sources', 'Initializing Deezer source...');
        const credentialManager = this.nodelink.credentialManager;
        const cachedCsrf = credentialManager?.get('deezer_csrf_token');
        const cachedLicense = credentialManager?.get('deezer_license_token');
        const cachedCookie = credentialManager?.get('deezer_cookie');
        if (cachedCsrf && cachedLicense && cachedCookie) {
            this.csrfToken = cachedCsrf;
            this.licenseToken = cachedLicense;
            this.cookie = cachedCookie;
            logger('info', 'Sources', 'Loaded Deezer credentials from CredentialManager.');
            return true;
        }
        try {
            const arl = this.config.sources?.deezer?.arl;
            const initialCookie = typeof arl === 'string' && arl.length > 0 ? `arl=${arl}` : '';
            const response = await http1makeRequest('https://www.deezer.com/ajax/gw-light.php?method=deezer.getUserData&input=3&api_version=1.0&api_token=', {
                method: 'GET',
                headers: initialCookie ? { Cookie: initialCookie } : undefined
            });
            const userData = this.getJsonBody(response.body);
            if (response.error || !userData?.results) {
                throw new Error(response.error ?? 'Failed to fetch Deezer user data.');
            }
            const responseCookies = this.getCookieHeaderValue(response.headers);
            this.cookie = initialCookie
                ? responseCookies
                    ? `${initialCookie}; ${responseCookies}`
                    : initialCookie
                : responseCookies;
            this.csrfToken = userData.results.checkForm ?? null;
            this.licenseToken = userData.results.USER?.OPTIONS?.license_token ?? null;
            if (!this.cookie || !this.csrfToken || !this.licenseToken) {
                throw new Error('CSRF token, license token, or cookie was missing.');
            }
            credentialManager?.set('deezer_csrf_token', this.csrfToken, CREDENTIAL_TTL_MS);
            credentialManager?.set('deezer_license_token', this.licenseToken, CREDENTIAL_TTL_MS);
            credentialManager?.set('deezer_cookie', this.cookie, CREDENTIAL_TTL_MS);
            logger('info', 'Sources', 'Deezer source setup successfully.');
            return true;
        }
        catch (error) {
            logger('error', 'Sources', `Failed to setup Deezer source: ${this.getErrorMessage(error)}`);
            return false;
        }
    }
    /**
     * Builds a metadata-only encoded track for album, playlist, and artist
     * search results.
     *
     * @param item Raw Deezer entity returned by the public API.
     * @param type Collection type represented by the entity.
     * @returns Encoded metadata track, or `null` when the entity is incomplete.
     */
    buildMetadataTrack(item, type) {
        if (item.id === undefined || item.id === null || item.id === '')
            return null;
        const identifier = String(item.id);
        const artworkUrl = item.cover_xl ??
            item.cover_big ??
            item.cover_medium ??
            item.picture_xl ??
            item.picture_big ??
            item.picture_medium ??
            null;
        const info = {
            title: type === 'artist'
                ? item.name?.trim() || 'Unknown Artist'
                : item.title?.trim() || 'Unknown Title',
            author: type === 'album'
                ? item.artist?.name?.trim() || 'Unknown Artist'
                : type === 'playlist'
                    ? item.user?.name?.trim() || item.creator?.name?.trim() || 'Deezer'
                    : 'Deezer',
            length: 0,
            identifier,
            isStream: false,
            uri: item.link ||
                `https://www.deezer.com/${type}/${encodeURIComponent(identifier)}`,
            artworkUrl,
            isrc: null,
            sourceName: 'deezer',
            position: 0,
            details: [],
            isSeekable: type !== 'artist'
        };
        const pluginInfo = { type };
        if (typeof item.nb_tracks === 'number') {
            pluginInfo.trackCount = item.nb_tracks;
        }
        return { encoded: encodeTrack(info), info, pluginInfo };
    }
    /**
     * Converts a raw Deezer track payload into an encoded track object.
     *
     * @param item Raw Deezer track metadata.
     * @param artworkUrl Optional artwork override used by playlist and artist
     * resolution paths.
     * @returns Encoded Deezer track, or `null` when the input is incomplete.
     */
    buildTrack(item, artworkUrl = null) {
        if (item.id === undefined || item.id === null || item.id === '')
            return null;
        const trackInfo = {
            identifier: String(item.id),
            isSeekable: true,
            author: item.artist?.name?.trim() || 'Unknown Artist',
            length: this.toMilliseconds(item.duration),
            isStream: false,
            position: 0,
            title: item.title?.trim() || 'Unknown Title',
            uri: item.link ||
                `https://www.deezer.com/track/${encodeURIComponent(String(item.id))}`,
            artworkUrl: artworkUrl ??
                item.album?.cover_xl ??
                item.album?.cover_big ??
                item.album?.cover_medium ??
                null,
            isrc: item.isrc ?? null,
            sourceName: 'deezer',
            details: []
        };
        const pluginInfo = {};
        if (item.album?.title?.trim())
            pluginInfo.albumName = item.album.title.trim();
        if (item.album?.id !== undefined &&
            item.album.id !== null &&
            item.album.id !== '') {
            pluginInfo.albumUrl = `https://www.deezer.com/album/${item.album.id}`;
        }
        if (item.artist?.id !== undefined &&
            item.artist.id !== null &&
            item.artist.id !== '') {
            pluginInfo.artistUrl = `https://www.deezer.com/artist/${item.artist.id}`;
        }
        if (item.artist?.picture_xl)
            pluginInfo.artistArtworkUrl = item.artist.picture_xl;
        if (item.preview)
            pluginInfo.previewUrl = item.preview;
        return { encoded: encodeTrack(trackInfo), info: trackInfo, pluginInfo };
    }
    /**
     * Converts a Deezer recommendation item into an encoded track payload.
     *
     * @param item Raw recommendation item returned by the gateway API.
     * @returns Encoded recommendation track, or `null` when required fields are
     * missing.
     */
    buildRecommendationTrack(item) {
        if (item.SNG_ID === undefined || item.SNG_ID === null)
            return null;
        const info = {
            identifier: String(item.SNG_ID),
            isSeekable: true,
            author: item.ART_NAME?.trim() || 'Unknown Artist',
            length: this.toMilliseconds(item.DURATION),
            isStream: false,
            position: 0,
            title: item.SNG_TITLE?.trim() || 'Unknown Title',
            uri: `https://www.deezer.com/track/${item.SNG_ID}`,
            artworkUrl: item.ALB_PICTURE
                ? `https://e-cdns-images.dzcdn.net/images/cover/${item.ALB_PICTURE}/1000x1000-000000-80-0-0.jpg`
                : null,
            isrc: item.ISRC ?? null,
            sourceName: 'deezer',
            details: []
        };
        return {
            encoded: encodeTrack(info),
            info,
            pluginInfo: {}
        };
    }
    /**
     * Extracts and normalizes an ISRC from a free-text query.
     *
     * @param input Candidate query text.
     * @returns Uppercase ISRC without separators, or `null` when absent.
     */
    extractIsrc(input) {
        const match = input.trim().match(ISRC_REGEX);
        return match?.[1] ? match[1].replace(/-/g, '').toUpperCase() : null;
    }
    /**
     * Resolves a Deezer track directly by ISRC.
     *
     * @param isrc Normalized ISRC value.
     * @returns Deezer track metadata, or `null` when the ISRC is not found.
     */
    async fetchTrackByIsrc(isrc) {
        const { body, error } = await makeRequest(`https://api.deezer.com/2.0/track/isrc:${isrc}`, { method: 'GET' });
        const track = this.getJsonBody(body);
        if (error || track?.error) {
            if (track?.error?.code === 800)
                return null;
            throw new Error(error ?? track?.error?.message ?? 'Failed to fetch track by ISRC.');
        }
        return track;
    }
    /**
     * Checks whether a raw string is one of Deezer's supported search types.
     *
     * @param value Candidate search type.
     * @returns `true` when the string is a supported search type.
     */
    isSearchType(value) {
        return (value === 'track' ||
            value === 'album' ||
            value === 'playlist' ||
            value === 'artist');
    }
    /**
     * Narrows a raw HTTP body into an object-like JSON payload.
     *
     * @param body Raw body returned by the shared HTTP helpers.
     * @returns Typed payload, or `null` when the body is not object-like.
     */
    getJsonBody(body) {
        if (body === null ||
            typeof body !== 'object' ||
            Array.isArray(body) ||
            Buffer.isBuffer(body)) {
            return null;
        }
        return body;
    }
    /**
     * Converts a raw HTTP body into text when possible.
     *
     * @param body Raw body returned by the shared HTTP helpers.
     * @returns Text body, or `null` when the payload is not text-like.
     */
    getTextBody(body) {
        if (typeof body === 'string')
            return body;
        if (Buffer.isBuffer(body))
            return body.toString('utf8');
        return null;
    }
    /**
     * Normalizes `set-cookie` response headers into a single cookie string.
     *
     * @param headers Response headers returned by the HTTP helper.
     * @returns Joined cookie header value, or an empty string when absent.
     */
    getCookieHeaderValue(headers) {
        const setCookie = headers?.['set-cookie'];
        if (Array.isArray(setCookie))
            return setCookie.join('; ');
        return typeof setCookie === 'string' ? setCookie : '';
    }
    /**
     * Converts Deezer gateway error payloads into a readable error string.
     *
     * @param errorPayload Raw gateway error payload.
     * @returns Human-readable message, or `null` when the payload is empty.
     */
    getGatewayErrorMessage(errorPayload) {
        if (!errorPayload)
            return null;
        if (typeof errorPayload === 'string')
            return errorPayload || null;
        if (Array.isArray(errorPayload)) {
            const messages = errorPayload.filter((value) => typeof value === 'string' && value.length > 0);
            return messages.length > 0 ? messages.join('; ') : null;
        }
        const values = Object.values(errorPayload).filter((value) => typeof value === 'string' && value.length > 0);
        return values.length > 0 ? values.join('; ') : null;
    }
    /**
     * Narrows cached additional stream metadata to the fields used by Deezer.
     *
     * @param value Additional data attached to a resolved track URL.
     * @returns Normalized Deezer gateway track metadata.
     */
    getAdditionalData(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            return {};
        const data = value;
        return {
            SNG_ID: typeof data.SNG_ID === 'string' || typeof data.SNG_ID === 'number'
                ? data.SNG_ID
                : undefined,
            TRACK_TOKEN: typeof data.TRACK_TOKEN === 'string' ? data.TRACK_TOKEN : undefined,
            FILESIZE: typeof data.FILESIZE === 'string' || typeof data.FILESIZE === 'number'
                ? data.FILESIZE
                : undefined,
            DURATION: typeof data.DURATION === 'string' || typeof data.DURATION === 'number'
                ? data.DURATION
                : undefined,
            startTime: typeof data.startTime === 'number' ? data.startTime : undefined
        };
    }
    /**
     * Extracts encoded track candidates from a generic source result.
     *
     * @param result Source result returned by a search flow.
     * @returns Deezer-compatible track candidates for best-match scoring.
     */
    extractTrackData(result) {
        if (result.loadType !== 'search' || !Array.isArray(result.data))
            return [];
        return result.data.filter((item) => this.isTrackData(item));
    }
    /**
     * Checks whether an unknown value exposes a valid encoded track shape.
     *
     * @param value Candidate search result item.
     * @returns `true` when the value is a usable encoded track payload.
     */
    isTrackData(value) {
        if (!value || typeof value !== 'object')
            return false;
        const record = value;
        return (typeof record.encoded === 'string' &&
            typeof record.info?.identifier === 'string' &&
            typeof record.info.title === 'string' &&
            typeof record.info.author === 'string' &&
            typeof record.info.length === 'number' &&
            typeof record.info.uri === 'string' &&
            typeof record.info.sourceName === 'string');
    }
    /**
     * Returns the source manager narrowed to the fallback methods used here.
     *
     * @returns Narrowed source manager, or `null` when unavailable.
     */
    getSourceManager() {
        const sourceManager = this.nodelink.sources;
        return sourceManager ?? null;
    }
    /**
     * Creates a standardized exception payload for Deezer operations.
     *
     * @param message Human-readable failure message.
     * @param severity Source-defined error severity.
     * @param cause Optional failure origin.
     * @returns Structured exception payload.
     */
    createException(message, severity, cause) {
        return { loadType: 'error', exception: { message, severity, cause } };
    }
    /**
     * Converts an unknown thrown value into a readable message string.
     *
     * @param error Unknown runtime failure.
     * @returns Human-readable error message.
     */
    getErrorMessage(error) {
        return error instanceof Error ? error.message : String(error);
    }
    /**
     * Converts a numeric-like seconds value into milliseconds.
     *
     * @param value Numeric-like duration expressed in seconds.
     * @returns Duration in milliseconds, or `0` when unavailable.
     */
    toMilliseconds(value) {
        const numericValue = this.toNumber(value);
        return numericValue ? numericValue * 1000 : 0;
    }
    /**
     * Converts a numeric-like value into a finite number.
     *
     * @param value Candidate numeric value.
     * @returns Finite number, or `null` when the value is invalid.
     */
    toNumber(value) {
        if (value === undefined || value === null || value === '')
            return null;
        const numericValue = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(numericValue) ? numericValue : null;
    }
    /**
     * Returns the configured Deezer search-result limit.
     *
     * @returns Maximum number of search results to return.
     */
    getMaxSearchResults() {
        const limit = this.config.search?.maxResults;
        return typeof limit === 'number' && limit > 0 ? limit : 10;
    }
    /**
     * Returns the configured collection-size limit, or the supplied fallback.
     *
     * @param fallback Default limit used when the config does not define one.
     * @returns Maximum collection length for albums, playlists, or artists.
     */
    getMaxCollectionLength(fallback) {
        const limit = this.config.playback?.maxPlaylistLength;
        return typeof limit === 'number' && limit > 0 ? limit : fallback;
    }
    /**
     * Computes the Blowfish decryption key for a Deezer song identifier.
     *
     * @param songId Deezer song identifier.
     * @returns Raw 16-byte Blowfish key.
     */
    calculateKey(songId) {
        const key = this.config.sources?.deezer?.decryptionKey;
        if (typeof key !== 'string' || key.length !== 16) {
            throw new Error('A valid 16-character Deezer decryptionKey is not provided in the configuration.');
        }
        const songIdHash = crypto
            .createHash('md5')
            .update(String(songId), 'ascii')
            .digest('hex');
        const trackKey = Buffer.alloc(16);
        for (let index = 0; index < 16; index++) {
            trackKey[index] =
                songIdHash.charCodeAt(index) ^
                    songIdHash.charCodeAt(index + 16) ^
                    key.charCodeAt(index);
        }
        return trackKey;
    }
}
