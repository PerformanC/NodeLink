import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { logger } from '../../utils.ts'
import { PRESERVED_PATHS } from './constants.ts'

export class FileSwapper {
  private readonly root: string

  public constructor(root: string) {
    this.root = root
  }

  private isPreserved(relativePath: string): boolean {
    const normalized = relativePath.split(path.sep).join('/')
    const baseName = normalized.split('/')[0] ?? ''

    if (
      PRESERVED_PATHS.includes(baseName as (typeof PRESERVED_PATHS)[number])
    ) {
      return true
    }

    if (baseName === 'node_modules' || baseName === '.git') {
      return true
    }

    return false
  }

  public async createBackup(backupDir: string): Promise<void> {
    await rm(backupDir, { recursive: true, force: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger(
          'debug',
          'Swapper',
          `Could not clear previous backup directory: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    })
    await mkdir(backupDir, { recursive: true })

    const targets = [
      'src',
      'dist',
      'package.json',
      'package-lock.json',
      'manifest.json'
    ]

    for (const target of targets) {
      const sourcePath = path.join(this.root, target)
      const targetBackupPath = path.join(backupDir, target)
      try {
        await cp(sourcePath, targetBackupPath, {
          recursive: true,
          force: true
        })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger(
            'warn',
            'Swapper',
            `Failed to backup ${target}: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    }
  }

  public async restoreBackup(backupDir: string): Promise<void> {
    logger('warn', 'Swapper', 'Rolling back files from backup directory...')
    await cp(backupDir, this.root, {
      recursive: true,
      force: true
    })
    logger('info', 'Swapper', 'Rollback completed successfully.')
  }

  public async applyStaging(stagingDir: string): Promise<void> {
    await cp(stagingDir, this.root, {
      recursive: true,
      force: true,
      filter: (sourcePath: string) => {
        const relative = path.relative(stagingDir, sourcePath)
        if (!relative) return true
        return !this.isPreserved(relative)
      }
    })
  }

  public async checkDependenciesChanged(stagingDir: string): Promise<boolean> {
    try {
      const currentPkgPath = path.join(this.root, 'package.json')
      const stagedPkgPath = path.join(stagingDir, 'package.json')

      const [currentRaw, stagedRaw] = await Promise.all([
        readFile(currentPkgPath, 'utf8'),
        readFile(stagedPkgPath, 'utf8')
      ])

      const currentPkg = JSON.parse(currentRaw) as {
        dependencies?: Record<string, string>
      }
      const stagedPkg = JSON.parse(stagedRaw) as {
        dependencies?: Record<string, string>
      }

      const hashCurrent = createHash('sha256')
        .update(JSON.stringify(currentPkg.dependencies ?? {}))
        .digest('hex')
      const hashStaged = createHash('sha256')
        .update(JSON.stringify(stagedPkg.dependencies ?? {}))
        .digest('hex')

      return hashCurrent !== hashStaged
    } catch (error) {
      logger(
        'warn',
        'Swapper',
        `Failed to diff package.json dependencies: ${error instanceof Error ? error.message : String(error)}`
      )
      return true
    }
  }
}
