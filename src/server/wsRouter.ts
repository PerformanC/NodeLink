import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import type http from 'node:http'
import type { Socket as NetSocket } from 'node:net'
import { URL } from 'node:url'
import type WebSocketServer from '@performanc/pwsl-server'

import { attachProfilerSocket } from '../api/profiler.socket.ts'
import type NodelinkServer from '../index.ts'
import type { RequestShim, SessionSocket } from '../typings/index.types.ts'
import type { ClientInfo } from '../typings/shared.types.ts'
import { decodeTrack, logger, parseClient, verifyDiscordID } from '../utils.ts'
import { handleClientWebSocket } from './wsSession.ts'

const VOICE_PATH_RE = /^\/v4\/websocket\/voice\/([A-Za-z0-9]+)\/?$/
const LIVE_PATH_RE = /^\/v4\/websocket\/youtube\/live\/([^/]+)\/?$/
const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/

const INTERNAL_IPS = new Set([
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
  'localhost'
])

function _getHeader(
  headers: http.IncomingHttpHeaders,
  name: string
): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

function _isAuthorized(
  provided: string | undefined,
  expected: string
): boolean {
  if (!provided || expected.length === 0) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function _rejectUpgrade(
  socket: NetSocket,
  status: number,
  statusText: string,
  body: string
): void {
  if (socket.destroyed || !socket.writable) {
    try {
      socket.destroy()
    } catch {}
    return
  }

  const payload =
    `HTTP/1.1 ${status} ${statusText}\r\n` +
    'Nodelink-Api-Version: 4\r\n' +
    'IamNodelink: true\r\n' +
    'Content-Type: text/plain\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
    body

  socket.end(payload, () => {
    try {
      socket.destroy()
    } catch {}
  })
}

function handleHttpUpgrade(
  context: NodelinkServer,
  request: http.IncomingMessage,
  socket: NetSocket,
  head: Buffer
): void {
  socket.on('error', (err: NodeJS.ErrnoException) => {
    if (err?.code === 'EPIPE' || err?.code === 'ECONNRESET') return
    logger('debug', 'Server', `Upgrade socket error: ${err.message}`)
  })

  const remoteAddress = request.socket.remoteAddress || 'unknown'
  const remotePort = request.socket.remotePort || 0
  const isInternal = INTERNAL_IPS.has(remoteAddress)
  const clientAddress = `${isInternal ? '[Internal]' : '[External]'} (${remoteAddress}:${remotePort})`

  const url = new URL(request.url || '/', 'http://localhost')
  const pathname = url.pathname

  if (pathname === '/v4/profiler/socket') {
    _handleProfilerUpgrade(
      context,
      request,
      socket,
      head,
      clientAddress,
      isInternal
    )
    return
  }

  _handleGatewayUpgrade(context, request, socket, head, pathname, clientAddress)
}

function _handleProfilerUpgrade(
  context: NodelinkServer,
  request: http.IncomingMessage,
  socket: NetSocket,
  head: Buffer,
  clientAddress: string,
  isInternal: boolean
): void {
  const reject = (reason: string): void => {
    _rejectUpgrade(socket, 403, 'Forbidden', reason)
  }

  const url = new URL(request.url || '/', 'http://localhost')
  const endpoint = context.options.cluster?.endpoint || {}
  const patchEnabled = endpoint.patchEnabled === true
  const allowExternal = endpoint.allowExternalPatch === true
  const expectedCode = endpoint.code || 'CAPYBARA'

  const providedCode =
    url.searchParams.get('code') ||
    _getHeader(request.headers, 'x-nodelink-code') ||
    _getHeader(request.headers, 'x-worker-code')

  if (!patchEnabled) {
    reject('Profiler socket endpoint is disabled.')
    return
  }

  if (!allowExternal && !isInternal) {
    reject('External profiler socket access is blocked.')
    return
  }

  if (!_isAuthorized(providedCode, expectedCode)) {
    reject('Invalid or missing profiler authentication code.')
    return
  }

  logger(
    'info',
    'ProfilerSocket',
    `Profiler socket connected from ${clientAddress} | URL: ${request.url}`
  )

  const wsServer = context.socket as WebSocketServer
  wsServer?.handleUpgrade(request, socket, head, null, (ws) => {
    context.socket?.emit(
      '/v4/profiler/socket',
      ws as SessionSocket,
      request,
      { name: 'ProfilerUI', version: '1' },
      null,
      null
    )
  })
}

function _handleGatewayUpgrade(
  context: NodelinkServer,
  request: http.IncomingMessage,
  socket: NetSocket,
  head: Buffer,
  pathname: string,
  clientAddress: string
): void {
  const reject = (status: number, title: string, reason: string): void => {
    logger(
      'warn',
      'Server',
      `Connection from ${clientAddress} rejected: ${reason}`
    )
    _rejectUpgrade(socket, status, title, reason)
  }

  const authHeader = _getHeader(request.headers, 'authorization')
  if (!_isAuthorized(authHeader, context.options.server?.password ?? '')) {
    reject(401, 'Unauthorized', 'Invalid password provided.')
    return
  }

  const clientName = _getHeader(request.headers, 'client-name')
  const clientInfo = parseClient(clientName) as ClientInfo
  if (!clientInfo) {
    reject(400, 'Bad Request', 'Invalid or missing Client-Name header.')
    return
  }

  let sessionId = _getHeader(request.headers, 'session-id')
  if (sessionId && !context.sessions.isResumable(sessionId)) {
    logger(
      'warn',
      'Server',
      `Session-ID ${sessionId} from ${clientAddress} does not exist or expired. Creating new session.`
    )
    sessionId = undefined
  }

  const voiceMatch = pathname.match(VOICE_PATH_RE)
  const liveMatch = pathname.match(LIVE_PATH_RE)
  const isGateway =
    pathname === '/v4/websocket' || Boolean(voiceMatch) || Boolean(liveMatch)

  if (!isGateway) {
    reject(404, 'Not Found', 'Invalid path for WebSocket upgrade.')
    return
  }

  const userId = _getHeader(request.headers, 'user-id')
  if (!userId || !verifyDiscordID(userId)) {
    reject(400, 'Bad Request', 'Missing or invalid User-Id header.')
    return
  }

  if (voiceMatch && !context.options.playback.voiceReceive?.enabled) {
    reject(404, 'Not Found', 'Voice receive is disabled on this server.')
    return
  }

  const clientTag = `${clientInfo.name}${clientInfo.version ? ` v${clientInfo.version}` : ''}`
  logger('info', 'Server', `${clientTag} connected from ${clientAddress}`)

  let eventName = '/v4/websocket'
  let routeId: string | null = null

  if (voiceMatch) {
    eventName = '/v4/websocket/voice'
    routeId = voiceMatch[1] ?? null
  } else if (liveMatch) {
    eventName = '/v4/websocket/youtube/live'
    routeId = liveMatch[1] ?? null
  }

  const wsServer = context.socket as WebSocketServer
  wsServer?.handleUpgrade(request, socket, head, null, (ws) => {
    context.socket?.emit(
      eventName,
      ws as SessionSocket,
      request,
      clientInfo,
      sessionId,
      routeId
    )
  })
}

function setupWebSocketEvents(context: NodelinkServer): void {
  if (!context.socket) return

  context.socket.on('error', (error: Error) => {
    logger('error', 'WebSocket', `WebSocket server error: ${error.message}`)
  })

  context.socket.on(
    '/v4/websocket',
    (
      socket: SessionSocket,
      request: http.IncomingMessage,
      clientInfo: ClientInfo,
      sessionId?: string
    ) => {
      handleClientWebSocket(context, socket, request, clientInfo, sessionId)
    }
  )

  context.socket.on(
    '/v4/profiler/socket',
    (socket: SessionSocket, request: http.IncomingMessage) => {
      attachProfilerSocket(context, socket, request)
    }
  )

  context.socket.on(
    '/v4/websocket/voice',
    (
      socket: SessionSocket,
      _request: RequestShim,
      _client: ClientInfo,
      _sessionId: string,
      guildId: string
    ) => {
      logger('info', 'Voice', `Voice socket linked for guild ${guildId}`)
      context.voiceRouter.registerSocket(guildId, socket)
    }
  )

  context.socket.on(
    '/v4/websocket/youtube/live',
    (
      socket: SessionSocket,
      request: RequestShim,
      _client: ClientInfo,
      _sessionId: string,
      id: string
    ) => {
      const videoId = _resolveYouTubeVideoId(context, id)
      socket.guildId = id

      if (!context.sourceWorkerManager) {
        type YouTubeLiveChatSource = {
          handleLiveChat?: (ws: SessionSocket, videoId: string) => void
        }
        const yt = context.sources?.getSource('youtube') as
          | YouTubeLiveChatSource
          | undefined

        if (yt?.handleLiveChat) {
          yt.handleLiveChat(socket, videoId)
        } else {
          socket.close(1008, 'YouTube live chat not supported')
        }
        return
      }

      logger(
        'info',
        'YouTube-LiveChat',
        `Streaming live chat for video: ${videoId}`
      )
      const streamAdapter = new WebSocketStreamAdapter(socket)

      context.sourceWorkerManager.delegate(
        request,
        streamAdapter,
        'loadLiveChat',
        { videoId },
        { isWebSocket: true }
      )
    }
  )
}

function _resolveYouTubeVideoId(
  context: NodelinkServer,
  rawIdentifier: string
): string {
  if (DISCORD_SNOWFLAKE_RE.test(rawIdentifier)) {
    const player = context.sessions.getPlayer(rawIdentifier)
    if (player?.track?.info?.sourceName?.includes('youtube')) {
      return player.track.info.identifier
    }
  } else if (rawIdentifier.length > 50) {
    try {
      const decoded = decodeTrack(rawIdentifier)
      if (decoded?.info?.sourceName?.includes('youtube')) {
        return decoded.info.identifier
      }
    } catch {}
  }

  return rawIdentifier
}

class WebSocketStreamAdapter {
  headersSent = false
  private readonly socket: SessionSocket

  constructor(socket: SessionSocket) {
    this.socket = socket
  }

  writeHead(status: number): void {
    if (status !== 200) {
      this.socket.close(1011, 'Worker stream failed')
    }
  }

  write(data: string | Buffer): void {
    this._sendFrame(data)
  }

  send(data: string | Buffer): void {
    this._sendFrame(data)
  }

  end(): void {
    this.socket.close(1000, 'Stream finished')
  }

  on(event: string, cb: (...args: (string | Buffer | number)[]) => void): void {
    this.socket.on(event, cb)
  }

  private _sendFrame(data: string | Buffer): void {
    const isBinary = Buffer.isBuffer(data)
    const payload = isBinary ? data : Buffer.from(String(data))

    this.socket.sendFrame?.(payload, {
      len: payload.length,
      fin: true,
      opcode: isBinary ? 0x02 : 0x01
    })
  }
}

async function cleanupWebSocketServer(server: NodelinkServer): Promise<void> {
  if (!server.socket) return

  try {
    let closedCount = 0
    for (const session of server.sessions.values()) {
      const socket = session.socket
      if (!socket) continue

      try {
        socket.close(1000, 'Server shutdown')
        closedCount++
      } catch {
        try {
          socket.destroy?.()
        } catch {
          logger(
            'debug',
            'WebSocket',
            `Failed to close socket for session ${session.id}`
          )
        }
      }
    }

    server.sessions.clearSessions()
    logger(
      'info',
      'WebSocket',
      `Closed ${closedCount} WebSocket connection(s) successfully`
    )
  } catch (error) {
    const err = error as Error
    logger(
      'error',
      'WebSocket',
      `Error closing WebSocket connections: ${err.message}`
    )
  }
}

export { cleanupWebSocketServer, handleHttpUpgrade, setupWebSocketEvents }
