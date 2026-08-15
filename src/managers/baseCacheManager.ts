import crypto from 'node:crypto'
import fs from 'node:fs/promises'
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
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error ?? 'Unknown error')

const getErrorCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined
  }
  const code = (error as NodeJS.ErrnoException).code
  return typeof code === 'string' ? code : undefined
}

/**
 * Generic encrypted cache file store using AES-256-GCM.
 * Handles atomic saves, TTL purging, and max entry eviction.
 */
export default abstract class BaseCacheManager<T = unknown> {
  protected readonly cacheName: string
  private readonly passwordHashKey: string
  private readonly salt: string
  private key: Buffer
  private legacyKey: Buffer | null
  protected readonly filePath: string
  protected readonly tempFilePath: string
  protected readonly saveDelayMs: number
  protected readonly cleanupIntervalMs: number
  protected readonly maxEntries: number
  protected readonly version: number
  protected readonly diskCacheEnabled: boolean

  protected cache: Map<string, BaseCacheEntry<T>>
  private saveTimeout: NodeJS.Timeout | null
  private cleanupInterval: NodeJS.Timeout | null
  private savePromise: Promise<void> | null
  private saveQueued: boolean

  protected lastLoadedAt: number | null
  protected lastSavedAt: number | null

  constructor(options: BaseCacheOptions) {
    this.cacheName = options.name
    this.passwordHashKey = options.passwordHashKey
    this.salt = options.salt
    this.filePath = options.filePath
    this.tempFilePath = `${options.filePath}.tmp`
    this.saveDelayMs = options.saveDelayMs ?? 5000
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 60000
    this.maxEntries = options.maxEntries ?? 0
    this.version = options.version ?? 1
    this.diskCacheEnabled = options.diskCacheEnabled ?? true

    this.key = this._deriveFastKey(this.passwordHashKey)
    this.legacyKey = null
    this.cache = new Map()

    this.saveTimeout = null
    this.savePromise = null
    this.saveQueued = false
    this.lastLoadedAt = null
    this.lastSavedAt = null

    this.cleanupInterval = setInterval(() => {
      const expiredCount = this._purgeExpired()
      const evictedCount = this._enforceMaxEntries()
      if (expiredCount > 0 || evictedCount > 0) this.save()
    }, this.cleanupIntervalMs)
    this.cleanupInterval.unref?.()
  }

  async load(): Promise<void> {
    if (!this.diskCacheEnabled) return

    try {
      const data = await fs.readFile(this.filePath)
      if (data.length < 32) return

      let payload: BaseCachePayload<T>
      let migratedFromLegacy = false

      try {
        payload = this._decodePayload(data, this.key)
      } catch {
        const legacyKey = this._getLegacyKey()
        payload = this._decodePayload(data, legacyKey)
        migratedFromLegacy = true
      }

      this.cache = new Map(Object.entries(payload.entries))

      const expiredCount = this._purgeExpired()
      const evictedCount = this._enforceMaxEntries()
      if (expiredCount > 0 || evictedCount > 0 || migratedFromLegacy)
        this.save()

      this.lastLoadedAt = Date.now()
      logger(
        'debug',
        this.cacheName,
        `Loaded ${this.cache.size} entries from disk.`
      )
    } catch (error) {
      const code = getErrorCode(error)
      if (code !== 'ENOENT') {
        logger(
          'error',
          this.cacheName,
          `Failed to load cache: ${getErrorMessage(error)}`
        )
      }
      this.cache = new Map()
    }
  }

  save(): void {
    if (this.saveTimeout) return

    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null
      void this.forceSave()
    }, this.saveDelayMs)
  }

  async forceSave(): Promise<void> {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout)
      this.saveTimeout = null
    }

    try {
      this._purgeExpired()
      this._enforceMaxEntries()
      await this._flushSaveQueue()
      logger('debug', this.cacheName, 'Force saved to disk.')
    } catch (error) {
      logger(
        'error',
        this.cacheName,
        `Failed to force save: ${getErrorMessage(error)}`
      )
    }
  }

  clear(): void {
    if (this.cache.size === 0) return
    this.cache.clear()
    this.save()
  }

  /**
   * Cleans up internal timers and resources.
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout)
      this.saveTimeout = null
    }
  }

  protected _getValidEntry(key: string): BaseCacheEntry<T> | null {
    const entry = this.cache.get(key)
    if (!entry) return null
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      this.save()
      return null
    }

    if (this.maxEntries > 0) {
      this.cache.delete(key)
      this.cache.set(key, entry)
    }

    return entry
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

  private _purgeExpired(): number {
    const now = Date.now()
    let expiredCount = 0
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt && now > entry.expiresAt) {
        this.cache.delete(key)
        expiredCount++
      }
    }
    return expiredCount
  }

  protected _enforceMaxEntries(): number {
    if (this.maxEntries <= 0 || this.cache.size <= this.maxEntries) return 0

    let removed = 0
    while (this.cache.size > this.maxEntries) {
      const oldestKey = this.cache.keys().next().value
      if (!oldestKey) break
      this.cache.delete(oldestKey)
      removed++
    }
    return removed
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

  private _buildPayload(): BaseCachePayload<T> {
    return {
      version: this.version,
      savedAt: Date.now(),
      entries: Object.fromEntries(this.cache)
    }
  }

  private async _flushSaveQueue(): Promise<void> {
    if (this.savePromise) {
      this.saveQueued = true
      await this.savePromise
      if (this.saveQueued) {
        this.saveQueued = false
        await this._flushSaveQueue()
      }
      return
    }

    const payload = this._buildPayload()
    this.savePromise = this._writeToDisk(payload)
    try {
      await this.savePromise
    } finally {
      this.savePromise = null
    }

    if (this.saveQueued) {
      this.saveQueued = false
      await this._flushSaveQueue()
    }
  }

  private async _writeToDisk(payload: BaseCachePayload<T>): Promise<void> {
    if (!this.diskCacheEnabled) return

    const plainText = JSON.stringify(payload)
    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv)

    const encrypted = Buffer.concat([
      cipher.update(plainText, 'utf8'),
      cipher.final()
    ])
    const tag = cipher.getAuthTag()
    const outBuffer = Buffer.concat([iv, tag, encrypted])

    await fs.mkdir('./.cache', { recursive: true })
    try {
      await fs.writeFile(this.tempFilePath, outBuffer)
      await fs.rename(this.tempFilePath, this.filePath)
    } catch (error) {
      logger(
        'debug',
        this.cacheName,
        `Atomic save failed, falling back to direct write: ${getErrorMessage(error)}`
      )
      await fs.writeFile(this.filePath, outBuffer)
      try {
        await fs.unlink(this.tempFilePath)
      } catch (cleanupError) {
        logger(
          'debug',
          this.cacheName,
          `Failed to remove temp cache file: ${getErrorMessage(cleanupError)}`
        )
      }
    }

    this.lastSavedAt = payload.savedAt
  }
}
