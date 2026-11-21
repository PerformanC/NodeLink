/**
 * @file AutoMixCacheManager.ts
 * @package NodeLink
 * @organization PerformanC
 * @author PerformanC <https://github.com/PerformanC>
 * @license GPL-3.0-or-later
 * @copyright (C) 2026 PerformanC
 *
 * @description
 * Ultra-low-latency, zero-disk in-memory lifecycle cache for AutoMix analyses and
 * crossfade transitions. Operates purely in-memory using binary/object references
 * and LRU eviction, avoiding any synchronous disk I/O, database locks, or audio stream starvation.
 */
import cluster from 'node:cluster';
const DEFAULT_PROFILE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const DEFAULT_TRANSITION_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ANALYSES_ENTRIES = 500;
const MAX_TRANSITION_ENTRIES = 100;
export class AutoMixCacheManager {
    static instance = null;
    analyses = new Map();
    transitions = new Map();
    cleanupInterval = null;
    constructor() {
        this._startCleanupTask();
    }
    static getInstance(_dbPath) {
        if (!AutoMixCacheManager.instance) {
            AutoMixCacheManager.instance = new AutoMixCacheManager();
        }
        return AutoMixCacheManager.instance;
    }
    _startCleanupTask() {
        this.cleanupInterval = setInterval(() => {
            this.purgeExpired();
        }, 2 * 60 * 1000);
        this.cleanupInterval.unref?.();
    }
    getProfile(trackId) {
        const record = this.analyses.get(trackId);
        if (!record)
            return null;
        if (record.expiresAt <= Date.now()) {
            this.analyses.delete(trackId);
            return null;
        }
        if (record.status !== 'pronto' || !record.profile) {
            return null;
        }
        // Move to end of Map for LRU freshness
        this.analyses.delete(trackId);
        this.analyses.set(trackId, record);
        return record.profile;
    }
    hasProfile(trackId) {
        const profile = this.getProfile(trackId);
        return profile !== null;
    }
    setProfile(trackId, profile, ttlMs = DEFAULT_PROFILE_TTL_MS) {
        const now = Date.now();
        const record = {
            trackId,
            status: 'pronto',
            workerId: cluster.worker?.id ?? 0,
            profile,
            createdAt: now,
            updatedAt: now,
            expiresAt: now + ttlMs
        };
        if (this.analyses.size >= MAX_ANALYSES_ENTRIES) {
            const oldestKey = this.analyses.keys().next().value;
            if (oldestKey !== undefined)
                this.analyses.delete(oldestKey);
        }
        this.analyses.set(trackId, record);
    }
    getAnalysis(trackId) {
        const record = this.analyses.get(trackId);
        if (!record)
            return null;
        if (record.expiresAt <= Date.now()) {
            this.analyses.delete(trackId);
            return null;
        }
        return record;
    }
    setAnalysisStatus(trackId, status, profile = null, ttlMs = DEFAULT_PROFILE_TTL_MS) {
        if (status === 'pronto' && profile) {
            this.setProfile(trackId, profile, ttlMs);
            return;
        }
        const now = Date.now();
        const expiresAt = now + (status === 'preparando' ? 90000 : ttlMs);
        const existing = this.analyses.get(trackId);
        const record = {
            trackId,
            status,
            workerId: cluster.worker?.id ?? 0,
            profile: profile ?? existing?.profile ?? null,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            expiresAt
        };
        if (this.analyses.size >= MAX_ANALYSES_ENTRIES) {
            const oldestKey = this.analyses.keys().next().value;
            if (oldestKey !== undefined)
                this.analyses.delete(oldestKey);
        }
        this.analyses.set(trackId, record);
    }
    deleteAnalysis(trackId) {
        this.analyses.delete(trackId);
    }
    setTransition(transitionId, outgoingTrackId, incomingTrackId, status, plan = null, ttlMs = DEFAULT_TRANSITION_TTL_MS) {
        const now = Date.now();
        const record = {
            transitionId,
            outgoingTrackId,
            incomingTrackId,
            status,
            plan,
            createdAt: now,
            updatedAt: now,
            expiresAt: now + ttlMs
        };
        if (this.transitions.size >= MAX_TRANSITION_ENTRIES) {
            const oldestKey = this.transitions.keys().next().value;
            if (oldestKey !== undefined)
                this.transitions.delete(oldestKey);
        }
        this.transitions.set(transitionId, record);
    }
    completeTransition(transitionId) {
        const record = this.transitions.get(transitionId);
        if (!record)
            return;
        record.status = 'concluido';
        record.updatedAt = Date.now();
    }
    deleteTransition(transitionId) {
        this.transitions.delete(transitionId);
    }
    getTransition(transitionId) {
        const record = this.transitions.get(transitionId);
        if (!record)
            return null;
        if (record.expiresAt <= Date.now()) {
            this.transitions.delete(transitionId);
            return null;
        }
        return record;
    }
    purgeExpired() {
        const now = Date.now();
        for (const [key, record] of this.analyses.entries()) {
            if (record.expiresAt <= now) {
                this.analyses.delete(key);
            }
        }
        const finishedCutoff = now - 3 * 60 * 1000;
        for (const [key, record] of this.transitions.entries()) {
            if (record.expiresAt <= now ||
                ((record.status === 'concluido' || record.status === 'cancelado') &&
                    record.updatedAt <= finishedCutoff)) {
                this.transitions.delete(key);
            }
        }
    }
    clear() {
        this.analyses.clear();
        this.transitions.clear();
    }
    get profileCount() {
        let count = 0;
        const now = Date.now();
        for (const record of this.analyses.values()) {
            if (record.status === 'pronto' && record.expiresAt > now) {
                count++;
            }
        }
        return count;
    }
    close() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        this.analyses.clear();
        this.transitions.clear();
    }
}
