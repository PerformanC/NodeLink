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
import { deepMerge, findMissingConfigKeys, migrateConfig, persistConfig, reconcileConfigOnDisk } from '../modules/config/configMigration.js';
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
    const migratedUser = migrateConfig(userConfig);
    const missingKeys = userFileName
        ? findMissingConfigKeys(defaultConfig, migratedUser)
        : [];
    const merged = deepMerge(defaultConfig, migratedUser);
    if (!userFileName) {
        await persistConfig(merged, defaultFileName);
    }
    else if (userFileName.endsWith('.js')) {
        await persistConfig(merged, userFileName);
    }
    else if (missingKeys.length > 0) {
        await reconcileConfigOnDisk(merged, userFileName, missingKeys);
    }
    applyEnvOverrides(merged);
    const clusterEnabled = process.env.CLUSTER_ENABLED?.toLowerCase() === 'true' ||
        Boolean(merged.cluster?.enabled);
    const configuredWorkers = Number(process.env.CLUSTER_WORKERS) || merged.cluster?.workers || 0;
    return {
        config: merged,
        clusterEnabled,
        configuredWorkers
    };
}
export { loadBootstrapConfig };
