import { spotifyCanvasType, spotifyCanvasUrl } from './spotifyCanvasResponse.js';
import { normalizeMediaImages as images, mediaDetails, normalizeMediaPalette, mediaUrl as webUrl } from './trackMedia.js';
function providerId(item, kind) {
    if (typeof item.id === 'string' && item.id)
        return item.id;
    const match = typeof item.uri === 'string'
        ? item.uri.match(new RegExp(`^spotify:${kind}:([A-Za-z0-9]+)$`))
        : undefined;
    return match?.[1];
}
/** Normalizes only metadata already present in Spotify track responses. */
export function buildSpotifyMedia(item, fallbackArtwork) {
    const listed = Array.isArray(item.artists)
        ? item.artists
        : item.artists?.items;
    const rawArtists = Array.isArray(listed) && listed.length
        ? listed
        : [
            ...(Array.isArray(item.firstArtist?.items)
                ? item.firstArtist.items
                : []),
            ...(Array.isArray(item.otherArtists?.items)
                ? item.otherArtists.items
                : [])
        ];
    const artists = [];
    for (const artist of rawArtists) {
        const rawName = artist?.profile?.name || artist?.name;
        if (typeof rawName !== 'string' || !rawName.trim())
            continue;
        const name = rawName.trim();
        const id = providerId(artist, 'artist');
        const artwork = images(artist.images ?? artist.visuals?.avatarImage?.sources);
        artists.push({
            name,
            ...(id ? { id } : {}),
            ...(artwork.length ? { artwork } : {})
        });
    }
    const album = item.albumOfTrack ?? item.album;
    const artwork = images(album?.coverArt?.sources ?? album?.images);
    const fallback = webUrl(fallbackArtwork);
    if (artwork.length === 0 && fallback)
        artwork.push({ url: fallback });
    const id = album ? providerId(album, 'album') : undefined;
    const name = typeof album?.name === 'string' ? album.name.trim() : undefined;
    return {
        provider: 'spotify',
        artists,
        ...mediaDetails({ identifiers: item.externalIds ?? item.external_ids }),
        ...(name || id || artwork.length
            ? {
                album: {
                    ...(name ? { name } : {}),
                    ...(id ? { id } : {}),
                    ...(artwork.length ? { artwork } : {})
                }
            }
            : {})
    };
}
/** Normalizes an existing Canvas response without fetching or proxying media. */
export function spotifyCanvasMedia(entry, trackUri) {
    if (!entry.trackUri || entry.trackUri !== trackUri)
        return undefined;
    const type = spotifyCanvasType(entry.type);
    if (type &&
        type !== 'UNKNOWN' &&
        type !== 'UNRECOGNIZED' &&
        !type.startsWith('VIDEO'))
        return undefined;
    const url = spotifyCanvasUrl(entry.canvasUrl);
    return url
        ? {
            url,
            ...(entry.id ? { id: entry.id } : {}),
            ...(typeof entry.canvasUri === 'string' &&
                /^spotify:canvas:[A-Za-z0-9]+$/.test(entry.canvasUri)
                ? { uri: entry.canvasUri }
                : {}),
            ...(typeof entry.fileId === 'string' &&
                /^[a-f0-9]{32}$/i.test(entry.fileId)
                ? { fileId: entry.fileId }
                : {}),
            ...(type ? { type } : {})
        }
        : undefined;
}
/** Select a matching, playable Canvas rather than trusting response order. */
export function selectSpotifyCanvas(entries, trackUri) {
    for (const entry of entries ?? []) {
        const canvas = spotifyCanvasMedia(entry, trackUri);
        if (canvas)
            return { entry, canvas };
    }
    return undefined;
}
/** Report only the validity of an existing session, never its token or expiry. */
export function spotifyCanvasSessionState(token, expiry, now = Date.now()) {
    if (!token?.trim())
        return 'missing';
    if (expiry === null || !Number.isFinite(expiry))
        return 'unknown-expiry';
    return expiry <= now ? 'expired' : 'ready';
}
/** Preserve the imagery of an explicitly resolved artist, not the artist of every track. */
export function buildSpotifyArtistMedia(input, expectedId) {
    function object(value) {
        return value && typeof value === 'object' && !Array.isArray(value)
            ? value
            : undefined;
    }
    const artist = object(input);
    if (!artist ||
        (artist.id !== undefined && artist.id !== expectedId) ||
        (artist.uri !== undefined && artist.uri !== `spotify:artist:${expectedId}`))
        return undefined;
    const name = object(artist.profile)?.name ?? artist.name;
    if (typeof name !== 'string' || !name.trim())
        return undefined;
    const visuals = object(artist.visuals);
    const gallery = object(visuals?.gallery)?.items;
    const artworkInputs = [];
    const append = (value) => {
        if (Array.isArray(value))
            artworkInputs.push(...value.slice(0, 100));
    };
    append(object(visuals?.avatarImage)?.sources);
    append(artist.images);
    for (const item of Array.isArray(gallery) ? gallery.slice(0, 50) : [])
        append(object(item)?.sources);
    const artwork = images(artworkInputs);
    const header = object(object(artist.headerImage)?.data);
    const banners = images(Array.isArray(header?.sources) ? header.sources.slice(0, 100) : []);
    return {
        provider: 'spotify',
        artists: [
            {
                id: expectedId,
                name: name.trim(),
                ...(artwork.length ? { artwork } : {}),
                ...(banners.length ? { banners } : {})
            }
        ]
    };
}
/** Read an ISRC only from the exact track returned by the official catalog. */
export function readOfficialSpotifyIsrc(input, expectedId) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        return undefined;
    const track = input;
    if (track.id !== expectedId)
        return undefined;
    const ids = track.external_ids;
    if (!ids || typeof ids !== 'object' || Array.isArray(ids))
        return undefined;
    return mediaDetails({
        identifiers: { isrc: ids.isrc }
    }).identifiers?.isrc;
}
/** Normalize a single-image response; the provider does not include an image ID in each result. */
export function normalizeSpotifyDynamicColors(input) {
    function object(value) {
        return value && typeof value === 'object' && !Array.isArray(value)
            ? value
            : undefined;
    }
    function rgb(value) {
        const color = object(value);
        if (color?.alpha !== 255)
            return undefined;
        const channels = [color.red, color.green, color.blue];
        if (!channels.every((v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255))
            return undefined;
        return ('#' +
            channels
                .map((v) => v.toString(16).padStart(2, '0'))
                .join('')
                .toUpperCase());
    }
    const items = object(input)?.dynamicColors;
    if (!Array.isArray(items) || items.length !== 1)
        return undefined;
    const source = object(items[0]);
    if (source?.status !== 'OK')
        return undefined;
    const converted = {
        bestFit: source.bestFit === 'DARK'
            ? 'dark'
            : source.bestFit === 'LIGHT'
                ? 'light'
                : undefined
    };
    for (const mode of ['dark', 'light']) {
        const raw = object(source[mode]);
        if (!raw)
            continue;
        const theme = {
            encoreBaseSetTextColor: rgb(raw.encoreBaseSetTextColor)
        };
        for (const level of [
            'minContrast',
            'highContrast',
            'higherContrast'
        ]) {
            const group = object(raw[level]);
            if (!group)
                continue;
            theme[level] = Object.fromEntries([
                'backgroundBase',
                'backgroundTintedBase',
                'textBase',
                'textBrightAccent',
                'textSubdued'
            ].map((key) => [key, rgb(group[key])]));
        }
        converted[mode] = theme;
    }
    const palette = normalizeMediaPalette(converted);
    if (!palette)
        return undefined;
    const dark = palette.dark?.highContrast?.backgroundBase;
    const light = palette.light?.highContrast?.backgroundBase;
    return { ...(dark ? { dark } : {}), ...(light ? { light } : {}), palette };
}
/** Read only explicitly identified ISRCs from the legacy metadata response. */
export function readSpotifyMetadataIsrc(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        return undefined;
    const ids = input.external_id;
    if (!Array.isArray(ids))
        return undefined;
    const values = new Set();
    for (const entry of ids) {
        if (!entry || typeof entry !== 'object' || entry.type !== 'isrc')
            continue;
        const isrc = mediaDetails({ identifiers: { isrc: entry.id } }).identifiers
            ?.isrc;
        if (isrc)
            values.add(isrc);
    }
    return values.size === 1 ? [...values][0] : undefined;
}
