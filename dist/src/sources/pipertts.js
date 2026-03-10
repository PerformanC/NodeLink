import { PassThrough } from 'node:stream';
import { encodeTrack, logger, makeRequest } from "../utils.js";
/**
 * Piper TTS source implementation.
 */
export default class PiperSource {
    /**
     * Runtime worker context used by the source implementation.
     */
    nodelink;
    /**
     * Sanitized Piper-specific configuration.
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
     * Creates a new Piper TTS source wrapper.
     *
     * @param nodelink - Worker runtime used by the source implementation.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.config = this.getConfig();
        this.searchTerms = ['pipertts'];
        this.patterns = [/^pipertts:/];
        this.priority = 50;
    }
    /**
     * Reads and normalizes the Piper configuration from the shared runtime.
     *
     * @returns Sanitized Piper configuration with only the fields used by this
     * source preserved.
     */
    getConfig() {
        const sourceKey = 'pipertts';
        const rawConfig = this.nodelink.options.sources?.[sourceKey];
        return {
            enabled: rawConfig?.enabled === true,
            url: typeof rawConfig?.url === 'string' ? rawConfig.url : undefined,
            voice: typeof rawConfig?.voice === 'string' ? rawConfig.voice : undefined,
            speaker: typeof rawConfig?.speaker === 'string' ||
                typeof rawConfig?.speaker === 'number'
                ? rawConfig.speaker
                : undefined,
            speaker_id: typeof rawConfig?.speaker_id === 'string' ||
                typeof rawConfig?.speaker_id === 'number'
                ? rawConfig.speaker_id
                : undefined,
            length_scale: typeof rawConfig?.length_scale === 'number'
                ? rawConfig.length_scale
                : undefined,
            noise_scale: typeof rawConfig?.noise_scale === 'number'
                ? rawConfig.noise_scale
                : undefined,
            noise_w_scale: typeof rawConfig?.noise_w_scale === 'number'
                ? rawConfig.noise_w_scale
                : undefined
        };
    }
    /**
     * Builds the title shown for a synthesized Piper track.
     *
     * @param text - Requested TTS text.
     * @returns Original text, truncated to the same 50-character policy used by
     * the legacy JavaScript source.
     */
    buildTitle(text) {
        return text.length > 50 ? `${text.substring(0, 47)}...` : text;
    }
    /**
     * Creates the encoded track payload for a Piper text request.
     *
     * @param text - TTS text that should be synthesized.
     * @returns Track payload compatible with the shared encoder and source
     * manager contracts.
     */
    buildTrack(text) {
        const track = {
            identifier: text,
            isSeekable: true,
            author: 'Piper TTS',
            length: -1,
            isStream: false,
            position: 0,
            title: this.buildTitle(text),
            uri: `pipertts:${text}`,
            artworkUrl: null,
            isrc: null,
            sourceName: 'pipertts',
            details: []
        };
        return {
            encoded: encodeTrack(track),
            info: track,
            pluginInfo: {}
        };
    }
    /**
     * Converts a request URL into the text sent to the Piper API.
     *
     * The source preserves the existing behavior of appending `" tts"` when the
     * input text does not already end with that suffix.
     *
     * @param url - Resolved Piper source URL.
     * @returns Text payload forwarded to the upstream TTS service.
     */
    getRequestText(url) {
        let text = url.startsWith('pipertts:') ? url.slice(9) : url;
        if (!text.toLowerCase().endsWith(' tts')) {
            text = `${text} tts`;
        }
        return text;
    }
    /**
     * Builds the JSON payload sent to the upstream Piper service.
     *
     * @param text - Text that should be synthesized.
     * @returns Request body matching the legacy JavaScript source behavior.
     */
    buildRequestBody(text) {
        const body = { text };
        if (this.config.voice) {
            body.voice = this.config.voice;
        }
        if (this.config.speaker !== undefined) {
            body.speaker = this.config.speaker;
        }
        if (this.config.speaker_id !== undefined) {
            body.speaker_id = this.config.speaker_id;
        }
        if (this.config.length_scale !== undefined) {
            body.length_scale = this.config.length_scale;
        }
        if (this.config.noise_scale !== undefined) {
            body.noise_scale = this.config.noise_scale;
        }
        if (this.config.noise_w_scale !== undefined) {
            body.noise_w_scale = this.config.noise_w_scale;
        }
        return body;
    }
    /**
     * Extracts a readable error message from a caught runtime failure.
     *
     * @param error - Caught runtime failure.
     * @returns Human-readable message suitable for logs and exception payloads.
     */
    getErrorMessage(error) {
        return error instanceof Error ? error.message : error;
    }
    /**
     * Initializes the source.
     *
     * Piper is only considered ready when it is enabled and has an upstream URL
     * configured.
     *
     * @returns `true` when the source is enabled and ready to accept requests.
     */
    async setup() {
        if (!this.config.enabled) {
            logger('debug', 'Piper', 'Piper TTS source is disabled.');
            return false;
        }
        if (!this.config.url) {
            logger('warn', 'Piper', 'Piper TTS is enabled but no URL is configured. Source will be disabled.');
            return false;
        }
        logger('info', 'Sources', 'Loaded Piper TTS source.');
        return true;
    }
    /**
     * Searches the Piper source by turning the query directly into a synthetic
     * track.
     *
     * @param query - Raw Piper TTS query.
     * @returns A single synthesized track result, or an empty response when the
     * query is blank.
     */
    async search(query) {
        if (!query) {
            return { loadType: 'empty', data: {} };
        }
        const text = query.startsWith('pipertts:') ? query.slice(9) : query;
        const track = this.buildTrack(text);
        return {
            loadType: 'track',
            data: track
        };
    }
    /**
     * Resolves a Piper request into a synthesized track payload.
     *
     * The legacy source treats resolve and search the same way, so this method
     * delegates to {@link search}.
     *
     * @param query - Raw Piper TTS query or `pipertts:` URI.
     * @returns Same payload produced by {@link search}.
     */
    async resolve(query) {
        return this.search(query);
    }
    /**
     * Resolves the internal Piper track URL.
     *
     * Piper tracks already store the canonical `pipertts:` URI, so no additional
     * remote lookup is required here.
     *
     * @param track - Decoded Piper track information.
     * @returns Piper protocol descriptor used later by `loadStream(...)`.
     */
    async getTrackUrl(track) {
        return {
            url: track.uri,
            protocol: 'piper',
            format: 'wav'
        };
    }
    /**
     * Opens a synthesized audio stream from the configured Piper TTS service.
     *
     * The upstream response is proxied through a local `PassThrough` to preserve
     * the stream lifecycle expected by the playback pipeline.
     *
     * @param decodedTrack - Decoded track metadata being played.
     * @param url - Piper protocol URL returned by `getTrackUrl(...)`.
     * @param _protocol - Protocol hint, unused by this source.
     * @param _additionalData - Additional stream metadata, unused by this source.
     * @returns WAV stream payload, or an exception result when the upstream
     * service fails.
     */
    async loadStream(decodedTrack, url, _protocol, _additionalData) {
        logger('debug', 'Sources', `Loading Piper TTS stream for "${decodedTrack.title}"`);
        const requestText = this.getRequestText(url);
        const body = this.buildRequestBody(requestText);
        try {
            const response = await makeRequest(this.config.url ?? '', {
                method: 'POST',
                body: JSON.stringify(body),
                headers: {
                    'Content-Type': 'application/json'
                },
                streamOnly: true
            });
            if (response.error || !response.stream) {
                throw new Error(response.error || 'Failed to get stream, no stream object returned.');
            }
            if (response.statusCode !== 200) {
                throw new Error(`Piper TTS returned status ${response.statusCode}`);
            }
            const stream = new PassThrough();
            response.stream.pipe(stream);
            response.stream.on('end', () => {
                stream.emit('finishBuffering');
            });
            response.stream.on('error', (error) => {
                logger('error', 'Sources', `Piper TTS stream error: ${error.message}`);
                if (!stream.destroyed) {
                    stream.destroy(error);
                }
            });
            return { stream, type: 'wav' };
        }
        catch (error) {
            const message = this.getErrorMessage(error instanceof Error ? error : String(error));
            logger('error', 'Sources', `Failed to load Piper TTS stream: ${message}`);
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
