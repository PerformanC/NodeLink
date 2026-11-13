import { access } from 'node:fs/promises'
import process from 'node:process'
import type {
  UpdateChannel,
  UpdateDownloadResult,
  UpdateManifest,
  UpdateProvider
} from '../../../typings/updater.types.ts'
import { logger } from '../../../utils.ts'

export class DockerProvider implements UpdateProvider {
  public readonly type = 'docker' as const

  public async isAvailable(): Promise<boolean> {
    if (process.env.DOCKER === 'true' || process.env.IS_DOCKER === 'true') {
      return true
    }

    try {
      await access('/.dockerenv')
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger(
          'debug',
          'DockerProvider',
          `Docker environment check failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      return false
    }
  }

  public async getLatest(
    _channel: UpdateChannel
  ): Promise<UpdateManifest | null> {
    return null
  }

  public async download(
    _manifest: UpdateManifest,
    _destination: string
  ): Promise<UpdateDownloadResult> {
    throw new Error(
      'Docker installations must be updated through the container image'
    )
  }
}
