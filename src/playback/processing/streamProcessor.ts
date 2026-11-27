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
import symphonia, { SymphoniaDecoder } from '@toddynnn/symphonia-decoder'
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
  Mp4Atom,
  MpegtsConfig,
  PendingChunk,
  ResamplingQuality,
  RingBufferLike,
  SeekableStreamMeta,
  SymphoniaDecoderLike,
  SymphoniaDecoderStreamOptions
} from '../../typings/playback/streamProcessor.types.ts'
import { http1makeRequest, logger } from '../../utils.ts'
import FlvDemuxer from '../demuxers/Flv.ts'
import WebmOpusDemuxer, {
  type WebmOpusPacketTiming
} from '../demuxers/WebmOpus.ts'
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
import { MusicAnalysis } from './MusicAnalysis.ts'
import {
  assertAudioCapabilities,
  resolveAudioProcessingMode,
  type AudioProcessingMode
} from './audioContract.ts'
import {
  ProtectedLimiterOutput,
  ProtectedPcmInput
} from './ProtectedAudioTransforms.ts'
import { createAudioRangeReader } from './mp4Ranges.ts'

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

const EMPTY_BUFFER: Buffer = Buffer.alloc(0)

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
const _extFromUrl = (url: string): string => {
  try {
    const p = new URL(url).pathname
    const m = p.match(/\.([a-z0-9]+)$/i)
    return (m?.[1] ?? '').toLowerCase()
  } catch {
    return ''
  }
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

const SAMPLE_RATES: readonly number[] = Object.freeze([
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
  8000, 7350
])

/**
 * Reads the core sample rate from AAC AudioSpecificConfig.
 * @internal
 * @param data - Codec configuration from the container.
 * @returns The core sample rate in Hz, or null when absent.
 */
const parseAacSampleRate = (data: Uint8Array): number | null => {
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

export const createAdtsHeader = (
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

/**
 * Reads the parameters needed to wrap native MP4 AAC packets in ADTS.
 * @internal
 * @param config - AudioSpecificConfig from MP4.
 * @param sampleRate - Track sample rate when the config omits it.
 * @param channels - Audio channel count.
 * @returns The ADTS configuration for the track.
 */
export function getMp4AacConfig(
  config: Buffer,
  sampleRate: number | null,
  channels: number | null
): AACConfig {
  const objectType = (config[0] ?? 0) >> 3
  const coreRate = parseAacSampleRate(config) ?? sampleRate
  const samplingIndex = coreRate === null ? -1 : SAMPLE_RATES.indexOf(coreRate)
  if (samplingIndex === -1 || !channels || objectType === 0)
    throw new Error('Unsupported MP4 AAC configuration')

  /* INFO: FAAD2 detects SBR and PS in the AAC payload. */
  return {
    profile: objectType === 5 || objectType === 29 ? 2 : objectType,
    samplingIndex,
    channelCount: channels
  }
}

type Mp4Reader = Awaited<ReturnType<typeof symphonia.openMp4Audio>>
type Mp4Audio = { stream: Readable; type: 'pcm' }

/**
 * Opens MP4 audio over HTTP Range without buffering the complete container.
 * @internal
 * @param url - URL of the MP4 object.
 * @param proxy - Proxy used to resolve the playback URL.
 * @param seekSeconds - Initial playback position in seconds.
 * @param refresh - Resolves another URL for the same MP4 after a transient HTTP error.
 * @param resamplingQuality - Quality used to resample decoded AAC.
 * @param abortSignal - Cancellation signal for direct HTTP playback.
 * @returns 48 kHz stereo PCM, or null when the server ignores Range.
 */
export async function openMp4HttpAudio(
  url: string,
  proxy?: HttpProxyConfig,
  seekSeconds = 0,
  refresh?: () => Promise<{ url: string; proxy?: HttpProxyConfig }>,
  resamplingQuality = 'fastest',
  abortSignal?: AbortSignal
): Promise<Mp4Audio | null> {
  const controller = new AbortController()
  const signal = abortSignal
    ? AbortSignal.any([controller.signal, abortSignal])
    : controller.signal
  let totalBytes = 0
  let activeResponse: Readable | undefined
  let cachedRange: { offset: number; bytes: Buffer } | undefined
  let readAudio: ReturnType<typeof createAudioRangeReader> | undefined
  const readRange = async (start: number, end: number): Promise<Buffer> => {
    signal.throwIfAborted()
    const headers = {
      Range: `bytes=${start}-${end}`,
      'Accept-Encoding': 'identity'
    }
    const request = () =>
      proxy
        ? http1makeRequest(url, {
            method: 'GET',
            headers,
            streamOnly: true,
            proxy,
            timeout: 20000
          })
        : fetch(url, {
            headers,
            signal: AbortSignal.any([signal, AbortSignal.timeout(20000)])
          }).then((result) => ({
            statusCode: result.status,
            headers: {
              'content-range': result.headers.get('content-range') ?? undefined
            },
            stream: result.body
              ? Readable.fromWeb(result.body as never)
              : undefined
          }))
    let response = await request()
    if (
      refresh &&
      !signal.aborted &&
      (response.statusCode === 403 ||
        response.statusCode === 404 ||
        (response.statusCode ?? 0) >= 500)
    ) {
      ;(response.stream as Readable | undefined)?.destroy()
      const replacement = await refresh()
      signal.throwIfAborted()
      url = replacement.url
      proxy = replacement.proxy
      response = await request()
    }
    const body = response.stream as Readable | undefined
    if (signal.aborted) {
      body?.destroy()
      signal.throwIfAborted()
    }
    if (totalBytes === 0 && response.statusCode === 200) {
      /* INFO: The source ignored the initial Range. Leave it to the sequential path. */
      body?.destroy()
      return Buffer.alloc(0)
    }
    const contentRange = String(response.headers?.['content-range'] ?? '')
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange)
    if (
      response.statusCode !== 206 ||
      !body ||
      !match ||
      Number(match[1]) !== start ||
      Number(match[2]) !== end ||
      !Number.isSafeInteger(Number(match[3])) ||
      Number(match[3]) <= end ||
      (totalBytes && totalBytes !== Number(match[3]))
    ) {
      body?.destroy()
      throw new Error(
        `Invalid MP4 HTTP Range response (${response.statusCode ?? 0})`
      )
    }
    totalBytes = Number(match[3])
    const bytes = Buffer.allocUnsafe(end - start + 1)
    let written = 0
    activeResponse = body
    try {
      for await (const chunk of body as AsyncIterable<Buffer>) {
        if (chunk.length > bytes.length - written)
          throw new Error('Oversized MP4 range')
        written += chunk.copy(bytes, written)
      }
      if (written !== bytes.length) throw new Error('Incomplete MP4 range')
      return bytes
    } finally {
      activeResponse = undefined
      body.destroy()
    }
  }

  await readRange(0, 0)
  if (!totalBytes) return null
  const reader = await symphonia.openMp4Audio(
    totalBytes,
    async (error, [start, length]) => {
      if (error) throw error
      if (abortSignal && length > 4 * 1024 * 1024)
        throw new Error('MP4 read exceeds the 4 MiB HTTP Range limit')
      if (readAudio) {
        const audio = await readAudio(start, length)
        if (audio) return audio
      }
      if (
        cachedRange &&
        start >= cachedRange.offset &&
        start + length <= cachedRange.offset + cachedRange.bytes.length
      ) {
        const offset = start - cachedRange.offset
        return cachedRange.bytes.subarray(offset, offset + length)
      }
      const end = Math.min(totalBytes, start + Math.max(length, 128 * 1024)) - 1
      const bytes = await readRange(start, end)
      cachedRange = { offset: start, bytes }
      return bytes.subarray(0, length)
    },
    seekSeconds
  )
  const indexedReader: Mp4Reader & {
    audioRanges?: Array<{ start: number; length: number }>
  } = reader
  const ranges = abortSignal && !proxy ? indexedReader.audioRanges : undefined
  if (ranges?.length)
    readAudio = createAudioRangeReader(url, ranges, totalBytes, signal)
  return createMp4Audio(reader, resamplingQuality, () => {
    controller.abort()
    activeResponse?.destroy()
    cachedRange = undefined
    readAudio = undefined
  })
}

/**
 * Opens an MP4 stream, using HTTP Range if media precedes its index.
 * @internal
 * @param input - The original MP4 byte stream.
 * @param resamplingQuality - Quality used to resample decoded AAC.
 * @param signal - Cancellation signal for the decoder.
 * @param directHttpUrl - Direct HTTP source available for random access.
 * @returns 48 kHz stereo PCM.
 */
async function openMp4StreamAudio(
  input: Readable,
  resamplingQuality: string,
  signal: AbortSignal,
  directHttpUrl?: string
): Promise<Mp4Audio> {
  const source = input.iterator()
  const prefix: Buffer[] = []
  let pending: Buffer = Buffer.alloc(0)
  async function read(length: number): Promise<Buffer> {
    const output = Buffer.allocUnsafe(length)
    let written = 0
    while (written < length) {
      if (!pending.length) {
        const { value, done } = await source.next()
        if (done) break
        pending = Buffer.isBuffer(value) ? value : Buffer.from(value)
      }
      const count = pending.copy(output, written, 0, length - written)
      written += count
      pending = pending.subarray(count)
    }
    return output.subarray(0, written)
  }

  try {
    let remainingPrefixBytes = 4 * 1024 * 1024
    /* INFO: The tail index can point to bytes already read from the stream. */
    while (true) {
      const header = await read(8)
      prefix.push(header)
      if (header.length < 8) break
      const type = header.toString('ascii', 4, 8)
      if (type === 'moov') break
      if (type === 'mdat' || type === 'moof') {
        input.destroy()
        if (directHttpUrl) {
          const audio = await openMp4HttpAudio(
            directHttpUrl,
            undefined,
            0,
            undefined,
            resamplingQuality,
            signal
          )
          if (audio) return audio
        }
        throw new Error(
          'MP4 with media before moov requires HTTP Range support'
        )
      }
      let size = header.readUInt32BE(0)
      let headerBytes = header.length
      if (size === 1) {
        const extended = await read(8)
        if (extended.length !== 8) throw new Error('Incomplete MP4 atom')
        prefix.push(extended)
        size = Number(extended.readBigUInt64BE(0))
        headerBytes += extended.length
      }
      if (size > remainingPrefixBytes)
        throw new Error('MP4 metadata exceeds the sequential probe limit')
      if (size < headerBytes) throw new Error('Invalid MP4 atom size')
      const body = await read(size - headerBytes)
      prefix.push(body)
      remainingPrefixBytes -= size
      if (body.length !== size - headerBytes) break
    }

    let replay: Buffer = Buffer.concat(prefix)
    prefix.length = 0
    const reader = await symphonia.openMp4Audio(
      null,
      async (error, [, length]) => {
        if (error) throw error
        const buffered = replay.subarray(0, length)
        replay = replay.subarray(buffered.length)
        if (buffered.length === length) return buffered
        const rest = await read(length - buffered.length)
        return buffered.length ? Buffer.concat([buffered, rest]) : rest
      }
    )
    return await createMp4Audio(reader, resamplingQuality, () => {
      pending = Buffer.alloc(0)
      input.destroy()
    })
  } catch (error) {
    input.destroy()
    throw error
  }
}

async function createMp4Audio(
  reader: Mp4Reader,
  resamplingQuality: string,
  cancel: () => void
): Promise<Mp4Audio> {
  const codec = reader.codec
  let decoder: Transform | undefined
  try {
    if (codec === 'aac') {
      decoder = new AACDecoderStream(
        { resamplingQuality: resamplingQuality as ResamplingQuality },
        reader.config
      )
    } else if (codec === 'opus') {
      decoder = new OpusDecoder()
    }
  } catch (error) {
    cancel()
    await reader.close().catch(logCloseError)
    throw error
  }

  const stream = Readable.from(
    (async function* () {
      if (codec === 'alac') {
        for (
          let pcm = await reader.readPcm();
          pcm;
          pcm = await reader.readPcm()
        )
          yield pcm
        return
      }
      while (true) {
        const packets = await reader.readPackets(32)
        if (!packets.length) break
        for (const { data } of packets) yield data
      }
    })(),
    { objectMode: false, highWaterMark: AUDIO_CONFIG.highWaterMark }
  )
  const destroy = stream.destroy.bind(stream)
  stream.destroy = (error?: Error) => {
    if (!stream.destroyed) cancel()
    return destroy(error)
  }
  stream.once('close', () => {
    void reader.close().catch(logCloseError)
  })
  const audio = decoder ? pipeline(stream, decoder, () => {}) : stream
  audio.once('end', () => audio.emit('finishBuffering'))
  return { stream: audio, type: 'pcm' }
}

function logCloseError(error: unknown): void {
  logger('error', 'MP4', error instanceof Error ? error.message : String(error))
}

function decodeMp4Stream(
  input: Readable,
  resamplingQuality: string,
  directHttpUrl?: string
): Transform {
  const controller = new AbortController()
  const output = pipeline(
    async function* () {
      const { stream } = await openMp4StreamAudio(
        input,
        resamplingQuality,
        controller.signal,
        directHttpUrl
      )
      try {
        yield* stream
      } finally {
        stream.destroy()
      }
    },
    new PassThrough(),
    () => {}
  )
  output.once('close', () => {
    controller.abort()
    input.destroy()
  })
  return output
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

  constructor(
    sampleRate = 48000,
    channels = 2,
    sampleFormat: 's16le' | 'f32le' = 's16le'
  ) {
    super()
    this.sampleRate = sampleRate
    this.bytesPerFrame = channels * (sampleFormat === 'f32le' ? 4 : 2)
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

/**
 * Emits 'error' on a pipeline stream only when it can be received.
 * Emitting with zero 'error' listeners throws, which escapes as an uncaught
 * exception and kills the worker, so teardown races must never emit blindly.
 */
export const emitResourceError = (
  target:
    | {
        destroyed?: boolean
        listenerCount?: (event: string) => number
        emit?: (event: string, error: unknown) => boolean
      }
    | null
    | undefined,
  error: unknown
): void => {
  if (!target || !error) return
  try {
    if (target.destroyed) return
    if (
      typeof target.listenerCount === 'function' &&
      target.listenerCount('error') === 0
    )
      return
    target.emit?.('error', error)
  } catch {}
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
        getMusicAnalysis?: () =>
          | import('./MusicAnalysis.ts').MusicAnalysisSnapshot
          | null
        isSilent?: () => boolean
        setFadeVolume?: (volume: number) => void
        fadeTo?: (volume: number, durationMs: number, curve?: string) => void
        tapeTo?: (
          durationMs: number,
          type: 'start' | 'stop',
          curve?: string
        ) => void
        setLoudnessNormalizer?: (enabled: boolean) => void
        getAudioProcessingTelemetry?: () =>
          | import('./audioContract.ts').AudioProcessingTelemetrySnapshot
          | null
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
    voiceStream.getMusicAnalysis = () => this.getMusicAnalysis()
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
    voiceStream.getAudioProcessingTelemetry = () =>
      this.getAudioProcessingTelemetry()
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
        resume?: () => void
        abort?: () => void
        unpipe?: () => void
        cleanup?: () => void
        destroy?: () => void
      }
      pipe.resume?.()
      pipe.abort?.()
      pipe.unpipe?.()
      pipe.cleanup?.()
      // Keep pipeline listeners for pending error and close events.
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

  getMusicAnalysis():
    | import('./MusicAnalysis.ts').MusicAnalysisSnapshot
    | null {
    const observer = this.pipes?.find((pipe) => pipe instanceof MusicAnalysis)
    return observer instanceof MusicAnalysis ? observer.snapshot() : null
  }

  getRMS(): number {
    if (!this.pipes) return 0
    const silenceDetector = this.pipes.find(
      (p) => p instanceof SilenceDetector
    ) as SilenceDetector | undefined
    return silenceDetector?.getRMS() ?? 0
  }

  getAudioProcessingTelemetry():
    | import('./audioContract.ts').AudioProcessingTelemetrySnapshot
    | null {
    return null
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
  private transformCallback: TransformCallback | null
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
    this.transformCallback = null
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

  cleanup(): void {
    this._cleanup()
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
      if (
        this.decoder.isProbed &&
        this.decoder.bufferedBytes >= BUFFER_THRESHOLDS.maxCompressed
      ) {
        this.transformCallback = callback
      } else {
        callback()
      }
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
      if (
        this.transformCallback &&
        this.decoder &&
        this.decoder.bufferedBytes < BUFFER_THRESHOLDS.minCompressed
      ) {
        const callback = this.transformCallback
        this.transformCallback = null
        callback()
      }
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
    const callback = this.flushCallback ?? this.transformCallback
    this.flushCallback = null
    this.transformCallback = null
    this.isFinished = true
    this._cleanup()

    const error =
      err instanceof Error ? err : new Error(`Symphonia decode failed: ${err}`)
    if (callback) {
      callback(error)
    } else {
      emitResourceError(this, error)
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

    this._cleanup(err)
    super._destroy(err, callback)
  }

  _cleanup(error?: Error | null): void {
    this._cancelTimers()

    if (this.decoder) {
      try {
        this.decoder.free()
      } catch {}
      this.decoder = null
    }
    if (this.transformCallback) {
      const callback = this.transformCallback
      this.transformCallback = null
      callback(error)
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
  private decoder: FAAD2DecoderLike | null
  private pcmConverter: {
    rate: number
    native: InstanceType<typeof symphonia.PcmResampler>
  } | null
  private isDecoderReady: boolean
  private configuring: Promise<unknown> | null = null
  private isConfigured: boolean
  private pendingChunk: PendingChunk | null = null
  private readonly ringBuffer: RingBufferLike | null
  private resamplingQuality: string

  constructor(options: AACDecoderStreamOptions, audioSpecificConfig?: Buffer) {
    super({
      ...options,
      highWaterMark: AUDIO_CONFIG.highWaterMark
    })
    this.decoder = new FAAD2NodeDecoder() as unknown as FAAD2DecoderLike
    this.pcmConverter = null
    this.isDecoderReady = false
    this.isConfigured = false
    this.ringBuffer = audioSpecificConfig
      ? null
      : (new RingBuffer(AAC_BUFFER_SIZE) as unknown as RingBufferLike)
    this.resamplingQuality = options.resamplingQuality || 'fastest'

    const decoder = this.decoder
    /* INFO: MP4 already supplies the config and packet boundaries. */
    const ready = audioSpecificConfig
      ? decoder.ready.then(() => {
          if (this.decoder === decoder)
            return decoder.configure(audioSpecificConfig, false)
        })
      : decoder.ready
    ready
      .then(() => {
        if (this.decoder !== decoder) {
          this._releaseDecoder(decoder)
          return
        }
        this.isDecoderReady = true
        const pending = this.pendingChunk
        this.pendingChunk = null
        if (pending) return this._decodeChunk(pending.chunk, pending.callback)
      })
      .catch((error: Error) => {
        if (!this.isDecoderReady) this._releaseDecoder(decoder)
        if (this.decoder === decoder) this.destroy(error)
      })
  }

  private _releaseDecoder(decoder: FAAD2DecoderLike): void {
    try {
      decoder.free?.()
    } catch {}
    try {
      decoder.destroy?.()
    } catch {}
  }

  private cleanup(): void {
    this.ringBuffer?.dispose()
    const decoder = this.decoder
    this.decoder = null
    if (decoder && this.isDecoderReady) {
      if (this.configuring) {
        void this.configuring.then(
          () => this._releaseDecoder(decoder),
          () => this._releaseDecoder(decoder)
        )
      } else {
        this._releaseDecoder(decoder)
      }
    }
    const pending = this.pendingChunk
    this.pendingChunk = null
    pending?.callback()
    this.pcmConverter?.native.close()
    this.pcmConverter = null
  }

  override _destroy(
    err: Error | null,
    cb: (error?: Error | null) => void
  ): void {
    this.cleanup()
    super._destroy(err, cb)
  }

  _findADTSFrame(ringBuffer: RingBufferLike): ADTSFrameInfo | null {
    const buffer = ringBuffer.peek(ringBuffer.length)
    if (!buffer) return null

    for (let offset = 0; offset + 7 <= buffer.length; offset++) {
      const flags = buffer[offset + 1] ?? 0
      const samplingIndex = ((buffer[offset + 2] ?? 0) >> 2) & 0x0f
      if (
        buffer[offset] !== 0xff ||
        (flags & 0xf0) !== 0xf0 ||
        (flags & 0x06) !== 0 ||
        samplingIndex >= 13
      ) {
        continue
      }

      const headerLength = (flags & 1) === 0 ? 9 : 7
      const frameLength =
        (((buffer[offset + 3] ?? 0) & 0x03) << 11) |
        ((buffer[offset + 4] ?? 0) << 3) |
        (((buffer[offset + 5] ?? 0) >> 5) & 0x07)
      if (frameLength <= headerLength) continue

      // Wait for the rest of this frame instead of scanning its payload.
      if (offset + frameLength > buffer.length) {
        ringBuffer.skip(offset)
        return null
      }

      return {
        start: offset,
        end: offset + frameLength,
        frame: buffer.subarray(offset, offset + frameLength)
      }
    }

    // Retain a partial header for the next chunk.
    ringBuffer.skip(Math.max(0, buffer.length - 6))
    return null
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    if (!this.isDecoderReady) {
      /* INFO: Transform waits for this callback before handing over another chunk. */
      this.pendingChunk = { chunk, callback }
      return
    }

    void this._decodeChunk(chunk, callback)
  }

  async _decodeChunk(
    chunk: Buffer,
    callback: TransformCallback
  ): Promise<void> {
    const decoder = this.decoder
    if (!decoder) return callback()
    try {
      const ringBuffer = this.ringBuffer
      if (!ringBuffer) {
        this._decodeFrame(decoder, chunk)
        return callback()
      }
      ringBuffer.write(chunk)

      while (ringBuffer.length > 7) {
        const frameInfo = this._findADTSFrame(ringBuffer)
        if (!frameInfo) break

        const adtsFrame = frameInfo.frame

        if (!this.isConfigured) {
          try {
            this.configuring = decoder.configure(adtsFrame)
            await this.configuring
          } finally {
            this.configuring = null
          }
          if (this.decoder !== decoder) return callback()
          this.isConfigured = true
        }

        this._decodeFrame(decoder, adtsFrame)
        ringBuffer.skip(frameInfo.end)
      }

      callback()
    } catch (err) {
      callback(this.destroyed ? undefined : (err as Error))
    }
  }

  private _decodeFrame(decoder: FAAD2DecoderLike, frame: Buffer): void {
    let result: ReturnType<FAAD2DecoderLike['decode']>
    try {
      result = decoder.decode(frame)
    } catch {
      return
    }
    if (!result?.pcm?.length) return
    const { pcm, sampleRate, channels } = result
    if (this.pcmConverter?.rate !== sampleRate) {
      this._finishPcm()
      this.pcmConverter = {
        rate: sampleRate,
        native: new symphonia.PcmResampler(sampleRate, this.resamplingQuality)
      }
    }
    const output = this.pcmConverter.native.process(pcm, channels)
    if (output.length) this.push(output)
  }

  private _finishPcm(): void {
    const converter = this.pcmConverter
    if (!converter) return
    this.pcmConverter = null
    try {
      const output = converter.native.finish()
      if (output.length) this.push(output)
    } finally {
      converter.native.close()
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      this._finishPcm()
    } catch (error) {
      callback(error as Error)
      return
    }
    callback()
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

  _parseBoxes(buffer: Buffer, offset = 0): Mp4Atom[] {
    const boxes: Mp4Atom[] = []
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
      if (!this._aborted) emitResourceError(this, err)
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
        const adtsHeader = createAdtsHeader(
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

class WebmOpusSeekTrimTransform extends Transform {
  private readonly targetSampleFrame: number
  private readonly endSampleFrame: number | null
  private timings: WebmOpusPacketTiming[]
  private timingIndex: number
  private nextOutputSampleFrame: number

  constructor(targetTimeMs = 0, endTimeMs?: number | null) {
    super({ readableObjectMode: false })
    this.targetSampleFrame = Math.max(0, Math.round(targetTimeMs * 48))
    this.endSampleFrame =
      typeof endTimeMs === 'number' &&
      Number.isFinite(endTimeMs) &&
      endTimeMs > 0
        ? Math.floor(endTimeMs * 48)
        : null
    this.timings = []
    this.timingIndex = 0
    this.nextOutputSampleFrame = this.targetSampleFrame
  }

  enqueueTiming(timing: WebmOpusPacketTiming): void {
    this.timings.push(timing)
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    if (chunk.length % 4 !== 0) {
      callback(
        new Error(
          `Invalid WebM Opus PCM chunk alignment (${chunk.length} bytes; expected stereo S16LE)`
        )
      )
      return
    }

    const timing = this.timings[this.timingIndex]
    if (!timing) {
      callback(new Error('Missing WebM packet timestamp for decoded Opus PCM'))
      return
    }
    if (!Number.isFinite(timing.timestampMs)) {
      callback(new Error('Invalid WebM packet timestamp for decoded Opus PCM'))
      return
    }
    this.timingIndex++

    const packetStartSample = Math.round(timing.timestampMs * 48)
    const packetEndSample = packetStartSample + chunk.length / 4
    const clippedStartSample = Math.max(
      packetStartSample,
      this.targetSampleFrame
    )
    const clippedEndSample =
      this.endSampleFrame === null
        ? packetEndSample
        : Math.min(packetEndSample, this.endSampleFrame)

    // Only fill gaps between packets. Never pad the tail: a missing final
    // packet must remain visible as an early EOF instead of being hidden.
    if (clippedEndSample > clippedStartSample) {
      let gapFrames = Math.max(
        0,
        clippedStartSample - this.nextOutputSampleFrame
      )
      while (gapFrames > 0) {
        const frames = Math.min(gapFrames, AUDIO_CONFIG.sampleRate)
        this.push(Buffer.alloc(frames * 4))
        this.nextOutputSampleFrame += frames
        gapFrames -= frames
      }

      const outputStartSample = Math.max(
        clippedStartSample,
        this.nextOutputSampleFrame
      )
      const outputEndSample = Math.max(outputStartSample, clippedEndSample)
      const framesToKeep = outputEndSample - outputStartSample

      if (framesToKeep > 0) {
        const framesToSkip = outputStartSample - packetStartSample
        const byteStart = framesToSkip * 4
        const byteEnd = byteStart + framesToKeep * 4
        this.push(chunk.subarray(byteStart, byteEnd))
        this.nextOutputSampleFrame = outputEndSample
      }
    }

    if (this.timingIndex > 2048) {
      this.timings = this.timings.slice(this.timingIndex)
      this.timingIndex = 0
    }

    callback()
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void
  ): void {
    this.timings = []
    this.timingIndex = 0
    this.nextOutputSampleFrame = this.targetSampleFrame
    callback(error)
  }
}

class StreamAudioResource extends BaseAudioResource {
  private nodelink: NodeLink
  private frameCounter: PCMFrameCounter | null = null
  private protectedLimiterOutput: ProtectedLimiterOutput | null = null
  private readonly webmSeekTimeMs: number | null
  readonly sourceDurationMs: number | null

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
    enableCrossfade = false,
    processingMode?: AudioProcessingMode | null,
    float32PCMOutput = false,
    directHttpUrl?: string,
    webmSeekTimeMs?: number | null,
    sourceDurationMs?: number | null
  ) {
    super(guildId)

    this.nodelink = nodelink
    this.webmSeekTimeMs =
      typeof webmSeekTimeMs === 'number' &&
      Number.isFinite(webmSeekTimeMs) &&
      webmSeekTimeMs > 0
        ? webmSeekTimeMs
        : null
    this.sourceDurationMs =
      typeof sourceDurationMs === 'number' &&
      Number.isFinite(sourceDurationMs) &&
      sourceDurationMs > 0
        ? sourceDurationMs
        : null
    const mode = resolveAudioProcessingMode(
      nodelink.options.playback.audio?.processingMode,
      processingMode
    )
    const preparedProtectedInterceptors: Transform[] = []
    if (!returnPCM && mode === 'protected') {
      // Validate filter capabilities before starting decoder streams. The real
      // manager is then constructed below as the resource-owned instance.
      new FiltersManager(nodelink, initialFilters, {}, 'protected')
      for (const factory of nodelink.extensions?.audioInterceptors ?? []) {
        const caps = factory.audioCapabilities
        if (
          !caps?.sampleFormats.includes('f32le') ||
          caps.amplitudeBehavior !== 'preserves-headroom'
        ) {
          throw new Error(
            'Protected mode requires every audio interceptor to declare f32le support and headroom preservation'
          )
        }
        assertAudioCapabilities(caps)
        const interceptor = factory()
        if (interceptor) preparedProtectedInterceptors.push(interceptor)
      }
    }
    this._validateInputStream(stream)

    const resamplingQuality =
      nodelink.options.playback.audio?.resamplingQuality || 'fastest'
    /* INFO: Select AAC, ALAC or Opus from the MP4 track metadata. */
    const normalizedType = _isMp4Format(type.toLowerCase())
      ? SupportedFormats.AAC
      : normalizeFormat(type)

    this.pipes = [stream]

    const pcmStream = this._createDecoderPipeline(
      stream,
      type,
      normalizedType,
      resamplingQuality,
      directHttpUrl,
      this.webmSeekTimeMs,
      this.sourceDurationMs
    )

    if (returnPCM) {
      this._createPCMOutputPipeline(
        pcmStream,
        volume,
        enableAGC,
        float32PCMOutput && mode === 'protected'
      )
    } else {
      this._createOutputPipeline(
        pcmStream,
        nodelink as unknown as NodeLink,
        initialFilters,
        volume,
        audioMixer,
        enableAGC,
        enableCrossfade,
        mode,
        preparedProtectedInterceptors
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
    resamplingQuality: string,
    directHttpUrl?: string,
    webmSeekTimeMs?: number | null,
    webmDurationMs?: number | null
  ): Transform {
    if (type === 'pcm') return stream as Transform

    switch (normalizedType) {
      case SupportedFormats.AAC:
        return this._createAACPipeline(
          stream,
          type,
          resamplingQuality,
          directHttpUrl
        )

      case SupportedFormats.FLV:
        return this._createFLVPipeline(stream, type, resamplingQuality)

      case SupportedFormats.MPEG:
      case SupportedFormats.FLAC:
      case SupportedFormats.OGG_VORBIS:
      case SupportedFormats.WAV:
      case SupportedFormats.ALAC:
        return this._createSymphoniaPipeline(stream, type)

      case SupportedFormats.OPUS:
        return this._createOpusPipeline(
          stream,
          type,
          webmSeekTimeMs,
          webmDurationMs
        )

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
        emitResourceError(this.stream, err)
      }
    })

    return decoder
  }

  _createAACPipeline(
    stream: Readable,
    type: string,
    resamplingQuality: string,
    directHttpUrl?: string
  ): Transform {
    const lowerType = type.toLowerCase()
    const streams: (Readable | Transform)[] = [stream]

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
              emitResourceError(this.stream, err)
            }
          }
        )

        return decoder
      }
    } else if (_isMp4Format(lowerType)) {
      const output = decodeMp4Stream(stream, resamplingQuality, directHttpUrl)
      output.once('end', () => {
        if (!this._finishBufferingEmitted) this._forwardFinishBuffering?.()
      })
      this.pipes?.push(output)
      return output
    }

    const decoder = new AACDecoderStream({
      resamplingQuality: resamplingQuality as ResamplingQuality
    })
    streams.push(decoder)

    this.pipes?.push(...streams.slice(1))

    pipeline(streams as unknown as Readable[], (err: Error | null): void => {
      if (err && !this._destroyed) {
        emitResourceError(this.stream, err)
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
        emitResourceError(this.stream, err)
      }
    })

    return decoder
  }

  _createOpusPipeline(
    stream: Readable,
    type: string,
    seekTargetMs?: number | null,
    endTimeMs?: number | null
  ): Transform {
    if (!_isWebmFormat(type.toLowerCase())) {
      // Ogg Opus decodes natively in Symphonia (libopus adapter)
      // symphonia-adapter-libopus, only has the decoder.
      return this._createSymphoniaPipeline(stream, type)
    }

    const decoder = new OpusDecoder({
      rate: AUDIO_CONFIG.sampleRate,
      channels: AUDIO_CONFIG.channels
    })

    const streams: (Readable | Transform)[] = [stream]

    const demuxer = new WebmOpusDemuxer()
    streams.push(demuxer)
    this.pipes?.push(demuxer)

    streams.push(decoder)
    this.pipes?.push(decoder)

    const normalizedSeekTarget =
      typeof seekTargetMs === 'number' &&
      Number.isFinite(seekTargetMs) &&
      seekTargetMs > 0
        ? seekTargetMs
        : 0
    const hasFiniteEndTime =
      typeof endTimeMs === 'number' &&
      Number.isFinite(endTimeMs) &&
      endTimeMs > 0

    let output: Transform = decoder
    if (normalizedSeekTarget > 0 || hasFiniteEndTime) {
      const seekTrimmer = new WebmOpusSeekTrimTransform(
        normalizedSeekTarget,
        hasFiniteEndTime ? endTimeMs : null
      )
      demuxer.on('packetTimestamp', (timing: WebmOpusPacketTiming) => {
        seekTrimmer.enqueueTiming(timing)
      })
      streams.push(seekTrimmer)
      this.pipes?.push(seekTrimmer)
      output = seekTrimmer
    }

    pipeline(streams as unknown as Readable[], (err: Error | null): void => {
      if (err && !this._destroyed) {
        emitResourceError(this.stream, err)
      }
    })

    return output
  }

  _createOutputPipeline(
    pcmStream: Transform,
    nodelink: NodeLink,
    initialFilters: FiltersState,
    volume: number,
    audioMixer: AudioMixer | null = null,
    enableAGC = true,
    enableCrossfade = false,
    processingMode: AudioProcessingMode = 'legacy',
    preparedProtectedInterceptors: Transform[] = []
  ): void {
    const frameCounter = new PCMFrameCounter(
      AUDIO_CONFIG.sampleRate,
      AUDIO_CONFIG.channels,
      processingMode === 'protected' ? 'f32le' : 's16le'
    )
    this.frameCounter = frameCounter // Saves the reference to get the time later

    const filters = new FiltersManager(
      nodelink,
      initialFilters,
      {},
      processingMode
    )
    const volumeTransformer = new VolumeTransformer({
      type: 's16le',
      volume,
      enableAGC,
      lookaheadMs:
        processingMode === 'protected'
          ? 0
          : nodelink.options.playback.audio?.lookaheadMs,
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
      sampleFormat: processingMode === 'protected' ? 'f32le' : 's16le',
      thresholdDb:
        nodelink.options.playback.audio?.automix?.silenceThresholdDb ?? -40
    })

    const flowController = new FlowController(
      volumeTransformer,
      fadeTransformer,
      tapeTransformer,
      scratchTransformer,
      audioMixer,
      processingMode
    )

    const opusEncoder = new OpusEncoder({
      rate: AUDIO_CONFIG.sampleRate,
      channels: AUDIO_CONFIG.channels,
      complexity: nodelink.options.playback.audio?.opusComplexity
    })

    opusEncoder.setDTX(false)

    const streams: Transform[] = [pcmStream]
    if (processingMode === 'protected') {
      const protectedInput = new ProtectedPcmInput()
      streams.push(protectedInput)
      this.pipes?.push(protectedInput)
    }
    if (enableCrossfade) {
      const crossfadeController = new CrossfadeController(
        processingMode === 'protected' ? 'f32le' : 's16le'
      )
      if (processingMode === 'protected') {
        // A crossfade changes track identity while this output pipeline remains
        // alive. Reset AGC history at both overlap start and promotion so the
        // incoming song cannot inherit the previous song's gain estimate.
        crossfadeController.on('transitionStart', () =>
          volumeTransformer.resetAGC()
        )
      }
      crossfadeController.on('bridgeStart', () => {
        if (processingMode === 'protected') volumeTransformer.resetAGC()
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
    streams.push(frameCounter, silenceDetector, filters)
    this.pipes?.push(frameCounter, silenceDetector, filters)
    let protectedOutput: ProtectedLimiterOutput | null = null
    streams.push(flowController)
    this.pipes?.push(flowController)

    if (processingMode === 'protected') {
      for (const interceptorStream of preparedProtectedInterceptors) {
        streams.push(interceptorStream)
        this.pipes?.push(interceptorStream)
      }
    } else if (nodelink.extensions?.audioInterceptors) {
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

    if (processingMode === 'protected') {
      protectedOutput = new ProtectedLimiterOutput(() =>
        volumeTransformer.getRequestedVolume()
      )
      this.protectedLimiterOutput = protectedOutput
      streams.push(protectedOutput)
    }

    if (protectedOutput) this.pipes?.push(protectedOutput)
    if (nodelink.options.playback.audio?.musicAnalysis === true) {
      const observer = new MusicAnalysis()
      observer.once('analysisFailure', (error: unknown) => {
        logger(
          'warn',
          'MusicAnalysis',
          'Output analysis disabled for this resource',
          error
        )
      })
      streams.push(observer)
      this.pipes?.push(observer)
    }
    streams.push(opusEncoder)
    this.pipes?.push(opusEncoder)

    pipeline(streams as unknown as Readable[], (err: Error | null): void => {
      if (err && !this._destroyed) {
        emitResourceError(opusEncoder, err)
      }
    })

    this._assignStream(opusEncoder)
  }

  getConsumedMs(): number {
    return this.frameCounter?.getConsumedMs() ?? 0
  }

  override getAudioProcessingTelemetry() {
    return this.protectedLimiterOutput?.snapshot() ?? null
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
    enableAGC = true,
    float32Output = false
  ): void {
    if (float32Output) {
      const converter = new ProtectedPcmInput()
      pipeline(pcmStream, converter, (err: Error | null): void => {
        if (err && !this._destroyed) emitResourceError(converter, err)
      })
      this.pipes?.push(converter)
      this._assignStream(converter)
      return
    }
    if (volume !== 1.0 || enableAGC) {
      const volumeTransformer = new VolumeTransformer({
        type: 's16le',
        volume,
        enableAGC,
        lookaheadMs: this.nodelink?.options?.playback?.audio?.lookaheadMs,
        gateThresholdLUFS:
          this.nodelink?.options?.playback?.audio?.gateThresholdLUFS
      })

      pipeline(pcmStream, volumeTransformer, (err: Error | null): void => {
        if (err && !this._destroyed) {
          emitResourceError(volumeTransformer, err)
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
        if (this.stream !== inputStream) this.stream?.emit('finishBuffering')
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
      this.stream?.destroy(err)
    })

    if (this.pipes) {
      for (const pipe of this.pipes) {
        if (pipe !== this.stream) {
          pipe.on?.('error', (err: Error) => {
            this.stream?.destroy(err)
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
  enableCrossfade: boolean = false,
  processingMode?: AudioProcessingMode | null,
  float32PCMOutput = false,
  directHttpUrl?: string,
  webmSeekTimeMs?: number | null
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
    enableCrossfade,
    processingMode,
    float32PCMOutput,
    directHttpUrl,
    webmSeekTimeMs
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
  enableCrossfade: boolean = false,
  processingMode?: AudioProcessingMode | null
): Promise<StreamAudioResource | ErrorResponse> => {
  try {
    /* INFO: Source format objects describe a rendition, not a MIME type. */
    const hinted =
      typeof player.streamInfo?.format === 'string'
        ? player.streamInfo.format.toLowerCase()
        : ''
    const ext = _extFromUrl(url)
    const containerGuess = hinted || ext
    const seekProxy = _extractSeekProxy(player.streamInfo)

    logger(
      'debug',
      'StreamProcessor',
      `createSeekeableAudioResource called for ${url} | seekTime: ${seekTime}ms | containerGuess: ${containerGuess}`
    )

    if (_isMp4Format(containerGuess)) {
      const audio = await openMp4HttpAudio(
        url,
        seekProxy,
        seekTime / 1000,
        undefined,
        nodelink.options.playback.audio?.resamplingQuality || 'fastest'
      )
      if (audio) {
        try {
          return new StreamAudioResource(
            guildId,
            audio.stream,
            audio.type,
            nodelink,
            initialFilters,
            volume,
            audioMixer,
            returnPCM,
            player.loudnessNormalizer ?? enableAGC,
            enableCrossfade,
            processingMode
          )
        } catch (error) {
          audio.stream.destroy()
          throw error
        }
      }
      if (seekTime > 0)
        throw new Error('MP4 seek requires an HTTP Range source')
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
      if (err) emitResourceError(passthroughStream, err)
    })

    /*
      INFO: seekable-stream may omit codec metadata for MP4 but still
        report contentType. Extensionless URLs can also lack a format
        hint, so use that detected MIME type to select the decoder.
      SOURCES:
        - @ecliptia/seekable-stream/src/index.js
    */
    const format = meta.codec?.container || hinted || meta.contentType
    const durationMeta = meta as SeekableStreamMeta & {
      audioDurationMs?: number
      audioDurationSource?: string
    }
    const sourceDurationMs =
      _isWebmFormat(format.toLowerCase()) &&
      durationMeta.audioDurationSource === 'audio-packets' &&
      Number.isFinite(durationMeta.audioDurationMs) &&
      (durationMeta.audioDurationMs as number) > 0
        ? (durationMeta.audioDurationMs as number)
        : null

    return new StreamAudioResource(
      guildId,
      passthroughStream,
      format,
      nodelink,
      initialFilters,
      volume,
      audioMixer,
      returnPCM,
      player.loudnessNormalizer ?? enableAGC,
      enableCrossfade,
      processingMode,
      false,
      undefined,
      _isWebmFormat(format.toLowerCase()) ? seekTime : null,
      sourceDurationMs
    )
  } catch (err) {
    const cause = err instanceof SeekError ? err.code : 'UNKNOWN'
    return _createErrorResponse((err as Error).message, cause)
  }
}

function buildDecodeStageStreams(
  stream: Readable,
  type: string,
  resamplingQuality: string,
  directHttpUrl?: string
): (Readable | Transform)[] {
  /* INFO: Keep MP4 codec selection in the demuxer, as in playback. */
  const normalizedType = _isMp4Format(type.toLowerCase())
    ? SupportedFormats.AAC
    : normalizeFormat(type)

  const streams: (Readable | Transform)[] = [stream]

  switch (type === 'pcm' ? type : normalizedType) {
    case 'pcm':
      break

    case SupportedFormats.AAC: {
      const lowerType = type.toLowerCase()

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
      } else if (_isMp4Format(lowerType)) {
        streams[0] = decodeMp4Stream(stream, resamplingQuality, directHttpUrl)
        break
      }

      streams.push(
        new AACDecoderStream({
          resamplingQuality: resamplingQuality as ResamplingQuality
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
        streams.push(
          new OpusDecoder({
            rate: AUDIO_CONFIG.sampleRate,
            channels: AUDIO_CONFIG.channels
          })
        )
      } else {
        streams.push(
          new SymphoniaDecoderStream({
            codecRegistryHint: _getSymphoniaCodecHint(type)
          })
        )
      }
      break
    }

    default:
      throw new Error(`Unsupported audio format: '${type}'`)
  }

  return streams
}

/**
 * Strips container framing (`fmp4`, `mpegts`, `flv`) into an elementary audio
 * stream when supported, leaving elementary formats untouched.
 */
export const createDemuxedStream = (
  stream: Readable,
  type: string
): { stream: Readable; type: string } => {
  const lowerType = type.toLowerCase()
  let demuxer: Transform | null = null
  let outputType = type

  if (_isFmp4Format(lowerType)) {
    demuxer = new FMP4ToAACStream({
      bufferMode: lowerType.includes('fmp4-buffered')
    })
    outputType = 'aac'
  } else if (_isMpegtsFormat(lowerType)) {
    demuxer = new MPEGTSDemuxer()
    outputType =
      lowerType.includes('mp3') || lowerType.includes('mpeg') ? 'mpeg' : 'aac'
  } else if (normalizeFormat(type) === SupportedFormats.FLV) {
    demuxer = new FLVToAACStream()
    outputType = 'aac'
  }

  if (!demuxer) {
    return { stream, type }
  }

  demuxer.on('error', (err: Error & { code?: string }) =>
    logger(
      'error',
      'DemuxedStream',
      `Component error (${demuxer.constructor.name}): ${err.message} (${err.code})`
    )
  )

  pipeline([stream, demuxer], (err: NodeJS.ErrnoException | null) => {
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      logger(
        'error',
        'DemuxedStream',
        `Internal demux pipeline failed: ${err.message}`
      )
    }
  })

  return { stream: demuxer, type: outputType }
}

/**
 * Decodes an audio stream directly to 48kHz stereo PCM without applying
 * player-side volume or DSP filters.
 */
export const createDecodedPCMStream = (
  stream: Readable,
  type: string,
  nodelink: NodeLink,
  directHttpUrl?: string
): Readable => {
  const resamplingQuality =
    nodelink.options?.playback?.audio?.resamplingQuality || 'fastest'
  const streams = buildDecodeStageStreams(
    stream,
    type,
    resamplingQuality,
    directHttpUrl
  )
  if (streams.length === 1) {
    return streams[0] as Readable
  }

  for (const s of streams) {
    if (s !== stream) {
      ;(s as Transform).on('error', (err: Error & { code?: string }) =>
        logger(
          'error',
          'DecodedPCMStream',
          `Component error (${s.constructor.name}): ${err.message} (${err.code})`
        )
      )
    }
  }

  pipeline(streams, (err: NodeJS.ErrnoException | null) => {
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      logger(
        'error',
        'DecodedPCMStream',
        `Internal decode pipeline failed: ${err.message}`
      )
    }
  })

  return streams[streams.length - 1] as Transform
}

export const createPCMStream = (
  _guildId: string,
  stream: Readable,
  type: string,
  nodelink: NodeLink,
  volume: number = 1.0,
  filters: FiltersState = {},
  enableAGC: boolean = false,
  directHttpUrl?: string
): Transform => {
  const resamplingQuality =
    nodelink.options.playback.audio?.resamplingQuality || 'fastest'
  const streams = buildDecodeStageStreams(
    stream,
    type,
    resamplingQuality,
    directHttpUrl
  )

  streams.push(
    new VolumeTransformer({
      type: 's16le',
      volume,
      enableAGC,
      lookaheadMs: nodelink.options.playback.audio?.lookaheadMs,
      gateThresholdLUFS: nodelink.options.playback.audio?.gateThresholdLUFS
    })
  )
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
