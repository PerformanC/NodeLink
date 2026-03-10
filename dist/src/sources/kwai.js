import { PassThrough } from 'node:stream';
import { encodeTrack, http1makeRequest, logger, makeRequest } from "../utils.js";
/**
 * Kwai source implementation.
 */
export default class KwaiSource {
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
     * Creates a new Kwai source wrapper.
     *
     * @param nodelink - Worker runtime used by the source implementation.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.patterns = [
            /^https?:\/\/(?:www\.)?kwai\.com\/(?:@[\w-]+\/)?video\/(\d+)/
        ];
        this.priority = 60;
    }
    /**
     * Initializes the source.
     *
     * @returns `true` once the source has been registered.
     */
    async setup() {
        logger('info', 'Sources', 'Loaded Kwai source.');
        return true;
    }
    /**
     * Kwai does not support text search in this source.
     *
     * @param _query - Ignored search query.
     * @returns Exception payload describing the unsupported operation.
     */
    async search(_query) {
        return {
            exception: {
                message: 'Search not supported for Kwai',
                severity: 'fault',
                cause: 'Kwai Source'
            }
        };
    }
    /**
     * Resolves a Kwai URL into a single playable track.
     *
     * @param queryUrl - Candidate Kwai video URL.
     * @returns Track payload or an exception payload when resolution fails.
     */
    async resolve(queryUrl) {
        try {
            const videoId = this.getVideoId(queryUrl);
            const videoData = await this.getVideoInfo(videoId);
            const track = this.buildTrack(videoData, queryUrl, videoId);
            return { loadType: 'track', data: track };
        }
        catch (error) {
            return {
                exception: {
                    message: error instanceof Error ? error.message : 'Invalid Kwai URL',
                    severity: 'fault',
                    cause: 'Kwai Source'
                }
            };
        }
    }
    /**
     * Resolves the direct playback URL for a Kwai track.
     *
     * @param track - Decoded Kwai track information.
     * @returns Direct media URL descriptor or an exception payload when Kwai does
     * not expose the video URL anymore.
     */
    async getTrackUrl(track) {
        try {
            const videoData = await this.getVideoInfo(track.identifier);
            if (!videoData.videoUrl) {
                return {
                    exception: {
                        message: 'Video URL not found',
                        severity: 'fault',
                        cause: 'StreamLink'
                    }
                };
            }
            return {
                url: videoData.videoUrl,
                protocol: videoData.videoUrl.startsWith('https:') ? 'https' : 'http',
                format: 'mp4'
            };
        }
        catch (error) {
            return {
                exception: {
                    message: error instanceof Error ? error.message : 'Failed to get video URL',
                    severity: 'fault',
                    cause: 'StreamLink'
                }
            };
        }
    }
    /**
     * Opens a Kwai media stream from the direct media URL.
     *
     * @param _decodedTrack - Decoded track metadata, unused by this source.
     * @param url - Direct Kwai media URL.
     * @returns Playable stream payload or an exception payload when the upstream
     * request fails.
     */
    async loadStream(_decodedTrack, url) {
        try {
            const response = await http1makeRequest(url, {
                method: 'GET',
                streamOnly: true,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3',
                    Accept: '*/*'
                },
                disableBodyCompression: true
            });
            if (response.error || !response.stream) {
                throw new Error(response.error || 'Failed to get stream, no stream object returned.');
            }
            if (response.statusCode !== 200) {
                throw new Error(`Kwai returned status ${response.statusCode}`);
            }
            const stream = new PassThrough();
            response.stream.on('data', (chunk) => {
                stream.write(chunk);
            });
            response.stream.on('end', () => {
                stream.emit('finishBuffering');
            });
            response.stream.on('error', (error) => {
                logger('error', 'Kwai', `Upstream stream error: ${error.message}`);
                stream.emit('error', error);
                stream.emit('finishBuffering');
            });
            return { stream, type: 'mp4' };
        }
        catch (error) {
            return {
                exception: {
                    message: error instanceof Error ? error.message : 'Failed to load stream',
                    severity: 'fault',
                    cause: 'Kwai Source'
                }
            };
        }
    }
    /**
     * Extracts the Kwai video identifier from a URL.
     *
     * @param url - Candidate Kwai URL.
     * @returns Parsed Kwai video id.
     * @throws Error when the URL is missing or does not contain a video id.
     */
    getVideoId(url) {
        if (!url) {
            throw new Error('Kwai URL not provided');
        }
        const match = url.match(/\/video\/(\d+)/);
        if (!match?.[1]) {
            throw new Error('Kwai video ID not found');
        }
        return match[1];
    }
    /**
     * Decodes JavaScript-style unicode escape sequences.
     *
     * @param value - Raw string that may contain `\\uXXXX` sequences.
     * @returns Decoded string, or `null` when the input is empty.
     */
    decodeUnicodeEscapes(value) {
        if (!value) {
            return null;
        }
        return value.replace(/\\u([\dA-Fa-f]{4})/g, (_match, code) => String.fromCharCode(Number.parseInt(code, 16)));
    }
    /**
     * Fetches and parses the Kwai page metadata used by this source.
     *
     * @param videoId - Kwai video identifier.
     * @returns Parsed Kwai video metadata.
     * @throws Error when the page request fails or required media URLs are
     * missing.
     */
    async getVideoInfo(videoId) {
        const url = `https://www.kwai.com/video/${videoId}?responseType=json`;
        const response = await makeRequest(url, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3',
                Accept: '*/*'
            }
        });
        if (response.statusCode !== 200) {
            throw new Error(`Request failed with code ${response.statusCode}`);
        }
        if (typeof response.body !== 'string' || response.body.length === 0) {
            throw new Error('Error fetching video info');
        }
        const body = response.body;
        const mediaSection = body.match(/share_info:c,main_mv_urls:\s*\[(.*?)\]/)?.[1];
        const author = body.match(/kwai_id\s*:\s*"([^"]+)"/)?.[1] ?? 'Unknown';
        const durationText = body.match(/duration:\s*([\d]+)/)?.[1];
        let thumbnailUrl = body.match(/poster="([^"]+)"/)?.[1] ?? null;
        if (!thumbnailUrl) {
            const thumbnailMatch = body.match(/cover_thumbnail_urls:\[\{cdn:p,url:\s*"([^"]+)"/);
            thumbnailUrl = this.decodeUnicodeEscapes(thumbnailMatch?.[1] ?? null);
        }
        if (!mediaSection) {
            throw new Error('Video URL not found in response');
        }
        const videoUrlMatch = mediaSection.match(/url:\s*"([^"]+)"/)?.[1];
        const videoUrl = this.decodeUnicodeEscapes(videoUrlMatch ?? null);
        if (!videoUrl) {
            throw new Error('Could not extract video URL');
        }
        return {
            author,
            title: author === 'Unknown' ? 'Kwai Video' : `Kwai - ${author}`,
            length: durationText ? Number.parseInt(durationText, 10) * 1000 : 0,
            thumbnail: thumbnailUrl,
            videoUrl
        };
    }
    /**
     * Builds the encoded track payload for a Kwai video.
     *
     * @param videoData - Parsed Kwai metadata.
     * @param queryUrl - Original Kwai page URL.
     * @param videoId - Kwai video identifier.
     * @returns Track payload compatible with the shared encoder and source
     * manager contracts.
     */
    buildTrack(videoData, queryUrl, videoId) {
        const trackInfo = {
            identifier: videoId,
            title: videoData.title,
            author: videoData.author,
            length: videoData.length,
            sourceName: 'kwai',
            artworkUrl: videoData.thumbnail,
            uri: queryUrl,
            isStream: false,
            isSeekable: true,
            position: 0,
            isrc: null,
            details: []
        };
        return {
            encoded: encodeTrack(trackInfo),
            info: trackInfo,
            pluginInfo: {}
        };
    }
}
