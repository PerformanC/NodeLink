import { encodeTrack, http1makeRequest, logger } from "../utils.js";
const GENIUS_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache'
};
const GENIUS_PATTERN = /https?:\/\/(?:www\.)?genius\.com\/(?:videos|a\/)?([\w-]+)/;
const PRELOADED_STATE_REGEX = /<script[^>]*>\s*window\.__PRELOADED_STATE__\s*=\s*JSON\.parse\((.+?)\);\s*<\/script>/s;
/**
 * Genius source implementation.
 */
export default class GeniusSource {
    /**
     * Runtime worker context used by the source implementation.
     */
    nodelink;
    /**
     * URL patterns supported by this source.
     */
    patterns;
    /**
     * Search aliases handled by this source.
     */
    searchTerms;
    /**
     * Match priority used by the source manager.
     */
    priority;
    /**
     * Creates a new Genius source wrapper.
     *
     * @param nodelink Worker runtime used by the source implementation.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.patterns = [GENIUS_PATTERN];
        this.searchTerms = [];
        this.priority = 100;
    }
    /**
     * Announces the Genius source during worker initialization.
     *
     * @returns `true` when the source is ready to accept requests.
     */
    async setup() {
        logger('info', 'Sources', 'Loaded Genius source (Video/Audio/Article).');
        return true;
    }
    /**
     * Genius does not expose a standalone search endpoint in this source path.
     *
     * @returns An empty result payload.
     */
    async search(_query) {
        return { loadType: 'empty', data: {} };
    }
    /**
     * Resolves a Genius article or video page into a playlist of delegated media
     * candidates, or a single fallback track when no media embeds can be parsed.
     *
     * @param url Public Genius page URL.
     * @returns A playlist, an empty payload, or a structured exception.
     */
    async resolve(url) {
        const match = url.match(GENIUS_PATTERN);
        if (!match) {
            return { loadType: 'empty', data: {} };
        }
        try {
            const { body, error, statusCode } = await http1makeRequest(url, {
                method: 'GET',
                headers: GENIUS_HEADERS,
                disableBodyCompression: true
            });
            if (error || statusCode !== 200) {
                throw new Error(error ?? `Genius returned status ${statusCode}`);
            }
            const html = this.getTextBody({ body });
            if (!html) {
                throw new Error('Genius returned an unreadable response body');
            }
            const songInfo = this.extractPreloadedState(html);
            if (!songInfo) {
                throw new Error('Could not extract Genius metadata');
            }
            const songPage = songInfo.songPage;
            const songId = songPage?.song;
            if (!songId) {
                throw new Error('Song ID not found in extracted data');
            }
            const title = this.getTrackingValue(songPage.trackingData, 'Title') ?? 'Unknown Title';
            const artist = this.getTrackingValue(songPage.trackingData, 'Primary Artist') ??
                'Unknown Artist';
            const songData = this.getSongData(songInfo.songs, songId);
            if (!songData) {
                throw new Error('Song data not found in entities');
            }
            const artworkUrl = songData.headerImageUrl ?? songData.songArtImageUrl;
            const tracks = [];
            for (const media of songData.media) {
                if ((media.type !== 'video' && media.type !== 'audio') || !media.url) {
                    continue;
                }
                const baseTrackInfo = this.createTrackInfo({
                    identifier: media.url,
                    title: `${title} (${media.provider ?? 'media'})`,
                    author: artist,
                    uri: media.url,
                    artworkUrl,
                    length: 0,
                    isSeekable: true,
                    isStream: false
                });
                const enrichedTrackInfo = await this.enrichTrackInfo(baseTrackInfo, media.url);
                tracks.push({
                    encoded: encodeTrack(enrichedTrackInfo),
                    info: enrichedTrackInfo,
                    pluginInfo: media.provider ? { provider: media.provider } : {}
                });
            }
            if (tracks.length === 0) {
                const fallbackTrack = this.createTrackInfo({
                    identifier: `genius:${songId}`,
                    title,
                    author: artist,
                    uri: url,
                    artworkUrl,
                    length: 0,
                    isSeekable: true,
                    isStream: false
                });
                tracks.push({
                    encoded: encodeTrack(fallbackTrack),
                    info: fallbackTrack,
                    pluginInfo: {}
                });
            }
            const playlist = {
                info: {
                    name: `${title} - ${artist} (Genius)`,
                    selectedTrack: 0
                },
                pluginInfo: {},
                tracks
            };
            return { loadType: 'playlist', data: playlist };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger('error', 'Genius', `Error resolving URL: ${message}`);
            return { exception: { message, severity: 'fault' } };
        }
    }
    /**
     * Resolves a playable stream URL for a Genius track. It first tries to
     * resolve the stored media URL directly and, if that fails, falls back to the
     * default-search pipeline using title and author matching.
     *
     * @param decodedTrack Decoded Genius track information.
     * @returns A delegated track URL descriptor or a structured exception.
     */
    async getTrackUrl(decodedTrack) {
        const sourceManager = this.getSourceManager();
        if (!sourceManager) {
            return {
                exception: {
                    message: 'Source manager is not available for Genius resolution.',
                    severity: 'fault'
                }
            };
        }
        if (decodedTrack.uri.startsWith('http')) {
            try {
                const result = await sourceManager.resolve(decodedTrack.uri);
                const targetTrack = this.extractTrackReferenceFromSourceResult(result);
                if (targetTrack) {
                    const streamInfo = await sourceManager.getTrackUrl(targetTrack.info);
                    return { newTrack: targetTrack, ...streamInfo };
                }
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logger('debug', 'Genius', `Direct resolve failed for ${decodedTrack.uri}: ${message}`);
            }
        }
        try {
            const query = `${decodedTrack.title} ${decodedTrack.author}`;
            const searchResult = await sourceManager.searchWithDefault(query);
            const candidates = this.extractSearchCandidates(searchResult);
            if (candidates.length === 0) {
                return {
                    exception: {
                        message: 'No alternative stream found via default search.',
                        severity: 'fault'
                    }
                };
            }
            const bestMatch = this.findBestMatch(candidates, decodedTrack);
            if (!bestMatch) {
                return {
                    exception: {
                        message: 'No suitable alternative stream found after filtering.',
                        severity: 'fault'
                    }
                };
            }
            const streamInfo = await sourceManager.getTrackUrl(bestMatch.info);
            return { newTrack: bestMatch, ...streamInfo };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                exception: {
                    message,
                    severity: 'fault'
                }
            };
        }
    }
    /**
     * Creates an encodable Genius track payload from the supplied fields.
     *
     * @param input Track fields collected during page parsing.
     * @returns A normalized Genius track payload compatible with `encodeTrack`.
     */
    createTrackInfo(input) {
        return {
            identifier: input.identifier,
            isSeekable: input.isSeekable,
            author: input.author,
            length: input.length,
            isStream: input.isStream,
            position: 0,
            title: input.title,
            uri: input.uri,
            artworkUrl: input.artworkUrl,
            isrc: null,
            sourceName: 'genius',
            details: []
        };
    }
    /**
     * Attempts to enrich a delegated Genius media candidate by resolving the
     * underlying URL through the source manager.
     *
     * @param trackInfo Base Genius track payload.
     * @param mediaUrl Delegated media URL attached to the Genius page.
     * @returns The enriched track payload when resolution succeeds, otherwise the
     * original payload.
     */
    async enrichTrackInfo(trackInfo, mediaUrl) {
        const sourceManager = this.getSourceManager();
        if (!sourceManager) {
            return trackInfo;
        }
        try {
            const result = await sourceManager.resolve(mediaUrl);
            const targetTrack = this.extractTrackReferenceFromSourceResult(result);
            if (!targetTrack) {
                return trackInfo;
            }
            return {
                ...trackInfo,
                title: targetTrack.info.title,
                author: targetTrack.info.author,
                length: targetTrack.info.length,
                isStream: targetTrack.info.isStream,
                isSeekable: targetTrack.info.isSeekable,
                artworkUrl: targetTrack.info.artworkUrl ?? trackInfo.artworkUrl,
                isrc: targetTrack.info.isrc ?? null
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger('debug', 'Genius', `Failed to resolve media URL ${mediaUrl}: ${message}; using basic info.`);
            return trackInfo;
        }
    }
    /**
     * Extracts the Genius preloaded state from the page HTML and narrows it to
     * the subset used by this source.
     *
     * @param html Raw Genius page HTML.
     * @returns A narrowed preloaded state or `null` when the payload cannot be parsed.
     */
    extractPreloadedState(html) {
        const scriptMatch = html.match(PRELOADED_STATE_REGEX);
        const jsonParseArg = scriptMatch?.[1];
        if (!jsonParseArg) {
            return null;
        }
        try {
            const parseFunction = new Function(`return JSON.parse(${jsonParseArg})`);
            const payload = parseFunction();
            return this.toPreloadedState(payload);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger('debug', 'Genius', `JavaScript execution failed: ${message}`);
            return null;
        }
    }
    /**
     * Narrows an arbitrary parsed value to the minimal Genius preloaded-state
     * shape used by this source.
     *
     * @param value Parsed payload returned from the embedded `JSON.parse(...)`.
     * @returns A narrowed Genius preloaded state or `null` when the payload does
     * not match the expected structure.
     */
    toPreloadedState(value) {
        const record = this.getRecordFromValue(value);
        if (!record) {
            return null;
        }
        const songPageRecord = this.getRecord(record, 'songPage');
        const entitiesRecord = this.getRecord(record, 'entities');
        const songsRecord = entitiesRecord
            ? this.getRecord(entitiesRecord, 'songs')
            : null;
        const songs = {};
        if (songsRecord) {
            for (const [key, songValue] of Object.entries(songsRecord)) {
                const songData = this.toSongData(songValue);
                if (songData) {
                    songs[key] = songData;
                }
            }
        }
        return {
            songPage: songPageRecord ? this.toSongPage(songPageRecord) : null,
            songs
        };
    }
    /**
     * Converts a raw song-page record into the narrowed Genius song-page shape.
     *
     * @param record Raw `songPage` record.
     * @returns A narrowed song-page payload.
     */
    toSongPage(record) {
        return {
            song: this.getString(record, 'song'),
            trackingData: this.getTrackingEntries(this.getValue(record, 'trackingData'))
        };
    }
    /**
     * Converts a raw song entity into the narrowed song-data shape.
     *
     * @param value Raw song value from `entities.songs`.
     * @returns A narrowed song payload or `null` when the value is invalid.
     */
    toSongData(value) {
        const record = this.getRecordFromValue(value);
        if (!record) {
            return null;
        }
        const mediaValues = this.getArray(record, 'media');
        return {
            media: mediaValues
                .map((entry) => this.toMediaEntry(entry))
                .filter((entry) => entry !== null),
            headerImageUrl: this.getString(record, 'headerImageUrl'),
            songArtImageUrl: this.getString(record, 'songArtImageUrl')
        };
    }
    /**
     * Converts a raw Genius media payload into the narrowed media-entry shape.
     *
     * @param value Raw media value from the preloaded state.
     * @returns A narrowed media entry or `null` when the payload is invalid.
     */
    toMediaEntry(value) {
        const record = this.getRecordFromValue(value);
        if (!record) {
            return null;
        }
        return {
            type: this.getString(record, 'type'),
            url: this.getString(record, 'url'),
            provider: this.getString(record, 'provider')
        };
    }
    /**
     * Extracts normalized tracking entries from a raw tracking-data payload.
     *
     * @param value Raw tracking-data array from the preloaded state.
     * @returns Normalized tracking entries.
     */
    getTrackingEntries(value) {
        if (!Array.isArray(value)) {
            return [];
        }
        return value
            .map((entry) => this.getRecordFromValue(entry))
            .filter((entry) => entry !== null)
            .map((entry) => ({
            key: this.getString(entry, 'key'),
            value: this.getString(entry, 'value')
        }));
    }
    /**
     * Reads a specific tracking value from the Genius tracking-data array.
     *
     * @param entries Tracking entries extracted from `songPage.trackingData`.
     * @param key Tracking key to look up.
     * @returns The matching tracking value or `null` when not found.
     */
    getTrackingValue(entries, key) {
        const entry = entries.find((item) => item.key === key);
        return entry?.value ?? null;
    }
    /**
     * Resolves a song id to the matching song entity, falling back to the first
     * available entity when the expected id is missing.
     *
     * @param songs Song entities keyed by id.
     * @param songId Expected song id from `songPage.song`.
     * @returns The matching song data or `null` when no entities exist.
     */
    getSongData(songs, songId) {
        const directMatch = songs[songId];
        if (directMatch) {
            return directMatch;
        }
        const firstKey = Object.keys(songs)[0];
        return firstKey ? (songs[firstKey] ?? null) : null;
    }
    /**
     * Extracts a usable track reference from a source-manager result. This helper
     * accepts either a direct `track` result or the first track in a `playlist`
     * result.
     *
     * @param result Source-manager result returned by a delegated resolve call.
     * @returns The first usable track reference or `null`.
     */
    extractTrackReferenceFromSourceResult(result) {
        const resultData = result.data;
        if (!resultData) {
            return null;
        }
        const trackData = resultData;
        if (result.loadType === 'track' && this.isTrackReference(trackData)) {
            return trackData;
        }
        const playlistData = resultData;
        if (result.loadType === 'playlist' &&
            this.isTrackCollection(playlistData) &&
            playlistData.tracks.length > 0) {
            return playlistData.tracks[0] ?? null;
        }
        return null;
    }
    /**
     * Extracts search candidates from a default-search result.
     *
     * @param result Source-manager search result.
     * @returns Track references suitable for title/author matching.
     */
    extractSearchCandidates(result) {
        const resultData = result.data;
        if (result.loadType === 'search' &&
            Array.isArray(resultData) &&
            resultData.every((item) => this.isTrackReference(item))) {
            return resultData;
        }
        return [];
    }
    /**
     * Chooses the best fallback track candidate by comparing normalized title and
     * author strings.
     *
     * @param list Candidate tracks returned by the default-search fallback.
     * @param original Original Genius track that needs a playable stream.
     * @returns The best candidate or `null` when no usable match exists.
     */
    findBestMatch(list, original) {
        const normalizedOriginalTitle = this.normalize(original.title);
        const normalizedOriginalAuthor = this.normalize(original.author);
        const scoredCandidates = list
            .map((item) => {
            const normalizedItemTitle = this.normalize(item.info.title);
            const normalizedItemAuthor = this.normalize(item.info.author);
            let score = 0;
            if (normalizedItemTitle.includes(normalizedOriginalTitle) ||
                normalizedOriginalTitle.includes(normalizedItemTitle)) {
                score += 100;
            }
            if (normalizedItemAuthor.includes(normalizedOriginalAuthor) ||
                normalizedOriginalAuthor.includes(normalizedItemAuthor)) {
                score += 100;
            }
            return { item, score };
        })
            .filter((candidate) => candidate.score >= 0);
        if (scoredCandidates.length === 0) {
            return null;
        }
        scoredCandidates.sort((left, right) => right.score - left.score);
        return scoredCandidates[0]?.item ?? null;
    }
    /**
     * Normalizes a title or author string for fuzzy comparison.
     *
     * @param value Human-readable title or author string.
     * @returns A simplified lowercase token string.
     */
    normalize(value) {
        if (!value) {
            return '';
        }
        return value
            .toLowerCase()
            .replace(/feat\.?/g, '')
            .replace(/ft\.?/g, '')
            .replace(/(\s*\(.*\)\s*)/g, '')
            .replace(/[^\w\s]/g, '')
            .trim();
    }
    /**
     * Returns the source manager narrowed to the methods used by this source.
     *
     * @returns The narrowed source manager or `null` when it is unavailable.
     */
    getSourceManager() {
        const sourceManager = this.nodelink.sources;
        return sourceManager ?? null;
    }
    /**
     * Converts a buffered HTTP body into text.
     *
     * @param response HTTP helper response carrying the buffered body.
     * @returns A UTF-8 string when the body is text-like, otherwise `null`.
     */
    getTextBody(response) {
        if (typeof response.body === 'string') {
            return response.body;
        }
        if (Buffer.isBuffer(response.body)) {
            return response.body.toString('utf8');
        }
        return null;
    }
    /**
     * Reads a nested record property from a JSON record.
     *
     * @param record Source record.
     * @param key Property name to read.
     * @returns The nested record or `null` when the property is not an object.
     */
    getRecord(record, key) {
        return this.getRecordFromValue(record[key]);
    }
    /**
     * Converts a JSON value into a record when possible.
     *
     * @param value Candidate JSON value.
     * @returns The record representation or `null`.
     */
    getRecordFromValue(value) {
        return value && typeof value === 'object' && !Array.isArray(value)
            ? value
            : null;
    }
    /**
     * Reads an array property from a JSON record.
     *
     * @param record Source record.
     * @param key Property name to read.
     * @returns The nested array or an empty array when the property is not an array.
     */
    getArray(record, key) {
        const value = this.getValue(record, key);
        return Array.isArray(value) ? value : [];
    }
    /**
     * Reads an arbitrary property value from a JSON record.
     *
     * @param record Source record.
     * @param key Property name to read.
     * @returns The property value or `undefined` when absent.
     */
    getValue(record, key) {
        return record[key];
    }
    /**
     * Reads a string-like field from a JSON record.
     *
     * @param record Source record.
     * @param key Property name to read.
     * @returns The normalized string value or `null`.
     */
    getString(record, key) {
        const value = this.getValue(record, key);
        if (typeof value === 'string') {
            return value;
        }
        if (typeof value === 'number') {
            return String(value);
        }
        return null;
    }
    /**
     * Checks whether an arbitrary value exposes a valid `TrackInfo` payload.
     *
     * @param value Candidate value returned by delegated source calls.
     * @returns `true` when the value contains a valid `TrackInfo` object.
     */
    isTrackInfo(value) {
        const record = this.getRecordFromValue(value);
        if (!record) {
            return false;
        }
        const identifier = this.getValue(record, 'identifier');
        const title = this.getValue(record, 'title');
        const author = this.getValue(record, 'author');
        const length = this.getValue(record, 'length');
        const isSeekable = this.getValue(record, 'isSeekable');
        const isStream = this.getValue(record, 'isStream');
        const position = this.getValue(record, 'position');
        const uri = this.getValue(record, 'uri');
        const sourceName = this.getValue(record, 'sourceName');
        return (typeof identifier === 'string' &&
            typeof title === 'string' &&
            typeof author === 'string' &&
            typeof length === 'number' &&
            typeof isSeekable === 'boolean' &&
            typeof isStream === 'boolean' &&
            typeof position === 'number' &&
            typeof uri === 'string' &&
            typeof sourceName === 'string');
    }
    /**
     * Checks whether a value exposes a valid track wrapper with an `info` field.
     *
     * @param value Candidate value returned by delegated source calls.
     * @returns `true` when the value is a usable track reference.
     */
    isTrackReference(value) {
        const record = this.getRecordFromValue(value);
        if (!record) {
            return false;
        }
        return this.isTrackInfo(this.getValue(record, 'info'));
    }
    /**
     * Checks whether a value exposes a valid playlist-like `tracks` array.
     *
     * @param value Candidate source result payload.
     * @returns `true` when the value contains a valid `tracks` array.
     */
    isTrackCollection(value) {
        const record = this.getRecordFromValue(value);
        if (!record) {
            return false;
        }
        const tracks = this.getValue(record, 'tracks');
        return (Array.isArray(tracks) &&
            tracks.every((track) => this.isTrackReference(track)));
    }
}
