import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
async function run() {
    const root = process.cwd();
    const pkgContent = await readFile(path.join(root, 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgContent);
    const version = pkg.version ?? '0.0.0-dev';
    let commit = 'unknown';
    let branch = 'dev';
    try {
        const { stdout: commitOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
        commit = commitOut.trim();
        const { stdout: branchOut } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' });
        branch = branchOut.trim() || 'dev';
    }
    catch (error) {
        console.warn(`[Updater] Failed to get git commit/branch: ${error instanceof Error ? error.message : String(error)}`);
    }
    const channel = branch === 'v3' ? 'stable' : 'dev';
    const manifest = {
        channel,
        version,
        commit,
        url: `https://github.com/PerformanC/NodeLink/archive/refs/heads/${branch}.tar.gz`,
        releaseDate: new Date().toISOString()
    };
    const destination = path.join(root, 'manifest.json');
    await writeFile(destination, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(`[Updater] Generated manifest.json for ${channel} (${version} @ ${commit.slice(0, 7)})`);
    try {
        await execFileAsync('git', ['add', 'manifest.json'], { cwd: root });
    }
    catch (error) {
        console.warn(`[Updater] Failed to stage manifest.json in git: ${error instanceof Error ? error.message : String(error)}`);
    }
}
run().catch((error) => {
    console.error('[Updater] Failed to generate manifest.json:', error);
    process.exit(1);
});
