import fs from 'node:fs'

import https from 'node:https'
import http from 'node:http'

import utils from '../utils.js'
import config from '../../config.js'
import constants from '../../constants.js'
import sources from '../sources.js'
import Filters from '../filters.js'

import * as djsVoice from '@discordjs/voice'

const adapters = new Map()
global.clients = new Map()

global.nodelinkPlayersCount = 0
global.nodelinkPlayingPlayersCount = 0

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
      pauseTime: [ 0, 0 ]
    }
    this.stateInterval
  
    this.config = {
      guildId,
      track: null,
      volume: 100,
      paused: false,
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

  _getRealTime() {
    return (new Date() - this.cache.startedAt) - this.cache.pauseTime[1]
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
            utils.debugLog('websocketClosed', 2, { track: this.config.track.info, exception: constants.VoiceWSCloseCodes[newState.closeCode] })

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
        this.cache.url = null

        utils.debugLog('trackEnd', 2, { track: this.config.track.info, reason: 'finished' })

        this.client.ws.send(JSON.stringify({
          op: 'event',
          type: 'TrackEndEvent',
          guildId: this.config.guildId,
          track: this.config.track,
          reason: 'finished'
        }))

        this.config.track = null
      }
    })

    this.player.on('error', (error) => {
      this._stopTrack()

      utils.debugLog('trackException', 2, { track: this.config.track.info, exception: error.message })

      this.client.ws.send(JSON.stringify({
        op: 'event',
        type: 'TrackExceptionEvent',
        guildId: this.config.guildId,
        track: this.config.track,
        exception: {
          message: error.message,
          severity: 'fault',
          cause: 'unknown'
        }
      }))

      this.config.track = null
      this.cache.silence = true
    })
  }

  trackStarted() {
    nodelinkPlayingPlayersCount++
          
    if (config.options.playerUpdateInterval) this.stateInterval = setInterval(() => {
      this.client.ws.send(JSON.stringify({
        op: 'playerUpdate',
        guildId: this.config.guildId,
        state: {
          time: Date.now(),
          position: this.player.state.status == djsVoice.AudioPlayerStatus.Playing ? this._getRealTime() : 0,
          connected: this.connection.state.status == djsVoice.VoiceConnectionStatus.Ready,
          ping: this.connection.state.status == djsVoice.VoiceConnectionStatus.Ready ? this.connection.ping.ws : -1
        }
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
    this.config.track = null
    this.config.filters = []
    this.cache.startedAt = 0
    if (this.player) this.cache.silence = true
    this.cache.url = null

    if (this.player) this.player.stop(true)

    if (this.cache.ffmpeg) this.cache.ffmpeg.destroy()

    this._stopTrack()

    this.client.players.delete(this.config.guildId)
  }

  async getResource(sourceName, url, protocol) {
    return new Promise(async (resolve) => {
      if (protocol == 'file') {
        const file = fs.createReadStream(url)

        file.on('error', () => {
          utils.debugLog('retrieveStream', 4, { type: 2, sourceName: sourceName, message: 'Failed to retrieve stream from source. (File not found or not accessible)' })

          resolve({ status: 1, exception: { message: 'Failed to retrieve stream from source. (File not found or not accessible)', severity: 'suspicious', cause: 'unknown' } })
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

          if (res.statusCode != 206 && res.statusCode != 302) {
            res.destroy()

            utils.debugLog('retrieveStream', 4, { type: 2, sourceName: sourceName, message: `Failed to retrieve stream from source. (${res.statusCode} != 206 or 302)` })

            resolve({ status: 1, exception: { message: `Failed to retrieve stream from source. (${res.statusCode} != 206 or 302)`, severity: 'suspicious', cause: 'unknown' } })
          }

          res.destroy()

          this.cache.url = url

          if ([ 'youtube', 'ytmusic' ].includes(sourceName) || ([ 'deezer', 'pandora', 'spotify' ].includes(sourceName) && config.search.defaultSearchSource == 'youtube'))
            resolve({ stream: djsVoice.createAudioResource(url, { inputType: djsVoice.StreamType.WebmOpus, inlineVolume: true }) })
          else
            resolve({ stream: djsVoice.createAudioResource(url, { inputType: djsVoice.StreamType.Arbitrary, inlineVolume: true }) })
        }).on('error', (error) => {
          utils.debugLog('retrieveStream', 4, { type: 2, sourceName: sourceName, message: error.message })

          resolve({ status: 1, exception: { message: error.message, severity: 'suspicious', cause: 'unknown' } })
        })
      }
    })
  }

  async play(track, noReplace) {
    if (noReplace && this.config.track) return this.config

    const decodedTrack = utils.decodeTrack(track)

    const oldTrack = this.config.track

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
      utils.debugLog('trackEnd', 2, { track: decodedTrack, reason: 'replaced' })

      this.client.ws.send(JSON.stringify({
        op: 'event',
        type: 'TrackEndEvent',
        guildId: this.config.guildId,
        track: oldTrack,
        reason: 'replaced'
      }))

      this.cache.silence = true
    }

    let resource = null
    let filterEnabled = false

    if (Object.keys(this.config.filters).length > 0) {
      const filter = new Filters()

      this.config.filters = filter.configure(this.config.filters)

      if (oldTrack) this._stopTrack(true)

      filterEnabled = true
      resource = await filter.createResource(this.config.guildId, decodedTrack, urlInfo.protocol, urlInfo.url, null, null, this.cache.ffmpeg)  
    } else {
      this.cache.url = urlInfo.url
      resource = await this.getResource(decodedTrack.sourceName, urlInfo.url, urlInfo.protocol)

      if (oldTrack) this._stopTrack(true)
    }
  
    if (resource.exception) {
      this.config.track = null
      this.config.filters = []
      this.cache.url = null

      utils.debugLog('trackException', 2, { track: decodedTrack, exception: resource.exception.message })

      this.client.ws.send(JSON.stringify({
        op: 'event',
        type: 'TrackExceptionEvent',
        guildId: this.config.guildId,
        track: decodedTrack,
        exception: resource.exception
      }))

      return this.config
    }
  
    if (filterEnabled) this.cache.ffmpeg = resource.ffmpeg

    if (this.player.subscribers.length == 0) this.connection.subscribe(this.player)
    this.player.play(resource.stream)

    if (this.config.paused) {
      this.cache.pauseTime[1] = Date.now()

      this.cache.startedAt += this.cache.pauseTime[1] - this.cache.pauseTime[0]
    }

    try {
      if (config.options.threshold) await djsVoice.entersState(this.player, djsVoice.AudioPlayerStatus.Playing, config.options.threshold)

      this.cache.startedAt = Date.now()
      this.config.track = { encoded: track, info: decodedTrack }

      utils.debugLog('trackStart', 2, { track: decodedTrack, })
      this.trackStarted()
    } catch (e) {
      this.config.track = null

      utils.debugLog('trackStuck', 2, { track: decodedTrack })
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
    utils.debugLog('trackEnd', 2, { track: this.config.track.info, reason: 'stopped' })

    this.client.ws.send(JSON.stringify({
      op: 'event',
      type: 'TrackEndEvent',
      guildId: this.config.guildId,
      track: this.config.track,
      reason: 'stopped'
    }))

    this.config.track = null
    this.config.filters = []
    this.cache.startedAt = 0
    if (this.player) this.cache.silence = true
    this.cache.url = null

    if (this.player) this.player.stop(true)

    if (this.cache.ffmpeg) this.cache.ffmpeg.destroy()

    this._stopTrack()
  }

  volume(volume) {
    this.player.state.resource.volume.setVolume(volume / 100)

    this.config.volume = volume / 100

    return this.config
  }

  pause(pause) {
    if (pause) {
      this.cache.pauseTime[0] = Date.now()

      this.player.pause()
    }
    else {
      if (this.config.paused)
        this.cache.pauseTime[1] = Date.now() - this.cache.pauseTime[0]

      this.player.unpause()
    }

    this.config.paused = pause
    
    return this.config
  }

  async filters(filters) {
    if (!this.player || this.player.state.status != djsVoice.AudioPlayerStatus.Playing || !config.filters.enabled) return this.config

    const filter = new Filters()

    this.config.filters = filter.configure(filters)

    if (!this.config.track) return this.config

    const protocol = this.config.track.info.sourceName == 'local' ? 'file' : (this.config.track.info.sourceName == 'http' ? 'http' : 'https')
    const url = sources.filtersPrepare(this.cache.url, this.config.track.info.sourceName)
    const resource = await filter.createResource(this.config.guildId, this.config.track.info, protocol, url, filters.endTime, this.cache, this.cache.ffmpeg)

    if (resource.exception) {
      this.config.track = null
      this.config.filters = []
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

    if (this.player.subscribers.length == 0) this.connection.subscribe(this.player)
    this.player.play(resource.stream)

    return this.config
  }
}

export default VoiceConnection