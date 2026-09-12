import { logger } from '../../utils.js';
const parsePositiveIntEnv = (key, fallback) => {
    const raw = process.env[key];
    if (!raw)
        return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const MAX_POOL_SIZE_BYTES = parsePositiveIntEnv('NODELINK_BUFFER_POOL_MAX_BYTES', 20 * 1024 * 1024 // 20 MB - reduced from 50MB
);
const MAX_BUCKET_ENTRIES = parsePositiveIntEnv('NODELINK_BUFFER_POOL_MAX_BUCKET_ENTRIES', 16 // hot frame sizes (3840/4000 -> 4096) need depth under many players; total still capped by MAX_POOL_SIZE_BYTES
);
const IDLE_CLEAR_MS = parsePositiveIntEnv('NODELINK_BUFFER_POOL_IDLE_CLEAR_MS', 60000 // 1 min - reduced from 3 min
);
const CLEANUP_INTERVAL = 60000;
/**
 * A pool for reusing Buffers to reduce allocations and GC pressure.
 * Aligns buffer sizes to powers of two for better reuse.
 */
class BufferPool {
    pools;
    totalBytes;
    cleanupInterval;
    acquireCalls;
    reuseHits;
    newAllocs;
    releaseCalls;
    rejectedReleases;
    clearCalls;
    highWaterBytes;
    lastActivityAt;
    constructor() {
        this.pools = new Map();
        this.totalBytes = 0;
        this.acquireCalls = 0;
        this.reuseHits = 0;
        this.newAllocs = 0;
        this.releaseCalls = 0;
        this.rejectedReleases = 0;
        this.clearCalls = 0;
        this.highWaterBytes = 0;
        this.lastActivityAt = Date.now();
        this.cleanupInterval = setInterval(() => this._cleanup(), CLEANUP_INTERVAL);
        this.cleanupInterval.unref();
    }
    /**
     * Aligns the requested size to the next power of two (minimum 1024).
     * @param size The requested size.
     * @returns The aligned size.
     * @private
     */
    _getAlignedSize(size) {
        if (size <= 1024)
            return 1024;
        let n = size - 1;
        n |= n >> 1;
        n |= n >> 2;
        n |= n >> 4;
        n |= n >> 8;
        n |= n >> 16;
        return n + 1;
    }
    /**
     * Acquires a Buffer of at least the requested size from the pool.
     * If no buffer is available, a new one is allocated.
     * @param size The minimum size required.
     * @returns A Buffer with length equal to the aligned size.
     */
    acquire(size) {
        this.lastActivityAt = Date.now();
        this.acquireCalls++;
        const alignedSize = this._getAlignedSize(size);
        const pool = this.pools.get(alignedSize);
        if (pool?.length) {
            const buffer = pool.pop();
            if (buffer) {
                this.reuseHits++;
                this.totalBytes -= alignedSize;
                return buffer;
            }
        }
        this.newAllocs++;
        return Buffer.allocUnsafe(alignedSize);
    }
    /**
     * Releases a Buffer back into the pool for future reuse.
     * Only buffers within a certain size range are pooled to avoid fragmentation.
     * @param buffer The Buffer to release.
     */
    release(buffer) {
        this.lastActivityAt = Date.now();
        this.releaseCalls++;
        if (!Buffer.isBuffer(buffer))
            return;
        const size = buffer.length;
        // Only pool buffers between 1KB and 10MB
        if (size < 1024 || size > 10 * 1024 * 1024) {
            this.rejectedReleases++;
            return;
        }
        if (this.totalBytes + size > MAX_POOL_SIZE_BYTES * 0.75) {
            const sizes = Array.from(this.pools.keys()).sort((a, b) => b - a);
            for (const s of sizes) {
                if (this.totalBytes + size <= MAX_POOL_SIZE_BYTES)
                    break;
                const bucket = this.pools.get(s);
                if (bucket?.length) {
                    this.totalBytes -= s * bucket.length;
                    this.pools.delete(s);
                }
            }
        }
        if (this.totalBytes + size > MAX_POOL_SIZE_BYTES) {
            this.rejectedReleases++;
            return;
        }
        let pool = this.pools.get(size);
        if (!pool) {
            pool = [];
            this.pools.set(size, pool);
        }
        if (pool.length >= MAX_BUCKET_ENTRIES) {
            this.rejectedReleases++;
            return;
        }
        pool.push(buffer);
        this.totalBytes += size;
        if (this.totalBytes > this.highWaterBytes) {
            this.highWaterBytes = this.totalBytes;
        }
    }
    /**
     * Clears all pooled buffers.
     */
    clear() {
        this.lastActivityAt = Date.now();
        this.clearCalls++;
        this.pools.clear();
        this.totalBytes = 0;
    }
    /**
     * Returns internal metrics for profiler/UI diagnostics.
     */
    getStats() {
        let entries = 0;
        const topBuckets = Array.from(this.pools.entries())
            .map(([size, list]) => {
            const count = list.length;
            entries += count;
            return {
                size,
                count,
                bytes: size * count
            };
        })
            .sort((a, b) => b.bytes - a.bytes)
            .slice(0, 20);
        const reuseRatio = this.acquireCalls > 0 ? this.reuseHits / this.acquireCalls : 0;
        const rejectionRate = this.releaseCalls > 0 ? this.rejectedReleases / this.releaseCalls : 0;
        if (rejectionRate > 0.5 && this.rejectedReleases > 10) {
            logger('warn', 'BufferPool', `High rejection rate: ${(rejectionRate * 100).toFixed(1)}% (${this.rejectedReleases}/${this.releaseCalls}). ` +
                `Pool: ${this.totalBytes} / ${MAX_POOL_SIZE_BYTES} bytes. ` +
                `Consider increasing NODELINK_BUFFER_POOL_MAX_BYTES.`);
        }
        return {
            totalBytes: this.totalBytes,
            highWaterBytes: this.highWaterBytes,
            buckets: this.pools.size,
            entries,
            acquireCalls: this.acquireCalls,
            reuseHits: this.reuseHits,
            newAllocs: this.newAllocs,
            releaseCalls: this.releaseCalls,
            rejectedReleases: this.rejectedReleases,
            clearCalls: this.clearCalls,
            reuseRatio,
            topBuckets
        };
    }
    /**
     * Periodic cleanup to ensure the pool doesn't exceed its total byte limit.
     * @private
     */
    _cleanup() {
        const now = Date.now();
        if (this.totalBytes > 0 && now - this.lastActivityAt >= IDLE_CLEAR_MS) {
            this.pools.clear();
            this.totalBytes = 0;
            logger('debug', 'BufferPool', 'Pool cleared after idle period.');
            return;
        }
        if (this.totalBytes > MAX_POOL_SIZE_BYTES) {
            const sizes = Array.from(this.pools.keys()).sort((a, b) => b - a);
            for (const size of sizes) {
                if (this.totalBytes <= MAX_POOL_SIZE_BYTES)
                    break;
                const bucket = this.pools.get(size);
                if (bucket?.length) {
                    const count = bucket.length;
                    this.totalBytes -= size * count;
                    this.pools.delete(size);
                    logger('debug', 'BufferPool', `Cleared bucket ${size} (${count} entries, ${size * count} bytes)`);
                }
            }
            if (this.totalBytes > MAX_POOL_SIZE_BYTES) {
                this.pools.clear();
                this.totalBytes = 0;
                logger('debug', 'BufferPool', 'Pool cleared due to size limit.');
            }
        }
    }
}
/**
 * Singleton instance of the BufferPool.
 */
export const bufferPool = new BufferPool();
