var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { logger } from "../utils.js";
/**
 * CommonJS resolver used to resolve npm package entry points.
 * @internal
 */
const require = createRequire(import.meta.url);
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
    nodelink;
    /** Plugin definitions from configuration. */
    config;
    /** Per-plugin configuration map. */
    pluginConfigs;
    /** Root directory for local plugins. */
    pluginsDir;
    /** Cache of loaded plugin entries. */
    loadedPlugins;
    /** Registered plugin hooks. */
    hooks;
    /** Tracks which hooks belong to which plugin for cleanup. */
    pluginHooks;
    /** Tracks the current plugin being initialized to associate hooks correctly. */
    executingPluginName = null;
    /**
     * Creates a new plugin manager instance.
     * @param nodelink - NodeLink runtime context.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.config = Array.isArray(nodelink.options.plugins)
            ? nodelink.options.plugins
            : [];
        this.pluginConfigs = nodelink.options.pluginConfig ?? {};
        this.pluginsDir = path.join(process.cwd(), 'plugins');
        this.loadedPlugins = new Map();
        this.hooks = new Map();
        this.pluginHooks = new Map();
    }
    /**
     * Loads and executes all configured plugins for the current process context.
     * @param contextType - Runtime context identifier (e.g. master/voice-worker).
     */
    async load(contextType) {
        logger('info', 'PluginManager', `Initializing plugins in ${contextType} context...`);
        try {
            await fs.access(this.pluginsDir);
        }
        catch {
            await fs.mkdir(this.pluginsDir, { recursive: true });
        }
        for (const pluginDef of this.config) {
            await this._loadPlugin(pluginDef, contextType);
        }
        logger('info', 'PluginManager', `Plugins processed for ${contextType}.`);
    }
    /**
     * Registers a callback for a specific plugin hook.
     * @param name - The name of the hook.
     * @param callback - The function to execute when the hook is called.
     * @public
     */
    registerHook(name, callback) {
        if (this.executingPluginName) {
            if (!this.pluginHooks.has(this.executingPluginName)) {
                this.pluginHooks.set(this.executingPluginName, new Set());
            }
            this.pluginHooks.get(this.executingPluginName)?.add({ name, callback });
        }
        if (!this.hooks.has(name)) {
            this.hooks.set(name, []);
        }
        this.hooks.get(name)?.push(callback);
    }
    /**
     * Unloads a plugin by removing its hooks and cache entry.
     * @param name - The name of the plugin to unload.
     * @public
     */
    unloadPlugin(name) {
        const pluginHooks = this.pluginHooks.get(name);
        if (pluginHooks) {
            for (const { name: hookName, callback } of pluginHooks) {
                const list = this.hooks.get(hookName);
                if (list) {
                    const index = list.indexOf(callback);
                    if (index !== -1)
                        list.splice(index, 1);
                }
            }
            this.pluginHooks.delete(name);
        }
        this.loadedPlugins.delete(name);
        logger('info', 'PluginManager', `Unloaded plugin: ${name}`);
    }
    /**
     * Reloads a specific plugin.
     * @param name - Name of the plugin.
     * @param contextType - Process context.
     * @public
     */
    async reloadPlugin(name, contextType) {
        const def = this.config.find((d) => d.name === name);
        if (!def) {
            throw new Error(`Plugin '${name}' not found in configuration.`);
        }
        this.unloadPlugin(name);
        await this._loadPlugin(def, contextType, true);
    }
    /**
     * Synchronously executes all callbacks registered for a hook.
     * @param name - The name of the hook to trigger.
     * @param args - Arguments to pass to the hook callbacks.
     * @public
     */
    callHook(name, ...args) {
        const callbacks = this.hooks.get(name);
        if (!callbacks)
            return;
        for (const callback of callbacks) {
            try {
                callback(...args);
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                logger('error', 'PluginManager', `Error in hook '${name}': ${message}`);
            }
        }
    }
    /**
     * Asynchronously executes all callbacks registered for a hook.
     * @param name - The name of the hook to trigger.
     * @param args - Arguments to pass to the hook callbacks.
     * @public
     */
    async callHookAsync(name, ...args) {
        const callbacks = this.hooks.get(name);
        if (!callbacks)
            return;
        await Promise.all(callbacks.map(async (callback) => {
            try {
                await callback(...args);
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                logger('error', 'PluginManager', `Error in async hook '${name}': ${message}`);
            }
        }));
    }
    /**
     * Locates the nearest package.json for a resolved module path.
     * @param startPath - Resolved file path inside a package.
     * @internal
     */
    async _findPackageJson(startPath) {
        let currentDir = path.dirname(startPath);
        while (currentDir !== path.parse(currentDir).root) {
            const pkgPath = path.join(currentDir, 'package.json');
            try {
                await fs.access(pkgPath);
                const data = await fs.readFile(pkgPath, 'utf-8');
                return this._parsePackageJson(data);
            }
            catch {
                if (path.basename(currentDir) === 'node_modules')
                    break;
                currentDir = path.dirname(currentDir);
            }
        }
        return null;
    }
    /**
     * Safely parses package.json raw content.
     * @param raw - Raw JSON string.
     * @internal
     */
    _parsePackageJson(raw) {
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object')
                return null;
            const pkg = parsed;
            const repository = pkg.repository;
            const author = pkg.author;
            return {
                version: typeof pkg.version === 'string' ? pkg.version : undefined,
                author: typeof author === 'string'
                    ? author
                    : author && typeof author === 'object'
                        ? {
                            name: typeof author.name === 'string'
                                ? author.name
                                : undefined
                        }
                        : undefined,
                homepage: typeof pkg.homepage === 'string' ? pkg.homepage : undefined,
                repository: typeof repository === 'string'
                    ? repository
                    : repository && typeof repository === 'object'
                        ? {
                            url: typeof repository.url ===
                                'string'
                                ? repository.url
                                : undefined
                        }
                        : undefined,
                main: typeof pkg.main === 'string' ? pkg.main : undefined
            };
        }
        catch {
            return null;
        }
    }
    /**
     * Extracts an author string from parsed package metadata.
     * @param pkg - Parsed package metadata.
     * @internal
     */
    _extractAuthor(pkg) {
        if (typeof pkg.author === 'string' && pkg.author.length > 0) {
            return pkg.author;
        }
        if (pkg.author &&
            typeof pkg.author === 'object' &&
            typeof pkg.author.name === 'string' &&
            pkg.author.name.length > 0) {
            return pkg.author.name;
        }
        return null;
    }
    /**
     * Extracts a topic/homepage/repository URL from package metadata.
     * @param pkg - Parsed package metadata.
     * @internal
     */
    _extractTopic(pkg) {
        if (typeof pkg.homepage === 'string' && pkg.homepage.length > 0) {
            return pkg.homepage;
        }
        if (pkg.repository &&
            typeof pkg.repository === 'object' &&
            typeof pkg.repository.url === 'string' &&
            pkg.repository.url.length > 0) {
            return pkg.repository.url;
        }
        if (typeof pkg.repository === 'string' && pkg.repository.length > 0) {
            return pkg.repository;
        }
        return null;
    }
    /**
     * Validates and narrows a dynamic module into a plugin module contract.
     * @param moduleValue - Dynamically imported module value.
     * @internal
     */
    _coercePluginModule(moduleValue) {
        if (!moduleValue || typeof moduleValue !== 'object')
            return null;
        const record = moduleValue;
        if (typeof record.default !== 'function')
            return null;
        return {
            default: record.default
        };
    }
    /**
     * Loads a single plugin definition and executes its entrypoint.
     * @param def - Plugin definition from config.
     * @param contextType - Current runtime context identifier.
     * @param forceReload - Whether to bypass cache and use timestamp for reloading.
     * @internal
     */
    async _loadPlugin(def, contextType, forceReload = false) {
        const { name, source, path: localPath, package: packageName } = def;
        if (!name || name.trim().length === 0)
            return;
        if (!forceReload && this.loadedPlugins.has(name)) {
            const cached = this.loadedPlugins.get(name);
            if (!cached)
                return;
            await this._executePlugin(cached.module, name, contextType, cached.meta);
            return;
        }
        try {
            let entryPoint = null;
            const pluginMeta = {
                name,
                version: '0.0.0',
                author: 'Unknown',
                topic: null
            };
            if (source === 'local') {
                const resolvedPath = path.resolve(this.pluginsDir, localPath || name);
                const stat = await fs.stat(resolvedPath);
                if (stat.isDirectory()) {
                    const pkgPath = path.join(resolvedPath, 'package.json');
                    try {
                        const pkgData = await fs.readFile(pkgPath, 'utf-8');
                        const pkg = this._parsePackageJson(pkgData);
                        if (pkg?.version)
                            pluginMeta.version = pkg.version;
                        const author = pkg ? this._extractAuthor(pkg) : null;
                        if (author) {
                            pluginMeta.author = author;
                        }
                        const topic = pkg ? this._extractTopic(pkg) : null;
                        if (topic) {
                            pluginMeta.topic = topic;
                        }
                        if (pkg?.main) {
                            entryPoint = path.join(resolvedPath, pkg.main);
                        }
                        else {
                            try {
                                await fs.access(path.join(resolvedPath, 'index.ts'));
                                entryPoint = path.join(resolvedPath, 'index.ts');
                            }
                            catch {
                                entryPoint = path.join(resolvedPath, 'index.js');
                            }
                        }
                    }
                    catch {
                        try {
                            await fs.access(path.join(resolvedPath, 'index.ts'));
                            entryPoint = path.join(resolvedPath, 'index.ts');
                        }
                        catch {
                            entryPoint = path.join(resolvedPath, 'index.js');
                        }
                    }
                }
                else {
                    entryPoint = resolvedPath;
                }
            }
            else if (source === 'npm') {
                try {
                    const pkgName = packageName || name;
                    entryPoint = require.resolve(pkgName);
                    const pkg = await this._findPackageJson(entryPoint);
                    if (pkg) {
                        if (pkg.version)
                            pluginMeta.version = pkg.version;
                        const author = this._extractAuthor(pkg);
                        if (author) {
                            pluginMeta.author = author;
                        }
                        const topic = this._extractTopic(pkg);
                        if (topic) {
                            pluginMeta.topic = topic;
                        }
                    }
                }
                catch (_e) {
                    logger('warn', 'PluginManager', `NPM package '${packageName || name}' not found.`);
                    return;
                }
            }
            if (!entryPoint)
                return;
            let fileUrl = pathToFileURL(entryPoint).href;
            if (forceReload) {
                fileUrl += `?t=${Date.now()}`;
            }
            const importedModule = await import(__rewriteRelativeImportExtension(fileUrl));
            const pluginModule = this._coercePluginModule(importedModule);
            if (!pluginModule) {
                throw new Error(`Plugin '${name}' entry point must export a default function.`);
            }
            this.loadedPlugins.set(name, {
                name,
                path: entryPoint,
                module: pluginModule,
                meta: pluginMeta
            });
            this.executingPluginName = name;
            try {
                await this._executePlugin(pluginModule, name, contextType, pluginMeta);
            }
            finally {
                this.executingPluginName = null;
            }
            const author = `\x1b[36m${pluginMeta.author}\x1b[0m`;
            const pluginName = `\x1b[1m\x1b[32m${name}\x1b[0m`;
            const version = `\x1b[33mv${pluginMeta.version}\x1b[0m`;
            const topic = pluginMeta.topic
                ? ` | \x1b[34mTopic:\x1b[0m ${pluginMeta.topic}`
                : '';
            const creditString = `[${author}] ${pluginName} ${version}${topic}`;
            logger('info', 'PluginManager', `${forceReload ? 'Reloaded' : 'Loaded'}: ${creditString}`);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger('error', 'PluginManager', `Failed to load plugin '${name}': ${message}`);
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
    async _executePlugin(pluginModule, name, contextType, meta) {
        const specificConfig = this.pluginConfigs[name] || {};
        const context = {
            type: contextType,
            workerId: process.pid,
            pluginName: name,
            meta
        };
        try {
            await pluginModule.default(this.nodelink, specificConfig, context);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger('error', 'PluginManager', `Error executing plugin '${name}' in '${contextType}' context: ${message}`);
        }
    }
}
