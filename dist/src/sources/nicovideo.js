import HLSHandler from "../playback/hls/HLSHandler.js";
import { encodeTrack, http1makeRequest, logger } from "../utils.js";
/**
 * NicoVideo source implementation.
 */
export default class NicoVideoSource {
    /**
     * Runtime worker context used by the source implementation.
     */
    nodelink;
    /**
     * Search aliases supported by this source.
     */
    searchTerms;
    /**
     * URL patterns handled by this source.
     */
    patterns;
    /**
     * Match priority used by the source manager.
     */
    priority;
    /**
     * Creates a new NicoVideo source wrapper.
     *
     * @param nodelink - Worker runtime used by the source implementation.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.searchTerms = ['ncsearch', 'nicovideo'];
        this.patterns = [
            /^https?:\/\/(?:www\.)?nicovideo\.jp\/watch\/(\w+)/,
            /^https?:\/\/nico\.ms\/(\w+)/
        ];
        this.priority = 75;
    }
    /**
     * Validates whether a raw HTTP payload can be treated as an object record.
     *
     * @param value - Candidate HTTP response body.
     * @returns `true` when the value is a non-array, non-buffer object.
     */
    isJsonRecord(value) {
        return (value !== null &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            !Buffer.isBuffer(value));
    }
    /**
     * Narrows a NicoVideo search payload after a successful HTTP request.
     *
     * @param value - Raw response body returned by the search endpoint.
     * @returns Typed NicoVideo search response, or `null` when the payload is
     * not object-like.
     */
    getSearchResponse(value) {
        if (!this.isJsonRecord(value)) {
            return null;
        }
        return value;
    }
    /**
     * Narrows the NicoVideo watch page payload returned by `responseType=json`.
     *
     * @param value - Raw response body returned by the watch page request.
     * @returns Typed watch page response, or `null` when the payload is not
     * object-like.
     */
    getWatchPageResponse(value) {
        if (!this.isJsonRecord(value)) {
            return null;
        }
        return value;
    }
    /**
     * Narrows the HLS access-right response returned by NicoVideo.
     *
     * @param value - Raw response body returned by the access-right request.
     * @returns Typed access-right response, or `null` when the payload is not
     * object-like.
     */
    getAccessRightsResponse(value) {
        if (!this.isJsonRecord(value)) {
            return null;
        }
        return value;
    }
    /**
     * Extracts a NicoVideo watch identifier from a supported URL.
     *
     * @param url - Candidate NicoVideo URL.
     * @returns Extracted watch identifier, or `null` when the URL does not
     * match this source.
     */
    getVideoId(url) {
        const primaryPattern = this.patterns[0];
        const shortPattern = this.patterns[1];
        const primaryMatch = primaryPattern?.exec(url);
        if (typeof primaryMatch?.[1] === 'string') {
            return primaryMatch[1];
        }
        const shortMatch = shortPattern?.exec(url);
        return typeof shortMatch?.[1] === 'string' ? shortMatch[1] : null;
    }
    /**
     * Builds the request headers required by NicoVideo endpoints.
     *
     * @param accessRightKey - Optional HLS access-right key for stream requests.
     * @returns Header object expected by NicoVideo HTTP endpoints.
     */
    buildHeaders(accessRightKey) {
        const headers = {
            'User-Agent': 'NodeLink',
            'X-Request-With': 'https://www.nicovideo.jp',
            Referer: 'https://www.nicovideo.jp/',
            'X-Frontend-Id': '6',
            'X-Frontend-Version': '0'
        };
        if (accessRightKey) {
            headers['x-access-right-key'] = accessRightKey;
        }
        return headers;
    }
    /**
     * Converts the limited NicoVideo duration string into milliseconds.
     *
     * This preserves the source's current behavior, which only reads the final
     * seconds segment from NicoVideo's duration string.
     *
     * @param duration - NicoVideo ISO-8601 duration string.
     * @returns Duration in milliseconds based on the parsed seconds component.
     */
    parseDurationMillis(duration) {
        if (!duration) {
            return 0;
        }
        const seconds = duration.match(/(\d+)S/)?.[1];
        return Number.parseInt(seconds ?? '0', 10) * 1000;
    }
    /**
     * Formats a request failure message from the utility HTTP client output.
     *
     * @param error - Text error returned by the HTTP helper.
     * @param statusCode - HTTP status code returned by the request.
     * @returns Human-readable request failure summary.
     */
    getRequestFailureMessage(error, statusCode) {
        return error ?? String(statusCode ?? 'unknown error');
    }
    /**
     * Normalizes the `set-cookie` response header into a single header string.
     *
     * @param headers - Response headers returned by the HTTP helper.
     * @returns Cookie header string, or `null` when the response does not carry
     * cookies.
     */
    getCookieHeaderValue(headers) {
        const setCookie = headers?.['set-cookie'];
        if (Array.isArray(setCookie)) {
            return setCookie.join('; ');
        }
        return typeof setCookie === 'string' ? setCookie : null;
    }
    /**
     * Narrows cached additional stream metadata received by `loadStream(...)`.
     *
     * @param value - Additional data attached to a previously resolved track URL.
     * @returns Typed stream metadata limited to the fields this source uses.
     */
    getAdditionalData(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return {};
        }
        const data = value;
        return {
            cookie: typeof data.cookie === 'string' || data.cookie === null
                ? data.cookie
                : undefined,
            startTime: typeof data.startTime === 'number' ? data.startTime : undefined
        };
    }
    /**
     * Builds the output pairs required by NicoVideo's HLS access endpoint.
     *
     * The current source logic keeps the best available audio rendition and pairs
     * it with each supported video quality.
     *
     * @param dmcMedia - Domand playback metadata returned by NicoVideo.
     * @returns Output pairs in the same order expected by the original source.
     */
    buildOutputData(dmcMedia) {
        const quality = ['1080p', '720p', '480p', '360p', '144p'];
        const outputs = [];
        let topAudioId = null;
        let topAudioQuality = -1;
        for (const audio of dmcMedia.audios ?? []) {
            if (audio.isAvailable && audio.qualityLevel > topAudioQuality) {
                topAudioId = audio.id;
                topAudioQuality = audio.qualityLevel;
            }
        }
        if (!topAudioId) {
            return outputs;
        }
        for (const video of dmcMedia.videos ?? []) {
            if (quality.includes(video.label) && video.isAvailable) {
                outputs.push([video.id, topAudioId]);
            }
        }
        return outputs;
    }
    /**
     * Initializes the source.
     *
     * NicoVideo does not require asynchronous bootstrapping beyond logging, so
     * setup always succeeds.
     *
     * @returns `true` once the source has been registered.
     */
    async setup() {
        logger('info', 'Sources', 'Loaded NicoVideo source.');
        return true;
    }
    /**
     * Searches NicoVideo videos by title and tags.
     *
     * @param query - Search text provided by the caller.
     * @returns Search result payload containing encoded NicoVideo tracks, an
     * empty result, or an exception payload when the request fails.
     */
    async search(query) {
        logger('debug', 'NicoVideo', `Searching for: ${query}`);
        const params = new URLSearchParams({
            q: query,
            targets: 'title,tags',
            fields: 'contentId,title,owner,thumbnailUrl,duration',
            _sort: '-viewCounter',
            _context: 'NodeLink',
            _limit: '25'
        });
        const { body, error, statusCode } = await http1makeRequest(`https://api.search.nicovideo.jp/api/v2/snapshot/video/contents/search?${params.toString()}`);
        if (error || statusCode !== 200) {
            return {
                exception: {
                    message: `Failed to search: ${this.getRequestFailureMessage(error, statusCode)}`,
                    severity: 'fault'
                }
            };
        }
        const items = this.getSearchResponse(body)?.data ?? [];
        if (items.length === 0) {
            return { loadType: 'empty', data: {} };
        }
        const tracks = items.map((item) => {
            const trackInfo = {
                identifier: item.contentId,
                isSeekable: true,
                author: item.owner?.name ?? 'Unknown Artist',
                length: item.duration * 1000,
                isStream: false,
                position: 0,
                title: item.title,
                uri: `https://www.nicovideo.jp/watch/${item.contentId}`,
                artworkUrl: item.thumbnailUrl ?? null,
                isrc: null,
                sourceName: 'nicovideo',
                details: []
            };
            return {
                encoded: encodeTrack(trackInfo),
                info: trackInfo,
                pluginInfo: {}
            };
        });
        return { loadType: 'search', data: tracks };
    }
    /**
     * Resolves a NicoVideo watch URL into a single encoded track payload.
     *
     * @param url - Candidate NicoVideo watch URL.
     * @returns Track result payload, an empty result when the URL is unsupported,
     * or an exception payload when required metadata cannot be resolved.
     */
    async resolve(url) {
        const videoId = this.getVideoId(url);
        if (!videoId) {
            return { loadType: 'empty', data: {} };
        }
        const { body, error, statusCode } = await http1makeRequest(`https://www.nicovideo.jp/watch/${videoId}?responseType=json`, { headers: this.buildHeaders() });
        if (error || statusCode !== 200) {
            return {
                exception: {
                    message: `Failed to resolve URL: ${this.getRequestFailureMessage(error, statusCode)}`,
                    severity: 'fault'
                }
            };
        }
        const watchPage = this.getWatchPageResponse(body);
        const jsonLd = watchPage?.data?.metadata?.jsonLds?.find((entry) => entry['@type'] === 'VideoObject');
        const videoIdFromApi = watchPage?.data?.response?.client?.watchId;
        if (!jsonLd || !videoIdFromApi) {
            return {
                exception: {
                    message: 'Could not extract video information.',
                    severity: 'common'
                }
            };
        }
        const track = {
            identifier: videoIdFromApi,
            isSeekable: true,
            author: jsonLd.author?.name ?? 'Unknown Artist',
            length: this.parseDurationMillis(jsonLd.duration),
            isStream: false,
            position: 0,
            title: jsonLd.name ?? 'Unknown Title',
            uri: jsonLd['@id'] ?? `https://www.nicovideo.jp/watch/${videoIdFromApi}`,
            artworkUrl: jsonLd.thumbnailUrl?.[0] ?? null,
            isrc: null,
            sourceName: 'nicovideo',
            details: []
        };
        return {
            loadType: 'track',
            data: {
                encoded: encodeTrack(track),
                info: track,
                pluginInfo: {}
            }
        };
    }
    /**
     * Resolves the playable HLS playlist URL for a NicoVideo track.
     *
     * @param track - Decoded track information provided by the playback system.
     * @param forceRefresh - When `true`, bypasses the track cache and resolves a
     * fresh HLS session.
     * @returns Cached or freshly resolved HLS access data, or an exception
     * payload when playback rights cannot be established.
     */
    async getTrackUrl(track, forceRefresh = false) {
        if (!forceRefresh) {
            const cached = this.nodelink.trackCacheManager?.get('nicovideo', track.identifier) ?? null;
            if (cached) {
                return cached;
            }
        }
        const { body: pageData, error, statusCode } = await http1makeRequest(`${track.uri}?responseType=json`, {
            headers: this.buildHeaders()
        });
        if (error || statusCode !== 200) {
            return {
                exception: {
                    message: `Failed to get track page: ${this.getRequestFailureMessage(error, statusCode)}`,
                    severity: 'fault'
                }
            };
        }
        const response = this.getWatchPageResponse(pageData)?.data?.response;
        if (!response) {
            return {
                exception: {
                    message: 'Failed to extract response data from page',
                    severity: 'fault'
                }
            };
        }
        const dmcMedia = response.media?.domand;
        const watchTrackId = response.client?.watchTrackId;
        const accessRightKey = dmcMedia?.accessRightKey;
        if (!dmcMedia || !watchTrackId || !accessRightKey) {
            return {
                exception: {
                    message: 'Failed to extract required DMC info for stream access',
                    severity: 'fault'
                }
            };
        }
        const streamRequestUrl = `https://nvapi.nicovideo.jp/v1/watch/${track.identifier}/access-rights/hls` +
            `?actionTrackId=${encodeURIComponent(watchTrackId)}&__retry=1`;
        const postBody = { outputs: this.buildOutputData(dmcMedia) };
        const { body: streamData, headers: streamHeaders, error: streamError, statusCode: streamStatus } = await http1makeRequest(streamRequestUrl, {
            method: 'POST',
            headers: this.buildHeaders(accessRightKey),
            body: postBody,
            disableBodyCompression: true
        });
        if (streamError || streamStatus !== 201) {
            return {
                exception: {
                    message: `Failed to get stream access rights: ${this.getRequestFailureMessage(streamError, streamStatus)}`,
                    severity: 'fault'
                }
            };
        }
        const cookie = this.getCookieHeaderValue(streamHeaders);
        const masterPlaylistUrl = this.getAccessRightsResponse(streamData)?.data?.contentUrl;
        if (!masterPlaylistUrl) {
            return {
                exception: {
                    message: 'Failed to extract master playlist URL',
                    severity: 'fault'
                }
            };
        }
        const { body: masterPlaylistContent, error: masterError, statusCode: masterStatus } = await http1makeRequest(masterPlaylistUrl, {
            headers: { Cookie: cookie ?? '' }
        });
        if (masterError || masterStatus !== 200) {
            return {
                exception: {
                    message: `Failed to fetch master HLS playlist: ${this.getRequestFailureMessage(masterError, masterStatus)}`,
                    severity: 'fault'
                }
            };
        }
        if (typeof masterPlaylistContent !== 'string') {
            return {
                exception: {
                    message: 'Master playlist response was not returned as text',
                    severity: 'fault'
                }
            };
        }
        const lines = masterPlaylistContent.split('\n');
        const audioTag = lines.find((line) => line.startsWith('#EXT-X-MEDIA') && line.includes('TYPE=AUDIO'));
        if (!audioTag) {
            const result = {
                url: masterPlaylistUrl,
                protocol: 'hls',
                format: 'aac',
                additionalData: { cookie }
            };
            this.nodelink.trackCacheManager?.set('nicovideo', track.identifier, result, 1000 * 60 * 60);
            return result;
        }
        const audioUri = audioTag.match(/URI="([^"]+)"/)?.[1];
        if (!audioUri) {
            return {
                exception: {
                    message: 'Could not parse audio URI from master playlist',
                    severity: 'fault'
                }
            };
        }
        const audioPlaylistUrl = new URL(audioUri, masterPlaylistUrl).toString();
        const result = {
            url: audioPlaylistUrl,
            protocol: 'hls',
            format: 'aac',
            additionalData: { cookie }
        };
        this.nodelink.trackCacheManager?.set('nicovideo', track.identifier, result, 1000 * 60 * 60);
        return result;
    }
    /**
     * Opens the NicoVideo audio stream from a previously resolved HLS playlist.
     *
     * @param _track - Decoded track information passed by the playback system.
     * The current implementation does not need it after URL resolution.
     * @param url - HLS playlist URL returned by `getTrackUrl(...)`.
     * @param protocol - Stream protocol returned by `getTrackUrl(...)`.
     * @param additionalData - Extra stream metadata such as cookies and resume
     * offsets.
     * @returns HLS stream payload, or an exception when the resolved protocol is
     * unsupported.
     */
    async loadStream(_track, url, protocol, additionalData) {
        if (protocol === 'hls') {
            const headers = this.buildHeaders();
            const streamData = this.getAdditionalData(additionalData);
            if (streamData.cookie) {
                headers.Cookie = streamData.cookie;
            }
            const stream = new HLSHandler(url, {
                headers,
                type: 'fmp4',
                localAddress: this.nodelink.routePlanner?.getIP?.() ?? null,
                startTime: streamData.startTime ?? 0
            });
            return { stream, type: 'fmp4' };
        }
        return {
            exception: {
                message: 'Unsupported protocol',
                severity: 'common'
            }
        };
    }
}
