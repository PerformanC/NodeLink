import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../../utils.js';
import { PRESERVED_PATHS } from './constants.js';
export class FileSwapper {
    root;
    constructor(root) {
        this.root = root;
    }
    isPreserved(relativePath) {
        const normalized = relativePath.split(path.sep).join('/');
        const baseName = normalized.split('/')[0] ?? '';
        if (PRESERVED_PATHS.includes(baseName)) {
            return true;
        }
        if (baseName === 'node_modules' || baseName === '.git') {
            return true;
        }
        return false;
    }
    async createBackup(backupDir) {
        await rm(backupDir, { recursive: true, force: true }).catch((error) => {
            if (error.code !== 'ENOENT') {
                logger('debug', 'Swapper', `Could not clear previous backup directory: ${error instanceof Error ? error.message : String(error)}`);
            }
        });
        await mkdir(backupDir, { recursive: true });
        const targets = [
            'src',
            'dist',
            'package.json',
            'package-lock.json',
            'manifest.json'
        ];
        for (const target of targets) {
            const sourcePath = path.join(this.root, target);
            const targetBackupPath = path.join(backupDir, target);
            try {
                await cp(sourcePath, targetBackupPath, {
                    recursive: true,
                    force: true
                });
            }
            catch (error) {
                if (error.code !== 'ENOENT') {
                    logger('warn', 'Swapper', `Failed to backup ${target}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        }
    }
    async restoreBackup(backupDir) {
        logger('warn', 'Swapper', 'Rolling back files from backup directory...');
        await cp(backupDir, this.root, {
            recursive: true,
            force: true
        });
        logger('info', 'Swapper', 'Rollback completed successfully.');
    }
    async applyStaging(stagingDir) {
        await cp(stagingDir, this.root, {
            recursive: true,
            force: true,
            filter: (sourcePath) => {
                const relative = path.relative(stagingDir, sourcePath);
                if (!relative)
                    return true;
                return !this.isPreserved(relative);
            }
        });
    }
    async checkDependenciesChanged(stagingDir) {
        try {
            const currentPkgPath = path.join(this.root, 'package.json');
            const stagedPkgPath = path.join(stagingDir, 'package.json');
            const [currentRaw, stagedRaw] = await Promise.all([
                readFile(currentPkgPath, 'utf8'),
                readFile(stagedPkgPath, 'utf8')
            ]);
            const currentPkg = JSON.parse(currentRaw);
            const stagedPkg = JSON.parse(stagedRaw);
            const hashCurrent = createHash('sha256')
                .update(JSON.stringify(currentPkg.dependencies ?? {}))
                .digest('hex');
            const hashStaged = createHash('sha256')
                .update(JSON.stringify(stagedPkg.dependencies ?? {}))
                .digest('hex');
            return hashCurrent !== hashStaged;
        }
        catch (error) {
            logger('warn', 'Swapper', `Failed to diff package.json dependencies: ${error instanceof Error ? error.message : String(error)}`);
            return true;
        }
    }
}
