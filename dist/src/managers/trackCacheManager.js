import BaseCacheManager from './baseCacheManager.js';
const TRACK_CACHE_SALT = 'nodelink-track-salt';
const DEFAULT_CACHE_FILE = './.cache/tracks.bin';
const DEFAULT_SAVE_DELAY_MS = 5000;
const DEFAULT_TTL_MS = 1000 * 60 * 60 * 6;
const DEFAULT_MAX_ENTRIES = 5000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000;
const _isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
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
export default class TrackCacheManager extends BaseCacheManager {
    nodelink;
    /**
     * Creates a new track cache manager instance.
     * @param nodelink - NodeLink runtime context.
     */
    constructor(nodelink) {
        const password = TrackCacheManager._resolvePassword(nodelink.options);
        const cacheOptions = TrackCacheManager._resolveCacheOptions(nodelink.options);
        super({
            name: 'TrackCache',
            passwordHashKey: password,
            salt: TRACK_CACHE_SALT,
            filePath: DEFAULT_CACHE_FILE,
            saveDelayMs: DEFAULT_SAVE_DELAY_MS,
            cleanupIntervalMs: cacheOptions.cleanupIntervalMs,
            maxEntries: cacheOptions.maxEntries,
            diskCacheEnabled: nodelink.options.cache?.diskEnabled ?? true
        });
        this.nodelink = nodelink;
    }
    /**
     * Retrieves a cached value by source/identifier.
     * @param source - Source name (e.g., "youtube").
     * @param identifier - Track identifier.
     */
    get(source, identifier) {
        const key = `${source}:${identifier}`;
        const entry = this._getValidEntry(key);
        return entry ? entry.value : null;
    }
    /**
     * Stores a cached value with a TTL.
     * @param source - Source name (e.g., "youtube").
     * @param identifier - Track identifier.
     * @param value - Cached payload.
     * @param ttlMs - Time-to-live in milliseconds.
     */
    set(source, identifier, value, ttlMs = DEFAULT_TTL_MS) {
        const key = `${source}:${identifier}`;
        const now = Date.now();
        this.cache.set(key, {
            value,
            createdAt: now,
            updatedAt: now,
            expiresAt: ttlMs > 0 ? now + ttlMs : null
        });
        this._enforceMaxEntries();
        this.save();
    }
    /**
     * Deletes a cached value by source/identifier.
     * @param source - Source name (e.g., "youtube").
     * @param identifier - Track identifier.
     */
    delete(source, identifier) {
        const key = `${source}:${identifier}`;
        const deleted = this.cache.delete(key);
        if (deleted)
            this.save();
        return deleted;
    }
    static _resolveCacheOptions(options) {
        const playback = options.playback;
        const maxEntriesRaw = playback.maxPlaylistLength;
        const cleanupIntervalRaw = playback.statsUpdateInterval;
        const maxEntries = typeof maxEntriesRaw === 'number' && Number.isFinite(maxEntriesRaw)
            ? Math.max(100, Math.floor(maxEntriesRaw))
            : DEFAULT_MAX_ENTRIES;
        const cleanupIntervalMs = typeof cleanupIntervalRaw === 'number' &&
            Number.isFinite(cleanupIntervalRaw)
            ? Math.max(1000, Math.floor(cleanupIntervalRaw))
            : DEFAULT_CLEANUP_INTERVAL_MS;
        return { maxEntries, cleanupIntervalMs };
    }
    static _resolvePassword(options) {
        const password = options.server?.password;
        if (!password) {
            throw new Error('TrackCacheManager requires options.server.password');
        }
        return password;
    }
}
