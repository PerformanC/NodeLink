import { OggLogicalBitstream, OpusHead } from '../prism-media.js'
import discordVoice from '@performanc/voice'

const Connections = {}

function setupConnection(ws, req) {
  let userId = req.headers['user-id']
  let guildId = req.headers['guild-id']

  if (!userId || !guildId) {
    console.log('[\u001b[31mwebsocketCD\u001b[39m]: Invalid request. Closing connection...')

    return ws.close(4001, 'Invalid request')
  }

  ws.on('close', (code, reason) => {
    console.log(`[\u001b[31mwebsocketCD\u001b[37m]: Closed connection with code \u001b[31m${code}\u001b[37m and reason \u001b[31m${reason === '' ? 'none' : reason}\u001b[37m`)

    delete Connections[userId]
  })

  ws.on('error', (err) => {
    console.error(`[\u001b[31mwebsocketCD\u001b[37m]: \u001b[31m${err}\u001b[37m`)

    delete Connections[userId]
  })

  Connections[userId] = {
    ws,
    guildId
  }
}

function handleStartSpeaking(ssrc, userId, guildId) {
  const opusStream = discordVoice.getSpeakStream(ssrc)

  const oggStream = new OggLogicalBitstream({
    opusHead: new OpusHead({
      channelCount: 2,
      sampleRate: 48000,
    }),
    pageSizeControl: {
      maxPackets: 10,
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

  oggStream.on('error', (err) => {
    console.error(`[\u001b[31mwebsocketCD\u001b[37m]: \u001b[31m${err}\u001b[37m`)

    oggStream.destroy()
    opusStream.destroy()
    buffer = null
  })

  opusStream.on('end', () => {    
    oggStream.destroy()

    let i = 0

    Object.keys(Connections).forEach((botId) => {
      if (Connections[botId].guildId !== guildId) return;

      Connections[botId].ws.send(JSON.stringify({
        type: 'endSpeakingEvent',
        data: {
          userId,
          guildId,
          data: Buffer.concat(buffer).toString('base64')
        }
      }))

      i++
    })

    buffer = null

    console.log(`[\u001b[31mwebsocketCD\u001b[37m]: Finished speaking. Sent data to \u001b[31m${i}\u001b[37m clients.`)
  })

  opusStream.pipe(oggStream)

  Object.keys(Connections).forEach((botId) => {
    if (Connections[botId].guildId !== guildId) return;

    Connections[botId].ws.send(JSON.stringify({
      type: 'startSpeakingEvent',
      data: {
        userId,
        guildId
      }
    }))
  })
}

export default {
  setupConnection,
  handleStartSpeaking
}