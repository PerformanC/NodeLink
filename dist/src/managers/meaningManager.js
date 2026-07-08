var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils.js';
/**
 * Checks whether a meaning source is enabled in config.
 * @param meaningsConfig - Meanings configuration bucket.
 * @param sourceName - Source name to check.
 * @internal
 */
const isMeaningSourceEnabled = (meaningsConfig, sourceName) => {
    const sourceConfig = meaningsConfig?.[sourceName];
    return sourceConfig?.enabled === true;
};
/**
 * Loads and resolves meaning providers for tracks.
 * @remarks Providers are loaded from `src/meanings` and sorted by priority.
 * @example
 * ```ts
 * const meanings = new MeaningManager(nodelink)
 * await meanings.loadFolder()
 * const result = await meanings.loadMeaning({ info: track.info }, 'en')
 * ```
 * @public
 */
export default class MeaningManager {
    nodelink;
    meaningSources;
    /**
     * Creates a new meaning manager instance.
     * @param nodelink - NodeLink runtime context.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.meaningSources = new Map();
    }
    /**
     * Loads enabled meaning providers from the meanings directory.
     */
    async loadFolder() {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const meaningsDir = path.join(__dirname, '../meanings');
        this.meaningSources.clear();
        try {
            await fs.access(meaningsDir);
            const files = await fs.readdir(meaningsDir);
            const jsFiles = files.filter((f) => f.endsWith('.js') || f.endsWith('.ts'));
            const toLoad = jsFiles.filter((f) => {
                const name = path.basename(f, path.extname(f));
                return isMeaningSourceEnabled(this.nodelink.options.meanings, name);
            });
            await Promise.all(toLoad.map(async (file) => {
                const name = path.basename(file, path.extname(file));
                const filePath = path.join(meaningsDir, file);
                const fileUrl = new URL(`file://${filePath.replace(/\\/g, '/')}`);
                const importedModule = (await import(__rewriteRelativeImportExtension(fileUrl.href)));
                const Mod = importedModule.default;
                if (typeof Mod !== 'function') {
                    logger('warn', 'Meaning', `Invalid meaning source module export for: ${name}`);
                    return;
                }
                const instance = new Mod(this.nodelink);
                if (await instance.setup()) {
                    this.meaningSources.set(name, instance);
                    logger('info', 'Meaning', `Loaded meaning source: ${name}`);
                }
                else {
                    logger('error', 'Meaning', `Failed setup for meaning source: ${name}; source not available.`);
                }
            }));
        }
        catch {
            logger('info', 'Meaning', `Meanings directory not found, creating at: ${meaningsDir}`);
            await fs.mkdir(meaningsDir, { recursive: true });
        }
    }
    /**
     * Loads meaning data for the provided decoded track.
     * @param decodedTrack - Decoded track payload with track info.
     * @param language - Optional target language code.
     * @returns Meaning result payload.
     */
    async loadMeaning(decodedTrack, language) {
        const trackInfo = decodedTrack?.info;
        const sourceName = trackInfo && typeof trackInfo.sourceName === 'string'
            ? trackInfo.sourceName
            : null;
        if (!trackInfo || !sourceName) {
            logger('warn', 'Meaning', 'Invalid track object provided to loadMeaning');
            return {
                loadType: 'error',
                data: { message: 'Invalid track object provided.', severity: 'common' }
            };
        }
        const meaningSource = this.meaningSources.get(sourceName);
        if (meaningSource) {
            const meaning = await meaningSource.getMeaning(trackInfo, language);
            if (meaning && meaning.loadType !== 'empty') {
                if (meaning.loadType === 'meaning') {
                    meaning.data.provider = sourceName;
                }
                return meaning;
            }
        }
        const sortedSources = Array.from(this.meaningSources.entries()).sort((a, b) => (b[1].priority || 0) - (a[1].priority || 0));
        for (const [name, source] of sortedSources) {
            if (name !== sourceName) {
                const meaning = await source.getMeaning(trackInfo, language);
                if (meaning && meaning.loadType !== 'empty') {
                    if (meaning.loadType === 'meaning') {
                        meaning.data.provider = name;
                    }
                    return meaning;
                }
            }
        }
        return { loadType: 'empty', data: {} };
    }
}
