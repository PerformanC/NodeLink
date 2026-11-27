import { buildTrackMedia } from './trackMedia.js';
/** Dimensions are taken only from the provider's explicit CDN URL format. */
function deezerImage(url) {
    if (typeof url !== 'string')
        return { url };
    try {
        const parsed = new URL(url);
        const dimensions = parsed.pathname.match(/^\/images\/(?:artist|cover)\/[^/]+\/(\d{1,4})x(\d{1,4})-/);
        if (parsed.protocol === 'https:' &&
            /^(?:[a-z0-9-]+\.)?dzcdn\.net$/i.test(parsed.hostname) &&
            dimensions) {
            return {
                url,
                width: Number(dimensions[1]),
                height: Number(dimensions[2])
            };
        }
    }
    catch { }
    return { url };
}
/** Preserve explicit contributor identities and roles without extra API requests. */
export function buildDeezerMedia(item, isrc) {
    const artists = new Map();
    const contributors = Array.isArray(item.contributors) ? item.contributors : [];
    for (const artist of [item.artist, ...contributors]) {
        if (!artist || typeof artist.name !== 'string' || !artist.name.trim())
            continue;
        const name = artist.name.trim();
        const id = artist.id;
        const key = id !== undefined && id !== null && String(id).trim()
            ? `id:${id}`
            : `name:${name}`;
        const previous = artists.get(key);
        const artwork = [
            artist.picture_xl,
            artist.picture_big,
            artist.picture_medium,
            artist.picture_small
        ].map(deezerImage);
        artists.set(key, {
            id,
            name,
            artwork: [...(previous?.artwork ?? []), ...artwork]
        });
    }
    return buildTrackMedia('deezer', {
        identifiers: { isrc },
        artists: [...artists.values()],
        credits: contributors.map((artist) => ({
            name: artist?.name,
            role: artist?.role
        })),
        album: {
            id: item.album?.id,
            name: item.album?.title,
            artwork: [
                item.album?.cover_xl,
                item.album?.cover_big,
                item.album?.cover_medium,
                item.album?.cover_small
            ].map(deezerImage)
        }
    });
}
