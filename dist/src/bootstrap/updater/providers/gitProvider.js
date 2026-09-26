import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { logger } from '../../../utils.js';
const execFileAsync = promisify(execFile);
export class GitProvider {
    type = 'git';
    root;
    constructor(root) {
        this.root = root;
    }
    async git(...args) {
        const { stdout } = await execFileAsync('git', args, {
            cwd: this.root,
            encoding: 'utf8'
        });
        return stdout.trim();
    }
    async isAvailable() {
        try {
            await access(path.join(this.root, '.git'));
            await this.git('--version');
            return true;
        }
        catch (error) {
            logger('debug', 'GitProvider', `Git provider unavailable: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }
    async isWorkingTreeClean() {
        try {
            const status = await this.git('status', '--porcelain', '-uno');
            return status.length === 0;
        }
        catch (error) {
            logger('warn', 'GitProvider', `Failed to check working tree cleanliness: ${error instanceof Error ? error.message : String(error)}`);
            return true;
        }
    }
    async resolveRemoteAndBranch(channel) {
        try {
            const upstream = await this.git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
            const separator = upstream.indexOf('/');
            if (separator !== -1) {
                return {
                    remote: upstream.slice(0, separator),
                    branch: upstream.slice(separator + 1)
                };
            }
        }
        catch (error) {
            logger('debug', 'GitProvider', `Could not resolve git upstream: ${error instanceof Error ? error.message : String(error)}`);
        }
        const branch = channel === 'stable' ? 'v3' : 'dev';
        return { remote: 'origin', branch };
    }
    async getLatest(channel) {
        try {
            const { remote, branch } = await this.resolveRemoteAndBranch(channel);
            await this.git('fetch', '--quiet', remote, branch);
            const commit = await this.git('rev-parse', 'FETCH_HEAD');
            let version = 'unknown';
            try {
                const packageJsonRaw = await this.git('show', 'FETCH_HEAD:package.json');
                const packageData = JSON.parse(packageJsonRaw);
                if (typeof packageData.version === 'string') {
                    version = packageData.version;
                }
            }
            catch (error) {
                logger('warn', 'GitProvider', `Failed to read package.json at FETCH_HEAD: ${error instanceof Error ? error.message : String(error)}`);
            }
            return {
                channel,
                version,
                commit,
                url: `git://${remote}/${branch}`
            };
        }
        catch (error) {
            logger('error', 'GitProvider', `Failed to get latest git revision: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }
    async download(manifest, destination) {
        await this.git('archive', '--format=tar.gz', `--output=${destination}`, manifest.commit);
        const hash = createHash('sha256');
        const fileStream = createReadStream(destination);
        for await (const chunk of fileStream) {
            hash.update(chunk);
        }
        const sha256 = hash.digest('hex');
        const fileStat = await stat(destination);
        return {
            path: destination,
            sha256,
            size: fileStat.size
        };
    }
}
