import type {
  LyricsLine,
  LyricsLoadResult,
  LyricsManagerContext,
  LyricsSourceInstance,
  TrackInfoLike
} from '../managers/lyricsManager.ts'
import type {
  InstanceHealth,
  MonochromeLyricsResponse
} from '../typings/sources/monochrome.types.ts'
import { logger, makeRequest } from '../utils.ts'

/**
 * Monochrome lyrics provider.
 *
 * Proxies Tidal lyrics through Monochrome instances. Implements synchronized
 * LRC parsing and instance rotation with health tracking to mirror the site's reliability.
 *
 * @public
 */
export default class MonochromeLyrics implements LyricsSourceInstance {
  /** Master NodeLink instance reference. */
  public readonly nodelink: LyricsManagerContext

  private instances: InstanceHealth[] = []
  private currentInstanceIndex = 0

  /**
   * Initializes the Monochrome lyrics provider.
   * @param nodelink - The worker server context.
   */
  constructor(nodelink: LyricsManagerContext) {
    this.nodelink = nodelink
    const sources = nodelink.options.sources
    const config = sources.monochrome

    const defaultUrls = [
      'https://eu-central.monochrome.tf',
      'https://us-west.monochrome.tf',
      'https://arran.monochrome.tf',
      'https://api.monochrome.tf',
      'http://wolf.qqdl.site'
    ]

    this.instances = (config.instances || defaultUrls).map((url) => ({
      url: url.replace(/\/$/, ''),
      score: 100,
      lastFailure: 0,
      failures: 0,
      activeRequests: 0
    }))
  }

  /**
   * Performs provider-specific resource initialization.
   * @returns A promise resolving to true.
   */
  public async setup(): Promise<boolean> {
    return this.instances.length > 0
  }

  /**
   * Selects the next instance from the pool using round-robin with health checks.
   * @returns Health-tracked instance metadata.
   * @private
   */
  private getBestInstance(): InstanceHealth {
    const now = Date.now()
    const candidates = this.instances.filter(
      (i) => i.score > 0 || now - i.lastFailure > 30_000
    )
    const activePool = candidates.length > 0 ? candidates : this.instances

    const index = this.currentInstanceIndex % activePool.length
    const instance = activePool[index] || this.instances[0]
    if (!instance) {
      throw new Error('No instances available')
    }
    this.currentInstanceIndex++
    return instance
  }

  /**
   * Fetches lyrics for the specified track.
   * @param trackInfo - Metadata of the track to fetch lyrics for.
   * @returns A promise resolving to a LyricsLoadResult.
   */
  public async getLyrics(trackInfo: TrackInfoLike): Promise<LyricsLoadResult> {
    if (trackInfo.sourceName !== 'monochrome') {
      return { loadType: 'empty', data: {} }
    }

    const identifier = trackInfo.uri?.split('/').pop()
    if (!identifier || !/^\d+$/.test(identifier)) {
      return { loadType: 'empty', data: {} }
    }

    const instance = this.getBestInstance()
    const url = `${instance.url}/lyrics?id=${identifier}`

    instance.activeRequests++
    try {
      const { body, error, statusCode } = await makeRequest(url, {})
      instance.activeRequests--

      if (error || statusCode !== 200 || !body) {
        instance.failures++
        instance.lastFailure = Date.now()
        instance.score = Math.max(instance.score - 20, 0)
        return { loadType: 'empty', data: {} }
      }

      instance.score = Math.min(instance.score + 5, 100)
      const response = body as MonochromeLyricsResponse
      if (!response.lyrics) return { loadType: 'empty', data: {} }

      const data = response.lyrics
      let lines: LyricsLine[] = []
      let synced = false

      if (data.subtitles) {
        synced = true
        lines = this.parseLrc(data.subtitles)
      } else if (data.lyrics) {
        lines = data.lyrics
          .split(/\r?\n/)
          .map((text) => ({ time: 0, duration: 0, text: text.trim() }))
          .filter((line) => line.text.length > 0)
      }

      if (lines.length === 0) return { loadType: 'empty', data: {} }

      return {
        loadType: 'lyrics',
        data: {
          name: trackInfo.title || identifier,
          synced,
          lines,
          provider: 'monochrome'
        }
      }
    } catch (e) {
      instance.activeRequests--
      instance.score = Math.max(instance.score - 30, 0)
      logger(
        'warn',
        'Lyrics',
        `Monochrome lyrics request failed: ${e instanceof Error ? e.message : String(e)}`
      )
      return { loadType: 'empty', data: {} }
    }
  }

  /**
   * Parses LRC format into timed lyric lines.
   * Ported from the reference site's parseSyncedLyrics logic.
   * @param lrc - Raw LRC string.
   * @returns Timed lyric lines.
   * @private
   */
  private parseLrc(lrc: string): LyricsLine[] {
    const lines: LyricsLine[] = []
    const pattern = /\[(\d+):(\d{2})(?:\.(\d{2,3}))?\]/g
    const rawLines = lrc.split(/\r?\n/)

    for (const rawLine of rawLines) {
      const timestamps: number[] = []
      let match = pattern.exec(rawLine)

      while (match) {
        const minutes = parseInt(match[1] || '0', 10)
        const seconds = parseInt(match[2] || '0', 10)
        const msText = (match[3] || '0').padEnd(3, '0').slice(0, 3)
        const milliseconds = parseInt(msText, 10)

        timestamps.push(minutes * 60000 + seconds * 1000 + milliseconds)
        match = pattern.exec(rawLine)
      }

      pattern.lastIndex = 0

      if (timestamps.length === 0) continue

      const text = rawLine.replace(/\[\d+:\d{2}(?:\.\d{2,3})?\]/g, '').trim()
      if (text.length === 0) continue

      for (const time of timestamps) {
        lines.push({ text, time, duration: 0 })
      }
    }

    const sorted = lines.sort((a, b) => a.time - b.time)
    for (let i = 0; i < sorted.length - 1; i++) {
      const current = sorted[i]
      const next = sorted[i + 1]
      if (current && next) {
        current.duration = next.time - current.time
      }
    }

    return sorted
  }
}
