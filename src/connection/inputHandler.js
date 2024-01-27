import { OggLogicalBitstream, OpusHead } from '../prism-media.js'
import { debugLog } from '../utils.js'
import config from '../../config.js'

import discordVoice from '@performanc/voice'

const Connections = {}

function setupConnection(ws, req) {
  let userId = req.headers['user-id']
  let guildId = req.headers['guild-id']

  if (!userId || !guildId) {
    debugLog('disconnectCD', 3, { code: 4001, reason: 'Invalid request.', guildId: 'unknown' })

    return ws.close(4001, 'Invalid request')
  }

  ws.on('close', (code, reason) => {
    debugLog('disconnectCD', 3, { code, reason, guildId })

    delete Connections[userId]
  })

  ws.on('error', (err) => {
    debugLog('disconnectCD', 3, { error: `Error: ${err.message}`, guildId })

    delete Connections[userId]
  })

  Connections[userId] = {
    ws,
    guildId
  }

  debugLog('connectCD', 3, { headers: req.headers, guildId })
}

function handleStartSpeaking(ssrc, userId, guildId) {
  const opusStream = discordVoice.getSpeakStream(ssrc)

  if (config.voiceReceive.audioType === 'ogg/opus') {
    const oggStream = new OggLogicalBitstream({
      opusHead: new OpusHead({
        channelCount: 2,
        sampleRate: 48000
      }),
      pageSizeControl: {
        maxPackets: 10
      }
    })

    let buffer = []
    oggStream.on('data', (chunk) => {
      if (Object.keys(Connections).length === 0) {
        oggStream.destroy()
        opusStream.destroy()
        buffer = null

        return;
      }

      buffer.push(chunk)
    })

    opusStream.on('end', () => {   
      oggStream.destroy()

      let i = 0

      const connectionsArray = Object.keys(Connections)

      if (connectionsArray.length === 0) {
        buffer = []

        return;
      }

      const endSpeakingResponse = JSON.stringify({
        op: 'speak',
        type: 'endSpeakingEvent',
        data: {
          userId,
          guildId,
          data: Buffer.concat(buffer).toString('base64'),
          type: 'ogg/opus'
        }
      })

      connectionsArray.forEach((botId) => {
        if (Connections[botId].guildId !== guildId) return;

        Connections[botId].ws.send(endSpeakingResponse)

        i++
      })

      buffer = []

      debugLog('sentDataCD', 3, { clientsAmount: i, guildId })
    })

    opusStream.pipe(oggStream)

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
  } else {
    let buffer = []
    opusStream.on('data', (chunk) => {
      if (Object.keys(Connections).length === 0) {
        opusStream.destroy()
        buffer = null

        return;
      }

      buffer.push(chunk)
    })

    opusStream.on('end', () => {
      let i = 0

      const connectionsArray = Object.keys(Connections)

      if (connectionsArray.length === 0) {
        buffer = []

        return;
      }

      const endSpeakingResponse = JSON.stringify({
        op: 'speak',
        type: 'endSpeakingEvent',
        data: {
          userId,
          guildId,
          data: Buffer.concat(buffer).toString('base64'),
          type: 'pcm'
        }
      })

      connectionsArray.forEach((botId) => {
        if (Connections[botId].guildId !== guildId) return;

        Connections[botId].ws.send(endSpeakingResponse)

        i++
      })

      buffer = []

      debugLog('sentDataCD', 3, { clientsAmount: i, guildId })
    })

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
}

export default {
  setupConnection,
  handleStartSpeaking
}