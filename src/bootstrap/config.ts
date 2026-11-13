import { resolve as resolvePath } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import {
  deepMerge,
  findMissingConfigKeys,
  migrateConfig,
  persistConfig,
  reconcileConfigOnDisk
} from '../modules/config/configMigration.ts'
import type { NodelinkConfig } from '../typings/config/config.types.ts'
import type { ConfigLoadError } from '../typings/index.types.ts'
import { applyEnvOverrides, logger } from '../utils.ts'

interface ResolvedBootstrapConfig {
  config: NodelinkConfig
  clusterEnabled: boolean
  configuredWorkers: number
}

interface ConfigModuleExport {
  default?: NodelinkConfig
  config?: NodelinkConfig
}

function _resolveConfigPath(fileName: string): string {
  const absolutePath = resolvePath(process.cwd(), fileName)
  return pathToFileURL(absolutePath).href
}

function _isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function _extractConfigFromModule(
  module: ConfigModuleExport,
  fileName: string
): NodelinkConfig {
  const exported = module.default ?? module.config

  if (_isRecord(exported)) {
    return exported as NodelinkConfig
  }

  throw new Error(
    `Invalid configuration in "${fileName}": file must export a configuration object.`
  )
}

async function _tryImportConfigFile(
  candidates: string[]
): Promise<{ module: ConfigModuleExport; fileName: string } | null> {
  for (const fileName of candidates) {
    try {
      const module = (await import(
        _resolveConfigPath(fileName)
      )) as ConfigModuleExport
      return { module, fileName }
    } catch (error) {
      if ((error as ConfigLoadError).code !== 'ERR_MODULE_NOT_FOUND') {
        throw error
      }
    }
  }
  return null
}

async function _loadUserConfig(): Promise<{
  userConfig: Partial<NodelinkConfig>
  userFileName: string | null
}> {
  const result = await _tryImportConfigFile(['config.ts', 'config.js'])
  if (!result) {
    logger('info', 'Config', 'No custom config.ts found. Using defaults.')
    return { userConfig: {}, userFileName: null }
  }

  logger('info', 'Config', `Loaded configuration from ${result.fileName}`)
  return {
    userConfig: _extractConfigFromModule(result.module, result.fileName),
    userFileName: result.fileName
  }
}

async function _loadDefaultConfig(): Promise<{
  defaultConfig: NodelinkConfig
  defaultFileName: string
}> {
  const result = await _tryImportConfigFile([
    'config.default.ts',
    'config.default.js'
  ])
  if (!result) {
    throw new Error('Base configuration (config.default.ts/js) was not found.')
  }

  return {
    defaultConfig: _extractConfigFromModule(result.module, result.fileName),
    defaultFileName: result.fileName
  }
}

async function loadBootstrapConfig(): Promise<ResolvedBootstrapConfig> {
  const { defaultConfig, defaultFileName } = await _loadDefaultConfig()
  const { userConfig, userFileName } = await _loadUserConfig()

  const migratedUser = migrateConfig(
    userConfig as Record<string, unknown>
  ) as Partial<NodelinkConfig>

  const missingKeys = userFileName
    ? findMissingConfigKeys(
        defaultConfig as unknown as Record<string, unknown>,
        migratedUser as Record<string, unknown>
      )
    : []

  const merged = deepMerge(
    defaultConfig as unknown as Record<string, unknown>,
    migratedUser as Record<string, unknown>
  ) as unknown as NodelinkConfig

  if (!userFileName) {
    await persistConfig(
      merged as unknown as Record<string, unknown>,
      defaultFileName
    )
  } else if (userFileName.endsWith('.js')) {
    await persistConfig(
      merged as unknown as Record<string, unknown>,
      userFileName
    )
  } else if (missingKeys.length > 0) {
    await reconcileConfigOnDisk(
      merged as unknown as Record<string, unknown>,
      userFileName,
      missingKeys
    )
  }

  applyEnvOverrides(merged)

  const clusterEnabled =
    process.env.CLUSTER_ENABLED?.toLowerCase() === 'true' ||
    Boolean(merged.cluster?.enabled)

  const configuredWorkers =
    Number(process.env.CLUSTER_WORKERS) || merged.cluster?.workers || 0

  return {
    config: merged,
    clusterEnabled,
    configuredWorkers
  }
}

export { loadBootstrapConfig, type ResolvedBootstrapConfig }
