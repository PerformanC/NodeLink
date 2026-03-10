import { PassThrough } from 'node:stream';
import { encodeTrack, http1makeRequest, logger } from "../utils.js";
/**
 * Pinterest source implementation.
 */
export default class PinterestSource {
    /**
     * Runtime NodeLink context.
     */
    nodelink;
    /**
     * Cached runtime configuration.
     */
    config;
    /**
     * URL patterns handled by the source.
     */
    patterns;
    /**
     * URL matching priority for the source manager.
     */
    priority;
    /**
     * Creates the Pinterest source wrapper.
     *
     * @param nodelink - Worker runtime used by the source implementation.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.config = nodelink.options;
        this.patterns = [
            /https?:\/\/(?:[^/]+\.)?pinterest\.(?:com|fr|de|ch|jp|cl|ca|it|co\.uk|nz|ru|com\.au|at|pt|co\.kr|es|com\.mx|dk|ph|th|com\.uy|co|nl|info|kr|ie|vn|com\.vn|ec|mx|in|pe|co\.at|hu|co\.in|co\.nz|id|com\.ec|com\.py|tw|be|uk|com\.bo|com\.pe)\/pin\/(?:[\w-]+--)?(\d+)/i
        ];
        this.priority = 100;
    }
    /**
     * Validates whether the provided value is a plain object record.
     *
     * @param value - Candidate response payload.
     * @returns `true` when the value can be safely indexed.
     */
    isObjectRecord(value) {
        return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    }
    /**
     * Builds the Pinterest resource URL used to query pin metadata.
     *
     * @param videoId - Pinterest pin identifier.
     * @returns Fully qualified Pinterest resource URL.
     */
    buildPinResourceUrl(videoId) {
        return `https://www.pinterest.com/resource/PinResource/get/?data=${encodeURIComponent(JSON.stringify({
            options: {
                field_set_key: 'unauth_react_main_pin',
                id: videoId
            }
        }))}`;
    }
    /**
     * Extracts the pin identifier from a Pinterest URL.
     *
     * @param url - Candidate Pinterest URL.
     * @returns Pin identifier, or `null` when the URL does not match the source
     * pattern.
     */
    getVideoId(url) {
        const pattern = this.patterns[0];
        if (!pattern) {
            return null;
        }
        const match = url.match(pattern);
        return match?.[1] ?? null;
    }
    /**
     * Narrows the raw HTTP response body returned by Pinterest.
     *
     * @param value - Raw response body.
     * @returns Typed Pinterest API response, or `null` when the payload does not
     * match the expected structure.
     */
    getPinterestApiResponse(value) {
        if (!this.isObjectRecord(value)) {
            return null;
        }
        const payload = value;
        const resourceResponse = payload.resource_response;
        if (!this.isObjectRecord(resourceResponse)) {
            return null;
        }
        const data = resourceResponse.data;
        if (!this.isObjectRecord(data)) {
            return null;
        }
        const parsedData = this.getPinData(data);
        if (!parsedData) {
            return null;
        }
        return {
            resource_response: {
                data: parsedData
            }
        };
    }
    /**
     * Narrows a raw pin payload from the Pinterest API.
     *
     * @param value - Candidate pin payload.
     * @returns Typed pin data, or `null` when the payload is not object-like.
     */
    getPinData(value) {
        if (!this.isObjectRecord(value)) {
            return null;
        }
        return value;
    }
    /**
     * Resolves the video list from either a standard pin or a story pin block.
     *
     * @param data - Typed pin payload.
     * @returns Available video list, or `null` when the pin has no playable
     * video payload.
     */
    getVideoList(data) {
        if (data.videos?.video_list) {
            return data.videos.video_list;
        }
        const blocks = data.story_pin_data?.pages?.[0]?.blocks;
        if (!Array.isArray(blocks)) {
            return null;
        }
        for (const block of blocks) {
            if (block.video?.video_list) {
                return block.video.video_list;
            }
        }
        return null;
    }
    /**
     * Selects the preferred playable video format from the Pinterest payload.
     *
     * @param videoList - Available Pinterest video variants.
     * @returns Preferred format, or `null` when no usable format exists.
     */
    getPreferredFormat(videoList) {
        if (!videoList) {
            return null;
        }
        return (videoList.V_720P ??
            videoList.V_540P ??
            videoList.V_360P ??
            Object.values(videoList)[0] ??
            null);
    }
    /**
     * Selects the first MP4-compatible format from the Pinterest payload.
     *
     * @param videoList - Available Pinterest video variants.
     * @returns First playable MP4-capable format, or `null` when none are found.
     */
    getPlayableFormat(videoList) {
        if (!videoList) {
            return null;
        }
        if (videoList.V_720P?.url)
            return videoList.V_720P;
        if (videoList.V_540P?.url)
            return videoList.V_540P;
        if (videoList.V_360P?.url)
            return videoList.V_360P;
        for (const format of Object.values(videoList)) {
            if (format?.url?.endsWith('.mp4')) {
                return format;
            }
        }
        return null;
    }
    /**
     * Resolves the best artwork URL attached to the pin payload.
     *
     * @param images - Pinterest image variants.
     * @returns Artwork URL, or `null` when no image URL exists.
     */
    getArtworkUrl(images) {
        if (typeof images?.orig?.url === 'string' && images.orig.url.length > 0) {
            return images.orig.url;
        }
        if (!images) {
            return null;
        }
        for (const image of Object.values(images)) {
            if (typeof image?.url === 'string' && image.url.length > 0) {
                return image.url;
            }
        }
        return null;
    }
    /**
     * Builds the encoded track information returned by the source manager.
     *
     * @param videoId - Pinterest pin identifier.
     * @param data - Typed pin payload.
     * @param format - Preferred playable format.
     * @returns Track payload compatible with the shared encoder.
     */
    createTrackInfo(videoId, data, format) {
        return {
            identifier: videoId,
            isSeekable: true,
            author: data.closeup_attribution?.full_name ??
                data.pinner?.full_name ??
                'Unknown Artist',
            length: typeof format.duration === 'number' && Number.isFinite(format.duration)
                ? Math.round(format.duration)
                : 0,
            isStream: false,
            position: 0,
            title: data.title ?? data.grid_title ?? 'Pinterest Video',
            uri: `https://www.pinterest.com/pin/${videoId}/`,
            artworkUrl: this.getArtworkUrl(data.images),
            isrc: null,
            sourceName: 'pinterest',
            details: []
        };
    }
    /**
     * Fetches and narrows the Pinterest pin payload for a specific pin id.
     *
     * @param videoId - Pinterest pin identifier.
     * @returns Typed pin payload, or `null` when the API response is missing or
     * malformed.
     */
    async fetchPinData(videoId) {
        const response = await http1makeRequest(this.buildPinResourceUrl(videoId), {
            headers: {
                'X-Pinterest-PWS-Handler': 'www/[username].js'
            }
        });
        if (response.statusCode !== 200) {
            return null;
        }
        return (this.getPinterestApiResponse(response.body)
            ?.resource_response?.data ?? null);
    }
    /**
     * Initializes the source.
     *
     * The Pinterest source does not require any asynchronous bootstrapping, so
     * setup always succeeds.
     *
     * @returns `true` to indicate the source is ready.
     */
    async setup() {
        return true;
    }
    /**
     * Resolves a Pinterest URL to a playable encoded track payload.
     *
     * @param url - Candidate Pinterest pin URL.
     * @returns Source resolution result describing either a playable track, an
     * empty response, or an error payload.
     */
    async resolve(url) {
        const videoId = this.getVideoId(url);
        if (videoId === null) {
            return { loadType: 'empty', data: {} };
        }
        try {
            const data = await this.fetchPinData(videoId);
            if (!data) {
                return { loadType: 'empty', data: {} };
            }
            const bestFormat = this.getPreferredFormat(this.getVideoList(data));
            if (!bestFormat) {
                return { loadType: 'empty', data: {} };
            }
            const trackInfo = this.createTrackInfo(videoId, data, bestFormat);
            return {
                loadType: 'track',
                data: {
                    encoded: encodeTrack(trackInfo),
                    info: trackInfo
                }
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Pinterest resolution failed.';
            logger('error', 'Pinterest', `Resolution failed: ${message}`);
            return {
                loadType: 'error',
                data: { message, severity: 'fault' }
            };
        }
    }
    /**
     * Resolves the direct stream URL for a Pinterest track.
     *
     * @param decodedTrack - Decoded track information previously returned by the
     * resolver.
     * @returns Direct HTTP track URL and its container metadata.
     * @throws Error when Pinterest does not expose a playable MP4 stream.
     */
    async getTrackUrl(decodedTrack) {
        const videoId = decodedTrack.identifier;
        try {
            const data = await this.fetchPinData(videoId);
            if (!data) {
                throw new Error('Failed to fetch Pinterest video URL');
            }
            const format = this.getPlayableFormat(this.getVideoList(data));
            if (!format?.url) {
                throw new Error('No MP4 format found for Pinterest video');
            }
            return { url: format.url, protocol: 'http', format: 'mp4' };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to get track URL.';
            logger('error', 'Pinterest', `Failed to get track URL: ${message}`);
            throw error;
        }
    }
    /**
     * Opens a proxied stream for a Pinterest video URL.
     *
     * The upstream stream is piped through a local `PassThrough` so the player
     * can receive buffering lifecycle events without depending on the original
     * HTTP stream object.
     *
     * @param _decodedTrack - Decoded track metadata, unused by this source.
     * @param url - Direct media URL returned by `getTrackUrl(...)`.
     * @param _protocol - Protocol hint, unused by this source.
     * @param _additionalData - Additional stream metadata, unused by this source.
     * @returns Playable stream payload, or an exception object when the upstream
     * request fails.
     */
    async loadStream(_decodedTrack, url, _protocol, _additionalData) {
        try {
            const response = await http1makeRequest(url, {
                method: 'GET',
                streamOnly: true,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3',
                    Accept: '*/*'
                }
            });
            if (response.error || !response.stream) {
                throw new Error(typeof response.error === 'string' && response.error.length > 0
                    ? response.error
                    : 'Failed to get stream, no stream object returned.');
            }
            const stream = new PassThrough();
            response.stream.on('data', (chunk) => {
                stream.write(chunk);
            });
            response.stream.on('end', () => {
                stream.emit('finishBuffering');
            });
            response.stream.on('error', (error) => {
                logger('error', 'Pinterest', `Upstream stream error: ${error.message}`);
                stream.emit('error', error);
                stream.emit('finishBuffering');
            });
            return { stream, type: 'mp4' };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to load stream.';
            logger('error', 'Pinterest', `Failed to load stream: ${message}`);
            return {
                exception: {
                    message,
                    severity: 'fault'
                }
            };
        }
    }
}
