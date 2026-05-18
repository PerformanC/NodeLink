import { PassThrough } from 'node:stream';
import { desEcbDecryptBase64ToUtf8 } from "../decrypters/des-ecb.js";
import { encodeTrack, getBestMatch, http1makeRequest, logger } from "../utils.js";
const API_BASE = 'https://www.jiosaavn.com/api.php';
const J_BUFFER = Buffer.from('38346591');
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
    Accept: 'application/json'
};
const HTML_ENTITY_REGEX = /&(?:quot|amp);/g;
const ENTITY_MAP = { '&quot;': '"', '&amp;': '&' };
const IDENTIFIER_REGEX = /^[A-Za-z0-9_,-]+$/;
const DEFAULT_PLAYLIST_LIMIT = 50;
const DEFAULT_ARTIST_LIMIT = 20;
/**
 * JioSaavn source implementation.
 * @public
 */
export default class JioSaavnSource {
    /**
     * Runtime NodeLink context.
     */
    nodelink;
    /**
     * Source configuration.
     */
    config;
    /**
     * Search aliases supported by this source.
     */
    searchTerms;
    /**
     * Recommendation aliases supported by this source.
     */
    recommendationTerm;
    /**
     * URL patterns supported by this source.
     */
    patterns;
    /**
     * Source priority for URL matching.
     */
    priority;
    /**
     * Maximum playlist load size.
     */
    playlistLoadLimit;
    /**
     * Maximum artist load size.
     */
    artistLoadLimit;
    /**
     * Creates a new JioSaavn source instance.
     * @param nodelink - Runtime NodeLink context.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.config = nodelink.options.sources?.jiosaavn || {};
        this.searchTerms = ['jssearch'];
        this.recommendationTerm = ['jsrec'];
        this.patterns = [
            /https?:\/\/(?:www\.)?jiosaavn\.com\/(?:(?<type>album|featured|song|s\/playlist|artist)\/)(?:[^/]+\/)(?<id>[A-Za-z0-9_,-]+)/
        ];
        this.priority = 60;
        this.playlistLoadLimit =
            this.config.playlistLoadLimit || DEFAULT_PLAYLIST_LIMIT;
        this.artistLoadLimit = this.config.artistLoadLimit || DEFAULT_ARTIST_LIMIT;
    }
    /**
     * Initializes the provider.
     * @returns Whether this source should be enabled.
     */
    async setup() {
        if (this.config.enabled === false)
            return false;
        logger('info', 'JioSaavn', 'JioSaavn source initialized.');
        return true;
    }
    /**
     * Searches JioSaavn tracks or recommendations.
     * @param query - Query string.
     * @param sourceTerm - Source alias used by the manager.
     * @returns Search result payload.
     */
    async search(query, sourceTerm) {
        if (sourceTerm && this.recommendationTerm.includes(sourceTerm)) {
            return this.getRecommendations(query);
        }
        try {
            logger('debug', 'JioSaavn', `Searching for: ${query}`);
            const data = await this._getJson({
                __call: 'search.getResults',
                q: query,
                includeMetaTags: '1'
            });
            const payload = this.toObject(data);
            if (!Array.isArray(payload?.results) || payload.results.length === 0) {
                logger('debug', 'JioSaavn', 'Search returned no results.');
                return this.emptyResult();
            }
            const tracks = payload.results
                .map((item) => this._parseTrack(item))
                .filter((item) => item !== null);
            return tracks.length > 0
                ? { loadType: 'search', data: tracks }
                : this.emptyResult();
        }
        catch (error) {
            const message = this.getErrorMessage(error);
            logger('error', 'JioSaavn', `Search error: ${message}`);
            return this.exceptionResult(message);
        }
    }
    /**
     * Fetches JioSaavn recommendations for a track/query.
     * @param query - Track identifier or textual query.
     * @returns Playlist-style recommendation payload.
     */
    async getRecommendations(query) {
        let id = query;
        if (!IDENTIFIER_REGEX.test(query)) {
            const searchRes = await this.search(query, 'jssearch');
            if (searchRes.loadType === 'search' &&
                searchRes.data[0]?.info.identifier) {
                id = searchRes.data[0].info.identifier;
            }
            else {
                return this.emptyResult();
            }
        }
        try {
            const encodedId = encodeURIComponent(`["${id}"]`);
            let json = await this._getJson({
                __call: 'webradio.createEntityStation',
                api_version: '4',
                ctx: 'android',
                entity_id: encodedId,
                entity_type: 'queue'
            });
            const station = this.toObject(json);
            if (station?.stationid) {
                json = await this._getJson({
                    __call: 'webradio.getSong',
                    api_version: '4',
                    ctx: 'android',
                    stationid: encodeURIComponent(station.stationid),
                    k: '20'
                });
                const playlist = this.getStationPlaylist(json);
                if (playlist)
                    return playlist;
            }
            const metadata = await this._fetchSongMetadata(id);
            if (metadata?.primary_artists_id) {
                json = await this._getJson({
                    __call: 'search.artistOtherTopSongs',
                    api_version: '4',
                    ctx: 'wap6dot0',
                    artist_ids: encodeURIComponent(metadata.primary_artists_id),
                    song_id: encodeURIComponent(id),
                    language: 'unknown'
                });
                if (Array.isArray(json) && json.length > 0) {
                    const tracks = json
                        .map((item) => this._parseTrack(item))
                        .filter((item) => item !== null);
                    if (tracks.length > 0) {
                        return {
                            loadType: 'playlist',
                            data: {
                                info: { name: 'JioSaavn Recommendations', selectedTrack: 0 },
                                pluginInfo: { type: 'recommendations' },
                                tracks
                            }
                        };
                    }
                }
            }
            return this.emptyResult();
        }
        catch (error) {
            const message = this.getErrorMessage(error);
            logger('error', 'JioSaavn', `Recommendations error: ${message}`);
            return this.exceptionResult(message);
        }
    }
    /**
     * Resolves JioSaavn URLs into tracks or playlists.
     * @param url - JioSaavn URL.
     * @returns Resolve result payload.
     */
    async resolve(url) {
        const pattern = this.patterns[0];
        if (!pattern)
            return this.emptyResult();
        const match = url.match(pattern);
        if (!match)
            return this.emptyResult();
        const groups = (match.groups || {});
        const type = groups.type;
        const id = groups.id;
        if (!type || !id)
            return this.emptyResult();
        logger('debug', 'JioSaavn', `Resolving ${type} with ID: ${id}`);
        try {
            if (type === 'song') {
                const trackData = await this._fetchSongMetadata(id);
                if (!trackData) {
                    logger('error', 'JioSaavn', `All resolution methods failed for song ${id}`);
                    return this.emptyResult();
                }
                const parsedTrack = this._parseTrack(trackData);
                return parsedTrack
                    ? { loadType: 'track', data: parsedTrack }
                    : this.emptyResult();
            }
            return this._resolveList(type, id);
        }
        catch (error) {
            const message = this.getErrorMessage(error);
            logger('error', 'JioSaavn', `Resolve error: ${message}`);
            return this.exceptionResult(message);
        }
    }
    /**
     * Resolves playable URL for a JioSaavn track.
     * @param decodedTrack - Decoded track metadata.
     * @returns Stream URL payload or fallback exception.
     */
    async getTrackUrl(decodedTrack) {
        try {
            logger('debug', 'JioSaavn', `Fetching stream for: ${decodedTrack.identifier}`);
            const trackData = await this._fetchSongMetadata(decodedTrack.identifier);
            if (!trackData) {
                return this.exceptionTrackUrlResult('Track metadata not found', 'common');
            }
            if (!trackData.encrypted_media_url) {
                return this.exceptionTrackUrlResult('No encrypted_media_url found');
            }
            let playbackUrl = this._decryptUrl(trackData.encrypted_media_url);
            if (trackData['320kbps'] === 'true' || trackData['320kbps'] === true) {
                playbackUrl = playbackUrl.replace('_96.mp4', '_320.mp4');
            }
            return {
                url: playbackUrl,
                protocol: 'https',
                format: 'mp4',
                additionalData: {}
            };
        }
        catch (error) {
            logger('warn', 'JioSaavn', `Direct stream failed for ${decodedTrack.title}: ${this.getErrorMessage(error)}. Falling back to default search.`);
        }
        const searchResult = await this.nodelink.sources.searchWithDefault(`${decodedTrack.title} ${decodedTrack.author}`);
        if (searchResult.loadType !== 'search' ||
            !Array.isArray(searchResult.data)) {
            return this.exceptionTrackUrlResult('No suitable alternative found.');
        }
        const candidates = [];
        const fallbackTracks = [];
        for (const item of searchResult.data) {
            const obj = this.toObject(item);
            const info = obj?.info;
            if (this.isTrackInfo(info)) {
                candidates.push({ info });
                fallbackTracks.push(info);
            }
        }
        const bestMatch = getBestMatch(candidates, decodedTrack);
        if (!bestMatch) {
            return this.exceptionTrackUrlResult('No suitable alternative found.');
        }
        const fallbackTrack = fallbackTracks.find((track) => track.title === bestMatch.info.title &&
            track.author === bestMatch.info.author &&
            track.length === bestMatch.info.length);
        if (!fallbackTrack) {
            return this.exceptionTrackUrlResult('No suitable alternative found.');
        }
        const streamInfo = await this.nodelink.sources.getTrackUrl(fallbackTrack);
        return { newTrack: { info: fallbackTrack }, ...streamInfo };
    }
    /**
     * Loads and forwards a JioSaavn stream.
     * @param _track - Decoded track metadata.
     * @param url - Resolved media URL.
     * @returns Streaming payload or exception.
     */
    async loadStream(_track, url) {
        const { stream, error, statusCode } = await http1makeRequest(url, {
            method: 'GET',
            streamOnly: true,
            proxy: this.config.network?.proxy
        });
        if (error || statusCode !== 200 || !stream) {
            return this.exceptionLoadResult(`Failed to load stream: ${error || statusCode || 'unknown'}`);
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
            logger('error', 'JioSaavn', `Stream error: ${this.getErrorMessage(err)}`);
            if (!passthrough.destroyed) {
                passthrough.destroy(err instanceof Error ? err : new Error(String(err)));
            }
        });
        return { stream: passthrough, type: 'mp4' };
    }
    /**
     * Executes a JioSaavn API request and returns parsed JSON.
     * @param params - Endpoint query parameters.
     * @returns Parsed JSON payload.
     */
    async _getJson(params) {
        const url = new URL(API_BASE);
        url.search = new URLSearchParams({
            _format: 'json',
            _marker: '0',
            cc: 'in',
            ctx: 'web6dot0',
            ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)]))
        }).toString();
        const { body, error, statusCode } = await http1makeRequest(url.toString(), {
            method: 'GET',
            headers: HEADERS,
            proxy: this.config.network?.proxy
        });
        if (error || statusCode !== 200) {
            throw new Error(`JioSaavn API request failed: ${statusCode || 'unknown'}`);
        }
        if (typeof body === 'string') {
            try {
                return JSON.parse(body);
            }
            catch {
                throw new Error('Failed to parse JioSaavn response');
            }
        }
        return body;
    }
    /**
     * Fetches canonical song metadata from JioSaavn APIs.
     * @param id - Song identifier.
     * @returns Song payload or null when unavailable.
     */
    async _fetchSongMetadata(id) {
        let data = await this._getJson({ __call: 'song.getDetails', pids: id });
        const details = this.toObject(data);
        if (details) {
            const byId = this._parseSongPayload(details[id]);
            if (byId)
                return byId;
            const firstSong = Array.isArray(details.songs)
                ? this._parseSongPayload(details.songs[0])
                : null;
            if (firstSong)
                return firstSong;
        }
        logger('warn', 'JioSaavn', `song.getDetails failed for ${id}. Retrying with webapi.get...`);
        data = await this._getJson({
            __call: 'webapi.get',
            api_version: '4',
            token: id,
            type: 'song'
        });
        const webApiPayload = this.toObject(data);
        return Array.isArray(webApiPayload?.songs)
            ? this._parseSongPayload(webApiPayload.songs[0])
            : null;
    }
    /**
     * Resolves non-song JioSaavn URLs (album/playlist/artist).
     * @param type - JioSaavn URL type.
     * @param id - Resource identifier.
     * @returns Playlist payload.
     */
    async _resolveList(type, id) {
        const params = {
            __call: 'webapi.get',
            api_version: '4',
            token: id,
            type: type === 'featured' || type === 's/playlist' ? 'playlist' : type
        };
        if (type === 'artist')
            params.n_song = this.artistLoadLimit;
        else
            params.n = this.playlistLoadLimit;
        const data = await this._getJson(params);
        const payload = this.toObject(data);
        const list = Array.isArray(payload?.list)
            ? payload.list
            : Array.isArray(payload?.topSongs)
                ? payload.topSongs
                : [];
        if (list.length === 0)
            return this.emptyResult();
        const tracks = list
            .map((item) => this._parseTrack(item))
            .filter((item) => item !== null);
        if (tracks.length === 0)
            return this.emptyResult();
        let name = typeof payload?.title === 'string' ? payload.title : payload?.name || '';
        if (type === 'artist')
            name = `${name}'s Top Tracks`;
        const playlistData = {
            info: {
                name: this._cleanString(name),
                selectedTrack: 0
            },
            tracks
        };
        return { loadType: 'playlist', data: playlistData };
    }
    /**
     * Decrypts JioSaavn encrypted media URL payload.
     * @param encryptedUrl - Encrypted URL.
     * @returns Decrypted playable URL.
     */
    _decryptUrl(encryptedUrl) {
        return desEcbDecryptBase64ToUtf8(encryptedUrl, J_BUFFER);
    }
    /**
     * Normalizes JioSaavn strings by decoding known HTML entities.
     * @param value - Raw string value.
     * @returns Cleaned string.
     */
    _cleanString(value) {
        if (!value)
            return '';
        return value.replace(HTML_ENTITY_REGEX, (tag) => ENTITY_MAP[tag] || tag);
    }
    /**
     * Converts an unknown payload into a JioSaavn track data object.
     * @param value - Unknown track payload.
     * @returns Encoded track data or null.
     */
    _parseTrack(value) {
        const json = this._parseSongPayload(value);
        if (!json)
            return null;
        const id = json.id;
        if (typeof id !== 'string' && typeof id !== 'number')
            return null;
        const title = this._cleanString(json.title || json.song || 'Unknown');
        const uri = typeof json.perma_url === 'string' ? json.perma_url : '';
        const durationMs = Number.parseInt(String(json.more_info?.duration || json.duration || '0'), 10) * 1000;
        const primaryArtists = json.more_info?.artistMap?.primary_artists;
        const artistList = json.more_info?.artistMap?.artists;
        const metaArtist = Array.isArray(primaryArtists) && primaryArtists.length > 0
            ? primaryArtists
            : Array.isArray(artistList) && artistList.length > 0
                ? artistList
                : null;
        const author = metaArtist
            ? this._cleanString(metaArtist
                .map((artist) => typeof artist?.name === 'string' ? artist.name : null)
                .filter((name) => Boolean(name))
                .join(', '))
            : this._cleanString(json.more_info?.music ||
                json.primary_artists ||
                json.singers ||
                'Unknown Artist');
        const artworkUrl = typeof json.image === 'string' && json.image.length > 0
            ? json.image.replace('150x150', '500x500')
            : null;
        const info = {
            identifier: String(id),
            isSeekable: true,
            author,
            length: Number.isFinite(durationMs) ? durationMs : 0,
            isStream: false,
            position: 0,
            title,
            uri,
            artworkUrl,
            isrc: null,
            sourceName: 'jiosaavn'
        };
        const encodedInput = { ...info, details: [] };
        return {
            encoded: encodeTrack(encodedInput),
            info,
            pluginInfo: {}
        };
    }
    /**
     * Parses station recommendation payload into a playlist result.
     * @param value - Unknown station payload.
     * @returns Playlist result when at least one track is available.
     */
    getStationPlaylist(value) {
        const json = this.toObject(value);
        if (!json || json.error)
            return null;
        const tracks = Object.values(json)
            .map((item) => this.toObject(item))
            .map((item) => this.toObject(item?.song))
            .map((song) => this._parseTrack(song))
            .filter((item) => item !== null);
        if (tracks.length === 0)
            return null;
        return {
            loadType: 'playlist',
            data: {
                info: { name: 'JioSaavn Recommendations', selectedTrack: 0 },
                pluginInfo: { type: 'recommendations' },
                tracks
            }
        };
    }
    /**
     * Parses unknown payload into normalized song metadata.
     * @param value - Unknown API payload.
     * @returns Normalized song payload or null.
     */
    _parseSongPayload(value) {
        const json = this.toObject(value);
        if (!json)
            return null;
        const id = json.id;
        if (typeof id !== 'string' && typeof id !== 'number')
            return null;
        return json;
    }
    /**
     * Validates canonical track info payload shape.
     * @param value - Unknown value.
     * @returns True when value is a track info object.
     */
    isTrackInfo(value) {
        const info = this.toObject(value);
        return (info !== null &&
            typeof info.identifier === 'string' &&
            typeof info.title === 'string' &&
            typeof info.author === 'string' &&
            typeof info.length === 'number' &&
            typeof info.uri === 'string' &&
            typeof info.sourceName === 'string');
    }
    /**
     * Converts unknown values to object records.
     * @param value - Unknown value.
     * @returns Object record or null.
     */
    toObject(value) {
        return value && typeof value === 'object' && !Array.isArray(value)
            ? value
            : null;
    }
    /**
     * Creates a typed empty result payload.
     * @returns Empty source result.
     */
    emptyResult() {
        return { loadType: 'empty', data: {} };
    }
    /**
     * Creates a typed exception payload.
     * @param message - Error message.
     * @param severity - Error severity.
     * @returns Exception result payload.
     */
    exceptionResult(message, severity = 'fault') {
        return { loadType: 'error', exception: { message, severity } };
    }
    /**
     * Creates a typed exception payload for URL resolution.
     * @param message - Error message.
     * @param severity - Error severity.
     * @returns Track URL exception payload.
     */
    exceptionTrackUrlResult(message, severity = 'fault') {
        return { exception: { message, severity } };
    }
    /**
     * Creates a typed exception payload for stream loading.
     * @param message - Error message.
     * @param severity - Error severity.
     * @returns Stream exception payload.
     */
    exceptionLoadResult(message, severity = 'fault') {
        return { exception: { message, severity } };
    }
    /**
     * Narrows source results to search payload.
     * @param result - Source result payload.
     * @returns True when the result is a search payload.
     */
    isSearchResult(result) {
        return ('loadType' in result &&
            result.loadType === 'search' &&
            'data' in result &&
            Array.isArray(result.data));
    }
    /**
     * Normalizes unknown errors to strings.
     * @param error - Unknown error payload.
     * @returns Error message string.
     */
    getErrorMessage(error) {
        return error instanceof Error ? error.message : String(error);
    }
}
