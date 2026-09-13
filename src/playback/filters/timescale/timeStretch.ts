import FloatFifoBuffer from './floatFifoBuffer.ts'

const DEFAULT_FRAME_SIZE = 1024
const DEFAULT_OVERLAP = 256
const DEFAULT_SEARCH = 128

/**
 * Concatenates multiple Float32Arrays into one.
 * @param chunks - Array of Float32Arrays.
 * @returns Combined Float32Array.
 */
const concatFloat32 = (chunks: Float32Array[]): Float32Array => {
  if (chunks.length === 0) return new Float32Array(0)
  if (chunks.length === 1 && chunks[0]) return chunks[0]

  let total = 0
  for (const chunk of chunks) total += chunk.length
  const output = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

/**
 * Time-stretching logic using the WSOLA algorithm.
 * @public
 */
export default class TimeStretch {
  private sampleRate: number
  private channels: number
  private frameSize: number
  private overlap: number
  private search: number
  private _analysisHop: number
  private _tempo = 1.0
  private _inputPos = 0
  private _prevOverlap: Float32Array | null = null
  private _buffer: FloatFifoBuffer

  /**
   * Creates a new time stretch instance.
   * @param options - Configuration options.
   */
  constructor({
    sampleRate,
    channels,
    frameSize = DEFAULT_FRAME_SIZE,
    overlap = DEFAULT_OVERLAP,
    search = DEFAULT_SEARCH
  }: {
    sampleRate: number
    channels: number
    frameSize?: number
    overlap?: number
    search?: number
  }) {
    this.sampleRate = sampleRate
    this.channels = channels
    this.frameSize = frameSize
    this.overlap = Math.min(overlap, frameSize - 1)
    this.search = Math.max(0, Math.floor(search))

    this._analysisHop = this.frameSize - this.overlap
    this._buffer = new FloatFifoBuffer(channels)
  }

  /**
   * Sets the playback tempo.
   * @param tempo - The tempo factor (e.g., 0.5 for half speed).
   */
  public setTempo(tempo: number): void {
    this._tempo = tempo
  }

  /**
   * Resets the time stretch state.
   */
  public reset(): void {
    this._buffer.clear()
    this._inputPos = 0
    this._prevOverlap = null
  }

  public destroy(): void {
    this._buffer.destroy()
    this._prevOverlap = null
  }

  /**
   * Processes new audio samples.
   * @param samples - The input Float32Array of samples.
   * @returns The time-stretched Float32Array of samples.
   */
  public process(samples: Float32Array): Float32Array {
    if (samples && samples.length > 0) {
      this._buffer.push(samples)
    }
    return this._drain(false)
  }

  /**
   * Flushes any remaining samples in the buffer.
   * @returns The final time-stretched samples.
   */
  public flush(): Float32Array {
    const output = this._drain(false)
    const start = this._selectStart(true)
    if (start === null) {
      const chunks: Float32Array[] = [output]
      if (this._prevOverlap) chunks.push(this._prevOverlap)
      const fallback = concatFloat32(chunks)
      this.reset()
      return fallback
    }

    const segment = this._readSegment(start, true)
    if (!segment) {
      const chunks: Float32Array[] = [output]
      if (this._prevOverlap) chunks.push(this._prevOverlap)
      const fallback = concatFloat32(chunks)
      this.reset()
      return fallback
    }
    const mixed = this._mixSegment(segment)
    const combined = concatFloat32([output, mixed])
    this.reset()
    return combined
  }

  /**
   * Drains processed segments from the buffer.
   * @param allowPartial - Whether to allow partial segments.
   */
  private _drain(allowPartial: boolean): Float32Array {
    const outputChunks: Float32Array[] = []

    while (true) {
      const start = this._selectStart(allowPartial)
      if (start === null) break

      const segment = this._readSegment(start, allowPartial)
      if (!segment) break

      const mixed = this._mixSegment(segment)
      const emitFrames = allowPartial ? this.frameSize : this._analysisHop
      outputChunks.push(mixed.subarray(0, emitFrames * this.channels))
      this._advance(start)

      if (allowPartial) break
    }

    return concatFloat32(outputChunks)
  }

  /**
   * Selects the best starting frame for the next segment using correlation.
   * @param allowPartial - Whether to allow partial segments.
   */
  private _selectStart(allowPartial: boolean): number | null {
    const available = this._buffer.frameCount
    if (this._prevOverlap === null) {
      if (available < this.frameSize && !allowPartial) return null
      if (available === 0) return null
      return 0
    }

    const expected = this._inputPos
    const minStart = Math.max(0, Math.floor(expected - this.search))
    const maxStart = Math.min(
      Math.floor(expected + this.search),
      available - this.frameSize
    )

    if (maxStart < minStart) {
      if (!allowPartial) return null
      return Math.max(0, available - this.frameSize)
    }

    let bestStart = minStart
    let bestScore = Number.NEGATIVE_INFINITY
    for (let start = minStart; start <= maxStart; start++) {
      const score = this._correlation(start)
      if (score > bestScore) {
        bestScore = score
        bestStart = start
      }
    }

    return bestStart
  }

  /**
   * Calculates the cross-correlation between the previous overlap and a potential segment.
   * @param startFrame - Potential segment start frame.
   */
  private _correlation(startFrame: number): number {
    const overlapSamples = this.overlap * this.channels
    const base = (this._buffer.startFrame + startFrame) * this.channels
    const samples = this._buffer.buffer
    const prev = this._prevOverlap

    let score = 0
    if (prev) {
      for (let i = 0; i < overlapSamples; i++) {
        score += (prev[i] ?? 0) * (samples[base + i] ?? 0)
      }
    }
    return score
  }

  /**
   * Reads a segment of audio from the buffer.
   * @param startFrame - Starting frame index.
   * @param allowPartial - Whether to allow partial segments.
   */
  private _readSegment(
    startFrame: number,
    allowPartial: boolean
  ): Float32Array | null {
    const available = this._buffer.frameCount - startFrame
    if (available <= 0) return null

    const framesToCopy = Math.min(this.frameSize, available)
    const segment = new Float32Array(this.frameSize * this.channels)
    this._buffer.copyTo(segment, startFrame, framesToCopy)

    if (framesToCopy < this.frameSize && !allowPartial) return null
    return segment
  }

  /**
   * Mixes the new segment with the previous overlap using a linear blend.
   * @param segment - The new audio segment.
   */
  private _mixSegment(segment: Float32Array): Float32Array {
    const mixed = new Float32Array(segment.length)
    const prev = this._prevOverlap

    if (!prev) {
      mixed.set(segment)
    } else {
      const overlapSamples = this.overlap * this.channels
      for (let i = 0; i < overlapSamples; i++) {
        const frameIndex = Math.floor(i / this.channels)
        const fadeIn = this.overlap > 1 ? frameIndex / (this.overlap - 1) : 1
        const fadeOut = 1 - fadeIn
        mixed[i] = (prev[i] ?? 0) * fadeOut + (segment[i] ?? 0) * fadeIn
      }
      mixed.set(segment.subarray(overlapSamples), overlapSamples)
    }

    const overlapStart = this._analysisHop * this.channels
    this._prevOverlap = new Float32Array(this.overlap * this.channels)
    this._prevOverlap.set(
      mixed.subarray(overlapStart, overlapStart + this._prevOverlap.length)
    )

    return mixed
  }

  /**
   * Advances the internal input position and discards old buffer data.
   * @param startFrame - The chosen start frame for the segment.
   */
  private _advance(startFrame: number): void {
    const inputHop = this._analysisHop * this._tempo
    this._inputPos = startFrame + inputHop

    const discard = Math.max(0, Math.floor(this._inputPos) - this.search)
    if (discard > 0) {
      this._buffer.discard(discard)
      this._inputPos -= discard
    }
  }
}
