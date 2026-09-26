import { execFile } from 'node:child_process'
import { access, mkdir, readdir, rename, rmdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ExtractResult } from '../../typings/updater.types.ts'
import { logger } from '../../utils.ts'

const execFileAsync = promisify(execFile)

export class ArchiveExtractor {
  public async extract(
    archivePath: string,
    stagingDir: string
  ): Promise<ExtractResult> {
    await mkdir(stagingDir, { recursive: true })

    try {
      await execFileAsync('tar', ['-xzf', archivePath, '-C', stagingDir])
    } catch (error) {
      logger(
        'error',
        'Extractor',
        `Failed to unpack tar archive: ${error instanceof Error ? error.message : String(error)}`
      )
      throw new Error(
        `Failed to extract archive: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    await this.flattenSingleSubdirectory(stagingDir)

    const hasPackageJson = await this.pathExists(
      path.join(stagingDir, 'package.json')
    )
    const hasSourceEntry =
      (await this.pathExists(path.join(stagingDir, 'src', 'index.ts'))) ||
      (await this.pathExists(path.join(stagingDir, 'dist', 'src', 'index.js')))

    if (!hasPackageJson || !hasSourceEntry) {
      throw new Error(
        `Staged archive is invalid or incomplete (package.json: ${hasPackageJson}, sourceEntry: ${hasSourceEntry})`
      )
    }

    return {
      stagingDir,
      hasPackageJson,
      hasSourceEntry
    }
  }

  private async flattenSingleSubdirectory(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    const isSingleDir = entries.length === 1 && entries[0]?.isDirectory()

    if (!isSingleDir) {
      return
    }

    const subDirName = entries[0]?.name
    if (!subDirName) return

    const subDirPath = path.join(dir, subDirName)
    const subEntries = await readdir(subDirPath)

    for (const entry of subEntries) {
      await rename(path.join(subDirPath, entry), path.join(dir, entry))
    }

    await rmdir(subDirPath).catch((error) => {
      logger(
        'debug',
        'Extractor',
        `Failed to remove extracted directory wrapper: ${error instanceof Error ? error.message : String(error)}`
      )
    })
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await access(targetPath)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger(
          'debug',
          'Extractor',
          `Path access error for ${targetPath}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      return false
    }
  }
}
