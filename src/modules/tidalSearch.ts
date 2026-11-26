type RecordData = Record<string, unknown>

function record(value: unknown): RecordData | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordData : undefined
}

export function tidalSearchItems(value: unknown, limit: number): RecordData[] {
  const root = record(value)
  const items = record(root?.tracks)?.items ?? root?.items
  if (!Array.isArray(items)) return []
  return items.map(record).filter((item): item is RecordData => !!item && /^\d+$/.test(String(item.id)) && typeof item.title === 'string' && item.title.length > 0).slice(0, Math.max(0, limit))
}

/** Try the track-specific legacy route once using the same authorization, if explicitly enabled. */
export async function tidalSearch(
  query: string,
  limit: number,
  get: (endpoint: string, params: Record<string, string | number>) => Promise<unknown>,
  allowAlternate: boolean,
  unauthorized: (error: unknown) => boolean
): Promise<RecordData[]> {
  try {
    return tidalSearchItems(await get('search', { query, limit, types: 'TRACKS' }), limit)
  } catch (error) {
    if (!allowAlternate || !unauthorized(error)) throw error
    // Preserve the initial diagnostic if the alternate route is also unavailable.
    try {
      return tidalSearchItems(await get('search/tracks', { query, limit }), limit)
    } catch {
      throw error
    }
  }
}

export function matchingTidalAlbum(value: unknown, id: string): RecordData | undefined {
  const album = record(value)
  return /^\d+$/.test(id) && String(album?.id) === id ? album : undefined
}
