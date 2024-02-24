import os from 'node:os'
import { URL } from 'node:url'

import { randomLetters, debugLog, sendResponse, sendResponseNonNull, verifyMethod, encodeTrack, decodeTrack } from '../utils.js'
import config from '../../config.js'
import sources from '../sources.js'
import VoiceConnection from './voiceHandler.js'

const clients = new Map()
// TODO: Use object
let statsInterval = null

function startStats() {
  statsInterval = setInterval(() => {
    let memoryUsage = process.memoryUsage()

    const statistics = {
      sent: 0,
      nulled: 0,
      expected: 0,
      deficit: 0
    }

    clients.forEach((client) => {
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

    clients.forEach((client) => client.ws.send(statisticsResponse, 200))
  }, config.options.statsInterval)
}

async function setupConnection(ws, req) {
  debugLog('connect', 3, { headers: req.headers })

  let sessionId = null
  let client = null

  ws.on('close', (code, reason) => {
    debugLog('disconnect', 3, { code, reason })
    client = clients.get(sessionId)
    if (!client) return;

    if (clients.size == 1) {
      clearInterval(statsInterval)
      statsInterval = null
    }

    if (client.resuming) {
      client.timeout = setTimeout(() => {
        debugLog('resumeTimeout', 3, { headers: req.headers })

        client.players.forEach((player) => player.destroy())
        clients.delete(sessionId)
        client = null
      }, config.server.resumeTimeout)
    } else {
      client.players.forEach((player) => player.destroy())
      clients.delete(sessionId)
      client = null
    }
  })

  function initializeClient() {
    sessionId = randomLetters(16)
    client = {
      userId: req.headers['user-id'],
      ws,
      players: new Map()
    }

    clients.set(sessionId, client)

    ws.send(JSON.stringify({
      op: 'ready',
      resumed: false,
      sessionId,
    }))
  }

  await startSourceAPIs()

  if (req.headers['session-id']) {
    sessionId = req.headers['session-id']

    const resumedClient = clients.get(sessionId)

    if (!resumedClient) {
      debugLog('failedResume', 3, { headers: req.headers })

      initializeClient()
    } else {
      debugLog('resume', 3, { headers: req.headers })

      clearTimeout(resumedClient.timeout)
      delete resumedClient.timeout
      clients.set(sessionId, resumedClient)

      sessionId = req.headers['session-id']
      client = resumedClient

      ws.send(JSON.stringify({
        op: 'ready',
        resumed: !!resumedClient,
        sessionId: !!resumedClient ? sessionId : randomLetters(16)
      }))
    }
  } else {
    initializeClient()
  }
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

  if (!req.headers || req.headers['authorization'] != config.server.password) {
    res.writeHead(401, { 'Content-Type': 'text/plain' })

    res.end('Unauthorized')
  }

  else if (parsedUrl.pathname == '/version') {
    if (verifyMethod(parsedUrl, req, res, 'GET')) return;

    debugLog('version', 1, { headers: req.headers })

    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(`${config.version.major}.${config.version.minor}.${config.version.patch}${config.version.preRelease ? `-${config.version.preRelease}` : ''}`)
  }

  else if (parsedUrl.pathname == '/v4/info') {
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
        if (typeof config.search.sources[source] == 'boolean') return source
        return config.search.sources[source].enabled
      }),
      filters: Object.keys(config.filters.list).filter((filter) => config.filters.list[filter]),
      plugins: []
    }, 200)
  }

  else if (parsedUrl.pathname == '/v4/decodetrack') {
    if (verifyMethod(parsedUrl, req, res, 'GET')) return;

    const encodedTrack = parsedUrl.searchParams.get('encodedTrack').replace(/ /, '+')

    if (!encodedTrack) {
      debugLog('decodetrack', 1, { params: parsedUrl.pathname, headers: req.headers, error: 'Missing encodedTrack query parameter' })

      return sendResponse(req, res, {
        timestamp: Date.now(),
        status: 400,
        error: 'Bad Request',
        trace: null,
        message: 'Missing encodedTrack query parameter',
        path: '/v4/decodetrack'
      }, 400)
    }

    const decodedTrack = decodeTrack(encodedTrack)

    if (!decodedTrack) {
      debugLog('decodetrack', 1, { params: parsedUrl.pathname, headers: req.headers, error: 'The provided track is invalid.' })

      return sendResponse(req, res, {
        timestamp: Date.now(),
        status: 400,
        error: 'Bad request',
        trace: null,
        message: 'The provided track is invalid.',
        path: parsedUrl.pathname
      }, 400)
    }

    debugLog('decodetrack', 1, { params: parsedUrl.pathname, headers: req.headers })

    sendResponse(req, res, { encoded: encodedTrack, info: decodedTrack }, 200)
  }

  else if (parsedUrl.pathname == '/v4/decodetracks') {
    if (verifyMethod(parsedUrl, req, res, 'POST')) return;

    let buffer = ''

    req.on('data', (buf) => buffer += buf)
    req.on('end', () => {
      try {
        buffer = JSON.parse(buffer)
      } catch {
        debugLog('decodetracks', 1, { headers: req.headers, body: buffer, error: 'Invalid body.' })

        return sendResponse(req, res, {
          timestamp: Date.now(),
          status: 400,
          error: 'Bad Request',
          trace: null,
          message: 'Invalid body.',
          path: '/v4/decodetracks'
        }, 400)
      }

      const tracks = []
      let shouldStop = false

      buffer.forEach((encodedTrack) => {
        if (shouldStop) return;

        const decodedTrack = decodeTrack(encodedTrack)

        if (!decodedTrack) {
          shouldStop = true

          debugLog('decodetracks', 1, { headers: req.headers, body: encodedTrack, error: 'The provided track is invalid.' })

          sendResponse(req, res, {
            timestamp: Date.now(),
            status: 400,
            error: 'Bad request',
            trace: null,
            message: 'The provided track is invalid.',
            path: parsedUrl.pathname
          }, 400)
        }

        tracks.push({ encoded: encodedTrack, info: decodedTrack })
      })

      if (shouldStop) return;

      debugLog('decodetracks', 1, { headers: req.headers, body: buffer })

      sendResponse(req, res, tracks, 200)
    })
  }

  else if (parsedUrl.pathname == '/v4/encodetrack') {
    if (verifyMethod(parsedUrl, req, res, 'GET')) return;

    let buffer = ''

    req.on('data', (buf) => buffer += buf)
    req.on('end', () => {
      try {
        buffer = JSON.parse(buffer)
      } catch {
        debugLog('encodetrack', 1, { headers: req.headers, body: buffer, error: 'Invalid body.' })

        return sendResponse(req, res, {
          timestamp: Date.now(),
          status: 400,
          error: 'Bad Request',
          trace: null,
          message: 'Invalid body.',
          path: '/v4/encodetrack'
        }, 400)
      }

      if (!buffer.title || !buffer.author || !buffer.length || !buffer.identifier || !buffer.isSeekable || !buffer.isStream || !buffer.position) {
        debugLog('encodetrack', 1, { headers: req.headers, body: buffer, error: 'Invalid track object' })

        return sendResponse(req, res, {
          timestamp: Date.now(),
          status: 400,
          error: 'Bad Request',
          trace: null,
          message: 'Invalid track object',
          path: '/v4/encodetrack'
        }, 400)
      }

      const encodedTrack = encodeTrack(buffer)

      if (!encodedTrack) {
        debugLog('encodetrack', 1, { headers: req.headers, body: buffer, error: e.message })

        return sendResponse(req, res, {
          timestamp: Date.now(),
          status: 400,
          error: 'Bad Request',
          trace: null,
          message: 'Invalid track object',
          path: '/v4/encodetrack'
        }, 400)
      }

      debugLog('encodetrack', 1, { headers: req.headers, body: buffer })

      sendResponse(req, res, encodedTrack, 200)
    })
  }

  else if (parsedUrl.pathname == '/v4/encodetracks') {
    if (verifyMethod(parsedUrl, req, res, 'POST')) return;

    let buffer = ''

    req.on('data', (buf) => buffer += buf)
    req.on('end', () => {
      try {
        buffer = JSON.parse(buffer)
      } catch {
        debugLog('encodetracks', 1, { headers: req.headers, body: buffer, error: 'Invalid body.' })

        return sendResponse(req, res, {
          timestamp: Date.now(),
          status: 400,
          error: 'Bad Request',
          trace: null,
          message: 'Invalid body.',
          path: '/v4/encodetracks'
        }, 400)
      }

      const tracks = []

      buffer.forEach((track) => {
        if (!track.title || !track.author || !track.length || !track.identifier || !track.isSeekable || !track.isStream || !track.position) {
          debugLog('encodetracks', 1, { headers: req.headers, body: buffer, error: 'Invalid track object' })

          return sendResponse(req, res, {
            timestamp: Date.now(),
            status: 400,
            error: 'Bad Request',
            trace: null,
            message: 'Invalid track object',
            path: '/v4/encodetracks'
          }, 400)
        }

        const encodedTrack = encodeTrack(track)

        if (!encodedTrack) {
          debugLog('encodetracks', 1, { headers: req.headers, body: buffer, error: e.message })

          return sendResponse(req, res, {
            timestamp: Date.now(),
            status: 400,
            error: 'Bad Request',
            trace: null,
            message: 'Invalid track object',
            path: '/v4/encodetracks'
          }, 400)
        }

        tracks.push(encodedTrack)
      })

      debugLog('encodetracks', 1, { headers: req.headers, body: buffer })

      sendResponse(req, res, tracks, 200)
    })
  }

  else if (parsedUrl.pathname == '/v4/stats') {
    if (verifyMethod(parsedUrl, req, res, 'GET')) return;

    debugLog('stats', 1, { headers: req.headers })

    const statistics = {
      sent: 0,
      nulled: 0,
      expected: 0,
      deficit: 0
    }

    clients.forEach((client) => {
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

  else if (parsedUrl.pathname == '/v4/loadtracks') {
    if (verifyMethod(parsedUrl, req, res, 'GET')) return;

    debugLog('loadtracks', 1, { params: parsedUrl.pathname, headers: req.headers })

    const identifier = parsedUrl.searchParams.get('identifier')

    let search = null

    const ytSearch = config.search.sources.youtube ? identifier.startsWith('ytsearch:') : null
    const ytRegex = config.search.sources.youtube && !ytSearch ? /^(https?:\/\/)?(www\.)?youtube\.com\/(?:shorts\/(?:\?v=)?[a-zA-Z0-9_-]{11}|playlist\?list=[a-zA-Z0-9_-]+|watch\?(?=.*v=[a-zA-Z0-9_-]{11})[^\s]+)$/.test(identifier) : null
    if (config.search.sources.youtube && (ytSearch || ytRegex))
      search = ytSearch ? await sources.youtube.search(identifier.replace('ytsearch:', ''), 'youtube', true) : await sources.youtube.loadFrom(identifier, 'youtube')

    if (sendResponseNonNull(req, res, search) == true) return;

    const ytMusicSearch = config.search.sources.youtubeMusic ? identifier.startsWith('ytmsearch:') : null
    const ytMusicRegex = config.search.sources.youtubeMusic && !ytMusicSearch ? /^(https?:\/\/)?(music\.)?youtube\.com\/(?:shorts\/(?:\?v=)?[a-zA-Z0-9_-]{11}|playlist\?list=[a-zA-Z0-9_-]+|watch\?(?=.*v=[a-zA-Z0-9_-]{11})[^\s]+)$/.test(identifier) : null
    if (config.search.sources.youtubeMusic && (ytMusicSearch || ytMusicRegex))
      search = ytMusicSearch ? await sources.youtube.search(identifier.replace('ytmsearch:', ''), 'ytmusic', true) : await sources.youtube.loadFrom(identifier, 'ytmusic')

    if (sendResponseNonNull(req, res, search) == true) return;

    const spSearch = config.search.sources.spotify.enabled ? identifier.startsWith('spsearch:') : null
    const spRegex = config.search.sources.spotify.enabled && !spSearch ? /^https?:\/\/(?:open\.spotify\.com\/|spotify:)(?:[^?]+)?(track|playlist|artist|episode|show|album)[/:]([A-Za-z0-9]+)/.exec(identifier) : null
    if (config.search.sources[config.search.defaultSearchSource] && (spSearch || spRegex))
       search = spSearch ? await sources.spotify.search(identifier.replace('spsearch:', '')) : await sources.spotify.loadFrom(identifier, spRegex)

    if (sendResponseNonNull(req, res, search) == true) return;

    const dzSearch = config.search.sources.deezer.enabled ? identifier.startsWith('dzsearch:') : null
    const dzRegex = config.search.sources.deezer.enabled && !dzSearch ? /^https?:\/\/(?:www\.)?deezer\.com\/(?:[a-z]{2}\/)?(track|album|playlist)\/(\d+)$/.exec(identifier) : null
    if (config.search.sources.deezer.enabled && (dzSearch || dzRegex))
      search = dzSearch ? await sources.deezer.search(identifier.replace('dzsearch:', ''), true) : await sources.deezer.loadFrom(identifier, dzRegex)

    if (sendResponseNonNull(req, res, search) == true) return;

    const scSearch = config.search.sources.soundcloud.enabled ? identifier.startsWith('scsearch:') : null
    const scRegex = config.search.sources.soundcloud.enabled && !scSearch ? /^https?:\/\/soundcloud\.com\/[a-zA-Z0-9-_]+\/?(?:sets\/)?[a-zA-Z0-9-_]+(?:\?.*)?$/ : null
    if (config.search.sources.soundcloud.enabled && (scSearch || scRegex))
      search = scSearch ? await sources.soundcloud.search(identifier.replace('scsearch:', ''), true) : await sources.soundcloud.loadFrom(identifier)

    if (sendResponseNonNull(req, res, search) == true) return;

    const bcSearch = config.search.sources.bandcamp ? identifier.startsWith('bcsearch:') : null
    const bcRegex = config.search.sources.bandcamp && !bcSearch ? /^https?:\/\/[\w-]+\.bandcamp\.com(\/(track|album)\/[\w-]+)?/.test(identifier) : null
    if (config.search.sources.bandcamp && (bcSearch || bcRegex))
      search = bcSearch ? await sources.bandcamp.search(identifier.replace('bcsearch:', ''), true) : await sources.bandcamp.loadFrom(identifier)

    if (sendResponseNonNull(req, res, search) == true) return;

    const pdSearch = config.search.sources.pandora ? identifier.startsWith('pdsearch:') : null
    const pdRegex = config.search.sources.pandora && !pdRegex ? /^https:\/\/www\.pandora\.com\/(?:playlist|station|podcast|artist)\/.+/.exec(identifier) : null
    if (config.search.sources.pandora && (pdSearch || pdRegex))
      search = pdSearch ? await sources.pandora.search(identifier.replace('pdsearch:', '')) : await sources.pandora.loadFrom(identifier)

    if (sendResponseNonNull(req, res, search) == true) return;

    if (config.search.sources.http && (identifier.startsWith('http://') || identifier.startsWith('https://')))
      search = await sources.http.loadFrom(identifier)

    if (sendResponseNonNull(req, res, search) == true) return;

    if (config.search.sources.local && identifier.startsWith('local:'))
      search = await sources.local.loadFrom(identifier.replace('local:', ''))

    if (!search) {
      debugLog('loadtracks', 4, { type: 3, loadType: 'error', sourceName: 'unknown', message: 'No possible search source found.' })

      search = { loadType: 'empty', data: {} }
    }

    sendResponse(req, res, search, 200)
  }

  else if (parsedUrl.pathname == '/v4/loadlyrics') {
    if (verifyMethod(parsedUrl, req, res, 'GET')) return;

    const encodedTrack = parsedUrl.searchParams.get('encodedTrack')

    if (!encodedTrack) return sendResponse(req, res, {
      timestamp: Date.now(),
      status: 400,
      error: 'Bad Request',
      trace: null,
      message: 'Missing encodedTrack query parameter',
      path: '/v4/loadlyrics'
    }, 400)

    const decodedTrack = decodeTrack(encodedTrack)

    if (!decodedTrack) {
      debugLog('loadlyrics', 4, { params: parsedUrl.pathname, headers: req.headers, error: 'The provided track is invalid.' })

      return sendResponse(req, res, {
        timestamp: Date.now(),
        status: 400,
        error: 'Bad request',
        trace: null,
        message: 'The provided track is invalid.',
        path: parsedUrl.pathname
      }, 400)
    }

    const language = parsedUrl.searchParams.get('language')

    let captions = { loadType: 'empty', data: {} }

    switch (decodedTrack.sourceName) {
      case 'ytmusic':
      case 'youtube': {
        if (!config.search.sources[decodedTrack.sourceName]) {
          debugLog('loadlyrics', 1, { params: parsedUrl.pathname, headers: req.headers, error: 'No possible search source found.' })

          break
        }

        captions = await sources.youtube.loadLyrics(decodedTrack, language) || captions

        break
      }
      case 'spotify': {
        if (!config.search.sources[config.search.defaultSearchSource] || !config.search.sources.spotify.enabled) {
          debugLog('loadlyrics', 1, { params: parsedUrl.pathname, headers: req.headers, error: 'No possible search source found.' })

          break
        }

        captions = await sources.spotify.loadLyrics(decodedTrack, language) || captions

        break
      }
      case 'deezer': {
        if (!config.search.sources.deezer.enabled) {
          debugLog('loadlyrics', 1, { params: parsedUrl.pathname, headers: req.headers, error: 'No possible search source found.' })

          break
        }

        captions = await sources.deezer.loadLyrics(decodedTrack, language)

        break
      }
      default: {
        switch (config.search.lyricsFallbackSearchSource) {
          case 'genius': {
            if (!config.search.sources.genius) {
              debugLog('loadlyrics', 1, { params: parsedUrl.pathname, headers: req.headers, error: 'No possible search source found.' })

              break
            }

            captions = await sources.genius.loadLyrics(decodedTrack, language) || captions

            break
          }
          case 'musixmatch': {
            if (!config.search.sources.musixmatch) {
              debugLog('loadlyrics', 1, { params: parsedUrl.pathname, headers: req.headers, error: 'No possible search source found.' })

              break
            }

            captions = await sources.musixmatch.loadLyrics(decodedTrack, language) || captions

            break
          }
        }

        break
      }
    }

    debugLog('loadlyrics', 1, { params: parsedUrl.pathname, headers: req.headers })

    sendResponse(req, res, captions, 200)
  }

  else if (/^\/v4\/sessions\/[A-Za-z0-9]+$/.test(parsedUrl.pathname)) {
    if (verifyMethod(parsedUrl, req, res, 'PATCH')) return;

    const sessionId = /^\/v4\/sessions\/[A-Za-z0-9]+/.exec(parsedUrl.pathname)[1]

    let buffer = ''

    req.on('data', (buf) => buffer += buf)
    req.on('end', () => {
      try {
        buffer = JSON.parse(buffer)
      } catch {
        debugLog('sessions', 1, { params: parsedUrl.pathname, headers: req.headers, body: buffer, error: 'Invalid body.' })

        return sendResponse(req, res, {
          timestamp: new Date(),
          status: 400,
          trace: null,
          message: 'Invalid body.',
          path: parsedUrl.pathname
        }, 400)
      }

      if (!buffer.resuming) {
        debugLog('sessions', 1, { params: parsedUrl.pathname, headers: req.headers, body: buffer, error: 'Invalid body.' })

        return sendResponse(req, res, {
          timestamp: new Date(),
          status: 400,
          trace: null,
          message: 'Invalid body.',
          path: parsedUrl.pathname
        }, 400)
      }

      clients.set(sessionId, { ...clients.get(sessionId), resuming: buffer.resuming })

      debugLog('sessions', 1, { params: parsedUrl.pathname, headers: req.headers, body: buffer })

      sendResponse(req, res, { resuming: buffer.resuming, timeout: config.server.resumeTimeout }, 200)
    })
  }

  else if (/^\/v4\/sessions\/[A-Za-z0-9]+\/players$(?!\/)/.test(parsedUrl.pathname)) {
    if (verifyMethod(parsedUrl, req, res, 'GET')) return;

    const client = clients.get(/^\/v4\/sessions\/([A-Za-z0-9]+)\/players$/.exec(parsedUrl.pathname)[1])

    if (!client) {
      debugLog('getPlayers', 1, { params: parsedUrl.pathname, headers: req.headers, error: 'The provided session Id doesn\'t exist.' })

      return sendResponse(req, res, {
        timestamp: new Date(),
        status: 404,
        trace: null,
        message: 'The provided session Id doesn\'t exist.',
        path: parsedUrl.pathname
      }, 404)
    }

    const players = []

    client.players.forEach((player) => {
      player.config.state = {
        time: new Date(),
        position: player.connection ? player.connection.playerState.status == 'playing' ? player._getRealTime() : 0 : 0,
        connected: player.connection ? player.connection.state.status == 'ready' : false,
        ping: player.connection ? player.connection.state.status == 'ready' ? player.connection.ping : -1 : -1
      }

      players.push(player.config)
    })

    debugLog('getPlayers', 1, { headers: req.headers })

    sendResponse(req, res, players, 200)

    return;
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

    const client = clients.get(/^\/v4\/sessions\/([A-Za-z0-9]+)\/players\/\d+$/.exec(parsedUrl.pathname)[1])

    if (!client) {
      debugLog('updatePlayer', 1, { params: parsedUrl.pathname, headers: req.headers, error: 'The provided session Id doesn\'t exist.' })

      return sendResponse(req, res, {
        timestamp: new Date(),
        status: 404,
        trace: null,
        message: 'The provided session Id doesn\'t exist.',
        path: parsedUrl.pathname
      }, 404)
    }

    const guildId = /\/players\/(\d+)$/.exec(parsedUrl.pathname)[1]
    let player = client.players.get(guildId)

    if (req.method == 'DELETE') {
      if (!player) {
        debugLog('deletePlayer', 1, { params: parsedUrl.pathname, headers: req.headers, error: 'The provided guildId doesn\'t exist.' })

        return sendResponse(req, res, {
          timestamp: new Date(),
          status: 404,
          trace: null,
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

    req.on('data', (buf) => buffer += buf)
    req.on('end', async () => {
      try {
        buffer = JSON.parse(buffer)
      } catch {
        debugLog('updatePlayer', 1, { params: parsedUrl.pathname, headers: req.headers, error: 'Invalid body.' })

        return sendResponse(req, res, {
          timestamp: new Date(),
          status: 400,
          trace: null,
          message: 'Invalid body.',
          path: parsedUrl.pathname
        }, 400)
      }

      if (req.method == 'GET') {
        if (!guildId) {
          debugLog('getPlayer', 1, { params: parsedUrl.pathname, headers: req.headers, error: 'Missing guildId parameter.' })

          return sendResponse(req, res, {
            timestamp: new Date(),
            status: 400,
            trace: null,
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
          position: player.connection ? player.connection.playerState.status == 'playing' ? player._getRealTime() : 0 : 0,
          connected: player.connection ? player.connection.state.status == 'ready' : false,
          ping: player.connection ? player.connection.state.status == 'ready' ? player.connection.ping : -1 : -1
        }

        debugLog('getPlayer', 1, { params: parsedUrl.pathname, headers: req.headers })

        sendResponse(req, res, player.config, 200)
      } else if (req.method == 'PATCH') {
        if (!player) player = new VoiceConnection(guildId, client)

        if (buffer.voice != undefined) {
          if (!buffer.voice.endpoint || !buffer.voice.token || !buffer.voice.sessionId) {
            debugLog('voice', 1, { params: parsedUrl.pathname, headers: req.headers, body: buffer, error: `Invalid voice object.` })

            return sendResponse(req, res, {
              timestamp: new Date(),
              status: 400,
              trace: null,
              message: 'Invalid voice object.',
              path: parsedUrl.pathname
            }, 400)
          }

          if (!player.connection) player.setup()

          player.updateVoice(buffer.voice)

          if (player.cache.track) {
            const decodedTrack = decodeTrack(player.cache.track)

            if (!decodedTrack) {
              debugLog('play', 1, { track: player.cache.track, exception: { message: 'The provided track is invalid.', severity: 'common', cause: 'Invalid track' } })

              return sendResponse(req, res, {
                timestamp: new Date(),
                status: 400,
                trace: null,
                message: 'The cached track is invalid.',
                path: parsedUrl.pathname
              }, 400)
            }

            player.play(player.cache.track.encoded, decodedTrack, false)

            player.cache.track = null
          }

          client.players.set(guildId, player)

          debugLog('voice', 1, { params: parsedUrl.pathname, headers: req.headers, body: buffer })
        }

        if (buffer.track?.encoded !== undefined || buffer.track?.encoded === null) {
          const noReplace = parsedUrl.searchParams.get('noReplace')

          if (buffer.track.encoded == null) player.config.track ? player.stop() : null
          else {
            if (!player.connection) player.setup()

            const decodedTrack = decodeTrack(buffer.track.encoded)

            if (!decodedTrack) {
              debugLog('play', 1, { track: buffer.track.encoded, exception: { message: 'The provided track is invalid.', severity: 'common', cause: 'Invalid track' } })

              return sendResponse(req, res, {
                timestamp: new Date(),
                status: 400,
                trace: null,
                message: 'The provided track is invalid.',
                path: parsedUrl.pathname
              }, 400)
            }

            if (!player.connection.voiceServer) player.cache.track = buffer.track.encoded
            else player.play(buffer.track.encoded, decodedTrack, noReplace == true)
          }

          client.players.set(guildId, player)

          if (buffer.track.encoded == null) debugLog('stop', 1, { params: parsedUrl.pathname, headers: req.headers, body: buffer })
          else debugLog('play', 1, { params: parsedUrl.pathname, headers: req.headers, body: buffer })
        }

        if (buffer.track?.userData !== undefined) {
          player.config.track = {
            ...(player.config.track ? player.config.track : {}),
            userData: buffer.userData
          }

          debugLog('userData', 1, { params: parsedUrl.pathname, params: parsedUrl.pathname, body: buffer })
        }

        if (buffer.volume != undefined) {
          if (buffer.volume < 0 || buffer.volume > 1000) {
            debugLog('volume', 1, { params: parsedUrl.pathname, headers: req.headers, body: buffer, error: 'The volume must be between 0 and 1000.' })

            return sendResponse(req, res, {
              timestamp: new Date(),
              status: 400,
              trace: null,
              message: 'The volume must be between 0 and 1000.',
              path: parsedUrl.pathname
            }, 400)
          }

          player.volume(buffer.volume)

          client.players.set(guildId, player)

          debugLog('volume', 1, { params: parsedUrl.pathname, params: parsedUrl.pathname, body: buffer })
        }

        if (buffer.paused != undefined) {
          if (typeof buffer.paused != 'boolean') {
            debugLog('pause', 1, { params: parsedUrl.pathname, headers: req.headers, body: buffer, error: 'The paused value must be a boolean.' })

            return sendResponse(req, res, {
              timestamp: new Date(),
              status: 400,
              trace: null,
              message: 'The paused value must be a boolean.',
              path: parsedUrl.pathname
            }, 400)
          }

          if (player.connection.ws) player.pause(buffer.paused)

          client.players.set(guildId, player)

          debugLog('pause', 1, { params: parsedUrl.pathname, headers: req.headers, body: buffer })
        }

        let filters = {}

        if (buffer.filters != undefined) {
          if (typeof buffer.filters != 'object') {
            debugLog('filters', 1, { params: parsedUrl.pathname, headers: req.headers, body: buffer, error: 'The filters value must be an object.' })

            return sendResponse(req, res, {
              timestamp: new Date(),
              status: 400,
              trace: null,
              message: 'The filters value must be an object.',
              path: parsedUrl.pathname
            }, 400)
          }

          filters = buffer.filters

          debugLog('filters', 1, { params: parsedUrl.pathname, headers: req.headers, body: buffer })
        }

        if (buffer.position != undefined) {
          if (typeof buffer.position != 'number') {
            debugLog('seek', 1, { params: parsedUrl.pathname, headers: req.headers, body: buffer, error: 'The position value must be a number.' })

            return sendResponse(req, res, {
              timestamp: new Date(),
              status: 400,
              trace: null,
              message: 'The position value must be a number.',
              path: parsedUrl.pathname
            }, 400)
          }

          filters.seek = buffer.position

          debugLog('seek', 1, { params: parsedUrl.pathname, headers: req.headers, body: buffer })
        }

        if (buffer.endTime != undefined) {
          if (typeof buffer.endTime != 'number') {
            debugLog('endTime', 1, { params: parsedUrl.pathname, headers: req.headers, body: buffer, error: 'The endTime value must be a number.' })

            return sendResponse(req, res, {
              timestamp: new Date(),
              status: 400,
              trace: null,
              message: 'The endTime value must be a number.',
              path: parsedUrl.pathname
            }, 400)
          }

          filters.endTime = buffer.endTime

          debugLog('endTime', 1, { params: parsedUrl.pathname, headers: req.headers, body: buffer })
        }

        if (Object.keys(filters).length != 0) {
          player.filters(filters)

          client.players.set(guildId, player)
        }

        player.config.state = {
          time: new Date(),
          position: player.connection ? player.connection.playerState.status == 'playing' ? player._getRealTime() : 0 : 0,
          connected: player.connection ? player.connection.state.status == 'ready' : false,
          ping: player.connection ? player.connection.state.status == 'ready' ? player.connection.ping : -1 : -1
        }

        sendResponse(req, res, player.config, 200)
      }
    })
  }

  else {
    sendResponse(req, res, {
      timestamp: Date.now(),
      status: 404,
      error: 'Not Found',
      trace: null,
      message: 'The requested route was not found.',
      path: parsedUrl.pathname
    }, 404)
  }
}

function startSourceAPIs() {
  if (clients.size != 0) return;

  return new Promise((resolve) => {
    const sourcesToInitialize = []

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

    let initializedAmount = 0

    if (sourcesToInitialize.length == 0) resolve()

    for (let i = 0;i < sourcesToInitialize.length;i++) {
      const source = sourcesToInitialize[i]

      source.init().then(() => {
        initializedAmount++

        if (initializedAmount == sourcesToInitialize.length) resolve()
      })
    }

    if (config.search.sources.musixmatch.enabled)
      sources.musixmatch.init()
  })
}

export default {
  setupConnection,
  requestHandler,
  startSourceAPIs
}
