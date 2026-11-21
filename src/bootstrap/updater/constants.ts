import path from 'node:path'
import type { UpdateChannel } from '../../typings/updater.types.ts'

export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = 'dev'

export const UPDATER_DIRECTORY = '.nodelink'

export const UPDATER_PATHS = {
  root: UPDATER_DIRECTORY,
  state: path.join(UPDATER_DIRECTORY, 'state.json'),
  lock: path.join(UPDATER_DIRECTORY, 'updater.lock'),
  updates: path.join(UPDATER_DIRECTORY, 'updates'),
  download: path.join(UPDATER_DIRECTORY, 'updates', 'download'),
  staging: path.join(UPDATER_DIRECTORY, 'updates', 'staging'),
  backup: path.join(UPDATER_DIRECTORY, 'updates', 'backup'),
  releases: path.join(UPDATER_DIRECTORY, 'releases')
} as const

export const PRESERVED_PATHS = Object.freeze([
  'config.ts',
  '.env',
  'plugins',
  'logs',
  '.nodelink'
] as const)

export const GITHUB_REPOSITORY = 'PerformanC/NodeLink'

export const GITHUB_API = 'https://api.github.com'

export const GITHUB_RAW_BASE = `https://raw.githubusercontent.com/${GITHUB_REPOSITORY}`

export const GITHUB_ARCHIVE_BASE = `https://github.com/${GITHUB_REPOSITORY}/archive`

export const MANIFEST_FILE_NAME = 'manifest.json'

export const USER_AGENT = 'NodeLink'

export const DEFAULT_DOWNLOAD_TIMEOUT = 5 * 60 * 1000

export const DEFAULT_MAX_DOWNLOAD_SIZE = 512 * 1024 * 1024

export const BOOT_HEALTHCHECK_TIMEOUT_MS = 8000

export const MAX_PROCESS_WAIT_TIMEOUT_MS = 10000

export const MAX_CONSECUTIVE_CRASHES = 3

export const RAPID_CRASH_THRESHOLD_MS = 15000
