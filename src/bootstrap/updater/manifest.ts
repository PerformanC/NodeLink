import type { UpdateManifest } from '../../typings/updater.types.ts'
import { logger } from '../../utils.ts'

export function parseUpdateManifest(data: unknown): UpdateManifest | null {
  if (!data || typeof data !== 'object') {
    logger('debug', 'Manifest', 'Received non-object manifest payload')
    return null
  }

  const manifest = data as Partial<UpdateManifest>
  if (!manifest.version || !manifest.commit || !manifest.url) {
    logger(
      'debug',
      'Manifest',
      'Missing required version/commit/url fields in manifest'
    )
    return null
  }

  return {
    channel: manifest.channel === 'stable' ? 'stable' : 'dev',
    version: manifest.version,
    commit: manifest.commit,
    url: manifest.url,
    sha256: manifest.sha256,
    size: manifest.size,
    releaseDate: manifest.releaseDate ?? new Date().toISOString()
  }
}
