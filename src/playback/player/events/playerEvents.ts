import { GatewayEvents } from '../../../constants.ts'
import type {
  NodeLink,
  PlayerTrack,
  Session
} from '../../../typings/playback/player.types.ts'
import { logger } from '../../../utils.ts'
import type { EndReason, GatewayEventName, Player } from '../../player.ts'
import type { PlayerLyrics } from '../features/lyrics.ts'

/**
 * Delivers player events, prepares track payloads, and invokes plugin hooks.
 * @internal
 */
export class PlayerEvents {
  private readonly player: Pick<
    Player,
    | 'track'
    | 'streamInfo'
    | 'emitEvent'
    | 'guildId'
    | 'audioMixer'
    | 'isLyricsSubscribed'
  >
  private readonly nodelink: NodeLink
  private readonly session: Session
  private readonly lyrics: PlayerLyrics
  private _resolvedTrack: PlayerTrack | null = null

  constructor(
    player: PlayerEvents['player'],
    nodelink: NodeLink,
    session: Session,
    lyrics: PlayerLyrics
  ) {
    this.player = player
    this.nodelink = nodelink
    this.session = session
    this.lyrics = lyrics
  }

  public get resolvedTrack(): PlayerTrack | null {
    return this._resolvedTrack
  }

  public clearResolvedTrack(): void {
    this._resolvedTrack = null
  }

  /**
   * Sends an event or queues it while the session is paused.
   */
  public emit(
    type: GatewayEventName | string,
    payload: Record<string, unknown> = {}
  ): void {
    this.nodelink.statsManager.incrementPlaybackEvent(type)
    const eventData = JSON.stringify({
      op: 'event',
      type,
      guildId: this.player.guildId,
      ...payload
    })

    if (this.session.isPaused) {
      this.session.eventQueue.push(eventData)
      logger(
        'debug',
        'Player',
        `Queued event ${type} for paused session ${this.session.id}`
      )
      return
    }

    try {
      this.session.socket.send(eventData)
    } catch {}
  }

  /**
   * Resolves the event track before start hooks and lyrics loading.
   */
  public async emitTrackStart(): Promise<void> {
    const trackToEmit = await this._resolveTrackForEvent(this.player.track)
    this._resolvedTrack = trackToEmit

    const format = this.player.streamInfo?.format
    const playingQuality =
      format && typeof format === 'object' && 'itag' in format
        ? ((format as { itag?: number }).itag ?? null)
        : null

    this.player.emitEvent(GatewayEvents.TRACK_START, {
      track: trackToEmit,
      playingQuality
    })

    this.nodelink.pluginManager?.callHook(
      'onTrackStart',
      this.player.guildId,
      trackToEmit
    )

    if (trackToEmit?.info?.sourceName === 'eternalbox') {
      const info = trackToEmit.info
      const pluginInfo = (trackToEmit.pluginInfo ?? {}) as {
        spotify?: { url?: string }
        analysisUrl?: string | null
        streamUrl?: string | null
        ogAudioSource?: string | null
        service?: string | null
        analysisSummary?: string | null
      }
      const spotify = pluginInfo.spotify
      const links = {
        jukeboxPage: info.uri,
        analysisUrl: pluginInfo.analysisUrl || null,
        streamUrl: pluginInfo.streamUrl || null,
        ogAudioSource: pluginInfo.ogAudioSource || null,
        spotifyUrl: spotify?.url || info.uri || null
      }

      this.player.emitEvent(GatewayEvents.ETERNALBOX_INFO, {
        track: trackToEmit,
        eternalbox: {
          id: info.identifier,
          service: pluginInfo.service || null,
          analysisSummary: pluginInfo.analysisSummary || null,
          spotify: pluginInfo.spotify || null,
          links
        }
      })
    }

    if (this.player.isLyricsSubscribed) {
      await this.lyrics._loadLyrics()
    }
  }

  /**
   * Emits the cached event track before cleaning up mixer layers.
   */
  public emitTrackEnd(
    reason: EndReason,
    extra: Record<string, unknown> = {}
  ): void {
    const trackToEmit = this._resolvedTrack || this.player.track
    this.player.emitEvent(GatewayEvents.TRACK_END, {
      track: trackToEmit,
      reason: reason,
      ...extra
    })

    this.nodelink.pluginManager?.callHook(
      'onTrackEnd',
      this.player.guildId,
      trackToEmit,
      reason
    )

    if (this.player.audioMixer?.autoCleanup) {
      this.player.audioMixer.clearLayers('MAIN_ENDED')
    }
  }

  private async _resolveTrackForEvent(
    track: PlayerTrack | null
  ): Promise<PlayerTrack | null> {
    if (!track) return null
    if (!this.nodelink.options.experimental.enableHoloTracks) {
      return track
    }

    try {
      const source = this.nodelink.sources.getSource(track.info.sourceName)
      const resolveHoloTrack = (
        source as {
          resolveHoloTrack?: (
            trackPayload: PlayerTrack,
            options: {
              fetchChannelInfo?: boolean
              resolveExternalLinks?: boolean
            }
          ) => Promise<PlayerTrack | null>
        } | null
      )?.resolveHoloTrack
      if (resolveHoloTrack) {
        const holoTrack = await resolveHoloTrack.call(source, track, {
          fetchChannelInfo: this.nodelink.options.search.fetchChannelInfo,
          resolveExternalLinks:
            this.nodelink.options.search.resolveExternalLinks
        })
        return holoTrack || track
      }
    } catch (err) {
      const error = err as Error
      logger('warn', 'Player', `Failed to resolve Holo track: ${error.message}`)
    }

    return track
  }
}
