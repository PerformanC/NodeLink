import { createServer } from 'node:http'
import { parse } from 'node:url'

import connectionHandler from './handler.js'
import inputHandler from './inputHandler.js'
import config from '../../config.js'
import { checkForUpdates } from '../utils.js'
import { WebSocketServer } from '../ws.js'

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

  connectionHandler.startSourceAPIs()
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
    v4.handleUpgrade(req, socket, head, (ws) => v4.emit('/v4/websocket', ws, req))

  if (pathname == '/connection/data')
    v4.handleUpgrade(req, socket, head, (ws) => v4.emit('/connection/data', ws, req))
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