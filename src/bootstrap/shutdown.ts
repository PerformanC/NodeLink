import type http from 'node:http'
import process from 'node:process'

import type NodelinkServer from '../index.ts'
import { cleanupHttpAgents, cleanupLogger, logger } from '../utils.ts'
import { printShutdownMessage } from './branding.ts'

function setupGracefulShutdown(nserver: NodelinkServer): void {
  let isShuttingDown = false

  const shutdown = async (): Promise<void> => {
    if (isShuttingDown) return
    isShuttingDown = true

    if (nserver.workerManager) {
      nserver.workerManager.isDestroying = true
    }

    nserver.emit('shutdown')
    printShutdownMessage()

    logger('info', 'Server', 'Shutdown signal received. Releasing resources...')

    nserver._stopHeartbeat()

    await nserver.credentialManager?.forceSave()
    await nserver.trackCacheManager?.forceSave()

    nserver.sourceWorkerManager?.destroy()
    nserver.workerManager?.destroy()
    nserver.connectionManager?.destroy()
    nserver.proxyManager?.destroy()
    nserver.routePlanner?.dispose()
    nserver.credentialManager?.destroy()
    nserver.trackCacheManager?.destroy()

    await nserver._cleanupWebSocketServer()

    const httpServer = nserver.server as http.Server | undefined
    if (httpServer?.listening) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
      logger('info', 'Server', 'HTTP server closed.')
    }

    cleanupHttpAgents()
    nserver.rateLimitManager.destroy()
    nserver.dosProtectionManager.destroy()
    cleanupLogger()

    process.exit(0)
  }

  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())
}

export { setupGracefulShutdown }
