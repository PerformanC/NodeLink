import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import { encodeTrack, getBestMatch, http1makeRequest, logger } from '../utils.js';
const AUDIOMACK_PATTERNS = [
    /https?:\/\/(?:www\.)?audiomack\.com\/[^/]+\/song\/[^/]+(?:\?.*)?$/i,
    /https?:\/\/(?:www\.)?audiomack\.com\/[^/]+\/album\/[^/]+(?:\?.*)?$/i,
    /https?:\/\/(?:www\.)?audiomack\.com\/[^/]+\/playlist\/[^/]+(?:\?.*)?$/i,
    /https?:\/\/(?:www\.)?audiomack\.com\/[^/]+(?:\/)?(?:\?.*)?$/i,
    /https?:\/\/(?:www\.)?audiomack\.com\/search(?:\?.*)?$/i
];
const API_BASE = 'https://api.audiomack.com/v1';
const CONSUMER_KEY = 'audiomack-web';
const CONSUMER_SECRET = 'bd8a07e9f23fbe9d808646b730f89b8e';
const DEFAULT_SECTION = '/search';
const STRICT_URI_RE = /[!'()*]/g;
/**
 * Strictly encodes URI components according to OAuth 1.0 requirements.
 *
 * @param value Scalar value to encode.
 * @returns OAuth-safe percent-encoded string.
 */
function strictEncodeURIComponent(value) {
    return encodeURIComponent(String(value)).replace(STRICT_URI_RE, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}
/**
 * Builds a sorted query-string payload for OAuth signature generation.
 *
 * @param params OAuth and endpoint parameters.
 * @returns Stable query string sorted by parameter name.
 */
function buildParamString(params) {
    return Object.keys(params)
        .sort()
        .map((key) => `${strictEncodeURIComponent(key)}=${strictEncodeURIComponent(params[key] ?? '')}`)
        .join('&');
}
/**
 * Parses an HTTP helper body into a typed JSON payload.
 *
 * @param body HTTP response body returned by the shared request helper.
 * @returns Parsed JSON payload or `null` when parsing fails.
 */
function parseJsonBody(body) {
    if (body === null || body === undefined) {
        return null;
    }
    if (Buffer.isBuffer(body)) {
        try {
            return JSON.parse(body.toString('utf8'));
        }
        catch {
            return null;
        }
    }
    if (typeof body === 'string') {
        try {
            return JSON.parse(body);
        }
        catch {
            return null;
        }
    }
    return body;
}
/**
 * Normalizes Audiomack API envelopes into a single object result.
 *
 * @param json Parsed API payload.
 * @returns The first resolved result object or `null` when none exists.
 */
function normalizeApiResult(json) {
    if (!json) {
        return null;
    }
    const envelope = json;
    const data = envelope.results ?? envelope.result ?? json;
    if (Array.isArray(data)) {
        return data[0] ?? null;
    }
    return (data ?? null);
}
/**
 * Extracts a lowercase file extension from a URL-like string.
 *
 * @param urlString Candidate URL.
 * @returns Lowercase extension without the dot.
 */
function getUrlExtension(urlString) {
    if (!urlString) {
        return '';
    }
    try {
        const pathname = new URL(urlString).pathname;
        const lastDotIndex = pathname.lastIndexOf('.');
        return lastDotIndex === -1
            ? ''
            : pathname.slice(lastDotIndex + 1).toLowerCase();
    }
    catch {
        const base = urlString.split('?')[0] ?? '';
        const lastDotIndex = base.lastIndexOf('.');
        return lastDotIndex === -1 ? '' : base.slice(lastDotIndex + 1).toLowerCase();
    }
}
/**
 * Guesses the container format from a direct stream URL.
 *
 * @param urlString Candidate direct stream URL.
 * @returns Normalized container format.
 */
function guessFormatFromUrl(urlString) {
    const extension = getUrlExtension(urlString);
    if (extension === 'mp4') {
        return 'm4a';
    }
    if (extension === 'aac' ||
        extension === 'flac' ||
        extension === 'flv' ||
        extension === 'm4a' ||
        extension === 'mp3' ||
        extension === 'ogg' ||
        extension === 'wav' ||
        extension === 'webm') {
        return extension;
    }
    return 'm4a';
}
/**
 * Converts a format hint or URL extension into a MIME type.
 *
 * @param typeOrFormat Explicit type or format hint.
 * @param urlString Direct stream URL used as fallback.
 * @returns A MIME type suitable for the playback pipeline.
 */
function coerceStreamType(typeOrFormat, urlString) {
    const normalizedType = typeOrFormat ? String(typeOrFormat).toLowerCase() : '';
    if (normalizedType) {
        if (normalizedType.includes('/'))
            return normalizedType;
        if (normalizedType === 'mp3' || normalizedType === 'mpeg') {
            return 'audio/mpeg';
        }
        if (normalizedType === 'm4a' || normalizedType === 'mp4') {
            return 'audio/mp4';
        }
        if (normalizedType === 'aac')
            return 'audio/aac';
        if (normalizedType === 'ogg')
            return 'audio/ogg';
        if (normalizedType === 'wav')
            return 'audio/wav';
        if (normalizedType === 'flac')
            return 'audio/flac';
        if (normalizedType === 'webm')
            return 'video/webm';
        if (normalizedType === 'flv')
            return 'video/x-flv';
        return normalizedType;
    }
    const extension = guessFormatFromUrl(urlString);
    if (extension === 'mp3')
        return 'audio/mpeg';
    if (extension === 'm4a')
        return 'audio/mp4';
    if (extension === 'aac')
        return 'audio/aac';
    if (extension === 'ogg')
        return 'audio/ogg';
    if (extension === 'wav')
        return 'audio/wav';
    if (extension === 'flac')
        return 'audio/flac';
    if (extension === 'webm')
        return 'video/webm';
    if (extension === 'flv')
        return 'video/x-flv';
    return 'audio/mp4';
}
/**
 * Converts an unknown error into a log-safe message string.
 *
 * @param error Unknown thrown value.
 * @returns Human-readable message string.
 */
function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Converts Audiomack duration values from seconds to milliseconds.
 *
 * @param duration Duration value returned by the API.
 * @returns Duration in milliseconds, or `0` when unavailable.
 */
function toDurationMilliseconds(duration) {
    if (duration === null || duration === undefined || duration === '') {
        return 0;
    }
    const numericDuration = typeof duration === 'number' ? duration : Number.parseInt(duration, 10);
    return Number.isFinite(numericDuration) ? numericDuration * 1000 : 0;
}
/**
 * Attempts to derive an Audiomack section path from a public URI.
 *
 * @param uri Public Audiomack URI.
 * @returns Pathname used by the official API for analytics context.
 */
function getSectionPath(uri) {
    if (!uri) {
        return DEFAULT_SECTION;
    }
    try {
        return new URL(uri).pathname || DEFAULT_SECTION;
    }
    catch {
        return DEFAULT_SECTION;
    }
}
/**
 * Audiomack source backed by the official public API.
 */
export default class AudiomackSource {
    /** Runtime worker context provided by the source manager. */
    nodelink;
    /** Search prefixes routed to this source. */
    searchTerms = ['admsearch', 'audiomack'];
    /** URL patterns supported by this source. */
    patterns = AUDIOMACK_PATTERNS;
    /** Source priority used for URL matching. */
    priority = 40;
    /**
     * Creates a new Audiomack source wrapper.
     *
     * @param nodelink Worker runtime shared with all sources.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
    }
    /**
     * Announces the Audiomack source during worker initialization.
     *
     * @returns `true` when the source is ready to accept requests.
     */
    async setup() {
        logger('info', 'Sources', 'Loaded Audiomack source (official public API).');
        return true;
    }
    /**
     * Searches Audiomack tracks using the official public search endpoint.
     *
     * @param query Search string provided by the source manager.
     * @returns Search results, an empty payload, or a structured exception.
     */
    async search(query, _sourceTerm) {
        logger('debug', 'Sources', `Searching Audiomack for: "${query}"`);
        try {
            const response = await this.makeSignedRequest('GET', `${API_BASE}/search`, {
                q: query,
                limit: '20',
                show: 'music',
                sort: 'popular',
                page: '1',
                section: DEFAULT_SECTION
            });
            if (response.error || response.statusCode !== 200 || !response.body) {
                const message = response.error ??
                    `Audiomack search returned an invalid status: ${response.statusCode}`;
                logger('error', 'Sources', `[Audiomack] API search failed: ${message}`);
                return this.createException(message, 'common');
            }
            const json = parseJsonBody(response.body);
            if (!json || !Array.isArray(json.results)) {
                logger('debug', 'Sources', '[Audiomack] No results found in response.');
                return { loadType: 'empty', data: {} };
            }
            const tracks = json.results
                .filter((item) => item.type === 'song' && item.id !== undefined && item.id !== null)
                .map((item) => this.buildTrack(item))
                .filter((track) => track !== null);
            logger('debug', 'Sources', `[Audiomack] Found ${tracks.length} tracks.`);
            if (tracks.length === 0) {
                return { loadType: 'empty', data: {} };
            }
            return { loadType: 'search', data: tracks };
        }
        catch (error) {
            const message = getErrorMessage(error);
            logger('error', 'Sources', `[Audiomack] search error: ${message}`);
            return this.createException('Failed to search.', 'common');
        }
    }
    /**
     * Resolves a public Audiomack song URL into a single encoded track.
     *
     * Album, playlist, and profile URLs intentionally return an exception until
     * dedicated handling is implemented.
     *
     * @param queryUrl Public Audiomack URL to resolve.
     * @returns A track payload, an empty payload, or a structured exception.
     */
    async resolve(queryUrl) {
        let parsedUrl;
        try {
            parsedUrl = new URL(queryUrl);
        }
        catch {
            return this.createException('Invalid Audiomack URL.', 'common');
        }
        const pathParts = parsedUrl.pathname
            .split('/')
            .filter((segment) => segment.length > 0);
        const [artistSlug, resourceType, ...resourceSegments] = pathParts;
        if (!artistSlug ||
            resourceType !== 'song' ||
            resourceSegments.length === 0) {
            return this.createException('Only single song URLs are currently supported.', 'common');
        }
        const songSlug = resourceSegments.join('/');
        const apiUrl = `${API_BASE}/music/song/${artistSlug}/${songSlug}`;
        try {
            const response = await this.makeSignedRequest('GET', apiUrl, {
                section: parsedUrl.pathname
            });
            if (response.error || response.statusCode !== 200 || !response.body) {
                const message = response.error ?? 'Failed to fetch track details from Audiomack API.';
                return this.createException(message, 'common');
            }
            const json = parseJsonBody(response.body);
            const song = normalizeApiResult(json);
            if (!song || song.id === undefined || song.id === null) {
                return this.createException('Track not found or invalid response.', 'common');
            }
            const track = this.buildTrack(song, queryUrl);
            if (!track) {
                return this.createException('Track not found or invalid response.', 'common');
            }
            return { loadType: 'track', data: track };
        }
        catch (error) {
            return this.createException(`Failed to resolve track: ${getErrorMessage(error)}`, 'common');
        }
    }
    /**
     * Resolves a direct playback URL for an Audiomack track.
     *
     * When the Audiomack API fails to provide a playable URL, this method falls
     * back to the default search pipeline and chooses the best delegated match.
     *
     * @param track Decoded track information produced by the source manager.
     * @returns A direct URL descriptor or a structured exception.
     */
    async getTrackUrl(track) {
        if (!track.identifier) {
            return this.createException('Track identifier (numeric ID) missing', 'fault', 'StreamLink');
        }
        const playUrl = `${API_BASE}/music/play/${track.identifier}`;
        try {
            const response = await this.makeSignedRequest('GET', playUrl, {
                environment: 'desktop-web',
                hq: 'true',
                section: getSectionPath(track.uri)
            });
            if (response.error || response.statusCode !== 200 || !response.body) {
                return this.createException(response.error ?? 'Failed to get playback URL from Audiomack API', 'fault', 'StreamLink');
            }
            const json = parseJsonBody(response.body);
            const data = normalizeApiResult(json);
            if (!data) {
                return this.createException('Invalid response from Audiomack API', 'fault', 'StreamLink');
            }
            const streamUrl = data.signedUrl ??
                data.signed_url ??
                data.url ??
                data.streamUrl ??
                data.stream_url;
            if (!streamUrl) {
                return this.createException('Invalid or missing streaming URL in response', 'fault', 'StreamLink');
            }
            return {
                url: streamUrl,
                protocol: 'https',
                format: guessFormatFromUrl(streamUrl)
            };
        }
        catch (error) {
            logger('warn', 'Audiomack', `Direct stream failed for ${track.title}: ${getErrorMessage(error)}. Falling back to default search.`);
        }
        const sourceManager = this.getSourceManager();
        if (!sourceManager) {
            return this.createException('No source manager is available for fallback resolution.', 'fault', 'StreamLink');
        }
        const searchResult = await sourceManager.searchWithDefault(`${track.title} ${track.author}`);
        const candidates = this.extractSearchCandidates(searchResult);
        const bestMatch = getBestMatch(candidates, track);
        if (!bestMatch) {
            return this.createException('No suitable alternative found.', 'fault', 'StreamLink');
        }
        const streamInfo = await sourceManager.getTrackUrl(bestMatch.info);
        return { newTrack: bestMatch, ...streamInfo };
    }
    /**
     * Opens and forwards the final Audiomack audio stream.
     *
     * The TypeScript rewrite also tightens stream cleanup: listeners are removed
     * when the passthrough closes or errors, and the upstream stream is destroyed
     * exactly once to reduce leak/race risks around abrupt teardown.
     *
     * @param decodedTrack Decoded track used for format hints.
     * @param url Direct playback URL returned by `getTrackUrl`.
     * @param _protocol Protocol hint from the source manager.
     * @param additionalData Additional request metadata used for stream loading.
     * @returns A readable stream or a structured exception.
     */
    async loadStream(decodedTrack, url, _protocol, additionalData) {
        try {
            const response = await http1makeRequest(url, {
                method: 'GET',
                headers: additionalData?.headers,
                streamOnly: true
            });
            if (response.error || !response.stream) {
                throw new Error(response.error ?? 'Failed to get stream');
            }
            const sourceStream = response.stream;
            const output = new PassThrough();
            const cleanupListeners = () => {
                sourceStream.removeListener('error', handleSourceError);
                sourceStream.removeListener('end', handleSourceEnd);
                output.removeListener('close', handleOutputClose);
                output.removeListener('error', handleOutputError);
            };
            const handleSourceError = (error) => {
                cleanupListeners();
                if (!output.destroyed) {
                    output.destroy(error);
                }
            };
            const handleSourceEnd = () => {
                output.emit('finishBuffering');
            };
            const handleOutputClose = () => {
                cleanupListeners();
                if (!sourceStream.destroyed) {
                    sourceStream.destroy();
                }
            };
            const handleOutputError = () => {
                cleanupListeners();
                if (!sourceStream.destroyed) {
                    sourceStream.destroy();
                }
            };
            sourceStream.once('error', handleSourceError);
            sourceStream.once('end', handleSourceEnd);
            output.once('close', handleOutputClose);
            output.once('error', handleOutputError);
            sourceStream.pipe(output);
            const streamType = coerceStreamType(additionalData?.type ?? additionalData?.format ?? decodedTrack.format, url);
            return { stream: output, type: streamType };
        }
        catch (error) {
            return this.createException(getErrorMessage(error), 'common');
        }
    }
    /**
     * Creates an OAuth-signed Audiomack API request.
     *
     * @param method HTTP method.
     * @param url Endpoint URL.
     * @param additionalParams Endpoint-specific query parameters.
     * @returns Shared HTTP helper response.
     */
    async makeSignedRequest(method, url, additionalParams = {}) {
        const params = {
            ...additionalParams,
            oauth_consumer_key: CONSUMER_KEY,
            oauth_nonce: crypto.randomBytes(16).toString('hex'),
            oauth_signature_method: 'HMAC-SHA1',
            oauth_timestamp: Math.floor(Date.now() / 1000),
            oauth_version: '1.0'
        };
        const paramString = buildParamString(params);
        const signature = this.generateSignature(method, url, params, CONSUMER_SECRET, paramString);
        const signedUrl = `${url}?${paramString}&oauth_signature=${strictEncodeURIComponent(signature)}`;
        return http1makeRequest(signedUrl, { method });
    }
    /**
     * Generates the OAuth 1.0 HMAC-SHA1 signature for an Audiomack request.
     *
     * @param method HTTP method.
     * @param url Endpoint URL.
     * @param params OAuth and endpoint parameters.
     * @param secret Consumer secret.
     * @param paramString Pre-built parameter string.
     * @returns Base64-encoded OAuth signature.
     */
    generateSignature(method, url, params, secret, paramString = buildParamString(params)) {
        const signatureBase = `${method.toUpperCase()}&${strictEncodeURIComponent(url)}&${strictEncodeURIComponent(paramString)}`;
        const signingKey = `${strictEncodeURIComponent(secret)}&`;
        return crypto
            .createHmac('sha1', signingKey)
            .update(signatureBase)
            .digest('base64');
    }
    /**
     * Converts Audiomack API metadata into an encoded track payload.
     *
     * @param item Raw Audiomack track payload.
     * @param queryUrl Canonical source URL when already known.
     * @returns Encoded track payload or `null` when the input is incomplete.
     */
    buildTrack(item, queryUrl = null) {
        if (item.id === undefined || item.id === null || item.id === '') {
            return null;
        }
        const title = item.title?.trim() || 'Unknown Title';
        const author = item.artist?.trim() || item.uploader?.name?.trim() || 'Unknown Artist';
        const artwork = item.image ?? item.image_base ?? null;
        let uri = queryUrl;
        if (!uri) {
            const uploaderSlug = item.uploader?.url_slug ??
                item.uploader_url_slug ??
                item.artist_slug ??
                'unknown';
            const songSlug = item.url_slug ?? item.slug ?? '';
            uri = `https://audiomack.com/${uploaderSlug}/song/${songSlug}`;
        }
        const trackInfo = {
            identifier: String(item.id),
            title,
            author,
            length: toDurationMilliseconds(item.duration),
            sourceName: 'audiomack',
            artworkUrl: artwork,
            uri,
            isStream: false,
            isSeekable: true,
            position: 0,
            isrc: item.isrc ?? null,
            details: []
        };
        return {
            encoded: encodeTrack(trackInfo),
            info: trackInfo,
            pluginInfo: {}
        };
    }
    /**
     * Returns the source manager narrowed to the fallback methods used here.
     *
     * @returns Narrowed source manager or `null` when unavailable.
     */
    getSourceManager() {
        const sourceManager = this.nodelink.sources;
        return sourceManager ?? null;
    }
    /**
     * Extracts track candidates from a default-search result.
     *
     * @param result Search result returned by the source manager.
     * @returns Track candidates accepted by the shared best-match scorer.
     */
    extractSearchCandidates(result) {
        if (result.loadType !== 'search' || !Array.isArray(result.data)) {
            return [];
        }
        return result.data.filter((item) => this.isTrackData(item));
    }
    /**
     * Checks whether an unknown value exposes a valid encoded track structure.
     *
     * @param value Candidate search result item.
     * @returns `true` when the item is a usable track payload.
     */
    isTrackData(value) {
        if (!value || typeof value !== 'object') {
            return false;
        }
        const record = value;
        return (typeof record.encoded === 'string' &&
            typeof record.info?.identifier === 'string' &&
            typeof record.info.title === 'string' &&
            typeof record.info.author === 'string' &&
            typeof record.info.length === 'number' &&
            typeof record.info.uri === 'string' &&
            typeof record.info.sourceName === 'string');
    }
    /**
     * Creates a standardized exception payload used across the source methods.
     *
     * @param message Human-readable failure message.
     * @param severity Error severity used by the source pipeline.
     * @param cause Optional failure origin.
     * @returns Structured exception payload.
     */
    createException(message, severity, cause) {
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
