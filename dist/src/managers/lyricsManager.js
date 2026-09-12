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
import { alignLyrics } from '../modules/lyricsAligner.js';
import { logger } from '../utils.js';
const getErrorMessage = (error) => error instanceof Error ? error.message : String(error);
const isTrackInfoLike = (value) => typeof value === 'object' && value !== null;
const getTrackInfoFromResolve = (result, fallback) => {
    if (result.loadType === 'error')
        return fallback;
    const data = result.data;
    if (!isTrackInfoLike(data))
        return fallback;
    const maybeInfo = data.info;
    if (isTrackInfoLike(maybeInfo))
        return maybeInfo;
    return data;
};
const isLyricsSourceEnabled = (lyricsConfig, sourceName) => {
    const sourceConfig = lyricsConfig?.[sourceName];
    if (typeof sourceConfig !== 'object' || sourceConfig === null)
        return false;
    const enabled = sourceConfig.enabled;
    return enabled === true;
};
export default class LyricsManager {
    nodelink;
    lyricsSources;
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.lyricsSources = new Map();
    }
    async loadFolder() {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const lyricsDir = path.join(__dirname, '../lyrics');
        this.lyricsSources.clear();
        try {
            await fs.access(lyricsDir);
            const files = await fs.readdir(lyricsDir);
            const jsFiles = files.filter((f) => f.endsWith('.js') || f.endsWith('.ts'));
            const toLoad = jsFiles.filter((f) => {
                const name = path.basename(f, path.extname(f));
                return isLyricsSourceEnabled(this.nodelink.options?.lyrics, name);
            });
            await Promise.all(toLoad.map(async (file) => {
                const name = path.basename(file, path.extname(file));
                const filePath = path.join(lyricsDir, file);
                const fileUrl = new URL(`file://${filePath.replace(/\\/g, '/')}`);
                const importedModule = (await import(__rewriteRelativeImportExtension(fileUrl.href)));
                const Mod = importedModule.default;
                if (typeof Mod !== 'function') {
                    logger('warn', 'Lyrics', `Invalid lyrics source module export for: ${name}`);
                    return;
                }
                const instance = new Mod(this.nodelink);
                if (await instance.setup()) {
                    this.lyricsSources.set(name, instance);
                    logger('info', 'Lyrics', `Loaded lyrics source: ${name}`);
                }
                else {
                    logger('error', 'Lyrics', `Failed setup for lyrics source: ${name}; source not available.`);
                }
            }));
        }
        catch {
            logger('info', 'Lyrics', `Lyrics directory not found, creating at: ${lyricsDir}`);
            await fs.mkdir(lyricsDir, { recursive: true });
        }
    }
    async loadLyrics(decodedTrack, language, skipTrackSource = false) {
        if (!decodedTrack?.info?.sourceName || !decodedTrack.info?.uri) {
            logger('warn', 'Lyrics', 'Invalid track object provided to loadLyrics', decodedTrack);
            return {
                loadType: 'error',
                data: { message: 'Invalid track object provided.', severity: 'common' }
            };
        }
        logger('debug', 'Lyrics', `Loading lyrics for track: ${decodedTrack.info.title}`);
        if (!this.nodelink.sources?.resolve) {
            logger('warn', 'Lyrics', 'Source manager is unavailable for lyrics loading');
            return {
                loadType: 'error',
                data: {
                    message: 'Source manager is unavailable.',
                    severity: 'fault'
                }
            };
        }
        const reliableTrackData = await this.nodelink.sources.resolve(decodedTrack.info.uri);
        if (reliableTrackData.loadType !== 'track') {
            logger('warn', 'Lyrics', `Could not re-fetch track information for ${decodedTrack.info.title}`);
            return {
                loadType: 'error',
                data: {
                    message: 'Could not re-fetch track information before loading lyrics.',
                    severity: 'fault'
                }
            };
        }
        const trackInfo = getTrackInfoFromResolve(reliableTrackData, decodedTrack.info);
        const sourceName = trackInfo.sourceName;
        const lyricsSource = sourceName
            ? this.lyricsSources.get(sourceName)
            : undefined;
        const isYouTube = sourceName === 'youtube' || sourceName === 'ytmusic';
        let youtubeCaptions = null;
        if (lyricsSource && !skipTrackSource) {
            if (isYouTube) {
                try {
                    const result = await lyricsSource.getLyrics(trackInfo, language);
                    if (result && result.loadType === 'lyrics') {
                        youtubeCaptions = result;
                    }
                }
                catch (e) {
                    logger('warn', 'Lyrics', `Failed to fetch YouTube captions for alignment: ${getErrorMessage(e)}`);
                }
            }
            else {
                const lyrics = await lyricsSource.getLyrics(trackInfo, language);
                if (lyrics && lyrics.loadType !== 'empty') {
                    if (lyrics.loadType === 'lyrics') {
                        lyrics.data.provider = sourceName;
                    }
                    return lyrics;
                }
            }
        }
        const sources = new Set([
            ...(this.nodelink.options.lyrics?.preferredSources ?? []),
            ...this.lyricsSources.keys()
        ]);
        for (const name of sources) {
            const source = this.lyricsSources.get(name);
            if (!source || name === sourceName)
                continue;
            logger('debug', 'Lyrics', `Trying lyrics source ${name} for ${trackInfo?.title || 'Unknown Title'}.`);
            const lyrics = await source.getLyrics(trackInfo, language);
            if (lyrics && lyrics.loadType !== 'empty') {
                if (isYouTube &&
                    youtubeCaptions?.loadType === 'lyrics' &&
                    lyrics.loadType === 'lyrics' &&
                    lyrics.data.synced &&
                    Array.isArray(lyrics.data.lines) &&
                    Array.isArray(youtubeCaptions.data.lines)) {
                    try {
                        logger('debug', 'Lyrics', `Aligning ${name} lyrics with YouTube timing...`);
                        const alignedLines = alignLyrics(lyrics.data.lines, youtubeCaptions.data);
                        lyrics.data.lines = alignedLines;
                    }
                    catch (alignErr) {
                        logger('warn', 'Lyrics', `Failed to align lyrics: ${getErrorMessage(alignErr)}`);
                    }
                }
                if (lyrics.loadType === 'lyrics') {
                    lyrics.data.provider = name;
                }
                return lyrics;
            }
        }
        if (isYouTube && youtubeCaptions?.loadType === 'lyrics') {
            youtubeCaptions.data.provider = sourceName;
            return youtubeCaptions;
        }
        logger('debug', 'Lyrics', `No lyrics found for ${trackInfo?.title || 'Unknown Track'}`);
        return { loadType: 'empty', data: {} };
    }
}
