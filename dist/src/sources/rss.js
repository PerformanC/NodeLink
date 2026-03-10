import { encodeTrack, http1makeRequest, logger } from "../utils.js";
const RSS_PATTERN = /https?:\/\/.+(\.rss|\.rrs)(\?.*)?$/i;
const PODCAST_RSS_PATTERN = /https?:\/\/.+\/podcast\/rss(\?.*)?$/i;
/**
 * RSS source implementation.
 */
export default class RssSource {
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
     * Creates a new RSS source wrapper.
     *
     * @param nodelink - Worker runtime used by the source implementation.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.patterns = [RSS_PATTERN, PODCAST_RSS_PATTERN];
        this.priority = 50;
    }
    /**
     * Initializes the source.
     *
     * @returns `true` once the source has been registered.
     */
    async setup() {
        return true;
    }
    /**
     * Resolves an RSS feed into a playlist of playable enclosure items.
     *
     * @param url - Candidate RSS feed URL.
     * @returns Playlist payload, an empty result when the URL does not return a
     * valid RSS feed, or an error payload when parsing fails unexpectedly.
     */
    async resolve(url) {
        try {
            const { body, statusCode, headers } = await http1makeRequest(url);
            if (statusCode !== 200 || typeof body !== 'string') {
                return { loadType: 'empty', data: {} };
            }
            const contentType = this.getContentType(headers);
            if (!contentType.includes('xml') && !body.includes('<rss')) {
                return { loadType: 'empty', data: {} };
            }
            const channelXml = this.extractFirstTag(body, 'channel') ?? '';
            const channelTitle = this.extractTagText(channelXml, 'title') ?? 'RSS Feed';
            const channelImage = this.extractTagAttribute(channelXml, 'itunes:image', 'href') ??
                this.extractTagText(this.extractFirstTag(channelXml, 'image') ?? '', 'url') ??
                null;
            const items = this.extractItems(body);
            if (items.length === 0) {
                return { loadType: 'empty', data: {} };
            }
            const tracks = [];
            for (const itemXml of items) {
                const title = this.extractTagText(itemXml, 'title') ?? 'Untitled';
                const author = this.extractTagText(itemXml, 'itunes:author') ??
                    this.extractTagText(itemXml, 'dc:creator') ??
                    this.extractTagText(channelXml, 'itunes:author') ??
                    this.extractTagText(channelXml, 'author') ??
                    'Unknown Artist';
                const enclosureTag = this.extractEnclosureTag(itemXml);
                const enclosureUrl = this.extractAttribute(enclosureTag, 'url');
                const enclosureType = this.extractAttribute(enclosureTag, 'type');
                const itemUrl = this.extractTagText(itemXml, 'link') ?? enclosureUrl ?? url;
                const guid = this.extractTagText(itemXml, 'guid') ?? itemUrl;
                const durationText = this.extractTagText(itemXml, 'itunes:duration');
                const artwork = this.extractTagAttribute(itemXml, 'itunes:image', 'href') ??
                    channelImage;
                if (!enclosureUrl) {
                    continue;
                }
                const trackInfo = {
                    identifier: guid,
                    isSeekable: true,
                    author: author.trim() || 'Unknown Artist',
                    length: this.parseDurationMs(durationText),
                    isStream: false,
                    position: 0,
                    title: title.trim() || 'Untitled',
                    uri: enclosureUrl,
                    artworkUrl: artwork,
                    isrc: null,
                    sourceName: 'rss',
                    details: []
                };
                tracks.push({
                    encoded: encodeTrack(trackInfo),
                    info: trackInfo,
                    pluginInfo: {
                        enclosureType,
                        itemUrl,
                        feedUrl: url
                    }
                });
            }
            if (tracks.length === 0) {
                return { loadType: 'empty', data: {} };
            }
            const playlistData = {
                info: { name: channelTitle, selectedTrack: 0 },
                pluginInfo: { feedUrl: url },
                tracks
            };
            return {
                loadType: 'playlist',
                data: playlistData
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'RSS resolution failed.';
            logger('error', 'RSS', `Resolve failed: ${message}`);
            return {
                loadType: 'error',
                data: {
                    message,
                    severity: 'fault'
                }
            };
        }
    }
    /**
     * Resolves the direct enclosure URL for an RSS episode.
     *
     * @param track - Decoded RSS track information.
     * @returns Direct HTTP or HTTPS URL descriptor, or an exception payload when
     * the enclosure URL is missing.
     */
    async getTrackUrl(track) {
        const url = track.uri;
        if (!url) {
            return {
                exception: {
                    message: 'Missing enclosure URL.',
                    severity: 'common'
                }
            };
        }
        return {
            url,
            protocol: url.startsWith('https://') ? 'https' : 'http',
            format: this.guessFormatFromUrl(url)
        };
    }
    /**
     * Extracts RSS item payloads from a feed XML string.
     *
     * @param xml - RSS feed XML.
     * @returns Raw inner XML for each `<item>` entry.
     */
    extractItems(xml) {
        const items = [];
        const itemExpression = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
        let match;
        do {
            match = itemExpression.exec(xml);
            if (match?.[1]) {
                items.push(match[1]);
            }
        } while (match !== null);
        return items;
    }
    /**
     * Extracts the inner XML of the first matching tag.
     *
     * @param xml - XML fragment to inspect.
     * @param tag - Tag name to extract.
     * @returns Inner XML content, or `null` when the tag is not present.
     */
    extractFirstTag(xml, tag) {
        const tagExpression = this.buildTagRegex(tag);
        const match = tagExpression.exec(xml);
        return match?.[1] ?? null;
    }
    /**
     * Extracts plain text from the first matching XML tag.
     *
     * @param xml - XML fragment to inspect.
     * @param tag - Tag name to extract.
     * @returns Trimmed plain-text tag content, or `null` when the tag is
     * missing.
     */
    extractTagText(xml, tag) {
        const content = this.extractFirstTag(xml, tag);
        if (!content) {
            return null;
        }
        const cdataMatch = content.match(/<!\[CDATA\[([\s\S]*?)\]\]>/i);
        if (cdataMatch?.[1]) {
            return cdataMatch[1].trim();
        }
        return content.replace(/<[^>]+>/g, '').trim();
    }
    /**
     * Extracts an attribute value from the first matching tag instance.
     *
     * @param xml - XML fragment to inspect.
     * @param tag - Tag name to locate.
     * @param attribute - Attribute name to read.
     * @returns Attribute value, or `null` when the tag or attribute is missing.
     */
    extractTagAttribute(xml, tag, attribute) {
        const tagExpression = new RegExp(`<${this.escape(tag)}\\b[^>]*>`, 'i');
        const match = tagExpression.exec(xml);
        if (!match?.[0]) {
            return null;
        }
        return this.extractAttribute(match[0], attribute);
    }
    /**
     * Extracts an attribute value from a tag string.
     *
     * @param tag - Raw XML tag string.
     * @param attribute - Attribute name to read.
     * @returns Attribute value, or `null` when the attribute is missing.
     */
    extractAttribute(tag, attribute) {
        const attributeExpression = new RegExp(`${this.escape(attribute)}=(["'])([^"']+)\\1`, 'i');
        const match = attributeExpression.exec(tag);
        return match?.[2] ?? null;
    }
    /**
     * Builds a regex that captures the inner XML of a tag.
     *
     * @param tag - Tag name to capture.
     * @returns Compiled regular expression for the tag.
     */
    buildTagRegex(tag) {
        return new RegExp(`<${this.escape(tag)}\\b[^>]*>([\\s\\S]*?)<\\/${this.escape(tag)}>`, 'i');
    }
    /**
     * Extracts the first `<enclosure>` tag from an RSS item.
     *
     * @param xml - RSS item XML.
     * @returns Raw `<enclosure>` tag string, or an empty string when not found.
     */
    extractEnclosureTag(xml) {
        const match = xml.match(/<enclosure\b[^>]*\/?>/i);
        return match?.[0] ?? '';
    }
    /**
     * Escapes a literal string for regex construction.
     *
     * @param value - Raw string that should be treated literally.
     * @returns Regex-escaped string.
     */
    escape(value) {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    /**
     * Parses an RSS duration string into milliseconds.
     *
     * Supports plain seconds as well as `mm:ss` and `hh:mm:ss`.
     *
     * @param text - Raw duration text.
     * @returns Duration in milliseconds, or `0` when parsing fails.
     */
    parseDurationMs(text) {
        if (!text) {
            return 0;
        }
        const trimmed = text.trim();
        if (/^\d+$/.test(trimmed)) {
            return Number.parseInt(trimmed, 10) * 1000;
        }
        const parts = trimmed.split(':').map((part) => Number.parseInt(part, 10));
        if (parts.some((part) => Number.isNaN(part))) {
            return 0;
        }
        const [first, second, third] = parts;
        if (parts.length === 3 &&
            first !== undefined &&
            second !== undefined &&
            third !== undefined) {
            return (first * 3600 + second * 60 + third) * 1000;
        }
        if (parts.length === 2 && first !== undefined && second !== undefined) {
            return (first * 60 + second) * 1000;
        }
        return 0;
    }
    /**
     * Guesses the audio container from an enclosure URL.
     *
     * @param url - Direct enclosure URL.
     * @returns Best-effort format hint used by the playback pipeline.
     */
    guessFormatFromUrl(url) {
        const [lower] = url.toLowerCase().split('?');
        if (!lower) {
            return 'mp3';
        }
        if (lower.endsWith('.m4a') || lower.endsWith('.aac')) {
            return 'm4a';
        }
        if (lower.endsWith('.ogg') || lower.endsWith('.oga')) {
            return 'ogg';
        }
        if (lower.endsWith('.wav')) {
            return 'wav';
        }
        if (lower.endsWith('.m3u8')) {
            return 'm3u8';
        }
        return 'mp3';
    }
    /**
     * Normalizes the response content-type header into a lowercase string.
     *
     * @param headers - HTTP headers returned by the request helper.
     * @returns Lowercase content type string, or an empty string when missing.
     */
    getContentType(headers) {
        const value = headers?.['content-type'];
        if (Array.isArray(value)) {
            return String(value[0] ?? '').toLowerCase();
        }
        return String(value ?? '').toLowerCase();
    }
}
