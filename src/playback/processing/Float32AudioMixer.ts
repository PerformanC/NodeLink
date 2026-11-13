/**
 * Isolated Float32 mixer for the Protected processing path.
 * It sums PCM sources without limiting or mutating input buffers.
 */
import {
  type AudioFormat,
  assertProtectedInternalAudioFormat,
  createAudioFormat
} from './audioContract.ts'

const FLOAT32_BYTES = 4
const CHANNELS = 2
const BYTES_PER_FRAME = FLOAT32_BYTES * CHANNELS
const MAX_FLOAT32 = 3.4028234663852886e38

const DEFAULT_FORMAT = createAudioFormat({
  sampleFormat: 'f32le',
  sampleRate: 48000,
  channels: CHANNELS,
  channelLayout: 'stereo',
  interleaved: true
})

export interface Float32MixSource {
  readonly data: Buffer
  readonly gain: number
  readonly format: AudioFormat
}

/** Sums aligned Float32 stereo blocks, zero-padding shorter sources at the end. */
export class Float32AudioMixer {
  public readonly format: AudioFormat

  public constructor(format: AudioFormat = DEFAULT_FORMAT) {
    assertProtectedInternalAudioFormat(format)
    this.format = format
  }

  public mix(sources: readonly Float32MixSource[]): Buffer {
    if (sources.length === 0) return Buffer.alloc(0)

    let outputLength = 0
    for (const source of sources) {
      this.assertCompatibleSource(source)
      outputLength = Math.max(outputLength, source.data.length)
    }

    const output = Buffer.allocUnsafe(outputLength)
    for (let offset = 0; offset < outputLength; offset += FLOAT32_BYTES) {
      let sum = 0
      for (const { data, gain } of sources) {
        if (offset >= data.length) continue
        const sample = data.readFloatLE(offset)
        if (!Number.isFinite(sample)) {
          throw new RangeError(
            `Float32 mixer input contains a non-finite sample at byte offset ${offset}`
          )
        }
        sum += sample * gain
      }
      if (!Number.isFinite(sum) || Math.abs(sum) > MAX_FLOAT32) {
        throw new RangeError(
          `Float32 mixer output overflow at byte offset ${offset}`
        )
      }
      output.writeFloatLE(sum, offset)
    }
    return output
  }

  private assertCompatibleSource(source: Float32MixSource): void {
    if (!Buffer.isBuffer(source.data)) {
      throw new TypeError('Float32 mixer source data must be a Buffer')
    }
    if (source.data.length % BYTES_PER_FRAME !== 0) {
      throw new RangeError(
        `Float32 stereo source length must be aligned to ${BYTES_PER_FRAME}-byte frames`
      )
    }
    if (!Number.isFinite(source.gain) || source.gain < 0) {
      throw new RangeError(
        'Float32 mixer source gain must be finite and nonnegative'
      )
    }
    assertProtectedInternalAudioFormat(source.format)
    if (
      source.format.sampleRate !== this.format.sampleRate ||
      source.format.sampleFormat !== this.format.sampleFormat ||
      source.format.channels !== this.format.channels ||
      source.format.channelLayout !== this.format.channelLayout ||
      source.format.interleaved !== this.format.interleaved
    ) {
      throw new TypeError(
        'Float32 mixer source format does not match the mixer format'
      )
    }
  }
}
