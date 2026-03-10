import fs from 'node:fs';
import path from 'node:path';
import { encodeTrack, logger } from "../utils.js";
/**
 * Mapping between file extensions and the stream types returned by the local
 * source.
 */
const EXTENSION_TYPE_MAP = Object.freeze({
    mp3: 'audio/mpeg',
    flac: 'audio/flac',
    m4a: 'm4a',
    mp4: 'mp4',
    mov: 'mov',
    aac: 'audio/aac',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    opus: 'audio/opus',
    webm: 'webm',
    weba: 'weba',
    flv: 'flv'
});
/**
 * Local source implementation.
 */
export default class LocalSource {
    /**
     * Runtime worker context used by the source implementation.
     */
    nodelink;
    /**
     * Search aliases handled by this source.
     */
    searchTerms;
    /**
     * Match priority used by the source manager.
     */
    priority;
    /**
     * Sanitized local-source configuration.
     */
    config;
    /**
     * Creates a new local source wrapper.
     *
     * @param nodelink - Worker runtime used by the source implementation.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.searchTerms = [];
        this.priority = 20;
        this.config = this.getConfig();
    }
    /**
     * Reads and normalizes the local-source configuration from the shared
     * runtime.
     *
     * @returns Sanitized local-source configuration.
     */
    getConfig() {
        const sourceKey = 'local';
        const rawConfig = this.nodelink.options.sources?.[sourceKey];
        return {
            enabled: rawConfig?.enabled === true,
            basePath: typeof rawConfig?.basePath === 'string' && rawConfig.basePath.length > 0
                ? rawConfig.basePath
                : './'
        };
    }
    /**
     * Maps a file extension to the stream type returned by this source.
     *
     * @param extension - File extension without the leading dot.
     * @returns Best-effort stream type for the extension.
     */
    mapExtensionToType(extension) {
        const extensionMap = EXTENSION_TYPE_MAP;
        return extensionMap[extension] || 'arbitrary';
    }
    /**
     * Reads the first bytes of a local file for magic-byte detection.
     *
     * @param filePath - Absolute local file path.
     * @param size - Number of bytes to read from the start of the file.
     * @returns Buffer containing the bytes that were actually read.
     */
    readMagicBytes(filePath, size = 4096) {
        const fileDescriptor = fs.openSync(filePath, 'r');
        try {
            const header = Buffer.alloc(size);
            const bytesRead = fs.readSync(fileDescriptor, header, 0, size, 0);
            return header.subarray(0, bytesRead);
        }
        finally {
            fs.closeSync(fileDescriptor);
        }
    }
    /**
     * Detects a media type from the first bytes of a file.
     *
     * This also fixes a bug in the JavaScript source where the FLAC check used an
     * invalid buffer encoding string and could never match correctly.
     *
     * @param header - Header bytes read from the local file.
     * @returns Detected stream type, or `null` when detection fails.
     */
    detectTypeByMagic(header) {
        if (header.length < 4) {
            return null;
        }
        const firstByte = header[0] ?? 0;
        const secondByte = header[1] ?? 0;
        const thirdByte = header[2] ?? 0;
        const fourthByte = header[3] ?? 0;
        if (header.subarray(0, 4).toString('ascii') === 'fLaC') {
            return 'audio/flac';
        }
        if (header.subarray(0, 4).toString('ascii') === 'OggS') {
            return header.includes(Buffer.from('OpusHead'))
                ? 'audio/opus'
                : 'audio/ogg';
        }
        if (header.length >= 12 &&
            header.subarray(0, 4).toString('ascii') === 'RIFF' &&
            header.subarray(8, 12).toString('ascii') === 'WAVE') {
            return 'audio/wav';
        }
        if (header.subarray(0, 3).toString('ascii') === 'ID3') {
            return 'audio/mpeg';
        }
        if ((firstByte === 0xff && (secondByte & 0xe0) === 0xe0) ||
            this.parseMp3Header(header)) {
            return 'audio/mpeg';
        }
        if (firstByte === 0xff && (secondByte & 0xf6) === 0xf0) {
            return 'audio/aac';
        }
        if (header.length >= 8 &&
            header.subarray(4, 8).toString('ascii') === 'ftyp') {
            return 'm4a';
        }
        if (firstByte === 0x1a &&
            secondByte === 0x45 &&
            thirdByte === 0xdf &&
            fourthByte === 0xa3) {
            return 'webm';
        }
        if (header.subarray(0, 3).toString('ascii') === 'FLV') {
            return 'flv';
        }
        return null;
    }
    /**
     * Detects the stream type for a local file using magic bytes first and the
     * extension as fallback.
     *
     * @param filePath - Absolute local file path.
     * @param extension - File extension without the leading dot.
     * @returns Best-effort stream type used by the playback pipeline.
     */
    detectLocalAudioType(filePath, extension = '') {
        try {
            const header = this.readMagicBytes(filePath);
            const detectedType = this.detectTypeByMagic(header);
            if (detectedType) {
                return detectedType;
            }
        }
        catch (error) {
            logger('warn', 'Sources', `Could not read magic bytes for "${filePath}": ${error instanceof Error ? error.message : String(error)}`);
        }
        return this.mapExtensionToType(extension);
    }
    /**
     * Parses enough of an MP3 header to estimate bitrate.
     *
     * @param buffer - File buffer positioned near the start of MPEG frames.
     * @returns Parsed header data, or `null` when the buffer is not a valid MP3
     * header.
     */
    parseMp3Header(buffer) {
        const b1 = buffer[0];
        const b2 = buffer[1];
        const b3 = buffer[2];
        if (b1 !== 0xff ||
            b2 === undefined ||
            b3 === undefined ||
            (b2 & 0xe0) !== 0xe0) {
            return null;
        }
        const versionBits = (b2 & 0x18) >> 3;
        const bitrateIndex = (b3 & 0xf0) >> 4;
        if (bitrateIndex < 1 || bitrateIndex > 14) {
            return null;
        }
        const versions = ['2.5', 'x', '2', '1'];
        const version = versions[versionBits] || 'unknown';
        const bitrateTable = {
            '1': [
                null,
                32,
                40,
                48,
                56,
                64,
                80,
                96,
                112,
                128,
                160,
                192,
                224,
                256,
                320
            ],
            '2': [null, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
            '2.5': [null, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
        };
        return {
            bitrateKbps: bitrateTable[version]?.[bitrateIndex] ?? null
        };
    }
    /**
     * Detects the size of an ID3v2 tag so MP3 parsing can skip it.
     *
     * @param fileDescriptor - Open file descriptor for the target file.
     * @returns Number of bytes occupied by the ID3v2 tag.
     */
    detectId3v2Size(fileDescriptor) {
        const header = Buffer.alloc(10);
        fs.readSync(fileDescriptor, header, 0, 10, 0);
        if (header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33) {
            const size = (((header[6] ?? 0) & 0x7f) << 21) |
                (((header[7] ?? 0) & 0x7f) << 14) |
                (((header[8] ?? 0) & 0x7f) << 7) |
                ((header[9] ?? 0) & 0x7f);
            return size + 10;
        }
        return 0;
    }
    /**
     * Reads the file metadata used by the local source.
     *
     * @param filePath - Absolute local file path.
     * @returns Detected file metadata used for track construction and seeking.
     */
    readFileInfo(filePath) {
        const extension = path.extname(filePath).slice(1).toLowerCase();
        const stats = fs.statSync(filePath);
        const info = {
            fileType: extension,
            streamType: this.detectLocalAudioType(filePath, extension),
            bitrateKbps: 'unknown',
            durationMs: -1
        };
        if (extension === 'mp3') {
            const fileDescriptor = fs.openSync(filePath, 'r');
            const skipBytes = this.detectId3v2Size(fileDescriptor);
            const buffer = Buffer.alloc(4096);
            fs.readSync(fileDescriptor, buffer, 0, buffer.length, skipBytes);
            fs.closeSync(fileDescriptor);
            const header = this.parseMp3Header(buffer);
            info.bitrateKbps = header?.bitrateKbps ?? 'unknown';
            const bitsPerSecond = (typeof info.bitrateKbps === 'number' ? info.bitrateKbps : 128) * 1000;
            info.durationMs = bitsPerSecond
                ? Math.floor(((stats.size * 8) / bitsPerSecond) * 1000)
                : 0;
        }
        return info;
    }
    /**
     * Checks whether a resolved relative path stays inside the configured base
     * directory.
     *
     * @param basePath - Absolute configured base path.
     * @param filePath - Absolute resolved file path.
     * @returns `true` when the file path remains inside the base path.
     */
    isPathInsideBase(basePath, filePath) {
        const relativePath = path.relative(basePath, filePath);
        return (relativePath !== '..' &&
            !relativePath.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relativePath));
    }
    /**
     * Builds the encoded track payload for a local file.
     *
     * @param filePath - Absolute local file path.
     * @param metadata - Detected file metadata.
     * @returns Track payload compatible with the shared encoder and source
     * manager contracts.
     */
    buildTrack(filePath, metadata) {
        const info = {
            identifier: filePath,
            isSeekable: metadata.durationMs > 0,
            author: 'unknown',
            length: metadata.durationMs,
            isStream: false,
            position: 0,
            title: path.basename(filePath),
            uri: filePath,
            artworkUrl: null,
            isrc: null,
            sourceName: 'local',
            details: []
        };
        return {
            encoded: encodeTrack(info),
            info,
            pluginInfo: metadata
        };
    }
    /**
     * Extracts the local file metadata attached to a resolved track when
     * available.
     *
     * @param track - Decoded track information that may include plugin metadata.
     * @returns Attached local metadata, or `null` when the track does not carry
     * it.
     */
    getTrackMetadata(track) {
        return track.pluginInfo ?? null;
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
     * Resolves a local file path into a single playable track.
     *
     * Relative paths are resolved against the configured base path, while
     * absolute paths preserve the original source behavior and are used directly.
     *
     * @param query - Absolute path or relative path inside the configured base
     * directory.
     * @returns Track payload, an empty result when the file is unreadable, or an
     * exception payload when a relative path attempts to escape the base path.
     */
    async search(query) {
        const isAbsolute = path.isAbsolute(query);
        const basePath = path.resolve(this.config.basePath ?? './');
        const filePath = isAbsolute
            ? path.resolve(query)
            : path.resolve(basePath, query);
        logger('debug', 'Sources', `Searching local file: ${filePath}`);
        if (!isAbsolute && !this.isPathInsideBase(basePath, filePath)) {
            logger('warn', 'Sources', `Path traversal attempt blocked for local source: "${query}"`);
            return {
                exception: {
                    message: 'Path traversal is not allowed.',
                    severity: 'common'
                }
            };
        }
        try {
            await fs.promises.access(filePath, fs.constants.R_OK);
            const metadata = this.readFileInfo(filePath);
            const track = this.buildTrack(filePath, metadata);
            logger('debug', 'Sources', `Local track found: ${track.info.title} [${metadata.fileType}]`);
            return { loadType: 'track', data: track };
        }
        catch (error) {
            logger('warn', 'Sources', `Local file not found or unreadable: ${filePath} - ${error instanceof Error ? error.message : String(error)}`);
            return { loadType: 'empty', data: {} };
        }
    }
    /**
     * Resolves a local file path using the same logic as `search(...)`.
     *
     * @param filePath - Absolute path or relative path inside the configured base
     * directory.
     * @returns Same payload produced by {@link search}.
     */
    async resolve(filePath) {
        return this.search(filePath);
    }
    /**
     * Resolves the direct local playback URL for a file-based track.
     *
     * @param track - Decoded local track information.
     * @returns Local protocol descriptor used by the playback pipeline.
     */
    getTrackUrl(track) {
        const extension = path
            .extname(track.uri || '')
            .slice(1)
            .toLowerCase();
        const metadata = this.getTrackMetadata(track);
        const streamType = metadata?.streamType ?? this.detectLocalAudioType(track.uri, extension);
        return {
            url: track.uri,
            protocol: 'local',
            format: streamType
        };
    }
    /**
     * Opens a readable stream for a local file.
     *
     * When a start time is provided and the file is seekable, the stream begins
     * at a best-effort byte offset derived from the detected bitrate.
     *
     * @param decodedTrack - Decoded local track information.
     * @param _url - Local URL hint, unused because the decoded track already
     * carries the file path.
     * @param _protocol - Protocol hint, unused by this source.
     * @param additionalData - Optional local resume metadata.
     * @returns Playable file stream payload.
     */
    async loadStream(decodedTrack, _url, _protocol, additionalData) {
        const extension = path
            .extname(decodedTrack.uri || '')
            .slice(1)
            .toLowerCase();
        const metadata = this.getTrackMetadata(decodedTrack);
        const streamType = metadata?.streamType ??
            this.detectLocalAudioType(decodedTrack.uri, extension);
        if ((additionalData?.startTime ?? 0) > 0 && decodedTrack.isSeekable) {
            const info = this.readFileInfo(decodedTrack.uri);
            const bitsPerSecond = (typeof info.bitrateKbps === 'number' ? info.bitrateKbps : 128) * 1000;
            const offset = info.durationMs > 0
                ? Math.floor((bitsPerSecond * (additionalData?.startTime ?? 0)) / 8000)
                : 0;
            const stream = fs.createReadStream(decodedTrack.uri, { start: offset });
            stream.once('close', () => stream.emit('finishBuffering'));
            return { stream, type: streamType };
        }
        const stream = fs.createReadStream(decodedTrack.uri);
        stream.once('close', () => stream.emit('finishBuffering'));
        stream.on('error', (error) => {
            logger('error', 'Sources', `Local stream error: ${error.message}`);
        });
        return { stream, type: streamType };
    }
}
