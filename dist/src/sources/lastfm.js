import { encodeTrack, getBestMatch, http1makeRequest, logger } from "../utils.js";
const LASTFM_PATTERN = /^https?:\/\/(?:www\.)?last\.fm\/(?:[a-z]{2}\/)?music\/.+/;
const YOUTUBE_LINK_PATTERN = /header-new-playlink[^>]*href="([^"]*youtube\.com[^"]+)"/;
const YOUTUBE_URL_PATTERN = /https?:\/\/(?:www\.)?youtube\.com\/watch\?v=[a-zA-Z0-9_-]+/;
/**
 * Decodes the small subset of HTML entities used by Last.fm pages.
 *
 * @param text Raw HTML text.
 * @returns A decoded string, or the original value when empty.
 */
function decodeHtml(text) {
    if (!text)
        return text;
    return text
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}
/**
 * Last.fm source implementation.
 */
export default class LastFMSource {
    /**
     * Runtime worker context used by the source implementation.
     */
    nodelink;
    /**
     * Sanitized Last.fm-specific configuration.
     */
    config;
    /**
     * URL patterns supported by this source.
     */
    patterns;
    /**
     * Match priority used by the source manager.
     */
    priority;
    /**
     * Search aliases handled by this source.
     */
    searchTerms;
    /**
     * Maximum number of search results returned by this source.
     */
    maxSearchResults;
    /**
     * Optional Last.fm API key.
     */
    apiKey;
    /**
     * Creates a new Last.fm source wrapper.
     *
     * @param nodelink Worker runtime used by the source implementation.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.config = this.getConfig();
        this.patterns = [LASTFM_PATTERN];
        this.priority = 40;
        this.searchTerms = ['lfsearch'];
        this.maxSearchResults = this.getMaxSearchResults();
        this.apiKey = this.config.apiKey ?? null;
    }
    /**
     * Reads the Last.fm configuration from the shared runtime.
     *
     * @returns Sanitized Last.fm configuration limited to the fields used by this source.
     */
    getConfig() {
        const options = this.nodelink.options;
        const config = options.sources?.lastfm;
        return {
            apiKey: typeof config?.apiKey === 'string' && config.apiKey.length > 0
                ? config.apiKey
                : undefined
        };
    }
    /**
     * Reads the configured maximum number of search results.
     *
     * @returns A positive integer limit used by this source.
     */
    getMaxSearchResults() {
        const options = this.nodelink.options;
        const limit = options.maxSearchResults;
        return typeof limit === 'number' && Number.isInteger(limit) && limit > 0
            ? limit
            : 10;
    }
    /**
     * Announces the Last.fm source during worker initialization.
     *
     * @returns `true` when the source is ready to accept requests.
     */
    async setup() {
        logger('info', 'Sources', 'Loaded Last.fm source.');
        return true;
    }
    /**
     * Checks whether a URL belongs to a supported Last.fm page.
     *
     * @param link Candidate URL.
     * @returns `true` when the URL matches the Last.fm pattern.
     */
    isLinkMatch(link) {
        return LASTFM_PATTERN.test(link);
    }
    /**
     * Searches Last.fm either through the public HTML track search or through the
     * REST API when an API key is configured.
     *
     * @param query Search query.
     * @param _sourceTerm Search alias provided by the source manager.
     * @param searchType Search type requested by the source manager.
     * @returns Search results, an empty payload, or a structured exception.
     */
    async search(query, _sourceTerm, searchType = 'track') {
        try {
            if (!this.apiKey) {
                if (searchType !== 'track') {
                    return {
                        exception: {
                            message: 'Last.fm API key required for album/artist search. Configure sources.lastfm.apiKey.',
                            severity: 'common'
                        }
                    };
                }
                return this.searchTracksHtml(query);
            }
            return this.searchApi(query, searchType);
        }
        catch (error) {
            return {
                exception: {
                    message: error instanceof Error ? error.message : String(error),
                    severity: 'fault'
                }
            };
        }
    }
    /**
     * Resolves a Last.fm track, album, or artist page into a track or playlist by
     * delegating embedded or inferred media to other sources.
     *
     * @param url Public Last.fm URL.
     * @returns A track, playlist, empty payload, or a structured exception.
     */
    async resolve(url) {
        if (!LASTFM_PATTERN.test(url)) {
            return { loadType: 'empty', data: {} };
        }
        const path = this.parsePath(url);
        if (!path) {
            return { loadType: 'empty', data: {} };
        }
        try {
            const { body, error, statusCode } = await http1makeRequest(url, {
                method: 'GET'
            });
            const html = this.getTextBody({ body });
            if (error || statusCode !== 200 || !html) {
                logger('error', 'LastFM', `Failed to fetch Last.fm page: ${error ?? statusCode}`);
                return {
                    exception: {
                        message: `Failed to fetch Last.fm page: ${error ?? statusCode}`,
                        severity: 'fault'
                    }
                };
            }
            const artist = decodeURIComponent((path[1] ?? 'Unknown').replace(/\+/g, ' '));
            let trackTitle = 'Unknown';
            if (path[2] === '_' && path[3]) {
                trackTitle = decodeURIComponent(path[3].replace(/\+/g, ' '));
            }
            else if (path[2]) {
                trackTitle = decodeURIComponent(path[2].replace(/\+/g, ' '));
            }
            const isTrack = path.includes('_') || path.length >= 4;
            if (isTrack) {
                const officialSearch = await this.searchPreferredTracks(`${artist} - ${trackTitle} official audio`);
                const officialTrack = officialSearch[0];
                if (officialTrack) {
                    const bestTrack = this.rewrapDelegatedTrack(officialTrack, url);
                    logger('info', 'LastFM', `Found official audio track: ${bestTrack.info.title} by ${bestTrack.info.author}`);
                    return { loadType: 'track', data: bestTrack };
                }
                logger('warn', 'LastFM', 'No official audio found, attempting to search without "official audio" qualifier');
                const fallbackSearch = await this.searchPreferredTracks(`${artist} - ${trackTitle}`);
                const fallbackTrack = fallbackSearch[0];
                if (fallbackTrack) {
                    const bestTrack = this.rewrapDelegatedTrack(fallbackTrack, url);
                    logger('info', 'LastFM', `Found track via fallback: ${bestTrack.info.title} by ${bestTrack.info.author}`);
                    return { loadType: 'track', data: bestTrack };
                }
                logger('error', 'LastFM', 'No tracks found for this Last.fm track');
                return {
                    exception: {
                        message: 'No matching tracks found for this Last.fm track',
                        severity: 'fault'
                    }
                };
            }
            const youtubeUrls = this.extractYouTubeUrls(html);
            const tracks = [];
            for (const youtubeUrl of youtubeUrls) {
                const youtubeResult = await this.getSourceManager()?.resolve(youtubeUrl);
                if (!youtubeResult) {
                    continue;
                }
                const delegatedTrack = this.extractTrackDataLike(youtubeResult);
                if (!delegatedTrack) {
                    continue;
                }
                tracks.push(this.rewrapDelegatedTrack(delegatedTrack, url, youtubeUrl));
            }
            if (tracks.length > 0) {
                logger('info', 'LastFM', `Resolved playlist: ${trackTitle} - ${artist} with ${tracks.length} tracks`);
                const playlist = {
                    info: { name: `${trackTitle} - ${artist}`, selectedTrack: 0 },
                    pluginInfo: {},
                    tracks
                };
                return { loadType: 'playlist', data: playlist };
            }
            logger('error', 'LastFM', 'Failed to resolve any tracks from Last.fm album/artist');
            return {
                exception: {
                    message: 'Failed to resolve tracks from Last.fm',
                    severity: 'fault'
                }
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger('error', 'LastFM', `Exception during resolve: ${message}`);
            return { exception: { message, severity: 'fault' } };
        }
    }
    /**
     * Resolves a playable stream URL for a Last.fm track by preferring a stored
     * YouTube URL and otherwise falling back to YouTube Music or the configured
     * default search sources.
     *
     * @param decodedTrack Decoded Last.fm track information.
     * @returns Delegated track URL metadata or a structured exception.
     */
    async getTrackUrl(decodedTrack) {
        const sourceManager = this.getSourceManager();
        if (!sourceManager) {
            return {
                exception: {
                    message: 'Source manager is not available for Last.fm resolution.',
                    severity: 'fault'
                }
            };
        }
        try {
            const youtubeUrl = decodedTrack.pluginInfo?.youtubeUrl;
            if (youtubeUrl) {
                const youtubeResult = await sourceManager.resolve(youtubeUrl);
                const delegatedTrack = this.extractTrackDataLike(youtubeResult);
                if (delegatedTrack) {
                    const streamInfo = await sourceManager.getTrackUrl(delegatedTrack.info);
                    return { newTrack: delegatedTrack, ...streamInfo };
                }
            }
            const query = `${decodedTrack.title} ${decodedTrack.author}`.trim();
            let searchResult = await sourceManager.search('ytmsearch', query);
            let searchTracks = this.extractTrackArray(searchResult);
            if (searchTracks.length === 0) {
                searchResult = await sourceManager.searchWithDefault(query);
                searchTracks = this.extractTrackArray(searchResult);
            }
            if (searchTracks.length === 0) {
                return {
                    exception: {
                        message: 'No matching track found on default source.',
                        severity: 'common'
                    }
                };
            }
            const bestMatchCandidate = getBestMatch(searchTracks, decodedTrack);
            const bestMatch = bestMatchCandidate
                ? this.findTrackDataByCandidate(searchTracks, bestMatchCandidate)
                : null;
            if (!bestMatch) {
                return {
                    exception: {
                        message: 'No suitable alternative found after filtering.',
                        severity: 'common'
                    }
                };
            }
            const streamInfo = await sourceManager.getTrackUrl(bestMatch.info);
            return { newTrack: bestMatch, ...streamInfo };
        }
        catch (error) {
            return {
                exception: {
                    message: error instanceof Error ? error.message : String(error),
                    severity: 'fault'
                }
            };
        }
    }
    /**
     * Loads a stream by delegating to the source manager entry that owns the
     * resolved playback URL.
     *
     * @param track Track metadata.
     * @param url Resolved playback URL.
     * @param protocol Optional protocol hint.
     * @param additionalData Optional source-specific data.
     * @returns The delegated track stream result.
     */
    async loadStream(track, url, protocol, additionalData) {
        const sourceManager = this.getSourceManager();
        if (!sourceManager) {
            throw new Error('Source manager is not available for Last.fm streaming');
        }
        return sourceManager.getTrackStream(track, url, protocol, additionalData);
    }
    /**
     * Parses a Last.fm URL into path segments relevant for this source.
     *
     * @param url Public Last.fm URL.
     * @returns Parsed path segments or `null` when the URL shape is unsupported.
     */
    parsePath(url) {
        try {
            const urlObject = new URL(url);
            const path = urlObject.pathname.split('/').filter(Boolean);
            if (path.length > 1 && path[0]?.length === 2 && path[1] === 'music') {
                path.shift();
            }
            return path[0] === 'music' && path.length >= 2 ? path : null;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger('error', 'LastFM', `Error parsing path: ${message}`);
            return null;
        }
    }
    /**
     * Extracts all YouTube URLs embedded in a Last.fm page.
     *
     * @param html Raw Last.fm page HTML.
     * @returns Unique YouTube URLs found in the page.
     */
    extractYouTubeUrls(html) {
        const urls = new Set();
        const playMatch = html.match(YOUTUBE_LINK_PATTERN);
        if (playMatch?.[1]) {
            urls.add(playMatch[1]);
        }
        const regex = new RegExp(YOUTUBE_URL_PATTERN, 'g');
        let match;
        match = regex.exec(html);
        while (match !== null) {
            if (match[0]) {
                urls.add(match[0]);
            }
            match = regex.exec(html);
        }
        return Array.from(urls);
    }
    /**
     * Searches preferred sources for a Last.fm-derived query, starting with
     * YouTube Music.
     *
     * @param query Search query.
     * @returns Resolved track array suitable for reuse or matching.
     */
    async searchPreferredTracks(query) {
        const sourceManager = this.getSourceManager();
        if (!sourceManager) {
            return [];
        }
        const searchResult = await sourceManager.search('ytmsearch', query);
        const preferredTracks = this.extractTrackArray(searchResult);
        if (preferredTracks.length > 0) {
            return preferredTracks;
        }
        const fallbackResult = await sourceManager.searchWithDefault(query);
        return this.extractTrackArray(fallbackResult);
    }
    /**
     * Searches the Last.fm REST API.
     *
     * @param query Search query.
     * @param searchType Requested search type.
     * @returns Search results or a structured exception.
     */
    async searchApi(query, searchType) {
        const typeMap = {
            track: { method: 'track.search', param: 'track' },
            album: { method: 'album.search', param: 'album' },
            artist: { method: 'artist.search', param: 'artist' }
        };
        const selected = typeMap[searchType];
        const url = `https://ws.audioscrobbler.com/2.0/?method=${selected.method}` +
            `&${selected.param}=${encodeURIComponent(query)}` +
            `&limit=${this.maxSearchResults}&api_key=${this.apiKey}&format=json`;
        const { body, statusCode, error } = await http1makeRequest(url, {
            method: 'GET'
        });
        const payload = this.parseJsonBody(body);
        if (error || statusCode !== 200 || !payload) {
            return {
                exception: {
                    message: `Last.fm API error: ${error ?? statusCode}`,
                    severity: 'fault'
                }
            };
        }
        if (this.getValue(payload, 'error') !== undefined) {
            const message = this.getString(payload, 'message') ?? 'Last.fm API error';
            return {
                exception: {
                    message,
                    severity: 'fault'
                }
            };
        }
        const results = this.mapApiResults(payload, searchType);
        return results.length > 0
            ? { loadType: 'search', data: results }
            : { loadType: 'empty', data: {} };
    }
    /**
     * Maps a Last.fm API response into encoded track or collection entries.
     *
     * @param body Parsed Last.fm API response.
     * @param searchType Requested search type.
     * @returns Encoded track-like results.
     */
    mapApiResults(body, searchType) {
        const results = this.getRecord(body, 'results');
        if (searchType === 'album') {
            const albumMatches = results
                ? this.getRecord(results, 'albummatches')
                : null;
            const albums = albumMatches ? this.getArray(albumMatches, 'album') : [];
            return albums
                .map((item) => this.getRecordFromValue(item))
                .filter((item) => item !== null)
                .filter((item) => typeof this.getValue(item, 'name') === 'string' &&
                typeof this.getValue(item, 'artist') === 'string')
                .map((item) => this.buildCollectionResult(this.getString(item, 'name') ?? 'Unknown', this.getString(item, 'artist') ?? 'Unknown', this.getString(item, 'url') ?? '', 'album'));
        }
        if (searchType === 'artist') {
            const artistMatches = results
                ? this.getRecord(results, 'artistmatches')
                : null;
            const artists = artistMatches
                ? this.getArray(artistMatches, 'artist')
                : [];
            return artists
                .map((item) => this.getRecordFromValue(item))
                .filter((item) => item !== null)
                .filter((item) => typeof this.getValue(item, 'name') === 'string')
                .map((item) => this.buildCollectionResult(this.getString(item, 'name') ?? 'Unknown', 'Last.fm', this.getString(item, 'url') ?? '', 'artist'));
        }
        const trackMatches = results
            ? this.getRecord(results, 'trackmatches')
            : null;
        const tracks = trackMatches ? this.getArray(trackMatches, 'track') : [];
        return tracks
            .map((item) => this.getRecordFromValue(item))
            .filter((item) => item !== null)
            .filter((item) => typeof this.getValue(item, 'name') === 'string' &&
            typeof this.getValue(item, 'artist') === 'string')
            .map((item) => this.buildTrackResult(this.getString(item, 'name') ?? 'Unknown', this.getString(item, 'artist') ?? 'Unknown', this.getString(item, 'url') ?? ''));
    }
    /**
     * Searches the public Last.fm HTML track-search page when no API key is available.
     *
     * @param query Search query.
     * @returns Search results or a structured exception.
     */
    async searchTracksHtml(query) {
        const url = `https://www.last.fm/search/tracks?q=${encodeURIComponent(query)}`;
        const { body, statusCode, error } = await http1makeRequest(url, {
            method: 'GET'
        });
        const html = this.getTextBody({ body });
        if (error || statusCode !== 200 || !html) {
            return {
                exception: {
                    message: `Failed to fetch Last.fm search page: ${error ?? statusCode}`,
                    severity: 'fault'
                }
            };
        }
        const results = this.parseTrackSearchHtml(html);
        return results.length > 0
            ? { loadType: 'search', data: results.slice(0, this.maxSearchResults) }
            : { loadType: 'empty', data: {} };
    }
    /**
     * Parses the Last.fm HTML track-search page into encoded track entries.
     *
     * @param html Raw search-result HTML.
     * @returns Encoded track results.
     */
    parseTrackSearchHtml(html) {
        const results = [];
        const regex = /data-youtube-url="([^"]+)"[\s\S]*?data-track-name="([^"]+)"[\s\S]*?data-track-url="([^"]+)"[\s\S]*?data-artist-name="([^"]+)"/g;
        let match;
        match = regex.exec(html);
        while (match !== null) {
            const youtubeUrl = decodeHtml(match[1] ?? null) ?? '';
            const title = decodeHtml(match[2] ?? null) ?? 'Unknown';
            const trackUrl = decodeHtml(match[3] ?? null) ?? '';
            const artist = decodeHtml(match[4] ?? null) ?? 'Unknown';
            const fullUrl = trackUrl.startsWith('http')
                ? trackUrl
                : `https://www.last.fm${trackUrl}`;
            results.push(this.buildTrackResult(title, artist, fullUrl, {
                youtubeUrl: youtubeUrl || undefined
            }));
            match = regex.exec(html);
        }
        return results;
    }
    /**
     * Builds an encoded Last.fm track result.
     *
     * @param title Human-readable track title.
     * @param artist Human-readable artist name.
     * @param url Canonical Last.fm URL.
     * @param pluginInfo Optional track metadata.
     * @returns Encoded track payload.
     */
    buildTrackResult(title, artist, url, pluginInfo = {}) {
        const info = {
            identifier: url || `${artist} - ${title}`,
            isSeekable: true,
            author: artist,
            length: 0,
            isStream: false,
            position: 0,
            title,
            uri: url,
            artworkUrl: null,
            isrc: null,
            sourceName: 'lastfm',
            details: []
        };
        return { encoded: encodeTrack(info), info, pluginInfo };
    }
    /**
     * Builds an encoded metadata-only collection result used for album and artist
     * search matches.
     *
     * @param title Human-readable collection title.
     * @param author Human-readable author label.
     * @param url Canonical Last.fm URL.
     * @param type Collection type stored in plugin metadata.
     * @returns Encoded track payload.
     */
    buildCollectionResult(title, author, url, type) {
        const info = {
            identifier: url || title,
            isSeekable: false,
            author,
            length: 0,
            isStream: false,
            position: 0,
            title,
            uri: url,
            artworkUrl: null,
            isrc: null,
            sourceName: 'lastfm',
            details: []
        };
        return { encoded: encodeTrack(info), info, pluginInfo: { type } };
    }
    /**
     * Rewraps a delegated track as a Last.fm track, preserving useful plugin
     * metadata and re-encoding the updated payload so `encoded` matches `info`.
     *
     * @param track Delegated track payload returned by another source.
     * @param url Canonical Last.fm URL that should become the public URI.
     * @param youtubeUrl Optional YouTube URL used for direct follow-up playback.
     * @returns A re-encoded Last.fm track payload.
     */
    rewrapDelegatedTrack(track, url, youtubeUrl) {
        const pluginInfo = this.getPluginInfoRecord(track.pluginInfo);
        const storedYoutubeUrl = pluginInfo.youtubeUrl;
        const lastFmPluginInfo = {
            youtubeUrl: youtubeUrl ||
                (typeof storedYoutubeUrl === 'string'
                    ? storedYoutubeUrl
                    : track.info.uri)
        };
        const info = {
            identifier: track.info.identifier,
            isSeekable: track.info.isSeekable,
            author: track.info.author,
            length: track.info.length,
            isStream: track.info.isStream,
            position: track.info.position,
            title: track.info.title,
            uri: url,
            artworkUrl: track.info.artworkUrl ?? null,
            isrc: track.info.isrc ?? null,
            sourceName: 'lastfm',
            details: []
        };
        return {
            encoded: encodeTrack(info),
            info,
            pluginInfo: lastFmPluginInfo
        };
    }
    /**
     * Extracts a delegated track from a source-manager result, supporting direct
     * track responses and the first track inside playlists.
     *
     * @param result Delegated source result.
     * @returns A usable delegated track or `null`.
     */
    extractTrackDataLike(result) {
        const trackData = result.data;
        if (result.loadType === 'track' && this.isTrackDataLike(trackData)) {
            return trackData;
        }
        const playlistData = result.data;
        if (result.loadType === 'playlist' &&
            this.isTrackCollection(playlistData) &&
            playlistData.tracks.length > 0) {
            return playlistData.tracks[0] ?? null;
        }
        return null;
    }
    /**
     * Extracts an array of delegated tracks from a source-manager search result.
     *
     * @param result Source-manager search result.
     * @returns Delegated track array suitable for best-match selection.
     */
    extractTrackArray(result) {
        const resultData = result.data;
        if (result.loadType === 'search' &&
            Array.isArray(resultData) &&
            resultData.every((item) => this.isTrackDataLike(item))) {
            return resultData;
        }
        return [];
    }
    /**
     * Maps a scored best-match candidate back to the original delegated track
     * payload returned by the search pipeline.
     *
     * @param tracks Candidate delegated tracks.
     * @param candidate Best-match candidate selected by the scoring helper.
     * @returns The original delegated track payload or `null` when no exact match exists.
     */
    findTrackDataByCandidate(tracks, candidate) {
        return (tracks.find((track) => track.info.title === candidate.info.title &&
            track.info.author === candidate.info.author &&
            track.info.uri === candidate.info.uri) ?? null);
    }
    /**
     * Returns the source manager narrowed to the methods used by this source.
     *
     * @returns The narrowed source manager or `null` when unavailable.
     */
    getSourceManager() {
        const sourceManager = this.nodelink.sources;
        return sourceManager ?? null;
    }
    /**
     * Converts a buffered HTTP body into text.
     *
     * @param response HTTP helper response carrying the buffered body.
     * @returns A UTF-8 string when the body is text-like, otherwise `null`.
     */
    getTextBody(response) {
        if (typeof response.body === 'string') {
            return response.body;
        }
        if (Buffer.isBuffer(response.body)) {
            return response.body.toString('utf8');
        }
        return null;
    }
    /**
     * Parses a JSON-capable response body into a record.
     *
     * @param body Raw HTTP response body.
     * @returns A JSON record or `null` when the payload is not object-like.
     */
    parseJsonBody(body) {
        if (body &&
            typeof body === 'object' &&
            !Array.isArray(body) &&
            !Buffer.isBuffer(body)) {
            return body;
        }
        const textBody = this.getTextBody({ body });
        if (!textBody) {
            return null;
        }
        try {
            const parsed = JSON.parse(textBody);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? parsed
                : null;
        }
        catch {
            return null;
        }
    }
    /**
     * Reads a nested record property from a JSON record.
     *
     * @param record Source record.
     * @param key Property name to read.
     * @returns The nested record or `null` when the property is not an object.
     */
    getRecord(record, key) {
        return this.getRecordFromValue(record[key]);
    }
    /**
     * Converts a JSON value into a record when possible.
     *
     * @param value Candidate JSON value.
     * @returns The record representation or `null`.
     */
    getRecordFromValue(value) {
        return value && typeof value === 'object' && !Array.isArray(value)
            ? value
            : null;
    }
    /**
     * Reads an arbitrary property value from a JSON record.
     *
     * @param record Source record.
     * @param key Property name to read.
     * @returns The property value or `undefined` when absent.
     */
    getValue(record, key) {
        return record[key];
    }
    /**
     * Reads an array property from a JSON record.
     *
     * @param record Source record.
     * @param key Property name to read.
     * @returns The nested array or an empty array when the property is not an array.
     */
    getArray(record, key) {
        const value = this.getValue(record, key);
        return Array.isArray(value) ? value : [];
    }
    /**
     * Reads a string-like field from a JSON record.
     *
     * @param record Source record.
     * @param key Property name to read.
     * @returns The normalized string value or `null`.
     */
    getString(record, key) {
        const value = this.getValue(record, key);
        if (typeof value === 'string') {
            return value;
        }
        if (typeof value === 'number') {
            return String(value);
        }
        return null;
    }
    /**
     * Converts an arbitrary plugin metadata value into a string-compatible record.
     *
     * @param value Plugin metadata value returned by a delegated source.
     * @returns A string-compatible record with invalid entries removed.
     */
    getPluginInfoRecord(value) {
        if (!value) {
            return {};
        }
        const result = {};
        for (const [key, entry] of Object.entries(value)) {
            if (typeof entry === 'string') {
                result[key] = entry;
            }
            else if (typeof entry === 'number') {
                result[key] = String(entry);
            }
        }
        return result;
    }
    /**
     * Checks whether an arbitrary value is a valid delegated track payload.
     *
     * @param value Candidate value returned by delegated source calls.
     * @returns `true` when the value is a usable delegated track payload.
     */
    isTrackDataLike(value) {
        const record = this.getRecordFromValue(value);
        if (!record) {
            return false;
        }
        const encoded = this.getValue(record, 'encoded');
        const info = this.getRecord(record, 'info');
        const title = info ? this.getValue(info, 'title') : undefined;
        const author = info ? this.getValue(info, 'author') : undefined;
        const length = info ? this.getValue(info, 'length') : undefined;
        const uri = info ? this.getValue(info, 'uri') : undefined;
        return (typeof encoded === 'string' &&
            !!info &&
            typeof title === 'string' &&
            typeof author === 'string' &&
            typeof length === 'number' &&
            typeof uri === 'string');
    }
    /**
     * Checks whether a value exposes a valid playlist-like `tracks` array.
     *
     * @param value Candidate source result payload.
     * @returns `true` when the value contains a valid `tracks` array.
     */
    isTrackCollection(value) {
        const record = this.getRecordFromValue(value);
        if (!record) {
            return false;
        }
        const tracks = this.getValue(record, 'tracks');
        return (Array.isArray(tracks) &&
            tracks.every((track) => this.isTrackDataLike(track)));
    }
}
