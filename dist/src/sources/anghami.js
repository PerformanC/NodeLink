import { encodeTrack, getBestMatch, logger, makeRequest } from '../utils.js';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
const AnghamiSongBatchDecoder = {
    decode(buffer) {
        const reader = new ProtoReader(buffer);
        const result = {
            response: {},
            takendownSongIds: [],
            missingSongIds: []
        };
        while (reader.pos < reader.len) {
            const tag = reader.uint32();
            const fieldNo = tag >>> 3;
            const wireType = tag & 7;
            switch (fieldNo) {
                case 1:
                    reader.skipType(wireType);
                    break;
                case 2: {
                    const end = reader.uint32() + reader.pos;
                    let key = '';
                    let value = null;
                    while (reader.pos < end) {
                        const mapTag = reader.uint32();
                        const mapFieldNo = mapTag >>> 3;
                        const mapWireType = mapTag & 7;
                        switch (mapFieldNo) {
                            case 1:
                                key = reader.string();
                                break;
                            case 2:
                                value = AnghamiSongDecoder.decode(reader, reader.uint32());
                                break;
                            default:
                                reader.skipType(mapWireType);
                                break;
                        }
                    }
                    if (key && value)
                        result.response[key] = value;
                    break;
                }
                case 4:
                    result.takendownSongIds.push(reader.string());
                    break;
                case 5:
                    result.missingSongIds.push(reader.string());
                    break;
                default:
                    reader.skipType(wireType);
                    break;
            }
        }
        return result;
    }
};
const AnghamiSongDecoder = {
    decode(reader, len) {
        const end = len === undefined ? reader.len : reader.pos + len;
        const message = {
            id: '',
            title: '',
            album: '',
            albumID: '',
            artist: '',
            artistID: '',
            track: 0,
            year: '',
            duration: 0,
            coverArt: '',
            genre: '',
            keywords: [],
            description: '',
            playervideo: '',
            videoid: '',
            thumbnailid: '',
            artistType: 0,
            artistGender: 0
        };
        while (reader.pos < end) {
            const tag = reader.uint32();
            const fieldNo = tag >>> 3;
            const wireType = tag & 7;
            switch (fieldNo) {
                case 1:
                    message.id = reader.string();
                    break;
                case 2:
                    message.title = reader.string();
                    break;
                case 3:
                    message.album = reader.string();
                    break;
                case 4:
                    message.albumID = reader.string();
                    break;
                case 5:
                    message.artist = reader.string();
                    break;
                case 6:
                    message.artistID = reader.string();
                    break;
                case 7:
                    message.track = reader.int32();
                    break;
                case 8:
                    message.year = reader.string();
                    break;
                case 9:
                    message.duration = reader.float();
                    break;
                case 10:
                    message.coverArt = reader.string();
                    break;
                case 12:
                    message.genre = reader.string();
                    break;
                case 14:
                    message.keywords.push(reader.string());
                    break;
                case 17:
                    message.description = reader.string();
                    break;
                case 28:
                    message.playervideo = reader.string();
                    break;
                case 46:
                    message.videoid = reader.string();
                    break;
                case 47:
                    message.thumbnailid = reader.string();
                    break;
                case 61:
                    message.ArtistArt = reader.string();
                    break;
                case 77:
                    message.artistType = reader.int32();
                    break;
                case 78:
                    message.artistGender = reader.int32();
                    break;
                default:
                    reader.skipType(wireType);
                    break;
            }
        }
        return message;
    }
};
class ProtoReader {
    buf;
    pos;
    len;
    constructor(buffer) {
        this.buf = buffer;
        this.pos = 0;
        this.len = buffer.length;
    }
    uint32() {
        let value = 0;
        let shift = 0;
        while (this.pos < this.len) {
            const b = this.buf[this.pos];
            if (b === undefined)
                break;
            this.pos++;
            value |= (b & 127) << shift;
            if (b < 128)
                return value >>> 0;
            shift += 7;
            if (shift >= 35)
                throw new Error('Varint too long');
        }
        return value >>> 0;
    }
    int32() {
        return this.uint32() | 0;
    }
    string() {
        const len = this.uint32();
        const str = this.buf.toString('utf8', this.pos, this.pos + len);
        this.pos += len;
        return str;
    }
    float() {
        const value = this.buf.readFloatLE(this.pos);
        this.pos += 4;
        return value;
    }
    skipType(wireType) {
        switch (wireType) {
            case 0:
                this.uint32();
                break;
            case 1:
                this.pos += 8;
                break;
            case 2:
                this.pos += this.uint32();
                break;
            case 5:
                this.pos += 4;
                break;
            default:
                throw new Error(`Unknown wire type: ${wireType}`);
        }
    }
}
export default class AnghamiSource {
    nodelink;
    config;
    sourceConfig;
    searchTerms = ['agsearch'];
    patterns = [
        /^https?:\/\/(?:play\.|www\.)?anghami\.com\/(?:song|album|playlist|artist)\/(\d+)/
    ];
    priority = 80;
    udid;
    cookieHeader;
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.config = nodelink.options;
        this.sourceConfig = this.asRecord(this.config.sources?.anghami)
            ? (this.asRecord(this.config.sources?.anghami) ??
                {})
            : {};
        this.udid = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
        this.cookieHeader = this.sourceConfig.cookies ?? '';
        if (this.cookieHeader)
            this.parseFingerprintFromCookies();
    }
    async setup() {
        return true;
    }
    async search(query, _sourceTerm) {
        logger('debug', 'Sources', `Searching Anghami for: "${query}"`);
        const searchUrl = `https://api.anghami.com/gateway.php?type=GETtabsearch&query=${encodeURIComponent(query)}&web2=true&language=en&output=json`;
        const { body, error } = await makeRequest(searchUrl, {
            method: 'GET',
            headers: this.buildHeaders()
        });
        if (error) {
            return {
                loadType: 'error',
                exception: { message: error, severity: 'common' }
            };
        }
        const searchBody = this.asRecord(body);
        const sections = Array.isArray(searchBody?.sections)
            ? searchBody.sections
            : [];
        const songsSection = sections.find((s) => s.type === 'genericitem' && s.group === 'songs');
        const data = Array.isArray(songsSection?.data) ? songsSection.data : [];
        if (data.length === 0)
            return { loadType: 'empty', data: {} };
        const tracks = data
            .map((item) => this.buildTrack(item))
            .filter((t) => t !== null);
        return tracks.length > 0
            ? { loadType: 'search', data: tracks }
            : { loadType: 'empty', data: {} };
    }
    async resolve(url) {
        const pattern = this.patterns[0];
        if (!pattern)
            return { loadType: 'empty', data: {} };
        const match = url.match(pattern);
        if (!match?.[1])
            return { loadType: 'empty', data: {} };
        const id = match[1];
        const type = url.includes('/song/')
            ? 'song'
            : url.includes('/album/')
                ? 'album'
                : url.includes('/playlist/')
                    ? 'playlist'
                    : url.includes('/artist/')
                        ? 'artist'
                        : null;
        if (!type)
            return { loadType: 'empty', data: {} };
        logger('debug', 'Sources', `Resolving Anghami URL: ${url} (Type: ${type}, ID: ${id})`);
        if (type === 'song')
            return this.resolveSong(id);
        if (type === 'album' || type === 'playlist')
            return this.resolveCollection(id, type);
        if (type === 'artist')
            return this.resolveArtist(id);
        return { loadType: 'empty', data: {} };
    }
    async getTrackUrl(decodedTrack) {
        const sources = this.nodelink.sources;
        if (!sources) {
            return {
                exception: {
                    message: 'Source manager is not available.',
                    severity: 'fault'
                }
            };
        }
        const searchQuery = `${decodedTrack.title} - ${decodedTrack.author}`;
        try {
            const searchResult = await sources.searchWithDefault(searchQuery);
            if (searchResult.loadType !== 'search' ||
                !Array.isArray(searchResult.data) ||
                searchResult.data.length === 0) {
                return {
                    exception: {
                        message: 'No suitable alternative found via default search.',
                        severity: 'common'
                    }
                };
            }
            const bestMatch = getBestMatch(searchResult.data, decodedTrack);
            if (!bestMatch) {
                return {
                    exception: {
                        message: 'No suitable alternative found after filtering.',
                        severity: 'common'
                    }
                };
            }
            const streamInfo = await sources.getTrackUrl(bestMatch.info);
            return { ...streamInfo, newTrack: { info: bestMatch.info } };
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            logger('warn', 'Anghami', `Search for "${searchQuery}" failed: ${message}`);
            return { exception: { message, severity: 'fault' } };
        }
    }
    async loadStream() {
        return {
            exception: {
                message: 'Direct stream loading is not supported by Anghami source.',
                severity: 'common'
            }
        };
    }
    parseFingerprintFromCookies() {
        const cookies = this.cookieHeader.split(';');
        for (const cookie of cookies) {
            const parts = cookie.trim().split('=');
            const name = parts[0];
            const value = parts.slice(1).join('=');
            if (name === 'fingerprint' && value) {
                try {
                    const decoded = Buffer.from(value, 'base64').toString('utf-8');
                    const json = JSON.parse(decoded);
                    if (typeof json.fp === 'string' && json.fp) {
                        this.udid = json.fp;
                        logger('info', 'Anghami', `Extracted UDID from config cookies: ${this.udid}`);
                    }
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    logger('warn', 'Anghami', `Failed to decode fingerprint cookie: ${message}`);
                }
                break;
            }
        }
    }
    async resolveSong(id) {
        const songDataUrl = `https://api.anghami.com/gateway.php?type=GETsongdata&songId=${id}&output=jsonhp`;
        const { body, error } = await makeRequest(songDataUrl, {
            method: 'GET',
            headers: this.buildHeaders()
        });
        const songBody = this.asRecord(body);
        if (error || !songBody || songBody.status !== 'ok') {
            const fallback = await this.searchByIdFallback(id);
            if (fallback)
                return { loadType: 'track', data: fallback };
            return {
                loadType: 'error',
                exception: {
                    message: error ?? 'Failed to resolve song',
                    severity: 'common'
                }
            };
        }
        const track = this.buildTrack(songBody);
        if (!track)
            return { loadType: 'empty', data: {} };
        return { loadType: 'track', data: track };
    }
    async searchByIdFallback(id) {
        const searchUrl = `https://api.anghami.com/gateway.php?type=GETtabsearch&query=${id}&web2=true&language=en&output=json`;
        const { body } = await makeRequest(searchUrl, {
            method: 'GET',
            headers: this.buildHeaders()
        });
        const searchBody = this.asRecord(body);
        const sections = Array.isArray(searchBody?.sections)
            ? searchBody.sections
            : [];
        for (const section of sections) {
            const sectionData = Array.isArray(section.data) ? section.data : [];
            const matched = sectionData.find((s) => String(s.id ?? '') === id);
            if (matched)
                return this.buildTrack(matched);
        }
        return null;
    }
    async resolveCollection(id, type) {
        const direct = await this.fetchCollectionData(id, type, false);
        const buffered = direct ?? (await this.fetchCollectionData(id, type, true));
        if (!buffered)
            return { loadType: 'empty', data: {} };
        return buffered;
    }
    async fetchCollectionData(id, type, useBuffered) {
        const apiType = type === 'album' ? 'GETalbumdata' : 'GETplaylistdata';
        const requestUrl = `https://api.anghami.com/gateway.php?type=${apiType}&${type}Id=${id}&web2=true&language=en&output=json${useBuffered ? '&buffered=1' : ''}`;
        const { body, error } = await makeRequest(requestUrl, {
            method: 'GET',
            headers: this.buildHeaders()
        });
        const collectionBody = this.asRecord(body);
        if (error || !collectionBody || collectionBody.error)
            return null;
        const tracks = this.extractCollectionTracks(collectionBody);
        if (tracks.length === 0)
            return null;
        const meta = this.asRecord(collectionBody.playlist) ??
            this.asRecord(collectionBody.album) ??
            {};
        const attributes = this.asRecord(meta._attributes) ??
            this.asRecord(collectionBody._attributes) ??
            {};
        const name = this.asString(collectionBody.title) ??
            this.asString(collectionBody.name) ??
            this.asString(meta.title) ??
            this.asString(meta.name) ??
            this.asString(attributes.title) ??
            this.asString(attributes.name) ??
            'Unknown Playlist';
        return {
            loadType: 'playlist',
            data: { info: { name, selectedTrack: 0 }, pluginInfo: {}, tracks }
        };
    }
    extractCollectionTracks(body) {
        const bufferedTracks = this.extractBufferedTracks(body);
        if (bufferedTracks.length > 0)
            return bufferedTracks;
        const sectionTracks = this.extractSectionTracks(body.sections);
        if (sectionTracks.length > 0)
            return sectionTracks;
        const mappedTracks = this.extractMappedTracks(body);
        if (mappedTracks.length > 0)
            return mappedTracks;
        if (Array.isArray(body.data)) {
            return body.data
                .map((item) => this.buildTrack(item))
                .filter((t) => t !== null);
        }
        return [];
    }
    extractBufferedTracks(body) {
        if (!Array.isArray(body.songbuffers))
            return [];
        const songMap = new Map();
        for (const bufferBase64 of body.songbuffers) {
            if (typeof bufferBase64 !== 'string')
                continue;
            try {
                const buffer = Buffer.from(bufferBase64, 'base64');
                const decoded = AnghamiSongBatchDecoder.decode(buffer);
                for (const key of Object.keys(decoded.response)) {
                    const song = decoded.response[key];
                    if (song)
                        songMap.set(key, song);
                }
            }
            catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                logger('error', 'Anghami', `Failed to decode playlist buffer: ${message}`);
            }
        }
        const meta = this.asRecord(body.playlist) ?? this.asRecord(body.album) ?? {};
        const attributes = this.asRecord(meta._attributes) ?? this.asRecord(body._attributes) ?? {};
        const orderStr = this.asString(body.songorder) ?? this.asString(attributes.songorder);
        const tracks = [];
        if (orderStr) {
            const order = orderStr.split(',');
            for (const songId of order) {
                const song = songMap.get(songId.trim());
                const track = song ? this.buildTrack(song) : null;
                if (track)
                    tracks.push(track);
            }
            if (tracks.length === 0) {
                for (const songId of order.reverse()) {
                    const song = songMap.get(songId.trim());
                    const track = song ? this.buildTrack(song) : null;
                    if (track)
                        tracks.push(track);
                }
            }
            return tracks;
        }
        for (const song of songMap.values()) {
            const track = this.buildTrack(song);
            if (track)
                tracks.push(track);
        }
        return tracks;
    }
    extractSectionTracks(sections) {
        if (!Array.isArray(sections))
            return [];
        const songsSection = sections.find((s) => s.type === 'song' || s.group === 'songs' || s.group === 'album_songs');
        const data = Array.isArray(songsSection?.data) ? songsSection.data : [];
        return data
            .map((item) => this.buildTrack(item))
            .filter((t) => t !== null);
    }
    extractMappedTracks(body) {
        const meta = this.asRecord(body.playlist) ?? this.asRecord(body.album) ?? {};
        const attributes = this.asRecord(meta._attributes) ?? this.asRecord(body._attributes) ?? {};
        const songsMapData = this.asRecord(this.asRecord(body.playlist)?.songs) ??
            this.asRecord(body.songs) ??
            this.asRecord(this.asRecord(body.album)?.songs);
        if (!songsMapData)
            return [];
        const songsMap = new Map();
        for (const key of Object.keys(songsMapData)) {
            const entry = songsMapData[key];
            const entryRecord = this.asRecord(entry);
            if (!entryRecord)
                continue;
            const songObj = (this.asRecord(entryRecord._attributes) ??
                entryRecord);
            const id = this.asString(songObj.id);
            if (id)
                songsMap.set(id, songObj);
        }
        const orderStr = this.asString(meta.songorder) ??
            this.asString(attributes.songorder) ??
            this.asString(body.songorder);
        const tracks = [];
        if (orderStr) {
            for (const songId of orderStr.split(',')) {
                const song = songsMap.get(songId.trim());
                const track = song ? this.buildTrack(song) : null;
                if (track)
                    tracks.push(track);
            }
        }
        if (tracks.length === 0) {
            for (const song of songsMap.values()) {
                const track = this.buildTrack(song);
                if (track)
                    tracks.push(track);
            }
        }
        return tracks;
    }
    async resolveArtist(id) {
        const artistUrl = `https://api.anghami.com/gateway.php?type=GETartistprofile&artistId=${id}&web2=true&language=en&output=json`;
        const { body, error } = await makeRequest(artistUrl, {
            method: 'GET',
            headers: this.buildHeaders()
        });
        if (error)
            return { loadType: 'empty', data: {} };
        const artistBody = this.asRecord(body);
        if (!artistBody)
            return { loadType: 'empty', data: {} };
        let tracksData = [];
        if (Array.isArray(artistBody.sections)) {
            const songsSec = artistBody.sections.find((s) => s.group === 'songs' || s.type === 'song');
            tracksData = Array.isArray(songsSec?.data) ? songsSec.data : [];
        }
        else if (Array.isArray(artistBody.data)) {
            tracksData = artistBody.data;
        }
        const tracks = tracksData
            .map((item) => this.buildTrack(item))
            .filter((t) => t !== null);
        if (tracks.length === 0)
            return { loadType: 'empty', data: {} };
        return {
            loadType: 'playlist',
            data: {
                info: {
                    name: this.asString(artistBody.name) ??
                        this.asString(artistBody.title) ??
                        'Artist Top Tracks',
                    selectedTrack: 0
                },
                pluginInfo: {},
                tracks
            }
        };
    }
    buildHeaders() {
        const headers = {
            'User-Agent': USER_AGENT,
            'X-ANGH-UDID': this.udid,
            'X-ANGH-TS': Math.floor(Date.now() / 1000).toString(),
            Referer: 'https://play.anghami.com/',
            Origin: 'https://play.anghami.com'
        };
        if (this.cookieHeader)
            headers.Cookie = this.cookieHeader;
        return headers;
    }
    buildTrack(item) {
        const itemRecord = item;
        const id = this.asString(item.id);
        if (!id)
            return null;
        const artworkId = this.asString(item.coverArt) ??
            this.asString(itemRecord.AlbumArt) ??
            this.asString(itemRecord.cover);
        const artworkUrl = artworkId
            ? `https://artwork.anghcdn.co/?id=${artworkId}&size=640`
            : null;
        const rawDuration = this.asString(item.duration) ?? this.asNumber(item.duration);
        const durationSeconds = typeof rawDuration === 'string'
            ? Number.parseFloat(rawDuration)
            : rawDuration;
        const lengthMs = Number.isFinite(durationSeconds ?? Number.NaN)
            ? Math.round((durationSeconds ?? 0) * 1000)
            : 0;
        const trackInfo = {
            identifier: id,
            isSeekable: true,
            author: this.asString(item.artist) ??
                this.asString(itemRecord.artistName) ??
                'Unknown Artist',
            length: lengthMs,
            isStream: false,
            position: 0,
            title: this.asString(item.title) ??
                this.asString(itemRecord.name) ??
                'Unknown Title',
            uri: `https://play.anghami.com/song/${id}`,
            artworkUrl,
            isrc: null,
            sourceName: 'anghami'
        };
        const encodeInput = { ...trackInfo, details: [] };
        return {
            encoded: encodeTrack(encodeInput),
            info: trackInfo,
            pluginInfo: {}
        };
    }
    asRecord(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            return null;
        return value;
    }
    asString(value) {
        return typeof value === 'string'
            ? value
            : typeof value === 'number'
                ? String(value)
                : null;
    }
    asNumber(value) {
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }
}
