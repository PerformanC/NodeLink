import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import { encodeTrack, getBestMatch, http1makeRequest, logger } from '../utils.js';
/**
 * Base URL for the Yandex Music API.
 * @internal
 */
const API_BASE = 'https://api.music.yandex.net';
/**
 * User agent string for Yandex Music API requests.
 * @internal
 */
const USER_AGENT = 'Yandex-Music-API';
/**
 * Custom header for Yandex Music identifying the client.
 * @internal
 */
const CLIENT_HEADER = 'YandexMusicAndroid/24023621';
/**
 * Regular expression for standard Yandex Music URLs.
 * Matches tracks, albums, and artists across different regional domains.
 * @internal
 */
const URL_PATTERN = /^(?:https?:\/\/)?music\.yandex\.(?<domain>ru|com|kz|by)\/(?<type1>artist|album|track)\/(?<id1>\d+)(?:\/(?<type2>track)\/(?<id2>\d+))?\/?(?:[?#].*)?$/i;
/**
 * Regular expression for user playlist URLs.
 * @internal
 */
const URL_PLAYLIST_PATTERN = /^(?:https?:\/\/)?music\.yandex\.(?<domain>ru|com|kz|by)\/users\/(?<user>[0-9A-Za-z@.-]+)\/playlists\/(?<id>\d+)\/?(?:[?#].*)?$/i;
/**
 * Regular expression for playlist UUID URLs.
 * @internal
 */
const URL_PLAYLIST_UUID_PATTERN = /^(?:https?:\/\/)?music\.yandex\.(?<domain>ru|com|kz|by)\/playlists\/(?<uuid>[0-9A-Za-z.-]+)\/?(?:[?#].*)?$/i;
/**
 * Max results to load for different collection types per logical page.
 * @internal
 */
const ARTIST_MAX_PAGE_ITEMS = 10;
const PLAYLIST_MAX_PAGE_ITEMS = 100;
const ALBUM_MAX_PAGE_ITEMS = 50;
/**
 * Yandex Music source implementation.
 * Integrates with Yandex Music API for track resolution, search, and recommendations.
 * Supports fallback to Song.link for non-token resolution.
 * @public
 */
export default class YandexMusicSource {
    /**
     * The NodeLink worker context.
     * @internal
     */
    nodelink;
    /**
     * Yandex Music specific configuration.
     * @internal
     */
    config;
    /**
     * Search term prefixes recognized by this source.
     * @public
     */
    searchTerms = ['ymsearch'];
    /**
     * Prefix for recommendation requests.
     * @public
     */
    recommendationTerm = ['ymrec'];
    /**
     * Registered URL patterns for identification.
     * @public
     */
    patterns = [
        URL_PATTERN,
        URL_PLAYLIST_PATTERN,
        URL_PLAYLIST_UUID_PATTERN
    ];
    /**
     * Priority score for source selection.
     * @public
     */
    priority = 85;
    /**
     * Cached access token for API requests.
     * @internal
     */
    accessToken = null;
    /**
     * Whether a valid token is available for the API.
     * @internal
     */
    hasToken = false;
    /**
     * Limit for artist top tracks loading.
     * @internal
     */
    artistLoadLimit;
    /**
     * Limit for album tracks loading.
     * @internal
     */
    albumLoadLimit;
    /**
     * Limit for playlist tracks loading.
     * @internal
     */
    playlistLoadLimit;
    /**
     * Whether to include tracks marked as unavailable in results.
     * @internal
     */
    allowUnavailable;
    /**
     * Whether to attempt mirroring resolution on playback failure.
     * @internal
     */
    mirrorOnFailure = true;
    /**
     * Whether to allow explicit content in mirrored searches.
     * @internal
     */
    allowExplicit;
    /**
     * Constructs a new YandexMusicSource instance.
     * @param nodelink - The worker context.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.config = (nodelink.options.sources?.yandexmusic || {
            enabled: false,
            accessToken: '',
            artistLoadLimit: 1,
            albumLoadLimit: 1,
            playlistLoadLimit: 1,
            allowUnavailable: false,
            allowExplicit: true
        });
        this.artistLoadLimit = this.config.artistLoadLimit ?? 1;
        this.albumLoadLimit = this.config.albumLoadLimit ?? 1;
        this.playlistLoadLimit = this.config.playlistLoadLimit ?? 1;
        this.allowUnavailable = this.config.allowUnavailable ?? false;
        this.allowExplicit = this.config.allowExplicit ?? true;
    }
    /**
     * Performs source-level initialization.
     * Loads cached tokens or registers provided configuration.
     * @returns A promise resolving to true if initialization succeeded.
     * @public
     */
    async setup() {
        const cm = this.nodelink.credentialManager;
        if (!cm)
            return false;
        const cachedToken = cm.get('yandexmusic_access_token');
        this.accessToken = this.config.accessToken || cachedToken || null;
        if (!this.accessToken) {
            logger('warn', 'YandexMusic', 'Missing access token. API resolution disabled; falling back to Song.link.');
            this.hasToken = false;
            return true;
        }
        if (this.config.accessToken && this.config.accessToken !== cachedToken) {
            cm.set('yandexmusic_access_token', this.accessToken, 24 * 60 * 60 * 1000);
        }
        this.hasToken = true;
        logger('info', 'YandexMusic', 'Yandex Music source primed with access token.');
        return true;
    }
    /**
     * Executes a catalog search on Yandex Music.
     * Supports tracks, albums, artists, and playlists.
     *
     * @param query - The search query.
     * @param sourceTerm - The prefix used.
     * @param searchType - Target resource type.
     * @returns A promise resolving to the search result payload.
     * @public
     */
    async search(query, sourceTerm, searchType = 'track') {
        if (sourceTerm && this.recommendationTerm.includes(sourceTerm)) {
            return this.getRecommendations(query);
        }
        if (!this.hasToken) {
            return {
                loadType: 'error',
                exception: {
                    message: 'Yandex Music access token is required for search.',
                    severity: 'common'
                }
            };
        }
        try {
            const data = await this._apiRequest('/search', {
                text: query,
                type: 'all',
                page: '0'
            });
            if (!data)
                return { loadType: 'empty', data: {} };
            const limit = this.nodelink.options.search.maxResults || 10;
            if (searchType === 'album') {
                const albums = (data.albums?.results || [])
                    .filter((item) => this.allowUnavailable || item.available)
                    .slice(0, limit)
                    .map((item) => this._buildAlbumSearchResult(item));
                return albums.length
                    ? { loadType: 'search', data: albums }
                    : { loadType: 'empty', data: {} };
            }
            if (searchType === 'artist') {
                const artists = (data.artists?.results || [])
                    .filter((item) => this.allowUnavailable || item.available)
                    .slice(0, limit)
                    .map((item) => this._buildArtistSearchResult(item));
                return artists.length
                    ? { loadType: 'search', data: artists }
                    : { loadType: 'empty', data: {} };
            }
            if (searchType === 'playlist') {
                const playlists = (data.playlists?.results || [])
                    .filter((item) => this.allowUnavailable || item.available)
                    .slice(0, limit)
                    .map((item) => this._buildPlaylistSearchResult(item));
                return playlists.length
                    ? { loadType: 'search', data: playlists }
                    : { loadType: 'empty', data: {} };
            }
            const tracks = this._parseTracks(data.tracks?.results || [], 'com').slice(0, limit);
            return tracks.length
                ? { loadType: 'search', data: tracks }
                : { loadType: 'empty', data: {} };
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            logger('error', 'YandexMusic', `Search failed: ${message}`);
            return { loadType: 'error', exception: { message, severity: 'fault' } };
        }
    }
    /**
     * Resolves a Yandex Music URL into a track or collection.
     * Delegates to specialized internal resolvers.
     *
     * @param url - The absolute Yandex Music URL.
     * @returns A promise resolving to the resolution result.
     * @public
     */
    async resolve(url) {
        const parts = url.split(/[?#]/);
        const cleanUrl = parts[0];
        if (!cleanUrl)
            return { loadType: 'empty', data: {} };
        if (!this.hasToken) {
            const fallback = await this._resolveWithSongLink(cleanUrl, 'track', '');
            return fallback || { loadType: 'empty', data: {} };
        }
        try {
            let match = cleanUrl.match(URL_PATTERN);
            if (match?.groups) {
                const domain = match.groups.domain;
                const type1 = match.groups.type1;
                const id1 = match.groups.id1;
                const id2 = match.groups.id2;
                if (domain && id1) {
                    if (type1 === 'album' && match.groups.type2 === 'track' && id2) {
                        return await this._getTrack(id2, domain);
                    }
                    if (type1 === 'album')
                        return await this._getAlbum(id1, domain);
                    if (type1 === 'artist')
                        return await this._getArtist(id1, domain);
                    if (type1 === 'track')
                        return await this._getTrack(id1, domain);
                }
            }
            match = cleanUrl.match(URL_PLAYLIST_PATTERN);
            if (match?.groups) {
                const user = match.groups.user;
                const id = match.groups.id;
                const domain = match.groups.domain;
                if (user && id && domain) {
                    return await this._getPlaylist(user, id, domain);
                }
            }
            match = cleanUrl.match(URL_PLAYLIST_UUID_PATTERN);
            if (match?.groups) {
                const uuid = match.groups.uuid;
                const domain = match.groups.domain;
                if (uuid && domain) {
                    return await this._getPlaylistByUuid(uuid, domain);
                }
            }
            return { loadType: 'empty', data: {} };
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return { loadType: 'error', exception: { message, severity: 'fault' } };
        }
    }
    /**
     * Fetches similar track recommendations based on a seed.
     * @param query - Seed track identifier or search string.
     * @returns Resolution result.
     * @public
     */
    async getRecommendations(query) {
        if (!this.hasToken) {
            return {
                loadType: 'error',
                exception: {
                    message: 'Yandex Music access token is required for recommendations.',
                    severity: 'common'
                }
            };
        }
        let trackId = query;
        if (!/^\d+$/.test(trackId)) {
            const searchRes = await this.search(query, undefined, 'track');
            if (searchRes.loadType === 'search' && searchRes.data.length > 0) {
                const first = searchRes.data[0];
                if (first)
                    trackId = first.info.identifier;
            }
            else {
                return { loadType: 'empty', data: {} };
            }
        }
        const data = await this._apiRequest(`/tracks/${trackId}/similar`);
        const similar = data?.similarTracks;
        if (!Array.isArray(similar) || similar.length === 0) {
            return { loadType: 'empty', data: {} };
        }
        const tracks = this._parseTracks(similar, 'com');
        if (!tracks.length)
            return { loadType: 'empty', data: {} };
        return {
            loadType: 'playlist',
            data: {
                info: { name: 'Yandex Music Recommendations', selectedTrack: 0 },
                pluginInfo: { type: 'recommendations' },
                tracks
            }
        };
    }
    /**
     * Resolves a playable MP3 download URL for a track.
     * @param decodedTrack - Metadata of the track.
     * @returns A promise resolving to the playable URL payload.
     * @public
     */
    async getTrackUrl(decodedTrack) {
        if (!this.hasToken) {
            return {
                exception: {
                    message: 'Yandex Music token required for stream resolution.',
                    severity: 'common'
                }
            };
        }
        try {
            const url = await this._getDownloadUrl(decodedTrack.identifier);
            return { url, protocol: 'https', format: 'mp3' };
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            logger('error', 'YandexMusic', `Failed to obtain download URL: ${message}`);
            if (this.mirrorOnFailure) {
                return await this._getMirrorUrl(decodedTrack, e instanceof Error ? e : new Error(message));
            }
            return { exception: { message, severity: 'fault' } };
        }
    }
    /**
     * Loads the audio stream from a Yandex Music CDN URL.
     * @param _track - Metadata of the track.
     * @param url - Resolved CDN URL.
     * @returns A promise resolving to the readable stream and content type.
     * @public
     */
    async loadStream(_track, url, _protocol, additionalData) {
        const stream = new PassThrough();
        const guildId = String(additionalData?.guildId || 'unbound');
        const streamContext = `guildId=${guildId} trackId=${_track.identifier} title="${String(_track.title || '-').replace(/"/g, "'")}"`;
        try {
            const requestStream = async (streamUrl, startByte = 0) => {
                const headers = startByte > 0 ? { Range: `bytes=${startByte}-` } : undefined;
                return await http1makeRequest(streamUrl, {
                    method: 'GET',
                    streamOnly: true,
                    headers,
                    localAddress: this.nodelink.routePlanner?.getIP?.() || undefined,
                    proxy: this.config.network?.proxy ?? this.config.proxy
                });
            };
            let response = await requestStream(url);
            if (response.error ||
                (response.statusCode &&
                    response.statusCode !== 200 &&
                    response.statusCode !== 206)) {
                const message = response.error || `HTTP ${response.statusCode} on stream fetch.`;
                return { exception: { message, severity: 'fault' } };
            }
            const initialSourceStream = response.stream;
            if (!initialSourceStream) {
                return {
                    exception: {
                        message: 'No readable stream returned from CDN.',
                        severity: 'fault'
                    }
                };
            }
            let sourceStream = null;
            let currentUrl = response.finalUrl || url;
            let bytesRead = 0;
            let reconnecting = false;
            let ended = false;
            let consecutiveReconnectFailures = 0;
            const wait = async (ms) => {
                await new Promise((resolve) => {
                    const timeout = setTimeout(resolve, ms);
                    timeout.unref?.();
                });
            };
            const finishStream = () => {
                if (ended || stream.destroyed || stream.writableEnded)
                    return;
                ended = true;
                stream.emit('finishBuffering');
                stream.end();
            };
            const detachSource = () => {
                if (!sourceStream)
                    return;
                sourceStream.removeListener('data', onData);
                sourceStream.removeListener('end', onEnd);
                sourceStream.removeListener('error', onError);
                sourceStream.removeListener('close', onClose);
            };
            const attachSource = (nextSource) => {
                detachSource();
                sourceStream = nextSource;
                sourceStream.on('data', onData);
                sourceStream.on('end', onEnd);
                sourceStream.on('error', onError);
                sourceStream.on('close', onClose);
            };
            const onData = (chunk) => {
                bytesRead += chunk.length;
                if (consecutiveReconnectFailures > 0)
                    consecutiveReconnectFailures = 0;
                if (!stream.write(chunk))
                    sourceStream?.pause();
            };
            const onEnd = () => {
                finishStream();
            };
            const reconnect = async (reason) => {
                if (ended || stream.destroyed || stream.writableEnded || reconnecting)
                    return;
                reconnecting = true;
                while (!ended && !stream.destroyed && !stream.writableEnded) {
                    consecutiveReconnectFailures++;
                    const delay = Math.min(300 * 2 ** Math.min(consecutiveReconnectFailures - 1, 5), 5000);
                    logger('debug', 'YandexMusic', `[${streamContext}] disconnected reason=${reason} retry=${consecutiveReconnectFailures} offset=${bytesRead} delayMs=${delay} url=${currentUrl}`);
                    await wait(delay);
                    if (ended || stream.destroyed || stream.writableEnded)
                        break;
                    response = await requestStream(currentUrl, bytesRead);
                    if (response.statusCode === 416) {
                        finishStream();
                        break;
                    }
                    const badStatus = response.statusCode &&
                        response.statusCode !== 200 &&
                        response.statusCode !== 206;
                    if (!response.error && !badStatus && response.stream) {
                        currentUrl = response.finalUrl || currentUrl;
                        attachSource(response.stream);
                        reconnecting = false;
                        return;
                    }
                    const shouldRefreshUrl = response.statusCode === 403 ||
                        response.statusCode === 404 ||
                        response.statusCode === 410;
                    if (shouldRefreshUrl) {
                        const refreshed = await this.getTrackUrl(_track);
                        if (refreshed.url) {
                            currentUrl = refreshed.url;
                        }
                    }
                }
                reconnecting = false;
            };
            const onError = (err) => {
                const netErr = err;
                const message = err.message || String(err);
                const isTransient = netErr.code === 'ECONNRESET' ||
                    netErr.code === 'ECONNABORTED' ||
                    netErr.code === 'ETIMEDOUT' ||
                    /aborted|socket hang up|connection reset|timeout/i.test(message);
                if (isTransient) {
                    void reconnect(message);
                    return;
                }
                logger('error', 'YandexMusic', `[${streamContext}] CDN stream error: ${message}`);
                if (!stream.destroyed)
                    stream.destroy(err);
            };
            const onClose = () => {
                if (!ended && !reconnecting) {
                    void reconnect('closed');
                }
            };
            stream.on('drain', () => {
                if (sourceStream && !sourceStream.destroyed)
                    sourceStream.resume();
            });
            stream.on('close', () => {
                detachSource();
                sourceStream?.destroy?.();
            });
            attachSource(initialSourceStream);
            return { stream, type: 'audio/mpeg' };
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            logger('error', 'YandexMusic', `[${streamContext}] stream loading failed: ${message}`);
            if (!stream.destroyed)
                stream.destroy(e instanceof Error ? e : new Error(message));
            return { exception: { message, severity: 'fault' } };
        }
    }
    /**
     * Specialized internal resolver for tracks.
     * @internal
     */
    async _getTrack(id, domain) {
        let data;
        try {
            data = await this._apiRequest(`/tracks/${id}`);
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            logger('warn', 'YandexMusic', `Direct track lookup failed: ${message}. Attempting Song.link fallback.`);
            const fallback = await this._resolveWithSongLink(`https://song.link/ya/${id}`, 'track', id);
            return fallback || { loadType: 'empty', data: {} };
        }
        const node = data?.result?.[0];
        if (!node || (node.available === false && !this.allowUnavailable)) {
            const fallback = await this._resolveWithSongLink(`https://song.link/ya/${id}`, 'track', id);
            return fallback || { loadType: 'empty', data: {} };
        }
        const track = this._parseTrack(node, domain);
        if (!track)
            return { loadType: 'empty', data: {} };
        // Enrich with Song.link data if available
        const songlink = await this._fetchSongLinkData(id);
        if (songlink) {
            this._applySongLinkMetadata(track, songlink);
            await this._enrichFromSongLinkPlatforms(track, songlink);
        }
        track.encoded = encodeTrack({ ...track.info, details: [] });
        return { loadType: 'track', data: track };
    }
    /**
     * Specialized internal resolver for albums.
     * @internal
     */
    async _getAlbum(id, domain) {
        const pageSize = ALBUM_MAX_PAGE_ITEMS * Math.max(this.albumLoadLimit, 1);
        let data;
        try {
            data = await this._apiRequest(`/albums/${id}/with-tracks`, {
                'page-size': String(pageSize)
            });
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            logger('warn', 'YandexMusic', `Direct album lookup failed: ${message}. Attempting Song.link fallback.`);
            const fallback = await this._resolveWithSongLink(`https://album.link/ya/${id}`, 'album', id);
            return fallback || { loadType: 'empty', data: {} };
        }
        const album = data?.result;
        if (!album?.volumes?.length) {
            const fallback = await this._resolveWithSongLink(`https://album.link/ya/${id}`, 'album', id);
            return fallback || { loadType: 'empty', data: {} };
        }
        const tracks = [];
        for (const volume of album.volumes) {
            for (const node of volume) {
                const track = this._parseTrack(node, domain);
                if (track)
                    tracks.push(track);
            }
        }
        if (!tracks.length)
            return { loadType: 'empty', data: {} };
        return {
            loadType: 'playlist',
            data: {
                info: { name: album.title || 'Yandex Music Album', selectedTrack: 0 },
                pluginInfo: { type: 'album' },
                tracks
            }
        };
    }
    /**
     * Specialized internal resolver for artist top tracks.
     * @internal
     */
    async _getArtist(id, domain) {
        const pageSize = ARTIST_MAX_PAGE_ITEMS * Math.max(this.artistLoadLimit, 1);
        let tracksData;
        try {
            tracksData = await this._apiRequest(`/artists/${id}/tracks`, {
                'page-size': String(pageSize)
            });
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            logger('warn', 'YandexMusic', `Artist tracks lookup failed: ${message}. Attempting fallback.`);
            const fallback = await this._resolveWithSongLink(`https://artist.link/ya/${id}`, 'artist', id);
            return fallback || { loadType: 'empty', data: {} };
        }
        const tracks = this._parseTracks(tracksData?.result?.tracks || [], domain);
        if (!tracks.length)
            return { loadType: 'empty', data: {} };
        const artistData = await this._apiRequest(`/artists/${id}`);
        const name = artistData?.result?.artist?.name || 'Unknown Artist';
        return {
            loadType: 'playlist',
            data: {
                info: { name: `${name}'s Top Tracks`, selectedTrack: 0 },
                pluginInfo: { type: 'artist' },
                tracks
            }
        };
    }
    /**
     * Specialized internal resolver for playlists by user and ID.
     * @internal
     */
    async _getPlaylist(user, id, domain) {
        const pageSize = PLAYLIST_MAX_PAGE_ITEMS * Math.max(this.playlistLoadLimit, 1);
        const playlistUrl = `https://music.yandex.${domain}/users/${user}/playlists/${id}`;
        let data;
        try {
            data = await this._apiRequest(`/users/${user}/playlists/${id}`, {
                'page-size': String(pageSize),
                'rich-tracks': 'true'
            });
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            logger('warn', 'YandexMusic', `Playlist lookup failed: ${message}. Attempting Song.link fallback.`);
            const fallback = await this._resolveWithSongLink(playlistUrl, 'playlist', id);
            return fallback || { loadType: 'empty', data: {} };
        }
        return this._parsePlaylistResponse(data, domain);
    }
    /**
     * Specialized internal resolver for playlists by UUID.
     * @internal
     */
    async _getPlaylistByUuid(uuid, domain) {
        const pageSize = PLAYLIST_MAX_PAGE_ITEMS * Math.max(this.playlistLoadLimit, 1);
        const playlistUrl = `https://music.yandex.${domain}/playlists/${uuid}`;
        let data;
        try {
            data = await this._apiRequest(`/playlist/${uuid}`, {
                'page-size': String(pageSize),
                'rich-tracks': 'true'
            });
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            logger('warn', 'YandexMusic', `Playlist UUID lookup failed: ${message}. Attempting Song.link fallback.`);
            const fallback = await this._resolveWithSongLink(playlistUrl, 'playlist', uuid);
            return fallback || { loadType: 'empty', data: {} };
        }
        return this._parsePlaylistResponse(data, domain);
    }
    /**
     * Parses a playlist API response into NodeLink format.
     * @internal
     */
    _parsePlaylistResponse(data, domain) {
        const result = data?.result;
        if (!result?.tracks?.length)
            return { loadType: 'empty', data: {} };
        const tracks = this._parseTracks(result.tracks, domain);
        if (!tracks.length)
            return { loadType: 'empty', data: {} };
        const ownerName = result.owner?.name || result.owner?.login || 'Unknown';
        const title = String(result.kind) === '3'
            ? `${ownerName}'s Liked Songs`
            : result.title || 'Yandex Music Playlist';
        return {
            loadType: 'playlist',
            data: {
                info: { name: title, selectedTrack: 0 },
                pluginInfo: { type: 'playlist' },
                tracks
            }
        };
    }
    /**
     * Parses a list of track nodes into TrackData objects.
     * @internal
     */
    _parseTracks(list, domain) {
        const tracks = [];
        for (const item of list) {
            const node = item.track ||
                item;
            const track = this._parseTrack(node, domain);
            if (track)
                tracks.push(track);
        }
        return tracks;
    }
    /**
     * Maps a single Yandex Music track node into standardized TrackData.
     * @internal
     */
    _parseTrack(json, domain) {
        if (!json || (json.available === false && !this.allowUnavailable))
            return null;
        const artist = this._parseArtistName(json);
        const album = json.albums?.[0];
        const info = {
            title: json.title || 'Unknown Title',
            author: artist,
            length: Math.round(Number(json.durationMs || 0)),
            identifier: String(json.id),
            isSeekable: true,
            isStream: false,
            uri: `https://music.yandex.${domain}/track/${json.id}`,
            artworkUrl: this._parseCoverUri(json),
            isrc: json.isrc || null,
            sourceName: 'yandexmusic',
            position: 0
        };
        return {
            encoded: encodeTrack({ ...info, details: [] }),
            info,
            pluginInfo: {
                albumName: album?.title || null,
                albumUrl: album
                    ? `https://music.yandex.${domain}/album/${album.id}`
                    : null,
                unavailable: json.available === false
            }
        };
    }
    /**
     * Extracts aggregated artist names from a track node.
     * @internal
     */
    _parseArtistName(json) {
        if (json.major &&
            json.major.name === 'PODCASTS' &&
            json.albums?.[0]?.title) {
            return json.albums[0].title;
        }
        if (json.artists?.length) {
            return json.artists.map((a) => a.name).join(', ');
        }
        return 'Unknown Artist';
    }
    /**
     * Extracts and formats cover artwork URL from various node properties.
     * @internal
     */
    _parseCoverUri(json) {
        const ogImage = json.ogImage;
        if (ogImage)
            return this._formatCoverUri(ogImage);
        const coverUri = json.coverUri;
        if (coverUri)
            return this._formatCoverUri(coverUri);
        const cover = json.cover;
        if (cover?.uri)
            return this._formatCoverUri(cover.uri);
        const itemsUri = cover?.itemsUri;
        if (itemsUri?.[0]) {
            const first = itemsUri[0];
            return first ? this._formatCoverUri(first) : null;
        }
        return null;
    }
    /**
     * Formats a raw Yandex cover URI template into a usable URL.
     * @internal
     */
    _formatCoverUri(uri) {
        return `https://${uri.replace('%%', '400x400')}`;
    }
    /**
     * Centralized authenticated API request helper.
     * @internal
     */
    async _apiRequest(path, params = {}) {
        const url = new URL(`${API_BASE}${path}`);
        for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, value);
        }
        const res = await http1makeRequest(url.toString(), {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                Authorization: `OAuth ${this.accessToken}`,
                'User-Agent': USER_AGENT,
                'X-Yandex-Music-Client': CLIENT_HEADER
            },
            localAddress: this.nodelink.routePlanner?.getIP?.() || undefined,
            proxy: this.config.network?.proxy ?? this.config.proxy
        });
        if (res.statusCode !== 200) {
            throw new Error(`Yandex API returned HTTP ${res.statusCode} for ${path}`);
        }
        return res.body;
    }
    /**
     * Resolves the direct MP3 download URL using internal signing logic.
     * @internal
     */
    async _getDownloadUrl(trackId) {
        const data = await this._apiRequest(`/tracks/${trackId}/download-info`);
        const results = data?.result;
        if (!results?.length)
            throw new Error(`No download info available for track ${trackId}`);
        const mp3 = results
            .filter((it) => it.codec === 'mp3')
            .sort((a, b) => (b.bitrateInKbps || 0) - (a.bitrateInKbps || 0))[0];
        if (!mp3?.downloadInfoUrl)
            throw new Error(`No high-quality MP3 source found for track ${trackId}`);
        const xml = await this._downloadText(mp3.downloadInfoUrl);
        const host = this._readXmlTag(xml, 'host');
        const path = this._readXmlTag(xml, 'path');
        const ts = this._readXmlTag(xml, 'ts');
        const s = this._readXmlTag(xml, 's');
        if (!host || !path || !ts || !s)
            throw new Error('Malformed download-info XML response.');
        const secret = 'XGRlBW9FXlekgbPrRHuSiA';
        const sign = `${secret}${path}${s}`;
        const md5 = crypto.createHash('md5').update(sign, 'utf8').digest('hex');
        return `https://${host}/get-mp3/${md5}/${ts}${path}`;
    }
    /**
     * Attempts to find a mirror stream using default source search.
     * @internal
     */
    async _getMirrorUrl(decodedTrack, originalError) {
        try {
            const query = `${decodedTrack.title} ${decodedTrack.author}`.trim();
            const sm = this.nodelink.sources;
            if (!sm)
                throw originalError;
            let res = await sm.searchWithDefault(decodedTrack.isrc ? `"${decodedTrack.isrc}"` : query);
            if (res.loadType !== 'search' || !res.data.length) {
                res = await sm.searchWithDefault(query);
            }
            if (res.loadType !== 'search' || !res.data.length) {
                throw originalError;
            }
            const best = getBestMatch(res.data, decodedTrack, {
                allowExplicit: this.allowExplicit
            });
            if (!best)
                throw originalError;
            const stream = await sm.getTrackUrl(best.info);
            return { newTrack: { info: best.info }, ...stream };
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return { exception: { message, severity: 'fault' } };
        }
    }
    /**
     * Fetches raw text (XML) from a provided URL using authentication.
     * @internal
     */
    async _downloadText(url) {
        const res = await http1makeRequest(url, {
            method: 'GET',
            headers: { Authorization: `OAuth ${this.accessToken}` },
            localAddress: this.nodelink.routePlanner?.getIP?.() || undefined
        });
        if (res.statusCode !== 200)
            throw new Error(`Download failed with HTTP ${res.statusCode}`);
        return typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    }
    /**
     * Simple regex-based XML tag reader.
     * @internal
     */
    _readXmlTag(xml, tag) {
        const match = xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`));
        if (match) {
            const val = match[1];
            return val ? val : null;
        }
        return null;
    }
    /**
     * Performs an iterative resolution using Song.link API.
     * @internal
     */
    async _resolveWithSongLink(url, _type, _id) {
        try {
            const sm = this.nodelink.sources;
            if (!sm)
                return null;
            const songlinkSource = sm.getSource('songlink');
            if (!songlinkSource?.getSongLinkData)
                return null;
            const data = await songlinkSource.getSongLinkData(url);
            const linksByPlatform = data.linksByPlatform;
            if (!linksByPlatform)
                return null;
            const platforms = songlinkSource.getPlatformOrder?.(linksByPlatform) ??
                Object.keys(linksByPlatform);
            for (const platform of platforms) {
                const platformLink = linksByPlatform[platform]?.url;
                if (!platformLink)
                    continue;
                const sourceName = songlinkSource.getPlatformSourceName?.(platform) ?? null;
                if (!sourceName || !this._isSourceAvailable(sourceName))
                    continue;
                const source = sm.getSource(sourceName);
                if (!source?.resolve)
                    continue;
                const res = await source.resolve(platformLink);
                if (res.loadType === 'track' || res.loadType === 'playlist') {
                    return this._decorateSongLinkResult(res, data, url, sourceName);
                }
            }
        }
        catch (e) {
            logger('debug', 'YandexMusic', `Song.link resolution failure: ${e instanceof Error ? e.message : String(e)}`);
        }
        return null;
    }
    /**
     * Adds Song.link metadata to a resolved external result.
     * @internal
     */
    _decorateSongLinkResult(result, songlink, originalUrl, mirrorSource) {
        const info = {
            pageUrl: songlink.pageUrl,
            entityUniqueId: songlink.entityUniqueId,
            linksByPlatform: songlink.linksByPlatform
        };
        if (result.loadType === 'track' && result.data) {
            result.data.pluginInfo = {
                ...result.data.pluginInfo,
                songlink: info,
                originalUrl,
                mirrorSource
            };
        }
        else if (result.loadType === 'playlist' && result.data) {
            result.data.pluginInfo = {
                ...result.data.pluginInfo,
                songlink: info,
                originalUrl,
                mirrorSource
            };
        }
        return result;
    }
    /**
     * Fetches Song.link metadata for a specific Yandex track ID.
     * @internal
     */
    async _fetchSongLinkData(id) {
        const sm = this.nodelink.sources;
        if (!sm)
            return null;
        const songlinkSource = sm.getSource('songlink');
        if (!songlinkSource?.getSongLinkData)
            return null;
        return await songlinkSource.getSongLinkData(`https://song.link/ya/${id}`);
    }
    /**
     * Applies Song.link metadata to an existing track object.
     * @internal
     */
    _applySongLinkMetadata(track, data) {
        const entities = data.entitiesByUniqueId;
        const entity = entities?.[data.entityUniqueId];
        if (!entity)
            return;
        if (!track.info.title && entity.title)
            track.info.title = String(entity.title);
        if (!track.info.author && entity.artistName)
            track.info.author = String(entity.artistName);
        if (entity.duration && (!track.info.length || track.info.length <= 0)) {
            track.info.length = Math.round(Number(entity.duration) * 1000);
        }
        if (entity.thumbnailUrl &&
            (!track.info.artworkUrl || track.info.artworkUrl.includes('yandex.net'))) {
            track.info.artworkUrl = String(entity.thumbnailUrl);
        }
        if (!track.info.isrc && entity.isrc)
            track.info.isrc = String(entity.isrc);
    }
    /**
     * Iterates through available platforms on Song.link to find missing metadata fields.
     * @internal
     */
    async _enrichFromSongLinkPlatforms(track, data) {
        const links = data.linksByPlatform;
        if (!links)
            return;
        const sm = this.nodelink.sources;
        if (!sm)
            return;
        const songlinkSource = sm.getSource('songlink');
        const platforms = songlinkSource?.getPlatformOrder?.(links) ?? Object.keys(links);
        for (const p of platforms) {
            const url = links[p]?.url;
            if (!url)
                continue;
            const sourceName = songlinkSource?.getPlatformSourceName?.(p) ?? null;
            if (!sourceName || !this._isSourceAvailable(sourceName))
                continue;
            const source = sm.getSource(sourceName);
            if (!source?.resolve)
                continue;
            try {
                const res = await source.resolve(url);
                if (res.loadType === 'error')
                    continue;
                const candidate = res.loadType === 'track'
                    ? res.data
                    : Array.isArray(res.data?.tracks)
                        ? res.data.tracks[0]
                        : null;
                if (candidate?.info) {
                    this._applyExternalMetadata(track, candidate.info);
                    if (track.info.length && track.info.isrc)
                        break;
                }
            }
            catch { }
        }
    }
    /**
     * Applies metadata from an external source to a track object.
     * @internal
     */
    _applyExternalMetadata(track, ext) {
        if (!track.info.title && ext.title)
            track.info.title = ext.title;
        if (!track.info.author && ext.author)
            track.info.author = ext.author;
        if (!track.info.length || track.info.length <= 0)
            track.info.length = ext.length;
        if (!track.info.isrc && ext.isrc)
            track.info.isrc = ext.isrc;
        if (!track.info.artworkUrl ||
            track.info.artworkUrl.includes('yandex.net')) {
            if (ext.artworkUrl)
                track.info.artworkUrl = ext.artworkUrl;
        }
    }
    /**
     * Checks if a specific source is enabled and registered in the manager.
     * @internal
     */
    _isSourceAvailable(name) {
        const sm = this.nodelink.sources;
        if (!sm)
            return false;
        const config = this.nodelink.options.sources?.[name];
        return !!(config?.enabled && sm.getSource(name));
    }
    /**
     * Maps an album node to a search result track data object.
     * @internal
     */
    _buildAlbumSearchResult(node) {
        const info = {
            title: node.title || 'Unknown Album',
            author: node.artists?.map((a) => a.name).join(', ') || 'Unknown Artist',
            length: 0,
            identifier: String(node.id),
            isSeekable: true,
            isStream: false,
            uri: `https://music.yandex.com/album/${node.id}`,
            artworkUrl: this._parseCoverUri(node),
            isrc: null,
            sourceName: 'yandexmusic',
            position: 0
        };
        return {
            encoded: encodeTrack({ ...info, details: [] }),
            info,
            pluginInfo: { type: 'album' }
        };
    }
    /**
     * Maps an artist node to a search result track data object.
     * @internal
     */
    _buildArtistSearchResult(node) {
        const info = {
            title: node.name || 'Unknown Artist',
            author: 'Yandex Music',
            length: 0,
            identifier: String(node.id),
            isSeekable: false,
            isStream: false,
            uri: `https://music.yandex.com/artist/${node.id}`,
            artworkUrl: this._parseCoverUri(node),
            isrc: null,
            sourceName: 'yandexmusic',
            position: 0
        };
        return {
            encoded: encodeTrack({ ...info, details: [] }),
            info,
            pluginInfo: { type: 'artist' }
        };
    }
    /**
     * Maps a playlist node to a search result track data object.
     * @internal
     */
    _buildPlaylistSearchResult(node) {
        const ownerName = node.owner?.name || node.owner?.login || 'Unknown';
        const login = node.owner?.login || 'unknown';
        const info = {
            title: node.title || 'Yandex Music Playlist',
            author: ownerName,
            length: 0,
            identifier: String(node.kind),
            isSeekable: true,
            isStream: false,
            uri: `https://music.yandex.com/users/${login}/playlists/${node.kind}`,
            artworkUrl: this._parseCoverUri(node),
            isrc: null,
            sourceName: 'yandexmusic',
            position: 0
        };
        return {
            encoded: encodeTrack({ ...info, details: [] }),
            info,
            pluginInfo: { type: 'playlist' }
        };
    }
}
