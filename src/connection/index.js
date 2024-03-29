import http from 'node:http'
import { URL } from 'node:url'

import connectionHandler from './handler.js'
import inputHandler from './inputHandler.js'
import config from '../../config.js'
import { debugLog, parseClientName } from '../utils.js'
import { WebSocketServer } from '../ws.js'

if (typeof config.server.port !== 'number')
  throw new Error('Port must be a number.')

if (typeof config.server.password !== 'string')
  throw new Error('Password must be a string.')

if (typeof config.options.threshold !== 'boolean' && typeof config.options.threshold !== 'number')
  throw new Error('Threshold must be a boolean or a number.')

if (typeof config.options.playerUpdateInterval !== 'boolean' && typeof config.options.playerUpdateInterval !== 'number')
  throw new Error('Player update interval must be a boolean or a number.')

if (typeof config.options.statsInterval !== 'boolean' && typeof config.options.statsInterval !== 'number')
  throw new Error('Stats interval must be a boolean or a number.')

if (typeof config.options.maxResultsLength !== 'number')
  throw new Error('Max results length must be a number.')

if (typeof config.options.maxAlbumPlaylistLength !== 'number')
  throw new Error('Max album playlist length must be a number.')

if (typeof config.options.maxCaptionsLength !== 'number')
  throw new Error('Max captions length must be a number.')

if (typeof config.options.bypassAgeRestriction !== 'boolean')
  throw new Error('Bypass age restriction must be a boolean.')

if (!['bandcamp', 'deezer', 'soundcloud', 'youtube', 'ytmusic'].includes(config.search.defaultSearchSource))
  throw new Error('Default search source must be either "bandcamp", "deezer", "soundcloud", "youtube" or "ytmusic".')

if (config.search.fallbackSearchSource === 'soundcloud')
  throw new Error('SoundCloud is not supported as a fallback source.')

if (config.search.sources.spotify.enabled && !config.search.sources.spotify.market)
  throw new Error('Spotify is enabled but no market was provided.')

if (config.search.sources.deezer.enabled && config.search.sources.deezer.decryptionKey === 'DISABLED')
  throw new Error('Deezer is enabled but no decryption key or API key was provided.')

if (config.search.sources.soundcloud.enabled && config.search.sources.soundcloud.clientId === 'DISABLED')
  throw new Error('SoundCloud is enabled but no client ID was provided.')

if (![ 'high', 'medium', 'low', 'lowest' ].includes(config.audio.quality))
  throw new Error('Audio quality must be either "high", "medium", "low" or "lowest".')

if (![ 'xsalsa20_poly1305', 'xsalsa20_poly1305_suffix', 'xsalsa20_poly1305_lite' ].includes(config.audio.encryption))
  throw new Error('Encryption must be either "xsalsa20_poly1305", "xsalsa20_poly1305_suffix" or "xsalsa20_poly1305_lite".')

if (typeof config.voiceReceive.timeout !== 'number')
  throw new Error('Voice receive timeout must be a number.')

if (![ 'opus', 'pcm' ].includes(config.voiceReceive.type))
  throw new Error('Voice receive type must be either "opus" or "pcm".')

const server = http.createServer(connectionHandler.requestHandler)
const v4 = new WebSocketServer()

v4.on('/v4/websocket', connectionHandler.configureConnection)

v4.on('/connection/data', inputHandler.setupConnection)

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`)

  if (req.headers.authorization !== config.server.password) {
    debugLog('disconnect', 3, { name: 'Unknown', version: '0.0.0', code: 401, reason: 'Invalid password' })

    req.socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')

    return req.socket.destroy()
  }

  const parsedClientName = parseClientName(req.headers['client-name'])

  if (!parsedClientName) {
    debugLog('connect', 1, { name: req.headers['client-name'], error: 'Client-name doesn\'t conform to NAME/VERSION format.' })

    req.socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')

    return req.socket.destroy()
  }

  req.clientInfo = parsedClientName

  if (pathname === '/v4/websocket') {
    debugLog('connect', 3, parsedClientName)

    v4.handleUpgrade(req, socket, head, { 'isNodeLink': true }, (ws) => v4.emit('/v4/websocket', ws, req, parsedClientName))
  }

  if (pathname === '/connection/data') {
    if (!req.headers['guild-id'] || !req.headers['user-id']) {
      debugLog('connectCD', 1, { ...parsedClientName, error: `"${!req.headers['guild-id'] ? 'guild-id' : 'user-id'}" header not provided.` })

      req.socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
  
      return req.socket.destroy()
    }

    debugLog('connectCD', 3, { ...parsedClientName, guildId: req.headers['guild-id'] })

    v4.handleUpgrade(req, socket, head, {}, (ws) => v4.emit('/connection/data', ws, req, parsedClientName))
  }
})

v4.on('error', (err) => {
  debugLog('error', 3, { error: err.message })
})

server.on('error', (err) => {
  debugLog('http', 1, { error: err.message })
})

server.listen(config.server.port || 2333, () => {
  console.log(`[\u001b[32mwebsocket\u001b[37m]: Listening on port \u001b[94m${config.server.port || 2333}\u001b[37m.`)
})