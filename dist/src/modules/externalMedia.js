import { normalizeMediaImages } from './trackMedia.js';
function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
function list(value) {
    return Array.isArray(value) ? value : [];
}
function name(value) {
    return typeof value === 'string' && value.trim()
        ? value.trim().slice(0, 512)
        : undefined;
}
export function mbid(value) {
    return typeof value === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
        ? value.toLowerCase()
        : undefined;
}
export function mediaIsrc(value) {
    if (typeof value !== 'string')
        return undefined;
    const code = value.trim().toUpperCase().replace(/-/g, '');
    return /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(code) ? code : undefined;
}
function relations(value) {
    const credits = [];
    const works = new Set();
    for (const raw of list(value).slice(0, 250)) {
        const rel = record(raw);
        const artist = record(rel.artist);
        const id = mbid(artist.id);
        const artistName = name(artist.name);
        const role = name(rel.type);
        if (id &&
            artistName &&
            role &&
            !credits.some((c) => c.mbid === id && c.role === role)) {
            credits.push({ name: artistName, role, mbid: id });
        }
        const work = mbid(record(rel.work).id);
        if (work && rel.type === 'performance')
            works.add(work);
    }
    return { credits, workMbids: [...works] };
}
function releaseGroups(value) {
    const seen = new Set();
    return list(value)
        .slice(0, 100)
        .flatMap((raw) => {
        const group = record(raw);
        const id = mbid(group.id);
        const title = name(group.title);
        if (!id || !title || seen.has(id))
            return [];
        seen.add(id);
        return [
            {
                mbid: id,
                title,
                firstReleaseDate: name(group['first-release-date']),
                type: name(group['primary-type'])
            }
        ];
    });
}
/** Return distinct recording candidates rather than guessing which version is correct. */
export function musicBrainzRecordings(payload, isrc) {
    const root = record(payload);
    if (mediaIsrc(root.isrc) !== isrc || !Array.isArray(root.recordings))
        return null;
    const seen = new Set();
    const recordings = [];
    for (const raw of root.recordings.slice(0, 100)) {
        const item = record(raw);
        const id = mbid(item.id);
        const title = name(item.title);
        if (!id || !title || seen.has(id))
            continue;
        if (Array.isArray(item.isrcs) &&
            !item.isrcs.some((code) => mediaIsrc(code) === isrc))
            continue;
        seen.add(id);
        const artists = list(item['artist-credit'])
            .slice(0, 50)
            .flatMap((rawCredit) => {
            const credit = record(rawCredit);
            const artist = record(credit.artist);
            const artistId = mbid(artist.id);
            const artistName = name(credit.name) ?? name(artist.name);
            return artistId && artistName
                ? [{ mbid: artistId, name: artistName }]
                : [];
        });
        recordings.push({
            mbid: id,
            title,
            artists,
            ...(typeof item.length === 'number' &&
                Number.isSafeInteger(item.length) &&
                item.length >= 0
                ? { durationMs: item.length }
                : {}),
            ...relations(item.relations),
            releaseGroups: releaseGroups(item['release-groups'])
        });
    }
    return { provider: 'musicbrainz', isrc, recordings };
}
export function musicBrainzWork(payload, id) {
    const root = record(payload);
    if (mbid(root.id) !== id)
        return null;
    return {
        provider: 'musicbrainz',
        mbid: id,
        title: name(root.title),
        ...relations(root.relations)
    };
}
function fanartImages(value) {
    return normalizeMediaImages(list(value)
        .slice(0, 50)
        .flatMap((raw) => {
        const image = record(raw);
        if (typeof image.url !== 'string')
            return [];
        try {
            const url = new URL(image.url);
            if (url.hostname !== 'assets.fanart.tv' ||
                url.username ||
                url.password ||
                url.port ||
                !['http:', 'https:'].includes(url.protocol))
                return [];
            // The provider's legacy URLs may use HTTP; expose its HTTPS asset host only.
            url.protocol = 'https:';
            const dimension = (value) => {
                const number = typeof value === 'number' ||
                    (typeof value === 'string' && /^\d+$/.test(value))
                    ? Number(value)
                    : NaN;
                return Number.isSafeInteger(number) && number > 1
                    ? number
                    : undefined;
            };
            const width = dimension(image.width);
            const height = dimension(image.height);
            // Legacy logos may declare 1x1; retain the URL without claiming dimensions.
            return [
                { url: url.href, ...(width && height ? { width, height } : {}) }
            ];
        }
        catch {
            return [];
        }
    }));
}
export function fanartArtist(payload, id) {
    const root = record(payload);
    if (mbid(root.mbid_id) !== id)
        return null;
    return {
        provider: 'fanart.tv',
        mbid: id,
        name: name(root.name),
        artwork: fanartImages(root.artistthumb),
        banners: fanartImages(root.musicbanner),
        backgrounds: normalizeMediaImages([
            ...fanartImages(root.artist4kbackground),
            ...fanartImages(root.artistbackground)
        ]),
        logos: normalizeMediaImages([
            ...fanartImages(root.hdmusiclogo),
            ...fanartImages(root.musiclogo)
        ])
    };
}
/** Official v3.2 album arrays and legacy maps, keyed by exact release-group MBID. */
export function fanartAlbum(payload, id) {
    const root = record(payload);
    const albums = root.albums;
    const item = Array.isArray(albums)
        ? albums.map(record).find((album) => mbid(album.release_group_id) === id)
        : record(record(albums)[id]);
    if (!item || !Object.keys(item).length)
        return null;
    if (item.release_group_id !== undefined && mbid(item.release_group_id) !== id)
        return null;
    return {
        provider: 'fanart.tv',
        releaseGroupMbid: id,
        artistName: name(root.name),
        artwork: fanartImages(item.albumcover),
        discArtwork: fanartImages(item.cdart)
    };
}
