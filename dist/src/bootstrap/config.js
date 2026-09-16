var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { resolve as resolvePath } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { migrateConfig, persistConfig } from '../modules/config/configMigration.js';
import { applyEnvOverrides, logger } from '../utils.js';
function _resolveConfigPath(fileName) {
    const absolutePath = resolvePath(process.cwd(), fileName);
    return pathToFileURL(absolutePath).href;
}
function _isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function _extractConfigFromModule(module, fileName) {
    const exported = module.default ?? module.config;
    if (_isRecord(exported)) {
        return exported;
    }
    throw new Error(`Invalid configuration in "${fileName}": file must export a configuration object.`);
}
function _mergeConfigs(base, override) {
    return {
        ...base,
        ...override,
        sources: {
            ...base.sources,
            ...override.sources
        },
        lyrics: {
            ...base.lyrics,
            ...override.lyrics
        },
        meanings: {
            ...base.meanings,
            ...override.meanings
        },
        pluginConfig: {
            ...base.pluginConfig,
            ...override.pluginConfig
        }
    };
}
async function _tryImportConfigFile(candidates) {
    for (const fileName of candidates) {
        try {
            const module = (await import(__rewriteRelativeImportExtension(_resolveConfigPath(fileName))));
            return { module, fileName };
        }
        catch (error) {
            if (error.code !== 'ERR_MODULE_NOT_FOUND') {
                throw error;
            }
        }
    }
    return null;
}
async function _loadUserConfig() {
    const result = await _tryImportConfigFile(['config.ts', 'config.js']);
    if (!result) {
        logger('info', 'Config', 'No custom config.ts found. Using defaults.');
        return { userConfig: {}, userFileName: null };
    }
    logger('info', 'Config', `Loaded configuration from ${result.fileName}`);
    return {
        userConfig: _extractConfigFromModule(result.module, result.fileName),
        userFileName: result.fileName
    };
}
async function _loadDefaultConfig() {
    const result = await _tryImportConfigFile([
        'config.default.ts',
        'config.default.js'
    ]);
    if (!result) {
        throw new Error('Base configuration (config.default.ts/js) was not found.');
    }
    return {
        defaultConfig: _extractConfigFromModule(result.module, result.fileName),
        defaultFileName: result.fileName
    };
}
async function loadBootstrapConfig() {
    const { defaultConfig, defaultFileName } = await _loadDefaultConfig();
    const { userConfig, userFileName } = await _loadUserConfig();
    const merged = _mergeConfigs(defaultConfig, userConfig);
    const migrated = migrateConfig(merged);
    await persistConfig(migrated, userFileName ?? defaultFileName);
    applyEnvOverrides(migrated);
    const clusterEnabled = process.env.CLUSTER_ENABLED?.toLowerCase() === 'true' ||
        Boolean(migrated.cluster?.enabled);
    const configuredWorkers = Number(process.env.CLUSTER_WORKERS) || migrated.cluster?.workers || 0;
    return {
        config: migrated,
        clusterEnabled,
        configuredWorkers
    };
}
export { loadBootstrapConfig };
