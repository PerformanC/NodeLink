import { logger, makeRequest } from "../utils.js";
const CLEAN_PATTERNS = [
    /\s*\([^)]*(?:official|lyrics?|video|audio|mv|visualizer|color\s*coded|hd|4k|prod\.)[^)]*\)/gi,
    /\s*\[[^\]]*(?:official|lyrics?|video|audio|mv|visualizer|color\s*coded|hd|4k|prod\.)[^\]]*\]/gi,
    /\s*-\s*Topic$/i,
    /VEVO$/i
];
const FEAT_PATTERN = /\s*[([]\s*(?:ft\.?|feat\.?|featuring)\s+[^)\]]+[)\]]/gi;
const TIME_TAG_PATTERN = /\[(\d+):(\d{2})(?:\.(\d{2,3}))?\]/g;
const SEPARATORS = [' - ', ' – ', ' — '];
/**
 * Removes common video, lyrics, and marketing fragments from titles/authors.
 *
 * @param text - Raw title or artist text.
 * @param removeFeaturing - Whether featuring segments should also be removed.
 * @returns Sanitized text used for search and comparison.
 */
function cleanMetadata(text, removeFeaturing = false) {
    let result = text;
    for (const pattern of CLEAN_PATTERNS) {
        result = result.replace(pattern, '');
    }
    if (removeFeaturing) {
        result = result.replace(FEAT_PATTERN, '');
    }
    return result.trim();
}
/**
 * Splits a combined `artist - title` string into separate searchable parts.
 *
 * @param query - User-facing track title that may contain an artist prefix.
 * @returns Parsed artist/title pair used for LRCLIB lookup.
 */
function parseTrackQuery(query) {
    const cleaned = cleanMetadata(query, true);
    for (const separator of SEPARATORS) {
        const index = cleaned.indexOf(separator);
        if (index > 0 && index < cleaned.length - separator.length) {
            const artist = cleaned.slice(0, index).trim();
            const title = cleaned.slice(index + separator.length).trim();
            if (artist.length > 0 && title.length > 0) {
                return { artist, title };
            }
        }
    }
    return { artist: null, title: cleaned };
}
/**
 * Normalizes text for strict comparisons between LRCLIB results and input.
 *
 * @param text - Text fragment that should be compared case-insensitively.
 * @param removeFeaturing - Whether featuring tags should be stripped.
 * @returns Lowercased comparable text.
 */
function normalizeComparableText(text, removeFeaturing = false) {
    return cleanMetadata(text, removeFeaturing).toLowerCase();
}
/**
 * Extracts a record from a JSON-compatible value.
 *
 * @param value - Candidate JSON value.
 * @returns Record view when the value is object-like, otherwise `null`.
 */
function getRecordFromValue(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return null;
    }
    return value;
}
/**
 * Reads a named property from a JSON record while preserving index-signature
 * compatibility with the project's strict compiler settings.
 *
 * @param record - JSON object previously narrowed by {@link getRecordFromValue}.
 * @param key - Property name to retrieve.
 * @returns Raw JSON value stored under the requested key, if present.
 */
function getRecordValue(record, key) {
    return record?.[key];
}
/**
 * Extracts a string from a JSON-compatible value.
 *
 * @param value - Candidate JSON value.
 * @returns String value when present, otherwise `null`.
 */
function getString(value) {
    return typeof value === 'string' ? value : null;
}
/**
 * Extracts a boolean from a JSON-compatible value.
 *
 * @param value - Candidate JSON value.
 * @returns Boolean value when present, otherwise `null`.
 */
function getBoolean(value) {
    return typeof value === 'boolean' ? value : null;
}
/**
 * Narrows a JSON payload into the LRCLIB result shape used by this source.
 *
 * @param body - Parsed or raw HTTP body returned by the request helper.
 * @returns Valid LRCLIB search entries only.
 */
function parseSearchResults(body) {
    const payload = typeof body === 'string' ? JSON.parse(body) : body;
    if (!Array.isArray(payload)) {
        return [];
    }
    const results = [];
    for (const entry of payload) {
        const record = getRecordFromValue(entry);
        const trackName = getString(getRecordValue(record, 'trackName'));
        const artistName = getString(getRecordValue(record, 'artistName'));
        if (!trackName || !artistName) {
            continue;
        }
        results.push({
            trackName,
            artistName,
            instrumental: getBoolean(getRecordValue(record, 'instrumental')) ?? false,
            syncedLyrics: getString(getRecordValue(record, 'syncedLyrics')),
            plainLyrics: getString(getRecordValue(record, 'plainLyrics'))
        });
    }
    return results;
}
/**
 * Converts a caught failure into a log-safe message.
 *
 * @param error - Caught runtime failure or helper error text.
 * @returns Human-readable message for logs and API errors.
 */
function getErrorMessage(error) {
    return error instanceof Error ? error.message : error;
}
/**
 * LRCLIB lyrics provider.
 */
export default class LRCLIBLyrics {
    /**
     * Runtime container passed by the lyrics manager.
     */
    nodelink;
    /**
     * Creates a new LRCLIB lyrics provider instance.
     *
     * @param nodelink - Runtime container passed by the lyrics manager.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
    }
    /**
     * Initializes the LRCLIB provider.
     *
     * LRCLIB does not require boot-time authentication or cache warmup.
     *
     * @returns `true` because the provider is immediately ready.
     */
    async setup() {
        return true;
    }
    /**
     * Parses synced LRCLIB lyrics in LRC format into timed lyric lines.
     *
     * This keeps all timestamps attached to a line and derives each line
     * duration from the next timestamp so consumers receive more useful timing
     * data than the legacy JavaScript implementation.
     *
     * @param lrc - Raw LRCLIB `syncedLyrics` payload.
     * @returns Sorted lyric lines with millisecond timestamps.
     */
    parseLrc(lrc) {
        const lines = [];
        const rawLines = lrc.split('\n');
        for (const rawLine of rawLines) {
            const timestamps = [];
            let match = TIME_TAG_PATTERN.exec(rawLine);
            while (match) {
                const minutes = Number.parseInt(match[1] ?? '0', 10);
                const seconds = Number.parseInt(match[2] ?? '0', 10);
                const millisecondsText = (match[3] ?? '0').padEnd(3, '0').slice(0, 3);
                const milliseconds = Number.parseInt(millisecondsText, 10);
                timestamps.push(minutes * 60_000 + seconds * 1_000 + milliseconds);
                match = TIME_TAG_PATTERN.exec(rawLine);
            }
            TIME_TAG_PATTERN.lastIndex = 0;
            if (timestamps.length === 0) {
                continue;
            }
            const text = rawLine.replace(TIME_TAG_PATTERN, '').trim();
            if (text.length === 0) {
                continue;
            }
            for (const time of timestamps) {
                lines.push({ text, time, duration: 0 });
            }
        }
        return this.applyLineDurations(lines);
    }
    /**
     * Converts plain unsynced lyrics into the unified line structure.
     *
     * @param lyrics - Raw plain-text lyrics returned by LRCLIB.
     * @returns Non-empty lyric lines with zeroed timing metadata.
     */
    parsePlainLyrics(lyrics) {
        return lyrics
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((text) => ({
            text,
            time: 0,
            duration: 0
        }));
    }
    /**
     * Applies durations to timed lyric lines based on the next timestamp.
     *
     * @param lines - Timed lyrics that may still have zero durations.
     * @returns Sorted lyric lines with best-effort durations.
     */
    applyLineDurations(lines) {
        const sortedLines = [...lines].sort((left, right) => left.time - right.time);
        return sortedLines.map((line, index) => {
            const nextLine = sortedLines[index + 1];
            return {
                ...line,
                duration: nextLine && nextLine.time > line.time ? nextLine.time - line.time : 0
            };
        });
    }
    /**
     * Selects the most relevant LRCLIB result for the requested track.
     *
     * The matching order is:
     * 1. exact title + exact artist
     * 2. exact title
     * 3. first non-instrumental result
     *
     * @param results - Candidate LRCLIB search results.
     * @param title - Sanitized target title.
     * @param artist - Sanitized target artist.
     * @returns Best matching LRCLIB entry or `null` when none fit.
     */
    selectBestMatch(results, title, artist) {
        const normalizedTitle = normalizeComparableText(title, true);
        const normalizedArtist = normalizeComparableText(artist, false);
        const exactTrackAndArtist = results.find((result) => !result.instrumental &&
            normalizeComparableText(result.trackName, true) === normalizedTitle &&
            normalizeComparableText(result.artistName, false) === normalizedArtist) ?? null;
        if (exactTrackAndArtist) {
            return exactTrackAndArtist;
        }
        const exactTrack = results.find((result) => !result.instrumental &&
            normalizeComparableText(result.trackName, true) === normalizedTitle) ?? null;
        if (exactTrack) {
            return exactTrack;
        }
        return results.find((result) => !result.instrumental) ?? null;
    }
    /**
     * Converts the selected LRCLIB item into the unified lyrics payload.
     *
     * @param match - Chosen LRCLIB search item.
     * @returns Lyrics result or an empty payload when the item has no lyrics.
     */
    buildLyricsResult(match) {
        if (match.syncedLyrics) {
            const lines = this.parseLrc(match.syncedLyrics);
            if (lines.length > 0) {
                return {
                    loadType: 'lyrics',
                    data: {
                        name: match.trackName,
                        synced: true,
                        lines
                    }
                };
            }
        }
        if (match.plainLyrics) {
            const lines = this.parsePlainLyrics(match.plainLyrics);
            if (lines.length > 0) {
                return {
                    loadType: 'lyrics',
                    data: {
                        name: match.trackName,
                        synced: false,
                        lines
                    }
                };
            }
        }
        return { loadType: 'empty', data: {} };
    }
    /**
     * Fetches lyrics for a decoded track using LRCLIB's search API.
     *
     * The provider first normalizes the incoming title/artist, then searches
     * LRCLIB, selects the best non-instrumental match, and finally converts
     * either synced or plain lyrics into the manager's unified format.
     *
     * @param trackInfo - Minimal decoded track metadata from the player.
     * @returns Lyrics payload, empty result, or structured error response.
     */
    async getLyrics(trackInfo) {
        const parsedTrack = parseTrackQuery(trackInfo.title);
        const sanitizedAuthor = cleanMetadata(trackInfo.author, false);
        const artist = parsedTrack.artist ?? sanitizedAuthor;
        const title = parsedTrack.artist
            ? parsedTrack.title
            : cleanMetadata(trackInfo.title, true);
        const query = `${title} ${artist}`.trim();
        logger('debug', 'Lyrics', `Searching LRCLIB for: ${query}`);
        try {
            const response = await makeRequest(`https://lrclib.net/api/search?q=${encodeURIComponent(query)}`, { method: 'GET' });
            if (response.error) {
                throw new Error(response.error);
            }
            if (response.statusCode !== 200) {
                throw new Error(`Unexpected LRCLIB status code: ${response.statusCode}`);
            }
            const results = parseSearchResults(response.body);
            if (results.length === 0) {
                return { loadType: 'empty', data: {} };
            }
            const bestMatch = this.selectBestMatch(results, title, artist);
            if (!bestMatch) {
                return { loadType: 'empty', data: {} };
            }
            return this.buildLyricsResult(bestMatch);
        }
        catch (error) {
            const message = getErrorMessage(error instanceof Error ? error : String(error));
            logger('error', 'Lyrics', `Failed to fetch lyrics from LRCLIB: ${message}`);
            return {
                loadType: 'error',
                data: {
                    message,
                    severity: 'fault'
                }
            };
        }
    }
}
