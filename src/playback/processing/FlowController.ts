import { Transform, type TransformCallback } from 'node:stream'
import type { AudioMixer } from '../../typings/playback/player.types.ts'
import type {
  IFadeTransformer,
  IScratchTransformer,
  ITapeTransformer,
  IVolumeTransformer,
  ScratchStyle
} from '../../typings/playback/processing.types.ts'

const FRAME_SIZE = 3840
const EMPTY_BUFFER = Buffer.alloc(0)

/**
 * Controller that coordinates filters, volume, fading, scratching, and mixing in a single stream.
 * @public
 */
export class FlowController extends Transform {
  private readonly volume: IVolumeTransformer
  private readonly fade: IFadeTransformer
  private readonly tape: ITapeTransformer
  private readonly scratch: IScratchTransformer
  private readonly audioMixer: AudioMixer | null
  private pendingBuffer: Buffer | null
  private pendingLength: number

  /**
   * Creates a new FlowController.
   * @param volume - The VolumeTransformer instance.
   * @param fade - The FadeTransformer instance.
   * @param tape - The TapeTransformer instance.
   * @param scratch - The ScratchTransformer instance.
   * @param audioMixer - Optional AudioMixer instance.
   */
  constructor(
    volume: IVolumeTransformer,
    fade: IFadeTransformer,
    tape: ITapeTransformer,
    scratch: IScratchTransformer,
    audioMixer: AudioMixer | null = null
  ) {
    super({ highWaterMark: FRAME_SIZE * 4 })

    this.volume = volume
    this.fade = fade
    this.tape = tape
    this.scratch = scratch
    this.audioMixer = audioMixer
    this.pendingBuffer = Buffer.allocUnsafe(FRAME_SIZE)
    this.pendingLength = 0
  }

  private _processFrame(frame: Buffer): void {
    let output: Buffer = frame

    output = this.tape.process(output)
    output = this.scratch.process(output)
    output = this.volume.process(output)
    output = this.fade.process(output)

    if (
      this.audioMixer &&
      this.audioMixer.enabled !== false &&
      this.audioMixer.hasActiveLayers()
    ) {
      try {
        const layerChunks = this.audioMixer.readLayerChunks(output.length)
        output = this.audioMixer.mixBuffers(output, layerChunks)
      } catch (_error) {}
    }

    this.push(output)
  }

  /**
   * Sets the volume gain.
   * @param volume - New volume level.
   */
  public setVolume(volume: number): void {
    this.volume.setVolume(volume)
  }

  /**
   * Calculates the combined playback rate of internal effects (tape, scratch).
   */
  public getEffectiveRate(): number {
    return this.tape.getRate() * this.scratch.getRate()
  }

  /**
   * Sets the fade gain immediately.
   * @param volume - New fade volume.
   */
  public setFadeVolume(volume: number): void {
    this.fade.setGain(volume)
  }

  /**
   * Schedules a fade effect.
   * @param volume - Target volume.
   * @param durationMs - Duration of the fade in milliseconds.
   * @param curve - Fading curve type.
   */
  public fadeTo(volume: number, durationMs: number, curve?: string): void {
    this.fade.fadeTo(volume, durationMs, curve)
  }

  /**
   * Schedules a tape effect.
   * @param durationMs - Duration of the ramp in milliseconds.
   * @param type - Ramp type ('start' or 'stop').
   * @param curve - Fading curve type.
   */
  public tapeTo(
    durationMs: number,
    type: 'start' | 'stop',
    curve?: string
  ): void {
    this.tape.tapeTo(durationMs, type, curve)
  }

  /**
   * Schedules a scratch effect.
   * @param durationMs - Duration of the scratch movement.
   * @param style - The style of scratch to apply.
   */
  public scratchTo(durationMs: number, style: ScratchStyle): void {
    this.scratch.scratchTo(durationMs, style)
  }

  public checkTapeRampCompleted(): boolean {
    return this.tape.checkRampCompleted()
  }

  public checkScratchEffectCompleted(): boolean {
    return this.scratch.checkEffectCompleted()
  }

  public setLoudnessNormalizer(enabled: boolean): void {
    if ('setAGCEnabled' in this.volume) {
      ;(
        this.volume as unknown as { setAGCEnabled?: (enabled: boolean) => void }
      ).setAGCEnabled?.(enabled)
    }
  }

  /**
   * Updates filters in the pipeline via the FlowController.
   * Note: FlowController currently doesn't manage filters itself,
   * this is a no-op placeholder to match the expected interface.
   * @param _filters - The filter settings.
   */
  public setFilters(
    _filters: import('../../typings/playback/player.types.ts').FiltersState
  ): void {
    // This exists to satisfy streamProcessor's type check and avoid 'as any'
  }

  public override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    if (!this.pendingBuffer) {
      callback()
      return
    }

    let offset = 0

    if (this.pendingLength > 0) {
      const needed = FRAME_SIZE - this.pendingLength
      const toCopy = Math.min(needed, chunk.length)
      chunk.copy(this.pendingBuffer, this.pendingLength, 0, toCopy)
      this.pendingLength += toCopy
      offset += toCopy

      if (this.pendingLength === FRAME_SIZE) {
        this._processFrame(this.pendingBuffer)
        this.pendingLength = 0
      }
    }

    const remaining = chunk.length - offset
    const fullFrameBytes = remaining - (remaining % FRAME_SIZE)
    const end = offset + fullFrameBytes

    for (let i = offset; i < end; i += FRAME_SIZE) {
      this._processFrame(chunk.subarray(i, i + FRAME_SIZE))
    }

    if (end < chunk.length) {
      this.pendingLength = chunk.length - end
      chunk.copy(this.pendingBuffer, 0, end)
    }

    callback()
  }

  public override _flush(callback: TransformCallback): void {
    let remaining =
      this.pendingLength > 0
        ? (this.pendingBuffer?.subarray(0, this.pendingLength) ?? EMPTY_BUFFER)
        : EMPTY_BUFFER
    this.pendingLength = 0

    if (remaining.length > 0) {
      remaining = this.tape.process(remaining)
      remaining = this.scratch.process(remaining)
      remaining = this.volume.process(remaining)
      remaining = this.fade.process(remaining)

      if (
        this.audioMixer &&
        this.audioMixer.enabled !== false &&
        this.audioMixer.hasActiveLayers()
      ) {
        try {
          const layerChunks = this.audioMixer.readLayerChunks(remaining.length)
          remaining = this.audioMixer.mixBuffers(remaining, layerChunks)
        } catch (_error) {}
      }

      const finalRemainder = remaining.length % 4
      if (finalRemainder > 0) {
        remaining = remaining.subarray(0, remaining.length - finalRemainder)
      }

      if (remaining.length > 0) this.push(remaining)
    }

    const silence = Buffer.alloc(FRAME_SIZE, 0)
    let drainLimit = 500
    while (
      (this.scratch.isActive() || this.tape.isActive()) &&
      drainLimit-- > 0
    ) {
      this._processFrame(silence)
    }

    callback()
  }

  override _destroy(
    _err: Error | null,
    cb: (error?: Error | null) => void
  ): void {
    this.pendingBuffer = null
    cb(null)
  }
}
