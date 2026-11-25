/**
 * Stream processing stage delivered by the Source Worker over StreamTransport.
 */
export const StreamOutputMode = {
    /** Source Worker fetches (and decrypts if needed) and forwards raw stream bytes. */
    RAW: 'raw',
    /** Source Worker assembles segmented protocols (HLS/DASH) or strips container framing (e.g. fMP4/MPEG-TS -> AAC). */
    DEMUXED: 'demuxed',
    /** Source Worker decodes audio all the way to 48kHz stereo PCM (~192 KB/s per stream). */
    PCM: 'pcm'
};
/**
 * Simplified preset modes for StreamTransport routing.
 */
export const StreamTransportPreset = {
    /** Disables StreamTransport routing regardless of rules. */
    OFF: 'off',
    /** Offloads only continuously decrypted streams (e.g. Deezer Blowfish, NicoVideo/HLS AES) in `raw` mode. */
    ENCRYPTED_ONLY: 'encrypted-only',
    /** Offloads live streams (`demuxed`), encrypted streams (`raw`), and segmented protocols (`hls`, `sabr`, `dash` -> `demuxed`). */
    BALANCED: 'balanced',
    /** Offloads all eligible sources in `demuxed` mode. */
    FULL_OFFLOAD: 'full-offload',
    /** Offloads all eligible sources decoded to `pcm` (reduces Player CPU at higher pipe bandwidth). */
    CPU_SAVER: 'cpu-saver',
    /** Ignores built-in presets and evaluates `rules` in order, falling back to `defaultAction`. */
    CUSTOM: 'custom'
};
/**
 * Named reserve buffer profiles for StreamTransport.
 */
export const StreamBufferProfileName = {
    /** Low-memory buffer (`32 KB` / `96 KB` / `192 KB`). */
    COMPACT: 'compact',
    /** Balanced buffer for compressed streams (`64 KB` / `192 KB` / `384 KB`). */
    STANDARD: 'standard',
    /** High-throughput buffer for `pcm` or jittery live streams (`128 KB` / `512 KB` / `1024 KB`). */
    LARGE: 'large'
};
