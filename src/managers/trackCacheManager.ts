import type { NodelinkConfig } from '../typings/config/config.types.ts'
import BaseCacheManager from './baseCacheManager.ts'

const TRACK_CACHE_SALT = 'nodelink-track-salt'
const DEFAULT_CACHE_FILE = './.cache/tracks.bin'
const DEFAULT_SAVE_DELAY_MS = 5000
const DEFAULT_TTL_MS = 1000 * 60 * 60 * 6
const DEFAULT_MAX_ENTRIES = 5000
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000

type TrackCacheContext = {
  options: NodelinkConfig
}

const _isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Encrypted cache for resolved track metadata and URLs.
 * @remarks Uses AES-256-GCM and purges expired entries on load and access.
 * @example
 * ```ts
 * const cache = new TrackCacheManager(nodelink)
 * await cache.load()
 * cache.set('youtube', 'id', { url: '...' })
 * const cached = cache.get('youtube', 'id')
 * ```
 * @public
 */
export default class TrackCacheManager extends BaseCacheManager<unknown> {
  private readonly nodelink: TrackCacheContext

  /**
   * Creates a new track cache manager instance.
   * @param nodelink - NodeLink runtime context.
   */
  constructor(nodelink: TrackCacheContext) {
    const password = TrackCacheManager._resolvePassword(nodelink.options)
    const cacheOptions = TrackCacheManager._resolveCacheOptions(
      nodelink.options
    )

    super({
      name: 'TrackCache',
      passwordHashKey: password,
      salt: TRACK_CACHE_SALT,
      filePath: DEFAULT_CACHE_FILE,
      saveDelayMs: DEFAULT_SAVE_DELAY_MS,
      cleanupIntervalMs: cacheOptions.cleanupIntervalMs,
      maxEntries: cacheOptions.maxEntries,
      diskCacheEnabled: nodelink.options.cache?.diskEnabled ?? true
    })

    this.nodelink = nodelink
  }

  /**
   * Retrieves a cached value by source/identifier.
   * @param source - Source name (e.g., "youtube").
   * @param identifier - Track identifier.
   */
  get<T = unknown>(source: string, identifier: string): T | null {
    const key = `${source}:${identifier}`
    const entry = this._getValidEntry(key)
    return entry ? (entry.value as T) : null
  }

  /**
   * Stores a cached value with a TTL.
   * @param source - Source name (e.g., "youtube").
   * @param identifier - Track identifier.
   * @param value - Cached payload.
   * @param ttlMs - Time-to-live in milliseconds.
   */
  set<T = unknown>(
    source: string,
    identifier: string,
    value: T,
    ttlMs: number = DEFAULT_TTL_MS
  ): void {
    const key = `${source}:${identifier}`
    const now = Date.now()

    this.cache.set(key, {
      value,
      createdAt: now,
      updatedAt: now,
      expiresAt: ttlMs > 0 ? now + ttlMs : null
    })

    this._enforceMaxEntries()
    this.save()
  }

  /**
   * Deletes a cached value by source/identifier.
   * @param source - Source name (e.g., "youtube").
   * @param identifier - Track identifier.
   */
  delete(source: string, identifier: string): boolean {
    const key = `${source}:${identifier}`
    const deleted = this.cache.delete(key)
    if (deleted) this.save()
    return deleted
  }

  private static _resolveCacheOptions(options: NodelinkConfig): {
    maxEntries: number
    cleanupIntervalMs: number
  } {
    const playback = options.playback

    const maxEntriesRaw = playback.maxPlaylistLength
    const cleanupIntervalRaw = playback.statsUpdateInterval

    const maxEntries =
      typeof maxEntriesRaw === 'number' && Number.isFinite(maxEntriesRaw)
        ? Math.max(100, Math.floor(maxEntriesRaw))
        : DEFAULT_MAX_ENTRIES
    const cleanupIntervalMs =
      typeof cleanupIntervalRaw === 'number' &&
      Number.isFinite(cleanupIntervalRaw)
        ? Math.max(1000, Math.floor(cleanupIntervalRaw))
        : DEFAULT_CLEANUP_INTERVAL_MS

    return { maxEntries, cleanupIntervalMs }
  }

  private static _resolvePassword(options: NodelinkConfig): string {
    const password = options.server?.password
    if (!password) {
      throw new Error('TrackCacheManager requires options.server.password')
    }
    return password
  }
}
