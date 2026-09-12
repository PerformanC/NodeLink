import type { NodelinkConfig } from '../typings/config/config.types.ts'
import type {
  CredentialEntry,
  CredentialManagerStats
} from '../typings/modules/credential.types.ts'
import BaseCacheManager from './baseCacheManager.ts'

const CREDENTIALS_SALT = 'nodelink-salt'
const CREDENTIALS_VERSION = 1
const DEFAULT_SAVE_DELAY_MS = 1000
const DEFAULT_CREDENTIALS_PATH = './.cache/credentials.bin'
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000

type CredentialManagerContext = {
  options: NodelinkConfig
}

const _isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Encrypted credential store with TTL support and debounced persistence.
 * @remarks
 * Credentials are stored in AES-256-GCM format and persisted atomically to disk.
 * @example
 * ```ts
 * const credentials = new CredentialManager(nodelink)
 * await credentials.load()
 * credentials.set('spotify_token', 'abc', 60_000)
 * const token = credentials.get<string>('spotify_token')
 * ```
 * @public
 */
export default class CredentialManager extends BaseCacheManager<unknown> {
  private readonly nodelink: CredentialManagerContext

  /**
   * Creates a new credential manager instance.
   * @param nodelink - NodeLink runtime used to derive the encryption key.
   */
  constructor(nodelink: CredentialManagerContext) {
    const password = CredentialManager._resolvePassword(nodelink.options)

    super({
      name: 'Credentials',
      passwordHashKey: password,
      salt: CREDENTIALS_SALT,
      filePath: DEFAULT_CREDENTIALS_PATH,
      saveDelayMs: DEFAULT_SAVE_DELAY_MS,
      cleanupIntervalMs: DEFAULT_CLEANUP_INTERVAL_MS,
      version: CREDENTIALS_VERSION,
      diskCacheEnabled: nodelink.options.cache?.diskEnabled ?? true
    })

    this.nodelink = nodelink
  }

  /**
   * Retrieves a credential value by key.
   * @param key - Credential identifier.
   * @returns The stored value or null when missing/expired.
   */
  get<T = unknown>(key: string): T | null {
    const entry = this._getValidEntry(key)
    return entry ? (entry.value as T) : null
  }

  /**
   * Retrieves the full credential entry with metadata.
   * @param key - Credential identifier.
   * @returns The entry or null when missing/expired.
   */
  getEntry<T = unknown>(key: string): CredentialEntry<T> | null {
    const entry = this._getValidEntry(key)
    if (!entry) return null
    return {
      ...(entry as unknown as CredentialEntry<T>)
    }
  }

  /**
   * Stores a credential value with an optional TTL.
   * @param key - Credential identifier.
   * @param value - Value to persist.
   * @param ttlMs - Time-to-live in milliseconds (0 = no expiry).
   */
  set<T = unknown>(key: string, value: T, ttlMs = 0): void {
    const now = Date.now()
    const current = this.cache.get(key)
    const expiresAt = ttlMs > 0 ? now + ttlMs : null

    this.cache.set(key, {
      value,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      expiresAt
    })
    this.save()
  }

  /**
   * Removes a credential entry.
   * @param key - Credential identifier.
   * @returns True if an entry was removed.
   */
  delete(key: string): boolean {
    const existed = this.cache.delete(key)
    if (existed) this.save()
    return existed
  }

  /**
   * Checks whether a credential entry exists and is not expired.
   * @param key - Credential identifier.
   */
  has(key: string): boolean {
    return this._getValidEntry(key) !== null
  }

  /**
   * Returns runtime statistics for credential storage.
   */
  getStats(): CredentialManagerStats {
    const now = Date.now()
    let expiredEntries = 0
    for (const entry of this.cache.values()) {
      if (entry.expiresAt && now > entry.expiresAt) expiredEntries++
    }
    return {
      totalEntries: this.cache.size,
      expiredEntries,
      lastLoadedAt: this.lastLoadedAt ?? undefined,
      lastSavedAt: this.lastSavedAt ?? undefined
    }
  }

  private static _resolvePassword(options: NodelinkConfig): string {
    const password = options.server?.password
    if (!password) {
      throw new Error('CredentialManager requires options.server.password')
    }
    return password
  }
}
