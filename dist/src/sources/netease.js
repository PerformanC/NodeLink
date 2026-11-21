import { PassThrough } from 'node:stream';
import { encodeTrack, getBestMatch, http1makeRequest, logger } from '../utils.js';
const NETEASE_TRACK_PATTERN = /^https?:\/\/(?:(?:www|y)\.)?music\.163\.com\/(?:m\/)?(?:#\/)?song(?:\/|.*?[?&]id=)(\d+)/i;
const NETEASE_ALBUM_PATTERN = /^https?:\/\/(?:(?:www|y)\.)?music\.163\.com\/(?:m\/)?(?:#\/)?album(?:\/|.*?[?&]id=)(\d+)/i;
const NETEASE_PLAYLIST_PATTERN = /^https?:\/\/(?:(?:www|y)\.)?music\.163\.com\/(?:m\/)?(?:#\/)?playlist(?:\/|.*?[?&]id=)(\d+)/i;
const NETEASE_ARTIST_PATTERN = /^https?:\/\/(?:(?:www|y)\.)?music\.163\.com\/(?:m\/)?(?:#\/)?artist(?:\/|.*?[?&]id=)(\d+)/i;
const STREAM_URL = 'http://music.163.com/song/media/outer/url?id=';
const ANDROID_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    Referer: 'http://music.163.com',
    'Content-Type': 'application/x-www-form-urlencoded',
    Cookie: 'appver=2.0.2; os=pc;'
};
const GET_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Referer: 'http://music.163.com',
    Accept: 'application/json, text/plain, */*',
    'Accept-Encoding': 'identity'
};
/**
 * Netease Cloud Music source implementation.
 * @public
 */
export default class NeteaseSource {
    /**
     * Declarative test suite for validating Netease source behavior.
     * @public
     */
    static _TESTS = [
        {
            id: 'netease.track.stream',
            name: 'Netease native audio streaming',
            input: {
                type: 'resolve',
                value: 'https://music.163.com/#/song?id=1430583016'
            },
            matrix: {
                variants: [{ id: 'Standard' }]
            },
            expect: {
                result: {
                    type: 'track'
                },
                metadata: {
                    title: { op: 'matches', value: '海底' },
                    author: { op: 'matches', value: '一支榴莲' },
                    sourceName: { op: 'equals', value: 'netease' }
                },
                stream: {
                    required: true,
                    download: 'complete',
                    minBytes: 100000,
                    validFormats: [{ container: 'mp3', codec: 'mp3' }],
                    decodeToEnd: true
                }
            },
            forbid: {
                resultTypes: ['empty', 'error']
            }
        },
        {
            id: 'netease.track.nohash',
            name: 'Netease track resolution without hash fragment',
            input: {
                type: 'resolve',
                value: 'https://music.163.com/song?id=1430583016'
            },
            expect: {
                result: {
                    type: 'track'
                },
                metadata: {
                    title: { op: 'matches', value: '海底' },
                    sourceName: { op: 'equals', value: 'netease' }
                }
            },
            forbid: {
                resultTypes: ['empty', 'error']
            }
        },
        {
            id: 'netease.track.mobile',
            name: 'Netease mobile track link resolution',
            input: {
                type: 'resolve',
                value: 'https://y.music.163.com/m/song?id=1430583016'
            },
            expect: {
                result: {
                    type: 'track'
                },
                metadata: {
                    title: { op: 'matches', value: '海底' },
                    sourceName: { op: 'equals', value: 'netease' }
                }
            },
            forbid: {
                resultTypes: ['empty', 'error']
            }
        },
        {
            id: 'netease.playlist.resolve',
            name: 'Netease playlist resolution',
            input: {
                type: 'resolve',
                value: 'https://music.163.com/#/playlist?id=2340621859'
            },
            expect: {
                result: {
                    type: 'playlist'
                },
                collection: {
                    minItems: 5
                }
            },
            forbid: {
                resultTypes: ['empty', 'error']
            }
        },
        {
            id: 'netease.album.resolve',
            name: 'Netease album resolution',
            input: {
                type: 'resolve',
                value: 'https://music.163.com/#/album?id=86447217'
            },
            expect: {
                result: {
                    type: 'playlist'
                },
                collection: {
                    minItems: 1
                }
            },
            forbid: {
                resultTypes: ['empty', 'error']
            }
        },
        {
            id: 'netease.artist.resolve',
            name: 'Netease artist top tracks resolution',
            input: {
                type: 'resolve',
                value: 'https://music.163.com/#/artist?id=33694141'
            },
            expect: {
                result: {
                    type: 'playlist'
                },
                collection: {
                    minItems: 1
                }
            },
            forbid: {
                resultTypes: ['empty', 'error']
            }
        },
        {
            id: 'netease.search',
            name: 'Netease track search',
            input: {
                type: 'search',
                value: '海底 一支榴莲',
                searchType: 'ntsearch'
            },
            expect: {
                result: {
                    type: 'search'
                },
                collection: {
                    minItems: 1
                }
            },
            forbid: {
                resultTypes: ['empty', 'error']
            }
        }
    ];
    /**
     * Runtime NodeLink context.
     */
    nodelink;
    /**
     * Source configuration.
     */
    config;
    /**
     * URL patterns accepted by this source.
     */
    patterns;
    /**
     * URL resolution priority.
     */
    priority;
    /**
     * Search aliases handled by this source.
     */
    searchTerms;
    /**
     * Max search results used by Netease API.
     */
    maxSearchResults;
    /**
     * Creates a new Netease source.
     * @param nodelink - Runtime NodeLink context.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.config = nodelink.options.sources?.netease || {};
        this.patterns = [
            NETEASE_TRACK_PATTERN,
            NETEASE_ALBUM_PATTERN,
            NETEASE_PLAYLIST_PATTERN,
            NETEASE_ARTIST_PATTERN
        ];
        this.priority = 45;
        this.searchTerms = ['ntsearch'];
        this.maxSearchResults = nodelink.options.search.maxResults || 10;
    }
    /**
     * Initializes Netease source.
     * @returns Always true.
     */
    async setup() {
        logger('info', 'Sources', 'Loaded Netease Cloud Music source.');
        return true;
    }
    /**
     * Returns whether a URL matches supported Netease patterns.
     * @param link - URL candidate.
     * @returns True when URL belongs to Netease.
     */
    isLinkMatch(link) {
        return (NETEASE_TRACK_PATTERN.test(link) ||
            NETEASE_ALBUM_PATTERN.test(link) ||
            NETEASE_PLAYLIST_PATTERN.test(link) ||
            NETEASE_ARTIST_PATTERN.test(link));
    }
    /**
     * Searches tracks/albums/artists/playlists on Netease.
     * @param query - Search query.
     * @param _sourceTerm - Search alias from manager.
     * @param searchType - Search category.
     * @returns Search result payload.
     */
    async search(query, _sourceTerm, searchType = 'track') {
        try {
            const typeMap = {
                track: 1,
                album: 10,
                artist: 100,
                playlist: 1000
            };
            const effectiveType = searchType in typeMap ? searchType : 'track';
            const type = typeMap[effectiveType];
            const postBody = `s=${encodeURIComponent(query)}&limit=${this.maxSearchResults}&type=${type}&offset=0`;
            const { body, statusCode, error } = await http1makeRequest('https://music.163.com/api/search/get/', {
                method: 'POST',
                body: postBody,
                disableBodyCompression: true,
                headers: {
                    ...ANDROID_HEADERS,
                    'Content-Length': String(Buffer.byteLength(postBody))
                }
            });
            const parsedBody = this.parseBody(body);
            if (error || statusCode !== 200 || !parsedBody) {
                return this.exceptionResult(`Netease search failed: ${statusCode || 'unknown'}`);
            }
            let results = this._mapSearchResults(parsedBody, effectiveType);
            if (searchType === 'track' && results.length > 0) {
                const ids = results.map((item) => item.info.identifier).filter(Boolean);
                const detailMap = await this._batchFetchDetails(ids);
                results = results.map((item) => {
                    const detail = detailMap[item.info.identifier];
                    const artworkUrl = this.toSong(detail)?.album?.picUrl || item.info.artworkUrl || null;
                    if (artworkUrl !== item.info.artworkUrl) {
                        item.info.artworkUrl = artworkUrl;
                        const encodedInput = { ...item.info, details: [] };
                        item.encoded = encodeTrack(encodedInput);
                    }
                    return item;
                });
            }
            return results.length > 0
                ? { loadType: 'search', data: results }
                : this.emptyResult();
        }
        catch (error) {
            return this.exceptionResult(this.getErrorMessage(error));
        }
    }
    /**
     * Fetches detail metadata for a list of track IDs.
     * @param ids - Netease track identifiers.
     * @returns Map keyed by song ID.
     */
    async _batchFetchDetails(ids) {
        if (!ids.length)
            return {};
        try {
            const idsParam = `[${ids.join(',')}]`;
            const { body, statusCode, error } = await http1makeRequest(`https://music.163.com/api/song/detail/?id=${ids[0]}&ids=${idsParam}`, { method: 'GET', headers: GET_HEADERS });
            if (error || statusCode !== 200 || !body)
                return {};
            const parsed = this.parseBody(body);
            if (!parsed || !Array.isArray(parsed.songs))
                return {};
            return Object.fromEntries(parsed.songs
                .map((song) => this.toSong(song))
                .filter((song) => song !== null && song.id !== undefined)
                .map((song) => [String(song.id), song]));
        }
        catch {
            return {};
        }
    }
    /**
     * Resolves a Netease URL.
     * @param url - Netease URL.
     * @returns Track/playlist result.
     */
    async resolve(url) {
        try {
            const trackMatch = url.match(NETEASE_TRACK_PATTERN);
            if (trackMatch?.[1])
                return await this._resolveTrack(trackMatch[1], url);
            const albumMatch = url.match(NETEASE_ALBUM_PATTERN);
            if (albumMatch?.[1])
                return await this._resolveAlbum(albumMatch[1], url);
            const playlistMatch = url.match(NETEASE_PLAYLIST_PATTERN);
            if (playlistMatch?.[1])
                return await this._resolvePlaylist(playlistMatch[1], url);
            const artistMatch = url.match(NETEASE_ARTIST_PATTERN);
            if (artistMatch?.[1])
                return await this._resolveArtist(artistMatch[1], url);
            return this.emptyResult();
        }
        catch (error) {
            const message = this.getErrorMessage(error);
            logger('error', 'Netease', `Exception during resolve: ${message}`);
            return this.exceptionResult(message);
        }
    }
    /**
     * Resolves a single Netease track URL.
     * @param id - Song ID.
     * @param originalUrl - Original URL.
     * @returns Track result payload.
     */
    async _resolveTrack(id, originalUrl) {
        const { body, statusCode, error } = await http1makeRequest(`https://music.163.com/api/song/detail/?id=${id}&ids=[${id}]`, { method: 'GET', headers: GET_HEADERS });
        const parsed = this.parseBody(body);
        if (error || statusCode !== 200 || !parsed) {
            return this.exceptionResult(`Failed to fetch Netease track: ${error || statusCode || 'unknown'}`);
        }
        const songs = Array.isArray(parsed.songs) ? parsed.songs : [];
        const song = this.toSong(songs[0]);
        if (!song)
            return this.emptyResult();
        const track = this._buildTrackResult(song, originalUrl);
        logger('info', 'Netease', `Resolved track: ${song.name} by ${this._getArtists(song)}`);
        return { loadType: 'track', data: track };
    }
    /**
     * Resolves a Netease album URL.
     * @param id - Album ID.
     * @param originalUrl - Original URL.
     * @returns Playlist payload.
     */
    async _resolveAlbum(id, originalUrl) {
        const { body, statusCode, error } = await http1makeRequest(`https://music.163.com/api/v1/album/${id}`, { method: 'GET', headers: GET_HEADERS });
        const parsed = this.parseBody(body);
        if (error || statusCode !== 200 || !parsed) {
            return this.exceptionResult(`Failed to fetch Netease album: ${error || statusCode || 'unknown'}`);
        }
        const songs = Array.isArray(parsed.songs) ? parsed.songs : [];
        const tracks = songs
            .map((song) => this.toSong(song))
            .filter((song) => song !== null)
            .map((song) => this._buildTrackResult(song, originalUrl));
        if (tracks.length === 0)
            return this.emptyResult();
        const name = parsed.album?.name || 'Unknown Album';
        const artist = parsed.album?.artist?.name || 'Unknown Artist';
        logger('info', 'Netease', `Resolved album: ${name} with ${tracks.length} tracks`);
        return {
            loadType: 'playlist',
            data: {
                info: { name: `${name} — ${artist}`, selectedTrack: 0 },
                pluginInfo: {},
                tracks
            }
        };
    }
    /**
     * Resolves a Netease playlist URL.
     * @param id - Playlist ID.
     * @param originalUrl - Original URL.
     * @returns Playlist payload.
     */
    async _resolvePlaylist(id, originalUrl) {
        const { body, statusCode, error } = await http1makeRequest(`https://music.163.com/api/playlist/detail?id=${id}`, { method: 'GET', headers: GET_HEADERS });
        const parsed = this.parseBody(body);
        if (error || statusCode !== 200 || !parsed) {
            return this.exceptionResult(`Failed to fetch Netease playlist: ${error || statusCode || 'unknown'}`);
        }
        const playlist = parsed.result || parsed.playlist;
        const songs = Array.isArray(playlist?.tracks) ? playlist.tracks : [];
        const tracks = songs
            .map((song) => this.toSong(song))
            .filter((song) => song !== null)
            .map((song) => this._buildTrackResult(song, originalUrl));
        if (tracks.length === 0)
            return this.emptyResult();
        const name = playlist?.name || 'Unknown Playlist';
        logger('info', 'Netease', `Resolved playlist: ${name} with ${tracks.length} tracks`);
        return {
            loadType: 'playlist',
            data: {
                info: { name, selectedTrack: 0 },
                pluginInfo: {},
                tracks
            }
        };
    }
    /**
     * Resolves a Netease artist URL.
     * @param id - Artist ID.
     * @param originalUrl - Original URL.
     * @returns Playlist payload with top tracks.
     */
    async _resolveArtist(id, originalUrl) {
        const { body, statusCode, error } = await http1makeRequest(`https://music.163.com/api/v1/artist/${id}`, { method: 'GET', headers: GET_HEADERS });
        const parsed = this.parseBody(body);
        if (error || statusCode !== 200 || !parsed) {
            return this.exceptionResult(`Failed to fetch Netease artist: ${error || statusCode || 'unknown'}`);
        }
        const songs = Array.isArray(parsed.hotSongs) ? parsed.hotSongs : [];
        const tracks = songs
            .map((song) => this.toSong(song))
            .filter((song) => song !== null)
            .slice(0, this.maxSearchResults)
            .map((song) => this._buildTrackResult(song, originalUrl));
        if (tracks.length === 0)
            return this.emptyResult();
        const name = parsed.artist?.name || 'Unknown Artist';
        logger('info', 'Netease', `Resolved artist top tracks: ${name} with ${tracks.length} tracks`);
        return {
            loadType: 'playlist',
            data: {
                info: { name: `${name} — Top Tracks`, selectedTrack: 0 },
                pluginInfo: {},
                tracks
            }
        };
    }
    /**
     * Maps a search response payload to track-like result list.
     * @param body - Parsed response payload.
     * @param searchType - Search category.
     * @returns Encoded search list.
     */
    _mapSearchResults(body, searchType) {
        const result = body.result || {};
        if (searchType === 'album') {
            const albums = Array.isArray(result.albums) ? result.albums : [];
            return albums.map((album) => this._buildCollectionResult(album.name || 'Unknown Album', album.artist?.name || 'Unknown', `https://music.163.com/#/album?id=${album.id}`, 'album'));
        }
        if (searchType === 'artist') {
            const artists = Array.isArray(result.artists) ? result.artists : [];
            return artists.map((artist) => this._buildCollectionResult(artist.name || 'Unknown Artist', 'Netease', `https://music.163.com/#/artist?id=${artist.id}`, 'artist'));
        }
        if (searchType === 'playlist') {
            const playlists = Array.isArray(result.playlists) ? result.playlists : [];
            return playlists.map((playlist) => this._buildCollectionResult(playlist.name || 'Unknown Playlist', playlist.creator?.nickname || 'Unknown', `https://music.163.com/#/playlist?id=${playlist.id}`, 'playlist'));
        }
        const songs = Array.isArray(result.songs) ? result.songs : [];
        return songs
            .map((song) => this.toSong(song))
            .filter((song) => song !== null)
            .map((song) => this._buildTrackResult(song, `https://music.163.com/song?id=${song.id}`));
    }
    /**
     * Converts a song payload to track result.
     * @param song - Netease song payload.
     * @param uri - Canonical URI.
     * @returns Encoded track data.
     */
    _buildTrackResult(song, uri) {
        const artist = this._getArtists(song);
        const duration = song.duration || song.dt || 0;
        const artworkUrl = song.album?.picUrl || song.al?.picUrl || null;
        const info = {
            identifier: String(song.id || uri),
            isSeekable: true,
            author: artist,
            length: duration,
            isStream: false,
            position: 0,
            title: song.name || 'Unknown',
            uri: uri || `https://music.163.com/song?id=${song.id}`,
            artworkUrl,
            isrc: null,
            sourceName: 'netease'
        };
        const encodedInput = { ...info, details: [] };
        return {
            encoded: encodeTrack(encodedInput),
            info,
            pluginInfo: { neteaseId: String(song.id || '') }
        };
    }
    /**
     * Builds collection result payload for search album/artist/playlist.
     * @param title - Collection title.
     * @param author - Collection author.
     * @param url - Collection URL.
     * @param type - Collection type marker.
     * @returns Encoded pseudo-track payload.
     */
    _buildCollectionResult(title, author, url, type) {
        const info = {
            identifier: url,
            isSeekable: false,
            author,
            length: 0,
            isStream: false,
            position: 0,
            title,
            uri: url,
            artworkUrl: null,
            isrc: null,
            sourceName: 'netease'
        };
        const encodedInput = { ...info, details: [] };
        return { encoded: encodeTrack(encodedInput), info, pluginInfo: { type } };
    }
    /**
     * Extracts artist names from Netease song payload.
     * @param song - Song payload.
     * @returns Joined artist string.
     */
    _getArtists(song) {
        const list = Array.isArray(song.artists)
            ? song.artists
            : Array.isArray(song.ar)
                ? song.ar
                : [];
        if (list.length > 0) {
            return list
                .map((artist) => artist.name || 'Unknown')
                .join(', ');
        }
        return song.artist?.name || 'Unknown';
    }
    /**
     * Resolves a playable URL for Netease tracks.
     * @param decodedTrack - Decoded track metadata.
     * @returns URL payload or exception.
     */
    async getTrackUrl(decodedTrack) {
        try {
            const neteaseId = decodedTrack.pluginInfo?.neteaseId || decodedTrack.identifier;
            if (neteaseId && /^\d+$/.test(neteaseId)) {
                const streamUrl = `${STREAM_URL}${neteaseId}.mp3`;
                const directUrl = await this._resolveDirectStream(streamUrl);
                if (directUrl) {
                    logger('info', 'Netease', `Returning stream URL for id ${neteaseId}`);
                    return { url: directUrl, protocol: 'http', format: 'mp3' };
                }
                logger('warn', 'Netease', `Direct playback for id ${neteaseId} (${decodedTrack.title}) is unavailable. Falling back to default search matching.`);
            }
            if (!this.nodelink.sources) {
                return this.exceptionTrackResult('Default source search is not available.', 'common');
            }
            const query = `${decodedTrack.title} ${decodedTrack.author}`.trim();
            const searchResult = await this.nodelink.sources.searchWithDefault(query);
            if (searchResult.loadType !== 'search' ||
                !Array.isArray(searchResult.data) ||
                searchResult.data.length === 0) {
                return this.exceptionTrackResult('No matching track found on fallback source.', 'common');
            }
            const candidates = this.toBestMatchCandidates(searchResult.data);
            const bestMatch = getBestMatch(candidates, decodedTrack);
            if (!bestMatch) {
                return this.exceptionTrackResult('No suitable alternative found after filtering.', 'common');
            }
            const fallback = candidates.find((candidate) => candidate.info.title === bestMatch.info.title &&
                candidate.info.author === bestMatch.info.author &&
                candidate.info.length === bestMatch.info.length);
            if (!fallback) {
                return this.exceptionTrackResult('No suitable alternative found.', 'common');
            }
            const streamInfo = await this.nodelink.sources.getTrackUrl(fallback.info);
            return { newTrack: { info: fallback.info }, ...streamInfo };
        }
        catch (error) {
            return this.exceptionTrackResult(this.getErrorMessage(error));
        }
    }
    /**
     * Resolves direct playable CDN URL from outer URL if available.
     * @param streamUrl - Outer URL candidate.
     * @returns Final CDN audio URL or null if unavailable / redirected to 404.
     */
    async _resolveDirectStream(streamUrl) {
        try {
            const state = { location: null };
            await http1makeRequest(streamUrl, {
                method: 'HEAD',
                headers: GET_HEADERS,
                proxy: this.config.network?.proxy,
                shouldFollowRedirect: (nextUrl) => {
                    state.location = nextUrl.href;
                    return false;
                }
            });
            if (state.location && !state.location.includes('/404')) {
                return state.location;
            }
            return null;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (message.includes('Redirect to ')) {
                const match = message.match(/Redirect to (https?:\/\/[^\s]+) is not allowed/);
                const target = match?.[1];
                if (target && !target.includes('/404')) {
                    return target;
                }
            }
            return null;
        }
    }
    /**
     * Loads an audio stream for a resolved Netease track.
     * @param _track - Track metadata.
     * @param url - Stream URL.
     * @param _protocol - Protocol hint.
     * @param _additionalData - Additional stream metadata.
     * @returns Stream payload.
     */
    async loadStream(_track, url, _protocol, _additionalData) {
        const proxy = this.config.network?.proxy;
        const res = await http1makeRequest(url, {
            method: 'GET',
            streamOnly: true,
            headers: GET_HEADERS,
            proxy
        });
        const contentType = res.headers?.['content-type'] || '';
        if (res.error ||
            !res.stream ||
            (res.statusCode && res.statusCode >= 400) ||
            contentType.includes('text/html')) {
            return {
                exception: {
                    message: res.error || `HTTP error ${res.statusCode} loading audio stream`,
                    severity: 'fault'
                }
            };
        }
        const passthrough = new PassThrough();
        const source = res.stream;
        source.on('data', (chunk) => {
            if (!passthrough.write(chunk))
                source.pause();
        });
        passthrough.on('drain', () => {
            source.resume();
        });
        source.on('end', () => {
            if (!passthrough.writableEnded) {
                passthrough.emit('finishBuffering');
                passthrough.end();
            }
        });
        source.on('error', (err) => {
            logger('error', 'Netease', `Underlying stream error: ${err.message}`);
            if (!passthrough.destroyed)
                passthrough.destroy(err);
        });
        return {
            stream: passthrough,
            type: 'audio/mpeg'
        };
    }
    /**
     * Executes a test variant for declarative test runner.
     * @param variant - Test variant definition.
     * @param track - Resolved canonical track info.
     * @param streamSpec - Optional stream validation specifications.
     * @returns Variant test execution result.
     */
    async executeVariant(variant, track, streamSpec) {
        const urlData = await this.getTrackUrl(track);
        if (!urlData || 'exception' in urlData || !urlData.url) {
            const errorMsg = urlData && 'exception' in urlData && urlData.exception?.message
                ? urlData.exception.message
                : 'Failed to resolve track streaming URL';
            return {
                variant: variant.id,
                resolved: false,
                error: errorMsg
            };
        }
        const container = 'mp3';
        const codec = 'mp3';
        if (!streamSpec?.required) {
            return {
                variant: variant.id,
                resolved: true,
                track: urlData.newTrack?.info || track,
                container,
                codec
            };
        }
        const streamResult = await this.loadStream(track, urlData.url);
        if (!('stream' in streamResult)) {
            return {
                variant: variant.id,
                resolved: true,
                error: streamResult.exception?.message || 'Failed to load audio stream'
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
    /**
     * Converts unknown payload to song shape.
     * @param value - Unknown payload.
     * @returns Song payload or null.
     */
    toSong(value) {
        return value && typeof value === 'object' && !Array.isArray(value)
            ? value
            : null;
    }
    /**
     * Parses unknown body into expected response object.
     * @param body - Unknown HTTP response body.
     * @returns Parsed response payload or null.
     */
    parseBody(body) {
        if (body && typeof body === 'object' && !Array.isArray(body)) {
            return body;
        }
        if (typeof body === 'string') {
            try {
                const parsed = JSON.parse(body);
                return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                    ? parsed
                    : null;
            }
            catch {
                return null;
            }
        }
        return null;
    }
    /**
     * Converts unknown search data array into best-match candidates.
     * @param data - Unknown search data.
     * @returns Best-match candidate list.
     */
    toBestMatchCandidates(data) {
        return data
            .map((item) => item && typeof item === 'object' && !Array.isArray(item)
            ? item
            : null)
            .map((item) => item?.info && this.isTrackInfo(item.info)
            ? { info: item.info }
            : null)
            .filter((item) => item !== null);
    }
    /**
     * Validates canonical track info payload shape.
     * @param value - Unknown value.
     * @returns True when value is a track info object.
     */
    isTrackInfo(value) {
        const info = value && typeof value === 'object' && !Array.isArray(value)
            ? value
            : null;
        return (info !== null &&
            typeof info.identifier === 'string' &&
            typeof info.title === 'string' &&
            typeof info.author === 'string' &&
            typeof info.length === 'number' &&
            typeof info.uri === 'string' &&
            typeof info.sourceName === 'string');
    }
    /**
     * Returns a typed empty result payload.
     * @returns Empty result.
     */
    emptyResult() {
        return { loadType: 'empty', data: {} };
    }
    /**
     * Returns a typed exception payload for source result.
     * @param message - Error message.
     * @param severity - Error severity.
     * @returns Exception result.
     */
    exceptionResult(message, severity = 'fault') {
        return { loadType: 'error', exception: { message, severity } };
    }
    /**
     * Returns a typed exception payload for track URL resolution.
     * @param message - Error message.
     * @param severity - Error severity.
     * @returns Exception result.
     */
    exceptionTrackResult(message, severity = 'fault') {
        return { exception: { message, severity } };
    }
    /**
     * Extracts human-readable message from unknown errors.
     * @param error - Unknown error value.
     * @returns Error message string.
     */
    getErrorMessage(error) {
        return error instanceof Error ? error.message : String(error);
    }
}
