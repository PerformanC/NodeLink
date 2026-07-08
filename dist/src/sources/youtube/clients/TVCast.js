/**
 * YouTube TV Cast Client
 *
 * Implements the YouTube TVHTML5_CAST innertube client for Chromecast
 * casting emulation. Supports video/playlist resolution with player
 * script deciphering but without OAuth authentication.
 *
 * @packageDocumentation
 * @module YouTubeTVCastClient
 */
import { logger, makeRequest } from '../../../utils.js';
import { BaseClient, checkURLType, YOUTUBE_CONSTANTS } from '../common.js';
/**
 * YouTube TVHTML5_CAST innertube client.
 *
 * Emulates a Chromecast device for YouTube API requests.
 * Does not use OAuth since audio is being cast.
 *
 * @public
 */
export default class TVCast extends BaseClient {
    /**
     * Creates a new TVCast client instance.
     *
     * @param nodelink - NodeLink worker instance providing options and source access
     * @param oauth - OAuth manager (unused for cast clients)
     */
    constructor(nodelink, oauth) {
        super(nodelink, 'TVHTML5_CAST', oauth);
    }
    /**
     * Builds the YouTube client context for TVHTML5_CAST innertube requests.
     *
     * @param context - General YouTube context with language, region, and visitor data
     * @returns Client context object describing this TVHTML5_CAST client configuration
     */
    getClient(context) {
        return {
            client: {
                clientName: 'TVHTML5_CAST',
                clientVersion: '7.20190924',
                userAgent: 'Mozilla/5.0 (Linux; Android) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 CrKey/1.54.248666',
                hl: context.client.hl,
                gl: context.client.gl,
                visitorData: context.client.visitorData
            },
            user: { lockedSafetyMode: false },
            request: { useSsl: true }
        };
    }
    /**
     * TV Cast client requires a player script for signature deciphering.
     *
     * @returns Always true for the TV Cast client
     */
    requirePlayerScript() {
        return true;
    }
    /**
     * Returns empty auth headers since cast clients do not use OAuth.
     *
     * @returns Empty headers object
     */
    async getAuthHeaders() {
        return {};
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
        const sourceName = 'youtube';
        const urlType = checkURLType(url, 'youtube');
        const apiEndpoint = this.getApiEndpoint();
        switch (urlType) {
            case YOUTUBE_CONSTANTS.VIDEO:
            case YOUTUBE_CONSTANTS.SHORTS: {
                const idPattern = /(?:v=|\/shorts\/|youtu\.be\/)([^&?]+)/;
                const videoIdMatch = url.match(idPattern);
                if (!videoIdMatch?.[1]) {
                    logger('error', 'YouTube-TVCast', `Could not parse video ID from URL: ${url}`);
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
                const headers = await this.getAuthHeaders();
                const { body: playerResponse, statusCode } = await this._makePlayerRequest(videoId, context, headers, cipherManager);
                if (statusCode !== 200) {
                    const message = `Failed to load video/short player data. Status: ${statusCode}`;
                    logger('error', 'YouTube-TVCast', message);
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
                    logger('error', 'YouTube-TVCast', `Could not parse playlist ID from URL: ${url}`);
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
                    logger('error', 'YouTube-TVCast', `Error loading playlist ${playlistId}: ${errMsg}`);
                    return {
                        loadType: 'error',
                        exception: {
                            message: errMsg,
                            severity: 'common',
                            cause: 'Upstream'
                        }
                    };
                }
                return await this._handlePlaylistResponse(playlistId, currentVideoId, playlistResponse, sourceName, context);
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
        logger('debug', 'YouTube-TVCast', `Getting stream URL for: ${decodedTrack.title} (ID: ${decodedTrack.identifier}) on ${sourceName}`);
        const headers = await this.getAuthHeaders();
        const { body: playerResponse, statusCode } = await this._makePlayerRequest(decodedTrack.identifier, context, headers, cipherManager, proxy);
        if (statusCode !== 200) {
            const message = `Failed to get player data for stream. Status: ${statusCode}`;
            logger('error', 'YouTube-TVCast', message);
            return {
                loadType: 'error',
                exception: { message, severity: 'common', cause: 'Upstream' }
            };
        }
        return await this._extractStreamData(playerResponse, decodedTrack, context, cipherManager, itag);
    }
}
