import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { logger } from '../utils.ts'

/**
 * CommonJS resolver used to resolve npm package entry points.
 * @internal
 */
const require = createRequire(import.meta.url)

/**
 * Execution context kind used by plugin bootstrap hooks.
 * @public
 */
export type PluginContextType =
  | 'master'
  | 'worker'
  | 'voice-worker'
  | 'source-worker'
  | 'micro-worker'
  | string

/**
 * Valid hook names supported by the NodeLink plugin system.
 * @public
 */
export type PluginHookName =
  | 'onPlayerCreate'
  | 'onPlayerDestroy'
  | 'onTrackStart'
  | 'onTrackEnd'
  | 'onTrackException'
  | 'onTrackStuck'
  | 'onSearch'
  | 'onResolve'
  | 'onRESTRequest'
  | 'onWebSocketMessage'
  | 'onIPCMessage'
  | string

/**
 * Plugin definition as declared in NodeLink configuration.
 * @public
 */
export interface PluginDefinition {
  name: string
  source?: 'local' | 'npm' | string
  path?: string
  package?: string
}

/**
 * Arbitrary plugin configuration object passed to plugin executors.
 * @public
 */
export type PluginSpecificConfig = Record<string, unknown>

/**
 * Per-plugin configuration map keyed by plugin name.
 * @public
 */
export type PluginConfigMap = Record<string, PluginSpecificConfig | undefined>

/**
 * Metadata resolved for a loaded plugin.
 * @public
 */
export interface PluginMeta {
  name: string
  version: string
  author: string
  topic: string | null
}

/**
 * Runtime context object passed to plugin entrypoints.
 * @public
 */
export interface PluginExecutionContext {
  /** The type of process the plugin is running in. */
  type: PluginContextType
  /** Process or thread identifier. */
  workerId: number | string
  /** The display name of the plugin. */
  pluginName: string
  /** Resolved plugin metadata. */
  meta: PluginMeta
}

/**
 * Function signature expected from plugin default exports.
 * @public
 */
export type PluginExecutor = (
  nodelink: PluginManagerContext,
  config: PluginSpecificConfig,
  context: PluginExecutionContext
) => Promise<void> | void

/**
 * Dynamically imported plugin module contract.
 * @public
 */
export interface PluginModule {
  default: PluginExecutor
}

/**
 * In-memory cache entry for loaded plugins.
 * @internal
 */
interface LoadedPluginEntry {
  name: string
  path: string
  module: PluginModule
  meta: PluginMeta
}

/**
 * Minimal package.json metadata read by the plugin manager.
 * @internal
 */
interface PluginPackageJson {
  version?: string
  author?: string | { name?: string }
  homepage?: string
  repository?: string | { url?: string }
  main?: string
}

/**
 * Minimal NodeLink context required by the plugin manager.
 * @public
 */
export type PluginManagerContext = {
  options: {
    plugins?: PluginDefinition[]
    pluginConfig?: PluginConfigMap
  }
} & Record<string, unknown>

/**
 * Loads and executes configured plugins from local paths and npm packages.
 * Implements a multi-process hook system for cross-cutting concerns.
 *
 * @example
 * ```ts
 * const plugins = new PluginManager(nodelink)
 * await plugins.load('master')
 * plugins.registerHook('onTrackStart', (guildId, track) => {
 *   console.log(`Track started in ${guildId}`)
 * })
 * ```
 * @public
 */
export default class PluginManager {
  /** The parent NodeLink context. */
  public readonly nodelink: PluginManagerContext
  /** Plugin definitions from configuration. */
  private readonly config: PluginDefinition[]
  /** Per-plugin configuration map. */
  private readonly pluginConfigs: PluginConfigMap
  /** Root directory for local plugins. */
  private readonly pluginsDir: string
  /** Cache of loaded plugin entries. */
  public readonly loadedPlugins: Map<string, LoadedPluginEntry>
  /** Registered plugin hooks. */
  private readonly hooks: Map<
    PluginHookName,
    Array<(...args: unknown[]) => void>
  >
  /** Tracks which hooks belong to which plugin for cleanup. */
  private readonly pluginHooks: Map<
    string,
    Set<{ name: PluginHookName; callback: (...args: unknown[]) => void }>
  >
  /** Tracks the current plugin being initialized to associate hooks correctly. */
  private executingPluginName: string | null = null

  /**
   * Creates a new plugin manager instance.
   * @param nodelink - NodeLink runtime context.
   */
  constructor(nodelink: PluginManagerContext) {
    this.nodelink = nodelink
    this.config = Array.isArray(nodelink.options.plugins)
      ? nodelink.options.plugins
      : []
    this.pluginConfigs = nodelink.options.pluginConfig ?? {}
    this.pluginsDir = path.join(process.cwd(), 'plugins')
    this.loadedPlugins = new Map()
    this.hooks = new Map()
    this.pluginHooks = new Map()
  }

  /**
   * Loads and executes all configured plugins for the current process context.
   * @param contextType - Runtime context identifier (e.g. master/voice-worker).
   */
  public async load(contextType: PluginContextType): Promise<void> {
    logger(
      'info',
      'PluginManager',
      `Initializing plugins in ${contextType} context...`
    )

    try {
      await fs.access(this.pluginsDir)
    } catch {
      await fs.mkdir(this.pluginsDir, { recursive: true })
    }

    for (const pluginDef of this.config) {
      await this._loadPlugin(pluginDef, contextType)
    }

    logger('info', 'PluginManager', `Plugins processed for ${contextType}.`)
  }

  /**
   * Registers a callback for a specific plugin hook.
   * @param name - The name of the hook.
   * @param callback - The function to execute when the hook is called.
   * @public
   */
  public registerHook(
    name: PluginHookName,
    callback: (...args: unknown[]) => void
  ): void {
    if (this.executingPluginName) {
      if (!this.pluginHooks.has(this.executingPluginName)) {
        this.pluginHooks.set(this.executingPluginName, new Set())
      }
      this.pluginHooks.get(this.executingPluginName)?.add({ name, callback })
    }

    if (!this.hooks.has(name)) {
      this.hooks.set(name, [])
    }
    this.hooks.get(name)?.push(callback)
  }

  /**
   * Unloads a plugin by removing its hooks and cache entry.
   * @param name - The name of the plugin to unload.
   * @public
   */
  public unloadPlugin(name: string): void {
    const pluginHooks = this.pluginHooks.get(name)
    if (pluginHooks) {
      for (const { name: hookName, callback } of pluginHooks) {
        const list = this.hooks.get(hookName)
        if (list) {
          const index = list.indexOf(callback)
          if (index !== -1) list.splice(index, 1)
        }
      }
      this.pluginHooks.delete(name)
    }

    this.loadedPlugins.delete(name)
    logger('info', 'PluginManager', `Unloaded plugin: ${name}`)
  }

  /**
   * Reloads a specific plugin.
   * @param name - Name of the plugin.
   * @param contextType - Process context.
   * @public
   */
  public async reloadPlugin(
    name: string,
    contextType: PluginContextType
  ): Promise<void> {
    const def = this.config.find((d) => d.name === name)
    if (!def) {
      throw new Error(`Plugin '${name}' not found in configuration.`)
    }

    this.unloadPlugin(name)
    await this._loadPlugin(def, contextType, true)
  }

  /**
   * Synchronously executes all callbacks registered for a hook.
   * @param name - The name of the hook to trigger.
   * @param args - Arguments to pass to the hook callbacks.
   * @public
   */
  public callHook(name: PluginHookName, ...args: unknown[]): void {
    const callbacks = this.hooks.get(name)
    if (!callbacks) return

    for (const callback of callbacks) {
      try {
        callback(...args)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger('error', 'PluginManager', `Error in hook '${name}': ${message}`)
      }
    }
  }

  /**
   * Asynchronously executes all callbacks registered for a hook.
   * @param name - The name of the hook to trigger.
   * @param args - Arguments to pass to the hook callbacks.
   * @public
   */
  public async callHookAsync(
    name: PluginHookName,
    ...args: unknown[]
  ): Promise<void> {
    const callbacks = this.hooks.get(name)
    if (!callbacks) return

    await Promise.all(
      callbacks.map(async (callback) => {
        try {
          await callback(...args)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logger(
            'error',
            'PluginManager',
            `Error in async hook '${name}': ${message}`
          )
        }
      })
    )
  }

  /**
   * Locates the nearest package.json for a resolved module path.
   * @param startPath - Resolved file path inside a package.
   * @internal
   */
  private async _findPackageJson(
    startPath: string
  ): Promise<PluginPackageJson | null> {
    let currentDir = path.dirname(startPath)

    while (currentDir !== path.parse(currentDir).root) {
      const pkgPath = path.join(currentDir, 'package.json')
      try {
        await fs.access(pkgPath)
        const data = await fs.readFile(pkgPath, 'utf-8')
        return this._parsePackageJson(data)
      } catch {
        if (path.basename(currentDir) === 'node_modules') break
        currentDir = path.dirname(currentDir)
      }
    }

    return null
  }

  /**
   * Safely parses package.json raw content.
   * @param raw - Raw JSON string.
   * @internal
   */
  private _parsePackageJson(raw: string): PluginPackageJson | null {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return null

      const pkg = parsed as Record<string, unknown>
      const repository = pkg.repository
      const author = pkg.author

      return {
        version: typeof pkg.version === 'string' ? pkg.version : undefined,
        author:
          typeof author === 'string'
            ? author
            : author && typeof author === 'object'
              ? {
                  name:
                    typeof (author as Record<string, unknown>).name === 'string'
                      ? ((author as Record<string, unknown>).name as string)
                      : undefined
                }
              : undefined,
        homepage: typeof pkg.homepage === 'string' ? pkg.homepage : undefined,
        repository:
          typeof repository === 'string'
            ? repository
            : repository && typeof repository === 'object'
              ? {
                  url:
                    typeof (repository as Record<string, unknown>).url ===
                    'string'
                      ? ((repository as Record<string, unknown>).url as string)
                      : undefined
                }
              : undefined,
        main: typeof pkg.main === 'string' ? pkg.main : undefined
      }
    } catch {
      return null
    }
  }

  /**
   * Extracts an author string from parsed package metadata.
   * @param pkg - Parsed package metadata.
   * @internal
   */
  private _extractAuthor(pkg: PluginPackageJson): string | null {
    if (typeof pkg.author === 'string' && pkg.author.length > 0) {
      return pkg.author
    }

    if (
      pkg.author &&
      typeof pkg.author === 'object' &&
      typeof pkg.author.name === 'string' &&
      pkg.author.name.length > 0
    ) {
      return pkg.author.name
    }

    return null
  }

  /**
   * Extracts a topic/homepage/repository URL from package metadata.
   * @param pkg - Parsed package metadata.
   * @internal
   */
  private _extractTopic(pkg: PluginPackageJson): string | null {
    if (typeof pkg.homepage === 'string' && pkg.homepage.length > 0) {
      return pkg.homepage
    }

    if (
      pkg.repository &&
      typeof pkg.repository === 'object' &&
      typeof pkg.repository.url === 'string' &&
      pkg.repository.url.length > 0
    ) {
      return pkg.repository.url
    }

    if (typeof pkg.repository === 'string' && pkg.repository.length > 0) {
      return pkg.repository
    }

    return null
  }

  /**
   * Validates and narrows a dynamic module into a plugin module contract.
   * @param moduleValue - Dynamically imported module value.
   * @internal
   */
  private _coercePluginModule(moduleValue: unknown): PluginModule | null {
    if (!moduleValue || typeof moduleValue !== 'object') return null

    const record = moduleValue as Record<string, unknown>
    if (typeof record.default !== 'function') return null

    return {
      default: record.default as PluginExecutor
    }
  }

  /**
   * Loads a single plugin definition and executes its entrypoint.
   * @param def - Plugin definition from config.
   * @param contextType - Current runtime context identifier.
   * @param forceReload - Whether to bypass cache and use timestamp for reloading.
   * @internal
   */
  private async _loadPlugin(
    def: PluginDefinition,
    contextType: PluginContextType,
    forceReload = false
  ): Promise<void> {
    const { name, source, path: localPath, package: packageName } = def

    if (!name || name.trim().length === 0) return

    if (!forceReload && this.loadedPlugins.has(name)) {
      const cached = this.loadedPlugins.get(name)
      if (!cached) return

      await this._executePlugin(cached.module, name, contextType, cached.meta)
      return
    }

    try {
      let entryPoint: string | null = null
      const pluginMeta: PluginMeta = {
        name,
        version: '0.0.0',
        author: 'Unknown',
        topic: null
      }

      if (source === 'local') {
        const resolvedPath = path.resolve(this.pluginsDir, localPath || name)
        const stat = await fs.stat(resolvedPath)

        if (stat.isDirectory()) {
          const pkgPath = path.join(resolvedPath, 'package.json')
          try {
            const pkgData = await fs.readFile(pkgPath, 'utf-8')
            const pkg = this._parsePackageJson(pkgData)

            if (pkg?.version) pluginMeta.version = pkg.version

            const author = pkg ? this._extractAuthor(pkg) : null
            if (author) {
              pluginMeta.author = author
            }

            const topic = pkg ? this._extractTopic(pkg) : null
            if (topic) {
              pluginMeta.topic = topic
            }

            if (pkg?.main) {
              entryPoint = path.join(resolvedPath, pkg.main)
            } else {
              try {
                await fs.access(path.join(resolvedPath, 'index.ts'))
                entryPoint = path.join(resolvedPath, 'index.ts')
              } catch {
                entryPoint = path.join(resolvedPath, 'index.js')
              }
            }
          } catch {
            try {
              await fs.access(path.join(resolvedPath, 'index.ts'))
              entryPoint = path.join(resolvedPath, 'index.ts')
            } catch {
              entryPoint = path.join(resolvedPath, 'index.js')
            }
          }
        } else {
          entryPoint = resolvedPath
        }
      } else if (source === 'npm') {
        try {
          const pkgName = packageName || name
          entryPoint = require.resolve(pkgName)

          const pkg = await this._findPackageJson(entryPoint)
          if (pkg) {
            if (pkg.version) pluginMeta.version = pkg.version

            const author = this._extractAuthor(pkg)
            if (author) {
              pluginMeta.author = author
            }

            const topic = this._extractTopic(pkg)
            if (topic) {
              pluginMeta.topic = topic
            }
          }
        } catch (_e) {
          logger(
            'warn',
            'PluginManager',
            `NPM package '${packageName || name}' not found.`
          )
          return
        }
      }

      if (!entryPoint) return

      let fileUrl = pathToFileURL(entryPoint).href
      if (forceReload) {
        fileUrl += `?t=${Date.now()}`
      }
      const importedModule: unknown = await import(fileUrl)
      const pluginModule = this._coercePluginModule(importedModule)

      if (!pluginModule) {
        throw new Error(
          `Plugin '${name}' entry point must export a default function.`
        )
      }

      this.loadedPlugins.set(name, {
        name,
        path: entryPoint,
        module: pluginModule,
        meta: pluginMeta
      })

      this.executingPluginName = name
      try {
        await this._executePlugin(pluginModule, name, contextType, pluginMeta)
      } finally {
        this.executingPluginName = null
      }

      const author = `\x1b[36m${pluginMeta.author}\x1b[0m`
      const pluginName = `\x1b[1m\x1b[32m${name}\x1b[0m`
      const version = `\x1b[33mv${pluginMeta.version}\x1b[0m`
      const topic = pluginMeta.topic
        ? ` | \x1b[34mTopic:\x1b[0m ${pluginMeta.topic}`
        : ''

      const creditString = `[${author}] ${pluginName} ${version}${topic}`

      logger(
        'info',
        'PluginManager',
        `${forceReload ? 'Reloaded' : 'Loaded'}: ${creditString}`
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger(
        'error',
        'PluginManager',
        `Failed to load plugin '${name}': ${message}`
      )
    }
  }

  /**
   * Executes the plugin default export with resolved config and metadata.
   * @param pluginModule - Coerced plugin module.
   * @param name - Plugin display name.
   * @param contextType - Current runtime context identifier.
   * @param meta - Resolved plugin metadata.
   * @internal
   */
  private async _executePlugin(
    pluginModule: PluginModule,
    name: string,
    contextType: PluginContextType,
    meta: PluginMeta
  ): Promise<void> {
    const specificConfig = this.pluginConfigs[name] || {}
    const context: PluginExecutionContext = {
      type: contextType,
      workerId: process.pid,
      pluginName: name,
      meta
    }

    try {
      await pluginModule.default(this.nodelink, specificConfig, context)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger(
        'error',
        'PluginManager',
        `Error executing plugin '${name}' in '${contextType}' context: ${message}`
      )
    }
  }
}
