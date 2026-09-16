import http from 'node:http'
import type { Socket as NetSocket } from 'node:net'
import process from 'node:process'

import type NodelinkServer from '../index.ts'
import type { ApiNodelinkServer } from '../typings/api/api.types.ts'
import { logger } from '../utils.ts'
import { handleHttpUpgrade } from './wsRouter.ts'

type RequestHandlerType = typeof import('../api/index.ts').default

/* INFO: Creates and configures native Node.js HTTP server with socket error guards and upgrade routing */
function createHttpServer(
  nodelink: NodelinkServer,
  getRequestHandler: () => Promise<RequestHandlerType>
): http.Server {
  const server = http.createServer((req, res) => {
    nodelink.pluginManager.callHook('onRESTRequest', req, res)

    if (res.writableEnded) return

    void getRequestHandler()
      .then((handler) => handler(nodelink as ApiNodelinkServer, req, res))
      .catch((error: Error) => {
        logger(
          'error',
          'Server',
          `Failed to handle HTTP request: ${error.message}`
        )
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' })
        }
        res.end('Internal Server Error')
      })
  })

  /* INFO: Tune keep-alive settings for high-throughput gateway traffic */
  server.keepAliveTimeout = 65000
  server.headersTimeout = 66000

  /* INFO: Guard all incoming sockets against EPIPE and ECONNRESET races */
  server.on('connection', (socket: NetSocket) => {
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (err?.code === 'EPIPE' || err?.code === 'ECONNRESET') return
      logger('debug', 'Server', `HTTP socket error: ${err.message}`)
    })
  })

  server.on('clientError', (err: NodeJS.ErrnoException, socket: NetSocket) => {
    if (err?.code !== 'EPIPE' && err?.code !== 'ECONNRESET') {
      logger('debug', 'Server', `HTTP client error: ${err.message}`)
    }
    try {
      if (!socket.destroyed) socket.destroy()
    } catch {}
  })

  server.on('upgrade', (request, socket, head) => {
    handleHttpUpgrade(nodelink, request, socket as NetSocket, head)
  })

  return server
}

/* INFO: Starts listening on configured port and host with descriptive network error diagnostics */
function listenHttpServer(
  server: http.Server,
  host: string,
  port: number
): void {
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger('error', 'Server', `Port ${port} is already in use.`)
    } else if (err.code === 'EADDRNOTAVAIL') {
      logger(
        'error',
        'Server',
        `The address ${host} is not available on this machine.`
      )
      logger(
        'error',
        'Server',
        'Please check your "host" configuration. Use "0.0.0.0" to listen on all interfaces.'
      )
    } else {
      logger('error', 'Server', `Failed to start server: ${err.message}`)
    }
    process.exit(1)
  })

  server.listen(port, host, () => {
    logger(
      'started',
      'Server',
      `Successfully listening on host ${host}, port ${port}`
    )
  })
}

export { createHttpServer, listenHttpServer }
