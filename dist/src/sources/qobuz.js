import crypto from 'node:crypto';
import { encodeTrack, getBestMatch, http1makeRequest, logger } from "../utils.js";
const API_URL = 'https://www.qobuz.com/api.json/0.2';
const WEB_PLAYER_BASE_URL = 'https://play.qobuz.com';
/**
 * Qobuz source implementation.
 * @public
 */
export default class QobuzSource {
    /**
     * Runtime NodeLink context.
     */
    nodelink;
    /**
     * Runtime options.
     */
    config;
    /**
     * Search aliases.
     */
    searchTerms;
    /**
     * Recommendation aliases.
     */
    recommendationTerm;
    /**
     * Qobuz URL patterns.
     */
    patterns;
    /**
     * Source priority.
     */
    priority;
    /**
     * Qobuz app ID extracted from bundle.
     */
    appId;
    /**
     * Qobuz app secret extracted from bundle.
     */
    appSecret;
    /**
     * Optional user token.
     */
    userToken;
    /**
     * Initialization flag.
     */
    initialized;
    /**
     * Creates a Qobuz source instance.
     * @param nodelink - Runtime NodeLink context.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.config = nodelink.options;
        this.searchTerms = ['qbsearch', 'qbisrc'];
        this.recommendationTerm = ['qbrec'];
        this.patterns = [
            /https?:\/\/(?:www\.|play\.|open\.)?qobuz\.com\/(?:(?:[a-z]{2}-[a-z]{2}\/)?(track|album|playlist|artist)\/(?:.+?\/)?([a-zA-Z0-9]+)|(playlist)\/(\d+))/
        ];
        this.priority = 90;
        this.appId = null;
        this.appSecret = null;
        this.userToken = null;
        this.initialized = false;
    }
    /**
     * Initializes Qobuz credentials.
     * @returns True when initialization succeeds.
     */
    async setup() {
        const qobuzConfig = this.getQobuzConfig();
        this.userToken = this.asString(qobuzConfig.userToken);
        const credentialManager = this.nodelink.credentialManager;
        const cachedAppId = credentialManager?.get('qobuz_app_id') || null;
        const cachedAppSecret = credentialManager?.get('qobuz_app_secret') || null;
        const cachedToken = credentialManager?.get('qobuz_user_token') || null;
        if (cachedAppId && cachedAppSecret && cachedToken === this.userToken) {
            this.appId = cachedAppId;
            this.appSecret = cachedAppSecret;
            this.initialized = true;
            logger('info', 'Qobuz', `Loaded credentials from cache (UserToken: ${Boolean(this.userToken)})`);
            return true;
        }
        try {
            const bundleJsContent = await this.fetchBundleJs();
            if (!bundleJsContent) {
                logger('error', 'Qobuz', 'Failed to fetch bundle.js content.');
                return false;
            }
            this.appId = this.extractAppId(bundleJsContent);
            this.appSecret = this.extractAppSecret(bundleJsContent);
            if (!this.appId || !this.appSecret) {
                logger('error', 'Qobuz', 'Failed to extract appId or appSecret.');
                return false;
            }
            credentialManager?.set('qobuz_app_id', this.appId, 24 * 60 * 60 * 1000);
            credentialManager?.set('qobuz_app_secret', this.appSecret, 24 * 60 * 60 * 1000);
            credentialManager?.set('qobuz_user_token', this.userToken, 24 * 60 * 60 * 1000);
            this.initialized = true;
            logger('info', 'Qobuz', `Initialized with appId: ${this.appId} (UserToken: ${Boolean(this.userToken)})`);
            return true;
        }
        catch (error) {
            logger('error', 'Qobuz', `Failed to initialize: ${this.getErrorMessage(error)}`);
            return false;
        }
    }
    /**
     * Searches Qobuz tracks.
     * @param query - Search query.
     * @param sourceTerm - Source alias term.
     * @returns Search result payload.
     */
    async search(query, sourceTerm) {
        if (sourceTerm && this.recommendationTerm.includes(sourceTerm)) {
            return this.getRecommendations(query);
        }
        const data = await this.apiRequest('/catalog/search', {
            query,
            limit: this.getMaxSearchResults(),
            type: 'tracks'
        });
        const tracksBlock = this.asRecord(data?.tracks);
        const items = this.asArrayRecords(tracksBlock?.items);
        if (items.length === 0)
            return { loadType: 'empty', data: {} };
        const tracks = items.map((item) => this.buildTrack(item));
        return { loadType: 'search', data: tracks };
    }
    /**
     * Fetches track-based recommendations.
     * @param id - Track ID.
     * @returns Playlist payload or empty/exception.
     */
    async getRecommendations(id) {
        try {
            const trackData = await this.apiRequest('/track/get', { track_id: id });
            if (!trackData)
                return { loadType: 'empty', data: {} };
            const performer = this.asRecord(trackData.performer);
            const artistId = this.asNumber(performer?.id);
            if (!artistId)
                return { loadType: 'empty', data: {} };
            const payload = {
                limit: 20,
                listened_tracks_ids: [Number(id)],
                track_to_analyse: [
                    {
                        track_id: Number(id),
                        artist_id: Number(artistId)
                    }
                ]
            };
            const data = await this.apiRequest('/dynamic/suggest', {}, {
                method: 'POST',
                body: payload,
                disableBodyCompression: true
            });
            const tracksBlock = this.asRecord(data?.tracks);
            const items = this.asArrayRecords(tracksBlock?.items);
            if (items.length === 0) {
                return { loadType: 'empty', data: {} };
            }
            const tracks = items.map((item) => this.buildTrack(item));
            return {
                loadType: 'playlist',
                data: {
                    info: { name: 'Qobuz Recommendations', selectedTrack: 0 },
                    pluginInfo: { type: 'recommendations' },
                    tracks
                }
            };
        }
        catch (error) {
            const message = this.getErrorMessage(error);
            logger('error', 'Qobuz', `Error fetching recommendations: ${message}`);
            return { loadType: 'error', exception: { message, severity: 'fault' } };
        }
    }
    /**
     * Resolves Qobuz links.
     * @param url - Qobuz URL.
     * @returns Source result.
     */
    async resolve(url) {
        const pattern = this.patterns[0];
        if (!pattern)
            return { loadType: 'empty', data: {} };
        const match = url.match(pattern);
        if (!match)
            return { loadType: 'empty', data: {} };
        let [, type, id] = match;
        if (!type) {
            type = match[3];
            id = match[4];
        }
        if (!type || !id)
            return { loadType: 'empty', data: {} };
        switch (type) {
            case 'track':
                return this.resolveTrack(id);
            case 'album':
                return this.resolveAlbum(id);
            case 'playlist':
                return this.resolvePlaylist(id);
            case 'artist':
                return this.resolveArtist(id);
            default:
                return { loadType: 'empty', data: {} };
        }
    }
    /**
     * Resolves track by ID.
     * @param id - Track ID.
     * @returns Source result.
     */
    async resolveTrack(id) {
        let data = await this.apiRequest('/track/get', { track_id: id });
        if (!data) {
            const search = await this.apiRequest('/catalog/search', {
                query: id,
                type: 'tracks',
                limit: 1
            });
            const tracksBlock = this.asRecord(search?.tracks);
            const items = this.asArrayRecords(tracksBlock?.items);
            data = items.find((item) => String(item.id) === String(id)) || null;
        }
        if (!data)
            return { loadType: 'empty', data: {} };
        return { loadType: 'track', data: this.buildTrack(data) };
    }
    /**
     * Resolves album by ID.
     * @param id - Album ID.
     * @returns Source result.
     */
    async resolveAlbum(id) {
        const max = this.getMaxAlbumPlaylistLength();
        let data = await this.apiRequest('/album/get', {
            album_id: id,
            limit: Math.min(max, 50)
        });
        if (!data) {
            const search = await this.apiRequest('/catalog/search', {
                query: id,
                type: 'albums',
                limit: 1
            });
            const albumsBlock = this.asRecord(search?.albums);
            const albums = this.asArrayRecords(albumsBlock?.items);
            const album = albums.find((item) => {
                const qobuzId = this.asNumber(item.qobuz_id);
                return String(item.id) === String(id) || qobuzId === Number(id);
            });
            if (album) {
                data = await this.apiRequest('/album/get', {
                    album_id: String(album.id),
                    limit: Math.min(max, 50)
                });
            }
        }
        const tracksBlock = this.asRecord(data?.tracks);
        if (!data || !tracksBlock)
            return { loadType: 'empty', data: {} };
        const allItems = await this.fetchRemainingTracks('/album/get', { album_id: String(data.id) }, tracksBlock, max);
        const tracks = allItems.map((item) => {
            item.album = {
                title: data.title,
                image: data.image,
                id: data.id
            };
            return this.buildTrack(item);
        });
        return {
            loadType: 'playlist',
            data: {
                info: {
                    name: this.asString(data.title) || 'Unknown Album',
                    selectedTrack: 0
                },
                tracks,
                pluginInfo: {}
            }
        };
    }
    /**
     * Resolves playlist by ID.
     * @param id - Playlist ID.
     * @returns Source result.
     */
    async resolvePlaylist(id) {
        const max = this.getMaxAlbumPlaylistLength();
        const data = await this.apiRequest('/playlist/get', {
            playlist_id: id,
            extra: 'tracks',
            limit: Math.min(max, 50)
        });
        const tracksBlock = this.asRecord(data?.tracks);
        if (!data || !tracksBlock)
            return { loadType: 'empty', data: {} };
        const allItems = await this.fetchRemainingTracks('/playlist/get', { playlist_id: id, extra: 'tracks' }, tracksBlock, max);
        const tracks = allItems.map((item) => this.buildTrack(item));
        return {
            loadType: 'playlist',
            data: {
                info: {
                    name: this.asString(data.name) || 'Unknown Playlist',
                    selectedTrack: 0
                },
                tracks,
                pluginInfo: {}
            }
        };
    }
    /**
     * Resolves artist by ID.
     * @param id - Artist ID.
     * @returns Source result.
     */
    async resolveArtist(id) {
        const max = this.getMaxAlbumPlaylistLength();
        const data = await this.apiRequest('/artist/get', {
            artist_id: id,
            extra: 'tracks',
            limit: Math.min(max, 50)
        });
        const tracksBlock = this.asRecord(data?.tracks);
        if (!data || !tracksBlock)
            return { loadType: 'empty', data: {} };
        const allItems = await this.fetchRemainingTracks('/artist/get', { artist_id: id, extra: 'tracks' }, tracksBlock, max);
        const tracks = allItems.map((item) => this.buildTrack(item));
        const artistName = this.asString(data.name) || 'Unknown Artist';
        return {
            loadType: 'playlist',
            data: {
                info: { name: `${artistName}'s Top Tracks`, selectedTrack: 0 },
                tracks,
                pluginInfo: {}
            }
        };
    }
    /**
     * Resolves direct or mirrored stream URL.
     * @param decodedTrack - Decoded track metadata.
     * @returns Track URL payload or exception payload.
     */
    async getTrackUrl(decodedTrack) {
        const qobuzConfig = this.getQobuzConfig();
        const formatId = this.asString(qobuzConfig.formatId) || '5';
        if (this.userToken && this.appSecret) {
            try {
                const unixTs = Math.floor(Date.now() / 1000);
                const sigData = `trackgetFileUrlformat_id${formatId}intentstreamtrack_id${decodedTrack.identifier}${unixTs}${this.appSecret}`;
                const requestSig = crypto
                    .createHash('md5')
                    .update(sigData)
                    .digest('hex');
                const data = await this.apiRequest('/track/getFileUrl', {
                    request_ts: unixTs,
                    request_sig: requestSig,
                    track_id: decodedTrack.identifier,
                    format_id: formatId,
                    intent: 'stream'
                });
                const directUrl = this.asString(data?.url);
                const sampleFlag = data?.sample;
                const isSample = sampleFlag === true || sampleFlag === 'true';
                if (directUrl && !isSample) {
                    return { url: directUrl, protocol: 'https' };
                }
                logger('debug', 'Qobuz', `Direct stream not available (sample: ${String(sampleFlag)}), falling back to mirror.`);
            }
            catch (error) {
                logger('error', 'Qobuz', `Direct stream request failed: ${this.getErrorMessage(error)}`);
            }
        }
        return this.getMirrorUrl(decodedTrack);
    }
    /**
     * Builds mirror search query.
     * @param track - Track metadata.
     * @param isExplicit - Explicit flag.
     * @returns Query string.
     */
    _buildMirrorQuery(track, isExplicit) {
        let query = `${track.title} ${track.author}`;
        if (isExplicit && !this.getAllowExplicit()) {
            query += ' clean version';
        }
        return query;
    }
    /**
     * Fetches remaining paginated tracks.
     * @param path - API path.
     * @param params - Base params.
     * @param initialTracks - Initial tracks payload.
     * @param max - Max tracks.
     * @returns Track object list.
     */
    async fetchRemainingTracks(path, params, initialTracks, max) {
        const items = this.asArrayRecords(initialTracks.items);
        const initialTotal = this.asNumber(initialTracks.total) ?? items.length;
        const total = Math.min(initialTotal, max);
        let offset = items.length;
        while (items.length < total) {
            const limit = Math.min(50, total - items.length);
            const data = await this.apiRequest(path, { ...params, limit, offset });
            const tracksBlock = this.asRecord(data?.tracks);
            const batchItems = this.asArrayRecords(tracksBlock?.items);
            if (batchItems.length === 0)
                break;
            items.push(...batchItems);
            offset += batchItems.length;
            if (batchItems.length < limit)
                break;
        }
        return items.slice(0, max);
    }
    /**
     * Executes Qobuz API request.
     * @param path - API path.
     * @param params - Query params.
     * @param options - Request options.
     * @returns Parsed object payload or null.
     */
    async apiRequest(path, params = {}, options = {}) {
        const url = new URL(`${API_URL}${path}`);
        for (const [key, value] of Object.entries(params)) {
            url.searchParams.append(key, String(value));
        }
        try {
            const { body, statusCode } = await http1makeRequest(url.toString(), {
                method: this.asString(options.method) || 'GET',
                headers: {
                    'x-app-id': this.appId || '',
                    'x-user-auth-token': this.userToken || '',
                    ...(this.asRecord(options.headers) || {})
                },
                body: this.asRequestBody(options.body),
                disableBodyCompression: this.asBoolean(options.disableBodyCompression) ?? false
            });
            if (statusCode !== 200) {
                logger('debug', 'Qobuz', `API Error (${statusCode}) on ${path}: ${JSON.stringify(body)}`);
                return null;
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
        catch (error) {
            logger('error', 'Qobuz', `Request failed on ${path}: ${this.getErrorMessage(error)}`);
            return null;
        }
    }
    /**
     * Fetches Qobuz bundle JavaScript.
     * @returns Bundle content or null.
     */
    async fetchBundleJs() {
        try {
            const { body } = await http1makeRequest(`${WEB_PLAYER_BASE_URL}/login`);
            const pageHtml = this.asString(body);
            if (!pageHtml)
                return null;
            const bundleMatch = pageHtml.match(/<script src="(\/resources\/\d+\.\d+\.\d+-[a-z]\d{3}\/bundle\.js)"/);
            if (!bundleMatch?.[1])
                return null;
            const { body: bundleJs } = await http1makeRequest(`${WEB_PLAYER_BASE_URL}${bundleMatch[1]}`);
            return this.asString(bundleJs);
        }
        catch (error) {
            logger('error', 'Qobuz', `Error fetching bundle.js: ${this.getErrorMessage(error)}`);
            return null;
        }
    }
    /**
     * Extracts Qobuz app ID from bundle source.
     * @param content - Bundle content.
     * @returns App ID or null.
     */
    extractAppId(content) {
        const match = content.match(/production:\{api:\{appId:"(.*?)"/);
        return match?.[1] ?? null;
    }
    /**
     * Extracts Qobuz app secret from bundle source.
     * @param content - Bundle content.
     * @returns App secret or null.
     */
    extractAppSecret(content) {
        const seedMatch = content.match(/\):[a-z]\.initialSeed\("(.*?)",window\.utimezone\.(.*?)\)/);
        if (!seedMatch?.[1] || !seedMatch?.[2])
            return null;
        const seed = seedMatch[1];
        const timezone = seedMatch[2].charAt(0).toUpperCase() + seedMatch[2].slice(1).toLowerCase();
        const infoExtrasRegex = new RegExp(`timezones:\\[.*?name:.*?/${timezone}",info:"(?<info>.*?)",extras:"(?<extras>.*?)"`);
        const infoExtrasMatch = content.match(infoExtrasRegex);
        const groups = infoExtrasMatch?.groups;
        if (!groups) {
            return null;
        }
        const info = groups.info;
        const extras = groups.extras;
        if (typeof info !== 'string' || typeof extras !== 'string') {
            return null;
        }
        const encoded = (seed + info + extras).slice(0, -44);
        return Buffer.from(encoded, 'base64').toString();
    }
    /**
     * Builds encoded track payload.
     * @param item - Qobuz track object.
     * @returns Encoded track payload.
     */
    buildTrack(item) {
        const artist = this.asRecord(item.artist);
        const performer = this.asRecord(item.performer);
        const album = this.asRecord(item.album);
        const albumImage = this.asRecord(album?.image);
        const trackInfo = {
            identifier: String(item.id),
            isSeekable: true,
            author: this.asString(artist?.name) ||
                this.asString(performer?.name) ||
                'Unknown Artist',
            length: (this.asNumber(item.duration) ?? 0) * 1000,
            isStream: false,
            position: 0,
            title: this.asString(item.title) || 'Unknown Title',
            uri: `https://open.qobuz.com/track/${item.id}`,
            artworkUrl: this.asString(albumImage?.large) ||
                this.asString(albumImage?.small) ||
                null,
            isrc: this.asString(item.isrc) || null,
            sourceName: 'qobuz'
        };
        const encodedInput = { ...trackInfo, details: [] };
        return {
            encoded: encodeTrack(encodedInput),
            info: trackInfo,
            pluginInfo: {}
        };
    }
    /**
     * Resolves fallback mirror stream.
     * @param decodedTrack - Decoded track metadata.
     * @returns Track URL payload or exception.
     */
    async getMirrorUrl(decodedTrack) {
        const query = `${decodedTrack.title} ${decodedTrack.author}`;
        try {
            let result = await this.nodelink.sources.searchWithDefault(decodedTrack.isrc ? `"${decodedTrack.isrc}"` : query);
            if (result.loadType !== 'search' ||
                !Array.isArray(result.data) ||
                result.data.length === 0) {
                result = await this.nodelink.sources.searchWithDefault(query);
            }
            if (result.loadType !== 'search' ||
                !Array.isArray(result.data) ||
                result.data.length === 0) {
                return {
                    exception: {
                        message: 'No mirror found for this track.',
                        severity: 'common'
                    }
                };
            }
            const tracks = this.toTrackInfoArray(result.data);
            if (tracks.length === 0) {
                return {
                    exception: {
                        message: 'No mirror found for this track.',
                        severity: 'common'
                    }
                };
            }
            const candidates = tracks.map((track) => ({
                info: track
            }));
            const best = getBestMatch(candidates, decodedTrack, {
                allowExplicit: this.getAllowExplicit()
            });
            if (!best) {
                return {
                    exception: { message: 'No suitable match found.', severity: 'common' }
                };
            }
            const fallbackTrack = tracks.find((track) => track.title === best.info.title &&
                track.author === best.info.author &&
                track.length === best.info.length);
            if (!fallbackTrack) {
                return {
                    exception: { message: 'No suitable match found.', severity: 'common' }
                };
            }
            const stream = await this.nodelink.sources.getTrackUrl(fallbackTrack);
            return { newTrack: { info: fallbackTrack }, ...stream };
        }
        catch (error) {
            const message = this.getErrorMessage(error);
            logger('error', 'Qobuz', `Mirroring failed: ${message}`);
            return { exception: { message, severity: 'fault' } };
        }
    }
    /**
     * Reads qobuz config block.
     * @returns Qobuz config object.
     */
    getQobuzConfig() {
        const sourceConfig = this.config.sources?.qobuz;
        return this.asRecord(sourceConfig) || {};
    }
    /**
     * Reads allowExplicit from qobuz config.
     * @returns True when explicit content is allowed.
     */
    getAllowExplicit() {
        return this.asBoolean(this.getQobuzConfig().allowExplicit) ?? true;
    }
    /**
     * Reads max search results from runtime config.
     * @returns Max search size.
     */
    getMaxSearchResults() {
        return this.asNumber(this.config.maxSearchResults) ?? 10;
    }
    /**
     * Reads max playlist/album load size from runtime config.
     * @returns Max playlist size.
     */
    getMaxAlbumPlaylistLength() {
        return this.asNumber(this.config.maxAlbumPlaylistLength) ?? 100;
    }
    /**
     * Converts unknown search results into TrackInfo list.
     * @param data - Unknown search data.
     * @returns TrackInfo list.
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
     * Casts unknown request body to accepted HTTP payload type.
     * @param value - Unknown value.
     * @returns Request body or undefined.
     */
    asRequestBody(value) {
        if (typeof value === 'string')
            return value;
        if (Buffer.isBuffer(value))
            return value;
        if (value instanceof Uint8Array)
            return value;
        if (this.asRecord(value))
            return value;
        return undefined;
    }
    /**
     * Normalizes unknown errors to strings.
     * @param error - Unknown error.
     * @returns Error message.
     */
    getErrorMessage(error) {
        return error instanceof Error ? error.message : String(error);
    }
}
