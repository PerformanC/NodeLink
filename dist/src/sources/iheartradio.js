import { encodeTrack, http1makeRequest, logger } from "../utils.js";
const IHEART_API_V2 = 'https://us.api.iheart.com/api/v2';
const IHEART_API_V1 = 'https://api2.iheart.com/api/v1';
const IHEART_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const IHEART_HEADERS = {
    'User-Agent': IHEART_USER_AGENT,
    Accept: 'application/json',
    Origin: 'https://www.iheart.com',
    Referer: 'https://www.iheart.com/'
};
const IHEART_PATTERN = /https?:\/\/(?:www\.)?iheart\.com\/live\/(?:[a-zA-Z0-9-]+-)?(\d+)\/?$/;
/**
 * iHeartRadio source implementation.
 */
export default class IheartradioSource {
    /**
     * Worker runtime shared with the source manager.
     */
    nodelink;
    /**
     * URL patterns accepted by the source.
     */
    patterns = [IHEART_PATTERN];
    /**
     * Search prefixes routed to this source.
     */
    searchTerms = ['ihsearch', 'iheartradio'];
    /**
     * Recommendation prefixes supported by this source.
     */
    recommendationTerm = [];
    /**
     * Source priority used by URL matching.
     */
    priority = 60;
    /**
     * Maximum number of search results returned by this source.
     */
    maxSearchResults;
    /**
     * Creates an iHeart source bound to the worker runtime.
     *
     * @param nodelink Worker runtime provided by the source manager.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        const options = nodelink.options;
        this.maxSearchResults =
            typeof options.maxSearchResults === 'number' &&
                Number.isInteger(options.maxSearchResults) &&
                options.maxSearchResults > 0
                ? options.maxSearchResults
                : 10;
    }
    /**
     * Announces the source during worker initialization.
     *
     * @returns `true` when the source is ready to accept requests.
     */
    async setup() {
        logger('info', 'Sources', 'Loaded iHeartRadio source.');
        return true;
    }
    /**
     * Requests an iHeart JSON endpoint and normalizes the response into a record.
     *
     * @param url API endpoint to request.
     * @returns A parsed JSON record or `null` when the request fails.
     */
    async requestJson(url) {
        try {
            const { body, error, statusCode } = await http1makeRequest(url, {
                headers: IHEART_HEADERS
            });
            if (error || statusCode !== 200) {
                logger('warn', 'iHeart', `HTTP ${error ?? statusCode} for ${url}`);
                return null;
            }
            return this.parseJsonBody(body);
        }
        catch (error) {
            logger('error', 'iHeart', `Request failed for ${url}: ${error instanceof Error ? error.message : 'unknown error'}`);
            return null;
        }
    }
    /**
     * Resolves a `.pls` playlist URL into the first playable media URL.
     *
     * @param plsUrl Playlist URL returned by the iHeart API.
     * @returns A direct media URL when one can be extracted, otherwise the original URL.
     */
    async resolvePls(plsUrl) {
        try {
            const { body, error, statusCode } = await http1makeRequest(plsUrl, {
                headers: { 'User-Agent': IHEART_USER_AGENT }
            });
            if (error || statusCode !== 200) {
                return plsUrl;
            }
            const text = this.getTextBody({ body });
            if (!text)
                return plsUrl;
            const match = text.match(/^File\d+=(.+)$/m);
            return match?.[1]?.trim() || plsUrl;
        }
        catch {
            return plsUrl;
        }
    }
    /**
     * Resolves the preferred live stream URL for an iHeart station id.
     *
     * @param stationId Station identifier extracted from the URL or track payload.
     * @returns The direct stream URL or `null` when no stream is available.
     */
    async getStreamUrl(stationId) {
        try {
            const data = await this.requestJson(`${IHEART_API_V2}/content/liveStations/${stationId}`);
            if (!data)
                return null;
            const station = this.extractStation(data);
            if (!station)
                return null;
            const streamUrl = this.selectStreamUrl(station.streams);
            if (!streamUrl) {
                logger('warn', 'iHeart', `No stream URL found for station ${stationId}`);
                return null;
            }
            if (streamUrl.endsWith('.pls')) {
                return this.resolvePls(streamUrl);
            }
            return streamUrl;
        }
        catch (error) {
            logger('error', 'iHeart', `_getStreamUrl failed for ${stationId}: ${error instanceof Error ? error.message : 'unknown error'}`);
            return null;
        }
    }
    /**
     * Converts normalized station metadata into an encoded live track.
     *
     * @param station Station metadata normalized from the iHeart API.
     * @returns An encoded track payload or `null` when the station is incomplete.
     */
    buildTrack(station) {
        const id = station.id || station.stationId;
        if (!id)
            return null;
        const city = station.markets[0]?.cityName || station.city || null;
        const name = station.name ||
            station.callLetters ||
            station.stationName ||
            `iHeart Station ${id}`;
        const artworkUrl = station.logo ||
            station.newThumbnailUrl ||
            station.profileImage ||
            station.imageUrl ||
            null;
        const info = {
            identifier: id,
            isSeekable: false,
            author: city || 'iHeartRadio',
            length: 0,
            isStream: true,
            position: 0,
            title: name,
            uri: `https://www.iheart.com/live/${id}/`,
            artworkUrl,
            isrc: null,
            sourceName: 'iheartradio',
            details: []
        };
        return {
            encoded: encodeTrack(info),
            info,
            pluginInfo: {
                description: station.description,
                genre: station.genres[0]?.name || station.genre?.name || station.genreName,
                frequency: station.freq || station.frequency || null,
                band: station.band,
                city,
                state: station.stateAbbreviation,
                website: station.website
            }
        };
    }
    /**
     * Searches the iHeart catalog for live stations matching a query.
     *
     * @param query Search string received from the API or unified search flow.
     * @returns Search results, an empty payload, or a structured exception.
     */
    async search(query) {
        try {
            const encoded = encodeURIComponent(query);
            const data = await this.requestJson(`${IHEART_API_V1}/catalog/searchAll` +
                `?keywords=${encoded}` +
                '&bestMatch=True' +
                '&queryStation=True' +
                '&queryArtist=False' +
                '&queryTrack=False' +
                '&queryTalkShow=True' +
                '&startIndex=0' +
                `&maxRows=${this.maxSearchResults}` +
                '&queryFeaturedStation=True' +
                '&queryBundle=False' +
                '&queryTalkTheme=False' +
                '&amp_version=4.11.0');
            if (!data)
                return { loadType: 'empty', data: {} };
            const stations = this.extractSearchStations(data);
            if (stations.length === 0)
                return { loadType: 'empty', data: {} };
            const tracks = stations
                .map((station) => this.buildTrack(station))
                .filter((track) => track !== null)
                .slice(0, this.maxSearchResults);
            return tracks.length > 0
                ? { loadType: 'search', data: tracks }
                : { loadType: 'empty', data: {} };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'iHeart search failed.';
            logger('error', 'iHeart', `Search failed: ${message}`);
            return { exception: { message, severity: 'fault' } };
        }
    }
    /**
     * Resolves an iHeart station URL into a single live track.
     *
     * @param url Public iHeart station URL.
     * @returns A live track, an empty payload, or a structured exception.
     */
    async resolve(url) {
        try {
            const match = url.match(IHEART_PATTERN);
            const stationId = match?.[1];
            if (!stationId)
                return { loadType: 'empty', data: {} };
            return this.resolveById(stationId);
        }
        catch (error) {
            return {
                exception: {
                    message: error instanceof Error ? error.message : 'iHeart resolve failed.',
                    severity: 'fault'
                }
            };
        }
    }
    /**
     * Resolves a station id directly through the iHeart station endpoint.
     *
     * @param stationId Stable iHeart station id.
     * @returns A live track result or a structured exception.
     */
    async resolveById(stationId) {
        const data = await this.requestJson(`${IHEART_API_V2}/content/liveStations/${stationId}`);
        if (!data) {
            return {
                exception: {
                    message: `iHeart station ${stationId} not found.`,
                    severity: 'common'
                }
            };
        }
        const station = this.extractStation(data);
        if (!station) {
            return {
                exception: {
                    message: `iHeart station ${stationId} returned an unreadable payload.`,
                    severity: 'fault'
                }
            };
        }
        const track = this.buildTrack(station);
        if (!track) {
            return {
                exception: {
                    message: 'Failed to build track from station data.',
                    severity: 'fault'
                }
            };
        }
        logger('info', 'iHeart', `Resolved station ${stationId}: ${track.info.title}`);
        return { loadType: 'track', data: track };
    }
    /**
     * Delegates live stream URL resolution to the `http` source after fetching the
     * current station stream URL from iHeart.
     *
     * @param decodedTrack Decoded iHeart track information.
     * @returns A delegated HTTP track URL result or a structured exception.
     */
    async getTrackUrl(decodedTrack) {
        try {
            const streamUrl = await this.getStreamUrl(decodedTrack.identifier);
            if (!streamUrl) {
                return {
                    exception: {
                        message: `Could not resolve stream URL for iHeart station ${decodedTrack.identifier}.`,
                        severity: 'fault'
                    },
                    url: '',
                    protocol: 'http'
                };
            }
            const sourceManager = this.nodelink.sources;
            if (!sourceManager) {
                return {
                    exception: {
                        message: 'Source manager is not available for iHeart delegation.',
                        severity: 'fault'
                    },
                    url: '',
                    protocol: 'http'
                };
            }
            const httpTrackInfo = {
                ...decodedTrack,
                uri: streamUrl,
                sourceName: 'http'
            };
            return sourceManager.getTrackUrl(httpTrackInfo);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'iHeart getTrackUrl failed.';
            logger('error', 'iHeart', `getTrackUrl failed: ${message}`);
            return {
                exception: { message, severity: 'fault' },
                url: '',
                protocol: 'http'
            };
        }
    }
    /**
     * Delegates stream loading to the `http` source after resolving the current
     * station stream URL.
     *
     * @param decodedTrack Decoded iHeart track information.
     * @param url Optional pre-resolved stream URL.
     * @returns A readable stream or a structured exception.
     */
    async loadStream(decodedTrack, url) {
        try {
            const streamUrl = url || (await this.getStreamUrl(decodedTrack.identifier));
            if (!streamUrl) {
                return {
                    exception: {
                        message: `Could not resolve stream URL for iHeart station ${decodedTrack.identifier}.`,
                        severity: 'fault'
                    }
                };
            }
            const sourceManager = this.nodelink.sources;
            if (!sourceManager) {
                return {
                    exception: {
                        message: 'Source manager is not available for iHeart stream delegation.',
                        severity: 'fault'
                    }
                };
            }
            const httpSource = sourceManager.getSource('http');
            if (!httpSource?.loadStream) {
                return {
                    exception: {
                        message: 'http source not available for stream delegation.',
                        severity: 'fault'
                    }
                };
            }
            const httpTrackInfo = {
                ...decodedTrack,
                uri: streamUrl,
                sourceName: 'http'
            };
            return httpSource.loadStream(httpTrackInfo, streamUrl);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'iHeart loadStream failed.';
            logger('error', 'iHeart', `loadStream failed: ${message}`);
            return { exception: { message, severity: 'fault' } };
        }
    }
    /**
     * Parses a JSON-capable HTTP response body into a record.
     *
     * @param body Buffered HTTP response body.
     * @returns A JSON record or `null` when the payload is not an object.
     */
    parseJsonBody(body) {
        if (body &&
            typeof body === 'object' &&
            !Array.isArray(body) &&
            !Buffer.isBuffer(body)) {
            return body;
        }
        const text = this.getTextBody({ body });
        if (!text)
            return null;
        try {
            const parsed = JSON.parse(text);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? parsed
                : null;
        }
        catch {
            return null;
        }
    }
    /**
     * Converts a buffered HTTP body into text.
     *
     * @param response HTTP helper response carrying the buffered body.
     * @returns A UTF-8 string when the body is text-like, otherwise `null`.
     */
    getTextBody(response) {
        if (typeof response.body === 'string') {
            return response.body;
        }
        if (Buffer.isBuffer(response.body)) {
            return response.body.toString('utf8');
        }
        return null;
    }
    /**
     * Extracts the first station payload from a station detail response.
     *
     * @param payload Normalized iHeart API payload.
     * @returns A normalized station or `null` when the payload does not contain one.
     */
    extractStation(payload) {
        const hits = this.getArray(payload, 'hits');
        const firstHit = hits[0] ? this.getRecordFromValue(hits[0]) : null;
        const nestedStation = firstHit ? this.getRecord(firstHit, 'station') : null;
        if (nestedStation) {
            return this.stationFromRecord(nestedStation);
        }
        if (firstHit) {
            return this.stationFromRecord(firstHit);
        }
        const station = this.getRecord(payload, 'station');
        return station
            ? this.stationFromRecord(station)
            : this.stationFromRecord(payload);
    }
    /**
     * Extracts the searchable station list from a search response payload.
     *
     * @param payload Normalized iHeart search payload.
     * @returns Normalized station list ready to be converted into tracks.
     */
    extractSearchStations(payload) {
        const stations = this.getArray(payload, 'stations');
        if (stations.length > 0) {
            return stations
                .map((value) => this.getRecordFromValue(value))
                .filter((record) => record !== null)
                .map((record) => this.stationFromRecord(record))
                .filter((station) => station !== null);
        }
        const results = this.getRecord(payload, 'results');
        const resultsStations = results ? this.getRecord(results, 'stations') : null;
        const hits = resultsStations ? this.getArray(resultsStations, 'hits') : [];
        return hits
            .map((value) => this.getRecordFromValue(value))
            .filter((record) => record !== null)
            .map((record) => this.getRecord(record, 'station') ?? record)
            .map((record) => this.stationFromRecord(record))
            .filter((station) => station !== null);
    }
    /**
     * Converts a raw iHeart station object into the normalized station shape used
     * by the source implementation.
     *
     * @param record Raw station record extracted from the API payload.
     * @returns A normalized station or `null` when the record lacks an id.
     */
    stationFromRecord(record) {
        const id = this.getString(record, 'id');
        const stationId = this.getString(record, 'stationId');
        if (!id && !stationId) {
            return null;
        }
        const marketValues = this.getArray(record, 'markets');
        const genreValues = this.getArray(record, 'genres');
        const genreRecord = this.getRecord(record, 'genre');
        const streamsRecord = this.getRecord(record, 'streams');
        return {
            id,
            stationId,
            name: this.getString(record, 'name'),
            callLetters: this.getString(record, 'callLetters'),
            stationName: this.getString(record, 'stationName'),
            logo: this.getString(record, 'logo'),
            newThumbnailUrl: this.getString(record, 'newThumbnailUrl'),
            profileImage: this.getString(record, 'profileImage'),
            imageUrl: this.getString(record, 'imageUrl'),
            markets: marketValues
                .map((value) => this.getRecordFromValue(value))
                .filter((value) => value !== null)
                .map((value) => ({ cityName: this.getString(value, 'cityName') })),
            city: this.getString(record, 'city'),
            description: this.getString(record, 'description'),
            genres: genreValues
                .map((value) => this.getRecordFromValue(value))
                .filter((value) => value !== null)
                .map((value) => ({ name: this.getString(value, 'name') })),
            genre: genreRecord ? { name: this.getString(genreRecord, 'name') } : null,
            genreName: this.getString(record, 'genreName'),
            freq: this.getString(record, 'freq'),
            frequency: this.getString(record, 'frequency'),
            band: this.getString(record, 'band'),
            stateAbbreviation: this.getString(record, 'stateAbbreviation'),
            website: this.getString(record, 'website'),
            streams: this.getStringRecord(streamsRecord)
        };
    }
    /**
     * Chooses the best playable stream URL from the available iHeart stream map.
     *
     * @param streams Stream URL map keyed by source type.
     * @returns The preferred playable stream URL or `null` when none exist.
     */
    selectStreamUrl(streams) {
        const preferredKeys = [
            'shoutcast_stream',
            'secure_mp3_pls_stream',
            'hls_stream',
            'mp3_pls_stream',
            'secure_hls_stream',
            'pivot_hls_stream'
        ];
        for (const key of preferredKeys) {
            const value = streams[key];
            if (value)
                return value;
        }
        for (const value of Object.values(streams)) {
            if (value)
                return value;
        }
        return null;
    }
    /**
     * Reads a nested record property from a JSON record.
     *
     * @param record Source record.
     * @param key Property name to read.
     * @returns The nested record or `null` when the property is not an object.
     */
    getRecord(record, key) {
        return this.getRecordFromValue(record[key]);
    }
    /**
     * Converts a JSON value into a record when possible.
     *
     * @param value Candidate JSON value.
     * @returns The record representation or `null`.
     */
    getRecordFromValue(value) {
        return value && typeof value === 'object' && !Array.isArray(value)
            ? value
            : null;
    }
    /**
     * Reads an array property from a JSON record.
     *
     * @param record Source record.
     * @param key Property name to read.
     * @returns The nested array or an empty array when the property is not an array.
     */
    getArray(record, key) {
        const value = record[key];
        return Array.isArray(value) ? value : [];
    }
    /**
     * Reads a string-like field from a JSON record.
     *
     * @param record Source record.
     * @param key Property name to read.
     * @returns The normalized string value or `null`.
     */
    getString(record, key) {
        const value = record[key];
        if (typeof value === 'string') {
            return value;
        }
        if (typeof value === 'number') {
            return String(value);
        }
        return null;
    }
    /**
     * Converts a JSON record containing string-like values into a plain string map.
     *
     * @param record Candidate record containing stream URLs.
     * @returns A string-only record with invalid entries removed.
     */
    getStringRecord(record) {
        if (!record)
            return {};
        const values = {};
        for (const [key, value] of Object.entries(record)) {
            if (typeof value === 'string') {
                values[key] = value;
            }
            else if (typeof value === 'number') {
                values[key] = String(value);
            }
        }
        return values;
    }
}
