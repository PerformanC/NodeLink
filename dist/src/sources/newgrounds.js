import { PassThrough, pipeline } from 'node:stream';
import { encodeTrack, logger, makeRequest } from '../utils.js';
const NEWGROUNDS_AUDIO_PATTERN = /^https?:\/\/(?:www\.)?newgrounds\.com\/audio\/listen\/(\d+)(?:[/?#]|$)/i;
const NEWGROUNDS_BASE_URL = 'https://www.newgrounds.com';
const NEWGROUNDS_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
/**
 * Resolves and streams tracks from the Newgrounds Audio Portal.
 * @public
 */
export default class NewgroundsSource {
    nodelink;
    patterns = [NEWGROUNDS_AUDIO_PATTERN];
    priority = 50;
    /**
     * Creates a Newgrounds source bound to the worker runtime.
     * @param nodelink - Worker runtime shared with all sources.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
    }
    /**
     * Initializes the Newgrounds source.
     * @returns Always `true`; this source requires no credentials.
     */
    async setup() {
        logger('info', 'Sources', 'Loaded Newgrounds source.');
        return true;
    }
    /**
     * Resolves a Newgrounds Audio Portal listen page.
     * @param url - Newgrounds listen-page URL.
     * @returns A normalized track, an empty result, or an extraction error.
     */
    async resolve(url) {
        if (!NEWGROUNDS_AUDIO_PATTERN.test(url)) {
            return { loadType: 'empty', data: {} };
        }
        try {
            const audio = await this._fetchAudioPage(url);
            if (!audio)
                return { loadType: 'empty', data: {} };
            const canonicalUrl = this._buildListenUrl(audio.identifier);
            const artworkUrl = this._buildArtworkUrl(audio.identifier, audio.version);
            const info = {
                identifier: audio.identifier,
                isSeekable: true,
                author: audio.author,
                length: Math.round(audio.duration * 1000),
                isStream: false,
                position: 0,
                title: audio.title,
                uri: canonicalUrl,
                artworkUrl,
                isrc: null,
                sourceName: 'newgrounds'
            };
            const encodedInput = { ...info, details: [] };
            return {
                loadType: 'track',
                data: {
                    encoded: encodeTrack(encodedInput),
                    info,
                    pluginInfo: {}
                }
            };
        }
        catch (error) {
            const message = this._getErrorMessage(error);
            logger('error', 'Newgrounds', `Failed to resolve audio: ${message}`);
            return {
                loadType: 'error',
                exception: {
                    message,
                    severity: 'fault',
                    cause: 'Newgrounds page extraction failed'
                }
            };
        }
    }
    /**
     * Refreshes the direct Newgrounds media URL before playback.
     * @param track - Decoded Newgrounds track metadata.
     * @returns The direct audio URL or a structured exception.
     */
    async getTrackUrl(track) {
        try {
            if (!/^\d+$/.test(track.identifier)) {
                throw new Error('Invalid Newgrounds audio identifier');
            }
            const audio = await this._fetchAudioPage(this._buildListenUrl(track.identifier));
            if (!audio) {
                const directory = Math.floor(Number(track.identifier) / 1000) * 1000;
                const title = track.title
                    .trim()
                    .replace(/[^\p{L}\p{N}\s-]/gu, '')
                    .replace(/\s+/g, '-');
                const version = track.artworkUrl?.match(/[?&]f(\d+)/)?.[1];
                if (!title)
                    throw new Error('Newgrounds audio is unavailable');
                return {
                    url: `https://audio-download.ngfiles.com/${directory}/${track.identifier}_${title}.mp3${version ? `?f${version}` : ''}`,
                    protocol: 'https',
                    format: 'mp3'
                };
            }
            return {
                url: audio.streamUrl,
                protocol: 'https',
                format: 'mp3'
            };
        }
        catch (error) {
            return {
                exception: {
                    message: this._getErrorMessage(error),
                    severity: 'fault',
                    cause: 'Newgrounds stream extraction failed'
                }
            };
        }
    }
    /**
     * Opens a Newgrounds audio stream for playback.
     * @param track - Decoded track metadata used for request context.
     * @param url - Direct Newgrounds media URL.
     * @returns A readable MP3 stream or a structured exception.
     */
    async loadStream(track, url) {
        try {
            const response = await makeRequest(url, {
                method: 'GET',
                streamOnly: true,
                headers: {
                    Accept: 'audio/mpeg,audio/*;q=0.9,*/*;q=0.8',
                    Referer: track.uri,
                    'User-Agent': NEWGROUNDS_USER_AGENT
                }
            });
            if (response.error ||
                !response.statusCode ||
                response.statusCode < 200 ||
                response.statusCode >= 300 ||
                !response.stream) {
                throw new Error(response.error ||
                    `Newgrounds returned stream status ${response.statusCode ?? 'unknown'}`);
            }
            const stream = new PassThrough();
            stream.once('close', () => {
                ;
                response.stream.destroy?.();
            });
            pipeline(response.stream, stream, (error) => {
                if (error && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
                    logger('error', 'Newgrounds', `Stream error: ${error.message}`);
                }
            });
            return { stream, type: 'audio/mpeg' };
        }
        catch (error) {
            const message = this._getErrorMessage(error);
            logger('error', 'Newgrounds', `Failed to load stream: ${message}`);
            return {
                exception: {
                    message,
                    severity: 'fault',
                    cause: 'Newgrounds stream request failed'
                }
            };
        }
    }
    /**
     * Fetches and parses the player payload embedded in a listen page.
     * @param url - Newgrounds listen-page URL.
     * @returns Parsed audio metadata, or `null` for a missing submission.
     * @internal
     */
    async _fetchAudioPage(url) {
        const response = await makeRequest(url, {
            method: 'GET',
            headers: {
                Accept: 'text/html,application/xhtml+xml',
                'User-Agent': NEWGROUNDS_USER_AGENT
            }
        });
        if (response.statusCode === 403) {
            const identifier = url.match(NEWGROUNDS_AUDIO_PATTERN)?.[1];
            if (!identifier)
                return null;
            const previewResponse = await makeRequest(`https://cardyb.bsky.app/v1/extract?url=${encodeURIComponent(url)}`, {
                method: 'GET',
                headers: { 'User-Agent': NEWGROUNDS_USER_AGENT }
            });
            const preview = previewResponse.body;
            const title = preview.title?.trim();
            if (previewResponse.statusCode !== 200 || preview.error || !title) {
                return null;
            }
            const directory = Math.floor(Number(identifier) / 1000) * 1000;
            const filename = title
                .replace(/[^\p{L}\p{N}\s-]/gu, '')
                .replace(/\s+/g, '-');
            return {
                identifier,
                streamUrl: `https://audio-download.ngfiles.com/${directory}/${identifier}_${filename}.mp3`,
                version: Number(preview.image?.match(/f(\d+)/)?.[1] || 0),
                duration: 0,
                title,
                author: 'Unknown Artist'
            };
        }
        if (response.statusCode === 404)
            return null;
        if (response.error || response.statusCode !== 200) {
            throw new Error(response.error ||
                `Newgrounds returned page status ${response.statusCode ?? 'unknown'}`);
        }
        const html = this._getResponseText(response.body);
        if (!html)
            throw new Error('Newgrounds returned an unreadable page');
        const playerMatch = html.match(/NgAudioPlayer\.fromListenPage\(\s*\{([\s\S]*?)\}\s*,\s*\d+\s*\)/);
        const player = playerMatch?.[1];
        if (!player)
            return null;
        const identifier = this._extractNumber(player, 'generic_id');
        const streamUrl = this._extractString(player, 'url');
        const version = this._extractNumber(player, 'version');
        const duration = this._extractNumber(player, 'duration');
        const title = this._extractString(player, 'title');
        const author = this._extractString(player, 'author');
        if (identifier === null ||
            !streamUrl ||
            version === null ||
            duration === null ||
            !title ||
            !author) {
            throw new Error('Newgrounds player metadata is incomplete');
        }
        return {
            identifier: String(identifier),
            streamUrl: streamUrl.startsWith('//') ? `https:${streamUrl}` : streamUrl,
            version,
            duration,
            title,
            author
        };
    }
    /**
     * Extracts a JSON-encoded string field from the player object literal.
     * @param player - Player object literal body.
     * @param field - Field name to extract.
     * @returns Decoded field value, or `null` when absent or invalid.
     * @internal
     */
    _extractString(player, field) {
        const match = player.match(new RegExp(`['"]${field}['"]\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`));
        if (!match?.[1])
            return null;
        try {
            const value = JSON.parse(match[1]);
            return typeof value === 'string' && value ? value : null;
        }
        catch {
            return null;
        }
    }
    /**
     * Extracts a finite numeric field from the player object literal.
     * @param player - Player object literal body.
     * @param field - Field name to extract.
     * @returns Numeric field value, or `null` when absent or invalid.
     * @internal
     */
    _extractNumber(player, field) {
        const match = player.match(new RegExp(`['"]${field}['"]\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
        if (!match?.[1])
            return null;
        const value = Number(match[1]);
        return Number.isFinite(value) ? value : null;
    }
    /**
     * Converts a request body into HTML text.
     * @param body - Response body returned by the request helper.
     * @returns UTF-8 text, or `null` for an unsupported body value.
     * @internal
     */
    _getResponseText(body) {
        if (typeof body === 'string')
            return body;
        if (Buffer.isBuffer(body))
            return body.toString('utf8');
        return null;
    }
    /**
     * Builds the canonical listen-page URL for an audio identifier.
     * @param identifier - Newgrounds audio identifier.
     * @returns Canonical listen-page URL.
     * @internal
     */
    _buildListenUrl(identifier) {
        return `${NEWGROUNDS_BASE_URL}/audio/listen/${identifier}`;
    }
    /**
     * Builds the medium-size Newgrounds audio thumbnail URL.
     * @param identifier - Newgrounds audio identifier.
     * @param version - Media version used for cache busting.
     * @returns Medium-size artwork URL.
     * @internal
     */
    _buildArtworkUrl(identifier, version) {
        const directory = Math.floor(Number(identifier) / 1000);
        return `https://aicon.ngfiles.com/${directory}/${identifier}_medium.png?f${version}`;
    }
    /**
     * Normalizes unknown exceptions into loggable messages.
     * @param error - Caught exception value.
     * @returns Human-readable error message.
     * @internal
     */
    _getErrorMessage(error) {
        return error instanceof Error ? error.message : String(error);
    }
}
