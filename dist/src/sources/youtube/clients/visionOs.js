/**
 * YouTube Vision OS Client
 *
 * Implements the YouTube Vision OS client for Apple Vision Pro
 * This seems to be a Internal youtube client. It does not require
 * a login to function, just like ANDROID_VR.
 * As of this date (08/16/2026), its more reliable than ANDROID_VR.
 *
 * @packageDocumentation
 * @module YouTubeVisionOSClient
 */
import { logger, makeRequest } from '../../../utils.js';
import { BaseClient, buildTrack, checkURLType, YOUTUBE_CONSTANTS } from '../common.js';
/**
 * YouTube VISIONOS innertube client.
 *
 * Emulates an Apple Vision Pro headset for YouTube API requests.
 * Does not require a player script for signature deciphering.
 *
 * @public
 */
export default class VisionOs extends BaseClient {
    /**
     * Creates a new VisionOs client instance.
     *
     * @param nodelink - NodeLink worker instance providing options and source access
     * @param oauth - OAuth manager for authenticated requests, or null if unauthenticated
     */
    constructor(nodelink, oauth) {
        super(nodelink, 'VISIONOS', oauth);
    }
    /**
     * Builds the YouTube client context for VISIONOS innertube requests.
     *
     * @param context - General YouTube context with language, region, and visitor data
     * @returns Client context object describing this VISIONOS client configuration
     */
    getClient(context) {
        return {
            client: {
                clientName: 'VISIONOS',
                clientVersion: '0.1',
                userAgent: 'com.google.ios.youtube/0.1 (RealityDevice14,1; U; CPU visionOS 1_3 like Mac OS X;)',
                deviceMake: 'Apple',
                deviceModel: 'RealityDevice14,1',
                osName: 'visionOS',
                osVersion: '1.3.21O771',
                hl: context.client.hl,
                gl: context.client.gl,
                visitorData: context.client.visitorData
            },
            user: { lockedSafetyMode: false },
            request: { useSsl: true }
        };
    }
    /**
     * VISIONOS client does not require a player script.
     *
     * @returns Always false for the VISIONOS client
     */
    requirePlayerScript() {
        return false;
    }
    /**
     * Searches YouTube for tracks matching the given query.
     *
     * @param query - Search query string (e.g., song name, artist)
     * @param _type - Search type hint (unused by VISIONOS client)
     * @param context - YouTube context with language and region settings
     * @returns Search result with tracks or an exception
     */
    async search(query, _type, context) {
        const sourceName = 'youtube';
        const requestBody = {
            context: this.getClient(context),
            query: query,
            params: 'EgIQAQ%3D%3D'
        };
        try {
            const { body: searchResultRaw, error, statusCode } = await makeRequest('https://youtubei.googleapis.com/youtubei/v1/search', {
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
                logger('error', 'YouTube-VisionOS', message);
                return {
                    loadType: 'error',
                    exception: { message, severity: 'common', cause: 'Upstream' }
                };
            }
            if (!searchResult) {
                logger('debug', 'YouTube-VisionOS', `Empty search result for '${query}'.`);
                return { loadType: 'empty', data: {} };
            }
            if (searchResult.error) {
                logger('error', 'YouTube-VisionOS', `Error from ${sourceName} search API: ${searchResult.error.message}`);
                return {
                    loadType: 'error',
                    exception: {
                        message: searchResult.error.message,
                        severity: 'fault',
                        cause: 'Upstream'
                    }
                };
            }
            const tracks = [];
            const allSections = searchResult.contents?.sectionListRenderer?.contents;
            const lastIdx = (allSections?.length ?? 0) - 1;
            let videos = allSections?.[lastIdx]?.itemSectionRenderer?.contents;
            if (!videos || videos.length === 0) {
                logger('debug', 'YouTube-VisionOS', `No matches found on ${sourceName} for: ${query}`);
                return { loadType: 'empty', data: {} };
            }
            const maxResults = this.config.search.maxResults || 10;
            if (videos.length > maxResults) {
                let count = 0;
                videos = videos.filter((video) => {
                    const isValid = video.videoRenderer || video.compactVideoRenderer;
                    if (isValid && count < maxResults) {
                        count++;
                        return true;
                    }
                    return false;
                });
            }
            for (const videoData of videos) {
                const track = await buildTrack(videoData, sourceName, null, null, this.config.experimental.enableHoloTracks);
                if (track) {
                    tracks.push(track);
                }
            }
            if (tracks.length === 0) {
                logger('debug', 'YouTube-VisionOS', `No processable tracks found on ${sourceName} for: ${query}`);
                return { loadType: 'empty', data: {} };
            }
            return { loadType: 'search', data: tracks };
        }
        catch (e) {
            logger('error', 'YouTube-VisionOS', `Exception during search for '${query}': ${e instanceof Error ? e.message : String(e)}`);
            return {
                loadType: 'error',
                exception: {
                    message: e instanceof Error ? e.message : String(e),
                    severity: 'fault',
                    cause: 'Exception'
                }
            };
        }
    }
    /**
     * Resolves a YouTube URL to track or playlist data.
     *
     * Supports video URLs, short URLs, and playlist URLs.
     *
     * @param url - YouTube URL to resolve
     * @param _type - URL type hint (unused)
     * @param context - YouTube context with language and region settings
     * @param cipherManager - Cipher manager for signature deciphering
     * @returns Resolved track/playlist data or an exception
     */
    async resolve(url, _type, context, cipherManager) {
        const sourceName = 'youtube';
        const urlType = checkURLType(url, 'youtube');
        const apiEndpoint = 'https://youtubei.googleapis.com';
        switch (urlType) {
            case YOUTUBE_CONSTANTS.VIDEO:
            case YOUTUBE_CONSTANTS.SHORTS: {
                const idPattern = /(?:v=|\/shorts\/|youtu\.be\/)([^&?]+)/;
                const videoIdMatch = url.match(idPattern);
                if (!videoIdMatch?.[1]) {
                    logger('error', 'YouTube-VisionOS', `Could not parse video ID from URL: ${url}`);
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
                    logger('error', 'YouTube-VisionOS', message);
                    return {
                        loadType: 'error',
                        exception: { message, severity: 'common', cause: 'Upstream' }
                    };
                }
                return await this._handlePlayerResponse(playerResponse, sourceName, videoId);
            }
            case YOUTUBE_CONSTANTS.PLAYLIST: {
                const playlistIdMatch = url.match(/[?&]list=([\w-]+)/);
                if (!playlistIdMatch?.[1]) {
                    logger('error', 'YouTube-VisionOS', `Could not parse playlist ID from URL: ${url}`);
                    return {
                        loadType: 'error',
                        exception: {
                            message: 'Invalid playlist URL.',
                            severity: 'common',
                            cause: 'Input'
                        }
                    };
                }
                const playlistId = playlistIdMatch[1];
                const videoIdMatch = url.match(/[?&]v=([\w-]+)/);
                const currentVideoId = videoIdMatch?.[1] ?? null;
                const requestBody = {
                    context: this.getClient(context),
                    playlistId,
                    contentCheckOk: true,
                    racyCheckOk: true
                };
                if (playlistId.startsWith('RD') && currentVideoId) {
                    requestBody.videoId = currentVideoId;
                }
                const { body: playlistResponse, statusCode } = await makeRequest(`${apiEndpoint}/youtubei/v1/next`, {
                    headers: { 'User-Agent': this.getClient(context).client.userAgent },
                    body: requestBody,
                    method: 'POST',
                    disableBodyCompression: true,
                    proxy: this.getProxy()
                });
                if (statusCode !== 200) {
                    const errMsg = `Failed to fetch playlist. Status: ${statusCode}`;
                    logger('error', 'YouTube-VisionOS', `Error loading playlist ${playlistId}: ${errMsg}`);
                    return {
                        loadType: 'error',
                        exception: {
                            message: errMsg,
                            severity: 'common',
                            cause: 'Upstream'
                        }
                    };
                }
                return await this._handlePlaylistResponse(playlistId, currentVideoId, playlistResponse, sourceName);
            }
            default:
                return { loadType: 'empty', data: {} };
        }
    }
    /**
     * Retrieves a playable stream URL for a track.
     *
     * @param decodedTrack - Decoded track information with identifier
     * @param context - YouTube context with language and region settings
     * @param cipherManager - Cipher manager for signature deciphering
     * @param itag - Optional specific format itag to request
     * @param proxy - Optional proxy override for this request
     * @returns Track URL data with protocol info, or an exception
     */
    async getTrackUrl(decodedTrack, context, cipherManager, itag, proxy) {
        const sourceName = decodedTrack.sourceName || 'youtube';
        logger('debug', 'YouTube-VisionOS', `Getting stream URL for: ${decodedTrack.title} (ID: ${decodedTrack.identifier}) on ${sourceName}`);
        const { body: playerResponse, statusCode } = await this._makePlayerRequest(decodedTrack.identifier, context, {}, cipherManager, proxy);
        if (statusCode !== 200) {
            const message = `Failed to get player data for stream. Status: ${statusCode}`;
            logger('error', 'YouTube-VisionOS', message);
            return {
                loadType: 'error',
                exception: { message, severity: 'common', cause: 'Upstream' }
            };
        }
        return await this._extractStreamData(playerResponse, decodedTrack, context, cipherManager, itag);
    }
}
