import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { logger } from '../utils.js';
const DEFAULT_DATABASE_PATH = './.cache/cache.db';
const DEFAULT_MAX_HOT_ENTRIES = 250;
let sharedDatabase = null;
function getSharedDatabase(dbPath) {
    if (!sharedDatabase) {
        const resolvedPath = path.resolve(process.cwd(), dbPath);
        fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
        sharedDatabase = new DatabaseSync(resolvedPath);
        sharedDatabase.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA temp_store = MEMORY;
    `);
    }
    return sharedDatabase;
}
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const getErrorMessage = (error) => error instanceof Error ? error.message : String(error ?? 'Unknown error');
/**
 * High-performance, multi-tier cache manager using an in-memory Hot Cache (LRU)
 * backed by native SQLite on disk with WAL mode and automatic legacy .bin migration.
 */
export default class BaseCacheManager {
    cacheName;
    tableName;
    passwordHashKey;
    salt;
    key;
    legacyKey;
    filePath;
    cleanupIntervalMs;
    maxEntries;
    maxHotEntries;
    version;
    diskCacheEnabled;
    cache;
    cleanupInterval;
    lastLoadedAt;
    lastSavedAt;
    db = null;
    stmtGet = null;
    stmtSet = null;
    stmtDelete = null;
    stmtPurgeExpired = null;
    stmtPurgeExcess = null;
    stmtClear = null;
    stmtRecent = null;
    stmtCount = null;
    constructor(options) {
        this.cacheName = options.name;
        this.tableName = `${options.name.toLowerCase().replace(/[^a-z0-9_]/g, '_')}_cache`;
        this.passwordHashKey = options.passwordHashKey;
        this.salt = options.salt;
        this.filePath = options.filePath;
        this.cleanupIntervalMs = options.cleanupIntervalMs ?? 60000;
        this.maxEntries = options.maxEntries ?? 0;
        this.maxHotEntries = options.maxHotEntries ?? DEFAULT_MAX_HOT_ENTRIES;
        this.version = options.version ?? 1;
        this.diskCacheEnabled = options.diskCacheEnabled ?? true;
        this.key = this._deriveFastKey(this.passwordHashKey);
        this.legacyKey = null;
        this.cache = new Map();
        this.lastLoadedAt = null;
        this.lastSavedAt = null;
        if (this.diskCacheEnabled) {
            this._initDatabase();
        }
        this.cleanupInterval = setInterval(() => {
            this._purgeExpired();
            this._enforceMaxEntries();
        }, this.cleanupIntervalMs);
        this.cleanupInterval.unref?.();
    }
    _initDatabase() {
        try {
            this.db = getSharedDatabase(DEFAULT_DATABASE_PATH);
            this.db.exec(`
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          expires_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_${this.tableName}_expires ON ${this.tableName}(expires_at);
        CREATE INDEX IF NOT EXISTS idx_${this.tableName}_updated ON ${this.tableName}(updated_at);
      `);
            this.stmtGet = this.db.prepare(`SELECT value, created_at, updated_at, expires_at FROM ${this.tableName} WHERE key = ?`);
            this.stmtSet = this.db.prepare(`INSERT OR REPLACE INTO ${this.tableName} (key, value, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?)`);
            this.stmtDelete = this.db.prepare(`DELETE FROM ${this.tableName} WHERE key = ?`);
            this.stmtPurgeExpired = this.db.prepare(`DELETE FROM ${this.tableName} WHERE expires_at IS NOT NULL AND expires_at <= ?`);
            this.stmtClear = this.db.prepare(`DELETE FROM ${this.tableName}`);
            this.stmtRecent = this.db.prepare(`SELECT key, value, created_at, updated_at, expires_at FROM ${this.tableName} WHERE expires_at IS NULL OR expires_at > ? ORDER BY updated_at DESC LIMIT ?`);
            this.stmtCount = this.db.prepare(`SELECT COUNT(*) as count FROM ${this.tableName}`);
        }
        catch (error) {
            logger('error', this.cacheName, `Failed to initialize SQLite database: ${getErrorMessage(error)}`);
            this.db = null;
        }
    }
    async load() {
        if (!this.diskCacheEnabled)
            return;
        if (fs.existsSync(this.filePath)) {
            await this._migrateLegacyFile();
        }
        this._preloadHotEntries();
        this.lastLoadedAt = Date.now();
        logger('debug', this.cacheName, `Initialized cache with ${this.cache.size} hot entries in RAM.`);
    }
    async _migrateLegacyFile() {
        try {
            const data = await fsPromises.readFile(this.filePath);
            if (data.length < 32)
                return;
            let payload;
            try {
                payload = this._decodePayload(data, this.key);
            }
            catch {
                const legacyKey = this._getLegacyKey();
                payload = this._decodePayload(data, legacyKey);
            }
            const entries = Object.entries(payload.entries);
            if (entries.length > 0 && this.db && this.stmtSet) {
                logger('info', this.cacheName, `Migrating ${entries.length} entries from legacy ${this.filePath} to SQLite...`);
                this.db.exec('BEGIN IMMEDIATE');
                try {
                    const now = Date.now();
                    let migrated = 0;
                    for (const [key, entry] of entries) {
                        if (entry.expiresAt && entry.expiresAt <= now)
                            continue;
                        this.stmtSet.run(key, JSON.stringify(entry.value), entry.createdAt, entry.updatedAt, entry.expiresAt);
                        migrated++;
                    }
                    this.db.exec('COMMIT');
                    logger('info', this.cacheName, `Successfully migrated ${migrated} entries to SQLite.`);
                }
                catch (txError) {
                    this.db.exec('ROLLBACK');
                    throw txError;
                }
            }
            try {
                await fsPromises.unlink(this.filePath);
            }
            catch { }
        }
        catch (error) {
            logger('error', this.cacheName, `Failed to migrate legacy cache ${this.filePath}: ${getErrorMessage(error)}`);
        }
    }
    _preloadHotEntries() {
        if (!this.stmtRecent)
            return;
        const now = Date.now();
        const rows = this.stmtRecent.all(now, this.maxHotEntries);
        for (let i = rows.length - 1; i >= 0; i--) {
            const row = rows[i];
            if (!row)
                continue;
            try {
                const parsed = JSON.parse(row.value);
                this.cache.set(row.key, {
                    value: parsed,
                    createdAt: row.created_at,
                    updatedAt: row.updated_at,
                    expiresAt: row.expires_at
                });
            }
            catch { }
        }
    }
    save() {
        this.lastSavedAt = Date.now();
    }
    async forceSave() {
        this._purgeExpired();
        this._enforceMaxEntries();
        this.lastSavedAt = Date.now();
    }
    clear() {
        this.cache.clear();
        if (this.stmtClear) {
            try {
                this.stmtClear.run();
            }
            catch (error) {
                logger('error', this.cacheName, `Clear failed: ${getErrorMessage(error)}`);
            }
        }
        this.save();
    }
    destroy() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        this.cache.clear();
    }
    _getValidEntry(key) {
        const hot = this.cache.get(key);
        if (hot) {
            if (hot.expiresAt && Date.now() > hot.expiresAt) {
                this.cache.delete(key);
                this.stmtDelete?.run(key);
                return null;
            }
            this.cache.delete(key);
            this.cache.set(key, hot);
            return hot;
        }
        if (!this.stmtGet)
            return null;
        try {
            const row = this.stmtGet.get(key);
            if (!row)
                return null;
            const now = Date.now();
            if (row.expires_at && now > row.expires_at) {
                this.stmtDelete?.run(key);
                return null;
            }
            const parsed = JSON.parse(row.value);
            const entry = {
                value: parsed,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                expiresAt: row.expires_at
            };
            this._insertHotCache(key, entry);
            return entry;
        }
        catch {
            return null;
        }
    }
    _setEntry(key, value, ttlMs) {
        const now = Date.now();
        const expiresAt = typeof ttlMs === 'number' && ttlMs > 0 ? now + ttlMs : null;
        const hot = this.cache.get(key);
        const entry = {
            value: value,
            createdAt: hot?.createdAt ?? now,
            updatedAt: now,
            expiresAt
        };
        this._insertHotCache(key, entry);
        if (this.stmtSet) {
            try {
                this.stmtSet.run(key, JSON.stringify(value), entry.createdAt, entry.updatedAt, entry.expiresAt);
            }
            catch (error) {
                logger('error', this.cacheName, `SQLite set failed: ${getErrorMessage(error)}`);
            }
        }
        this.save();
    }
    _deleteEntry(key) {
        const inHot = this.cache.delete(key);
        let inDb = false;
        if (this.stmtDelete) {
            try {
                const info = this.stmtDelete.run(key);
                inDb = Number(info.changes) > 0;
            }
            catch (error) {
                logger('error', this.cacheName, `SQLite delete failed: ${getErrorMessage(error)}`);
            }
        }
        if (inHot || inDb)
            this.save();
        return inHot || inDb;
    }
    _insertHotCache(key, entry) {
        if (this.cache.size >= this.maxHotEntries && !this.cache.has(key)) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey !== undefined)
                this.cache.delete(oldestKey);
        }
        this.cache.set(key, entry);
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
        if (this.stmtPurgeExpired) {
            try {
                const info = this.stmtPurgeExpired.run(now);
                expiredCount += Number(info.changes);
            }
            catch (error) {
                logger('error', this.cacheName, `Purge expired failed: ${getErrorMessage(error)}`);
            }
        }
        return expiredCount;
    }
    _enforceMaxEntries() {
        if (this.maxEntries <= 0 || !this.db)
            return 0;
        try {
            if (!this.stmtPurgeExcess) {
                this.stmtPurgeExcess = this.db.prepare(`
          DELETE FROM ${this.tableName} WHERE key NOT IN (
            SELECT key FROM ${this.tableName} ORDER BY updated_at DESC LIMIT ?
          )
        `);
            }
            const info = this.stmtPurgeExcess.run(this.maxEntries);
            return Number(info.changes);
        }
        catch {
            return 0;
        }
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
}
