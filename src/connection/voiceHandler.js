import { debugLog, waitForEvent } from '../utils.js'
import config from '../../config.js'
import sources from '../sources.js'
import Filters from '../filters.js'

import inputHandler from './inputHandler.js'

import voiceUtils from '../voice/utils.js'

import discordVoice from '@performanc/voice'

globalThis.nodelinkPlayersCount = 0
globalThis.nodelinkPlayingPlayersCount = 0

class VoiceConnection {
  constructor(guildId, client) {
    nodelinkPlayersCount++

    this.client = {
      userId: client.userId,
      ws: client.ws
    }

    this.cache = {
      streamInfo: {
        url: null,
        protocol: null,
        format: null,
      },
      track: null,
      time: 0
    }
  
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

    this._setupVoice()
  }

  _setupVoice() {
    this.connection = discordVoice.joinVoiceChannel({ guildId: this.config.guildId, userId: this.client.userId, encryption: config.audio.encryption })

    this.connection.on('speakStart', (userId, ssrc) => inputHandler.handleStartSpeaking(ssrc, userId, this.config.guildId))

    this.connection.on('stateChange', async (oldState, newState) => {
      switch (newState.status) {
        case 'disconnected': {
          debugLog('websocketClosed', 2, { code: newState.code, reason: newState.closeReason })

          if (this.config.track && oldState.status === 'connected') nodelinkPlayingPlayersCount--

          this.client.ws.send(JSON.stringify({
            op: 'event',
            type: 'WebSocketClosedEvent',
            guildId: this.config.guildId,
            code: newState.code,
            reason: newState.closeReason,
            byRemote: true
          }))

          break
        }
      }
    })

    this.connection.on('playerStateChange', (_oldState, newState) => {
      if (newState.status === 'idle' && [ 'stopped', 'finished', 'loadFailed' ].includes(newState.reason)) {
        if (!this.config.paused) nodelinkPlayingPlayersCount--

        debugLog('trackEnd', 2, { track: this.config.track.info, reason: newState.reason })

        this.client.ws.send(JSON.stringify({
          op: 'event',
          type: 'TrackEndEvent',
          guildId: this.config.guildId,
          track: this.config.track,
          reason: newState.reason
        }))

        this._stopTrack()
      }

      if (newState.status === 'playing' && newState.reason === 'requested') {
        nodelinkPlayingPlayersCount++

        debugLog('trackStart', 2, { track: this.config.track.info })

        this.client.ws.send(JSON.stringify({
          op: 'event',
          type: 'TrackStartEvent',
          guildId: this.config.guildId,
          track: this.config.track
        }))
      }
    })

    this.connection.on('error', (error) => {
      if (!this.config.track) return;

      debugLog('trackException', 2, { track: this.config.track.info, exception: error.message })

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

      this.connection.stop('loadFailed')
    })
  }

  _stopTrack() {
    this.cache = {
      url: null,
      protocol: null,
      track: null,
      time: 0
    }

    this.config = {
      ...this.config,
      track: null,
      paused: false
    }
  }

  _getRealTime() {
    return this.cache.time + (this.connection.statistics.packetsExpected * 20)
  }

  updateVoice(buffer) {
    this.config.voice = buffer

    if (!this.connection) this._setupVoice()

    this.connection.voiceStateUpdate({
      session_id: buffer.sessionId
    })
    this.connection.voiceServerUpdate({
      token: buffer.token,
      endpoint: buffer.endpoint
    })

    this.connection.connect(() => {
      if (this.connection.audioStream && !this.config.paused) {
        nodelinkPlayingPlayersCount++

        this.connection.unpause('reconnected')
      }
    })
  }

  destroy() {
    if (this.connection) {
      if (this.connection.audioStream && !this.config.paused) nodelinkPlayingPlayersCount--

      this.connection.destroy()
      this.connection = null
    }

    this._stopTrack()

    nodelinkPlayersCount--
  }

  async getResource(decodedTrack, urlInfo) {
    const streamInfo = await sources.getTrackStream(decodedTrack, urlInfo.url, urlInfo.protocol, urlInfo.additionalData)

    if (streamInfo.exception) return streamInfo

    return { stream: voiceUtils.createAudioResource(streamInfo.stream, urlInfo.format) }
  }

  _emitException(track, reason, cause) {
    debugLog('trackException', 2, { track: track.info, exception: reason })

    this.client.ws.send(JSON.stringify({
      op: 'event',
      type: 'TrackExceptionEvent',
      guildId: this.config.guildId,
      track: track,
      exception: {
        message: reason,
        severity: 'fault',
        cause
      }
    }))
    
    this.client.ws.send(JSON.stringify({
      op: 'event',
      type: 'TrackEndEvent',
      guildId: this.config.guildId,
      track: track,
      reason: 'loadFailed'
    }))
  }

  async play(track, decodedTrack, noReplace) {
    if (noReplace && this.config.track) return this.config

    const urlInfo = await sources.getTrackURL(decodedTrack)

    if (urlInfo.exception) {
      if (this.connection.audioStream) this.connection.stop('loadFailed')
      else this._emitException({
        encoded: track,
        info: decodedTrack,
        userData: this.config.track?.userData
      }, urlInfo.exception.message, urlInfo.exception.cause)

      return this.config
    }

    if (this.config.track?.encoded) {
      debugLog('trackEnd', 2, { track: this.config.track.info, reason: 'replaced' })

      this.client.ws.send(JSON.stringify({
        op: 'event',
        type: 'TrackEndEvent',
        guildId: this.config.guildId,
        track: this.config.track,
        reason: 'replaced'
      }))

      debugLog('trackStart', 2, { track: decodedTrack })

      this.client.ws.send(JSON.stringify({
        op: 'event',
        type: 'TrackStartEvent',
        guildId: this.config.guildId,
        track: {
          encoded: track,
          info: decodedTrack,
          userData: this.config.track?.userData
        }
      }))
    }

    let resource = null
    if (Object.keys(this.config.filters).length > 0) {
      const filter = new Filters()
      filter.configure(this.config.filters)

      this.config.filters = {}
      filter.filters.forEach((filter) => {
        if (typeof filter.type !== 'number' && filter.name !== 'timescale') return;
  
        this.config.filters[filter.name] = filter.data
      })

      resource = await filter.getResource(decodedTrack, urlInfo)  
    } else {
      resource = await this.getResource(decodedTrack, urlInfo)
    }
  
    if (resource.exception) {
      if (this.connection.audioStream) this.connection.stop('loadFailed')
      else this._emitException({
        encoded: track,
        info: decodedTrack,
        userData: this.config.track?.userData
      }, resource.exception.message, resource.exception.cause)

      return this.config
    }

    this.cache.streamInfo = {
      url: urlInfo.url,
      protocol: urlInfo.protocol,
      format: urlInfo.format
    }
    this.config.track = { encoded: track, info: decodedTrack }
    this.config.paused = false

    if (this.config.volume !== 100) 
      resource.stream.setVolume(this.config.volume / 100)

    if (!this.connection)
      return this.config
  
    if (!this.connection.udpInfo?.secretKey)
      await waitForEvent(this.connection, 'stateChange', (_oldState, newState) => newState.status === 'connected')

    const oldResource = this.connection.audioStream
    
    this.connection.play(resource.stream)

    if (oldResource)
      resource.stream.once('readable', () => oldResource.destroy())

    await waitForEvent(this.connection, 'playerStateChange', (_oldState, newState) => newState.status === 'playing')

    return this.config
  }

  stop() {
    if (!this.config.track) return this.config

    if (this.connection.audioStream && this.connection.udp) this.connection.stop()
    else this._stopTrack()
  }

  volume(volume) {
    if (this.connection.audioStream)
      this.connection.audioStream.setVolume(volume / 100)

    this.config.volume = volume

    return this.config
  }

  pause(pause) {
    if (this.connection.audioStream && this.connection.udp) {
      if (pause) {
        this.connection.pause()

        nodelinkPlayingPlayersCount--
      }
      else {
        this.connection.unpause()

        nodelinkPlayingPlayersCount++
      }
    }

    this.config.paused = pause
    
    return this.config
  }

  async filters(filters) {
    if (!this.config.track?.encoded || !config.filters.enabled) return this.config

    const filter = new Filters()
    filter.configure(filters, this.config.track.info)

    this.config.filters = {}
    filter.filters.forEach((filter) => {
      if (typeof filter.type !== 'number' && filter.name !== 'timescale') return;

      this.config.filters[filter.name] = filter.data
    })

    if (!this.config.track) return this.config

    const realTime = this._getRealTime()
    const resource = await filter.getResource(this.config.track.info, this.cache.streamInfo, this._getRealTime(), this.connection.audioStream)

    if (resource.exception) {
      if (this.connection.audioStream) this.connection.stop('loadFailed')
      else this._emitException(this.config.track, resource.exception.message, resource.exception.cause)

      return this.config
    }

    const objectedFilters = Object.entries(this.config.filters)

    const volumeFilter = objectedFilters.find(([ name ]) => name === 'volume')
    this.config.volume = (volumeFilter * 100) || this.config.volume

    const seekFilter = objectedFilters.find(([ name ]) => name === 'seek')
    const endTimeFilter = objectedFilters.find(([ name ]) => name === 'endTime')
    if (resource.stream || seekFilter || endTimeFilter || filter.command.length !== 0) {
      resource.stream.setVolume(volumeFilter || (this.config.volume / 100))
      this.cache.time = seekFilter || realTime

      if (!this.connection)
        return this.config

      if (!this.connection.udpInfo?.secretKey)
        await waitForEvent(this.connection, 'stateChange', (_oldState, newState) => newState.status === 'connected')
      
      this.cache.time = seekFilter || realTime
      this.connection.play(resource.stream)
    } else {
      this.connection.audioStream.setVolume(volumeFilter || (this.config.volume / 100))
    }

    return this.config
  }
}

export default VoiceConnection
