import { createServer } from 'node:http'
import { parse } from 'node:url'

import connectionHandler from './handler.js'
import inputHandler from './inputHandler.js'
import config from '../../config.js'
import { checkForUpdates } from '../utils.js'
import { WebSocketServer } from '../ws.js'

if (typeof config.server.port != 'number')
  throw new Error('Port must be a number.')

if (typeof config.server.password != 'string')
  throw new Error('Password must be a string.')

if (typeof config.server.resumeTimeout != 'number')
  throw new Error('Resume timeout must be a number.')

if (typeof config.options.threshold != 'boolean' && typeof config.options.threshold != 'number')
  throw new Error('Threshold must be a boolean or a number.')

if (typeof config.options.playerUpdateInterval != 'boolean' && typeof config.options.playerUpdateInterval != 'number')
  throw new Error('Player update interval must be a boolean or a number.')

if (typeof config.options.statsInterval != 'boolean' && typeof config.options.statsInterval != 'number')
  throw new Error('Stats interval must be a boolean or a number.')

if (typeof config.options.autoUpdate != 'object')
  throw new Error('Auto update must be an array.')

if (typeof config.options.autoUpdate[0] != 'boolean')
  throw new Error('Auto update[0] must be a boolean.')

if (typeof config.options.autoUpdate[1] != 'boolean')
  throw new Error('Auto update[1] must be a boolean.')

if (typeof config.options.autoUpdate[2] != 'boolean' && typeof config.options.autoUpdate[2] != 'number')
  throw new Error('Auto update[2] must be a boolean or a number.')

if (typeof config.options.autoUpdate[3] != 'string')
  throw new Error('Auto update[3] must be a string.')

if (!['tar', 'zip', '7zip'].includes(config.options.autoUpdate[3]))
  throw new Error('Auto update[3] must be either "tar", "zip" or "7zip".')

if (typeof config.options.maxResultsLength != 'number')
  throw new Error('Max results length must be a number.')

if (typeof config.options.maxAlbumPlaylistLength != 'number')
  throw new Error('Max album playlist length must be a number.')

if (!['bandcamp', 'deezer', 'soundcloud', 'youtube', 'ytmusic'].includes(config.search.defaultSearchSource))
  throw new Error('Default search source must be either "bandcamp", "deezer", "soundcloud", "youtube" or "ytmusic".')

if (config.search.fallbackSearchSource == 'soundcloud')
  throw new Error('SoundCloud is not supported as a fallback source.')

if (config.search.sources.spotify.enabled && !config.search.sources.spotify.market)
  throw new Error('Spotify is enabled but no market was provided.')

if (config.search.sources.deezer.enabled && (!config.search.sources.deezer.decryptionKey || !config.search.sources.deezer.apiKey))
  throw new Error('Deezer is enabled but no decryption key or API key was provided.')

if (config.search.sources.soundcloud.enabled && !config.search.sources.soundcloud.clientId)
  throw new Error('SoundCloud is enabled but no client ID was provided.')

if (config.options.autoUpdate[2]) setInterval(() => {
  checkForUpdates()
}, config.options.autoUpdate[2])

const server = createServer(connectionHandler.requestHandler)
const v4 = new WebSocketServer()

v4.on('/v4/websocket', (ws, req) => {
  if (req.headers.authorization != config.server.password) {
    console.log('[\u001b[31mwebsocket\u001b[39m]: Invalid password. Closing connection...')

    return ws.close(4001, 'Invalid password')
  }

  connectionHandler.setupConnection(ws, req)
})

v4.on('/connection/data', (ws, req) => {
  if (req.headers.authorization != config.server.password) {
    console.log('[\u001b[31mwebsocket\u001b[39m]: Invalid password. Closing connection...')

    return ws.close(4001, 'Invalid password')
  }

  inputHandler.setupConnection(ws, req)
})

server.on('upgrade', (req, socket, head) => {
  const { pathname } = parse(req.url)

  if (pathname == '/v4/websocket')
    v4.handleUpgrade(req, socket, head, { 'isNodeLink': true }, (ws) => v4.emit('/v4/websocket', ws, req))

  if (pathname == '/connection/data')
    v4.handleUpgrade(req, socket, head, {}, (ws) => v4.emit('/connection/data', ws, req))
})

v4.on('error', (err) => {
  console.error(`[\u001b[31mwebsocket\u001b[37m]: Error: \u001b[31m${err}\u001b[37m`)
})

server.on('error', (err) => {
  console.error(`[\u001b[31mhttp\u001b[37m]: Error: \u001b[31m${err}\u001b[37m`)
})

server.listen(config.server.port || 2333, () => {
  console.log(`[\u001b[32mwebsocket\u001b[37m]: Listening on port \u001b[94m${config.server.port || 2333}\u001b[37m.`)
})