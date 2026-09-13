import { Buffer } from 'node:buffer'
import type { Readable } from 'node:stream'

import type { VoiceConnection } from '@performanc/voice'
import type {
  ActiveStreamEntry,
  ExtendedVoiceConnection,
  VoiceRelay,
  VoiceRelayOptions
} from '../typings/voice/voice.types.ts'
import {
  buildVoiceFrame,
  resolveVoiceFormat,
  VOICE_FORMATS,
  VOICE_FRAME_OPS
} from './voiceFrames.ts'

const EMPTY_BUFFER = Buffer.alloc(0)
type DiscordVoiceModule = typeof import('@performanc/voice')
type OpusModule = typeof import('../playback/opus/Opus.ts')
type OpusDecoderInstance = InstanceType<OpusModule['Decoder']>

let voiceRuntimePromise: Promise<{
  discordVoice: DiscordVoiceModule['default']
  OpusDecoder: OpusModule['Decoder']
}> | null = null

const getVoiceRuntime = async () => {
  if (!voiceRuntimePromise) {
    voiceRuntimePromise = Promise.all([
      import('@performanc/voice'),
      import('../playback/opus/Opus.ts')
    ]).then(([discordVoiceModule, opusModule]) => ({
      discordVoice: discordVoiceModule.default,
      OpusDecoder: opusModule.Decoder
    }))
  }

  return voiceRuntimePromise
}

/**
 * Creates a voice relay for handling voice packet interception and forwarding.
 *
 * @param options - Configuration options for the voice relay.
 * @returns The voice relay instance or null if disabled.
 */
export function createVoiceRelay({
  enabled,
  format,
  sendFrame,
  logger
}: VoiceRelayOptions): VoiceRelay | null {
  if (!enabled || typeof sendFrame !== 'function') {
    return null
  }

  const formatInfo = resolveVoiceFormat(format, logger)
  const activeStreams = new Map<string, ActiveStreamEntry>()
  let pcmEnabled = formatInfo.name === 'pcm_s16le'
  let activeFormatCode = formatInfo.code

  const now = (): number => Date.now() >>> 0

  const safeSend = (frame: Buffer): void => {
    try {
      sendFrame(frame)
    } catch (err) {
      if (logger) {
        logger(
          'error',
          'Voice',
          `Failed to send voice frame: ${(err as Error).message}`
        )
      }
    }
  }

  const cleanupStream = (key: string): ActiveStreamEntry | null => {
    const entry = activeStreams.get(key)
    if (!entry) return null

    entry.dataStream.off('data', entry.onData)
    entry.dataStream.off('end', entry.onEnd)
    entry.dataStream.off('close', entry.onEnd)
    entry.dataStream.off('error', entry.onError)

    if (entry.decoder) {
      try {
        if ('unpipe' in entry.stream) {
          ;(entry.stream as Readable).unpipe(entry.decoder)
        }
        entry.decoder.destroy()
      } catch {
        // Ignore errors during destruction
      }
    }

    activeStreams.delete(key)
    return entry
  }

  const handleSpeakStart = async (
    guildId: string,
    userId: string,
    ssrc: number
  ): Promise<void> => {
    const { discordVoice, OpusDecoder } = await getVoiceRuntime()
    const key = `${guildId}:${ssrc}`
    if (activeStreams.has(key)) return

    const stream = discordVoice.getSpeakStream(ssrc, guildId)
    if (!stream) return

    let decoder: OpusDecoderInstance | null = null
    let dataStream: Readable | OpusDecoderInstance = stream
    let formatCode = activeFormatCode

    if (pcmEnabled) {
      try {
        decoder = new OpusDecoder({ rate: 48000, channels: 2 })
        stream.pipe(decoder)
        dataStream = decoder
      } catch (err) {
        pcmEnabled = false
        activeFormatCode = VOICE_FORMATS.opus
        formatCode = activeFormatCode
        if (logger) {
          logger(
            'warn',
            'Voice',
            `PCM decode unavailable (${(err as Error).message}); sending opus instead.`
          )
        }
      }
    }

    const startFrame = buildVoiceFrame(
      VOICE_FRAME_OPS.start,
      formatCode,
      guildId,
      userId,
      ssrc,
      now(),
      EMPTY_BUFFER
    )
    safeSend(startFrame)

    const onData = (chunk: Buffer): void => {
      const frame = buildVoiceFrame(
        VOICE_FRAME_OPS.data,
        formatCode,
        guildId,
        userId,
        ssrc,
        now(),
        chunk
      )
      safeSend(frame)
    }

    const onEnd = (): void => {
      handleSpeakStop(guildId, userId, ssrc)
    }

    const onError = (err: Error): void => {
      if (logger) {
        logger('warn', 'Voice', `Voice stream error: ${err?.message || err}`)
      }
      handleSpeakStop(guildId, userId, ssrc)
    }

    dataStream.on('data', onData)
    dataStream.once('end', onEnd)
    dataStream.once('close', onEnd)
    dataStream.once('error', onError)

    activeStreams.set(key, {
      stream,
      dataStream,
      decoder,
      formatCode,
      onData,
      onEnd,
      onError,
      userId
    })
  }

  const handleSpeakStop = (
    guildId: string,
    userId: string,
    ssrc: number
  ): void => {
    const key = `${guildId}:${ssrc}`
    const entry = cleanupStream(key)
    const finalUserId = entry?.userId || userId
    const formatCode = entry?.formatCode ?? activeFormatCode
    if (!finalUserId) return

    const stopFrame = buildVoiceFrame(
      VOICE_FRAME_OPS.stop,
      formatCode,
      guildId,
      finalUserId,
      ssrc,
      now(),
      EMPTY_BUFFER
    )
    safeSend(stopFrame)
  }

  const attach = (connection: VoiceConnection, guildId: string): void => {
    const conn = connection as ExtendedVoiceConnection
    if (!conn || conn._voiceRelayAttached) return
    conn._voiceRelayAttached = true

    const speakStartHandler = (userId: string, ssrc: number) => {
      void handleSpeakStart(guildId, userId, ssrc).catch((err: Error) => {
        if (logger) {
          logger(
            'warn',
            'Voice',
            `Failed to initialize voice relay stream: ${err.message}`
          )
        }
      })
    }
    const speakEndHandler = (userId: string, ssrc: number) => {
      handleSpeakStop(guildId, userId, ssrc)
    }

    conn._voiceRelaySpeakStart = speakStartHandler
    conn._voiceRelaySpeakEnd = speakEndHandler

    conn.on('speakStart', speakStartHandler)
    conn.on('speakEnd', speakEndHandler)
  }

  const detach = (connection: VoiceConnection): void => {
    const conn = connection as ExtendedVoiceConnection
    if (!conn._voiceRelayAttached) return
    if (conn._voiceRelaySpeakStart) {
      conn.removeListener('speakStart', conn._voiceRelaySpeakStart)
    }
    if (conn._voiceRelaySpeakEnd) {
      conn.removeListener('speakEnd', conn._voiceRelaySpeakEnd)
    }
    conn._voiceRelayAttached = false
  }

  return { attach, detach }
}
