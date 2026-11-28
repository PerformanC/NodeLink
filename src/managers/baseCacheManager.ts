import crypto from 'node:crypto'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { logger } from '../utils.ts'

export type BaseCacheEntry<T> = {
  value: T
  createdAt: number
  updatedAt: number
  expiresAt: number | null
}

export type BaseCachePayload<T> = {
  version: number
  savedAt: number
  entries: Record<string, BaseCacheEntry<T>>
}

export interface BaseCacheOptions {
  name: string
  passwordHashKey: string
  salt: string
  filePath: string
  saveDelayMs?: number
  cleanupIntervalMs?: number
  maxEntries?: number
  version?: number
  diskCacheEnabled?: boolean
  maxHotEntries?: number
}

const DEFAULT_DATABASE_PATH = './.cache/cache.db'
const DEFAULT_MAX_HOT_ENTRIES = 250

let sharedDatabase: DatabaseSync | null = null

function getSharedDatabase(dbPath: string): DatabaseSync {
  if (!sharedDatabase) {
    const resolvedPath = path.resolve(process.cwd(), dbPath)
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })
    sharedDatabase = new DatabaseSync(resolvedPath)
    sharedDatabase.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA temp_store = MEMORY;
    `)
  }
  return sharedDatabase
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error ?? 'Unknown error')

/**
 * High-performance, multi-tier cache manager using an in-memory Hot Cache (LRU)
 * backed by native SQLite on disk with WAL mode and automatic legacy .bin migration.
 */
export default abstract class BaseCacheManager<T = unknown> {
  protected readonly cacheName: string
  protected readonly tableName: string
  private readonly passwordHashKey: string
  private readonly salt: string
  private key: Buffer
  private legacyKey: Buffer | null
  protected readonly filePath: string
  protected readonly cleanupIntervalMs: number
  protected readonly maxEntries: number
  protected readonly maxHotEntries: number
  protected readonly version: number
  protected readonly diskCacheEnabled: boolean

  protected cache: Map<string, BaseCacheEntry<T>>
  private cleanupInterval: NodeJS.Timeout | null

  protected lastLoadedAt: number | null
  protected lastSavedAt: number | null

  private db: DatabaseSync | null = null
  private stmtGet: StatementSync | null = null
  private stmtSet: StatementSync | null = null
  private stmtDelete: StatementSync | null = null
  private stmtPurgeExpired: StatementSync | null = null
  private stmtPurgeExcess: StatementSync | null = null
  private stmtClear: StatementSync | null = null
  private stmtRecent: StatementSync | null = null
  private stmtCount: StatementSync | null = null

  constructor(options: BaseCacheOptions) {
    this.cacheName = options.name
    this.tableName = `${options.name.toLowerCase().replace(/[^a-z0-9_]/g, '_')}_cache`
    this.passwordHashKey = options.passwordHashKey
    this.salt = options.salt
    this.filePath = options.filePath
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 60000
    this.maxEntries = options.maxEntries ?? 0
    this.maxHotEntries = options.maxHotEntries ?? DEFAULT_MAX_HOT_ENTRIES
    this.version = options.version ?? 1
    this.diskCacheEnabled = options.diskCacheEnabled ?? true

    this.key = this._deriveFastKey(this.passwordHashKey)
    this.legacyKey = null
    this.cache = new Map()

    this.lastLoadedAt = null
    this.lastSavedAt = null

    if (this.diskCacheEnabled) {
      this._initDatabase()
    }

    this.cleanupInterval = setInterval(() => {
      this._purgeExpired()
      this._enforceMaxEntries()
    }, this.cleanupIntervalMs)
    this.cleanupInterval.unref?.()
  }

  private _initDatabase(): void {
    try {
      this.db = getSharedDatabase(DEFAULT_DATABASE_PATH)
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
      `)

      this.stmtGet = this.db.prepare(
        `SELECT value, created_at, updated_at, expires_at FROM ${this.tableName} WHERE key = ?`
      )
      this.stmtSet = this.db.prepare(
        `INSERT OR REPLACE INTO ${this.tableName} (key, value, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?)`
      )
      this.stmtDelete = this.db.prepare(
        `DELETE FROM ${this.tableName} WHERE key = ?`
      )
      this.stmtPurgeExpired = this.db.prepare(
        `DELETE FROM ${this.tableName} WHERE expires_at IS NOT NULL AND expires_at <= ?`
      )
      this.stmtClear = this.db.prepare(`DELETE FROM ${this.tableName}`)
      this.stmtRecent = this.db.prepare(
        `SELECT key, value, created_at, updated_at, expires_at FROM ${this.tableName} WHERE expires_at IS NULL OR expires_at > ? ORDER BY updated_at DESC LIMIT ?`
      )
      this.stmtCount = this.db.prepare(
        `SELECT COUNT(*) as count FROM ${this.tableName}`
      )
    } catch (error) {
      logger(
        'error',
        this.cacheName,
        `Failed to initialize SQLite database: ${getErrorMessage(error)}`
      )
      this.db = null
    }
  }

  async load(): Promise<void> {
    if (!this.diskCacheEnabled) return

    if (fs.existsSync(this.filePath)) {
      await this._migrateLegacyFile()
    }

    this._preloadHotEntries()
    this.lastLoadedAt = Date.now()
    logger(
      'debug',
      this.cacheName,
      `Initialized cache with ${this.cache.size} hot entries in RAM.`
    )
  }

  private async _migrateLegacyFile(): Promise<void> {
    try {
      const data = await fsPromises.readFile(this.filePath)
      if (data.length < 32) return

      let payload: BaseCachePayload<T>
      try {
        payload = this._decodePayload(data, this.key)
      } catch {
        const legacyKey = this._getLegacyKey()
        payload = this._decodePayload(data, legacyKey)
      }

      const entries = Object.entries(payload.entries)
      if (entries.length > 0 && this.db && this.stmtSet) {
        logger(
          'info',
          this.cacheName,
          `Migrating ${entries.length} entries from legacy ${this.filePath} to SQLite...`
        )

        this.db.exec('BEGIN IMMEDIATE')
        try {
          const now = Date.now()
          let migrated = 0
          for (const [key, entry] of entries) {
            if (entry.expiresAt && entry.expiresAt <= now) continue
            this.stmtSet.run(
              key,
              JSON.stringify(entry.value),
              entry.createdAt,
              entry.updatedAt,
              entry.expiresAt
            )
            migrated++
          }
          this.db.exec('COMMIT')
          logger(
            'info',
            this.cacheName,
            `Successfully migrated ${migrated} entries to SQLite.`
          )
        } catch (txError) {
          this.db.exec('ROLLBACK')
          throw txError
        }
      }

      try {
        await fsPromises.unlink(this.filePath)
      } catch {}
    } catch (error) {
      logger(
        'error',
        this.cacheName,
        `Failed to migrate legacy cache ${this.filePath}: ${getErrorMessage(error)}`
      )
    }
  }

  private _preloadHotEntries(): void {
    if (!this.stmtRecent) return
    const now = Date.now()
    const rows = this.stmtRecent.all(now, this.maxHotEntries) as Array<{
      key: string
      value: string
      created_at: number
      updated_at: number
      expires_at: number | null
    }>

    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]
      if (!row) continue
      try {
        const parsed = JSON.parse(row.value) as T
        this.cache.set(row.key, {
          value: parsed,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          expiresAt: row.expires_at
        })
      } catch {}
    }
  }

  save(): void {
    this.lastSavedAt = Date.now()
  }

  async forceSave(): Promise<void> {
    this._purgeExpired()
    this._enforceMaxEntries()
    this.lastSavedAt = Date.now()
  }

  clear(): void {
    this.cache.clear()
    if (this.stmtClear) {
      try {
        this.stmtClear.run()
      } catch (error) {
        logger(
          'error',
          this.cacheName,
          `Clear failed: ${getErrorMessage(error)}`
        )
      }
    }
    this.save()
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    this.cache.clear()
  }

  protected _getValidEntry(key: string): BaseCacheEntry<T> | null {
    const hot = this.cache.get(key)
    if (hot) {
      if (hot.expiresAt && Date.now() > hot.expiresAt) {
        this.cache.delete(key)
        this.stmtDelete?.run(key)
        return null
      }
      this.cache.delete(key)
      this.cache.set(key, hot)
      return hot
    }

    if (!this.stmtGet) return null

    try {
      const row = this.stmtGet.get(key) as
        | {
            value: string
            created_at: number
            updated_at: number
            expires_at: number | null
          }
        | undefined

      if (!row) return null

      const now = Date.now()
      if (row.expires_at && now > row.expires_at) {
        this.stmtDelete?.run(key)
        return null
      }

      const parsed = JSON.parse(row.value) as T
      const entry: BaseCacheEntry<T> = {
        value: parsed,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        expiresAt: row.expires_at
      }

      this._insertHotCache(key, entry)
      return entry
    } catch {
      return null
    }
  }

  protected _setEntry(key: string, value: unknown, ttlMs?: number): void {
    const now = Date.now()
    const expiresAt =
      typeof ttlMs === 'number' && ttlMs > 0 ? now + ttlMs : null
    const hot = this.cache.get(key)

    const entry: BaseCacheEntry<T> = {
      value: value as T,
      createdAt: hot?.createdAt ?? now,
      updatedAt: now,
      expiresAt
    }

    this._insertHotCache(key, entry)

    if (this.stmtSet) {
      try {
        this.stmtSet.run(
          key,
          JSON.stringify(value),
          entry.createdAt,
          entry.updatedAt,
          entry.expiresAt
        )
      } catch (error) {
        logger(
          'error',
          this.cacheName,
          `SQLite set failed: ${getErrorMessage(error)}`
        )
      }
    }
    this.save()
  }

  protected _deleteEntry(key: string): boolean {
    const inHot = this.cache.delete(key)
    let inDb = false

    if (this.stmtDelete) {
      try {
        const info = this.stmtDelete.run(key)
        inDb = Number(info.changes) > 0
      } catch (error) {
        logger(
          'error',
          this.cacheName,
          `SQLite delete failed: ${getErrorMessage(error)}`
        )
      }
    }

    if (inHot || inDb) this.save()
    return inHot || inDb
  }

  private _insertHotCache(key: string, entry: BaseCacheEntry<T>): void {
    if (this.cache.size >= this.maxHotEntries && !this.cache.has(key)) {
      const oldestKey = this.cache.keys().next().value
      if (oldestKey !== undefined) this.cache.delete(oldestKey)
    }
    this.cache.set(key, entry)
  }

  protected _purgeExpired(): number {
    const now = Date.now()
    let expiredCount = 0

    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt && now > entry.expiresAt) {
        this.cache.delete(key)
        expiredCount++
      }
    }

    if (this.stmtPurgeExpired) {
      try {
        const info = this.stmtPurgeExpired.run(now)
        expiredCount += Number(info.changes)
      } catch (error) {
        logger(
          'error',
          this.cacheName,
          `Purge expired failed: ${getErrorMessage(error)}`
        )
      }
    }

    return expiredCount
  }

  protected _enforceMaxEntries(): number {
    if (this.maxEntries <= 0 || !this.db) return 0

    try {
      if (!this.stmtPurgeExcess) {
        this.stmtPurgeExcess = this.db.prepare(`
          DELETE FROM ${this.tableName} WHERE key NOT IN (
            SELECT key FROM ${this.tableName} ORDER BY updated_at DESC LIMIT ?
          )
        `)
      }
      const info = this.stmtPurgeExcess.run(this.maxEntries)
      return Number(info.changes)
    } catch {
      return 0
    }
  }

  private _deriveFastKey(password: string): Buffer {
    return crypto
      .createHash('sha256')
      .update(`${this.salt}:${password}`)
      .digest()
  }

  private _getLegacyKey(): Buffer {
    if (!this.legacyKey) {
      this.legacyKey = crypto.scryptSync(this.passwordHashKey, this.salt, 32)
    }
    return this.legacyKey
  }

  private _decodePayload(data: Buffer, key: Buffer): BaseCachePayload<T> {
    const iv = data.subarray(0, 16)
    const tag = data.subarray(16, 32)
    const encrypted = data.subarray(32)

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]).toString('utf8')
    const parsed = JSON.parse(decrypted) as unknown
    return this._normalizePayload(parsed)
  }

  private _normalizePayload(raw: unknown): BaseCachePayload<T> {
    const now = Date.now()

    if (isRecord(raw) && !('version' in raw) && !('entries' in raw)) {
      return {
        version: this.version,
        savedAt: now,
        entries: this._normalizeEntries(raw, now)
      }
    }

    if (isRecord(raw)) {
      const payloadCandidate = raw as Partial<BaseCachePayload<T>> & {
        entries?: unknown
        savedAt?: unknown
      }
      const entriesValue = payloadCandidate.entries
      if (isRecord(entriesValue)) {
        return {
          version: payloadCandidate.version ?? this.version,
          savedAt:
            typeof payloadCandidate.savedAt === 'number'
              ? payloadCandidate.savedAt
              : now,
          entries: this._normalizeEntries(entriesValue, now)
        }
      }
    }

    return {
      version: this.version,
      savedAt: now,
      entries: {}
    }
  }

  private _normalizeEntries(
    rawEntries: Record<string, unknown>,
    fallbackTime: number
  ): Record<string, BaseCacheEntry<T>> {
    const entries: Record<string, BaseCacheEntry<T>> = {}
    for (const [key, value] of Object.entries(rawEntries)) {
      entries[key] = this._normalizeEntry(value, fallbackTime)
    }
    return entries
  }

  private _normalizeEntry(
    rawValue: unknown,
    fallbackTime: number
  ): BaseCacheEntry<T> {
    if (isRecord(rawValue)) {
      const entryCandidate = rawValue as Partial<BaseCacheEntry<T>> & {
        value?: unknown
      }
      const value = Object.hasOwn(entryCandidate, 'value')
        ? entryCandidate.value
        : rawValue

      const createdAt =
        typeof entryCandidate.createdAt === 'number'
          ? entryCandidate.createdAt
          : fallbackTime
      const updatedAt =
        typeof entryCandidate.updatedAt === 'number'
          ? entryCandidate.updatedAt
          : createdAt
      const expiresAt =
        typeof entryCandidate.expiresAt === 'number' &&
        entryCandidate.expiresAt > 0
          ? entryCandidate.expiresAt
          : null

      return {
        value: value as T,
        createdAt,
        updatedAt,
        expiresAt
      }
    }

    return {
      value: rawValue as T,
      createdAt: fallbackTime,
      updatedAt: fallbackTime,
      expiresAt: null
    }
  }
}
