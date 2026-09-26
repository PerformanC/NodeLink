import { exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { logger } from '../../utils.js';
const execAsync = promisify(exec);
export async function installDependencies(root) {
    const isBun = Boolean(process.versions.bun) && existsSync(path.resolve(root, 'bun.lock'));
    const isPnpm = existsSync(path.resolve(root, 'pnpm-lock.yaml')) && !isBun;
    const command = isPnpm
        ? 'pnpm install'
        : isBun
            ? 'bun install'
            : 'npm install --omit=dev';
    logger('info', 'PackageHelper', `Installing dependencies using: ${command}`);
    try {
        await execAsync(command, { cwd: root });
        logger('info', 'PackageHelper', 'Dependencies installed successfully.');
    }
    catch (error) {
        logger('error', 'PackageHelper', `Dependency installation failed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
}
