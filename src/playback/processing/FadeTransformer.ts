// Copyright (C) 2026 NodeLink.
// This file is part of NodeLink and is protected under the GNU General Public License v3 (GPLv3).
// All parts of this project are protected by this license. See LICENSE for details.

import { Transform } from 'node:stream'
import type {
  FadeCurve,
  FadeTransformerOptions,
  IFadeTransformer
} from '../../typings/playback/processing.types.ts'

interface FadeState {
  startGain: number
  targetGain: number
  durationMs: number
  elapsedMs: number
  curve: FadeCurve
}

const DEFAULT_CURVE: FadeCurve = 'linear'
const SUPPORTED_CURVES = new Set<FadeCurve>([
  'linear',
  'exponential',
  'logarithmic',
  's-curve'
])

const _clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))

const _normalizeCurve = (curve: string): FadeCurve =>
  SUPPORTED_CURVES.has(curve as FadeCurve)
    ? (curve as FadeCurve)
    : DEFAULT_CURVE

const _applyCurve = (progress: number, curve: FadeCurve): number => {
  const clamped = _clamp(progress, 0, 1)
  switch (curve) {
    case 'exponential':
      return clamped ** 2
    case 'logarithmic':
      return Math.log10(1 + 9 * clamped)
    case 's-curve':
      return clamped * clamped * (3 - 2 * clamped)
    case 'linear':
      return clamped
  }
  return clamped
}

/**
 * A Transform stream that applies fade-in/fade-out effects to PCM audio data.
 * @public
 */
export class FadeTransformer extends Transform implements IFadeTransformer {
  public readonly sampleRate: number
  public readonly channels: number
  private currentGain: number
  private fade: FadeState | null

  /**
   * Creates a new FadeTransformer.
   * @param options - Transformation options.
   */
  constructor(options: FadeTransformerOptions = {}) {
    super({ highWaterMark: 3840, ...options })
    this.sampleRate = options.sampleRate ?? 48000
    this.channels = options.channels ?? 2
    const initialGain = Number.isFinite(options.volume)
      ? (options.volume as number)
      : 1.0
    this.currentGain = _clamp(initialGain, 0, 1)
    this.fade = null
  }

  /**
   * Sets the gain immediately, canceling any active fade.
   * @param volume - New gain (0.0 to 1.0).
   */
  public setGain(volume: number): void {
    this.currentGain = _clamp(volume, 0, 1)
    this.fade = null
  }

  /**
   * Schedules a fade to a target volume.
   * @param volume - Target gain (0.0 to 1.0).
   * @param durationMs - Fade duration in milliseconds.
   * @param curve - Fading curve type.
   */
  public fadeTo(
    volume: number,
    durationMs: number,
    curve: string = DEFAULT_CURVE
  ): void {
    const targetGain = _clamp(volume, 0, 1)
    const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0

    if (duration === 0) {
      this.setGain(targetGain)
      return
    }

    this.fade = {
      startGain: this.currentGain,
      targetGain,
      durationMs: duration,
      elapsedMs: 0,
      curve: _normalizeCurve(curve)
    }
  }

  /**
   * Processes a chunk of PCM data, applying the current gain/fade.
   * @param chunk - PCM data buffer.
   * @returns Processed buffer.
   */
  public process(chunk: Buffer): Buffer {
    const sampleCount = chunk.length >> 1
    if (!sampleCount) return chunk

    let gainStart = this.currentGain
    let gainEnd = this.currentGain

    if (this.fade) {
      const { startGain, targetGain, durationMs, elapsedMs, curve } = this.fade
      const chunkDurationMs =
        (sampleCount / this.channels / this.sampleRate) * 1000
      const nextElapsed = Math.min(durationMs, elapsedMs + chunkDurationMs)
      const progressStart = durationMs === 0 ? 1 : elapsedMs / durationMs
      const progressEnd = durationMs === 0 ? 1 : nextElapsed / durationMs

      gainStart =
        startGain + (targetGain - startGain) * _applyCurve(progressStart, curve)
      gainEnd =
        startGain + (targetGain - startGain) * _applyCurve(progressEnd, curve)

      this.fade.elapsedMs = nextElapsed
      if (nextElapsed >= durationMs) {
        this.fade = null
        this.currentGain = targetGain
      } else {
        this.currentGain = gainEnd
      }
    }

    if (gainStart === 1 && gainEnd === 1) return chunk

    let view: Int16Array | null = null
    let _useBuffer = false

    if (chunk.byteOffset % 2 === 0) {
      view = new Int16Array(chunk.buffer, chunk.byteOffset, sampleCount)
    } else {
      _useBuffer = true
    }

    const step = sampleCount > 1 ? (gainEnd - gainStart) / (sampleCount - 1) : 0

    if (view) {
      for (let i = 0; i < view.length; i++) {
        const gain = gainStart + step * i
        const sample = view[i] ?? 0
        const value = sample * gain
        view[i] = value < -32768 ? -32768 : value > 32767 ? 32767 : value | 0
      }
    } else {
      for (let i = 0; i < sampleCount; i++) {
        const gain = gainStart + step * i
        const sample = chunk.readInt16LE(i * 2)
        const value = sample * gain
        const clamped =
          value < -32768 ? -32768 : value > 32767 ? 32767 : value | 0
        chunk.writeInt16LE(clamped, i * 2)
      }
    }

    return chunk
  }

  /**
   * Flushes any buffered data (returns empty as it's real-time).
   */
  public flush(): Buffer {
    return Buffer.alloc(0)
  }

  public override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: unknown) => void
  ): void {
    this.push(this.process(chunk))
    callback()
  }
}
