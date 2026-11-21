import { PassThrough } from 'node:stream';
import { encodeTrack, http1makeRequest, logger } from '../utils.js';
/**
 * Browser user agent sent with TikTok requests.
 * @internal
 */
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
/**
 * TikTok player API endpoint used by embeds.
 * @internal
 */
const API_BASE = 'https://www.tiktok.com/player/api/v1/items';
/**
 * Regex pattern to extract the video ID from a TikTok URL.
 * @internal
 */
const VIDEO_ID_RE = /\/video\/(\d{15,})/;
/**
 * Returns the first valid string from an array of unknown values.
 * @param list - Array of unknown values (usually strings from API).
 * @returns The first valid string, or an empty string if none found.
 * @internal
 */
function firstString(list) {
    if (Array.isArray(list)) {
        for (const v of list) {
            if (typeof v === 'string' && v.length)
                return v;
        }
    }
    return '';
}
/**
 * TikTok source implementation.
 *
 * Resolves `tiktok.com/@user/video/ID` URLs and extracts MP4 playback streams
 * using the TikTok player API endpoint.
 * @public
 */
export default class TiktokSource {
    /**
     * Declarative test suite for validating TikTok source behavior.
     */
    static _TESTS = [
        {
            id: 'tiktok.video.stream',
            name: 'TikTok standard video playback',
            input: {
                type: 'resolve',
                value: 'https://www.tiktok.com/@scout2015/video/6718335390845095173'
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
                        value: 'Scout'
                    },
                    sourceName: {
                        op: 'equals',
                        value: 'tiktok'
                    }
                },
                stream: {
                    required: true,
                    download: 'complete',
                    minBytes: 100000,
                    validFormats: [{ container: 'mp4', codec: 'aac' }]
                }
            },
            forbid: {
                resultTypes: ['empty', 'error']
            }
        }
    ];
    /**
     * Runtime worker context.
     */
    nodelink;
    /**
     * URL patterns this source handles.
     */
    patterns;
    /**
     * Match priority used by the source manager (higher wins).
     */
    priority;
    /**
     * Creates a new TikTok source wrapper.
     * @param nodelink - Worker runtime context.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.patterns = [
            /^https?:\/\/(?:www\.)?tiktok\.com\/@[\w.-]+\/video\/(\d+)/i,
            /^https?:\/\/(?:www\.)?tiktok\.com\/t\/([\w-]+)/i,
            /^https?:\/\/(?:www\.)?vm\.tiktok\.com\/([\w-]+)/i,
            /^https?:\/\/(?:www\.)?vt\.tiktok\.com\/([\w-]+)/i,
            /^https?:\/\/(?:www\.)?m\.tiktok\.com\/([\w-]+)/i
        ];
        this.priority = 60;
    }
    /**
     * Initializes source resources. No async setup required.
     * @returns `true` when the source is ready to accept requests.
     */
    async setup() {
        logger('info', 'Sources', 'Loaded TikTok source.');
        return true;
    }
    /**
     * TikTok does not support keyword search.
     * @param _query - Unused search query.
     * @param _sourceName - Unused source name.
     * @param _searchType - Unused search type.
     * @returns An empty result.
     */
    async search(_query, _sourceName, _searchType) {
        return { loadType: 'empty', data: {} };
    }
    /**
     * Resolves a TikTok video URL into a playable track.
     *
     * Fetches metadata and playback URLs from the TikTok player API endpoint.
     * @param url - Public TikTok video URL.
     * @param _type - Unused type hint kept for source-manager compatibility.
     * @returns A track result, an empty payload, or a structured exception.
     */
    async resolve(url, _type) {
        let targetUrl = url;
        let match = targetUrl.match(VIDEO_ID_RE);
        let videoId = match?.[1];
        if (!videoId) {
            try {
                const headRes = await fetch(targetUrl, {
                    method: 'HEAD',
                    redirect: 'follow',
                    headers: { 'User-Agent': USER_AGENT }
                });
                targetUrl = headRes.url;
                match = targetUrl.match(VIDEO_ID_RE);
                videoId = match?.[1];
            }
            catch {
                // Continue and check if videoId resolved
            }
        }
        if (!videoId)
            return { loadType: 'empty', data: {} };
        try {
            const params = new URLSearchParams({
                item_ids: videoId,
                language: 'en',
                aid: '1284',
                app_name: 'tiktok_web',
                device_platform: 'web_pc'
            });
            const response = await http1makeRequest(`${API_BASE}?${params}`, {
                method: 'GET',
                headers: {
                    'User-Agent': USER_AGENT,
                    Referer: `https://www.tiktok.com/player/v1/${videoId}`,
                    Accept: 'application/json, text/plain, */*'
                }
            });
            if (response.error || response.statusCode !== 200) {
                return {
                    loadType: 'error',
                    exception: {
                        message: `TikTok API failed: ${response.error || `Status ${response.statusCode}`}`,
                        severity: 'fault'
                    }
                };
            }
            let data = response.body;
            if (typeof data === 'string') {
                try {
                    data = JSON.parse(data);
                }
                catch {
                    return {
                        loadType: 'error',
                        exception: { message: 'Invalid TikTok JSON', severity: 'fault' }
                    };
                }
            }
            const items = data?.items;
            const item = (Array.isArray(items) ? items[0] : undefined);
            if (!item)
                return { loadType: 'empty', data: {} };
            const vi = item.video_info ?? {};
            const profile = Array.isArray(vi.profiles) ? vi.profiles[0] : null;
            const directUrl = firstString(profile?.play_addr?.url_list) || firstString(vi.url_list);
            if (!directUrl) {
                return {
                    loadType: 'error',
                    exception: {
                        message: 'No playback URL in TikTok response',
                        severity: 'fault'
                    }
                };
            }
            const author = item.author_info?.nickname || 'TikTok User';
            const desc = item.desc || '';
            const title = desc.split('#')[0]?.trim() || 'TikTok Video';
            const rawDuration = vi.meta?.duration ?? 0;
            const durationMs = rawDuration > 0
                ? rawDuration < 1000
                    ? rawDuration * 1000
                    : rawDuration
                : -1;
            const thumbnail = firstString(vi.cover?.url_list) || null;
            const info = {
                identifier: videoId,
                isSeekable: true,
                author,
                length: durationMs,
                isStream: false,
                position: 0,
                title,
                uri: url,
                artworkUrl: thumbnail,
                isrc: null,
                sourceName: 'tiktok',
                details: []
            };
            const trackData = {
                encoded: encodeTrack(info),
                info: info,
                pluginInfo: { directUrl, videoId }
            };
            return { loadType: 'track', data: trackData };
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            logger('error', 'TikTok', `Resolve failed: ${message}`);
            return { loadType: 'error', exception: { message, severity: 'fault' } };
        }
    }
    /**
     * Returns the cached or resolved direct playback URL.
     *
     * When the track already carries a `pluginInfo.directUrl`, the URL is
     * returned immediately. Otherwise the video is re-resolved.
     * @param trackInfo - Decoded TikTok track information.
     * @param _itag - Unused itag placeholder kept for source-manager compatibility.
     * @param _isRecovering - Whether this is a recovery attempt.
     * @returns Direct playback URL metadata or throws an error.
     */
    async getTrackUrl(trackInfo, _itag, _isRecovering) {
        const pluginInfo = trackInfo
            .pluginInfo;
        const directUrl = pluginInfo?.directUrl;
        if (directUrl && typeof directUrl === 'string') {
            return { url: directUrl, protocol: 'https', format: 'mp4' };
        }
        const uri = trackInfo.uri;
        if (uri && VIDEO_ID_RE.test(uri)) {
            const result = await this.resolve(uri);
            if (result.loadType === 'track') {
                const trackData = result.data;
                const url = trackData?.pluginInfo?.directUrl;
                if (url)
                    return { url, protocol: 'https', format: 'mp4' };
            }
        }
        throw new Error('No playable URL for TikTok track');
    }
    /**
     * Loads the MP4 stream for a TikTok video.
     *
     * Proxies the direct playback URL through a `PassThrough` stream.
     * @param _track - Decoded track information.
     * @param url - Resolved playback URL.
     * @param _protocol - Optional protocol hint (unused).
     * @param _additionalData - Optional additional data (unused).
     * @returns A readable stream or throws an error.
     */
    async loadStream(_track, url, _protocol, _additionalData) {
        const response = await http1makeRequest(url, {
            method: 'GET',
            streamOnly: true,
            headers: {
                'User-Agent': USER_AGENT,
                Referer: 'https://www.tiktok.com/'
            }
        });
        if (response.error || !response.stream) {
            throw new Error(response.error || 'No stream returned');
        }
        const stream = new PassThrough();
        const upstream = response.stream;
        upstream.on('data', (chunk) => {
            if (!stream.write(chunk)) {
                upstream.pause();
            }
        });
        stream.on('drain', () => {
            if (!stream.destroyed) {
                upstream.resume();
            }
        });
        upstream.on('end', () => {
            if (!stream.writableEnded) {
                stream.emit('finishBuffering');
                stream.end();
            }
        });
        upstream.on('error', (err) => {
            if (!stream.destroyed) {
                stream.destroy(err);
            }
        });
        return { stream, type: 'video/mp4' };
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
