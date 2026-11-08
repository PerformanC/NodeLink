import { encodeTrack, getBestMatch, http1makeRequest, logger } from '../utils.js';
/**
 * User agent string used for web scraping operations to trigger SSR JSON-LD output.
 * @internal
 */
const BOT_USER_AGENT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
/**
 * User agent string specifically for search operations.
 * @internal
 */
const SEARCH_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';
/**
 * Amazon Music source implementation.
 * Resolves tracks, albums, playlists, and artists from Amazon Music via structured metadata and search scraping.
 * Delegates audio playback to configured default streaming providers via ISRC or title/author matching.
 * @public
 */
export default class AmazonMusicSource {
    /**
     * Declarative test suite for validating Amazon Music source behavior.
     * @public
     */
    static _TESTS = [
        {
            id: 'amazonmusic.track.resolve',
            name: 'Amazon Music Track URL resolution',
            input: {
                type: 'resolve',
                value: 'https://music.amazon.com/tracks/B01DPROY60'
            },
            expect: {
                result: { type: 'track' },
                metadata: {
                    title: { op: 'matches', value: 'Creep' },
                    author: { op: 'matches', value: 'Radiohead' },
                    isrc: { op: 'exists', value: true }
                }
            }
        },
        {
            id: 'amazonmusic.album.resolve',
            name: 'Amazon Music Album URL resolution',
            input: {
                type: 'resolve',
                value: 'https://music.amazon.com/albums/B07SYHQPPD'
            },
            expect: {
                result: { type: 'playlist' },
                collection: {
                    minItems: 10
                },
                metadata: {
                    author: { op: 'matches', value: 'Taylor Swift' }
                }
            }
        },
        {
            id: 'amazonmusic.retail.resolve',
            name: 'Amazon Retail Track URL resolution (/dp/ASIN)',
            input: {
                type: 'resolve',
                value: 'https://www.amazon.com/dp/B01DPROY60'
            },
            expect: {
                result: { type: 'track' },
                metadata: {
                    title: { op: 'matches', value: 'Creep' },
                    author: { op: 'matches', value: 'Radiohead' }
                }
            }
        },
        {
            id: 'amazonmusic.search.amsearch',
            name: 'Amazon Music catalog search (amsearch:)',
            input: {
                type: 'search',
                value: 'Radiohead Creep',
                searchType: 'amsearch'
            },
            expect: {
                result: { type: 'search' },
                collection: {
                    minItems: 1
                },
                metadata: {
                    title: { op: 'matches', value: 'Creep' }
                }
            }
        },
        {
            id: 'amazonmusic.search.azsearch',
            name: 'Amazon Music catalog search (azsearch:)',
            input: {
                type: 'search',
                value: 'Taylor Swift Lover',
                searchType: 'azsearch'
            },
            expect: {
                result: { type: 'search' },
                collection: {
                    minItems: 1
                },
                metadata: {
                    title: { op: 'matches', value: 'Lover' }
                }
            }
        }
    ];
    /**
     * The global worker NodeLink context.
     * @internal
     */
    nodelink;
    /**
     * The configuration bucket for Amazon Music.
     * @internal
     */
    config;
    /**
     * Prefixes used to identify search queries targeting this source.
     * @public
     */
    searchTerms = ['amazonmusic', 'azsearch', 'amsearch'];
    /**
     * Regular expression patterns used to match Amazon Music and Retail URLs.
     * @public
     */
    patterns = [
        /^https?:\/\/music\.amazon\.[a-z.]+\/(?:.*\/)?(track|album|playlist|artist)s?\/([a-z0-9]+)(?:[/?#].*)?$/i,
        /^https?:\/\/(?:www\.)?amazon\.[a-z.]+\/(dp)\/([a-z0-9]+)(?:[/?#].*)?$/i
    ];
    /**
     * Matching priority for this source.
     * @public
     */
    priority = 100;
    /**
     * Constructs a new AmazonMusicSource instance.
     * @param nodelink - The worker NodeLink context.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.config = (nodelink.options.sources?.amazonmusic || {
            enabled: false,
            playlistLoadLimit: 0,
            albumLoadLimit: 0
        });
    }
    /**
     * Performs source-level initialization.
     * @returns A promise resolving to true.
     * @public
     */
    async setup() {
        return true;
    }
    /**
     * Validates whether a candidate URL belongs to Amazon domains.
     * @internal
     */
    _isAmazonUrl(candidate) {
        try {
            const parsed = typeof candidate === 'string' ? new URL(candidate) : candidate;
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                return false;
            }
            const host = parsed.hostname.toLowerCase();
            return (host.startsWith('music.amazon.') ||
                host.startsWith('amazon.') ||
                host.startsWith('www.amazon.'));
        }
        catch {
            return false;
        }
    }
    /**
     * Resolves an Amazon Music URL to its corresponding audio resource.
     * Handles individual tracks, albums, playlists, and artist profiles.
     * @param url - The canonical Amazon Music or Retail URL.
     * @returns A promise resolving to a SourceResult.
     * @public
     */
    async resolve(url) {
        try {
            if (!this._isAmazonUrl(url))
                return { loadType: 'empty', data: {} };
            const pattern1 = this.patterns[0];
            const pattern2 = this.patterns[1];
            if (!pattern1 || !pattern2)
                return { loadType: 'empty', data: {} };
            const match = url.match(pattern1) || url.match(pattern2);
            if (!match)
                return { loadType: 'empty', data: {} };
            let [, type, id] = match;
            if (!id) {
                id = type;
                type = 'track';
            }
            if (!id)
                return { loadType: 'empty', data: {} };
            const trackAsin = this.extractTrackAsinParam(url);
            if (trackAsin)
                return await this.resolveTrack(url, trackAsin);
            if (type === 'track')
                return await this.resolveTrack(url, id);
            if (type === 'album')
                return await this.resolveAlbum(url, id);
            if (type === 'playlist')
                return await this.resolvePlaylist(url, id);
            if (type === 'artist')
                return await this.resolveArtist(url, id);
            if (type === 'dp') {
                const trackRes = await this.resolveTrack(`https://music.amazon.com/tracks/${id}`, id);
                if (trackRes.loadType !== 'empty' && trackRes.loadType !== 'error') {
                    return trackRes;
                }
                return await this.resolveAlbum(`https://music.amazon.com/albums/${id}`, id);
            }
            return { loadType: 'empty', data: {} };
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            logger('error', 'AmazonMusic', `Resolution failed: ${message}`);
            return {
                loadType: 'error',
                exception: { message, severity: 'fault' }
            };
        }
    }
    /**
     * Resolves a single track identifier into normalized metadata.
     * @param url - The track URL.
     * @param id - The track identifier (ASIN).
     * @returns A promise resolving to a SourceResult.
     * @internal
     */
    async resolveTrack(url, id) {
        const data = await this.fetchJsonLd(url, id);
        if (data?.loadType === 'track')
            return data;
        return { loadType: 'empty', data: {} };
    }
    /**
     * Resolves an album URL and returns its track collection.
     * @param url - The album URL.
     * @param id - The album identifier.
     * @returns A promise resolving to a SourceResult.
     * @internal
     */
    async resolveAlbum(url, id) {
        const data = await this.fetchJsonLd(url, id);
        if (data?.loadType === 'playlist')
            return data;
        return { loadType: 'empty', data: {} };
    }
    /**
     * Resolves a playlist URL and returns its track collection.
     * @param url - The playlist URL.
     * @param id - The playlist identifier.
     * @returns A promise resolving to a SourceResult.
     * @internal
     */
    async resolvePlaylist(url, id) {
        const data = await this.fetchJsonLd(url, id);
        if (data?.loadType === 'playlist')
            return data;
        return { loadType: 'empty', data: {} };
    }
    /**
     * Resolves an artist profile URL and returns their top tracks.
     * @param url - The artist URL.
     * @param id - The artist identifier.
     * @returns A promise resolving to a SourceResult.
     * @internal
     */
    async resolveArtist(url, id) {
        const data = await this.fetchJsonLd(url, id);
        if (data?.loadType === 'playlist')
            return data;
        return { loadType: 'empty', data: {} };
    }
    /**
     * Scrapes and parses structured JSON-LD metadata from Amazon Music HTML documents.
     * @param url - The page URL to scrape.
     * @param targetId - Optional identifier to target a specific track within a collection.
     * @returns A promise resolving to a SourceResult or null if scraping failed.
     * @internal
     */
    async fetchJsonLd(url, targetId) {
        if (!this._isAmazonUrl(url))
            return null;
        try {
            const { body, statusCode } = await http1makeRequest(url, {
                headers: {
                    'User-Agent': BOT_USER_AGENT,
                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9'
                },
                shouldFollowRedirect: (nextUrl) => this._isAmazonUrl(nextUrl)
            });
            if (statusCode !== 200 || typeof body !== 'string')
                return null;
            const artworkUrl = this.extractArtworkUrl(body);
            const jsonLdMatches = body.matchAll(/<script [^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
            let collection = null;
            let trackData = null;
            for (const match of jsonLdMatches) {
                try {
                    const content = match[1]
                        ?.replaceAll('&quot;', '"')
                        .replaceAll('&amp;', '&');
                    if (!content)
                        continue;
                    const parsed = JSON.parse(content);
                    const entries = Array.isArray(parsed) ? parsed : [parsed];
                    for (const item of entries) {
                        if (['MusicAlbum', 'MusicGroup', 'Playlist'].includes(item['@type'])) {
                            collection = item;
                        }
                        else if (item['@type'] === 'MusicRecording') {
                            trackData = item;
                        }
                    }
                }
                catch (e) {
                    logger('debug', 'AmazonMusic', `JSON-LD parse error: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            if (collection) {
                const collectionArtist = (Array.isArray(collection.byArtist)
                    ? collection.byArtist[0]?.name
                    : collection.byArtist?.name) ||
                    collection.author?.name ||
                    'Unknown Artist';
                const collectionName = collection.name || collection.title || 'Unknown Collection';
                const collectionImage = collection.image || artworkUrl;
                if (Array.isArray(collection.track) && collection.track.length > 0) {
                    const tracks = [];
                    for (const t of collection.track) {
                        const rawUri = t.url || t['@id'] || url;
                        const tId = this.extractIdentifier(rawUri) ||
                            `am-${Buffer.from(t.name || '').toString('hex')}`;
                        const trackArtist = (Array.isArray(t.byArtist)
                            ? t.byArtist[0]?.name
                            : t.byArtist?.name) ||
                            t.author?.name ||
                            collectionArtist;
                        tracks.push({
                            identifier: tId,
                            isSeekable: true,
                            author: trackArtist,
                            length: this.parseISO8601Duration(t.duration),
                            isStream: false,
                            position: 0,
                            title: t.name || 'Unknown Track',
                            uri: rawUri,
                            artworkUrl: collectionImage,
                            isrc: t.isrcCode || null,
                            sourceName: 'amazonmusic'
                        });
                    }
                    if (targetId) {
                        const selected = tracks.find((t) => t.identifier === targetId ||
                            t.uri.endsWith(`/${targetId}`) ||
                            t.uri.includes(`trackAsin=${targetId}`));
                        if (selected) {
                            return {
                                loadType: 'track',
                                data: {
                                    encoded: encodeTrack({ ...selected, details: [] }),
                                    info: selected,
                                    pluginInfo: {}
                                }
                            };
                        }
                    }
                    if (tracks.length > 0) {
                        return {
                            loadType: 'playlist',
                            data: {
                                info: { name: collectionName, selectedTrack: 0 },
                                tracks: tracks.map((t) => ({
                                    encoded: encodeTrack({ ...t, details: [] }),
                                    info: t,
                                    pluginInfo: {}
                                })),
                                pluginInfo: {}
                            }
                        };
                    }
                }
            }
            if (trackData) {
                const artist = (Array.isArray(trackData.byArtist)
                    ? trackData.byArtist[0]?.name
                    : trackData.byArtist?.name) ||
                    trackData.author?.name ||
                    'Unknown Artist';
                const trackTitle = trackData.name || trackData.title || 'Unknown Track';
                const trackImage = trackData.image || artworkUrl;
                const trackId = targetId ||
                    this.extractIdentifier(trackData.url || trackData['@id'] || url) ||
                    url.split('/').pop() ||
                    'am-unknown';
                return this.buildTrackResult(trackTitle, artist, trackData.url || url, trackImage, trackId, this.parseISO8601Duration(trackData.duration), trackData.isrcCode || null);
            }
        }
        catch (e) {
            logger('debug', 'AmazonMusic', `fetchJsonLd failed for ${url}: ${e instanceof Error ? e.message : String(e)}`);
        }
        return null;
    }
    /**
     * Extracts artwork image URL from page HTML.
     * @param html - Raw page HTML string.
     * @returns Artwork URL or null.
     * @internal
     */
    extractArtworkUrl(html) {
        const m1 = html.match(/<music-detail-header[^>]*image-src="([^"]+)"/i);
        if (m1?.[1])
            return m1[1];
        const m2 = html.match(/<meta [^>]*property="og:image" [^>]*content="([^"]+)"/i);
        if (m2?.[1])
            return m2[1];
        const m3 = html.match(/image-src="([^"]+)"/i);
        if (m3?.[1])
            return m3[1];
        const m4 = html.match(/https:\/\/m\.media-amazon\.com\/images\/I\/[A-Za-z0-9+_-]+\.jpg/i);
        if (m4?.[0])
            return m4[0];
        return null;
    }
    /**
     * Constructs a standardized track result object wrapped in a SourceResult.
     * @param title - The track title.
     * @param author - The track author or artist name.
     * @param url - The track URL.
     * @param image - Optional artwork URL.
     * @param id - Stable track identifier.
     * @param length - Track duration in milliseconds.
     * @param isrc - Optional ISRC code.
     * @returns A SourceResult representing the resolved track.
     * @internal
     */
    buildTrackResult(title, author, url, image, id, length = 0, isrc = null) {
        const info = {
            identifier: id,
            isSeekable: true,
            author: author?.trim() || 'Unknown Artist',
            length,
            isStream: false,
            position: 0,
            title: title?.trim() || 'Unknown Track',
            uri: url,
            artworkUrl: image,
            isrc,
            sourceName: 'amazonmusic'
        };
        return {
            loadType: 'track',
            data: {
                encoded: encodeTrack({ ...info, details: [] }),
                info,
                pluginInfo: {}
            }
        };
    }
    /**
     * Executes a catalog search on Amazon digital music.
     * @param query - The search query string.
     * @returns A promise resolving to a SourceResult containing search hits.
     * @public
     */
    async search(query) {
        try {
            const searchUrl = `https://www.amazon.com/s?k=${encodeURIComponent(query)}&i=digital-music`;
            const res = await http1makeRequest(searchUrl, {
                headers: {
                    'User-Agent': SEARCH_USER_AGENT,
                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9'
                }
            });
            if (res.statusCode !== 200 || typeof res.body !== 'string') {
                return { loadType: 'empty', data: {} };
            }
            const itemRegex = /data-asin="([A-Z0-9]{10})"[\s\S]*?(?:data-asin=|$)/g;
            const tracks = [];
            for (const match of res.body.matchAll(itemRegex)) {
                if (tracks.length >= 10)
                    break;
                const asin = match[1];
                const block = match[0];
                if (asin?.length !== 10)
                    continue;
                const titleMatch = block.match(/<h2[^>]*aria-label="([^"]+)"/i) ||
                    block.match(/<h2[^>]*>(?:<a[^>]*>)?(?:<span[^>]*>)?([^<]+)/i);
                const artistMatch = block.match(/<span[^>]*class="a-size-base">by <\/span><span[^>]*class="a-size-base">([^<]+)<\/span>/i);
                const imgMatch = block.match(/src="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/i);
                if (titleMatch?.[1]) {
                    const rawTitle = titleMatch[1].trim();
                    const rawAuthor = artistMatch?.[1]
                        ? artistMatch[1].trim()
                        : 'Unknown Artist';
                    const artworkUrl = imgMatch?.[1]
                        ? imgMatch[1].replace(/\._[^.]+\./, '.')
                        : null;
                    tracks.push({
                        identifier: asin,
                        isSeekable: true,
                        author: rawAuthor,
                        length: 0,
                        isStream: false,
                        position: 0,
                        title: rawTitle,
                        uri: `https://music.amazon.com/tracks/${asin}`,
                        artworkUrl,
                        isrc: null,
                        sourceName: 'amazonmusic'
                    });
                }
            }
            if (tracks.length === 0)
                return { loadType: 'empty', data: {} };
            return {
                loadType: 'search',
                data: tracks.map((t) => ({
                    encoded: encodeTrack({ ...t, details: [] }),
                    info: t,
                    pluginInfo: {}
                }))
            };
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            logger('debug', 'AmazonMusic', `Search failed: ${message}`);
            return { loadType: 'empty', data: {} };
        }
    }
    /**
     * Resolves a delegated track URL for an Amazon Music resource.
     * Performs a metadata-based mirror search on configured default sources.
     * @param decodedTrack - The Amazon Music track metadata to resolve.
     * @returns A promise resolving to a TrackUrlResult or an error.
     * @public
     */
    async getTrackUrl(decodedTrack) {
        const query = `${decodedTrack.title} ${decodedTrack.author}`;
        const sources = this.nodelink.sources;
        if (!sources) {
            return {
                exception: { message: 'Sources not available.', severity: 'fault' }
            };
        }
        const searchResult = await sources.searchWithDefault(decodedTrack.isrc ? `"${decodedTrack.isrc}"` : query);
        const candidates = searchResult.loadType === 'search' ? searchResult.data : [];
        const bestMatch = getBestMatch(candidates, decodedTrack);
        if (!bestMatch) {
            return {
                exception: {
                    message: 'No suitable alternative stream found.',
                    severity: 'fault'
                }
            };
        }
        const trackUrl = await sources.getTrackUrl(bestMatch.info);
        return {
            newTrack: { info: bestMatch.info },
            ...trackUrl
        };
    }
    /**
     * Direct stream fetching is not supported by the Amazon Music source.
     * @returns A promise resolving to a structured exception.
     * @public
     */
    async loadStream() {
        return {
            exception: {
                message: 'Direct stream loading is not supported by Amazon Music source.',
                severity: 'common'
            }
        };
    }
    /**
     * Extracts the 'trackAsin' parameter from a provided URL string.
     * @param u - The URL to parse.
     * @returns The ASIN string or null if not found.
     * @internal
     */
    extractTrackAsinParam(u) {
        if (!u)
            return null;
        const k = 'trackAsin=';
        const i = u.indexOf(k);
        if (i === -1)
            return null;
        const s = i + k.length;
        let e = u.indexOf('&', s);
        const e2 = u.indexOf('%26', s);
        if (e === -1 || (e2 !== -1 && e2 < e))
            e = e2;
        const h = u.indexOf('#', s);
        if (e === -1 || (h !== -1 && h < e))
            e = h;
        if (e === -1)
            e = u.length;
        return u.slice(s, e) || null;
    }
    /**
     * Extracts a unique resource identifier from an Amazon deeplink or URI.
     * @param deeplink - The deeplink or URL to process.
     * @returns The resource identifier or null if parsing failed.
     * @internal
     */
    extractIdentifier(deeplink) {
        if (!deeplink)
            return null;
        const asin = this.extractTrackAsinParam(deeplink);
        if (asin)
            return asin;
        let end = deeplink.length;
        const q = deeplink.indexOf('?');
        if (q !== -1 && q < end)
            end = q;
        const h = deeplink.indexOf('#');
        if (h !== -1 && h < end)
            end = h;
        const cut = deeplink.lastIndexOf('/', end - 1);
        return deeplink.slice(cut + 1, end) || null;
    }
    /**
     * Parses an ISO 8601 duration string into a millisecond value.
     * @param duration - The ISO 8601 duration string.
     * @returns The total duration in milliseconds.
     * @internal
     */
    parseISO8601Duration(duration) {
        if (!duration)
            return 0;
        const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
        if (!match)
            return 0;
        const hours = Number.parseInt(match[1] || '0', 10);
        const minutes = Number.parseInt(match[2] || '0', 10);
        const seconds = Number.parseInt(match[3] || '0', 10);
        return (hours * 3600 + minutes * 60 + seconds) * 1000;
    }
}
