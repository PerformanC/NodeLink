import { setTimeout as sleep } from 'node:timers/promises'
import type NodelinkServer from '../../index.ts'
import { logger } from '../../utils.ts'

export async function drainAndShutdown(
  server?: NodelinkServer,
  reason = 'Server restarting for update',
  drainTimeout = 2000
): Promise<void> {
  if (!server) return

  const sessions = server.sessions?.activeSessions
  const count = sessions?.size ?? 0

  if (count > 0) {
    logger(
      'info',
      'Updater',
      `Gracefully disconnecting ${count} client session(s) with code 5002...`
    )
    for (const session of sessions.values()) {
      try {
        session.socket?.close(5002, reason)
      } catch (error) {
        logger(
          'warn',
          'Updater',
          `Error closing session socket: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
    await sleep(drainTimeout)
  }

  try {
    await server.stop()
  } catch (error) {
    logger(
      'warn',
      'Updater',
      `Error stopping server: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
