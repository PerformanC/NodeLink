import os from 'node:os'
import { URL } from 'node:url'

import { randomLetters, debugLog, sendResponse, sendResponseNonNull, verifyMethod, encodeTrack, decodeTrack, tryParseBody } from '../utils.js'
import config from '../../config.js'
import sources from '../sources.js'
import VoiceConnection from './voiceHandler.js'

const clients = {}
let statsInterval = null
let playerUpdateInterval = null

function startStats() {
  statsInterval = setInterval(() => {
    let memoryUsage = process.memoryUsage()

    const statistics = {
      sent: 0,
      nulled: 0,
      expected: 0,
      deficit: 0
    }

    Object.keys(clients).forEach((key) => {
      const client = clients[key]

      client.players.forEach((player) => {
        if (!player.connection) return;

        statistics.sent += player.connection.statistics.packetsSent
        statistics.nulled += player.connection.statistics.packetsLost
        statistics.expected += player.connection.statistics.packetsExpected
      })
    })

    statistics.deficit = statistics.sent - statistics.expected

    const statisticsResponse = JSON.stringify({
      op: 'stats',
      players: nodelinkPlayingPlayersCount,
      playingPlayers: nodelinkPlayingPlayersCount,
      uptime: Math.floor(process.uptime() * 1000),
      memory: {
        free: memoryUsage.heapTotal - memoryUsage.heapUsed,
        used: memoryUsage.heapUsed,
        allocated: 0,
        reservable: memoryUsage.rss
      },
      cpu: {
        cores: os.cpus().length,
        systemLoad: os.loadavg()[0],
        lavalinkLoad: 0
      },
      frameStats: statistics
    })

    Object.keys(clients).forEach((key) => clients[key].ws.send(statisticsResponse, 200))
  }, config.options.statsInterval)
}

function startPlayerUpdate() {
  playerUpdateInterval = setInterval(() => {
    if (Object.keys(clients).length === 0) return;

    Object.keys(clients).forEach((key) => {
      const client = clients[key]

      client.players.forEach((player) => {
        if (!player.connection) return;

        player.config.state = {
          time: Date.now(),
          position: player.connection.playerState.status === 'playing' ? player._getRealTime() : 0,
          connected: player.connection.state.status === 'connected',
          ping: player.connection.ping || -1
        }

        client.ws.send(JSON.stringify({
          op: 'playerUpdate',
          guildId: player.guildId,
          state: player.config.state
        }))
      })
    })
  }, config.options.playerUpdateInterval)
}

async function configureConnection(ws, req, parsedClientName) {
  let sessionId = null
  let client = null

  ws.on('close', (code, reason) => {
    debugLog('disconnect', 3, { ...parsedClientName, code, reason })

    if (!client) return;

    if (clients.length === 1) {
      clearInterval(statsInterval)
      statsInterval = null

      clearInterval(playerUpdateInterval)
      playerUpdateInterval = null

      if (config.search.sources.youtube && config.options.bypassAgeRestriction)
        sources.youtube.free()
    }

    client.players.forEach((player) => player.destroy())
    delete clients[sessionId]
  })

  sessionId = randomLetters(16)
  client = {
    userId: req.headers['user-id'],
    ws,
    players: new Map()
  }

  clients[sessionId] = client

  await startSourceAPIs()

  ws.send(
    JSON.stringify({
      op: 'ready',
      resumed: false,
      sessionId
    })
  )
}

async function requestHandler(req, res) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`)

  if (config.debug.request.all) {
    const body = []
    req.on('data', (chunk) => body.push(chunk))
    req.on('end', () => {
      debugLog('all', 6, { method: req.method, path: parsedUrl.pathname, headers: req.headers, body: Buffer.concat(body).toString() })

      req.removeAllListeners()

      req.push(Buffer.concat(body))
    })
  }

  if (!req.headers || req.headers.authorization !== config.server.password) {
    res.writeHead(401, { 'Content-Type': 'text/plain' })

    res.end('Unauthorized')
  }

  else if (parsedUrl.pathname === '/version') {
    if (verifyMethod(parsedUrl, req, res, 'GET')) return;

    debugLog('version', 1, { headers: req.headers })

    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(`${config.version.major}.${config.version.minor}.${config.version.patch}${config.version.preRelease ? `-${config.version.preRelease}` : ''}`)
  }

  else if (parsedUrl.pathname === '/v4/info') {
    if (verifyMethod(parsedUrl, req, res, 'GET')) return;

    debugLog('info', 1, { headers: req.headers })

    sendResponse(req, res, {
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
      isNodeLink: true,
      jvm: '0.0.0',
      lavaplayer: '0.0.0',
      sourceManagers: Object.keys(config.search.sources).filter((source) => {
        if (typeof config.search.sources[source] === 'boolean') return source
        return config.search.sources[source].enabled
      }),
      filters: Object.keys(config.filters.list).filter((filter) => config.filters.list[filter]),
      plugins: []
    }, 200)
  }

  else if (parsedUrl.pathname === '/v4/decodetrack') {
    if (verifyMethod(parsedUrl, req, res, 'GET')) return;

    const encodedTrack = parsedUrl.searchParams.get('encodedTrack').replace(/ /, '+')
    let decodedTrack = null

    if (!encodedTrack || !(decodedTrack = decodeTrack(encodedTrack))) {
      debugLog('decodetrack', 1, { params: parsedUrl.pathname, headers: req.headers, error: 'The provided track is invalid.' })

      return sendResponse(req, res, {
        timestamp: Date.now(),
        status: 400,
        error: 'Bad Request',
        trace: new Error().stack,
        message: 'The provided track is invalid.',
        path: parsedUrl.pathname
      }, 400)
    }

    debugLog('decodetrack', 1, { params: parsedUrl.pathname, headers: req.headers })

    sendResponse(req, res, { encoded: encodedTrack, info: decodedTrack }, 200)
  }

  else if (parsedUrl.pathname === '/v4/decodetracks') {
    if (verifyMethod(parsedUrl, req, res, 'POST')) return;

    let buffer = ''
    if (!(buffer = await tryParseBody(req, res, buffer))) return;

    if (typeof buffer !== 'object' || !Array.isArray(buffer)) {
      debugLog('decodetracks', 1, { headers: req.headers, body: buffer, error: 'The provided body is invalid.' })

      return sendResponse(req, res, {
        timestamp: Date.now(),
        status: 400,
        error: 'Bad request',
        trace: new Error().stack,
        message: 'The provided body is invalid.',
        path: parsedUrl.pathname
      }, 400)
    }

    const tracks = []
    let failed = false

    buffer.nForEach((encodedTrack) => {
      const decodedTrack = decodeTrack(encodedTrack)

      if (!decodedTrack) {
        failed = true

        debugLog('decodetracks', 1, { headers: req.headers, body: encodedTrack, error: 'The provided track is invalid.' })

        sendResponse(req, res, {
          timestamp: Date.now(),
          status: 400,
          error: 'Bad request',
          trace: new Error().stack,
          message: 'The provided track is invalid.',
          path: parsedUrl.pathname
        }, 400)

        return true
      }

      tracks.push({ encoded: encodedTrack, info: decodedTrack })
    })

    if (failed) return;

    debugLog('decodetracks', 1, { headers: req.headers, body: buffer })

    sendResponse(req, res, tracks, 200)
  }

  else if (parsedUrl.pathname === '/v4/encodetrack') {
    if (verifyMethod(parsedUrl, req, res, 'GET')) return;

    let buffer = ''
    if (!(buffer = await tryParseBody(req, res, buffer))) return;

    let encodedTrack = null

    if (!(encodedTrack = encodeTrack(buffer))) {
      debugLog('encodetrack', 1, { headers: req.headers, body: buffer, error: 'Invalid track object' })

      return sendResponse(req, res, {
        timestamp: Date.now(),
        status: 400,
        error: 'Bad Request',
        trace: new Error().stack,
        message: 'Invalid track object',
        path: '/v4/encodetrack'
      }, 400)
    }

    debugLog('encodetrack', 1, { headers: req.headers, body: buffer })

    sendResponse(req, res, encodedTrack, 200)
  }

  else if (parsedUrl.pathname === '/v4/encodetracks') {
    if (verifyMethod(parsedUrl, req, res, 'POST')) return;

    let buffer = ''
    if (!(buffer = await tryParseBody(req, res, buffer))) return;

    if (typeof buffer !== 'object' || !Array.isArray(buffer)) {
      debugLog('decodetracks', 1, { headers: req.headers, body: buffer, error: 'The provided body is invalid.' })

      return sendResponse(req, res, {
        timestamp: Date.now(),
        status: 400,
        error: 'Bad request',
        trace: new Error().stack,
        message: 'The provided body is invalid.',
        path: parsedUrl.pathname
      }, 400)
    }

    const tracks = []

    buffer.forEach((track) => {
      let encodedTrack = null

      if (!(encodedTrack = encodeTrack(track))) {
        debugLog('encodetracks', 1, { headers: req.headers, body: buffer, error: 'Invalid track object' })

        return sendResponse(req, res, {
          timestamp: Date.now(),
          status: 400,
          error: 'Bad Request',
          trace: new Error().stack,
          message: 'Invalid track object',
          path: '/v4/encodetracks'
        }, 400)
      }

      tracks.push(encodedTrack)
    })

    debugLog('encodetracks', 1, { headers: req.headers, body: buffer })

    sendResponse(req, res, tracks, 200)
  }

  else if (parsedUrl.pathname === '/v4/stats') {
    if (verifyMethod(parsedUrl, req, res, 'GET')) return;

    debugLog('stats', 1, { headers: req.headers })

    const statistics = {
      sent: 0,
      nulled: 0,
      expected: 0,
      deficit: 0
    }

    clients.forEach((key) => {
      const client = clients[key]

      client.players.forEach((player) => {
        if (!player.connection) return;

        statistics.sent += player.connection.statistics.packetsSent
        statistics.nulled += player.connection.statistics.packetsLost
        statistics.expected += player.connection.statistics.packetsExpected
      })
    })

    statistics.deficit = statistics.sent - statistics.expected

    sendResponse(req, res, {
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
    }, 200)
  }

  else if (parsedUrl.pathname === '/v4/loadtracks') {
    if (verifyMethod(parsedUrl, req, res, 'GET')) return;

    debugLog('loadtracks', 1, { params: parsedUrl.pathname, headers: req.headers })

    const identifier = parsedUrl.searchParams.get('identifier')

    let search = null

    const ytSearch = config.search.sources.youtube ? identifier.startsWith('ytsearch:') : null
    const ytRegex = config.search.sources.youtube && !ytSearch ? /^(?:(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:shorts\/(?:\?v=)?[a-zA-Z0-9_-]{11}|playlist\?list=[a-zA-Z0-9_-]+|watch\?(?=.*v=[a-zA-Z0-9_-]{11})[^\s]+))|(?:https?:\/\/)?(?:www\.)?youtu\.be\/[a-zA-Z0-9_-]{11})/.test(identifier) : null
    if (config.search.sources.youtube && (ytSearch || ytRegex))
      search = ytSearch ? await sources.youtube.search(identifier.replace('ytsearch:', ''), 'youtube', true) : await sources.youtube.loadFrom(identifier, 'youtube')

    if (sendResponseNonNull(req, res, search) === true) return;

    const ytMusicSearch = config.search.sources.youtube ? identifier.startsWith('ytmsearch:') : null
    const ytMusicRegex = config.search.sources.youtube && !ytMusicSearch ? /^(https?:\/\/)?(music\.)?youtube\.com\/(?:shorts\/(?:\?v=)?[a-zA-Z0-9_-]{11}|playlist\?list=[a-zA-Z0-9_-]+|watch\?(?=.*v=[a-zA-Z0-9_-]{11})[^\s]+)$/.test(identifier) : null
    if (config.search.sources.youtube && (ytMusicSearch || ytMusicRegex))
      search = ytMusicSearch ? await sources.youtube.search(identifier.replace('ytmsearch:', ''), 'ytmusic', true) : await sources.youtube.loadFrom(identifier, 'ytmusic')

    if (sendResponseNonNull(req, res, search) === true) return;

    const spSearch = config.search.sources.spotify.enabled ? identifier.startsWith('spsearch:') : null
    const spRegex = config.search.sources.spotify.enabled && !spSearch ? /^https?:\/\/(?:open\.spotify\.com\/|spotify:)(?:[^?]+)?(track|playlist|artist|episode|show|album)[/:]([A-Za-z0-9]+)/.exec(identifier) : null
    if (config.search.sources[config.search.defaultSearchSource] && (spSearch || spRegex))
       search = spSearch ? await sources.spotify.search(identifier.replace('spsearch:', '')) : await sources.spotify.loadFrom(identifier, spRegex)

    if (sendResponseNonNull(req, res, search) === true) return;

    const dzSearch = config.search.sources.deezer.enabled ? identifier.startsWith('dzsearch:') : null
    const dzRegex = config.search.sources.deezer.enabled && !dzSearch ? /^https?:\/\/(?:www\.)?deezer\.com\/(?:[a-z]{2}\/)?(track|album|playlist)\/(\d+)$/.exec(identifier) : null
    if (config.search.sources.deezer.enabled && (dzSearch || dzRegex))
      search = dzSearch ? await sources.deezer.search(identifier.replace('dzsearch:', ''), true) : await sources.deezer.loadFrom(identifier, dzRegex)

    if (sendResponseNonNull(req, res, search) === true) return;

    const scSearch = config.search.sources.soundcloud.enabled ? identifier.startsWith('scsearch:') : null
    const scRegex = config.search.sources.soundcloud.enabled && !scSearch ? /^(https?:\/\/)?(www.)?(m\.)?soundcloud\.com\/[\w\-\.]+(\/)+[\w\-\.]+?$/.test(identifier) : null
    if (config.search.sources.soundcloud.enabled && (scSearch || scRegex))
      search = scSearch ? await sources.soundcloud.search(identifier.replace('scsearch:', ''), true) : await sources.soundcloud.loadFrom(identifier)

    if (sendResponseNonNull(req, res, search) === true) return;

    const bcSearch = config.search.sources.bandcamp ? identifier.startsWith('bcsearch:') : null
    const bcRegex = config.search.sources.bandcamp && !bcSearch ? /^https?:\/\/[\w-]+\.bandcamp\.com(\/(track|album)\/[\w-]+)?/.test(identifier) : null
    if (config.search.sources.bandcamp && (bcSearch || bcRegex))
      search = bcSearch ? await sources.bandcamp.search(identifier.replace('bcsearch:', ''), true) : await sources.bandcamp.loadFrom(identifier)

    if (sendResponseNonNull(req, res, search) === true) return;

    const pdSearch = config.search.sources.pandora ? identifier.startsWith('pdsearch:') : null
    const pdRegex = config.search.sources.pandora && !pdRegex ? /^https:\/\/www\.pandora\.com\/(?:playlist|station|podcast|artist)\/.+/.exec(identifier) : null
    if (config.search.sources.pandora && (pdSearch || pdRegex))
      search = pdSearch ? await sources.pandora.search(identifier.replace('pdsearch:', '')) : await sources.pandora.loadFrom(identifier)

    if (sendResponseNonNull(req, res, search) === true) return;

    if (config.search.sources.http && (identifier.startsWith('http://') || identifier.startsWith('https://')))
      search = await sources.http.loadFrom(identifier)

    if (sendResponseNonNull(req, res, search) === true) return;

    if (config.search.sources.local && identifier.startsWith('local:'))
      search = await sources.local.loadFrom(identifier.replace('local:', ''))

    if (!search) {
      debugLog('loadtracks', 4, { type: 3, loadType: 'error', sourceName: 'unknown', message: 'No possible search source found.' })

      search = { loadType: 'empty', data: {} }
    }

    sendResponse(req, res, search, 200)

    return;
  }

  else if (parsedUrl.pathname === '/v4/loadlyrics') {
    if (verifyMethod(parsedUrl, req, res, 'GET')) return;

    const encodedTrack = parsedUrl.searchParams.get('encodedTrack')
    let decodedTrack = null

    if (!encodedTrack || !(decodedTrack = decodeTrack(encodedTrack))) {
      debugLog('loadlyrics', 1, { params: parsedUrl.pathname, headers: req.headers, error: 'The provided track is invalid.' })

      return sendResponse(req, res, {
        timestamp: Date.now(),
        status: 400,
        error: 'Bad Request',
        trace: new Error().stack,
        message: 'The provided track is invalid.',
        path: '/v4/loadlyrics'
      }, 400)
    }

    const language = parsedUrl.searchParams.get('language')
    const captions = await sources.loadLyrics(decodedTrack, language)

    debugLog('loadlyrics', 1, { params: parsedUrl.pathname, headers: req.headers })

    sendResponse(req, res, captions, 200)
  }

  else if (/^\/v4\/sessions\/[A-Za-z0-9]+\/players$(?!\/)/.test(parsedUrl.pathname)) {
    if (verifyMethod(parsedUrl, req, res, 'GET')) return;

    const client = clients[/^\/v4\/sessions\/([A-Za-z0-9]+)\/players$/.exec(parsedUrl.pathname)[1]]

    if (!client) {
      debugLog('getPlayers', 1, { params: parsedUrl.pathname, headers: req.headers, error: 'The provided session Id doesn\'t exist.' })

      return sendResponse(req, res, {
        timestamp: new Date(),
        status: 404,
        trace: new Error().stack,
        message: 'The provided session Id doesn\'t exist.',
        path: parsedUrl.pathname
      }, 404)
    }

    const players = []

    client.players.forEach((player) => {
      player.config.state = {
        time: new Date(),
        position: player.connection ? player.connection.playerState.status === 'playing' ? player._getRealTime() : 0 : 0,
        connected: player.connection ? player.connection.state.status === 'ready' : false,
        ping: player.connection?.ping || -1
      }

      players.push(player.config)
    })

    debugLog('getPlayers', 1, { headers: req.headers })

    sendResponse(req, res, players, 200)
  }

  else if (/^\/v4\/sessions\/\w+\/players\/\w+./.test(parsedUrl.pathname)) {
    if (![ 'DELETE', 'PATCH', 'GET' ].includes(req.method)) {
      sendResponse(req, res, {
        timestamp: Date.now(),
        status: 405,
        error: 'Method Not Allowed',
        message: `Request method must be DELETE, PATCH or GET`,
        path: parsedUrl.pathname
      }, 405)

      return;
    }

    const client = clients[/^\/v4\/sessions\/([A-Za-z0-9]+)\/players\/\d+$/.exec(parsedUrl.pathname)[1]]

    if (!client) {
      debugLog('updatePlayer', 1, { params: parsedUrl.pathname, headers: req.headers, error: 'The provided session Id doesn\'t exist.' })

      return sendResponse(req, res, {
        timestamp: new Date(),
        status: 404,
        trace: new Error().stack,
        message: 'The provided session Id doesn\'t exist.',
        path: parsedUrl.pathname
      }, 404)
    }

    const guildId = /\/players\/(\d+)$/.exec(parsedUrl.pathname)[1]
    let player = client.players.get(guildId)

    if (req.method === 'DELETE') {
      if (!player) {
        debugLog('deletePlayer', 1, { params: parsedUrl.pathname, headers: req.headers, error: 'The provided guildId doesn\'t exist.' })

        return sendResponse(req, res, {
          timestamp: new Date(),
          status: 404,
          trace: new Error().stack,
          message: 'The provided guildId doesn\'t exist.',
          path: parsedUrl.pathname
        }, 404)
      }

      player.destroy()
      client.players.delete(guildId)

      debugLog('deletePlayer', 1, { params: parsedUrl.pathname, headers: req.headers })

      return sendResponse(req, res, null, 204)
    }

    let buffer = ''
    if (!(buffer = await tryParseBody(req, res, buffer))) return;

    if (req.method === 'GET') {
      if (!guildId) {
        debugLog('getPlayer', 1, { params: parsedUrl.pathname, headers: req.headers, error: 'Missing guildId parameter.' })

        return sendResponse(req, res, {
          timestamp: new Date(),
          status: 400,
          trace: new Error().stack,
          message: 'Missing guildId parameter.',
          path: parsedUrl.pathname
        }, 400)
      }

      let player = client.players.get(guildId)

      if (!player) {
        player = new VoiceConnection(guildId, client)

        client.players.set(guildId, player)
      }

      player.config.state = {
        time: new Date(),
        position: player.connection ? player.connection.playerState.status === 'playing' ? player._getRealTime() : 0 : 0,
        connected: player.connection ? player.connection.state.status === 'ready' : false,
        ping: player.connection?.ping || -1
      }

      debugLog('getPlayer', 1, { params: parsedUrl.pathname, headers: req.headers })

      sendResponse(req, res, player.config, 200)
    }
    
    else if (req.method === 'PATCH') {
      if (!player) player = new VoiceConnection(guildId, client)

      if (buffer.voice !== undefined) {
        if (!buffer.voice.endpoint || !buffer.voice.token || !buffer.voice.sessionId) {
          debugLog('voice', 1, { params: parsedUrl.pathname, headers: req.headers, body: buffer, error: `Invalid voice object.` })

          return sendResponse(req, res, {
            timestamp: new Date(),
            status: 400,
            trace: new Error().stack,
            message: 'Invalid voice object.',
            path: parsedUrl.pathname
          }, 400)
        }

        player.updateVoice(buffer.voice)

        if (player.cache.track) {
          player.play(player.cache.track.encoded, decodeTrack(player.cache.track), false)

          player.cache.track = null
        }

        client.players.set(guildId, player)

        debugLog('voice', 1, { params: parsedUrl.pathname, headers: req.headers, body: buffer })
      }

                                                                   /* Deprecated */
      const encodedTrack = buffer.track?.encoded === undefined ? buffer.encodedTrack : buffer.track?.encoded

      if (encodedTrack !== undefined) {
        if (buffer.encodedTrack !== undefined) /* Deprecated */
          debugLog('encodedTrack', 2, { params: parsedUrl.pathname, headers: req.headers, body: buffer, warning: 'The client is using a deprecated method of play (encodedTrack), deprecated by LavaLink. Report to the client GitHub.' })

        if (encodedTrack === null) {
          if (!player.config.track) {
            debugLog('stop', 1, { params: parsedUrl.pathname, headers: req.headers, body: buffer, error: 'The player is not playing.' })

            return sendResponse(req, res, {
              timestamp: new Date(),
              status: 400,
              trace: new Error().stack,
              message: 'The player is not playing.',
              path: parsedUrl.pathname
            }, 400)
          }

          player.stop()

          debugLog('stop', 1, { params: parsedUrl.pathname, headers: req.headers, body: buffer })
        } else {
          const noReplace = parsedUrl.searchParams.get('noReplace')
          const decodedTrack = decodeTrack(encodedTrack)

          if (!decodedTrack) {
            debugLog('play', 1, { track: encodedTrack, exception: { message: 'The provided track is invalid.', severity: 'common', cause: 'Invalid track' } })

            return sendResponse(req, res, {
              timestamp: new Date(),
              status: 400,
              trace: new Error().stack,
              message: 'The provided track is invalid.',
              path: parsedUrl.pathname
            }, 400)
          }

          if (!player.connection.voiceServer) player.cache.track = encodedTrack
          else player.play(encodedTrack, decodedTrack, noReplace === true)

          debugLog('play', 1, { params: parsedUrl.pathname, headers: req.headers, body: buffer })
        }

        client.players.set(guildId, player)
      }

      if (buffer.track?.userData !== undefined) {
        player.config.track = {
          ...(player.config.track ? player.config.track : {}),
          userData: buffer.userData
        }

        debugLog('userData', 1, { params: parsedUrl.pathname, params: parsedUrl.pathname, body: buffer })
      }

      if (buffer.volume !== undefined) {
        if (buffer.volume < 0 || buffer.volume > 1000) {
          debugLog('volume', 1, { params: parsedUrl.pathname, headers: req.headers, body: buffer, error: 'The volume must be between 0 and 1000.' })

          return sendResponse(req, res, {
            timestamp: new Date(),
            status: 400,
            trace: new Error().stack,
            message: 'The volume must be between 0 and 1000.',
            path: parsedUrl.pathname
          }, 400)
        }

        player.volume(buffer.volume)

        client.players.set(guildId, player)

        debugLog('volume', 1, { params: parsedUrl.pathname, params: parsedUrl.pathname, body: buffer })
      }

      if (buffer.paused !== undefined) {
        if (typeof buffer.paused !== 'boolean') {
          debugLog('pause', 1, { params: parsedUrl.pathname, headers: req.headers, body: buffer, error: 'The paused value must be a boolean.' })

          return sendResponse(req, res, {
            timestamp: new Date(),
            status: 400,
            trace: new Error().stack,
            message: 'The paused value must be a boolean.',
            path: parsedUrl.pathname
          }, 400)
        }

        if (!player.connection.ws) {
          debugLog('pause', 1, { params: parsedUrl.pathname, headers: req.headers, body: buffer, error: 'The player is not connected to a voice server.' })

          return sendResponse(req, res, {
            timestamp: new Date(),
            status: 400,
            trace: new Error().stack,
            message: 'The player is not connected to a voice server.',
            path: parsedUrl.pathname
          }, 400)
        }

        player.pause(buffer.paused)

        client.players.set(guildId, player)

        debugLog('pause', 1, { params: parsedUrl.pathname, headers: req.headers, body: buffer })
      }

      let filters = {}

      if (buffer.filters !== undefined) {
        if (typeof buffer.filters !== 'object') {
          debugLog('filters', 1, { params: parsedUrl.pathname, headers: req.headers, body: buffer, error: 'The filters value must be an object.' })

          return sendResponse(req, res, {
            timestamp: new Date(),
            status: 400,
            trace: new Error().stack,
            message: 'The filters value must be an object.',
            path: parsedUrl.pathname
          }, 400)
        }

        filters = buffer.filters

        debugLog('filters', 1, { params: parsedUrl.pathname, headers: req.headers, body: buffer })
      }

      if (buffer.position !== undefined) {
        if (typeof buffer.position !== 'number' && buffer.endTime !== null) {
          debugLog('seek', 1, { params: parsedUrl.pathname, headers: req.headers, body: buffer, error: 'The position value must be a number.' })

          return sendResponse(req, res, {
            timestamp: new Date(),
            status: 400,
            trace: new Error().stack,
            message: 'The position value must be a number.',
            path: parsedUrl.pathname
          }, 400)
        }

        filters.seek = buffer.position

        debugLog('seek', 1, { params: parsedUrl.pathname, headers: req.headers, body: buffer })
      }

      if (buffer.endTime !== undefined) {
        if (typeof buffer.endTime !== 'number' && buffer.endTime !== null) {
          debugLog('endTime', 1, { params: parsedUrl.pathname, headers: req.headers, body: buffer, error: 'The endTime value must be a number.' })

          return sendResponse(req, res, {
            timestamp: new Date(),
            status: 400,
            trace: new Error().stack,
            message: 'The endTime value must be a number.',
            path: parsedUrl.pathname
          }, 400)
        }

        filters.endTime = buffer.endTime

        debugLog('endTime', 1, { params: parsedUrl.pathname, headers: req.headers, body: buffer })
      }

      if (Object.keys(filters).length != 0 || JSON.stringify(buffer.filters) === '{}') {
        player.filters(filters)

        client.players.set(guildId, player)
      }

      /* Updating player state to ensure it's sending up-to-date data */
      player.config.state = {
        time: new Date(),
        position: player.connection ? player.connection.playerState.status === 'playing' ? player._getRealTime() : 0 : 0,
        connected: player.connection ? player.connection.state.status === 'ready' : false,
        ping: player.connection?.ping || -1 
      }

      sendResponse(req, res, player.config, 200)
    }
  }

  else {
    sendResponse(req, res, {
      timestamp: Date.now(),
      status: 404,
      error: 'Not Found',
      trace: new Error().stack,
      message: 'The requested route was not found.',
      path: parsedUrl.pathname
    }, 404)
  }
}

function startSourceAPIs() {
  if (Object.keys(clients).length !== 1) return;

  return new Promise((resolve) => {
    const sourcesToInitialize = []

    if (config.search.sources.youtube && config.options.bypassAgeRestriction)
      sourcesToInitialize.push(sources.youtube)

    if (config.search.sources.spotify.enabled)
      sourcesToInitialize.push(sources.spotify)

    if (config.search.sources.pandora)
      sourcesToInitialize.push(sources.pandora)

    if (config.search.sources.deezer.enabled)
      sourcesToInitialize.push(sources.deezer)

    if (config.search.sources.soundcloud.enabled)
      sourcesToInitialize.push(sources.soundcloud)

    if (config.options.statsInterval)
      startStats()

    if (config.options.playerUpdateInterval)
      startPlayerUpdate()

    if (config.search.sources.musixmatch.enabled)
      sources.musixmatch.init()

    if (sourcesToInitialize.length === 0) resolve()

    let i = 0
    sourcesToInitialize.forEach(async (source) => {
      await source.init()

      if (++i === sourcesToInitialize.length) resolve()
    })
  })
}

export default {
  configureConnection,
  requestHandler,
  startSourceAPIs
}
