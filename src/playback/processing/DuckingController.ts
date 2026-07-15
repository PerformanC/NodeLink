import { Buffer } from 'node:buffer'
import type { VoiceConnection } from '@performanc/voice'
import type { DuckingConfig, DuckingStreamControl } from '../../typings/playback/ducking.types.ts'
import { Decoder as OpusDecoder } from '../../playback/opus/Opus.ts'
import { logger } from '../../utils.ts'

/**
 * Controls auto-ducking behavior: lowers music volume when users speak
 * and restores it when they stop.
 */
export class DuckingController {
  private config: DuckingConfig
  private streamControl: DuckingStreamControl | null = null
  private activeSpeakers = new Map<number, NodeJS.Timeout>()
  private isDucked = false
  private destroyed = false
  private hookedStreams = new Set<number>()

  private static readonly HOLD_MS = 600
  private static readonly RMS_THRESHOLD = 3500

  private readonly _onSpeakStart = (_userId: string, ssrc: number): void => {
    if (this.destroyed || !this.config.enabled) return
    if (this.hookedStreams.has(ssrc)) return

    const stream = this.connection?.getSpeakStream?.(ssrc)
    if (!stream) return

    this.hookedStreams.add(ssrc)

    let decoder: OpusDecoder | null = null
    try {
      decoder = new OpusDecoder({ rate: 48000, channels: 2 })
      stream.pipe(decoder)
    } catch (err) {
      logger('warn', 'Ducking', `Failed to create Opus decoder for RMS ducking: ${(err as Error).message}`)
      stream.on('data', (chunk: Buffer) => {
        if (this.destroyed || !this.config.enabled) return
        if (chunk.length < 40) return
        
        this._registerSpeech(ssrc)
      })
      
      stream.once('end', () => this.hookedStreams.delete(ssrc))
      return
    }

    let lastLogTime = 0

    decoder.on('data', (pcm: Buffer) => {
      if (this.destroyed || !this.config.enabled) return
      
      let sumSquare = 0
      for (let i = 0; i < pcm.length; i += 2) {
        const sample = pcm.readInt16LE(i)
        sumSquare += sample * sample
      }
      const rms = Math.sqrt(sumSquare / (pcm.length / 2))

      const now = Date.now()
      if (now - lastLogTime > 1000) {
        logger('debug', 'Ducking', `[RMS Debug] SSRC ${ssrc} - Current RMS: ${Math.round(rms)} (Threshold: ${DuckingController.RMS_THRESHOLD})`)
        lastLogTime = now
      }

      if (rms >= DuckingController.RMS_THRESHOLD) {
        this._registerSpeech(ssrc, rms)
      }
    })

    stream.once('end', () => {
      this.hookedStreams.delete(ssrc)
      logger('debug', 'Ducking', `Speak stream ended for SSRC ${ssrc}. Cleaning up.`)
      if (decoder) {
        decoder.destroy()
      }

      const existing = this.activeSpeakers.get(ssrc)
      if (existing) {
        clearTimeout(existing)
        this.activeSpeakers.delete(ssrc)
        logger('debug', 'Ducking', `Cleared speaker ${ssrc} because stream ended.`)
        if (this.activeSpeakers.size === 0) this._restore()
      }
    })
  }

  private connection: VoiceConnection | null = null
  private readonly guildId: string

  constructor(guildId: string, config: DuckingConfig) {
    this.guildId = guildId
    this.config = { ...config }
  }

  public updateConfig(config: DuckingConfig): void {
    this.config = { ...config }
    if (!config.enabled && this.isDucked) this._restore(0)
  }

  public getTargetVolume(defaultVolume = 1.0): number {
    return this.isDucked ? this.currentTargetVolume : defaultVolume
  }

  public setStreamControl(control: DuckingStreamControl | null): void {
    this.streamControl = control
    if (this.isDucked && this.streamControl) {
      try {
        this.streamControl.fadeTo(this.config.targetVolume, this.config.duration, this.config.curve)
      } catch (err) {
        logger('error', 'Ducking', `Failed to reapply ducked volume for guild ${this.guildId}: ${(err as Error).message}`)
      }
    }
  }

  public attach(connection: VoiceConnection): void {
    if (this.connection) return
    this.connection = connection
    this.connection.on('speakStart', this._onSpeakStart)
    logger('debug', 'Ducking', `Attached ducking listeners for guild ${this.guildId}`)
  }

  public detach(): void {
    if (this.connection) {
      this.connection.removeListener('speakStart', this._onSpeakStart)
      this.connection = null
      logger('debug', 'Ducking', `Detached ducking listeners for guild ${this.guildId}`)
    }
    this.hookedStreams.clear()
    this._restore(0)
  }

  public destroy(): void {
    this.destroyed = true
    this.detach()
    this.activeSpeakers.forEach(clearTimeout)
    this.activeSpeakers.clear()
    this.streamControl = null
  }

  private currentTargetVolume = 1.0
  private lastFadeTime = 0

  private _registerSpeech(ssrc: number, rms = 0): void {
    const existing = this.activeSpeakers.get(ssrc)
    if (existing) clearTimeout(existing)

    this.activeSpeakers.set(ssrc, setTimeout(() => {
      this.activeSpeakers.delete(ssrc)
      logger('debug', 'Ducking', `Speaker ${ssrc} timeout expired. Active speakers: ${this.activeSpeakers.size}`)
      if (this.activeSpeakers.size === 0) this._restore()
    }, DuckingController.HOLD_MS))

    const intensity = Math.min(1.0, Math.max(0, (rms - DuckingController.RMS_THRESHOLD) / (15000 - DuckingController.RMS_THRESHOLD)))
    const minVol = 0.03
    let dynamicVol = this.config.targetVolume - (intensity * (this.config.targetVolume - minVol))
    dynamicVol = Number(Math.max(minVol, dynamicVol).toFixed(2))

    const now = Date.now()
    const wasDucked = this.isDucked
    
    const isAttacking = dynamicVol < this.currentTargetVolume
    
    const threshold = isAttacking ? 0.02 : 0.06
    const isSignificantChange = Math.abs(this.currentTargetVolume - dynamicVol) >= threshold

    if (!wasDucked || (isSignificantChange && now - this.lastFadeTime > 100)) {
      this.isDucked = true
      
      let fadeDur = 50 
      if (!isAttacking && wasDucked) {
        fadeDur = 400
      }
      
      this.currentTargetVolume = dynamicVol
      this.lastFadeTime = now
      
      try {
        this.streamControl?.fadeTo(dynamicVol, fadeDur, this.config.curve)
        logger('debug', 'Ducking', `Proportional Ducking -> Vol: ${dynamicVol} | Dur: ${fadeDur}ms | RMS: ${Math.round(rms)} | Guild: ${this.guildId}`)
      } catch (err) {
        logger('error', 'Ducking', `Failed to dynamically duck volume for guild ${this.guildId}: ${(err as Error).message}`)
      }
    }
  }
  private _restore(overrideDuration?: number): void {
    if (!this.isDucked) return
    this.isDucked = false
    this.currentTargetVolume = 1.0
    
    const duration = overrideDuration ?? Math.max(this.config.duration, 600)
    
    try {
      this.streamControl?.fadeTo(1.0, duration, this.config.curve)
      logger('debug', 'Ducking', `Volume restored to 1.0 over ${duration}ms for guild ${this.guildId}`)
    } catch (err) {
      logger('error', 'Ducking', `Failed to restore volume for guild ${this.guildId}: ${(err as Error).message}`)
    }
  }
}
