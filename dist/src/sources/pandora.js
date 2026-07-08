/**
 * Pandora music source implementation.
 * Provides search, playlist, station, artist, and podcast resolution.
 * @module sources/pandora
 */
import { encodeTrack, getBestMatch, http1makeRequest, logger, makeRequest } from '../utils.js';
/**
 * Default credential cache TTL (24 hours).
 * @internal
 */
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Pandora content image CDN base URL.
 * @internal
 */
const PANDORA_CDN_BASE = 'https://content-images.p-cdn.com/';
/**
 * Pandora web base URL.
 * @internal
 */
const PANDORA_BASE_URL = 'https://www.pandora.com';
/**
 * Pandora music source.
 * Integrates with the Pandora web API for search, playlists, stations, artists, and podcasts.
 * @public
 */
export default class PandoraSource {
    /**
     * Runtime NodeLink context.
     * @internal
     */
    nodelink;
    /**
     * Pandora source configuration.
     * @internal
     */
    config;
    /**
     * NodeLink options reference.
     * @internal
     */
    options;
    /**
     * Search aliases handled by this source.
     * @public
     */
    searchTerms = ['pdsearch'];
    /**
     * URL patterns handled by this source.
     * @public
     */
    patterns = [
        /^https?:\/\/(?:www\.)?pandora\.com\/(?:playlist|station|podcast|artist)\/.+/
    ];
    /**
     * URL resolution priority.
     * @public
     */
    priority = 80;
    /**
     * Pre-configured CSRF token from config.
     * @internal
     */
    csrfTokenConfig;
    /**
     * Active CSRF token.
     * @internal
     */
    csrfToken = null;
    /**
     * Active authentication token.
     * @internal
     */
    authToken = null;
    /**
     * Setup promise to prevent duplicate initialization.
     * @internal
     */
    setupPromise = null;
    /**
     * Constructs a new PandoraSource instance.
     * @param nodelink - The worker NodeLink context.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.options = nodelink.options;
        this.config = (nodelink.options.sources?.pandora ??
            {});
        this.csrfTokenConfig = this.config.csrfToken ?? null;
    }
    /**
     * Initializes the Pandora source by obtaining authentication tokens.
     * @returns Promise resolving to true if setup succeeded.
     * @public
     */
    async setup() {
        if (this.authToken)
            return true;
        if (this.setupPromise)
            return this.setupPromise;
        this.setupPromise = this.performSetup();
        return this.setupPromise;
    }
    /**
     * Performs the actual setup logic.
     * @returns Promise resolving to true if setup succeeded.
     * @internal
     */
    async performSetup() {
        try {
            const credMgr = this.nodelink.credentialManager;
            if (credMgr) {
                const cachedAuth = credMgr.get('pandora_auth_token');
                const cachedCsrf = credMgr.get('pandora_csrf_token');
                if (cachedAuth && cachedCsrf) {
                    this.authToken = cachedAuth;
                    this.csrfToken = cachedCsrf;
                    logger('info', 'Pandora', 'Loaded Pandora credentials from CredentialManager.');
                    return true;
                }
            }
            logger('debug', 'Pandora', 'Setting Pandora auth and CSRF token.');
            if (await this.tryRemoteTokenProvider()) {
                return true;
            }
            if (!(await this.initializeCsrfToken())) {
                return false;
            }
            if (!(await this.performAnonymousLogin())) {
                return false;
            }
            this.cacheCredentials(DEFAULT_CACHE_TTL_MS);
            logger('info', 'Pandora', 'Successfully set Pandora auth and CSRF token.');
            return true;
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            logger('error', 'Pandora', `Setup failed: ${message}`);
            return false;
        }
        finally {
            this.setupPromise = null;
        }
    }
    /**
     * Attempts to fetch tokens from a remote provider.
     * @returns Promise resolving to true if remote tokens were obtained.
     * @internal
     */
    async tryRemoteTokenProvider() {
        const remoteUrl = this.config.remoteTokenUrl;
        if (!remoteUrl)
            return false;
        logger('info', 'Pandora', `Fetching tokens from remote provider: ${remoteUrl}`);
        try {
            const response = await makeRequest(remoteUrl, { method: 'GET' });
            const body = response.body;
            if (!response.error &&
                response.statusCode === 200 &&
                body?.success &&
                body.authToken &&
                body.csrfToken) {
                this.authToken = body.authToken;
                this.csrfToken = {
                    raw: `csrftoken=${body.csrfToken};Path=/;Domain=.pandora.com;Secure`,
                    parsed: body.csrfToken
                };
                const cacheTtlMs = (body.expires_in_seconds ?? 3600) * 1000;
                this.cacheCredentials(cacheTtlMs);
                logger('info', 'Pandora', 'Successfully initialized with remote tokens (bypass active).');
                return true;
            }
            logger('warn', 'Pandora', `Remote provider failed (Status: ${response.statusCode}). Falling back to local login.`);
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            logger('warn', 'Pandora', `Exception during remote token fetch: ${message}. Falling back to local login.`);
        }
        return false;
    }
    /**
     * Initializes the CSRF token from config or Pandora website.
     * @returns Promise resolving to true if CSRF token was obtained.
     * @internal
     */
    async initializeCsrfToken() {
        if (this.csrfTokenConfig) {
            this.csrfToken = {
                raw: `csrftoken=${this.csrfTokenConfig};Path=/;Domain=.pandora.com;Secure`,
                parsed: this.csrfTokenConfig
            };
            return true;
        }
        const response = await makeRequest(PANDORA_BASE_URL, { method: 'HEAD' });
        if (response.error) {
            logger('error', 'Pandora', 'Failed to set CSRF token from Pandora.');
            return false;
        }
        const cookies = response.headers?.['set-cookie'];
        const csrfCookie = cookies?.find((cookie) => cookie.startsWith('csrftoken='));
        if (!csrfCookie) {
            logger('error', 'Pandora', 'Failed to find CSRF token cookie.');
            return false;
        }
        const csrfMatch = /csrftoken=([a-f0-9]{16})/.exec(csrfCookie);
        if (!csrfMatch?.[1]) {
            logger('error', 'Pandora', 'Failed to parse CSRF token.');
            return false;
        }
        this.csrfToken = {
            raw: csrfCookie.split(';')[0] ?? '',
            parsed: csrfMatch[1]
        };
        return true;
    }
    /**
     * Performs anonymous login to obtain auth token.
     * @returns Promise resolving to true if login succeeded.
     * @internal
     */
    async performAnonymousLogin() {
        if (!this.csrfToken)
            return false;
        const response = await makeRequest(`${PANDORA_BASE_URL}/api/v1/auth/anonymousLogin`, {
            headers: {
                Cookie: this.csrfToken.raw,
                'Content-Type': 'application/json',
                Accept: '*/*',
                'X-CsrfToken': this.csrfToken.parsed
            },
            method: 'POST'
        });
        const body = response.body;
        if (response.error || body?.errorCode === 0) {
            logger('error', 'Pandora', 'Failed to set auth token from Pandora.');
            return false;
        }
        this.authToken = body?.authToken ?? null;
        return this.authToken !== null;
    }
    /**
     * Caches credentials in the credential manager.
     * @param ttlMs - Time to live in milliseconds.
     * @internal
     */
    cacheCredentials(ttlMs) {
        const credMgr = this.nodelink.credentialManager;
        if (!credMgr)
            return;
        if (this.authToken) {
            credMgr.set('pandora_auth_token', this.authToken, ttlMs);
        }
        if (this.csrfToken) {
            credMgr.set('pandora_csrf_token', this.csrfToken, ttlMs);
        }
    }
    /**
     * Searches for tracks on Pandora.
     * @param query - Search query string.
     * @returns Promise resolving to search results.
     * @public
     */
    async search(query) {
        const authError = await this.ensureAuth();
        if (authError)
            return authError;
        logger('debug', 'Pandora', `Searching for: ${query}`);
        const body = {
            query,
            types: ['TR'],
            listener: null,
            start: 0,
            count: this.options.search.maxResults ?? 10,
            annotate: true,
            searchTime: 0,
            annotationRecipe: 'CLASS_OF_2019'
        };
        const response = await makeRequest(`${PANDORA_BASE_URL}/api/v3/sod/search`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: '*/*'
            },
            body,
            disableBodyCompression: true
        });
        if (response.error) {
            return this.buildException(response.error);
        }
        const data = response.body;
        if (!data?.results || data.results.length === 0) {
            return { loadType: 'empty', data: {} };
        }
        const tracks = [];
        const annotations = data.annotations ?? {};
        for (const key of Object.keys(annotations)) {
            const item = annotations[key];
            if (item?.type === 'TR') {
                tracks.push(this.buildTrack(item));
            }
        }
        return { loadType: 'search', data: tracks };
    }
    /**
     * Resolves a Pandora URL to track/playlist data.
     * @param url - The Pandora URL to resolve.
     * @returns Promise resolving to the resolved content.
     * @public
     */
    async resolve(url) {
        const authError = await this.ensureAuth();
        if (authError)
            return authError;
        const typeMatch = /^(https:\/\/www\.pandora\.com\/)((playlist)|(station)|(podcast)|(artist))\/.+/.exec(url);
        if (!typeMatch) {
            return { loadType: 'empty', data: {} };
        }
        const type = typeMatch[2];
        const lastPart = url.split('/').pop() ?? '';
        logger('debug', 'Pandora', `Resolving ${type} with ID: ${lastPart}`);
        switch (type) {
            case 'artist':
                return this.resolveArtist(lastPart);
            case 'playlist':
                return this.resolvePlaylist(lastPart);
            case 'station':
                return this.resolveStation(lastPart);
            case 'podcast':
                return this.resolvePodcast(lastPart);
            default:
                return { loadType: 'empty', data: {} };
        }
    }
    /**
     * Ensures authentication is available.
     * @returns Null if authenticated, exception result otherwise.
     * @internal
     */
    async ensureAuth() {
        if (!this.authToken) {
            await this.setup();
        }
        if (!this.authToken) {
            return {
                loadType: 'error',
                exception: {
                    message: 'Pandora source is not available.',
                    severity: 'common',
                    cause: 'Auth Failed'
                }
            };
        }
        return null;
    }
    /**
     * Builds an exception result.
     * @param error - Error object or undefined.
     * @param data - Additional data with message.
     * @returns SourceResult with exception.
     * @internal
     */
    buildException(error, data) {
        const errorMessage = typeof error === 'string' ? error : (error?.message ?? null);
        return {
            loadType: 'error',
            exception: {
                message: errorMessage ?? data?.message ?? 'Unknown error',
                severity: 'common'
            }
        };
    }
    /**
     * Builds request headers for Pandora API.
     * @returns Headers object.
     * @internal
     */
    getHeaders() {
        return {
            Cookie: this.csrfToken?.raw ?? '',
            'X-CsrfToken': this.csrfToken?.parsed ?? '',
            'X-AuthToken': this.authToken ?? '',
            'Content-Type': 'application/json'
        };
    }
    /**
     * Builds a full artwork URL.
     * @param artwork - Partial or full artwork URL.
     * @returns Full artwork URL or null.
     * @internal
     */
    buildArtworkUrl(artwork) {
        if (!artwork)
            return null;
        return artwork.startsWith('http')
            ? artwork
            : `${PANDORA_CDN_BASE}${artwork}`;
    }
    /**
     * Builds a full URI from a shareable path.
     * @param shareableUrlPath - Partial or full URL path.
     * @returns Full URI.
     * @internal
     */
    buildUri(shareableUrlPath) {
        if (!shareableUrlPath)
            return '';
        return shareableUrlPath.startsWith('http')
            ? shareableUrlPath
            : `${PANDORA_BASE_URL}${shareableUrlPath}`;
    }
    /**
     * Limits array to specified length.
     * @param arr - Array to limit.
     * @param limit - Maximum length.
     * @returns Limited array.
     * @internal
     */
    limitArray(arr, limit) {
        return arr.length > limit ? arr.slice(0, limit) : arr;
    }
    /**
     * Gets the maximum playlist/album length from config.
     * @returns Maximum length.
     * @internal
     */
    getMaxPlaylistLength() {
        return (this.options.playback.maxPlaylistLength ?? 100);
    }
    /**
     * Resolves an artist, album, or track by ID.
     * @param id - Pandora ID.
     * @returns Promise resolving to the content.
     * @internal
     */
    async resolveArtist(id) {
        const response = await http1makeRequest(`${PANDORA_BASE_URL}/api/v4/catalog/annotateObjectsSimple`, {
            body: JSON.stringify({ pandoraIds: [id] }),
            headers: this.getHeaders(),
            method: 'POST',
            disableBodyCompression: true
        });
        const trackData = this.parseJsonBody(response.body);
        if (response.error || this.hasApiError(trackData)) {
            return this.buildException(response.error, trackData);
        }
        const keys = Object.keys(trackData ?? {});
        if (keys.length === 0 || !keys[0])
            return { loadType: 'empty', data: {} };
        const item = trackData?.[keys[0]];
        if (!item)
            return { loadType: 'empty', data: {} };
        if (item.type === 'TR') {
            const track = this.buildTrack(item);
            return { loadType: 'track', data: track };
        }
        if (item.type === 'AL' && item.pandoraId) {
            return this.resolveAlbumDetails(item.pandoraId, item.name ?? 'Unknown Album');
        }
        if (item.type === 'AR' && item.pandoraId) {
            return this.resolveArtistDetails(item.pandoraId);
        }
        return { loadType: 'empty', data: {} };
    }
    /**
     * Resolves album details.
     * @param id - Album ID.
     * @param name - Album name.
     * @returns Promise resolving to album tracks.
     * @internal
     */
    async resolveAlbumDetails(id, name) {
        const response = await http1makeRequest(`${PANDORA_BASE_URL}/api/v4/catalog/getDetails`, {
            body: JSON.stringify({ pandoraId: id }),
            headers: this.getHeaders(),
            method: 'POST',
            disableBodyCompression: true
        });
        const data = this.parseJsonBody(response.body);
        if (response.error || data?.errors) {
            return this.buildException(response.error, {
                message: 'Unknown album error'
            });
        }
        const annotations = data?.annotations ?? {};
        const trackKeys = this.limitArray(Object.keys(annotations), this.getMaxPlaylistLength());
        const tracks = trackKeys
            .map((key) => annotations[key])
            .filter((item) => item !== undefined)
            .map((item) => this.buildTrack(item));
        return {
            loadType: 'album',
            data: {
                info: { name, selectedTrack: 0 },
                tracks,
                pluginInfo: {}
            }
        };
    }
    /**
     * Resolves artist top tracks via GraphQL.
     * @param id - Artist ID.
     * @returns Promise resolving to artist tracks.
     * @internal
     */
    async resolveArtistDetails(id) {
        const graphqlQuery = `query GetArtistDetailsWithCuratorsWeb($pandoraId: String!) {
      entity(id: $pandoraId) {
        ... on Artist {
          name
          topTracksWithCollaborations {
            ...TrackFragment
            __typename
          }
          __typename
        }
      }
    }
    fragment ArtFragment on Art {
      artId
      dominantColor
      artUrl: url(size: WIDTH_500)
    }
    fragment TrackFragment on Track {
      pandoraId: id
      type
      name
      duration
      shareableUrlPath: urlPath
      artistName: artist {
        name
        __typename
      }
      icon: art {
        ...ArtFragment
        __typename
      }
    }`;
        const response = await http1makeRequest(`${PANDORA_BASE_URL}/api/v1/graphql/graphql`, {
            body: JSON.stringify({
                operationName: 'GetArtistDetailsWithCuratorsWeb',
                query: graphqlQuery,
                variables: { pandoraId: id }
            }),
            headers: this.getHeaders(),
            method: 'POST',
            disableBodyCompression: true
        });
        const data = this.parseJsonBody(response.body);
        if (response.error || data?.errors) {
            return this.buildException(response.error, {
                message: 'Unknown artist error'
            });
        }
        const topTracks = data?.data?.entity?.topTracksWithCollaborations ?? [];
        const items = this.limitArray(topTracks, this.getMaxPlaylistLength());
        const tracks = items.map((item) => this.buildTrack({
            name: item.name,
            artistName: typeof item.artistName === 'object'
                ? item.artistName?.name
                : item.artistName,
            shareableUrlPath: item.shareableUrlPath,
            icon: item.icon,
            pandoraId: item.pandoraId,
            duration: item.duration
        }));
        const artistName = data?.data?.entity?.name ?? 'Unknown Artist';
        return {
            loadType: 'artist',
            data: {
                info: {
                    name: `${artistName}'s Top Tracks`,
                    selectedTrack: 0
                },
                tracks,
                pluginInfo: {}
            }
        };
    }
    /**
     * Resolves a playlist by ID.
     * @param id - Playlist ID.
     * @returns Promise resolving to playlist tracks.
     * @internal
     */
    async resolvePlaylist(id) {
        const maxLength = this.getMaxPlaylistLength();
        const body = {
            request: {
                pandoraId: id,
                playlistVersion: 0,
                offset: 0,
                limit: maxLength,
                annotationLimit: maxLength,
                allowedTypes: ['TR', 'AM'],
                bypassPrivacyRules: true
            }
        };
        const response = await makeRequest(`${PANDORA_BASE_URL}/api/v7/playlists/getTracks`, {
            method: 'POST',
            headers: this.getHeaders(),
            body,
            disableBodyCompression: true
        });
        if (response.error) {
            return this.buildException(response.error);
        }
        const data = response.body;
        const annotations = data?.annotations ?? {};
        const keys = Object.keys(annotations).filter((key) => key.includes('TR:'));
        const tracks = keys
            .map((key) => annotations[key])
            .filter((item) => item !== undefined)
            .map((item) => this.buildTrack(item));
        return {
            loadType: 'playlist',
            data: {
                info: { name: data?.name ?? 'Playlist', selectedTrack: 0 },
                tracks,
                pluginInfo: {}
            }
        };
    }
    /**
     * Resolves a station by ID.
     * @param id - Station ID.
     * @returns Promise resolving to station tracks.
     * @internal
     */
    async resolveStation(id) {
        const response = await http1makeRequest(`${PANDORA_BASE_URL}/api/v1/station/getStationDetails`, {
            body: JSON.stringify({ stationId: id }),
            headers: this.getHeaders(),
            method: 'POST',
            disableBodyCompression: true
        });
        const stationData = this.parseJsonBody(response.body);
        if (response.error || stationData?.message) {
            return this.buildException(response.error, stationData);
        }
        const tracks = await this.fetchStationTracks(id, stationData);
        return {
            loadType: 'station',
            data: {
                info: { name: stationData?.name ?? 'Station', selectedTrack: 0 },
                tracks,
                pluginInfo: {}
            }
        };
    }
    /**
     * Fetches tracks for a station.
     * @param id - Station ID.
     * @param stationData - Station details.
     * @returns Promise resolving to track array.
     * @internal
     */
    async fetchStationTracks(id, stationData) {
        const tracks = [];
        try {
            const response = await http1makeRequest(`${PANDORA_BASE_URL}/api/v1/playlist/getPlaylist`, {
                body: JSON.stringify({ stationId: id }),
                headers: this.getHeaders(),
                method: 'POST',
                disableBodyCompression: true
            });
            const playlistData = this.parseJsonBody(response.body);
            if (playlistData?.items && Array.isArray(playlistData.items)) {
                for (const item of playlistData.items) {
                    if (!item.songName)
                        continue;
                    tracks.push(this.buildTrack({
                        name: item.songName,
                        artistName: item.artistName,
                        shareableUrlPath: item.songDetailUrl,
                        icon: { artUrl: item.albumArtUrl },
                        pandoraId: item.songId,
                        duration: item.trackLength
                    }));
                }
            }
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            logger('debug', 'Pandora', `Failed to fetch station playlist: ${message}`);
        }
        if (tracks.length === 0 && stationData?.seeds) {
            const seeds = this.limitArray(stationData.seeds, this.getMaxPlaylistLength());
            for (const seed of seeds) {
                if (!seed.song)
                    continue;
                const artUrl = seed.art?.[seed.art.length - 1]?.url;
                tracks.push(this.buildTrack({
                    name: seed.song.songTitle,
                    artistName: seed.song.artistSummary,
                    shareableUrlPath: seed.song.songDetailUrl,
                    icon: { artUrl },
                    pandoraId: seed.song.songId
                }));
            }
        }
        return tracks;
    }
    /**
     * Resolves a podcast by ID.
     * @param id - Podcast ID.
     * @returns Promise resolving to podcast content.
     * @internal
     */
    async resolvePodcast(id) {
        const response = await http1makeRequest(`${PANDORA_BASE_URL}/api/v1/aesop/getDetails`, {
            body: JSON.stringify({ catalogVersion: 4, pandoraId: id }),
            headers: this.getHeaders(),
            method: 'POST',
            disableBodyCompression: true
        });
        const podcastData = this.parseJsonBody(response.body);
        if (response.error || podcastData?.message) {
            return this.buildException(response.error, podcastData);
        }
        const details = podcastData?.details;
        const type = details?.podcastProgramDetails?.type ??
            details?.podcastEpisodeDetails?.type;
        if (type === 'PE') {
            const epId = details?.podcastEpisodeDetails?.pandoraId;
            if (epId && details?.annotations?.[epId]) {
                const ep = details.annotations[epId];
                const track = this.buildTrack(ep);
                return { loadType: 'track', data: track };
            }
        }
        if (type === 'PC') {
            return this.resolvePodcastEpisodes(id);
        }
        return { loadType: 'empty', data: {} };
    }
    /**
     * Resolves podcast episodes.
     * @param id - Podcast program ID.
     * @returns Promise resolving to episode tracks.
     * @internal
     */
    async resolvePodcastEpisodes(id) {
        const idsResponse = await http1makeRequest(`${PANDORA_BASE_URL}/api/v1/aesop/getAllEpisodesByPodcastProgram`, {
            body: JSON.stringify({ catalogVersion: 4, pandoraId: id }),
            headers: this.getHeaders(),
            method: 'POST',
            disableBodyCompression: true
        });
        const idsData = this.parseJsonBody(idsResponse.body);
        if (idsResponse.error || idsData?.message) {
            return this.buildException(idsResponse.error, idsData);
        }
        const episodeLabels = idsData?.episodes?.episodesWithLabel ?? [];
        const allEpisodeIds = this.limitArray(episodeLabels.flatMap((yearInfo) => yearInfo.episodes ?? []), this.getMaxPlaylistLength());
        const episodesResponse = await http1makeRequest(`${PANDORA_BASE_URL}/api/v1/aesop/annotateObjects`, {
            body: JSON.stringify({ catalogVersion: 4, pandoraIds: allEpisodeIds }),
            headers: this.getHeaders(),
            method: 'POST',
            disableBodyCompression: true
        });
        const episodesData = this.parseJsonBody(episodesResponse.body);
        if (episodesResponse.error || episodesData?.message) {
            return this.buildException(episodesResponse.error, episodesData);
        }
        const annotations = episodesData?.annotations ?? {};
        const episodeKeys = Object.keys(annotations);
        const tracks = episodeKeys
            .map((key) => annotations[key])
            .filter((item) => item !== undefined)
            .map((item) => this.buildTrack(item));
        const programId = episodeKeys.find((key) => annotations[key]?.type === 'PC');
        const programName = programId ? annotations[programId]?.name : 'Podcast';
        return {
            loadType: 'podcast',
            data: {
                info: { name: programName ?? 'Podcast', selectedTrack: 0 },
                tracks,
                pluginInfo: {}
            }
        };
    }
    /**
     * Builds a track data object from annotation.
     * @param item - Pandora track annotation.
     * @returns Encoded track data.
     * @internal
     */
    buildTrack(item) {
        const artwork = this.buildArtworkUrl(item.icon?.artUrl);
        const uri = this.buildUri(item.shareableUrlPath ?? item.urlPath);
        const duration = item.duration ?? item.trackLength ?? item.length ?? 0;
        const artistName = typeof item.artistName === 'object'
            ? item.artistName?.name
            : item.artistName;
        const trackInfo = {
            identifier: item.pandoraId ?? item.id ?? 'unknown',
            isSeekable: true,
            author: artistName ?? item.programName ?? 'Unknown Artist',
            length: duration * 1000,
            isStream: false,
            position: 0,
            title: item.name ?? 'Unknown Title',
            uri,
            artworkUrl: artwork,
            isrc: item.isrc ?? null,
            sourceName: 'pandora'
        };
        const encodeInput = { ...trackInfo, details: [] };
        return {
            encoded: encodeTrack(encodeInput),
            info: trackInfo,
            pluginInfo: {}
        };
    }
    /**
     * Resolves a track URL by searching on default source.
     * @param decodedTrack - The decoded track to resolve.
     * @returns Promise resolving to track URL result.
     * @public
     */
    async getTrackUrl(decodedTrack) {
        const query = `${decodedTrack.title} ${decodedTrack.author}`;
        const sources = this.nodelink.sources;
        if (!sources) {
            return {
                exception: {
                    message: 'Source manager is not available.',
                    severity: 'fault'
                }
            };
        }
        try {
            let searchResult = await sources.searchWithDefault(decodedTrack.isrc ? `"${decodedTrack.isrc}"` : query);
            if (searchResult?.loadType !== 'search' ||
                !Array.isArray(searchResult.data) ||
                searchResult.data.length === 0) {
                searchResult = await sources.searchWithDefault(query);
            }
            if (searchResult.loadType !== 'search' ||
                !Array.isArray(searchResult.data) ||
                searchResult.data.length === 0) {
                return {
                    exception: {
                        message: 'No matching track found on default source.',
                        severity: 'common'
                    }
                };
            }
            const candidates = searchResult.data;
            const bestMatch = getBestMatch(candidates, decodedTrack);
            if (!bestMatch) {
                return {
                    exception: {
                        message: 'No suitable alternative found after filtering.',
                        severity: 'common'
                    }
                };
            }
            const trackInfo = bestMatch.info;
            const streamInfo = await sources.getTrackUrl(trackInfo);
            return { newTrack: bestMatch, ...streamInfo };
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            logger('error', 'Pandora', `Failed to mirror track: ${message}`);
            return { exception: { message, severity: 'fault' } };
        }
    }
    /**
     * Direct stream loading is not supported.
     * @returns Exception result.
     * @public
     */
    async loadStream() {
        return {
            exception: {
                message: 'Direct stream loading is not supported by Pandora source.',
                severity: 'common'
            }
        };
    }
    /**
     * Parses JSON body safely.
     * @param body - Response body (string or object).
     * @returns Parsed object or undefined.
     * @internal
     */
    parseJsonBody(body) {
        if (typeof body === 'string') {
            try {
                return JSON.parse(body);
            }
            catch {
                return undefined;
            }
        }
        return body;
    }
    /**
     * Checks if response has API error.
     * @param data - Response data.
     * @returns True if error present.
     * @internal
     */
    hasApiError(data) {
        if (!data || typeof data !== 'object')
            return false;
        return ('message' in data &&
            typeof data.message === 'string');
    }
}
