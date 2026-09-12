/**
 * Audio sample rate for Discord voice connections
 *
 * Discord requires all audio to be encoded at 48kHz (48000 Hz).
 * This constant is used throughout the audio processing pipeline
 * to ensure proper encoding, filtering, and format conversion.
 *
 * @remarks
 * This value must match Discord's voice gateway requirements.
 * Using a different sample rate will result in audio playback issues.
 *
 * @example
 * ```ts
 * const resampler = createResampler(inputRate, SAMPLE_RATE)
 * ```
 *
 * @public
 */
export const SAMPLE_RATE = 48000;
/**
 * Regular expression to validate Discord snowflake IDs
 *
 * Discord uses snowflake IDs for all entities (users, guilds, channels, etc.).
 * Snowflakes are 64-bit unsigned integers represented as strings, typically
 * 18-19 digits in length. This regex validates the format but does not
 * guarantee the ID exists or is valid for your use case.
 *
 * @remarks
 * Snowflakes encode timestamp, worker ID, process ID, and increment.
 * IDs created before 2015 may be shorter than 18 digits.
 *
 * @example
 * ```ts
 * if (DISCORD_ID_REGEX.test(guildId)) {
 *   // Valid format
 * }
 * ```
 *
 * @see {@link https://discord.com/developers/docs/reference#snowflakes}
 * @public
 */
export const DISCORD_ID_REGEX = /^\d{18,19}$/;
/**
 * Regular expression pattern to parse semantic versioning strings
 *
 * Parses version strings following the Semantic Versioning 2.0.0 specification.
 * Captures major, minor, patch, prerelease, and build metadata components
 * as named groups for easy extraction.
 *
 * @remarks
 * Named groups available:
 * - `major`: Major version number (breaking changes)
 * - `minor`: Minor version number (new features)
 * - `patch`: Patch version number (bug fixes)
 * - `prerelease`: Pre-release identifier (e.g., "alpha.1", "beta.2")
 * - `build`: Build metadata (e.g., "20130313144700")
 *
 * @example
 * ```ts
 * const match = SEMVER_PATTERN.exec("1.2.3-beta.1+build.456")
 * console.log(match.groups.major)  // "1"
 * console.log(match.groups.minor)  // "2"
 * console.log(match.groups.patch)  // "3"
 * console.log(match.groups.prerelease)  // "beta.1"
 * console.log(match.groups.build)  // "build.456"
 * ```
 *
 * @see {@link https://semver.org/}
 * @public
 */
export const SEMVER_PATTERN = /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<prerelease>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+(?<build>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
/**
 * API version path prefix for NodeLink endpoints
 *
 * All NodeLink API endpoints are prefixed with this version identifier
 * to maintain backwards compatibility when introducing breaking changes.
 * This follows REST API versioning best practices.
 *
 * @remarks
 * Current version: v4 (Lavalink-compatible)
 *
 * @example
 * ```ts
 * const endpoint = `/${PATH_VERSION}/loadtracks`
 * // Results in: "/v4/loadtracks"
 * ```
 *
 * @public
 */
export const PATH_VERSION = 'v4';
export const MINIMUM_NODE_VERSION = '22.22.2';
/**
 * HTTP status codes that indicate a redirect response
 *
 * List of HTTP status codes that require following a redirect to the
 * Location header. Used by HTTP clients to automatically follow redirects
 * up to a maximum limit.
 *
 * @remarks
 * Status code meanings:
 * - `301` - Moved Permanently (cacheable)
 * - `302` - Found (temporary, not cacheable)
 * - `303` - See Other (use GET for redirect)
 * - `307` - Temporary Redirect (preserve method)
 * - `308` - Permanent Redirect (preserve method)
 *
 * @see {@link DEFAULT_MAX_REDIRECTS}
 * @public
 */
export const REDIRECT_STATUS_CODES = [301, 302, 303, 307, 308];
/**
 * Default maximum number of HTTP redirects to follow
 *
 * Limits the number of redirects an HTTP client will follow automatically
 * to prevent infinite redirect loops and excessive network requests.
 * Most HTTP libraries use a similar limit (5-10 redirects).
 *
 * @remarks
 * If this limit is exceeded, the request should fail with an error
 * indicating too many redirects.
 *
 * @see {@link REDIRECT_STATUS_CODES}
 * @public
 */
export const DEFAULT_MAX_REDIRECTS = 5;
/**
 * Maximum number of concurrent HLS segment downloads
 *
 * Limits the number of HLS media segments that can be downloaded
 * simultaneously. This prevents overwhelming the network or target
 * server with too many concurrent connections while maintaining
 * reasonable throughput for live streams.
 *
 * @remarks
 * Higher values increase memory usage and may trigger rate limits.
 * Lower values reduce bandwidth usage but may cause buffering.
 * Value of 5 provides a good balance for most use cases.
 *
 * @public
 */
export const HLS_SEGMENT_DOWNLOAD_CONCURRENCY_LIMIT = 5;
/**
 * WebSocket gateway event types sent from server to clients
 *
 * These event type identifiers are used in WebSocket messages to indicate
 * what kind of event occurred on the server. Clients should listen for
 * these event types to handle player state changes, track events, and
 * connection status updates.
 *
 * @remarks
 * Event categories:
 * - **Connection Events**: WEBSOCKET_CLOSED, CONNECTION_STATUS, PLAYER_RECONNECTING, PLAYER_CONNECTED
 * - **Track Events**: TRACK_START, TRACK_END, TRACK_STUCK, TRACK_EXCEPTION
 * - **Player State Events**: PLAYER_UPDATE, PAUSE, SEEK, VOLUME_CHANGED, FILTERS_CHANGED
 * - **Player Lifecycle Events**: PLAYER_CREATED, PLAYER_DESTROYED
 * - **Mix Events**: MIX_STARTED, MIX_ENDED (for track mixing)
 * - **Special Events**: ETERNALBOX_INFO, ETERNALBOX_JUMP (for continuous playback)
 * - **Stream Events**: STREAM_METADATA (for live stream metadata updates)
 *
 * @example
 * ```ts
 * socket.on('message', (data) => {
 *   const message = JSON.parse(data)
 *   if (message.type === GatewayEvents.TRACK_START) {
 *     console.log('Track started:', message.track)
 *   }
 * })
 * ```
 *
 * @public
 */
export const GatewayEvents = {
    /** WebSocket connection was closed */
    WEBSOCKET_CLOSED: 'WebSocketClosedEvent',
    /** Track finished playing */
    TRACK_END: 'TrackEndEvent',
    /** Track started playing */
    TRACK_START: 'TrackStartEvent',
    /** Track is stuck and not progressing */
    TRACK_STUCK: 'TrackStuckEvent',
    /** An exception occurred while playing track */
    TRACK_EXCEPTION: 'TrackExceptionEvent',
    /** SponsorBlock segments were loaded */
    SPONSORBLOCK_SEGMENTS_LOADED: 'SponsorBlockSegmentsLoadedEvent',
    /** SponsorBlock segment was skipped */
    SPONSORBLOCK_SEGMENT_SKIPPED: 'SponsorBlockSegmentSkippedEvent',
    /** Player position/state update */
    PLAYER_UPDATE: 'playerUpdate',
    /** Voice connection status changed */
    CONNECTION_STATUS: 'ConnectionStatusEvent',
    /** Player volume was changed */
    VOLUME_CHANGED: 'VolumeChangedEvent',
    /** Audio filters were changed */
    FILTERS_CHANGED: 'FiltersChangedEvent',
    /** Track position was seeked */
    SEEK: 'SeekEvent',
    /** Player was paused or resumed */
    PAUSE: 'PauseEvent',
    /** New player instance was created */
    PLAYER_CREATED: 'PlayerCreatedEvent',
    /** Player instance was destroyed */
    PLAYER_DESTROYED: 'PlayerDestroyedEvent',
    /** Player is reconnecting to voice */
    PLAYER_RECONNECTING: 'PlayerReconnectingEvent',
    /** Player successfully connected to voice */
    PLAYER_CONNECTED: 'PlayerConnectedEvent',
    /** Track mixing started */
    MIX_STARTED: 'MixStartedEvent',
    /** Track mixing ended */
    MIX_ENDED: 'MixEndedEvent',
    /** EternalBox continuous playback info update */
    ETERNALBOX_INFO: 'EternalBoxInfoEvent',
    /** EternalBox jumped to different track in queue */
    ETERNALBOX_JUMP: 'EternalBoxJumpEvent',
    /** Live stream metadata was updated */
    STREAM_METADATA: 'StreamMetadataEvent'
};
/**
 * Track end reason types indicating why a track stopped playing
 *
 * These reasons are included in TRACK_END events to inform clients
 * why playback ended. This information is crucial for implementing
 * proper queue management, error handling, and autoplay features.
 *
 * @remarks
 * Reason meanings:
 * - `STOPPED`: User manually stopped playback (should not auto-advance queue)
 * - `FINISHED`: Track completed naturally (should auto-advance queue)
 * - `LOAD_FAILED`: Track failed to load or stream (error condition)
 * - `REPLACED`: Track was replaced by another track (should not auto-advance)
 * - `CLEANUP`: Track ended due to cleanup/destroy operation (internal)
 * - `GAPLESS`: Track ended for gapless transition (seamless playback)
 * - `CROSSFADE`: Track ended after overlapping with a preloaded next track
 *
 * @example
 * ```ts
 * if (trackEndEvent.reason === EndReasons.FINISHED) {
 *   // Play next track in queue
 *   playNextTrack()
 * } else if (trackEndEvent.reason === EndReasons.LOAD_FAILED) {
 *   // Handle error and skip to next track
 *   handleTrackError()
 *   playNextTrack()
 * }
 * ```
 *
 * @public
 */
export const EndReasons = {
    /** Playback was manually stopped by user or bot */
    STOPPED: 'stopped',
    /** Track finished playing completely */
    FINISHED: 'finished',
    /** Track failed to load or stream error occurred */
    LOAD_FAILED: 'loadFailed',
    /** Track was replaced with a different track */
    REPLACED: 'replaced',
    /** Track ended due to cleanup or player destruction */
    CLEANUP: 'cleanup',
    /** Track ended for gapless transition to next track */
    GAPLESS: 'gapless',
    /** Track ended after a crossfade transition */
    CROSSFADE: 'crossfading'
};
/**
 * Supported audio format identifiers for stream processing
 *
 * Identifies the audio codec or container format used by a media stream.
 * Different formats require different decoding strategies and may have
 * different quality/performance characteristics.
 *
 * @remarks
 * Format characteristics:
 * - `OPUS`: Modern, efficient codec optimized for voice/music (WebM container)
 * - `AAC`: Widely used format, excellent quality/compression (MP4/HLS)
 * - `MPEG`: Legacy format, universal compatibility (MP3)
 * - `FLAC`: Lossless compression, highest quality, larger file size
 * - `OGG_VORBIS`: Open-source alternative to MP3, good quality
 * - `WAV`: Uncompressed PCM audio, maximum quality, very large
 * - `FLV`: Flash video container, used by older streaming platforms
 * - `UNKNOWN`: Format could not be determined or is not supported
 *
 * @example
 * ```ts
 * const format = normalizeFormat(contentType)
 * if (format === SupportedFormats.OPUS) {
 *   // Use Opus decoder
 * } else if (format === SupportedFormats.UNKNOWN) {
 *   // Fall back to auto-detection
 * }
 * ```
 *
 * @see {@link normalizeFormat}
 * @public
 */
export const SupportedFormats = {
    /** Opus audio codec (WebM/Ogg container) */
    OPUS: 'opus',
    /** Advanced Audio Coding (MP4/M4A/HLS container) */
    AAC: 'aac',
    /** MPEG Audio Layer III (MP3 files) */
    MPEG: 'mpeg',
    /** Free Lossless Audio Codec */
    FLAC: 'flac',
    /** Ogg Vorbis audio codec */
    OGG_VORBIS: 'ogg-vorbis',
    /** Waveform Audio File Format (uncompressed PCM) */
    WAV: 'wav',
    /** Flash Video container format */
    FLV: 'flv',
    /** Apple Lossless Audio Codec */
    ALAC: 'alac',
    /** Unknown or unsupported audio format */
    UNKNOWN: 'unknown'
};
/**
 * Normalizes a media type string to a supported audio format identifier
 *
 * Analyzes MIME types, file extensions, and container format names to determine
 * the most appropriate audio format category. This function handles various
 * representations of the same format (e.g., "audio/mp4", "mp4", "m4a" all
 * map to AAC format).
 *
 * The normalization is case-insensitive and uses substring matching to handle
 * complex MIME types like "audio/mp4; codecs=mp4a.40.2".
 *
 * @param type - Media type string which can be:
 *   - MIME type (e.g., "audio/mpeg", "video/mp4")
 *   - File extension (e.g., "mp3", "opus")
 *   - Container format name (e.g., "webm", "hls")
 *   - null or undefined for unknown formats
 *
 * @returns One of the supported audio format identifiers from SupportedFormats.
 *   Returns UNKNOWN if the format cannot be determined or is not supported.
 *
 * @remarks
 * Format detection logic:
 * - OPUS: "opus", "webm", "weba"
 * - AAC: "aac", "mp4", "m4a", "m4v", "mov", "quicktime", "hls", "mpegurl", "fmp4", "mpegts"
 * - MPEG: "mpeg", "mp3"
 * - FLAC: "flac"
 * - OGG_VORBIS: "ogg", "vorbis"
 * - WAV: "wav"
 * - FLV: "flv"
 *
 * @example
 * ```ts
 * // MIME types
 * normalizeFormat("audio/opus")              // => "opus"
 * normalizeFormat("audio/mp4")               // => "aac"
 * normalizeFormat("audio/mpeg")              // => "mpeg"
 *
 * // File extensions
 * normalizeFormat("webm")                    // => "opus"
 * normalizeFormat("weba")                    // => "opus"
 * normalizeFormat("m4a")                     // => "aac"
 * normalizeFormat("mp3")                     // => "mpeg"
 *
 * // Container formats
 * normalizeFormat("application/x-mpegURL")   // => "aac" (HLS)
 * normalizeFormat("video/mp2t")              // => "aac" (MPEG-TS)
 *
 * // Edge cases
 * normalizeFormat(null)                      // => "unknown"
 * normalizeFormat(undefined)                 // => "unknown"
 * normalizeFormat("audio/unknown")           // => "unknown"
 * ```
 *
 * @see {@link SupportedFormats}
 * @see {@link SupportedFormat}
 * @public
 */
export function normalizeFormat(type) {
    if (!type)
        return SupportedFormats.UNKNOWN;
    const lowerType = type.toLowerCase();
    if (lowerType.includes('alac'))
        return SupportedFormats.ALAC;
    if (lowerType.includes('opus') ||
        lowerType.includes('webm') ||
        lowerType.includes('weba'))
        return SupportedFormats.OPUS;
    if (lowerType.includes('aac') ||
        lowerType.includes('mp4') ||
        lowerType.includes('m4a') ||
        lowerType.includes('m4v') ||
        lowerType.includes('mov') ||
        lowerType.includes('quicktime') ||
        lowerType.includes('hls') ||
        lowerType.includes('mpegurl') ||
        lowerType.includes('fmp4') ||
        lowerType.includes('mpegts'))
        return SupportedFormats.AAC;
    if (lowerType.includes('mpeg') || lowerType.includes('mp3'))
        return SupportedFormats.MPEG;
    if (lowerType.includes('flac'))
        return SupportedFormats.FLAC;
    if (lowerType.includes('ogg') || lowerType.includes('vorbis'))
        return SupportedFormats.OGG_VORBIS;
    if (lowerType.includes('wav'))
        return SupportedFormats.WAV;
    if (lowerType.includes('flv'))
        return SupportedFormats.FLV;
    return SupportedFormats.UNKNOWN;
}
