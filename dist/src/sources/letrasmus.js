import { encodeTrack, getBestMatch, http1makeRequest, logger } from "../utils.js";
const LETRAS_PATTERN = /^https?:\/\/(?:www\.)?letras\.(?:mus\.br|com)\/[a-z0-9-]+\/[^/]+\/?/i;
const ARTIST_PATTERN = /^https?:\/\/(?:www\.)?letras\.(?:mus\.br|com)\/([a-z0-9-]+)\//i;
const SOLR_ENDPOINT = 'https://solr.sscdn.co/letras/m1/';
const RECOMMENDATION_ENDPOINT = 'https://api.letras.mus.br/v2/playlists/radio';
/**
 * Decodes the small subset of HTML entities used by LetrasMus pages.
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
 * Parses a JSONP response returned by the LetrasMus Solr endpoint.
 *
 * @param body Raw response body.
 * @returns Parsed JSON value or `null` when parsing fails.
 */
function parseJsonp(body) {
    const trimmed = body.trim();
    if (!trimmed)
        return null;
    try {
        if (trimmed.startsWith('LetrasSug(') && trimmed.endsWith(')')) {
            return JSON.parse(trimmed.slice('LetrasSug('.length, -1));
        }
        const start = trimmed.indexOf('(');
        const end = trimmed.lastIndexOf(')');
        if (start !== -1 && end > start) {
            return JSON.parse(trimmed.slice(start + 1, end));
        }
        return JSON.parse(trimmed);
    }
    catch {
        return null;
    }
}
/**
 * Extracts a meta-property content value from a LetrasMus page.
 *
 * @param html Raw page HTML.
 * @param property Open Graph property name to search.
 * @returns The decoded meta content, or `null` when absent.
 */
function extractMeta(html, property) {
    const re1 = new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i');
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["'][^>]*>`, 'i');
    const match = html.match(re1) || html.match(re2);
    return match?.[1] ? decodeHtml(match[1]) : null;
}
/**
 * Extracts the canonical URL from a LetrasMus page.
 *
 * @param html Raw page HTML.
 * @returns The canonical URL when available.
 */
function extractCanonicalUrl(html) {
    const linkMatch = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>/i);
    if (linkMatch?.[1]) {
        return decodeHtml(linkMatch[1]);
    }
    return extractMeta(html, 'og:url');
}
/**
 * Extracts the `_omq.push(['ui/lyric', ...])` payload embedded in a LetrasMus
 * page.
 *
 * @param html Raw page HTML.
 * @returns Parsed lyric metadata or `null` when the payload is absent.
 */
function extractOmqLyric(html) {
    const match = html.match(/_omq\.push\(\['ui\/lyric',\s*({[\s\S]*?})\s*,/i);
    if (!match?.[1])
        return null;
    try {
        return JSON.parse(match[1]);
    }
    catch {
        return null;
    }
}
/**
 * Builds a public LetrasMus track URL from the artist and song slugs returned
 * by the APIs.
 *
 * @param dns Artist slug.
 * @param url Song slug.
 * @returns The canonical public track URL.
 */
function buildTrackUrl(dns, url) {
    return `https://www.letras.mus.br/${dns}/${url}/`;
}
/**
 * LetrasMus source implementation.
 */
export default class LetrasMusSource {
    /**
     * Runtime worker context used by the source implementation.
     */
    nodelink;
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
     * Recommendation aliases handled by this source.
     */
    recommendationTerm;
    /**
     * Maximum number of search results returned by the source.
     */
    maxSearchResults;
    /**
     * Creates a new LetrasMus source wrapper.
     *
     * @param nodelink Worker runtime used by the source implementation.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.priority = 40;
        this.searchTerms = ['lmsearch'];
        this.recommendationTerm = ['lmrec'];
        this.patterns = [LETRAS_PATTERN];
        const options = nodelink.options;
        this.maxSearchResults =
            typeof options.maxSearchResults === 'number' &&
                Number.isInteger(options.maxSearchResults) &&
                options.maxSearchResults > 0
                ? options.maxSearchResults
                : 10;
    }
    /**
     * Announces the source during worker initialization.
     *
     * @returns `true` when the source is ready to accept requests.
     */
    async setup() {
        logger('info', 'Sources', 'Loaded LetrasMus source.');
        return true;
    }
    /**
     * Checks whether a URL belongs to a supported LetrasMus page.
     *
     * @param link Candidate URL.
     * @returns `true` when the URL matches the LetrasMus pattern.
     */
    isLinkMatch(link) {
        return LETRAS_PATTERN.test(link);
    }
    /**
     * Searches LetrasMus or returns radio-style recommendations depending on the
     * alias used by the source manager.
     *
     * @param query Search query or reference URL.
     * @param sourceTerm Search alias provided by the source manager.
     * @returns Search results, an empty payload, or a structured exception.
     */
    async search(query, sourceTerm) {
        try {
            if (sourceTerm === 'lmrec') {
                return await this.recommend(query);
            }
            const tracks = await this.searchSolr(query);
            return tracks.length > 0
                ? { loadType: 'search', data: tracks }
                : { loadType: 'empty', data: {} };
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
     * Resolves a LetrasMus page into a metadata-only track and attempts to enrich
     * duration and artwork using the linked YouTube video when available.
     *
     * @param url Public LetrasMus page URL.
     * @returns A track, an empty payload, or a structured exception.
     */
    async resolve(url) {
        if (!LETRAS_PATTERN.test(url)) {
            return { loadType: 'empty', data: {} };
        }
        try {
            const { body, statusCode, error } = await http1makeRequest(url, {
                method: 'GET'
            });
            const html = this.getTextBody({ body });
            if (error || statusCode !== 200 || !html) {
                return {
                    exception: {
                        message: `Failed to fetch Letras page: ${error ?? statusCode}`,
                        severity: 'fault'
                    }
                };
            }
            const omq = extractOmqLyric(html);
            const title = omq?.Name || extractMeta(html, 'og:title') || 'Unknown';
            const author = omq?.Artist || 'Unknown';
            const artworkUrl = extractMeta(html, 'og:image');
            const youtubeId = omq?.YoutubeID || null;
            const canonical = extractCanonicalUrl(html) || url;
            let length = 0;
            let finalArtwork = artworkUrl || null;
            if (youtubeId) {
                try {
                    const youtubeUrl = `https://www.youtube.com/watch?v=${youtubeId}`;
                    const youtubeResult = await this.getSourceManager()?.resolve(youtubeUrl);
                    const youtubeTrack = youtubeResult
                        ? this.extractTrackFromResolveResult(youtubeResult)
                        : null;
                    if (youtubeTrack) {
                        if (Number.isFinite(youtubeTrack.info.length)) {
                            length = youtubeTrack.info.length;
                        }
                        if (!finalArtwork && youtubeTrack.info.artworkUrl) {
                            finalArtwork = youtubeTrack.info.artworkUrl;
                        }
                    }
                }
                catch { }
            }
            return {
                loadType: 'track',
                data: this.buildTrack({
                    identifier: canonical,
                    author,
                    length,
                    title,
                    uri: canonical,
                    artworkUrl: finalArtwork
                })
            };
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
     * Resolves a playable stream for a LetrasMus track by preferring the linked
     * YouTube id from the page and otherwise falling back to a search match.
     *
     * @param decodedTrack Decoded LetrasMus track information.
     * @returns Delegated track URL metadata or a structured exception.
     */
    async getTrackUrl(decodedTrack) {
        const sourceManager = this.getSourceManager();
        if (!sourceManager) {
            return {
                exception: {
                    message: 'Source manager is not available for LetrasMus resolution.',
                    severity: 'fault'
                }
            };
        }
        try {
            const youtubeId = decodedTrack.uri
                ? await this.resolveYoutubeIdFromPage(decodedTrack.uri)
                : null;
            if (youtubeId) {
                const youtubeUrl = `https://www.youtube.com/watch?v=${youtubeId}`;
                const youtubeResult = await sourceManager.resolve(youtubeUrl);
                const youtubeTrack = this.extractTrackFromResolveResult(youtubeResult);
                if (youtubeTrack) {
                    const streamInfo = await sourceManager.getTrackUrl(youtubeTrack.info);
                    return { newTrack: youtubeTrack, ...streamInfo };
                }
            }
            const query = `${decodedTrack.title} ${decodedTrack.author}`.trim();
            let searchResult = await sourceManager.search('ytmsearch', query);
            let searchTracks = searchResult.data;
            if (searchResult.loadType !== 'search' ||
                !this.isTrackDataArray(searchTracks)) {
                searchResult = await sourceManager.searchWithDefault(query);
                searchTracks = searchResult.data;
            }
            if (searchResult.loadType !== 'search' ||
                !this.isTrackDataArray(searchTracks) ||
                searchTracks.length === 0) {
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
            throw new Error('Source manager is not available for LetrasMus streaming');
        }
        return sourceManager.getTrackStream(track, url, protocol, additionalData);
    }
    /**
     * Searches the LetrasMus Solr endpoint and maps the response into encoded
     * track stubs.
     *
     * @param query Search query.
     * @returns Encoded track stubs returned by the Solr endpoint.
     */
    async searchSolr(query) {
        const url = `${SOLR_ENDPOINT}?q=${encodeURIComponent(query)}&wt=json&callback=LetrasSug`;
        const { body, statusCode, error } = await http1makeRequest(url, {
            method: 'GET'
        });
        const text = this.getTextBody({ body });
        if (error || statusCode !== 200 || !text) {
            throw new Error(`Letras search failed: ${error ?? statusCode}`);
        }
        const parsed = parseJsonp(text);
        const responseRecord = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? this.getRecordFromValue(parsed)
            : null;
        const responseData = responseRecord
            ? this.getRecord(responseRecord, 'response')
            : null;
        const docs = responseData ? this.getArray(responseData, 'docs') : [];
        return docs
            .map((value) => this.toSolrDoc(value))
            .filter((doc) => doc !== null)
            .filter((doc) => doc.t === '2' && !!doc.dns && !!doc.url)
            .slice(0, this.maxSearchResults)
            .map((doc) => {
            const uri = buildTrackUrl(doc.dns, doc.url);
            return this.buildTrack({
                identifier: uri,
                author: doc.art || 'Unknown',
                length: 0,
                title: doc.txt || 'Unknown',
                uri,
                artworkUrl: doc.img || null
            });
        });
    }
    /**
     * Returns recommendation tracks for the artist associated with the query or
     * page URL.
     *
     * @param query Search query or LetrasMus URL.
     * @returns Search results, an empty payload, or a structured exception.
     */
    async recommend(query) {
        let artistSlug = query.match(ARTIST_PATTERN)?.[1] || null;
        if (!artistSlug) {
            try {
                const searchTracks = await this.searchSolr(query);
                const firstUri = searchTracks[0]?.info.uri;
                artistSlug = firstUri?.match(ARTIST_PATTERN)?.[1] || null;
            }
            catch { }
        }
        if (!artistSlug) {
            return { loadType: 'empty', data: {} };
        }
        const recUrl = `${RECOMMENDATION_ENDPOINT}/${artistSlug}/`;
        const { body, statusCode, error } = await http1makeRequest(recUrl, {
            method: 'GET'
        });
        const payload = body &&
            typeof body === 'object' &&
            !Array.isArray(body) &&
            !Buffer.isBuffer(body)
            ? body
            : null;
        if (error || statusCode !== 200 || !payload) {
            return {
                exception: {
                    message: `Letras recommendation failed: ${error ?? statusCode}`,
                    severity: 'fault'
                }
            };
        }
        const songList = this.getArray(payload, 'SongList');
        const tracks = songList
            .map((item) => this.toRecommendationItem(item))
            .filter((item) => item !== null)
            .filter((item) => !!item.DNS && !!item.URL)
            .slice(0, this.maxSearchResults)
            .map((item) => {
            const uri = buildTrackUrl(item.DNS, item.URL);
            return this.buildTrack({
                identifier: uri,
                author: item.Artist || 'Unknown',
                length: 0,
                title: item.Name || 'Unknown',
                uri,
                artworkUrl: null
            });
        });
        if (tracks.length === 0) {
            return { loadType: 'empty', data: {} };
        }
        return { loadType: 'search', data: tracks };
    }
    /**
     * Fetches a LetrasMus page and extracts the linked YouTube id from the
     * embedded lyric metadata.
     *
     * @param url LetrasMus page URL.
     * @returns The linked YouTube id or `null`.
     */
    async resolveYoutubeIdFromPage(url) {
        try {
            const { body, statusCode, error } = await http1makeRequest(url, {
                method: 'GET'
            });
            const html = this.getTextBody({ body });
            if (error || statusCode !== 200 || !html) {
                return null;
            }
            return extractOmqLyric(html)?.YoutubeID || null;
        }
        catch {
            return null;
        }
    }
    /**
     * Builds an encoded LetrasMus track payload.
     *
     * @param input Track fields collected from page resolution or search results.
     * @returns An encoded LetrasMus track entry.
     */
    buildTrack(input) {
        const info = {
            identifier: input.identifier,
            isSeekable: true,
            author: input.author,
            length: input.length,
            isStream: false,
            position: 0,
            title: input.title,
            uri: input.uri,
            artworkUrl: input.artworkUrl,
            isrc: null,
            sourceName: 'letrasmus',
            details: []
        };
        return {
            encoded: encodeTrack(info),
            info,
            pluginInfo: {}
        };
    }
    /**
     * Extracts a single track from a delegated resolve result, supporting direct
     * track responses and the first track inside playlists.
     *
     * @param result Delegated source result.
     * @returns A usable track entry or `null`.
     */
    extractTrackFromResolveResult(result) {
        const trackData = result.data;
        if (result.loadType === 'track' && this.isTrackData(trackData)) {
            return trackData;
        }
        const playlistData = result.data;
        if (result.loadType === 'playlist' &&
            this.isPlaylistData(playlistData) &&
            playlistData.tracks.length > 0) {
            return playlistData.tracks[0] ?? null;
        }
        return null;
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
     * Reads an array property from a JSON record.
     *
     * @param record Source record.
     * @param key Property name to read.
     * @returns The nested array or an empty array when the property is not an array.
     */
    getArray(record, key) {
        const value = record[key];
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
        const value = record[key];
        if (typeof value === 'string') {
            return value;
        }
        if (typeof value === 'number') {
            return String(value);
        }
        return null;
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
     * Narrows a raw Solr response value to the subset used by this source.
     *
     * @param value Raw Solr item.
     * @returns A narrowed Solr document or `null`.
     */
    toSolrDoc(value) {
        const record = this.getRecordFromValue(value);
        if (!record) {
            return null;
        }
        return {
            t: this.getString(record, 't'),
            dns: this.getString(record, 'dns'),
            url: this.getString(record, 'url'),
            art: this.getString(record, 'art'),
            txt: this.getString(record, 'txt'),
            img: this.getString(record, 'img')
        };
    }
    /**
     * Narrows a raw recommendation item to the subset used by this source.
     *
     * @param value Raw recommendation item.
     * @returns A narrowed recommendation item or `null`.
     */
    toRecommendationItem(value) {
        const record = this.getRecordFromValue(value);
        if (!record) {
            return null;
        }
        return {
            DNS: this.getString(record, 'DNS'),
            URL: this.getString(record, 'URL'),
            Artist: this.getString(record, 'Artist'),
            Name: this.getString(record, 'Name')
        };
    }
    /**
     * Checks whether an arbitrary value is a valid encoded track payload.
     *
     * @param value Candidate value returned by delegated source calls.
     * @returns `true` when the value is a usable encoded track payload.
     */
    isTrackData(value) {
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
    isPlaylistData(value) {
        const record = this.getRecordFromValue(value);
        if (!record) {
            return false;
        }
        const tracks = this.getValue(record, 'tracks');
        return (Array.isArray(tracks) &&
            tracks.every((track) => this.isTrackData(track)));
    }
    /**
     * Checks whether a value is an array of track payloads usable by
     * `getBestMatch`.
     *
     * @param value Candidate search result payload.
     * @returns `true` when the payload is a valid track array.
     */
    isTrackDataArray(value) {
        return Array.isArray(value) && value.every((item) => this.isTrackData(item));
    }
    /**
     * Maps a scored best-match candidate back to the original encoded track
     * payload returned by the search pipeline.
     *
     * @param tracks Candidate encoded tracks.
     * @param candidate Best-match candidate selected by the scoring helper.
     * @returns The original encoded track payload or `null` when no exact match exists.
     */
    findTrackDataByCandidate(tracks, candidate) {
        return (tracks.find((track) => track.info.title === candidate.info.title &&
            track.info.author === candidate.info.author &&
            track.info.uri === candidate.info.uri) ?? null);
    }
}
