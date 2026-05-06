import type { Transform, TransformOptions } from 'node:stream'
import type { VoiceAudioStream } from '@performanc/voice'
import type { PlayerTrack } from './player.types.ts'
import type { RingBufferLike } from './streamProcessor.types.ts'

/**
 * Supported fading curve types.
 */
export type FadeCurve =
  | 'linear'
  | 'exponential'
  | 'logarithmic'
  | 's-curve'
  | 'sine'
  | 'sinusoidal'

/**
 * Options for VolumeTransformer.
 */
export interface VolumeTransformerOptions extends TransformOptions {
  /** Initial volume multiplier (1.0 = 100%). */
  volume?: number
  /** Duration of fade effects in milliseconds. */
  fadeDurationMs?: number
  /** Curve type for fading. */
  fadeCurve?: FadeCurve
  /** Audio sampling rate. */
  sampleRate?: number
  /** Number of channels. */
  channels?: number
  /** Maximum gain before limiting. */
  limiterThreshold?: number
  /** Softness of the limiter knee. */
  limiterSoftness?: number
  /** Whether to enable Automatic Gain Control/Loudness Normalizer. */
  enableAGC?: boolean
  /** Lookahead duration in milliseconds for AGC. */
  lookaheadMs?: number
  /** Noise gate threshold in LUFS. */
  gateThresholdLUFS?: number
  /** Stream type (e.g., 's16le'). */
  type?: string
}

/**
 * Interface for VolumeTransformer to avoid structural typing issues with private members.
 */
export interface IVolumeTransformer extends Transform {
  readonly sampleRate: number
  readonly channels: number
  setVolume(volume: number): void
  process(chunk: Buffer): Buffer
  setAGCEnabled?(enabled: boolean): void
}

/**
 * Interface for FadeTransformer.
 */
export interface IFadeTransformer extends Transform {
  setGain(volume: number): void
  fadeTo(volume: number, durationMs: number, curve?: string): void
  process(chunk: Buffer): Buffer
}

/**
 * Supported scratch styles.
 */
export type ScratchStyle =
  | 'wash'
  | 'backspin'
  | 'baby'
  | 'start'
  | 'stop'
  | 'random'

/**
 * Interface for ScratchTransformer.
 */
export interface IScratchTransformer extends Transform {
  scratchTo(durationMs: number, style: ScratchStyle): void
  process(chunk: Buffer): Buffer
  isActive(): boolean
  checkEffectCompleted(): boolean
  getRate(): number
}

/**
 * Interface for TapeTransformer.
 */
export interface ITapeTransformer extends Transform {
  tapeTo(durationMs: number, type: 'start' | 'stop', curve?: string): void
  process(chunk: Buffer): Buffer
  isActive(): boolean
  checkRampCompleted(): boolean
  getRate(): number
}

/**
 * Interface for FiltersManager.
 */
export interface IFiltersManager extends Transform {
  update(filters: unknown): void
  process(chunk: Buffer): Buffer
  flush(): Buffer
  getRate(): number
}

/**
 * Options for FadeTransformer.
 */
export interface FadeTransformerOptions extends TransformOptions {
  /** Sample rate of the audio. */
  sampleRate?: number
  /** Number of audio channels. */
  channels?: number
  /** Initial volume gain (0.0 to 1.0). */
  volume?: number
  /** Stream type (e.g., 's16le'). */
  type?: string
}

/**
 * Options for TapeTransformer.
 */
export interface TapeTransformerOptions extends TransformOptions {
  /** Sample rate of the audio. */
  sampleRate?: number
  /** Number of audio channels. */
  channels?: number
  /** Stream type (e.g., 's16le'). */
  type?: string
}
/**
 * Options for LoudnessNormalizer.
 */
export interface LoudnessNormalizerOptions {
  /** Sample rate of the audio. */
  sampleRate?: number
  /** Number of audio channels. */
  channels?: number
  /** Target loudness in LUFS. */
  targetLoudness?: number
  /** Attack time for gain smoothing in seconds. */
  attackTime?: number
  /** Release time for gain smoothing in seconds. */
  releaseTime?: number
  /** Integration time for short-term energy in seconds. */
  shortTermTime?: number
  /** Noise gate threshold in LUFS. */
  gateThresholdLUFS?: number
}

/**
 * Configuration for the AudioMixer.
 */
export interface AudioMixerConfig {
  /** Maximum number of layers to mix. */
  maxLayersMix?: number
  /** Default volume for new layers. */
  defaultVolume?: number
  /** Whether to automatically clean up finished layers. */
  autoCleanup?: boolean
  /** Whether the mixer is enabled. */
  enabled?: boolean
}

/**
 * Represents a single audio layer in the mixer.
 */
export interface MixLayer {
  /** Unique identifier for the layer. */
  id: string
  /** The input stream for this layer. */
  stream: VoiceAudioStream
  /** The track associated with this layer. */
  track: PlayerTrack
  /** Current volume of the layer (0.0 to 1.0). */
  volume: number
  /** Current position in bytes. */
  position: number
  /** Timestamp when the layer was created. */
  startTime: number
  /** Whether the layer is active. */
  active: boolean
  /** Whether the input stream has finished feeding data. */
  finishedFeeding: boolean
  /** Internal buffer for the layer. */
  ringBuffer: RingBufferLike
  /** Total bytes received from the stream. */
  receivedBytes: number
  /** Small buffer for handling misaligned chunks. */
  pending: Buffer
  /** Whether the layer is currently paused due to buffer fullness. */
  paused: boolean
}
