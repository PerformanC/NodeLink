import { spawn } from 'node:child_process';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { logger } from '../../utils.js';
import { DEFAULT_UPDATE_CHANNEL, MANIFEST_FILE_NAME, UPDATER_PATHS } from './constants.js';
import { drainAndShutdown } from './drain.js';
import { ArchiveExtractor } from './extractor.js';
import { parseUpdateManifest } from './manifest.js';
import { DockerProvider } from './providers/dockerProvider.js';
import { GitProvider } from './providers/gitProvider.js';
import { HttpProvider } from './providers/httpProvider.js';
import { UpdateStateStore } from './state.js';
export class UpdateManager {
    root;
    stateStore;
    providers;
    extractor = new ArchiveExtractor();
    constructor(root) {
        this.root = root;
        this.stateStore = new UpdateStateStore(root);
        this.providers = Object.freeze([
            new DockerProvider(),
            new GitProvider(root),
            new HttpProvider()
        ]);
    }
    async selectProvider() {
        for (const provider of this.providers) {
            if (await provider.isAvailable()) {
                return provider;
            }
        }
        throw new Error('No update provider available for this environment');
    }
    async isLocked() {
        const lockPath = path.join(this.root, UPDATER_PATHS.lock);
        try {
            const content = await readFile(lockPath, 'utf8');
            const lockData = JSON.parse(content);
            const age = Date.now() - (lockData.timestamp ?? 0);
            if (age < 10 * 60 * 1000) {
                return true;
            }
            await unlink(lockPath).catch((err) => {
                logger('debug', 'UpdateManager', `Failed to remove stale lockfile: ${err instanceof Error ? err.message : String(err)}`);
            });
            return false;
        }
        catch (error) {
            if (error.code !== 'ENOENT') {
                logger('debug', 'UpdateManager', `Lockfile read error: ${error instanceof Error ? error.message : String(error)}`);
            }
            return false;
        }
    }
    async acquireLock() {
        if (await this.isLocked()) {
            return false;
        }
        const lockPath = path.join(this.root, UPDATER_PATHS.lock);
        try {
            await writeFile(lockPath, JSON.stringify({ pid: process.pid, timestamp: Date.now() }), 'utf8');
            return true;
        }
        catch (error) {
            logger('warn', 'UpdateManager', `Failed to write lockfile: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }
    async releaseLock() {
        const lockPath = path.join(this.root, UPDATER_PATHS.lock);
        await unlink(lockPath).catch((error) => {
            if (error.code !== 'ENOENT') {
                logger('debug', 'UpdateManager', `Failed to delete lockfile: ${error instanceof Error ? error.message : String(error)}`);
            }
        });
    }
    async getCurrentState(fallbackVersion, fallbackCommit = 'unknown', channel = DEFAULT_UPDATE_CHANNEL) {
        const savedState = await this.stateStore.read();
        if (savedState) {
            return savedState;
        }
        return {
            version: fallbackVersion,
            commit: fallbackCommit,
            channel,
            updatedAt: new Date().toISOString()
        };
    }
    async getLocalManifestCommit() {
        const manifestPath = path.join(this.root, MANIFEST_FILE_NAME);
        try {
            const content = await readFile(manifestPath, 'utf8');
            const parsed = parseUpdateManifest(JSON.parse(content));
            return parsed?.commit ?? null;
        }
        catch (error) {
            if (error.code !== 'ENOENT') {
                logger('debug', 'UpdateManager', `Could not read local manifest: ${error instanceof Error ? error.message : String(error)}`);
            }
            return null;
        }
    }
    async check(fallbackVersion, fallbackCommit = 'unknown', channel = DEFAULT_UPDATE_CHANNEL) {
        const current = await this.getCurrentState(fallbackVersion, fallbackCommit, channel);
        if (await this.stateStore.checkCrashLoop()) {
            return {
                available: false,
                current,
                provider: 'http',
                reason: 'Auto-update suspended due to rapid boot crash loop detection'
            };
        }
        if (await this.isLocked()) {
            return {
                available: false,
                current,
                provider: 'http',
                reason: 'Update operation currently locked by another process'
            };
        }
        const provider = await this.selectProvider();
        if (provider.type === 'docker') {
            return {
                available: false,
                current,
                provider: provider.type,
                reason: 'Running inside Docker container. Updates must be applied by updating the container image.'
            };
        }
        const latest = await provider.getLatest(channel);
        if (!latest) {
            return {
                available: false,
                current,
                provider: provider.type,
                reason: 'Unable to fetch latest release metadata'
            };
        }
        const quarantined = current.quarantinedCommits?.[latest.commit];
        if (quarantined) {
            logger('warn', 'UpdateManager', `Ignoring commit ${latest.commit.slice(0, 7)}: quarantined on ${quarantined.failedAt} (${quarantined.reason})`);
            return {
                available: false,
                current,
                latest,
                provider: provider.type,
                reason: `Commit ${latest.commit.slice(0, 7)} is quarantined due to startup failure`
            };
        }
        if (provider.type === 'git') {
            const isClean = await provider.isWorkingTreeClean();
            if (!isClean) {
                logger('warn', 'UpdateManager', 'Local modifications detected in tracked files. Skipping automatic update.');
                return {
                    available: false,
                    current,
                    latest,
                    provider: provider.type,
                    reason: 'Tracked files have uncommitted local modifications'
                };
            }
        }
        const localManifestCommit = await this.getLocalManifestCommit();
        if (localManifestCommit && localManifestCommit === latest.commit) {
            if (current.commit !== latest.commit) {
                await this.stateStore.write({
                    ...current,
                    commit: latest.commit,
                    version: latest.version
                });
            }
            return {
                available: false,
                current: { ...current, commit: latest.commit, version: latest.version },
                latest,
                provider: provider.type,
                reason: 'Local installation is already running the latest commit'
            };
        }
        const available = latest.commit !== current.commit &&
            current.commit !== 'unknown' &&
            latest.commit.length > 0;
        return {
            available,
            current,
            latest,
            provider: provider.type
        };
    }
    async download(manifest, destination) {
        const provider = await this.selectProvider();
        return provider.download(manifest, destination);
    }
    async applyUpdate(manifest, server, drainTimeout = 2000) {
        const acquired = await this.acquireLock();
        if (!acquired) {
            logger('warn', 'UpdateManager', 'Update locked by another running task, aborting');
            return false;
        }
        try {
            const downloadDir = path.join(this.root, UPDATER_PATHS.download);
            await mkdir(downloadDir, { recursive: true });
            const archivePath = path.join(downloadDir, `${manifest.commit}.tar.gz`);
            logger('info', 'UpdateManager', `Downloading update package for ${manifest.commit.slice(0, 7)}...`);
            await this.download(manifest, archivePath);
            const stagingDir = path.join(this.root, UPDATER_PATHS.staging, manifest.commit);
            logger('info', 'UpdateManager', 'Unpacking update archive to staging...');
            await this.extractor.extract(archivePath, stagingDir);
            if (server) {
                await drainAndShutdown(server, 'Server restarting for update', drainTimeout);
            }
            const backupDir = path.join(this.root, UPDATER_PATHS.backup);
            const workerPath = path.join(this.root, 'src', 'bootstrap', 'updater', 'updater-worker.ts');
            logger('info', 'UpdateManager', 'Spawning detached update-worker...');
            const child = spawn(process.execPath, [
                '--dns-result-order=ipv4first',
                '--experimental-strip-types',
                workerPath,
                `--root=${this.root}`,
                `--staging=${stagingDir}`,
                `--backup=${backupDir}`,
                `--parent-pid=${process.pid}`,
                `--target-commit=${manifest.commit}`,
                `--target-version=${manifest.version}`,
                `--channel=${manifest.channel}`
            ], {
                cwd: this.root,
                stdio: 'inherit',
                detached: true
            });
            child.unref();
            process.exit(0);
        }
        catch (error) {
            await this.releaseLock();
            logger('error', 'UpdateManager', `Failed to execute update pipeline: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }
    async saveState(state) {
        await this.stateStore.write(state);
    }
    async quarantine(commit, reason) {
        await this.stateStore.quarantineCommit(commit, reason);
    }
}
