import type {
  LyricsLine,
  LyricsPayload,
  NodeLink
} from '../../../typings/playback/player.types.ts'
import { logger } from '../../../utils.ts'
import type { Player } from '../../player.ts'
import type { PlaybackClock } from '../tracks/clock.ts'

/**
 * Loads lyrics and synchronizes their events with playback.
 * @internal
 */
export class PlayerLyrics {
  private readonly player: Pick<
    Player,
    | 'guildId'
    | 'isLyricsSubscribed'
    | 'skipTrackSource'
    | 'track'
    | 'isPaused'
    | 'currentLyrics'
    | 'lyricsLineIndex'
    | 'emitEvent'
  >
  private readonly nodelink: NodeLink
  private readonly clock: PlaybackClock
  private _lyricsMarkerTimer: NodeJS.Timeout | null = null

  constructor(
    player: PlayerLyrics['player'],
    nodelink: NodeLink,
    clock: PlaybackClock
  ) {
    this.player = player
    this.nodelink = nodelink
    this.clock = clock
  }

  public _clearMarkerTimer(): void {
    if (this._lyricsMarkerTimer) {
      clearTimeout(this._lyricsMarkerTimer)
      this._lyricsMarkerTimer = null
    }
  }

  /**
   * Subscribes to lyrics events for the current track.
   *
   * @param skipTrackSource - When true, skips track source provider before fetching lyrics.
   */
  public async subscribeLyrics(
    skipTrackSource: boolean | string | undefined
  ): Promise<void> {
    logger(
      'debug',
      'Player',
      `[Action: subscribeLyrics] Method invoked for guild ${this.player.guildId}`
    )
    return new Promise((resolve) => {
      if (this.player.isLyricsSubscribed) {
        return resolve()
      }

      this.player.isLyricsSubscribed = true
      this.player.skipTrackSource =
        skipTrackSource === 'true' || skipTrackSource === true

      if (this.player.track && !this.player.isPaused) {
        this._loadLyrics().catch((error: unknown) => {
          const errorMessage =
            error instanceof Error ? error.message : String(error)
          logger(
            'warn',
            'Lyrics',
            `Failed to load lyrics for guild ${this.player.guildId}: ${errorMessage} `
          )
        })
      }

      return resolve()
    })
  }

  /**
   * Unsubscribes from lyrics events.
   */
  public unsubscribeLyrics(): Promise<void> {
    logger(
      'debug',
      'Player',
      `[Action: unsubscribeLyrics] Method invoked for guild ${this.player.guildId}`
    )
    return new Promise((resolve) => {
      this.player.isLyricsSubscribed = false
      this.player.skipTrackSource = false
      this.player.currentLyrics = null
      this.player.lyricsLineIndex = -1
      this._clearMarkerTimer()
      return resolve()
    })
  }

  /**
   * Loads lyrics for the current track and emits events.
   */
  public async _loadLyrics(): Promise<void> {
    if (!this.player.track) return

    const lyricsManager =
      this.nodelink.lyrics ?? (await this.nodelink.getLyricsManager?.())
    if (!lyricsManager) return

    const lyricsData = await lyricsManager.loadLyrics(
      { info: this.player.track.info },
      undefined,
      this.player.skipTrackSource
    )

    if (lyricsData && lyricsData.loadType === 'lyrics') {
      const lines: LyricsLine[] = lyricsData.data.lines.map((line) => ({
        timestamp: line.time,
        duration: line.duration || 0,
        line: line.text,
        words: line.words || [],
        plugin: {}
      }))

      for (let i = 0; i < lines.length - 1; i++) {
        const current = lines[i]
        const next = lines[i + 1]
        if (!current || !next) continue
        if (current.duration === 0) {
          current.duration = next.timestamp - current.timestamp
        }
      }

      const payload: LyricsPayload = {
        sourceName: this.player.track.info.sourceName,
        provider: lyricsData.data.provider,
        text: lyricsData.data.lines.map((l) => l.text).join('\n'),
        lines,
        plugin: {}
      }

      this.player.currentLyrics = payload
      this.player.lyricsLineIndex = -1
      this.player.emitEvent('LyricsFoundEvent', {
        lyrics: this.player.currentLyrics
      })
      this._clearMarkerTimer()
      this._recalculateLyricsIndex(undefined, undefined, true)
      this._syncLyrics(true)
    } else {
      this.player.currentLyrics = null
      this.player.emitEvent('LyricsNotFoundEvent')
    }
  }

  /**
   * Synchronizes lyrics with current playback position.
   */
  public _syncLyrics(force = false): void {
    if (!this.player.isLyricsSubscribed || !this.player.currentLyrics?.lines)
      return
    if (this._lyricsMarkerTimer && !force) return

    const timescale = this.clock._getTimescale()
    const playbackSpeed = timescale.speed * timescale.rate
    const position = this._getLyricsPosition(playbackSpeed)
    const lines = this.player.currentLyrics.lines
    this._recalculateLyricsIndex(position, lines)

    const nextIndex = this.player.lyricsLineIndex + 1
    const nextLine = lines[nextIndex]
    if (!nextLine) return

    const nextTimestamp = nextLine.timestamp
    const delayMs = Math.max(0, (nextTimestamp - position) / playbackSpeed)

    this._lyricsMarkerTimer = setTimeout(() => {
      this._lyricsMarkerTimer = null
      if (!this.player.isLyricsSubscribed || !this.player.currentLyrics?.lines)
        return
      const timedLine = this.player.currentLyrics.lines[nextIndex]
      if (!timedLine) return
      const nowPosition = this._getLyricsPosition(playbackSpeed)
      const drift = nowPosition - nextTimestamp

      if (drift < -15) {
        this._syncLyrics(true)
        return
      }

      if (Math.abs(drift) > 100) {
        this.clock._adjustPacketPosition(-drift * 0.25)
      }

      this.player.lyricsLineIndex = nextIndex
      this.player.emitEvent('LyricsLineEvent', {
        lineIndex: nextIndex,
        line: timedLine,
        skipped: drift > 60
      })
      this._syncLyrics(true)
    }, delayMs)
  }

  /**
   * Computes current lyrics position based on packets received.
   */
  private _getLyricsPosition(playbackSpeed: number): number {
    return this.clock._getPacketPosition(playbackSpeed)
  }

  /**
   * Recalculates the current lyric line index.
   */
  public _recalculateLyricsIndex(
    positionOverride?: number,
    linesOverride?: LyricsLine[],
    allowBackward = false
  ): void {
    if (!this.player.currentLyrics?.lines) return

    const lines = linesOverride || this.player.currentLyrics.lines
    let position = positionOverride

    if (position === undefined) {
      const timescale = this.clock._getTimescale()
      const playbackSpeed = timescale.speed * timescale.rate
      position = this._getLyricsPosition(playbackSpeed)
    }

    let foundIndex = -1
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue
      if (line.timestamp <= position) {
        foundIndex = i
      } else {
        break
      }
    }

    if (!allowBackward && foundIndex < this.player.lyricsLineIndex) {
      return
    }

    if (foundIndex !== this.player.lyricsLineIndex) {
      const skipped = foundIndex > this.player.lyricsLineIndex + 1
      this.player.lyricsLineIndex = foundIndex

      if (foundIndex !== -1) {
        const line = lines[foundIndex]
        if (!line) return
        this.player.emitEvent('LyricsLineEvent', {
          lineIndex: foundIndex,
          line: line,
          skipped
        })
      }
    }
  }
}
