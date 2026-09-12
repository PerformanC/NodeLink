import { logger, makeRequest } from '../../../utils.js';
import { BaseClient, buildTrack, checkURLType, YOUTUBE_CONSTANTS } from '../common.js';
/**
 * YouTube Music (WEB_REMIX) client implementation.
 *
 * Uses the YouTube Music innertube API to search for tracks,
 * resolve playlist URLs, and provide track metadata. This client
 * does not provide direct stream URLs.
 *
 * @public
 */
export default class WebRemix extends BaseClient {
    /**
     * @param nodelink - NodeLink worker instance providing options, sources, and logging
     * @param oauth - OAuth manager for authenticated requests, or null if unauthenticated
     */
    constructor(nodelink, oauth) {
        super(nodelink, 'WEB_REMIX', oauth);
    }
    /**
     * Returns the YouTube Music client context for innertube requests.
     *
     * This is only used for getting the videoDetails, no playback.
     * @param context - General YouTube context with language, region, and visitor data
     * @returns Client context configured for WEB_REMIX
     */
    getClient(context) {
        return {
            client: {
                clientName: 'WEB_REMIX',
                clientVersion: '1.20260721.00.00',
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) YouTubeMusic/3.12.0 Chrome/148.0.7778.271 Electron/42.5.0 Safari/537.36',
                hl: context.client.hl,
                gl: context.client.gl,
                applicationState: 'ACTIVE'
            },
            user: { lockedSafetyMode: false },
            request: { useSsl: true }
        };
    }
    /**
     * Whether this client requires a player script for signature deciphering.
     * @returns false — WEB_REMIX does not need cipher resolution
     */
    requirePlayerScript() {
        return false;
    }
    /**
     * Searches YouTube Music for tracks, playlists, albums, or artists.
     * @param query - Search query string
     * @param type - Search type ('track', 'playlist', 'album', 'artist')
     * @param context - YouTube context with language and region settings
     * @returns Search results with matched tracks or an exception
     */
    async search(query, type, context) {
        const sourceName = 'ytmusic';
        let params = 'EgWKAQIIAWoQEAQQAxAJEAUQChAQEBUQEQ%3D%3D'; // Default (Tracks)
        if (type === 'playlist')
            params = 'EgeKAQQoAEABahAQBBADEAkQBRAKEBAQFRAR';
        if (type === 'album')
            params = 'EgWKAQIYAWoQEAQQAxAJEAUQChAQEBUQEQ%3D%3D';
        if (type === 'artist')
            params = 'EgWKAQIgAWoQEAQQAxAJEAUQChAQEBUQEQ%3D%3D';
        const requestBody = {
            context: this.getClient(context),
            query: query,
            params
        };
        const { body: searchResultRaw, error, statusCode } = await makeRequest('https://music.youtube.com/youtubei/v1/search?prettyPrint=false', {
            method: 'POST',
            headers: {
                'User-Agent': this.getClient(context).client.userAgent,
                'X-Goog-Api-Format-Version': '2'
            },
            body: requestBody,
            disableBodyCompression: true,
            proxy: this.getProxy()
        });
        if (error || statusCode !== 200) {
            const message = error ||
                `Failed to load results from ${sourceName}. Status: ${statusCode}`;
            logger('error', 'YouTube-Music', message);
            return {
                loadType: 'error',
                exception: { message, severity: 'common', cause: 'Upstream' }
            };
        }
        const searchResult = searchResultRaw;
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
        const tabContent = searchResult.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer
            ?.content;
        const _loggedVideoData = false;
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
            const v = video;
            const renderer = v.musicResponsiveListItemRenderer ||
                v.musicTwoColumnItemRenderer ||
                (v.videoId ? v : null);
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
     * Resolves a YouTube Music URL to track or playlist data.
     * @param url - YouTube or YouTube Music URL
     * @param _type - Source type override (unused)
     * @param context - YouTube context with language and region settings
     * @param cipherManager - Cipher manager instance (unused for WEB_REMIX)
     * @returns Resolved track or playlist data, or an exception
     */
    async resolve(url, _type, context, cipherManager) {
        const sourceName = 'ytmusic';
        const urlType = checkURLType(url, sourceName);
        const _apiEndpoint = this.getApiEndpoint();
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
                const { body: resRaw, statusCode } = await makeRequest('https://music.youtube.com/youtubei/v1/next', {
                    method: 'POST',
                    body,
                    headers: {
                        'User-Agent': this.getClient(context).client.userAgent,
                        'X-Goog-Api-Format-Version': '2'
                    },
                    disableBodyCompression: true,
                    proxy: this.getProxy()
                });
                if (statusCode !== 200 || !resRaw) {
                    return { loadType: 'empty', data: {} };
                }
                const res = resRaw;
                return await this._handlePlaylistResponse(playlistId, null, res, sourceName, context);
            }
            default:
                return { loadType: 'empty', data: {} };
        }
    }
    /**
     * Retrieves a playable stream URL for a track.
     * WEB_REMIX does not provide direct track URLs.
     * @param _decodedTrack - Decoded track information (unused)
     * @param _context - YouTube context (unused)
     * @param _cipherManager - Cipher manager instance (unused)
     * @returns Exception indicating this client cannot resolve stream URLs
     */
    async getTrackUrl(_decodedTrack, _context, _cipherManager) {
        return {
            loadType: 'error',
            exception: {
                message: 'WebRemix client does not provide direct track URLs.',
                severity: 'common'
            }
        };
    }
}
