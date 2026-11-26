import { normalizeMediaImages } from './trackMedia.js';
/** Per-source, bounded cache of successful artist artwork lookups. */
export class SpotifyArtistMediaCache {
    entries = new Map();
    pending = new Map();
    fetchArtist;
    now;
    constructor(fetchArtist, now = Date.now) {
        this.fetchArtist = fetchArtist;
        this.now = now;
    }
    async get(id) {
        if (!/^[A-Za-z0-9]{22}$/.test(id))
            return undefined;
        const cached = this.entries.get(id);
        if (cached && cached.expires > this.now())
            return cached.artist;
        this.entries.delete(id);
        const pending = this.pending.get(id);
        if (pending)
            return pending;
        if (this.pending.size >= 8)
            return undefined;
        const task = Promise.resolve()
            .then(() => this.fetchArtist(id))
            .then((artist) => {
            if (!artist ||
                artist.id !== id ||
                (!artist.artwork?.length && !artist.banners?.length))
                return undefined;
            this.entries.set(id, { artist, expires: this.now() + 15 * 60_000 });
            if (this.entries.size > 128) {
                const oldest = this.entries.keys().next().value;
                if (oldest !== undefined)
                    this.entries.delete(oldest);
            }
            return artist;
        })
            .catch(() => undefined)
            .finally(() => this.pending.delete(id));
        this.pending.set(id, task);
        return task;
    }
    async enrich(artists) {
        const ids = [
            ...new Set(artists.flatMap((artist) => (artist.id ? [artist.id] : [])))
        ].slice(0, 3);
        const results = await Promise.all(ids.map(async (id) => [id, await this.get(id)]));
        const byId = new Map(results);
        return artists.map((artist) => {
            const detail = artist.id ? byId.get(artist.id) : undefined;
            if (!detail)
                return artist;
            const artwork = normalizeMediaImages([
                ...(artist.artwork ?? []),
                ...(detail.artwork ?? [])
            ]);
            const banners = normalizeMediaImages([
                ...(artist.banners ?? []),
                ...(detail.banners ?? [])
            ]);
            return {
                ...artist,
                ...(artwork.length ? { artwork } : {}),
                ...(banners.length ? { banners } : {})
            };
        });
    }
}
