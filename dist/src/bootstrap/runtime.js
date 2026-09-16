import process from 'node:process';
import { MINIMUM_NODE_VERSION } from '../constants.js';
import { logger } from '../utils.js';
const NODE_LTS_CREDENTIAL_KEY = 'runtime.node.latestLts';
const NODE_LTS_CREDENTIAL_TTL_MS = 24 * 60 * 60 * 1000;
const NODE_LTS_MEMORY_TTL_MS = 10 * 60 * 1000;
let latestNodeLtsCache = null;
function _parseVersionParts(version) {
    return version
        .replace(/^v/, '')
        .split('.')
        .map((part) => Number.parseInt(part, 10) || 0);
}
function _isVersionAtLeast(current, minimum) {
    const curParts = _parseVersionParts(current);
    const minParts = _parseVersionParts(minimum);
    const len = Math.max(curParts.length, minParts.length);
    for (let i = 0; i < len; i++) {
        const cur = curParts[i] ?? 0;
        const min = minParts[i] ?? 0;
        if (cur > min)
            return true;
        if (cur < min)
            return false;
    }
    return true;
}
const memoryTraceEnabled = process.env.NODELINK_MEMORY_TRACE?.toLowerCase() === 'true';
function memoryTrace(stage) {
    if (!memoryTraceEnabled)
        return;
    const m = process.memoryUsage();
    const toMB = (value) => (value / 1024 / 1024).toFixed(2);
    process.stdout.write(`[MEM] ${stage} rss=${toMB(m.rss)}MB heapUsed=${toMB(m.heapUsed)}MB heapTotal=${toMB(m.heapTotal)}MB external=${toMB(m.external)}MB\n`);
}
async function getLatestNodeLtsVersion(credentialManager) {
    const now = Date.now();
    if (latestNodeLtsCache && latestNodeLtsCache.expiresAt > now) {
        return latestNodeLtsCache.value;
    }
    const diskCache = credentialManager?.get(NODE_LTS_CREDENTIAL_KEY);
    if (diskCache?.version) {
        latestNodeLtsCache = {
            value: diskCache.version,
            expiresAt: now + NODE_LTS_MEMORY_TTL_MS
        };
        return diskCache.version;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
        const response = await fetch('https://nodejs.org/dist/index.json', {
            signal: controller.signal
        });
        if (!response.ok) {
            latestNodeLtsCache = { value: null, expiresAt: now + 10 * 60 * 1000 };
            return null;
        }
        const releases = (await response.json());
        const latestLts = releases.find((release) => release.version && release.lts);
        latestNodeLtsCache = {
            value: latestLts?.version ?? null,
            expiresAt: now + 60 * 60 * 1000
        };
        if (latestNodeLtsCache.value && credentialManager) {
            credentialManager.set(NODE_LTS_CREDENTIAL_KEY, {
                version: latestNodeLtsCache.value,
                fetchedAt: now
            }, NODE_LTS_CREDENTIAL_TTL_MS);
        }
        return latestNodeLtsCache.value;
    }
    catch (error) {
        logger('warn', 'Server', `Failed to fetch latest Node.js LTS version: ${error instanceof Error ? error.message : String(error)}`);
        latestNodeLtsCache = { value: null, expiresAt: now + 10 * 60 * 1000 };
        return null;
    }
    finally {
        clearTimeout(timeout);
    }
}
async function validateRuntime(credentialManager) {
    const isLts = Boolean(process.release?.lts);
    const isSupported = _isVersionAtLeast(process.version, MINIMUM_NODE_VERSION);
    const latestLts = await getLatestNodeLtsVersion(credentialManager);
    if (!isSupported) {
        throw new Error(`Unsupported Node.js runtime (${process.version}). Baseline is v${MINIMUM_NODE_VERSION}. Please update to Node.js LTS.`);
    }
    if (!isLts) {
        const isAboveOrAtLts = Boolean(latestLts && _isVersionAtLeast(process.version, latestLts));
        const targetLts = latestLts ?? 'unknown';
        const message = isAboveOrAtLts
            ? `Non-LTS preview runtime (${process.version}) >= latest LTS (${targetLts}). Behavior may vary.`
            : `Non-LTS runtime (${process.version}). Lower stability than LTS (${targetLts}).`;
        logger('warn', 'Server', message);
    }
    else if (latestLts && !_isVersionAtLeast(process.version, latestLts)) {
        logger('info', 'Server', `Runtime ${process.version} is supported, but below latest LTS (${latestLts}). Consider updating.`);
    }
}
export { _isVersionAtLeast, getLatestNodeLtsVersion, memoryTrace, validateRuntime };
