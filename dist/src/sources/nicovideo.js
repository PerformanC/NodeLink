import HLSHandler from '../playback/hls/HLSHandler.js';
import { encodeTrack, http1makeRequest, logger } from '../utils.js';
/**
 * NicoVideo source implementation.
 */
export default class NicoVideoSource {
    /**
     * Declarative test suite for validating NicoVideo source behavior.
     */
    static _TESTS = [
        {
            id: 'nicovideo.watch.stream',
            name: 'NicoVideo standard watch video playback',
            input: {
                type: 'resolve',
                value: 'https://www.nicovideo.jp/watch/sm9'
            },
            matrix: {
                variants: [{ id: 'Standard' }]
            },
            expect: {
                result: {
                    type: 'track'
                },
                metadata: {
                    author: {
                        op: 'matches',
                        value: '中の'
                    },
                    sourceName: {
                        op: 'equals',
                        value: 'nicovideo'
                    }
                },
                stream: {
                    required: true,
                    download: {
                        mode: 'window',
                        maxDurationMs: 10000,
                        maxBytes: 512 * 1024
                    },
                    minBytes: 100000,
                    validFormats: [{ container: 'mp4', codec: 'aac' }]
                }
            },
            forbid: {
                resultTypes: ['empty', 'error']
            }
        },
        {
            id: 'nicovideo.short.stream',
            name: 'NicoVideo short URL playback',
            input: {
                type: 'resolve',
                value: 'https://nico.ms/sm9'
            },
            matrix: {
                variants: [{ id: 'Standard' }]
            },
            expect: {
                result: {
                    type: 'track'
                },
                metadata: {
                    author: {
                        op: 'matches',
                        value: '中の'
                    },
                    sourceName: {
                        op: 'equals',
                        value: 'nicovideo'
                    }
                },
                stream: {
                    required: true,
                    download: {
                        mode: 'window',
                        maxDurationMs: 10000,
                        maxBytes: 512 * 1024
                    },
                    minBytes: 100000,
                    validFormats: [{ container: 'mp4', codec: 'aac' }]
                }
            },
            forbid: {
                resultTypes: ['empty', 'error']
            }
        },
        {
            id: 'nicovideo.search',
            name: 'NicoVideo search query',
            input: {
                type: 'search',
                value: 'Bad Apple',
                searchType: 'ncsearch'
            },
            matrix: {
                variants: [{ id: 'Standard' }]
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
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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
        const cleanQuery = query.replace(/^(?:ncsearch|nicovideo):/, '').trim();
        logger('debug', 'NicoVideo', `Searching for: ${cleanQuery}`);
        const params = new URLSearchParams({
            q: cleanQuery,
            targets: 'title,tags',
            fields: 'contentId,title,userId,thumbnailUrl,lengthSeconds',
            _sort: '-viewCounter',
            _context: 'NodeLink',
            _limit: '25'
        });
        const { body, error, statusCode } = await http1makeRequest(`https://snapshot.search.nicovideo.jp/api/v2/snapshot/video/contents/search?${params.toString()}`, { headers: this.buildHeaders() });
        if (error || statusCode !== 200) {
            return {
                loadType: 'error',
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
                author: item.userId ? `User ${item.userId}` : 'Unknown Artist',
                length: (item.lengthSeconds ?? 0) * 1000,
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
        const actionTrackId = `AAAAAAAAAA_${Date.now()}`;
        const apiUrl = `https://www.nicovideo.jp/api/watch/v3_guest/${videoId}?actionTrackId=${actionTrackId}`;
        const { body, error, statusCode } = await http1makeRequest(apiUrl, {
            headers: this.buildHeaders()
        });
        if (error || statusCode !== 200) {
            return {
                loadType: 'error',
                exception: {
                    message: `Failed to resolve URL: ${this.getRequestFailureMessage(error, statusCode)}`,
                    severity: 'fault'
                }
            };
        }
        const response = (this.isJsonRecord(body) ? body : null);
        const video = response?.data?.video;
        const owner = response?.data?.owner;
        if (!video?.id) {
            return {
                loadType: 'error',
                exception: {
                    message: 'Could not extract video information.',
                    severity: 'common'
                }
            };
        }
        const track = {
            identifier: video.id,
            isSeekable: true,
            author: owner?.nickname ?? 'Unknown Artist',
            length: (video.duration ?? 0) * 1000,
            isStream: false,
            position: 0,
            title: video.title ?? 'Unknown Title',
            uri: `https://www.nicovideo.jp/watch/${video.id}`,
            artworkUrl: video.thumbnail?.ogp ??
                video.thumbnail?.player ??
                video.thumbnail?.url ??
                null,
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
     * @returns Cached or freshly resolved HLS access data.
     */
    async getTrackUrl(track, _itag, forceRefresh = false) {
        if (!forceRefresh) {
            const cached = this.nodelink.trackCacheManager?.get('nicovideo', track.identifier) ?? null;
            if (cached) {
                return cached;
            }
        }
        const videoId = track.identifier && /^[a-zA-Z0-9_-]+$/.test(track.identifier)
            ? track.identifier
            : this.getVideoId(track.uri || '');
        if (!videoId) {
            throw new Error('Invalid NicoVideo identifier or URL.');
        }
        const actionTrackId = `AAAAAAAAAA_${Date.now()}`;
        const watchUrl = `https://www.nicovideo.jp/api/watch/v3_guest/${videoId}?actionTrackId=${actionTrackId}`;
        const { body: pageData, error, statusCode } = await http1makeRequest(watchUrl, {
            headers: this.buildHeaders()
        });
        if (error || statusCode !== 200 || !this.isJsonRecord(pageData)) {
            throw new Error(`Failed to get track page: ${this.getRequestFailureMessage(error, statusCode)}`);
        }
        const response = pageData;
        const dmcMedia = response.data?.media?.domand;
        const watchTrackId = response.data?.client?.watchTrackId;
        const accessRightKey = dmcMedia?.accessRightKey;
        if (!dmcMedia || !watchTrackId || !accessRightKey) {
            throw new Error('Failed to extract required DMC info for stream access.');
        }
        const streamRequestUrl = `https://nvapi.nicovideo.jp/v1/watch/${videoId}/access-rights/hls` +
            `?actionTrackId=${encodeURIComponent(watchTrackId)}&__retry=1`;
        const postBody = { outputs: this.buildOutputData(dmcMedia) };
        const { body: streamData, headers: streamHeaders, error: streamError, statusCode: streamStatus } = await http1makeRequest(streamRequestUrl, {
            method: 'POST',
            headers: {
                ...this.buildHeaders(accessRightKey),
                'Content-Type': 'application/json'
            },
            body: postBody,
            disableBodyCompression: true
        });
        if (streamError || streamStatus !== 201) {
            throw new Error(`Failed to get stream access rights: ${this.getRequestFailureMessage(streamError, streamStatus)}`);
        }
        const cookie = this.getCookieHeaderValue(streamHeaders);
        const masterPlaylistUrl = this.getAccessRightsResponse(streamData)?.data?.contentUrl;
        if (!masterPlaylistUrl) {
            throw new Error('Failed to extract master playlist URL.');
        }
        const { body: masterPlaylistContent, error: masterError, statusCode: masterStatus } = await http1makeRequest(masterPlaylistUrl, {
            headers: {
                ...this.buildHeaders(),
                ...(cookie ? { Cookie: cookie } : {})
            }
        });
        if (masterError ||
            masterStatus !== 200 ||
            typeof masterPlaylistContent !== 'string') {
            throw new Error(`Failed to fetch master HLS playlist: ${this.getRequestFailureMessage(masterError, masterStatus)}`);
        }
        const lines = masterPlaylistContent.split('\n');
        const audioTag = lines.find((line) => line.startsWith('#EXT-X-MEDIA') && line.includes('TYPE=AUDIO'));
        let playlistUrl = masterPlaylistUrl;
        if (audioTag) {
            const audioUri = audioTag.match(/URI="([^"]+)"/)?.[1];
            if (audioUri) {
                playlistUrl = new URL(audioUri, masterPlaylistUrl).toString();
            }
        }
        const result = {
            url: playlistUrl,
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
        throw new Error('Unsupported protocol');
    }
    /**
     * Executes a specific variant for testing.
     *
     * @param variant - The test variant to execute.
     * @param track - The track information.
     * @param streamSpec - Optional stream validation specifications.
     * @returns A result object detailing resolution and stream state.
     */
    async executeVariant(variant, track, streamSpec) {
        let urlData;
        try {
            urlData = await this.getTrackUrl(track);
        }
        catch (err) {
            return {
                variant: variant.id,
                resolved: false,
                error: err instanceof Error
                    ? err.message
                    : 'Failed to resolve track streaming URL'
            };
        }
        if (!urlData.url) {
            return {
                variant: variant.id,
                resolved: false,
                error: 'Failed to resolve track streaming URL'
            };
        }
        const container = 'mp4';
        const codec = 'aac';
        if (!streamSpec?.required) {
            return {
                variant: variant.id,
                resolved: true,
                track: urlData.newTrack?.info || track,
                container,
                codec
            };
        }
        let streamResult;
        try {
            streamResult = await this.loadStream(track, urlData.url, urlData.protocol, urlData.additionalData);
        }
        catch (err) {
            return {
                variant: variant.id,
                resolved: true,
                error: err instanceof Error ? err.message : 'Failed to load audio stream'
            };
        }
        if (!streamResult.stream) {
            return {
                variant: variant.id,
                resolved: true,
                error: 'Failed to load audio stream'
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
}
