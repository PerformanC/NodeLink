import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { logger } from '../../../utils.js';
import { DEFAULT_DOWNLOAD_TIMEOUT, GITHUB_API, GITHUB_ARCHIVE_BASE, GITHUB_RAW_BASE, GITHUB_REPOSITORY, MANIFEST_FILE_NAME, USER_AGENT } from '../constants.js';
import { parseUpdateManifest } from '../manifest.js';
export class HttpProvider {
    type = 'http';
    timeout;
    constructor(timeout = DEFAULT_DOWNLOAD_TIMEOUT) {
        this.timeout = timeout;
    }
    async isAvailable() {
        return true;
    }
    async getLatest(channel) {
        const branch = channel === 'stable' ? 'v3' : 'dev';
        const manifestFromRepo = await this.fetchManifestFromRepo(branch);
        if (manifestFromRepo) {
            return manifestFromRepo;
        }
        return this.fetchLatestFromGithubApi(channel, branch);
    }
    async fetchManifestFromRepo(branch) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout);
        try {
            const response = await fetch(`${GITHUB_RAW_BASE}/${branch}/${MANIFEST_FILE_NAME}`, {
                signal: controller.signal,
                headers: {
                    'User-Agent': USER_AGENT
                }
            });
            if (!response.ok) {
                return null;
            }
            const raw = await response.json();
            return parseUpdateManifest(raw);
        }
        catch (error) {
            logger('debug', 'HttpProvider', `Remote manifest.json fetch failed: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
        finally {
            clearTimeout(timer);
        }
    }
    async fetchLatestFromGithubApi(channel, branch) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout);
        try {
            const commitPromise = fetch(`${GITHUB_API}/repos/${GITHUB_REPOSITORY}/commits/${branch}`, {
                signal: controller.signal,
                headers: {
                    'User-Agent': USER_AGENT,
                    Accept: 'application/vnd.github+json'
                }
            });
            const packageJsonPromise = fetch(`${GITHUB_RAW_BASE}/${branch}/package.json`, {
                signal: controller.signal,
                headers: {
                    'User-Agent': USER_AGENT
                }
            });
            const [commitRes, packageRes] = await Promise.all([
                commitPromise,
                packageJsonPromise
            ]);
            if (!commitRes.ok) {
                logger('warn', 'HttpProvider', `GitHub commits API returned HTTP ${commitRes.status}`);
                return null;
            }
            const commitData = (await commitRes.json());
            if (!commitData.sha) {
                logger('warn', 'HttpProvider', 'GitHub commits API returned missing commit SHA');
                return null;
            }
            let version = 'unknown';
            if (packageRes.ok) {
                try {
                    const packageData = (await packageRes.json());
                    if (typeof packageData.version === 'string') {
                        version = packageData.version;
                    }
                }
                catch (error) {
                    logger('debug', 'HttpProvider', `Failed to parse remote package.json: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            return {
                channel,
                version,
                commit: commitData.sha,
                url: `${GITHUB_ARCHIVE_BASE}/refs/heads/${branch}.tar.gz`
            };
        }
        catch (error) {
            logger('error', 'HttpProvider', `GitHub API fetch failed: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
        finally {
            clearTimeout(timer);
        }
    }
    async download(manifest, destination) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout);
        try {
            const response = await fetch(manifest.url, {
                signal: controller.signal,
                headers: {
                    'User-Agent': USER_AGENT
                }
            });
            if (!response.ok) {
                throw new Error(`Update download failed: HTTP ${response.status}`);
            }
            if (!response.body) {
                throw new Error('Update response has no readable body');
            }
            const hash = createHash('sha256');
            const output = createWriteStream(destination);
            const source = Readable.fromWeb(response.body);
            source.on('data', (chunk) => {
                hash.update(chunk);
            });
            await pipeline(source, output);
            const fileStat = await stat(destination);
            const sha256 = hash.digest('hex');
            if (manifest.sha256 && manifest.sha256 !== sha256) {
                throw new Error(`SHA-256 mismatch: expected ${manifest.sha256}, got ${sha256}`);
            }
            return {
                path: destination,
                sha256,
                size: fileStat.size
            };
        }
        finally {
            clearTimeout(timer);
        }
    }
}
