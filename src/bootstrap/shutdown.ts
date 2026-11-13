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

    await nserver.stop()

    cleanupHttpAgents()
    cleanupLogger()

    process.exit(0)
  }

  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())
}

export { setupGracefulShutdown }
