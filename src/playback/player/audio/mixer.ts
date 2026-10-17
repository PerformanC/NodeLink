import type { VoiceAudioStream } from '@performanc/voice'

import { GatewayEvents } from '../../../constants.ts'
import type {
  AudioMixer,
  AudioResource,
  NodeLink,
  PlayerTrack,
  TrackInfoExtended
} from '../../../typings/playback/player.types.ts'
import { logger } from '../../../utils.ts'
import type { Player } from '../../player.ts'

/**
 * Manages the audio mixer and additional track layers.
 * @internal
 */
export class PlayerMixer {
  private readonly player: Pick<
    Player,
    'audioMixer' | 'emitEvent' | 'guildId' | 'track' | 'isPaused'
  >
  private readonly nodelink: NodeLink
  private _audioMixerInitPromise: Promise<void> | null = null

  constructor(player: PlayerMixer['player'], nodelink: NodeLink) {
    this.player = player
    this.nodelink = nodelink
  }

  /**
   * Initializes the audio mixer instance used for mix layers and fading.
   */
  private async _initAudioMixer(): Promise<void> {
    if (this.player.audioMixer) return

    const { AudioMixer: Mixer } = await import('../../processing/AudioMixer.ts')
    this.player.audioMixer = new Mixer(
      this.nodelink.options?.playback.mix ?? {
        enabled: true,
        defaultVolume: 0.8,
        maxLayersMix: 5,
        autoCleanup: true
      }
    ) as AudioMixer

    this.player.audioMixer.on('mixStarted', (data) => {
      this.player.emitEvent(GatewayEvents.MIX_STARTED, {
        mixId: data.id,
        track: data.track,
        volume: data.volume
      })
    })

    this.player.audioMixer.on('mixEnded', (data) => {
      this.player.emitEvent(GatewayEvents.MIX_ENDED, {
        mixId: data.id,
        reason: data.reason
      })
    })

    this.player.audioMixer.on('mixError', (data) => {
      const errorMessage = data.error ? data.error.message : 'Unknown mix error'
      logger('error', 'Player', `Mix error for ${data.id}: ${errorMessage}`)
    })
  }

  /**
   * Ensures the audio mixer is initialized only once on demand.
   */
  public async _ensureAudioMixer(): Promise<void> {
    if (this.player.audioMixer) return
    if (!this._audioMixerInitPromise) {
      this._audioMixerInitPromise = this._initAudioMixer()
        .catch((err) => {
          this._audioMixerInitPromise = null
          throw err
        })
        .then(() => {
          this._audioMixerInitPromise = null
        })
    }
    await this._audioMixerInitPromise
  }

  public _destroyAudioMixer(): void {
    if (this.player.audioMixer) {
      this.player.audioMixer.destroy()
      this.player.audioMixer = null
    }
    this._audioMixerInitPromise = null
  }

  /**
   * Adds an additional mix layer over the main stream.
   *
   * @param trackPayload - Track to mix in PCM form.
   * @param volume - Optional mix volume (0-1). Defaults to mix config.
   * @throws Error when no active main stream or mixer limits exceeded.
   */
  public async addMix(
    trackPayload: PlayerTrack,
    volume: number | null = null
  ): Promise<{
    id: string
    track: PlayerTrack
    volume: number
  }> {
    logger(
      'debug',
      'Player',
      `[Action: addMix] Method invoked for guild ${this.player.guildId}`
    )
    if (!this.player.track || this.player.isPaused) {
      throw new Error('Cannot add mix without an active stream')
    }

    await this._ensureAudioMixer()
    if (!this.player.audioMixer) throw new Error('AudioMixer not initialized')

    const mixConfig = this.nodelink?.options?.playback.mix ?? {
      enabled: true,
      defaultVolume: 0.8,
      maxLayersMix: 5
    }

    if (
      this.player.audioMixer.mixLayers.size >= (mixConfig.maxLayersMix ?? 5)
    ) {
      throw new Error(
        `Maximum number of mix layers(${mixConfig.maxLayersMix}) reached`
      )
    }

    const mixVolume = volume ?? mixConfig.defaultVolume ?? 0.8

    const { createAudioResource: createResource } = await import(
      '../../processing/streamProcessor.ts'
    )

    const urlData = await this.nodelink.sources.getTrackUrl(trackPayload.info)
    if (!urlData?.url) {
      throw new Error('Failed to get stream URL for mix track')
    }

    const fetched = await this.nodelink.sources.getTrackStream(
      (urlData.newTrack?.info as TrackInfoExtended) || trackPayload.info,
      urlData.url as string,
      urlData.protocol as string,
      urlData.additionalData
    )

    if (fetched.exception) {
      throw new Error(fetched.exception.message)
    }

    const pcmResource = createResource(
      this.player.guildId,
      fetched.stream as NonNullable<typeof fetched.stream>,
      fetched.type || (urlData.format as string) || 'unknown',
      this.nodelink,
      {},
      mixVolume,
      null,
      true
    ) as AudioResource & { stream: VoiceAudioStream }

    const mixId = this.player.audioMixer.addLayer(
      pcmResource.stream,
      trackPayload,
      mixVolume
    )

    return {
      id: mixId,
      track: trackPayload,
      volume: mixVolume
    }
  }

  /**
   * Removes a mix layer by id.
   *
   * @param mixId - Identifier returned by addMix.
   * @returns True when removed.
   */
  public removeMix(mixId: string): boolean {
    logger(
      'debug',
      'Player',
      `[Action: removeMix] Method invoked for guild ${this.player.guildId} mixId=${mixId}`
    )
    if (!this.player.audioMixer) {
      return false
    }
    return this.player.audioMixer.removeLayer(mixId)
  }

  /**
   * Updates the volume of a mix layer.
   *
   * @param mixId - Identifier of the mix layer.
   * @param volume - New volume (0-1).
   * @returns True when updated; false if layer missing.
   */
  public updateMix(mixId: string, volume: number): boolean {
    logger(
      'debug',
      'Player',
      `[Action: updateMix] Method invoked for guild ${this.player.guildId} mixId=${mixId} volume=${volume}`
    )
    if (!this.player.audioMixer) {
      return false
    }
    return this.player.audioMixer.updateLayerVolume(mixId, volume)
  }

  /**
   * Lists active mix layers.
   *
   * @returns Current mix layers with track and volume.
   */
  public getMixes(): Array<{
    id: string
    track: PlayerTrack
    volume: number
    position: number
    startTime: number
  }> {
    logger(
      'debug',
      'Player',
      `[Action: getMixes] Method invoked for guild ${this.player.guildId}`
    )
    if (!this.player.audioMixer) {
      return []
    }
    return this.player.audioMixer.getLayers()
  }
}
