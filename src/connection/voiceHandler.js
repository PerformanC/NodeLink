import { debugLog, waitForEvent } from '../utils.js'
import config from '../../config.js'
import constants from '../../constants.js'
import sources from '../sources.js'
import Filters from '../filters.js'

import inputHandler from './inputHandler.js'

import voiceUtils from '../voice/utils.js'

import discordVoice from '@performanc/voice'

global.nodelinkPlayersCount = 0
global.nodelinkPlayingPlayersCount = 0
 
class VoiceConnection {
  constructor(guildId, client) {
    this.connection = null
    this.client = client
    this.cache = {
      startedAt: 0,
      pauseTime: [ 0, 0 ],
      silence: false,
      url: null,
      protocol: null,
      track: null,
      volume: 100
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
  }

  _stopTrack() {
    nodelinkPlayingPlayersCount--

    if (this.stateInterval) clearInterval(this.stateInterval)

    this.config.state = {
      time: null,
      position: 0,
      connected: false,
      ping: -1
    }

    this.cache.startedAt = 0
    this.cache.pauseTime = [ 0, 0 ]
  }

  _getRealTime() {
    return (new Date() - this.cache.startedAt) - this.cache.pauseTime[1]
  }

  setup() {
    nodelinkPlayersCount++

    this.connection = discordVoice.joinVoiceChannel({ channelId: "", guildId: this.config.guildId, userId: this.client.userId })
    this.connection.on('speakStart', (userId, ssrc) => inputHandler.handleStartSpeaking(ssrc, userId, this.config.guildId))

    this.connection.on('stateChange', async (oldState, newState) => {
      switch (newState.status) {
        case 'disconnected': {
          if (oldState.status == 'disconnected') return;

          if (newState.code != 4015) {
              debugLog('websocketClosed', 2, { track: this.config.track?.info, exception: constants.VoiceWSCloseCodes[newState.closeCode] })

              this.connection.destroy()
              this._stopTrack()
              this.config = {
                guildId: this.config.guildId,
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

              this.client.ws.send(JSON.stringify({
                op: 'event',
                type: 'WebSocketClosedEvent',
                guildId: this.config.guildId,
                code: newState.closeCode,
                reason: constants.VoiceWSCloseCodes[newState.closeCode],
                byRemote: true
              }))
          } else {
            /* Should send trackException instead */
          }
          break;
        }
      }
    })

    this.connection.on('playerStateChange', (oldState, newState) => {
      if (newState.status == 'idle' && oldState.status != 'idle') {
        if (this.cache.silence) return (this.cache.silence = false)

        this._stopTrack()
        this.cache.url = null

        debugLog('trackEnd', 2, { track: this.config.track.info, reason: 'finished' })

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

    this.connection.on('error', (error) => {
      this._stopTrack()

      debugLog('trackException', 2, { track: this.config.track?.info, exception: error.message })

      this.client.ws.send(JSON.stringify({
        op: 'event',
        type: 'TrackExceptionEvent',
        guildId: this.config.guildId,
        track: this.config.track,
        exception: {
          message: error.message,
          severity: 'fault',
          cause: `${error.name}: ${error.message}`
        }
      }))

      this.client.ws.send(JSON.stringify({
        op: 'event',
        type: 'TrackEndEvent',
        guildId: this.config.guildId,
        track: this.config.track,
        reason: 'loadFailed'
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
          position: this.connection.playerState.status == 'playing' ? this._getRealTime() : 0,
          connected: this.connection.state.status == 'ready',
          ping: this.connection.state.status == 'ready' ? this.connection.ping || -1 : -1
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

    if (this.connection.voiceServer && this.connection.voiceServer.token == buffer.token && this.connection.voiceServer.endpoint == buffer.endpoint) return;

    if (this.connection.ws) this.connection.destroy()

    this.connection.voiceStateUpdate({ guild_id: this.config.guildId, user_id: this.client.userId, session_id: buffer.sessionId })
    this.connection.voiceServerUpdate({ user_id: this.client.userId, token: buffer.token, guild_id: this.config.guildId, endpoint: buffer.endpoint })

    this.connection.connect()
  }

  destroy() {
    if (this.config.track) {
      this.cache.silence = true

      this.connection.destroy()
    }

    if (this.connection) this.connection.destroy()

    this._stopTrack()

    this.client.players.delete(this.config.guildId)
  }

  async getResource(decodedTrack, urlInfo) {
    return new Promise(async (resolve) => {
      const streamInfo = await sources.getTrackStream(decodedTrack, urlInfo.url, urlInfo.protocol, urlInfo.additionalData)

      if (streamInfo.exception) return resolve(streamInfo)

      this.cache.url = urlInfo.url

      resolve({ stream: voiceUtils.createAudioResource(streamInfo.stream, urlInfo.format) })
    })
  }

  async play(track, decodedTrack, noReplace) {
    if (noReplace && this.config.track) return this.config

    const oldTrack = this.config.track

    const urlInfo = await sources.getTrackURL(decodedTrack)

    if (urlInfo.exception) {
      this.config.track = null
      this.cache.url = null

      this.client.ws.send(JSON.stringify({
        op: 'event',
        type: 'TrackExceptionEvent',
        guildId: this.config.guildId,
        track: {
          encoded: track,
          info: decodedTrack
        },
        exception: urlInfo.exception
      }))

      this.client.ws.send(JSON.stringify({
        op: 'event',
        type: 'TrackEndEvent',
        guildId: this.config.guildId,
        track: {
          encoded: track,
          info: decodedTrack,
          userData: this.config.track.userData
        },
        reason: 'loadFailed'
      }))

      return this.config
    }

    if (oldTrack) {
      debugLog('trackEnd', 2, { track: decodedTrack, reason: 'replaced' })

      this.client.ws.send(JSON.stringify({
        op: 'event',
        type: 'TrackEndEvent',
        guildId: this.config.guildId,
        track: oldTrack,
        reason: 'replaced'
      }))
    }

    let resource = null

    if (Object.keys(this.config.filters).length > 0) {
      const filter = new Filters()

      this.config.filters = filter.configure(this.config.filters)

      resource = await filter.getResource(this.config.guildId, decodedTrack, urlInfo.protocol, urlInfo.url, null, null, this.cache.ffmpeg, urlInfo.additionalData)  

      if (oldTrack) this._stopTrack()
    } else {
      this.cache.url = urlInfo.url
      resource = await this.getResource(decodedTrack, urlInfo)

      if (oldTrack) this._stopTrack()
    }
  
    if (resource.exception) {
      this.config.track = null
      this.config.filters = []
      this.cache.url = null

      debugLog('trackException', 2, { track: decodedTrack, exception: resource.exception.message })

      this.client.ws.send(JSON.stringify({
        op: 'event',
        type: 'TrackExceptionEvent',
        guildId: this.config.guildId,
        track: {
          encoded: track,
          info: decodedTrack,
          userData: this.config.track.userData
        },
        exception: resource.exception
      }))

      this.client.ws.send(JSON.stringify({
        op: 'event',
        type: 'TrackEndEvent',
        guildId: this.config.guildId,
        track: {
          encoded: track,
          info: decodedTrack,
          userData: this.config.track.userData
        },
        reason: 'loadFailed'
      }))

      return this.config
    }

    this.config.track = { encoded: track, info: decodedTrack }
   
    if (this.cache.volume != 100) {
      resource.stream.setVolume(this.cache.volume / 100)
     
      this.config.volume = this.cache.volume
    }
  
    if (!this.connection.udpInfo?.secretKey)
      await waitForEvent(this.connection, 'playerStateChange', (_oldState, newState) => newState.status == 'connected', config.options.threshold || undefined)
    
    this.connection.play(resource.stream)

    if (this.config.paused) {
      this.cache.pauseTime[1] = Date.now()

      this.cache.startedAt += this.cache.pauseTime[1] - this.cache.pauseTime[0]
    }

    this.cache.protocol = urlInfo.protocol

    try {
      await waitForEvent(this.connection, 'playerStateChange', (_oldState, newState) => newState.status == 'playing', config.options.threshold || undefined)

      this.cache.startedAt = Date.now()

      debugLog('trackStart', 2, { track: decodedTrack })
      this.trackStarted()
    } catch (e) {
      this._stopTrack()

      debugLog('trackStuck', 2, { track: decodedTrack })
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
    if (!this.config.track) return this.config

    debugLog('trackEnd', 2, { track: this.config.track.info, reason: 'stopped' })

    this.client.ws.send(JSON.stringify({
      op: 'event',
      type: 'TrackEndEvent',
      guildId: this.config.guildId,
      track: this.config.track,
      reason: 'stopped'
    }))

    this.cache.startedAt = 0
    this.cache.pauseTime = [ 0, 0 ]
    if (this.config.track) {
      this.cache.silence = true

      this.connection.stop()
    }
    this.config.track = null
    this.config.filters = []
    this.cache.url = null

    this._stopTrack()
  }

  volume(volume) {
    if (!this.config.track) {
      this.cache.volume = volume / 100

      return this.config
    }

    this.connection.audioStream.volume.setVolume(volume / 100)

    this.config.volume = volume / 100

    return this.config
  }

  pause(pause) {
    if (pause) {
      this.cache.pauseTime[0] = Date.now()

      this.connection.pause()
    }
    else {
      if (this.config.paused)
        this.cache.pauseTime[1] = Date.now() - this.cache.pauseTime[0]

      this.connection.unpause()
    }

    this.config.paused = pause
    
    return this.config
  }

  async filters(filters) {
    if (this.connection.playerState.status != 'playing' || !config.filters.enabled) return this.config

    const filter = new Filters()

    this.config.filters = filter.configure(filters)

    if (!this.config.track) return this.config

    const protocol = this.cache.protocol
    const resource = await filter.getResource(this.config.guildId, this.config.track.info, protocol, this.cache.url, this._getRealTime(), filters.endTime, this.cache.ffmpeg, null)

    if (resource.exception) {
      this.config.track = null
      this.config.filters = []
      this.cache.url = null

      this.client.ws.send(JSON.stringify({
        op: 'event',
        type: 'TrackExceptionEvent',
        guildId: this.config.guildId,
        track: this.config.track,
        exception: resource.exception
      }))

      this.client.ws.send(JSON.stringify({
        op: 'event',
        type: 'TrackEndEvent',
        guildId: this.config.guildId,
        track: this.config.track.info,
        reason: 'loadFailed'
      }))

      return this.config
    }

    if (!this.connection.udpInfo?.secretKey)
      await waitForEvent(this.connection, 'playerStateChange', (_oldState, newState) => newState.status == 'connected', config.options.threshold || undefined)
    
    this.connection.play(resource.stream)

    return this.config
  }
}

export default VoiceConnection
