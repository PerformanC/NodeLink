/**
 * YouTube Music (Android) Client
 *
 * Implements the YouTube ANDROID_MUSIC innertube client for YouTube Music
 * mobile app emulation. Provides search and resolve capabilities for
 * YouTube Music content but does not provide direct track URLs.
 *
 * @packageDocumentation
 * @module YouTubeMusicClient
 */
import { logger, makeRequest } from '../../../utils.js';
import { BaseClient, buildTrack, checkURLType, YOUTUBE_CONSTANTS } from '../common.js';
/**
 * YouTube ANDROID_MUSIC innertube client.
 *
 * Emulates the YouTube Music Android app for API requests.
 * Search and resolve are supported; track URL resolution returns an exception
 * since this client does not provide direct playback URLs.
 *
 * @public
 */
export default class Music extends BaseClient {
    /**
     * Creates a new Music client instance.
     *
     * @param nodelink - NodeLink worker instance providing options and source access
     * @param oauth - OAuth manager for authenticated requests, or null if unauthenticated
     */
    constructor(nodelink, oauth) {
        super(nodelink, 'ANDROID_MUSIC', oauth);
    }
    /**
     * Builds the YouTube client context for ANDROID_MUSIC innertube requests.
     *
     * @param context - General YouTube context with language, region, and visitor data
     * @returns Client context object describing this ANDROID_MUSIC client configuration
     */
    getClient(context) {
        return {
            client: {
                clientName: 'ANDROID_MUSIC',
                clientVersion: '8.47.54',
                userAgent: 'com.google.android.apps.youtube.music/8.47.54 (Linux; U; Android 14 gzip)',
                deviceMake: 'Google',
                deviceModel: 'Pixel 6',
                osName: 'Android',
                osVersion: '14',
                androidSdkVersion: '30',
                hl: context.client.hl,
                gl: context.client.gl
            },
            user: { lockedSafetyMode: false },
            request: { useSsl: true }
        };
    }
    /**
     * Searches YouTube Music for tracks matching the given query.
     *
     * @param query - Search query string (e.g., song name, artist)
     * @param type - Search type hint ('track', 'playlist', 'album', 'artist')
     * @param context - YouTube context with language and region settings
     * @returns Search result with tracks or an exception
     */
    async search(query, type, context) {
        const sourceName = 'ytmusic';
        let params = 'EgWKAQIIAWoQEAMQBBAJEAoQBRAREBAQFQ%3D%3D'; // Default (Tracks)
        if (type === 'playlist')
            params = 'EgWKAQIoAWoKEAMQBBAJEAoQBRAB';
        if (type === 'album')
            params = 'EgWKAQIYAWoKEAMQBBAJEAoQBRAB';
        if (type === 'artist')
            params = 'EgWKAQIYAWoKEAMQBBAJEAoQBRAB';
        const requestBody = {
            context: this.getClient(context),
            query: query,
            params
        };
        const { body: searchResultRaw, error, statusCode } = await makeRequest('https://music.youtube.com/youtubei/v1/search', {
            method: 'POST',
            headers: {
                'User-Agent': this.getClient(context).client.userAgent,
                'X-Goog-Api-Format-Version': '2'
            },
            body: requestBody,
            disableBodyCompression: true,
            proxy: this.getProxy()
        });
        const searchResult = searchResultRaw;
        if (error || statusCode !== 200) {
            const message = error ||
                `Failed to load results from ${sourceName}. Status: ${statusCode}`;
            logger('error', 'YouTube-Music', message);
            return {
                loadType: 'error',
                exception: { message, severity: 'common', cause: 'Upstream' }
            };
        }
        if (searchResult.error) {
            logger('error', 'YouTube-Music', `Error from ${sourceName} search API: ${searchResult.error.message}`);
            return {
                loadType: 'error',
                exception: {
                    message: searchResult.error.message,
                    severity: 'fault',
                    cause: 'Upstream'
                }
            };
        }
        const tabContent = searchResult.contents?.tabbedSearchResultsRenderer
            ?.tabs?.[0]?.tabRenderer?.content;
        const tracks = [];
        let videos = null;
        const findShelf = (contents) => {
            if (!Array.isArray(contents))
                return null;
            for (const section of contents) {
                const sec = section;
                if (sec.musicShelfRenderer) {
                    return sec.musicShelfRenderer.contents;
                }
            }
            return null;
        };
        if (tabContent?.sectionListRenderer) {
            videos = findShelf(tabContent.sectionListRenderer.contents);
        }
        if (!videos &&
            tabContent?.musicSplitViewRenderer?.mainContent?.sectionListRenderer) {
            videos = findShelf(tabContent.musicSplitViewRenderer.mainContent.sectionListRenderer
                .contents);
        }
        if (!videos || videos.length === 0) {
            logger('debug', 'YouTube-Music', `No matches found on ${sourceName} for: ${query}`);
            return { loadType: 'empty', data: {} };
        }
        for (const video of videos) {
            const videoObj = video;
            const renderer = videoObj.musicResponsiveListItemRenderer ||
                videoObj.musicTwoColumnItemRenderer;
            if (!renderer) {
                continue;
            }
            const track = await buildTrack(video, 'ytmusic', 'ytmusic', searchResult);
            if (track) {
                tracks.push(track);
            }
        }
        return { loadType: 'search', data: tracks };
    }
    /**
     * Resolves a YouTube URL to track or playlist data.
     *
     * @param url - YouTube URL to resolve
     * @param _type - URL type hint (unused)
     * @param context - YouTube context with language and region settings
     * @param cipherManager - Cipher manager for signature deciphering
     * @returns Resolved track/playlist data or an exception
     */
    async resolve(url, _type, context, cipherManager) {
        const sourceName = 'ytmusic';
        const urlType = checkURLType(url, sourceName);
        switch (urlType) {
            case YOUTUBE_CONSTANTS.VIDEO:
            case YOUTUBE_CONSTANTS.SHORTS: {
                const idPattern = /(?:v=|\/shorts\/|youtu\.be\/)([^&?]+)/;
                const videoIdMatch = url.match(idPattern);
                if (!videoIdMatch?.[1]) {
                    logger('error', 'YouTube-Music', `Could not parse video ID from URL: ${url}`);
                    return {
                        loadType: 'error',
                        exception: {
                            message: 'Invalid video URL.',
                            severity: 'common',
                            cause: 'Input'
                        }
                    };
                }
                const videoId = videoIdMatch[1];
                const { body: playerResponse, statusCode } = await this._makePlayerRequest(videoId, context, {}, cipherManager);
                if (statusCode !== 200) {
                    const message = `Failed to load video/short player data. Status: ${statusCode}`;
                    logger('error', 'YouTube-Music', message);
                    return {
                        loadType: 'error',
                        exception: { message, severity: 'common', cause: 'Upstream' }
                    };
                }
                return await this._handlePlayerResponse(playerResponse, sourceName, videoId);
            }
            case YOUTUBE_CONSTANTS.PLAYLIST: {
                const listIdMatch = url.match(/[?&]list=([\w-]+)/);
                if (!listIdMatch?.[1]) {
                    return { loadType: 'empty', data: {} };
                }
                const playlistId = listIdMatch[1];
                const body = {
                    context: this.getClient(context),
                    playlistId,
                    enablePersistentPlaylistPanel: true,
                    isAudioOnly: true
                };
                const { body: res, statusCode } = await makeRequest('https://music.youtube.com/youtubei/v1/next', {
                    method: 'POST',
                    body,
                    headers: {
                        'User-Agent': this.getClient(context).client.userAgent,
                        'X-Goog-Api-Format-Version': '2'
                    },
                    disableBodyCompression: true,
                    proxy: this.getProxy()
                });
                if (statusCode !== 200 || !res) {
                    return { loadType: 'empty', data: {} };
                }
                return await this._handlePlaylistResponse(playlistId, null, res, sourceName, context);
            }
            default:
                return { loadType: 'empty', data: {} };
        }
    }
    /**
     * Returns an exception indicating the Music client does not provide direct track URLs.
     *
     * @param _decodedTrack - Decoded track information (unused)
     * @param _context - YouTube context (unused)
     * @param _cipherManager - Cipher manager (unused)
     * @returns Exception indicating no direct URLs are available
     */
    async getTrackUrl(_decodedTrack, _context, _cipherManager) {
        return {
            loadType: 'error',
            exception: {
                message: 'Music client does not provide direct track URLs.',
                severity: 'common'
            }
        };
    }
}
