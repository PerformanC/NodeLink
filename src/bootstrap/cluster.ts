import type http from 'node:http'
import process from 'node:process'

import { GatewayEvents } from '../constants.ts'
import type CredentialManager from '../managers/credentialManager.ts'
import type SessionManager from '../managers/sessionManager.ts'
import type { NodelinkConfig } from '../typings/config/config.types.ts'
import type { NodelinkServerType } from '../typings/index.types.ts'
import type { IPCMessage } from '../typings/shared.types.ts'
import type { YouTubeOAuthRuntime } from '../typings/sources/youtubeClient.types.ts'
import { logger } from '../utils.ts'

const BENIGN_DISCONNECT_CODES = new Set([
  'EPIPE',
  'ECONNRESET',
  'ERR_STREAM_PREMATURE_CLOSE'
])

function setupProcessGuards(): void {
  process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
    const isBenign =
      (err?.code && BENIGN_DISCONNECT_CODES.has(err.code)) ||
      err?.message === 'aborted'

    if (isBenign) {
      logger(
        'debug',
        'Server',
        `Ignored expected client disconnect: ${err.code ?? err.message}`
      )
      return
    }

    logger('error', 'Server', `Uncaught Exception: ${err.stack || err.message}`)
    process.stderr.write('', () => process.exit(1))
  })

  process.on('unhandledRejection', (reason, promise) => {
    logger(
      'error',
      'Server',
      `Unhandled Promise Rejection at: ${promise}, reason: ${reason}`
    )
  })
}

function setupClusterWorkerSocket(server: NodelinkServerType): void {
  logger(
    'info',
    'Server',
    'Running as cluster worker — waiting for sockets from master.'
  )

  process.on(
    'message',
    (
      msg: IPCMessage | { type: string },
      handle: { pause?: () => void; destroy?: () => void } | null
    ) => {
      if (msg?.type !== 'sticky-session' || !handle) return
      try {
        try {
          handle.pause?.()
        } catch {}
        ;(server as http.Server).emit('connection', handle)
      } catch (err) {
        const error = err as Error
        logger(
          'error',
          'Server',
          `Failed to inject socket from master: ${error.message}`
        )
        try {
          handle.destroy?.()
        } catch {}
      }
    }
  )
}

function _groupAffectedGuilds(affectedGuilds: string[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>()

  for (const playerKey of affectedGuilds) {
    const [sessionId, guildId] = playerKey.split(':')
    if (!sessionId || !guildId) continue

    const guilds = grouped.get(sessionId)
    if (guilds) {
      guilds.push(guildId)
    } else {
      grouped.set(sessionId, [guildId])
    }
  }

  return grouped
}

function broadcastWorkerFailure(
  sessions: SessionManager,
  workerId: number,
  affectedGuilds: string[]
): void {
  logger(
    'warn',
    'Cluster',
    `Worker ${workerId} failed. Notifying affected guilds: ${affectedGuilds.join(', ')}`
  )

  for (const [sessionId, guilds] of _groupAffectedGuilds(affectedGuilds)) {
    const socket = sessions.get(sessionId)?.socket
    if (!socket) continue

    socket.send(
      JSON.stringify({
        op: 'event',
        type: 'WorkerFailedEvent',
        affectedGuilds: guilds,
        message: `Players for guilds ${guilds.join(', ')} lost due to worker failure.`
      })
    )

    for (const guildId of guilds) {
      socket.send(
        JSON.stringify({
          op: 'event',
          type: GatewayEvents.WEBSOCKET_CLOSED,
          guildId,
          code: 5001,
          reason: 'worker_failed',
          byRemote: false
        })
      )
    }
  }
}

async function handleYouTubeOAuthCLI(
  config: NodelinkConfig,
  getCredentialManagerClass: () => Promise<typeof CredentialManager>
): Promise<void> {
  const OAuth = (
    await import('../sources/youtube/OAuth.ts').catch((e: Error) => {
      logger(
        'error',
        'youtube',
        `OAuth module could not be loaded: ${e.message}`
      )
      process.exit(1)
    })
  ).default

  const CredentialManagerClass = await getCredentialManagerClass()
  const credentialManager = new CredentialManagerClass({ options: config })

  const oauthRuntime: YouTubeOAuthRuntime = {
    options: config,
    credentialManager
  }

  const validator = new OAuth(oauthRuntime)
  await validator.validateCurrentTokens()

  try {
    await OAuth.acquireRefreshToken()
    process.exit(0)
  } catch (error) {
    const err = error as Error
    logger(
      'error',
      'OAuth',
      `YouTube OAuth token acquisition failed: ${err.message}`
    )
    process.exit(1)
  }
}

export {
  broadcastWorkerFailure,
  handleYouTubeOAuthCLI,
  setupClusterWorkerSocket,
  setupProcessGuards
}
