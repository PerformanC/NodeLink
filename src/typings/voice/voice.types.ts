import type { Buffer } from 'node:buffer'
import type { Readable } from 'node:stream'
import type { VoiceConnection } from '@performanc/voice'
import type { Decoder as OpusDecoder } from '../../playback/opus/Opus.ts'

/**
 * Resolved voice format information.
 * @public
 */
export interface ResolvedVoiceFormat {
  /**
   * Name of the voice format (e.g., 'opus', 'pcm_s16le').
   */
  name: string
  /**
   * Numeric code representing the format.
   */
  code: number
}

/**
 * Parsed header information from a voice frame.
 * @public
 */
export interface ParsedVoiceFrameHeader {
  /**
   * Operation code.
   */
  op: number
  /**
   * Format code.
   */
  format: number
  /**
   * Guild ID associated with the frame.
   */
  guildId: string
  /**
   * User ID associated with the frame.
   */
  userId: string
  /**
   * SSRC identifier.
   */
  ssrc: number
  /**
   * Timestamp of the frame.
   */
  timestamp: number
  /**
   * Offset where the payload begins in the buffer.
   */
  payloadOffset: number
}

/**
 * Options for configuring the voice relay.
 * @public
 */
export interface VoiceRelayOptions {
  /**
   * Whether the relay is enabled.
   */
  enabled: boolean
  /**
   * Voice format string (optional).
   */
  format?: string
  /**
   * Function to send the voice frame buffer.
   */
  sendFrame: (frame: Buffer) => void
  /**
   * Optional logger function.
   */
  logger?: (level: string, module: string, message: string) => void
}

/**
 * Interface for the Voice Relay instance.
 * @public
 */
export interface VoiceRelay {
  /**
   * Attaches the relay to a voice connection.
   * @param connection - The voice connection to attach to.
   * @param guildId - The guild ID for context.
   */
  attach: (connection: VoiceConnection, guildId: string) => void
  /**
   * Detaches the relay from a voice connection.
   * @param connection - The voice connection to detach from.
   */
  detach: (connection: VoiceConnection) => void
}

/**
 * internal state for an active voice stream.
 * @internal
 */
export interface ActiveStreamEntry {
  stream: Readable
  dataStream: Readable | OpusDecoder
  decoder: OpusDecoder | null
  formatCode: number
  onData: (chunk: Buffer) => void
  onEnd: () => void
  onError: (err: Error) => void
  userId: string
}

/**
 * Extended VoiceConnection to track relay attachment.
 * @internal
 */
export type ExtendedVoiceConnection = VoiceConnection & {
  _voiceRelayAttached?: boolean
  _voiceRelaySpeakStart?: (userId: string, ssrc: number) => void
  _voiceRelaySpeakEnd?: (userId: string, ssrc: number) => void
}
