import type { Readable } from 'node:stream'
import { PassThrough } from 'node:stream'
import type {
  HLSFetchStrategy,
  HLSHandlerOptions,
  HLSMediaPlaylist,
  HLSPlaylist,
  HLSSegment,
  HLSSegmentFetchResult,
  HLSVariant
} from '../../typings/playback/hls.types.ts'
import { http1makeRequest, logger } from '../../utils.ts'
import { parse as parsePlaylist } from './PlaylistParser.ts'
import SegmentFetcher from './SegmentFetcher.ts'

const MAX_HISTORY = 200
const MAX_GAP = 30
const MASTER_REFRESH_INTERVAL = 3
const LIVE_PRE_ROLL_SEGMENTS = 12
const STUCK_THRESHOLD = 10

/**
 * Handler for HLS (HTTP Live Streaming) playback.
 * Extends PassThrough to provide a unified stream of audio data.
 *
 * @public
 */
export default class HLSHandler extends PassThrough {
  private readonly masterUrl: string
  private currentUrl: string
  private readonly headers: Record<string, string>
  private readonly localAddress: string | null
  private readonly proxy: {
    url: string
    username?: string
    password?: string
  } | null
  private readonly onResolveUrl:
    | ((url: string) => Promise<string | null>)
    | null
  private readonly strategy: HLSFetchStrategy
  private startTime: number
  private readonly fetcher: SegmentFetcher
  private readonly processedSegments: Set<string | number>
  private readonly processedOrder: Array<string | number>
  private segmentQueue: HLSSegment[]
  private readonly maxParallelFetches: number
  private isFetching: boolean
  private stop: boolean
  private lastMapUri: string | null
  private isLive: boolean
  private playlistTimer: NodeJS.Timeout | null
  private readonly activeSegmentStreams: Map<string | number, Readable>
  private lastMediaSequence: number
  private highestSequence: number
  private stuckCount: number
  private preRolled: boolean
  private justResynced: boolean
  private masterRefreshCounter: number

  /**
   * Creates a new HLSHandler.
   *
   * @param url - The master playlist URL.
   * @param options - Configuration options for the handler.
   */
  constructor(url: string, options: HLSHandlerOptions = {}) {
    super({ highWaterMark: options.highWaterMark ?? 256 * 1024 })

    this.masterUrl = url
    this.currentUrl = url
    this.headers = options.headers ?? {}
    this.localAddress = options.localAddress ?? null
    this.proxy = options.network?.proxy ?? options.proxy ?? null
    this.onResolveUrl = options.onResolveUrl ?? null
    this.strategy =
      options.strategy ??
      (options.type?.includes('fmp4') ? 'segmented' : 'streaming')
    this.startTime = (options.startTime ?? 0) / 1000

    this.fetcher = new SegmentFetcher({
      headers: this.headers,
      localAddress: this.localAddress,
      proxy: this.proxy ?? undefined,
      onResolveUrl: this.onResolveUrl ?? undefined
    })

    this.processedSegments = new Set<string | number>()
    this.processedOrder = []
    this.segmentQueue = []
    this.maxParallelFetches =
      this.strategy === 'segmented' ? 3 : this.strategy === 'streaming' ? 2 : 1
    this.isFetching = false
    this.stop = false
    this.lastMapUri = null
    this.isLive = false
    this.playlistTimer = null
    this.activeSegmentStreams = new Map<string | number, Readable>()
    this.lastMediaSequence = -1
    this.highestSequence = -1
    this.stuckCount = 0
    this.preRolled = false
    this.justResynced = false
    this.masterRefreshCounter = 0

    this.on('error', (err: Error) => {
      this.destroy(err)
    })

    this._start().catch((err: Error) => {
      logger('error', 'HLSHandler', `Failed to start: ${err.message}`)
      this.destroy(err)
    })
  }

  /** @internal */
  private async _start(): Promise<void> {
    await this._playlistLoop()
  }

  /**
   * Destroys the handler and cleans up all resources.
   *
   * @param err - Optional error that caused the destruction.
   * @returns This instance.
   */
  override destroy(err?: Error | null): this {
    if (this.stop) return this

    this.stop = true

    if (this.playlistTimer) {
      clearTimeout(this.playlistTimer)
      this.playlistTimer = null
    }

    for (const stream of this.activeSegmentStreams.values()) {
      stream.destroy()
    }
    this.activeSegmentStreams.clear()

    this.segmentQueue = []
    this.processedSegments.clear()
    this.processedOrder.length = 0
    this.lastMediaSequence = -1
    this.highestSequence = -1

    if (!this.destroyed) {
      super.destroy(err ?? undefined)
    }

    return this
  }

  /** @internal */
  private _rememberSegment(key: string | number): boolean {
    if (this.processedSegments.has(key)) return false

    this.processedSegments.add(key)
    this.processedOrder.push(key)

    if (this.processedOrder.length > MAX_HISTORY) {
      const oldest = this.processedOrder.shift()
      if (oldest !== undefined) {
        this.processedSegments.delete(oldest)
      }
    }

    return true
  }

  /** @internal */
  private async _playlistLoop(): Promise<void> {
    if (this.stop) return

    try {
      const response = await http1makeRequest(this.currentUrl, {
        headers: this.headers,
        method: 'GET',
        localAddress: this.localAddress ?? undefined,
        proxy: this.proxy ?? undefined
      })

      const { body: playlistContent, error, statusCode } = response

      if (error || statusCode !== 200) {
        if (statusCode === 403 || statusCode === 410) {
          if (this.currentUrl !== this.masterUrl) {
            this.currentUrl = this.masterUrl
            this.justResynced = true
            setImmediate(() => this._playlistLoop())
            return
          }
        }
        throw new Error(`Playlist fetch failed: ${statusCode}`)
      }

      let parsed: HLSPlaylist
      try {
        parsed = parsePlaylist(playlistContent as string, this.currentUrl)
      } catch (e) {
        if (this.currentUrl !== this.masterUrl) {
          this.currentUrl = this.masterUrl
          this.justResynced = true
          setImmediate(() => this._playlistLoop())
          return
        }
        throw e
      }

      if (parsed.isMaster) {
        await this._handleMasterPlaylist(parsed)
        return
      }

      await this._handleMediaPlaylist(parsed, playlistContent as string)
    } catch (err) {
      const error = err as Error
      if (!this.isLive) {
        this.destroy(error)
        return
      }
      logger(
        'warn',
        'HLSHandler',
        `Playlist error (retrying): ${error.message}`
      )
      this.playlistTimer = setTimeout(() => this._playlistLoop(), 3000)
    }
  }

  /** @internal */
  private async _handleMasterPlaylist(parsed: HLSPlaylist): Promise<void> {
    if (!parsed.isMaster) return
    const sortedVariants = parsed.variants.sort(
      (a: HLSVariant, b: HLSVariant) => b.bandwidth - a.bandwidth
    )

    const bestVariant =
      sortedVariants.find(
        (v: HLSVariant) =>
          (v.codecs?.includes('mp4a') || v.codecs?.includes('opus')) &&
          !v.codecs?.includes('avc1')
      ) ??
      sortedVariants.find(
        (v: HLSVariant) =>
          v.codecs?.includes('mp4a') || v.codecs?.includes('opus')
      ) ??
      sortedVariants[0]

    if (!bestVariant) {
      throw new Error('No suitable variant found in master playlist')
    }

    logger(
      'debug',
      'HLSHandler',
      `Selected variant bandwidth: ${bestVariant.bandwidth}, codecs: ${bestVariant.codecs}`
    )

    if (bestVariant.audio && parsed.audioGroups?.[bestVariant.audio]) {
      const group = parsed.audioGroups[bestVariant.audio] as Array<{
        default?: string
        autoselect?: string
        uri?: string
      }>
      const audioRendition =
        group.find((r) => r.default === 'YES') ??
        group.find((r) => r.autoselect === 'YES') ??
        group[0]

      if (audioRendition?.uri) {
        this.currentUrl = audioRendition.uri
        setImmediate(() => this._playlistLoop())
        return
      }
    }

    this.currentUrl = bestVariant.url
    setImmediate(() => this._playlistLoop())
  }

  /** @internal */
  private async _handleMediaPlaylist(
    parsed: HLSMediaPlaylist,
    playlistContent: string
  ): Promise<void> {
    this.isLive = parsed.isLive

    logger(
      'debug',
      'HLSHandler',
      `Processing playlist. Live: ${this.isLive}, Segments: ${parsed.segments.length}, startTime: ${this.startTime}s`
    )

    if (
      this.startTime > 0 &&
      !this.isLive &&
      this.processedSegments.size === 0
    ) {
      this._handleStartTime(parsed)
    }

    if (
      this.lastMediaSequence !== -1 &&
      (parsed.mediaSequence < this.lastMediaSequence ||
        parsed.mediaSequence > this.lastMediaSequence + MAX_GAP)
    ) {
      if (this.isLive) {
        logger(
          'warn',
          'HLSHandler',
          `Playlist sequence discontinuity (${this.lastMediaSequence} -> ${parsed.mediaSequence}). Resetting to live edge.`
        )
        this.segmentQueue = []
        this.processedSegments.clear()
        this.processedOrder.length = 0
        this.highestSequence = -1
        this.preRolled = false
        this.justResynced = true
      }
    }
    this.lastMediaSequence = parsed.mediaSequence

    if (this.isLive && ++this.masterRefreshCounter >= MASTER_REFRESH_INTERVAL) {
      this.masterRefreshCounter = 0
      this.currentUrl = this.masterUrl
      setImmediate(() => this._playlistLoop())
      return
    }

    this._handleLivePreRoll(parsed)

    const newSegments = parsed.segments.filter((s: HLSSegment) => {
      if (s.sequence !== -1 && s.sequence <= this.highestSequence) return false
      const key = s.sequence !== -1 ? s.sequence : s.url
      return !this.processedSegments.has(key)
    })

    if (newSegments.length > 0) {
      this.stuckCount = 0
      for (const segment of newSegments) {
        if (segment.discontinuity && this.isLive) {
          logger(
            'debug',
            'HLSHandler',
            'Discontinuity detected in segment. Clearing queue and re-syncing.'
          )
          this.segmentQueue = []
          this.processedSegments.clear()
          this.processedOrder.length = 0
          this.highestSequence = -1
          this.preRolled = false
          this.justResynced = true
          setImmediate(() => this._playlistLoop())
          return
        }

        const key = segment.sequence !== -1 ? segment.sequence : segment.url
        this._rememberSegment(key)
        this.segmentQueue.push(segment)
        if (
          segment.sequence !== -1 &&
          segment.sequence > this.highestSequence
        ) {
          this.highestSequence = segment.sequence
        }
      }
    } else if (this.isLive) {
      if (++this.stuckCount >= STUCK_THRESHOLD) {
        logger(
          'warn',
          'HLSHandler',
          'No new segments for 10 reloads. Refreshing master playlist.'
        )
        this.stuckCount = 0
        this.currentUrl = this.masterUrl
        this.justResynced = true
        setImmediate(() => this._playlistLoop())
        return
      }
    }

    if (this.segmentQueue.length > 0 && !this.isFetching) {
      this._fetchSegments().catch((err: Error) => {
        logger('error', 'HLSHandler', `Segment fetch error: ${err.message}`)
      })
    }

    if (
      !this.isLive &&
      this.segmentQueue.length === 0 &&
      !this.isFetching &&
      !this.stop &&
      !this.destroyed
    ) {
      this.end()
      return
    }

    if (this.isLive && !playlistContent.includes('#EXT-X-ENDLIST')) {
      this._scheduleNextTick(parsed.targetDuration)
    }
  }

  /** @internal */
  private _handleStartTime(parsed: HLSMediaPlaylist): void {
    let elapsed = 0
    let skippedCount = 0

    for (const seg of parsed.segments) {
      if (elapsed + seg.duration <= this.startTime) {
        elapsed += seg.duration
        const key = seg.sequence !== -1 ? seg.sequence : seg.url
        this.processedSegments.add(key)
        this.processedOrder.push(key)
        if (seg.sequence !== -1 && seg.sequence > this.highestSequence) {
          this.highestSequence = seg.sequence
        }
        skippedCount++
      } else {
        break
      }
    }

    logger(
      'debug',
      'HLSHandler',
      `Skipped ${skippedCount} segments. New elapsed: ${elapsed}s, Target: ${this.startTime}s`
    )
    this.startTime = 0
  }

  /** @internal */
  private _handleLivePreRoll(parsed: HLSMediaPlaylist): void {
    const isFirstLoad = this.processedSegments.size === 0

    if (this.isLive && (isFirstLoad || this.justResynced)) {
      if (this.justResynced) {
        this.processedSegments.clear()
        this.processedOrder.length = 0
        this.highestSequence = -1
      }

      const startIdx = Math.max(
        0,
        parsed.segments.length - LIVE_PRE_ROLL_SEGMENTS
      )
      for (let i = 0; i < startIdx; i++) {
        const seg = parsed.segments[i]
        if (!seg) continue
        const key = seg.sequence !== -1 ? seg.sequence : seg.url
        this.processedSegments.add(key)
        this.processedOrder.push(key)
        if (seg.sequence !== -1 && seg.sequence > this.highestSequence) {
          this.highestSequence = seg.sequence
        }
      }
      this.justResynced = false
    } else {
      this.justResynced = false
    }
  }

  /** @internal */
  private async _fetchWithRetry(
    segment: HLSSegment,
    attempt = 1
  ): Promise<HLSSegmentFetchResult | null> {
    try {
      if (this.strategy === 'segmented') {
        const data = (await this.fetcher.fetchSegment(segment, {
          stream: false
        })) as Buffer
        return { segment, data }
      }
      const stream = (await this.fetcher.fetchSegment(segment, {
        stream: true
      })) as Readable
      return { segment, stream }
    } catch (err) {
      const error = err as Error & { code?: string }
      if (this.stop) return null

      const isRecoverable =
        error.message === 'aborted' ||
        error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT'

      if (isRecoverable && attempt <= 3) {
        const delay = 2 ** attempt * 500
        logger(
          'warn',
          'HLSHandler',
          `Segment fetch failed (attempt ${attempt}/3): ${error.message}. Retrying in ${delay}ms...`
        )
        await new Promise<void>((resolve) => setTimeout(resolve, delay))
        return this._fetchWithRetry(segment, attempt + 1)
      }

      logger(
        'error',
        'HLSHandler',
        `Segment fetch permanently failed ${segment.sequence}: ${error.message}`
      )
      return null
    }
  }

  /** @internal */
  private async _waitForDrain(): Promise<void> {
    if (this.destroyed || this.stop) return

    return new Promise((resolve) => {
      const cleanup = (): void => {
        this.removeListener('drain', onDrain)
        this.removeListener('close', onFinish)
        this.removeListener('error', onFinish)
        resolve()
      }

      const onDrain = (): void => cleanup()
      const onFinish = (): void => cleanup()

      this.once('drain', onDrain)
      this.once('close', onFinish)
      this.once('error', onFinish)
    })
  }

  /** @internal */
  private async _fetchSegments(): Promise<void> {
    if (this.isFetching || this.stop) return

    this.isFetching = true

    const fetchPool = new Map<
      string | number,
      Promise<HLSSegmentFetchResult | null>
    >()

    const fillPool = (): void => {
      while (
        fetchPool.size < this.maxParallelFetches &&
        this.segmentQueue.length > 0
      ) {
        const seg = this.segmentQueue.shift() as HLSSegment
        const key = seg.sequence !== -1 ? seg.sequence : seg.url
        fetchPool.set(key, this._fetchWithRetry(seg))
      }
    }

    while ((this.segmentQueue.length > 0 || fetchPool.size > 0) && !this.stop) {
      fillPool()

      if (
        this.isLive &&
        fetchPool.size === 0 &&
        this.segmentQueue.length === 0 &&
        !this.preRolled
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 500))
        if (this.segmentQueue.length === 0 && fetchPool.size === 0) break
        continue
      }

      if (fetchPool.size === 0) break

      const nextEntry = fetchPool.entries().next()
      if (!nextEntry.value) continue

      const [key, promise] = nextEntry.value as [
        string | number,
        Promise<HLSSegmentFetchResult | null>
      ]
      fetchPool.delete(key)

      const current = await promise
      if (!current) {
        logger('warn', 'HLSHandler', `Skipping failed segment: ${key}`)
        continue
      }

      this.preRolled = true

      try {
        const { segment, data, stream } = current

        if (segment.map && segment.map.uri !== this.lastMapUri) {
          const keyForMap = segment.key?.iv ? segment.key : null
          const mapData = await this.fetcher.fetchMap(segment.map, keyForMap)
          if (mapData && !this.stop) {
            if (!this.write(mapData)) await this._waitForDrain()
            this.lastMapUri = segment.map.uri ?? null
          }
        }

        if (this.strategy === 'segmented') {
          if (!this.stop && data) {
            if (!this.write(data)) await this._waitForDrain()
          }
        } else if (stream) {
          this.activeSegmentStreams.set(key, stream)

          for await (const chunk of stream) {
            if (this.stop) break
            if (!this.write(chunk as Buffer)) await this._waitForDrain()
          }

          this.activeSegmentStreams.delete(key)
        }
      } catch (err) {
        const error = err as Error
        logger(
          'error',
          'HLSHandler',
          `Segment processing error: ${error.message}`
        )
      }
    }

    this.isFetching = false

    if (
      !this.isLive &&
      this.segmentQueue.length === 0 &&
      fetchPool.size === 0 &&
      !this.stop &&
      !this.destroyed
    ) {
      this.end()
    }
  }

  /** @internal */
  private _scheduleNextTick(targetDuration: number): void {
    if (this.stop) return

    const delay = Math.max(0.5, targetDuration / 2) * 1000
    this.playlistTimer = setTimeout(() => this._playlistLoop(), delay)
  }
}

/**
 * Events emitted by the HLSHandler.
 *
 * @public
 */
export interface HLSHandlerEvents {
  /** Emitted when all segments from a non-live playlist have been fetched and buffered. */
  finishBuffering: () => void
  /** Emitted when a chunk of audio data is available. */
  data: (chunk: Buffer) => void
  /** Emitted when an error occurs. */
  error: (err: Error) => void
}
