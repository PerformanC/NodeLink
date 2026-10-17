import { Buffer } from 'node:buffer'
import process from 'node:process'
import type { Readable } from 'node:stream'
import { PassThrough } from 'node:stream'

import type { VoiceAudioStream } from '@performanc/voice'

import { GatewayEvents } from '../../../constants.ts'
import { YOUTUBE_WEBM_ITAGS } from '../../../sources/youtube/common.ts'
import type {
  AudioResource,
  CreateAudioResource,
  CreateSeekeableAudioResource,
  ExtendedAudioStream,
  NodeLink,
  TrackFormat,
  TrackInfoExtended
} from '../../../typings/playback/player.types.ts'
import type { TrackUrlResult } from '../../../typings/sources/source.types.ts'
import { logger } from '../../../utils.ts'
import type { PlayerConnection } from '../../../voice/playerConnection.ts'
import type { Player } from '../../player.ts'
import type { PlayerMixer } from '../audio/mixer.ts'
import type { PlayerEvents } from '../events.ts'

const trackFinishMemoryTraceEnabled =
  process.env.NODELINK_TRACK_FINISH_MEMORY_TRACE?.toLowerCase() === 'true'

export let createAudioResource: CreateAudioResource | null = null

export let createSeekeableAudioResource: CreateSeekeableAudioResource | null =
  null

export function isWebmYouTubePlayback(
  sourceName: string,
  data?: Pick<TrackUrlResult, 'additionalData' | 'format'> | null
): boolean {
  if (sourceName !== 'youtube' && sourceName !== 'ytmusic') return false
  const itag = data?.additionalData?.itag
  if (typeof itag === 'number') return YOUTUBE_WEBM_ITAGS.has(itag)
  const format = data?.format
  if (typeof format === 'string') return format.toLowerCase().includes('webm')
  if (typeof format?.itag === 'number')
    return YOUTUBE_WEBM_ITAGS.has(format.itag)
  return true
}

export async function getStreamProcessor(): Promise<void> {
  if (createAudioResource && createSeekeableAudioResource) return

  const processor = await import('../../processing/streamProcessor.ts')
  createAudioResource = processor.createAudioResource as CreateAudioResource
  createSeekeableAudioResource =
    processor.createSeekeableAudioResource as CreateSeekeableAudioResource
}

interface PlayerResourcesDependencies {
  isCrossfadeEnabled: () => boolean
  cleanupCrossfade: (preserveQueuedTrack: boolean) => void
  mixer: PlayerMixer
  voiceConnection: PlayerConnection
  events: PlayerEvents
}

/**
 * Builds audio resources and cleans up their streams.
 * @internal
 */
export class PlayerResources {
  private readonly player: Pick<
    Player,
    | 'guildId'
    | 'position'
    | 'isPaused'
    | 'profilerStreamStats'
    | 'emitEvent'
    | 'track'
    | 'filters'
    | 'volumePercent'
    | 'audioMixer'
    | 'loudnessNormalizer'
    | 'connection'
    | 'duckingController'
  >
  private readonly nodelink: NodeLink
  private readonly dependencies: PlayerResourcesDependencies
  private _currentResource: AudioResource | null = null

  constructor(
    player: PlayerResources['player'],
    nodelink: NodeLink,
    dependencies: PlayerResourcesDependencies
  ) {
    this.player = player
    this.nodelink = nodelink
    this.dependencies = dependencies
  }

  /**
   * Logs a memory snapshot for track-finish diagnostics when enabled.
   */
  public _traceTrackFinishMemory(stage: string): void {
    if (!trackFinishMemoryTraceEnabled) return
    const memoryUsage = process.memoryUsage()
    const toMegabytes = (value: number): string =>
      (value / 1024 / 1024).toFixed(2)
    logger(
      'debug',
      'Player',
      `[MEM][TrackFinish][${this.player.guildId}] ${stage} rss=${toMegabytes(memoryUsage.rss)}MB heapUsed=${toMegabytes(
        memoryUsage.heapUsed
      )}MB heapTotal=${toMegabytes(memoryUsage.heapTotal)}MB external=${toMegabytes(memoryUsage.external)}MB arrayBuffers=${toMegabytes(
        memoryUsage.arrayBuffers
      )}MB`
    )
  }

  /**
   * Records which resource belongs to the current stream.
   */
  public _adoptResource(resource: AudioResource): void {
    this._currentResource = resource
  }

  public _replaceResource(resource: AudioResource): void {
    if (this._currentResource && this._currentResource !== resource) {
      try {
        this._currentResource.destroy()
      } catch {}
    }
    this._currentResource = resource
  }

  public _abortYouTubeStreams(): void {
    try {
      const youtube = (
        this.nodelink.sources as unknown as {
          sources: Map<string, { abortGuildStreams: (guildId: string) => void }>
        }
      ).sources.get('youtube')
      youtube?.abortGuildStreams(this.player.guildId)
    } catch {}
  }

  public _releaseResource(): void {
    if (this._currentResource) {
      try {
        this._currentResource.destroy()
      } catch {}
      this._currentResource = null
    }
  }

  /**
   * Fetches an audio resource for playback.
   */
  public async _fetchResource(
    info: TrackInfoExtended,
    urlData: TrackUrlResult & { protocol?: string; format?: TrackFormat },
    startTime?: number,
    returnPCM = false
  ): Promise<{ stream: AudioResource } | { exception: { message: string } }> {
    if (this.nodelink.options?.playback.mix?.enabled !== false) {
      await this.dependencies.mixer._ensureAudioMixer()
    }

    await getStreamProcessor()
    const audioResourceFactory = createAudioResource
    if (!audioResourceFactory) {
      return { exception: { message: 'Stream processor not initialized' } }
    }

    const additionalData = {
      ...urlData.additionalData,
      ...(startTime !== undefined ? { startTime, position: startTime } : {}),
      guildId: this.player.guildId,
      positionCallback: (positionMs: number) => {
        if (!Number.isFinite(positionMs) || positionMs < 0) return
        this.player.position = positionMs
      },
      // specific to sabr protocol for now
      playbackPaused: () => this.player.isPaused
    }

    const resolvedUrlData = {
      ...urlData,
      additionalData
    }

    const track = resolvedUrlData?.newTrack
      ? (resolvedUrlData?.newTrack?.info as TrackInfoExtended)
      : info

    logger(
      'debug',
      'Player',
      `Fetching stream resource from source for guild ${this.player.guildId}`,
      {
        source: track.sourceName,
        url: resolvedUrlData.url
      }
    )

    const fetched = await this.nodelink.sources.getTrackStream(
      track,
      resolvedUrlData.url as string,
      resolvedUrlData.protocol as string,
      additionalData
    )
    if (fetched.exception) {
      logger(
        'error',
        'Player',
        `Stream resource fetch failed for guild ${this.player.guildId}`,
        fetched.exception
      )
      return fetched as { exception: { message: string } }
    }
    logger(
      'debug',
      'Player',
      `Successfully fetched stream resource for guild ${this.player.guildId}`
    )
    const fetchedStream = fetched.stream as NonNullable<typeof fetched.stream>
    const totalBytesRaw =
      (
        resolvedUrlData.additionalData as
          | { contentLength?: number | string }
          | null
          | undefined
      )?.contentLength ?? null
    const totalBytesNum = Number(totalBytesRaw)
    this.player.profilerStreamStats = {
      downloadedBytes: 0,
      totalBytes:
        Number.isFinite(totalBytesNum) && totalBytesNum > 0
          ? totalBytesNum
          : null,
      lastChunkAt: null
    }
    let streamForResource: Readable = fetchedStream as Readable

    if ((fetchedStream as { on?: unknown }).on) {
      const eventStream = fetchedStream as unknown as VoiceAudioStream
      const profilerTap = new PassThrough()
      const profilerHandler = (chunk: Buffer | Uint8Array | string) => {
        const size =
          typeof chunk === 'string'
            ? Buffer.byteLength(chunk)
            : Number((chunk as { length?: number })?.length || 0)
        if (size > 0) this.player.profilerStreamStats.downloadedBytes += size
        this.player.profilerStreamStats.lastChunkAt = Date.now()
      }
      profilerTap.on('data', profilerHandler)
      streamForResource = (fetchedStream as Readable).pipe(profilerTap)
      ;(profilerTap as unknown as Record<string, unknown>)._sourceStream =
        fetchedStream

      const seekControl = fetchedStream as unknown as {
        beginSeekHandoff?: () => Promise<unknown>
        cancelSeekHandoff?: () => void
      }
      const beginSeekHandoff = seekControl.beginSeekHandoff
      if (beginSeekHandoff) {
        ;(
          profilerTap as unknown as {
            beginSeekHandoff?: () => Promise<unknown>
          }
        ).beginSeekHandoff = () => beginSeekHandoff()
      }
      const cancelSeekHandoff = seekControl.cancelSeekHandoff
      if (cancelSeekHandoff) {
        ;(
          profilerTap as unknown as { cancelSeekHandoff?: () => void }
        ).cancelSeekHandoff = () => cancelSeekHandoff()
      }

      const eternalboxHandler = (data: unknown) => {
        this.player.emitEvent(GatewayEvents.ETERNALBOX_JUMP, {
          track: this.dependencies.events.resolvedTrack || this.player.track,
          eternalbox: data
        })
      }
      const icyHandler = (data: unknown) => {
        this.player.emitEvent(GatewayEvents.STREAM_METADATA, {
          track: this.dependencies.events.resolvedTrack || this.player.track,
          stream: data
        })
      }
      eventStream.on?.('eternalboxJump', eternalboxHandler)
      eventStream.on?.('icyMetadata', icyHandler)

      let listenersCleaned = false
      const cleanupListeners = () => {
        if (listenersCleaned) return
        listenersCleaned = true
        eventStream.off?.('eternalboxJump', eternalboxHandler)
        eventStream.off?.('icyMetadata', icyHandler)
        profilerTap.off('data', profilerHandler)
        streamForResource.off('close', cleanupListeners)
        streamForResource.off('error', cleanupListeners)
        streamForResource.off('end', cleanupListeners)
        const src = (profilerTap as unknown as { _sourceStream?: Readable })
          ._sourceStream
        if (src && !src.destroyed) {
          try {
            src.destroy()
          } catch {}
        }
        delete (profilerTap as unknown as Record<string, unknown>)._sourceStream
        if (!profilerTap.destroyed) {
          try {
            profilerTap.destroy()
          } catch {}
        }
      }

      streamForResource.on('close', cleanupListeners)
      streamForResource.on('error', cleanupListeners)
      streamForResource.on('end', cleanupListeners)
      ;(
        streamForResource as unknown as {
          _cleanupListeners?: () => void
        }
      )._cleanupListeners = cleanupListeners
    }
    const resource = audioResourceFactory(
      this.player.guildId,
      streamForResource,
      fetched.type || resolvedUrlData.format,
      this.nodelink,
      this.player.filters,
      returnPCM ? 1 : this.player.volumePercent / 100,
      returnPCM ? null : this.player.audioMixer,
      returnPCM,
      returnPCM ? false : this.player.loudnessNormalizer,
      !returnPCM && this.dependencies.isCrossfadeEnabled()
    )
    return { stream: resource }
  }

  /**
   * Destroys and dereferences current audio stream to avoid lingering references.
   */
  public _cleanupCurrentAudioStream(
    context: string,
    preserveCrossfade = false
  ): void {
    this.dependencies.cleanupCrossfade(preserveCrossfade)
    logger(
      'debug',
      'Player',
      `[Cleanup] Triggering stream cleanup for guild ${this.player.guildId}. Context: ${context}`
    )
    const conn = this.player.connection

    this.dependencies.voiceConnection.clearPendingKeyPackage()

    const audioStream = conn?.audioStream as
      | ExtendedAudioStream
      | undefined
      | null

    if (this.player.duckingController) {
      this.player.duckingController.setStreamControl(null)
      this.player.duckingController.detach()
    }

    if (this._currentResource) {
      try {
        this._currentResource.destroy()
      } catch (err) {
        logger(
          'debug',
          'Player',
          `Resource destroy failed during ${context} for guild ${this.player.guildId}: ${
            (err as Error)?.message ?? String(err)
          }`
        )
      }
      this._currentResource = null
    }

    if (!audioStream) {
      return
    }

    try {
      audioStream._cleanupListeners?.()
    } catch {
      // Ignore cleanup errors
    }

    if (audioStream.destroyed) {
      if (conn) conn.audioStream = null
      return
    }

    try {
      audioStream.destroy?.()

      if (Array.isArray(audioStream.pipes)) {
        for (const pipe of audioStream.pipes) {
          pipe.destroy?.()
        }
      }

      this.dependencies.voiceConnection.flush(conn)
    } catch (err) {
      logger(
        'debug',
        'Player',
        `Failed to destroy audio stream during ${context} for guild ${this.player.guildId}: ${
          (err as Error)?.message ?? String(err)
        }`
      )
    } finally {
      if (conn) conn.audioStream = null
    }
  }
}
