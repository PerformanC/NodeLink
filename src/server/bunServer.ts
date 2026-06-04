import { EventEmitter } from 'node:events'
import type { ServerWebSocket } from 'bun'
import type { NodelinkConfig } from '../typings/config/config.types.ts'
import type {
  BunSocketData,
  IBunSocketWrapper,
  NodelinkSocketType,
  RequestShim,
  ResponseShim,
  SessionSocket
} from '../typings/index.types.ts'
import type { ClientInfo, ReqShim } from '../typings/shared.types.ts'
import { logger, parseClient, verifyDiscordID } from '../utils.ts'

const VOICE_PATH_RE = /^\/v4\/websocket\/voice\/([A-Za-z0-9]+)\/?$/
const LIVE_PATH_RE = /^\/v4\/websocket\/youtube\/live\/([^/]+)\/?$/

type RequestHandler = (
  nodelink: import('../typings/api/api.types.ts').ApiNodelinkServer,
  req: RequestShim,
  res: ResponseShim
) => Promise<void>

/**
 * Context required by the Bun server functions.
 * Subset of NodelinkServer properties that the Bun code reads.
 * @internal
 */
export interface BunServerContext {
  options: NodelinkConfig
  sessions: {
    resumableSessions: Map<string, unknown>
    activeSessions: Map<string, { id: string; socket: SessionSocket | null }>
  }
  socket: NodelinkSocketType
}

/**
 * Wrapper for Bun's ServerWebSocket that implements EventEmitter
 * Provides compatibility with Node.js WebSocket implementations
 */
export class BunSocketWrapper
  extends EventEmitter
  implements IBunSocketWrapper
{
  ws: ServerWebSocket<BunSocketData>
  remoteAddress: string

  /**
   * Creates a new BunSocketWrapper
   * @param ws - Bun ServerWebSocket instance
   */
  constructor(ws: ServerWebSocket<BunSocketData>) {
    super()
    this.ws = ws
    this.remoteAddress = ws?.data?.remoteAddress || 'unknown'
  }

  /**
   * Sends data through the WebSocket connection
   * @param data - Data to send
   * @returns True if sent successfully
   * @public
   */
  send(data: string | Buffer): boolean {
    try {
      const r = this.ws.send(data)
      return r !== 0
    } catch {
      return false
    }
  }

  /**
   * Sends a WebSocket ping frame
   * @param data - Optional ping data
   * @returns True if sent successfully
   * @public
   */
  ping(data?: string | Buffer): boolean {
    try {
      this.ws.ping?.(data)
      return true
    } catch {
      return false
    }
  }

  /**
   * Closes the connection.
   *
   * - `1000` means "normal closure" **(default)**
   * - `1009` means a message was too big and was rejected
   * - `1011` means the server encountered an error
   * - `1012` means the server is restarting
   * - `1013` means the server is too busy or the client is rate-limited
   * - `4000` through `4999` are reserved for applications (you can use it!)
   *
   * To close the connection abruptly, use `terminate()`.
   *
   * @param code The close code to send
   * @param reason The close reason to send
   * @public
   */
  close(code?: number, reason?: string): void {
    this.ws.close(code, reason)
  }

  /**
   * Terminates the connection immediately
   * @public
   */
  terminate(): void {
    this.ws.close(1000, 'Terminated')
  }

  /**
   * Internal handler for received messages
   * @param message - Message data
   * @internal
   */
  _handleMessage(message: string | Buffer): void {
    this.emit('message', message)
  }

  /**
   * Internal handler for connection close events
   * @param code - Close code
   * @param reason - Close reason
   * @internal
   */
  _handleClose(code: number, reason: string): void {
    this.emit('close', code, reason)
  }
}

/**
 * Creates and configures Bun HTTP server with WebSocket support
 * @param context - Server context (NodelinkServer subset)
 * @param getRequestHandler - Lazy loader for the API request handler
 * @returns The created Bun server instance
 * @internal
 */
export function createBunServer(
  context: BunServerContext,
  getRequestHandler: () => Promise<RequestHandler>
): ReturnType<typeof Bun.serve> {
  const port = context.options.server.port
  const host = context.options.server.host || '0.0.0.0'
  const password = context.options.server.password

  logger(
    'warn',
    'Server',
    'Running with Bun.serve, remember this is experimental!'
  )

  const server = Bun.serve({
    port,
    hostname: host,
    maxRequestBodySize: 1024 * 1024 * 50,
    idleTimeout: 60,

    error(error) {
      logger(
        'error',
        'Server',
        `HTTP server error: ${error instanceof Error ? error.message : String(error)}`
      )
      return new Response('Internal Server Error', { status: 500 })
    },

    async fetch(req, server) {
      const url = new URL(req.url)
      const pathname = url.pathname.endsWith('/')
        ? url.pathname.slice(0, -1)
        : url.pathname

      if (pathname === '/v4/profiler/socket') {
        const remoteAddress = server.requestIP(req)?.address || 'unknown'
        const isInternal = /^(::1|localhost|127\.0\.0\.1)/.test(remoteAddress)
        const endpoint = context.options.cluster?.endpoint || {}
        const patchEnabled = endpoint.patchEnabled === true
        const allowExternalPatch = endpoint.allowExternalPatch === true
        const expectedCode =
          typeof endpoint.code === 'string' && endpoint.code.length > 0
            ? endpoint.code
            : 'CAPYBARA'
        const providedCode =
          url.searchParams.get('code') ||
          req.headers.get('x-nodelink-code') ||
          req.headers.get('x-worker-code')

        if (!patchEnabled) {
          return new Response('Profiler socket endpoint is disabled.', {
            status: 403,
            statusText: 'Forbidden'
          })
        }
        if (!allowExternalPatch && !isInternal) {
          return new Response('External profiler socket access is blocked.', {
            status: 403,
            statusText: 'Forbidden'
          })
        }
        if (!providedCode || providedCode !== expectedCode) {
          return new Response('Invalid or missing profiler code.', {
            status: 403,
            statusText: 'Forbidden'
          })
        }

        const success = server.upgrade(req, {
          data: {
            clientInfo: { name: 'ProfilerUI', version: '1' },
            sessionId: null,
            reqHeaders: Object.fromEntries(req.headers),
            remoteAddress,
            url: req.url,
            pathname,
            eventName: '/v4/profiler/socket',
            routeId: null
          }
        })

        if (success) return undefined
        return new Response('WebSocket upgrade failed', { status: 400 })
      }

      const voiceMatch = pathname.match(VOICE_PATH_RE)
      const liveMatch = pathname.match(LIVE_PATH_RE)
      const isMainWs = pathname === '/v4/websocket'

      if (isMainWs || voiceMatch || liveMatch) {
        const remoteAddress = server.requestIP(req)?.address || 'unknown'
        const clientAddress = `[External] (${remoteAddress})`

        const clientName = req.headers.get('client-name')
        const auth = req.headers.get('authorization')
        const userId = req.headers.get('user-id')
        let sessionId = req.headers.get('session-id')

        if (auth !== password) {
          logger(
            'warn',
            'Server',
            `Unauthorized connection attempt from ${clientAddress} - Invalid password provided: ${auth || 'None'}`
          )
          return new Response('Invalid password provided.', {
            status: 401,
            statusText: 'Unauthorized',
            headers: {
              'Nodelink-Api-Version': '4',
              IamNodelink: 'true'
            }
          })
        }

        if (!clientName) {
          logger('warn', 'Server', `Missing client-name from ${clientAddress}`)
          return new Response('Invalid or missing Client-Name header.', {
            status: 400,
            statusText: 'Bad Request',
            headers: {
              'Nodelink-Api-Version': '4',
              IamNodelink: 'true'
            }
          })
        }

        if (!userId || !verifyDiscordID(userId)) {
          logger('warn', 'Server', `Invalid user ID from ${clientAddress}`)
          return new Response('Invalid or missing User-Id header.', {
            status: 400,
            statusText: 'Bad Request',
            headers: {
              'Nodelink-Api-Version': '4',
              IamNodelink: 'true'
            }
          })
        }

        const clientInfo = parseClient(clientName) as ClientInfo | null
        if (!clientInfo) {
          logger('warn', 'Server', `Invalid client-name from ${clientAddress}`)
          return new Response('Invalid or missing Client-Name header.', {
            status: 400,
            statusText: 'Bad Request',
            headers: {
              'Nodelink-Api-Version': '4',
              IamNodelink: 'true'
            }
          })
        }

        let eventName = '/v4/websocket'
        let routeId: string | null = null
        if (voiceMatch) {
          if (!context.options.playback.voiceReceive?.enabled) {
            return new Response('Voice receive disabled.', {
              status: 404,
              statusText: 'Not Found',
              headers: {
                'Nodelink-Api-Version': '4',
                IamNodelink: 'true'
              }
            })
          }
          eventName = '/v4/websocket/voice'
          routeId = voiceMatch[1] ?? null
        } else if (liveMatch) {
          eventName = '/v4/websocket/youtube/live'
          routeId = liveMatch[1] ?? null
        }

        if (sessionId && !context.sessions.resumableSessions.has(sessionId)) {
          logger(
            'warn',
            'Server',
            `Session-ID provided by ${clientAddress} does not exist or is not resumable: ${sessionId}, creating a new session`
          )
          sessionId = null
        }

        const success = server.upgrade(req, {
          data: {
            clientInfo,
            sessionId,
            reqHeaders: Object.fromEntries(req.headers),
            remoteAddress,
            url: req.url,
            pathname,
            eventName,
            routeId
          }
        })

        if (success) return undefined
        return new Response('WebSocket upgrade failed', {
          status: 400,
          headers: {
            'Nodelink-Api-Version': '4',
            IamNodelink: 'true'
          }
        })
      }

      return new Promise((resolve) => {
        const dataListeners: Array<(data: Buffer) => void> = []
        const endListeners: Array<() => void> = []
        const errorListeners: Array<(err: Error) => void> = []
        let bodyTriggered = false

        const triggerBodyRead = () => {
          if (bodyTriggered) return
          bodyTriggered = true

          const hasBody =
            req.headers.get('content-length') ||
            req.headers.get('transfer-encoding')
          if (!hasBody && (req.method === 'GET' || req.method === 'HEAD')) {
            queueMicrotask(() => {
              for (const cb of endListeners) {
                try {
                  cb()
                } catch (e) {
                  logger(
                    'debug',
                    'Server',
                    `Bun reqShim end listener threw: ${(e as Error).message}`
                  )
                }
              }
            })
            return
          }

          req
            .arrayBuffer()
            .then((buf: ArrayBuffer) => {
              const chunk = Buffer.from(buf)
              if (chunk.length > 0) {
                for (const cb of dataListeners) {
                  try {
                    cb(chunk)
                  } catch (e) {
                    logger(
                      'debug',
                      'Server',
                      `Bun reqShim data listener threw: ${(e as Error).message}`
                    )
                  }
                }
              }
              for (const cb of endListeners) {
                try {
                  cb()
                } catch (e) {
                  logger(
                    'debug',
                    'Server',
                    `Bun reqShim end listener threw: ${(e as Error).message}`
                  )
                }
              }
            })
            .catch((err: unknown) => {
              const error = err instanceof Error ? err : new Error(String(err))
              if (errorListeners.length > 0) {
                for (const cb of errorListeners) {
                  try {
                    cb(error)
                  } catch {}
                }
              } else {
                logger(
                  'debug',
                  'Server',
                  `Bun request body read failed: ${error.message}`
                )
                for (const cb of endListeners) {
                  try {
                    cb()
                  } catch {}
                }
              }
            })
        }

        const reqShim: RequestShim = {
          method: req.method,
          url: url.pathname + url.search,
          headers: Object.fromEntries(req.headers),
          socket: { remoteAddress: server.requestIP(req)?.address },
          on: (event: string, cb: (data: Buffer) => void) => {
            if (event === 'data') {
              dataListeners.push(cb)
              triggerBodyRead()
            } else if (event === 'end') {
              endListeners.push(cb as unknown as () => void)
              triggerBodyRead()
            } else if (event === 'error') {
              errorListeners.push(cb as unknown as (err: Error) => void)
            }
          }
        }

        const resShim: ResponseShim = {
          _status: 200,
          _headers: {},
          _body: [],
          writeHead(
            status: number,
            headers?: Record<string, string | string[]>
          ) {
            this._status = status
            if (headers) Object.assign(this._headers, headers)
          },
          setHeader(name: string, value: string | string[]) {
            this._headers[name] = value
          },
          getHeader(name: string) {
            return this._headers[name] as string | string[] | undefined
          },
          end(data?: string | Buffer) {
            if (data) this._body.push(data)
            let finalBody: Buffer | string
            if (this._body.length === 0) {
              finalBody = ''
            } else if (
              this._body.length === 1 &&
              Buffer.isBuffer(this._body[0])
            ) {
              finalBody = this._body[0] as Buffer
            } else {
              finalBody = Buffer.concat(
                this._body.map((chunk) =>
                  Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
                )
              )
            }

            const headers = new Headers()
            for (const [key, value] of Object.entries(this._headers)) {
              if (Array.isArray(value)) {
                for (const v of value) headers.append(key, v)
              } else if (value !== undefined) {
                headers.set(key, String(value))
              }
            }

            const response = new Response(finalBody, {
              status: this._status,
              headers
            })
            resolve(response)
          },
          write(data: string | Buffer) {
            if (data) this._body.push(data)
          }
        }

        void getRequestHandler()
          .then((handler) =>
            handler(
              context as unknown as import('../typings/api/api.types.ts').ApiNodelinkServer,
              reqShim as unknown as RequestShim,
              resShim
            )
          )
          .catch((error: Error) => {
            logger(
              'error',
              'Server',
              `Failed to handle Bun request: ${error.message}`
            )
            if (!resShim._status || resShim._status < 400) {
              resShim.writeHead(500, { 'Content-Type': 'text/plain' })
            }
            resShim.end('Internal Server Error')
          })
      })
    },

    websocket: {
      sendPings: true,
      idleTimeout: 120,
      maxPayloadLength: 1024 * 1024 * 16,
      data: {} as BunSocketData,
      open(ws) {
        if (!ws.data) {
          try {
            ws.close(1011, 'Missing socket data')
          } catch {}
          return
        }
        const wrapper = new BunSocketWrapper(ws)
        ws.data.wrapper = wrapper

        const {
          clientInfo,
          sessionId,
          reqHeaders,
          pathname,
          eventName,
          routeId
        } = ws.data

        const reqShim: ReqShim = {
          headers: reqHeaders as Record<string, string | string[]>,
          url: ws.data.url,
          socket: { remoteAddress: ws.data.remoteAddress }
        }

        if (pathname === '/v4/profiler/socket') {
          logger(
            'info',
            'ProfilerSocket',
            `Profiler socket connected from [External] (${ws.data.remoteAddress})`
          )
          context.socket?.emit(
            '/v4/profiler/socket',
            wrapper,
            reqShim,
            null,
            null
          )
          return
        }

        logger(
          'info',
          'Server',
          `\x1b[36m${clientInfo.name}\x1b[0m${
            clientInfo.version ? `/\x1b[32mv${clientInfo.version}\x1b[0m` : ''
          } connected from [External] (${ws.data.remoteAddress}) | \x1b[33mURL:\x1b[0m ${ws.data.url}`
        )

        if (context.socket) {
          context.socket.emit(
            eventName ?? '/v4/websocket',
            wrapper,
            reqShim,
            clientInfo,
            sessionId,
            routeId ?? null
          )
        }
      },
      message(ws: ServerWebSocket<BunSocketData>, message: string | Buffer) {
        const wrapper = ws.data?.wrapper
        if (!wrapper) {
          logger(
            'debug',
            'WebSocket',
            `Bun message received without wrapper (remote: ${ws.data?.remoteAddress || 'unknown'})`
          )
          return
        }
        wrapper._handleMessage(message)
      },
      close(ws: ServerWebSocket<BunSocketData>, code: number, reason: string) {
        const wrapper = ws.data?.wrapper
        if (!wrapper) {
          logger(
            'debug',
            'WebSocket',
            `Bun close received without wrapper (code: ${code}, remote: ${ws.data?.remoteAddress || 'unknown'})`
          )
          return
        }
        wrapper._handleClose(code, reason)
      },
      // `error` is documented in Bun.serve docs but missing from
      // bun-types@1.3.14 typings; cast keeps runtime behaviour while
      // satisfying the type checker.
      ...({
        error(ws: ServerWebSocket<BunSocketData>, err: Error) {
          logger(
            'error',
            'WebSocket',
            `Bun WebSocket error from ${ws.data?.remoteAddress || 'unknown'}: ${err.message}`
          )
          const wrapper = ws.data?.wrapper
          if (wrapper && wrapper.listenerCount('error') > 0) {
            try {
              wrapper.emit('error', err)
            } catch {}
          }
        }
      } as Record<string, unknown>)
    }
  })

  logger(
    'started',
    'Server',
    `Successfully listening on ${host}:${port} (Bun Native)`
  )

  return server
}

/**
 * Cleans up Bun WebSocket server resources
 * @param context - Server context
 * @param server - The Bun server instance to clean up
 * @internal
 */
export async function cleanupBunServer(
  context: BunServerContext,
  server: { stop: (force?: boolean) => Promise<void>; unref: () => void }
): Promise<void> {
  try {
    logger('info', 'WebSocket', 'Stopping Bun server...')

    // Gracefully close every active session with the same code Node uses,
    // so clients see a clean 1000 close frame and reconnect normally.
    // Without this, Bun.stop(true) tears TCP connections down without
    // sending close frames, surfacing as ECONNRESET on the client.
    let closedCount = 0
    for (const session of context.sessions.activeSessions.values()) {
      if (!session.socket) continue
      try {
        session.socket.close(1000, 'Server shutdown')
        closedCount++
      } catch (_e) {
        try {
          ;(session.socket as SessionSocket).destroy?.()
        } catch (_destroyErr) {
          logger(
            'debug',
            'WebSocket',
            `Failed to close/destroy socket for session ${session.id}`
          )
        }
      }
    }
    context.sessions.activeSessions.clear()
    context.sessions.resumableSessions.clear()
    logger(
      'info',
      'WebSocket',
      `Signalled close to ${closedCount} WebSocket connection(s)`
    )

    // Prefer graceful stop so the close frames above flush. If clients
    // don't drain within 1.5s (slow networks, half-open peers), fall
    // back to force-stop so shutdown still completes promptly.
    await new Promise<void>((resolveStop) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolveStop()
      }

      const forceTimer = setTimeout(() => {
        server.stop(true).then(finish, finish)
      }, 1500)

      server.stop(false).then(
        () => {
          clearTimeout(forceTimer)
          finish()
        },
        () => {
          clearTimeout(forceTimer)
          server.stop(true).then(finish, finish)
        }
      )
    })

    try {
      server.unref()
    } catch {}
    logger('info', 'WebSocket', 'Bun server stopped successfully')
  } catch (e) {
    const error = e as Error
    logger(
      'error',
      'WebSocket',
      `Error stopping Bun server: ${error?.message ?? String(e)}`
    )
  }
}
