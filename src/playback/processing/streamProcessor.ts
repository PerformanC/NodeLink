/** biome-ignore-all assist/source/organizeImports: <no-op> */
import {
  PassThrough,
  Readable,
  Transform,
  pipeline,
  type TransformCallback,
  type TransformOptions
} from 'node:stream'
import FAAD2NodeDecoder from '@ecliptia/faad2-wasm/faad2_node_decoder.js'
import { SeekError, seekableStream } from '@ecliptia/seekable-stream'
import type { VoiceAudioStream } from '@performanc/voice'
import { SymphoniaDecoder } from '@toddynnn/symphonia-decoder'
import { normalizeFormat, SupportedFormats } from '../../constants.ts'
import type {
  AudioMixer,
  FiltersState,
  NodeLink,
  StreamInfo
} from '../../typings/playback/player.types.ts'
import type {
  HttpProxyConfig,
  HttpRequestHeaders,
  HttpResponseHeaders
} from '../../typings/utils.types.ts'
import type {
  AACConfig,
  AACDecoderStreamOptions,
  ADTSFrameInfo,
  AudioConfig,
  AudioConstants,
  BufferThresholds,
  ErrorResponse,
  FAAD2DecoderLike,
  FlvDemuxerLike,
  FMP4StreamOptions,
  FMP4StreamState,
  MP4BoxFile,
  MP4BoxInfo,
  MP4BoxSample,
  MP4BoxTrack,
  MP4Box as MP4BoxType,
  MpegtsConfig,
  PendingChunk,
  ResamplerLike,
  ResamplingQuality,
  RingBufferLike,
  SeekableStreamMeta,
  SymphoniaDecoderLike,
  SymphoniaDecoderStreamOptions
} from '../../typings/playback/streamProcessor.types.ts'
import { http1makeRequest, logger } from '../../utils.ts'
import FlvDemuxer from '../demuxers/Flv.ts'
import WebmOpusDemuxer from '../demuxers/WebmOpus.ts'
import { Decoder as OpusDecoder, Encoder as OpusEncoder } from '../opus/Opus.ts'
import { RingBuffer } from '../structs/RingBuffer.ts'
import { FadeTransformer } from './FadeTransformer.ts'
import { TapeTransformer } from './TapeTransformer.ts'
import { ScratchTransformer } from './ScratchTransformer.ts'
import { FlowController } from './FlowController.ts'
import { FiltersManager } from './filtersManager.ts'
import { VolumeTransformer } from './VolumeTransformer.ts'
import {
  CrossfadeController,
  type CrossfadePrepareOptions
} from './CrossfadeController.ts'
import { SilenceDetector } from './SilenceDetector.ts'

type LibSampleRateModule = typeof import('@alexanderolsen/libsamplerate-js')
let libSampleRatePromise: Promise<LibSampleRateModule> | null = null

type MP4BoxModule = typeof import('mp4box')
type MP4Descriptor = {
  tag?: number
  data?: Uint8Array
  descs?: MP4Descriptor[]
}
let mp4BoxPromise: Promise<MP4BoxModule> | null = null

const getMP4Box = async (): Promise<MP4BoxModule> => {
  if (!mp4BoxPromise) {
    mp4BoxPromise = import('mp4box')
  }
  return mp4BoxPromise
}

const getLibSampleRate = async (): Promise<LibSampleRateModule> => {
  if (!libSampleRatePromise) {
    libSampleRatePromise = import('@alexanderolsen/libsamplerate-js').then(
      (module) => (module.default || module) as unknown as LibSampleRateModule
    )
  }

  return libSampleRatePromise
}

const AUDIO_CONFIG: AudioConfig = Object.freeze({
  sampleRate: 48000,
  channels: 2,
  frameSize: 960,
  highWaterMark: 19200
})

const BUFFER_THRESHOLDS: BufferThresholds = Object.freeze({
  maxCompressed: 256 * 1024,
  minCompressed: 128 * 1024
})

const parsePositiveIntEnv = (key: string, fallback: number): number => {
  const raw = process.env[key]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const AAC_BUFFER_SIZE: number = parsePositiveIntEnv(
  'NODELINK_AAC_RING_BYTES',
  512 * 1024
)

const AUDIO_CONSTANTS: AudioConstants = Object.freeze({
  pcmFloatFactor: 32767,
  maxDecodesPerTick: 5,
  decodeIntervalMs: 10
})

const MPEGTS_CONFIG: MpegtsConfig = Object.freeze({
  syncByte: 0x47,
  packetSize: 188,
  aacStreamType: 0x0f,
  mp3StreamType: 0x03,
  mp3StreamType2: 0x04
})

const _DOWNMIX_COEFFICIENTS: Readonly<{
  center: number
  surround: number
  lfe: number
}> = Object.freeze({
  center: Math.SQRT1_2,
  surround: Math.SQRT1_2,
  lfe: 0.5
})

const SAMPLE_RATES: readonly number[] = Object.freeze([
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
  8000, 7350
])

const _parseAacSampleRate = (data: Uint8Array): number | null => {
  let bitOffset = 0
  const readBits = (count: number): number | null => {
    if (bitOffset + count > data.byteLength * 8) return null

    let value = 0
    for (let i = 0; i < count; i++) {
      const byte = data[bitOffset >> 3]
      if (byte === undefined) return null
      value = (value << 1) | ((byte >> (7 - (bitOffset & 7))) & 1)
      bitOffset++
    }
    return value
  }

  const objectType = readBits(5)
  if (objectType === null) return null
  if (objectType === 31 && readBits(6) === null) return null

  const samplingIndex = readBits(4)
  if (samplingIndex === null) return null

  if (samplingIndex === 15) {
    const explicitSampleRate = readBits(24)
    return explicitSampleRate && explicitSampleRate > 0
      ? explicitSampleRate
      : null
  }

  return SAMPLE_RATES[samplingIndex] ?? null
}

const EMPTY_BUFFER: Buffer = Buffer.alloc(0)

const _getResamplerConverterType = (
  quality: ResamplingQuality,
  libSampleRate: LibSampleRateModule
): LibSampleRateModule['ConverterType'][keyof LibSampleRateModule['ConverterType']] => {
  const types = libSampleRate.ConverterType
  const qualityMap: Record<string, (typeof types)[keyof typeof types]> = {
    best: types.SRC_SINC_BEST_QUALITY,
    medium: types.SRC_SINC_MEDIUM_QUALITY,
    fastest: types.SRC_SINC_FASTEST,
    'zero order holder': types.SRC_ZERO_ORDER_HOLD,
    linear: types.SRC_LINEAR
  }
  return qualityMap[quality] || types.SRC_SINC_FASTEST
}

const _clampSample = (value: number): number => {
  if (value > 1) return 1
  if (value < -1) return -1
  return value
}

const _floatToInt16Buffer = (floatArray: Float32Array): Buffer => {
  const length = floatArray.length
  const output = new Int16Array(length)

  for (let i = 0; i < length; i++) {
    output[i] =
      _clampSample(floatArray[i] || 0) * AUDIO_CONSTANTS.pcmFloatFactor
  }

  return Buffer.from(output.buffer, output.byteOffset, output.byteLength)
}

const _createAdtsHeader = (
  sampleLength: number,
  profile: number,
  samplingIndex: number,
  channelCount: number
): Buffer => {
  const frameLength = sampleLength + 7
  const profileIndex = profile - 1

  return Buffer.from([
    0xff,
    0xf1,
    ((profileIndex & 0x03) << 6) |
      ((samplingIndex & 0x0f) << 2) |
      ((channelCount & 0x04) >> 2),
    ((channelCount & 0x03) << 6) | ((frameLength & 0x1800) >> 11),
    (frameLength & 0x7f8) >> 3,
    ((frameLength & 0x7) << 5) | 0x1f,
    0xfc
  ])
}

const _parseBoxes = (buffer: Buffer, offset: number = 0): MP4BoxType[] => {
  const boxes: MP4BoxType[] = []
  const bufferLength = buffer.length

  while (offset + 8 <= bufferLength) {
    const size = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)

    if (size === 0 || size > bufferLength - offset) break
    if (type === '\0\0\0\0') break

    boxes.push({
      type,
      size,
      data: buffer.subarray(offset + 8, offset + size),
      offset
    })

    offset += size
  }

  return boxes
}

const _findNestedBox = (
  boxes: MP4BoxType[],
  ...path: string[]
): MP4BoxType[] | null => {
  let current = boxes

  for (const boxType of path) {
    const box = current.find((b) => b.type === boxType)
    if (!box) return null
    current = _parseBoxes(box.data)
  }

  return current
}

const _createErrorResponse = (
  message: string,
  cause: string = 'UNKNOWN'
): ErrorResponse => ({
  exception: {
    message,
    severity: 'fault',
    cause
  }
})

const _isFmp4Format = (type: string): boolean =>
  type.indexOf('fmp4') !== -1 ||
  type.indexOf('hls') !== -1 ||
  type.indexOf('mpegurl') !== -1

const _isMpegtsFormat = (type: string): boolean =>
  type.indexOf('mpegts') !== -1 || type.indexOf('video/mp2t') !== -1

const _isMp4Format = (type: string): boolean =>
  type.indexOf('mp4') !== -1 ||
  type.indexOf('m4a') !== -1 ||
  type.indexOf('m4v') !== -1 ||
  type.indexOf('mov') !== -1 ||
  type.indexOf('quicktime') !== -1

const _isWebmFormat = (type: string): boolean =>
  type.includes('webm') || type.includes('weba')

const _isFlvFormat = (type: string): boolean => type.indexOf('flv') !== -1

const _getSymphoniaCodecHint = (type: string): string | null => {
  const lowerType = type.toLowerCase()
  if (lowerType.includes('flac')) return 'flac'
  if (lowerType.includes('mp3') || lowerType.includes('mpeg')) return 'mp3'
  if (lowerType.includes('ogg') || lowerType.includes('vorbis')) return 'ogg'
  if (lowerType.includes('wav') || lowerType.includes('wave')) return 'wav'
  if (
    lowerType.includes('alac') ||
    lowerType.includes('mp4') ||
    lowerType.includes('m4a')
  )
    return 'm4a'
  return null
}
const _tightBuffer = (buf: Buffer): Buffer =>
  buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength
    ? buf
    : Buffer.from(buf)
const _toTightArrayBuffer = (buf: Buffer): ArrayBuffer => {
  const backing = buf.buffer
  if (
    backing instanceof ArrayBuffer &&
    buf.byteOffset === 0 &&
    buf.byteLength === backing.byteLength
  ) {
    return backing
  }
  return Uint8Array.from(buf).buffer
}

const _extFromUrl = (url: string): string => {
  try {
    const p = new URL(url).pathname
    const m = p.match(/\.([a-z0-9]+)$/i)
    return (m?.[1] ?? '').toLowerCase()
  } catch {
    return ''
  }
}

const _toArrayBufferWithFileStart = (
  buf: Buffer,
  fileStart: number
): ArrayBuffer & { fileStart?: number } => {
  const ab = _toTightArrayBuffer(buf) as ArrayBuffer & { fileStart?: number }
  ab.fileStart = fileStart
  return ab
}

const _isHttpProxyConfig = (value: unknown): value is HttpProxyConfig => {
  if (!value || typeof value !== 'object') return false

  const proxy = value as Record<string, unknown>
  if (typeof proxy.url !== 'string' || proxy.url.length === 0) return false
  if (proxy.username !== undefined && typeof proxy.username !== 'string')
    return false
  if (proxy.password !== undefined && typeof proxy.password !== 'string')
    return false
  if (
    proxy.type !== undefined &&
    proxy.type !== 'forward' &&
    proxy.type !== 'reverse'
  )
    return false

  return true
}

const _extractSeekProxy = (
  streamInfo: StreamInfo
): HttpProxyConfig | undefined => {
  const additionalData = streamInfo?.additionalData as
    | Record<string, unknown>
    | undefined

  return _isHttpProxyConfig(additionalData?.proxy)
    ? (additionalData.proxy as HttpProxyConfig)
    : undefined
}

async function _fetchRange(
  url: string,
  start: number,
  endInclusive: number,
  proxy?: HttpProxyConfig
): Promise<Buffer> {
  if (proxy) {
    const response = await http1makeRequest(url, {
      method: 'GET',
      headers: {
        Range: `bytes=${start}-${endInclusive}`
      } as HttpRequestHeaders,
      responseType: 'buffer',
      proxy
    })

    if (response.statusCode !== 200 && response.statusCode !== 206) {
      throw new Error(`HTTP ${response.statusCode ?? 0} while fetching range`)
    }

    if (Buffer.isBuffer(response.body)) {
      return response.body
    }

    if (response.body instanceof Uint8Array) {
      return Buffer.from(response.body)
    }

    throw new Error('Invalid binary response body while fetching range')
  }

  const res = await fetch(url, {
    headers: { Range: `bytes=${start}-${endInclusive}` }
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} while fetching range`)
  }
  const ab = await res.arrayBuffer()
  return Buffer.from(ab)
}

async function _openRangeStream(
  url: string,
  start: number,
  proxy?: HttpProxyConfig
): Promise<Readable> {
  if (proxy) {
    const response = await http1makeRequest(url, {
      method: 'GET',
      headers: {
        Range: `bytes=${start}-`
      } as HttpRequestHeaders,
      streamOnly: true,
      proxy
    })

    if (
      (response.statusCode !== 200 && response.statusCode !== 206) ||
      !response.stream
    ) {
      throw new Error(
        `HTTP ${response.statusCode ?? 0} while opening range stream`
      )
    }

    return response.stream as Readable
  }

  const res = await fetch(url, {
    headers: { Range: `bytes=${start}-` }
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} while opening range stream`)
  }
  // @ts-expect-error - Node.js Readable.fromWeb accepts ReadableStream
  return Readable.fromWeb(res.body)
}

type MP4BoxSeekResult = number | { offset?: number; time?: number }

const _seekOffset = (res: MP4BoxSeekResult): number => {
  if (typeof res === 'number') return res
  const off = res && typeof res === 'object' ? res.offset : undefined
  return off ?? NaN
}

async function _buildMp4SeekOptions(
  url: string,
  seekTimeMs: number,
  proxy?: HttpProxyConfig
): Promise<MP4ToAACStreamOptions> {
  const mp4Box = await getMP4Box()
  const mp4 = mp4Box.createFile() as unknown as MP4BoxFile

  const prefetch: MP4PrefetchChunk[] = []
  let readyInfo: MP4BoxInfo | null = null
  let nextStart = 0

  await new Promise<void>(async (resolve, reject) => {
    mp4.onError = (e: string) => reject(new Error(`MP4Box init error: ${e}`))
    mp4.onReady = (info: MP4BoxInfo) => {
      readyInfo = info
      resolve()
    }

    const CHUNK = 512 * 1024
    const MAX_FETCHES = 40

    try {
      for (let i = 0; i < MAX_FETCHES && !readyInfo; i++) {
        const buf = await _fetchRange(
          url,
          nextStart,
          nextStart + CHUNK - 1,
          proxy
        )
        const ab = _toArrayBufferWithFileStart(buf, nextStart)

        prefetch.push({ fileStart: nextStart, data: ab })
        const appended = mp4.appendBuffer(ab)

        if (typeof appended === 'number') {
          nextStart = appended
        } else {
          nextStart += ab.byteLength
        }

        if (!Number.isFinite(nextStart) || nextStart < 0) break
      }
      if (!readyInfo) {
        reject(
          new Error('Could not parse MP4 metadata (moov not found quickly).')
        )
      }
    } catch (e) {
      reject(e)
    }
  })

  const info = readyInfo as MP4BoxInfo | null
  const audioTrack = info?.tracks.find((t: MP4BoxTrack) =>
    t.codec?.startsWith('mp4a')
  )
  if (!audioTrack) {
    throw new Error('No AAC track found in MP4/M4A')
  }

  mp4.setExtractionOptions(audioTrack.id, null, { nbSamples: 1 })

  const seekTimeSec = seekTimeMs / 1000
  const mp4boxFile = mp4 as unknown as {
    seek: (time: number, async: boolean) => MP4BoxSeekResult
  }
  const seekRes = mp4boxFile.seek(seekTimeSec, true) as MP4BoxSeekResult
  const startOffset = _seekOffset(seekRes)

  try {
    mp4.stop()
  } catch {}

  if (!Number.isFinite(startOffset) || startOffset < 0) {
    throw new Error(
      `MP4Box seek returned invalid offset: ${JSON.stringify(seekRes)}`
    )
  }

  return {
    prefetch,
    baseFileStart: startOffset,
    seekTimeSec
  }
}

type SeekableResponseLike = Readable & {
  statusCode?: number
  headers?: HttpResponseHeaders
}

const _createSeekableProxyRequest = (
  proxy?: HttpProxyConfig
):
  | ((
      requestUrl: string | URL,
      options: {
        method?: string
        headers?: Record<string, string>
      }
    ) => Promise<SeekableResponseLike>)
  | undefined => {
  if (!proxy) return undefined

  return async (
    requestUrl: string | URL,
    options: {
      method?: string
      headers?: Record<string, string>
    }
  ): Promise<SeekableResponseLike> => {
    const response = await http1makeRequest(
      typeof requestUrl === 'string' ? requestUrl : requestUrl.toString(),
      {
        method: options?.method ?? 'GET',
        headers: (options?.headers ?? {}) as HttpRequestHeaders,
        streamOnly: true,
        proxy
      }
    )

    if (!response.stream) {
      throw new Error('Failed to open proxied seek request stream')
    }

    const stream = response.stream as SeekableResponseLike
    stream.statusCode = response.statusCode
    stream.headers = response.headers
    return stream
  }
}

/**
 * Immutable counter of processed frames.
 * Ensures the song position in Lavalink doesn't break when using Nightcore/Vaporwave.
 */
class PCMFrameCounter extends Transform {
  private totalFrames = 0
  private sampleRate: number
  private bytesPerFrame: number

  constructor(sampleRate = 48000, channels = 2) {
    super()
    this.sampleRate = sampleRate
    this.bytesPerFrame = channels * 2 // 16-bit PCM (2 bytes per channel)
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    this.totalFrames += chunk.length / this.bytesPerFrame
    this.push(chunk)
    callback()
  }

  getConsumedMs(): number {
    return (this.totalFrames / this.sampleRate) * 1000
  }
}

class BaseAudioResource {
  pipes: (Readable | Transform)[] | null
  stream: (VoiceAudioStream & Transform) | null
  canStop?: boolean
  protected _destroyed: boolean
  protected guildId: string
  protected _forwardFinishBuffering: ((...args: unknown[]) => void) | null =
    null
  protected _finishBufferingEmitted: boolean

  constructor(guildId?: string) {
    this.guildId = guildId || 'api-stream'
    this.pipes = []
    this.stream = null
    this.canStop = false
    this._destroyed = false
    this._finishBufferingEmitted = false
  }

  protected _assignStream(stream: Transform): void {
    const voiceStream = stream as unknown as VoiceAudioStream &
      Transform & {
        canStop?: boolean
        checkTapeRampCompleted?: () => boolean
        scratchTo?: (
          durationMs: number,
          style: import('../../typings/playback/processing.types.ts').ScratchStyle
        ) => void
        checkScratchEffectCompleted?: () => boolean
        getEffectiveRate?: () => number
        getRMS?: () => number
        isSilent?: () => boolean
        setFadeVolume?: (volume: number) => void
        fadeTo?: (volume: number, durationMs: number, curve?: string) => void
        tapeTo?: (
          durationMs: number,
          type: 'start' | 'stop',
          curve?: string
        ) => void
        setLoudnessNormalizer?: (enabled: boolean) => void
        isPipelineFinished?: () => boolean
      }
    voiceStream.setVolume = (volume: number) => this.setVolume(volume)
    voiceStream.setFilters = (filters: FiltersState) => this.setFilters(filters)
    voiceStream.checkTapeRampCompleted = () => this.checkTapeRampCompleted()
    voiceStream.scratchTo = (
      durationMs: number,
      style: import('../../typings/playback/processing.types.ts').ScratchStyle
    ) => this.scratchTo(durationMs, style)
    voiceStream.checkScratchEffectCompleted = () =>
      this.checkScratchEffectCompleted()
    voiceStream.getEffectiveRate = () => this.getEffectiveRate()
    voiceStream.getRMS = () => this.getRMS()
    voiceStream.isSilent = () => this.isSilent()
    voiceStream.setFadeVolume = (volume: number) => this.setFadeVolume(volume)
    voiceStream.fadeTo = (volume: number, durationMs: number, curve?: string) =>
      this.fadeTo(volume, durationMs, curve)
    voiceStream.tapeTo = (
      durationMs: number,
      type: 'start' | 'stop',
      curve?: string
    ) => this.tapeTo(durationMs, type, curve)
    voiceStream.setLoudnessNormalizer = (enabled: boolean) =>
      this.setLoudnessNormalizer(enabled)
    voiceStream.isPipelineFinished = () => this.isPipelineFinished()

    /*
     * This will prevent a race condition where fast CDN/network streams finish buffering and emit
     * 'finishBuffering' before the voice connection finishes starting and subscribes to the event.
     * Using 'newListener' event, if the voice player subscribes after the stream has
     * already buffered, we will re-emit 'finishBuffering' immediately, allowing the track to be stoppable
     * and transition to trackEnd naturally.
     *
     * ... i hate nodejs sometimes...
     */
    voiceStream.on('newListener', (event) => {
      if (event === 'finishBuffering' && this._finishBufferingEmitted) {
        setImmediate(() => {
          voiceStream.emit('finishBuffering')
        })
      }
    })

    this.stream = voiceStream
  }

  _end(): void {
    if (this._destroyed || !this.pipes) return
    this._destroyed = true

    const firstPipe = this.pipes[0] as Readable & {
      stopHls?: () => void
      responseStream?: { destroyed: boolean; destroy: () => void }
      _sourceStream?: Readable & {
        off?: (event: string, handler: (...args: unknown[]) => void) => void
        destroyed?: boolean
        destroy?: (err?: Error) => void
      }
      _cleanupListeners?: () => void
    }

    if (firstPipe?._cleanupListeners) {
      try {
        firstPipe._cleanupListeners()
      } catch {}
    }

    if (this._forwardFinishBuffering && firstPipe?._sourceStream) {
      try {
        firstPipe._sourceStream.off?.(
          'finishBuffering',
          this._forwardFinishBuffering
        )
      } catch {}
    }

    if (firstPipe?.stopHls) {
      firstPipe.stopHls()
    }

    if (firstPipe?.responseStream?.destroyed === false) {
      firstPipe.responseStream.destroy()
    }

    if (firstPipe?._sourceStream && !firstPipe._sourceStream.destroyed) {
      try {
        firstPipe._sourceStream.destroy()
      } catch {}
      try {
        delete (firstPipe as unknown as Record<string, unknown>)._sourceStream
      } catch {}
    }

    for (let i = this.pipes.length - 1; i >= 0; i--) {
      const pipe = this.pipes[i] as Transform & {
        abort?: () => void
        unpipe?: () => void
        destroy?: () => void
      }
      pipe.abort?.()
      pipe.unpipe?.()
      pipe.destroy?.()
    }

    this.pipes.length = 0
    this.stream = null
    this.pipes = null
  }

  destroy(): void {
    this._end()
  }

  getEffectiveRate(): number {
    return 1.0
  }

  getRMS(): number {
    if (!this.pipes) return 0
    const silenceDetector = this.pipes.find(
      (p) => p instanceof SilenceDetector
    ) as SilenceDetector | undefined
    return silenceDetector?.getRMS() ?? 0
  }

  isSilent(): boolean {
    if (!this.pipes) return false
    const silenceDetector = this.pipes.find(
      (p) => p instanceof SilenceDetector
    ) as SilenceDetector | undefined
    return silenceDetector?.isSilent() ?? false
  }

  getMainEnergy(): { rms: number; peak: number } | null {
    return null
  }

  checkTapeRampCompleted(): boolean {
    return false
  }

  scratchTo(
    _durationMs: number,
    _style: import('../../typings/playback/processing.types.ts').ScratchStyle
  ): void {}

  checkScratchEffectCompleted(): boolean {
    return false
  }

  tapeTo(_durationMs: number, _type: 'start' | 'stop', _curve?: string): void {}

  setLoudnessNormalizer(_enabled: boolean): void {}

  prepareCrossfade(
    stream: Readable,
    options: CrossfadePrepareOptions,
    onComplete: (consumedMs: number) => void
  ): boolean {
    const controller = this.pipes?.find(
      (pipe) => pipe instanceof CrossfadeController
    ) as CrossfadeController | undefined
    return controller?.prepareNextStream(stream, options, onComplete) ?? false
  }

  startCrossfade(
    durationMs?: number,
    curve?: string,
    availableMs?: number
  ): boolean {
    const controller = this.pipes?.find(
      (pipe) => pipe instanceof CrossfadeController
    ) as CrossfadeController | undefined
    return controller?.startCrossfade(durationMs, curve, availableMs) ?? false
  }

  clearCrossfade(): void {
    const controller = this.pipes?.find(
      (pipe) => pipe instanceof CrossfadeController
    ) as CrossfadeController | undefined
    controller?.clearNext()
  }

  setCrossfadePaused(paused: boolean): void {
    const controller = this.pipes?.find(
      (pipe) => pipe instanceof CrossfadeController
    ) as CrossfadeController | undefined
    controller?.setPaused(paused)
  }

  getCrossfadeState(): {
    active: boolean
    bufferedMs: number
    isBridging: boolean
  } {
    const controller = this.pipes?.find(
      (pipe) => pipe instanceof CrossfadeController
    ) as CrossfadeController | undefined
    return (
      controller?.getState() ?? {
        active: false,
        bufferedMs: 0,
        isBridging: false
      }
    )
  }

  isPipelineFinished(): boolean {
    if (this._destroyed || !this.pipes) return true
    const crossfadeController = this.pipes.find(
      (pipe) => pipe instanceof CrossfadeController
    ) as CrossfadeController | undefined
    if (crossfadeController?.getState().isBridging) return false
    for (const pipe of this.pipes) {
      if (
        (pipe as unknown as { isFinished?: boolean }).isFinished ||
        pipe.readableEnded
      ) {
        return true
      }
    }
    return false
  }

  setVolume(volume: number): void {
    if (!this.pipes) return

    const flowController = this.pipes.find(
      (p) => p instanceof FlowController
    ) as FlowController | undefined
    if (flowController) {
      flowController.setVolume(volume)
      return
    }

    const volumeTransformer = this.pipes.find(
      (p) => p instanceof VolumeTransformer
    ) as VolumeTransformer | undefined

    if (volumeTransformer) {
      volumeTransformer.setVolume(volume)
    }
  }

  setFilters(filters: FiltersState): void {
    if (!this.pipes) return

    const filterManager = this.pipes.find((p) => p instanceof FiltersManager) as
      | FiltersManager
      | undefined

    if (filterManager) {
      filterManager.update(filters)
      return
    }

    const flowController = this.pipes.find(
      (p) => p instanceof FlowController
    ) as FlowController | undefined

    if (flowController) {
      flowController.setFilters(filters)
      return
    }
  }

  setFadeVolume(volume: number): void {
    if (!this.pipes) return

    const flowController = this.pipes.find(
      (p) => p instanceof FlowController
    ) as FlowController | undefined
    if (flowController) {
      flowController.setFadeVolume(volume)
      return
    }

    const fadeTransformer = this.pipes.find(
      (p) => p instanceof FadeTransformer
    ) as FadeTransformer | undefined

    if (fadeTransformer) {
      fadeTransformer.setGain(volume)
    }
  }

  fadeTo(volume: number, durationMs: number, curve?: string): void {
    if (!this.pipes) return

    const flowController = this.pipes.find(
      (p) => p instanceof FlowController
    ) as FlowController | undefined
    if (flowController) {
      flowController.fadeTo(volume, durationMs, curve)
      return
    }

    const fadeTransformer = this.pipes.find(
      (p) => p instanceof FadeTransformer
    ) as FadeTransformer | undefined

    if (fadeTransformer) {
      fadeTransformer.fadeTo(volume, durationMs, curve)
    } else {
      throw new Error('FadeTransformer not found in the pipeline.')
    }
  }

  emit(event: string, ...args: unknown[]): void {
    this.stream?.emit(event, ...args)
  }
  on(event: string, listener: (...args: unknown[]) => void): void {
    this.stream?.on(event, listener)
  }
  off(event: string, listener: (...args: unknown[]) => void): void {
    this.stream?.off(event, listener)
  }
  once(event: string, listener: (...args: unknown[]) => void): void {
    this.stream?.once(event, listener)
  }
  removeListener(event: string, listener: (...args: unknown[]) => void): void {
    this.stream?.removeListener(event, listener)
  }

  removeAllListeners(): void {
    if (!this.stream?.eventNames) return

    for (const eventName of this.stream.eventNames()) {
      this.stream.removeAllListeners(eventName)
    }
  }

  read(): Buffer | null {
    return (this.stream?.read() as Buffer | null) ?? null
  }
  resume(): void {
    this.stream?.resume()
  }
}

class SymphoniaDecoderStream extends Transform {
  private decoder: SymphoniaDecoderLike | null
  private readonly codecRegistryHint: string | null
  private flushCallback: TransformCallback | null
  private inputClosed: boolean
  private isFinished: boolean
  private _aborted: boolean
  private _isDecoding: boolean
  private _timeoutId: ReturnType<typeof setTimeout> | null
  private _immediateId: ReturnType<typeof setImmediate> | null

  constructor(options: SymphoniaDecoderStreamOptions = {}) {
    const { codecRegistryHint, ...streamOptions } = options

    super({
      ...streamOptions,
      highWaterMark: options.highWaterMark ?? AUDIO_CONFIG.highWaterMark,
      objectMode: false
    })

    this.decoder = new SymphoniaDecoder() as SymphoniaDecoderLike
    this.codecRegistryHint = codecRegistryHint ?? null
    this.flushCallback = null
    this.inputClosed = false
    this.isFinished = false
    this._aborted = false
    this._isDecoding = false
    this._timeoutId = null
    this._immediateId = null
  }

  abort(): void {
    this._aborted = true
    this._cancelTimers()
  }

  _cancelTimers(): void {
    if (this._timeoutId) {
      clearTimeout(this._timeoutId)
      this._timeoutId = null
    }
    if (this._immediateId) {
      clearImmediate(this._immediateId)
      this._immediateId = null
    }
  }

  _isDecoderValid(): boolean {
    return this.decoder !== null && !this._aborted && !this.isFinished
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    if (this._aborted || !this.decoder) {
      callback()
      return
    }

    try {
      this.decoder.push(chunk)
      if (!this.decoder.isProbed) {
        this.decoder.initialize(this.codecRegistryHint)
      }
      this._scheduleDecode()
      callback()
    } catch (err) {
      callback(err as Error)
    }
  }

  override _read(_size: number): void {
    super._read(_size)

    if (this._isDecoderValid()) {
      this._scheduleDecode()
    }
  }

  _scheduleDecode(delayMs = 0): void {
    if (this._immediateId || this._timeoutId || !this._isDecoderValid()) return

    if (delayMs > 0) {
      this._timeoutId = setTimeout(() => {
        this._timeoutId = null
        this._decodeLoop()
      }, delayMs)
      return
    }

    this._immediateId = setImmediate(() => {
      this._immediateId = null
      this._decodeLoop()
    })
  }

  _decodeLoop(): void {
    if (this._isDecoding || !this._isDecoderValid()) return

    if (!this.decoder?.isProbed) {
      try {
        if (!this.decoder?.initialize(this.codecRegistryHint)) {
          if (this.inputClosed) this._finishDecode()
          return
        }
      } catch (err) {
        this._failDecode(err)
        return
      }
    }

    if (this.readableLength >= this.readableHighWaterMark) {
      this._scheduleDecode(AUDIO_CONSTANTS.decodeIntervalMs)
      return
    }

    this._isDecoding = true

    try {
      let decodeCount = 0

      while (
        decodeCount < AUDIO_CONSTANTS.maxDecodesPerTick &&
        this._isDecoderValid() &&
        this.readableLength < this.readableHighWaterMark
      ) {
        const result = this.decoder?.decode()
        if (!result) {
          if (this.inputClosed) this._finishDecode()
          return
        }

        decodeCount++
        if (result.samples.length === 0) continue
        if (!this.push(result.samples)) {
          this._scheduleDecode(AUDIO_CONSTANTS.decodeIntervalMs)
          return
        }
      }

      this._scheduleDecode()
    } catch (err) {
      this._failDecode(err)
    } finally {
      this._isDecoding = false
    }
  }

  _finishDecode(): void {
    const callback = this.flushCallback
    this.flushCallback = null
    this.isFinished = true
    this._cleanup()
    callback?.()
  }

  _failDecode(err: unknown): void {
    const callback = this.flushCallback
    this.flushCallback = null
    this.isFinished = true
    this._cleanup()

    const error =
      err instanceof Error ? err : new Error(`Symphonia decode failed: ${err}`)
    if (callback) {
      callback(error)
    } else {
      this.emit('error', error)
    }
  }

  override _flush(callback: TransformCallback): void {
    this._cancelTimers()

    if (this._aborted || !this.decoder) {
      this._cleanup()
      callback()
      return
    }

    try {
      this.decoder.closeInput()
      this.inputClosed = true
      this.flushCallback = callback

      if (!this.decoder.initialize(this.codecRegistryHint)) {
        if ((this.decoder.bufferedBytes ?? 0) === 0) {
          this._cleanup()
          callback()
          return
        }
        throw new Error('Symphonia init failed: not enough input data')
      }

      this._decodeLoop()
    } catch (err) {
      this.flushCallback = null
      this._cleanup()
      callback(err as Error)
    }
  }

  override _destroy(
    err: Error | null,
    callback: (error?: Error | null) => void
  ): void {
    this._aborted = true
    this.isFinished = true
    this._cancelTimers()

    if (this.flushCallback) {
      const cb = this.flushCallback
      this.flushCallback = null
      cb(err)
    }

    this._cleanup()
    super._destroy(err, callback)
  }

  _cleanup(): void {
    this._cancelTimers()

    if (this.decoder) {
      try {
        this.decoder.free()
      } catch {}
      this.decoder = null
    }
  }
}

class MPEGTSDemuxer extends Transform {
  private ringBuffer: RingBufferLike
  private patPmtId: number | null
  private audioPid: number | null
  private audioPidFound: boolean
  private _aborted: boolean
  private pesChunks: Buffer[]
  private pesSize: number

  constructor(options?: { highWaterMark?: number }) {
    super({
      ...options,
      highWaterMark: AUDIO_CONFIG.highWaterMark
    })

    this.ringBuffer = new RingBuffer(
      BUFFER_THRESHOLDS.maxCompressed
    ) as unknown as RingBufferLike
    this.patPmtId = null
    this.audioPid = null
    this.audioPidFound = false
    this._aborted = false
    this.pesChunks = []
    this.pesSize = 0
  }

  abort(): void {
    this._aborted = true
    this.ringBuffer.clear()
    this.pesChunks = []
    this.pesSize = 0
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    if (this._aborted) {
      callback()
      return
    }

    try {
      this.ringBuffer.write(chunk)

      while (
        this.ringBuffer.length >= MPEGTS_CONFIG.packetSize &&
        !this._aborted
      ) {
        const head = this.ringBuffer.peek(1)
        if (!head || head.length === 0 || head[0] !== MPEGTS_CONFIG.syncByte) {
          this.ringBuffer.skip(1)
          continue
        }

        const packet = this.ringBuffer.read(MPEGTS_CONFIG.packetSize)
        if (!packet || packet.length < MPEGTS_CONFIG.packetSize) continue

        try {
          const pusi = !!((packet[1] ?? 0) & 0x40)
          const pid = (((packet[1] ?? 0) & 0x1f) << 8) | (packet[2] ?? 0)
          const afc = ((packet[3] ?? 0) & 0x30) >> 4

          let offset = 4
          if (afc > 1) {
            offset = 5 + (packet[4] ?? 0)
            if (offset >= MPEGTS_CONFIG.packetSize) continue
          }

          if (pid === 0 && pusi) {
            this._processPAT(packet, offset)
          } else if (this.patPmtId && pid === this.patPmtId && pusi) {
            this._processPMT(packet, offset)
          } else if (this.audioPid && pid === this.audioPid) {
            this._processAudioPacket(packet, pusi, offset)
          }
        } catch {
          this._aborted = true
        }
      }
      callback()
    } catch {
      callback()
    }
  }

  _processPAT(packet: Buffer, offset: number): void {
    offset += (packet[offset] || 0) + 1
    if (offset + 11 < MPEGTS_CONFIG.packetSize) {
      this.patPmtId =
        (((packet[offset + 10] || 0) & 0x1f) << 8) | (packet[offset + 11] || 0)
    }
  }

  _processPMT(packet: Buffer, offset: number): void {
    offset += (packet[offset] || 0) + 1
    const sectionLength =
      (((packet[offset + 1] || 0) & 0x0f) << 8) | (packet[offset + 2] || 0)
    const tableEnd = offset + 3 + sectionLength - 4
    const programInfoLength =
      (((packet[offset + 10] || 0) & 0x0f) << 8) | (packet[offset + 11] || 0)
    offset += 12 + programInfoLength

    while (offset < tableEnd && offset < MPEGTS_CONFIG.packetSize) {
      const streamType = packet[offset] || 0
      const elementaryPid =
        (((packet[offset + 1] || 0) & 0x1f) << 8) | (packet[offset + 2] || 0)

      if (
        (streamType === MPEGTS_CONFIG.aacStreamType ||
          streamType === MPEGTS_CONFIG.mp3StreamType ||
          streamType === MPEGTS_CONFIG.mp3StreamType2) &&
        !this.audioPidFound
      ) {
        this.audioPid = elementaryPid
        this.audioPidFound = true
        return
      }
      const esInfoLen =
        (((packet[offset + 3] || 0) & 0x0f) << 8) | (packet[offset + 4] || 0)
      offset += 5 + esInfoLen
    }
  }

  _processAudioPacket(packet: Buffer, pusi: boolean, offset: number): void {
    if (pusi) {
      if (this.pesSize > 0) {
        this._emitPES(Buffer.concat(this.pesChunks, this.pesSize))
        this.pesChunks = []
        this.pesSize = 0
      }
    }

    const payload = _tightBuffer(packet.subarray(offset))
    if (payload.length > 0) {
      this.pesChunks.push(payload)
      this.pesSize += payload.length
    }
  }

  _emitPES(buffer: Buffer): void {
    if (buffer.length < 9) return

    if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01) {
      const headerLength = buffer[8] || 0
      const payloadOffset = 9 + headerLength

      if (payloadOffset < buffer.length) {
        this.push(_tightBuffer(buffer.subarray(payloadOffset)))
      }
    }
  }

  override _flush(callback: TransformCallback): void {
    if (this.pesSize > 0) {
      this._emitPES(Buffer.concat(this.pesChunks, this.pesSize))
    }
    this.pesChunks = []
    this.pesSize = 0
    this.ringBuffer.clear()
    callback()
  }

  override _destroy(
    err: Error | null,
    callback: (error?: Error | null) => void
  ): void {
    this._aborted = true
    this.ringBuffer.dispose()
    this.pesChunks = []
    this.pesSize = 0
    super._destroy(err, callback)
  }
}
/**********************************************************************
 * ATENÇÃO: Não altere este trecho; ajustes aqui quebram a cadeia de decodificação.
 * WARNING: Do not edit this section; changes here will break the decoding pipeline.
 **********************************************************************/
class AACDecoderStream extends Transform {
  private decoder: FAAD2DecoderLike
  private resampler: ResamplerLike | null
  private isDecoderReady: boolean
  private isConfigured: boolean
  private pendingChunks: PendingChunk[]
  private ringBuffer: RingBufferLike
  private resamplingQuality: string
  private resamplerCreationPromise: Promise<ResamplerLike> | null
  private static readonly MAX_PENDING_CHUNKS = 200

  private state: { isAlac: boolean } | null

  constructor(options: AACDecoderStreamOptions) {
    super({
      ...options,
      highWaterMark: AUDIO_CONFIG.highWaterMark
    })
    this.state = options.state ?? null
    this.decoder = new FAAD2NodeDecoder() as unknown as FAAD2DecoderLike
    this.resampler = null
    this.isDecoderReady = false
    this.isConfigured = false
    this.pendingChunks = []
    this.ringBuffer = new RingBuffer(
      AAC_BUFFER_SIZE
    ) as unknown as RingBufferLike
    this.resamplingQuality = options.resamplingQuality || 'fastest'
    this.resamplerCreationPromise = null

    this.decoder.ready
      .then(() => {
        this.isDecoderReady = true
        this._processPendingChunks()
      })
      .catch((err: Error) => this.emit('error', err))
  }

  override _destroy(
    err: Error | null,
    cb: (error?: Error | null) => void
  ): void {
    this.ringBuffer.dispose()
    this.pendingChunks.length = 0
    if (this.decoder) this.decoder.free?.()
    if (this.resampler) {
      this.resampler.destroy?.()
      this.resampler = null
    }
    super._destroy(err, cb)
  }

  _downmixToStereo(
    interleavedPCM: Float32Array,
    channels: number,
    samplesPerChannel: number
  ): Float32Array {
    if (channels === 2) return interleavedPCM

    const stereo = new Float32Array(samplesPerChannel * 2)

    if (channels === 1) {
      for (let i = 0; i < samplesPerChannel; i++) {
        const val = interleavedPCM[i] || 0
        stereo[i * 2] = val
        stereo[i * 2 + 1] = val
      }
      return stereo
    }

    const CENTER_MIX = Math.SQRT1_2
    const SURROUND_MIX = Math.SQRT1_2
    const LFE_MIX = 0.5

    for (let i = 0; i < samplesPerChannel; i++) {
      let left = 0
      let right = 0
      const offset = i * channels

      switch (channels) {
        case 3: {
          const C = interleavedPCM[offset] || 0
          const L = interleavedPCM[offset + 1] || 0
          const R = interleavedPCM[offset + 2] || 0
          left = L + C * CENTER_MIX
          right = R + C * CENTER_MIX
          break
        }
        case 4: {
          const C = interleavedPCM[offset] || 0
          const L = interleavedPCM[offset + 1] || 0
          const R = interleavedPCM[offset + 2] || 0
          const Cs = interleavedPCM[offset + 3] || 0
          left = L + C * CENTER_MIX + Cs * SURROUND_MIX * 0.5
          right = R + C * CENTER_MIX + Cs * SURROUND_MIX * 0.5
          break
        }
        case 5: {
          const C = interleavedPCM[offset] || 0
          const L = interleavedPCM[offset + 1] || 0
          const R = interleavedPCM[offset + 2] || 0
          const Ls = interleavedPCM[offset + 3] || 0
          const Rs = interleavedPCM[offset + 4] || 0
          left = L + C * CENTER_MIX + Ls * SURROUND_MIX
          right = R + C * CENTER_MIX + Rs * SURROUND_MIX
          break
        }
        case 6: {
          const C = interleavedPCM[offset] || 0
          const L = interleavedPCM[offset + 1] || 0
          const R = interleavedPCM[offset + 2] || 0
          const Ls = interleavedPCM[offset + 3] || 0
          const Rs = interleavedPCM[offset + 4] || 0
          const LFE = interleavedPCM[offset + 5] || 0
          left = L + C * CENTER_MIX + Ls * SURROUND_MIX + LFE * LFE_MIX
          right = R + C * CENTER_MIX + Rs * SURROUND_MIX + LFE * LFE_MIX
          break
        }
        default:
          left = interleavedPCM[offset] || 0
          right = interleavedPCM[offset + 1] || left
          break
      }

      if (left > 1.0) left = 1.0
      else if (left < -1.0) left = -1.0
      if (right > 1.0) right = 1.0
      else if (right < -1.0) right = -1.0

      stereo[i * 2] = left
      stereo[i * 2 + 1] = right
    }

    return stereo
  }

  async _processPendingChunks(): Promise<void> {
    if (!this.isDecoderReady || this.pendingChunks.length === 0) return

    for (const item of this.pendingChunks) {
      await this._decodeChunk(item.chunk, item.encoding, item.callback)
    }
    this.pendingChunks = []
  }

  _findADTSFrame(): ADTSFrameInfo | null {
    const buffer = this.ringBuffer.peek(this.ringBuffer.length)
    if (!buffer) return null

    const buf = buffer
    for (let i = 0; i < buf.length - 7; i++) {
      const syncword = ((buf[i] ?? 0) << 4) | ((buf[i + 1] ?? 0) >> 4)
      if (syncword === 0xfff) {
        const frameLength =
          (((buf[i + 3] ?? 0) & 0x03) << 11) |
          ((buf[i + 4] ?? 0) << 3) |
          (((buf[i + 5] ?? 0) >> 5) & 0x07)

        if (buf.length >= i + frameLength) {
          return {
            start: i,
            end: i + frameLength,
            frame: buf.subarray(i, i + frameLength)
          }
        }
      }
    }
    return null
  }

  override _transform(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    if (this.state?.isAlac) {
      this.push(chunk)
      callback()
      return
    }

    if (!this.isDecoderReady || this.pendingChunks.length > 0) {
      if (this.pendingChunks.length >= AACDecoderStream.MAX_PENDING_CHUNKS) {
        this.pendingChunks.shift()
      }
      this.pendingChunks.push({ chunk, encoding, callback })
      return
    }

    this._decodeChunk(chunk, encoding, callback)
  }

  async _decodeChunk(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): Promise<void> {
    try {
      this.ringBuffer.write(chunk)

      while (this.ringBuffer.length > 7) {
        const frameInfo = this._findADTSFrame()
        if (!frameInfo) break

        if (frameInfo.start > 0) {
          this.ringBuffer.skip(frameInfo.start)
        }

        const adtsFrame = frameInfo.frame

        if (!this.isConfigured) {
          await this.decoder.configure(adtsFrame)
          this.isConfigured = true
        }

        try {
          const result = this.decoder.decode(adtsFrame)
          if (result?.pcm?.length) {
            let { pcm, sampleRate, channels, samplesPerChannel } = result

            if (channels > 2 || channels === 1) {
              pcm = this._downmixToStereo(pcm, channels, samplesPerChannel)
              channels = 2
            }

            if (sampleRate !== AUDIO_CONFIG.sampleRate) {
              if (this.resampler) {
                const resampled = this.resampler.full(pcm)
                const pcmInt16 = new Int16Array(resampled.length)
                for (let i = 0; i < resampled.length; i++) {
                  pcmInt16[i] =
                    Math.max(-1, Math.min(1, resampled[i] || 0)) * 32767
                }
                this.push(Buffer.from(pcmInt16.buffer))
              } else {
                if (!this.resamplerCreationPromise) {
                  this.resamplerCreationPromise = getLibSampleRate()
                    .then((libSampleRate) =>
                      libSampleRate.create(2, sampleRate, 48000, {
                        converterType: _getResamplerConverterType(
                          this.resamplingQuality as ResamplingQuality,
                          libSampleRate
                        )
                      })
                    )
                    .then((resampler: ResamplerLike) => {
                      this.resampler = resampler
                      this.resamplerCreationPromise = null
                      return resampler
                    })
                }

                const resampler = await this.resamplerCreationPromise
                const resampled = resampler.full(pcm)
                const pcmInt16 = new Int16Array(resampled.length)
                for (let i = 0; i < resampled.length; i++) {
                  pcmInt16[i] =
                    Math.max(-1, Math.min(1, resampled[i] || 0)) * 32767
                }
                this.push(Buffer.from(pcmInt16.buffer))
              }
            } else {
              const pcmInt16 = new Int16Array(pcm.length)
              for (let i = 0; i < pcm.length; i++) {
                pcmInt16[i] = Math.max(-1, Math.min(1, pcm[i] || 0)) * 32767
              }
              this.push(Buffer.from(pcmInt16.buffer))
            }
          }
        } catch (_decodeErr) {}

        this.ringBuffer.skip(frameInfo.end)
      }

      callback()
    } catch (err) {
      callback(err as Error)
    }
  }

  override _flush(callback: TransformCallback): void {
    if (this.state?.isAlac) {
      callback()
      return
    }

    if (this.ringBuffer.length > 0 && this.isConfigured) {
      try {
        const frameInfo = this._findADTSFrame()
        if (frameInfo) {
          const result = this.decoder.decode(frameInfo.frame)
          if (result?.pcm) {
            const pcmInt16 = new Int16Array(result.pcm.length)
            for (let i = 0; i < result.pcm.length; i++) {
              pcmInt16[i] =
                Math.max(-1, Math.min(1, result.pcm[i] || 0)) * 32767
            }
            this.push(Buffer.from(pcmInt16.buffer))
          }
        }
      } catch (_err) {}
    }

    if (this.resampler) {
      this.resampler.destroy?.()
      this.resampler = null
    }
    if (this.decoder) this.decoder.destroy?.()
    callback()
  }
}
type MP4PrefetchChunk = { fileStart: number; data: ArrayBuffer }

function patchMoovOffsets(moovBuffer: Buffer, shift: number): void {
  let idx = 0
  while (true) {
    idx = moovBuffer.indexOf('stco', idx)
    if (idx === -1) break
    const boxStart = idx - 4
    if (boxStart >= 0) {
      const boxSize = moovBuffer.readUInt32BE(boxStart)
      const entryCount = moovBuffer.readUInt32BE(idx + 8)
      if (boxSize === 16 + entryCount * 4) {
        for (let i = 0; i < entryCount; i++) {
          const offsetPos = idx + 12 + i * 4
          const originalOffset = moovBuffer.readUInt32BE(offsetPos)
          moovBuffer.writeUInt32BE(originalOffset + shift, offsetPos)
        }
      }
    }
    idx += 4
  }

  idx = 0
  while (true) {
    idx = moovBuffer.indexOf('co64', idx)
    if (idx === -1) break
    const boxStart = idx - 4
    if (boxStart >= 0) {
      const boxSize = moovBuffer.readUInt32BE(boxStart)
      const entryCount = moovBuffer.readUInt32BE(idx + 8)
      if (boxSize === 16 + entryCount * 8) {
        for (let i = 0; i < entryCount; i++) {
          const offsetPos = idx + 12 + i * 8
          const high = moovBuffer.readUInt32BE(offsetPos)
          const low = moovBuffer.readUInt32BE(offsetPos + 4)
          const originalOffset = high * 0x100000000 + low
          const newOffset = originalOffset + shift
          const newHigh = Math.floor(newOffset / 0x100000000)
          const newLow = newOffset % 0x100000000
          moovBuffer.writeUInt32BE(newHigh, offsetPos)
          moovBuffer.writeUInt32BE(newLow, offsetPos + 4)
        }
      }
    }
    idx += 4
  }
}

/* INFO: for context of why i did this: https://github.com/pdeljanov/Symphonia/issues/289, still seems to be broken. */
function reorderMp4Boxes(originalBuffer: Buffer): Buffer {
  const topBoxes = _parseBoxes(originalBuffer)
  const ftyp = topBoxes.find((b) => b.type === 'ftyp')
  const moov = topBoxes.find((b) => b.type === 'moov')
  const mdat = topBoxes.find((b) => b.type === 'mdat')

  if (!ftyp || !moov || !mdat) {
    return originalBuffer
  }

  if (moov.offset < mdat.offset) {
    return originalBuffer
  }

  const ftypBuffer = originalBuffer.subarray(
    ftyp.offset,
    ftyp.offset + ftyp.size
  )
  const moovBuffer = Buffer.from(
    originalBuffer.subarray(moov.offset, moov.offset + moov.size)
  )

  patchMoovOffsets(moovBuffer, moov.size)

  const beforeMoov = originalBuffer.subarray(
    ftyp.offset + ftyp.size,
    moov.offset
  )
  const afterMoov = originalBuffer.subarray(moov.offset + moov.size)

  return Buffer.concat([ftypBuffer, moovBuffer, beforeMoov, afterMoov])
}

type MP4ToAACStreamOptions = TransformOptions & {
  prefetch?: MP4PrefetchChunk[]
  baseFileStart?: number
  seekTimeSec?: number
}

class MP4ToAACStream extends Transform {
  private mp4boxFile: MP4BoxFile | null
  private audioConfig: AACConfig | null
  private offset: number
  private _aborted: boolean
  private _prefetchDone: boolean
  private _opts: MP4ToAACStreamOptions
  private _initPromise: Promise<void> | null
  private state: { isAlac: boolean } | null
  private symphoniaDecoder: SymphoniaDecoderStream | null
  private headerChunks: Buffer[]

  constructor(
    options: MP4ToAACStreamOptions & { state?: { isAlac: boolean } } = {}
  ) {
    super({ ...options, highWaterMark: AUDIO_CONFIG.highWaterMark })

    this._opts = options
    this.mp4boxFile = null
    this.audioConfig = null
    this.offset = options.baseFileStart ?? 0
    this._aborted = false
    this._prefetchDone = false
    this._initPromise = null
    this.state = options.state ?? null
    this.symphoniaDecoder = null
    this.headerChunks = []
  }

  private async _initMp4Box(): Promise<void> {
    if (this.mp4boxFile) return
    if (this._initPromise) {
      await this._initPromise
      return
    }

    this._initPromise = (async () => {
      const mp4Box = await getMP4Box()
      this.mp4boxFile = mp4Box.createFile(false) as unknown as MP4BoxFile
      this._setupMP4BoxHandlers()
    })()

    await this._initPromise
  }

  abort(): void {
    this._aborted = true
    this._cleanupMp4Box()
    if (this.symphoniaDecoder) {
      this.symphoniaDecoder.abort?.()
    }
  }

  private _appendPrefetchIfNeeded(): void {
    if (this._prefetchDone || !this.mp4boxFile) return
    this._prefetchDone = true

    const prefetch = this._opts.prefetch ?? []
    this._opts.prefetch = undefined
    for (const chunk of prefetch) {
      const ab = chunk.data as ArrayBuffer & { fileStart?: number }
      ab.fileStart = chunk.fileStart
      this.mp4boxFile.appendBuffer(ab)
    }
  }

  _setupMP4BoxHandlers(): void {
    if (!this.mp4boxFile) return

    this.mp4boxFile.onError = (e: string): void => {
      throw new Error(`MP4Box error: ${e}`)
    }

    this.mp4boxFile.onReady = (info: MP4BoxInfo): void => {
      if (this._aborted || !this.mp4boxFile) return

      const audioTrack = info.tracks.find(
        (t: MP4BoxTrack) =>
          t.codec?.startsWith('mp4a') || t.codec?.startsWith('alac')
      )
      if (!audioTrack) {
        throw new Error('No supported track found in MP4')
      }

      if (audioTrack.codec?.startsWith('alac')) {
        if (this.state) this.state.isAlac = true
        this._cleanupMp4Box()
        this.symphoniaDecoder = new SymphoniaDecoderStream({
          codecRegistryHint: 'm4a'
        })
        this.symphoniaDecoder.on('data', (pcm: Buffer) => {
          this.push(pcm)
        })
        this.symphoniaDecoder.on('error', (err) => {
          this.emit('error', err)
        })
        const fullBuffer = Buffer.concat(this.headerChunks)
        const reordered = reorderMp4Boxes(fullBuffer)
        this.headerChunks = []
        this.symphoniaDecoder.write(reordered)
      } else {
        this.audioConfig = this._getAudioConfig(audioTrack)
        this.headerChunks = []

        this.mp4boxFile.setExtractionOptions(audioTrack.id, null, {
          nbSamples: 50
        })

        if (typeof this._opts.seekTimeSec === 'number') {
          const mp4boxFile = this.mp4boxFile as unknown as {
            seek: (time: number, async: boolean) => MP4BoxSeekResult
          }
          const seekRes = mp4boxFile.seek(
            this._opts.seekTimeSec,
            true
          ) as MP4BoxSeekResult
          const expectedOffset = _seekOffset(seekRes)

          if (
            typeof this._opts.baseFileStart === 'number' &&
            this._opts.baseFileStart !== expectedOffset
          ) {
            logger(
              'warn',
              'MP4ToAACStream',
              `MP4 seek mismatch: stream starts at ${this._opts.baseFileStart} but MP4Box requested ${expectedOffset}`
            )
          }

          if (typeof this._opts.baseFileStart !== 'number') {
            this.offset = expectedOffset
          }
        }

        this.mp4boxFile.start()
      }
    }

    this.mp4boxFile.onSamples = (
      id: number,
      _user: unknown,
      samples: MP4BoxSample[]
    ): void => {
      if (this._aborted || !this.mp4boxFile) return
      if (!samples?.length) return

      for (const sample of samples) this._emitSampleWithADTS(sample)

      const last: unknown = samples[samples.length - 1]
      if (last && typeof last === 'object' && 'number' in last) {
        const mp4boxFile = this.mp4boxFile as unknown as {
          releaseUsedSamples: (trackId: number, sampleNumber: number) => void
        }
        mp4boxFile.releaseUsedSamples(
          id,
          (last as { number: number }).number + 1
        )
      }
    }
  }

  _emitSampleWithADTS(sample: MP4BoxSample): void {
    if (!this.audioConfig) return
    const { profile, samplingIndex, channelCount } = this.audioConfig

    const sampleData = Buffer.from(sample.data)

    this.push(
      _createAdtsHeader(
        sampleData.byteLength,
        profile,
        samplingIndex,
        channelCount
      )
    )
    this.push(sampleData)
  }

  _getAudioConfig(track: MP4BoxTrack): AACConfig {
    let profile = 2
    const file = this.mp4boxFile as unknown as {
      getTrackById?: (id: number) => {
        mdia?: {
          minf?: {
            stbl?: {
              stsd?: {
                entries?: Array<{
                  esds?: {
                    esd?: { descs?: MP4Descriptor[] }
                  }
                }>
              }
            }
          }
        }
      }
    }
    const entry = file?.getTrackById?.(track.id)?.mdia?.minf?.stbl?.stsd
      ?.entries?.[0]
    const decoderConfig = entry?.esds?.esd?.descs?.find(
      (descriptor) => descriptor.tag === 4
    )
    const decoderSpecificInfo = decoderConfig?.descs?.find(
      (descriptor) => descriptor.tag === 5
    )?.data
    const adtsSampleRate =
      (decoderSpecificInfo && _parseAacSampleRate(decoderSpecificInfo)) ||
      track.audio.sample_rate

    if (track.codec) {
      const codecParts = (String(track.codec) || '').split('.')

      if (codecParts.length >= 3) {
        const objectType = Number.parseInt(codecParts[2] || '0', 10)

        if (objectType === 5 || objectType === 29) {
          // ADTS carries the AAC-LC core profile. FAAD detects the SBR/PS
          // extension from the payload and exposes the higher output rate.
          profile = 2
        } else {
          profile = objectType
        }
      }
    }

    const samplingIndex = SAMPLE_RATES.indexOf(adtsSampleRate)

    if (samplingIndex === -1) {
      throw new Error('Unsupported sample rate for ADTS')
    }

    return {
      profile,
      samplingIndex,
      channelCount: track.audio.channel_count,
      sampleRate: adtsSampleRate
    }
  }

  override async _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): Promise<void> {
    if (this._aborted) {
      callback()
      return
    }

    if (this.symphoniaDecoder) {
      this.symphoniaDecoder.write(chunk)
      callback()
      return
    }

    if (!this.audioConfig) this.headerChunks.push(chunk)

    try {
      await this._initMp4Box()
      if (!this.mp4boxFile) {
        callback()
        return
      }

      this._appendPrefetchIfNeeded()

      const arrayBuffer =
        chunk instanceof ArrayBuffer
          ? chunk
          : (_toTightArrayBuffer(chunk) as ArrayBuffer & { fileStart?: number })

      ;(arrayBuffer as ArrayBuffer & { fileStart?: number }).fileStart =
        this.offset
      this.offset += arrayBuffer.byteLength

      this.mp4boxFile.appendBuffer(arrayBuffer)
      callback()
    } catch (err) {
      callback(err as Error)
    }
  }

  override _flush(callback: TransformCallback): void {
    const decoderInstance = this
      .symphoniaDecoder as SymphoniaDecoderStream | null
    if (decoderInstance) {
      decoderInstance.end(callback)
      return
    }

    if (!this._aborted && this.mp4boxFile) {
      try {
        this.mp4boxFile.flush()
      } catch {}
    }

    const decoderInstanceAfter = this
      .symphoniaDecoder as SymphoniaDecoderStream | null
    if (decoderInstanceAfter) {
      decoderInstanceAfter.end(callback)
      return
    }

    this._cleanupMp4Box()
    callback()
  }

  override _destroy(
    err: Error | null,
    callback: (error?: Error | null) => void
  ): void {
    this._aborted = true
    this._cleanupMp4Box()
    this.headerChunks = []
    if (this.symphoniaDecoder) {
      this.symphoniaDecoder.destroy()
      this.symphoniaDecoder = null
    }
    super._destroy(err, callback)
  }

  _cleanupMp4Box(): void {
    if (this.mp4boxFile) {
      try {
        this.mp4boxFile.stop()
        this.mp4boxFile.flush()
      } catch {}
      this.mp4boxFile.onReady = null
      this.mp4boxFile.onSamples = null
      this.mp4boxFile.onError = null
      this.mp4boxFile = null
    }
  }
}
/**********************************************************************
 * ATENÇÃO: Não altere este trecho; ajustes aqui quebram a cadeia de decodificação.
 * WARNING: Do not edit this section; changes here will break the decoding pipeline.
 **********************************************************************/
class FMP4ToAACStream extends Transform {
  private audioConfig: AACConfig | null
  private initSegmentProcessed: boolean
  private bufferMode: boolean
  private buffer: Buffer
  private _streamState: FMP4StreamState | null

  constructor(options: FMP4StreamOptions = {}) {
    super(options as TransformOptions)
    this.audioConfig = null
    this.initSegmentProcessed = false
    this.bufferMode = options.bufferMode || false
    this.buffer = EMPTY_BUFFER
    this._streamState = null
  }

  private _compactBuffer(): void {
    if (this.buffer.length === 0) {
      this.buffer = EMPTY_BUFFER
      return
    }

    if (
      this.buffer.byteOffset > 0 &&
      (this.buffer.byteOffset >= 256 * 1024 ||
        this.buffer.buffer.byteLength > this.buffer.length * 4)
    ) {
      this.buffer = Buffer.from(this.buffer)
    }
  }

  _parseBoxes(buffer: Buffer, offset = 0): MP4BoxType[] {
    const boxes: MP4BoxType[] = []
    while (offset < buffer.length) {
      if (offset + 8 > buffer.length) break

      const size = buffer.readUInt32BE(offset)
      const type = buffer.toString('ascii', offset + 4, offset + 8)

      if (size === 0 || size > buffer.length - offset) break
      if (type === '\0\0\0\0') break

      const boxData = buffer.subarray(offset + 8, offset + size)
      boxes.push({ type, size, data: boxData, offset })
      offset += size
    }
    return boxes
  }

  _extractAudioConfigFromInit(initSegment: Buffer): AACConfig | null {
    const boxes = this._parseBoxes(initSegment)
    const moovBox = boxes.find((b) => b.type === 'moov')
    if (!moovBox) return null

    const moovBoxes = this._parseBoxes(moovBox.data)
    const trakBox = moovBoxes.find((b) => b.type === 'trak')
    if (!trakBox) return null

    const trakBoxes = this._parseBoxes(trakBox.data)
    const mdiaBox = trakBoxes.find((b) => b.type === 'mdia')
    if (!mdiaBox) return null

    const mdiaBoxes = this._parseBoxes(mdiaBox.data)
    const minfBox = mdiaBoxes.find((b) => b.type === 'minf')
    if (!minfBox) return null

    const minfBoxes = this._parseBoxes(minfBox.data)
    const stblBox = minfBoxes.find((b) => b.type === 'stbl')
    if (!stblBox) return null

    const stblBoxes = this._parseBoxes(stblBox.data)
    const stsdBox = stblBoxes.find((b) => b.type === 'stsd')
    if (!stsdBox) return null

    const stsd = stsdBox.data
    if (stsd.length < 16) return null

    const stsdBoxes = this._parseBoxes(stsd, 8)
    const mp4aBox = stsdBoxes.find((b) => b.type === 'mp4a')
    if (!mp4aBox) return null

    const mp4a = mp4aBox.data
    if (mp4a.length < 28) return null

    const channelCount = mp4a.readUInt16BE(16)
    const sampleRate = mp4a.readUInt32BE(24) >> 16

    const sampleRates = [
      96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000,
      11025, 8000, 7350
    ]
    const samplingIndex = sampleRates.indexOf(sampleRate)

    return {
      profile: 2,
      samplingIndex: samplingIndex !== -1 ? samplingIndex : 4,
      channelCount,
      sampleRate
    }
  }

  _createAdtsHeader(sampleLength: number, audioConfig: AACConfig): Buffer {
    const adts = Buffer.alloc(7)
    const frameLength = sampleLength + 7

    const profile = (audioConfig.profile || 2) - 1
    const samplingIndex = audioConfig.samplingIndex || 4
    const channelCount = audioConfig.channelCount || 2

    adts[0] = 0xff
    adts[1] = 0xf1
    adts[2] =
      ((profile & 0x03) << 6) |
      ((samplingIndex & 0x0f) << 2) |
      ((channelCount & 0x04) >> 2)
    adts[3] = ((channelCount & 0x03) << 6) | ((frameLength & 0x1800) >> 11)
    adts[4] = (frameLength & 0x7f8) >> 3
    adts[5] = ((frameLength & 0x7) << 5) | 0x1f
    adts[6] = 0xfc

    return adts
  }

  _extractAACFromSegment(buffer: Buffer): Buffer | null {
    if (!this.audioConfig) return null

    const boxes = this._parseBoxes(buffer)
    const mdatBox = boxes.find((b) => b.type === 'mdat')
    if (!mdatBox) return null

    const aacData = mdatBox.data
    const moofBox = boxes.find((b) => b.type === 'moof')
    if (!moofBox) return aacData

    const moofBoxes = this._parseBoxes(moofBox.data)
    const trafBox = moofBoxes.find((b) => b.type === 'traf')
    if (!trafBox) return aacData

    const trafBoxes = this._parseBoxes(trafBox?.data || EMPTY_BUFFER)
    const trunBox = trafBoxes.find((b) => b.type === 'trun')
    if (!trunBox) return aacData

    const trun = trunBox.data
    if (trun.length < 8) return aacData

    const flags =
      ((trun[1] ?? 0) << 16) | ((trun[2] ?? 0) << 8) | (trun[3] ?? 0)
    const sampleCount = trun.readUInt32BE(4)

    let offset = 8
    if (flags & 0x1) offset += 4
    if (flags & 0x4) offset += 4

    const sampleSizes = []
    const hasSampleSize = flags & 0x200

    for (let i = 0; i < sampleCount && offset < trun.length; i++) {
      if (flags & 0x100) offset += 4
      if (hasSampleSize && offset + 4 <= trun.length) {
        sampleSizes.push(trun.readUInt32BE(offset))
        offset += 4
      }
      if (flags & 0x400) offset += 4
      if (flags & 0x800) offset += 4
    }

    if (sampleSizes.length > 0) {
      const validSampleSizes: number[] = []
      let totalBytes = 0
      let dataOffset = 0
      for (const sampleSize of sampleSizes) {
        if (dataOffset + sampleSize <= aacData.length) {
          validSampleSizes.push(sampleSize)
          totalBytes += 7 + sampleSize
          dataOffset += sampleSize
        }
      }
      if (validSampleSizes.length === 0) return null

      const out = Buffer.allocUnsafe(totalBytes)
      let inOffset = 0
      let outOffset = 0
      for (const sampleSize of validSampleSizes) {
        const adtsHeader = this._createAdtsHeader(sampleSize, this.audioConfig)
        adtsHeader.copy(out, outOffset)
        outOffset += adtsHeader.length
        aacData.copy(out, outOffset, inOffset, inOffset + sampleSize)
        outOffset += sampleSize
        inOffset += sampleSize
      }
      return out
    }

    return null
  }

  _processBuffer(): void {
    while (this.buffer.length > 0) {
      if (!this._streamState) {
        this._streamState = {
          mode: 'READ_HEADER',
          offset: 0,
          boxSize: 0,
          boxType: '',
          headerSize: 8,
          moofBuffer: EMPTY_BUFFER,
          samples: []
        }
      }

      const state = this._streamState
      if (state.mode === 'READ_HEADER') {
        if (this.buffer.length < 8) {
          this._compactBuffer()
          break
        }

        const size32 = this.buffer.readUInt32BE(0)
        const type = this.buffer.toString('ascii', 4, 8)

        let size = size32
        let headerSize = 8

        if (size === 1) {
          if (this.buffer.length < 16) {
            this._compactBuffer()
            break
          }
          size = Number(this.buffer.readBigUInt64BE(8))
          headerSize = 16
        }

        if (size === 0 || (size < headerSize && size !== 0)) {
          this.buffer = this.buffer.subarray(1)
          continue
        }

        state.boxSize = size
        state.boxType = type
        state.headerSize = headerSize

        this.buffer = this.buffer.subarray(headerSize)
        state.boxSize -= headerSize

        if (type === 'mdat') {
          state.mode = 'STREAM_MDAT'
        } else {
          state.mode = 'READ_BODY'
        }
      } else if (state.mode === 'READ_BODY') {
        if (this.buffer.length < state.boxSize) {
          this._compactBuffer()
          break
        }

        const body = this.buffer.subarray(0, state.boxSize)
        this.buffer = this.buffer.subarray(state.boxSize)

        const type = state.boxType

        if (type === 'moov') {
          if (!this.initSegmentProcessed) {
            const header = Buffer.alloc(8)
            header.writeUInt32BE(body.length + 8, 0)
            header.write('moov', 4)
            const fullBox = Buffer.concat([header, body])

            const config = this._extractAudioConfigFromInit(fullBox)
            if (config) {
              this.audioConfig = config
              this.initSegmentProcessed = true
            } else {
              logger('warn', 'FMP4', 'Failed to extract audio config from moov')
            }
          }
        } else if (type === 'ftyp') {
        } else if (type === 'moof') {
          const sizes = this._parseMoof(body)
          if (sizes && sizes.length > 0) {
            this._streamState.samples = sizes
          } else {
          }
        }

        this._streamState.mode = 'READ_HEADER'
      } else if (this._streamState.mode === 'STREAM_MDAT') {
        const samples = this._streamState.samples

        if (samples.length === 0) {
          const toSkip = Math.min(this.buffer.length, this._streamState.boxSize)
          this.buffer = this.buffer.subarray(toSkip)
          this._streamState.boxSize -= toSkip
        } else {
          while (
            samples.length > 0 &&
            samples[0] !== undefined &&
            this.buffer.length >= samples[0]
          ) {
            const sampleSize = samples[0]
            const sampleData = this.buffer.subarray(0, sampleSize)
            this.buffer = this.buffer.subarray(sampleSize)

            if (this.audioConfig) {
              const adts = this._createAdtsHeader(sampleSize, this.audioConfig)
              this.push(adts)
              this.push(_tightBuffer(sampleData))
            }

            this._streamState.boxSize -= sampleSize
            samples.shift()
          }
        }

        if (this._streamState.boxSize <= 0) {
          this._streamState.mode = 'READ_HEADER'
          this._streamState.samples = []
        } else if (
          samples.length > 0 &&
          samples[0] !== undefined &&
          this.buffer.length < samples[0]
        ) {
          this._compactBuffer()
          break
        }
      }

      this._compactBuffer()
    }
  }

  _parseMoof(moofData: Buffer): number[] {
    const boxes = this._parseBoxes(moofData)
    const trafs = boxes.filter((b) => b.type === 'traf')
    const sizes = []

    for (const traf of trafs) {
      const trafBoxes = this._parseBoxes(traf.data)
      const tfhd = trafBoxes.find((b) => b.type === 'tfhd')
      if (!tfhd || tfhd.data.length < 8) continue

      const trackId = tfhd.data.readUInt32BE(4)

      if (
        trafs.length > 1 &&
        this.audioConfig &&
        trackId !== this.audioConfig.trackId
      ) {
        continue
      }
      if (!this.audioConfig) continue

      const tfhdData = tfhd.data
      const tfhdFlags =
        ((tfhdData[1] ?? 0) << 16) |
        ((tfhdData[2] ?? 0) << 8) |
        (tfhdData[3] ?? 0)
      let currentDefaultSize = this.audioConfig.defaultSampleSize || 0

      let offset = 8
      if (tfhdFlags & 0x01) offset += 8
      if (tfhdFlags & 0x02) offset += 4
      if (tfhdFlags & 0x08) offset += 4
      if (tfhdFlags & 0x10 && offset + 4 <= tfhdData.length) {
        currentDefaultSize = tfhdData.readUInt32BE(offset)
        offset += 4
      }

      const truns = trafBoxes.filter((b) => b.type === 'trun')
      for (const trun of truns) {
        const data = trun.data
        if (data.length < 8) continue
        const flags =
          ((data[1] ?? 0) << 16) | ((data[2] ?? 0) << 8) | (data[3] ?? 0)
        const count = data.readUInt32BE(4)

        let trunOffset = 8
        if (flags & 0x01) trunOffset += 4
        if (flags & 0x04) trunOffset += 4

        const hasDuration = flags & 0x100
        const hasSize = flags & 0x200
        const hasFlags = flags & 0x400
        const hasCtOffset = flags & 0x800

        for (let i = 0; i < count; i++) {
          let sSize = currentDefaultSize
          if (hasDuration) trunOffset += 4
          if (hasSize && trunOffset + 4 <= data.length) {
            sSize = data.readUInt32BE(trunOffset)
            trunOffset += 4
          }
          if (hasFlags) trunOffset += 4
          if (hasCtOffset) trunOffset += 4

          if (sSize > 0) sizes.push(sSize)
        }
      }
    }
    return sizes
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    try {
      if (this.bufferMode) {
        if (this.buffer.length === 0) this.buffer = chunk
        else if (chunk.length > 0)
          this.buffer = Buffer.concat(
            [this.buffer, chunk],
            this.buffer.length + chunk.length
          )
        this._processBuffer()
      } else {
        if (!this.initSegmentProcessed && chunk.length > 8) {
          const boxType = chunk.toString('ascii', 4, 8)
          if (boxType === 'ftyp') {
            this.audioConfig = this._extractAudioConfigFromInit(chunk)
            this.initSegmentProcessed = true
            callback()
            return
          }
        }

        if (this.audioConfig) {
          const aacData = this._extractAACFromSegment(chunk)
          if (aacData) this.push(aacData)
        }
      }

      callback()
    } catch (_err) {
      callback()
    }
  }

  override _flush(callback: TransformCallback): void {
    if (this.bufferMode) {
      try {
        this._processBuffer()
      } catch (_err) {}
    }
    this.buffer = EMPTY_BUFFER
    this._streamState = null
    callback()
  }

  override _destroy(
    err: Error | null,
    callback: (error?: Error | null) => void
  ): void {
    this.buffer = EMPTY_BUFFER
    this._streamState = null
    super._destroy(err, callback)
  }
}

class FLVToAACStream extends Transform {
  private demuxer: FlvDemuxerLike
  private audioConfig: AACConfig | null
  private _aborted: boolean

  constructor(options: TransformOptions = {}) {
    super(options)
    this.demuxer = new FlvDemuxer() as FlvDemuxerLike
    this.audioConfig = null
    this._aborted = false

    this.demuxer.on('data', (audioTag: Buffer) => {
      if (this._aborted) return
      this._processAudioTag(audioTag)
    })

    this.demuxer.on('error', (err: Error) => {
      if (!this._aborted) this.emit('error', err)
    })
  }

  abort(): void {
    this._aborted = true
    this.demuxer.destroy()
  }

  _processAudioTag(tag: Buffer): void {
    const header = tag[0] ?? 0
    const format = (header & 0xf0) >> 4

    if (format === 10) {
      const aacPacketType = tag[1]
      if (aacPacketType === 0) {
        this.audioConfig = this._parseAudioSpecificConfig(tag.subarray(2))
      } else if (aacPacketType === 1 && this.audioConfig) {
        const adtsHeader = _createAdtsHeader(
          tag.length - 2,
          this.audioConfig.profile || 2,
          this.audioConfig.samplingIndex || 4,
          this.audioConfig.channelCount || 2
        )
        this.push(adtsHeader)
        this.push(_tightBuffer(tag.subarray(2)))
      }
    } else if (format === 2) {
      this.push(_tightBuffer(tag.subarray(1)))
    }
  }

  _parseAudioSpecificConfig(data: Buffer): AACConfig {
    const objectType = ((data[0] ?? 0) & 0xf8) >> 3
    const samplingIndex =
      (((data[0] ?? 0) & 0x07) << 1) | (((data[1] ?? 0) & 0x80) >> 7)
    const channelConfig = ((data[1] ?? 0) & 0x78) >> 3

    return {
      profile: objectType,
      samplingIndex,
      channelCount: channelConfig
    }
  }

  override _transform(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    this.demuxer.write(chunk, encoding, callback)
  }

  override _flush(callback: TransformCallback): void {
    this.demuxer.end(callback)
  }
}

class StreamAudioResource extends BaseAudioResource {
  private nodelink: NodeLink
  private frameCounter: PCMFrameCounter | null = null

  constructor(
    guildId: string,
    stream: Readable,
    type: string,
    nodelink: NodeLink,
    initialFilters: FiltersState = {},
    volume = 1.0,
    audioMixer: AudioMixer | null = null,
    returnPCM = false,
    enableAGC = true,
    enableCrossfade = false
  ) {
    super(guildId)

    this.nodelink = nodelink
    this._validateInputStream(stream)

    const resamplingQuality =
      nodelink.options.playback.audio?.resamplingQuality || 'fastest'
    const normalizedType = normalizeFormat(type)

    this.pipes = [stream]

    const pcmStream = this._createDecoderPipeline(
      stream,
      type,
      normalizedType,
      resamplingQuality
    )

    if (returnPCM) {
      this._createPCMOutputPipeline(pcmStream, volume, enableAGC)
    } else {
      this._createOutputPipeline(
        pcmStream,
        nodelink as unknown as NodeLink,
        initialFilters,
        volume,
        audioMixer,
        enableAGC,
        enableCrossfade
      )
    }

    this._setupEventHandlers(stream)
  }

  _validateInputStream(stream: Readable): void {
    if (!stream || !(stream instanceof Readable)) {
      throw new Error('Invalid stream provided')
    }
  }

  _createDecoderPipeline(
    stream: Readable,
    type: string,
    normalizedType: string,
    resamplingQuality: string
  ): Transform {
    if (type === 'pcm') return stream as Transform

    switch (normalizedType) {
      case SupportedFormats.AAC:
        return this._createAACPipeline(stream, type, resamplingQuality)

      case SupportedFormats.FLV:
        return this._createFLVPipeline(stream, type, resamplingQuality)

      case SupportedFormats.MPEG:
      case SupportedFormats.FLAC:
      case SupportedFormats.OGG_VORBIS:
      case SupportedFormats.WAV:
      case SupportedFormats.ALAC:
        return this._createSymphoniaPipeline(stream, type)

      case SupportedFormats.OPUS:
        return this._createOpusPipeline(stream, type)

      default:
        throw this._createUnsupportedFormatError(type)
    }
  }

  _createFLVPipeline(
    stream: Readable,
    _type: string,
    resamplingQuality: string
  ): Transform {
    const demuxer = new FLVToAACStream()
    const decoder = new AACDecoderStream({
      resamplingQuality: resamplingQuality as ResamplingQuality
    })

    this.pipes?.push(demuxer, decoder)

    pipeline(stream, demuxer, decoder, (err: Error | null): void => {
      if (err && !this._destroyed) {
        this.stream?.emit('error', err)
      }
    })

    return decoder
  }

  _createAACPipeline(
    stream: Readable,
    type: string,
    resamplingQuality: string
  ): Transform {
    const lowerType = type.toLowerCase()
    const _aacStream = stream
    const streams: (Readable | Transform)[] = [stream]
    const state = { isAlac: false }

    if (_isFmp4Format(lowerType)) {
      const bufferMode = lowerType.includes('fmp4-buffered')
      const demuxer = new FMP4ToAACStream({ bufferMode })
      streams.push(demuxer)
    } else if (_isMpegtsFormat(lowerType)) {
      const demuxer = new MPEGTSDemuxer()
      streams.push(demuxer)

      if (lowerType.includes('mp3') || lowerType.includes('mpeg')) {
        const decoder = new SymphoniaDecoderStream({
          codecRegistryHint: _getSymphoniaCodecHint(lowerType)
        })
        streams.push(decoder)

        this.pipes?.push(...streams.slice(1))

        pipeline(
          streams as unknown as Readable[],
          (err: Error | null): void => {
            if (err && !this._destroyed) {
              this.stream?.emit('error', err)
            }
          }
        )

        return decoder
      }
    } else if (_isMp4Format(lowerType)) {
      const seekOpts = (
        stream as unknown as { __mp4SeekOptions?: MP4ToAACStreamOptions }
      ).__mp4SeekOptions
      const demuxer = new MP4ToAACStream(
        seekOpts
          ? {
              prefetch: seekOpts.prefetch,
              baseFileStart: seekOpts.baseFileStart,
              seekTimeSec: seekOpts.seekTimeSec,
              state
            }
          : { state }
      )
      streams.push(demuxer)
    }

    const decoder = new AACDecoderStream({
      resamplingQuality: resamplingQuality as ResamplingQuality,
      state
    })
    streams.push(decoder)

    this.pipes?.push(...streams.slice(1))

    pipeline(streams as unknown as Readable[], (err: Error | null): void => {
      if (err && !this._destroyed) {
        this.stream?.emit('error', err)
      }
    })

    return decoder
  }

  _createSymphoniaPipeline(stream: Readable, type: string): Transform {
    const decoder = new SymphoniaDecoderStream({
      codecRegistryHint: _getSymphoniaCodecHint(type)
    })
    this.pipes?.push(decoder)

    pipeline(stream, decoder, (err: Error | null): void => {
      if (err && !this._destroyed) {
        this.stream?.emit('error', err)
      }
    })

    return decoder
  }

  _createOpusPipeline(stream: Readable, type: string): Transform {
    const decoder = new OpusDecoder({
      rate: AUDIO_CONFIG.sampleRate,
      channels: AUDIO_CONFIG.channels
    })

    const streams: (Readable | Transform)[] = [stream]

    if (_isWebmFormat(type.toLowerCase())) {
      const demuxer = new WebmOpusDemuxer()
      streams.push(demuxer)
      this.pipes?.push(demuxer)
    }

    streams.push(decoder)
    this.pipes?.push(decoder)

    pipeline(streams as unknown as Readable[], (err: Error | null): void => {
      if (err && !this._destroyed) {
        this.stream?.emit('error', err)
      }
    })

    return decoder
  }

  _createOutputPipeline(
    pcmStream: Transform,
    nodelink: NodeLink,
    initialFilters: FiltersState,
    volume: number,
    audioMixer: AudioMixer | null = null,
    enableAGC = true,
    enableCrossfade = false
  ): void {
    const frameCounter = new PCMFrameCounter(
      AUDIO_CONFIG.sampleRate,
      AUDIO_CONFIG.channels
    )
    this.frameCounter = frameCounter // Saves the reference to get the time later

    const filters = new FiltersManager(nodelink, initialFilters)
    const volumeTransformer = new VolumeTransformer({
      type: 's16le',
      volume,
      enableAGC,
      lookaheadMs: nodelink.options.playback.audio?.lookaheadMs,
      gateThresholdLUFS: nodelink.options.playback.audio?.gateThresholdLUFS
    })
    const fadeTransformer = new FadeTransformer({
      type: 's16le',
      volume: 1.0,
      sampleRate: AUDIO_CONFIG.sampleRate,
      channels: AUDIO_CONFIG.channels
    })
    const tapeTransformer = new TapeTransformer({
      sampleRate: AUDIO_CONFIG.sampleRate,
      channels: AUDIO_CONFIG.channels
    })
    const scratchTransformer = new ScratchTransformer({
      sampleRate: AUDIO_CONFIG.sampleRate,
      channels: AUDIO_CONFIG.channels
    })

    const silenceDetector = new SilenceDetector({
      sampleRate: AUDIO_CONFIG.sampleRate,
      channels: AUDIO_CONFIG.channels,
      thresholdDb:
        nodelink.options.playback.audio?.automix?.silenceThresholdDb ?? -40
    })

    const flowController = new FlowController(
      volumeTransformer,
      fadeTransformer,
      tapeTransformer,
      scratchTransformer,
      audioMixer
    )

    const opusEncoder = new OpusEncoder({
      rate: AUDIO_CONFIG.sampleRate,
      channels: AUDIO_CONFIG.channels
    })

    opusEncoder.setDTX(false)

    const streams: Transform[] = [pcmStream]
    if (enableCrossfade) {
      const crossfadeController = new CrossfadeController()
      crossfadeController.on('bridgeStart', () => {
        this.canStop = false
      })
      crossfadeController.on('bridgeEnd', () => {
        if (this._destroyed) return
        this.canStop = true
        this._finishBufferingEmitted = true
        this.stream?.emit('finishBuffering')
      })
      streams.push(crossfadeController)
      this.pipes?.push(crossfadeController)
    }
    streams.push(frameCounter, silenceDetector, filters, flowController)
    this.pipes?.push(frameCounter, silenceDetector, filters, flowController)

    if (nodelink.extensions?.audioInterceptors) {
      for (const interceptorFactory of nodelink.extensions.audioInterceptors) {
        try {
          const interceptorStream = interceptorFactory()
          if (interceptorStream) {
            streams.push(interceptorStream)
            this.pipes?.push(interceptorStream)
          }
        } catch (e) {
          logger(
            'error',
            'StreamProcessor',
            `Audio interceptor error: ${e instanceof Error ? e.message : String(e)}`
          )
        }
      }
    }

    streams.push(opusEncoder)
    this.pipes?.push(opusEncoder)

    pipeline(streams as unknown as Readable[], (err: Error | null): void => {
      if (err && !this._destroyed) {
        opusEncoder.emit('error', err)
      }
    })

    this._assignStream(opusEncoder)
  }

  getConsumedMs(): number {
    return this.frameCounter?.getConsumedMs() ?? 0
  }

  override getMainEnergy(): { rms: number; peak: number } | null {
    return null
  }

  override getEffectiveRate(): number {
    const filters = this.pipes?.find((p) => p instanceof FiltersManager) as
      | FiltersManager
      | undefined
    const flowController = this.pipes?.find(
      (p) => p instanceof FlowController
    ) as FlowController | undefined
    return (
      (filters?.getRate() ?? 1.0) * (flowController?.getEffectiveRate() ?? 1.0)
    )
  }

  override checkTapeRampCompleted(): boolean {
    if (!this.pipes) return false

    const flowController = this.pipes.find(
      (p) => p instanceof FlowController
    ) as FlowController | undefined
    return flowController?.checkTapeRampCompleted() ?? false
  }

  override checkScratchEffectCompleted(): boolean {
    if (!this.pipes) return false

    const flowController = this.pipes.find(
      (p) => p instanceof FlowController
    ) as FlowController | undefined
    return flowController?.checkScratchEffectCompleted() ?? false
  }

  override tapeTo(
    durationMs: number,
    type: 'start' | 'stop',
    curve?: string
  ): void {
    if (!this.pipes) return

    const flowController = this.pipes.find(
      (p) => p instanceof FlowController
    ) as FlowController | undefined
    if (flowController) {
      flowController.tapeTo(durationMs, type, curve)
    }
  }

  override scratchTo(
    durationMs: number,
    style: import('../../typings/playback/processing.types.ts').ScratchStyle
  ): void {
    if (!this.pipes) return

    const flowController = this.pipes.find(
      (p) => p instanceof FlowController
    ) as FlowController | undefined
    if (flowController) {
      flowController.scratchTo(durationMs, style)
    }
  }

  override setLoudnessNormalizer(enabled: boolean): void {
    if (!this.pipes) return

    const volumeTransformer = this.pipes.find(
      (p) => p instanceof VolumeTransformer
    ) as VolumeTransformer | undefined
    if (volumeTransformer) {
      volumeTransformer.setAGCEnabled(enabled)
      return
    }

    const flowController = this.pipes.find(
      (p) => p instanceof FlowController
    ) as FlowController | undefined
    if (flowController) {
      flowController.setLoudnessNormalizer(enabled)
    }
  }

  _createPCMOutputPipeline(
    pcmStream: Transform,
    volume: number,
    enableAGC = true
  ): void {
    if (volume !== 1.0 || enableAGC) {
      const volumeTransformer = new VolumeTransformer({
        type: 's16le',
        volume,
        enableAGC,
        lookaheadMs: this.nodelink?.options?.audio?.lookaheadMs,
        gateThresholdLUFS: this.nodelink?.options?.audio?.gateThresholdLUFS
      })

      pipeline(pcmStream, volumeTransformer, (err: Error | null): void => {
        if (err && !this._destroyed) {
          volumeTransformer.emit('error', err)
        }
      })

      this._assignStream(volumeTransformer as unknown as Transform)
    } else {
      this._assignStream(pcmStream)
    }
  }

  _setupEventHandlers(inputStream: Readable): void {
    const forwardFinishBuffering = (): void => {
      if (this.getCrossfadeState().isBridging) return
      if (!this._destroyed) {
        this._finishBufferingEmitted = true
        this.stream?.emit('finishBuffering')
      }
    }
    this._forwardFinishBuffering = forwardFinishBuffering

    inputStream.on('finishBuffering', forwardFinishBuffering)

    const wrappedSource = (
      inputStream as Readable & {
        _sourceStream?: Readable
      }
    )._sourceStream
    wrappedSource?.on?.('finishBuffering', forwardFinishBuffering)

    inputStream.on('error', (err: Error) => {
      this.stream?.emit('error', err)
    })

    if (this.pipes) {
      for (const pipe of this.pipes) {
        if (pipe !== this.stream) {
          pipe.on?.('error', (err: Error) => {
            this.stream?.emit('error', err)
          })
        }
      }
    }

    if (this.stream) {
      this.stream.on('error', () => {
        this._end()
      })
    }
  }

  _createUnsupportedFormatError(type: string): Error {
    const supportedFormats = [
      'MP3 (audio/mpeg)',
      'AAC (audio/aac, audio/aacp, video/quicktime, mp4, m4a, m4v, mov, hls, mpegurl, fmp4, mpegts)',
      'FLAC (audio/flac)',
      'OGG Vorbis (audio/ogg, audio/vorbis)',
      'WAV (audio/wav)',
      'Opus (webm/opus, ogg/opus, webm, weba)',
      'FLV (video/x-flv, flv)'
    ]

    return new Error(
      `Unsupported audio format: '${type}'.\n` +
        'Supported formats:\n' +
        supportedFormats.map((f) => `  • ${f}`).join('\n')
    )
  }
}

export const createAudioResource = (
  guildId: string,
  stream: Readable,
  type: string,
  nodelink: NodeLink,
  initialFilters: FiltersState = {},
  volume: number = 1.0,
  audioMixer: AudioMixer | null = null,
  returnPCM: boolean = false,
  enableAGC: boolean = true,
  enableCrossfade: boolean = false
): StreamAudioResource =>
  new StreamAudioResource(
    guildId,
    stream,
    type,
    nodelink,
    initialFilters,
    volume,
    audioMixer,
    returnPCM,
    enableAGC,
    enableCrossfade
  )

export const createSeekeableAudioResource = async (
  guildId: string,
  url: string,
  seekTime: number,
  endTime: number | undefined,
  nodelink: NodeLink,
  initialFilters: FiltersState,
  player: { streamInfo: StreamInfo; loudnessNormalizer?: boolean },
  volume: number = 1.0,
  audioMixer: AudioMixer | null = null,
  returnPCM: boolean = false,
  enableAGC: boolean = true,
  enableCrossfade: boolean = false
): Promise<StreamAudioResource | ErrorResponse> => {
  try {
    const hinted = String(player.streamInfo?.format ?? '').toLowerCase()
    const ext = _extFromUrl(url)
    const containerGuess = hinted || ext
    const seekProxy = _extractSeekProxy(player.streamInfo)

    logger(
      'debug',
      'StreamProcessor',
      `createSeekeableAudioResource called for ${url} | seekTime: ${seekTime}ms | containerGuess: ${containerGuess}`
    )

    if (_isMp4Format(containerGuess)) {
      const mp4Seek = await _buildMp4SeekOptions(url, seekTime, seekProxy)

      const ranged = await _openRangeStream(
        url,
        mp4Seek.baseFileStart ?? 0,
        seekProxy
      )

      const passthroughStream = new PassThrough({
        highWaterMark: AUDIO_CONFIG.highWaterMark
      })

      ;(
        passthroughStream as unknown as {
          __mp4SeekOptions?: MP4ToAACStreamOptions
        }
      ).__mp4SeekOptions = mp4Seek

      passthroughStream.once('finish', () => {
        passthroughStream.emit('finishBuffering')
      })

      pipeline(
        ranged,
        passthroughStream,
        (err: NodeJS.ErrnoException | null) => {
          if (err) passthroughStream.emit('error', err)
        }
      )

      const format = hinted || (ext ? ext : 'm4a')

      return new StreamAudioResource(
        guildId,
        passthroughStream,
        format,
        nodelink,
        initialFilters,
        volume,
        audioMixer,
        returnPCM,
        returnPCM ? true : (player.loudnessNormalizer ?? enableAGC),
        enableCrossfade
      )
    }

    const { stream, meta } = (await seekableStream(
      url,
      seekTime,
      endTime,
      {},
      _createSeekableProxyRequest(seekProxy)
    )) as { stream: Readable; meta: SeekableStreamMeta }

    const passthroughStream = new PassThrough({
      highWaterMark: AUDIO_CONFIG.highWaterMark
    })

    passthroughStream.once('finish', () => {
      passthroughStream.emit('finishBuffering')
    })

    pipeline(stream, passthroughStream, (err: NodeJS.ErrnoException | null) => {
      if (err) passthroughStream.emit('error', err)
    })

    const format = meta.codec?.container || player.streamInfo?.format

    return new StreamAudioResource(
      guildId,
      passthroughStream,
      format as string,
      nodelink,
      initialFilters,
      volume,
      audioMixer,
      returnPCM,
      returnPCM ? true : (player.loudnessNormalizer ?? enableAGC),
      enableCrossfade
    )
  } catch (err) {
    const cause = err instanceof SeekError ? err.code : 'UNKNOWN'
    return _createErrorResponse((err as Error).message, cause)
  }
}

export const createPCMStream = (
  _guildId: string,
  stream: Readable,
  type: string,
  nodelink: NodeLink,
  volume: number = 1.0,
  filters: FiltersState = {}
): Transform => {
  const resamplingQuality =
    nodelink.options.playback.audio?.resamplingQuality || 'fastest'
  const normalizedType = normalizeFormat(type)

  const streams: (Readable | Transform)[] = [stream]

  switch (normalizedType) {
    case SupportedFormats.AAC: {
      const lowerType = type.toLowerCase()
      const state = { isAlac: false }

      if (_isFmp4Format(lowerType)) {
        const bufferMode = lowerType.includes('fmp4-buffered')
        streams.push(new FMP4ToAACStream({ bufferMode }))
      } else if (_isMpegtsFormat(lowerType)) {
        streams.push(new MPEGTSDemuxer())

        if (lowerType.includes('mp3') || lowerType.includes('mpeg')) {
          streams.push(
            new SymphoniaDecoderStream({
              codecRegistryHint: _getSymphoniaCodecHint(lowerType)
            })
          )
          break
        }
      } else if (_isMp4Format(lowerType))
        streams.push(new MP4ToAACStream({ state }))

      streams.push(
        new AACDecoderStream({
          resamplingQuality: resamplingQuality as ResamplingQuality,
          state
        })
      )
      break
    }

    case SupportedFormats.FLV: {
      streams.push(new FLVToAACStream())
      streams.push(
        new AACDecoderStream({
          resamplingQuality: resamplingQuality as ResamplingQuality
        })
      )
      break
    }

    case SupportedFormats.MPEG:
    case SupportedFormats.FLAC:
    case SupportedFormats.OGG_VORBIS:
    case SupportedFormats.WAV:
    case SupportedFormats.ALAC: {
      streams.push(
        new SymphoniaDecoderStream({
          codecRegistryHint: _getSymphoniaCodecHint(type)
        })
      )
      break
    }

    case SupportedFormats.OPUS: {
      if (_isWebmFormat(type.toLowerCase())) {
        streams.push(new WebmOpusDemuxer())
      }
      streams.push(
        new OpusDecoder({
          rate: AUDIO_CONFIG.sampleRate,
          channels: AUDIO_CONFIG.channels
        })
      )
      break
    }

    default:
      throw new Error(`Unsupported audio format: '${type}'`)
  }

  streams.push(new VolumeTransformer({ type: 's16le', volume }))
  streams.push(new FiltersManager(nodelink, filters))

  for (const s of streams) {
    if (s !== stream) {
      ;(s as Transform).on('error', (err: Error & { code?: string }) =>
        logger(
          'error',
          'PCMStream',
          `Component error (${s.constructor.name}): ${err.message} (${err.code})`
        )
      )
    }
  }

  pipeline(streams, (err: NodeJS.ErrnoException | null) => {
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      logger(
        'error',
        'PCMStream',
        `Internal processing pipeline failed: ${err.message}`
      )
    }
  })

  return streams[streams.length - 1] as Transform
}
