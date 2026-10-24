import { encodeTrack, http1makeRequest, logger } from '../utils.js';
/**
 * Base URL for Audius discovery nodes.
 * @internal
 */
const AUDIUS_API_BASE = 'https://discoveryprovider.audius.co';
/**
 * Priority order for artwork resolution.
 * @internal
 */
const ARTWORK_SIZES = [
    '1000x1000',
    '480x480',
    '150x150'
];
/**
 * Audius source implementation.
 * Integrates with the decentralized Audius discovery network for music resolution and search.
 * @public
 */
export default class AudiusSource {
    /**
     * The NodeLink worker context.
     * @internal
     */
    nodelink;
    /**
     * Audius-specific configuration.
     * @internal
     */
    config;
    /**
     * Prefixes that trigger Audius search.
     * @public
     */
    searchTerms = ['ausearch'];
    /**
     * Prefix for recommendation (inspired-by) requests.
     * @public
     */
    recommendationTerm = ['sprec'];
    /**
     * Regular expression patterns for identifying Audius URLs.
     * Supports tracks, playlists, albums, and users.
     * @public
     */
    patterns = [
        /** Track URL pattern */
        /^https?:\/\/(?:open\.)?audius\.co\/([^/]+)\/([^/?#]+)(?:\?.*)?$/i,
        /** Playlist URL pattern */
        /^https?:\/\/(?:open\.)?audius\.co\/([^/]+)\/playlist\/([^/?#]+)(?:\?.*)?$/i,
        /** Album URL pattern */
        /^https?:\/\/(?:open\.)?audius\.co\/([^/]+)\/album\/([^/?#]+)(?:\?.*)?$/i,
        /** User/Artist URL pattern */
        /^https?:\/\/(?:open\.)?audius\.co\/([^/?#]+)(?:\?.*)?$/i
    ];
    /**
     * Priority score for source selection.
     * @public
     */
    priority = 90;
    /**
     * Application name registered with Audius.
     * @internal
     */
    appName = null;
    /**
     * Optional API key for Audius services.
     * @internal
     */
    apiKey = null;
    /**
     * Maximum tracks to load from a playlist.
     * @internal
     */
    playlistLoadLimit = 100;
    /**
     * Maximum tracks to load from an album.
     * @internal
     */
    albumLoadLimit = 100;
    /**
     * Constructs a new AudiusSource instance.
     * @param nodelink - The worker context.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.config = (nodelink.options.sources?.audius || {
            enabled: false,
            appName: '',
            apiKey: '',
            apiSecret: '',
            playlistLoadLimit: 100,
            albumLoadLimit: 100
        });
    }
    /**
     * Performs source-level initialization.
     * @returns A promise resolving to true if initialization succeeded.
     * @public
     */
    async setup() {
        try {
            this.appName = this.config.appName || null;
            this.apiKey = this.config.apiKey || null;
            this.playlistLoadLimit = this.config.playlistLoadLimit ?? 100;
            this.albumLoadLimit = this.config.albumLoadLimit ?? 100;
            logger('info', 'Audius', 'Audius source initialized successfully.');
            return true;
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            logger('error', 'Audius', `Failed to initialize Audius: ${message}`);
            return false;
        }
    }
    /**
     * Centralized helper for executing API requests to Audius discovery nodes.
     * Automatically appends required query parameters.
     *
     * @param endpoint - The API endpoint path.
     * @returns A promise resolving to the response data or null.
     * @internal
     */
    async _apiRequest(endpoint) {
        try {
            const url = endpoint.startsWith('http')
                ? endpoint
                : `${AUDIUS_API_BASE}${endpoint}`;
            const urlObj = new URL(url);
            if (this.appName)
                urlObj.searchParams.set('app_name', this.appName);
            if (this.apiKey)
                urlObj.searchParams.set('apiKey', this.apiKey);
            const res = await http1makeRequest(urlObj.toString(), {
                headers: {
                    Accept: 'application/json',
                    'User-Agent': 'NodeLink (https://github.com/NodeLink/NodeLink)'
                }
            });
            if (res.statusCode !== 200) {
                logger('error', 'Audius', `Discovery node error: ${res.statusCode}`);
                return null;
            }
            const body = res.body;
            return body?.data || body;
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            logger('error', 'Audius', `Request to ${endpoint} failed: ${message}`);
            return null;
        }
    }
    /**
     * Resolves the most appropriate artwork URL from an Audius artwork object.
     * @param artwork - The raw artwork data from the API.
     * @returns Resolves to a full URL or null.
     * @internal
     */
    _getArtworkUrl(artwork) {
        if (!artwork)
            return null;
        if (typeof artwork === 'string' && artwork.trim()) {
            return artwork.startsWith('/') ? `https://audius.co${artwork}` : artwork;
        }
        if (typeof artwork === 'object') {
            for (const size of ARTWORK_SIZES) {
                const url = artwork[size];
                if (url) {
                    return url.startsWith('/') ? `https://audius.co${url}` : url;
                }
            }
        }
        return null;
    }
    /**
     * Normalizes Audius track data into NodeLink's standard format.
     * @param trackData - Raw track data from discovery node.
     * @returns Built TrackData object or null if data is insufficient.
     * @internal
     */
    _buildTrack(trackData) {
        if (!trackData?.id || !trackData?.title)
            return null;
        const trackInfo = {
            identifier: trackData.id,
            isSeekable: true,
            author: trackData.user?.name || 'Unknown',
            length: Math.round((trackData.duration || 0) * 1000),
            isStream: false,
            position: 0,
            title: trackData.title,
            uri: trackData.permalink
                ? `https://audius.co${trackData.permalink}`
                : `https://audius.co/track/${trackData.id}`,
            artworkUrl: this._getArtworkUrl(trackData.artwork),
            isrc: null,
            sourceName: 'audius'
        };
        return {
            encoded: encodeTrack({ ...trackInfo, details: [] }),
            info: trackInfo,
            pluginInfo: {}
        };
    }
    /**
     * Executes a search query on the Audius catalog.
     * @param query - The user search string.
     * @returns Resolves to a SourceResult containing search results.
     * @public
     */
    async search(query) {
        try {
            const limit = this.nodelink.options.search.maxResults || 10;
            const endpoint = `/v1/tracks/search?query=${encodeURIComponent(query)}&limit=${limit}`;
            const data = await this._apiRequest(endpoint);
            if (!data || data.length === 0) {
                return { loadType: 'empty', data: {} };
            }
            const tracks = data
                .map((item) => this._buildTrack(item))
                .filter((t) => t !== null);
            if (tracks.length === 0) {
                return { loadType: 'empty', data: {} };
            }
            return { loadType: 'search', data: tracks };
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return { loadType: 'error', exception: { message, severity: 'fault' } };
        }
    }
    /**
     * Resolves an Audius URL into a track or collection.
     * @param url - The absolute Audius URL.
     * @returns Resolution result payload.
     * @public
     */
    async resolve(url) {
        try {
            // 1. Playlist check
            const playlistPattern = this.patterns[1];
            const playlistMatch = playlistPattern?.exec(url);
            if (playlistMatch) {
                const [, artist, slug] = playlistMatch.map((p) => p ? decodeURIComponent(p) : '');
                if (artist && slug)
                    return await this._resolvePlaylist(artist, slug);
            }
            // 2. Album check
            const albumPattern = this.patterns[2];
            const albumMatch = albumPattern?.exec(url);
            if (albumMatch) {
                const [, artist, slug] = albumMatch.map((p) => p ? decodeURIComponent(p) : '');
                if (artist && slug)
                    return await this._resolveAlbum(artist, slug);
            }
            // 3. Track check
            const trackPattern = this.patterns[0];
            const trackMatch = trackPattern?.exec(url);
            if (trackMatch) {
                const [, artist, slug] = trackMatch.map((p) => p ? decodeURIComponent(p) : '');
                if (artist && slug)
                    return await this._resolveTrack(artist, slug);
            }
            // 4. User/Artist check
            const userPattern = this.patterns[3];
            const userMatch = userPattern?.exec(url);
            if (userMatch) {
                const [, handle] = userMatch.map((p) => p ? decodeURIComponent(p) : '');
                if (handle)
                    return await this._resolveArtist(handle);
            }
            return { loadType: 'empty', data: {} };
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return { loadType: 'error', exception: { message, severity: 'fault' } };
        }
    }
    /**
     * Resolves a track URL by searching for the artist and track slug.
     * @internal
     */
    async _resolveTrack(artist, trackSlug) {
        try {
            const searchEndpoint = `/v1/tracks/search?query=${encodeURIComponent(`${artist} ${trackSlug}`)}&limit=10`;
            const data = await this._apiRequest(searchEndpoint);
            if (!data || data.length === 0) {
                return {
                    loadType: 'error',
                    exception: { message: 'Track not found.', severity: 'common' }
                };
            }
            const expectedPath = `/${artist}/${trackSlug}`.toLowerCase();
            // Exact permalink match prioritized
            for (const item of data) {
                const permalink = item.permalink?.toLowerCase();
                if (permalink === expectedPath ||
                    permalink?.endsWith(`/${trackSlug.toLowerCase()}`)) {
                    const track = this._buildTrack(item);
                    return track
                        ? { loadType: 'track', data: track }
                        : { loadType: 'empty', data: {} };
                }
            }
            // Fallback to top result
            const first = data[0];
            if (!first)
                return { loadType: 'empty', data: {} };
            const track = this._buildTrack(first);
            return track
                ? { loadType: 'track', data: track }
                : { loadType: 'empty', data: {} };
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return { loadType: 'error', exception: { message, severity: 'fault' } };
        }
    }
    /**
     * Resolves a playlist URL.
     * @internal
     */
    async _resolvePlaylist(artist, playlistSlug) {
        try {
            const playlistData = await this._findPlaylistBySlug(artist, playlistSlug);
            if (!playlistData?.id) {
                return {
                    loadType: 'error',
                    exception: { message: 'Playlist not found.', severity: 'common' }
                };
            }
            const tracks = await this._loadPlaylistTracks(playlistData.id, this.playlistLoadLimit);
            if (tracks.length === 0) {
                return {
                    loadType: 'error',
                    exception: {
                        message: 'Playlist contains no valid tracks.',
                        severity: 'common'
                    }
                };
            }
            logger('info', 'Audius', `Successfully loaded ${tracks.length} tracks from playlist "${playlistData.playlist_name}".`);
            return {
                loadType: 'playlist',
                data: {
                    info: {
                        name: playlistData.playlist_name || 'Audius Playlist',
                        selectedTrack: 0
                    },
                    pluginInfo: {
                        type: 'playlist',
                        url: `https://audius.co/${artist}/playlist/${playlistSlug}`,
                        artworkUrl: this._getArtworkUrl(playlistData.artwork),
                        author: playlistData.user?.name
                    },
                    tracks
                }
            };
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return { loadType: 'error', exception: { message, severity: 'fault' } };
        }
    }
    /**
     * Resolves an album URL.
     * @internal
     */
    async _resolveAlbum(artist, albumSlug) {
        try {
            const albumData = await this._findAlbumBySlug(artist, albumSlug);
            if (!albumData?.id) {
                return {
                    loadType: 'error',
                    exception: { message: 'Album not found.', severity: 'common' }
                };
            }
            const tracks = await this._loadPlaylistTracks(albumData.id, this.albumLoadLimit);
            if (tracks.length === 0) {
                return {
                    loadType: 'error',
                    exception: {
                        message: 'Album contains no valid tracks.',
                        severity: 'common'
                    }
                };
            }
            logger('info', 'Audius', `Successfully loaded ${tracks.length} tracks from album "${albumData.playlist_name}".`);
            return {
                loadType: 'playlist',
                data: {
                    info: {
                        name: albumData.playlist_name || 'Audius Album',
                        selectedTrack: 0
                    },
                    pluginInfo: {
                        type: 'album',
                        url: `https://audius.co/${artist}/album/${albumSlug}`,
                        artworkUrl: this._getArtworkUrl(albumData.artwork),
                        author: albumData.user?.name
                    },
                    tracks
                }
            };
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return { loadType: 'error', exception: { message, severity: 'fault' } };
        }
    }
    /**
     * Resolves a user handle into their top tracks.
     * @internal
     */
    async _resolveArtist(artist) {
        try {
            const userData = await this._apiRequest(`/v1/users/search?query=${encodeURIComponent(artist)}&limit=1`);
            if (!userData || userData.length === 0) {
                return {
                    loadType: 'error',
                    exception: { message: 'Artist not found.', severity: 'common' }
                };
            }
            const user = userData[0];
            if (!user) {
                return {
                    loadType: 'error',
                    exception: { message: 'Artist not found.', severity: 'common' }
                };
            }
            const tracksData = await this._apiRequest(`/v1/users/${user.id}/tracks?limit=50`);
            if (!tracksData || tracksData.length === 0) {
                return {
                    loadType: 'error',
                    exception: {
                        message: 'Artist has no public tracks.',
                        severity: 'common'
                    }
                };
            }
            const tracks = tracksData
                .map((item) => this._buildTrack(item))
                .filter((t) => t !== null);
            if (tracks.length === 0) {
                return {
                    loadType: 'error',
                    exception: {
                        message: 'Artist has no valid playable tracks.',
                        severity: 'common'
                    }
                };
            }
            logger('info', 'Audius', `Loaded ${tracks.length} tracks for artist "${user.name || artist}".`);
            return {
                loadType: 'playlist',
                data: {
                    info: {
                        name: `${user.name || artist}'s Top Tracks`,
                        selectedTrack: 0
                    },
                    pluginInfo: {
                        type: 'artist',
                        url: `https://audius.co/${artist}`,
                        artworkUrl: this._getArtworkUrl(user.profile_picture),
                        author: user.name
                    },
                    tracks
                }
            };
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return { loadType: 'error', exception: { message, severity: 'fault' } };
        }
    }
    /**
     * Searches for a playlist by its owner and slug.
     * @internal
     */
    async _findPlaylistBySlug(artist, playlistSlug) {
        const searchEndpoint = `/v1/playlists/search?query=${encodeURIComponent(`${artist} ${playlistSlug}`)}&limit=10`;
        const data = await this._apiRequest(searchEndpoint);
        if (!data || data.length === 0)
            return null;
        const slugLower = playlistSlug.toLowerCase();
        for (const playlist of data) {
            if (playlist.permalink?.toLowerCase().includes(slugLower)) {
                return playlist;
            }
        }
        return data[0] || null;
    }
    /**
     * Searches for an album by its owner and slug.
     * @internal
     */
    async _findAlbumBySlug(artist, albumSlug) {
        const searchEndpoint = `/v1/playlists/search?query=${encodeURIComponent(`${artist} ${albumSlug}`)}&limit=10`;
        const data = await this._apiRequest(searchEndpoint);
        if (!data || data.length === 0)
            return null;
        const slugLower = albumSlug.toLowerCase();
        // Prefer nodes explicitly flagged as albums
        for (const playlist of data) {
            if (playlist.is_album &&
                playlist.permalink?.toLowerCase().includes(slugLower)) {
                return playlist;
            }
        }
        // Generic match fallback
        for (const playlist of data) {
            if (playlist.permalink?.toLowerCase().includes(slugLower)) {
                return playlist;
            }
        }
        return null;
    }
    /**
     * Loads all tracks for a given playlist identifier.
     * @internal
     */
    async _loadPlaylistTracks(playlistId, limit) {
        const data = await this._apiRequest(`/v1/playlists/${playlistId}/tracks?limit=${limit}`);
        if (!data || data.length === 0)
            return [];
        return data
            .map((item) => this._buildTrack(item))
            .filter((t) => t !== null);
    }
    /**
     * Resolves a playback URL for an Audius track.
     * @param decodedTrack - Decoded track metadata.
     * @returns A promise resolving to the playable stream result.
     * @public
     */
    async getTrackUrl(decodedTrack) {
        try {
            if (!decodedTrack.identifier) {
                return {
                    exception: { message: 'Missing track identifier.', severity: 'fault' }
                };
            }
            const streamUrl = this._getStreamUrl(decodedTrack.identifier);
            if (!streamUrl) {
                return {
                    exception: {
                        message: 'Failed to construct Audius stream URL.',
                        severity: 'fault'
                    }
                };
            }
            logger('debug', 'Audius', `Resolved stream URL for ${decodedTrack.identifier}: ${streamUrl}`);
            return {
                url: streamUrl,
                protocol: 'http',
                format: 'mp3',
                additionalData: {}
            };
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return { exception: { message, severity: 'fault' } };
        }
    }
    /**
     * Constructs an authenticated stream URL for a track ID.
     * @internal
     */
    _getStreamUrl(trackId) {
        try {
            const url = new URL(`${AUDIUS_API_BASE}/v1/tracks/${trackId}/stream`);
            if (this.appName)
                url.searchParams.set('app_name', this.appName);
            if (this.apiKey)
                url.searchParams.set('apiKey', this.apiKey);
            return url.toString();
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            logger('error', 'Audius', `Stream URL construction failed: ${message}`);
            return null;
        }
    }
    /**
     * Executes the final stream load via NodeLink's HTTP request handler.
     *
     * @param _track - Metadata of the track.
     * @param url - Resolved stream URL.
     * @returns A promise resolving to the readable stream and type.
     * @public
     */
    async loadStream(_track, url) {
        try {
            const res = await http1makeRequest(url, {
                method: 'GET',
                streamOnly: true
            });
            if (res.error)
                throw new Error(res.error);
            const contentTypeRaw = res.headers?.['content-type'];
            const contentType = Array.isArray(contentTypeRaw)
                ? contentTypeRaw[0]
                : typeof contentTypeRaw === 'string'
                    ? contentTypeRaw
                    : 'audio/mpeg';
            const stream = res.stream;
            if (!stream) {
                throw new Error('Failed to obtain readable stream from discovery node.');
            }
            stream.on('end', () => {
                stream.emit('finishBuffering');
            });
            stream.on('error', (err) => {
                logger('error', 'Audius', `Readable stream error: ${err.message}`);
            });
            return {
                stream,
                type: contentType
            };
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            logger('error', 'Audius', `Stream fetch failed: ${message}`);
            return { exception: { message, severity: 'fault' } };
        }
    }
}
