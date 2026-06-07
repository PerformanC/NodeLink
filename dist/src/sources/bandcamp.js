import { PassThrough, pipeline } from 'node:stream';
import { encodeTrack, logger, makeRequest } from "../utils.js";
const BANDCAMP_BASE_URL = 'https://bandcamp.com';
const BANDCAMP_SEARCH_API_URL = `${BANDCAMP_BASE_URL}/api/bcsearch_public_api/1/autocomplete_elastic`;
const BANDCAMP_TRACK_PATTERN = /^https?:\/\/([^/]+)\.bandcamp\.com\/(track|album)\/([^/?]+)/;
const STREAM_URL_REGEX = /https?:\/\/t4\.bcbits\.com\/stream\/[^"'\\&\s]+/;
const TRALBUM_REGEX = /data-tralbum="([^"]*(?:"[^"]*)*?)"/;
const JSON_LD_REGEX = /<script\s+type="application\/ld\+json"\s*>([\s\S]*?)<\/script>/;
/**
 * Bandcamp source implementation.
 */
export default class BandcampSource {
    /**
     * Shared worker runtime provided by the source manager.
     */
    nodelink;
    /**
     * Base Bandcamp URL used for search requests.
     */
    baseUrl = BANDCAMP_BASE_URL;
    /**
     * URL patterns supported by this source.
     */
    patterns = [BANDCAMP_TRACK_PATTERN];
    /**
     * Search prefixes routed to this source.
     */
    searchTerms = ['bcsearch'];
    /**
     * Source priority used for URL matching.
     */
    priority = 90;
    /**
     * Creates a Bandcamp source bound to the worker runtime.
     *
     * @param nodelink Worker runtime shared with all sources.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
    }
    /**
     * Announces the Bandcamp source during worker initialization.
     *
     * @returns `true` when the source is ready to accept requests.
     */
    async setup() {
        logger('info', 'Sources', 'Loaded BandCamp source.');
        return true;
    }
    /**
     * Checks whether a URL matches one of the Bandcamp patterns.
     *
     * @param link Candidate URL provided by the source manager.
     * @returns `true` when the URL belongs to a supported Bandcamp page.
     */
    isLinkMatch(link) {
        return this.patterns.some((pattern) => pattern.test(link));
    }
    /**
     * Searches Bandcamp track results using the internal JSON search API.
     *
     * The previous HTML-scraping approach broke because `bandcamp.com/search`
     * now returns a client-challenge page that requires JavaScript.  The
     * internal autocomplete API used by the Bandcamp frontend returns
     * structured JSON and does not require authentication.
     *
     * @param query Search string received from the API or unified search flow.
     * @returns Search results, an empty payload, or a structured exception.
     */
    async search(query) {
        try {
            const request = await makeRequest(BANDCAMP_SEARCH_API_URL, {
                method: 'POST',
                disableBodyCompression: true,
                body: {
                    search_text: query,
                    search_filter: 't',
                    full_page: true,
                    fan_id: null
                }
            });
            if (request.error || request.statusCode !== 200) {
                return {
                    loadType: 'error',
                    exception: {
                        message: request.error ??
                            `BandCamp search API returned status ${request.statusCode}.`,
                        severity: 'fault',
                        cause: 'Request Failed'
                    }
                };
            }
            const response = this.getJsonBody(request.body);
            if (!response?.auto?.results || response.auto.results.length === 0) {
                logger('debug', 'Sources', `No results found on BandCamp for: "${query}"`);
                return { loadType: 'empty', data: {} };
            }
            const tracks = [];
            const maxResults = this.getMaxSearchResults();
            for (const item of response.auto.results) {
                if (tracks.length >= maxResults)
                    break;
                if (!item.name || !item.item_url_path)
                    continue;
                tracks.push(this.buildTrack({
                    identifier: item.id != null ? String(item.id) : null,
                    title: item.name,
                    author: item.band_name || null,
                    uri: item.item_url_path,
                    artworkUrl: item.art_id
                        ? this.createArtworkUrl(item.art_id)
                        : (item.img ?? null)
                }));
            }
            if (tracks.length === 0) {
                logger('warn', 'Sources', 'Search results found on BandCamp, but no tracks could be parsed.');
                return { loadType: 'empty', data: {} };
            }
            logger('debug', 'Sources', `Found ${tracks.length} tracks on BandCamp for: "${query}"`);
            return { loadType: 'search', data: tracks };
        }
        catch (error) {
            return this.createSourceException(error instanceof Error ? error.message : 'BandCamp search failed.', 'fault', 'Exception');
        }
    }
    /**
     * Resolves a Bandcamp track or album URL into a track or playlist payload.
     *
     * Uses `data-tralbum` as the primary metadata source and enriches with
     * JSON-LD structured data (ISRC, duration, artwork) when available.
     *
     * @param url Canonical Bandcamp URL to resolve.
     * @returns A track, playlist, empty result, or a structured exception.
     */
    async resolve(url) {
        try {
            const pageData = await this.fetchPageData(url);
            if (!pageData) {
                logger('warn', 'Sources', `Failed to fetch BandCamp page for: ${url}`);
                return { loadType: 'empty', data: {} };
            }
            const { tralbum, jsonLd } = pageData;
            if (!tralbum?.trackinfo || tralbum.trackinfo.length === 0) {
                logger('warn', 'Sources', `No 'tralbum' data found on BandCamp for: ${url}`);
                return { loadType: 'empty', data: {} };
            }
            const artworkUrl = this.createArtworkUrl(tralbum.art_id) ??
                (typeof jsonLd?.image === 'string' ? jsonLd.image : null);
            const author = this.normalizeText(tralbum.artist) ??
                this.normalizeText(jsonLd?.byArtist?.name) ??
                'Unknown Artist';
            const pageIsrc = tralbum.current?.isrc ?? jsonLd?.isrcCode ?? null;
            if (tralbum.trackinfo.length > 1) {
                const tracks = [];
                for (const item of tralbum.trackinfo) {
                    const trackUrl = item.title_link
                        ? this.buildAbsoluteTrackUrl(item.title_link, url)
                        : null;
                    if (!trackUrl)
                        continue;
                    tracks.push(this.buildTrack({
                        identifier: this.getTrackIdentifier(item, trackUrl),
                        isSeekable: true,
                        author,
                        length: this.toDurationMilliseconds(item.duration),
                        isStream: false,
                        title: this.normalizeText(item.title),
                        uri: trackUrl,
                        artworkUrl
                    }));
                }
                if (tracks.length === 0) {
                    return { loadType: 'empty', data: {} };
                }
                const playlist = {
                    info: {
                        name: this.normalizeText(tralbum.current?.title) ?? 'BandCamp Playlist',
                        selectedTrack: 0
                    },
                    pluginInfo: {},
                    tracks
                };
                return { loadType: 'playlist', data: playlist };
            }
            const trackData = tralbum.trackinfo[0];
            if (!trackData) {
                return { loadType: 'empty', data: {} };
            }
            const track = this.buildTrack({
                identifier: this.getTrackIdentifier(trackData, url),
                isSeekable: true,
                author,
                length: this.toDurationMilliseconds(trackData.duration) ??
                    this.parseIsoDuration(jsonLd?.duration),
                isStream: false,
                title: this.normalizeText(trackData.title),
                uri: url,
                artworkUrl,
                isrc: pageIsrc
            });
            return { loadType: 'track', data: track };
        }
        catch (error) {
            return this.createSourceException(error instanceof Error ? error.message : 'BandCamp resolve failed.', 'fault', 'Exception');
        }
    }
    /**
     * Extracts the direct Bandcamp MP3 stream URL from a track page.
     *
     * When possible, the stream URL is extracted directly from the
     * `data-tralbum` payload to avoid an additional HTTP round-trip.
     * Falls back to a regex scan of the full page body when the structured
     * extraction does not yield a URL.
     *
     * @param track Decoded track information produced by the source manager.
     * @returns A direct stream URL descriptor or a structured exception.
     */
    async getTrackUrl(track) {
        try {
            const { body, error, statusCode } = await makeRequest(track.uri, {
                method: 'GET'
            });
            if (error || statusCode !== 200) {
                return {
                    loadType: 'error',
                    exception: {
                        message: `Failed to fetch track page: ${error ?? statusCode}`,
                        severity: 'fault',
                        cause: 'Request Failed'
                    }
                };
            }
            const page = this.getResponseText({ body });
            if (page === null) {
                return {
                    loadType: 'error',
                    exception: {
                        message: 'BandCamp returned an unreadable track page.',
                        severity: 'fault',
                        cause: 'Invalid Response'
                    }
                };
            }
            // Try extracting stream URL from the structured tralbum data first.
            const streamUrl = this.extractStreamUrlFromPage(page, track.identifier);
            if (!streamUrl) {
                return {
                    loadType: 'error',
                    exception: {
                        message: 'No stream URL was found in the page content.',
                        severity: 'fault',
                        cause: 'Stream Extraction Failed'
                    }
                };
            }
            return {
                url: streamUrl,
                protocol: 'https',
                format: 'mp3'
            };
        }
        catch (error) {
            return {
                loadType: 'error',
                exception: {
                    message: error instanceof Error
                        ? error.message
                        : 'BandCamp stream extraction failed.',
                    severity: 'fault',
                    cause: 'Stream Extraction Failed'
                }
            };
        }
    }
    /**
     * Opens the resolved Bandcamp audio stream for playback.
     *
     * @param decodedTrack Decoded track used only for logging context.
     * @param url Direct playback URL returned by `getTrackUrl`.
     * @returns A readable stream or a structured exception.
     */
    async loadStream(decodedTrack, url) {
        logger('debug', 'Sources', `Loading BandCamp stream for "${decodedTrack.title}"`);
        try {
            const response = await makeRequest(url, {
                method: 'GET',
                streamOnly: true,
                headers: {
                    Referer: decodedTrack.uri
                }
            });
            if (response.error || response.statusCode !== 200 || !response.stream) {
                return {
                    loadType: 'error',
                    exception: {
                        message: response.error ??
                            `BandCamp returned an invalid stream status: ${response.statusCode}`,
                        severity: 'common',
                        cause: 'Upstream'
                    }
                };
            }
            const stream = new PassThrough();
            stream.once('close', () => {
                ;
                response.stream.destroy?.();
            });
            pipeline(response.stream, stream, (error) => {
                if (error && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
                    logger('error', 'Sources', `BandCamp stream error: ${error.message}`);
                }
            });
            return { stream };
        }
        catch (error) {
            logger('error', 'Sources', `Failed to load BandCamp stream: ${error instanceof Error ? error.message : 'unknown error'}`);
            return {
                loadType: 'error',
                exception: {
                    message: error instanceof Error
                        ? error.message
                        : 'Failed to load BandCamp stream.',
                    severity: 'common',
                    cause: 'Upstream'
                }
            };
        }
    }
    /**
     * Fetches a Bandcamp page and extracts both `data-tralbum` and JSON-LD data.
     *
     * @param url Bandcamp track or album URL.
     * @returns Parsed page metadata or `null` when extraction fails.
     */
    async fetchPageData(url) {
        const { body, error, statusCode } = await makeRequest(url, {
            method: 'GET'
        });
        if (error || statusCode !== 200) {
            logger('error', 'Sources', `Failed to fetch BandCamp page: ${error ?? statusCode}`);
            return null;
        }
        const page = this.getResponseText({ body });
        if (page === null)
            return null;
        const tralbum = this.parseTralbumFromPage(page);
        const jsonLd = this.parseJsonLdFromPage(page);
        return { tralbum, jsonLd, rawPage: page };
    }
    /**
     * Converts parsed Bandcamp metadata into an encoded track payload.
     *
     * @param partialInfo Track fields collected from search or page resolution.
     * @returns An encoded track entry compatible with the source manager.
     */
    buildTrack(partialInfo) {
        const track = {
            identifier: partialInfo.identifier?.trim() ||
                this.getIdentifierFromUrl(partialInfo.uri),
            isSeekable: partialInfo.isSeekable ?? true,
            author: partialInfo.author?.trim() || 'Unknown Artist',
            length: partialInfo.length ?? -1,
            isStream: partialInfo.isStream ?? false,
            position: 0,
            title: partialInfo.title?.trim() || 'Unknown Title',
            uri: partialInfo.uri,
            artworkUrl: partialInfo.artworkUrl,
            isrc: partialInfo.isrc ?? null,
            sourceName: 'bandcamp',
            details: []
        };
        return {
            encoded: encodeTrack(track),
            info: track,
            pluginInfo: {}
        };
    }
    /**
     * Derives a stable identifier from a Bandcamp URL.
     *
     * @param url Bandcamp track or album URL.
     * @returns A hostname-and-slug identifier, or the URL itself as fallback.
     */
    getIdentifierFromUrl(url) {
        const match = url.match(BANDCAMP_TRACK_PATTERN);
        return match ? `${match[1]}:${match[3]}` : url;
    }
    /**
     * Parses the `data-tralbum` JSON payload from a Bandcamp page body.
     *
     * @param page Full HTML page body.
     * @returns Parsed tralbum data, or `null` when not found or invalid.
     */
    parseTralbumFromPage(page) {
        const match = page.match(TRALBUM_REGEX);
        if (!match?.[1])
            return null;
        try {
            const decoded = this.decodeHtmlEntities(match[1]);
            return JSON.parse(decoded);
        }
        catch (error) {
            logger('warn', 'Sources', `Failed to parse BandCamp tralbum payload: ${error instanceof Error ? error.message : 'invalid JSON'}`);
            return null;
        }
    }
    /**
     * Parses the JSON-LD `MusicRecording` block from a Bandcamp page body.
     *
     * @param page Full HTML page body.
     * @returns Parsed JSON-LD data, or `null` when not found or invalid.
     */
    parseJsonLdFromPage(page) {
        const match = page.match(JSON_LD_REGEX);
        if (!match?.[1])
            return null;
        try {
            return JSON.parse(match[1].trim());
        }
        catch {
            return null;
        }
    }
    /**
     * Extracts the MP3 stream URL from a Bandcamp page body.
     *
     * Tries the structured `data-tralbum` `trackinfo[].file["mp3-128"]` field
     * first, then falls back to a regex scan for a `t4.bcbits.com/stream` URL.
     */
    extractStreamUrlFromPage(page, trackId) {
        // Try structured extraction from tralbum first.
        const tralbum = this.parseTralbumFromPage(page);
        if (tralbum?.trackinfo) {
            // Find the specific track if an ID is provided, otherwise default to the first
            const trackData = trackId
                ? tralbum.trackinfo.find(t => String(t.track_id) === trackId || String(t.id) === trackId) || tralbum.trackinfo[0]
                : tralbum.trackinfo[0];
            if (trackData?.file) {
                const mp3Url = trackData.file['mp3-128'];
                if (mp3Url) {
                    return this.decodeHtmlEntities(mp3Url);
                }
            }
        }
        // Fallback: regex scan of the full page.
        const decodedPage = this.decodeHtmlEntities(page);
        // Fix: The regex must allow `&` to capture the token parameters.
        const streamUrlMatch = decodedPage.match(/https?:\/\/t4\.bcbits\.com\/stream\/[^"'\s]+/);
        return streamUrlMatch ? streamUrlMatch[0] : null;
    }
    /**
     * Converts an HTTP helper response body into UTF-8 text.
     *
     * @param response HTTP helper response containing a buffered body.
     * @returns The normalized text body, or `null` when the payload is not text-like.
     */
    getResponseText(response) {
        if (typeof response.body === 'string') {
            return response.body;
        }
        if (Buffer.isBuffer(response.body)) {
            return response.body.toString('utf8');
        }
        return null;
    }
    /**
     * Safely parses a JSON body from an HTTP response.
     *
     * @param body Raw response body from the HTTP helper.
     * @returns The parsed JSON object, or `null` when parsing fails.
     */
    getJsonBody(body) {
        if (body !== null &&
            body !== undefined &&
            typeof body === 'object' &&
            !Buffer.isBuffer(body)) {
            return body;
        }
        const text = this.getResponseText({ body });
        if (text === null)
            return null;
        try {
            return JSON.parse(text);
        }
        catch {
            return null;
        }
    }
    /**
     * Decodes HTML entities commonly found in Bandcamp page attributes and
     * JSON payloads embedded in HTML.
     *
     * Handles named entities, decimal numeric entities, and hexadecimal
     * numeric entities.
     *
     * @param value Raw HTML fragment or encoded attribute value.
     * @returns A decoded string safe to use in URLs and titles.
     */
    decodeHtmlEntities(value) {
        return value
            .replaceAll('&quot;', '"')
            .replaceAll('&#34;', '"')
            .replaceAll('&#39;', "'")
            .replaceAll('&#x27;', "'")
            .replaceAll('&apos;', "'")
            .replaceAll('&lt;', '<')
            .replaceAll('&gt;', '>')
            .replaceAll('&nbsp;', ' ')
            .replaceAll('&amp;', '&')
            .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
            .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
    }
    /**
     * Normalizes parsed HTML text into a trimmed human-readable value.
     *
     * @param value Raw string extracted from HTML or JSON payloads.
     * @returns Normalized text, or `null` when the input becomes empty.
     */
    normalizeText(value) {
        if (!value)
            return null;
        const normalized = this.decodeHtmlEntities(value)
            .replace(/\s+/g, ' ')
            .trim();
        return normalized ? normalized : null;
    }
    /**
     * Converts Bandcamp duration values from seconds to milliseconds.
     *
     * @param durationSeconds Duration in seconds provided by Bandcamp.
     * @returns Duration in milliseconds, or `-1` when duration is missing.
     */
    toDurationMilliseconds(durationSeconds) {
        return durationSeconds ? Math.round(durationSeconds * 1000) : -1;
    }
    /**
     * Parses an ISO 8601 duration string into milliseconds.
     *
     * Handles the `P00H05M20S` format used by Bandcamp's JSON-LD.
     *
     * @param iso ISO 8601 duration string.
     * @returns Duration in milliseconds, or `-1` when parsing fails.
     */
    parseIsoDuration(iso) {
        if (!iso)
            return -1;
        const match = iso.match(/P(?:(\d+)D)?(?:T)?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/);
        if (!match)
            return -1;
        const days = parseInt(match[1] || '0', 10);
        const hours = parseInt(match[2] || '0', 10);
        const minutes = parseInt(match[3] || '0', 10);
        const seconds = parseFloat(match[4] || '0');
        return Math.round((days * 86400 + hours * 3600 + minutes * 60 + seconds) * 1000);
    }
    /**
     * Builds the public Bandcamp artwork URL from an `art_id` value.
     *
     * @param artId Artwork identifier exposed by `data-tralbum`.
     * @returns The public image URL or `null` when no artwork exists.
     */
    createArtworkUrl(artId) {
        if (artId === undefined || artId === null || artId === '') {
            return null;
        }
        return `https://f4.bcbits.com/img/a${String(artId)}_10.jpg`;
    }
    /**
     * Builds an absolute Bandcamp track URL from a relative album entry link.
     *
     * @param titleLink Relative or absolute track path exposed by Bandcamp.
     * @param parentUrl Canonical album URL used as the base.
     * @returns The absolute track URL or `null` when the input is invalid.
     */
    buildAbsoluteTrackUrl(titleLink, parentUrl) {
        try {
            return new URL(titleLink, parentUrl).href;
        }
        catch {
            return null;
        }
    }
    /**
     * Chooses the best stable identifier available for a Bandcamp track.
     *
     * @param track Page payload entry returned by `data-tralbum`.
     * @param fallbackUrl Fallback public URL used when no numeric identifier exists.
     * @returns A stable identifier string for the encoded payload.
     */
    getTrackIdentifier(track, fallbackUrl) {
        const identifier = track.track_id ?? track.id;
        return identifier !== undefined && identifier !== null && identifier !== ''
            ? String(identifier)
            : this.getIdentifierFromUrl(fallbackUrl);
    }
    /**
     * Reads and normalizes the configured maximum number of search results.
     *
     * @returns A positive integer limit used when parsing search results.
     */
    getMaxSearchResults() {
        const options = this.nodelink.options;
        const limit = options.search.maxResults;
        return typeof limit === 'number' && Number.isInteger(limit) && limit > 0
            ? limit
            : 10;
    }
    /**
     * Creates a standardized source exception payload for search and resolve flows.
     *
     * @param message Human-readable failure message.
     * @param severity Error severity used by the source pipeline.
     * @param cause Optional failure origin.
     * @returns A source result containing only exception metadata.
     */
    createSourceException(message, severity, cause) {
        return {
            loadType: 'error',
            exception: {
                message,
                severity,
                cause
            }
        };
    }
}
