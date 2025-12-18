import cluster from 'node:cluster'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import WebSocketServer from '@performanc/pwsl-server'

import requestHandler from './api/index.js'
import connectionManager from './managers/connectionManager.js'
import lyricsManager from './managers/lyricsManager.js'
import routePlannerManager from './managers/routePlannerManager.js'
import sessionManager from './managers/sessionManager.js'
import sourceManager from './managers/sourceManager.js'
import statsManager from './managers/statsManager.js'
import OAuth from './sources/youtube/OAuth.js'
import {
  checkForUpdates,
  cleanupHttpAgents,
  cleanupLogger,
  getGitInfo,
  getStats,
  getVersion,
  initLogger,
  logger,
  parseClient,
  validateProperty,
  verifyDiscordID,
  applyEnvOverrides
} from './utils.js'
import 'dotenv/config'
import { GatewayEvents } from './constants.js'
import DosProtectionManager from './managers/dosProtectionManager.js'
import PlayerManager from './managers/playerManager.js'
import RateLimitManager from './managers/rateLimitManager.js'

let config

try {
  config = (await import('../config.js')).default
} catch (e) {
  if (e.code === 'ERR_MODULE_NOT_FOUND') {
    try {
      config = (await import('../config.default.js')).default
      console.log(
        '[WARN] Config: config.js not found, using config.default.js. It is recommended to create a config.js file for your own configuration.'
      )
    } catch (e2) {
      console.error(
        '[ERROR] Config: Failed to load config.default.js. Please make sure it exists.'
      )
      throw e2
    }
  } else {
    throw e
  }
}

// Apply environment variable overrides after config is loaded
applyEnvOverrides(config);

const clusterEnabled =
  process.env.CLUSTER_ENABLED?.toLowerCase() === 'true' ||
  (typeof config.cluster?.enabled === 'boolean' && config.cluster.enabled) ||
  false

let configuredWorkers = 0
if (process.env.CLUSTER_WORKERS)
  configuredWorkers = Number(process.env.CLUSTER_WORKERS)
else if (typeof config.cluster?.workers === 'number')
  configuredWorkers = config.cluster.workers

initLogger(config)

const isBun = typeof Bun !== 'undefined'

if (!cluster.isWorker) {
  const ascii = `
   ▄   ████▄ ██▄   ▄███▄   █    ▄█    ▄   █  █▀
    █  █   █ █  █  █▀   ▀  █    ██     █  █▄█
██   █ █   █ █   █ ██▄▄    █    ██ ██   █ █▀▄   ${clusterEnabled ? 'Cluster Mode' : 'Single Process'}
█ █  █ ▀████ █  █  █▄   ▄▀ ███▄ ▐█ █ █  █ █  █  v${getVersion()}
█  █ █       ███▀  ▀███▀       ▀ ▐ █  █ █   █   Powered by PerformanC;
█   ██                             █   ██  ▀    rewritten by 1Lucas1.apk;
`
  process.stdout.write(`\x1b[32m${ascii}\x1b[0m\n`)
}

await checkForUpdates()

class BunSocketWrapper extends EventEmitter {
  constructor(ws) {
    super()
    this.ws = ws
    this.remoteAddress = ws.remoteAddress
    this.readyState = ws.readyState
  }

  send(data) {
    return this.ws.send(data) > 0
  }

  close(code, reason) {
    this.ws.close(code, reason)
  }

  terminate() {
    this.ws.close(1000, 'Terminated')
  }

  _handleMessage(message) {
    this.emit('message', message)
  }

  _handleClose(code, reason) {
    this.emit('close', code, reason)
  }
}

class NodelinkServer {
  constructor(options, PlayerManagerClass, isClusterPrimary = false) {
    if (!options || Object.keys(options).length === 0)
      throw new Error('Configuration file not found or empty')
    this.options = options
    this.server = null
    this.socket = null
    this.sessions = new sessionManager(this, PlayerManagerClass)
    if (!isClusterPrimary) {
      this.sources = new sourceManager(this)
      this.lyrics = new lyricsManager(this)
    } else {
      this.sources = null
      this.lyrics = null
    }
    this.routePlanner = new routePlannerManager(this)
    this.connectionManager = new connectionManager(this)
    this.statsManager = new statsManager(this)
    this.rateLimitManager = new RateLimitManager(this)
    this.dosProtectionManager = new DosProtectionManager(this)
    this.version = getVersion()
    this.gitInfo = getGitInfo()
    this.statistics = {
      players: 0,
      playingPlayers: 0
    }
    this._globalUpdater = null
    this.supportedSourcesCache = null

    if (isBun) {
      this.socket = new EventEmitter()
    } else {
      this.socket = new WebSocketServer({ noServer: true })
    }

    logger('info', 'Server', `version ${this.version}`)
    logger(
      'info',
      'Server',
      `git branch: ${this.gitInfo.branch}, commit: ${this.gitInfo.commit}, committed on: ${new Date(this.gitInfo.commitTime).toISOString()}`
    )
  }

  async getSourcesFromWorker() {
    if (!this.workerManager) {
      return []
    }
    const worker = this.workerManager.getBestWorker()
    if (!worker) {
      logger('warn', 'Server', 'No worker available to get sources from.')
      return []
    }
    const sources = await this.workerManager.execute(worker, 'getSources', {})
    return sources
  }

  _validateConfig() {
    validateProperty({
      value: this.options.server.port,
      path: 'server.port',
      expected: 'number (1–65535)',
      validator: (value) => typeof value === 'number'
    })

    validateProperty({
      value: this.options.server.host,
      path: 'server.host',
      expected: 'string',
      validator: (value) => typeof value === 'string'
    })

  }

  _setupSocketEvents() {
    this.socket.on('error', (error) => {
      logger('error', 'WebSocket', `WebSocket server error: ${error.message}`)
    })

    this.socket.on(
      '/v4/websocket',
      (socket, request, clientInfo, oldSessionId) => {
        logger(
          'debug',
          'Resume',
          `Processing websocket connection. oldSessionId: ${oldSessionId}`
        )
        if (oldSessionId) {
          const session = this.sessions.resume(oldSessionId, socket)

          if (session) {
            logger(
              'info',
              'Server',
              `\x1b[36m${clientInfo.name}\x1b[0m/\x1b[32mv${clientInfo.version}\x1b[0m resumed session with ID: ${oldSessionId}`
            )
            this.statsManager.incrementSessionResume(clientInfo.name, true)
            socket.send(
              JSON.stringify({
                op: 'ready',
                resumed: true,
                sessionId: oldSessionId
              })
            )

            while (session.eventQueue.length > 0) {
              const event = session.eventQueue.shift()
              socket.send(event)
            }

            for (const [
              playerKey,
              playerInfo
            ] of session.players.players.entries()) {
              if (this.workerManager) {
                const worker = this.workerManager.getWorkerForGuild(playerKey)
                if (worker) {
                  this.workerManager.execute(worker, 'playerCommand', {
                    sessionId: session.id,
                    guildId: playerInfo.guildId,
                    command: 'forceUpdate',
                    args: []
                  })
                }
              } else {
                playerInfo._sendUpdate()
              }
            }
          }
        } else {
          const sessionId = this.sessions.create(request, socket, clientInfo)

          const sessionCount = this.sessions.activeSessions?.size || 0
          this.statsManager.setWebsocketConnections(sessionCount)

          socket.on('close', (code, reason) => {
            if (!this.sessions.has(sessionId)) return

            const session = this.sessions.get(sessionId)
            if (!session) return

            logger(
              'info',
              'Server',
              `\x1b[36m${clientInfo.name}\x1b[0m/\x1b[32mv${clientInfo.version}\x1b[0m disconnected with code ${code} and reason: ${reason || 'without reason'
              }`
            )

            if (session.resuming) {
              this.sessions.pause(sessionId)
            } else {
              this.sessions.shutdown(sessionId)
            }

            const sessionCount = this.sessions.activeSessions?.size || 0
            this.statsManager.setWebsocketConnections(sessionCount)
          })

          socket.send(
            JSON.stringify({
              op: 'ready',
              resumed: false,
              sessionId
            })
          )
        }
      }
    )
  }

  _createBunServer() {
    const port = this.options.server.port
    const host = this.options.server.host || '0.0.0.0'
    const password = this.options.server.password
    const useBun = this.options.server.useBunServer || false

    if (!useBun) {
      logger(
        'warn',
        'Server',
        'Bun.serve usage is disabled in config, using standard Node.js HTTP server instead.'
      )
      return
    }
    logger(
      'warn',
      'Server',
      `Running with Bun.serve, remember this is experimental!`
    )
    const self = this

    this.server = Bun.serve({
      port,
      hostname: host,
      maxRequestBodySize: 1024 * 1024 * 50,

      async fetch(req, server) {
        const url = new URL(req.url)
        const path = url.pathname.endsWith('/')
          ? url.pathname.slice(0, -1)
          : url.pathname

        if (path === '/v4/websocket') {
          const remoteAddress = server.requestIP(req)?.address || 'unknown'
          const clientAddress = `[External] (${remoteAddress})`

          const clientName = req.headers.get('client-name')
          const auth = req.headers.get('authorization')
          const userId = req.headers.get('user-id')
          const sessionId = req.headers.get('session-id')

          if (auth !== password) {
            logger(
              'warn',
              'Server',
              `Unauthorized connection attempt from ${clientAddress} - Invalid Password`
            )
            return new Response(null, {
              status: 401,
              statusText: 'Unauthorized'
            })
          }

          if (!clientName) {
            logger(
              'warn',
              'Server',
              `Missing client-name from ${clientAddress}`
            )
            return new Response(null, {
              status: 400,
              statusText: 'Bad Request'
            })
          }

          if (!userId || !verifyDiscordID(userId)) {
            logger('warn', 'Server', `Invalid user ID from ${clientAddress}`)
            return new Response(null, {
              status: 400,
              statusText: 'Bad Request'
            })
          }

          const clientInfo = parseClient(clientName)

          const success = server.upgrade(req, {
            data: {
              clientInfo,
              sessionId,
              reqHeaders: Object.fromEntries(req.headers),
              remoteAddress,
              url: req.url
            }
          })

          if (success) {
            return undefined
          }

          return new Response('WebSocket upgrade failed', { status: 400 })
        }

        return new Promise((resolve) => {
          const reqShim = {
            method: req.method,
            url: url.pathname + url.search,
            headers: Object.fromEntries(req.headers),
            socket: { remoteAddress: server.requestIP(req)?.address },
            on: (event, cb) => {
              if (event === 'data') {
                req
                  .arrayBuffer()
                  .then((buf) => {
                    cb(Buffer.from(buf))
                    if (reqShim._endCb) reqShim._endCb()
                  })
                  .catch(() => { })
              }
              if (event === 'end') reqShim._endCb = cb
            }
          }

          const resShim = {
            _status: 200,
            _headers: {},
            _body: [],
            writeHead(status, headers) {
              this._status = status
              if (headers) Object.assign(this._headers, headers)
            },
            setHeader(name, value) {
              this._headers[name] = value
            },
            getHeader(name) {
              return this._headers[name]
            },
            end(data) {
              if (data) this._body.push(data)
              const finalBody = Buffer.concat(
                this._body.map((chunk) =>
                  Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
                )
              )

              const response = new Response(finalBody, {
                status: this._status,
                headers: this._headers
              })
              resolve(response)
            },
            write(data) {
              if (data) this._body.push(data)
            }
          }

          requestHandler(self, reqShim, resShim)
        })
      },

      websocket: {
        open(ws) {
          const wrapper = new BunSocketWrapper(ws)
          ws.data.wrapper = wrapper

          const { clientInfo, sessionId, reqHeaders } = ws.data

          const reqShim = {
            headers: reqHeaders,
            url: ws.data.url,
            socket: { remoteAddress: ws.data.remoteAddress }
          }

          logger(
            'info',
            'Server',
            `\x1b[36m${clientInfo.name}\x1b[0m/\x1b[32mv${clientInfo.version}\x1b[0m connected from [External] (${ws.data.remoteAddress}) | \x1b[33mURL:\x1b[0m ${ws.data.url}`
          )

          self.socket.emit(
            '/v4/websocket',
            wrapper,
            reqShim,
            clientInfo,
            sessionId
          )
        },
        message(ws, message) {
          if (ws.data.wrapper) {
            ws.data.wrapper._handleMessage(message)
          }
        },
        close(ws, code, reason) {
          if (ws.data.wrapper) {
            ws.data.wrapper._handleClose(code, reason)
          }
        }
      }
    })

    logger(
      'started',
      'Server',
      `Successfully listening on ${host}:${port} (Bun Native)`
    )
  }

  _createServer() {
    if (isBun) {
      this._createBunServer()
      return
    }

    this.server = http.createServer((req, res) =>
      requestHandler(this, req, res)
    )

    this.server.on('upgrade', (request, socket, head) => {
      const { remoteAddress, remotePort } = request.socket
      const isInternal =
        /^(::1|localhost|127\.0\.0\.1)/.test(remoteAddress) ||
        /^::ffff:127\.0\.0\.1/.test(remoteAddress)
      const clientAddress = `${isInternal ? '[Internal]' : '[External]'} (${remoteAddress}:${remotePort})`

      const originalHeaders = request.headers
      const headers = {}
      for (const key in originalHeaders) {
        headers[key.toLowerCase()] = originalHeaders[key]
      }

      logger(
        'debug',
        'Resume',
        `Received headers (lowercased): ${JSON.stringify(headers)}`
      )

      if (headers.authorization !== this.options.server.password) {
        logger(
          'warn',
          'Server',
          `Unauthorized connection attempt from ${clientAddress} - Invalid password provided`
        )
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        return socket.destroy()
      }
      const clientInfo = parseClient(headers['client-name'])
      if (!clientInfo) {
        logger(
          'warn',
          'Server',
          `Unauthorized connection attempt from ${clientAddress} - Invalid client-name provided`
        )
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
        return socket.destroy()
      }

      let sessionId = headers['session-id']
      logger('debug', 'Resume', `Received session-id header: ${sessionId}`)
      if (sessionId && !this.sessions.resumableSessions.has(sessionId)) {
        logger(
          'warn',
          'Server',
          `Session-ID provided by ${clientAddress} does not exist or is not resumable: ${sessionId}, creating a new session`
        )
        sessionId = undefined
      }

      const { pathname } = new URL(
        request.url,
        `http://${request.headers.host}`
      )
      if (pathname === '/v4/websocket') {
        if (!headers['user-id']) {
          logger(
            'warn',
            'Server',
            `Unauthorized connection attempt from ${clientAddress} - Missing user ID`
          )
          socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
          return socket.destroy()
        }
        if (!verifyDiscordID(headers['user-id'])) {
          logger(
            'warn',
            'Server',
            `Unauthorized connection attempt from ${clientAddress} - Invalid user ID provided`
          )
          socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
          return socket.destroy()
        }
        request.headers = headers

        logger(
          'info',
          'Server',
          `\x1b[36m${clientInfo.name}\x1b[0m/\x1b[32mv${clientInfo.version}\x1b[0m connected from ${clientAddress} | \x1b[33mURL:\x1b[0m ${request.url}`
        )

        this.socket.handleUpgrade(request, socket, head, {}, (ws) =>
          this.socket.emit('/v4/websocket', ws, request, clientInfo, sessionId)
        )
      } else {
        logger(
          'warn',
          'Server',
          `Unauthorized connection attempt from ${clientAddress} - Invalid path provided`
        )
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
        return socket.destroy()
      }
    })
  }

  _listen() {
    if (isBun) return

    const port = this.options.server.port
    const host = this.options.server.host || '0.0.0.0'

    logger(
      'info',
      'Server',
      `Attempting to listen on host: ${host}, port: ${port}`
    )

    this.server.on('error', (err) => {
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
          'Please check your `host` configuration. Use "0.0.0.0" to listen on all available interfaces.'
        )
      } else {
        logger('error', 'Server', `Failed to start server: ${err.message}`)
      }
      process.exit(1)
    })

    this.server.listen(port, host, () => {
      logger(
        'started',
        'Server',
        `Successfully listening on host ${host}, port ${port}`
      )
    })
  }
  _startGlobalUpdater() {
    if (this._globalUpdater) return
    const updateInterval = Math.max(
      1,
      this.options?.playerUpdateInterval ?? 5000
    )
    const zombieThreshold = this.options?.zombieThresholdMs ?? 60000

    this._globalUpdater = setInterval(() => {
      let localPlayers = 0
      let localPlayingPlayers = 0
      let voiceConnections = 0
      for (const session of this.sessions.values()) {
        if (!session.players) continue
        for (const player of session.players.players.values()) {
          localPlayers++
          if (!player.isPaused && player.track) {
            localPlayingPlayers++
          }
          if (player.connection) {
            voiceConnections++
          }
        }
      }

      this.statsManager.setVoiceConnections(voiceConnections)

      if (clusterEnabled && cluster.isWorker) {
        process.send({
          type: 'workerStats',
          stats: {
            players: localPlayers,
            playingPlayers: localPlayingPlayers
          }
        })
      } else if (!clusterEnabled) {
        // In single-process mode, update the server's own statistics
        this.statistics.players = localPlayers
        this.statistics.playingPlayers = localPlayingPlayers
      }

      const stats = getStats(this)
      const workerMetrics = this.workerManager ? this.workerManager.getWorkerMetrics() : null
      this.statsManager.updateStatsMetrics(stats, workerMetrics)
      const statsPayload = JSON.stringify({ op: 'stats', ...stats })

      for (const session of this.sessions.values()) {
        if (session.socket) {
          session.socket.send(statsPayload)
        }

        for (const player of session.players.players.values()) {
          if (player?.track && !player.isPaused && player.connection) {
            if (
              player._lastStreamDataTime > 0 &&
              Date.now() - player._lastStreamDataTime >= zombieThreshold
            ) {
              logger(
                'warn',
                'Player',
                `Player for guild ${player.guildId} detected as zombie (no stream data).`
              )
              player.emitEvent(GatewayEvents.TRACK_STUCK, {
                guildId: player.guildId,
                track: player.track,
                reason: 'no_stream_data',
                thresholdMs: zombieThreshold
              })
            }
            player._sendUpdate()
          }
        }
      }
    }, updateInterval)
  }
  _stopGlobalPlayerUpdater() {
    if (this._globalUpdater) {
      clearInterval(this._globalUpdater)
      this._globalUpdater = null
    }
  }

  _cleanupWebSocketServer() {
    if (isBun && this.server) {
      this.server.stop()
      logger('info', 'WebSocket', 'Bun server stopped successfully')
      return
    }

    if (this.socket) {
      try {
        this.socket.close()
        logger('info', 'WebSocket', 'WebSocket server closed successfully')
      } catch (error) {
        logger(
          'error',
          'WebSocket',
          `Error closing WebSocket server: ${error.message}`
        )
      }
    }
  }

  handleIPCMessage(msg) {
    if (msg.type === 'playerEvent') {
      const { sessionId, data } = msg.payload
      const session = this.sessions.get(sessionId)
      session?.socket?.send(data)
    } else if (msg.type === 'workerStats') {
      if (this.workerManager) {
        const worker = this.workerManager.workers.find(
          (w) => w.process.pid === msg.pid
        )
        if (worker) {
          this.workerManager.workerLoad.set(worker.id, msg.stats.players)
        }
      }
    } else if (msg.type === 'workerFailed') {
      const { workerId, affectedGuilds } = msg.payload
      logger(
        'warn',
        'Cluster',
        `Worker ${workerId} failed. Notifying clients for affected players: ${affectedGuilds.join(', ')}`
      )

      const sessionsToNotify = new Map()

      for (const playerKey of affectedGuilds) {
        const [sessionId, guildId] = playerKey.split(':')
        if (!sessionsToNotify.has(sessionId)) {
          sessionsToNotify.set(sessionId, new Set())
        }
        sessionsToNotify.get(sessionId).add(guildId)
      }

      for (const [sessionId, guildsInSession] of sessionsToNotify.entries()) {
        const session = this.sessions.get(sessionId)
        if (session?.socket) {
          session.socket.send(
            JSON.stringify({
              op: 'event',
              type: 'WorkerFailedEvent',
              affectedGuilds: Array.from(guildsInSession),
              message: `Players for guilds ${Array.from(guildsInSession).join(', ')} lost due to worker failure.`
            })
          )
        }
      }
    }
  }

  async start(startOptions = {}) {
    this._validateConfig()

    await this.statsManager.initialize()

    if (this.options.sources.youtube?.getOAuthToken) {
      logger(
        'info',
        'OAuth',
        'Starting YouTube OAuth token acquisition process...'
      )
      try {
        await OAuth.acquireRefreshToken()
        logger(
          'info',
          'OAuth',
          'YouTube OAuth token acquisition completed. Please update your config.js with the refresh token and set sources.youtube.getOAuthToken to false.'
        )
        process.exit(0)
      } catch (error) {
        logger(
          'error',
          'OAuth',
          `YouTube OAuth token acquisition failed: ${error.message}`
        )
        process.exit(1)
      }
    }

    if (!startOptions.isClusterPrimary) {
      await this.sources.loadFolder()

      await this.lyrics.loadFolder()
    }

    this._setupSocketEvents()

    this._createServer()

    if (startOptions.isClusterWorker) {
      logger(
        'info',
        'Server',
        'Running as cluster worker — waiting for sockets from master.'
      )
      process.on('message', (msg, handle) => {
        if (!msg || msg.type !== 'sticky-session') return
        if (!handle) return
        try {
          try {
            handle.pause?.()
          } catch (e) { }
          this.server.emit('connection', handle)
        } catch (err) {
          logger(
            'error',
            'Server',
            `Failed to inject socket from master: ${err?.message ?? err}`
          )
          try {
            handle.destroy?.()
          } catch (e) { }
        }
      })
    } else {
      if (!isBun) this._listen()
    }

    if (startOptions.isClusterPrimary) {
      this._startMasterMetricsUpdater()
    } else {
      this._startGlobalUpdater()
    }
    this.connectionManager.start()
    return this
  }

  _startMasterMetricsUpdater() {
    if (this._globalUpdater) return
    const updateInterval = Math.max(
      1,
      this.options?.playerUpdateInterval ?? 5000
    )

    this._globalUpdater = setInterval(() => {
      const stats = getStats(this)
      const workerMetrics = this.workerManager ? this.workerManager.getWorkerMetrics() : null
      this.statsManager.updateStatsMetrics(stats, workerMetrics)

      const sessionCount = this.sessions.activeSessions?.size || 0
      this.statsManager.setWebsocketConnections(sessionCount)
    }, updateInterval)
  }
}

import WorkerManager from './managers/workerManager.js'

if (clusterEnabled && cluster.isPrimary) {
  const workerManager = new WorkerManager(config)

  const serverInstancePromise = (async () => {
    const nserver = new NodelinkServer(config, PlayerManager, true)
    nserver.workerManager = workerManager

    await nserver.start({ isClusterPrimary: true })
    global.nodelink = nserver

    process.on('beforeExit', () => {
      workerManager.destroy()
      nserver._cleanupWebSocketServer()
      cleanupHttpAgents()
      cleanupLogger()
      nserver.rateLimitManager.destroy()
      nserver.dosProtectionManager.destroy()
    })

    return nserver
  })()

  await serverInstancePromise
} else if (clusterEnabled && cluster.isWorker) {
  await import('./worker.js')
} else {
  const serverInstancePromise = (async () => {
    const nserver = new NodelinkServer(config, PlayerManager, false)
    await nserver.start()
    global.nodelink = nserver

    logger(
      'info',
      'Server',
      `Single-process server running (PID ${process.pid})`
    )

    process.on('beforeExit', () => {
      nserver._cleanupWebSocketServer()
      cleanupHttpAgents()
      cleanupLogger()
      nserver.rateLimitManager.destroy()
      nserver.dosProtectionManager.destroy()
    })

    return nserver
  })()

  await serverInstancePromise
}
