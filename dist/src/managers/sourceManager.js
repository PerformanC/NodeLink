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
import { logger } from "../utils.js";
export default class SourcesManager {
    nodelink;
    sources;
    sourceMap;
    searchAliasMap;
    patternMap;
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.sources = new Map();
        this.sourceMap = new Map();
        this.searchAliasMap = new Map();
        this.patternMap = [];
    }
    async loadFolder() {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const sourcesDir = path.join(__dirname, '../sources');
        this.sources.clear();
        this.sourceMap.clear();
        this.searchAliasMap.clear();
        this.patternMap = [];
        const processSource = async (name, mod) => {
            const isYouTube = name === 'youtube' || name.includes('YouTube.js');
            const sourceKey = isYouTube ? 'youtube' : name;
            const youtubeKey = 'youtube';
            const sourceConfig = this.nodelink.options.sources;
            const enabled = isYouTube
                ? sourceConfig?.[youtubeKey]
                    ?.enabled
                : !!sourceConfig?.[sourceKey]?.enabled;
            if (!enabled)
                return;
            const importedModule = mod;
            const Mod = importedModule.default;
            if (!Mod) {
                logger('warn', 'Sources', `Invalid source module export for: ${sourceKey}`);
                return;
            }
            const instance = new Mod(this.nodelink);
            if (instance.setup && (await instance.setup())) {
                this.sources.set(sourceKey, instance);
                this.sourceMap.set(sourceKey, instance);
                if (Array.isArray(instance.additionalsSourceName)) {
                    for (const addName of instance.additionalsSourceName) {
                        this.sourceMap.set(addName, instance);
                    }
                }
                if (Array.isArray(instance.searchTerms)) {
                    for (const term of instance.searchTerms) {
                        this.searchAliasMap.set(term, instance);
                    }
                }
                if (Array.isArray(instance.recommendationTerm)) {
                    for (const term of instance.recommendationTerm) {
                        this.searchAliasMap.set(term, instance);
                    }
                }
                if (Array.isArray(instance.patterns)) {
                    for (const regex of instance.patterns) {
                        if (regex instanceof RegExp) {
                            this.patternMap.push({
                                regex,
                                sourceName: sourceKey,
                                priority: instance.priority || 0
                            });
                        }
                    }
                }
                logger('info', 'Sources', `Loaded source: ${sourceKey}`);
            }
        };
        try {
            await fs.access(sourcesDir);
            const enabledSourceKeys = Object.entries(this.nodelink.options.sources || {})
                .filter(([, cfg]) => !!cfg?.enabled)
                .map(([key]) => key.toLowerCase());
            const uniqueEnabled = Array.from(new Set(enabledSourceKeys));
            const sourceEntries = uniqueEnabled.map((sourceKey) => {
                const fileCandidates = sourceKey === 'youtube'
                    ? [
                        path.join(sourcesDir, 'youtube', 'YouTube.js'),
                        path.join(sourcesDir, 'youtube', 'YouTube.ts')
                    ]
                    : [
                        path.join(sourcesDir, `${sourceKey}.js`),
                        path.join(sourcesDir, `${sourceKey}.ts`)
                    ];
                return { sourceKey, fileCandidates };
            });
            await Promise.all(sourceEntries.map(async ({ sourceKey, fileCandidates }) => {
                let filePath = null;
                for (const candidatePath of fileCandidates) {
                    try {
                        await fs.access(candidatePath);
                        filePath = candidatePath;
                        break;
                    }
                    catch { }
                }
                if (!filePath) {
                    logger('warn', 'Sources', `Enabled source "${sourceKey}" has no entry file at ${fileCandidates[0]} or ${fileCandidates[1]}`);
                    return;
                }
                try {
                    const fileUrl = new URL(`file://${filePath.replace(/\\/g, '/')}`);
                    const mod = await import(__rewriteRelativeImportExtension(fileUrl.href));
                    await processSource(sourceKey, mod);
                }
                catch (e) {
                    logger('error', 'Sources', `Failed to load source "${sourceKey}": ${e.message}`);
                }
            }));
        }
        catch (e) {
            logger('error', 'Sources', `Error loading sources: ${e.message}`);
        }
        this.patternMap.sort((a, b) => b.priority - a.priority);
    }
    async _instrumentedSourceCall(sourceName, method, ...args) {
        const instance = this.sourceMap.get(sourceName);
        if (!instance ||
            typeof instance[method] !== 'function') {
            this.nodelink.statsManager?.incrementSourceFailure?.(sourceName || 'unknown');
            throw new Error(`Source ${sourceName} not found or does not support ${method}`);
        }
        try {
            const fn = instance[method];
            if (!fn) {
                throw new Error(`Method ${method} not found on source ${sourceName}`);
            }
            const result = await fn.apply(instance, args);
            if (result.loadType === 'error') {
                this.nodelink.statsManager?.incrementSourceFailure?.(sourceName);
            }
            else {
                this.nodelink.statsManager?.incrementSourceSuccess?.(sourceName);
            }
            return result;
        }
        catch (e) {
            this.nodelink.statsManager?.incrementSourceFailure?.(sourceName);
            throw e;
        }
    }
    async search(sourceTerm, query) {
        let instance = this.searchAliasMap.get(sourceTerm);
        const sourceName = sourceTerm;
        if (!instance) {
            instance = this.sourceMap.get(sourceTerm);
        }
        if (!instance) {
            throw new Error(`Source or search alias not found for: ${sourceTerm}`);
        }
        let searchType = 'track';
        let searchQuery = query;
        if (query.includes(':')) {
            const parts = query.split(':');
            const possibleType = (parts[0] ?? '').toLowerCase();
            const types = ['playlist', 'artist', 'album', 'channel', 'track'];
            if (types.includes(possibleType)) {
                searchType = possibleType;
                searchQuery = parts.slice(1).join(':');
            }
        }
        const name = instance.constructor.name.replace('Source', '').toLowerCase();
        logger('debug', 'Sources', `Searching on ${name} (${searchType}) for: "${searchQuery}"`);
        return this._instrumentedSourceCall(name, 'search', searchQuery, sourceName, searchType);
    }
    async searchWithDefault(query) {
        const defaultSources = Array.isArray(this.nodelink.options.defaultSearchSource)
            ? this.nodelink.options.defaultSearchSource
            : [this.nodelink.options.defaultSearchSource];
        for (const source of defaultSources) {
            try {
                const result = await this.search(source, query);
                if (result.loadType === 'search' &&
                    Array.isArray(result.data) &&
                    result.data.length > 0) {
                    return result;
                }
            }
            catch (e) {
                logger('warn', 'Sources', `Default source search failed for ${source}: ${e.message}`);
            }
        }
        return { loadType: 'empty', data: {} };
    }
    async unifiedSearch(query) {
        const searchSources = (this.nodelink.options.unifiedSearchSources || [
            'youtube'
        ]);
        logger('debug', 'Sources', `Performing unified search for "${query}" on [${searchSources.join(', ')}]`);
        const searchPromises = searchSources.map((sourceName) => this._instrumentedSourceCall(sourceName, 'search', query).catch((e) => {
            logger('warn', 'Sources', `A source (${sourceName}) failed during unified search: ${e.message}`);
            return { loadType: 'error', data: { message: e.message } };
        }));
        const results = await Promise.all(searchPromises);
        const allTracks = [];
        results.forEach((result) => {
            if (result.loadType === 'search') {
                allTracks.push(...result.data);
            }
        });
        if (allTracks.length === 0) {
            return { loadType: 'empty', data: {} };
        }
        return {
            loadType: 'playlist',
            data: {
                info: {
                    name: `Search results for: ${query}`,
                    selectedTrack: -1
                },
                pluginInfo: {},
                tracks: allTracks
            }
        };
    }
    async resolve(url) {
        let sourceName = null;
        for (const entry of this.patternMap) {
            if (entry.regex.test(url)) {
                sourceName = entry.sourceName;
                break;
            }
        }
        if (!sourceName &&
            (url.startsWith('https://') || url.startsWith('http://'))) {
            sourceName = 'http';
        }
        if (!sourceName || !this.sourceMap.has(sourceName)) {
            logger('warn', 'Sources', `No source found for URL: ${url}`);
            return {
                loadType: 'error',
                data: {
                    message: 'No source found for URL',
                    severity: 'fault',
                    cause: 'Unknown'
                }
            };
        }
        logger('debug', 'Sources', `Resolving with ${sourceName} for: ${url}`);
        return this._instrumentedSourceCall(sourceName, 'resolve', url);
    }
    async reload() {
        await this.loadFolder();
    }
    async getTrackUrl(track, itag, isRecovering) {
        const instance = this.sourceMap.get(track.sourceName);
        if (!instance?.getTrackUrl) {
            throw new Error(`Source ${track.sourceName} not found or does not support getTrackUrl`);
        }
        return await instance.getTrackUrl(track, itag, isRecovering);
    }
    async getTrackStream(track, url, protocol, additionalData) {
        const instance = this.sourceMap.get(track.sourceName);
        if (!instance?.loadStream) {
            throw new Error(`Source ${track.sourceName} not found or does not support loadStream`);
        }
        return await instance.loadStream(track, url, protocol, additionalData);
    }
    async getChapters(track) {
        const sourceName = track.info?.sourceName;
        if (!sourceName)
            return [];
        const instance = this.sourceMap.get(sourceName);
        if (!instance ||
            typeof instance.getChapters !== 'function' ||
            !track.info) {
            return [];
        }
        return await instance.getChapters(track.info);
    }
    getAllSources() {
        return Array.from(this.sources.values());
    }
    getSource(name) {
        return this.sourceMap.get(name) || null;
    }
    getEnabledSourceNames() {
        const enabledNames = [];
        const sources = this.nodelink.options.sources;
        if (sources) {
            for (const sourceName in sources) {
                if (sources[sourceName]?.enabled) {
                    enabledNames.push(sourceName);
                }
            }
        }
        return enabledNames;
    }
}
