import fs from 'node:fs/promises'
import path from 'node:path'
import type { JsonValue } from '../../typings/config/config.types.ts'
import { logger } from '../../utils.ts'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends Record<string, unknown>
    ? DeepPartial<T[P]>
    : T[P]
}

/**
 * Deeply merges a source object into a target object recursively.
 * User-provided values always take precedence. Missing keys from target
 * (e.g. new defaults) are populated.
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: DeepPartial<T> | Record<string, unknown>
): T {
  const result = { ...target } as Record<string, unknown>

  for (const [key, sourceVal] of Object.entries(source)) {
    if (sourceVal === undefined) continue

    const targetVal = result[key]

    if (
      isRecord(targetVal) &&
      isRecord(sourceVal) &&
      !Array.isArray(targetVal) &&
      !Array.isArray(sourceVal)
    ) {
      result[key] = deepMerge(targetVal, sourceVal)
    } else {
      result[key] = sourceVal
    }
  }

  return result as T
}

/**
 * Compares defaults with user configuration to identify missing property paths.
 */
export function findMissingConfigKeys(
  defaults: Record<string, unknown>,
  user: Record<string, unknown>,
  prefix = ''
): string[] {
  const missing: string[] = []

  for (const [key, defVal] of Object.entries(defaults)) {
    const fullPath = prefix ? `${prefix}.${key}` : key

    if (!(key in user) || user[key] === undefined) {
      missing.push(fullPath)
    } else if (
      isRecord(defVal) &&
      isRecord(user[key]) &&
      !Array.isArray(defVal) &&
      !Array.isArray(user[key])
    ) {
      missing.push(
        ...findMissingConfigKeys(
          defVal as Record<string, unknown>,
          user[key] as Record<string, unknown>,
          fullPath
        )
      )
    }
  }

  return missing
}

/**
 * Migrates old flat configuration structures to the new hierarchical NodeLink schema.
 */
export function migrateConfig(
  oldConfig: Record<string, unknown>
): Record<string, unknown> {
  const newConfig: Record<string, unknown> = JSON.parse(
    JSON.stringify(oldConfig)
  )

  const migrationMap: Record<string, string> = {
    host: 'server.host',
    port: 'server.port',
    password: 'server.password',
    useBunServer: 'server.useBunServer',
    cors: 'server.cors',
    trustProxy: 'trustProxy',
    connection: 'connection',
    proxy: 'network.proxy',
    routePlanner: 'network.routePlanner',
    maxSearchResults: 'search.maxResults',
    defaultSearchSource: 'search.defaultSource',
    unifiedSearchSources: 'search.unifiedSources',
    resolveExternalLinks: 'search.resolveExternalLinks',
    fetchChannelInfo: 'search.fetchChannelInfo',
    maxAlbumPlaylistLength: 'playback.maxPlaylistLength',
    playerUpdateInterval: 'playback.playerUpdateInterval',
    statsUpdateInterval: 'playback.statsUpdateInterval',
    trackStuckThresholdMs: 'playback.trackStuckThresholdMs',
    eventTimeoutMs: 'playback.eventTimeoutMs',
    zombieThresholdMs: 'playback.zombieThresholdMs',
    sponsorblock: 'playback.sponsorblock',
    filters: 'playback.filters',
    audio: 'playback.audio',
    voiceReceive: 'playback.voiceReceive',
    mix: 'playback.mix',
    enableTrackStreamEndpoint: 'api.enableTrackStreamEndpoint',
    enableLoadStreamEndpoint: 'api.enableLoadStreamEndpoint',
    dosProtection: 'dosProtection',
    rateLimit: 'rateLimit',
    admission: 'admission',
    metrics: 'metrics',
    enableHoloTracks: 'experimental.enableHoloTracks',
    commandTimeout: 'cluster.timeouts.heavyMs',
    fastCommandTimeout: 'cluster.timeouts.fastMs',
    localPath: 'sources.local.basePath',
    spotifyClientId: 'sources.spotify.clientId',
    spotifyClientSecret: 'sources.spotify.clientSecret',
    spotifyMarket: 'sources.spotify.market',
    spotifyPlaylistLimit: 'sources.spotify.playlistLoadLimit',
    spotifyAlbumLimit: 'sources.spotify.albumLoadLimit',
    youtubeAllowItag: 'sources.youtube.allowItag',
    youtubeTargetItag: 'sources.youtube.targetItag',
    youtubeGetOAuthToken: 'sources.youtube.getOAuthToken',
    youtubeHl: 'sources.youtube.hl',
    youtubeGl: 'sources.youtube.gl',
    soundcloudClientId: 'sources.soundcloud.clientId',
    applemusicMarket: 'sources.applemusic.market',
    deezerMasterDecryptionKey: 'sources.deezer.masterDecryptionKey',
    tidalToken: 'sources.tidal.token'
  }

  for (const [oldKey, newPath] of Object.entries(migrationMap)) {
    if (oldKey === newPath) continue
    if (Object.hasOwn(newConfig, oldKey)) {
      const value: unknown | undefined = newConfig[oldKey]
      if (value === undefined) continue

      if (getDeepValue(newConfig, newPath) === undefined) {
        setDeepValue(newConfig, newPath, value)
      }
      delete newConfig[oldKey]
    }
  }

  const cluster = newConfig.cluster as Record<string, JsonValue> | undefined
  const network = newConfig.network as Record<string, JsonValue> | undefined
  const clusterTimeouts = cluster?.timeouts as
    | Record<string, JsonValue>
    | undefined

  const connection = getDeepValue(newConfig, 'connection')
  if (
    connection &&
    getDeepValue(newConfig, 'network.connection') === undefined
  ) {
    setDeepValue(newConfig, 'network.connection', connection)
    delete newConfig.connection
  }

  const metrics = getDeepValue(newConfig, 'metrics')
  if (metrics && getDeepValue(newConfig, 'api.metrics') === undefined) {
    setDeepValue(newConfig, 'api.metrics', metrics)
    delete newConfig.metrics
  }

  if (
    typeof cluster?.commandTimeout === 'number' &&
    typeof clusterTimeouts?.heavyMs !== 'number'
  ) {
    setDeepValue(
      newConfig,
      'cluster.timeouts.heavyMs',
      cluster.commandTimeout as JsonValue
    )
  }

  if (
    typeof cluster?.fastCommandTimeout === 'number' &&
    typeof clusterTimeouts?.fastMs !== 'number'
  ) {
    setDeepValue(
      newConfig,
      'cluster.timeouts.fastMs',
      cluster.fastCommandTimeout as JsonValue
    )
  }

  if (!network?.proxy || typeof network.proxy !== 'object') {
    setDeepValue(newConfig, 'network.proxy', {
      enabled: false,
      strategy: 'RoundRobin',
      retries: 3,
      timeout: 10000,
      shuffleOnStart: true,
      list: []
    })
  }

  const crossfade = getDeepValue(newConfig, 'playback.audio.crossfade') as
    | Record<string, unknown>
    | undefined
  if (crossfade && typeof crossfade.mode === 'string') {
    const validModes = ['preload', 'stream', 'smart']
    if (!validModes.includes(crossfade.mode)) {
      logger(
        'warn',
        'Config',
        `Unrecognized playback.audio.crossfade.mode "${crossfade.mode}". Falling back to "preload"`
      )
      crossfade.mode = 'preload'
    }
  }

  return newConfig
}

function setDeepValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown
): void {
  const parts = path.split('.')
  if (parts.length === 0) return
  let current = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    if (!part) continue
    if (!current[part] || typeof current[part] !== 'object') {
      current[part] = {}
    }
    current = current[part] as Record<string, unknown>
  }
  const leaf = parts[parts.length - 1]
  if (!leaf) return
  current[leaf] = value
}

function getDeepValue(
  obj: Record<string, unknown>,
  path: string
): unknown | undefined {
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (
      !current ||
      typeof current !== 'object' ||
      Array.isArray(current) ||
      !(part in current)
    ) {
      return undefined
    }
    const next: unknown | undefined = (current as Record<string, unknown>)[part]
    if (next === undefined) return undefined
    current = next
  }
  return current
}

/**
 * Converts a JavaScript object to a TypeScript literal string.
 * Uses single quotes and avoids quoting keys when possible.
 *
 * @param obj - The object to convert.
 * @param indent - Current indentation level.
 * @returns A formatted string representation of the object.
 * @internal
 */
export function toTsLiteral(obj: unknown, indent = 0): string {
  const spaces = ' '.repeat(indent)
  const nextSpaces = ' '.repeat(indent + 2)

  if (obj === null) return 'null'
  if (typeof obj === 'string') {
    return `'${obj.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`
  }
  if (typeof obj !== 'object') return String(obj)

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]'
    const items = obj
      .map((v) => toTsLiteral(v, indent + 2))
      .join(`,\n${nextSpaces}`)
    return `[\n${nextSpaces}${items}\n${spaces}]`
  }

  const keys = Object.keys(obj)
  if (keys.length === 0) return '{}'

  const props = keys
    .map((key) => {
      const val: unknown | undefined = (obj as Record<string, unknown>)[key]
      if (val === undefined) return null
      const value = toTsLiteral(val, indent + 2)
      const validKey = /^[a-z_$][a-z0-9_$]*$/i.test(key) ? key : `'${key}'`
      return `${validKey}: ${value}`
    })
    .filter((v) => v !== null)
    .join(`,\n${nextSpaces}`)

  return `{\n${nextSpaces}${props}\n${spaces}}`
}

/**
 * Persists a configuration object to config.ts if it was loaded from a legacy
 * source or the default template.
 *
 * @param config - The migrated configuration object.
 * @param fileName - The name of the source file.
 */
export async function persistConfig(
  config: Record<string, unknown>,
  fileName: string
): Promise<void> {
  const isLegacy = fileName.endsWith('.js')
  const isDefault = fileName.startsWith('config.default')

  if (!isLegacy && !isDefault) return

  try {
    const configTsPath = path.resolve(process.cwd(), 'config.ts')
    const literal = toTsLiteral(config)
    const content = `import type { NodelinkConfig } from './src/typings/config/config.types.ts'\n\nexport const config: NodelinkConfig = ${literal}\n\nexport default config\n`

    await fs.writeFile(configTsPath, content, 'utf-8')
    logger(
      'info',
      'Config',
      `Automatically updated local config.ts from ${fileName}`
    )
  } catch (err) {
    logger(
      'warn',
      'Config',
      `Failed to persist updated configuration: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/**
 * Reconciles an existing config.ts file by merging newly introduced default fields.
 * Safely creates a backup (config.ts.bak) before modifying the file on disk.
 */
export async function reconcileConfigOnDisk(
  config: Record<string, unknown>,
  fileName: string,
  missingKeys: string[]
): Promise<void> {
  const configTsPath = path.resolve(process.cwd(), fileName)
  const backupPath = `${configTsPath}.bak`

  try {
    try {
      await fs.copyFile(configTsPath, backupPath)
      logger(
        'info',
        'Config',
        `Created backup of ${fileName} at ${path.basename(backupPath)}`
      )
    } catch (backupErr) {
      logger(
        'warn',
        'Config',
        `Failed to create configuration backup ${backupPath}: ${backupErr instanceof Error ? backupErr.message : String(backupErr)}`
      )
    }

    const literal = toTsLiteral(config)
    const header = [
      '// Configuration updated automatically by NodeLink configuration migration.',
      `// Populated ${missingKeys.length} new/missing field(s) from latest release:`,
      `// - ${missingKeys.slice(0, 10).join('\n// - ')}${missingKeys.length > 10 ? `\n// - ... and ${missingKeys.length - 10} more` : ''}`,
      `// A backup of your previous configuration was saved to ${path.basename(backupPath)}`
    ].join('\n')

    const content = `${header}\n\nimport type { NodelinkConfig } from './src/typings/config/config.types.ts'\n\nexport const config: NodelinkConfig = ${literal}\n\nexport default config\n`

    await fs.writeFile(configTsPath, content, 'utf-8')
    logger(
      'info',
      'Config',
      `Updated ${fileName} with missing defaults from update: [${missingKeys.slice(0, 5).join(', ')}${missingKeys.length > 5 ? ', ...' : ''}]`
    )
  } catch (err) {
    logger(
      'warn',
      'Config',
      `Failed to reconcile configuration on disk: ${err instanceof Error ? err.message : String(err)}. Server will continue with merged in-memory configuration.`
    )
  }
}