import fs from 'node:fs/promises';
import path from 'node:path';
/**
 * Migrates old flat configuration structures to the new hierarchical NodeLink schema.
 */
export function migrateConfig(oldConfig) {
    const newConfig = JSON.parse(JSON.stringify(oldConfig));
    const migrationMap = {
        host: 'server.host',
        port: 'server.port',
        password: 'server.password',
        useBunServer: 'server.useBunServer',
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
    };
    for (const [oldKey, newPath] of Object.entries(migrationMap)) {
        if (Object.hasOwn(oldConfig, oldKey)) {
            const value = oldConfig[oldKey];
            if (value === undefined)
                continue;
            // Do not overwrite already-migrated or explicit hierarchical values.
            if (getDeepValue(newConfig, newPath) !== undefined) {
                continue;
            }
            setDeepValue(newConfig, newPath, value);
        }
    }
    const cluster = newConfig.cluster;
    const network = newConfig.network;
    const clusterTimeouts = cluster?.timeouts;
    const connection = getDeepValue(newConfig, 'connection');
    if (connection) {
        setDeepValue(newConfig, 'network.connection', connection);
    }
    const metrics = getDeepValue(newConfig, 'metrics');
    if (metrics) {
        setDeepValue(newConfig, 'api.metrics', metrics);
    }
    if (typeof cluster?.commandTimeout === 'number' &&
        typeof clusterTimeouts?.heavyMs !== 'number') {
        setDeepValue(newConfig, 'cluster.timeouts.heavyMs', cluster.commandTimeout);
    }
    if (typeof cluster?.fastCommandTimeout === 'number' &&
        typeof clusterTimeouts?.fastMs !== 'number') {
        setDeepValue(newConfig, 'cluster.timeouts.fastMs', cluster.fastCommandTimeout);
    }
    if (!network?.proxy || typeof network.proxy !== 'object') {
        setDeepValue(newConfig, 'network.proxy', {
            enabled: false,
            strategy: 'RoundRobin',
            retries: 3,
            timeout: 10000,
            shuffleOnStart: true,
            list: []
        });
    }
    return newConfig;
}
function setDeepValue(obj, path, value) {
    const parts = path.split('.');
    if (parts.length === 0)
        return;
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!part)
            continue;
        if (!current[part] || typeof current[part] !== 'object') {
            current[part] = {};
        }
        current = current[part];
    }
    const leaf = parts[parts.length - 1];
    if (!leaf)
        return;
    current[leaf] = value;
}
function getDeepValue(obj, path) {
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
        if (!current ||
            typeof current !== 'object' ||
            Array.isArray(current) ||
            !(part in current)) {
            return undefined;
        }
        const next = current[part];
        if (next === undefined)
            return undefined;
        current = next;
    }
    return current;
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
export function toTsLiteral(obj, indent = 0) {
    const spaces = ' '.repeat(indent);
    const nextSpaces = ' '.repeat(indent + 2);
    if (obj === null)
        return 'null';
    if (typeof obj === 'string')
        return `'${obj.replace(/'/g, "\\'")}'`;
    if (typeof obj !== 'object')
        return String(obj);
    if (Array.isArray(obj)) {
        if (obj.length === 0)
            return '[]';
        const items = obj
            .map((v) => toTsLiteral(v, indent + 2))
            .join(`,\n${nextSpaces}`);
        return `[\n${nextSpaces}${items}\n${spaces}]`;
    }
    const keys = Object.keys(obj);
    if (keys.length === 0)
        return '{}';
    const props = keys
        .map((key) => {
        const val = obj[key];
        if (val === undefined)
            return null;
        const value = toTsLiteral(val, indent + 2);
        const validKey = /^[a-z_$][a-z0-9_$]*$/i.test(key) ? key : `'${key}'`;
        return `${validKey}: ${value}`;
    })
        .filter((v) => v !== null)
        .join(`,\n${nextSpaces}`);
    return `{\n${nextSpaces}${props}\n${spaces}}`;
}
/**
 * Persists a configuration object to config.ts if it was loaded from a legacy
 * source or the default template.
 *
 * @param config - The migrated configuration object.
 * @param fileName - The name of the source file.
 */
export async function persistConfig(config, fileName) {
    const isLegacy = fileName.endsWith('.js');
    const isDefault = fileName.startsWith('config.default');
    if (!isLegacy && !isDefault)
        return;
    try {
        const configTsPath = path.resolve(process.cwd(), 'config.ts');
        const literal = toTsLiteral(config);
        const content = `import type { NodelinkConfig } from './src/typings/config/config.types.ts'\n\nexport const config: NodelinkConfig = ${literal}\n\nexport default config\n`;
        await fs.writeFile(configTsPath, content, 'utf-8');
        console.log(`[INFO] Config: Automatically updated local config.ts from ${fileName}`);
    }
    catch (err) {
        console.warn(`[WARN] Config: Failed to persist updated configuration: ${err instanceof Error ? err.message : String(err)}`);
    }
}
