import { WebSocketServer } from 'ws'
import { createServer } from 'http'
import { parse } from 'url'

import connectionHandler from './handler.js'
import config from '../../config.js'
import utils from '../utils.js'

if (config.options.autoUpdate[2]) setInterval(() => {
  utils.checkForUpdates()
}, config.options.autoUpdate[2])

const server = createServer(connectionHandler.requestHandler)
const v4 = new WebSocketServer({ noServer: true })

v4.on('connection', (ws, req) => {
  if (req.headers.authorization != config.server.password) {
    console.log('[NodeLink:websocket]: Invalid password. Closing connection...')

    return ws.close(4001, 'Invalid password')
  }

  connectionHandler.startSourceAPIs()
  connectionHandler.setupConnection(ws, req)
})

server.on('upgrade', (req, socket, head) => {
  const { pathname } = parse(req.url)

  if (pathname == '/v4/websocket')
    v4.handleUpgrade(req, socket, head, (ws) => v4.emit('connection', ws, req))
})

v4.on('error', (err) => {
  console.error('[NodeLink:websocket]: Error: ' + err)
})

server.on('error', (err) => {
  console.error('[NodeLink:http]: Error: ' + err)
})

server.listen(config.server.port || 2333, () => {
  console.log(`[NodeLink:websocket]: Listening on port ${config.server.port || 2333}`)
})