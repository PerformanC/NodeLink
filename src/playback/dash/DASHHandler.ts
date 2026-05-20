import { Transform, type TransformCallback } from 'node:stream'
import type {
  DASHHandlerOptions,
  DASHRepresentation
} from '../../typings/playback/dash.types.ts'
import { logger, makeRequest } from '../../utils.ts'

const PREFETCH_COUNT = 4
const MAX_BUFFERED = 16 * 1024

/**
 * Fetches and parses a DASH MPD manifest, then streams fMP4 segments.
 * Selects AACLC representation (skips FLAC which has broken metadata extraction).
 * Uses a bounded prefetch queue with backpressure to minimize memory usage.
 * Skips segments before startTime to avoid wasted downloads on seek.
 */
export class DASHHandler extends Transform {
  private readonly mpdUrl: string
  private readonly options: DASHHandlerOptions
  private stopped = false
  private abortController: AbortController | null = null
  private readonly readWaiters: Array<() => void> = []

  constructor(mpdUrl: string, options: DASHHandlerOptions = {}) {
    super()
    this.mpdUrl = mpdUrl
    this.options = options
  }

  override _transform(
    _chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    callback()
  }

  override _read(size: number): void {
    super._read(size)
    this._resolveReadWaiters()
  }

  override _destroy(
    err: Error | null,
    callback: (error?: Error | null) => void
  ): void {
    this.stop()
    callback(err)
  }

  private _resolveReadWaiters(): void {
    const waiters = this.readWaiters.splice(0)
    for (const resolve of waiters) resolve()
  }

  /**
   * Fetch the MPD, parse representations, select AACLC, and stream segments.
   * Uses a bounded prefetch queue with backpressure to keep memory minimal.
   * Skips segments before startTime to avoid wasted bandwidth on seek.
   */
  async start(): Promise<void> {
    this.abortController = new AbortController()
    const { signal } = this.abortController

    try {
      const mpdRes = await makeRequest(this.mpdUrl, {
        headers: this.options.headers,
        method: 'GET',
        localAddress: this.options.localAddress
      })

      if (
        mpdRes.error ||
        mpdRes.statusCode !== 200 ||
        typeof mpdRes.body !== 'string'
      ) {
        const err = new Error(
          `MPD fetch failed: ${mpdRes.error || mpdRes.statusCode}`
        )
        logger('error', 'DASHHandler', err.message)
        this.destroy(err)
        return
      }

      const representations = this._parseRepresentations(mpdRes.body)
      const selected = this._selectRepresentation(representations)

      if (!selected) {
        const err = new Error('No suitable audio representation found in MPD')
        logger('error', 'DASHHandler', err.message)
        this.destroy(err)
        return
      }

      logger(
        'debug',
        'DASHHandler',
        `Selected: id=${selected.id}, codecs=${selected.codecs}, bandwidth=${selected.bandwidth}`
      )

      const initRes = await makeRequest(selected.initUrl, {
        headers: this.options.headers,
        method: 'GET',
        localAddress: this.options.localAddress,
        responseType: 'buffer'
      })

      if (
        initRes.error ||
        initRes.statusCode !== 200 ||
        !Buffer.isBuffer(initRes.body)
      ) {
        const err = new Error(
          `Init segment fetch failed: ${initRes.error || initRes.statusCode}`
        )
        logger('error', 'DASHHandler', err.message)
        this.destroy(err)
        return
      }

      await this._pushChunk(initRes.body)

      const totalSegments = this._countSegments(selected)
      const segmentUrlGen = this._generateSegmentUrls(selected)
      const segmentDuration = this._calcSegmentDuration(selected)

      let skipSegments = 0
      if (
        this.options.startTime &&
        this.options.startTime > 0 &&
        segmentDuration > 0
      ) {
        skipSegments = Math.floor(
          this.options.startTime / (segmentDuration * 1000)
        )
        if (skipSegments >= totalSegments) skipSegments = totalSegments - 1
        if (skipSegments < 0) skipSegments = 0
      }

      logger(
        'debug',
        'DASHHandler',
        `Total segments: ${totalSegments}, prefetch: ${PREFETCH_COUNT}, skip: ${skipSegments}`
      )

      const fetchQueue: Array<Promise<Buffer | null>> = []
      let fetchIndex = 0
      let pushIndex = 0

      const fetchSegment = async (url: string): Promise<Buffer | null> => {
        try {
          const res = await fetch(url, {
            headers: this.options.headers as Record<string, string>,
            signal
          })
          if (!res.ok || !res.body) {
            logger(
              'error',
              'DASHHandler',
              `Segment fetch failed: HTTP ${res.status}`
            )
            return null
          }
          const arrayBuf = await res.arrayBuffer()
          if (this.stopped || signal.aborted) return null
          return Buffer.from(arrayBuf)
        } catch {
          return null
        }
      }

      while (fetchIndex < skipSegments && fetchIndex < totalSegments) {
        segmentUrlGen.next()
        fetchIndex++
      }

      while (fetchQueue.length < PREFETCH_COUNT && fetchIndex < totalSegments) {
        const url = segmentUrlGen.next().value
        if (url) fetchQueue.push(fetchSegment(url))
        fetchIndex++
      }

      for (let i = skipSegments; i < totalSegments; i++) {
        if (this.stopped || signal.aborted) return

        await this._waitForBuffer()
        if (this.stopped || signal.aborted) return

        const pending = fetchQueue.shift()
        if (!pending) break

        const data = await pending
        if (data && !this.stopped && !signal.aborted) {
          await this._pushChunk(data)
        }

        if (fetchIndex < totalSegments) {
          const url = segmentUrlGen.next().value
          if (url) fetchQueue.push(fetchSegment(url))
          fetchIndex++
        }

        pushIndex++

        if (segmentDuration > 0 && pushIndex < totalSegments) {
          const paceMs = Math.min(segmentDuration * 1000 * 0.8, 5000)
          await this._sleepOrStop(paceMs)
        }
      }

      logger(
        'debug',
        'DASHHandler',
        `All ${pushIndex} segments pushed (skipped ${skipSegments}), ending stream`
      )
      this.push(null)
      this.emit('finishBuffering')
    } catch (err) {
      if (!signal.aborted) {
        logger(
          'error',
          'DASHHandler',
          `Stream error: ${(err as Error).message}`
        )
        this.destroy(err as Error)
      }
    }
  }

  stop(): void {
    this.stopped = true
    this.abortController?.abort()
    this._resolveReadWaiters()
  }

  private _sleepOrStop(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const check = () => {
        if (this.stopped) {
          resolve()
          return
        }
        setTimeout(check, 50).unref()
      }
      setTimeout(() => {
        resolve()
      }, ms).unref()
      check()
    })
  }

  private async _waitForBuffer(): Promise<void> {
    while (this.readableLength > MAX_BUFFERED && !this.stopped) {
      await this._waitForRead()
    }
  }

  private _pushChunk(chunk: Buffer): Promise<void> {
    if (this.stopped || this.destroyed) return Promise.resolve()
    if (this.push(chunk)) return Promise.resolve()
    return this._waitForRead()
  }

  private _waitForRead(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.readableLength <= MAX_BUFFERED) {
        resolve()
        return
      }
      const cleanup = () => {
        const index = this.readWaiters.indexOf(onRead)
        if (index !== -1) this.readWaiters.splice(index, 1)
        this.off('end', onEnd)
        this.off('close', onEnd)
      }
      const onEnd = () => {
        cleanup()
        resolve()
      }
      const onRead = () => {
        if (this.readableLength <= MAX_BUFFERED) {
          cleanup()
          resolve()
        }
      }
      this.readWaiters.push(onRead)
      this.once('end', onEnd)
      this.once('close', onEnd)
    })
  }

  private *_generateSegmentUrls(
    selected: DASHRepresentation
  ): Generator<string> {
    let segNum = selected.startNumber
    for (const segGroup of selected.segments) {
      for (let r = 0; r <= segGroup.repeat; r++) {
        yield selected.mediaTemplate.replace('$Number$', String(segNum++))
      }
    }
  }

  private _countSegments(selected: DASHRepresentation): number {
    let count = 0
    for (const segGroup of selected.segments) {
      count += segGroup.repeat + 1
    }
    return count
  }

  private _calcSegmentDuration(selected: DASHRepresentation): number {
    if (selected.segments.length === 0) return 0
    const total = selected.segments.reduce(
      (sum, seg) => sum + seg.duration * (seg.repeat + 1),
      0
    )
    const count = this._countSegments(selected)
    return count > 0 ? total / count : 0
  }

  /**
   * Parse MPD XML to extract audio representations.
   */
  private _parseRepresentations(mpdContent: string): DASHRepresentation[] {
    const representations: DASHRepresentation[] = []
    const repRegex = /<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/g

    const decodeHtml = (s: string): string =>
      s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')

    const urlAttr = (tag: string, attr: string): string => {
      const re = new RegExp(`${attr}\\s*=\\s*["']([^"']+)["']`)
      return decodeHtml(tag.match(re)?.[1] ?? '')
    }

    let repMatch: RegExpExecArray | null
    repMatch = repRegex.exec(mpdContent)
    while (repMatch !== null) {
      const repAttrs = repMatch[1] ?? ''
      const repBody = repMatch[2] ?? ''
      const codecs = urlAttr(repAttrs, 'codecs')
      const bandwidth = parseInt(urlAttr(repAttrs, 'bandwidth') || '0', 10)
      const audioSamplingRate = parseInt(
        urlAttr(repAttrs, 'audioSamplingRate') || '44100',
        10
      )
      const id = urlAttr(repAttrs, 'id')

      if (!codecs) {
        repMatch = repRegex.exec(mpdContent)
        continue
      }

      const templateMatch = repBody.match(/<SegmentTemplate\b([^>]*)\/?>/)
      if (!templateMatch) {
        repMatch = repRegex.exec(mpdContent)
        continue
      }

      const templateAttrs = templateMatch[1] ?? ''
      const initUrl = urlAttr(templateAttrs, 'initialization')
      const mediaTemplate = urlAttr(templateAttrs, 'media')
      const startNumber = parseInt(
        urlAttr(templateAttrs, 'startNumber') || '1',
        10
      )
      const timescale = parseInt(
        urlAttr(templateAttrs, 'timescale') || '44100',
        10
      )

      const segments: Array<{ duration: number; repeat: number }> = []
      const sRegex = /<S\b([^>]*)\/?>/g
      let sMatch: RegExpExecArray | null
      sMatch = sRegex.exec(repBody)
      while (sMatch !== null) {
        const sAttrs = sMatch[1] ?? ''
        const d = parseInt(urlAttr(sAttrs, 'd') || '0', 10)
        const r = parseInt(urlAttr(sAttrs, 'r') || '0', 10)
        segments.push({ duration: d / timescale, repeat: r })
        sMatch = sRegex.exec(repBody)
      }

      representations.push({
        id,
        codecs,
        bandwidth,
        audioSamplingRate,
        initUrl,
        mediaTemplate,
        startNumber,
        segments
      })

      repMatch = repRegex.exec(mpdContent)
    }

    return representations
  }

  /**
   * Select the best representation. Skips FLAC, prefers highest bandwidth AAC.
   */
  private _selectRepresentation(
    representations: DASHRepresentation[]
  ): DASHRepresentation | null {
    let best: DASHRepresentation | null = null

    for (const rep of representations) {
      if (rep.codecs === 'flac') continue
      if (!best || rep.bandwidth > best.bandwidth) {
        best = rep
      }
    }

    return best
  }
}
