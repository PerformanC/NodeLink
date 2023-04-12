import os from 'os'
import https from 'https'
import { URLSearchParams, parse } from 'url'
import { Readable } from 'stream'

import config from '../config.js'
import constants from '../constants.js'
import utils from './utils.js'
import sources from './sources.js'

import * as djsVoice from '@discordjs/voice'
import prism from 'prism-media'

const adapters = new Map()
const clients = new Map()

let nodelinkPlayersCount = 0, nodelinkPlayingPlayersCount = 0

class replayableStream extends Readable {
  constructor() {
    super()
    this.data = []
    this.i = 0
  }

  read() {
    if (this.i < this.data.length) {
      this.push(this.data[this.i])
      this.i++
    } else {
      this.push(null)
    }
  }

  _read() {
    return this.read()
  }

  write(chunk) {
    this.data.push(chunk)
  }

  _write(chunk) {
    return this.write(chunk)
  }

  _destroy() {
    this.data = []
    this.i = 0
  }

  _reset() {
    this.i = 0
  }

  end() {
    this.data.push(null)
  }
} 

function voiceAdapterCreator(userId, guildId) {
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
      track: null,
      stream: [ null, null ]
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
    nodelinkPlayingPlayersCount--
              
    clearInterval(this.stateInterval)

    this.config.state = {
      time: Date.now(),
      position: 0,
      connected: false,
      ping: -1
    }
    this.config.track = null
    this.cache.stream = [ null, null ]
  }
  
  setup() {
    nodelinkPlayersCount++
  
    this.connection = djsVoice.joinVoiceChannel({ channelId: "", guildId: this.config.guildId, group: this.client.userId, adapterCreator: voiceAdapterCreator(this.client.userId, this.config.guildId) })
    this.player = djsVoice.createAudioPlayer()
  
    this.connection.on('stateChange', async (oldState, newState) => {
      switch (newState.status) {
        case djsVoice.VoiceConnectionStatus.Disconnected: {
          if (oldState.status == djsVoice.VoiceConnectionStatus.Disconnected) return;
  
          try {
            if (config.options.threshold) await djsVoice.entersState(this.connection, djsVoice.VoiceConnectionStatus.Signalling, config.options.threshold)
            if (config.options.threshold) await djsVoice.entersState(this.connection, djsVoice.VoiceConnectionStatus.Connecting, config.options.threshold)
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
            if (config.options.threshold) await djsVoice.entersState(this.connection, djsVoice.VoiceConnectionStatus.Ready, config.options.threshold)
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
          reason: 'finished'
        }))

        this._stopTrack()
      }
      if (newState.status == djsVoice.AudioPlayerStatus.Playing && oldState.status != djsVoice.AudioPlayerStatus.Paused && oldState.status != djsVoice.AudioPlayerStatus.AutoPaused) {
        nodelinkPlayingPlayersCount++
          
        if (config.options.playerUpdateInterval) this.stateInterval = setInterval(() => {
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
        }, config.options.playerUpdateInterval)
  
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

  async getResource(decodedTrack, urlInfo) {
    return new Promise(async (resolve) => {
      if (config.filters.enabled) https.get(urlInfo.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
          'range': 'bytes=0-'
        }
      }, (res) => {
        this.cache.stream[0] = res
      })
      https.get(urlInfo.url, (res) => {
        this.cache.stream[0] = res

        if ([ 'youtube', 'ytmusic', 'deezer', 'pandora', 'spotify' ].includes(decodedTrack.sourceName))
          resolve(new djsVoice.AudioResource([], [res, new prism.VolumeTransformer({ type: 's16le' }), new prism.opus.WebmDemuxer()], urlInfo.url, 5))
        else
          resolve(new djsVoice.AudioResource(res, { inputType: djsVoice.StreamType.Arbitrary, inlineVolume: true }))
      })
    })
  }
  
  async play(track, noReplace) {
    if (noReplace && this.config.track) return;

    const decodedTrack = utils.decodeTrack(track)

    const oldTrack = this.config.track

    this.config.track = { encoded: track, info: decodedTrack }
  
    const urlInfo = await sources.getTrackURL(decodedTrack)

    if (urlInfo.status) {
      this.config.track = null
  
      this.client.ws.send(JSON.stringify({
        op: 'event',
        type: 'TrackExceptionEvent',
        guildId: this.config.guildId,
        track: decodedTrack,
        exception: urlInfo.exception
      }))
  
      return this.config
    }

    if (oldTrack) {
      this.client.ws.send(JSON.stringify({
        op: 'event',
        type: 'TrackEndEvent',
        guildId: this.config.guildId,
        track: oldTrack,
        reason: 'replaced'
      }))
    }

    console.log(`[NodeLink:play]: Playing track from ${decodedTrack.sourceName}: ${decodedTrack.title}`)

    let resource = await this.getResource(decodedTrack, urlInfo)
     
    resource.volume.setVolume(this.config.volume / 100)

    this.connection.subscribe(this.player)
    this.player.play(resource)
      
    try {
      if (config.options.threshold) await djsVoice.entersState(this.player, djsVoice.AudioPlayerStatus.Playing, config.options.threshold)
    
      if (oldTrack) {
        this.client.ws.send(JSON.stringify({
          op: 'event',
          type: 'TrackStartEvent',
          guildId: this.config.guildId,
          track: this.config.track
        }))
      }
    } catch (e) {
      console.log('[NodeLink:play]: Couldn\'t start playing track in time of threshold.')
  
      this.config.track = null
  
      this.client.ws.send(JSON.stringify({
        op: 'event',
        type: 'TrackStuckEvent',
        guildId: this.config.guildId,
        track: decodedTrack,
        thresholdMs: config.options.threshold
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
      reason: 'stopped'
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

  filters(filters) {
    if (this.player.state.status != djsVoice.AudioPlayerStatus.Playing || !config.filters.enabled) return this.config
  
    let commands = [
      '-analyzeduration', '0',
      '-loglevel', '0',
      '-threads', config.filters.threads,
      '-filter_threads', config.filters.threads,
      '-filter_complex_threads', config.filters.threads,
    ]

    let filterCommand = []    
    if (filters.volume) {
      if (!config.filters.list.volume) return this.config

      this.config.filters.volume = filters.volume

      filterCommand.push(`volume=${filters.volume}`)
    }

		if (filters.equalizer && Array.isArray(filters.equalizer) && filters.equalizer.length) {
      if (!config.filters.list.equalizer) return this.config

      this.config.filters.equalizer = filters.equalizer

			const bandSettings = [ { band: 0, gain: 0.2 }, { band: 1, gain: 0.2 }, { band: 2, gain: 0.2 }, { band: 3, gain: 0.2 }, { band: 4, gain: 0.2 }, { band: 5, gain: 0.2 }, { band: 6, gain: 0.2 }, { band: 7, gain: 0.2 }, { band: 8, gain: 0.2 }, { band: 9, gain: 0.2 }, { band: 10, gain: 0.2 }, { band: 11, gain: 0.2 }, { band: 12, gain: 0.2 }, { band: 13, gain: 0.2 }, { band: 14, gain: 0.2 }]

      filters.equalizer.forEach((eq) => {
        const cur = bandSettings.find(i => i.band == eq.band)
				if (cur) cur.gain = eq.gain
      })

      filterCommand.push(filters.equalizer.map((eq) => `equalizer=f=${eq.band}:width_type=h:width=1:g=${eq.gain}`).join(','))
		}

    if (filters.karaoke && filters.karaoke.level && filters.karaoke.monoLevel && filters.karaoke.filterBand && filters.karaoke.filterWidth) {
      if (!config.filters.list.karaoke) return this.config

      this.config.filters.karaoke = { level: filters.karaoke.level, monoLevel: filters.karaoke.monoLevel, filterBand: filters.karaoke.filterBand, filterWidth: filters.karaoke.filterWidth }

      filterCommand.push(`stereotools=mlev=${filters.karaoke.monoLevel}:mwid=${filters.karaoke.filterWidth}:k=${filters.karaoke.level}:kc=${filters.karaoke.filterBand}`)
    }
    if (filters.timescale && filters.timescale.speed && filters.timescale.pitch && filters.timescale.rate) {
      if (!config.filters.list.timescale) return this.config

      this.config.filters.timescale = { speed: filters.timescale.speed, pitch: filters.timescale.pitch, rate: filters.timescale.rate }

			const speeddif = 1.0 - filters.timescale.pitch
			const finalspeed = filters.timescale.speed + speeddif
			const ratedif = 1.0 - filters.timescale.rate

			filterCommand.push(`asetrate=48000*${filters.timescale.pitch + ratedif},atempo=${finalspeed},aresample=48000`)
		}

    if (filters.tremolo && filters.tremolo.frequency && filters.tremolo.depth) {
      if (!config.filters.list.tremolo) return this.config

      this.config.filters.tremolo = { frequency: filters.tremolo.frequency, depth: filters.tremolo.depth }

      filterCommand.push(`tremolo=f=${filters.tremolo.frequency}:d=${filters.tremolo.depth}`)
    }

    if (filters.vibrato && filters.vibrato.frequency && filters.vibrato.depth) {
      if (!config.filters.list.vibrato) return this.config

      this.config.filters.vibrato = { frequency: filters.vibrato.frequency, depth: filters.vibrato.depth }

      filterCommand.push(`vibrato=f=${filters.vibrato.frequency}:d=${filters.vibrato.depth}`)
    }

    if (filters.rotation && filters.rotation.rotationHz) {
      if (!config.filters.list.rotation) return this.config

      this.config.filters.rotation = { rotationHz: filters.rotation.rotationHz }

      filterCommand.push(`apulsator=hz=${filters.rotation.rotationHz}`)
    }

    if (filters.distortion && filters.distortion.sinOffset && filters.distortion.sinScale && filters.distortion.cosOffset && filters.distortion.cosScale && filters.distortion.tanOffset && filters.distortion.tanScale && filters.distortion.offset && filters.distortion.scale) {
      if (!config.filters.list.distortion) return this.config

      this.config.filters.distortion = { sinOffset: filters.distortion.sinOffset, sinScale: filters.distortion.sinScale, cosOffset: filters.distortion.cosOffset, cosScale: filters.distortion.cosScale, tanOffset: filters.distortion.tanOffset, tanScale: filters.distortion.tanScale, offset: filters.distortion.offset, scale: filters.distortion.scale }

      filterCommand.push(`afftfilt=real='hypot(re,im)*sin(0.1*${filters.distortion.sinOffset}*PI*t)*${filters.distortion.sinScale}+hypot(re,im)*cos(0.1*${filters.distortion.cosOffset}*PI*t)*${filters.distortion.cosScale}+hypot(re,im)*tan(0.1*${filters.distortion.tanOffset}*PI*t)*${filters.distortion.tanScale}+${filters.distortion.offset}':imag='hypot(re,im)*sin(0.1*${filters.distortion.sinOffset}*PI*t)*${filters.distortion.sinScale}+hypot(re,im)*cos(0.1*${filters.distortion.cosOffset}*PI*t)*${filters.distortion.cosScale}+hypot(re,im)*tan(0.1*${filters.distortion.tanOffset}*PI*t)*${filters.distortion.tanScale}+${filters.distortion.offset}':win_size=512:overlap=0.75:scale=${filters.distortion.scale}`)
    }

    if (filters.channelMix && filters.channelMix.leftToLeft && filters.channelMix.leftToRight && filters.channelMix.rightToLeft && filters.channelMix.rightToRight) {
      if (!config.filters.list.channelMix) return this.config

      this.config.filters.channelMix = { leftToLeft: filters.channelMix.leftToLeft, leftToRight: filters.channelMix.leftToRight, rightToLeft: filters.channelMix.rightToLeft, rightToRight: filters.channelMix.rightToRight }

      filterCommand.push(`pan=stereo|c0<c0*${filters.channelMix.leftToLeft}+c1*${filters.channelMix.rightToLeft}|c1<c0*${filters.channelMix.leftToRight}+c1*${filters.channelMix.rightToRight}`)
    }

    if (filters.lowPass && filters.lowPass.smoothing) {
      if (!config.filters.list.lowPass) return this.config
      this.config.filters.lowPass = { smoothing: filters.lowPass.smoothing }

      filterCommand.push(`lowpass=f=${filters.lowPass.smoothing / 500}`)
    }

    if (filterCommand.length) {
      commands.push('-f', 's16le', '-ar', '48000', '-ac', '2')
      commands.push('-af', filterCommand.join(','))
      commands.push('-ss', `${this.player.state.resource.playbackDuration}ms`)

      const res = this.cache.stream[1] ? this.cache.stream[1] : this.cache.stream[0]
      const resource = new djsVoice.AudioResource([], [res, new prism.FFmpeg({ args: commands }), new prism.VolumeTransformer({ type: 's16le' }), new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 }) ], this.player.state.resource.metadata, 5) 

      this.connection.subscribe(this.player)
      this.player.play(resource)

      let url = this.player.state.resource.metadata

      https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
          'range': `bytes=0-`
        }
      }, (res) => {
        this.cache.stream[1] = res
      })

      return this.config
    }
  }
}

function setupConnection(ws, req) {
  let sessionId

  if (config.options.statsInterval) setInterval(() => {
    if (ws.readyState != 1) return;
   
    ws.send(JSON.stringify({
      op: 'stats',
      players: nodelinkPlayingPlayersCount,
      playingPlayers: nodelinkPlayingPlayersCount,
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
    console.log(`[NodeLink:websocket]: Connection closed with websocket. (sessionId: ${sessionId}, code: ${code}, reason: ${reason == '' ? 'No reason provided' : reason})`)

    const client = clients.get(sessionId)

    if (client.timeoutFunction) {
      client.timeoutFunction = setTimeout(() => {
        if (clients.size == 1 && config.search.sources.youtube || config.search.sources.youtubeMusic)
          sources.youtube.stopInnertube()

        client.players.forEach((player) => player.destroy())
        clients.delete(sessionId)
      })
    } else {
      if (clients.size == 1 && config.search.sources.youtube || config.search.sources.youtubeMusic)
        sources.youtube.stopInnertube()

      clients.get(sessionId).players.forEach((player) => player.destroy())
      clients.delete(sessionId)
    }
  })

  if (req.headers['session-id']) {
    sessionId = req.headers['session-id']

    if (!clients.has(sessionId)) 
      console.log(`[NodeLink:websocket]: Failed to resume connection with websocket: The sessionId does not exist (sessionId: ${sessionId}). Starting a new connection instead.`)
    else {
      console.log(`[NodeLink:websocket]: Connection re-established with websocket. (sessionId: ${sessionId})`)

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

  sessionId = utils.generateSessionId()

  console.log(`[NodeLink:websocket]: Connection established with websocket. (sessionId: ${sessionId})`)

  clients.set(sessionId, { userId: req.headers['user-id'], ws, players: new Map() })

  ws.send(JSON.stringify({
    op: 'ready',
    resume: false,
    sessionId,
  }))
}

async function requestHandler(req, res) {
  const parsedUrl = parse(req.url)

  if (parsedUrl.pathname == '/v4/version') {
    console.log('[NodeLink:version]: Received request.')

    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(constants.NodeLinkVersion)
  }

  if (parsedUrl.pathname == '/v4/decodetrack') {
    console.log('[NodeLink:decodetrack]: Received request.')
    
    const encodedTrack = new URLSearchParams(parsedUrl.query).get('encodedTrack')

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(utils.decodeTrack(encodedTrack)))
  }

  if (parsedUrl.pathname == '/v4/decodetracks') {
    console.log('[NodeLink:decodetracks]: Received request.')

    let buffer = ''

    req.on('data', (buf) => buffer += buf)
    req.on('end', () => {
      if (config.debug.showReqBody) console.log(`[NodeLink:decodetracks]: Received request body: ${buffer}`)

      buffer = JSON.parse(buffer)

      const tracks = []

      buffer.forEach((encodedTrack) => tracks.push(utils.decodeTrack(encodedTrack)))

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(tracks))
    })
  }

  if (parsedUrl.pathname == '/v4/encodetrack') {
    console.log('[NodeLink:encodetrack]: Received request. (NodeLink endpoint only)')

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

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(utils.encodeTrack(buffer)))
    })
  }

  if (parsedUrl.pathname == '/v4/encodetracks') {
    console.log('[NodeLink:encodetracks]: Received request. (NodeLink endpoint only)')

    let buffer = ''

    req.on('data', (buf) => buffer += buf)
    req.on('end', () => {
      if (config.debug.showReqBody) console.log(`[NodeLink:encodetracks]: Received request body: ${buffer}`)

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
        tracks.push(utils.encodeTrack(track))
      })

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(tracks))
    })
  }

  if (parsedUrl.pathname == '/v4/stats') {
    console.log('[NodeLink:stats]: Received request.')

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      players: nodelinkPlayersCount,
      playingPlayers: nodelinkPlayingPlayersCount,
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
    console.log('[NodeLink:loadtracks]: Received request.')

    const identifier = new URLSearchParams(parsedUrl.query).get('identifier')

    console.log(`[NodeLink:loadtracks]: Identifier: ${identifier}`)

    let search

    const ytSearch = config.search.sources.youtube ? identifier.startsWith('ytsearch:') : null
    if (!search && (config.search.sources.youtube && (ytSearch || /^(https?:\/\/)?(www\.)?youtube\.com\/(?:shorts\/(?:\?v=)?[a-zA-Z0-9_-]{11}|playlist\?list=[a-zA-Z0-9_-]+|watch\?(?=.*v=[a-zA-Z0-9_-]{11})[^\s]+)$/.test(identifier))))
      search = await sources.youtube.search(ytSearch ? identifier.replace('ytsearch:', '') : identifier, 'youtube', ytSearch)

    const ytMusicSearch = config.search.sources.youtubeMusic ? identifier.startsWith('ytmsearch:') : null
    if (config.search.sources.youtubeMusic && (ytMusicSearch || /^(https?:\/\/)?(music\.)?youtube\.com\/(?:shorts\/(?:\?v=)?[a-zA-Z0-9_-]{11}|playlist\?list=[a-zA-Z0-9_-]+|watch\?(?=.*v=[a-zA-Z0-9_-]{11})[^\s]+)$/.test(identifier)))
      search = await sources.youtube.search(ytMusicSearch ? identifier.replace('ytmsearch:', '') : identifier, 'ytmusic', ytMusicSearch)

    const spSearch = config.search.sources.spotify ? identifier.startsWith('spsearch:') : null
    const spRegex = config.search.sources.youtube && config.search.sources.spotify && !spSearch ? /^https?:\/\/(?:open\.spotify\.com\/|spotify:)(?:.+)?(track|playlist|artist|episode|show|album)[/:]([A-Za-z0-9]+)/.exec(identifier) : null
    if (!search && (config.search.sources.youtube && config.search.sources.spotify && (spSearch || spRegex)))
       search = spSearch ? await sources.spotify.search(identifier.replace('spsearch:', '')) : await sources.spotify.loadFrom(identifier, spRegex)

    const dzRegex = config.search.sources.youtube && config.search.sources.deezer ? /^https?:\/\/(?:www\.)?deezer\.com\/(track|album|playlist)\/(\d+)$/.exec(identifier) : null
    if (!search && (config.search.sources.youtube && config.search.sources.deezer && dzRegex))
      search = await sources.deezer.loadFrom(identifier, dzRegex)

    const scSearch = config.search.sources.soundcloud.enabled ? identifier.startsWith('scsearch:') : null
    if (!search && (config.search.sources.soundcloud.enabled && (scSearch || /^https?:\/\/soundcloud\.com\/[a-zA-Z0-9-_]+\/[a-zA-Z0-9-_]+$/.test(identifier))))
      search = scSearch ? await sources.soundcloud.search(identifier.replace('scsearch:', '')) : await sources.soundcloud.loadFrom(identifier)

    const bcSearch = config.search.sources.bandcamp ? identifier.startsWith('bcsearch:') : null
    if (!search && (config.search.sources.bandcamp && (bcSearch || /https?:\/\/[\w-]+\.bandcamp\.com\/(track|album)\/[\w-]+/.test(identifier))))
      search = bcSearch ? await sources.bandcamp.search(identifier.replace('bcsearch:', '')) : await sources.bandcamp.loadFrom(identifier)

    const pdSearch = config.search.sources.pandora ? identifier.startsWith('pdsearch:') : null
    if (!search && (config.search.sources.pandora && (pdSearch || /^(https:\/\/www\.pandora\.com\/)((playlist)|(station)|(podcast)|(artist))\/.+/.test(identifier))))
      search = pdSearch ? await sources.pandora.search(identifier.replace('pdsearch:', '')) : await sources.pandora.loadFrom(identifier)

    if (!search && (config.search.sources.http && (identifier.startsWith('http://') || identifier.startsWith('https://'))))
      search = await sources.http.loadFrom(identifier)
    
    if (!search && (config.search.sources.local && identifier.startsWith('local:')))
      search = await sources.local.loadFrom(identifier.replace('local:', ''))

    if (!search) {
      console.log('[NodeLink:loadtracks]: No possible search source found.')

      search = { loadType: 'empty', data: {} }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(search))
  }

  if (/^\/v4\/sessions\/\{[a-zA-Z0-9_-]+\}$/.test(parsedUrl.pathname) && req.method == 'PATCH') {
    const sessionId = /^\/v4\/sessions\/\{([a-zA-Z0-9_-]+)\}$/.exec(parsedUrl.pathname)[1]

    let buffer = ''

    req.on('data', (buf) => buffer += buf)
    req.on('end', () => {
      if (config.debug.showReqBody) console.log(`[NodeLink:updateSession]: Received request body: ${buffer}`)

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

    if (!client) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({
        timestamp: new Date(),
        status: 404,
        trace: null,
        message: 'The provided session Id doesn\'t exist.',
        path: parsedUrl.pathname
      }))
    }

    if (req.method == 'GET') {
      if (/^\/v4\/sessions\/[A-Za-z0-9]+\/players\/\d+$/.test(parsedUrl.pathname)) {
        const guildId = /\/players\/(\d+)$/.exec(parsedUrl.pathname)[1]

        let player = client.players.get(guildId)

        if (!player) {
          player = new VoiceConnection(guildId, client.userId, client.sessionId, client.timeout)

          client.players.set(guildId, player)
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' })
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
        if (config.debug.showReqBody) console.log(`[NodeLink:updatePlayer]: Received request body: ${buffer}`)

        buffer = JSON.parse(buffer)

        const guildId = /\/players\/(\d+)$/.exec(parsedUrl.pathname)[1]
        let player = client.players.get(guildId)

        // Voice update
        if (buffer.voice != undefined) {
          console.log('[NodeLink:updatePlayer]: Received voice state update.')

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
          console.log(`[NodeLink:updatePlayer]: Received ${buffer.encodedTrack == null && player.config.track ? 'stop' : 'play'} request.`)

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
          console.log('[NodeLink:updatePlayer]: Received volume request.')

          if (!player) player = new VoiceConnection(guildId, client)

          player.volume(buffer.volume)

          client.players.set(guildId, player)
        }

        // Pause
        if (buffer.paused != undefined) {
          console.log('[NodeLink:updatePlayer]: Received pause request.')

          if (!player) player = new VoiceConnection(guildId, client)

          player.pause(buffer.paused == true)

          client.players.set(guildId, player)
        }

        // Filters
        if (buffer.filters != undefined) {
          console.log('[NodeLink:updatePlayer]: Received filters request.')

          if (!player) player = new VoiceConnection(guildId, client)

          player.filters(buffer.filters)

          client.players.set(guildId, player)
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(player.config))
      })
    }
  }
}

function startSourceAPIs() {
  if (clients.size != 0) return;

  if (config.search.sources.youtube || config.search.sources.youtubeMusic)
    sources.youtube.startInnertube()

  if (config.search.sources.spotify)
    sources.spotify.setSpotifyToken()

  if (config.search.sources.pandora)
    sources.pandora.setToken()
}

export default { setupConnection, requestHandler, startSourceAPIs }