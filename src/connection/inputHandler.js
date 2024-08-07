import { debugLog } from '../utils.js'
import config from '../../config.js'

import voiceUtils from '../voice/utils.js'
import discordVoice from '@performanc/voice'
import prism from 'prism-media'

const Connections = {}
const SpeechesTimeout = {}

function setupConnection(ws, req, parsedClientName) {
  const userId = req.headers['user-id']
  const guildId = req.headers['guild-id']

  ws.on('close', (code, reason) => {
    debugLog('disconnectCD', 3, { ...parsedClientName, code, reason, guildId })

    delete Connections[userId]
  })

  ws.on('error', (err) => {
    debugLog('disconnectCD', 3, { ...parsedClientName, error: `Error: ${err.message}`, guildId })

    delete Connections[userId]
  })

  Connections[userId] = {
    ws,
    guildId
  }
}

function handleStartSpeaking(ssrc, userId, guildId) {
  const opusStream = discordVoice.getSpeakStream(ssrc)
  const stream = new voiceUtils.NodeLinkStream(opusStream, config.voiceReceive.type === 'pcm' ? [ new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 }) ] : [])

  if (!SpeechesTimeout[userId]) {
    const startSpeakingResponse = JSON.stringify({
      op: 'speak',
      type: 'startSpeakingEvent',
      data: {
        userId,
        guildId
      }
    })

    Object.keys(Connections).forEach((botId) => {
      if (Connections[botId].guildId !== guildId) return;

      Connections[botId].ws.send(startSpeakingResponse)
    })
  }

  let buffer = []
  stream.on('data', (chunk) => {
    if (SpeechesTimeout[userId]) {
      clearTimeout(SpeechesTimeout[userId])
      delete SpeechesTimeout[userId]
    }

    if (Object.keys(Connections).length === 0) {
      stream.destroy()
      buffer = null

      return;
    }

    buffer.push(chunk)
  })

  stream.on('end', () => {
    let i = 0

    if (Object.keys(Connections).length === 0) {
      buffer = []

      return;
    }

    SpeechesTimeout[userId] = setTimeout(() => {
      const endSpeakingResponse = JSON.stringify({
        op: 'speak',
        type: 'endSpeakingEvent',
        data: {
          userId,
          guildId,
          data: Buffer.concat(buffer).toString('base64'),
          type: config.voiceReceive.type
        }
      })

      Object.keys(Connections).forEach((botId) => {
        if (Connections[botId].guildId !== guildId) return;

        Connections[botId].ws.send(endSpeakingResponse)

        i++
      })

      buffer = []

      debugLog('sentDataCD', 3, { clientsAmount: i, guildId })

      delete SpeechesTimeout[userId]
    }, config.voiceReceive.timeout)
  })
}

export default {
  setupConnection,
  handleStartSpeaking
}