import { logger, makeRequest } from '../../../utils.js';
import { BaseClient, buildTrack, checkURLType, YOUTUBE_CONSTANTS } from '../common.js';
/**
 * YouTube Android innertube client implementation.
 *
 * Simulates the official Android YouTube app for API requests.
 * Used for search, URL resolution, and track playback.
 *
 * @public
 */
export default class Android extends BaseClient {
    /**
     * @param nodelink - NodeLink worker instance providing options, sources, and logging
     * @param oauth - OAuth manager for authenticated requests, or null if unauthenticated
     */
    constructor(nodelink, oauth) {
        super(nodelink, 'ANDROID', oauth);
    }
    /**
     * Returns the Android client context for innertube API requests.
     * @param context - General YouTube context with language, region, and visitor data
     * @returns Client context simulating an Android Pixel 6 device
     */
    getClient(context) {
        return {
            client: {
                clientName: 'ANDROID',
                clientVersion: '20.01.35',
                userAgent: 'com.google.android.youtube/20.01.35 (Linux; U; Android 14) identity',
                deviceMake: 'Google',
                deviceModel: 'Pixel 6',
                osName: 'Android',
                osVersion: '14',
                androidSdkVersion: '34',
                hl: context.client.hl,
                gl: context.client.gl,
                visitorData: context.client.visitorData
            },
            user: { lockedSafetyMode: false },
            request: { useSsl: true }
        };
    }
    /**
     * Whether this client requires a player script for signature deciphering.
     * Android client returns URLs directly without encryption.
     * @returns false - Android formats do not require deciphering
     */
    requirePlayerScript() {
        return false;
    }
    /**
     * Searches YouTube for tracks, playlists, channels, or artists.
     *
     * Extends the base class `search` with optional proxy and status reporting
     * parameters. Called directly by YouTubeSource with these additional args.
     *
     * @param query - Search query string
     * @param type - Search type ('track', 'playlist', 'album', 'artist', 'channel')
     * @param context - YouTube API context
     * @param proxy - Optional proxy configuration for the request
     * @param reportProxyStatus - Callback to report proxy success/failure with latency
     * @returns Search results or error
     */
    async search(query, type, context, proxy, reportProxyStatus = () => { }) {
        const sourceName = 'youtube';
        let params = 'oAIBEgIQAQ%3D%3D'; // Default to track (video)
        if (type === 'playlist' || type === 'album')
            params = 'oAIBEgIQAw%3D%3D';
        if (type === 'artist' || type === 'channel')
            params = 'oAIBEgIQAg%3D%3D';
        const requestBody = {
            context: this.getClient(context),
            query: query,
            params
        };
        const searchProxy = proxy || this.getProxy();
        const searchStart = Date.now();
        try {
            const { body: searchResultRaw, error, statusCode } = await makeRequest('https://youtubei.googleapis.com/youtubei/v1/search', {
                method: 'POST',
                headers: {
                    'User-Agent': this.getClient(context).client.userAgent,
                    'X-Goog-Api-Format-Version': '2',
                    ...(context.client.visitorData
                        ? { 'X-Goog-Visitor-Id': context.client.visitorData }
                        : {}),
                    'X-YouTube-Client-Name': '3',
                    'X-YouTube-Client-Version': this.getClient(context).client.clientVersion
                },
                body: requestBody,
                disableBodyCompression: true,
                proxy: searchProxy
            });
            reportProxyStatus(searchProxy, !error && statusCode === 200, statusCode, Date.now() - searchStart);
            if (error || statusCode !== 200) {
                const message = error ||
                    `Failed to load results from ${sourceName}. Status: ${statusCode}`;
                logger('error', 'YouTube-Android', message);
                return {
                    loadType: 'error',
                    exception: { message, severity: 'common', cause: 'Upstream' }
                };
            }
            const searchResult = searchResultRaw;
            if (!searchResult) {
                logger('debug', 'YouTube-Android', `Empty search result for '${query}'.`);
                return { loadType: 'empty', data: {} };
            }
            if (searchResult.error) {
                logger('error', 'YouTube-Android', `Error from ${sourceName} search API: ${searchResult.error.message}`);
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
            const allSections = searchResult.contents?.sectionListRenderer?.contents || [];
            const items = [];
            for (const section of allSections) {
                let contents = section.itemSectionRenderer?.contents;
                if (!contents) {
                    const shelf = section.shelfRenderer || section.richShelfRenderer;
                    contents =
                        shelf?.content?.verticalListRenderer?.items ||
                            shelf?.content?.richGridRenderer?.contents;
                }
                if (Array.isArray(contents)) {
                    for (const item of contents) {
                        items.push(item.richItemRenderer?.content || item);
                    }
                }
            }
            if (items.length === 0) {
                logger('debug', 'YouTube-Android', `No matches found on ${sourceName} for: ${query}`);
                return { loadType: 'empty', data: {} };
            }
            const maxResults = this.config.search.maxResults || 10;
            let count = 0;
            const filteredItems = items.filter((item) => {
                const isValid = item.videoRenderer ||
                    item.compactVideoRenderer ||
                    item.playlistRenderer ||
                    item.compactPlaylistRenderer ||
                    item.channelRenderer ||
                    (item.elementRenderer &&
                        (item.elementRenderer.newElement?.type?.componentType?.model
                            ?.compactChannelModel ||
                            item.elementRenderer.newElement?.type?.componentType?.model
                                ?.compactPlaylistModel));
                if (isValid && count < maxResults) {
                    count++;
                    return true;
                }
                return false;
            });
            for (const itemData of filteredItems) {
                const track = await buildTrack(itemData, sourceName, null, null, this.config.experimental.enableHoloTracks);
                if (track) {
                    tracks.push(track);
                }
            }
            if (tracks.length === 0) {
                logger('debug', 'YouTube-Android', `No processable tracks found on ${sourceName} for: ${query}`);
                return { loadType: 'empty', data: {} };
            }
            return { loadType: 'search', data: tracks };
        }
        catch (e) {
            reportProxyStatus(searchProxy, false, 500, Date.now() - searchStart);
            logger('error', 'YouTube-Android', `Exception during search for '${query}': ${e instanceof Error ? e.message : String(e)}`);
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
     * Extends the base class `resolve` with an optional `reportProxyStatus`
     * callback for proxy latency tracking. Called directly by YouTubeSource.
     *
     * @param url - YouTube URL to resolve (video, short, or playlist)
     * @param _type - Source type override (unused)
     * @param context - YouTube API context
     * @param cipherManager - Cipher manager for signature deciphering
     * @param reportProxyStatus - Callback to report proxy success/failure with latency
     * @returns Resolved track/playlist data or error
     */
    async resolve(url, _type, context, cipherManager, reportProxyStatus = () => { }) {
        const sourceName = 'youtube';
        const urlType = checkURLType(url, 'youtube');
        const apiEndpoint = 'https://youtubei.googleapis.com';
        switch (urlType) {
            case YOUTUBE_CONSTANTS.VIDEO:
            case YOUTUBE_CONSTANTS.SHORTS: {
                const idPattern = /(?:v=|\/shorts\/|youtu\.be\/)([^&?]+)/;
                const videoIdMatch = url.match(idPattern);
                if (!videoIdMatch?.[1]) {
                    logger('error', 'youtube-android', `Could not parse video ID from URL: ${url}`);
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
                    logger('error', 'youtube-android', message);
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
                    logger('error', 'youtube-android', `Could not parse playlist ID from URL: ${url}`);
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
                const isRadio = playlistId.startsWith('RD');
                logger('debug', 'YouTube-Android', `User-Agent for playlist request: ${this.getClient(context).client.userAgent}`);
                const requestBody = isRadio
                    ? {
                        context: this.getClient(context),
                        playlistId,
                        contentCheckOk: true,
                        racyCheckOk: true
                    }
                    : { context: this.getClient(context), browseId: `VL${playlistId}` };
                if (isRadio && currentVideoId) {
                    requestBody.videoId = currentVideoId;
                }
                const playlistProxy = this.getProxy();
                const playlistStart = Date.now();
                const { body: playlistResponseRaw, statusCode } = await makeRequest(`${apiEndpoint}/youtubei/v1/${isRadio ? 'next' : 'browse'}`, {
                    headers: {
                        'User-Agent': this.getClient(context).client.userAgent,
                        ...(context.client.visitorData
                            ? { 'X-Goog-Visitor-Id': context.client.visitorData }
                            : {}),
                        'X-YouTube-Client-Name': '3',
                        'X-YouTube-Client-Version': this.getClient(context).client.clientVersion
                    },
                    body: requestBody,
                    method: 'POST',
                    disableBodyCompression: true,
                    proxy: playlistProxy
                });
                reportProxyStatus(playlistProxy, statusCode === 200, statusCode, Date.now() - playlistStart);
                if (statusCode !== 200) {
                    const errMsg = `Failed to fetch playlist. Status: ${statusCode}`;
                    logger('error', 'youtube-android', `Error loading playlist ${playlistId}: ${errMsg}`);
                    return {
                        loadType: 'error',
                        exception: {
                            message: errMsg,
                            severity: 'common',
                            cause: 'Upstream'
                        }
                    };
                }
                const playlistResponse = playlistResponseRaw;
                if (!isRadio) {
                    return await this._handleBrowsePlaylistResponse(playlistId, playlistResponse, sourceName, context);
                }
                return await this._handlePlaylistResponse(playlistId, currentVideoId, playlistResponse, sourceName);
            }
            default:
                return { loadType: 'empty', data: {} };
        }
    }
    /**
     * Retrieves a playable stream URL for a track via the Android client.
     *
     * Overrides the base class implementation to add SABR (server-side ABR)
     * protocol support for adaptive streaming.
     *
     * @param decodedTrack - Decoded track information with identifier and metadata
     * @param context - YouTube API context
     * @param cipherManager - Cipher manager for signature deciphering
     * @param itag - Optional specific format itag to request
     * @param proxy - Optional proxy override for the request
     * @returns Stream URL data including protocol, format, and additional metadata
     */
    async getTrackUrl(decodedTrack, context, cipherManager, itag, proxy) {
        const sourceName = decodedTrack.sourceName || 'youtube';
        logger('debug', 'youtube-android', `Getting stream URL for: ${decodedTrack.title} (ID: ${decodedTrack.identifier}) on ${sourceName}`);
        const { body: playerResponse, statusCode } = await this._makePlayerRequest(decodedTrack.identifier, context, {}, cipherManager, proxy);
        if (statusCode !== 200) {
            const message = `Failed to get player data for stream. Status: ${statusCode}`;
            logger('error', 'youtube-android', message);
            return {
                loadType: 'error',
                exception: { message, severity: 'common', cause: 'Upstream' }
            };
        }
        const playerData = playerResponse;
        const streamingData = (playerData.streamingData ||
            playerData.streaming_data);
        const serverAbrUrl = streamingData?.serverAbrStreamingUrl ||
            streamingData?.server_abr_streaming_url;
        const ustreamerConfig = playerData.playerConfig?.mediaCommonConfig;
        const videoPlaybackConfig = ustreamerConfig?.mediaUstreamerRequestConfig;
        if (serverAbrUrl) {
            logger('debug', 'YouTube-Android', `SABR URL found for ${decodedTrack.identifier}. Using SABR protocol.`);
            const formats = [
                ...(streamingData?.formats || []),
                ...(streamingData?.adaptiveFormats ||
                    streamingData?.adaptive_formats ||
                    [])
            ].map((fRaw) => {
                const f = fRaw;
                return {
                    itag: f.itag,
                    lastModified: f.lastModified || f.last_modified_ms,
                    xtags: f.xtags,
                    width: f.width,
                    height: f.height,
                    mimeType: f.mimeType || f.mime_type,
                    audioQuality: f.audioQuality || f.audio_quality,
                    bitrate: f.bitrate,
                    averageBitrate: f.averageBitrate || f.average_bitrate,
                    quality: f.quality,
                    qualityLabel: f.qualityLabel || f.quality_label,
                    audioTrackId: f.audioTrack
                        ?.id,
                    approxDurationMs: f.approxDurationMs || f.approx_duration_ms,
                    contentLength: f.contentLength || f.content_length,
                    isDrc: !!f.isDrc
                };
            });
            return {
                protocol: 'sabr',
                url: serverAbrUrl,
                additionalData: {
                    serverAbrStreamingUrl: serverAbrUrl,
                    videoPlaybackUstreamerConfig: videoPlaybackConfig?.videoPlaybackUstreamerConfig,
                    visitorData: this.getClient(context).client.visitorData,
                    clientInfo: { clientName: 3, clientVersion: '20.51.39' },
                    formats,
                    accessToken: null,
                    userAgent: this.getClient(context).client.userAgent
                }
            };
        }
        return await this._extractStreamData(playerResponse, decodedTrack, context, cipherManager, itag);
    }
}
