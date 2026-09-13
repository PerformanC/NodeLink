import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import HLSHandler from '../playback/hls/HLSHandler.js';
import { encodeTrack, http1makeRequest, logger } from '../utils.js';
const VIMEO_PATTERNS = [
    /^https?:\/\/(?:www\.)?vimeo\.com\/(\d+)(?:|[/?#])/i,
    /^https?:\/\/player\.vimeo\.com\/video\/(\d+)(?:|[/?#])/i,
    /^https?:\/\/(?:www\.)?vimeo\.com\/channels\/[^/]+\/(\d+)(?:|[/?#])/i,
    /^https?:\/\/(?:www\.)?vimeo\.com\/groups\/[^/]+\/videos\/(\d+)(?:|[/?#])/i,
    /^https?:\/\/(?:www\.)?vimeo\.com\/album\/\d+\/video\/(\d+)(?:|[/?#])/i,
    /^https?:\/\/(?:www\.)?vimeo\.com\/showcase\/\d+\/video\/(\d+)(?:|[/?#])/i
];
const VIMEO_BASE = 'https://vimeo.com';
const VIMEO_API_BASE = 'https://api.vimeo.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';
const REQUEST_TIMEOUT = 15000;
const HANDOFF_TTL = 15000;
const HANDOFF_MAX = 20;
const CDN_PRIORITY = ['akfire_interconnect_quic', 'fastly_skyfire'];
const PLAYER_QUERY = 'autoplay=0&muted=0&badge=1&title=0&portrait=0&byline=0&share=1&like=1&watch_later=1&transparent=0&ask_ai=0&transcript=0&preload=auto&chapters=1&airplay=1&audio_tracks=1&chromecast=1&cc=1&cc_track_menu=1&disable_context_menu=0&colors=000000%2C00adef%2Cffffff%2C000000&fullscreen=1&vimeo_logo=1&pip=1&playbar=1&play_button_position=auto&quality_selector=1&speed=1&skipping_forward=1&volume=1&outro=beginning';
function parseNextData(html) {
    const json = html.match(/<script\b[^>]*\bid\s*=\s*["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
    if (!json)
        return null;
    try {
        return JSON.parse(json);
    }
    catch {
        return null;
    }
}
function getSignature(pageProps) {
    const signature = pageProps.pageMetadata?.clipSignature;
    const jwt = pageProps.viewerBootstrap?.jwt;
    if (!pageProps.clipId || !signature || !jwt)
        return null;
    return {
        videoId: String(pageProps.clipId),
        value: signature,
        jwt
    };
}
function extractVideoId(url) {
    for (const pattern of VIMEO_PATTERNS) {
        const match = url.match(pattern);
        if (match?.[1])
            return match[1];
    }
    return null;
}
function extractHashParam(url) {
    try {
        return new URL(url).searchParams.get('h');
    }
    catch {
        return null;
    }
}
function getPlaylistDirectory(url) {
    const parsed = new URL(url);
    parsed.pathname = parsed.pathname.slice(0, parsed.pathname.lastIndexOf('/') + 1);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
}
function buildSegmentUrl(playlistUrl, basePath, trackPath, segmentPath) {
    if (/^https?:\/\//i.test(segmentPath))
        return segmentPath;
    return new URL(`${basePath}${trackPath}${segmentPath}`, getPlaylistDirectory(playlistUrl)).toString();
}
function selectAudioTrack(tracks) {
    const playable = tracks.filter((track) => track.segments?.length && track.init_segment);
    const candidates = playable.filter((track) => /mp4a|aac/i.test(track.codecs ?? ''));
    return (candidates.sort((a, b) => {
        const aSampleRate = a.sample_rate ?? a.audio_sample_rate ?? 0;
        const bSampleRate = b.sample_rate ?? b.audio_sample_rate ?? 0;
        if (aSampleRate !== bSampleRate)
            return bSampleRate - aSampleRate;
        return ((b.avg_bitrate ?? b.bitrate ?? 0) - (a.avg_bitrate ?? a.bitrate ?? 0));
    })[0] ?? null);
}
/**
 * Vimeo source implementation.
 *
 * Resolves public Vimeo pages through the anonymous player configuration flow
 * and streams the selected adaptive audio track.
 *
 * @public
 */
export default class VimeoSource {
    nodelink;
    config;
    searchTerms;
    patterns;
    priority;
    activeStreams = new Set();
    handoff = new Map();
    /**
     * Creates the Vimeo source.
     *
     * @param nodelink - NodeLink worker context.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.config = nodelink.options;
        this.searchTerms = [];
        this.patterns = VIMEO_PATTERNS;
        this.priority = 70;
    }
    /**
     * Initializes the source.
     *
     * @returns `true` when the source is ready.
     */
    async setup() {
        return true;
    }
    /**
     * Checks whether a URL belongs to Vimeo.
     *
     * @param url - Candidate URL.
     * @returns Whether the URL contains a supported Vimeo video id.
     */
    match(url) {
        return extractVideoId(url) !== null;
    }
    /**
     * Vimeo does not expose text search through this source.
     *
     * @returns Empty search result.
     */
    async search() {
        return { loadType: 'empty', data: {} };
    }
    /**
     * Resolves Vimeo metadata into an encoded track.
     *
     * @param url - Vimeo video URL.
     * @returns Resolved track or an empty result.
     */
    async resolve(url) {
        const videoId = extractVideoId(url);
        const hashParam = extractHashParam(url);
        if (!videoId)
            return { loadType: 'empty', data: {} };
        const metadata = await this.fetchVideoMetadata(videoId, hashParam);
        if (!metadata?.title)
            return { loadType: 'empty', data: {} };
        const trackInfo = {
            title: metadata.title,
            author: metadata.author || 'Unknown',
            length: metadata.durationMs,
            identifier: videoId,
            isSeekable: true,
            isStream: false,
            uri: `${VIMEO_BASE}/${videoId}${hashParam ? `?h=${hashParam}` : ''}`,
            artworkUrl: metadata.artworkUrl,
            isrc: null,
            sourceName: 'vimeo',
            position: 0,
            details: [],
            userData: hashParam ? { vimeo: { h: hashParam } } : undefined
        };
        return {
            loadType: 'track',
            data: {
                encoded: encodeTrack(trackInfo),
                info: trackInfo,
                pluginInfo: {}
            }
        };
    }
    /**
     * Resolves the playable Vimeo stream.
     *
     * @param decodedTrack - Decoded Vimeo track.
     * @returns Adaptive, HLS, or progressive stream descriptor.
     */
    async getTrackUrl(decodedTrack) {
        const videoId = decodedTrack.identifier;
        const hashParam = decodedTrack.userData?.vimeo?.h ?? null;
        if (!videoId) {
            return {
                exception: {
                    message: 'Invalid Vimeo track identifier',
                    severity: 'fault'
                }
            };
        }
        try {
            const config = await this.fetchPlayerConfig(videoId, hashParam);
            const result = await this.extractStream(config, videoId);
            if ('playlistData' in result && result.playlistData) {
                this.setHandoff(this.handoffKey(videoId, hashParam), result);
            }
            return result;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown Vimeo error';
            logger('warn', 'Vimeo', `Stream extraction failed: ${message}`);
            return {
                exception: {
                    message: `Failed to extract Vimeo stream: ${message}`,
                    severity: 'fault',
                    cause: 'Upstream'
                }
            };
        }
    }
    /**
     * Opens a Vimeo media stream.
     *
     * @param decodedTrack - Decoded Vimeo track.
     * @param url - URL returned by `getTrackUrl`.
     * @param protocol - Vimeo stream protocol.
     * @returns Playable stream result.
     */
    async loadStream(decodedTrack, url, protocol) {
        if (protocol === 'hls') {
            return {
                stream: new HLSHandler(url, {
                    headers: this.mediaHeaders(),
                    localAddress: this.nodelink.routePlanner?.getIP?.() ?? undefined,
                    type: 'mpegts'
                }),
                type: 'mpegts'
            };
        }
        const stream = new PassThrough({
            highWaterMark: 64 * 1024,
            emitClose: true,
            autoDestroy: true
        });
        this.activeStreams.add(stream);
        const cleanup = () => {
            this.activeStreams.delete(stream);
        };
        stream.once('close', cleanup);
        stream.once('error', cleanup);
        if (protocol === 'http' || protocol === 'https') {
            void this.pipeProgressive(url, stream);
            return { stream, type: 'mp4' };
        }
        if (protocol === 'segmented') {
            const hashParam = decodedTrack.userData?.vimeo?.h ?? null;
            const key = this.handoffKey(decodedTrack.identifier, hashParam);
            const result = this.takeHandoff(key) ?? (await this.fetchPlaylist(url));
            if (!result.playlistData) {
                stream.destroy(new Error('Vimeo playlist data is missing'));
                return { stream };
            }
            void this.pipeSegments(result.playlistData, stream);
            return { stream, type: result.format };
        }
        stream.destroy(new Error(`Unsupported Vimeo protocol: ${protocol}`));
        return { stream };
    }
    /**
     * Destroys active Vimeo streams and cached handoffs.
     */
    cleanupAllStreams() {
        for (const stream of this.activeStreams) {
            if (!stream.destroyed)
                stream.destroy();
        }
        this.activeStreams.clear();
        this.handoff.clear();
    }
    requestOptions(headers = {}) {
        return {
            headers: {
                'User-Agent': USER_AGENT,
                ...headers
            },
            timeout: REQUEST_TIMEOUT,
            maxResponseBodyBytes: 5 * 1024 * 1024
        };
    }
    mediaHeaders() {
        return {
            'User-Agent': USER_AGENT,
            Accept: '*/*',
            Origin: VIMEO_BASE,
            Referer: `${VIMEO_BASE}/`
        };
    }
    async fetchVideoMetadata(videoId, hashParam) {
        const targetUrl = `${VIMEO_BASE}/${videoId}${hashParam ? `?h=${hashParam}` : ''}`;
        const oembedUrl = `${VIMEO_BASE}/api/oembed.json?url=${encodeURIComponent(targetUrl)}`;
        try {
            const response = await http1makeRequest(oembedUrl, this.requestOptions({ Accept: 'application/json' }));
            const data = response.body;
            if (response.statusCode === 200 && data?.title) {
                return {
                    title: data.title,
                    author: data.author_name ?? 'Unknown',
                    durationMs: (data.duration ?? 0) * 1000,
                    artworkUrl: data.thumbnail_url ?? null
                };
            }
        }
        catch { }
        try {
            const response = await http1makeRequest(`${VIMEO_BASE}/api/v2/video/${videoId}.json`, this.requestOptions({ Accept: 'application/json' }));
            const data = response.body;
            const video = Array.isArray(data) ? data[0] : undefined;
            if (response.statusCode !== 200 || !video?.title)
                return null;
            return {
                title: video.title,
                author: video.user_name ?? 'Unknown',
                durationMs: (video.duration ?? 0) * 1000,
                artworkUrl: video.thumbnail_large ?? video.thumbnail_medium ?? null
            };
        }
        catch {
            return null;
        }
    }
    async fetchPlayerConfig(videoId, hashParam) {
        const pageUrl = `${VIMEO_BASE}/${videoId}${hashParam ? `?h=${hashParam}` : ''}`;
        const signature = getSignature(await this.fetchNextPageProps(videoId, hashParam));
        if (!signature) {
            throw new Error('Vimeo anonymous credentials were not found');
        }
        const apiUrl = new URL(`/videos/${signature.videoId}?${PLAYER_QUERY}`, VIMEO_API_BASE);
        apiUrl.searchParams.set('anon_signature', signature.value);
        apiUrl.searchParams.set('fields', 'type,embed_player_config_url,width,height,live.recurring_event.link,live.recurring_event.stream_privacy.unlisted_hash,player_embed_url');
        const api = await http1makeRequest(apiUrl.toString(), {
            ...this.requestOptions({
                Accept: 'application/vnd.vimeo.*+json;version=3.4.12',
                Authorization: `jwt ${signature.jwt}`,
                'Content-Type': 'application/json',
                'Vimeo-Page': '/video/[clipId]',
                'Accept-Language': 'en',
                Referer: `${VIMEO_BASE}/`
            }),
            maxRetries: 0
        });
        const apiData = (typeof api.body === 'string' ? JSON.parse(api.body) : api.body);
        if (api.statusCode !== 200 || !apiData?.embed_player_config_url) {
            throw new Error(`Vimeo anonymous API returned HTTP ${api.statusCode ?? 0}`);
        }
        const config = await http1makeRequest(apiData.embed_player_config_url, this.requestOptions({
            Accept: 'application/json',
            Referer: pageUrl,
            Origin: VIMEO_BASE
        }));
        if (config.statusCode !== 200 || !config.body) {
            throw new Error(`Vimeo player config returned HTTP ${config.statusCode ?? 0}`);
        }
        return config.body;
    }
    async fetchNextPageProps(videoId, hashParam) {
        const watch = await http1makeRequest(`${VIMEO_BASE}/watch`, this.requestOptions({
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }));
        if (watch.statusCode !== 200 || typeof watch.body !== 'string') {
            throw new Error(`Vimeo bootstrap returned HTTP ${watch.statusCode ?? 0}`);
        }
        const nextData = parseNextData(watch.body);
        if (!nextData?.buildId || !nextData.locale) {
            throw new Error('Vimeo Next.js bootstrap data was not found');
        }
        // i never hated the devtools debugger as much as i do now. im going crazy w vimeo.
        const dataUrl = new URL(`/_next/data/${encodeURIComponent(nextData.buildId)}/${encodeURIComponent(nextData.locale)}/${encodeURIComponent(videoId)}.json`, VIMEO_BASE);
        if (hashParam)
            dataUrl.searchParams.set('h', hashParam);
        const page = await http1makeRequest(dataUrl.toString(), {
            ...this.requestOptions({
                Accept: 'application/json',
                'Accept-Language': nextData.locale,
                'x-nextjs-data': '1',
                Referer: `${VIMEO_BASE}/watch`
            }),
            maxRetries: 0
        });
        const pageData = page.body;
        if (page.statusCode !== 200 || !pageData?.pageProps) {
            throw new Error(`Vimeo video data returned HTTP ${page.statusCode ?? 0}`);
        }
        return pageData.pageProps;
    }
    async extractStream(config, videoId) {
        const files = this.findFiles(config);
        if (!files)
            throw new Error('Vimeo player config has no files');
        const dash = files.dash;
        if (dash?.cdns) {
            const cdn = this.pickCdn(dash.cdns, dash.default_cdn);
            const playlistUrl = cdn?.url ?? cdn?.avc_url;
            if (playlistUrl) {
                try {
                    return await this.fetchPlaylist(playlistUrl);
                }
                catch (error) {
                    logger('debug', 'Vimeo', `DASH audio failed for ${videoId}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        }
        const hls = files.hls;
        if (hls?.cdns) {
            const cdn = this.pickCdn(hls.cdns, hls.default_cdn);
            if (cdn?.url) {
                return {
                    url: cdn.url,
                    protocol: 'hls',
                    format: 'mpegts',
                    additionalData: { source: 'vimeo.hls' }
                };
            }
        }
        const progressive = [...(files.progressive ?? [])].sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];
        if (progressive?.url) {
            return {
                url: progressive.url,
                protocol: 'https',
                format: 'mp4',
                additionalData: {
                    source: 'vimeo.progressive',
                    quality: progressive.quality,
                    height: progressive.height ?? 0
                }
            };
        }
        throw new Error('Vimeo player config has no playable streams');
    }
    findFiles(config) {
        const files = config.request?.files ??
            config.video?.files ??
            config.files ??
            config.clip?.files;
        if (files)
            return files;
        const nested = config.config ?? config.player?.config ?? config.data?.config;
        return nested ? this.findFiles(nested) : null;
    }
    pickCdn(cdns, defaultCdn) {
        for (const name of CDN_PRIORITY) {
            if (cdns[name])
                return cdns[name];
        }
        return ((defaultCdn ? cdns[defaultCdn] : undefined) ??
            Object.values(cdns)[0] ??
            null);
    }
    async fetchPlaylist(playlistUrl) {
        const response = await http1makeRequest(playlistUrl, {
            ...this.requestOptions(this.mediaHeaders()),
            maxResponseBodyBytes: 2 * 1024 * 1024
        });
        if (response.statusCode !== 200) {
            throw new Error(`Vimeo playlist returned HTTP ${response.statusCode ?? 0}`);
        }
        const playlist = response.body;
        const audio = selectAudioTrack(playlist.audio ?? []);
        if (audio)
            return this.buildAudioResult(playlistUrl, playlist, audio);
        const video = [...(playlist.video ?? [])].sort((a, b) => (b.avg_bitrate ?? b.bitrate ?? 0) - (a.avg_bitrate ?? a.bitrate ?? 0))[0];
        if (video?.segments?.length) {
            return this.buildVideoResult(playlistUrl, playlist, video);
        }
        throw new Error('Vimeo playlist has no compatible audio track');
    }
    buildAudioResult(playlistUrl, playlist, audio) {
        const codecs = audio.codecs ?? '';
        const playlistData = {
            playlistUrl,
            basePath: this.withTrailingSlash(playlist.base_url),
            trackPath: this.withTrailingSlash(audio.base_url),
            initSegment: audio.init_segment ?? null,
            segments: audio.segments ?? [],
            duration: audio.duration,
            bitrate: audio.avg_bitrate ?? audio.bitrate,
            codecs,
            sampleRate: audio.sample_rate ?? audio.audio_sample_rate ?? 48000,
            clipId: playlist.clip_id,
            isDashFormat: audio.format === 'dash',
            streamType: 'mp4'
        };
        logger('debug', 'Vimeo', `Selected AAC audio: ${codecs}, ${playlistData.bitrate ?? 0}bps`);
        return {
            url: playlistUrl,
            protocol: 'segmented',
            format: 'mp4',
            playlistData,
            additionalData: {
                source: 'vimeo.adaptive',
                bitrate: playlistData.bitrate,
                codecs,
                segments: playlistData.segments.length,
                sampleRate: playlistData.sampleRate,
                format: audio.format
            }
        };
    }
    buildVideoResult(playlistUrl, playlist, video) {
        return {
            url: playlistUrl,
            protocol: 'segmented',
            format: 'mp4',
            playlistData: {
                playlistUrl,
                basePath: this.withTrailingSlash(playlist.base_url),
                trackPath: this.withTrailingSlash(video.base_url),
                initSegment: video.init_segment ?? null,
                segments: video.segments ?? [],
                duration: video.duration,
                bitrate: video.avg_bitrate ?? video.bitrate,
                codecs: video.codecs,
                clipId: playlist.clip_id,
                isDashFormat: video.format === 'dash',
                streamType: 'mp4'
            },
            additionalData: {
                source: 'vimeo.video-fallback',
                segments: video.segments?.length ?? 0
            }
        };
    }
    async pipeProgressive(url, output) {
        try {
            const response = await http1makeRequest(url, {
                ...this.requestOptions(this.mediaHeaders()),
                streamOnly: true
            });
            if (response.statusCode !== 200 || !response.stream) {
                throw new Error(`Vimeo progressive stream returned HTTP ${response.statusCode ?? 0}`);
            }
            await pipeline(response.stream, output);
            output.emit('finishBuffering');
        }
        catch (error) {
            if (!output.destroyed) {
                output.destroy(error instanceof Error ? error : new Error(String(error)));
            }
        }
    }
    async pipeSegments(playlist, output) {
        try {
            if (playlist.initSegment) {
                await this.write(output, Buffer.from(playlist.initSegment, 'base64'));
            }
            for (const segment of playlist.segments) {
                if (output.destroyed || !segment.url)
                    return;
                const url = buildSegmentUrl(playlist.playlistUrl, playlist.basePath, playlist.trackPath, segment.url);
                const response = await http1makeRequest(url, {
                    ...this.requestOptions(this.mediaHeaders()),
                    responseType: 'buffer',
                    maxResponseBodyBytes: 5 * 1024 * 1024
                });
                if (response.statusCode !== 200 || !Buffer.isBuffer(response.body)) {
                    throw new Error(`Vimeo segment returned HTTP ${response.statusCode ?? 0}`);
                }
                await this.write(output, response.body);
            }
            if (!output.destroyed) {
                output.emit('finishBuffering');
                output.end();
            }
        }
        catch (error) {
            if (!output.destroyed) {
                output.destroy(error instanceof Error ? error : new Error(String(error)));
            }
        }
    }
    async write(output, chunk) {
        if (output.write(chunk))
            return;
        await once(output, 'drain');
    }
    withTrailingSlash(value) {
        if (!value)
            return '';
        return value.endsWith('/') ? value : `${value}/`;
    }
    handoffKey(videoId, hashParam) {
        return `${videoId}:${hashParam ?? ''}`;
    }
    setHandoff(key, value) {
        const now = Date.now();
        for (const [entryKey, entry] of this.handoff) {
            if (entry.expiresAt <= now)
                this.handoff.delete(entryKey);
        }
        while (this.handoff.size >= HANDOFF_MAX) {
            const firstKey = this.handoff.keys().next().value;
            if (typeof firstKey === 'string')
                this.handoff.delete(firstKey);
        }
        this.handoff.set(key, { value, expiresAt: now + HANDOFF_TTL });
    }
    takeHandoff(key) {
        const entry = this.handoff.get(key);
        this.handoff.delete(key);
        if (!entry || entry.expiresAt <= Date.now())
            return null;
        return entry.value;
    }
}
