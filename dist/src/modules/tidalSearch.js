function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
export function tidalSearchItems(value, limit) {
    const root = record(value);
    const items = record(root?.tracks)?.items ?? root?.items;
    if (!Array.isArray(items))
        return [];
    return items
        .map(record)
        .filter((item) => !!item &&
        /^\d+$/.test(String(item.id)) &&
        typeof item.title === 'string' &&
        item.title.length > 0)
        .slice(0, Math.max(0, limit));
}
/** Try the track-specific legacy route once using the same authorization, if explicitly enabled. */
export async function tidalSearch(query, limit, get, allowAlternate, unauthorized) {
    try {
        return tidalSearchItems(await get('search', { query, limit, types: 'TRACKS' }), limit);
    }
    catch (error) {
        if (!allowAlternate || !unauthorized(error))
            throw error;
        // Preserve the initial diagnostic if the alternate route is also unavailable.
        try {
            return tidalSearchItems(await get('search/tracks', { query, limit }), limit);
        }
        catch {
            throw error;
        }
    }
}
export function matchingTidalAlbum(value, id) {
    const album = record(value);
    return /^\d+$/.test(id) && String(album?.id) === id ? album : undefined;
}
