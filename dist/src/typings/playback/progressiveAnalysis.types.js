/**
 * @file progressiveAnalysis.types.ts
 * @package NodeLink
 * @organization PerformanC
 * @author PerformanC <https://github.com/PerformanC>
 * @license GPL-3.0-or-later
 * @copyright (C) 2026 PerformanC
 *
 * @description
 * Universal type definitions and capability contracts for Progressive Lookahead Audio Analysis
 * in NodeLink AutoMix. Standardizes media time access, PCM audio format guarantees, and
 * streaming MIR (Music Information Retrieval) feature extraction.
 */
/**
 * Creates a validated AnalysisPcmFormat deriving bytesPerSample and bytesPerFrame.
 */
export function createAnalysisPcmFormat(options) {
    const sampleRate = options?.sampleRate ?? 48000;
    const channels = options?.channels ?? 2;
    const sampleFormat = options?.sampleFormat ?? 's16le';
    const bytesPerSample = sampleFormat === 's16le' ? 2 : 4;
    const bytesPerFrame = channels * bytesPerSample;
    return {
        sampleRate,
        channels,
        sampleFormat,
        bytesPerSample,
        bytesPerFrame
    };
}
/**
 * Standard NodeLink 48kHz stereo 16-bit PCM format configuration.
 */
export const STANDARD_ANALYSIS_PCM_FORMAT = createAnalysisPcmFormat({
    sampleRate: 48000,
    channels: 2,
    sampleFormat: 's16le'
});
/**
 * Converts a raw byte count into equivalent media milliseconds based on full PCM frames.
 *
 * @param bytes - Total number of bytes.
 * @param format - Target PCM audio format specification.
 * @returns Equivalent duration in media milliseconds derived strictly from integer frames.
 */
export function bytesToMediaMs(bytes, format = STANDARD_ANALYSIS_PCM_FORMAT) {
    const fullFrames = Math.floor(bytes / format.bytesPerFrame);
    return (fullFrames / format.sampleRate) * 1000;
}
/**
 * Converts media milliseconds into an equivalent byte count aligned to full audio frames.
 *
 * @param ms - Duration in media milliseconds.
 * @param format - Target PCM audio format specification.
 * @returns Aligned byte count.
 */
export function mediaMsToBytes(ms, format = STANDARD_ANALYSIS_PCM_FORMAT) {
    const frames = Math.round((ms * format.sampleRate) / 1000);
    return frames * format.bytesPerFrame;
}
/**
 * Aligns a byte count to the nearest full frame boundary without exceeding the original count.
 *
 * @param bytes - Raw byte count.
 * @param format - Target PCM audio format specification.
 * @returns Byte count aligned to full frame boundary.
 */
export function alignBytesToFrames(bytes, format = STANDARD_ANALYSIS_PCM_FORMAT) {
    return bytes - (bytes % format.bytesPerFrame);
}
/**
 * Converts frame count into equivalent media milliseconds.
 *
 * @param frames - Number of audio frames.
 * @param sampleRate - Sampling rate in Hz.
 * @returns Duration in media milliseconds.
 */
export function framesToMediaMs(frames, sampleRate = STANDARD_ANALYSIS_PCM_FORMAT.sampleRate) {
    return (frames / sampleRate) * 1000;
}
/**
 * Converts media milliseconds into an equivalent frame count.
 *
 * @param ms - Duration in media milliseconds.
 * @param sampleRate - Sampling rate in Hz.
 * @returns Number of audio frames.
 */
export function mediaMsToFrames(ms, sampleRate = STANDARD_ANALYSIS_PCM_FORMAT.sampleRate) {
    return Math.round((ms * sampleRate) / 1000);
}
