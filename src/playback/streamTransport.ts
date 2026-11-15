import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { Readable } from 'node:stream'
import { logger } from '../utils.ts'

export const STREAM_TRANSPORT_MAGIC_U32 = 0x4e4c5354 // "NLST"
export const STREAM_TRANSPORT_VERSION = 0x01
export const STREAM_HANDSHAKE_SIZE = 56
export const STREAM_RECORD_HEADER_SIZE = 5
export const STREAM_ID_BYTE_LENGTH = 16
export const SECURITY_TOKEN_BYTE_LENGTH = 32
export const DEFAULT_MAX_RECORD_PAYLOAD_BYTES = 256 * 1024

export const StreamMessageType = {
  HANDSHAKE: 0x01
} as const

export const StreamRecordType = {
  DATA: 0x10,
  END: 0x11,
  ERROR: 0x12,
  CANCEL: 0x13
} as const

export type StreamRecordTypeValue =
  (typeof StreamRecordType)[keyof typeof StreamRecordType]

export const StreamErrorCode = {
  UNKNOWN: 0x0001,
  UPSTREAM_ERROR: 0x0002,
  DECRYPTION_ERROR: 0x0003,
  PROTOCOL_VIOLATION: 0x0004,
  UNAUTHORIZED: 0x0005,
  CANCELLED: 0x0006
} as const

export interface ParsedHandshake {
  version: number
  type: number
  flags: number
  streamIdBytes: Buffer
  streamIdHex: string
  securityTokenBytes: Buffer
}

export interface ParsedStreamRecord {
  type: StreamRecordTypeValue
  payload: Buffer
  errorCode?: number
  errorMessage?: string
}

export class StreamProtocolError extends Error {
  public readonly code: number
  constructor(
    message: string,
    code: number = StreamErrorCode.PROTOCOL_VIOLATION
  ) {
    super(message)
    this.name = 'StreamProtocolError'
    this.code = code
  }
}

export function encodeHandshake(
  streamIdBytes: Buffer,
  securityTokenBytes: Buffer,
  flags = 0
): Buffer {
  if (streamIdBytes.length !== STREAM_ID_BYTE_LENGTH) {
    throw new Error(`Invalid streamId length: ${streamIdBytes.length}`)
  }
  if (securityTokenBytes.length !== SECURITY_TOKEN_BYTE_LENGTH) {
    throw new Error(
      `Invalid securityToken length: ${securityTokenBytes.length}`
    )
  }
  const buf = Buffer.allocUnsafe(STREAM_HANDSHAKE_SIZE)
  buf.writeUInt32BE(STREAM_TRANSPORT_MAGIC_U32, 0)
  buf.writeUInt8(STREAM_TRANSPORT_VERSION, 4)
  buf.writeUInt8(StreamMessageType.HANDSHAKE, 5)
  buf.writeUInt16BE(flags & 0xffff, 6)
  streamIdBytes.copy(buf, 8, 0, STREAM_ID_BYTE_LENGTH)
  securityTokenBytes.copy(buf, 24, 0, SECURITY_TOKEN_BYTE_LENGTH)
  return buf
}

export function decodeHandshake(buf: Buffer): ParsedHandshake {
  if (buf.length !== STREAM_HANDSHAKE_SIZE) {
    throw new StreamProtocolError(`Invalid handshake size: ${buf.length}`)
  }
  if (buf.readUInt32BE(0) !== STREAM_TRANSPORT_MAGIC_U32) {
    throw new StreamProtocolError('Invalid protocol magic signature')
  }
  const version = buf.readUInt8(4)
  if (version !== STREAM_TRANSPORT_VERSION) {
    throw new StreamProtocolError(`Unsupported protocol version: ${version}`)
  }
  const type = buf.readUInt8(5)
  if (type !== StreamMessageType.HANDSHAKE) {
    throw new StreamProtocolError(`Invalid handshake message type: ${type}`)
  }
  const flags = buf.readUInt16BE(6)
  const streamIdBytes = Buffer.from(buf.subarray(8, 24))
  const securityTokenBytes = Buffer.from(buf.subarray(24, 56))
  return {
    version,
    type,
    flags,
    streamIdBytes,
    streamIdHex: streamIdBytes.toString('hex'),
    securityTokenBytes
  }
}

export function encodeRecordHeader(
  type: StreamRecordTypeValue,
  payloadLength: number
): Buffer {
  const header = Buffer.allocUnsafe(STREAM_RECORD_HEADER_SIZE)
  header.writeUInt8(type, 0)
  header.writeUInt32BE(payloadLength >>> 0, 1)
  return header
}

export function encodeRecord(
  type: StreamRecordTypeValue,
  payload: Buffer = Buffer.alloc(0)
): Buffer {
  const frame = Buffer.allocUnsafe(STREAM_RECORD_HEADER_SIZE + payload.length)
  frame.writeUInt8(type, 0)
  frame.writeUInt32BE(payload.length >>> 0, 1)
  if (payload.length > 0) payload.copy(frame, STREAM_RECORD_HEADER_SIZE)
  return frame
}

export function encodeErrorRecord(errorCode: number, message: string): Buffer {
  const msgBytes = Buffer.from(message || 'Stream error', 'utf8')
  const clipped =
    msgBytes.length > 4096 ? msgBytes.subarray(0, 4096) : msgBytes
  const payload = Buffer.allocUnsafe(2 + clipped.length)
  payload.writeUInt16BE(errorCode & 0xffff, 0)
  clipped.copy(payload, 2)
  return encodeRecord(StreamRecordType.ERROR, payload)
}

export function decodeErrorPayload(payload: Buffer): {
  errorCode: number
  errorMessage: string
} {
  if (payload.length < 2) {
    return {
      errorCode: StreamErrorCode.UNKNOWN,
      errorMessage:
        payload.length > 0 ? payload.toString('utf8') : 'Unknown stream error'
    }
  }
  const errorCode = payload.readUInt16BE(0)
  const errorMessage =
    payload.length > 2
      ? payload.subarray(2).toString('utf8')
      : `Stream error (${errorCode})`
  return { errorCode, errorMessage }
}

export interface StreamTransportParserCallbacks {
  onHandshake: (handshake: ParsedHandshake) => boolean
  onRecord: (record: ParsedStreamRecord) => void
  onProtocolError: (error: StreamProtocolError) => void
}

export class StreamTransportParser {
  private readonly maxPayloadBytes: number
  private readonly callbacks: StreamTransportParserCallbacks
  private chunks: Buffer[] = []
  private bufferedBytes = 0
  private handshakeCompleted = false
  private terminalRecordReceived = false
  private errored = false

  constructor(
    callbacks: StreamTransportParserCallbacks,
    maxPayloadBytes: number = DEFAULT_MAX_RECORD_PAYLOAD_BYTES
  ) {
    this.callbacks = callbacks
    this.maxPayloadBytes = maxPayloadBytes
  }

  public push(chunk: Buffer): void {
    if (this.errored || chunk.length === 0) return
    if (this.terminalRecordReceived) {
      this._fail(new StreamProtocolError('Trailing bytes after terminal record'))
      return
    }

    this.chunks.push(chunk)
    this.bufferedBytes += chunk.length

    try {
      if (!this.handshakeCompleted) {
        if (this.bufferedBytes >= 4) {
          if (
            this._peekBytes(4).readUInt32BE(0) !== STREAM_TRANSPORT_MAGIC_U32
          ) {
            this._fail(new StreamProtocolError('Invalid protocol magic'))
            return
          }
        }
        if (this.bufferedBytes < STREAM_HANDSHAKE_SIZE) return

        const handshake = decodeHandshake(this._readBytes(STREAM_HANDSHAKE_SIZE))
        if (!this.callbacks.onHandshake(handshake)) {
          this.errored = true
          this.reset()
          return
        }
        this.handshakeCompleted = true
      }

      while (!this.errored && this.bufferedBytes >= STREAM_RECORD_HEADER_SIZE) {
        if (this.terminalRecordReceived) {
          this._fail(
            new StreamProtocolError('Trailing bytes after terminal record')
          )
          return
        }

        const header = this._peekBytes(STREAM_RECORD_HEADER_SIZE)
        const recordType = header.readUInt8(0)
        const payloadLength = header.readUInt32BE(1)

        if (
          recordType !== StreamRecordType.DATA &&
          recordType !== StreamRecordType.END &&
          recordType !== StreamRecordType.ERROR &&
          recordType !== StreamRecordType.CANCEL
        ) {
          this._fail(
            new StreamProtocolError(`Unknown record type: ${recordType}`)
          )
          return
        }

        if (payloadLength > this.maxPayloadBytes) {
          this._fail(
            new StreamProtocolError(
              `Payload length ${payloadLength} exceeds max ${this.maxPayloadBytes}`
            )
          )
          return
        }

        if (recordType === StreamRecordType.END && payloadLength !== 0) {
          this._fail(new StreamProtocolError('END record must have length 0'))
          return
        }

        if (this.bufferedBytes < STREAM_RECORD_HEADER_SIZE + payloadLength) {
          return
        }

        this._consumeBytes(STREAM_RECORD_HEADER_SIZE)
        const payload =
          payloadLength > 0 ? this._readBytes(payloadLength) : Buffer.alloc(0)

        if (
          recordType === StreamRecordType.END ||
          recordType === StreamRecordType.ERROR
        ) {
          this.terminalRecordReceived = true
        }

        if (recordType === StreamRecordType.ERROR) {
          const { errorCode, errorMessage } = decodeErrorPayload(payload)
          this.callbacks.onRecord({
            type: recordType,
            payload,
            errorCode,
            errorMessage
          })
        } else {
          this.callbacks.onRecord({
            type: recordType as StreamRecordTypeValue,
            payload
          })
        }
      }
    } catch (err) {
      this._fail(
        err instanceof StreamProtocolError
          ? err
          : new StreamProtocolError((err as Error).message)
      )
    }
  }

  public reset(): void {
    this.chunks = []
    this.bufferedBytes = 0
  }

  private _fail(error: StreamProtocolError): void {
    if (this.errored) return
    this.errored = true
    this.reset()
    this.callbacks.onProtocolError(error)
  }

  private _peekBytes(count: number): Buffer {
    const first = this.chunks[0]
    if (first && first.length >= count) return first.subarray(0, count)
    const out = Buffer.allocUnsafe(count)
    let offset = 0
    for (const piece of this.chunks) {
      const take = Math.min(piece.length, count - offset)
      piece.copy(out, offset, 0, take)
      offset += take
      if (offset >= count) break
    }
    return out
  }

  private _consumeBytes(count: number): void {
    let remaining = count
    while (remaining > 0 && this.chunks.length > 0) {
      const first = this.chunks[0]
      if (!first) break
      if (first.length <= remaining) {
        remaining -= first.length
        this.chunks.shift()
      } else {
        this.chunks[0] = first.subarray(remaining)
        remaining = 0
      }
    }
    this.bufferedBytes = Math.max(0, this.bufferedBytes - count)
  }

  private _readBytes(count: number): Buffer {
    if (count === 0) return Buffer.alloc(0)
    const first = this.chunks[0]
    if (first && first.length === count) {
      this.chunks.shift()
      this.bufferedBytes -= count
      return first
    }
    if (first && first.length > count) {
      const slice = first.subarray(0, count)
      this.chunks[0] = first.subarray(count)
      this.bufferedBytes -= count
      return slice
    }
    const out = Buffer.allocUnsafe(count)
    let offset = 0
    while (offset < count && this.chunks.length > 0) {
      const piece = this.chunks[0]
      if (!piece) break
      const take = Math.min(piece.length, count - offset)
      piece.copy(out, offset, 0, take)
      offset += take
      if (take === piece.length) this.chunks.shift()
      else this.chunks[0] = piece.subarray(take)
    }
    this.bufferedBytes = Math.max(0, this.bufferedBytes - count)
    return out
  }
}

export interface StreamReserveWatermarks {
  lowWatermark: number
  targetWatermark: number
  highWatermark: number
}

export interface StreamTransportMetricsSnapshot {
  streamId: string
  playerId: string
  bytesProduced: number
  bytesTransmitted: number
  bytesReceived: number
  bytesConsumed: number
  currentReserveBytes: number
  minReserveBytes: number
  avgReserveBytes: number
  maxReserveBytes: number
  targetWatermarkBytes: number
  lowWatermarkBytes: number
  highWatermarkBytes: number
  estimatedAudioDurationMs: number
  backpressureWaitMs: number
  pauseCount: number
  resumeCount: number
  dataRecordCount: number
  avgPayloadBytes: number
  protocolErrors: number
  unexpectedDisconnects: number
}

export const DEFAULT_RESERVE_WATERMARKS: StreamReserveWatermarks = {
  lowWatermark: 64 * 1024,
  targetWatermark: 160 * 1024,
  highWatermark: 256 * 1024
}

export const DEFAULT_GLOBAL_RESERVE_BUDGET_BYTES = 16 * 1024 * 1024

export class GlobalReserveBudget {
  private maxBudgetBytes: number
  private currentUsedBytes = 0
  private peakUsedBytes = 0
  private readonly waitingStreams: Set<() => void> = new Set()

  constructor(maxBudgetBytes: number = DEFAULT_GLOBAL_RESERVE_BUDGET_BYTES) {
    this.maxBudgetBytes = Math.max(64 * 1024, maxBudgetBytes)
  }

  public get usedBytes(): number {
    return this.currentUsedBytes
  }

  public get peakBytes(): number {
    return this.peakUsedBytes
  }

  public get limitBytes(): number {
    return this.maxBudgetBytes
  }

  public canAllocate(bytes: number): boolean {
    return this.currentUsedBytes + bytes <= this.maxBudgetBytes
  }

  public allocate(bytes: number): boolean {
    this.currentUsedBytes += bytes
    if (this.currentUsedBytes > this.peakUsedBytes) {
      this.peakUsedBytes = this.currentUsedBytes
    }
    return this.currentUsedBytes < this.maxBudgetBytes
  }

  public release(bytes: number): void {
    if (bytes <= 0) return
    this.currentUsedBytes = Math.max(0, this.currentUsedBytes - bytes)
    if (this.currentUsedBytes <= this.maxBudgetBytes * 0.85) {
      for (const cb of Array.from(this.waitingStreams)) {
        if (this.currentUsedBytes >= this.maxBudgetBytes) break
        this.waitingStreams.delete(cb)
        cb()
      }
    }
  }

  public onSpaceAvailable(cb: () => void): void {
    this.waitingStreams.add(cb)
  }

  public removeWaiter(cb: () => void): void {
    this.waitingStreams.delete(cb)
  }
}

export interface StreamReserveOptions {
  streamId: string
  playerId: string
  watermarks?: Partial<StreamReserveWatermarks>
  estimatedBitrateBps?: number
  globalBudget?: GlobalReserveBudget
  onPauseTransport?: () => void
  onResumeTransport?: () => void
  onPlayerClose?: () => void
}

export class StreamReserveBuffer extends Readable {
  public streamId: string
  public readonly playerId: string
  public readonly watermarks: StreamReserveWatermarks

  private readonly globalBudget: GlobalReserveBudget | null
  private readonly estimatedBytesPerSecond: number
  private readonly onPauseTransport?: () => void
  private readonly onResumeTransport?: () => void
  private readonly onPlayerClose?: () => void
  private readonly budgetWaiter: () => void

  private queue: Buffer[] = []
  private queuedBytes = 0
  private wantsRead = false
  private transportPaused = false
  private pausedAt = 0
  private eofSignaled = false
  private ended = false
  private closedByPlayer = false

  private bytesProduced = 0
  private bytesTransmitted = 0
  private bytesReceived = 0
  private bytesConsumed = 0
  private minReserveBytes = Number.POSITIVE_INFINITY
  private maxReserveBytes = 0
  private reserveSampleSum = 0
  private reserveSampleCount = 0
  private backpressureWaitMs = 0
  private pauseCount = 0
  private resumeCount = 0
  private dataRecordCount = 0
  private protocolErrors = 0
  private unexpectedDisconnects = 0
  private hasReceivedFirstChunk = false

  constructor(options: StreamReserveOptions) {
    super({ highWaterMark: 16 * 1024 })
    this.streamId = options.streamId
    this.playerId = options.playerId

    const low =
      options.watermarks?.lowWatermark ??
      DEFAULT_RESERVE_WATERMARKS.lowWatermark
    const target =
      options.watermarks?.targetWatermark ??
      Math.max(low * 2, DEFAULT_RESERVE_WATERMARKS.targetWatermark)
    const high =
      options.watermarks?.highWatermark ??
      Math.max(target + 32 * 1024, DEFAULT_RESERVE_WATERMARKS.highWatermark)

    this.watermarks = {
      lowWatermark: low,
      targetWatermark: target,
      highWatermark: high
    }

    const bitrateBps =
      options.estimatedBitrateBps && options.estimatedBitrateBps > 0
        ? options.estimatedBitrateBps
        : 128_000
    this.estimatedBytesPerSecond = Math.max(1000, bitrateBps / 8)
    this.globalBudget = options.globalBudget ?? null
    this.onPauseTransport = options.onPauseTransport
    this.onResumeTransport = options.onResumeTransport
    this.onPlayerClose = options.onPlayerClose
    this.budgetWaiter = () => this._maybeResumeTransport()
  }

  public get currentReserveBytes(): number {
    return this.queuedBytes + this.readableLength
  }

  public get isTransportPaused(): boolean {
    return this.transportPaused
  }

  public enqueueChunk(chunk: Buffer): boolean {
    if (this.destroyed || this.ended || this.eofSignaled) return false
    if (chunk.length === 0) return !this.transportPaused

    this.bytesReceived += chunk.length
    this.dataRecordCount++
    this.hasReceivedFirstChunk = true

    this.queue.push(chunk)
    this.queuedBytes += chunk.length
    const withinGlobal = this.globalBudget
      ? this.globalBudget.allocate(chunk.length)
      : true

    if (this.wantsRead) {
      this._drainToConsumer()
    }
    this._sampleReserveOccupancy()

    if (
      this.currentReserveBytes >= this.watermarks.highWatermark ||
      !withinGlobal
    ) {
      this._pauseTransport(!withinGlobal)
      return false
    }
    return true
  }

  public signalEnd(): void {
    if (this.destroyed || this.eofSignaled) return
    this.eofSignaled = true
    this.emit('finishBuffering')
    this._drainToConsumer()
  }

  public signalError(
    error: Error,
    options?: { isProtocolError?: boolean; isUnexpectedDisconnect?: boolean }
  ): void {
    if (options?.isProtocolError) this.protocolErrors++
    if (options?.isUnexpectedDisconnect) this.unexpectedDisconnects++
    this._releaseAllQueuedBytes()
    if (!this.destroyed) {
      if (this.listenerCount('error') > 0) {
        this.destroy(error)
      } else {
        logger(
          'warn',
          'StreamTransport',
          `Stream ${this.streamId} (player=${this.playerId}) closed with no error listener attached: ${error.message}`
        )
        this.destroy()
      }
    }
  }

  public getMetricsSnapshot(): StreamTransportMetricsSnapshot {
    const current = this.currentReserveBytes
    const activePauseWait =
      this.transportPaused && this.pausedAt > 0
        ? performance.now() - this.pausedAt
        : 0
    return {
      streamId: this.streamId,
      playerId: this.playerId,
      bytesProduced:
        this.bytesProduced > 0 ? this.bytesProduced : this.bytesReceived,
      bytesTransmitted:
        this.bytesTransmitted > 0 ? this.bytesTransmitted : this.bytesReceived,
      bytesReceived: this.bytesReceived,
      bytesConsumed: this.bytesConsumed,
      currentReserveBytes: current,
      minReserveBytes:
        this.minReserveBytes === Number.POSITIVE_INFINITY
          ? 0
          : this.minReserveBytes,
      avgReserveBytes:
        this.reserveSampleCount > 0
          ? Math.round(this.reserveSampleSum / this.reserveSampleCount)
          : current,
      maxReserveBytes: this.maxReserveBytes,
      targetWatermarkBytes: this.watermarks.targetWatermark,
      lowWatermarkBytes: this.watermarks.lowWatermark,
      highWatermarkBytes: this.watermarks.highWatermark,
      estimatedAudioDurationMs: Math.round(
        (current / this.estimatedBytesPerSecond) * 1000
      ),
      backpressureWaitMs: Number(
        (this.backpressureWaitMs + activePauseWait).toFixed(2)
      ),
      pauseCount: this.pauseCount,
      resumeCount: this.resumeCount,
      dataRecordCount: this.dataRecordCount,
      avgPayloadBytes:
        this.dataRecordCount > 0
          ? Math.round(this.bytesReceived / this.dataRecordCount)
          : 0,
      protocolErrors: this.protocolErrors,
      unexpectedDisconnects: this.unexpectedDisconnects
    }
  }

  public override read(size?: number): Buffer | null {
    const chunk = super.read(size) as Buffer | null
    if (chunk !== null) {
      this._maybeResumeTransport()
    }
    return chunk
  }

  public override _read(_size: number): void {
    this.wantsRead = true
    this._drainToConsumer()
  }

  public override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void
  ): void {
    if (this.transportPaused && this.pausedAt > 0) {
      this.backpressureWaitMs += performance.now() - this.pausedAt
      this.pausedAt = 0
      this.transportPaused = false
    }
    this.globalBudget?.removeWaiter(this.budgetWaiter)
    this._releaseAllQueuedBytes()
    if (!this.ended && !this.closedByPlayer) {
      this.closedByPlayer = true
      this.onPlayerClose?.()
    }
    callback(error)
  }

  private _drainToConsumer(): void {
    while (this.wantsRead && this.queue.length > 0 && !this.destroyed) {
      const chunk = this.queue.shift()
      if (!chunk) break
      this.queuedBytes = Math.max(0, this.queuedBytes - chunk.length)
      this.globalBudget?.release(chunk.length)
      this.bytesConsumed += chunk.length
      if (!this.push(chunk)) {
        this.wantsRead = false
      }
    }
    if (this.hasReceivedFirstChunk) this._sampleReserveOccupancy()
    this._maybeResumeTransport()

    if (
      this.eofSignaled &&
      this.queue.length === 0 &&
      !this.ended &&
      !this.destroyed
    ) {
      this.ended = true
      this.push(null)
    }
  }

  private _pauseTransport(waitOnGlobalBudget: boolean): void {
    if (this.transportPaused) return
    this.transportPaused = true
    this.pausedAt = performance.now()
    this.pauseCount++
    if (waitOnGlobalBudget && this.globalBudget) {
      this.globalBudget.onSpaceAvailable(this.budgetWaiter)
    }
    this.onPauseTransport?.()
  }

  private _maybeResumeTransport(): void {
    if (!this.transportPaused || this.destroyed || this.eofSignaled) return
    if (this.currentReserveBytes > this.watermarks.lowWatermark) return
    if (this.globalBudget && !this.globalBudget.canAllocate(16 * 1024)) {
      this.globalBudget.onSpaceAvailable(this.budgetWaiter)
      return
    }
    this.globalBudget?.removeWaiter(this.budgetWaiter)
    this.transportPaused = false
    if (this.pausedAt > 0) {
      this.backpressureWaitMs += performance.now() - this.pausedAt
      this.pausedAt = 0
    }
    this.resumeCount++
    this.onResumeTransport?.()
  }

  private _sampleReserveOccupancy(): void {
    const current = this.currentReserveBytes
    if (current < this.minReserveBytes) this.minReserveBytes = current
    if (current > this.maxReserveBytes) this.maxReserveBytes = current
    this.reserveSampleSum += current
    this.reserveSampleCount++
  }

  private _releaseAllQueuedBytes(): void {
    if (this.queuedBytes > 0) {
      this.globalBudget?.release(this.queuedBytes)
      this.queuedBytes = 0
    }
    this.queue = []
  }
}

export type StreamRegistrationState =
  | 'waiting'
  | 'connected'
  | 'ended'
  | 'errored'
  | 'cancelled'

export interface StreamRegistration {
  readonly streamIdHex: string
  readonly streamIdBytes: Buffer
  readonly playerId: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly reserveStream: StreamReserveBuffer
  state: StreamRegistrationState
  socket: net.Socket | null
}

interface InternalStreamRegistration extends StreamRegistration {
  securityToken: Buffer | null
  tokenConsumed: boolean
  expiryTimer: NodeJS.Timeout | null
}

export type StreamAuthRejectReason =
  | 'STREAM_NOT_FOUND'
  | 'TOKEN_ALREADY_USED'
  | 'INVALID_STATE'
  | 'TOKEN_EXPIRED'
  | 'PLAYER_CLOSED'
  | 'INVALID_TOKEN_LENGTH'
  | 'TOKEN_MISMATCH'

export type StreamAuthResult =
  | { authorized: true; registration: StreamRegistration }
  | { authorized: false; reason: StreamAuthRejectReason }

export const DEFAULT_STREAM_AUTH_TIMEOUT_MS = 10_000

export class StreamRegistry {
  private readonly entries: Map<string, InternalStreamRegistration> = new Map()
  private readonly defaultAuthTimeoutMs: number

  constructor(defaultAuthTimeoutMs: number = DEFAULT_STREAM_AUTH_TIMEOUT_MS) {
    this.defaultAuthTimeoutMs = Math.max(50, defaultAuthTimeoutMs)
  }

  public get size(): number {
    return this.entries.size
  }

  public register(options: {
    playerId: string
    reserveStream: StreamReserveBuffer
    authTimeoutMs?: number
  }): {
    streamIdHex: string
    streamIdBytes: Buffer
    securityTokenBytes: Buffer
    registration: StreamRegistration
  } {
    const streamIdBytes = crypto.randomBytes(STREAM_ID_BYTE_LENGTH)
    const streamIdHex = streamIdBytes.toString('hex')
    const securityTokenBytes = crypto.randomBytes(SECURITY_TOKEN_BYTE_LENGTH)
    const storedToken = Buffer.from(securityTokenBytes)
    const now = Date.now()
    const timeoutMs = options.authTimeoutMs ?? this.defaultAuthTimeoutMs

    const entry: InternalStreamRegistration = {
      streamIdHex,
      streamIdBytes: Buffer.from(streamIdBytes),
      playerId: options.playerId,
      createdAt: now,
      expiresAt: now + timeoutMs,
      reserveStream: options.reserveStream,
      state: 'waiting',
      socket: null,
      securityToken: storedToken,
      tokenConsumed: false,
      expiryTimer: null
    }

    entry.expiryTimer = setTimeout(() => {
      const current = this.entries.get(streamIdHex)
      if (!current || current.state !== 'waiting') return
      this._invalidateToken(current)
      current.expiryTimer = null
      current.state = 'errored'
      this.entries.delete(streamIdHex)
      current.reserveStream.signalError(
        new Error(`Stream transport auth expired (${streamIdHex})`)
      )
    }, timeoutMs)
    entry.expiryTimer.unref?.()

    this.entries.set(streamIdHex, entry)
    return {
      streamIdHex,
      streamIdBytes,
      securityTokenBytes,
      registration: entry
    }
  }

  public authenticate(
    streamIdBytes: Buffer,
    candidateTokenBytes: Buffer,
    socket: net.Socket
  ): StreamAuthResult {
    if (streamIdBytes.length !== STREAM_ID_BYTE_LENGTH) {
      return { authorized: false, reason: 'STREAM_NOT_FOUND' }
    }
    const streamIdHex = streamIdBytes.toString('hex')
    const entry = this.entries.get(streamIdHex)
    if (!entry) return { authorized: false, reason: 'STREAM_NOT_FOUND' }
    if (entry.tokenConsumed || !entry.securityToken) {
      return { authorized: false, reason: 'TOKEN_ALREADY_USED' }
    }
    if (entry.state !== 'waiting') {
      return { authorized: false, reason: 'INVALID_STATE' }
    }
    if (entry.reserveStream.destroyed || entry.reserveStream.readableEnded) {
      this._invalidateToken(entry)
      this._clearTimer(entry)
      entry.state = 'cancelled'
      this.entries.delete(streamIdHex)
      return { authorized: false, reason: 'PLAYER_CLOSED' }
    }
    if (Date.now() > entry.expiresAt) {
      this._invalidateToken(entry)
      this._clearTimer(entry)
      entry.state = 'errored'
      this.entries.delete(streamIdHex)
      entry.reserveStream.signalError(
        new Error(`Stream transport auth expired (${streamIdHex})`)
      )
      return { authorized: false, reason: 'TOKEN_EXPIRED' }
    }
    if (
      candidateTokenBytes.length !== SECURITY_TOKEN_BYTE_LENGTH ||
      entry.securityToken.length !== SECURITY_TOKEN_BYTE_LENGTH
    ) {
      return { authorized: false, reason: 'INVALID_TOKEN_LENGTH' }
    }
    if (!crypto.timingSafeEqual(entry.securityToken, candidateTokenBytes)) {
      return { authorized: false, reason: 'TOKEN_MISMATCH' }
    }

    this._invalidateToken(entry)
    this._clearTimer(entry)
    entry.state = 'connected'
    entry.socket = socket
    return { authorized: true, registration: entry }
  }

  public get(streamIdHex: string): StreamRegistration | undefined {
    return this.entries.get(streamIdHex)
  }

  public markEnded(streamIdHex: string): void {
    const entry = this.entries.get(streamIdHex)
    if (!entry) return
    this._invalidateToken(entry)
    this._clearTimer(entry)
    entry.state = 'ended'
    entry.socket = null
    this.entries.delete(streamIdHex)
  }

  public markErrored(streamIdHex: string): void {
    const entry = this.entries.get(streamIdHex)
    if (!entry) return
    this._invalidateToken(entry)
    this._clearTimer(entry)
    entry.state = 'errored'
    entry.socket = null
    this.entries.delete(streamIdHex)
  }

  public cancel(streamIdHex: string): void {
    const entry = this.entries.get(streamIdHex)
    if (!entry) return
    this._invalidateToken(entry)
    this._clearTimer(entry)
    entry.state = 'cancelled'
    const sock = entry.socket
    entry.socket = null
    this.entries.delete(streamIdHex)
    if (sock && !sock.destroyed) sock.destroy()
  }

  public clearAll(): void {
    for (const [id, entry] of this.entries.entries()) {
      this._invalidateToken(entry)
      this._clearTimer(entry)
      if (entry.socket && !entry.socket.destroyed) entry.socket.destroy()
      this.entries.delete(id)
    }
  }

  private _invalidateToken(entry: InternalStreamRegistration): void {
    entry.tokenConsumed = true
    if (entry.securityToken) {
      entry.securityToken.fill(0)
      entry.securityToken = null
    }
  }

  private _clearTimer(entry: InternalStreamRegistration): void {
    if (entry.expiryTimer) {
      clearTimeout(entry.expiryTimer)
      entry.expiryTimer = null
    }
  }
}

const IS_WINDOWS = os.platform() === 'win32'
const TRANSPORT_KIND = IS_WINDOWS ? 'Named Pipe' : 'Unix Domain Socket'
const STALE_SOCKET_PATTERN = /^stream-transport-(\d+)-[0-9a-f]+\.sock$/i

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function cleanupStaleUnixSockets(runtimeDir: string): void {
  if (IS_WINDOWS || !fs.existsSync(runtimeDir)) return
  try {
    for (const name of fs.readdirSync(runtimeDir)) {
      const match = STALE_SOCKET_PATTERN.exec(name)
      if (!match) continue
      const ownerPid = Number(match[1])
      if (ownerPid !== process.pid && !isProcessAlive(ownerPid)) {
        try {
          fs.unlinkSync(path.join(runtimeDir, name))
        } catch {}
      }
    }
  } catch {}
}

export function isLocalSocketEndpoint(endpoint: string): boolean {
  if (!endpoint) return false
  if (IS_WINDOWS) {
    return (
      endpoint.startsWith('\\\\.\\pipe\\') ||
      endpoint.startsWith('\\\\?\\pipe\\')
    )
  }
  return path.isAbsolute(endpoint) && endpoint.endsWith('.sock')
}

function createDefaultSocketEndpoint(customRuntimeDir?: string): {
  socketPath: string
  runtimeDir: string | null
} {
  const randomSuffix = crypto.randomBytes(8).toString('hex')
  if (IS_WINDOWS) {
    return {
      socketPath: `\\\\.\\pipe\\nodelink-stream-transport-${process.pid}-${randomSuffix}`,
      runtimeDir: null
    }
  }
  const uidPart = String(os.userInfo().uid)
  const xdg = process.env.XDG_RUNTIME_DIR
  const baseDir = xdg && fs.existsSync(xdg) ? xdg : os.tmpdir()
  const runtimeDir = customRuntimeDir
    ? path.resolve(customRuntimeDir)
    : path.join(baseDir, `nodelink-stream-rt-${uidPart}`)

  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(runtimeDir, 0o700)
  } catch {}
  cleanupStaleUnixSockets(runtimeDir)

  return {
    socketPath: path.join(
      runtimeDir,
      `stream-transport-${process.pid}-${randomSuffix}.sock`
    ),
    runtimeDir
  }
}

export interface StreamTransportServerOptions {
  socketPath?: string
  runtimeDir?: string
  authTimeoutMs?: number
  handshakeTimeoutMs?: number
  maxRecordPayloadBytes?: number
  globalReserveBudgetBytes?: number
  defaultWatermarks?: Partial<StreamReserveWatermarks>
}

export interface CreatedStreamSession {
  readonly streamIdHex: string
  readonly streamIdBytes: Buffer
  readonly securityTokenBytes: Buffer
  readonly socketPath: string
  readonly stream: StreamReserveBuffer
  cancel: () => void
  getMetrics: () => StreamTransportMetricsSnapshot
}

export class StreamTransportServer {
  public readonly socketPath: string
  public readonly registry: StreamRegistry
  public readonly globalBudget: GlobalReserveBudget

  private readonly runtimeDir: string | null
  private readonly handshakeTimeoutMs: number
  private readonly maxRecordPayloadBytes: number
  private readonly defaultWatermarks?: Partial<StreamReserveWatermarks>
  private readonly processExitListener: () => void

  private server: net.Server | null = null
  private readonly activeSockets: Set<net.Socket> = new Set()
  private readonly completedMetricsHistory: Map<
    string,
    StreamTransportMetricsSnapshot
  > = new Map()
  private isClosed = false
  private exitHookRegistered = false

  private totalAcceptedStreams = 0
  private rejectedConnections = 0
  private unauthorizedAttempts = 0
  private protocolErrors = 0
  private unexpectedDisconnects = 0
  private lastRejectReason: StreamAuthRejectReason | string | null = null

  constructor(options: StreamTransportServerOptions = {}) {
    if (options.socketPath) {
      if (!isLocalSocketEndpoint(options.socketPath)) {
        throw new Error(
          `Invalid stream transport endpoint '${options.socketPath}': external endpoints forbidden`
        )
      }
      this.socketPath = options.socketPath
      this.runtimeDir =
        options.runtimeDir ??
        (!IS_WINDOWS ? path.dirname(path.resolve(options.socketPath)) : null)
    } else {
      const created = createDefaultSocketEndpoint(options.runtimeDir)
      this.socketPath = created.socketPath
      this.runtimeDir = created.runtimeDir
    }

    this.registry = new StreamRegistry(
      options.authTimeoutMs ?? DEFAULT_STREAM_AUTH_TIMEOUT_MS
    )
    this.globalBudget = new GlobalReserveBudget(
      options.globalReserveBudgetBytes ?? DEFAULT_GLOBAL_RESERVE_BUDGET_BYTES
    )
    this.handshakeTimeoutMs = Math.max(100, options.handshakeTimeoutMs ?? 5000)
    this.maxRecordPayloadBytes =
      options.maxRecordPayloadBytes ?? DEFAULT_MAX_RECORD_PAYLOAD_BYTES
    this.defaultWatermarks = options.defaultWatermarks
    this.processExitListener = () => this._cleanupSocketFilesSync()
  }

  public get isListening(): boolean {
    return Boolean(this.server?.listening)
  }

  public async start(): Promise<void> {
    if (this.server?.listening) return
    this.isClosed = false

    this._cleanupSocketFilesSync()

    if (!IS_WINDOWS && this.runtimeDir) {
      fs.mkdirSync(this.runtimeDir, { recursive: true, mode: 0o700 })
      try {
        fs.chmodSync(this.runtimeDir, 0o700)
      } catch {}
    }

    this._registerExitHook()

    this.server = net.createServer({ allowHalfOpen: false }, (socket) => {
      this._handleConnection(socket)
    })

    await new Promise<void>((resolve, reject) => {
      const srv = this.server
      if (!srv) {
        reject(new Error('StreamTransportServer not initialized'))
        return
      }
      const onStartupError = (err: Error) => {
        this._unregisterExitHook()
        this._cleanupSocketFilesSync()
        reject(err)
      }
      srv.once('error', onStartupError)
      srv.listen({ path: this.socketPath, exclusive: true }, () => {
        srv.removeListener('error', onStartupError)
        srv.on('error', (err: Error) => {
          logger('error', 'StreamTransport', `Server error: ${err.message}`)
        })
        if (!IS_WINDOWS) {
          try {
            fs.chmodSync(this.socketPath, 0o600)
          } catch {}
        }
        logger(
          'info',
          'StreamTransport',
          `Listening for binary streams via ${TRANSPORT_KIND} at ${this.socketPath}`
        )
        resolve()
      })
    })
  }

  public createStreamSession(options: {
    playerId: string
    watermarks?: Partial<StreamReserveWatermarks>
    estimatedBitrateBps?: number
    authTimeoutMs?: number
    onCancel?: () => void
  }): CreatedStreamSession {
    if (this.isClosed || !this.server?.listening) {
      throw new Error('StreamTransportServer is not listening')
    }

    let activeRegistration: StreamRegistration | null = null
    let cancelledByPlayer = false

    const reserveBuffer = new StreamReserveBuffer({
      streamId: 'pending',
      playerId: options.playerId,
      watermarks: options.watermarks ?? this.defaultWatermarks,
      estimatedBitrateBps: options.estimatedBitrateBps,
      globalBudget: this.globalBudget,
      onPauseTransport: () => {
        const sock = activeRegistration?.socket
        if (sock && !sock.destroyed) sock.pause()
      },
      onResumeTransport: () => {
        const sock = activeRegistration?.socket
        if (sock && !sock.destroyed) sock.resume()
      },
      onPlayerClose: () => {
        if (cancelledByPlayer) return
        cancelledByPlayer = true
        if (activeRegistration) {
          this._saveMetricsSnapshot(
            activeRegistration.streamIdHex,
            reserveBuffer
          )
          const sock = activeRegistration.socket
          if (sock && !sock.destroyed && sock.writable) {
            try {
              sock.write(encodeRecord(StreamRecordType.CANCEL))
            } catch {}
          }
          this.registry.cancel(activeRegistration.streamIdHex)
        }
        options.onCancel?.()
      }
    })

    const credentials = this.registry.register({
      playerId: options.playerId,
      reserveStream: reserveBuffer,
      authTimeoutMs: options.authTimeoutMs
    })

    activeRegistration = credentials.registration
    reserveBuffer.streamId = credentials.streamIdHex

    const cancel = () => {
      if (cancelledByPlayer) return
      cancelledByPlayer = true
      this._saveMetricsSnapshot(credentials.streamIdHex, reserveBuffer)
      const sock = credentials.registration.socket
      if (sock && !sock.destroyed && sock.writable) {
        try {
          sock.write(encodeRecord(StreamRecordType.CANCEL))
        } catch {}
      }
      this.registry.cancel(credentials.streamIdHex)
      if (!reserveBuffer.destroyed) reserveBuffer.destroy()
      options.onCancel?.()
    }

    return {
      streamIdHex: credentials.streamIdHex,
      streamIdBytes: credentials.streamIdBytes,
      securityTokenBytes: credentials.securityTokenBytes,
      socketPath: this.socketPath,
      stream: reserveBuffer,
      cancel,
      getMetrics: () => reserveBuffer.getMetricsSnapshot()
    }
  }

  public getStreamMetrics(
    streamIdHex: string
  ): StreamTransportMetricsSnapshot | null {
    const active = this.registry.get(streamIdHex)
    if (active) return active.reserveStream.getMetricsSnapshot()
    return this.completedMetricsHistory.get(streamIdHex) ?? null
  }

  public getStats() {
    return {
      socketPath: this.socketPath,
      listening: this.isListening,
      activeRegistrations: this.registry.size,
      activeSockets: this.activeSockets.size,
      totalAcceptedStreams: this.totalAcceptedStreams,
      rejectedConnections: this.rejectedConnections,
      unauthorizedAttempts: this.unauthorizedAttempts,
      protocolErrors: this.protocolErrors,
      unexpectedDisconnects: this.unexpectedDisconnects,
      lastRejectReason: this.lastRejectReason,
      globalReserveUsedBytes: this.globalBudget.usedBytes,
      globalReservePeakBytes: this.globalBudget.peakBytes,
      globalReserveLimitBytes: this.globalBudget.limitBytes
    }
  }

  public async stop(): Promise<void> {
    this.isClosed = true
    this._unregisterExitHook()
    this.registry.clearAll()
    for (const sock of this.activeSockets) {
      if (!sock.destroyed) sock.destroy()
    }
    this.activeSockets.clear()
    if (this.server) {
      const srv = this.server
      this.server = null
      if (srv.listening) {
        await new Promise<void>((resolve) => srv.close(() => resolve()))
      }
    }
    this._cleanupSocketFilesSync()
  }

  private _handleConnection(socket: net.Socket): void {
    this.activeSockets.add(socket)
    let registration: StreamRegistration | null = null
    let terminalHandled = false
    let handshakeTimer: NodeJS.Timeout | null = setTimeout(() => {
      handshakeTimer = null
      if (!registration) {
        this.rejectedConnections++
        this.unauthorizedAttempts++
        this.lastRejectReason = 'HANDSHAKE_TIMEOUT'
        socket.destroy()
      }
    }, this.handshakeTimeoutMs)
    handshakeTimer.unref?.()

    const clearHandshakeTimer = () => {
      if (handshakeTimer) {
        clearTimeout(handshakeTimer)
        handshakeTimer = null
      }
    }

    const parser = new StreamTransportParser(
      {
        onHandshake: (handshake: ParsedHandshake): boolean => {
          clearHandshakeTimer()
          const auth = this.registry.authenticate(
            handshake.streamIdBytes,
            handshake.securityTokenBytes,
            socket
          )
          handshake.securityTokenBytes.fill(0)

          if (!auth.authorized) {
            this.rejectedConnections++
            this.unauthorizedAttempts++
            this.lastRejectReason = auth.reason
            try {
              socket.write(
                encodeErrorRecord(
                  StreamErrorCode.UNAUTHORIZED,
                  `Unauthorized: ${auth.reason}`
                )
              )
            } catch {}
            socket.destroy()
            return false
          }

          this.totalAcceptedStreams++
          registration = auth.registration
          logger(
            'info',
            'StreamTransport',
            `Accepted ${TRANSPORT_KIND} stream [streamId=${registration.streamIdHex}, player=${registration.playerId}]`
          )
          if (registration.reserveStream.isTransportPaused) {
            socket.pause()
          }
          return true
        },
        onRecord: (record: ParsedStreamRecord): void => {
          if (!registration) {
            this.rejectedConnections++
            socket.destroy()
            return
          }
          const reserve = registration.reserveStream
          if (reserve.destroyed) {
            socket.destroy()
            return
          }
          if (record.type === StreamRecordType.DATA) {
            reserve.enqueueChunk(record.payload)
          } else if (record.type === StreamRecordType.END) {
            terminalHandled = true
            this._saveMetricsSnapshot(registration.streamIdHex, reserve)
            const snap = reserve.getMetricsSnapshot()
            logger(
              'debug',
              'StreamTransport',
              `Completed ${TRANSPORT_KIND} stream [streamId=${registration.streamIdHex}, player=${registration.playerId}, bytes=${snap.bytesReceived}, pauses=${snap.pauseCount}]`
            )
            this.registry.markEnded(registration.streamIdHex)
            reserve.signalEnd()
            socket.end()
          } else if (record.type === StreamRecordType.ERROR) {
            terminalHandled = true
            this._saveMetricsSnapshot(registration.streamIdHex, reserve)
            logger(
              'warn',
              'StreamTransport',
              `Errored ${TRANSPORT_KIND} stream [streamId=${registration.streamIdHex}, player=${registration.playerId}]: ${record.errorMessage || 'Upstream stream error'}`
            )
            this.registry.markErrored(registration.streamIdHex)
            reserve.signalError(
              new Error(record.errorMessage || 'Upstream stream error')
            )
            socket.destroy()
          }
        },
        onProtocolError: (error: StreamProtocolError): void => {
          clearHandshakeTimer()
          this.protocolErrors++
          this.rejectedConnections++
          this.lastRejectReason = error.message
          terminalHandled = true
          if (registration) {
            this._saveMetricsSnapshot(
              registration.streamIdHex,
              registration.reserveStream
            )
            this.registry.markErrored(registration.streamIdHex)
            registration.reserveStream.signalError(error, {
              isProtocolError: true
            })
          }
          socket.destroy()
        }
      },
      this.maxRecordPayloadBytes
    )

    socket.on('data', (chunk: Buffer) => parser.push(chunk))
    socket.on('error', (err: Error) => {
      clearHandshakeTimer()
      if (registration && !terminalHandled) {
        terminalHandled = true
        this.unexpectedDisconnects++
        this._saveMetricsSnapshot(
          registration.streamIdHex,
          registration.reserveStream
        )
        this.registry.markErrored(registration.streamIdHex)
        registration.reserveStream.signalError(err, {
          isUnexpectedDisconnect: true
        })
      }
    })
    socket.on('close', () => {
      clearHandshakeTimer()
      this.activeSockets.delete(socket)
      parser.reset()
      if (registration && !terminalHandled) {
        if (
          registration.state !== 'cancelled' &&
          registration.state !== 'ended'
        ) {
          terminalHandled = true
          this.unexpectedDisconnects++
          this._saveMetricsSnapshot(
            registration.streamIdHex,
            registration.reserveStream
          )
          this.registry.markErrored(registration.streamIdHex)
          registration.reserveStream.signalError(
            new Error(
              `Unexpected disconnect before END (${registration.streamIdHex})`
            ),
            { isUnexpectedDisconnect: true }
          )
        }
      }
    })
  }

  private _saveMetricsSnapshot(
    streamIdHex: string,
    reserve: StreamReserveBuffer
  ): void {
    if (this.completedMetricsHistory.size >= 500) {
      const oldest = this.completedMetricsHistory.keys().next().value
      if (oldest) this.completedMetricsHistory.delete(oldest)
    }
    this.completedMetricsHistory.set(streamIdHex, reserve.getMetricsSnapshot())
  }

  private _registerExitHook(): void {
    if (this.exitHookRegistered || IS_WINDOWS) return
    this.exitHookRegistered = true
    process.once('exit', this.processExitListener)
  }

  private _unregisterExitHook(): void {
    if (!this.exitHookRegistered) return
    this.exitHookRegistered = false
    process.removeListener('exit', this.processExitListener)
  }

  private _cleanupSocketFilesSync(): void {
    if (IS_WINDOWS || !this.socketPath) return
    try {
      if (fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath)
    } catch {}
    if (this.runtimeDir) {
      cleanupStaleUnixSockets(this.runtimeDir)
      try {
        if (fs.readdirSync(this.runtimeDir).length === 0) {
          fs.rmdirSync(this.runtimeDir)
        }
      } catch {}
    }
  }
}

export interface StreamTransportClientOptions {
  socketPath: string
  streamIdBytes: Buffer
  securityTokenBytes: Buffer
  sourceStream: Readable
  maxRecordPayloadBytes?: number
  artificialDelayMs?: number
  onCancel?: () => void
}

export interface StreamTransportClientStats {
  streamIdHex: string
  bytesProduced: number
  bytesTransmitted: number
  dataRecordCount: number
  pauseCount: number
  resumeCount: number
  backpressureWaitMs: number
  cancelled: boolean
  completedNormally: boolean
  errorMessage: string | null
}

export class StreamTransportClient {
  public readonly streamIdHex: string
  private readonly socketPath: string
  private readonly streamIdBytes: Buffer
  private readonly securityTokenBytes: Buffer
  private readonly sourceStream: Readable
  private readonly maxRecordPayloadBytes: number
  private readonly artificialDelayMs: number
  private readonly onCancel?: () => void

  private socket: net.Socket | null = null
  private cancelled = false
  private completedNormally = false
  private remoteErrorMessage: string | null = null

  private bytesProduced = 0
  private bytesTransmitted = 0
  private dataRecordCount = 0
  private pauseCount = 0
  private resumeCount = 0
  private backpressureWaitMs = 0

  constructor(options: StreamTransportClientOptions) {
    if (!isLocalSocketEndpoint(options.socketPath)) {
      throw new Error(
        `Invalid stream transport endpoint '${options.socketPath}'`
      )
    }
    this.socketPath = options.socketPath
    this.streamIdBytes = Buffer.from(options.streamIdBytes)
    this.streamIdHex = this.streamIdBytes.toString('hex')
    this.securityTokenBytes = Buffer.from(options.securityTokenBytes)
    this.sourceStream = options.sourceStream
    this.maxRecordPayloadBytes =
      options.maxRecordPayloadBytes ?? DEFAULT_MAX_RECORD_PAYLOAD_BYTES
    this.artificialDelayMs = Math.max(0, options.artificialDelayMs ?? 0)
    this.onCancel = options.onCancel
  }

  public getStats(): StreamTransportClientStats {
    return {
      streamIdHex: this.streamIdHex,
      bytesProduced: this.bytesProduced,
      bytesTransmitted: this.bytesTransmitted,
      dataRecordCount: this.dataRecordCount,
      pauseCount: this.pauseCount,
      resumeCount: this.resumeCount,
      backpressureWaitMs: Number(this.backpressureWaitMs.toFixed(2)),
      cancelled: this.cancelled,
      completedNormally: this.completedNormally,
      errorMessage: this.remoteErrorMessage
    }
  }

  public cancel(): void {
    if (this.cancelled) return
    this.cancelled = true
    if (!this.sourceStream.destroyed) this.sourceStream.destroy()
    if (this.socket && !this.socket.destroyed) this.socket.destroy()
    this.onCancel?.()
  }

  public async run(): Promise<StreamTransportClientStats> {
    const handshakeFrame = encodeHandshake(
      this.streamIdBytes,
      this.securityTokenBytes
    )
    this.securityTokenBytes.fill(0)

    let socket: net.Socket | null = null

    try {
      socket = await this._connect()
      this.socket = socket
      this._setupControlReader(socket)

      await this._writeFrame(socket, handshakeFrame)

      for await (const rawChunk of this.sourceStream) {
        if (this.cancelled || socket.destroyed || !socket.writable) break
        const chunk = Buffer.isBuffer(rawChunk)
          ? rawChunk
          : Buffer.from(rawChunk as Uint8Array)
        if (chunk.length === 0) continue

        this.bytesProduced += chunk.length

        if (this.artificialDelayMs > 0) {
          await new Promise<void>((r) => setTimeout(r, this.artificialDelayMs))
          if (this.cancelled || socket.destroyed || !socket.writable) break
        }

        let offset = 0
        while (offset < chunk.length) {
          if (this.cancelled || socket.destroyed || !socket.writable) break
          const sliceLen = Math.min(
            this.maxRecordPayloadBytes,
            chunk.length - offset
          )
          const slice =
            offset === 0 && sliceLen === chunk.length
              ? chunk
              : chunk.subarray(offset, offset + sliceLen)
          offset += sliceLen

          const header = encodeRecordHeader(StreamRecordType.DATA, slice.length)
          socket.cork()
          socket.write(header)
          const canContinue = socket.write(slice)
          socket.uncork()

          this.bytesTransmitted += slice.length
          this.dataRecordCount++

          if (!canContinue) {
            await this._waitForDrain(socket)
          }
        }
      }

      if (this.remoteErrorMessage) {
        throw new Error(this.remoteErrorMessage)
      }

      if (!this.cancelled && !socket.destroyed && socket.writable) {
        await this._writeFrame(socket, encodeRecord(StreamRecordType.END))
        this.completedNormally = true
        await this._gracefulEnd(socket)
      }
    } catch (err) {
      const errorMsg = (err as Error).message || 'Upstream source error'
      this.remoteErrorMessage = errorMsg
      if (!this.cancelled && socket && !socket.destroyed && socket.writable) {
        try {
          socket.write(
            encodeErrorRecord(StreamErrorCode.UPSTREAM_ERROR, errorMsg)
          )
          await this._gracefulEnd(socket)
        } catch {}
      }
      if (!this.sourceStream.destroyed) this.sourceStream.destroy()
      if (socket && !socket.destroyed) socket.destroy()
      throw err
    } finally {
      if (!this.sourceStream.destroyed) this.sourceStream.destroy()
    }

    return this.getStats()
  }

  private _connect(): Promise<net.Socket> {
    return new Promise<net.Socket>((resolve, reject) => {
      let settled = false
      const socket = net.createConnection(this.socketPath, () => {
        if (settled) return
        settled = true
        socket.removeListener('error', onErr)
        resolve(socket)
      })
      const onErr = (err: Error) => {
        if (settled) return
        settled = true
        reject(err)
      }
      socket.once('error', onErr)
    })
  }

  private _setupControlReader(socket: net.Socket): void {
    let controlBuf: Buffer = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      controlBuf =
        controlBuf.length === 0 ? chunk : Buffer.concat([controlBuf, chunk])
      while (controlBuf.length >= STREAM_RECORD_HEADER_SIZE) {
        const recType = controlBuf.readUInt8(0)
        const payloadLen = controlBuf.readUInt32BE(1)
        const total = STREAM_RECORD_HEADER_SIZE + payloadLen
        if (controlBuf.length < total) break
        const payload = controlBuf.subarray(STREAM_RECORD_HEADER_SIZE, total)
        controlBuf = controlBuf.subarray(total)

        if (recType === StreamRecordType.CANCEL) {
          this.cancel()
          return
        }
        if (recType === StreamRecordType.ERROR) {
          this.remoteErrorMessage = decodeErrorPayload(payload).errorMessage
          if (!this.sourceStream.destroyed) this.sourceStream.destroy()
          socket.destroy()
          return
        }
      }
    })
    socket.on('error', (err: Error) => {
      if (!this.remoteErrorMessage) this.remoteErrorMessage = err.message
      if (!this.sourceStream.destroyed) this.sourceStream.destroy()
    })
    socket.on('close', () => {
      if (
        !this.completedNormally &&
        !this.cancelled &&
        !this.sourceStream.destroyed
      ) {
        this.sourceStream.destroy()
      }
    })
  }

  private _writeFrame(socket: net.Socket, frame: Buffer): Promise<void> {
    if (this.cancelled || socket.destroyed || !socket.writable) {
      return Promise.resolve()
    }
    return socket.write(frame)
      ? Promise.resolve()
      : this._waitForDrain(socket)
  }

  private _waitForDrain(socket: net.Socket): Promise<void> {
    if (this.cancelled || socket.destroyed || !socket.writable) {
      return Promise.resolve()
    }
    this.pauseCount++
    const pauseStart = performance.now()

    return new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        socket.removeListener('drain', done)
        socket.removeListener('close', done)
        socket.removeListener('error', done)
        this.backpressureWaitMs += performance.now() - pauseStart
        this.resumeCount++
        resolve()
      }
      socket.once('drain', done)
      socket.once('close', done)
      socket.once('error', done)
    })
  }

  private _gracefulEnd(socket: net.Socket): Promise<void> {
    if (socket.destroyed || socket.writableEnded) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        socket.removeListener('finish', done)
        socket.removeListener('close', done)
        socket.removeListener('error', done)
        resolve()
      }
      socket.once('finish', done)
      socket.once('close', done)
      socket.once('error', done)
      socket.end()
    })
  }
}
