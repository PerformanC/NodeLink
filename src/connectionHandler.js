import os from 'os'
import { URLSearchParams, parse } from 'url'

import config from '../config.js'
import constants from '../constants.js'
import utils from './utils.js'
import sources from './sources.js'

import * as djsVoice from '@discordjs/voice'

const adapters = new Map()
const clients = new Map()

let nodelinkStats = {
  players: 0,
  playingPlayers: 0
}

function nodelink_voiceAdapterCreator(userId, guildId) {
  return (methods) => {
    adapters.set(`${userId}/${guildId}`, methods)

    return {
      sendPayload(data) {
        return !!data
      },
      destroy() {
        return adapters.delete(`${userId}/${guildId}`)
      }
    }
  }
}
 
class VoiceConnection {
  constructor(guildId, client) {
    this.connection
    this.player
    this.client = client
    this.cache = {
      voice: null,
      track: null
    }
    this.stateInterval
  
    this.config = {
      guildId,
      track: null,
      volume: 100,
      paused: false,
      state: {
        time: 0,
        position: 0,
        connected: false,
        ping: 0
      },
      filters: {},
      voice: {
        token: null,
        endpoint: null,
        sessionId: null
      }
    }
  }

  _stopTrack() {
    nodelinkStats.playingPlayers--
              
    clearInterval(this.stateInterval)

    this.config.state = {
      time: Date.now(),
      position: 0,
      connected: false,
      ping: -1
    }
    this.config.track = null
  }
  
  setup() {
    nodelinkStats.players++
  
    this.connection = djsVoice.joinVoiceChannel({ channelId: "", guildId: this.config.guildId, group: this.client.userId, adapterCreator: nodelink_voiceAdapterCreator(this.client.userId, this.config.guildId) })
    this.player = djsVoice.createAudioPlayer()
  
    this.connection.on('stateChange', async (oldState, newState) => {
      switch (newState.status) {
        case djsVoice.VoiceConnectionStatus.Disconnected: {
          if (oldState.status == djsVoice.VoiceConnectionStatus.Disconnected) return;
  
          try {
            await djsVoice.entersState(this.connection, djsVoice.VoiceConnectionStatus.Signalling, config.options.threshold)
            await djsVoice.entersState(this.connection, djsVoice.VoiceConnectionStatus.Connecting, config.options.threshold)
          } catch (e) {
            this._stopTrack()
  
            if (newState.reason == djsVoice.VoiceConnectionDisconnectReason.WebSocketClose) {
              this.client.ws.send(JSON.stringify({
                op: 'event',
                type: 'WebSocketClosedEvent',
                guildId: this.config.guildId,
                code: newState.closeCode,
                reason: constants.VoiceWSCloseCodes[newState.closeCode],
                byRemote: true
              }))
            } else {
              this.client.ws.send(JSON.stringify({
                op: 'event',
                type: 'WebSocketClosedEvent',
                guildId: this.config.guildId,
                code: 4000,
                reason: 'Could not connect in time of set threshold.',
                byRemote: true
              }))
            }
          }
          break;
        }
        case djsVoice.VoiceConnectionStatus.Signalling:
        case djsVoice.VoiceConnectionStatus.Connecting: {
          if (oldState.status == djsVoice.VoiceConnectionStatus.Ready)
            this.connection.configureNetworking()

          try {
            await djsVoice.entersState(this.connection, djsVoice.VoiceConnectionStatus.Ready, config.options.threshold)
          } catch {
            this._stopTrack()
  
            this.client.ws.send(JSON.stringify({
              op: 'event',
              type: 'WebSocketClosedEvent',
              guildId: this.config.guildId,
              code: 4000,
              reason: 'Could not be ready in time of set threshold.',
              byRemote: true
            }))
          }
          break;
        }
      }
    })
    
    this.player.on('stateChange', (oldState, newState) => {
      if (newState.status == djsVoice.AudioPlayerStatus.Idle && oldState.status != djsVoice.AudioPlayerStatus.Idle) {  
        this.client.ws.send(JSON.stringify({
          op: 'event',
          type: 'TrackEndEvent',
          guildId: this.config.guildId,
          track: this.config.track,
          reason: 'FINISHED'
        }))

        this._stopTrack()
      }
      if (newState.status == djsVoice.AudioPlayerStatus.Playing && oldState.status != djsVoice.AudioPlayerStatus.Paused && oldState.status != djsVoice.AudioPlayerStatus.AutoPaused) {
        nodelinkStats.playingPlayers++
          
        this.stateInterval = setInterval(() => {
          this.config.state = {
            time: Date.now(),
            position: this.player.state.status == djsVoice.AudioPlayerStatus.Playing ? this.player.state.resource.playbackDuration : 0,
            connected: this.player.state.status == djsVoice.AudioPlayerStatus.Playing,
            ping: this.connection.state.status == djsVoice.VoiceConnectionStatus.Ready ? this.connection.ping.ws : -1
          }
      
          this.client.ws.send(JSON.stringify({
            op: 'playerUpdate',
            guildId: this.config.guildId,
            state: this.config.state
          }))
        }, config.options.stateInterval)
  
        this.client.ws.send(JSON.stringify({
          op: 'event',
          type: 'TrackStartEvent',
          guildId: this.config.guildId,
          track: this.config.track
        }))
      }
    })
    
    this.player.on('error', (error) => {
      this._stopTrack()
  
      this.client.ws.send(JSON.stringify({
        op: 'event',
        type: 'TrackExceptionEvent',
        guildId: this.config.guildId,
        track: this.config.track,
        exception: {
          message: error.message,
          severity: 'COMMON',
          cause: 'unknown'
        }
      }))
    })
  }
  
  updateVoice(buffer) {
    this.cache.voice = buffer

    const adapter = adapters.get(`${this.client.userId}/${this.config.guildId}`)
  
    if (!adapter) return;
  
    adapter.onVoiceStateUpdate({ channel_id: "", guild_id: this.config.guildId, user_id: this.client.userId, session_id: buffer.sessionId, deaf: false, self_deaf: false, mute: false, self_mute: false, self_video: false, suppress: false, request_to_speak_timestamp: null })
    adapter.onVoiceServerUpdate({ token: buffer.token, guild_id: this.config.guildId, endpoint: buffer.endpoint })

    this.cache.voice = null
    this.config.voice = buffer
  }
  
  destroy() {
    if (this.player) this.player.stop()
    if (this.connection) this.connection.destroy()
  
    this.client.players.delete(this.config.guildId)
  }
  
  async play(track, noReplace) {
    if (noReplace && this.config.track) return;

    if (this.config.track) this.client.ws.send(JSON.stringify({
      op: 'event',
      type: 'TrackEndEvent',
      guildId: this.config.guildId,
      track: this.config.track,
      reason: 'REPLACED'
    }))

    const encodedTrack = utils.nodelink_decodeTrack(track)

    this.config.track = { encoded: track, info: encodedTrack }
  
    const url = await sources.getTrackURL(encodedTrack.identifier, encodedTrack.sourceName)

    if (!url) {
      this.config.track = null
  
      this.client.ws.send(JSON.stringify({
        op: 'event',
        type: 'TrackExceptionEvent',
        guildId: this.config.guildId,
        track: encodedTrack,
        exception: {
          message: 'No playable sources found',
          severity: 'COMMON',
          cause: 'unknown'
        }
      }))
  
      return this.config
    }

    console.log(`[NodeLink]: Playing "${encodedTrack.title}", from ${encodedTrack.sourceName}.`)

    const resource = djsVoice.createAudioResource(url, { inputType: encodedTrack.sourceName == 'youtube' ? djsVoice.StreamType.WebmOpus : djsVoice.StreamType.Arbitrary, inlineVolume: true })
    resource.volume.setVolume(this.config.volume / 100)

    this.connection.subscribe(this.player)
    this.player.play(resource)
      
    try {
      await djsVoice.entersState(this.player, djsVoice.AudioPlayerStatus.Playing, config.options.threshold)
    } catch (e) {
      console.log('[NodeLink]: Connection timed out')
  
      this.config.track = null
  
      this.client.ws.send(JSON.stringify({
        op: 'event',
        type: 'WebSocketClosedEvent',
        guildId: this.config.guildId,
        track: encodedTrack,
        code: 4000,
        reason: 'Connection timed out',
        byRemote: true
      }))
    }
  
    return this.config
  }

  stop() {
    this.player.stop()
  
    this.client.ws.send(JSON.stringify({
      op: 'event',
      type: 'TrackEndEvent',
      guildId: this.config.guildId,
      track: this.config.track,
      reason: 'STOPPED'
    }))

    this._stopTrack()
  }
  
  volume(volume) {
    this.player.state.resource.volume.setVolume(volume / 100)
  
    this.config.volume = volume / 100
  
    return this.config
  }
  
  pause(pause) {
    if (pause) this.player.pause()
    else this.player.unpause()
  
    this.config.paused = pause
  
    return this.config
  }
}

function nodelink_setupConnection(ws, req) {
  let sessionId

  setInterval(() => {
    if (ws.readyState != 1) return;
   
    ws.send(JSON.stringify({
      op: 'stats',
      players: nodelinkStats.playingPlayers,
      playingPlayers: nodelinkStats.playingPlayers,
      uptime: Math.floor(process.uptime() * 1000),
      memory: {
        free: process.memoryUsage().heapTotal - process.memoryUsage().heapUsed,
        used: process.memoryUsage().heapUsed,
        allocated: 0,
        reservable: process.memoryUsage().rss
      },
      cpu: {
        cores: os.cpus().length,
        systemLoad: os.loadavg()[0],
        lavalinkLoad: 0
      },
      frameStats: null
    }))
  }, config.options.statsInterval)

  ws.on('close', (code, reason) => {
    console.log(`[NodeLink]: Connection closed with v4 websocket server (sessionId: ${sessionId}, code: ${code}, reason: ${reason == '' ? 'No reason provided' : reason})`)

    const client = clients.get(sessionId)

    if (client.timeoutFunction) {
      client.timeoutFunction = setTimeout(() => {
        if (clients.size == 1 && config.search.sources.youtube)
          sources.stopInnertube()

        client.players.forEach((player) => player.destroy())
        clients.delete(sessionId)
      })
    } else {
      if (clients.size == 1 && config.search.sources.youtube)
        sources.stopInnertube()

      clients.get(sessionId).players.forEach((player) => player.destroy())
      clients.delete(sessionId)
    }
  })

  if (req.headers['session-id']) {
    sessionId = req.headers['session-id']

    if (!clients.has(sessionId)) 
      console.log(`[NodeLink]: Failed to resume connection with v4 websocket server: The sessionId does not exist (sessionId: ${sessionId}). Starting a new connection instead.`)
    else {
      console.log(`[NodeLink]: Connection re-established with v4 websocket server, sessionId: ${sessionId}`)

      const client = clients.get(sessionId)

      clearTimeout(client.timeoutFunction)

      clients.set(sessionId, { ...client, timeout: null })

      ws.send(JSON.stringify({
        op: 'ready',
        resume: true,
        sessionId: req.headers['session-id'],
      }))
    }
  }

  sessionId = utils.nodelink_generateSessionId()

  console.log(`[NodeLink]: Connection established with v4 websocket server, sessionId: ${sessionId}`)

  clients.set(sessionId, { userId: req.headers['user-id'], ws, players: new Map() })

  ws.send(JSON.stringify({
    op: 'ready',
    resume: false,
    sessionId,
  }))
}

async function nodelink_requestHandler(req, res) {
  const parsedUrl = parse(req.url)

  if (parsedUrl.pathname == '/v4/version') {
    console.log('[NodeLink]: Received version request')

    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(constants.NodeLinkVersion)
  }

  if (parsedUrl.pathname == '/v4/decodetrack') {
    console.log('[NodeLink]: Received decodetrack request')
    
    const encodedTrack = new URLSearchParams(parsedUrl.query).get('encodedTrack')

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(utils.nodelink_decodeTrack(encodedTrack)))
  }

  if (parsedUrl.pathname == '/v4/decodetracks') {
    console.log('[NodeLink]: Received decodetracks request')

    let buffer = ''

    req.on('data', (buf) => buffer += buf)
    req.on('end', () => {
      if (config.debug.showReqBody) console.log(`[NodeLink]: Received request body: ${buffer}`)

      buffer = JSON.parse(buffer)

      const tracks = []

      buffer.forEach((encodedTrack) => tracks.push(utils.nodelink_decodeTrack(encodedTrack)))

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(tracks))
    })
  }

  if (parsedUrl.pathname == '/v4/encodetrack') {
    console.log('[NodeLink]: Received encodetrack request (NodeLink endpoint only)')

    let buffer = ''

    req.on('data', (buf) => buffer += buf)
    req.on('end', () => {
      buffer = JSON.parse(buffer)

      if (!buffer.title || !buffer.author || !buffer.length || !buffer.identifier || !buffer.isSeekable || !buffer.isStream || !buffer.position) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          timestamp: Date.now(),
          status: 400,
          error: 'Bad Request',
          trace: null,
          message: 'Invalid track object',
          path: '/v4/encodetrack'
        }))

        return;
      }

      res.writeHeWhad(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(utils.nodelink_encodeTrack(buffer)))
    })
  }

  if (parsedUrl.pathname == '/v4/encodetracks') {
    console.log('[NodeLink]: Received encodetracks request (NodeLink endpoint only)')

    let buffer = ''

    req.on('data', (buf) => buffer += buf)
    req.on('end', () => {
      if (config.debug.showReqBody) console.log(`[NodeLink]: Received request body: ${buffer}`)

      buffer = JSON.parse(buffer)

      const tracks = []

      buffer.forEach((track) => {
        if (!track.title || !track.author || !track.length || !track.identifier || !track.isSeekable || !track.isStream || !track.position) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            timestamp: Date.now(),
            status: 400,
            error: 'Bad Request',
            trace: null,
            message: 'Invalid track object',
            path: '/v4/encodetracks'
          }))

          return;
        }
        tracks.push(utils.nodelink_encodeTrack(track))
      })

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(tracks))
    })
  }

  if (parsedUrl.pathname == '/v4/stats') {
    console.log('[NodeLink]: Received stats request')

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      players: nodelinkStats.players,
      playingPlayers: nodelinkStats.playingPlayers,
      uptime: Math.floor(process.uptime() * 1000),
      memory: {
        free: process.memoryUsage().heapTotal - process.memoryUsage().heapUsed,
        used: process.memoryUsage().heapUsed,
        allocated: 0,
        reservable: process.memoryUsage().rss
      },
      cpu: {
        cores: os.cpus().length,
        systemLoad: os.loadavg()[0],
        lavalinkLoad: 0
      },
      frameStats: null
    }))
  }

  if (parsedUrl.pathname == '/v4/loadtracks') {
    console.log('[NodeLink]: Received loadtracks request')

    let identifier = new URLSearchParams(parsedUrl.query).get('identifier')

    console.log(`[NodeLink]: Loading track for identifier "${identifier}"`)

    let search

    const ytSearch = config.search.sources.youtube ? identifier.startsWith('ytsearch:') : null
    if (config.search.sources.youtube && (ytSearch || /^(?:https?:\/\/)?(?:www\.)?(?:m\.)?(?:youtu\.be\/|(?:youtube\.com\/(?:watch\?(?=.*v=[\w-]+)(?:\S+&)?list=([\w-]+)))?(?:\S*\/)?([\w-]+))(?:\S*)?$/.test(identifier)))
      search = await sources.searchOnYoutube(ytSearch ? identifier.replace('ytsearch:', '') : identifier, ytSearch ? 1 : sources.checkYouTubeURLType(identifier))

    if (config.search.sources.youtube && config.search.sources.spotify && /(?:https:\/\/open\.spotify\.com\/|spotify:)(?:.+)?(track|playlist|artist|episode|show|album)[/:]([A-Za-z0-9]+)/.test(identifier))
      search = await sources.loadFromSpotify(identifier)

    if (config.search.sources.youtube && config.search.sources.deezer && /^https?:\/\/(?:www\.)?deezer\.com\/(track|album|playlist)\/(\d+)$/.test(identifier))
      search = await sources.loadFromDeezer(identifier)

    const scSearch = config.search.sources.soundcloud.enabled ? identifier.startsWith('scsearch:') : null
    if (config.search.sources.soundcloud.enabled && (scSearch || /^https?:\/\/soundcloud\.com\/[a-zA-Z0-9-_]+\/[a-zA-Z0-9-_]+$/.test(identifier)))
      search = await sources.searchOnSoundcloud(scSearch ? identifier.replace('scsearch:', '') : identifier, scSearch ? 1 : 0)

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(search))
  }

  if (/^\/v4\/sessions\/\{[a-zA-Z0-9_-]+\}$/.test(parsedUrl.pathname) && req.method == 'PATCH') {
    const sessionId = /^\/v4\/sessions\/\{([a-zA-Z0-9_-]+)\}$/.exec(parsedUrl.pathname)[1]

    let buffer = ''

    req.on('data', (buf) => buffer += buf)
    req.on('end', () => {
      if (config.debug.showReqBody) console.log(`[NodeLink]: Received request body: ${buffer}`)

      buffer = JSON.parse(buffer)

      clients.set(sessionId, { ...clients.get(sessionId), timeout: buffer.timeout * 1000 })

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        resuming: buffer.resuming,
        timeout: buffer.timeout
      }))
    })
  }

  if (/^\/v4\/sessions\/\w+\/players\/\w+./.test(parsedUrl.pathname)) {
    const client = clients.get(/^\/v4\/sessions\/([A-Za-z0-9]+)\/players\/\d+$/.exec(parsedUrl.pathname)[1])

    if (req.method == 'GET') {
      if (/^\/v4\/sessions\/[A-Za-z0-9]+\/players\/\d+$/.test(parsedUrl.pathname)) {
        const guildId = /\/players\/(\d+)$/.exec(parsedUrl.pathname)[1]

        let player = client.players.get(guildId)

        res.writeHead(200, { 'Content-Type': 'application/json' })
        if (!player) {
          player = new VoiceConnection(guildId, client.userId, client.sessionId, client.timeout)

          client.players.set(guildId, player)
        }
        
        res.end(JSON.stringify(player.config))
      } else {
        const players = []

        client.players.forEach((player) => players.push(player.config))

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(players))
      }
    } else if (req.method == 'PATCH') {  
      let buffer = ''

      req.on('data', (buf) => buffer += buf)
      req.on('end', () => {
        if (config.debug.showReqBody) console.log(`[NodeLink]: Received request body: ${buffer}`)

        buffer = JSON.parse(buffer)

        const guildId = /\/players\/(\d+)$/.exec(parsedUrl.pathname)[1]
        let player = client.players.get(guildId)

        // Voice update
        if (buffer.voice != undefined) {
          console.log('[NodeLink]: Received voice state update')

          if (!player) player = new VoiceConnection(guildId, client)

          if (player.cache.track) {
            player.setup()
            player.play(player.cache.track, false)

            player.cache.track = null
          }

          player.updateVoice(buffer.voice)

          client.players.set(guildId, player)
        }

        // Play
        if (buffer.encodedTrack !== undefined || buffer.encodedTrack === null) {
          console.log('[NodeLink]: Received play request')

          const noReplace = new URLSearchParams(parsedUrl.query).get('noReplace')

          if (!player) player = new VoiceConnection(guildId, client)

          if (buffer.encodedTrack == null && player.config.track) player.stop()
          else {
            if (!player.cache.voice && !player.config.voice.endpoint) player.cache.track = buffer.encodedTrack
            else {
              if (!player.connection) player.setup()
              if (!player.config.voice.endpoint) player.updateVoice(player.cache.voice)
              player.play(buffer.encodedTrack, noReplace == true)
            }
          }

          client.players.set(guildId, player)
        }

        // Volume
        if (buffer.volume != undefined) {
          console.log('[NodeLink]: Received volume request')

          if (!player) player = new VoiceConnection(guildId, client)

          player.volume(buffer.volume)

          client.players.set(guildId, player)
        }

        // Pause
        if (buffer.paused != undefined) {
          console.log('[NodeLink]: Received pause request')

          if (!player) player = new VoiceConnection(guildId, client)

          player.pause(buffer.paused == true)

          client.players.set(guildId, player)
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(player.config))
      })
    }
  }
}

function nodelink_startSourceAPIs() {
  if (clients.size != 0) return;

  if (config.search.sources.youtube)
    sources.startInnertube()

  if (config.search.sources.spotify)
    sources.setSpotifyToken()
}

export default { nodelink_setupConnection, nodelink_requestHandler, nodelink_startSourceAPIs }