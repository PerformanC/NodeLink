import prism from 'prism-media'
import * as djsVoice from '@discordjs/voice'

const Connections = {}

function setupConnection(ws, req) {
  const userId = req.headers['user-id']
  const guildId = req.headers['guild-id']

  if (!userId || !guildId) {
    console.log('[\u001b[31mwebsocketCD\u001b[39m]: Invalid request. Closing connection...')

    return ws.close(4001, 'Invalid request')
  }

  ws.on('close', (code, reason) => {
    console.log(`[\u001b[31mwebsocketCD\u001b[37m]: Closed connection with code \u001b[31m${code}\u001b[37m and reason \u001b[31m${reason == '' ? 'none' : reason}\u001b[37m`)

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

function handleStartSpeaking(receiver, userId, guildId) {
  const opusStream = receiver.subscribe(userId, {
    end: {
      behavior: djsVoice.EndBehaviorType.AfterSilence,
      duration: 1000
    }
  })

  const oggStream = new prism.opus.OggLogicalBitstream({
    opusHead: new prism.opus.OpusHead({
      channelCount: 2,
      sampleRate: 48000,
    }),
    pageSizeControl: {
      maxPackets: 10,
    }
  })

  const buffer = []
  oggStream.on('data', (chunk) => {
    if (Object.keys(Connections).length == 0) {
      oggStream.destroy()
      opusStream.destroy()

      return;
    }

    buffer.push(chunk)
  })

  oggStream.on('error', (err) => console.error(`[\u001b[31mwebsocketCD\u001b[37m]: \u001b[31m${err}\u001b[37m`))

  opusStream.on('end', () => {    
    oggStream.destroy()
    opusStream.destroy()

    let i = 0

    Object.keys(Connections).forEach((botId) => {
      if (Connections[botId].guildId != guildId) return;

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

    console.log(`[\u001b[31mwebsocketCD\u001b[37m]: Finished speaking. Sent data to \u001b[31m${i}\u001b[37m clients.`)
  })

  opusStream.pipe(oggStream)

  Object.keys(Connections).forEach((botId) => {
    if (Connections[botId].guildId != guildId) return;

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