import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import type { VoiceAudioStream } from '@performanc/voice'
import type { PlayerTrack } from '../../typings/playback/player.types.ts'
import type {
  AudioMixerConfig,
  MixLayer
} from '../../typings/playback/processing.types.ts'
import { RingBuffer } from '../structs/RingBuffer.ts'

interface ExtendedVoiceStream extends VoiceAudioStream {
  pause(): this
  resume(): this
  destroyed: boolean
}

const LAYER_BUFFER_SIZE = 1024 * 1024
const EMPTY_BUFFER = Buffer.alloc(0)
const FRAME_SIZE = 3840
const SILENCE_FRAME = Buffer.alloc(FRAME_SIZE)

/**
 * Mixer that allows layering multiple audio streams over a main PCM stream.
 * Acts now as a continuous river (readable stream)
 */
export class AudioMixer extends Readable {
  public mixLayers: Map<string, MixLayer>
  private maxLayers: number
  private defaultVolume: number
  public autoCleanup: boolean
  public enabled: boolean

  /**
   * Creates a new AudioMixer.
   * @param config - Mixer configuration.
   */
  constructor(config: AudioMixerConfig = {}) {
    super({ highWaterMark: FRAME_SIZE * 4 })

    this.mixLayers = new Map()
    this.maxLayers = config.maxLayersMix || 5
    this.defaultVolume = config.defaultVolume || 0.8
    this.autoCleanup = config.autoCleanup !== false
    this.enabled = config.enabled !== false
  }

  override _read(_size: number): void {
    const targetSize = FRAME_SIZE

    if (this.mixLayers.size === 0 || !this.enabled) {
      this.push(SILENCE_FRAME)
      return
    }

    const chunks = this.readLayerChunks(targetSize)

    if (chunks.size === 0) {
      this.push(SILENCE_FRAME)
      return
    }

    const baseBuffer = Buffer.alloc(targetSize)

    const mixedBuffer = this.mixBuffers(baseBuffer, chunks)

    this.push(mixedBuffer)
  }

  /**
   * Ensures a buffer is treated as Int16Array, handling alignment.
   * @param buffer - Input buffer.
   * @returns Int16Array view of the buffer.
   */
  private _asInt16Array(buffer: Buffer): Int16Array {
    if (buffer.byteOffset % 2 === 0 && buffer.length % 2 === 0) {
      return new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2)
    }

    const alignedBuffer = Buffer.from(
      buffer.subarray(0, buffer.length - (buffer.length % 2))
    )
    return new Int16Array(
      alignedBuffer.buffer,
      alignedBuffer.byteOffset,
      alignedBuffer.length / 2
    )
  }

  /**
   * Mixes multiple PCM buffers into a main PCM buffer.
   * @param mainPCM - The primary PCM buffer.
   * @param layersPCM - Map of additional PCM layers to mix in.
   * @returns The mixed PCM buffer.
   */
  public mixBuffers(
    mainPCM: Buffer,
    layersPCM: Map<string, { buffer: Buffer; volume: number }>
  ): Buffer {
    if (layersPCM.size === 0 || !this.enabled) return mainPCM

    const mainLen = mainPCM.length >> 1
    const mainView = this._asInt16Array(mainPCM)

    const activeLayerViews: Int16Array[] = []
    const layerVolumes: number[] = []

    for (const layer of layersPCM.values()) {
      activeLayerViews.push(this._asInt16Array(layer.buffer))
      layerVolumes.push(layer.volume)
    }

    const numLayers = activeLayerViews.length
    const outputBuffer = Buffer.allocUnsafe(mainPCM.length)
    const outputView = this._asInt16Array(outputBuffer)

    for (let i = 0; i < mainLen; i++) {
      let sample = mainView[i] ?? 0

      for (let j = 0; j < numLayers; j++) {
        const layerView = activeLayerViews[j] as Int16Array
        const volume = layerVolumes[j] as number

        sample += ((layerView[i] ?? 0) * volume) | 0
      }

      outputView[i] = sample < -32768 ? -32768 : sample > 32767 ? 32767 : sample
    }

    return outputBuffer
  }

  /**
   * Adds a new audio layer to the mixer.
   * @param stream - The audio stream to add.
   * @param track - The track info associated with the stream.
   * @param volume - Optional volume for the layer.
   * @returns The unique ID of the added layer.
   * @throws Error if maximum layers are reached.
   */
  public addLayer(
    stream: VoiceAudioStream,
    track: PlayerTrack,
    volume: number | null = null
  ): string {
    if (this.mixLayers.size >= this.maxLayers) {
      throw new Error(`Maximum mix layers (${this.maxLayers}) reached`)
    }

    const id = randomBytes(8).toString('hex')
    const actualVolume = volume !== null ? volume : this.defaultVolume

    const layer: MixLayer = {
      id,
      stream,
      track,
      volume: Math.max(0, Math.min(1, actualVolume)),
      position: 0,
      startTime: Date.now(),
      active: true,
      finishedFeeding: false,
      ringBuffer: new RingBuffer(LAYER_BUFFER_SIZE),
      receivedBytes: 0,
      pending: EMPTY_BUFFER,
      paused: false
    }

    this.mixLayers.set(id, layer)

    stream.on('data', (chunk: Buffer) => {
      if (!layer.active) return

      if (layer.ringBuffer.length > LAYER_BUFFER_SIZE * 0.8) {
        layer.paused = true
        ;(stream as ExtendedVoiceStream).pause()
      }

      let data = chunk
      if (layer.pending.length > 0) {
        const merged = Buffer.allocUnsafe(layer.pending.length + chunk.length)
        layer.pending.copy(merged, 0)
        chunk.copy(merged, layer.pending.length)
        data = merged
        layer.pending = EMPTY_BUFFER
      }

      const remainder = data.length % 4
      if (remainder > 0) {
        layer.pending = Buffer.from(data.subarray(data.length - remainder))
        data = data.subarray(0, data.length - remainder)
      }

      if (data.length > 0) {
        layer.receivedBytes += data.length
        layer.ringBuffer.write(data)
      }
    })

    stream.once('end', () => {
      layer.finishedFeeding = true
    })

    stream.once('close', () => {
      layer.finishedFeeding = true
    })

    stream.once('error', (error: Error) => {
      this.emit('mixError', { id, error })
      this.removeLayer(id, 'ERROR')
    })

    this.emit('mixStarted', { id, track, volume: layer.volume })

    return id
  }

  /**
   * Reads chunks from all active layers.
   * @param chunkSize - Size of chunk to read in bytes.
   * @returns Map of layer chunks.
   */
  public readLayerChunks(
    chunkSize: number
  ): Map<string, { buffer: Buffer; volume: number }> {
    const layerChunks = new Map<string, { buffer: Buffer; volume: number }>()
    const safeSize = chunkSize - (chunkSize % 4)

    for (const [id, layer] of this.mixLayers.entries()) {
      if (!layer.active) continue

      if (layer.ringBuffer.length < safeSize) {
        if (layer.finishedFeeding && layer.ringBuffer.length === 0) {
          if (this.autoCleanup) this.removeLayer(id, 'FINISHED')
        }
        continue
      }

      const chunk = layer.ringBuffer.read(safeSize)
      if (!chunk) continue

      layerChunks.set(id, { buffer: chunk, volume: layer.volume })
      layer.position += chunk.length

      if (layer.paused && layer.ringBuffer.length < LAYER_BUFFER_SIZE * 0.5) {
        layer.paused = false
        ;(layer.stream as ExtendedVoiceStream).resume()
      }
    }

    return layerChunks
  }

  /**
   * Checks if there are any active layers.
   * @returns True if active layers exist.
   */
  public hasActiveLayers(): boolean {
    return this.mixLayers.size > 0
  }

  /**
   * Removes a layer from the mixer.
   * @param id - The ID of the layer to remove.
   * @param reason - Reason for removal.
   * @returns True if the layer was found and removed.
   */
  public removeLayer(id: string, reason: string = 'REMOVED'): boolean {
    const layer = this.mixLayers.get(id)
    if (!layer) return false

    layer.active = false
    if (layer.stream && !(layer.stream as ExtendedVoiceStream).destroyed) {
      layer.stream.removeAllListeners('data')
      layer.stream.destroy()
    }
    layer.ringBuffer.dispose()
    this.mixLayers.delete(id)
    this.emit('mixEnded', { id, reason, track: layer.track })
    return true
  }

  /**
   * Updates the volume of a layer.
   * @param id - The ID of the layer.
   * @param volume - New volume (0.0 to 1.0).
   * @returns True if the layer was updated.
   */
  public updateLayerVolume(id: string, volume: number): boolean {
    const layer = this.mixLayers.get(id)
    if (!layer) return false
    layer.volume = Math.max(0, Math.min(1, volume))
    return true
  }

  /**
   * Gets information about a specific layer.
   * @param id - The ID of the layer.
   * @returns Partial layer info or null if not found.
   */
  public getLayer(id: string) {
    const layer = this.mixLayers.get(id)
    if (!layer) return null
    return {
      id: layer.id,
      track: layer.track,
      volume: layer.volume,
      position: layer.position,
      startTime: layer.startTime
    }
  }

  /**
   * Gets information about all active layers.
   * @returns Array of layer info.
   */
  public getLayers() {
    return Array.from(this.mixLayers.values()).map((layer) => ({
      id: layer.id,
      track: layer.track,
      volume: layer.volume,
      position: layer.position,
      startTime: layer.startTime
    }))
  }

  /**
   * Clears all layers from the mixer.
   * @param reason - Reason for clearing.
   * @returns The number of layers cleared.
   */
  public clearLayers(reason: string = 'CLEARED'): number {
    const ids = Array.from(this.mixLayers.keys())
    for (const id of ids) this.removeLayer(id, reason)
    return ids.length
  }
}
