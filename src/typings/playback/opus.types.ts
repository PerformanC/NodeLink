/**
 * Supported Opus application types.
 * - 'voip': Optimized for voice-over-IP.
 * - 'audio': Optimized for music and high-fidelity audio.
 * - 'lowdelay': Optimized for lowest possible latency.
 */
export type OpusApplication = 'voip' | 'audio' | 'lowdelay'

/**
 * Interface representing a generic Opus encoder instance.
 * Supports multiple underlying libraries like @discordjs/opus, opusscript, etc.
 */
export interface OpusEncoderInstance {
  /**
   * Encodes a PCM buffer into an Opus packet.
   * @param buffer - PCM audio buffer to encode.
   * @param frameSize - Number of samples per frame (optional, required by some libraries like opusscript).
   * @returns Encoded Opus packet.
   */
  encode(buffer: Buffer, frameSize?: number): Buffer

  /**
   * Encodes PCM into a caller-owned output buffer.
   * @param buffer - PCM audio buffer to encode.
   * @param output - Destination for the encoded Opus packet.
   * @returns Number of bytes written to the destination.
   */
  encodeInto?(buffer: Buffer, output: Buffer): number

  /**
   * Sets the encoding bitrate.
   * @param bitrate - Bitrate in bits per second.
   */
  setBitrate(bitrate: number): void

  /**
   * Different Opus libraries use varying names for the CTL method.
   * For cross-compatibility, we include all common variants.
   */
  applyEncoderCTL?(id: number, value: number): void
  applyEncoderCtl?(id: number, value: number): void
  encoderCTL?(id: number, value: number): void

  /**
   * Releases resources associated with the encoder.
   */
  delete?(): void
}

/**
 * Interface representing a generic Opus decoder instance.
 */
export interface OpusDecoderInstance {
  /**
   * Decodes an Opus packet back into a PCM buffer.
   * @param buffer - Opus packet to decode.
   * @returns Decoded PCM audio buffer.
   */
  decode(buffer: Buffer): Buffer

  /**
   * Decodes an Opus packet into a caller-owned PCM buffer.
   * @param buffer - Opus packet to decode.
   * @param output - Destination for decoded PCM audio.
   * @returns Number of bytes written to the destination.
   */
  decodeInto?(buffer: Buffer, output: Buffer): number

  /**
   * Releases resources associated with the decoder.
   */
  delete?(): void
}

/**
 * Metadata and constructor definitions for a loaded Opus library.
 */
export interface OpusLibrary {
  /**
   * Name of the library (e.g., '@discordjs/opus', 'opusscript').
   */
  name: string

  /**
   * Encoder/Decoder constructor.
   */
  Encoder: {
    /**
     * Creates a new instance of the encoder or decoder.
     * @param rate - Sampling rate (e.g., 48000).
     * @param channels - Number of audio channels (e.g., 2).
     * @param application - Opus application type (numeric constant or string).
     */
    new (
      rate: number,
      channels: number,
      application: number | string
    ): OpusEncoderInstance & OpusDecoderInstance

    /**
     * Map of application types to their numeric constants (used by libraries like opusscript).
     */
    Application: Record<string, number | undefined>
  }
}

/**
 * Result of an instance creation operation, containing the instance and its library metadata.
 */
export interface OpusInstanceResult {
  /**
   * The created Opus encoder or decoder instance.
   */
  instance: OpusEncoderInstance | OpusDecoderInstance

  /**
   * Metadata about the library used to create the instance.
   */
  lib: OpusLibrary
}

/**
 * Example usage:
 *
 * ```typescript
 * const result: OpusInstanceResult = _createInstance(48000, 2, 'voip');
 * const encoder = result.instance as OpusEncoderInstance;
 * const encodedBuffer = encoder.encode(pcmBuffer);
 * ```
 */
