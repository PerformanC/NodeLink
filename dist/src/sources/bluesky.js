import { PassThrough } from 'node:stream';
import HLSHandler from "../playback/hls/HLSHandler.js";
import { parse as parsePlaylist } from "../playback/hls/PlaylistParser.js";
import { encodeTrack, http1makeRequest, logger, makeRequest } from "../utils.js";
/**
 * Bluesky source implementation.
 */
export default class BlueskySource {
    /**
     * Runtime worker context used by the source implementation.
     */
    nodelink;
    /**
     * Sanitized runtime configuration for this source.
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
     * Creates a new Bluesky source wrapper.
     *
     * @param nodelink - Worker runtime used by the source implementation.
     */
    constructor(nodelink) {
        const options = nodelink.options;
        this.nodelink = nodelink;
        this.config = {
            maxSearchResults: typeof options.maxSearchResults === 'number'
                ? options.maxSearchResults
                : undefined
        };
        this.searchTerms = ['bksearch'];
        this.patterns = [
            /https?:\/\/(?:www\.)?(?:bsky\.app|main\.bsky\.dev)\/profile\/(?<handle>[\w.:%-]+)\/post\/(?<id>\w+)/,
            /at:\/\/(?<handle>[\w.:%-]+)\/app\.bsky\.feed\.post\/(?<id>\w+)/
        ];
    }
    /**
     * Validates whether the provided value is a plain object record.
     *
     * @param value - Candidate response payload.
     * @returns `true` when the value can be safely indexed.
     */
    isObjectRecord(value) {
        return (value !== null &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            !Buffer.isBuffer(value));
    }
    /**
     * Narrows a DID document response to the subset used by this source.
     *
     * @param value - Raw response body.
     * @returns Typed DID document, or `null` when the payload shape is invalid.
     */
    getDidDocument(value) {
        if (!this.isObjectRecord(value)) {
            return null;
        }
        const payload = value;
        if (payload.service !== undefined && !Array.isArray(payload.service)) {
            return null;
        }
        return {
            service: payload.service ?? undefined
        };
    }
    /**
     * Narrows a Bluesky search response.
     *
     * @param value - Raw response body.
     * @returns Typed search response, or `null` when the payload shape is
     * invalid.
     */
    getSearchResponse(value) {
        if (!this.isObjectRecord(value)) {
            return null;
        }
        const payload = value;
        if (payload.posts !== undefined && !Array.isArray(payload.posts)) {
            return null;
        }
        return {
            posts: payload.posts ?? undefined
        };
    }
    /**
     * Narrows a Bluesky thread response.
     *
     * @param value - Raw response body.
     * @returns Typed thread response, or `null` when the payload shape is
     * invalid.
     */
    getThreadResponse(value) {
        if (!this.isObjectRecord(value)) {
            return null;
        }
        return value;
    }
    /**
     * Extracts the handle and id captured by the supported Bluesky URL patterns.
     *
     * @param url - Candidate Bluesky URL or AT URI.
     * @returns Parsed handle/id pair, or `null` when the URL does not match.
     */
    parsePostReference(url) {
        for (const pattern of this.patterns) {
            const match = pattern.exec(url);
            const groups = match?.groups;
            const handle = groups?.handle;
            const id = groups?.id;
            if (typeof handle === 'string' && typeof id === 'string') {
                return { handle, id };
            }
        }
        return null;
    }
    /**
     * Extracts the playable media embed from a Bluesky post.
     *
     * @param post - Candidate Bluesky post.
     * @returns Media embed payload, or `null` when the post has no supported
     * media.
     */
    getPlayableEmbed(post) {
        const embed = post.embed?.media ?? post.embed;
        if (!embed) {
            return null;
        }
        return {
            playlist: embed.playlist,
            cid: embed.cid,
            thumbnail: embed.thumbnail,
            video: embed.video
        };
    }
    /**
     * Determines whether a built track payload is non-null.
     *
     * @param track - Candidate track payload.
     * @returns `true` when the value is a track payload.
     */
    isTrackData(track) {
        return track !== null;
    }
    /**
     * Resolves the user's PDS endpoint from their DID.
     *
     * @param did - Author DID.
     * @returns PDS endpoint URL, or the default Bluesky PDS when lookup fails.
     */
    async getServiceEndpoint(did) {
        const didUrl = did.startsWith('did:web:')
            ? `https://${did.slice(8)}/.well-known/did.json`
            : `https://plc.directory/${did}`;
        const response = await makeRequest(didUrl, { method: 'GET' });
        const document = this.getDidDocument(response.body);
        if (response.error || !document?.service) {
            return 'https://bsky.social';
        }
        const pds = document.service.find((entry) => entry.type === 'AtprotoPersonalDataServer');
        return pds?.serviceEndpoint || 'https://bsky.social';
    }
    /**
     * Computes the duration of an HLS playlist by summing its media segments.
     *
     * @param playlistUrl - HLS playlist URL.
     * @returns Duration in milliseconds, or `0` when the playlist cannot be
     * parsed.
     */
    async getDuration(playlistUrl) {
        try {
            const response = await makeRequest(playlistUrl, { method: 'GET' });
            if (response.error ||
                response.statusCode !== 200 ||
                typeof response.body !== 'string') {
                return 0;
            }
            const parsed = parsePlaylist(response.body, playlistUrl);
            if (parsed.isMaster) {
                const firstVariant = parsed.variants[0];
                return firstVariant ? this.getDuration(firstVariant.url) : 0;
            }
            let durationSeconds = 0;
            for (const segment of parsed.segments) {
                durationSeconds += segment.duration;
            }
            return Math.round(durationSeconds * 1000);
        }
        catch {
            return 0;
        }
    }
    /**
     * Builds the public API URL used to resolve a single Bluesky post.
     *
     * @param handle - Author handle.
     * @param id - Post id.
     * @returns Fully qualified public API URL.
     */
    buildThreadUrl(handle, id) {
        return `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=at://${handle}/app.bsky.feed.post/${id}&depth=0`;
    }
    /**
     * Builds the encoded track payload for a Bluesky post.
     *
     * @param post - Resolved Bluesky post.
     * @returns Encoded track payload, or `null` when the post has no playable
     * media.
     */
    async buildTrack(post) {
        const embed = this.getPlayableEmbed(post);
        if (!embed) {
            return null;
        }
        const videoCid = embed.cid ?? embed.video?.ref?.$link ?? null;
        const playlistUrl = embed.playlist;
        if (!playlistUrl && !videoCid) {
            return null;
        }
        const handle = post.author?.handle;
        const id = post.uri?.split('/').pop();
        if (!handle || !id) {
            return null;
        }
        const rawTitle = post.record?.text ?? post.value?.text ?? 'Bluesky Media';
        const title = rawTitle.split('\n')[0]?.slice(0, 72) || 'Bluesky Media';
        const author = post.author?.displayName || handle;
        const length = playlistUrl ? await this.getDuration(playlistUrl) : 0;
        const trackInfo = {
            identifier: id,
            isSeekable: true,
            author,
            length,
            isStream: false,
            position: 0,
            title,
            uri: `https://bsky.app/profile/${handle}/post/${id}`,
            artworkUrl: embed.thumbnail ?? post.author?.avatar ?? null,
            isrc: null,
            sourceName: 'bluesky',
            details: []
        };
        return {
            encoded: encodeTrack(trackInfo),
            info: trackInfo,
            pluginInfo: {}
        };
    }
    /**
     * Initializes the source.
     *
     * @returns `true` once the source has been registered.
     */
    async setup() {
        return true;
    }
    /**
     * Searches public Bluesky posts and filters down to posts with playable
     * media.
     *
     * @param query - Search query.
     * @returns Search result payload or an empty result when no playable posts
     * are found.
     */
    async search(query) {
        logger('debug', 'Bluesky', `Searching for: ${query}`);
        const searchUrl = `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(query)}` +
            `&limit=${this.config.maxSearchResults ?? 10}`;
        const response = await makeRequest(searchUrl, { method: 'GET' });
        const searchResponse = this.getSearchResponse(response.body);
        if (response.error || !searchResponse?.posts) {
            return { loadType: 'empty', data: {} };
        }
        const tracks = (await Promise.all(searchResponse.posts.map((post) => this.buildTrack(post)))).filter((track) => this.isTrackData(track));
        return tracks.length > 0
            ? { loadType: 'search', data: tracks }
            : { loadType: 'empty', data: {} };
    }
    /**
     * Resolves a Bluesky post URL into a single track payload.
     *
     * @param url - Candidate Bluesky URL or AT URI.
     * @returns Track result payload, an empty result when the post has no
     * playable media, or an exception payload when the URL is malformed.
     */
    async resolve(url) {
        const reference = this.parsePostReference(url);
        if (!reference) {
            return { loadType: 'empty', data: {} };
        }
        logger('debug', 'Bluesky', `Resolving post: ${reference.id} by ${reference.handle}`);
        const response = await makeRequest(this.buildThreadUrl(reference.handle, reference.id), { method: 'GET' });
        const threadResponse = this.getThreadResponse(response.body);
        const post = threadResponse?.thread?.post;
        if (response.error || !post) {
            return { loadType: 'empty', data: {} };
        }
        const track = await this.buildTrack(post);
        return track
            ? { loadType: 'track', data: track }
            : { loadType: 'empty', data: {} };
    }
    /**
     * Resolves the direct playable URL for a Bluesky media post.
     *
     * @param decodedTrack - Decoded Bluesky track information.
     * @returns Direct HLS or blob URL descriptor, or an exception payload when
     * the track URI cannot be resolved.
     */
    async getTrackUrl(decodedTrack) {
        const reference = this.parsePostReference(decodedTrack.uri);
        if (!reference) {
            return {
                exception: {
                    message: 'Invalid Bluesky track URI',
                    severity: 'common'
                }
            };
        }
        const response = await makeRequest(this.buildThreadUrl(reference.handle, reference.id), { method: 'GET' });
        const threadResponse = this.getThreadResponse(response.body);
        const post = threadResponse?.thread?.post;
        if (response.error || !post) {
            return {
                exception: {
                    message: 'Failed to fetch Bluesky post for streaming',
                    severity: 'fault'
                }
            };
        }
        const embed = this.getPlayableEmbed(post);
        if (!embed) {
            return {
                exception: {
                    message: 'No media found in Bluesky post',
                    severity: 'common'
                }
            };
        }
        if (embed.playlist) {
            return {
                url: embed.playlist,
                protocol: 'hls',
                format: 'mpegts'
            };
        }
        const videoCid = embed.cid ?? embed.video?.ref?.$link ?? null;
        if (videoCid && post.author?.did) {
            const endpoint = await this.getServiceEndpoint(post.author.did);
            return {
                url: `${endpoint}/xrpc/com.atproto.sync.getBlob?did=${post.author.did}&cid=${videoCid}`,
                protocol: 'https',
                format: 'mp4'
            };
        }
        return {
            exception: {
                message: 'This Bluesky post does not contain a direct video or audio stream.',
                severity: 'common'
            }
        };
    }
    /**
     * Opens a Bluesky media stream from either HLS or a direct blob URL.
     *
     * @param decodedTrack - Decoded Bluesky track metadata.
     * @param url - Direct HLS or blob URL returned by `getTrackUrl(...)`.
     * @param protocol - Stream protocol hint returned by `getTrackUrl(...)`.
     * @param additionalData - Optional resume metadata.
     * @returns Playable stream payload, or an exception payload when the
     * upstream request fails.
     */
    async loadStream(decodedTrack, url, protocol, additionalData) {
        logger('debug', 'Bluesky', `Loading stream for ${decodedTrack.identifier} via ${protocol}`);
        if (protocol === 'hls') {
            const stream = new HLSHandler(url, {
                startTime: additionalData?.startTime,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36'
                }
            });
            return { stream, type: 'mpegts' };
        }
        const response = await http1makeRequest(url, {
            method: 'GET',
            streamOnly: true,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36'
            }
        });
        if (response.error || !response.stream) {
            return {
                exception: {
                    message: `Failed to load Bluesky stream: ${response.error || 'No stream object returned.'}`,
                    severity: 'fault'
                }
            };
        }
        if (response.statusCode !== 200) {
            return {
                exception: {
                    message: `Failed to load Bluesky stream: status ${response.statusCode}`,
                    severity: 'fault'
                }
            };
        }
        const upstream = response.stream;
        const stream = new PassThrough();
        upstream.on('data', (chunk) => {
            if (!stream.write(chunk)) {
                upstream.pause();
            }
        });
        stream.on('drain', () => {
            if (!stream.destroyed) {
                upstream.resume();
            }
        });
        upstream.on('end', () => {
            if (!stream.writableEnded) {
                stream.emit('finishBuffering');
                stream.end();
            }
        });
        upstream.on('error', (error) => {
            logger('error', 'Bluesky', `Upstream stream error: ${error.message}`);
            if (!stream.destroyed) {
                stream.destroy(error);
            }
        });
        return { stream, type: 'mp4' };
    }
}
