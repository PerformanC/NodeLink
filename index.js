import { WebSocketServer } from 'ws'
import { createServer } from 'http'
import { parse } from 'url'

import connectionHandler from './src/connectionHandler.js'
import config from './config.js'
import utils from './src/utils.js'

if (config.options.autoUpdate[1]) setInterval(() => {
  utils.checkForUpdates()
}, config.options.autoUpdate[1])

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
  let { pathname } = parse(req.url)

  if (pathname == '/v4/websocket')
    v4.handleUpgrade(req, socket, head, (ws) => v4.emit('connection', ws, req))
})

server.listen(config.server.port || 2333, () => {
  console.log(`[NodeLink:websocket]: Listening on port ${config.server.port || 2333}`)
})