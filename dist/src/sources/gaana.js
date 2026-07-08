import { createDecipheriv } from 'node:crypto';
import { PassThrough } from 'node:stream';
import HLSHandler from '../playback/hls/HLSHandler.js';
import { parse as parsePlaylist } from '../playback/hls/PlaylistParser.js';
import { encodeTrack, getBestMatch, http1makeRequest, logger } from '../utils.js';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const API_URL = 'https://gaana.com/apiv2';
const STREAM_URL_API = 'https://gaana.com/api/stream-url';
const CRYPTO_KEY = Buffer.from('gy1t#b@jl(b$wtme', 'utf8');
const CRYPTO_IV = Buffer.from('xC4dmVJAq14BfntX', 'utf8');
const HLS_BASE_URL = 'https://vodhlsgaana-ebw.akamaized.net/';
/**
 * Gaana source implementation.
 * @public
 */
export default class GaanaSource {
    /**
     * Runtime NodeLink context.
     */
    nodelink;
    /**
     * Gaana source configuration block.
     */
    config;
    /**
     * Search aliases handled by this source.
     */
    searchTerms;
    /**
     * URL patterns handled by this source.
     */
    patterns;
    /**
     * URL resolution priority.
     */
    priority;
    /**
     * Max results returned by search.
     */
    maxSearchResults;
    /**
     * Max playlist load size.
     */
    playlistLoadLimit;
    /**
     * Max album load size.
     */
    albumLoadLimit;
    /**
     * Max artist load size.
     */
    artistLoadLimit;
    /**
     * Preferred direct stream quality.
     */
    streamQuality;
    /**
     * Creates a Gaana source instance.
     * @param nodelink - Runtime NodeLink context.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        const sourceConfig = this.nodelink.options.sources.gaana;
        this.config = sourceConfig;
        this.searchTerms = ['gnsearch', 'gaanasearch'];
        this.patterns = [
            /^@?(?:https?:\/\/)?(?:www\.)?gaana\.com\/(?<type>song|album|playlist|artist)\/(?<seokey>[\w-]+)(?:[?#].*)?$/
        ];
        this.priority = 70;
        this.maxSearchResults =
            this.asNumber(this.nodelink.options.search.maxResults) ?? 10;
        const maxAlbumPlaylistLength = this.asNumber(this.nodelink.options.playback.maxPlaylistLength) ?? 100;
        this.playlistLoadLimit =
            this.asNumber(this.config.playlistLoadLimit) ?? maxAlbumPlaylistLength;
        this.albumLoadLimit =
            this.asNumber(this.config.albumLoadLimit) ?? maxAlbumPlaylistLength;
        this.artistLoadLimit =
            this.asNumber(this.config.artistLoadLimit) ?? maxAlbumPlaylistLength;
        this.streamQuality = this.asString(this.config.streamQuality) || 'high';
    }
    /**
     * Initializes the source.
     * @returns False when source is disabled.
     */
    async setup() {
        if (this.config.enabled === false)
            return false;
        logger('info', 'Sources', 'Loaded Gaana source.');
        return true;
    }
    /**
     * Searches tracks/albums/artists/playlists in Gaana.
     * @param query - Search query.
     * @param _sourceTerm - Source alias.
     * @param searchType - Search type.
     * @returns Search result payload.
     */
    async search(query, _sourceTerm, searchType = 'track') {
        try {
            const params = {
                country: 'IN',
                page: 0,
                type: 'search',
                keyword: query
            };
            if (searchType === 'track')
                params.secType = 'track';
            else if (searchType === 'album')
                params.secType = 'album';
            else if (searchType === 'artist')
                params.secType = 'artist';
            else if (searchType === 'playlist')
                params.secType = 'playlist';
            const data = await this.getJson(params, `search/${encodeURIComponent(query)}`);
            const groups = this.asArrayRecords(data?.gr);
            if (groups.length === 0)
                return { loadType: 'empty', data: {} };
            const targetGroupName = searchType === 'track'
                ? 'Track'
                : searchType.charAt(0).toUpperCase() + searchType.slice(1);
            const group = groups.find((item) => this.asString(item.ty) === targetGroupName);
            const items = this.asArrayRecords(group?.gd).slice(0, this.maxSearchResults);
            if (items.length === 0)
                return { loadType: 'empty', data: {} };
            if (searchType === 'track') {
                const trackIdentifiers = items
                    .map((item) => this.asString(item.seo) || this.asString(item.id))
                    .filter((item) => Boolean(item));
                const tracks = await this.getTracks(trackIdentifiers);
                return tracks.length > 0
                    ? { loadType: 'search', data: tracks }
                    : { loadType: 'empty', data: {} };
            }
            const results = items
                .map((item) => this.mapCollectionResult(item, searchType))
                .filter((item) => item !== null);
            return results.length > 0
                ? { loadType: 'search', data: results }
                : { loadType: 'empty', data: {} };
        }
        catch (error) {
            const message = this.getErrorMessage(error);
            logger('error', 'Gaana', `Search error: ${message}`);
            return { loadType: 'error', exception: { message, severity: 'fault' } };
        }
    }
    /**
     * Resolves Gaana links.
     * @param url - Gaana URL.
     * @returns Source result payload.
     */
    async resolve(url) {
        const pattern = this.patterns[0];
        if (!pattern)
            return { loadType: 'empty', data: {} };
        const match = url.match(pattern);
        if (!match?.groups)
            return { loadType: 'empty', data: {} };
        const type = match.groups.type;
        const seokey = match.groups.seokey;
        if (!type || !seokey)
            return { loadType: 'empty', data: {} };
        try {
            if (type === 'song')
                return this.getSong(seokey);
            if (type === 'album')
                return this.getAlbum(seokey);
            if (type === 'playlist')
                return this.getPlaylist(seokey);
            if (type === 'artist')
                return this.getArtist(seokey);
            return { loadType: 'empty', data: {} };
        }
        catch (error) {
            const message = this.getErrorMessage(error);
            logger('error', 'Gaana', `Resolve error: ${message}`);
            return { loadType: 'error', exception: { message, severity: 'fault' } };
        }
    }
    /**
     * Resolves playback URL for a Gaana track.
     * @param decodedTrack - Decoded track metadata.
     * @returns Direct stream or mirror fallback payload.
     */
    async getTrackUrl(decodedTrack) {
        try {
            const decodedTrackRecord = decodedTrack;
            const pluginInfo = this.asRecord(decodedTrackRecord.pluginInfo);
            const pluginTrackId = this.asString(pluginInfo?.trackId);
            const trackId = pluginTrackId || decodedTrack.identifier;
            if (trackId && /^\d+$/.test(String(trackId))) {
                const streamInfo = await this.fetchDirectStream(String(trackId));
                if (streamInfo)
                    return streamInfo;
            }
        }
        catch (error) {
            logger('debug', 'Gaana', `Direct stream fetch failed for ${decodedTrack.title}: ${this.getErrorMessage(error)}`);
        }
        logger('warn', 'Gaana', `Direct playback for ${decodedTrack.title} failed. Falling back to default search matching.`);
        if (!this.nodelink.sources) {
            return {
                exception: {
                    message: 'Default source search is not available.',
                    severity: 'fault'
                }
            };
        }
        const searchResult = await this.nodelink.sources.searchWithDefault(`${decodedTrack.title} ${decodedTrack.author}`);
        const tracks = searchResult.loadType === 'search'
            ? this.toTrackInfoArray(searchResult.data)
            : [];
        const candidates = tracks.map((track) => ({
            info: {
                title: track.title,
                author: track.author,
                length: track.length,
                uri: track.uri
            }
        }));
        const bestMatch = getBestMatch(candidates, decodedTrack);
        if (!bestMatch) {
            return {
                exception: {
                    message: 'No suitable alternative found in default search.',
                    severity: 'fault'
                }
            };
        }
        const fallbackTrack = tracks.find((track) => track.title === bestMatch.info.title &&
            track.author === bestMatch.info.author &&
            track.length === bestMatch.info.length);
        if (!fallbackTrack) {
            return {
                exception: {
                    message: 'No suitable alternative found in default search.',
                    severity: 'fault'
                }
            };
        }
        const sourceManager = this.nodelink.sources;
        if (!sourceManager) {
            return {
                exception: {
                    message: 'Source manager is not available.',
                    severity: 'fault'
                }
            };
        }
        const streamInfo = await sourceManager.getTrackUrl(fallbackTrack);
        return { newTrack: { info: fallbackTrack }, ...streamInfo };
    }
    /**
     * Opens a Gaana stream.
     * @param _track - Decoded track metadata.
     * @param url - Stream URL.
     * @param protocol - Protocol hint.
     * @param additionalData - Additional segment metadata.
     * @returns Track stream payload.
     */
    async loadStream(_track, url, protocol, additionalData) {
        const proxy = this.getProxyConfig();
        if (protocol === 'hls') {
            const additional = this.asRecord(additionalData) || {};
            const stream = new HLSHandler(url, {
                type: 'mpegts',
                localAddress: this.nodelink.routePlanner?.getIP?.(),
                startTime: this.asNumber(additional.startTime) || 0,
                headers: this.getHeaders(),
                proxy
            });
            return { stream, type: 'mpegts' };
        }
        const additional = this.asRecord(additionalData) || {};
        const additionalSegments = this.normalizeSegments(additional.segments);
        if (additionalSegments.length > 0) {
            const stream = new PassThrough();
            let segments = additionalSegments;
            const startTime = this.asNumber(additional.startTime) || 0;
            if (startTime > 0) {
                let elapsed = 0;
                const startIndex = segments.findIndex((segment) => {
                    const duration = (segment.duration || 0) * 1000;
                    if (elapsed + duration > startTime)
                        return true;
                    elapsed += duration;
                    return false;
                });
                if (startIndex !== -1) {
                    segments = segments.slice(startIndex);
                }
            }
            const initUrl = this.asString(additional.initUrl) || null;
            void this.streamSegments(stream, initUrl, segments
                .map((segment) => segment.url)
                .filter((segmentUrl) => segmentUrl.length > 0));
            const format = this.asString(additional.format) || 'mp4';
            let type = 'mp4';
            if (format === 'ts' || format === 'mpegts')
                type = 'mpegts';
            else if (format === 'aac')
                type = 'aac';
            return { stream, type };
        }
        const { stream, error, statusCode } = await http1makeRequest(url, {
            method: 'GET',
            streamOnly: true,
            headers: this.getHeaders(),
            proxy
        });
        if (error || statusCode !== 200 || !stream) {
            return {
                exception: {
                    message: `Stream status ${statusCode || 'unknown'}: ${error || 'request failed'}`,
                    severity: 'fault'
                }
            };
        }
        let type = 'mp4';
        if (url.includes('.ts'))
            type = 'mpegts';
        else if (url.includes('.aac'))
            type = 'aac';
        const passthrough = new PassThrough();
        stream.on('data', (chunk) => {
            if (!passthrough.write(chunk))
                stream.pause();
        });
        passthrough.on('drain', () => {
            stream.resume();
        });
        stream.on('end', () => {
            if (!passthrough.writableEnded) {
                passthrough.emit('finishBuffering');
                passthrough.end();
            }
        });
        stream.on('error', (err) => {
            const streamError = err instanceof Error ? err : new Error(String(err));
            if (!passthrough.destroyed)
                passthrough.destroy(streamError);
        });
        return { stream: passthrough, type };
    }
    /**
     * Fetches and resolves a single Gaana song.
     * @param seokey - Song key.
     * @returns Track payload.
     */
    async getSong(seokey) {
        const data = await this.getJson({ type: 'songDetail', seokey }, `song/${seokey}`);
        const tracks = this.asArrayRecords(data?.tracks);
        const firstTrack = tracks[0];
        if (!firstTrack)
            return { loadType: 'empty', data: {} };
        const track = this.mapTrack(firstTrack);
        return track
            ? { loadType: 'track', data: track }
            : { loadType: 'empty', data: {} };
    }
    /**
     * Fetches and resolves a Gaana album.
     * @param seokey - Album key.
     * @returns Playlist payload.
     */
    async getAlbum(seokey) {
        const data = await this.getJson({ type: 'albumDetail', seokey }, `album/${seokey}`);
        const tracks = this.asArrayRecords(data?.tracks);
        if (tracks.length === 0)
            return { loadType: 'empty', data: {} };
        const album = this.asRecord(data?.album) || {};
        return this.buildPlaylist(this.asString(album.title) || 'Unknown Album', tracks, 'album', `https://gaana.com/album/${seokey}`, this.asString(album.atw) || null, this.asString(this.asRecord(this.asArrayRecords(album.artist)[0])?.name) || null);
    }
    /**
     * Fetches and resolves a Gaana playlist.
     * @param seokey - Playlist key.
     * @returns Playlist payload.
     */
    async getPlaylist(seokey) {
        const data = await this.getJson({ type: 'playlistDetail', seokey }, `playlist/${seokey}`);
        const tracks = this.asArrayRecords(data?.tracks);
        if (tracks.length === 0)
            return { loadType: 'empty', data: {} };
        const playlist = this.asRecord(data?.playlist) || {};
        return this.buildPlaylist(this.asString(playlist.title) || 'Unknown Playlist', tracks, 'playlist', `https://gaana.com/playlist/${seokey}`, this.asString(playlist.atw) || null);
    }
    /**
     * Fetches and resolves Gaana artist top tracks.
     * @param seokey - Artist key.
     * @returns Playlist payload.
     */
    async getArtist(seokey) {
        const detail = await this.getJson({ type: 'artistDetail', seokey }, `artist/${seokey}`);
        const artists = this.asArrayRecords(detail?.artist);
        const firstArtist = artists[0];
        if (!firstArtist)
            return { loadType: 'empty', data: {} };
        const artistToken = this.asString(firstArtist.artist_id);
        if (!artistToken)
            return { loadType: 'empty', data: {} };
        const tracksData = await this.getJson({
            type: 'artistTrackList',
            id: artistToken,
            language: '',
            order: 0,
            page: 0,
            sortBy: 'popularity'
        }, `artist/${seokey}`);
        const tracksArray = this.asArrayRecords(tracksData?.tracks);
        const entitiesArray = this.asArrayRecords(tracksData?.entities);
        const merged = tracksArray.length > 0 ? tracksArray : entitiesArray;
        if (merged.length === 0)
            return { loadType: 'empty', data: {} };
        return this.buildPlaylist(this.asString(firstArtist.name) || 'Unknown Artist', merged, 'artist', `https://gaana.com/artist/${seokey}`, this.asString(firstArtist.artwork_bio) || null);
    }
    /**
     * Builds playlist payload from Gaana item list.
     * @param name - Playlist display name.
     * @param tracksArray - Track list.
     * @param type - Collection type.
     * @param url - Source URL.
     * @param artwork - Artwork URL.
     * @param author - Optional author label.
     * @returns Source playlist payload.
     */
    buildPlaylist(name, tracksArray, type, url, artwork, author) {
        const tracks = tracksArray
            .map((item) => item.track_id || item.track_title
            ? this.mapTrack(item)
            : this.mapEntityTrack(item))
            .filter((item) => item !== null)
            .slice(0, this.getLoadLimit(type));
        const infoName = type === 'artist' ? `${name}'s Top Tracks` : name;
        return {
            loadType: 'playlist',
            data: {
                info: { name: infoName, selectedTrack: 0 },
                pluginInfo: { type, url, artwork, author: author || undefined },
                tracks
            }
        };
    }
    /**
     * Maps a Gaana track object to canonical track payload.
     * @param track - Raw Gaana track object.
     * @returns Encoded track payload.
     */
    mapTrack(track) {
        const title = this.asString(track.track_title) || this.asString(track.name);
        if (!title)
            return null;
        const duration = (this.asNumber(track.duration) ?? 0) * 1000;
        const artist = track.artist;
        const author = Array.isArray(artist)
            ? artist
                .map((item) => this.asString(this.asRecord(item)?.name))
                .filter((item) => Boolean(item))
                .join(', ')
            : this.asString(this.asRecord(artist)?.name) || 'Unknown Artist';
        const identifier = this.asString(track.track_id) || this.asString(track.seokey) || '';
        if (!identifier)
            return null;
        const seokey = this.asString(track.seokey);
        const uri = seokey ? `https://gaana.com/song/${seokey}` : '';
        const info = {
            identifier,
            isSeekable: true,
            author,
            length: duration,
            isStream: false,
            position: 0,
            title,
            uri,
            artworkUrl: this.asString(track.artwork_large) || this.asString(track.atw) || null,
            isrc: this.asString(track.isrc) || null,
            sourceName: 'gaana'
        };
        const encodedInput = { ...info, details: [] };
        return {
            encoded: encodeTrack(encodedInput),
            info,
            pluginInfo: {
                trackId: this.asString(track.track_id) || null,
                albumName: this.asString(track.album_title) || null,
                albumUrl: this.asString(track.albumseokey)
                    ? `https://gaana.com/album/${this.asString(track.albumseokey)}`
                    : null
            }
        };
    }
    /**
     * Maps Gaana entity payload to canonical track payload.
     * @param json - Raw entity payload.
     * @returns Encoded track payload.
     */
    mapEntityTrack(json) {
        const getEntityValue = (key) => {
            const entities = this.asArrayRecords(json.entity_info);
            return entities.find((item) => this.asString(item.key) === key)?.value;
        };
        const title = this.asString(json.name) || '';
        if (!title)
            return null;
        const duration = (this.asNumber(getEntityValue('duration')) ?? 0) * 1000;
        const artistsRaw = getEntityValue('artist');
        const artists = Array.isArray(artistsRaw)
            ? artistsRaw
                .map((item) => this.asString(this.asRecord(item)?.name))
                .filter((item) => Boolean(item))
                .join(', ')
            : '';
        const identifier = this.asString(json.entity_id) || '';
        const seokey = this.asString(json.seokey) || '';
        if (!identifier || !seokey)
            return null;
        const info = {
            identifier,
            isSeekable: true,
            author: artists,
            length: duration,
            isStream: false,
            position: 0,
            title,
            uri: `https://gaana.com/song/${seokey}`,
            artworkUrl: this.asString(json.atw) || null,
            isrc: this.asString(getEntityValue('isrc')) || null,
            sourceName: 'gaana'
        };
        const encodedInput = { ...info, details: [] };
        return {
            encoded: encodeTrack(encodedInput),
            info,
            pluginInfo: {}
        };
    }
    /**
     * Maps non-track search entries as pseudo-track payloads.
     * @param item - Search item.
     * @param type - Search type.
     * @returns Encoded pseudo-track payload.
     */
    mapCollectionResult(item, type) {
        const title = this.asString(item.ti) || this.asString(item.name) || 'Unknown';
        const seokey = this.asString(item.seo) || '';
        const uri = `https://gaana.com/${type}/${seokey}`;
        const info = {
            identifier: seokey,
            isSeekable: true,
            author: this.asString(item.sti) || 'Gaana',
            length: 0,
            isStream: false,
            position: 0,
            title,
            uri,
            artworkUrl: this.asString(item.aw) || this.asString(item.atw) || null,
            isrc: null,
            sourceName: 'gaana'
        };
        const encodedInput = { ...info, details: [] };
        return { encoded: encodeTrack(encodedInput), info, pluginInfo: { type } };
    }
    /**
     * Fetches direct stream metadata from Gaana API.
     * @param trackId - Numeric Gaana track ID.
     * @returns Track URL payload or null.
     */
    async fetchDirectStream(trackId) {
        const quality = this.streamQuality || 'high';
        const params = new URLSearchParams({
            quality,
            track_id: trackId,
            stream_format: 'mp4'
        });
        const proxy = this.getProxyConfig();
        const { body, error, statusCode } = await http1makeRequest(STREAM_URL_API, {
            method: 'POST',
            headers: {
                ...this.getHeaders(),
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: params.toString(),
            proxy
        });
        const data = this.asRecord(body);
        const dataNode = this.asRecord(data?.data);
        const streamPath = this.asString(dataNode?.stream_path);
        if (error ||
            statusCode !== 200 ||
            this.asString(data?.api_status) !== 'success' ||
            !streamPath) {
            return null;
        }
        const hlsUrl = this.decryptStreamPath(streamPath);
        if (!hlsUrl)
            return null;
        try {
            const manifest = await this.parseHlsManifest(hlsUrl);
            if (manifest.segments.length === 0)
                return null;
            const firstSegment = manifest.segments[0];
            const firstSegmentUrl = firstSegment?.url || '';
            let format = 'mp4';
            if (firstSegmentUrl.includes('.m4s'))
                format = 'fmp4';
            else if (firstSegmentUrl.includes('.mp4'))
                format = 'mp4';
            else if (firstSegmentUrl.includes('.ts'))
                format = 'mpegts';
            else if (firstSegmentUrl.includes('.aac'))
                format = 'aac';
            return {
                url: hlsUrl,
                protocol: 'hls',
                format: format === 'mpegts' ? 'mpegts' : 'mp4',
                additionalData: {
                    initUrl: firstSegment?.map?.uri,
                    segments: manifest.segments,
                    format
                }
            };
        }
        catch (error) {
            logger('debug', 'Gaana', `Manifest parsing failed: ${this.getErrorMessage(error)}. Using HLS protocol as fallback.`);
            return {
                url: hlsUrl,
                protocol: 'hls',
                format: 'mpegts'
            };
        }
    }
    /**
     * Decrypts Gaana HLS stream path.
     * @param encryptedData - Encrypted stream path.
     * @returns Absolute HLS URL.
     */
    decryptStreamPath(encryptedData) {
        try {
            const offset = Number.parseInt(encryptedData[0] || '', 10);
            if (Number.isNaN(offset))
                return '';
            const ciphertextB64 = encryptedData.substring(offset + 16);
            const ciphertext = Buffer.from(`${ciphertextB64}==`, 'base64');
            const decipher = createDecipheriv('aes-128-cbc', CRYPTO_KEY, CRYPTO_IV);
            decipher.setAutoPadding(false);
            let decrypted = decipher.update(ciphertext);
            decrypted = Buffer.concat([decrypted, decipher.final()]);
            let rawText = decrypted.toString('utf8').replace(/\0/g, '').trim();
            rawText = rawText
                .split('')
                .filter((char) => {
                const code = char.charCodeAt(0);
                return code >= 32 && code <= 126;
            })
                .join('');
            if (rawText.includes('/hls/')) {
                const pathStart = rawText.indexOf('hls/');
                return HLS_BASE_URL + rawText.substring(pathStart);
            }
            return '';
        }
        catch {
            return '';
        }
    }
    /**
     * Parses HLS manifest and resolves best media playlist.
     * @param url - HLS URL.
     * @returns Parsed media playlist.
     */
    async parseHlsManifest(url) {
        const proxy = this.getProxyConfig();
        const { body } = await http1makeRequest(url, {
            headers: this.getHeaders(),
            proxy
        });
        if (typeof body !== 'string')
            throw new Error('Empty manifest');
        let parsed = parsePlaylist(body, url);
        if (parsed.isMaster) {
            const bestVariant = parsed.variants[0];
            if (!bestVariant)
                throw new Error('No HLS variants available');
            const { body: variantText } = await http1makeRequest(bestVariant.url, {
                headers: this.getHeaders(),
                proxy
            });
            if (typeof variantText !== 'string') {
                throw new Error('Variant manifest is empty');
            }
            parsed = parsePlaylist(variantText, bestVariant.url);
            if (parsed.isMaster)
                throw new Error('Nested master playlist not supported');
        }
        return {
            segments: parsed.segments
        };
    }
    /**
     * Streams HLS segment queue into output stream.
     * @param outputStream - Output stream.
     * @param initUrl - Optional init segment URL.
     * @param segments - Segment URLs.
     */
    async streamSegments(outputStream, initUrl, segments) {
        const queue = [];
        if (initUrl)
            queue.push(initUrl);
        queue.push(...segments);
        try {
            for (const segmentUrl of queue) {
                if (outputStream.destroyed)
                    break;
                await this.streamUrlChunk(outputStream, segmentUrl);
            }
        }
        catch (error) {
            if (!outputStream.destroyed) {
                outputStream.emit('error', error);
            }
        }
        finally {
            if (!outputStream.destroyed) {
                outputStream.emit('finishBuffering');
                outputStream.end();
            }
        }
    }
    /**
     * Streams one segment URL into output stream.
     * @param outputStream - Output stream.
     * @param url - Segment URL.
     * @returns True when chunk succeeded.
     */
    async streamUrlChunk(outputStream, url) {
        try {
            const proxy = this.getProxyConfig();
            const { stream, statusCode, error } = await http1makeRequest(url, {
                method: 'GET',
                streamOnly: true,
                headers: this.getHeaders(),
                proxy
            });
            if (error || statusCode !== 200 || !stream) {
                logger('warn', 'Gaana', `Segment fetch failed: ${error || statusCode}`);
                return false;
            }
            await new Promise((resolve, reject) => {
                stream.on('data', (chunk) => {
                    if (!outputStream.destroyed)
                        outputStream.write(chunk);
                });
                stream.once('end', () => resolve());
                stream.once('error', reject);
            });
            return true;
        }
        catch (error) {
            logger('warn', 'Gaana', `Segment stream error: ${this.getErrorMessage(error)}`);
            return false;
        }
    }
    /**
     * Fetches one or more tracks by identifiers.
     * @param identifiers - Song identifiers.
     * @returns Track payload list.
     */
    async getTracks(identifiers) {
        if (identifiers.length === 0)
            return [];
        const tracks = await Promise.all(identifiers.map(async (id) => {
            const trackResult = await this.getSong(id);
            return trackResult.loadType === 'track'
                ? this.extractTrackData(trackResult.data)
                : null;
        }));
        return tracks.filter((item) => item !== null);
    }
    /**
     * Performs Gaana API request.
     * @param params - Query params.
     * @param query - Relative page query for referer.
     * @returns Parsed object payload.
     */
    async getJson(params, query = '') {
        const url = `${API_URL}?${new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString()}`;
        const proxy = this.getProxyConfig();
        const { body, statusCode, error } = await http1makeRequest(url, {
            method: 'POST',
            headers: this.getHeaders(query),
            disableBodyCompression: true,
            proxy
        });
        if (error || statusCode !== 200 || !body)
            return null;
        if (typeof body === 'string') {
            try {
                return this.asRecord(JSON.parse(body));
            }
            catch {
                return null;
            }
        }
        return this.asRecord(body);
    }
    /**
     * Returns source-specific headers.
     * @param query - Optional referer suffix.
     * @returns HTTP headers.
     */
    getHeaders(query = '') {
        return {
            'User-Agent': USER_AGENT,
            Accept: 'application/json, text/plain, */*',
            Origin: 'https://gaana.com',
            Referer: `https://gaana.com/${query}`
        };
    }
    /**
     * Returns load limit by collection type.
     * @param type - Collection type.
     * @returns Max load size.
     */
    getLoadLimit(type) {
        if (type === 'album')
            return this.albumLoadLimit;
        if (type === 'artist')
            return this.artistLoadLimit;
        return this.playlistLoadLimit;
    }
    /**
     * Gets proxy configuration.
     * @returns Proxy configuration object or null.
     */
    getProxyConfig() {
        const proxy = this.asRecord(this.config.network?.proxy);
        const url = this.asString(proxy?.url);
        if (!url)
            return undefined;
        const username = this.asString(proxy?.username) || undefined;
        const password = this.asString(proxy?.password) || undefined;
        return { url, username, password };
    }
    /**
     * Converts unknown search data into best-match candidates.
     * @param data - Unknown search payload.
     * @returns Candidate list.
     */
    toTrackInfoArray(data) {
        if (!Array.isArray(data))
            return [];
        const tracks = [];
        for (const item of data) {
            const info = this.asRecord(this.asRecord(item)?.info);
            if (!info)
                continue;
            const identifier = this.asString(info.identifier);
            const isSeekable = this.asBoolean(info.isSeekable);
            const author = this.asString(info.author);
            const length = this.asNumber(info.length);
            const isStream = this.asBoolean(info.isStream);
            const position = this.asNumber(info.position);
            const title = this.asString(info.title);
            const uri = this.asString(info.uri);
            const sourceName = this.asString(info.sourceName);
            if (identifier === null ||
                isSeekable === null ||
                author === null ||
                length === null ||
                isStream === null ||
                position === null ||
                title === null ||
                uri === null ||
                sourceName === null) {
                continue;
            }
            tracks.push({
                identifier,
                isSeekable,
                author,
                length,
                isStream,
                position,
                title,
                uri,
                artworkUrl: this.asString(info.artworkUrl) || null,
                isrc: this.asString(info.isrc) || null,
                sourceName
            });
        }
        return tracks;
    }
    /**
     * Extracts canonical track payload from unknown object.
     * @param data - Unknown payload.
     * @returns Track payload or null.
     */
    extractTrackData(data) {
        const object = this.asRecord(data);
        const info = this.asRecord(object?.info);
        if (!object || !info)
            return null;
        const identifier = this.asString(info.identifier);
        const isSeekable = this.asBoolean(info.isSeekable);
        const author = this.asString(info.author);
        const length = this.asNumber(info.length);
        const isStream = this.asBoolean(info.isStream);
        const position = this.asNumber(info.position);
        const title = this.asString(info.title);
        const uri = this.asString(info.uri);
        const sourceName = this.asString(info.sourceName);
        const encoded = this.asString(object.encoded);
        const pluginInfo = this.asRecord(object.pluginInfo);
        if (identifier === null ||
            isSeekable === null ||
            author === null ||
            length === null ||
            isStream === null ||
            position === null ||
            title === null ||
            uri === null ||
            sourceName === null ||
            encoded === null) {
            return null;
        }
        return {
            encoded,
            info: {
                identifier,
                isSeekable,
                author,
                length,
                isStream,
                position,
                title,
                uri,
                artworkUrl: this.asString(info.artworkUrl) || null,
                isrc: this.asString(info.isrc) || null,
                sourceName
            },
            pluginInfo: pluginInfo || {}
        };
    }
    /**
     * Normalizes unknown segment array payload.
     * @param value - Unknown segment payload.
     * @returns Segment list with URL and duration.
     */
    normalizeSegments(value) {
        if (!Array.isArray(value))
            return [];
        const result = [];
        for (const item of value) {
            const segment = this.asRecord(item);
            const segmentUrl = this.asString(segment?.url);
            if (!segmentUrl)
                continue;
            result.push({
                url: segmentUrl,
                duration: this.asNumber(segment?.duration) ?? 0
            });
        }
        return result;
    }
    /**
     * Casts unknown value to record.
     * @param value - Unknown value.
     * @returns Record or null.
     */
    asRecord(value) {
        return value && typeof value === 'object' && !Array.isArray(value)
            ? value
            : null;
    }
    /**
     * Casts unknown value to record array.
     * @param value - Unknown value.
     * @returns Record array.
     */
    asArrayRecords(value) {
        if (!Array.isArray(value))
            return [];
        return value
            .map((item) => this.asRecord(item))
            .filter((item) => item !== null);
    }
    /**
     * Casts unknown value to string.
     * @param value - Unknown value.
     * @returns String or null.
     */
    asString(value) {
        return typeof value === 'string' ? value : null;
    }
    /**
     * Casts unknown value to finite number.
     * @param value - Unknown value.
     * @returns Number or null.
     */
    asNumber(value) {
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }
    /**
     * Casts unknown value to boolean.
     * @param value - Unknown value.
     * @returns Boolean or null.
     */
    asBoolean(value) {
        return typeof value === 'boolean' ? value : null;
    }
    /**
     * Normalizes unknown errors to string.
     * @param error - Unknown error.
     * @returns Error message.
     */
    getErrorMessage(error) {
        return error instanceof Error ? error.message : String(error);
    }
}
