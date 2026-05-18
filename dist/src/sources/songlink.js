import { encodeTrack, http1makeRequest, logger } from "../utils.js";
const SONG_LINK_PATTERN = /^https?:\/\/(?:www\.)?(song\.link|album\.link|artist\.link|pods\.link|odesli\.co)\/.+/i;
const DEFAULT_PLATFORM_ORDER = [
    'spotify',
    'appleMusic',
    'youtubeMusic',
    'youtube',
    'deezer',
    'tidal',
    'amazonMusic',
    'soundcloud',
    'bandcamp',
    'audius',
    'audiomack',
    'pandora',
    'itunes',
    'amazonStore',
    'google',
    'googleStore',
    'napster',
    'yandex',
    'boomplay',
    'anghami',
    'spinrilla'
];
const PLATFORM_SOURCE_MAP = {
    spotify: 'spotify',
    itunes: 'applemusic',
    appleMusic: 'applemusic',
    youtube: 'youtube',
    youtubeMusic: 'youtube',
    deezer: 'deezer',
    tidal: 'tidal',
    amazonMusic: 'amazonmusic',
    amazonStore: 'amazonmusic',
    soundcloud: 'soundcloud',
    bandcamp: 'bandcamp',
    audius: 'audius',
    audiomack: 'audiomack',
    pandora: 'pandora'
};
const DEFAULT_CACHE_TTL_MS = 1000 * 60 * 60 * 6;
const SCRAPE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
/**
 * Song.link resolver source.
 * @public
 */
export default class SongLinkSource {
    /**
     * Runtime NodeLink context.
     */
    nodelink;
    /**
     * Raw source configuration block.
     */
    config;
    /**
     * Search aliases supported by this source.
     */
    searchTerms;
    /**
     * URL patterns handled by this source.
     */
    patterns;
    /**
     * URL resolution priority.
     */
    priority;
    /**
     * Optional Song.link API key.
     */
    apiKey;
    /**
     * Preferred request country.
     */
    userCountry;
    /**
     * Whether single links should resolve as songs.
     */
    songIfSingle;
    /**
     * Platform preference order.
     */
    preferredPlatforms;
    /**
     * Whether any remaining platform can be used.
     */
    fallbackToAny;
    /**
     * Cache TTL in milliseconds.
     */
    cacheTtlMs;
    /**
     * Whether HTML fallback is enabled.
     */
    useScrapeFallback;
    /**
     * Whether API resolution is enabled.
     */
    useApi;
    /**
     * Creates a Song.link source instance.
     * @param nodelink - Runtime NodeLink context.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        const sourceConfig = this.nodelink.options.sources?.songlink;
        this.config =
            sourceConfig && typeof sourceConfig === 'object'
                ? sourceConfig
                : {};
        this.searchTerms = ['slsearch'];
        this.patterns = [SONG_LINK_PATTERN];
        this.priority = 95;
        this.apiKey = null;
        this.userCountry = 'US';
        this.songIfSingle = true;
        this.preferredPlatforms = [...DEFAULT_PLATFORM_ORDER];
        this.fallbackToAny = true;
        this.cacheTtlMs = DEFAULT_CACHE_TTL_MS;
        this.useScrapeFallback = true;
        this.useApi = true;
    }
    /**
     * Initializes Song.link source options.
     * @returns Always true.
     */
    async setup() {
        this.apiKey = this.asString(this.config.apiKey);
        this.userCountry = this.asString(this.config.userCountry) ?? 'US';
        this.songIfSingle = this.asBoolean(this.config.songIfSingle) ?? true;
        this.preferredPlatforms = Array.isArray(this.config.preferredPlatforms)
            ? this.config.preferredPlatforms.filter((item) => typeof item === 'string')
            : [...DEFAULT_PLATFORM_ORDER];
        this.fallbackToAny = this.asBoolean(this.config.fallbackToAny) ?? true;
        this.useScrapeFallback =
            this.asBoolean(this.config.useScrapeFallback) ?? true;
        this.useApi = this.asBoolean(this.config.useApi) ?? true;
        return true;
    }
    /**
     * Resolves Song.link URLs to supported platform results.
     * @param url - Song.link URL.
     * @returns Source resolution result.
     */
    async resolve(url) {
        try {
            const cached = this.nodelink.trackCacheManager?.get('songlink', url);
            if (cached)
                return cached;
            const data = await this._fetchSongLinkData(url);
            const linksByPlatform = this.asRecord(data?.linksByPlatform) || {};
            if (Object.keys(linksByPlatform).length === 0) {
                return { loadType: 'empty', data: {} };
            }
            const platforms = this._buildPlatformOrder(linksByPlatform);
            const songlinkInfo = {
                pageUrl: this.asString(data?.pageUrl) || undefined,
                entityUniqueId: this.asString(data?.entityUniqueId) || undefined,
                userCountry: this.asString(data?.userCountry) || undefined,
                linksByPlatform
            };
            for (const platform of platforms) {
                const platformData = this.asRecord(linksByPlatform[platform]);
                const link = this.asString(platformData?.url);
                if (!link)
                    continue;
                const sourceName = PLATFORM_SOURCE_MAP[platform];
                if (!sourceName || !this._isSourceAvailable(sourceName))
                    continue;
                try {
                    const result = await this.nodelink.sources.resolve(link);
                    if (result.loadType &&
                        result.loadType !== 'empty' &&
                        result.loadType !== 'error') {
                        const decorated = this._decorateResult(result, songlinkInfo, platform, link);
                        this.nodelink.trackCacheManager?.set('songlink', url, decorated, this.cacheTtlMs);
                        return decorated;
                    }
                }
                catch (error) {
                    logger('debug', 'SongLink', `Failed to resolve ${platform} link: ${this.getErrorMessage(error)}`);
                }
            }
            return {
                loadType: 'error',
                exception: {
                    message: 'No supported platform links found for this Song.link URL.',
                    severity: 'fault'
                }
            };
        }
        catch (error) {
            const message = this.getErrorMessage(error);
            logger('error', 'SongLink', `Resolution failed: ${message}`);
            return {
                loadType: 'error',
                exception: { message, severity: 'fault' }
            };
        }
    }
    /**
     * Performs Song.link-backed iTunes search.
     * @param query - Search query.
     * @param _sourceTerm - Ignored source alias.
     * @param _searchType - Ignored search type.
     * @returns Search result payload.
     */
    async search(query, _sourceTerm, _searchType = 'track') {
        try {
            const maxSearchRaw = this.nodelink.options.search.maxResults;
            const limit = typeof maxSearchRaw === 'number' && Number.isFinite(maxSearchRaw)
                ? maxSearchRaw
                : 10;
            const searchUrl = new URL('https://itunes.apple.com/search');
            searchUrl.searchParams.set('term', query);
            searchUrl.searchParams.set('country', this.userCountry || 'US');
            searchUrl.searchParams.set('entity', 'song,album,podcast,podcastEpisode');
            searchUrl.searchParams.set('limit', String(limit));
            searchUrl.searchParams.set('callback', '__jp33');
            const { body, statusCode } = await http1makeRequest(searchUrl.toString());
            if (statusCode !== 200)
                return { loadType: 'empty', data: {} };
            const payload = typeof body === 'string' ? this._parseJsonp(body) : this.asRecord(body);
            const results = payload?.results;
            if (!Array.isArray(results) || results.length === 0) {
                return { loadType: 'empty', data: {} };
            }
            const tracks = [];
            for (const rawItem of results) {
                const item = this.asRecord(rawItem);
                if (!item)
                    continue;
                const trackId = item.trackId;
                if (trackId === undefined || trackId === null)
                    continue;
                const kind = this.asString(item.kind) ?? this.asString(item.wrapperType);
                const wrapper = this.asString(item.wrapperType) ?? '';
                const isSong = kind === 'song';
                const isPodcastEpisode = kind === 'podcast-episode' || wrapper === 'podcastEpisode';
                const isPodcast = kind === 'podcast' || wrapper === 'track';
                if (!isSong && !isPodcastEpisode && !isPodcast)
                    continue;
                const episodeUrl = this.asString(item.episodeUrl);
                const previewUrl = this.asString(item.previewUrl);
                const feedUrl = this.asString(item.feedUrl);
                const fallbackUrl = this.asString(item.trackViewUrl) ||
                    this.asString(item.collectionViewUrl);
                const uri = (isPodcastEpisode ? episodeUrl || previewUrl : null) ||
                    (isPodcast ? feedUrl : null) ||
                    fallbackUrl;
                if (!uri)
                    continue;
                const trackInfo = {
                    identifier: String(trackId),
                    isSeekable: true,
                    author: this.asString(item.artistName) ||
                        this.asString(item.collectionArtistName) ||
                        this.asString(item.artistViewUrl) ||
                        'Unknown Artist',
                    length: this.asNumber(item.trackTimeMillis) ?? 0,
                    isStream: false,
                    position: 0,
                    title: this.asString(item.trackName) ||
                        this.asString(item.collectionName) ||
                        'Unknown Title',
                    uri,
                    artworkUrl: this.asString(item.artworkUrl600) ||
                        this.asString(item.artworkUrl100) ||
                        this.asString(item.artworkUrl60) ||
                        null,
                    isrc: this.asString(item.isrc) || null,
                    sourceName: 'songlink'
                };
                const encodedInput = { ...trackInfo, details: [] };
                tracks.push({
                    encoded: encodeTrack(encodedInput),
                    info: trackInfo,
                    pluginInfo: {
                        kind: kind || wrapper || 'track',
                        feedUrl: feedUrl || null
                    }
                });
            }
            if (tracks.length === 0)
                return { loadType: 'empty', data: {} };
            return { loadType: 'search', data: tracks };
        }
        catch (error) {
            const message = this.getErrorMessage(error);
            logger('error', 'SongLink', `Search failed: ${message}`);
            return { loadType: 'error', exception: { message, severity: 'fault' } };
        }
    }
    /**
     * Exposes raw Song.link payload fetch.
     * @param url - Song.link URL.
     * @returns Raw payload object.
     */
    async getSongLinkData(url) {
        return this._fetchSongLinkData(url);
    }
    /**
     * Exposes platform ordering utility.
     * @param linksByPlatform - Platform map.
     * @returns Ordered platform list.
     */
    getPlatformOrder(linksByPlatform = {}) {
        return this._buildPlatformOrder(linksByPlatform);
    }
    /**
     * Returns mapped source name for a Song.link platform key.
     * @param platform - Song.link platform key.
     * @returns NodeLink source name or null.
     */
    getPlatformSourceName(platform) {
        return (PLATFORM_SOURCE_MAP[platform] || null);
    }
    /**
     * Delegates stream URL resolution from resolved Song.link track URI.
     * @param decodedTrack - Decoded track metadata.
     * @returns Track URL result or exception.
     */
    async getTrackUrl(decodedTrack) {
        try {
            const uri = decodedTrack.uri;
            if (!uri) {
                return {
                    exception: { message: 'Missing track URL.', severity: 'common' }
                };
            }
            const resolved = await this.nodelink.sources.resolve(uri);
            if (resolved.loadType === 'track' &&
                this.isTrackResultData(resolved.data)) {
                const streamInfo = await this.nodelink.sources.getTrackUrl(resolved.data.info);
                return { newTrack: resolved.data, ...streamInfo };
            }
            return {
                exception: {
                    message: 'Resolved URL did not return a playable track.',
                    severity: 'common'
                }
            };
        }
        catch (error) {
            return {
                exception: {
                    message: this.getErrorMessage(error),
                    severity: 'fault'
                }
            };
        }
    }
    /**
     * Fetches Song.link payload from API or HTML fallback.
     * @param url - Song.link URL.
     * @returns Parsed Song.link payload.
     */
    async _fetchSongLinkData(url) {
        if (this.useApi) {
            try {
                const apiUrl = new URL('https://api.song.link/v1-alpha.1/links');
                apiUrl.searchParams.set('url', url);
                if (this.userCountry) {
                    apiUrl.searchParams.set('userCountry', this.userCountry);
                }
                if (this.songIfSingle) {
                    apiUrl.searchParams.set('songIfSingle', 'true');
                }
                if (this.apiKey) {
                    apiUrl.searchParams.set('key', this.apiKey);
                }
                const { body, statusCode } = await http1makeRequest(apiUrl.toString());
                const parsed = this.asRecord(body);
                const linksByPlatform = this.asRecord(parsed?.linksByPlatform);
                if (statusCode === 200 && linksByPlatform) {
                    return parsed;
                }
            }
            catch (error) {
                logger('debug', 'SongLink', `API failed: ${this.getErrorMessage(error)}`);
            }
        }
        if (!this.useScrapeFallback)
            return null;
        return this._fetchFromHtml(url);
    }
    /**
     * Parses JSONP response text.
     * @param text - JSONP payload.
     * @returns Parsed object payload.
     */
    _parseJsonp(text) {
        const start = text.indexOf('(');
        const end = text.lastIndexOf(')');
        if (start === -1 || end === -1 || end <= start)
            return null;
        const json = text.slice(start + 1, end);
        try {
            return this.asRecord(JSON.parse(json));
        }
        catch {
            return null;
        }
    }
    /**
     * Fetches Song.link payload from HTML page.
     * @param url - Song.link URL.
     * @returns Parsed payload.
     */
    async _fetchFromHtml(url) {
        try {
            const { body, statusCode } = await http1makeRequest(url, {
                headers: { 'User-Agent': SCRAPE_USER_AGENT }
            });
            if (statusCode !== 200 || typeof body !== 'string')
                return null;
            const nextDataMatch = body.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
            if (!nextDataMatch?.[1])
                return null;
            const parsed = JSON.parse(nextDataMatch[1]);
            const payload = this._findSonglinkPayload(parsed);
            return this.asRecord(payload?.linksByPlatform) ? payload : null;
        }
        catch (error) {
            logger('debug', 'SongLink', `HTML scrape failed: ${this.getErrorMessage(error)}`);
            return null;
        }
    }
    /**
     * Finds Song.link payload in a nested object tree.
     * @param root - Root object.
     * @returns Payload object.
     */
    _findSonglinkPayload(root) {
        const derived = this._extractFromNextData(root);
        if (derived)
            return derived;
        const stack = [root];
        let visited = 0;
        const maxNodes = 10000;
        while (stack.length > 0 && visited < maxNodes) {
            const current = stack.pop();
            visited++;
            const currentObject = this.asRecord(current);
            if (!currentObject)
                continue;
            if (this.asRecord(currentObject.linksByPlatform) &&
                this.asRecord(currentObject.entitiesByUniqueId)) {
                return currentObject;
            }
            for (const value of Object.values(currentObject)) {
                if (Array.isArray(value)) {
                    for (const item of value)
                        stack.push(item);
                }
                else if (value && typeof value === 'object') {
                    stack.push(value);
                }
            }
        }
        return null;
    }
    /**
     * Extracts Song.link payload from Next.js data tree.
     * @param root - Next.js root object.
     * @returns Normalized payload.
     */
    _extractFromNextData(root) {
        const rootObject = this.asRecord(root);
        const props = this.asRecord(rootObject?.props);
        const pageProps = this.asRecord(props?.pageProps);
        const pageData = this.asRecord(pageProps?.pageData);
        if (!pageData)
            return null;
        const sections = pageData?.sections;
        if (!Array.isArray(sections))
            return null;
        const linksByPlatform = {};
        let userCountry = this.userCountry || 'US';
        for (const sectionItem of sections) {
            const section = this.asRecord(sectionItem);
            const links = section?.links;
            if (!Array.isArray(links))
                continue;
            for (const linkItem of links) {
                const link = this.asRecord(linkItem);
                if (!link)
                    continue;
                const platform = this.asString(link.platform);
                const url = this.asString(link.url);
                if (!platform || !url || link.show === false)
                    continue;
                linksByPlatform[platform] = {
                    url,
                    nativeAppUriMobile: this.asString(link.nativeAppUriMobile) || undefined,
                    nativeAppUriDesktop: this.asString(link.nativeAppUriDesktop) || undefined,
                    entityUniqueId: this.asString(link.uniqueId) || undefined
                };
                const country = this.asString(link.country);
                if (country)
                    userCountry = country;
            }
        }
        if (Object.keys(linksByPlatform).length === 0)
            return null;
        const entitiesByUniqueId = {};
        const entityId = this.asString(pageData.entityUniqueId);
        const entityData = this.asRecord(pageData.entityData);
        if (entityId && entityData) {
            const durationRaw = this.asNumber(entityData.duration);
            entitiesByUniqueId[entityId] = {
                id: entityData.id,
                type: this.asString(entityData.type) || undefined,
                title: this.asString(entityData.title) || undefined,
                artistName: this.asString(entityData.artistName) || undefined,
                thumbnailUrl: this.asString(entityData.thumbnailUrl) || undefined,
                duration: durationRaw !== null ? durationRaw / 1000 : undefined,
                isrc: this.asString(entityData.isrc) || null
            };
        }
        return {
            entityUniqueId: entityId || undefined,
            userCountry,
            pageUrl: this.asString(pageData.pageUrl) ||
                this.asString(pageProps?.pageUrl) ||
                undefined,
            linksByPlatform,
            entitiesByUniqueId
        };
    }
    /**
     * Builds ordered platform candidates.
     * @param linksByPlatform - Platform map.
     * @returns Ordered platform list.
     */
    _buildPlatformOrder(linksByPlatform) {
        const available = Object.keys(linksByPlatform || {});
        if (available.length === 0)
            return [];
        const ordered = [];
        const seen = new Set();
        const base = this.preferredPlatforms.length > 0
            ? this.preferredPlatforms
            : DEFAULT_PLATFORM_ORDER;
        for (const platform of base) {
            if (available.includes(platform) && !seen.has(platform)) {
                ordered.push(platform);
                seen.add(platform);
            }
        }
        if (this.fallbackToAny) {
            for (const platform of available) {
                if (!seen.has(platform)) {
                    ordered.push(platform);
                    seen.add(platform);
                }
            }
        }
        return ordered;
    }
    /**
     * Checks whether a mapped source is enabled and loaded.
     * @param sourceName - Source name.
     * @returns True when source can be used.
     */
    _isSourceAvailable(sourceName) {
        const sourceConfig = this.nodelink.options.sources?.[sourceName];
        if (!sourceConfig?.enabled)
            return false;
        return !!this.nodelink.sources.getSource(sourceName);
    }
    /**
     * Attaches Song.link metadata to resolved results.
     * @param result - Result payload.
     * @param songlinkInfo - Song.link metadata.
     * @param platform - Selected platform.
     * @param url - Selected URL.
     * @returns Decorated result.
     */
    _decorateResult(result, songlinkInfo, platform, url) {
        const extraInfo = {
            ...songlinkInfo,
            selectedPlatform: platform,
            selectedUrl: url
        };
        if (result.loadType === 'track' && this.isTrackResultData(result.data)) {
            result.data.pluginInfo = {
                ...(this.asRecord(result.data.pluginInfo) || {}),
                songlink: extraInfo
            };
        }
        else if (result.loadType === 'playlist' &&
            this.asRecord(result.data) !== null) {
            const playlist = this.asRecord(result.data);
            if (playlist) {
                playlist.pluginInfo = {
                    ...(this.asRecord(playlist.pluginInfo) || {}),
                    songlinkUrl: url
                };
            }
        }
        return result;
    }
    /**
     * Validates track result payload shape.
     * @param data - Unknown data payload.
     * @returns True when payload is track result data.
     */
    isTrackResultData(data) {
        const record = this.asRecord(data);
        const info = this.asRecord(record?.info);
        return (record !== null &&
            info !== null &&
            typeof info.identifier === 'string' &&
            typeof info.title === 'string' &&
            typeof info.author === 'string' &&
            typeof info.length === 'number' &&
            typeof info.uri === 'string' &&
            typeof info.sourceName === 'string');
    }
    /**
     * Converts unknown value into a record object.
     * @param value - Unknown value.
     * @returns Record object or null.
     */
    asRecord(value) {
        return value && typeof value === 'object' && !Array.isArray(value)
            ? value
            : null;
    }
    /**
     * Converts unknown value into string.
     * @param value - Unknown value.
     * @returns String value or null.
     */
    asString(value) {
        return typeof value === 'string' ? value : null;
    }
    /**
     * Converts unknown value into number.
     * @param value - Unknown value.
     * @returns Number value or null.
     */
    asNumber(value) {
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }
    /**
     * Converts unknown value into boolean.
     * @param value - Unknown value.
     * @returns Boolean value or null.
     */
    asBoolean(value) {
        return typeof value === 'boolean' ? value : null;
    }
    /**
     * Normalizes unknown errors to message strings.
     * @param error - Unknown error.
     * @returns Error message string.
     */
    getErrorMessage(error) {
        return error instanceof Error ? error.message : String(error);
    }
}
