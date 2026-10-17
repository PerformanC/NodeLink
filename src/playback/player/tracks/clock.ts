import type { ExtendedAudioStream } from '../../../typings/playback/player.types.ts'
import type { PlayerConnection } from '../../../voice/playerConnection.ts'
import type { Player } from '../../player.ts'

/**
 * Tracks playback position from audio consumption and voice packets.
 * @internal
 */
export class PlaybackClock {
  private readonly player: Pick<Player, 'filters' | 'connection'>
  private readonly voiceConnection: PlayerConnection
  private _packetBasePositionMs = 0
  private _packetBasePackets = 0
  private _audioConsumedBaselineMs = 0
  private _audioTrackBasePositionMs = 0

  constructor(
    player: PlaybackClock['player'],
    voiceConnection: PlayerConnection
  ) {
    this.player = player
    this.voiceConnection = voiceConnection
  }

  /**
   * Reads the configured timescale speed and rate.
   */
  public _getTimescale(): { speed: number; rate: number } {
    const filterSettings = this.player.filters.filters as
      | { timescale?: { speed?: number; rate?: number } }
      | undefined
    const timescale = filterSettings?.timescale || {}
    return {
      speed: typeof timescale.speed === 'number' ? timescale.speed : 1.0,
      rate: typeof timescale.rate === 'number' ? timescale.rate : 1.0
    }
  }

  /**
   * Starts a fresh packet baseline, using zero if voice has no packet statistics.
   */
  public _resetPacketBaseline(position: number): void {
    this._packetBasePositionMs = position
    this._snapshotPacketCount()
  }

  /**
   * Keeps the previous packet count if statistics are absent during a crossfade.
   */
  public _continuePacketBaseline(position: number): void {
    this._packetBasePositionMs = position
    this._packetBasePackets =
      this.player.connection?.statistics?.packetsExpected ??
      this._packetBasePackets
  }

  public _snapshotPacketCount(): void {
    this._packetBasePackets =
      this.player.connection?.statistics?.packetsExpected ?? 0
  }

  public _adjustPacketPosition(offsetMs: number): void {
    this._packetBasePositionMs += offsetMs
  }

  public _getPacketPosition(playbackSpeed: number): number {
    const packets =
      this.player.connection?.statistics?.packetsExpected ??
      this._packetBasePackets
    const deltaPackets = Math.max(0, packets - this._packetBasePackets)
    return this._packetBasePositionMs + deltaPackets * 20 * playbackSpeed
  }

  public _realPosition(): number {
    const audioStream = this.voiceConnection._getAudioStream()

    const playbackSpeed =
      audioStream?.getEffectiveRate?.() ?? this._getTimescaleSpeed()

    return this._getPacketPosition(playbackSpeed)
  }

  public _getTimescaleSpeed(): number {
    const settings = (this.player.filters.filters ?? this.player.filters) as {
      timescale?: { speed?: number; rate?: number }
    }
    const timescale = settings.timescale || {}
    return (timescale.speed ?? 1.0) * (timescale.rate ?? 1.0)
  }

  /**
   * Captures current position and packet count as a new baseline.
   * Call whenever playback speed changes (filters, tape, scratch).
   */
  public _snapshotPosition(): void {
    if (!this.player.connection?.audioStream) return
    this._packetBasePositionMs = this._realPosition()
    this._packetBasePackets =
      this.player.connection.statistics?.packetsExpected ?? 0
  }

  public _resetAudioConsumptionBaseline(
    position: number,
    consumedMs = 0
  ): void {
    this._audioTrackBasePositionMs = Math.max(0, position)
    this._audioConsumedBaselineMs = Math.max(0, consumedMs)
  }

  public _getPipelineLeadMs(
    stream: ExtendedAudioStream,
    playbackPosition: number
  ): number {
    const consumedMs = stream.getConsumedMs?.()
    if (!Number.isFinite(consumedMs)) return 0
    const decodedElapsed = Math.max(
      0,
      (consumedMs ?? 0) - this._audioConsumedBaselineMs
    )
    const playedElapsed = Math.max(
      0,
      playbackPosition - this._audioTrackBasePositionMs
    )
    return Math.min(10000, Math.max(0, decodedElapsed - playedElapsed))
  }
}
