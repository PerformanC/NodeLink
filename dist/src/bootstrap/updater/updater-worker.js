import { execFile, spawn } from 'node:child_process';
import { access, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { logger } from '../../utils.js';
import { BOOT_HEALTHCHECK_TIMEOUT_MS, MAX_PROCESS_WAIT_TIMEOUT_MS } from './constants.js';
import { installDependencies } from './packageHelper.js';
import { UpdateStateStore } from './state.js';
import { FileSwapper } from './swapper.js';
const execFileAsync = promisify(execFile);
function parseCliArgs() {
    const args = process.argv.slice(2);
    const argMap = {};
    for (const arg of args) {
        if (arg.startsWith('--')) {
            const [key, value] = arg.slice(2).split('=');
            if (key && value) {
                argMap[key] = value;
            }
        }
    }
    const root = argMap.root ?? process.cwd();
    const stagingDir = argMap.staging ?? '';
    const backupDir = argMap.backup ?? '';
    const parentPid = Number(argMap['parent-pid'] ?? 0);
    const targetCommit = argMap['target-commit'] ?? '';
    const targetVersion = argMap['target-version'] ?? '';
    const channel = argMap.channel ?? 'dev';
    if (!stagingDir || !backupDir || !targetCommit) {
        throw new Error('Missing required arguments for updater-worker');
    }
    return {
        root,
        stagingDir,
        backupDir,
        parentPid,
        targetCommit,
        targetVersion,
        channel
    };
}
async function waitForParentProcessToExit(pid) {
    if (pid <= 0)
        return;
    const startTime = Date.now();
    while (Date.now() - startTime < MAX_PROCESS_WAIT_TIMEOUT_MS) {
        try {
            process.kill(pid, 0);
            await sleep(250);
        }
        catch (error) {
            logger('debug', 'UpdaterWorker', `Parent process ${pid} confirmed exited: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
    }
    try {
        process.kill(pid, 'SIGKILL');
    }
    catch (error) {
        logger('debug', 'UpdaterWorker', `Process ${pid} termination signal completed: ${error instanceof Error ? error.message : String(error)}`);
    }
}
async function runWorker() {
    const { root, stagingDir, backupDir, parentPid, targetCommit, targetVersion, channel } = parseCliArgs();
    const stateStore = new UpdateStateStore(root);
    const swapper = new FileSwapper(root);
    logger('info', 'UpdaterWorker', `Starting update worker for ${targetCommit.slice(0, 7)}...`);
    logger('info', 'UpdaterWorker', `Waiting for parent PID ${parentPid} to terminate...`);
    await waitForParentProcessToExit(parentPid);
    logger('info', 'UpdaterWorker', 'Creating pre-update backup snapshot...');
    await swapper.createBackup(backupDir);
    const needInstall = await swapper.checkDependenciesChanged(stagingDir);
    logger('info', 'UpdaterWorker', 'Applying updated files from staging...');
    await swapper.applyStaging(stagingDir);
    if (needInstall) {
        logger('info', 'UpdaterWorker', 'Package dependencies changed. Installing...');
        try {
            await installDependencies(root);
        }
        catch (error) {
            logger('error', 'UpdaterWorker', `Dependency installation failed: ${error instanceof Error ? error.message : String(error)}. Initiating rollback...`);
            await swapper.restoreBackup(backupDir);
            await stateStore.quarantineCommit(targetCommit, 'Dependency install failed');
            spawnServer(root);
            process.exit(1);
        }
    }
    logger('info', 'UpdaterWorker', 'Starting NodeLink and verifying boot health...');
    const child = spawnServer(root);
    let hasExited = false;
    let exitCode = null;
    child.on('exit', (code) => {
        hasExited = true;
        exitCode = code;
    });
    await sleep(BOOT_HEALTHCHECK_TIMEOUT_MS);
    if (hasExited && exitCode !== 0) {
        logger('error', 'UpdaterWorker', `New version crashed with exit code ${exitCode}. Executing automatic rollback!`);
        await swapper.restoreBackup(backupDir);
        await stateStore.quarantineCommit(targetCommit, `Process exited with code ${exitCode} during boot health check`);
        logger('info', 'UpdaterWorker', 'Restarting restored previous version...');
        spawnServer(root);
        process.exit(1);
    }
    logger('info', 'UpdaterWorker', 'Boot health check passed. Finalizing state...');
    const previousState = await stateStore.read();
    await stateStore.write({
        version: targetVersion || (previousState?.version ?? 'unknown'),
        commit: targetCommit,
        channel,
        updatedAt: new Date().toISOString(),
        previousVersion: previousState?.version,
        previousCommit: previousState?.commit,
        quarantinedCommits: previousState?.quarantinedCommits ?? {},
        consecutiveCrashCount: 0,
        justUpdated: true
    });
    try {
        const gitDir = path.join(root, '.git');
        const hasGit = await access(gitDir)
            .then(() => true)
            .catch(() => false);
        if (hasGit) {
            await execFileAsync('git', ['reset', '--hard', targetCommit], {
                cwd: root
            });
        }
    }
    catch (error) {
        logger('warn', 'UpdaterWorker', `Could not sync git repository to ${targetCommit.slice(0, 7)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await rm(stagingDir, { recursive: true, force: true }).catch((error) => {
        logger('warn', 'UpdaterWorker', `Failed to clean staging directory: ${error instanceof Error ? error.message : String(error)}`);
    });
    await rm(backupDir, { recursive: true, force: true }).catch((error) => {
        logger('warn', 'UpdaterWorker', `Failed to clean backup directory: ${error instanceof Error ? error.message : String(error)}`);
    });
    logger('info', 'UpdaterWorker', 'Update process completed successfully!');
    process.exit(0);
}
function spawnServer(root) {
    const isExperimental = (process.versions.node.split('.').map(Number)[0] ?? 0) >= 22;
    const args = isExperimental
        ? [
            '--dns-result-order=ipv4first',
            '--experimental-strip-types',
            'src/index.ts'
        ]
        : ['--dns-result-order=ipv4first', 'dist/src/index.js'];
    const child = spawn(process.execPath, args, {
        cwd: root,
        stdio: 'inherit',
        env: process.env,
        detached: true
    });
    child.unref();
    return child;
}
runWorker().catch((error) => {
    logger('error', 'UpdaterWorker', `Fatal updater-worker error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});
