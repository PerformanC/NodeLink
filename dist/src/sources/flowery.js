import { PassThrough } from 'node:stream';
import { URL } from 'node:url';
import { encodeTrack, logger, makeRequest } from "../utils.js";
/**
 * Flowery TTS source implementation.
 */
export default class FlowerySource {
    /**
     * Runtime worker context used by the source implementation.
     */
    nodelink;
    /**
     * Sanitized Flowery-specific configuration.
     */
    config;
    /**
     * Search aliases handled by this source.
     */
    searchTerms;
    /**
     * URL patterns supported by this source.
     */
    patterns;
    /**
     * Match priority used by the source manager.
     */
    priority;
    /**
     * Voice map keyed by lowercase voice name.
     */
    voiceMap;
    /**
     * Default Flowery voice identifier.
     */
    defaultVoiceId;
    /**
     * Creates a new Flowery TTS source wrapper.
     *
     * @param nodelink - Worker runtime used by the source implementation.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.config = this.getConfig();
        this.searchTerms = ['ftts', 'flowery'];
        this.patterns = [/^ftts:\/\//];
        this.priority = 50;
        this.voiceMap = new Map();
        this.defaultVoiceId = null;
    }
    /**
     * Reads and normalizes the Flowery configuration from the shared runtime.
     *
     * @returns Sanitized Flowery configuration limited to the fields used by
     * this source.
     */
    getConfig() {
        const sourceKey = 'flowery';
        const rawConfig = this.nodelink.options.sources?.[sourceKey];
        return {
            enabled: rawConfig?.enabled === true,
            voice: typeof rawConfig?.voice === 'string' ? rawConfig.voice : undefined,
            translate: rawConfig?.translate === true,
            silence: typeof rawConfig?.silence === 'number' ? rawConfig.silence : undefined,
            speed: typeof rawConfig?.speed === 'number' ? rawConfig.speed : undefined,
            enforceConfig: rawConfig?.enforceConfig === true
        };
    }
    /**
     * Validates whether a raw HTTP payload can be treated as an object record.
     *
     * @param value - Candidate HTTP response body.
     * @returns `true` when the value is a non-array, non-buffer object.
     */
    isJsonRecord(value) {
        return (value !== null &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            !Buffer.isBuffer(value));
    }
    /**
     * Narrows a candidate voice payload from the Flowery API.
     *
     * @param value - Candidate voice entry.
     * @returns Typed voice payload, or `null` when the shape is invalid.
     */
    getVoice(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return null;
        }
        const voiceRecord = value;
        const id = voiceRecord.id;
        const name = voiceRecord.name;
        if ((typeof id !== 'string' && typeof id !== 'number') ||
            typeof name !== 'string') {
            return null;
        }
        return { id, name };
    }
    /**
     * Narrows the Flowery voices endpoint response.
     *
     * @param value - Raw response body returned by Flowery.
     * @returns Typed voices response, or `null` when the payload shape is
     * invalid.
     */
    getVoicesResponse(value) {
        if (!this.isJsonRecord(value)) {
            return null;
        }
        const payload = value;
        const voicesValue = payload.voices;
        if (!Array.isArray(voicesValue)) {
            return null;
        }
        const voices = [];
        for (const voice of voicesValue) {
            const parsedVoice = this.getVoice(voice);
            if (!parsedVoice) {
                return null;
            }
            voices.push(parsedVoice);
        }
        const defaultVoice = this.getVoice(payload.default);
        return {
            voices,
            default: defaultVoice ?? undefined
        };
    }
    /**
     * Narrows cached voice data stored in the credential manager.
     *
     * @param value - Cached credential payload.
     * @returns Typed cache payload, or `null` when the stored shape is invalid.
     */
    getCachedVoiceEntry(value) {
        if (!value) {
            return null;
        }
        const voiceMap = value.voiceMap;
        if (!voiceMap || typeof voiceMap !== 'object' || Array.isArray(voiceMap)) {
            return null;
        }
        const normalizedVoiceMap = {};
        for (const [name, identifier] of Object.entries(voiceMap)) {
            if (typeof identifier === 'string' || typeof identifier === 'number') {
                normalizedVoiceMap[name] = identifier;
            }
        }
        const defaultVoiceId = typeof value.defaultVoiceId === 'string' ||
            typeof value.defaultVoiceId === 'number'
            ? value.defaultVoiceId
            : null;
        return {
            voiceMap: normalizedVoiceMap,
            defaultVoiceId
        };
    }
    /**
     * Extracts a readable error message from a runtime failure or helper error.
     *
     * @param error - Caught runtime failure or helper error text.
     * @returns Human-readable message suitable for logs and exception payloads.
     */
    getErrorMessage(error) {
        return error instanceof Error ? error.message : error;
    }
    /**
     * Builds the title shown for a Flowery synthesized track.
     *
     * @param text - Requested TTS text.
     * @returns Original text, truncated to the same 50-character policy used by
     * the legacy source.
     */
    buildTitle(text) {
        return text.length > 50 ? `${text.substring(0, 47)}...` : text;
    }
    /**
     * Restores the Flowery voice cache from the credential manager when present.
     *
     * @returns `true` when a valid cache entry was restored.
     */
    restoreVoicesFromCache() {
        const cachedVoices = this.nodelink.credentialManager?.get('flowery_voices') ?? null;
        const parsedCache = this.getCachedVoiceEntry(cachedVoices);
        if (!parsedCache) {
            return false;
        }
        this.voiceMap = new Map(Object.entries(parsedCache.voiceMap));
        this.defaultVoiceId = parsedCache.defaultVoiceId;
        logger('debug', 'Flowery', `Loaded ${this.voiceMap.size} voices from CredentialManager.`);
        return true;
    }
    /**
     * Persists the current Flowery voice cache in the credential manager.
     *
     * @returns Nothing. Failures are intentionally ignored to match the source's
     * best-effort caching behavior.
     */
    saveVoiceCache() {
        this.nodelink.credentialManager?.set('flowery_voices', {
            voiceMap: Object.fromEntries(this.voiceMap),
            defaultVoiceId: this.defaultVoiceId
        }, 24 * 60 * 60 * 1000);
    }
    /**
     * Fetches the latest voice list from Flowery and updates the local cache.
     *
     * This method keeps the original boot behavior but also fixes two incoherent
     * cases from the JavaScript version:
     * it now reads the helper's string-based `error` correctly and validates the
     * cached credential payload before trusting it.
     *
     * @returns Nothing. Failures are logged and the source remains usable with
     * fallback voice behavior.
     */
    async fetchVoices() {
        try {
            if (this.restoreVoicesFromCache()) {
                return;
            }
            const voicesEndpoint = 'https://api.flowery.pw/v1/tts/voices';
            const { body, error, statusCode } = await makeRequest(voicesEndpoint, {
                method: 'GET'
            });
            const voicesResponse = this.getVoicesResponse(body);
            if (error || statusCode !== 200 || !voicesResponse) {
                const failureReason = error || `Status ${typeof statusCode === 'number' ? statusCode : 0}`;
                logger('error', 'Flowery', `Failed to fetch voices from ${voicesEndpoint}: ${failureReason}`);
                return;
            }
            this.voiceMap.clear();
            for (const voice of voicesResponse.voices) {
                this.voiceMap.set(voice.name.toLowerCase(), voice.id);
            }
            if (voicesResponse.default) {
                this.defaultVoiceId = voicesResponse.default.id;
                logger('info', 'Flowery', `Default voice set to: ${voicesResponse.default.name} (${voicesResponse.default.id})`);
            }
            else if (voicesResponse.voices.length > 0) {
                const firstVoice = voicesResponse.voices[0];
                if (firstVoice) {
                    this.defaultVoiceId = firstVoice.id;
                    logger('info', 'Flowery', `Using first available voice as default: ${firstVoice.name} (${firstVoice.id})`);
                }
            }
            this.saveVoiceCache();
            logger('debug', 'Flowery', `Fetched ${this.voiceMap.size} voices.`);
        }
        catch (error) {
            logger('error', 'Flowery', `Exception fetching voices: ${this.getErrorMessage(error instanceof Error ? error : String(error))}`);
        }
    }
    /**
     * Builds the encoded track payload for a Flowery request.
     *
     * @param trackInput - Identifier, title, and URL used to build the track.
     * @returns Track payload compatible with the shared encoder and source
     * manager contracts.
     */
    buildTrack(trackInput) {
        const track = {
            identifier: trackInput.identifier,
            isSeekable: true,
            author: 'Flowery TTS',
            length: -1,
            isStream: false,
            position: 0,
            title: trackInput.title,
            uri: trackInput.uri,
            artworkUrl: null,
            isrc: null,
            sourceName: 'flowery',
            details: []
        };
        return {
            encoded: encodeTrack(track),
            info: track,
            pluginInfo: {}
        };
    }
    /**
     * Parses known Flowery overrides from an `ftts://` URL query string.
     *
     * Unknown keys are ignored because the source only consumes the documented
     * Flowery override set.
     *
     * @param query - URL query string without the leading `?`.
     * @returns Parsed override set understood by `buildUrl(...)`.
     */
    parseOverrides(query) {
        const overrides = {};
        const searchParams = new URLSearchParams(query);
        for (const [key, value] of searchParams) {
            if (key === 'voice') {
                overrides.voice = value;
            }
            else if (key === 'translate') {
                overrides.translate = value;
            }
            else if (key === 'silence') {
                overrides.silence = value;
            }
            else if (key === 'speed') {
                overrides.speed = value;
            }
        }
        return overrides;
    }
    /**
     * Builds the Flowery playback URL for a given text request.
     *
     * The method preserves the original override behavior while fixing an
     * incoherent defaulting edge case from the JavaScript version: configured
     * numeric values are now read with nullish semantics instead of `||`, so
     * valid numeric inputs are not accidentally masked by fallback defaults.
     *
     * @param text - Text that should be synthesized.
     * @param overrides - Optional override set parsed from the request URL.
     * @returns Fully qualified Flowery TTS URL.
     */
    buildUrl(text, overrides = {}) {
        const enforceConfig = this.config.enforceConfig === true;
        let voiceName = this.config.voice && this.config.voice.length > 0
            ? this.config.voice
            : 'Salli';
        let translate = this.config.translate ?? false;
        let silence = this.config.silence ?? 0;
        let speed = this.config.speed ?? 1.0;
        if (!enforceConfig) {
            if (overrides.voice) {
                voiceName = overrides.voice;
            }
            if (overrides.translate !== undefined) {
                translate = overrides.translate;
            }
            if (overrides.silence !== undefined) {
                silence = overrides.silence;
            }
            if (overrides.speed !== undefined) {
                speed = overrides.speed;
            }
        }
        let voiceId = this.voiceMap.get(String(voiceName).toLowerCase()) || this.defaultVoiceId;
        if (!voiceId) {
            logger('warn', 'Flowery', `Voice "${voiceName}" not found and no default voice available. Using fallback voice ID.`);
            voiceId = 'default';
        }
        const baseUrl = 'https://api.flowery.pw/v1/tts';
        const queryParams = new URLSearchParams({
            voice: String(voiceId),
            text: String(text),
            translate: String(translate),
            silence: String(silence),
            audio_format: 'mp3',
            speed: String(speed)
        });
        return `${baseUrl}?${queryParams.toString()}`;
    }
    /**
     * Forces a Flowery playback URL to request MP3 output.
     *
     * @param uri - Candidate Flowery playback URL.
     * @returns Normalized direct URL descriptor for MP3 playback.
     */
    forceMp3Url(uri) {
        const output = {
            url: uri,
            protocol: 'https',
            format: 'mp3'
        };
        try {
            const urlObject = new URL(uri);
            urlObject.searchParams.set('audio_format', 'mp3');
            output.url = urlObject.toString();
            return output;
        }
        catch {
            return output;
        }
    }
    /**
     * Initializes the source and primes the Flowery voice cache.
     *
     * @returns `true` once the source has completed its best-effort voice fetch.
     */
    async setup() {
        logger('info', 'Sources', 'Loaded Flowery TTS source.');
        await this.fetchVoices();
        return true;
    }
    /**
     * Converts a Flowery search query into a single synthetic track.
     *
     * @param query - Raw TTS text supplied by the caller.
     * @returns Track result payload, an empty result for blank input, or an
     * exception payload when URL construction fails.
     */
    async search(query) {
        if (!query) {
            return { loadType: 'empty', data: {} };
        }
        try {
            const url = this.buildUrl(query);
            const track = this.buildTrack({
                title: this.buildTitle(query),
                uri: url,
                identifier: `ftts:${query}`
            });
            return { loadType: 'track', data: track };
        }
        catch (error) {
            return {
                exception: {
                    message: this.getErrorMessage(error instanceof Error ? error : String(error)),
                    severity: 'fault',
                    cause: 'Exception'
                }
            };
        }
    }
    /**
     * Resolves either an `ftts://` URL or raw text into a Flowery track.
     *
     * @param url - Raw Flowery URL or plain text request.
     * @returns Track result payload, an empty result for blank resolved text, or
     * an exception payload when the URL cannot be decoded.
     */
    async resolve(url) {
        try {
            let text = '';
            let overrides = {};
            if (url.startsWith('ftts://')) {
                const pathAndQuery = url.slice(7);
                const splitIndex = pathAndQuery.indexOf('?');
                if (splitIndex !== -1) {
                    text = decodeURIComponent(pathAndQuery.substring(0, splitIndex));
                    overrides = this.parseOverrides(pathAndQuery.substring(splitIndex + 1));
                }
                else {
                    text = decodeURIComponent(pathAndQuery);
                }
            }
            else {
                text = url;
            }
            if (!text) {
                return { loadType: 'empty', data: {} };
            }
            const apiUrl = this.buildUrl(text, overrides);
            const track = this.buildTrack({
                title: this.buildTitle(text),
                uri: apiUrl,
                identifier: url
            });
            return { loadType: 'track', data: track };
        }
        catch (error) {
            return {
                exception: {
                    message: this.getErrorMessage(error instanceof Error ? error : String(error)),
                    severity: 'fault',
                    cause: 'Exception'
                }
            };
        }
    }
    /**
     * Resolves the normalized direct playback URL for a Flowery track.
     *
     * @param track - Decoded Flowery track information.
     * @param _itag - Unused format selector, kept for source-manager
     * compatibility.
     * @param forceRefresh - When `true`, bypasses the cache and rebuilds the URL
     * immediately.
     * @returns Normalized MP3 playback URL.
     */
    async getTrackUrl(track, _itag, forceRefresh = false) {
        if (!forceRefresh) {
            const cached = this.nodelink.trackCacheManager?.get('flowery', track.identifier) ?? null;
            if (cached) {
                return cached;
            }
        }
        const normalized = this.forceMp3Url(track.uri);
        try {
            this.nodelink.trackCacheManager?.set('flowery', track.identifier, normalized);
        }
        catch {
            // Best-effort cache writes are intentionally ignored.
        }
        return normalized;
    }
    /**
     * Opens a proxied audio stream for a Flowery playback URL.
     *
     * This method preserves the original streaming pipeline but also rejects
     * non-`200` upstream responses, which prevents error pages from being treated
     * as playable audio.
     *
     * @param decodedTrack - Decoded track metadata being played.
     * @param url - Direct playback URL returned by `getTrackUrl(...)`.
     * @param _protocol - Protocol hint, unused by this source.
     * @param _additionalData - Additional stream metadata, unused by this source.
     * @returns Playable stream payload, or an exception payload when the
     * upstream request fails.
     */
    async loadStream(decodedTrack, url, _protocol, _additionalData) {
        logger('debug', 'Sources', `Loading Flowery TTS stream for "${decodedTrack.title}"`);
        const finalUrl = this.forceMp3Url(url).url;
        try {
            const response = await makeRequest(finalUrl, {
                method: 'GET',
                streamOnly: true,
                headers: {
                    'User-Agent': 'NodeLink/FloweryTTS',
                    Accept: '*/*'
                }
            });
            if (response.error || !response.stream) {
                throw new Error(response.error || 'Failed to get stream, no stream object returned.');
            }
            if (response.statusCode !== 200) {
                throw new Error(`Flowery TTS returned status ${response.statusCode}`);
            }
            const stream = new PassThrough();
            response.stream.pipe(stream);
            response.stream.on('end', () => {
                stream.emit('finishBuffering');
            });
            response.stream.on('error', (error) => {
                logger('error', 'Sources', `Flowery TTS stream error: ${error.message}`);
                if (!stream.destroyed) {
                    stream.destroy(error);
                }
            });
            return { stream };
        }
        catch (error) {
            const message = this.getErrorMessage(error instanceof Error ? error : String(error));
            logger('error', 'Sources', `Failed to load Flowery TTS stream: ${message}`);
            return {
                exception: {
                    message,
                    severity: 'common',
                    cause: 'Upstream'
                }
            };
        }
    }
}
