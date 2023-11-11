import { debugLog } from '../utils.js'
import config from '../../config.js'
import constants from '../../constants.js'
import sources from '../sources.js'
import Filters from '../filters.js'

import inputHandler from './inputHandler.js'

import * as djsVoice from '@discordjs/voice'

const adapters = new Map()

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
      silence: false,
      ffmpeg: null,
      url: null,
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

    this.connection = null
    this.player = null
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
  }

  _getRealTime() {
    return this.player.state.playbackDuration
  }

  setup() {
    nodelinkPlayersCount++

    this.connection = djsVoice.joinVoiceChannel({ channelId: "", guildId: this.config.guildId, group: this.client.userId, adapterCreator: voiceAdapterCreator(this.client.userId, this.config.guildId) })
    this.connection.receiver.speaking.on('start', (userId) => inputHandler.handleStartSpeaking(this.connection.receiver, userId, this.config.guildId))

    this.connection.on('stateChange', async (oldState, newState) => {
      switch (newState.status) {
        case djsVoice.VoiceConnectionStatus.Disconnected: {
          if (oldState.status == djsVoice.VoiceConnectionStatus.Disconnected) return;

          try {
            if (config.options.threshold) await djsVoice.entersState(this.connection, djsVoice.VoiceConnectionStatus.Connecting, config.options.threshold)
          } catch (e) {
            debugLog('websocketClosed', 2, { track: this.config.track.info, exception: constants.VoiceWSCloseCodes[newState.closeCode] })

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
  }
  
  setupEvents() {
    this.player.on('stateChange', (oldState, newState) => {
      if (newState.status == djsVoice.AudioPlayerStatus.Idle && oldState.status != djsVoice.AudioPlayerStatus.Idle) {
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

    this.player.on('error', (error) => {
      this._stopTrack()

      debugLog('trackException', 2, { track: this.config.track.info, exception: error.message })

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
          ping: this.connection.state.status == djsVoice.VoiceConnectionStatus.Ready ? this.connection.ping.ws || -1 : -1
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
    if (this.player) {
      this.cache.silence = true

      this.player.stop(true)
    }
    this.cache.url = null

    if (this.connection) this.connection.destroy()

    if (this.cache.ffmpeg) this.cache.ffmpeg.destroy()

    this._stopTrack()

    this.client.players.delete(this.config.guildId)
  }

  async getResource(decodedTrack, url, protocol, additionalData) {
    return new Promise(async (resolve) => {
      const trackData = await sources.getTrackStream(decodedTrack, url, protocol, additionalData)

      if (trackData.exception) {
        debugLog('retrieveStream', 4, { type: 2, sourceName: decodedTrack.sourceName, query: decodedTrack.title, message: trackData.exception.message })

        resolve({ status: 1, exception: { message: trackData.exception.message, severity: 'fault', cause: 'Unknown' } })
      }

      this.cache.url = url

      resolve({ stream: djsVoice.createAudioResource(trackData.stream, { inputType: trackData.type, inlineVolume: true }) })
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
        track: decodedTrack,
        exception: urlInfo.exception
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

      this.cache.silence = true
    }

    let resource = null
    let filterEnabled = false

    if (Object.keys(this.config.filters).length > 0) {
      const filter = new Filters()

      this.config.filters = filter.configure(this.config.filters)

      filterEnabled = true
      resource = await filter.getResource(this.config.guildId, decodedTrack, urlInfo.protocol, urlInfo.url, null, null, this.cache.ffmpeg, urlInfo.additionalData)  

      if (oldTrack) this._stopTrack()
    } else {
      this.cache.url = urlInfo.url
      resource = await this.getResource(decodedTrack, urlInfo.url, urlInfo.protocol, urlInfo.additionalData)

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
        track: decodedTrack,
        exception: resource.exception
      }))

      return this.config
    }
  
    if (filterEnabled) this.cache.ffmpeg = resource.ffmpeg

    if (!this.player) {
      this.player = djsVoice.createAudioPlayer()
      this.setupEvents()
    }
    if (this.player.subscribers.length == 0) this.connection.subscribe(this.player)
    this.player.play(resource.stream)

    if (this.cache.volume != 100) {
      this.player.state.resource.volume.setVolume(this.cache.volume)
      this.config.volume = 100
    }


    try {
      if (config.options.threshold) await djsVoice.entersState(this.player, djsVoice.AudioPlayerStatus.Playing, config.options.threshold)

      this.config.track = { encoded: track, info: decodedTrack }

      debugLog('trackStart', 2, { track: decodedTrack, })
      this.trackStarted()
    } catch (e) {
      this.config.track = null

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

    this.config.track = null
    this.config.filters = []
    if (this.player) {
      this.cache.silence = true

      this.player.stop(true)
    }
    this.cache.url = null

    if (this.cache.ffmpeg) this.cache.ffmpeg.destroy()

    this._stopTrack()
  }

  volume(volume) {
    if (!this.player?.state?.resource) {
      this.cache.volume = volume / 100

      return this.config
    }

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
    const resource = await filter.getResource(this.config.guildId, this.config.track.info, protocol, this.cache.url, this._getRealTime(), filters.endTime, this.cache.ffmpeg, null)

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