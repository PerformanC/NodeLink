import os from 'node:os'
import { URLSearchParams, parse } from 'node:url'

import utils from '../utils.js'
import config from '../../config.js'
import sources from '../sources.js'
import VoiceConnection from './voiceHandler.js'

import * as djsVoice from '@discordjs/voice'

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

  sessionId = utils.randomLetters(16)

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
    if (utils.verifyMethod(parsedUrl, req, res, 'GET')) return;

    utils.debugLog('version', 1, { headers: req.headers })

    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(`${config.version.major}.${config.version.minor}.${config.version.patch}${config.version.preRelease ? `-${config.version.preRelease}` : ''}`)
  }

  if (parsedUrl.pathname == '/v4/info') {
    if (utils.verifyMethod(parsedUrl, req, res, 'GET')) return;

    utils.debugLog('info', 1, { headers: req.headers })

    utils.send(req, res, {
      version: {
        semver: `${config.version.major}.${config.version.minor}.${config.version.patch}${config.version.preRelease ? `-${config.version.preRelease}` : ''}`,
        ...config.version
      },
      buildTime: -1,
      git: {
        branch: 'main',
        commit: 'unknown',
        commitTime: -1
      },
      nodejs: process.version,
      sourceManagers: Object.keys(config.search.sources).filter((source) => {
        if (typeof config.search.sources[source] == 'boolean') return source
        return source.enabled
      }),
      filters: Object.keys(config.filters.list).filter((filter) => filter),
      plugins: []
    }, 200)
  }

  if (parsedUrl.pathname == '/v4/decodetrack') {
    if (utils.verifyMethod(parsedUrl, req, res, 'GET')) return;

    utils.debugLog('decodetrack', 1, { params: parsedUrl.query, headers: req.headers })
    
    const encodedTrack = new URLSearchParams(parsedUrl.query).get('encodedTrack')

    if (!encodedTrack) return utils.send(req, res, {
      timestamp: Date.now(),
      status: 400,
      error: 'Bad Request',
      trace: null,
      message: 'Missing encodedTrack query parameter',
      path: '/v4/decodetrack'
    }, 400)

    const decodedTrack = utils.decodeTrack(encodedTrack)

    if (!decodedTrack) {
      utils.debugLog('decodetrack', 3, { headers: req.headers, error: 'Failed to decode track.' })

      return utils.send(req, res, {
        timestamp: Date.now(),
        status: 400,
        error: 'Bad request',
        trace: null,
        message: 'The provided track is invalid.',
        path: parsedUrl.pathname
      }, 400)
    }

    utils.send(req, res, { encoded: encodedTrack, info: decodedTrack }, 200)
  }

  if (parsedUrl.pathname == '/v4/decodetracks') {
    if (utils.verifyMethod(parsedUrl, req, res, 'POST')) return;

    let buffer = ''

    req.on('data', (buf) => buffer += buf)
    req.on('end', () => {
      utils.debugLog('decodetracks', 1, { headers: req.headers, body: buffer })

      buffer = JSON.parse(buffer)

      const tracks = []

      const decodedTrack = utils.decodeTrack(buffer)

      if (!decodedTrack) {
        utils.debugLog('decodetracks', 3, { headers: req.headers, body: buffer, error: 'Failed to decode track.' })

        return utils.send(req, res, {
          timestamp: Date.now(),
          status: 400,
          error: 'Bad request',
          trace: null,
          message: 'The provided track is invalid.',
          path: parsedUrl.pathname
        }, 400)
      }

      buffer.forEach((encodedTrack) => tracks.push({ encoded: encodedTrack, info: decodedTrack }))

      utils.send(req, res, tracks, 200)
    })
  }

  if (parsedUrl.pathname == '/v4/encodetrack') {
    if (utils.verifyMethod(parsedUrl, req, res, 'GET')) return;

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
        utils.send(req, res, utils.encodeTrack(buffer), 200)
      } catch (e) {
        utils.debugLog('encodetrack', 3, { headers: req.headers, body: buffer, error: e.message })

        return utils.send(req, res, {
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
    if (utils.verifyMethod(parsedUrl, req, res, 'POST')) return;

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

      utils.send(req, res, tracks, 200)
    })
  }

  if (parsedUrl.pathname == '/v4/stats') {
    if (utils.verifyMethod(parsedUrl, req, res, 'GET')) return;

    utils.debugLog('stats', 1, { headers: req.headers })

    utils.send(req, res, {
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
    if (utils.verifyMethod(parsedUrl, req, res, 'GET')) return;

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
      utils.debugLog('loadtracks', 4, { type: 3, loadType: 'error', sourceName: 'unknown', message: 'No possible search source found.' })

      search = { loadType: 'empty', data: {} }
    }

    utils.sendNonNull(req, res, search, true)
  }

  if (parsedUrl.pathname == '/v4/loadcaptions') {
    if (utils.verifyMethod(parsedUrl, req, res, 'GET')) return;

    utils.debugLog('loadcaptions', 1, { params: parsedUrl.query, headers: req.headers })

    const encodedTrack = new URLSearchParams(parsedUrl.query).get('encodedTrack')

    if (!identifier) return utils.send(req, res, {
      timestamp: Date.now(),
      status: 400,
      error: 'Bad Request',
      trace: null,
      message: 'Missing encodedTrack query parameter',
      path: '/v4/loadcaptions'
    }, 400)

    const decodedTrack = utils.decodeTrack(encodedTrack)

    if (!decodedTrack) {
      utils.debugLog('loadcaptions', 4, { params: parsedUrl.query, headers: req.headers, error: 'Failed to decode track.' })

      return utils.send(req, res, {
        timestamp: Date.now(),
        status: 400,
        error: 'Bad request',
        trace: null,
        message: 'The provided track is invalid.',
        path: parsedUrl.pathname
      }, 400)
    }

    let captions = null

    switch (decodedTrack.sourceName) {
      case 'ytmusic':
      case 'youtube': {
        if (!config.search.sources.youtube) {
          console.log('[\u001b[31mloadCaptions\u001b[37m]: No possible search source found.')

          captions = { loadType: 'empty', data: {} }
        }

        captions = await sources.youtube.loadCaptions(decodedTrack)

        break
      }
    }

    utils.send(req, res, captions, 200)
  }

  if (/^\/v4\/sessions\/\{[a-zA-Z0-9_-]+\}$/.test(parsedUrl.pathname)) {
    if (utils.verifyMethod(parsedUrl, req, res, 'PATCH')) return;

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
  
  if (/^\/v4\/sessions\/[A-Za-z0-9]+\/players$(?!\/)/.test(parsedUrl.pathname)) {
    if (utils.verifyMethod(parsedUrl, req, res, 'GET')) return;
  
    utils.debugLog('getPlayers', 1, { headers: req.headers })

    const client = clients.get(/^\/v4\/sessions\/([A-Za-z0-9]+)\/players$/.exec(parsedUrl.pathname)[1])

    const players = []

    client.players.forEach((player) => {
      player.config.state = {
        time: new Date(),
        position: player.player ? player.player.state.status == djsVoice.AudioPlayerStatus.Playing ? new Date() - player.cache.startedAt : 0 : 0,
        connected: player.connection ? player.connection.state.status == djsVoice.VoiceConnectionStatus.Ready : false,
        ping: player.connection ? player.connection.state.status == djsVoice.VoiceConnectionStatus.Ready ? player.connection.ping.ws : -1 : -1
      }

      players.push(player.config)
    })

    utils.send(req, res, players, 200)

    return;
  }

  if (/^\/v4\/sessions\/\w+\/players\/\w+./.test(parsedUrl.pathname)) {
    if (req.method != 'PATCH' && req.method != 'GET') {
      utils.send(req, res, {
        timestamp: Date.now(),
        status: 405,
        error: 'Method Not Allowed',
        message: `Request method must be either PATCH or GET`,
        path: parsedUrl.pathname
      }, 405)
      
      return;
    }

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
    
    let buffer = ''

    req.on('data', (buf) => buffer += buf)
    req.on('end', async () => {
      buffer = JSON.parse(buffer)

      const guildId = /\/players\/(\d+)$/.exec(parsedUrl.pathname)[1]
      let player = client.players.get(guildId)

      if (req.method == 'GET') {    
        utils.debugLog('getPlayer', 1, { params: parsedUrl.query, headers: req.headers })
    
        const client = clients.get(/^\/v4\/sessions\/([A-Za-z0-9]+)\/players\/\d+$/.exec(parsedUrl.pathname)[1])
        const guildId = /\/players\/(\d+)$/.exec(parsedUrl.pathname)[1]
    
        let player = client.players.get(guildId)
    
        if (!player) {
          player = new VoiceConnection(guildId, client.userId, client.sessionId, client.timeout)
    
          client.players.set(guildId, player)
        }
    
        player.config.state = {
          time: new Date(),
          position: player.player ? player.state.status == djsVoice.AudioPlayerStatus.Playing ? new Date() - player.cache.startedAt : 0 : 0,
          connected: player.connection ? player.connection.state.status == djsVoice.VoiceConnectionStatus.Ready : false,
          ping: player.connection ? player.connection.state.status == djsVoice.VoiceConnectionStatus.Ready ? player.connection.ping.ws : -1 : -1
        }
    
        utils.send(req, res, player.config, 200)
      } else {
        if (buffer.voice != undefined) {
          utils.debugLog('voice', 1, { params: parsedUrl.query, headers: req.headers, body: buffer })

          if (!buffer.voice.endpoint || !buffer.voice.token || !buffer.voice.sessionId) {
            let missing = []
            if (!buffer.voice.endpoint) missing.push('endpoint')
            if (!buffer.voice.token) missing.push('token')
            if (!buffer.voice.sessionId) missing.push('sessionId')
            missing = missing.join(', ')

            utils.debugLog('voice', 1, { params: parsedUrl.query, headers: req.headers, body: buffer, error: `Missing members on body: ${missing}.` })

            return utils.send(req, res, {
              timestamp: new Date(),
              status: 400,
              trace: null,
              message: `Missing members on body: ${missing}.`,
              path: parsedUrl.pathname
            }, 400)
          }

          if (!player) player = new VoiceConnection(guildId, client)

          if (player.cache.track) {
            const decodedTrack = utils.decodeTrack(player.cache.track)

            if (!decodedTrack) {
              utils.debugLog('play', 2, { track: player.cache.track, exception: { message: 'Failed to decode track.', severity: 'common', cause: 'Invalid track' } })
        
              return utils.send(req, res, {
                timestamp: new Date(),
                status: 400,
                trace: null,
                message: 'The provided track is invalid.',
                path: parsedUrl.pathname
              }, 400)
            }

            player.play(player.cache.track.encoded, decodedTrack, false)

            player.cache.track = null
          }

          player.updateVoice(buffer.voice)

          client.players.set(guildId, player)
        }

        if (buffer.encodedTrack !== undefined || buffer.encodedTrack === null) {
          if (buffer.encodedTrack == null) utils.debugLog('stop', 1, { params: parsedUrl.query, headers: req.headers, body: buffer })
          else utils.debugLog('play', 1, { params: parsedUrl.query, headers: req.headers, body: buffer })

          const noReplace = new URLSearchParams(parsedUrl.query).get('noReplace')

          if (!player) player = new VoiceConnection(guildId, client)

          if (buffer.encodedTrack == null) player.player ? player.stop() : null
          else {
            if (!player.connection) player.setup()

            if (!player.config.voice.endpoint) {
              const decodedTrack = utils.decodeTrack(buffer.encodedTrack)

              if (!decodedTrack) {
                utils.debugLog('play', 1, { params: parsedUrl.query, headers: req.headers, body: buffer, error: 'Failed to decode track.' })

                return utils.send(req, res, {
                  timestamp: Date.now(),
                  status: 400,
                  error: 'Bad request',
                  trace: null,
                  message: 'The provided track is invalid.',
                  path: parsedUrl.pathname
                }, 400)
              }

              player.cache.track = { encoded: buffer.encodedTrack, info: decodedTrack }
            }
            else {
              if (player.connection._state != 'connecting' || player.connection._state != 'ready') player.updateVoice(player.config.voice)
              
              const decodedTrack = utils.decodeTrack(buffer.encodedTrack)

              if (!decodedTrack) {
                utils.debugLog('play', 2, { track: buffer.encodedTrack, exception: { message: 'Failed to decode track.', severity: 'common', cause: 'Invalid track' } })
          
                return utils.send(req, res, {
                  timestamp: new Date(),
                  status: 400,
                  trace: null,
                  message: 'The provided track is invalid.',
                  path: parsedUrl.pathname
                }, 400)
              }
  
              player.play(buffer.encodeTrack, decodedTrack, noReplace == true)
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

        player.config.state = {
          time: new Date(),
          position: player.player ? player.player.state.status == djsVoice.AudioPlayerStatus.Playing ? new Date() - player.cache.startedAt : 0 : 0,
          connected: player.connection ? player.connection.state.status == djsVoice.VoiceConnectionStatus.Ready : false,
          ping: player.connection ? player.connection.state.status == djsVoice.VoiceConnectionStatus.Ready ? player.connection.ping.ws : -1 : -1
        }

        utils.send(req, res, player.config, 200)
      }
    })
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