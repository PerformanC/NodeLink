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
const getLyricsQualityTier = (result) => {
    if (result.loadType !== 'lyrics')
        return 0;
    const lines = result.data.lines ?? [];
    if (lines.some((line) => Array.isArray(line.words) && line.words.length > 0)) {
        return 3;
    }
    if (result.data.synced)
        return 2;
    return 1;
};
const enrichTemporalMetadata = (data, trackLengthMs) => {
    const lines = data.lines;
    if (!lines || lines.length === 0)
        return;
    const first = lines[0];
    if (first && first.time > 0 && data.introEndMs === undefined) {
        data.introEndMs = first.time;
    }
    const last = lines[lines.length - 1];
    if (last && data.outroStartMs === undefined) {
        const lastEnd = last.time + Math.max(0, last.duration || 0);
        if (trackLengthMs && trackLengthMs > lastEnd && lastEnd > 0) {
            data.outroStartMs = lastEnd;
        }
        else if (!last.duration && last.time > 0) {
            data.outroStartMs = last.time;
        }
    }
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
    /* INFO: A provider that throws must not abort the search, so a throw becomes an error result like any other failure */
    async _fetchFrom(source, name, trackInfo, language) {
        try {
            return await source.getLyrics(trackInfo, language);
        }
        catch (e) {
            const message = getErrorMessage(e);
            logger('warn', 'Lyrics', `Lyrics source ${name} threw: ${message}`);
            return { loadType: 'error', data: { message, severity: 'fault' } };
        }
    }
    async loadLyrics(decodedTrack, language, skipTrackSource = false, requestedSource, type = 'lyrics') {
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
            logger('warn', 'Lyrics', `Could not re-fetch track information for ${decodedTrack.info.title}, using the provided track information instead.`);
        }
        const trackInfo = reliableTrackData.loadType === 'track'
            ? getTrackInfoFromResolve(reliableTrackData, decodedTrack.info)
            : decodedTrack.info;
        if (requestedSource?.trim()) {
            const requestedName = requestedSource.trim().toLowerCase();
            const requestedLyricsSource = this.lyricsSources.get(requestedName);
            if (!requestedLyricsSource) {
                logger('warn', 'Lyrics', `Requested lyrics source is not available: ${requestedName}`);
                return {
                    loadType: 'error',
                    data: {
                        message: `Lyrics source '${requestedName}' is not available.`,
                        severity: 'common'
                    }
                };
            }
            logger('debug', 'Lyrics', `Loading lyrics from ${requestedName} for ${trackInfo?.title || 'Unknown Title'}.`);
            const requestedLyrics = await requestedLyricsSource.getLyrics(trackInfo, language);
            if (requestedLyrics?.loadType === 'lyrics') {
                requestedLyrics.data.provider = requestedName;
            }
            return requestedLyrics;
        }
        const sourceName = trackInfo.sourceName;
        const lyricsSource = sourceName
            ? this.lyricsSources.get(sourceName)
            : undefined;
        const isYouTube = sourceName === 'youtube' || sourceName === 'ytmusic';
        if (type === 'onlyCaptions') {
            if (!lyricsSource || skipTrackSource) {
                return { loadType: 'empty', data: {} };
            }
            const captions = await this._fetchFrom(lyricsSource, sourceName, trackInfo, language);
            if (captions?.loadType === 'lyrics') {
                captions.data.provider = sourceName;
                captions.data.kind = 'captions';
                enrichTemporalMetadata(captions.data, trackInfo.length);
            }
            return captions;
        }
        let youtubeCaptions = null;
        let lastError = null;
        let sawEmpty = false;
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
                const lyrics = await this._fetchFrom(lyricsSource, sourceName, trackInfo, language);
                if (lyrics?.loadType === 'lyrics') {
                    lyrics.data.provider = sourceName;
                    lyrics.data.kind = 'lyrics';
                    enrichTemporalMetadata(lyrics.data, trackInfo.length);
                    return lyrics;
                }
                if (lyrics?.loadType === 'error') {
                    lastError = lyrics;
                }
                else {
                    sawEmpty = true;
                }
            }
        }
        const sources = new Set([
            ...(this.nodelink.options.lyrics?.preferredSources ?? []),
            ...this.lyricsSources.keys()
        ]);
        let bestCandidate = null;
        for (const name of sources) {
            const source = this.lyricsSources.get(name);
            if (!source || name === sourceName)
                continue;
            logger('debug', 'Lyrics', `Trying lyrics source ${name} for ${trackInfo?.title || 'Unknown Title'}.`);
            const lyrics = await this._fetchFrom(source, name, trackInfo, language);
            if (lyrics?.loadType === 'error') {
                lastError = lyrics;
                continue;
            }
            if (lyrics?.loadType === 'lyrics') {
                const tier = getLyricsQualityTier(lyrics);
                if (!bestCandidate || tier > bestCandidate.tier) {
                    bestCandidate = { result: lyrics, name, tier };
                }
                if (tier === 3) {
                    break;
                }
                continue;
            }
            sawEmpty = true;
        }
        if (bestCandidate) {
            const { result: lyrics, name } = bestCandidate;
            if (isYouTube &&
                youtubeCaptions?.loadType === 'lyrics' &&
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
            lyrics.data.provider = name;
            lyrics.data.kind = 'lyrics';
            enrichTemporalMetadata(lyrics.data, trackInfo.length);
            return lyrics;
        }
        if (isYouTube && youtubeCaptions?.loadType === 'lyrics') {
            youtubeCaptions.data.provider = sourceName;
            youtubeCaptions.data.kind = 'captions';
            enrichTemporalMetadata(youtubeCaptions.data, trackInfo.length);
            return youtubeCaptions;
        }
        /* INFO: Only report a failure when every provider that answered failed; otherwise the track simply has no lyrics */
        if (lastError && !sawEmpty) {
            return lastError;
        }
        logger('debug', 'Lyrics', `No lyrics found for ${trackInfo?.title || 'Unknown Track'}`);
        return { loadType: 'empty', data: {} };
    }
}
