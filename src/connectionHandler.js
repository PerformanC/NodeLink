import fs from 'fs'
import os from 'os'
import https from 'https'
import http from 'http'
import { URLSearchParams, parse } from 'url'

import config from '../config.js'
import constants from '../constants.js'
import utils from './utils.js'
import sources from './sources.js'
import Filters from './filters.js'

import * as djsVoice from '@discordjs/voice'

const adapters = new Map()
const clients = new Map()

let nodelinkPlayersCount = 0, nodelinkPlayingPlayersCount = 0

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
      startedAt: 0,
      silence: false,
      ffmpeg: null,
      url: null,
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

    this.connection = null
    this.player = null
  }

  _stopTrack() {
    nodelinkPlayingPlayersCount--

    fs.rm(`./cache/${this.config.guildId}.webm`, { force: true }, () => {})

    if (this.stateInterval) clearInterval(this.stateInterval)

    this.config.state = {
      time: null,
      position: 0,
      connected: false,
      ping: -1
    }

    this.cache.startedAt = 0
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
            if (config.options.threshold) await djsVoice.entersState(this.connection, djsVoice.VoiceConnectionStatus.Connecting, config.options.threshold)
          } catch (e) {
            utils.debugLog('websocketClosed', 2, { track: this.config.track.info, guildId: this.config.guildId, exception: constants.VoiceWSCloseCodes[newState.closeCode] })

            this._stopTrack()
            this.config.track = null

            if (newState.reason == djsVoice.VoiceConnectionDisconnectReason.WebSocketClose) {
              this.client.ws.send(JSON.stringify({
                op: 'event',
                type: 'WebSocketClosedEvent',
                guildId: this.config.guildId,
                code: newState.closeCode,
                reason: constants.VoiceWSCloseCodes[newState.closeCode],
                byRemote: true
              }))
            }
          }
          break;
        }
      }
    })

    this.player.on('stateChange', (oldState, newState) => {
      if (newState.status == djsVoice.AudioPlayerStatus.Idle && oldState.status != djsVoice.AudioPlayerStatus.Idle) {
        if (this.cache.silence) return (this.cache.silence = false)

        this._stopTrack()
        this.config.track = null
        this.cache.url = null

        utils.debugLog('trackEnd', 2, { track: this.config.track.info, guildId: this.config.guildId, reason: 'finished' })

        this.client.ws.send(JSON.stringify({
          op: 'event',
          type: 'TrackEndEvent',
          guildId: this.config.guildId,
          track: this.config.track,
          reason: 'finished'
        }))
      }
    })

    this.player.on('error', (error) => {
      this._stopTrack()
      this.config.track = null

      utils.debugLog('trackException', 2, { track: this.config.track.info, guildId: this.config.guildId, exception: error.message })

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

  trackStarted() {
    nodelinkPlayingPlayersCount++
          
    if (config.options.playerUpdateInterval) this.stateInterval = setInterval(() => {
      this.config.state = {
        time: Date.now(),
        position: this.player.state.status == djsVoice.AudioPlayerStatus.Playing ? new Date() - this.cache.startedAt : 0,
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

  updateVoice(buffer) {
    this.config.voice = buffer

    const adapter = adapters.get(`${this.client.userId}/${this.config.guildId}`)

    if (!adapter) return;

    adapter.onVoiceStateUpdate({ channel_id: "", guild_id: this.config.guildId, user_id: this.client.userId, session_id: buffer.sessionId, deaf: false, self_deaf: false, mute: false, self_mute: false, self_video: false, suppress: false, request_to_speak_timestamp: null })
    adapter.onVoiceServerUpdate({ token: buffer.token, guild_id: this.config.guildId, endpoint: buffer.endpoint })
  }

  destroy() {
    if (this.player) this.player.stop(true)

    if (this.cache.ffmpeg)
      this.cache.ffmpeg.destroy()

    this._stopTrack()
    this.config.track = null

    if (this.connection) this.connection.destroy()

    this.client.players.delete(this.config.guildId)
  }

  async getResource(sourceName, url, protocol) {
    return new Promise(async (resolve) => {
      if (protocol == 'file') {
        const file = fs.createReadStream(url)

        file.on('error', () => {
          utils.debugLog('retrieveStream', 4, { type: 2, sourceName: sourceName, message: 'Failed to get the stream from source.' })

          resolve({ status: 1, exception: { message: 'Failed to get the stream from source.', severity: 'UNCOMMON', cause: 'unknown' } })
        })

        this.cache.url = url
        resolve({ stream: djsVoice.createAudioResource(file, { inputType: djsVoice.StreamType.Arbitrary, inlineVolume: true }) })
      } else {
        (protocol == 'https' ? https : http).get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
            'Range': 'bytes=0-'
          }
        }, (res) => {
          res.on('error', () => {})

          if (res.statusCode != 206) {
            res.destroy()

            utils.debugLog('retrieveStream', 4, { type: 2, sourceName: sourceName, message: 'Failed to get the stream from source.' })

            resolve({ status: 1, exception: { message: 'Failed to get the stream from source.', severity: 'UNCOMMON', cause: 'unknown' } })
          }

          this.cache.url = url

          if ([ 'youtube', 'ytmusic', 'deezer', 'pandora', 'spotify' ].includes(sourceName))
            resolve({ stream: djsVoice.createAudioResource(url, { inputType: djsVoice.StreamType.WebmOpus, inlineVolume: true }) })
          else
            resolve({ stream: djsVoice.createAudioResource(url, { inputType: djsVoice.StreamType.Arbitrary, inlineVolume: true }) })
        }).on('error', () => {
          utils.debugLog('retrieveStream', 4, { type: 2, sourceName: sourceName, message: 'Failed to get the stream from source.' })

          resolve({ status: 1, exception: { message: 'Failed to get the stream from source.', severity: 'UNCOMMON', cause: 'unknown' } })
        })
      }
    })
  }

  async play(track, noReplace) {
    if (noReplace && this.config.track) return this.config

    const decodedTrack = utils.decodeTrack(track)

    const oldTrack = this.config.track

    this.config.track = { encoded: track, info: decodedTrack }

    const urlInfo = await sources.getTrackURL(decodedTrack)

    if (urlInfo.exception) {
      this.config.track = null
      this.cache.url = null

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
      utils.debugLog('trackEnd', 2, { track: decodedTrack, guildId: this.config.guildId, reason: 'replaced' })

      this.client.ws.send(JSON.stringify({
        op: 'event',
        type: 'TrackEndEvent',
        guildId: this.config.guildId,
        track: oldTrack,
        reason: 'replaced'
      }))
    }

    let resource = null
    let filterEnabled = false

    if (Object.keys(this.config.filters).length > 0) {
      const filter = new Filters(this.config.filters, urlInfo.url, this.config.guildId, new Date())

      this.config.filters = filter.configure(this.config.filters)

      if (oldTrack) this._stopTrack(true)

      filterEnabled = true
      resource = await filter.createResource(this.config.guildId, urlInfo.protocol, urlInfo.url, null, null, this.cache.ffmpeg)  
    } else {
      this.cache.url = urlInfo.url
      resource = await this.getResource(decodedTrack.sourceName, urlInfo.url, urlInfo.protocol)

      if (oldTrack) this._stopTrack(true)
    }
  
    if (resource.exception) {
      this.config.track = null
      this.config.filters = null
      this.cache.url = null

      utils.debugLog('trackException', 2, { track: decodedTrack, guildId: this.config.guildId, exception: resource.exception.message })

      this.client.ws.send(JSON.stringify({
        op: 'event',
        type: 'TrackExceptionEvent',
        guildId: this.config.guildId,
        track: this.config.track.info,
        exception: resource.exception
      }))

      return this.config
    }
  
    if (filterEnabled) this.cache.ffmpeg = resource.ffmpeg

    if (this.player.subscribers.length == 0) this.connection.subscribe(this.player)
    this.player.play(resource.stream)

    try {
      if (config.options.threshold) await djsVoice.entersState(this.player, djsVoice.AudioPlayerStatus.Playing, config.options.threshold)

      this.cache.startedAt = Date.now()

      utils.debugLog('trackStart', 2, { track: decodedTrack, guildId: this.config.guildId })
      this.trackStarted()
    } catch (e) {
      this.config.track = null

      utils.debugLog('trackStuck', 2, { track: decodedTrack, guildId: this.config.guildId })
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
    utils.debugLog('trackEnd', 2, { track: this.config.track.info, guildId: this.config.guildId, reason: 'stopped' })

    this.client.ws.send(JSON.stringify({
      op: 'event',
      type: 'TrackEndEvent',
      guildId: this.config.guildId,
      track: this.config.track,
      reason: 'stopped'
    }))

    this.cache.silence = true

    this.player.stop(true)

    if (this.cache.ffmpeg)
      this.cache.ffmpeg.destroy()

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

  async filters(filters) {
    if (!this.player || this.player.state.status != djsVoice.AudioPlayerStatus.Playing || !config.filters.enabled) return this.config

    const filter = new Filters()

    this.config.filters = filter.configure(filters)

    if (!this.config.track) return this.config

    const protocol = this.config.track.info.sourceName == 'local' ? 'file' : (this.config.track.info.sourceName == 'http' ? 'http' : 'https')
    const resource = await filter.createResource(this.config.guildId, protocol, this.cache.url, filters.endTime, this.cache.startedAt, this.cache.ffmpeg)

    if (resource.exception) {
      this.config.track = null
      this.config.filters = null
      this.cache.url = null

      this.client.ws.send(JSON.stringify({
        op: 'event',
        type: 'TrackExceptionEvent',
        guildId: this.config.guildId,
        track: this.config.track.info,
        exception: resource.exception
      }))

      return this.config
    }

    this.cache.ffmpeg = resource.ffmpeg
    this.cache.silence = true

    if (this.player.subscribers.length == 0) this.connection.subscribe(this.player)
    this.player.play(resource.stream)

    return this.config
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
    utils.debugLog('disconnect', 3, { code, reason })

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
      utils.debugLog('failedResume', 3, { headers: req.headers })
    else {
      utils.debugLog('resume', 3, { headers: req.headers })

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

  utils.debugLog('connect', 3, { headers: req.headers })

  clients.set(sessionId, { userId: req.headers['user-id'], ws, players: new Map() })

  ws.send(JSON.stringify({
    op: 'ready',
    resume: false,
    sessionId,
  }))
}

async function requestHandler(req, res) {
  const parsedUrl = parse(req.url)

  if (!req.headers || req.headers['authorization'] != config.server.password) {
    res.writeHead(401, { 'Content-Type': 'text/plain' })
    return res.end('Unauthorized')
  }

  if (parsedUrl.pathname == '/version') {
    utils.debugLog('version', 1, { headers: req.headers })

    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(config.version)
  }

  if (parsedUrl.pathname == '/v4/decodetrack') {
    utils.debugLog('decodetrack', 1, { headers: req.headers })
    
    const encodedTrack = new URLSearchParams(parsedUrl.query).get('encodedTrack')

    try {
      utils.send(res, res, utils.decodeTrack(encodedTrack), 200)
    } catch (e) {
      utils.debugLog('decodetrack', 3, { headers: req.headers, error: e.message })

      return utils.send(req, res, {
        timestamp: Date.now(),
        status: 500,
        error: 'Internal Server Error',
        trace: e.stack,
        message: e.message
      }, 500)
    }
  }

  if (parsedUrl.pathname == '/v4/decodetracks') {
    let buffer = ''

    req.on('data', (buf) => buffer += buf)
    req.on('end', () => {
      utils.debugLog('decodetracks', 1, { headers: req.headers, body: buffer })

      buffer = JSON.parse(buffer)

      const tracks = []

      try {
        buffer.forEach((encodedTrack) => tracks.push(utils.decodeTrack(encodedTrack)))
      } catch (e) {
        utils.debugLog('decodetracks', 3, { headers: req.headers, body: buffer, error: e.message })

        return utils.send(req, res, {
          timestamp: Date.now(),
          status: 500,
          error: 'Internal Server Error',
          trace: e.stack,
          message: e.message
        }, 500)
      }

      utils.send(req, res, tracks, 200)
    })
  }

  if (parsedUrl.pathname == '/v4/encodetrack') {
    let buffer = ''

    req.on('data', (buf) => buffer += buf)
    req.on('end', () => {
      utils.debugLog('encodetrack', 1, { headers: req.headers, body: buffer })

      buffer = JSON.parse(buffer)

      if (!buffer.title || !buffer.author || !buffer.length || !buffer.identifier || !buffer.isSeekable || !buffer.isStream || !buffer.position) {
        utils.debugLog('encodetrack', 3, { headers: req.headers, body: buffer, error: 'Invalid track object' })

        return utils.send(req, res, {
          timestamp: Date.now(),
          status: 400,
          error: 'Bad Request',
          trace: null,
          message: 'Invalid track object',
          path: '/v4/encodetrack'
        }, 400)
      }

      try {
        utils.send(res, res, utils.encodeTrack(buffer), 200)
      } catch (e) {
        utils.debugLog('encodetrack', 3, { headers: req.headers, body: buffer, error: e.message })

        utils.send(req, res, {
          timestamp: Date.now(),
          status: 500,
          error: 'Internal Server Error',
          trace: e.stack,
          message: e.message,
          path: '/v4/encodetrack'
        }, 500)
      }
    })
  }

  if (parsedUrl.pathname == '/v4/encodetracks') {
    let buffer = ''

    req.on('data', (buf) => buffer += buf)
    req.on('end', () => {
      utils.debugLog('encodetracks', 1, { headers: req.headers, body: buffer })

      buffer = JSON.parse(buffer)

      const tracks = []

      buffer.forEach((track) => {
        if (!track.title || !track.author || !track.length || !track.identifier || !track.isSeekable || !track.isStream || !track.position) {
          utils.debugLog('encodetracks', 1, { headers: req.headers, body: buffer, error: 'Invalid track object' })

          return utils.send(req, res, {
            timestamp: Date.now(),
            status: 400,
            error: 'Bad Request',
            trace: null,
            message: 'Invalid track object',
            path: '/v4/encodetracks'
          }, 400)
        }

        try {
          tracks.push(utils.encodeTrack(track))
        } catch (e) {
          utils.debugLog('encodetracks', 1, { headers: req.headers, body: buffer, error: e.message })

          return utils.send(req, res, {
            timestamp: Date.now(),
            status: 500,
            error: 'Internal Server Error',
            trace: e.stack,
            message: e.message,
            path: '/v4/encodetracks'
          }, 500)
        }
      })

      utils.send(res, res, tracks, 200)
    })
  }

  if (parsedUrl.pathname == '/v4/stats') {
    utils.debugLog('stats', 1, { headers: req.headers })

    utils.send(res, res, {
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
    })
  }

  if (parsedUrl.pathname == '/v4/loadtracks') {
    utils.debugLog('loadtracks', 1, { params: parsedUrl.query, headers: req.headers })

    const identifier = new URLSearchParams(parsedUrl.query).get('identifier')

    let search

    const ytSearch = config.search.sources.youtube ? identifier.startsWith('ytsearch:') : null
    if (config.search.sources.youtube && (ytSearch || /^(https?:\/\/)?(www\.)?youtube\.com\/(?:shorts\/(?:\?v=)?[a-zA-Z0-9_-]{11}|playlist\?list=[a-zA-Z0-9_-]+|watch\?(?=.*v=[a-zA-Z0-9_-]{11})[^\s]+)$/.test(identifier)))
      search = ytSearch ? await sources.youtube.search(identifier.replace('ytsearch:', ''), 'youtube') : await sources.youtube.loadFrom(identifier, 'youtube')

    if (utils.sendNonNull(req, res, search) == true) return;

    const ytMusicSearch = config.search.sources.youtubeMusic ? identifier.startsWith('ytmsearch:') : null
    if (config.search.sources.youtubeMusic && (ytMusicSearch || /^(https?:\/\/)?(music\.)?youtube\.com\/(?:shorts\/(?:\?v=)?[a-zA-Z0-9_-]{11}|playlist\?list=[a-zA-Z0-9_-]+|watch\?(?=.*v=[a-zA-Z0-9_-]{11})[^\s]+)$/.test(identifier)))
      search = ytMusicSearch ? await sources.youtube.search(identifier.replace('ytmsearch:', ''), 'ytmusic') : await sources.youtube.loadFrom(identifier, 'ytmusic')
 
    if (utils.sendNonNull(req, res, search) == true) return;

    const spSearch = config.search.sources.spotify ? identifier.startsWith('spsearch:') : null
    const spRegex = config.search.sources.youtube && config.search.sources.spotify && !spSearch ? /^https?:\/\/(?:open\.spotify\.com\/|spotify:)(?:.+)?(track|playlist|artist|episode|show|album)[/:]([A-Za-z0-9]+)/.exec(identifier) : null
    if (config.search.sources.youtube && config.search.sources.spotify && (spSearch || spRegex))
       search = spSearch ? await sources.spotify.search(identifier.replace('spsearch:', '')) : await sources.spotify.loadFrom(identifier, spRegex)

    if (utils.sendNonNull(req, res, search) == true) return;

    const dzRegex = config.search.sources.youtube && config.search.sources.deezer ? /^https?:\/\/(?:www\.)?deezer\.com\/(?:[a-z]{2}\/)?(track|album|playlist)\/(\d+)$/.exec(identifier) : null
    if (config.search.sources.youtube && config.search.sources.deezer && dzRegex)
      search = await sources.deezer.loadFrom(identifier, dzRegex)

    if (utils.sendNonNull(req, res, search) == true) return;

    const scSearch = config.search.sources.soundcloud.enabled ? identifier.startsWith('scsearch:') : null
    if (config.search.sources.soundcloud.enabled && (scSearch || /^https?:\/\/soundcloud\.com\/[a-zA-Z0-9-_]+\/(?:sets\/)?[a-zA-Z0-9-_]+$/.test(identifier)))
      search = scSearch ? await sources.soundcloud.search(identifier.replace('scsearch:', '')) : await sources.soundcloud.loadFrom(identifier)

    if (utils.sendNonNull(req, res, search) == true) return;

    const bcSearch = config.search.sources.bandcamp ? identifier.startsWith('bcsearch:') : null
    if (config.search.sources.bandcamp && (bcSearch || /https?:\/\/[\w-]+\.bandcamp\.com\/(track|album)\/[\w-]+/.test(identifier)))
      search = bcSearch ? await sources.bandcamp.search(identifier.replace('bcsearch:', '')) : await sources.bandcamp.loadFrom(identifier)

    if (utils.sendNonNull(req, res, search) == true) return;

    const pdSearch = config.search.sources.pandora ? identifier.startsWith('pdsearch:') : null
    if (config.search.sources.pandora && (pdSearch || /^(https:\/\/www\.pandora\.com\/)((playlist)|(station)|(podcast)|(artist))\/.+/.test(identifier)))
      search = pdSearch ? await sources.pandora.search(identifier.replace('pdsearch:', '')) : await sources.pandora.loadFrom(identifier)

    if (utils.sendNonNull(req, res, search) == true) return;

    if (config.search.sources.http && (identifier.startsWith('http://') || identifier.startsWith('https://')))
      search = await sources.http.loadFrom(identifier)
    
    if (utils.sendNonNull(req, res, search) == true) return;

    if (config.search.sources.local && identifier.startsWith('local:'))
      search = await sources.local.loadFrom(identifier.replace('local:', ''))

    if (!search) {
      console.log('[NodeLink:loadtracks]: No possible search source found.')

      search = { loadType: 'empty', data: {} }
    }

    utils.sendNonNull(req, res, search, true)
  }

  if (parsedUrl.pathname == '/v4/loadcaptions') {
    utils.debugLog('loadcaptions', 1, { params: parsedUrl.query, headers: req.headers })

    const identifier = new URLSearchParams(parsedUrl.query).get('encodedTrack')

    let decodedTrack = null
    try {
      decodedTrack = utils.decodeTrack(identifier)
    } catch (e) {
      utils.debugLog('loadcaptions', 2, { params: parsedUrl.query, headers: req.headers, error: e.message })

      utils.send(req, res, {
        timestamp: Date.now(),
        status: 500,
        error: 'Internal Server Error',
        trace: e.stack,
        message: e.message,
        path: '/v4/loadcaptions'
      }, 500)
    }

    let captions = null

    switch (decodedTrack.sourceName) {
      case 'ytmusic':
      case 'youtube': {
        if (!config.search.sources.youtube) {
          console.log('[NodeLink:loadcaptions]: No possible search source found.')

          captions = { loadType: 'empty', data: {} }
        }

        captions = await sources.youtube.loadCaptions(decodedTrack)

        break
      }
    }

    utils.send(req, res, captions, 200)
  }

  if (/^\/v4\/sessions\/\{[a-zA-Z0-9_-]+\}$/.test(parsedUrl.pathname) && req.method == 'PATCH') {
    const sessionId = /^\/v4\/sessions\/\{([a-zA-Z0-9_-]+)\}$/.exec(parsedUrl.pathname)[1]

    let buffer = ''

    req.on('data', (buf) => buffer += buf)
    req.on('end', () => {
      utils.debugLog('sessions', 1, { params: parsedUrl.query, headers: req.headers, body: buffer })

      buffer = JSON.parse(buffer)

      clients.set(sessionId, { ...clients.get(sessionId), timeout: buffer.timeout * 1000 })

      utils.send(req, res, { resuming: buffer.resuming, timeout: buffer.timeout }, 200)
    })
  }

  if (/^\/v4\/sessions\/\w+\/players\/\w+./.test(parsedUrl.pathname)) {
    const client = clients.get(/^\/v4\/sessions\/([A-Za-z0-9]+)\/players\/\d+$/.exec(parsedUrl.pathname)[1])

    if (!client) {
      utils.debugLog('player', 1, { params: parsedUrl.query, headers: req.headers, error: 'The provided session Id doesn\'t exist.' })

      return utils.send(req, res, {
        timestamp: new Date(),
        status: 404,
        trace: null,
        message: 'The provided session Id doesn\'t exist.',
        path: parsedUrl.pathname
      }, 404)
    }

    if (req.method == 'GET') {
      if (/^\/v4\/sessions\/[A-Za-z0-9]+\/players\/\d+$/.test(parsedUrl.pathname)) {
        utils.debugLog('getPlayer', 1, { params: parsedUrl.query, headers: req.headers })

        const guildId = /\/players\/(\d+)$/.exec(parsedUrl.pathname)[1]

        let player = client.players.get(guildId)

        if (!player) {
          player = new VoiceConnection(guildId, client.userId, client.sessionId, client.timeout)

          client.players.set(guildId, player)
        }
        
        utils.send(req, res, player.config, 200)
      } else {
        utils.debugLog('getPlayers', 1, { headers: req.headers })

        const players = []

        client.players.forEach((player) => players.push(player.config))

        utils.send(req, res, players, 200)
      }
    } else if (req.method == 'PATCH') {  
      let buffer = ''

      req.on('data', (buf) => buffer += buf)
      req.on('end', () => {
        buffer = JSON.parse(buffer)

        const guildId = /\/players\/(\d+)$/.exec(parsedUrl.pathname)[1]
        let player = client.players.get(guildId)

        if (buffer.voice != undefined) {
          utils.debugLog('voice', 1, { params: parsedUrl.query, headers: req.headers, body: buffer })

          if (!buffer.voice.endpoint || !buffer.voice.token || !buffer.voice.sessionId) {
            utils.debugLog('voice', 1, { params: parsedUrl.query, headers: req.headers, body: buffer, error: 'Missing voice data.' })

            return utils.send(req, res, {
              timestamp: new Date(),
              status: 400,
              trace: null,
              message: 'Missing voice data.',
              path: parsedUrl.pathname
            }, 400)
          }

          if (!player) player = new VoiceConnection(guildId, client)

          if (player.config.track && (player.player._state != 'buffering'|| player.player._state != 'playing'))
            player.play(player.config.track.encoded, false)

          player.updateVoice(buffer.voice)

          client.players.set(guildId, player)
        }

        if (buffer.encodedTrack !== undefined || buffer.encodedTrack === null) {
          if (buffer.encodedTrack == null) utils.debugLog('stop', 1, { params: parsedUrl.query, headers: req.headers, body: buffer })
          else utils.debugLog('play', 1, { params: parsedUrl.query, headers: req.headers, body: buffer })

          const noReplace = new URLSearchParams(parsedUrl.query).get('noReplace')

          if (!player) player = new VoiceConnection(guildId, client)

          if (player.player && buffer.encodedTrack == null) player.stop()
          else {
            if (!player.connection) player.setup()

            if (!player.config.voice.endpoint) player.config.track = { encoded: buffer.encodedTrack, info: utils.decodeTrack(buffer.encodedTrack) }
            else {
              if (player.connection._state != 'connecting' || player.connection._state != 'ready') player.updateVoice(player.config.voice)
              
              player.play(buffer.encodedTrack, noReplace == true)
            }
          }

          client.players.set(guildId, player)
        }

        if (buffer.volume != undefined) {
          utils.debugLog('volume', 1, { params: parsedUrl.query, params: parsedUrl.query, body: buffer })

          if (buffer.volume < 0 || buffer.volume > 1000) {
            utils.debugLog('volume', 1, { params: parsedUrl.query, headers: req.headers, body: buffer, error: 'The volume must be between 0 and 1000.' })

            return utils.send(req, res, {
              timestamp: new Date(),
              status: 400,
              trace: null,
              message: 'The volume must be between 0 and 1000.',
              path: parsedUrl.pathname
            }, 400)
          }

          if (!player) player = new VoiceConnection(guildId, client)

          player.volume(buffer.volume)

          client.players.set(guildId, player)
        }

        if (buffer.paused != undefined) {
          utils.debugLog('pause', 1, { params: parsedUrl.query, headers: req.headers, body: buffer })

          if (typeof buffer.paused != 'boolean') {
            utils.debugLog('pause', 1, { params: parsedUrl.query, headers: req.headers, body: buffer, error: 'The paused value must be a boolean.' })

            return utils.send(req, res, {
              timestamp: new Date(),
              status: 400,
              trace: null,
              message: 'The paused value must be a boolean.',
              path: parsedUrl.pathname
            }, 400)
          }

          if (!player) player = new VoiceConnection(guildId, client)

          player.pause(buffer.paused)

          client.players.set(guildId, player)
        }

        let filters = {}

        if (buffer.filters != undefined) {
          utils.debugLog('filters', 1, { params: parsedUrl.query, headers: req.headers, body: buffer })

          filters = buffer.filters
        }

        if (buffer.position != undefined) {
          utils.debugLog('seek', 1, { params: parsedUrl.query, headers: req.headers, body: buffer })

          filters.seek = buffer.position
        }

        if (buffer.endTime != undefined) {
          utils.debugLog('endTime', 1, { params: parsedUrl.query, headers: req.headers, body: buffer })

          filters.endTime = buffer.endTime
        }

        if (Object.keys(filters).length != 0) {
          if (!player) player = new VoiceConnection(guildId, client)

          player.filters(filters)

          client.players.set(guildId, player)
        }

        utils.send(req, res, player.config, 200)
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