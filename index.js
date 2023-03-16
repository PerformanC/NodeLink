import { WebSocketServer } from 'ws'
import { createServer } from 'http'
import { parse } from 'url'

import connectionHandler from './src/connectionHandler.js'
import config from './config.js'

const server = createServer(connectionHandler.nodelink_requestHandler)
const v4 = new WebSocketServer({ noServer: true })

v4.on('connection', (ws, req) => {
  if (req.headers.authorization !== config.password) {
    console.log('[NodeLink]: Invalid password. Closing connection...')

    return ws.close(4001, 'Invalid password')
  }

  connectionHandler.nodelink_setupConnection(ws, req)
})

server.on('upgrade', (req, socket, head) => {
  let { pathname } = parse(req.url)

  console.log(`[NodeLink]: Received upgrade request for ${pathname}`)

  if (pathname == '/v4/websocket') [
    v4.handleUpgrade(req, socket, head, (ws) => {
      console.log('[NodeLink]: Upgrade request accepted, sending connection event...')

      v4.emit('connection', ws, req)
    })
  ]
})

server.listen(config.port || 2333, () => {
  console.log(`[NodeLink]: Listening on port ${config.port || 2333}`)
})