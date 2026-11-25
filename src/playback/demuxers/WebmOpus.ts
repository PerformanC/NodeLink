import {
  Transform,
  type TransformCallback,
  type TransformOptions
} from 'node:stream'
import { logger } from '../../utils.ts'
import { RingBuffer } from '../structs/RingBuffer.ts'

const TOO_SHORT: unique symbol = Symbol('TOO_SHORT')
const INVALID_VINT: unique symbol = Symbol('INVALID_VINT')

const parsePositiveIntEnv = (key: string, fallback: number): number => {
  const raw = process.env[key]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const BUFFER_SIZE = parsePositiveIntEnv(
  'NODELINK_WEBM_DEMUX_RING_BYTES',
  512 * 1024
)

const TAGS: Readonly<Record<string, boolean>> = Object.freeze({
  '1a45dfa3': true, // EBML
  '18538067': true, // Segment
  '1549a966': true, // Info
  '1654ae6b': true, // Tracks
  ae: true, // TrackEntry
  '1f43b675': true, // Cluster
  a0: true, // BlockGroup
  '1c53bb6b': true, // Cues
  'bb': true, // CuePoint
  'b7': true, // CueTrackPositions
  '2ad7b1': false, // TimecodeScale
  '4489': false, // Duration
  d7: false, // TrackNumber
  '83': false, // TrackType
  '86': false, // CodecID
  '63a2': false, // CodecPrivate
  '56aa': false, // CodecDelay
  '56bb': false, // SeekPreRoll
  e7: false, // Cluster Timecode
  a3: false, // SimpleBlock
  a1: false, // Block
  '9b': false, // BlockDuration
  '75a2': false, // DiscardPadding
  f7: false, // CueTrack
  f1: false, // CueClusterPosition
  b3: false // CueTime
})

const OPUS_HEAD = Buffer.from([
  0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64
])
const MAX_TAG_SIZE = 10 * 1024 * 1024
const toTightBuffer = (buf: Buffer): Buffer => Buffer.from(buf)

type WebmTrackInfo = {
  number?: number
  type?: number
  codecId?: string
  codecDelayNs?: bigint
  seekPreRollNs?: bigint
}

export type WebmOpusPacketTiming = {
  timestampMs: number
  durationMs: number
}

type WebmOpusProfilerStats = {
  created: number
  destroyed: number
  active: number
  chunksIn: number
  bytesIn: number
  packetsOut: number
  packetBytesOut: number
  headPackets: number
  tooShortReads: number
  invalidVint: number
  skippedBytes: number
  ringPeakBytes: number
  maxTagBytesSeen: number
}

const webmOpusProfiler: WebmOpusProfilerStats = {
  created: 0,
  destroyed: 0,
  active: 0,
  chunksIn: 0,
  bytesIn: 0,
  packetsOut: 0,
  packetBytesOut: 0,
  headPackets: 0,
  tooShortReads: 0,
  invalidVint: 0,
  skippedBytes: 0,
  ringPeakBytes: 0,
  maxTagBytesSeen: 0
}

export const getWebmOpusProfilerStats = (): WebmOpusProfilerStats => ({
  ...webmOpusProfiler
})

type VintLengthResult = number | typeof TOO_SHORT | typeof INVALID_VINT
type VintResult = bigint | typeof TOO_SHORT
type EbmlIdResult =
  | {
      id: Buffer
      offset: number
    }
  | typeof TOO_SHORT
  | typeof INVALID_VINT
type TagSizeResult =
  | {
      offset: number
      dataLen: bigint
      vintLen: number
    }
  | typeof TOO_SHORT
  | typeof INVALID_VINT
type TagReadResult = { offset: number; _skipUntil?: bigint } | typeof TOO_SHORT

type ParsedBlock = {
  trackNumber: number
  relativeTimecode: number
  flags: number
  packets: Buffer[]
}

/** Reads the length of an EBML VINT without consuming its marker bit. */
const readVintLength = (buf: Buffer, index: number): VintLengthResult => {
  if (index < 0 || index >= buf.length) return TOO_SHORT
  const firstByte = buf[index]
  if (firstByte === undefined) return TOO_SHORT
  if (firstByte === 0) return INVALID_VINT

  let mask = 0x80
  let length = 1
  while (length <= 8 && (firstByte & mask) === 0) {
    mask >>= 1
    length++
  }

  if (length > 8) return INVALID_VINT
  return index + length > buf.length ? TOO_SHORT : length
}

/** Reads an EBML VINT value with its marker bit removed. */
const readVint = (buf: Buffer, start: number, end: number): VintResult => {
  if (end > buf.length) return TOO_SHORT
  const length = readVintLength(buf, start)
  if (typeof length !== 'number' || end !== start + length) return TOO_SHORT

  const firstByte = buf[start]
  if (firstByte === undefined) return TOO_SHORT
  const mask = (1 << (8 - length)) - 1
  let value = BigInt(firstByte & mask)

  for (let index = start + 1; index < end; index++) {
    const nextByte = buf[index]
    if (nextByte === undefined) return TOO_SHORT
    value = (value << 8n) | BigInt(nextByte)
  }

  return value
}

const readUnsigned = (data: Buffer): bigint => {
  let value = 0n
  for (const byte of data) value = (value << 8n) | BigInt(byte)
  return value
}

const readBlockVint = (
  data: Buffer,
  offset: number
): { value: bigint; length: number } | null => {
  const length = readVintLength(data, offset)
  if (typeof length !== 'number') return null
  const value = readVint(data, offset, offset + length)
  if (value === TOO_SHORT) return null
  return { value, length }
}

const parseLacedFrames = (
  data: Buffer,
  offset: number,
  lacing: number
): Buffer[] | null => {
  if (offset > data.length) return null
  if (lacing === 0) return [data.subarray(offset)]
  if (offset >= data.length) return null

  const frameCount = (data[offset] ?? 0) + 1
  offset++
  if (frameCount < 1) return null

  if (lacing === 2) {
    const payloadLength = data.length - offset
    if (payloadLength % frameCount !== 0) return null
    const frameLength = payloadLength / frameCount
    const frames: Buffer[] = []
    for (let index = 0; index < frameCount; index++) {
      const start = offset + index * frameLength
      frames.push(data.subarray(start, start + frameLength))
    }
    return frames
  }

  const sizes: number[] = []
  let declaredSize = 0

  if (lacing === 1) {
    for (let index = 0; index < frameCount - 1; index++) {
      let frameSize = 0
      let byte: number
      do {
        if (offset >= data.length) return null
        byte = data[offset++] ?? 0
        frameSize += byte
      } while (byte === 255)
      sizes.push(frameSize)
      declaredSize += frameSize
    }
  } else if (lacing === 3) {
    const first = readBlockVint(data, offset)
    if (!first || first.value > BigInt(Number.MAX_SAFE_INTEGER)) return null
    offset += first.length
    let previousSize = Number(first.value)
    sizes.push(previousSize)
    declaredSize += previousSize

    for (let index = 1; index < frameCount - 1; index++) {
      const deltaVint = readBlockVint(data, offset)
      if (!deltaVint) return null
      offset += deltaVint.length

      const bias = (1n << BigInt(7 * deltaVint.length - 1)) - 1n
      const delta = deltaVint.value - bias
      const nextSizeBig = BigInt(previousSize) + delta
      if (nextSizeBig < 0n || nextSizeBig > BigInt(Number.MAX_SAFE_INTEGER))
        return null

      previousSize = Number(nextSizeBig)
      sizes.push(previousSize)
      declaredSize += previousSize
    }
  } else {
    return null
  }

  const remaining = data.length - offset
  const lastSize = remaining - declaredSize
  if (lastSize < 0) return null
  sizes.push(lastSize)

  const frames: Buffer[] = []
  let cursor = offset
  for (const size of sizes) {
    if (!Number.isSafeInteger(size) || size < 0 || cursor + size > data.length)
      return null
    frames.push(data.subarray(cursor, cursor + size))
    cursor += size
  }

  return cursor === data.length ? frames : null
}

/** Returns the duration represented by one Opus packet, based on its TOC. */
const getOpusPacketDurationMs = (packet: Buffer): number => {
  const toc = packet[0]
  if (toc === undefined) return 20

  const config = toc >> 3
  let frameDurationMs: number
  if (config >= 16) {
    frameDurationMs = [2.5, 5, 10, 20][config & 0x03] ?? 20
  } else if (config >= 12) {
    frameDurationMs = (config & 0x01) === 0 ? 10 : 20
  } else {
    frameDurationMs = [10, 20, 40, 60][config & 0x03] ?? 20
  }

  const frameCode = toc & 0x03
  let frameCount = 1
  if (frameCode === 1 || frameCode === 2) {
    frameCount = 2
  } else if (frameCode === 3) {
    // Code 3: bits 2-7 contain M (frame count); bits 0-1 are VBR/padding.
    frameCount = packet[1] === undefined ? 0 : (packet[1] >> 2) & 0x3f
  }

  const duration = frameDurationMs * frameCount
  return frameCount > 0 && duration <= 120 ? duration : 20
}

const parseBlock = (data: Buffer): ParsedBlock | null => {
  const track = readBlockVint(data, 0)
  if (!track || track.value > BigInt(Number.MAX_SAFE_INTEGER)) return null

  let offset = track.length
  if (offset + 3 > data.length) return null

  const relativeTimecode = data.readInt16BE(offset)
  offset += 2
  const flags = data[offset] ?? 0
  offset++

  const lacing = (flags >> 1) & 0x03
  const packets = parseLacedFrames(data, offset, lacing)
  if (!packets || packets.some((packet) => packet.length === 0)) return null

  return {
    trackNumber: Number(track.value),
    relativeTimecode,
    flags,
    packets
  }
}

/**
 * Demuxes WebM audio blocks into Opus packets. For every emitted packet it also
 * emits a `packetTimestamp` event before pushing the packet downstream. The
 * timestamp is the Matroska block timestamp adjusted by CodecDelay.
 */
abstract class WebmBaseDemuxer extends Transform {
  protected ringBuffer: RingBuffer
  protected total: bigint
  protected processed: bigint
  protected skipUntil: bigint | null
  protected currentTrack: WebmTrackInfo | null
  protected pendingTrack: WebmTrackInfo
  protected ebmlFound: boolean
  private clusterTimecode: bigint
  private timecodeScaleNs: bigint
  private cleanedUp: boolean

  constructor(options: TransformOptions = {}) {
    super({ readableObjectMode: true, ...options })
    this.on('error', (err: Error & { code?: string | number }) => {
      const errorCode = String(err.code ?? '')
      const expectedCancellation =
        errorCode === 'ERR_STREAM_PREMATURE_CLOSE' ||
        errorCode === 'ABORT_ERR' ||
        err.name === 'AbortError' ||
        (this.destroyed && errorCode === 'ECONNRESET')

      if (expectedCancellation) {
        logger('debug', 'WebmDemuxer', `Upstream stream closed: ${err.message}`)
        return
      }

      const code = err.code ? ` (${err.code})` : ''
      logger('error', 'WebmDemuxer', `Stream error: ${err.message}${code}`)
    })

    this.ringBuffer = new RingBuffer(BUFFER_SIZE)
    this.total = 0n
    this.processed = 0n
    this.skipUntil = null
    this.currentTrack = null
    this.pendingTrack = {}
    this.ebmlFound = false
    this.clusterTimecode = 0n
    this.timecodeScaleNs = 1_000_000n
    this.cleanedUp = false

    webmOpusProfiler.created++
    webmOpusProfiler.active++
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: TransformCallback
  ): void {
    if (!chunk?.length) {
      done()
      return
    }

    if (chunk.length > BUFFER_SIZE || this.ringBuffer.length + chunk.length > BUFFER_SIZE) {
      done(
        new Error(
          `WebM parser buffer overflow (buffered=${this.ringBuffer.length}, incoming=${chunk.length}, capacity=${BUFFER_SIZE})`
        )
      )
      return
    }

    webmOpusProfiler.chunksIn++
    webmOpusProfiler.bytesIn += chunk.length
    this.ringBuffer.write(chunk)
    if (this.ringBuffer.length > webmOpusProfiler.ringPeakBytes) {
      webmOpusProfiler.ringPeakBytes = this.ringBuffer.length
    }
    this.total += BigInt(chunk.length)

    if (this.skipUntil !== null) {
      const remainingToSkip = this.skipUntil - this.processed
      const bufferLen = BigInt(this.ringBuffer.length)
      const toSkip = remainingToSkip < bufferLen ? remainingToSkip : bufferLen

      if (toSkip > 0n) {
        const skipNum = Number(toSkip)
        this.ringBuffer.skip(skipNum)
        this.processed += BigInt(skipNum)
      }
      if (this.processed < this.skipUntil) {
        done()
        return
      }
      this.skipUntil = null
    }

    while (true) {
      const currentData = this.ringBuffer.getContiguous(this.ringBuffer.length)
      if (!currentData) break

      let result: TagReadResult
      try {
        result = this._readTag(currentData, 0)
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        logger('error', 'WebmDemuxer', `Error in _readTag: ${error.message}`)
        done(error)
        return
      }

      if (result === TOO_SHORT) {
        webmOpusProfiler.tooShortReads++
        break
      }

      if (result._skipUntil !== undefined) {
        const skipped = this.ringBuffer.length
        if (skipped > 0) webmOpusProfiler.skippedBytes += skipped
        this.skipUntil = result._skipUntil
        this.ringBuffer.skip(skipped)
        this.processed += BigInt(skipped)
        break
      }

      if (result.offset > 0) {
        webmOpusProfiler.skippedBytes += result.offset
        this.ringBuffer.skip(result.offset)
        this.processed += BigInt(result.offset)
      } else {
        break
      }
    }

    if (this.total > 1_000_000_000n && this.skipUntil === null) {
      this.total = this.processed = 0n
    }

    done()
  }

  protected _readEBMLId(chunk: Buffer, offset: number): EbmlIdResult {
    const length = readVintLength(chunk, offset)
    if (length === TOO_SHORT || length === INVALID_VINT) return length
    return { id: chunk.subarray(offset, offset + length), offset: offset + length }
  }

  protected _readTagSize(chunk: Buffer, offset: number): TagSizeResult {
    const length = readVintLength(chunk, offset)
    if (length === TOO_SHORT || length === INVALID_VINT) return length
    const dataLen = readVint(chunk, offset, offset + length)
    if (dataLen === TOO_SHORT) return TOO_SHORT
    return { offset: offset + length, dataLen, vintLen: length }
  }

  protected _readTag(chunk: Buffer, offset: number): TagReadResult {
    const idData = this._readEBMLId(chunk, offset)
    if (idData === TOO_SHORT) return TOO_SHORT
    if (idData === INVALID_VINT) {
      webmOpusProfiler.invalidVint++
      return { offset: 1 }
    }

    const tag = idData.id.toString('hex')
    if (!this.ebmlFound) {
      if (tag === '1a45dfa3' || tag === '1f43b675') {
        this.ebmlFound = true
      } else {
        return { offset: 1 }
      }
    }

    const sizeData = this._readTagSize(chunk, idData.offset)
    if (sizeData === TOO_SHORT) return TOO_SHORT
    if (sizeData === INVALID_VINT) {
      webmOpusProfiler.invalidVint++
      return { offset: 1 }
    }

    const { dataLen, vintLen } = sizeData
    const numericTagSize = Number(dataLen)
    if (
      Number.isFinite(numericTagSize) &&
      numericTagSize > webmOpusProfiler.maxTagBytesSeen
    ) {
      webmOpusProfiler.maxTagBytesSeen = numericTagSize
    }

    const unknownSize = dataLen === 2n ** BigInt(7 * vintLen) - 1n
    if (tag !== '18538067' && !unknownSize && dataLen > BigInt(MAX_TAG_SIZE)) {
      return { offset: 1 }
    }

    const dataOffset = sizeData.offset
    if (!(tag in TAGS)) {
      if (unknownSize) return { offset: 1 }
      const size = Number(dataLen)
      if (!Number.isSafeInteger(size) || size < 0) return { offset: 1 }
      if (chunk.length >= dataOffset + size) {
        return { offset: dataOffset + size }
      }
      return {
        offset: dataOffset,
        _skipUntil: this.processed + BigInt(dataOffset + size)
      }
    }

    if (TAGS[tag]) {
      if (tag === '1f43b675') this.clusterTimecode = 0n
      if (tag === 'ae') this.pendingTrack = {}
      return { offset: dataOffset }
    }

    const size = Number(dataLen)
    if (!Number.isSafeInteger(size) || size < 0) return { offset: 1 }
    if (dataOffset + size > chunk.length) return TOO_SHORT
    const data = chunk.subarray(dataOffset, dataOffset + size)

    if (tag === '2ad7b1') {
      const scale = readUnsigned(data)
      if (scale > 0n) this.timecodeScaleNs = scale
    } else if (tag === 'd7') {
      const value = readUnsigned(data)
      if (value <= BigInt(Number.MAX_SAFE_INTEGER))
        this.pendingTrack.number = Number(value)
    } else if (tag === '83') {
      const value = readUnsigned(data)
      if (value <= BigInt(Number.MAX_SAFE_INTEGER))
        this.pendingTrack.type = Number(value)
    } else if (tag === '86') {
      this.pendingTrack.codecId = data.toString('utf8')
    } else if (tag === '56aa') {
      this.pendingTrack.codecDelayNs = readUnsigned(data)
    } else if (tag === '56bb') {
      this.pendingTrack.seekPreRollNs = readUnsigned(data)
    }

    if (
      !this.currentTrack &&
      this.pendingTrack.type === 2 &&
      this.pendingTrack.number !== undefined &&
      this.pendingTrack.codecId === 'A_OPUS'
    ) {
      this.currentTrack = this.pendingTrack
    }

    if (tag === 'e7') {
      this.clusterTimecode = readUnsigned(data)
    } else if (tag === '63a2') {
      try {
        this._checkHead(data)
        webmOpusProfiler.headPackets++
        this.emit('head', toTightBuffer(data))
      } catch {
        // An invalid CodecPrivate is ignored here; packet validation below will
        // still fail through the decoder if the stream is not valid Opus.
      }
    } else if (tag === 'a3' || tag === 'a1') {
      this._emitBlock(data)
    }

    return { offset: dataOffset + size }
  }

  private _emitBlock(data: Buffer): void {
    const block = parseBlock(data)
    if (!block || !this.currentTrack) return
    if (block.trackNumber !== this.currentTrack.number) return

    const rawTimestamp =
      (this.clusterTimecode + BigInt(block.relativeTimecode)) * this.timecodeScaleNs
    const codecDelayNs = this.currentTrack.codecDelayNs ?? 0n
    const timestampNs = rawTimestamp - codecDelayNs
    let elapsedMs = 0

    for (const packet of block.packets) {
      const durationMs = getOpusPacketDurationMs(packet)
      const timestampMs = Number(timestampNs) / 1_000_000 + elapsedMs

      if (this.listenerCount('packetTimestamp') > 0) {
        this.emit('packetTimestamp', {
          timestampMs,
          durationMs
        } satisfies WebmOpusPacketTiming)
      }

      const output = toTightBuffer(packet)
      webmOpusProfiler.packetsOut++
      webmOpusProfiler.packetBytesOut += output.length
      this.push(output)

      elapsedMs += durationMs
    }

  }

  protected abstract _checkHead(data: Buffer): void

  override _destroy(err: Error | null, cb: TransformCallback): void {
    this._cleanup()
    cb(err ?? undefined)
  }

  override _final(cb: TransformCallback): void {
    this._cleanup()
    cb()
  }

  protected _cleanup(): void {
    if (this.cleanedUp) return
    this.cleanedUp = true

    webmOpusProfiler.destroyed++
    webmOpusProfiler.active = Math.max(0, webmOpusProfiler.active - 1)
    this.ringBuffer.dispose()
    this.pendingTrack = {}
    this.currentTrack = null
    this.ebmlFound = false
    this.skipUntil = null
  }
}

export class WebmOpusDemuxer extends WebmBaseDemuxer {
  protected override _checkHead(data: Buffer): void {
    if (!data.subarray(0, 8).equals(OPUS_HEAD)) {
      throw new Error('Expected Opus audio stream')
    }
  }
}

export default WebmOpusDemuxer
