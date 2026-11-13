import { encodeTrack, getBestMatch, http1makeRequest, logger } from '../utils.js';
const DEFAULT_LASTFM_API_KEY = 'b25b959554ed76058ac220b7b2e0a026';
const LASTFM_API_BASE = 'https://ws.audioscrobbler.com/2.0/';
const LASTFM_PATTERNS = [
    /^https?:\/\/(?:www\.)?last\.fm\/(?:[a-z]{2}\/)?music(?:\/.*)?$/i,
    /^https?:\/\/(?:www\.)?last\.fm\/(?:[a-z]{2}\/)?tag\/[^/?#]+/i,
    /^https?:\/\/(?:www\.)?last\.fm\/(?:[a-z]{2}\/)?user\/[^/?#]+/i,
    /^https?:\/\/(?:www\.)?last\.fm\/(?:[a-z]{2}\/)?charts(?:\/.*)?$/i
];
/**
 * Extracts the highest quality image URL from a Last.fm image array.
 */
function extractArtworkUrl(images) {
    if (!Array.isArray(images) || images.length === 0)
        return null;
    for (let i = images.length - 1; i >= 0; i--) {
        const img = images[i];
        const text = img?.['#text'] || img?.text || img?.url;
        if (typeof text === 'string' && text.length > 0) {
            return text;
        }
    }
    return null;
}
/**
 * Decodes URL path parameter, replacing '+' with space and unescaping percent encoding.
 */
function sanitizeSegment(raw) {
    try {
        return decodeURIComponent(raw.replace(/\+/g, ' ')).trim();
    }
    catch {
        return raw.replace(/\+/g, ' ').trim();
    }
}
/**
 * Last.fm source implementation.
 *
 * Resolves music metadata from Last.fm tracks, albums, artists, tags,
 * user loved tracks, and charts, delegating audio streaming to the default
 * mirror playback source.
 *
 * @public
 */
export default class LastFMSource {
    /**
     * Declarative test suite for validating Last.fm source behavior.
     */
    static _TESTS = [
        {
            id: 'lastfm.track.resolve',
            name: 'Last.fm track resolution (/music/Artist/_/Track)',
            input: {
                type: 'resolve',
                value: 'https://www.last.fm/music/Radiohead/_/Creep'
            },
            expect: {
                result: { type: 'track' },
                metadata: {
                    title: {
                        op: 'matches',
                        value: 'Creep'
                    },
                    author: {
                        op: 'matches',
                        value: 'Radiohead'
                    },
                    sourceName: {
                        op: 'equals',
                        value: 'lastfm'
                    }
                }
            }
        },
        {
            id: 'lastfm.album.resolve',
            name: 'Last.fm album resolution (/music/Artist/Album)',
            input: {
                type: 'resolve',
                value: 'https://www.last.fm/music/Radiohead/OK+Computer'
            },
            expect: {
                result: { type: 'playlist' },
                collection: { minItems: 12 }
            }
        },
        {
            id: 'lastfm.artist.resolve',
            name: 'Last.fm artist top tracks resolution (/music/Artist)',
            input: {
                type: 'resolve',
                value: 'https://www.last.fm/music/Radiohead'
            },
            expect: {
                result: { type: 'playlist' },
                collection: { minItems: 5 }
            }
        },
        {
            id: 'lastfm.tag.resolve',
            name: 'Last.fm tag top tracks resolution (/tag/Tag)',
            input: {
                type: 'resolve',
                value: 'https://www.last.fm/tag/rock'
            },
            expect: {
                result: { type: 'playlist' },
                collection: { minItems: 5 }
            }
        },
        {
            id: 'lastfm.user.loved',
            name: 'Last.fm user loved tracks resolution (/user/Username/loved)',
            input: {
                type: 'resolve',
                value: 'https://www.last.fm/user/RJ/loved'
            },
            expect: {
                result: { type: 'playlist' },
                collection: { minItems: 5 }
            }
        },
        {
            id: 'lastfm.charts.resolve',
            name: 'Last.fm global charts resolution (/charts)',
            input: {
                type: 'resolve',
                value: 'https://www.last.fm/charts'
            },
            expect: {
                result: { type: 'playlist' },
                collection: { minItems: 5 }
            }
        },
        {
            id: 'lastfm.search.query',
            name: 'Last.fm search query (lfsearch)',
            input: {
                type: 'search',
                value: 'Radiohead Creep',
                searchType: 'lfsearch'
            },
            expect: {
                result: { type: 'search' },
                collection: { minItems: 1 }
            }
        }
    ];
    nodelink;
    config;
    patterns;
    priority;
    searchTerms;
    maxSearchResults;
    apiKey;
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.config = this.getConfig();
        this.patterns = LASTFM_PATTERNS;
        this.priority = 40;
        this.searchTerms = ['lfsearch', 'lastfm'];
        this.maxSearchResults = this.getMaxSearchResults();
        this.apiKey = this.config.apiKey ?? DEFAULT_LASTFM_API_KEY;
    }
    getConfig() {
        const options = this.nodelink?.options;
        const config = options?.sources?.lastfm;
        return {
            apiKey: typeof config?.apiKey === 'string' && config.apiKey.length > 0
                ? config.apiKey
                : undefined
        };
    }
    getMaxSearchResults() {
        const options = this.nodelink?.options;
        const limit = options?.search?.maxResults ?? options?.maxSearchResults;
        return typeof limit === 'number' && Number.isInteger(limit) && limit > 0
            ? limit
            : 10;
    }
    async setup() {
        logger('info', 'Sources', 'Loaded Last.fm source.');
        return true;
    }
    isLinkMatch(link) {
        return this.patterns.some((pattern) => pattern.test(link));
    }
    /**
     * Calls the Last.fm AudioScrobbler 2.0 API.
     */
    async callApi(method, params = {}) {
        const query = new URLSearchParams({
            method,
            api_key: this.apiKey,
            format: 'json'
        });
        for (const [key, value] of Object.entries(params)) {
            query.set(key, String(value));
        }
        const url = `${LASTFM_API_BASE}?${query.toString()}`;
        const response = await http1makeRequest(url, { method: 'GET' });
        if (response.error || response.statusCode !== 200) {
            return null;
        }
        const body = response.body;
        if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
            return body;
        }
        if (typeof body === 'string') {
            try {
                return JSON.parse(body);
            }
            catch {
                return null;
            }
        }
        return null;
    }
    /**
     * Searches Last.fm catalog for tracks, albums, or artists.
     */
    async search(query, _sourceTerm, searchType = 'track') {
        try {
            const typeMap = {
                track: { method: 'track.search', param: 'track' },
                album: { method: 'album.search', param: 'album' },
                artist: { method: 'artist.search', param: 'artist' }
            };
            const selected = typeMap[searchType] || {
                method: 'track.search',
                param: 'track'
            };
            const payload = await this.callApi(selected.method, {
                [selected.param]: query,
                limit: this.maxSearchResults
            });
            if (!payload) {
                return { loadType: 'empty', data: {} };
            }
            const results = this.mapApiResults(payload, searchType);
            return results.length > 0
                ? { loadType: 'search', data: results }
                : { loadType: 'empty', data: {} };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger('error', 'LastFM', `Search failed: ${message}`);
            return { loadType: 'empty', data: {} };
        }
    }
    /**
     * Resolves a Last.fm URL into a track or playlist.
     */
    async resolve(url) {
        const parsed = this.parsePath(url);
        if (!parsed) {
            return { loadType: 'empty', data: {} };
        }
        const { segments } = parsed;
        try {
            // 1. Music routes: /music/...
            if (segments[0] === 'music') {
                // /music (discovery / overview -> global top tracks)
                if (segments.length === 1 || segments[1] === '+free-music-downloads') {
                    return this.resolveChartTracks();
                }
                const artist = sanitizeSegment(segments[1] ?? '');
                // /music/{artist}/_/{track}
                if (segments.length >= 4 && segments[2] === '_') {
                    const trackTitle = sanitizeSegment(segments[3] ?? '');
                    return this.resolveTrackPage(artist, trackTitle, url);
                }
                // /music/{artist}/{album}
                if (segments.length >= 3) {
                    const albumTitle = sanitizeSegment((segments[2] ?? '').replace(/^\+/, ''));
                    return this.resolveAlbumPage(artist, albumTitle, url);
                }
                // /music/{artist}
                return this.resolveArtistPage(artist, url);
            }
            // 2. Tag routes: /tag/{tag}
            if (segments[0] === 'tag') {
                const tag = sanitizeSegment(segments[1] ?? '');
                return this.resolveTagTracks(tag, url);
            }
            // 3. User routes: /user/{username}/...
            if (segments[0] === 'user') {
                const username = sanitizeSegment(segments[1] ?? '');
                const subRoute = segments[2]?.toLowerCase();
                if (subRoute === 'loved') {
                    return this.resolveUserLovedTracks(username, url);
                }
                return this.resolveUserTopTracks(username, url);
            }
            // 4. Charts routes: /charts
            if (segments[0] === 'charts') {
                return this.resolveChartTracks();
            }
            return { loadType: 'empty', data: {} };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger('error', 'LastFM', `Exception during resolve: ${message}`);
            return { loadType: 'error', exception: { message, severity: 'fault' } };
        }
    }
    async resolveTrackPage(artist, trackTitle, url) {
        const payload = await this.callApi('track.getInfo', {
            artist,
            track: trackTitle
        });
        const trackObj = payload?.track ?? null;
        const title = trackObj?.name || trackTitle;
        const author = trackObj?.artist?.name || artist;
        const duration = Number(trackObj?.duration) || 0;
        const artworkUrl = extractArtworkUrl(trackObj?.album?.image || trackObj?.image);
        const trackInfo = {
            identifier: url,
            isSeekable: true,
            author,
            length: duration,
            isStream: false,
            position: 0,
            title,
            uri: url,
            artworkUrl,
            isrc: null,
            sourceName: 'lastfm'
        };
        return {
            loadType: 'track',
            data: {
                encoded: encodeTrack({ ...trackInfo, details: [] }),
                info: trackInfo,
                pluginInfo: {
                    artist,
                    track: title
                }
            }
        };
    }
    async resolveAlbumPage(artist, albumTitle, url) {
        const payload = await this.callApi('album.getInfo', {
            artist,
            album: albumTitle
        });
        const albumObj = payload?.album ?? null;
        if (!albumObj) {
            return { loadType: 'empty', data: {} };
        }
        const title = albumObj.name || albumTitle;
        const author = albumObj.artist || artist;
        const artworkUrl = extractArtworkUrl(albumObj.image);
        const rawTracks = albumObj.tracks?.track || [];
        const trackList = Array.isArray(rawTracks) ? rawTracks : [rawTracks];
        const tracks = [];
        for (const raw of trackList) {
            const item = raw;
            if (!item || typeof item.name !== 'string')
                continue;
            const itemDuration = Number(item.duration) || 0;
            const trackAuthor = item.artist?.name || author;
            const itemUrl = item.url || url;
            const info = {
                identifier: itemUrl,
                isSeekable: true,
                author: trackAuthor,
                length: itemDuration > 0 ? itemDuration * 1000 : 0,
                isStream: false,
                position: 0,
                title: item.name,
                uri: itemUrl,
                artworkUrl,
                isrc: null,
                sourceName: 'lastfm'
            };
            tracks.push({
                encoded: encodeTrack({ ...info, details: [] }),
                info,
                pluginInfo: { artist: trackAuthor, track: item.name }
            });
        }
        if (tracks.length === 0) {
            return { loadType: 'empty', data: {} };
        }
        return {
            loadType: 'playlist',
            data: {
                info: {
                    name: `${title} - ${author}`,
                    selectedTrack: 0
                },
                pluginInfo: {
                    type: 'album',
                    url,
                    artworkUrl,
                    author,
                    totalTracks: tracks.length
                },
                tracks
            }
        };
    }
    async resolveArtistPage(artist, url) {
        const payload = await this.callApi('artist.getTopTracks', {
            artist,
            limit: this.maxSearchResults
        });
        const rawTracks = payload?.toptracks?.track ||
            [];
        const trackList = Array.isArray(rawTracks) ? rawTracks : [rawTracks];
        const tracks = this.buildTrackList(trackList, artist);
        if (tracks.length === 0) {
            return { loadType: 'empty', data: {} };
        }
        return {
            loadType: 'playlist',
            data: {
                info: {
                    name: `${artist}'s Top Tracks`,
                    selectedTrack: 0
                },
                pluginInfo: {
                    type: 'artist',
                    url,
                    author: artist,
                    totalTracks: tracks.length
                },
                tracks
            }
        };
    }
    async resolveTagTracks(tag, url) {
        const payload = await this.callApi('tag.getTopTracks', {
            tag,
            limit: this.maxSearchResults
        });
        const rawTracks = payload?.tracks?.track || [];
        const trackList = Array.isArray(rawTracks) ? rawTracks : [rawTracks];
        const tracks = this.buildTrackList(trackList);
        if (tracks.length === 0) {
            return { loadType: 'empty', data: {} };
        }
        return {
            loadType: 'playlist',
            data: {
                info: {
                    name: `Top Tracks for #${tag}`,
                    selectedTrack: 0
                },
                pluginInfo: {
                    type: 'tag',
                    url,
                    totalTracks: tracks.length
                },
                tracks
            }
        };
    }
    async resolveUserLovedTracks(username, url) {
        const payload = await this.callApi('user.getLovedTracks', {
            user: username,
            limit: this.maxSearchResults
        });
        const rawTracks = payload?.lovedtracks?.track ||
            [];
        const trackList = Array.isArray(rawTracks) ? rawTracks : [rawTracks];
        const tracks = this.buildTrackList(trackList);
        if (tracks.length === 0) {
            return { loadType: 'empty', data: {} };
        }
        return {
            loadType: 'playlist',
            data: {
                info: {
                    name: `${username}'s Loved Tracks`,
                    selectedTrack: 0
                },
                pluginInfo: {
                    type: 'loved',
                    url,
                    author: username,
                    totalTracks: tracks.length
                },
                tracks
            }
        };
    }
    async resolveUserTopTracks(username, url) {
        const payload = await this.callApi('user.getTopTracks', {
            user: username,
            limit: this.maxSearchResults
        });
        const rawTracks = payload?.toptracks?.track ||
            [];
        const trackList = Array.isArray(rawTracks) ? rawTracks : [rawTracks];
        const tracks = this.buildTrackList(trackList);
        if (tracks.length === 0) {
            return { loadType: 'empty', data: {} };
        }
        return {
            loadType: 'playlist',
            data: {
                info: {
                    name: `${username}'s Top Tracks`,
                    selectedTrack: 0
                },
                pluginInfo: {
                    type: 'user',
                    url,
                    author: username,
                    totalTracks: tracks.length
                },
                tracks
            }
        };
    }
    async resolveChartTracks() {
        const payload = await this.callApi('chart.getTopTracks', {
            limit: this.maxSearchResults
        });
        const rawTracks = payload?.tracks?.track || [];
        const trackList = Array.isArray(rawTracks) ? rawTracks : [rawTracks];
        const tracks = this.buildTrackList(trackList);
        if (tracks.length === 0) {
            return { loadType: 'empty', data: {} };
        }
        return {
            loadType: 'playlist',
            data: {
                info: {
                    name: 'Last.fm Global Charts',
                    selectedTrack: 0
                },
                pluginInfo: {
                    type: 'charts',
                    url: 'https://www.last.fm/charts',
                    totalTracks: tracks.length
                },
                tracks
            }
        };
    }
    buildTrackList(rawTracks, defaultAuthor = 'Unknown') {
        const tracks = [];
        for (const raw of rawTracks) {
            const item = raw;
            if (!item || typeof item.name !== 'string')
                continue;
            const artistName = (typeof item.artist === 'string'
                ? item.artist
                : item.artist?.name) ||
                defaultAuthor;
            const durationSeconds = Number(item.duration) || 0;
            const artworkUrl = extractArtworkUrl(item.image);
            const trackUrl = item.url ||
                `https://www.last.fm/music/${encodeURIComponent(artistName)}/_/${encodeURIComponent(item.name)}`;
            const info = {
                identifier: trackUrl,
                isSeekable: true,
                author: artistName,
                length: durationSeconds > 0 ? durationSeconds * 1000 : 0,
                isStream: false,
                position: 0,
                title: item.name,
                uri: trackUrl,
                artworkUrl,
                isrc: null,
                sourceName: 'lastfm'
            };
            tracks.push({
                encoded: encodeTrack({ ...info, details: [] }),
                info,
                pluginInfo: {
                    artist: artistName,
                    track: item.name
                }
            });
        }
        return tracks;
    }
    /**
     * Resolves playback stream via the default playback source mirror.
     */
    async getTrackUrl(decodedTrack, _itag, _isRecovering) {
        const sourceManager = this.nodelink?.sources;
        if (!sourceManager) {
            throw new Error('Source manager is not available for Last.fm resolution.');
        }
        const query = `${decodedTrack.title} ${decodedTrack.author}`.trim();
        const searchResult = await sourceManager.searchWithDefault(query);
        if (searchResult.loadType !== 'search' ||
            !Array.isArray(searchResult.data) ||
            searchResult.data.length === 0) {
            throw new Error(`No matching track found on default source for: ${query}`);
        }
        const candidates = searchResult.data;
        const bestMatch = getBestMatch(candidates, decodedTrack) || candidates[0];
        if (!bestMatch?.info) {
            throw new Error(`No suitable alternative found after filtering for: ${query}`);
        }
        const streamInfo = await sourceManager.getTrackUrl(bestMatch.info);
        return {
            ...streamInfo,
            newTrack: {
                info: bestMatch.info
            }
        };
    }
    /**
     * Delegates stream reading to the matched source.
     */
    async loadStream(track, url, protocol, additionalData) {
        const sourceManager = this.nodelink?.sources;
        if (!sourceManager) {
            throw new Error('Source manager is not available for Last.fm streaming');
        }
        return sourceManager.getTrackStream(track, url, protocol, additionalData);
    }
    /**
     * Executes a test variant against the Last.fm source.
     */
    async executeVariant(variant, track, streamSpec) {
        let urlData;
        try {
            urlData = await this.getTrackUrl(track);
        }
        catch (err) {
            return {
                variant: variant.id,
                resolved: false,
                error: err instanceof Error
                    ? err.message
                    : 'Failed to resolve track streaming URL'
            };
        }
        if (!urlData.url) {
            return {
                variant: variant.id,
                resolved: false,
                error: 'Failed to resolve track streaming URL'
            };
        }
        const container = 'mp4';
        const codec = 'aac';
        if (!streamSpec?.required) {
            return {
                variant: variant.id,
                resolved: true,
                track: urlData.newTrack?.info || track,
                container,
                codec
            };
        }
        let streamResult;
        try {
            streamResult = await this.loadStream(track, urlData.url, urlData.protocol, urlData.additionalData);
        }
        catch (err) {
            return {
                variant: variant.id,
                resolved: true,
                error: err instanceof Error ? err.message : 'Failed to load audio stream'
            };
        }
        if (!streamResult.stream) {
            return {
                variant: variant.id,
                resolved: true,
                error: 'Failed to load audio stream'
            };
        }
        return {
            variant: variant.id,
            resolved: true,
            track: urlData.newTrack?.info || track,
            stream: streamResult.stream,
            container,
            codec,
            httpStatus: 200
        };
    }
    parsePath(url) {
        try {
            const urlObject = new URL(url);
            const segments = urlObject.pathname.split('/').filter(Boolean);
            // Strip optional 2-char language prefix, e.g. /pt/music/...
            if (segments.length > 1 &&
                segments[0]?.length === 2 &&
                ['music', 'tag', 'user', 'charts'].includes(segments[1] ?? '')) {
                segments.shift();
            }
            return segments.length > 0 ? { segments } : null;
        }
        catch {
            return null;
        }
    }
    mapApiResults(body, searchType) {
        const results = body.results;
        if (!results)
            return [];
        if (searchType === 'album') {
            const albumMatches = results.albummatches;
            const rawAlbums = albumMatches?.album;
            const albums = Array.isArray(rawAlbums)
                ? rawAlbums
                : rawAlbums
                    ? [rawAlbums]
                    : [];
            return albums
                .filter((item) => Boolean(item) &&
                typeof item.name === 'string' &&
                typeof item.artist === 'string')
                .map((item) => {
                const artworkUrl = extractArtworkUrl(item.image);
                const info = {
                    identifier: item.url || item.name,
                    isSeekable: false,
                    author: item.artist,
                    length: 0,
                    isStream: false,
                    position: 0,
                    title: item.name,
                    uri: item.url || '',
                    artworkUrl,
                    isrc: null,
                    sourceName: 'lastfm'
                };
                return {
                    encoded: encodeTrack({ ...info, details: [] }),
                    info,
                    pluginInfo: { type: 'album' }
                };
            });
        }
        if (searchType === 'artist') {
            const artistMatches = results.artistmatches;
            const rawArtists = artistMatches?.artist;
            const artists = Array.isArray(rawArtists)
                ? rawArtists
                : rawArtists
                    ? [rawArtists]
                    : [];
            return artists
                .filter((item) => Boolean(item) && typeof item.name === 'string')
                .map((item) => {
                const artworkUrl = extractArtworkUrl(item.image);
                const info = {
                    identifier: item.url || item.name,
                    isSeekable: false,
                    author: 'Last.fm',
                    length: 0,
                    isStream: false,
                    position: 0,
                    title: item.name,
                    uri: item.url || '',
                    artworkUrl,
                    isrc: null,
                    sourceName: 'lastfm'
                };
                return {
                    encoded: encodeTrack({ ...info, details: [] }),
                    info,
                    pluginInfo: { type: 'artist' }
                };
            });
        }
        const trackMatches = results.trackmatches;
        const rawTracks = trackMatches?.track;
        const tracks = Array.isArray(rawTracks)
            ? rawTracks
            : rawTracks
                ? [rawTracks]
                : [];
        return this.buildTrackList(tracks);
    }
}
