import { PassThrough } from 'node:stream';
import HLSHandler from "../playback/hls/HLSHandler.js";
import { encodeTrack, http1makeRequest, logger, makeRequest } from "../utils.js";
const DECRYPTION_KEY = 'IFYOUWANTTHEARTISTSTOGETPAIDDONOTDOWNLOADFROMMIXCLOUD';
const MIXCLOUD_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_MAX_PLAYLIST_LENGTH = 1000;
/**
 * Mixcloud source implementation.
 * @public
 */
export default class MixcloudSource {
    /**
     * Runtime NodeLink context.
     */
    nodelink;
    /**
     * Source configuration options.
     */
    config;
    /**
     * Supported Mixcloud URL patterns.
     */
    patterns;
    /**
     * Search aliases handled by this source.
     */
    searchTerms;
    /**
     * URL matching priority.
     */
    priority;
    /**
     * Creates a new Mixcloud source.
     * @param nodelink - Runtime NodeLink context.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.config = nodelink.options;
        this.patterns = [
            /https?:\/\/(?:(?:www|beta|m)\.)?mixcloud\.com\/(?<user>[^/]+)\/(?!stream|uploads|favorites|listens|playlists)(?<slug>[^/]+)\/?/i,
            /https?:\/\/(?:(?:www|beta|m)\.)?mixcloud\.com\/(?<user>[^/]+)\/playlists\/(?<playlist>[^/]+)\/?/i,
            /https?:\/\/(?:(?:www|beta|m)\.)?mixcloud\.com\/(?<id>[^/]+)\/(?<type>uploads|favorites|listens|stream)?\/?/i
        ];
        this.searchTerms = ['mcsearch'];
        this.priority = 90;
    }
    /**
     * Initializes source resources.
     * @returns Always true for this provider.
     */
    async setup() {
        return true;
    }
    /**
     * Returns a normalized error message string.
     * @param error - Unknown error payload.
     * @returns Human-readable message.
     */
    getErrorMessage(error) {
        return error instanceof Error ? error.message : String(error);
    }
    /**
     * Parses HTTP response body into a JSON object when possible.
     * @param body - Raw response body.
     * @returns Parsed object payload or null.
     */
    parseObjectBody(body) {
        if (body && typeof body === 'object' && !Array.isArray(body)) {
            return body;
        }
        if (typeof body === 'string') {
            try {
                const parsed = JSON.parse(body);
                return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                    ? parsed
                    : null;
            }
            catch {
                return null;
            }
        }
        return null;
    }
    /**
     * Creates a typed `empty` load result.
     * @returns Empty result payload.
     */
    emptyResult() {
        return { loadType: 'empty', data: {} };
    }
    /**
     * Creates a typed `error` load result.
     * @param message - Error message.
     * @returns Error result payload.
     */
    errorResult(message) {
        return { loadType: 'error', exception: { message, severity: 'fault' } };
    }
    /**
     * Narrows a source result to the Mixcloud track payload shape.
     * @param result - Source result payload.
     * @returns True when result contains Mixcloud track data.
     */
    isTrackResult(result) {
        return (result.loadType === 'track' &&
            typeof result.data === 'object' &&
            result.data !== null &&
            'pluginInfo' in result.data);
    }
    /**
     * Executes a Mixcloud GraphQL request.
     * @param query - GraphQL query string.
     * @returns HTTP response payload.
     */
    async _request(query) {
        const apiUrl = `https://app.mixcloud.com/graphql?query=${encodeURIComponent(query)}`;
        return makeRequest(apiUrl, {
            method: 'GET',
            headers: {
                'User-Agent': MIXCLOUD_USER_AGENT
            }
        });
    }
    /**
     * Converts seconds to milliseconds.
     * @param value - Duration in seconds.
     * @returns Duration in milliseconds.
     */
    toMilliseconds(value) {
        return typeof value === 'number' && Number.isFinite(value)
            ? Math.max(0, Math.round(value * 1000))
            : 0;
    }
    /**
     * Normalizes a Mixcloud URL into path segments.
     * @param url - Canonical Mixcloud URL.
     * @returns URL path segments without empty entries.
     */
    getMixcloudPathParts(url) {
        return (url.split('mixcloud.com/')[1] || '').split('/').filter(Boolean);
    }
    /**
     * Builds a Mixcloud track payload from a cloudcast node.
     * @param data - Cloudcast node payload.
     * @returns Encoded track payload.
     */
    _parseTrackData(data) {
        const pathParts = this.getMixcloudPathParts(data.url || '');
        const identifier = `${pathParts[0] || 'unknown'}_${pathParts[1] || 'unknown'}`;
        const info = {
            identifier,
            isSeekable: true,
            author: data.owner?.displayName || pathParts[0] || 'unknown',
            length: this.toMilliseconds(data.audioLength),
            isStream: false,
            position: 0,
            title: data.name || 'Unknown',
            uri: data.url || `https://www.mixcloud.com/${identifier}`,
            artworkUrl: data.picture?.url || null,
            isrc: null,
            sourceName: 'mixcloud'
        };
        const encodedInput = { ...info, details: [] };
        return {
            encoded: encodeTrack(encodedInput),
            info,
            pluginInfo: {
                encryptedHls: data.streamInfo?.hlsUrl,
                encryptedUrl: data.streamInfo?.url
            }
        };
    }
    /**
     * Performs Mixcloud cloudcast search.
     * @param query - Search query string.
     * @returns Search load result payload.
     */
    async search(query) {
        try {
            const apiUrl = `https://api.mixcloud.com/search/?q=${encodeURIComponent(query)}&type=cloudcast`;
            const response = await http1makeRequest(apiUrl, {
                headers: { 'User-Agent': MIXCLOUD_USER_AGENT },
                disableBodyCompression: true
            });
            if (response.error) {
                throw new Error(response.error);
            }
            const body = this.parseObjectBody(response.body);
            if (response.statusCode !== 200 || !body?.data) {
                logger('warn', 'Mixcloud', `Search API returned status ${response.statusCode}`);
                return this.emptyResult();
            }
            if (body.data.length === 0)
                return this.emptyResult();
            const tracks = body.data
                .map((item) => {
                const pathParts = this.getMixcloudPathParts(item.url || '');
                const info = {
                    identifier: `${pathParts[0] || 'unknown'}_${pathParts[1] || 'unknown'}`,
                    isSeekable: true,
                    author: item.user?.name || pathParts[0] || 'unknown',
                    length: this.toMilliseconds(item.audio_length),
                    isStream: false,
                    position: 0,
                    title: item.name || 'Unknown',
                    uri: item.url || '',
                    artworkUrl: item.pictures?.large || item.pictures?.medium || null,
                    isrc: null,
                    sourceName: 'mixcloud'
                };
                const encodedInput = { ...info, details: [] };
                return {
                    encoded: encodeTrack(encodedInput),
                    info,
                    pluginInfo: {}
                };
            })
                .filter((track) => track.info.uri.length > 0)
                .slice(0, this.config.search.maxResults || DEFAULT_MAX_RESULTS);
            if (tracks.length === 0)
                return this.emptyResult();
            return { loadType: 'search', data: tracks };
        }
        catch (error) {
            logger('error', 'Mixcloud', `Search failed: ${this.getErrorMessage(error)}`);
            return this.emptyResult();
        }
    }
    /**
     * Decrypts Mixcloud encrypted stream URLs.
     * @param ciphertextB64 - Base64-encoded encrypted payload.
     * @returns Decrypted URL string.
     */
    _decrypt(ciphertextB64) {
        const ciphertext = Buffer.from(ciphertextB64, 'base64');
        const key = Buffer.from(DECRYPTION_KEY);
        const decrypted = Buffer.alloc(ciphertext.length);
        for (let i = 0; i < ciphertext.length; i++) {
            decrypted[i] = (ciphertext[i] ?? 0) ^ (key[i % key.length] ?? 0);
        }
        return decrypted.toString('utf-8');
    }
    /**
     * Resolves a Mixcloud URL to track/playlist data.
     * @param url - Input URL.
     * @returns Load result payload.
     */
    async resolve(url) {
        if (this.patterns[0]?.test(url))
            return this._resolveTrack(url);
        if (this.patterns[1]?.test(url))
            return this._resolvePlaylist(url);
        if (this.patterns[2]?.test(url))
            return this._resolveUser(url);
        return this.emptyResult();
    }
    /**
     * Resolves a single Mixcloud track URL.
     * @param url - Track URL.
     * @returns Track or error result.
     */
    async _resolveTrack(url) {
        const pattern = this.patterns[0];
        if (!pattern)
            return this.emptyResult();
        const match = url.match(pattern);
        const groups = (match?.groups || {});
        const username = groups.user;
        const slug = groups.slug;
        if (!username || !slug)
            return this.emptyResult();
        try {
            const query = `{
        cloudcastLookup(lookup: {username: "${username}", slug: "${slug}"}) {
          audioLength
          name
          url
          owner { displayName username }
          picture(width: 1024, height: 1024) { url }
          streamInfo { hlsUrl url }
          restrictedReason
        }
      }`;
            const response = await this._request(query);
            const body = this.parseObjectBody(response.body);
            const cloudcast = body?.data?.cloudcastLookup;
            if (response.statusCode !== 200 || !cloudcast)
                return this.emptyResult();
            if (cloudcast.restrictedReason) {
                throw new Error(`Track restricted: ${cloudcast.restrictedReason}`);
            }
            return {
                loadType: 'track',
                data: this._parseTrackData(cloudcast)
            };
        }
        catch (error) {
            const message = this.getErrorMessage(error);
            logger('error', 'Mixcloud', `Track resolution failed: ${message}`);
            return this.errorResult(message);
        }
    }
    /**
     * Resolves a Mixcloud playlist URL.
     * @param url - Playlist URL.
     * @returns Playlist or error result.
     */
    async _resolvePlaylist(url) {
        const pattern = this.patterns[1];
        if (!pattern)
            return this.emptyResult();
        const match = url.match(pattern);
        const groups = (match?.groups || {});
        const user = groups.user;
        const slug = groups.playlist;
        if (!user || !slug)
            return this.emptyResult();
        try {
            const queryTemplate = (cursor) => `{
        playlistLookup(lookup: {username: "${user}", slug: "${slug}"}) {
          name
          items(first: 100${cursor ? `, after: "${cursor}"` : ''}) {
            edges {
              node {
                cloudcast {
                  audioLength
                  name
                  url
                  owner { displayName username }
                  picture(width: 1024, height: 1024) { url }
                  streamInfo { hlsUrl url }
                }
              }
            }
            pageInfo { endCursor hasNextPage }
          }
        }
      }`;
            const tracks = [];
            let cursor = null;
            let hasNextPage = true;
            let playlistName = 'Mixcloud Playlist';
            const maxTracks = this.config.playback.maxPlaylistLength || DEFAULT_MAX_PLAYLIST_LENGTH;
            while (hasNextPage && tracks.length < maxTracks) {
                const response = await this._request(queryTemplate(cursor));
                const body = this.parseObjectBody(response.body);
                const playlist = body?.data?.playlistLookup;
                if (response.statusCode !== 200 || !playlist?.items)
                    break;
                playlistName = playlist.name || playlistName;
                for (const edge of playlist.items.edges || []) {
                    const track = edge.node?.cloudcast;
                    if (!track?.url)
                        continue;
                    tracks.push(this._parseTrackData(track));
                    if (tracks.length >= maxTracks)
                        break;
                }
                cursor = playlist.items.pageInfo?.endCursor || null;
                hasNextPage = playlist.items.pageInfo?.hasNextPage === true;
            }
            if (tracks.length === 0)
                return this.emptyResult();
            return {
                loadType: 'playlist',
                data: {
                    info: { name: playlistName, selectedTrack: 0 },
                    tracks
                }
            };
        }
        catch (error) {
            const message = this.getErrorMessage(error);
            logger('error', 'Mixcloud', `Playlist resolution failed: ${message}`);
            return this.errorResult(message);
        }
    }
    /**
     * Resolves a Mixcloud user collection URL.
     * @param url - User collection URL.
     * @returns Playlist or error result.
     */
    async _resolveUser(url) {
        const pattern = this.patterns[2];
        if (!pattern)
            return this.emptyResult();
        const match = url.match(pattern);
        const groups = (match?.groups || {});
        const username = groups.id;
        const type = groups.type || 'uploads';
        if (!username)
            return this.emptyResult();
        try {
            const queryType = type === 'stream' ? 'stream' : type;
            const streamFragment = '... on Cloudcast { audioLength name url owner { displayName username } picture(width: 1024, height: 1024) { url } streamInfo { hlsUrl url } }';
            const queryTemplate = (cursor) => `{
        userLookup(lookup: {username: "${username}"}) {
          displayName
          ${queryType}(first: 100${cursor ? `, after: "${cursor}"` : ''}) {
            edges {
              node {
                ${type === 'stream' ? streamFragment : 'audioLength name url owner { displayName username } picture(width: 1024, height: 1024) { url } streamInfo { hlsUrl url }'}
              }
            }
            pageInfo { endCursor hasNextPage }
          }
        }
      }`;
            const tracks = [];
            let cursor = null;
            let hasNextPage = true;
            let userDisplayName = username;
            const maxTracks = this.config.playback.maxPlaylistLength || DEFAULT_MAX_PLAYLIST_LENGTH;
            while (hasNextPage && tracks.length < maxTracks) {
                const response = await this._request(queryTemplate(cursor));
                const body = this.parseObjectBody(response.body);
                const userLookup = body?.data?.userLookup;
                const list = userLookup?.[queryType];
                if (response.statusCode !== 200 || !list)
                    break;
                userDisplayName = userLookup?.displayName || userDisplayName;
                for (const edge of list.edges || []) {
                    const node = edge.node;
                    if (!node?.url)
                        continue;
                    tracks.push(this._parseTrackData(node));
                    if (tracks.length >= maxTracks)
                        break;
                }
                cursor = list.pageInfo?.endCursor || null;
                hasNextPage = list.pageInfo?.hasNextPage === true;
            }
            if (tracks.length === 0)
                return this.emptyResult();
            return {
                loadType: 'playlist',
                data: {
                    info: { name: `${userDisplayName} (${type})`, selectedTrack: 0 },
                    tracks
                }
            };
        }
        catch (error) {
            const message = this.getErrorMessage(error);
            logger('error', 'Mixcloud', `User resolution failed: ${message}`);
            return this.errorResult(message);
        }
    }
    /**
     * Resolves a stream URL for Mixcloud tracks.
     * @param decodedTrack - Decoded track metadata.
     * @param _itag - Unused itag parameter.
     * @param forceRefresh - Forces bypassing URL cache.
     * @returns Stream URL descriptor.
     */
    async getTrackUrl(decodedTrack, _itag, forceRefresh = false) {
        if (!forceRefresh) {
            const cached = this.nodelink.trackCacheManager?.get('mixcloud', decodedTrack.identifier);
            if (cached)
                return cached;
        }
        let encryptedHls = decodedTrack.pluginInfo?.encryptedHls;
        let encryptedUrl = decodedTrack.pluginInfo?.encryptedUrl;
        if (!encryptedHls && !encryptedUrl) {
            const resolved = await this._resolveTrack(decodedTrack.uri);
            if (this.isTrackResult(resolved)) {
                encryptedHls = resolved.data.pluginInfo.encryptedHls;
                encryptedUrl = resolved.data.pluginInfo.encryptedUrl;
            }
        }
        let result = null;
        if (encryptedHls) {
            result = {
                url: this._decrypt(encryptedHls),
                protocol: 'hls',
                format: 'mpegts'
            };
        }
        else if (encryptedUrl) {
            result = {
                url: this._decrypt(encryptedUrl),
                protocol: 'https',
                format: 'm4a'
            };
        }
        if (!result) {
            throw new Error('No stream URL available for Mixcloud track');
        }
        this.nodelink.trackCacheManager?.set('mixcloud', decodedTrack.identifier, result);
        return result;
    }
    /**
     * Loads and forwards Mixcloud audio stream.
     * @param _decodedTrack - Decoded track payload.
     * @param url - Resolved stream URL.
     * @param protocol - Stream protocol hint.
     * @param additionalData - Optional stream modifiers.
     * @returns Stream payload or structured exception.
     */
    async loadStream(_decodedTrack, url, protocol, additionalData) {
        try {
            if (protocol === 'hls') {
                const stream = new HLSHandler(url, {
                    type: 'mpegts',
                    strategy: 'segmented',
                    localAddress: this.nodelink.routePlanner?.getIP?.() ?? null,
                    headers: {
                        'User-Agent': MIXCLOUD_USER_AGENT,
                        Referer: 'https://www.mixcloud.com/'
                    },
                    startTime: additionalData?.startTime || 0
                });
                return { stream, type: 'mpegts' };
            }
            const response = await http1makeRequest(url, {
                method: 'GET',
                streamOnly: true,
                headers: {
                    'User-Agent': MIXCLOUD_USER_AGENT,
                    Referer: 'https://www.mixcloud.com/'
                }
            });
            if (response.error || !response.stream) {
                throw new Error(response.error || 'Failed to get stream');
            }
            const stream = new PassThrough();
            response.stream.on('data', (chunk) => {
                if (!stream.destroyed) {
                    stream.write(chunk);
                }
            });
            response.stream.on('end', () => {
                if (!stream.writableEnded) {
                    stream.emit('finishBuffering');
                    stream.end();
                }
            });
            response.stream.on('error', (error) => {
                logger('error', 'Mixcloud', `Upstream stream error: ${this.getErrorMessage(error)}`);
                if (!stream.destroyed) {
                    stream.destroy(error instanceof Error ? error : new Error(String(error)));
                }
            });
            return { stream, type: 'm4a' };
        }
        catch (error) {
            const message = this.getErrorMessage(error);
            logger('error', 'Mixcloud', `Failed to load stream: ${message}`);
            return { exception: { message, severity: 'fault' } };
        }
    }
}
