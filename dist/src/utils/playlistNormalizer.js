/**
 * Centralized playlist metadata normalization for NodeLink.
 *
 * Ensures all playlist and album responses returned to clients contain
 * a comprehensive, consistent set of metadata fields inside `data.info`
 * while strictly maintaining Lavalink v4 protocol compatibility.
 *
 * @module utils/playlistNormalizer
 */
export { isGenericDescription } from '../sources/youtube/playlistMeta.js';
import { isGenericDescription } from '../sources/youtube/playlistMeta.js';
const KNOWN_ALBUM_TYPES = new Set([
    'album',
    'single',
    'ep',
    'compilation',
    'audiobook'
]);
/**
 * Returns a non-empty string trimmed of whitespace, or null if invalid or blank.
 */
function asNonEmptyString(val) {
    if (typeof val === 'string') {
        const trimmed = val.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    if (typeof val === 'number' && Number.isFinite(val)) {
        return String(val);
    }
    return null;
}
/**
 * Parses dates and timestamps into a standard ISO 8601 string.
 * Returns null if the value cannot be parsed into a valid date.
 */
export function parseIsoDate(val) {
    if (val === null || val === undefined || val === '')
        return null;
    if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
        // If timestamp in seconds (less than year 2100 in seconds: ~4.1e9)
        const ms = val < 1e11 ? val * 1000 : val;
        const date = new Date(ms);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    if (typeof val === 'string') {
        const trimmed = val.trim();
        if (!trimmed)
            return null;
        // Numeric timestamp string
        if (/^\d{10,13}$/.test(trimmed)) {
            const num = Number(trimmed);
            const ms = trimmed.length === 10 ? num * 1000 : num;
            const date = new Date(ms);
            return Number.isNaN(date.getTime()) ? null : date.toISOString();
        }
        const date = new Date(trimmed);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    if (val instanceof Date && !Number.isNaN(val.getTime())) {
        return val.toISOString();
    }
    return null;
}
/**
 * Extracts a playlist or album identifier from standard music service URLs.
 */
export function extractIdentifierFromUrl(url) {
    if (!url || typeof url !== 'string')
        return null;
    // YouTube / YouTube Music playlist: ?list=...
    const ytMatch = url.match(/[?&]list=([a-zA-Z0-9_-]+)/i);
    if (ytMatch?.[1])
        return ytMatch[1];
    // Spotify: /playlist/... or /album/...
    const spotifyMatch = url.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?(?:playlist|album|artist|show)\/([a-zA-Z0-9]+)/i);
    if (spotifyMatch?.[1])
        return spotifyMatch[1];
    // Apple Music: /playlist/... or /album/...
    const appleMatch = url.match(/music\.apple\.com\/[^/]+\/(?:playlist|album)\/[^/]+\/([a-zA-Z0-9._-]+)/i) ??
        url.match(/music\.apple\.com\/[^/]+\/(?:playlist|album)\/([a-zA-Z0-9._-]+)/i);
    if (appleMatch?.[1])
        return appleMatch[1];
    // Deezer: /playlist/... or /album/...
    const deezerMatch = url.match(/deezer\.com\/(?:[a-z]{2}\/)?(?:playlist|album)\/(\d+)/i);
    if (deezerMatch?.[1])
        return deezerMatch[1];
    // Tidal: /playlist/... or /album/...
    const tidalMatch = url.match(/tidal\.com\/(?:browse\/)?(?:playlist|album)\/([a-zA-Z0-9-]+)/i);
    if (tidalMatch?.[1])
        return tidalMatch[1];
    // SoundCloud: /sets/...
    const soundcloudMatch = url.match(/soundcloud\.com\/[^/]+\/sets\/([^/?#]+)/i);
    if (soundcloudMatch?.[1])
        return soundcloudMatch[1];
    // Bandcamp: /album/...
    const bandcampMatch = url.match(/bandcamp\.com\/album\/([^/?#]+)/i);
    if (bandcampMatch?.[1])
        return bandcampMatch[1];
    return null;
}
/**
 * Infers the music source name from a URL if not explicitly provided.
 */
export function inferSourceNameFromUrl(url) {
    if (!url || typeof url !== 'string')
        return null;
    if (/(?:youtube\.com|youtu\.be)/i.test(url))
        return 'youtube';
    if (/spotify\.com/i.test(url))
        return 'spotify';
    if (/apple\.com/i.test(url))
        return 'applemusic';
    if (/deezer\.com/i.test(url))
        return 'deezer';
    if (/soundcloud\.com/i.test(url))
        return 'soundcloud';
    if (/tidal\.com/i.test(url))
        return 'tidal';
    if (/bandcamp\.com/i.test(url))
        return 'bandcamp';
    if (/jiosaavn\.com/i.test(url))
        return 'jiosaavn';
    if (/bilibili\.com/i.test(url))
        return 'bilibili';
    if (/(?:163\.com|music\.163)/i.test(url))
        return 'netease';
    if (/yandex\.(?:ru|com|music)/i.test(url))
        return 'yandexmusic';
    if (/vk\.com/i.test(url))
        return 'vkmusic';
    if (/qobuz\.com/i.test(url))
        return 'qobuz';
    if (/audius\.co/i.test(url))
        return 'audius';
    return null;
}
/**
 * Builds the comprehensive `data.info` object containing all 18 specified fields.
 *
 * @param rawInfo - Initial playlist info provided by the source.
 * @param pluginInfo - Auxiliary collection metadata from pluginInfo.
 * @param tracks - List of tracks in the playlist.
 * @param context - Caller context including source name and request URL.
 * @returns Fully populated `NormalizedPlaylistInfo` object.
 * @public
 */
export function buildPlaylistInfo(rawInfo = {}, pluginInfo = {}, tracks = [], context) {
    const loadedTracks = Array.isArray(tracks) ? tracks.length : 0;
    // 1. Name
    const name = asNonEmptyString(rawInfo.name) ??
        asNonEmptyString(pluginInfo.name) ??
        asNonEmptyString(pluginInfo.title) ??
        'Unknown Playlist';
    // 2. Selected Track
    let selectedTrack = typeof rawInfo.selectedTrack === 'number' &&
        !Number.isNaN(rawInfo.selectedTrack)
        ? rawInfo.selectedTrack
        : 0;
    if (loadedTracks > 0) {
        if (selectedTrack >= loadedTracks || selectedTrack < -1) {
            selectedTrack = 0;
        }
    }
    else if (selectedTrack !== -1) {
        selectedTrack = -1;
    }
    // 3. Identifier
    const identifier = asNonEmptyString(rawInfo.identifier) ??
        asNonEmptyString(pluginInfo.identifier) ??
        asNonEmptyString(pluginInfo.id) ??
        extractIdentifierFromUrl(context?.url) ??
        null;
    // 4. URI
    const uri = asNonEmptyString(rawInfo.uri) ??
        asNonEmptyString(pluginInfo.uri) ??
        asNonEmptyString(pluginInfo.url) ??
        asNonEmptyString(pluginInfo.permalink_url) ??
        asNonEmptyString(context?.url) ??
        null;
    // 5. Artwork URL
    // Prioritize native playlist artwork; fall back to the first available track artwork
    let artworkUrl = asNonEmptyString(rawInfo.artworkUrl) ??
        asNonEmptyString(pluginInfo.artworkUrl) ??
        asNonEmptyString(pluginInfo.thumbnail) ??
        asNonEmptyString(pluginInfo.image) ??
        asNonEmptyString(pluginInfo.coverUrl) ??
        asNonEmptyString(pluginInfo.picture) ??
        null;
    if (!artworkUrl && loadedTracks > 0) {
        for (const track of tracks) {
            const trackArt = asNonEmptyString(track?.info?.artworkUrl);
            if (trackArt) {
                artworkUrl = trackArt;
                break;
            }
        }
    }
    // 6. Author
    const author = asNonEmptyString(rawInfo.author) ??
        asNonEmptyString(pluginInfo.author) ??
        asNonEmptyString(pluginInfo.artist) ??
        asNonEmptyString(pluginInfo.owner) ??
        asNonEmptyString(pluginInfo.curator) ??
        asNonEmptyString(pluginInfo.uploader) ??
        asNonEmptyString(pluginInfo.creator) ??
        null;
    // 7. Author URL
    const authorUrl = asNonEmptyString(rawInfo.authorUrl) ??
        asNonEmptyString(pluginInfo.authorUrl) ??
        asNonEmptyString(pluginInfo.author_url) ??
        asNonEmptyString(pluginInfo.ownerUrl) ??
        asNonEmptyString(pluginInfo.owner_url) ??
        asNonEmptyString(pluginInfo.artistUrl) ??
        asNonEmptyString(pluginInfo.artist_url) ??
        null;
    // 8. Description
    const rawDescription = asNonEmptyString(rawInfo.description) ??
        asNonEmptyString(pluginInfo.description) ??
        null;
    const description = rawDescription && !isGenericDescription(rawDescription)
        ? rawDescription
        : null;
    // 9. Source Name
    // Preserve original playlist source even when tracks resolve through another source
    const sourceName = asNonEmptyString(rawInfo.sourceName) ??
        asNonEmptyString(pluginInfo.sourceName) ??
        asNonEmptyString(context?.sourceName) ??
        inferSourceNameFromUrl(uri) ??
        asNonEmptyString(tracks[0]?.info?.sourceName) ??
        null;
    // 10. Total Tracks & 11. isPartial
    let totalTracksRaw = null;
    const candidateTotals = [
        rawInfo.totalTracks,
        pluginInfo.totalTracks,
        pluginInfo.total,
        pluginInfo.trackCount,
        pluginInfo.nb_tracks
    ];
    for (const candidate of candidateTotals) {
        if (typeof candidate === 'number' &&
            Number.isFinite(candidate) &&
            candidate >= 0) {
            totalTracksRaw = Math.floor(candidate);
            break;
        }
    }
    const explicitPartial = rawInfo.isPartial === true || pluginInfo.isPartial === true;
    const isPartial = explicitPartial ||
        (totalTracksRaw !== null && totalTracksRaw > loadedTracks);
    let totalTracks;
    if (totalTracksRaw !== null) {
        totalTracks = totalTracksRaw;
    }
    else if (!isPartial) {
        totalTracks = loadedTracks;
    }
    else {
        totalTracks = null;
    }
    // 12. Loaded Duration & Stream / Unknown detection
    let loadedDuration = 0;
    let hasStreamOrUnknown = false;
    for (const track of tracks) {
        const isStream = track?.info?.isStream === true;
        const length = typeof track?.info?.length === 'number' ? track.info.length : 0;
        if (isStream || length <= 0) {
            hasStreamOrUnknown = true;
        }
        else {
            loadedDuration += Math.round(length);
        }
    }
    // 13. Total Duration
    let explicitTotalDuration = null;
    const candidateDurations = [
        rawInfo.totalDuration,
        pluginInfo.totalDuration,
        pluginInfo.duration
    ];
    for (const candidate of candidateDurations) {
        if (typeof candidate === 'number' &&
            Number.isFinite(candidate) &&
            candidate >= 0) {
            explicitTotalDuration = Math.round(candidate);
            break;
        }
    }
    let totalDuration = null;
    if (explicitTotalDuration !== null) {
        totalDuration = explicitTotalDuration;
    }
    else if (isPartial) {
        // When partially loaded, do not report loaded duration as total duration
        totalDuration = null;
    }
    else if (loadedTracks === 0) {
        totalDuration = 0;
    }
    else if (hasStreamOrUnknown) {
        // Streams or unknown track lengths make total duration indeterminable
        totalDuration = null;
    }
    else {
        // Complete playlist with all track lengths known
        totalDuration = loadedDuration;
    }
    // 14. isAlbum
    const collectionType = typeof pluginInfo.type === 'string' ? pluginInfo.type.toLowerCase().trim() : '';
    let isAlbum = false;
    if (typeof rawInfo.isAlbum === 'boolean') {
        isAlbum = rawInfo.isAlbum;
    }
    else if (typeof pluginInfo.isAlbum === 'boolean') {
        isAlbum = pluginInfo.isAlbum;
    }
    else {
        isAlbum =
            KNOWN_ALBUM_TYPES.has(collectionType) ||
                (typeof identifier === 'string' && identifier.startsWith('OLAK')) ||
                (typeof uri === 'string' &&
                    (/[?&]list=OLAK/i.test(uri) || /\/album\//i.test(uri)));
    }
    // 15. isExplicit
    let isExplicit = null;
    if (typeof rawInfo.isExplicit === 'boolean') {
        isExplicit = rawInfo.isExplicit;
    }
    else if (typeof pluginInfo.isExplicit === 'boolean') {
        isExplicit = pluginInfo.isExplicit;
    }
    else {
        let anyExplicit = false;
        let determinableCount = 0;
        for (const track of tracks) {
            const trackRecord = track;
            const infoRecord = trackRecord.info;
            const pluginRecord = trackRecord.pluginInfo;
            const trackExplicit = typeof infoRecord?.isExplicit === 'boolean'
                ? infoRecord.isExplicit
                : typeof pluginRecord?.isExplicit === 'boolean'
                    ? pluginRecord.isExplicit
                    : typeof pluginRecord?.explicit === 'boolean'
                        ? pluginRecord.explicit
                        : null;
            if (trackExplicit !== null) {
                determinableCount++;
                if (trackExplicit === true) {
                    anyExplicit = true;
                    break;
                }
            }
        }
        if (anyExplicit) {
            isExplicit = true;
        }
        else if (determinableCount > 0 && determinableCount === loadedTracks && loadedTracks > 0) {
            isExplicit = false;
        }
        else {
            isExplicit = null;
        }
    }
    // 16. createdAt
    const createdAt = parseIsoDate(rawInfo.createdAt) ??
        parseIsoDate(pluginInfo.createdAt) ??
        parseIsoDate(pluginInfo.created_at) ??
        parseIsoDate(pluginInfo.releaseDate) ??
        parseIsoDate(pluginInfo.release_date) ??
        null;
    // 17. updatedAt
    const updatedAt = parseIsoDate(rawInfo.updatedAt) ??
        parseIsoDate(pluginInfo.updatedAt) ??
        parseIsoDate(pluginInfo.updated_at) ??
        parseIsoDate(pluginInfo.modifiedAt) ??
        parseIsoDate(pluginInfo.lastModified) ??
        parseIsoDate(pluginInfo.last_modified) ??
        null;
    const normalized = {
        name,
        selectedTrack,
        identifier,
        uri,
        artworkUrl,
        author,
        authorUrl,
        sourceName,
        totalTracks,
        loadedTracks,
        totalDuration,
        loadedDuration,
        isAlbum
    };
    if (description !== null) {
        normalized.description = description;
    }
    if (isPartial) {
        normalized.isPartial = true;
    }
    if (typeof isExplicit === 'boolean') {
        normalized.isExplicit = isExplicit;
    }
    if (createdAt !== null) {
        normalized.createdAt = createdAt;
    }
    if (updatedAt !== null) {
        normalized.updatedAt = updatedAt;
    }
    return normalized;
}
/**
 * Normalizes a playlist data object in-place and returns it.
 *
 * @param data - Raw or partial playlist data object.
 * @param context - Caller context including source name and request URL.
 * @returns Fully normalized `PlaylistData` object.
 * @public
 */
export function normalizePlaylistData(data, context) {
    const tracks = Array.isArray(data.tracks) ? data.tracks : [];
    const pluginInfo = (data.pluginInfo ?? {});
    const rawInfo = (data.info ?? {});
    const normalizedInfo = buildPlaylistInfo(rawInfo, pluginInfo, tracks, context);
    data.info = normalizedInfo;
    data.pluginInfo = pluginInfo;
    data.tracks = tracks;
    for (const track of tracks) {
        track.userData ??= {};
    }
    return data;
}
/**
 * Normalizes a SourceResult if it is a playlist collection.
 * Leaves track, search, empty, or error results completely unchanged.
 *
 * @param result - The resolution or search result.
 * @param context - Optional caller context.
 * @returns The normalized result.
 * @public
 */
export function normalizePlaylistResult(result, context) {
    if (!result || typeof result !== 'object' || !('loadType' in result)) {
        return result;
    }
    const res = result;
    if (res.loadType === 'playlist' ||
        res.loadType === 'album' ||
        res.loadType === 'artist' ||
        (res.loadType !== 'empty' &&
            res.loadType !== 'error' &&
            res.data &&
            typeof res.data === 'object' &&
            'tracks' in res.data &&
            'info' in res.data)) {
        // Preserve backward compatibility with Lavalink v4
        res.loadType = 'playlist';
        const playlistData = res.data;
        res.data = normalizePlaylistData(playlistData, context);
    }
    return result;
}
