import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { logger } from '../utils.js';
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const getErrorMessage = (error) => error instanceof Error ? error.message : String(error ?? 'Unknown error');
const getErrorCode = (error) => {
    if (!error || typeof error !== 'object' || !('code' in error)) {
        return undefined;
    }
    const code = error.code;
    return typeof code === 'string' ? code : undefined;
};
/**
 * Generic encrypted cache file store using AES-256-GCM.
 * Handles atomic saves, TTL purging, and max entry eviction.
 */
export default class BaseCacheManager {
    cacheName;
    passwordHashKey;
    salt;
    key;
    legacyKey;
    filePath;
    tempFilePath;
    saveDelayMs;
    cleanupIntervalMs;
    maxEntries;
    version;
    diskCacheEnabled;
    cache;
    saveTimeout;
    cleanupInterval;
    savePromise;
    saveQueued;
    lastLoadedAt;
    lastSavedAt;
    constructor(options) {
        this.cacheName = options.name;
        this.passwordHashKey = options.passwordHashKey;
        this.salt = options.salt;
        this.filePath = options.filePath;
        this.tempFilePath = `${options.filePath}.tmp`;
        this.saveDelayMs = options.saveDelayMs ?? 5000;
        this.cleanupIntervalMs = options.cleanupIntervalMs ?? 60000;
        this.maxEntries = options.maxEntries ?? 0;
        this.version = options.version ?? 1;
        this.diskCacheEnabled = options.diskCacheEnabled ?? true;
        this.key = this._deriveFastKey(this.passwordHashKey);
        this.legacyKey = null;
        this.cache = new Map();
        this.saveTimeout = null;
        this.savePromise = null;
        this.saveQueued = false;
        this.lastLoadedAt = null;
        this.lastSavedAt = null;
        this.cleanupInterval = setInterval(() => {
            const expiredCount = this._purgeExpired();
            const evictedCount = this._enforceMaxEntries();
            if (expiredCount > 0 || evictedCount > 0)
                this.save();
        }, this.cleanupIntervalMs);
        this.cleanupInterval.unref?.();
    }
    async load() {
        if (!this.diskCacheEnabled)
            return;
        try {
            const data = await fs.readFile(this.filePath);
            if (data.length < 32)
                return;
            let payload;
            let migratedFromLegacy = false;
            try {
                payload = this._decodePayload(data, this.key);
            }
            catch {
                const legacyKey = this._getLegacyKey();
                payload = this._decodePayload(data, legacyKey);
                migratedFromLegacy = true;
            }
            this.cache = new Map(Object.entries(payload.entries));
            const expiredCount = this._purgeExpired();
            const evictedCount = this._enforceMaxEntries();
            if (expiredCount > 0 || evictedCount > 0 || migratedFromLegacy)
                this.save();
            this.lastLoadedAt = Date.now();
            logger('debug', this.cacheName, `Loaded ${this.cache.size} entries from disk.`);
        }
        catch (error) {
            const code = getErrorCode(error);
            if (code !== 'ENOENT') {
                logger('error', this.cacheName, `Failed to load cache: ${getErrorMessage(error)}`);
            }
            this.cache = new Map();
        }
    }
    save() {
        if (this.saveTimeout)
            return;
        this.saveTimeout = setTimeout(() => {
            this.saveTimeout = null;
            void this.forceSave();
        }, this.saveDelayMs);
    }
    async forceSave() {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
            this.saveTimeout = null;
        }
        try {
            this._purgeExpired();
            this._enforceMaxEntries();
            await this._flushSaveQueue();
            logger('debug', this.cacheName, 'Force saved to disk.');
        }
        catch (error) {
            logger('error', this.cacheName, `Failed to force save: ${getErrorMessage(error)}`);
        }
    }
    clear() {
        if (this.cache.size === 0)
            return;
        this.cache.clear();
        this.save();
    }
    /**
     * Cleans up internal timers and resources.
     */
    destroy() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
            this.saveTimeout = null;
        }
    }
    _getValidEntry(key) {
        const entry = this.cache.get(key);
        if (!entry)
            return null;
        if (entry.expiresAt && Date.now() > entry.expiresAt) {
            this.cache.delete(key);
            this.save();
            return null;
        }
        if (this.maxEntries > 0) {
            this.cache.delete(key);
            this.cache.set(key, entry);
        }
        return entry;
    }
    _deriveFastKey(password) {
        return crypto
            .createHash('sha256')
            .update(`${this.salt}:${password}`)
            .digest();
    }
    _getLegacyKey() {
        if (!this.legacyKey) {
            this.legacyKey = crypto.scryptSync(this.passwordHashKey, this.salt, 32);
        }
        return this.legacyKey;
    }
    _purgeExpired() {
        const now = Date.now();
        let expiredCount = 0;
        for (const [key, entry] of this.cache.entries()) {
            if (entry.expiresAt && now > entry.expiresAt) {
                this.cache.delete(key);
                expiredCount++;
            }
        }
        return expiredCount;
    }
    _enforceMaxEntries() {
        if (this.maxEntries <= 0 || this.cache.size <= this.maxEntries)
            return 0;
        let removed = 0;
        while (this.cache.size > this.maxEntries) {
            const oldestKey = this.cache.keys().next().value;
            if (!oldestKey)
                break;
            this.cache.delete(oldestKey);
            removed++;
        }
        return removed;
    }
    _decodePayload(data, key) {
        const iv = data.subarray(0, 16);
        const tag = data.subarray(16, 32);
        const encrypted = data.subarray(32);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        const decrypted = Buffer.concat([
            decipher.update(encrypted),
            decipher.final()
        ]).toString('utf8');
        const parsed = JSON.parse(decrypted);
        return this._normalizePayload(parsed);
    }
    _normalizePayload(raw) {
        const now = Date.now();
        if (isRecord(raw) && !('version' in raw) && !('entries' in raw)) {
            return {
                version: this.version,
                savedAt: now,
                entries: this._normalizeEntries(raw, now)
            };
        }
        if (isRecord(raw)) {
            const payloadCandidate = raw;
            const entriesValue = payloadCandidate.entries;
            if (isRecord(entriesValue)) {
                return {
                    version: payloadCandidate.version ?? this.version,
                    savedAt: typeof payloadCandidate.savedAt === 'number'
                        ? payloadCandidate.savedAt
                        : now,
                    entries: this._normalizeEntries(entriesValue, now)
                };
            }
        }
        return {
            version: this.version,
            savedAt: now,
            entries: {}
        };
    }
    _normalizeEntries(rawEntries, fallbackTime) {
        const entries = {};
        for (const [key, value] of Object.entries(rawEntries)) {
            entries[key] = this._normalizeEntry(value, fallbackTime);
        }
        return entries;
    }
    _normalizeEntry(rawValue, fallbackTime) {
        if (isRecord(rawValue)) {
            const entryCandidate = rawValue;
            const value = Object.hasOwn(entryCandidate, 'value')
                ? entryCandidate.value
                : rawValue;
            const createdAt = typeof entryCandidate.createdAt === 'number'
                ? entryCandidate.createdAt
                : fallbackTime;
            const updatedAt = typeof entryCandidate.updatedAt === 'number'
                ? entryCandidate.updatedAt
                : createdAt;
            const expiresAt = typeof entryCandidate.expiresAt === 'number' &&
                entryCandidate.expiresAt > 0
                ? entryCandidate.expiresAt
                : null;
            return {
                value: value,
                createdAt,
                updatedAt,
                expiresAt
            };
        }
        return {
            value: rawValue,
            createdAt: fallbackTime,
            updatedAt: fallbackTime,
            expiresAt: null
        };
    }
    _buildPayload() {
        return {
            version: this.version,
            savedAt: Date.now(),
            entries: Object.fromEntries(this.cache)
        };
    }
    async _flushSaveQueue() {
        if (this.savePromise) {
            this.saveQueued = true;
            await this.savePromise;
            if (this.saveQueued) {
                this.saveQueued = false;
                await this._flushSaveQueue();
            }
            return;
        }
        const payload = this._buildPayload();
        this.savePromise = this._writeToDisk(payload);
        try {
            await this.savePromise;
        }
        finally {
            this.savePromise = null;
        }
        if (this.saveQueued) {
            this.saveQueued = false;
            await this._flushSaveQueue();
        }
    }
    async _writeToDisk(payload) {
        if (!this.diskCacheEnabled)
            return;
        const plainText = JSON.stringify(payload);
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
        const encrypted = Buffer.concat([
            cipher.update(plainText, 'utf8'),
            cipher.final()
        ]);
        const tag = cipher.getAuthTag();
        const outBuffer = Buffer.concat([iv, tag, encrypted]);
        await fs.mkdir('./.cache', { recursive: true });
        try {
            await fs.writeFile(this.tempFilePath, outBuffer);
            await fs.rename(this.tempFilePath, this.filePath);
        }
        catch (error) {
            logger('debug', this.cacheName, `Atomic save failed, falling back to direct write: ${getErrorMessage(error)}`);
            await fs.writeFile(this.filePath, outBuffer);
            try {
                await fs.unlink(this.tempFilePath);
            }
            catch (cleanupError) {
                logger('debug', this.cacheName, `Failed to remove temp cache file: ${getErrorMessage(cleanupError)}`);
            }
        }
        this.lastSavedAt = payload.savedAt;
    }
}
