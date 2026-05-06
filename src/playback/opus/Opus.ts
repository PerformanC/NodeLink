import type { Buffer } from 'node:buffer'
import { createRequire } from 'node:module'
import { Transform } from 'node:stream'
import type {
  OpusApplication,
  OpusDecoderInstance,
  OpusEncoderInstance,
  OpusInstanceResult,
  OpusLibrary
} from '../../typings/playback/opus.types.ts'
import { bufferPool } from '../structs/BufferPool.ts'

const require = createRequire(import.meta.url)

const OPUS_CTL = {
  BITRATE: 4002,
  FEC: 4012,
  PLP: 4014,
  DTX: 4016
}

let ACTIVE_LIB: OpusLibrary | null = null

const _getLib = (): OpusLibrary => {
  if (ACTIVE_LIB) return ACTIVE_LIB
  const libs: Array<{
    name: string
    pick: (mod: Record<string, unknown>) => unknown
  }> = [
    // biome-ignore lint: TypeScript requires bracket access for index signatures
    { name: '@toddynnn/voice-opus', pick: (m) => m['OpusEncoder'] },
    // biome-ignore lint: TypeScript requires bracket access for index signatures
    { name: 'toddy-mediaplex', pick: (m) => m['OpusEncoder'] },
    // biome-ignore lint: TypeScript requires bracket access for index signatures
    { name: '@discordjs/opus', pick: (m) => m['OpusEncoder'] },
    { name: 'opusscript', pick: (m) => m }
  ]

  for (const l of libs) {
    try {
      const mod = require(l.name) as Record<string, unknown>
      const Encoder = l.pick(mod) as OpusLibrary['Encoder']
      if (typeof Encoder === 'function') {
        ACTIVE_LIB = { name: l.name, Encoder }
        return ACTIVE_LIB
      }
    } catch (e: unknown) {
      if (
        e instanceof Error &&
        // biome-ignore lint/complexity/useLiteralKeys: index signature requires bracket access
        (e as unknown as Record<string, unknown>)['code'] !== 'MODULE_NOT_FOUND'
      )
        throw e
    }
  }
  throw new Error('No compatible Opus library found.')
}

const _createInstance = (
  rate: number,
  channels: number,
  app: OpusApplication | number | string
): OpusInstanceResult => {
  const lib = _getLib()
  const { name, Encoder } = lib

  let type: number | string = app
  if (name === 'opusscript' && typeof app === 'string') {
    type =
      Encoder.Application[app.toUpperCase()] ??
      // biome-ignore lint/complexity/useLiteralKeys: index signature requires bracket access
      Encoder.Application['VOIP'] ??
      2048
  }

  return { instance: new Encoder(rate, channels, type), lib }
}

const _applyCtl = (
  enc: OpusEncoderInstance,
  _libName: string,
  id: number,
  val: number
): void => {
  if (!enc) throw new Error('Encoder not ready.')

  if (id === OPUS_CTL.BITRATE) {
    enc.setBitrate(val)
    return
  }

  const fn = enc.applyEncoderCTL || enc.applyEncoderCtl || enc.encoderCTL
  if (typeof fn === 'function') fn.call(enc, id, val)
}

export class Encoder extends Transform {
  private enc: OpusEncoderInstance | null
  private lib: OpusLibrary
  private frameSize: number
  private frameBytes: number
  private leftover: Buffer | null

  constructor({
    rate = 48000,
    channels = 2,
    frameSize = 960,
    application = 'audio'
  }: {
    rate?: number
    channels?: number
    frameSize?: number
    application?: OpusApplication | number | string
  } = {}) {
    super({ readableObjectMode: true })

    const { instance, lib } = _createInstance(rate, channels, application)
    this.enc = instance as OpusEncoderInstance
    this.lib = lib
    this.frameSize = frameSize
    this.frameBytes = frameSize * channels * 2
    this.leftover = null
  }

  override _transform(
    chunk: Buffer,
    _encoding: string,
    cb: (err?: Error) => void
  ): void {
    if (!chunk?.length) {
      cb()
      return
    }
    if (!this.enc) {
      cb(new Error('Encoder destroyed.'))
      return
    }

    let buf: Buffer
    let pooledBuf: Buffer | null = null

    if (this.leftover?.length) {
      const totalLen = this.leftover.length + chunk.length
      pooledBuf = bufferPool.acquire(totalLen)
      this.leftover.copy(pooledBuf, 0)
      chunk.copy(pooledBuf, this.leftover.length)
      bufferPool.release(this.leftover)
      this.leftover = null
      buf = pooledBuf
    } else {
      buf = chunk
    }

    const frames = Math.floor(buf.length / this.frameBytes)
    const consumed = frames * this.frameBytes

    for (let i = 0; i < frames; i++) {
      const off = i * this.frameBytes
      const frame = buf.subarray(off, off + this.frameBytes)

      try {
        const encoded =
          this.lib.name === 'opusscript'
            ? this.enc.encode(frame, this.frameSize)
            : this.enc.encode(frame)

        this.push(encoded)
      } catch (e) {
        this.leftover = null
        if (pooledBuf) bufferPool.release(pooledBuf)
        cb(e instanceof Error ? e : new Error(String(e)))
        return
      }
    }

    if (consumed < buf.length) {
      const remaining = buf.subarray(consumed)
      this.leftover = bufferPool.acquire(remaining.length)
      remaining.copy(this.leftover, 0, 0, remaining.length)
    }

    // Release the temporary concatenation buffer back to the pool
    if (pooledBuf) bufferPool.release(pooledBuf)
    cb()
  }

  override _flush(cb: (err?: Error) => void): void {
    if (this.leftover) {
      bufferPool.release(this.leftover)
      this.leftover = null
    }
    cb()
  }

  override _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    if (this.lib.name === 'opusscript' && this.enc && this.enc.delete) {
      this.enc.delete()
    }
    this.enc = null
    if (this.leftover) {
      bufferPool.release(this.leftover)
      this.leftover = null
    }
    cb(err)
  }

  setBitrate(v: number): void {
    const val = v < 500 ? 500 : v > 512000 ? 512000 : v
    if (this.enc) _applyCtl(this.enc, this.lib.name, OPUS_CTL.BITRATE, val)
  }

  setFEC(enabled = true): void {
    if (this.enc)
      _applyCtl(this.enc, this.lib.name, OPUS_CTL.FEC, enabled ? 1 : 0)
  }

  setPLP(percent: number): void {
    const p = percent <= 1 ? percent * 100 : percent
    const val = p < 0 ? 0 : p > 100 ? 100 : Math.round(p)
    if (this.enc) _applyCtl(this.enc, this.lib.name, OPUS_CTL.PLP, val)
  }

  setDTX(enabled = false): void {
    if (this.enc)
      _applyCtl(this.enc, this.lib.name, OPUS_CTL.DTX, enabled ? 1 : 0)
  }
}

export class Decoder extends Transform {
  private dec: OpusDecoderInstance | null
  private lib: OpusLibrary

  constructor({
    rate = 48000,
    channels = 2
  }: { rate?: number; channels?: number } = {}) {
    super({ readableObjectMode: false })
    const { instance, lib } = _createInstance(rate, channels, 'voip')
    this.dec = instance as OpusDecoderInstance
    this.lib = lib
  }

  override _transform(
    chunk: Buffer,
    _encoding: string,
    cb: (err?: Error) => void
  ): void {
    try {
      if (!this.dec) throw new Error('Decoder not ready.')
      this.push(this.dec.decode(chunk))
      cb()
    } catch (e) {
      cb(e instanceof Error ? e : new Error(String(e)))
    }
  }

  override _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    if (this.lib.name === 'opusscript' && this.dec && this.dec.delete) {
      this.dec.delete()
    }
    this.dec = null
    cb(err)
  }
}
