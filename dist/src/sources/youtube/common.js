import { YOUTUBE_CONSTANTS } from '../../typings/sources/youtube.types.js';
import { encodeTrack, logger, makeRequest } from '../../utils.js';
export { YOUTUBE_CONSTANTS };
/**
 * Fallback strings used when metadata cannot be retrieved from YouTube.
 * These ensure track objects always have meaningful title/author values.
 *
 * @internal
 */
const FALLBACK_TITLE = 'Unknown Title';
const FALLBACK_AUTHOR = 'Unknown Artist';
/**
 * Regular expressions for parsing YouTube URLs and extracting IDs.
 * Each pattern handles a specific URL format used by YouTube.
 *
 * @internal
 */
const URL_PATTERNS = {
    /** Standard YouTube watch URL (www.youtube.com/watch?v=xxx) */
    video: /^https?:\/\/(?:music\.)?(?:www\.)?youtube\.com\/watch\?v=[\w-]+/,
    /** YouTube Music watch URL (music.youtube.com/watch?v=xxx) */
    musicVideo: /^https?:\/\/music\.youtube\.com\/watch\?v=[\w-]+/,
    /** YouTube playlist URL (www.youtube.com/playlist?list=xxx) */
    playlist: /^https?:\/\/(?:music\.)?(?:www\.)?youtube\.com\/playlist\?list=[\w-]+/,
    /** Short YouTube link (youtu.be/xxx) */
    shortUrl: /^https?:\/\/youtu\.be\/[\w-]+/,
    /** YouTube Shorts URL (www.youtube.com/shorts/xxx) */
    shorts: /^https?:\/\/(?:www\.)?youtube\.com\/shorts\/[\w-]+/,
    /** Playlist parameter check (matches any URL with list= param) */
    listParam: /[?&]list=/,
    /** Extracts video ID from various YouTube URL formats */
    videoId: /(?:v=|shorts\/|youtu\.be\/)([^&?]+)/,
    /** Extracts playlist ID from YouTube URL */
    playlistId: /[?&]list=([\w-]+)/,
    /** Extracts video ID from v= parameter specifically */
    videoIdParam: /[?&]v=([\w-]+)/
};
/**
 * Multipliers for converting time units to milliseconds.
 * Used for parsing YouTube's relative time strings (e.g., "2 years ago").
 *
 * @internal
 */
const TIME_UNIT_MULTIPLIERS = {
    year: 365.25 * 24 * 60 * 60 * 1000,
    month: 30.44 * 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    hour: 60 * 60 * 1000,
    minute: 60 * 1000,
    second: 1000
};
/**
 * Regex for parsing human-readable time strings.
 * Matches patterns like "2 years ago", "3 months ago", "1 week ago", etc.
 *
 * @internal
 */
const TIME_UNIT_REGEX = /(\d+)\s*(year|month|week|day|hour|minute|second)/gi;
export function formatDuration(ms) {
    if (!ms || ms === 0)
        return { ms: 0, formatted: '🔴 LIVE', hms: '🔴 LIVE' };
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const s = seconds % 60;
    const m = minutes % 60;
    const formatted = hours > 0
        ? `${hours}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${m}:${String(s).padStart(2, '0')}`;
    const hms = `${hours}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
    return { ms, formatted, hms };
}
/**
 * Formats a large number into a compact string (e.g. 1.5M).
 * @param num - Number to format
 * @returns Formatted string
 * @public
 */
export function formatNumber(num) {
    if (!num || Number.isNaN(num))
        return '0';
    if (num >= 1000000000)
        return `${(num / 1000000000).toFixed(1)}B`;
    if (num >= 1000000)
        return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000)
        return `${(num / 1000).toFixed(1)}K`;
    return String(num);
}
/**
 * Safely converts a value to a string with a fallback.
 * @internal
 */
function safeString(value, fallback = '') {
    if (value === null || value === undefined)
        return fallback;
    return String(value);
}
/**
 * Builds a human readable relative time string from units.
 * @internal
 */
function _buildReadableTime(units) {
    if (units.years > 0)
        return `${units.years} year${units.years > 1 ? 's' : ''} ago`;
    if (units.months > 0)
        return `${units.months} month${units.months > 1 ? 's' : ''} ago`;
    if (units.weeks > 0)
        return `${units.weeks} week${units.weeks > 1 ? 's' : ''} ago`;
    if (units.days > 0)
        return `${units.days} day${units.days > 1 ? 's' : ''} ago`;
    if (units.hours > 0)
        return `${units.hours} hour${units.hours > 1 ? 's' : ''} ago`;
    if (units.minutes > 0)
        return `${units.minutes} minute${units.minutes > 1 ? 's' : ''} ago`;
    if (units.seconds > 0)
        return `${units.seconds} second${units.seconds > 1 ? 's' : ''} ago`;
    return 'just now';
}
/**
 * Builds PublishedAtInfo from a timestamp.
 * @internal
 */
function _buildPublishedAtFromTimestamp(timestamp, originalText) {
    const diff = Date.now() - timestamp;
    const diffAbs = Math.abs(diff);
    const resultUnits = {
        years: 0,
        months: 0,
        weeks: 0,
        days: 0,
        hours: 0,
        minutes: 0,
        seconds: 0
    };
    if (diffAbs >= TIME_UNIT_MULTIPLIERS.year) {
        resultUnits.years = Math.floor(diffAbs / TIME_UNIT_MULTIPLIERS.year);
    }
    else if (diffAbs >= TIME_UNIT_MULTIPLIERS.month) {
        resultUnits.months = Math.floor(diffAbs / TIME_UNIT_MULTIPLIERS.month);
    }
    else if (diffAbs >= TIME_UNIT_MULTIPLIERS.week) {
        resultUnits.weeks = Math.floor(diffAbs / TIME_UNIT_MULTIPLIERS.week);
    }
    else if (diffAbs >= TIME_UNIT_MULTIPLIERS.day) {
        resultUnits.days = Math.floor(diffAbs / TIME_UNIT_MULTIPLIERS.day);
    }
    else if (diffAbs >= TIME_UNIT_MULTIPLIERS.hour) {
        resultUnits.hours = Math.floor(diffAbs / TIME_UNIT_MULTIPLIERS.hour);
    }
    else if (diffAbs >= TIME_UNIT_MULTIPLIERS.minute) {
        resultUnits.minutes = Math.floor(diffAbs / TIME_UNIT_MULTIPLIERS.minute);
    }
    else {
        resultUnits.seconds = Math.floor(diffAbs / TIME_UNIT_MULTIPLIERS.second);
    }
    return {
        original: originalText,
        timestamp: Math.floor(timestamp),
        date: new Date(timestamp).toISOString(),
        readable: _buildReadableTime(resultUnits),
        compact: `${resultUnits.years}y ${resultUnits.months}mo ${resultUnits.weeks}w ${resultUnits.days}d ${resultUnits.hours}h ${resultUnits.minutes}m ${resultUnits.seconds}s`,
        ago: resultUnits
    };
}
/**
 * Parses a YouTube publication date string into structured info.
 * @param publishedText - Text like "2 years ago" or a date string
 * @returns Structured publication info or null
 * @public
 */
export function parsePublishedAt(publishedText) {
    if (!publishedText)
        return null;
    const date = new Date(publishedText);
    if (!Number.isNaN(date.getTime())) {
        return _buildPublishedAtFromTimestamp(date.getTime(), publishedText);
    }
    const text = publishedText.toLowerCase();
    const units = {
        years: 0,
        months: 0,
        weeks: 0,
        days: 0,
        hours: 0,
        minutes: 0,
        seconds: 0
    };
    const regex = new RegExp(TIME_UNIT_REGEX.source, TIME_UNIT_REGEX.flags);
    for (const match of text.matchAll(regex)) {
        const valueStr = match[1];
        const unitStr = match[2];
        if (!valueStr || !unitStr)
            continue;
        const value = parseInt(valueStr, 10);
        const unit = unitStr.toLowerCase();
        if (unit.startsWith('year'))
            units.years = value;
        else if (unit.startsWith('month'))
            units.months = value;
        else if (unit.startsWith('week'))
            units.weeks = value;
        else if (unit.startsWith('day'))
            units.days = value;
        else if (unit.startsWith('hour'))
            units.hours = value;
        else if (unit.startsWith('minute'))
            units.minutes = value;
        else if (unit.startsWith('second'))
            units.seconds = value;
    }
    const msAgo = units.years * TIME_UNIT_MULTIPLIERS.year +
        units.months * TIME_UNIT_MULTIPLIERS.month +
        units.weeks * TIME_UNIT_MULTIPLIERS.week +
        units.days * TIME_UNIT_MULTIPLIERS.day +
        units.hours * TIME_UNIT_MULTIPLIERS.hour +
        units.minutes * TIME_UNIT_MULTIPLIERS.minute +
        units.seconds * TIME_UNIT_MULTIPLIERS.second;
    const timestamp = Date.now() - msAgo;
    return {
        original: publishedText,
        timestamp: Math.floor(timestamp),
        date: new Date(timestamp).toISOString(),
        readable: _buildReadableTime(units),
        compact: `${units.years}y ${units.months}mo ${units.weeks}w ${units.days}d ${units.hours}h ${units.minutes}m ${units.seconds}s`,
        ago: units
    };
}
/**
 * Gets a value from an object using multiple possible dot-notation paths.
 * @internal
 */
function getItemValue(obj, paths, defaultValue = null) {
    if (!obj || typeof obj !== 'object')
        return defaultValue;
    for (const path of paths) {
        const value = path
            .split('.')
            .reduce((o, k) => o?.[k], obj);
        if (value !== undefined && value !== null)
            return value;
    }
    return defaultValue;
}
/**
 * Concatenates text from a YouTube runs array.
 * @internal
 */
function getRunsText(runsArray) {
    if (Array.isArray(runsArray) && runsArray.length > 0) {
        return runsArray.map((run) => run.text || '').join('');
    }
    return null;
}
/**
 * Extracts basic title/author metadata from a YouTube player response.
 * @internal
 */
function extractMetadataFromResponse(fullApiResponse) {
    const metadata = {
        title: null,
        author: null
    };
    const vd = fullApiResponse.videoDetails;
    if (vd) {
        if (typeof vd.title === 'string' && vd.title !== 'undefined')
            metadata.title = vd.title;
        if (typeof vd.author === 'string' && vd.author !== 'undefined')
            metadata.author = vd.author;
    }
    if (metadata.title && metadata.author)
        return metadata;
    const microRoot = fullApiResponse.microformat;
    const mf = microRoot?.playerMicroformatRenderer;
    if (mf) {
        const titleObj = mf.title;
        const title = typeof titleObj === 'string'
            ? titleObj
            : getRunsText(titleObj?.runs) || titleObj?.simpleText;
        if (title && !metadata.title)
            metadata.title = title;
        if (typeof mf.ownerChannelName === 'string' && !metadata.author)
            metadata.author = mf.ownerChannelName;
    }
    return metadata;
}
/**
 * Fetches metadata for a video via oEmbed.
 * @internal
 */
async function fetchOEmbedMetadata(videoId, makeRequestFn) {
    try {
        const { body, statusCode } = await makeRequestFn(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, {
            method: 'GET',
            maxRedirects: 5
        });
        if (statusCode === 200 && body && typeof body === 'object') {
            const b = body;
            return {
                title: b.title || null,
                author: b.author_name || null,
                thumbnail_url: b.thumbnail_url || null
            };
        }
    }
    catch (e) {
        logger('debug', 'fetchOEmbedMetadata', `Failed to fetch oEmbed data: ${e instanceof Error ? e.message : String(e)}`);
    }
    return null;
}
/**
 * Extracts the video title from various possible locations in a YouTube response.
 * Checks multiple sources in priority order: fullApiResponse, renderer title, and fallback locations.
 *
 * @param renderer - YouTube item renderer with title data
 * @param fullApiResponse - Full API response for metadata lookup
 * @param _videoId - Video ID (unused, reserved for future use)
 * @param _makeRequestFn - Optional makeRequest function (unused, reserved for future use)
 * @returns The extracted title string, or `null` if not found
 *
 * @example
 * ```typescript
 * const title = extractTitle(renderer, response, videoId);
 * // Returns: "Never Gonna Give You Up" or null
 * ```
 *
 * @internal
 */
function extractTitle(renderer, fullApiResponse, _videoId, _makeRequestFn = null) {
    if (fullApiResponse) {
        const metadata = extractMetadataFromResponse(fullApiResponse);
        if (metadata.title) {
            return metadata.title;
        }
    }
    if (typeof renderer?.title === 'string' && renderer.title !== 'undefined') {
        return renderer.title;
    }
    const title = getRunsText(renderer?.title?.runs) ||
        getItemValue(fullApiResponse, [
            'videoDetails.endscreen.endscreenRenderer.elements.1.endscreenElementRenderer.title.simpleText'
        ]) ||
        getItemValue(renderer, ['title.simpleText']);
    if (title && title !== 'undefined') {
        return title;
    }
    return null;
}
/**
 * Extracts the video author/channel name from various possible locations in a YouTube response.
 * Checks multiple sources in priority order: fullApiResponse, direct author field, and textual runs.
 *
 * @param renderer - YouTube item renderer with author data
 * @param fullApiResponse - Full API response for metadata lookup
 * @param _videoId - Video ID (unused, reserved for future use)
 * @param _makeRequestFn - Optional makeRequest function (unused, reserved for future use)
 * @returns The extracted author string, or `null` if not found
 *
 * @example
 * ```typescript
 * const author = extractAuthor(renderer, response, videoId);
 * // Returns: "RickAstley" or null
 * ```
 *
 * @internal
 */
function extractAuthor(renderer, fullApiResponse, _videoId, _makeRequestFn = null) {
    if (fullApiResponse) {
        const metadata = extractMetadataFromResponse(fullApiResponse);
        if (metadata.author) {
            return metadata.author;
        }
    }
    if (renderer?.author && renderer.author !== 'undefined') {
        return renderer.author;
    }
    const author = getRunsText(getItemValue(renderer, [
        'longBylineText.runs',
        'shortBylineText.runs',
        'ownerText.runs'
    ]) ?? undefined) || getItemValue(fullApiResponse, ['videoDetails.author']);
    if (author && author !== 'undefined') {
        return author;
    }
    return null;
}
/**
 * Extracts the best thumbnail URL from a renderer or video ID.
 * @internal
 */
function extractThumbnail(renderer, videoId) {
    const thumbnails = renderer?.thumbnail?.thumbnails ||
        renderer?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails;
    if (Array.isArray(thumbnails) && thumbnails.length > 0) {
        const lastThumb = thumbnails[thumbnails.length - 1];
        const url = lastThumb?.url;
        return url?.split('?')[0] || null;
    }
    if (videoId) {
        return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    }
    return null;
}
/**
 * Fetches detailed channel information from YouTube.
 * @param channelId - YouTube channel ID
 * @param makeRequestFn - HTTP request utility
 * @param context - YouTube API context
 * @returns Detailed channel info or null
 * @public
 */
export async function fetchChannelInfo(channelId, makeRequestFn, context) {
    if (!channelId)
        return null;
    try {
        const { body: channelResponseRaw, statusCode } = await makeRequestFn('https://www.youtube.com/youtubei/v1/browse', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: {
                context: {
                    client: {
                        clientName: 'WEB',
                        clientVersion: '2.20251030.01.00',
                        platform: 'DESKTOP',
                        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
                        hl: context?.client?.hl || 'en',
                        gl: context?.client?.gl || 'US'
                    }
                },
                browseId: channelId
            },
            disableBodyCompression: true
        });
        if (statusCode !== 200 ||
            !channelResponseRaw ||
            typeof channelResponseRaw !== 'object') {
            logger('warn', 'fetchChannelInfo', `Bad status code or empty response: ${statusCode}`);
            return null;
        }
        const channelResponse = channelResponseRaw;
        const headerRoot = channelResponse.header;
        const pageHeader = headerRoot?.pageHeaderRenderer;
        const pageHeaderContent = pageHeader?.content;
        const header = pageHeaderContent?.pageHeaderViewModel;
        if (!header) {
            logger('warn', 'fetchChannelInfo', 'No pageHeaderViewModel found');
            return null;
        }
        const channelInfo = {
            icon: null,
            banner: null,
            subscribers: null,
            verified: false,
            description: null,
            links: []
        };
        const imageRoot = header.image;
        const decoratedAvatar = imageRoot?.decoratedAvatarViewModel;
        const avatar = decoratedAvatar?.avatar;
        const avatarViewModel = avatar?.avatarViewModel;
        const avatarImage = avatarViewModel?.image;
        const avatarSources = avatarImage?.sources;
        channelInfo.icon =
            Array.isArray(avatarSources) && avatarSources.length > 0
                ? avatarSources[avatarSources.length - 1]?.url?.split('=')[0] || null
                : null;
        const bannerRoot = header.banner;
        const bannerViewModel = bannerRoot?.imageBannerViewModel;
        const bannerImage = bannerViewModel?.image;
        const bannerSources = bannerImage?.sources;
        channelInfo.banner =
            Array.isArray(bannerSources) && bannerSources.length > 0
                ? bannerSources[bannerSources.length - 1]?.url?.split('=')[0] || null
                : null;
        const titleRoot = header.title;
        const dynamicText = titleRoot?.dynamicTextViewModel;
        const rendererCtx = dynamicText?.rendererContext;
        const accessibilityCtx = rendererCtx?.accessibilityContext;
        const accessibilityLabel = accessibilityCtx?.label;
        channelInfo.verified = !!accessibilityLabel?.includes('Verified');
        const metadataRoot = header.metadata;
        const contentMetadata = metadataRoot?.contentMetadataViewModel;
        const metadataRows = contentMetadata?.metadataRows;
        if (Array.isArray(metadataRows)) {
            for (const rowRaw of metadataRows) {
                const row = rowRaw;
                const parts = row.metadataParts;
                if (Array.isArray(parts)) {
                    for (const partRaw of parts) {
                        const part = partRaw;
                        const partTextObj = part.text;
                        const text = (typeof partTextObj === 'object'
                            ? partTextObj?.content
                            : partTextObj);
                        if (typeof text === 'string') {
                            const lowerText = text.toLowerCase();
                            if (lowerText.includes('subscriber')) {
                                const numStrMatch = lowerText.match(/([\d.,]+)\s*([kmb])?/i);
                                if (numStrMatch) {
                                    const matchedVal = numStrMatch[1];
                                    if (matchedVal) {
                                        let count = parseFloat(matchedVal.replace(/,/g, ''));
                                        const multiplier = numStrMatch[2]?.toLowerCase();
                                        if (multiplier === 'k')
                                            count *= 1000;
                                        else if (multiplier === 'm')
                                            count *= 1000000;
                                        else if (multiplier === 'b')
                                            count *= 1000000000;
                                        channelInfo.subscribers = {
                                            original: text,
                                            count: Math.floor(count),
                                            formatted: formatNumber(Math.floor(count))
                                        };
                                    }
                                }
                                else {
                                    channelInfo.subscribers = {
                                        original: text,
                                        count: null,
                                        formatted: text
                                    };
                                }
                            }
                            else if (lowerText.includes('video')) {
                                const match = lowerText.match(/(\d+(?:,\d+)*)\s*video/i);
                                if (match) {
                                    const matchedVal = match[1];
                                    if (matchedVal) {
                                        const count = parseInt(matchedVal.replace(/,/g, ''), 10);
                                        channelInfo.videoCount = {
                                            original: text,
                                            count,
                                            formatted: formatNumber(count)
                                        };
                                    }
                                }
                                else {
                                    channelInfo.videoCount = {
                                        original: text,
                                        count: null,
                                        formatted: text
                                    };
                                }
                            }
                        }
                    }
                }
            }
        }
        const descRoot = header.description;
        const descPreview = descRoot?.descriptionPreviewViewModel;
        const descContent = descPreview?.description;
        channelInfo.description =
            descContent?.content || null;
        const attributionRoot = header.attribution;
        const attribution = attributionRoot?.attributionViewModel;
        const attributionText = attribution?.text;
        const mainLink = attributionText?.content;
        if (mainLink && !mainLink.includes('and') && !mainLink.includes('more')) {
            channelInfo.links.push(mainLink);
        }
        const resultsRoot = channelResponse.contents;
        const singleColumn = resultsRoot?.singleColumnBrowseResultsRenderer;
        const tabs = singleColumn?.tabs;
        if (Array.isArray(tabs)) {
            for (const tabRaw of tabs) {
                const tab = tabRaw;
                const tabRenderer = tab.tabRenderer;
                const tabContent = tabRenderer?.content;
                const sectionList = tabContent?.sectionListRenderer;
                const contents = sectionList?.contents;
                if (Array.isArray(contents)) {
                    for (const sectionRaw of contents) {
                        const section = sectionRaw;
                        const itemSection = section.itemSectionRenderer;
                        const items = itemSection?.contents;
                        if (Array.isArray(items)) {
                            for (const item of items) {
                                const channelVideoPlayer = item.channelVideoPlayerRenderer;
                                if (channelVideoPlayer?.videoId) {
                                    channelInfo.featuredVideo = {
                                        id: channelVideoPlayer.videoId,
                                        url: `https://www.youtube.com/watch?v=${channelVideoPlayer.videoId}`,
                                        title: channelVideoPlayer.title?.runs?.[0]?.text || null,
                                        description: channelVideoPlayer.description?.runs?.[0]?.text || null
                                    };
                                    break;
                                }
                            }
                        }
                        if (channelInfo.featuredVideo)
                            break;
                    }
                }
                if (channelInfo.featuredVideo)
                    break;
            }
        }
        return channelInfo;
    }
    catch (e) {
        logger('error', 'fetchChannelInfo', `Failed to fetch channel info: ${e instanceof Error ? e.message : String(e)}`);
        if (e instanceof Error)
            logger('error', 'fetchChannelInfo', e.stack ?? '');
        return null;
    }
}
/**
 * Resolves short URLs in external links to their final destinations.
 * @internal
 */
async function resolveExternalLinks(externalLinks, makeRequestFn) {
    if (!externalLinks)
        return null;
    const resolved = { ...externalLinks };
    if (resolved.spotify &&
        (resolved.spotify.includes('smarturl.it') ||
            resolved.spotify.includes('ffm.to'))) {
        try {
            const response = await makeRequestFn(resolved.spotify, {
                method: 'GET',
                maxRedirects: 5
            });
            const finalUrl = response.finalUrl;
            if (finalUrl?.includes('spotify.com')) {
                resolved.spotify = finalUrl;
                const match = finalUrl.match(/spotify\.com\/(album|track|artist|playlist)\/([a-zA-Z0-9]+)/);
                if (match) {
                    resolved.spotifyId = {
                        type: match[1],
                        id: match[2]
                    };
                }
            }
        }
        catch (_e) { }
    }
    if (resolved.appleMusic &&
        (resolved.appleMusic.includes('smarturl.it') ||
            resolved.appleMusic.includes('apple'))) {
        try {
            const response = await makeRequestFn(resolved.appleMusic, {
                method: 'GET',
                maxRedirects: 5
            });
            const finalUrl = response.finalUrl;
            if (finalUrl?.includes('music.apple.com')) {
                resolved.appleMusic = finalUrl;
            }
        }
        catch (_e) { }
    }
    return resolved;
}
/**
 * Extracts links to other platforms from a video description.
 * @param description - Video description text
 * @returns Object with categorized links or null
 * @public
 */
export function extractExternalLinks(description) {
    if (!description)
        return null;
    const links = {
        spotify: null,
        appleMusic: null,
        soundcloud: null,
        bandcamp: null,
        deezer: null,
        tidal: null,
        amazonMusic: null,
        youtubeMusic: null,
        website: null,
        other: []
    };
    const urlRegex = /(https?:\/\/[^\s]+)/gi;
    const matches = description.match(urlRegex) || [];
    const linkMatchers = [
        { key: 'spotify', patterns: ['spotify.com', 'open.spotify.com'] },
        {
            key: 'appleMusic',
            patterns: ['apple.com', 'itunes.apple.com', 'music.apple.com']
        },
        { key: 'soundcloud', patterns: ['soundcloud.com'] },
        { key: 'bandcamp', patterns: ['bandcamp.com'] },
        { key: 'deezer', patterns: ['deezer.com'] },
        { key: 'tidal', patterns: ['tidal.com'] },
        { key: 'amazonMusic', patterns: ['amazon.com/music', 'music.amazon'] },
        { key: 'youtubeMusic', patterns: ['music.youtube.com'] }
    ];
    for (let url of matches) {
        url = url.replace(/[,;)]$/, '');
        let matched = false;
        for (const matcher of linkMatchers) {
            if (matcher.patterns.some((pattern) => url.includes(pattern))) {
                ;
                links[matcher.key] = url;
                matched = true;
                break;
            }
        }
        if (!matched && !url.includes('youtube.com') && !url.includes('youtu.be')) {
            if (!links.website &&
                (url.includes('.com') ||
                    url.includes('.net') ||
                    url.includes('.org') ||
                    url.includes('.io'))) {
                links.website = url;
            }
            else {
                links.other?.push(url);
            }
        }
    }
    if (links.other?.length === 0)
        delete links.other;
    const hasLinks = Object.values(links).some((v) => v !== null && (!Array.isArray(v) || v.length > 0));
    return hasLinks ? links : null;
}
/**
 * Extracts available video qualities from streaming data.
 * @internal
 */
function extractVideoQualities(streamingData) {
    if (!streamingData)
        return [];
    const allFormats = [
        ...(streamingData.formats || []),
        ...(streamingData.adaptiveFormats || [])
    ];
    const qualityMap = new Map();
    for (const formatRaw of allFormats) {
        const format = formatRaw;
        if (format.qualityLabel &&
            format.bitrate &&
            format.mimeType?.startsWith('video/')) {
            const quality = format.qualityLabel;
            const existingQuality = qualityMap.get(quality);
            if (!qualityMap.has(quality) ||
                format.bitrate > (existingQuality?.bitrate ?? 0)) {
                const mimeType = format.mimeType;
                const codecMatch = mimeType.match(/codecs="([^"]+)"/);
                const codec = codecMatch?.[1]?.split('.')[0] || 'unknown';
                qualityMap.set(quality, {
                    quality,
                    bitrate: format.bitrate,
                    fps: format.fps ?? null,
                    mimeType: format.mimeType ?? null,
                    width: format.width ?? null,
                    height: format.height ?? null,
                    codec,
                    itag: format.itag,
                    container: format.mimeType
                        ?.split(';')[0]
                        ?.split('/')[1] ?? null,
                    averageBitrate: format.averageBitrate ?? null,
                    contentLength: format.contentLength ?? null
                });
            }
        }
    }
    return Array.from(qualityMap.values()).sort((a, b) => {
        const resA = Number.parseInt(a.quality, 10) || 0;
        const resB = Number.parseInt(b.quality, 10) || 0;
        return resA - resB;
    });
}
/**
 * Extracts available audio formats from streaming data.
 * @internal
 */
function extractAudioFormats(streamingData) {
    if (!streamingData)
        return [];
    const allFormats = [
        ...(streamingData.formats || []),
        ...(streamingData.adaptiveFormats || [])
    ];
    const qualityMap = new Map();
    for (const formatRaw of allFormats) {
        const format = formatRaw;
        if (format.mimeType?.startsWith('audio/') &&
            format.bitrate) {
            const audioQuality = format.audioQuality || 'UNKNOWN';
            const existingAudioQuality = qualityMap.get(audioQuality);
            if (!qualityMap.has(audioQuality) ||
                format.bitrate > (existingAudioQuality?.bitrate ?? 0)) {
                const mimeType = format.mimeType;
                const codecMatch = mimeType.match(/codecs="([^"]+)"/);
                const codec = codecMatch?.[1] || 'unknown';
                qualityMap.set(audioQuality, {
                    itag: format.itag,
                    mimeType: format.mimeType,
                    bitrate: format.bitrate,
                    averageBitrate: format.averageBitrate ?? null,
                    audioQuality: format.audioQuality ?? null,
                    audioSampleRate: format.audioSampleRate ?? null,
                    audioChannels: format.audioChannels ?? null,
                    codec,
                    container: format.mimeType
                        ?.split(';')[0]
                        ?.split('/')[1] ?? null,
                    contentLength: format.contentLength ?? null,
                    loudnessDb: format.loudnessDb ?? null
                });
            }
        }
    }
    return Array.from(qualityMap.values()).sort((a, b) => b.bitrate - a.bitrate);
}
/**
 * Extracts available audio tracks from streaming data.
 * @internal
 */
function extractAudioTracks(streamingData) {
    if (!streamingData)
        return [];
    const allFormats = [
        ...(streamingData.formats || []),
        ...(streamingData.adaptiveFormats || [])
    ];
    const tracksMap = new Map();
    for (const formatRaw of allFormats) {
        const format = formatRaw;
        const audioTrack = format.audioTrack;
        if (audioTrack) {
            const id = audioTrack.id;
            if (!tracksMap.has(id)) {
                tracksMap.set(id, {
                    id: audioTrack.id,
                    name: audioTrack.displayName,
                    isDefault: !!audioTrack.audioIsDefault,
                    isAutoDubbed: !!audioTrack.isAutoDubbed
                });
            }
        }
    }
    return Array.from(tracksMap.values());
}
/**
 * Extracts caption tracks from YouTube captions data.
 * @internal
 */
function extractCaptions(captionsData) {
    const captionsRoot = captionsData?.playerCaptionsTracklistRenderer;
    const captionTracks = captionsRoot?.captionTracks;
    if (!captionTracks)
        return [];
    return captionTracks.map((cRaw) => {
        const c = cRaw;
        return {
            languageCode: c.languageCode,
            name: c.name?.simpleText,
            isTranslatable: !!c.isTranslatable,
            baseUrl: c.baseUrl,
            kind: c.kind
        };
    });
}
/**
 * Parses track duration and stream status from text/seconds.
 * @internal
 */
function parseLengthAndStream(lengthText, lengthSeconds, isLive) {
    if (isLive) {
        return { lengthMs: -1, isStream: true };
    }
    let lengthMs = 0;
    let isStream = true;
    if (lengthText && /[:\d]+/.test(lengthText)) {
        const parts = lengthText.split(':').map(Number);
        lengthMs = (parts.reduce((acc, val) => acc * 60 + val, 0) || 0) * 1000;
        isStream = !Number.isFinite(lengthMs) || lengthMs <= 0;
    }
    else if (lengthSeconds) {
        lengthMs = Number.parseInt(String(lengthSeconds), 10) * 1000;
        isStream = false;
    }
    return { lengthMs, isStream };
}
/**
 * Identifies the type of renderer from YouTube item data.
 * @internal
 */
function getRendererFromItemData(itemData, itemType) {
    if (!itemData)
        return null;
    if (itemType === 'ytmusic') {
        const data = getItemValue(itemData, [
            'musicResponsiveListItemRenderer',
            'playlistPanelVideoRenderer',
            'musicTwoColumnItemRenderer'
        ]);
        if (data)
            return { ...data, _type: 'track' };
    }
    const rendererTypes = [
        { key: 'videoRenderer', type: 'track' },
        { key: 'compactVideoRenderer', type: 'track' },
        { key: 'playlistRenderer', type: 'playlist' },
        { key: 'compactPlaylistRenderer', type: 'playlist' },
        { key: 'channelRenderer', type: 'channel' },
        { key: 'playlistPanelVideoRenderer', type: 'track' },
        { key: 'playlistVideoRenderer', type: 'track' },
        { key: 'gridVideoRenderer', type: 'track' }
    ];
    for (const r of rendererTypes) {
        const renderer = itemData[r.key];
        if (renderer) {
            return { ...renderer, _type: r.type };
        }
    }
    if (itemData.elementRenderer) {
        const model = getItemValue(itemData.elementRenderer, ['newElement.type.componentType.model']);
        const data = model?.compactChannelModel
            ?.compactChannelData ||
            model?.compactPlaylistModel
                ?.compactPlaylistData;
        if (data) {
            return {
                ...data,
                _type: model?.compactChannelModel ? 'channel' : 'playlist'
            };
        }
    }
    return itemData.videoId ? { ...itemData, _type: 'track' } : null;
}
/**
 * Builds a standard track object from YouTube API item data.
 * @param itemData - Raw YouTube API item data
 * @param itemType - Item source type ('youtube' or 'ytmusic')
 * @param sourceNameOverride - Optional source name override
 * @param fullApiResponse - Full API response for extra metadata
 * @param enableHolo - Whether to build an extended "holo" track
 * @param config - Build configuration
 * @param makeRequestFn - Optional makeRequest override
 * @returns Built track data or null
 * @public
 */
export async function buildTrack(itemData, itemType, sourceNameOverride = null, fullApiResponse = null, enableHolo = false, config = { search: {} }, makeRequestFn = null) {
    if (!itemData) {
        logger('warn', 'buildTrack', 'itemData is null or undefined');
        return null;
    }
    const renderer = getRendererFromItemData(itemData, itemType);
    if (renderer?._type === 'channel') {
        const ch = renderer.channelRenderer || renderer;
        const channelId = ch.channelId ||
            getItemValue(ch, [
                'onTap.innertubeCommand.browseEndpoint.browseId'
            ]) ||
            getItemValue(ch, [
                'endpoint.innertubeCommand.browseEndpoint.browseId'
            ]);
        const title = ch.attributedTitle?.content ||
            (typeof ch.title === 'string'
                ? ch.title
                : getRunsText(ch.title?.runs) ||
                    ch.title?.simpleText) ||
            getRunsText(ch.displayName?.runs) ||
            FALLBACK_TITLE;
        if (!channelId)
            return null;
        const trackInfo = {
            identifier: channelId,
            isSeekable: false,
            author: title,
            length: 0,
            isStream: false,
            position: 0,
            title,
            uri: `https://www.youtube.com/channel/${channelId}`,
            artworkUrl: extractThumbnail(ch, null) || null,
            isrc: null,
            sourceName: sourceNameOverride || 'youtube'
        };
        return {
            encoded: encodeTrack({ ...trackInfo, details: [] }),
            info: trackInfo,
            pluginInfo: {
                type: 'channel_result',
                videoCount: String(getRunsText(ch.videoCountText?.runs) ||
                    ch.videoCount ||
                    '0'),
                subscriberCount: String(getRunsText(ch.subscriberCountText?.runs) ||
                    ch.subscriberCount ||
                    '0'),
                handle: String(ch.handle ?? '')
            }
        };
    }
    if (renderer?._type === 'playlist') {
        const pl = renderer;
        const playlistId = pl.playlistId;
        const title = pl.attributedTitle?.content ||
            (typeof pl.title === 'string'
                ? pl.title
                : getRunsText(pl.title?.runs) ||
                    pl.title?.simpleText) ||
            FALLBACK_TITLE;
        const author = (typeof pl.authorName === 'string'
            ? pl.authorName
            : getRunsText(pl.longBylineText?.runs) ||
                getRunsText(pl.shortBylineText?.runs)) ||
            FALLBACK_AUTHOR;
        const videoCount = getRunsText(pl.videoCountText?.runs) ||
            pl.videoCount ||
            '0';
        if (!playlistId)
            return null;
        const trackInfo = {
            identifier: playlistId,
            isSeekable: false,
            author,
            length: 0,
            isStream: false,
            position: 0,
            title,
            uri: `https://www.youtube.com/playlist?list=${playlistId}`,
            artworkUrl: extractThumbnail(pl, null) || null,
            isrc: null,
            sourceName: sourceNameOverride || 'youtube'
        };
        return {
            encoded: encodeTrack({ ...trackInfo, details: [] }),
            info: trackInfo,
            pluginInfo: {
                type: 'playlist_result',
                videoCount: String(videoCount)
            }
        };
    }
    const videoId = getItemValue(renderer, [
        'playlistItemData.videoId',
        'navigationEndpoint.watchEndpoint.videoId',
        'videoId'
    ]) ||
        itemData.videoId ||
        renderer?.videoId;
    if (!videoId) {
        logger('warn', 'buildTrack', 'Could not extract videoId from item data');
        return null;
    }
    let title = FALLBACK_TITLE;
    let author = FALLBACK_AUTHOR;
    let lengthMs = 0;
    let isStream = true;
    let artworkUrl = null;
    let uri = '';
    const requestFn = makeRequestFn || makeRequest;
    if (itemType === 'ytmusic') {
        title = safeString(getRunsText(getItemValue(renderer, ['title.runs']) ?? undefined) ||
            getItemValue(renderer, ['title.simpleText']) ||
            renderer?.title, FALLBACK_TITLE);
        if (title === FALLBACK_TITLE && Array.isArray(renderer?.flexColumns)) {
            const firstCol = renderer?.flexColumns?.[0];
            title = safeString(getRunsText(firstCol?.musicResponsiveListItemFlexColumnRenderer?.text?.runs), FALLBACK_TITLE);
        }
        const subtitleRuns = getItemValue(renderer, [
            'subtitle.runs'
        ]);
        const longBylineRuns = getItemValue(renderer, [
            'longBylineText.runs'
        ]);
        const shortBylineRuns = getItemValue(renderer, [
            'shortBylineText.runs'
        ]);
        if (Array.isArray(subtitleRuns) && subtitleRuns.length > 0) {
            author = safeString(subtitleRuns[0]?.text, FALLBACK_AUTHOR);
        }
        else if (Array.isArray(longBylineRuns) && longBylineRuns.length > 0) {
            author = safeString(longBylineRuns[0]?.text, FALLBACK_AUTHOR);
        }
        else if (Array.isArray(shortBylineRuns) && shortBylineRuns.length > 0) {
            author = safeString(shortBylineRuns[0]?.text, FALLBACK_AUTHOR);
        }
        else {
            author = safeString(renderer?.author, FALLBACK_AUTHOR);
        }
        if (author === FALLBACK_AUTHOR && Array.isArray(renderer?.flexColumns)) {
            const secondCol = renderer?.flexColumns?.[1];
            author = safeString(secondCol?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]
                ?.text, FALLBACK_AUTHOR);
        }
        let lengthText = null;
        if (Array.isArray(subtitleRuns)) {
            const lengthRun = subtitleRuns.find((run) => run.text && /^\d{1,2}:\d{2}(:\d{2})?$/.test(run.text));
            lengthText = lengthRun?.text || null;
        }
        if (!lengthText) {
            lengthText =
                getItemValue(renderer, ['lengthText.simpleText']) ||
                    getRunsText(getItemValue(renderer, ['lengthText.runs']) ??
                        undefined);
        }
        if (!lengthText && Array.isArray(renderer?.flexColumns)) {
            for (const column of renderer?.flexColumns || []) {
                const textObj = column.musicResponsiveListItemFlexColumnRenderer?.text;
                if (Array.isArray(textObj?.runs)) {
                    const found = textObj.runs.find((run) => run.text && /^\d{1,2}:\d{2}(:\d{2})?$/.test(run.text));
                    if (found) {
                        lengthText = found.text;
                        break;
                    }
                }
            }
        }
        const parsed = parseLengthAndStream(lengthText, itemData.lengthSeconds, itemData.isLive);
        lengthMs = parsed.lengthMs;
        isStream = parsed.isStream;
        artworkUrl = extractThumbnail(renderer || undefined, videoId);
        uri = `https://music.youtube.com/watch?v=${videoId}`;
    }
    else {
        const extractedTitle = extractTitle(renderer || undefined, fullApiResponse, videoId, requestFn);
        const extractedAuthor = extractAuthor(renderer || undefined, fullApiResponse, videoId, requestFn);
        let oEmbedData = null;
        const shouldFetchOEmbed = !!fullApiResponse && (extractedTitle === null || extractedAuthor === null);
        if (shouldFetchOEmbed) {
            try {
                oEmbedData = await fetchOEmbedMetadata(videoId, requestFn);
                if (oEmbedData) {
                    logger('debug', 'buildTrack', `Got metadata from oEmbed: title="${safeString(oEmbedData.title, FALLBACK_TITLE)}", author="${safeString(oEmbedData.author, FALLBACK_AUTHOR)}"`);
                }
            }
            catch (e) {
                logger('warn', 'buildTrack', `Failed to fetch oEmbed metadata: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        title = safeString(oEmbedData?.title ?? extractedTitle, FALLBACK_TITLE);
        author = safeString(oEmbedData?.author ?? extractedAuthor, FALLBACK_AUTHOR);
        if (oEmbedData?.thumbnail_url && !artworkUrl) {
            artworkUrl = oEmbedData.thumbnail_url;
        }
        const lengthText = getItemValue(renderer, ['lengthText.simpleText']) ||
            getRunsText(renderer?.lengthText?.runs);
        const parsed = parseLengthAndStream(lengthText, renderer?.lengthSeconds, renderer?.isLive);
        lengthMs = parsed.lengthMs;
        isStream = parsed.isStream;
        artworkUrl = artworkUrl || extractThumbnail(renderer || undefined, videoId);
        uri = `https://www.youtube.com/watch?v=${videoId}`;
    }
    let sourceName = sourceNameOverride;
    if (!sourceName) {
        if (uri.includes('music.youtube.com')) {
            sourceName = 'ytmusic';
        }
        else {
            sourceName = 'youtube';
        }
    }
    const trackInfo = {
        identifier: videoId,
        isSeekable: !isStream,
        author,
        length: lengthMs,
        isStream,
        position: 0,
        title,
        uri,
        artworkUrl: artworkUrl || null,
        isrc: null,
        sourceName
    };
    trackInfo.title = safeString(trackInfo.title, FALLBACK_TITLE);
    trackInfo.author = safeString(trackInfo.author, FALLBACK_AUTHOR);
    trackInfo.identifier = safeString(trackInfo.identifier, '');
    trackInfo.uri = safeString(trackInfo.uri, '');
    trackInfo.sourceName = safeString(trackInfo.sourceName, 'youtube');
    if (!trackInfo.identifier) {
        logger('warn', 'buildTrack', 'Track identifier is empty after processing');
        return null;
    }
    const streamingData = fullApiResponse?.streamingData;
    const audioFormats = streamingData ? extractAudioFormats(streamingData) : [];
    const audioTracks = streamingData ? extractAudioTracks(streamingData) : [];
    const basicTrack = {
        encoded: encodeTrack({ ...trackInfo, details: [] }),
        info: trackInfo,
        pluginInfo: {
            captions: JSON.stringify(extractCaptions(fullApiResponse?.captions ?? {})),
            audioFormats: JSON.stringify(audioFormats),
            audioTracks: JSON.stringify(audioTracks)
        }
    };
    if (enableHolo) {
        return await buildHoloTrack(trackInfo, itemData, itemType, fullApiResponse, config, requestFn);
    }
    return basicTrack;
}
/**
 * Builds an extended "holo" track object with rich metadata.
 * @param trackInfo - Basic track information
 * @param itemData - Raw YouTube API item data
 * @param itemType - Item source type ('youtube' or 'ytmusic')
 * @param fullApiResponse - Full API response for extra metadata
 * @param config - Build configuration
 * @param makeRequestFn - HTTP request utility
 * @returns Built holo track data
 * @public
 */
export async function buildHoloTrack(trackInfo, itemData, itemType, fullApiResponse = null, config = { search: {} }, makeRequestFn = null) {
    const duration = formatDuration(trackInfo.length);
    const sourceName = trackInfo.sourceName;
    const sourceUrl = sourceName === 'ytmusic'
        ? 'https://music.youtube.com'
        : 'https://www.youtube.com';
    const renderer = getRendererFromItemData(itemData, itemType);
    const channelData = {
        name: trackInfo.author,
        id: null,
        url: null,
        icon: null,
        banner: null,
        subscribers: null,
        verified: false,
        description: null,
        videoCount: null,
        featuredVideo: null,
        links: []
    };
    let thumbnails = {};
    let viewCount = null;
    let _badges = [];
    let accessibilityLabel = `${trackInfo.title} by ${trackInfo.author}`;
    let publishedAt = null;
    let keywords = [];
    let description = null;
    let isLive = false;
    let category = null;
    let likeCount = null;
    const videoDetails = fullApiResponse?.videoDetails;
    if (videoDetails) {
        viewCount = videoDetails.viewCount
            ? Number.parseInt(videoDetails.viewCount, 10)
            : null;
        keywords = videoDetails.keywords || [];
        description = videoDetails.shortDescription || null;
        isLive = videoDetails.isLiveContent || false;
        accessibilityLabel = `${trackInfo.title} by ${videoDetails.author || trackInfo.author}`;
        channelData.name =
            videoDetails.author || trackInfo.author;
        channelData.id = videoDetails.channelId || null;
        channelData.url = videoDetails.channelId
            ? `https://www.youtube.com/channel/${videoDetails.channelId}`
            : null;
        const vdThumbRoot = videoDetails.thumbnail;
        const vdThumbnails = vdThumbRoot?.thumbnails;
        if (vdThumbnails) {
            thumbnails = {
                default: vdThumbnails[0]?.url?.split('?')[0] || null,
                medium: vdThumbnails[1]?.url?.split('?')[0] ||
                    vdThumbnails[0]?.url?.split('?')[0] ||
                    null,
                high: vdThumbnails[vdThumbnails.length - 1]?.url?.split('?')[0] || null
            };
        }
        const rawPublishedAt = videoDetails.publishDate;
        if (rawPublishedAt) {
            publishedAt = parsePublishedAt(rawPublishedAt);
        }
    }
    const microRoot = fullApiResponse?.microformat;
    const micro = microRoot?.playerMicroformatRenderer;
    if (micro) {
        publishedAt =
            publishedAt ||
                (micro.publishDate
                    ? parsePublishedAt(micro.publishDate)
                    : null) ||
                (micro.uploadDate ? parsePublishedAt(micro.uploadDate) : null);
        category = category || micro.category || null;
        likeCount =
            likeCount ||
                (micro.likeCount ? Number.parseInt(micro.likeCount, 10) : null);
    }
    if (renderer) {
        const thumbArray = renderer.thumbnail?.thumbnails ||
            renderer.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
            [];
        thumbnails = {
            default: thumbArray[0]?.url?.split('?')[0] || null,
            medium: thumbArray[1]?.url?.split('?')[0] ||
                thumbArray[0]?.url?.split('?')[0] ||
                null,
            high: thumbArray[thumbArray.length - 1]?.url?.split('?')[0] || null
        };
        const viewCountText = getRunsText(getItemValue(renderer, [
            'viewCountText.runs',
            'shortViewCountText.runs'
        ]) ?? undefined) ||
            getItemValue(renderer, [
                'viewCountText.simpleText',
                'shortViewCountText.simpleText'
            ]);
        if (viewCountText && !viewCount) {
            const match = viewCountText.match(/[\d,]+/);
            if (match)
                viewCount = Number.parseInt(match[0].replace(/,/g, ''), 10);
        }
        const rendererPublishedAt = getRunsText(getItemValue(renderer, ['publishedTimeText.runs']) ??
            undefined) || getItemValue(renderer, ['publishedTimeText.simpleText']);
        if (rendererPublishedAt && !publishedAt) {
            publishedAt = parsePublishedAt(rendererPublishedAt);
        }
        const rendererAccessibility = getItemValue(renderer, [
            'accessibility.accessibilityData.label',
            'title.accessibility.accessibilityData.label'
        ]);
        accessibilityLabel =
            accessibilityLabel || rendererAccessibility || undefined;
        const ownerBadges = renderer.ownerBadges || [];
        _badges = ownerBadges
            .map((b) => getItemValue(b, [
            'metadataBadgeRenderer.tooltip',
            'metadataBadgeRenderer.label'
        ]))
            .filter((b) => !!b);
        if (!channelData.id) {
            const channelName = getRunsText(getItemValue(renderer, [
                'longBylineText.runs',
                'shortBylineText.runs',
                'ownerText.runs'
            ]) ?? undefined) || trackInfo.author;
            const channelUrl = getItemValue(renderer, [
                'longBylineText.runs.0.navigationEndpoint.browseEndpoint.canonicalBaseUrl',
                'shortBylineText.runs.0.navigationEndpoint.browseEndpoint.canonicalBaseUrl',
                'ownerText.runs.0.navigationEndpoint.browseEndpoint.canonicalBaseUrl'
            ]);
            const channelIdFromRenderer = getItemValue(renderer, [
                'longBylineText.runs.0.navigationEndpoint.browseEndpoint.browseId',
                'shortBylineText.runs.0.navigationEndpoint.browseEndpoint.browseId',
                'ownerText.runs.0.navigationEndpoint.browseEndpoint.browseId'
            ]);
            channelData.name = channelName;
            channelData.id = channelIdFromRenderer || null;
            channelData.url = channelUrl
                ? `https://www.youtube.com${channelUrl}`
                : null;
        }
    }
    accessibilityLabel =
        accessibilityLabel ||
            `${trackInfo.title} by ${channelData.name || trackInfo.author}`;
    if (config.search.fetchChannelInfo && channelData.id && makeRequestFn) {
        try {
            const channelInfo = await fetchChannelInfo(channelData.id, makeRequestFn, fullApiResponse?.responseContext);
            if (channelInfo) {
                channelData.icon = channelInfo.icon;
                channelData.banner = channelInfo.banner;
                channelData.subscribers = channelInfo.subscribers;
                channelData.verified = channelInfo.verified;
                channelData.description = channelInfo.description;
                channelData.videoCount = channelInfo.videoCount;
                channelData.featuredVideo = channelInfo.featuredVideo || null;
                if (channelInfo.links && channelInfo.links.length > 0) {
                    channelData.links = channelInfo.links;
                }
            }
        }
        catch (e) {
            logger('warn', 'buildHoloTrack', `Failed to fetch channel info: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    thumbnails.default = thumbnails.default || trackInfo.artworkUrl || null;
    thumbnails.medium = thumbnails.medium || trackInfo.artworkUrl || null;
    thumbnails.high = thumbnails.high || trackInfo.artworkUrl || null;
    let externalLinks = extractExternalLinks(description);
    if (config.search.resolveExternalLinks && externalLinks && makeRequestFn) {
        try {
            externalLinks = await resolveExternalLinks(externalLinks, makeRequestFn);
        }
        catch (e) {
            logger('warn', 'buildHoloTrack', `Failed to resolve external links: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    const streamingData = fullApiResponse?.streamingData;
    const videoQualities = streamingData
        ? extractVideoQualities(streamingData)
        : [];
    const audioFormats = streamingData ? extractAudioFormats(streamingData) : [];
    const audioTracks = streamingData ? extractAudioTracks(streamingData) : [];
    const captions = extractCaptions(fullApiResponse?.captions ?? {});
    const pluginInfo = {
        type: 'holo',
        accessibility: accessibilityLabel ?? '',
        description: description || '',
        isSeekable: trackInfo.isSeekable,
        isLive,
        isExplicit: false,
        duration: duration.formatted,
        sourceName: sourceName,
        sourceUrl: sourceUrl,
        internalId: trackInfo.identifier,
        isrc: trackInfo.isrc || '',
        views: viewCount || 0,
        likes: likeCount || 0,
        category: category || '',
        publishedAt: publishedAt?.date || '',
        thumbnailDefault: thumbnails.default || '',
        thumbnailMedium: thumbnails.medium || '',
        thumbnailHigh: thumbnails.high || '',
        channelName: channelData.name || '',
        channelId: channelData.id || '',
        channelUrl: channelData.url || '',
        channelVerified: !!channelData.verified
    };
    const result = {
        encoded: encodeTrack({ ...trackInfo, details: [] }),
        info: trackInfo,
        pluginInfo: {
            ...pluginInfo,
            keywords: JSON.stringify(keywords),
            externalLinks: JSON.stringify(externalLinks),
            videoQualities: JSON.stringify(videoQualities),
            audioFormats: JSON.stringify(audioFormats),
            audioTracks: JSON.stringify(audioTracks),
            captions: JSON.stringify(captions),
            channel: JSON.stringify(channelData)
        }
    };
    return result;
}
/**
 * Checks the type of a YouTube URL.
 * @param url - URL to check
 * @param type - Source type ('youtube' or 'ytmusic')
 * @returns YOUTUBE_CONSTANTS identifier
 * @public
 */
export function checkURLType(url, type) {
    const isMusicSource = type === 'ytmusic';
    if (URL_PATTERNS.listParam.test(url)) {
        return YOUTUBE_CONSTANTS.PLAYLIST;
    }
    if (isMusicSource) {
        if (URL_PATTERNS.musicVideo.test(url)) {
            return YOUTUBE_CONSTANTS.VIDEO;
        }
    }
    else {
        if (URL_PATTERNS.video.test(url)) {
            return YOUTUBE_CONSTANTS.VIDEO;
        }
        if (URL_PATTERNS.shorts.test(url)) {
            return YOUTUBE_CONSTANTS.SHORTS;
        }
        if (URL_PATTERNS.shortUrl.test(url)) {
            return YOUTUBE_CONSTANTS.VIDEO;
        }
    }
    return YOUTUBE_CONSTANTS.UNKNOWN;
}
/**
 * Fetches encryptedHostFlags for a video by inspecting the embed page.
 * @param videoId - YouTube video ID
 * @returns encryptedHostFlags string or null
 * @public
 */
export async function fetchEncryptedHostFlags(videoId) {
    try {
        const embedUrl = `https://www.youtube.com/embed/${videoId}`;
        const { body, statusCode, error } = await makeRequest(embedUrl, {
            method: 'GET',
            headers: {
                Referer: 'https://www.google.com',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        if (error || statusCode !== 200 || !body || typeof body !== 'string') {
            logger('warn', 'fetchEncryptedHostFlags', `Failed to fetch embed page: ${statusCode} - ${error ?? 'Unknown error'}`);
            return null;
        }
        const match = body.match(/"encryptedHostFlags":"([^"]+)"/);
        if (match?.[1]) {
            logger('debug', 'fetchEncryptedHostFlags', `Successfully extracted encryptedHostFlags for ${videoId}`);
            return match[1];
        }
        logger('debug', 'fetchEncryptedHostFlags', 'encryptedHostFlags not found in embed page');
        return null;
    }
    catch (e) {
        logger('error', 'fetchEncryptedHostFlags', `Error fetching encryptedHostFlags: ${e instanceof Error ? e.message : String(e)}`);
        return null;
    }
}
/**
 * Base class for YouTube clients.
 * Handles common request logic and response processing.
 * @public
 */
export class BaseClient {
    nodelink;
    config;
    name;
    oauth;
    /**
     * @param nodelink - NodeLink worker instance
     * @param name - Client name (e.g. 'ANDROID', 'WEB')
     * @param oauth - OAuth manager instance
     */
    constructor(nodelink, name, oauth) {
        this.nodelink = nodelink;
        this.config = nodelink.options;
        this.name = name;
        this.oauth = oauth;
    }
    /**
     * Returns a proxy configuration if available.
     * @param _rotate - Whether to rotate the proxy
     */
    getProxy(_rotate = false) {
        return undefined;
    }
    /**
     * Whether this client requires a player script for signature deciphering.
     */
    requirePlayerScript() {
        return false;
    }
    /**
     * Returns the base API endpoint for this client.
     */
    getApiEndpoint() {
        return 'https://youtubei.googleapis.com';
    }
    /**
     * Returns additional player parameters for this client.
     */
    getPlayerParams() {
        return null;
    }
    /**
     * Whether this client is an embedded player.
     */
    isEmbedded() {
        return false;
    }
    /**
     * Retrieves OAuth authorization headers.
     */
    async getAuthHeaders() {
        return this.oauth?.getAuthHeaders() ?? {};
    }
    /**
     * Searches for tracks using this client.
     * @param _query - Search query
     * @param _type - Search type
     * @param _context - YouTube context
     */
    async search(_query, _type, _context) {
        return { loadType: 'search', data: [] };
    }
    /**
     * Performs an innertube player request.
     * @internal
     */
    async _makePlayerRequest(videoId, context, headers, cipherManager, proxy) {
        const apiEndpoint = this.getApiEndpoint();
        const requestBody = {
            context: this.getClient(context),
            videoId: videoId,
            contentCheckOk: true,
            attestationRequest: { omitBotguardData: true },
            racyCheckOk: true
        };
        const playerParams = this.getPlayerParams();
        if (playerParams) {
            requestBody.params = playerParams;
        }
        if (this.isEmbedded()) {
            const encryptedHostFlags = await fetchEncryptedHostFlags(videoId);
            if (encryptedHostFlags) {
                const playbackContext = requestBody.playbackContext || {};
                playbackContext.contentPlaybackContext =
                    playbackContext.contentPlaybackContext || {};
                playbackContext.contentPlaybackContext.encryptedHostFlags = encryptedHostFlags;
                requestBody.playbackContext = playbackContext;
            }
            if (context.client.clientName === 'WEB_EMBEDDED_PLAYER') {
                requestBody.serializedThirdPartyEmbedConfig = {
                    hideInfoBar: true,
                    disableRelatedVideos: true
                };
            }
        }
        if (this.requirePlayerScript() && cipherManager) {
            try {
                const playerScript = await cipherManager.getCachedPlayerScript();
                if (playerScript?.url) {
                    const signatureTimestamp = await cipherManager.getTimestamp(playerScript.url);
                    const playbackContext = requestBody.playbackContext || {};
                    playbackContext.contentPlaybackContext =
                        playbackContext.contentPlaybackContext || {};
                    playbackContext.contentPlaybackContext.signatureTimestamp = signatureTimestamp;
                    requestBody.playbackContext = playbackContext;
                }
            }
            catch (e) {
                logger('warn', `youtube-${this.name}`, `Failed to get signature timestamp: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        const clientCtx = this.getClient(context);
        const response = await makeRequest(`${apiEndpoint}/youtubei/v1/player?prettyPrint=false`, {
            method: 'POST',
            headers: {
                'User-Agent': clientCtx.client.userAgent,
                ...(clientCtx.client.visitorData
                    ? {
                        'X-Goog-Visitor-Id': clientCtx.client.visitorData
                    }
                    : {}),
                ...(this.isEmbedded() ? { Referer: 'https://www.youtube.com' } : {}),
                ...headers
            },
            body: requestBody,
            disableBodyCompression: true,
            proxy: proxy || this.getProxy()
        });
        if (response.statusCode !== 200) {
            const message = `Failed to get player data. Status: ${response.statusCode}`;
            logger('error', `youtube-${this.name}`, message);
            return { ...response, error: message };
        }
        return response;
    }
    /**
     * Performs an innertube next request (for playlists/recommendations).
     * TVHTML5 now requires this to fetch title and author after fetching the /player endpoint. Tho, oEmbed is preferred.
     * @internal
     */
    async _makeNextRequest(videoId, context, headers, proxy) {
        const apiEndpoint = this.getApiEndpoint();
        const requestBody = {
            context: this.getClient(context),
            videoId: videoId
        };
        const clientCtx = this.getClient(context);
        const response = await makeRequest(`${apiEndpoint}/youtubei/v1/next?prettyPrint=false`, {
            method: 'POST',
            headers: {
                'User-Agent': clientCtx.client.userAgent,
                ...(clientCtx.client.visitorData
                    ? {
                        'X-Goog-Visitor-Id': clientCtx.client.visitorData
                    }
                    : {}),
                ...headers
            },
            body: requestBody,
            disableBodyCompression: true,
            proxy: proxy || this.getProxy()
        });
        return response;
    }
    /**
     * Handles an innertube player response and converts it to SourceResult.
     * @internal
     */
    async _handlePlayerResponse(playerResponseRaw, sourceName, videoId, _context) {
        if (!playerResponseRaw || typeof playerResponseRaw !== 'object') {
            logger('error', `youtube-${this.name}`, `Null or invalid player response for ${videoId}`);
            return { loadType: 'empty', data: {} };
        }
        const playerResponse = playerResponseRaw;
        if (playerResponse.error) {
            logger('error', `youtube-${this.name}`, `API error for video/short ${videoId}: ${playerResponse.error.message}`);
            return {
                loadType: 'error',
                exception: {
                    message: playerResponse.error.message,
                    severity: 'fault',
                    cause: 'Upstream'
                }
            };
        }
        const videoDetails = playerResponse.videoDetails;
        const playabilityStatus = playerResponse.playabilityStatus?.status;
        if (playabilityStatus &&
            playabilityStatus !== 'OK' &&
            playerResponse.microformat?.microformatDataRenderer.appName !==
                'YouTube Music') {
            const message = playerResponse.playabilityStatus?.reason || 'Video not playable.';
            logger('warn', `youtube-${this.name}`, `Video/short ${videoId} not playable: ${message}`);
            return {
                loadType: 'error',
                exception: {
                    message,
                    severity: 'common',
                    cause: 'UpstreamPlayability'
                }
            };
        }
        if (!videoDetails?.videoId) {
            logger('error', `youtube-${this.name}`, `Missing videoDetails for ${videoId}`);
            return {
                loadType: 'error',
                exception: {
                    message: 'No video details in response.',
                    severity: 'fault',
                    cause: 'NoVideoDetails'
                }
            };
        }
        const track = await buildTrack(videoDetails, sourceName, null, playerResponse, !!this.config.experimental.enableHoloTracks, {
            resolveExternalLinks: !!this.config.search.resolveExternalLinks,
            fetchChannelInfo: !!this.config.search.fetchChannelInfo,
            search: {}
        });
        if (!track) {
            logger('error', `youtube-${this.name}`, `Failed to build track for ${videoId}`);
            return {
                loadType: 'error',
                exception: {
                    message: 'Failed to process video data.',
                    severity: 'fault',
                    cause: 'TrackBuildFailed'
                }
            };
        }
        return { loadType: 'track', data: track };
    }
    /**
     * Handles an innertube next response for playlists.
     * @internal
     */
    async _handlePlaylistResponse(playlistId, currentVideoId, playlistResponseRaw, sourceName, _context) {
        if (!playlistResponseRaw || typeof playlistResponseRaw !== 'object') {
            return { loadType: 'empty', data: {} };
        }
        const playlistResponse = playlistResponseRaw;
        if (playlistResponse.error) {
            const error = playlistResponse.error;
            const errMsg = error.message || 'Failed to fetch playlist.';
            logger('error', `youtube-${this.name}`, `Error loading playlist ${playlistId}: ${errMsg}`);
            return {
                loadType: 'error',
                exception: { message: errMsg, severity: 'common', cause: 'Upstream' }
            };
        }
        const contentsRoot = playlistResponse.contents
            ?.singleColumnWatchNextResults ||
            playlistResponse.contents
                ?.singleColumnMusicWatchNextResultsRenderer;
        let playlistContent = null;
        const playlist = contentsRoot?.playlist;
        const plData = playlist?.playlist;
        if (plData?.contents) {
            playlistContent = plData.contents;
        }
        else {
            const tabbedRenderer = contentsRoot?.tabbedRenderer;
            const watchNext = tabbedRenderer?.watchNextTabbedResultsRenderer;
            const tabs = watchNext?.tabs;
            const tabRenderer = tabs?.[0]?.tabRenderer;
            const musicQueue = tabRenderer?.content;
            const mqRenderer = musicQueue?.musicQueueRenderer;
            if (mqRenderer) {
                const plPanel = mqRenderer.content;
                const panelRenderer = plPanel?.playlistPanelRenderer;
                playlistContent =
                    panelRenderer?.contents ||
                        mqRenderer.contents ||
                        null;
            }
        }
        if (!playlistContent || playlistContent.length === 0) {
            logger('info', `youtube-${this.name}`, `Playlist ${playlistId} is empty or inaccessible.`);
            return { loadType: 'empty', data: {} };
        }
        const tracks = [];
        let selectedTrack = 0;
        const maxLength = this.config.playback?.maxPlaylistLength || 100;
        if (sourceName === 'ytmusic') {
            playlistContent = playlistContent.filter((item) => getItemValue(item, ['playlistPanelVideoRenderer.videoId']));
        }
        let continuation = getItemValue(playlistResponse, [
            'contents.singleColumnMusicWatchNextResultsRenderer.tabbedRenderer.watchNextTabbedResultsRenderer.tabs.0.tabRenderer.content.musicQueueRenderer.content.playlistPanelRenderer.continuations.0.nextContinuationData.continuation'
        ]);
        const seenContinuations = new Set();
        while (sourceName === 'ytmusic' &&
            _context &&
            continuation &&
            !seenContinuations.has(continuation) &&
            playlistContent.length < maxLength) {
            seenContinuations.add(continuation);
            const client = this.getClient(_context);
            const { body, statusCode } = await makeRequest('https://music.youtube.com/youtubei/v1/next', {
                method: 'POST',
                headers: {
                    'User-Agent': client.client.userAgent,
                    'X-Goog-Api-Format-Version': '2'
                },
                body: { context: client, continuation },
                disableBodyCompression: true,
                proxy: this.getProxy()
            });
            if (statusCode !== 200 || !body)
                break;
            const page = getItemValue(body, [
                'continuationContents.playlistPanelContinuation'
            ]);
            const items = page?.contents?.filter((item) => getItemValue(item, ['playlistPanelVideoRenderer.videoId']));
            if (!items?.length)
                break;
            playlistContent.push(...items.slice(0, maxLength - playlistContent.length));
            continuation = getItemValue(page, [
                'continuations.0.nextContinuationData.continuation'
            ]);
        }
        for (let i = 0; i < Math.min(playlistContent.length, maxLength); i++) {
            const item = playlistContent[i];
            try {
                const track = await buildTrack(item, sourceName || 'youtube', null, null, !!this.config.experimental.enableHoloTracks, {
                    fetchChannelInfo: false,
                    resolveExternalLinks: false,
                    search: {}
                });
                if (track) {
                    tracks.push(track);
                    if (currentVideoId && track.info.identifier === currentVideoId) {
                        selectedTrack = i;
                    }
                }
            }
            catch (err) {
                logger('warn', `youtube-${this.name}`, `Failed to build track: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        if (tracks.length === 0) {
            logger('info', `youtube-${this.name}`, `No valid tracks parsed from playlist ${playlistId}.`);
            return { loadType: 'empty', data: {} };
        }
        let playlistTitle = 'Unknown Playlist';
        if (plData?.title) {
            playlistTitle = plData.title;
        }
        else {
            const tabbedRenderer = contentsRoot?.tabbedRenderer;
            const watchNext = tabbedRenderer?.watchNextTabbedResultsRenderer;
            const tabs = watchNext?.tabs;
            const tabRenderer = tabs?.[0]?.tabRenderer;
            const musicQueue = tabRenderer?.content;
            const mqRenderer = musicQueue?.musicQueueRenderer;
            const headerRoot = mqRenderer?.header;
            const mqHeader = headerRoot?.musicQueueHeaderRenderer;
            const subtitle = mqHeader?.subtitle;
            if (subtitle?.runs?.[0]?.text) {
                playlistTitle = subtitle.runs[0].text;
            }
        }
        return {
            loadType: 'playlist',
            data: {
                info: { name: playlistTitle, selectedTrack },
                pluginInfo: {},
                tracks
            }
        };
    }
    /**
     * Handles an innertube browse response for playlists.
     * @internal
     */
    async _handleBrowsePlaylistResponse(playlistId, browseResponseRaw, sourceName, _context) {
        if (!browseResponseRaw || typeof browseResponseRaw !== 'object') {
            return { loadType: 'empty', data: {} };
        }
        const browseResponse = browseResponseRaw;
        if (browseResponse.error) {
            const error = browseResponse.error;
            const errMsg = error.message || 'Failed to browse playlist.';
            logger('error', `youtube-${this.name}`, `Error browsing playlist ${playlistId}: ${errMsg}`);
            return {
                loadType: 'error',
                exception: { message: errMsg, severity: 'common', cause: 'Upstream' }
            };
        }
        const contents = browseResponse.contents;
        const singleColumn = contents?.singleColumnBrowseResultsRenderer;
        const tabs = singleColumn?.tabs;
        const tabRenderer = tabs?.[0]?.tabRenderer;
        const tabContent = tabRenderer?.content;
        const sectionList = tabContent?.sectionListRenderer;
        const sectionContents = sectionList?.contents;
        const section = sectionContents?.[0];
        const shelf = section?.musicPlaylistShelfRenderer ||
            section?.playlistVideoListRenderer;
        const shelfContentsCheck = shelf?.contents;
        if (!shelf || !shelfContentsCheck || shelfContentsCheck.length === 0) {
            logger('info', `youtube-${this.name}`, `Browse playlist ${playlistId} is empty or inaccessible.`);
            return { loadType: 'empty', data: {} };
        }
        const maxLength = this.config.playback?.maxPlaylistLength || 100;
        const shelfContents = shelfContentsCheck.filter((item) => !getItemValue(item, ['messageRenderer']));
        let continuation = getItemValue(shelf, [
            'continuations.0.nextContinuationData.continuation'
        ]);
        const seenContinuations = new Set();
        while (this.name === 'ANDROID' &&
            _context &&
            continuation &&
            !seenContinuations.has(continuation) &&
            shelfContents.length < maxLength) {
            seenContinuations.add(continuation);
            const client = this.getClient(_context);
            const { body, statusCode } = await makeRequest(`${this.getApiEndpoint()}/youtubei/v1/browse`, {
                method: 'POST',
                headers: {
                    'User-Agent': client.client.userAgent,
                    'X-YouTube-Client-Name': '3',
                    'X-YouTube-Client-Version': client.client.clientVersion ?? ''
                },
                body: { context: client, continuation },
                disableBodyCompression: true,
                proxy: this.getProxy()
            });
            if (statusCode !== 200 || !body)
                break;
            const page = getItemValue(body, [
                'continuationContents.playlistVideoListContinuation'
            ]);
            const items = page?.contents;
            if (!items?.length)
                break;
            shelfContents.push(...items.slice(0, maxLength - shelfContents.length));
            continuation = getItemValue(page, [
                'continuations.0.nextContinuationData.continuation'
            ]);
        }
        const tracks = [];
        for (let i = 0; i < Math.min(shelfContents.length, maxLength); i++) {
            const item = shelfContents[i];
            try {
                const track = await buildTrack(item, sourceName || 'ytmusic', sourceName, browseResponse, !!this.config.experimental.enableHoloTracks, {
                    fetchChannelInfo: false,
                    resolveExternalLinks: false,
                    search: {}
                });
                if (track) {
                    tracks.push(track);
                }
            }
            catch (err) {
                logger('warn', `youtube-${this.name}`, `Failed to build track: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        if (tracks.length === 0) {
            logger('info', `youtube-${this.name}`, `No valid tracks parsed from browse playlist ${playlistId}.`);
            return { loadType: 'empty', data: {} };
        }
        let playlistTitle = 'Unknown Playlist';
        const headerRoot = browseResponse.header;
        const pageHeader = headerRoot?.pageHeaderRenderer;
        const musicDetail = headerRoot?.musicDetailHeaderRenderer;
        const musicTitle = musicDetail?.title;
        if (typeof pageHeader?.pageTitle === 'string') {
            playlistTitle = pageHeader.pageTitle;
        }
        else if (musicTitle?.runs?.[0]?.text) {
            playlistTitle = musicTitle.runs[0].text;
        }
        else {
            const editableHeaderRoot = headerRoot?.musicEditablePlaylistDetailHeaderRenderer;
            const editableHeader = editableHeaderRoot?.header;
            const editableMusicDetail = editableHeader?.musicDetailHeaderRenderer;
            const editableMusicTitle = editableMusicDetail?.title;
            if (editableMusicTitle?.runs?.[0]?.text) {
                playlistTitle = editableMusicTitle.runs[0].text;
            }
        }
        return {
            loadType: 'playlist',
            data: {
                info: { name: playlistTitle, selectedTrack: 0 },
                pluginInfo: {},
                tracks
            }
        };
    }
    /**
     * Extracts streaming metadata from a player response.
     * @internal
     */
    async _extractStreamData(playerResponseRaw, decodedTrack, context, cipherManager, itag) {
        const playerResponse = playerResponseRaw;
        const streamingData = playerResponse.streamingData;
        if (!streamingData) {
            logger('error', `youtube-${this.name}`, `No streaming data found for ${decodedTrack.identifier}`);
            return {
                loadType: 'error',
                exception: {
                    message: 'No streaming data available.',
                    severity: 'common',
                    cause: 'UpstreamNoStream'
                }
            };
        }
        const ytConfig = this.config.sources?.youtube || {};
        const targetItag = ytConfig.targetItag;
        const allowItag = ytConfig.allowItag || [];
        let targetItags = [];
        if (itag) {
            targetItags = [Number(itag)];
        }
        else if (targetItag) {
            targetItags = [Number(targetItag)];
        }
        else {
            const qualityPriority = this._getQualityPriority();
            const audioConfig = this.config.playback?.audio;
            const audioQuality = audioConfig?.quality || 'high';
            targetItags =
                qualityPriority[audioQuality] || [];
            if (allowItag.length > 0) {
                targetItags = [...new Set([...targetItags, ...allowItag])];
            }
        }
        const allFormats = [
            ...(streamingData.adaptiveFormats || []),
            ...(streamingData.formats || [])
        ];
        let formats = allFormats.map((fRaw) => {
            const f = fRaw;
            return {
                itag: f.itag,
                mimeType: f.mimeType,
                qualityLabel: f.qualityLabel,
                bitrate: f.bitrate,
                audioQuality: f.audioQuality,
                url: f.url,
                signatureCipher: (f.signatureCipher ||
                    f.cipher ||
                    f.signature_cipher),
                audioTrack: f.audioTrack
            };
        });
        const dt = decodedTrack;
        if (dt.audioTrackId) {
            const requestedFormats = formats.filter((f) => f.audioTrack && f.audioTrack.id === dt.audioTrackId);
            if (requestedFormats.length > 0) {
                logger('debug', `youtube-${this.name}`, `Found requested audio track: ${dt.audioTrackId}`);
                formats = requestedFormats;
            }
            else {
                const hasAudioTracks = formats.some((f) => f.audioTrack);
                if (hasAudioTracks) {
                    logger('warn', `youtube-${this.name}`, `Requested audio track ${dt.audioTrackId} not found in client ${this.name}.`);
                    return {
                        loadType: 'error',
                        exception: {
                            message: 'Requested audio track not available in this client.',
                            severity: 'common',
                            cause: 'AudioTrackNotFound'
                        }
                    };
                }
            }
        }
        else {
            const defaultFormats = formats.filter((f) => f.audioTrack?.audioIsDefault);
            if (defaultFormats.length > 0) {
                logger('debug', `youtube-${this.name}`, 'Using default audio track.');
                formats = defaultFormats;
            }
        }
        const _attemptCipherResolution = async (formatToResolve, playerScript, ctx) => {
            let currentStreamUrl = formatToResolve.url;
            let currentEncryptedSignature = null;
            let currentNParam = null;
            let currentSignatureKey = null;
            if (formatToResolve.signatureCipher) {
                const cipher = new URLSearchParams(formatToResolve.signatureCipher);
                currentStreamUrl = cipher.get('url') || undefined;
                currentEncryptedSignature = cipher.get('s');
                currentSignatureKey = cipher.get('sp') || 'sig';
                currentNParam = cipher.get('n');
            }
            if (!playerScript) {
                if (currentEncryptedSignature) {
                    return null;
                }
                if (currentStreamUrl) {
                    formatToResolve.url = currentStreamUrl;
                    return formatToResolve;
                }
                return null;
            }
            if (currentStreamUrl && cipherManager) {
                try {
                    const decipheredUrl = await cipherManager.resolveUrl(currentStreamUrl, currentEncryptedSignature, currentNParam, currentSignatureKey, playerScript, ctx);
                    formatToResolve.url = decipheredUrl;
                    return formatToResolve;
                }
                catch (e) {
                    logger('warn', `youtube-${this.name}`, `Failed to resolve format URL for itag ${formatToResolve.itag}: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            return null;
        };
        let resolvedFormat = null;
        const playerScript = this.requirePlayerScript() && cipherManager
            ? await cipherManager.getCachedPlayerScript()
            : null;
        if (this.requirePlayerScript() && !playerScript) {
            logger('error', `youtube-${this.name}`, 'Failed to obtain player script for deciphering. Cannot extract stream data.');
            return {
                loadType: 'error',
                exception: {
                    message: 'Failed to obtain player script for deciphering.',
                    severity: 'fault',
                    cause: 'Internal'
                }
            };
        }
        logger('debug', `youtube-${this.name}`, `Initial target itags (from config/quality priority): ${targetItags.join(', ')}`);
        const opusAudioCandidates = formats
            .filter((format) => targetItags.includes(format.itag) &&
            format.mimeType?.startsWith('audio/'))
            .sort((a, b) => targetItags.indexOf(a.itag) - targetItags.indexOf(b.itag));
        logger('debug', `youtube-${this.name}`, `Opus audio-only candidates: ${opusAudioCandidates.map((f) => f.itag).join(', ')}`);
        for (const formatRaw of opusAudioCandidates) {
            const format = formatRaw;
            resolvedFormat = await _attemptCipherResolution(format, playerScript, context);
            if (resolvedFormat) {
                logger('debug', `youtube-${this.name}`, `Resolved format: itag ${resolvedFormat.itag}, mimeType ${resolvedFormat.mimeType}`);
                break;
            }
        }
        if (!resolvedFormat) {
            logger('debug', `youtube-${this.name}`, 'Opus audio-only failed. Attempting fallback to itag 18.');
            const itag18FormatRaw = formats.find((format) => format.itag === 18);
            if (itag18FormatRaw) {
                const itag18Format = itag18FormatRaw;
                resolvedFormat = await _attemptCipherResolution(itag18Format, playerScript, context);
                if (resolvedFormat) {
                    logger('debug', `youtube-${this.name}`, `Resolved format from itag 18 fallback: itag ${resolvedFormat.itag}, mimeType ${resolvedFormat.mimeType}`);
                }
                else {
                    logger('debug', `youtube-${this.name}`, 'Itag 18 found but could not be resolved.');
                }
            }
            else {
                logger('debug', `youtube-${this.name}`, 'Itag 18 not found in available formats.');
            }
        }
        if (!resolvedFormat && !streamingData.hlsManifestUrl) {
            logger('debug', `youtube-${this.name}`, 'No suitable stream found after all fallbacks, and no HLS manifest URL.');
            return {
                loadType: 'error',
                exception: {
                    message: 'No suitable audio stream found after all fallbacks.',
                    severity: 'common',
                    cause: 'Upstream'
                },
                formats
            };
        }
        if (!resolvedFormat && streamingData.hlsManifestUrl) {
            logger('debug', `youtube-${this.name}`, 'No suitable stream found after all fallbacks, but HLS manifest URL is available. Proceeding with HLS.');
        }
        else {
            logger('debug', `youtube-${this.name}`, `Final resolved format: itag ${resolvedFormat?.itag}, mimeType ${resolvedFormat?.mimeType}`);
        }
        const directUrl = resolvedFormat?.url && !decodedTrack.isStream
            ? resolvedFormat.url
            : undefined;
        if (!directUrl && !streamingData.hlsManifestUrl) {
            logger('debug', `youtube-${this.name}`, 'No direct URL resolved and no HLS manifest. Returning error.');
            return {
                loadType: 'error',
                exception: {
                    message: 'No suitable audio stream found.',
                    severity: 'common',
                    cause: 'Upstream'
                },
                formats
            };
        }
        const resolveFormatStr = (mimeType) => {
            if (!mimeType)
                return null;
            const lowerMime = mimeType.toLowerCase();
            if (lowerMime.includes('opus')) {
                return 'webm/opus';
            }
            if (lowerMime.includes('mp4')) {
                return 'mp4';
            }
            if (lowerMime.includes('mp3')) {
                return 'mp3';
            }
            if (lowerMime.includes('aac')) {
                return 'aac';
            }
            if (decodedTrack.isStream) {
                return 'mpegts';
            }
            return null;
        };
        return {
            url: directUrl,
            protocol: directUrl ? 'http' : null,
            format: resolveFormatStr(resolvedFormat?.mimeType),
            itag: resolvedFormat?.itag,
            hlsUrl: streamingData.hlsManifestUrl || null,
            formats
        };
    }
    /**
     * Returns a map of quality names to itag priorities.
     * @internal
     */
    _getQualityPriority() {
        return {
            high: [251, 250, 140],
            medium: [250, 140],
            low: [249, 250, 140],
            lowest: [249, 139]
        };
    }
    /**
     * Resolves a URL to track/playlist data.
     * @param url - YouTube URL
     * @param _type - Source type override
     * @param context - YouTube context
     * @param cipherManager - Cipher manager instance
     */
    async resolve(url, _type, context, cipherManager) {
        const sourceName = 'youtube';
        const urlType = checkURLType(url, 'youtube');
        const apiEndpoint = this.getApiEndpoint();
        switch (urlType) {
            case YOUTUBE_CONSTANTS.VIDEO:
            case YOUTUBE_CONSTANTS.SHORTS: {
                const idPattern = /(?:v=|shorts\/|youtu\.be\/)([^&?]+)/;
                const videoIdMatch = url.match(idPattern);
                if (!videoIdMatch?.[1]) {
                    logger('error', `youtube-${this.name}`, `Could not parse video ID from URL: ${url}`);
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
                const headers = this.oauth ? await this.oauth.getAuthHeaders() : {};
                const playerResult = await this._makePlayerRequest(videoId, context, headers, cipherManager);
                if (playerResult.statusCode !== 200 || !playerResult.body) {
                    const message = `Failed to load video/short player data. Status: ${playerResult.statusCode}`;
                    logger('error', `youtube-${this.name}`, message);
                    return {
                        loadType: 'error',
                        exception: {
                            message: message,
                            severity: 'common',
                            cause: 'Upstream'
                        }
                    };
                }
                return await this._handlePlayerResponse(playerResult.body, sourceName, videoId, context);
            }
            case YOUTUBE_CONSTANTS.PLAYLIST: {
                const playlistIdMatch = url.match(/[?&]list=([\w-]+)/);
                if (!playlistIdMatch?.[1]) {
                    logger('error', `youtube-${this.name}`, `Could not parse playlist ID from URL: ${url}`);
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
                const headers = this.oauth ? await this.oauth.getAuthHeaders() : {};
                const playlistResponse = await makeRequest(`${apiEndpoint}/youtubei/v1/next`, {
                    headers: {
                        'User-Agent': this.getClient(context).client.userAgent,
                        ...headers
                    },
                    body: {
                        context: { client: this.getClient(context) },
                        playlistId,
                        contentCheckOk: true,
                        racyCheckOk: true
                    },
                    method: 'POST',
                    disableBodyCompression: true,
                    proxy: this.getProxy()
                });
                const plBody = playlistResponse.body;
                if (playlistResponse.statusCode !== 200 || plBody?.error) {
                    const error = plBody?.error;
                    const errMsg = error?.message ||
                        `Failed to fetch playlist. Status: ${playlistResponse.statusCode}`;
                    logger('error', `youtube-${this.name}`, `Error loading playlist ${playlistId}: ${errMsg}`);
                    return {
                        loadType: 'error',
                        exception: {
                            message: errMsg,
                            severity: 'common',
                            cause: 'Upstream'
                        }
                    };
                }
                return await this._handlePlaylistResponse(playlistId, currentVideoId, plBody ?? {}, sourceName, context);
            }
            default:
                return { loadType: 'empty', data: {} };
        }
    }
    /**
     * Retrieves a playable stream URL for a track.
     * @param decodedTrack - Decoded track information
     * @param context - YouTube context
     * @param cipherManager - Cipher manager instance
     * @param itag - Optional specific itag to request
     * @param proxy - Optional proxy override
     */
    async getTrackUrl(decodedTrack, context, cipherManager, itag, proxy) {
        const headers = this.oauth ? await this.oauth.getAuthHeaders() : {};
        const playerResult = await this._makePlayerRequest(decodedTrack.identifier, context, headers, cipherManager, proxy);
        if (playerResult.statusCode !== 200 || !playerResult.body) {
            const message = `Failed to get player data for stream. Status: ${playerResult.statusCode}`;
            logger('error', `youtube-${this.name}`, message);
            return {
                loadType: 'error',
                exception: { message, severity: 'common', cause: 'Upstream' }
            };
        }
        return await this._extractStreamData(playerResult.body, decodedTrack, context, cipherManager, itag);
    }
    /**
     * Fetches the initial visitor data by making a GET request to YouTube.
     * This is used to initialize the session context.
     *
     * @returns The extracted visitor data string, or null if it could not be found.
     */
    async getVisitorData() {
        try {
            const response = await makeRequest('https://www.youtube.com', {
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                },
                proxy: this.getProxy()
            });
            if (response.statusCode !== 200 || !response.body) {
                return null;
            }
            const body = response.body;
            const match = body.match(/ytcfg\.set\((\{.*?\})\);/);
            if (match?.[1]) {
                try {
                    const ytcfg = JSON.parse(match[1]);
                    if (ytcfg.VISITOR_DATA) {
                        return ytcfg.VISITOR_DATA;
                    }
                }
                catch {
                    // Fallback to regex if JSON parse fails
                }
            }
            const visitorDataMatch = body.match(/"visitorData":"([^"]+)"/);
            return visitorDataMatch?.[1] || null;
        }
        catch (err) {
            logger('debug', `youtube-${this.name}`, `Failed to fetch visitor data: ${err instanceof Error ? err.message : String(err)}`);
            return null;
        }
    }
}
