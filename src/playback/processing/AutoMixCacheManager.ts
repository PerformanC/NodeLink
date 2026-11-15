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

import cluster from 'node:cluster'
import type { TrackPreAnalysisProfile } from './MusicalAnalyzer.ts'

export type AnalysisStatus = 'preparando' | 'pronto' | 'falha'
export type TransitionStatus =
  | 'preparando'
  | 'ativo'
  | 'concluido'
  | 'cancelado'

export interface AnalysisRecord {
  trackId: string
  status: AnalysisStatus
  workerId: number | null
  profile: TrackPreAnalysisProfile | null
  createdAt: number
  updatedAt: number
  expiresAt: number
}

export interface TransitionRecord {
  transitionId: string
  outgoingTrackId: string
  incomingTrackId: string
  status: TransitionStatus
  plan: unknown | null
  createdAt: number
  updatedAt: number
  expiresAt: number
}

const DEFAULT_PROFILE_TTL_MS = 4 * 60 * 60 * 1000 // 4 hours
const DEFAULT_TRANSITION_TTL_MS = 15 * 60 * 1000 // 15 minutes
const MAX_ANALYSES_ENTRIES = 500
const MAX_TRANSITION_ENTRIES = 100

export class AutoMixCacheManager {
  private static instance: AutoMixCacheManager | null = null

  private readonly analyses = new Map<string, AnalysisRecord>()
  private readonly transitions = new Map<string, TransitionRecord>()
  private cleanupInterval: NodeJS.Timeout | null = null

  private constructor() {
    this._startCleanupTask()
  }

  public static getInstance(_dbPath?: string): AutoMixCacheManager {
    if (!AutoMixCacheManager.instance) {
      AutoMixCacheManager.instance = new AutoMixCacheManager()
    }
    return AutoMixCacheManager.instance
  }

  private _startCleanupTask(): void {
    this.cleanupInterval = setInterval(
      () => {
        this.purgeExpired()
      },
      2 * 60 * 1000
    )
    this.cleanupInterval.unref?.()
  }

  public getProfile(trackId: string): TrackPreAnalysisProfile | null {
    const record = this.analyses.get(trackId)
    if (!record) return null

    if (record.expiresAt <= Date.now()) {
      this.analyses.delete(trackId)
      return null
    }

    if (record.status !== 'pronto' || !record.profile) {
      return null
    }

    // Move to end of Map for LRU freshness
    this.analyses.delete(trackId)
    this.analyses.set(trackId, record)
    return record.profile
  }

  public hasProfile(trackId: string): boolean {
    const profile = this.getProfile(trackId)
    return profile !== null
  }

  public setProfile(
    trackId: string,
    profile: TrackPreAnalysisProfile,
    ttlMs: number = DEFAULT_PROFILE_TTL_MS
  ): void {
    const now = Date.now()
    const record: AnalysisRecord = {
      trackId,
      status: 'pronto',
      workerId: cluster.worker?.id ?? 0,
      profile,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + ttlMs
    }

    if (this.analyses.size >= MAX_ANALYSES_ENTRIES) {
      const oldestKey = this.analyses.keys().next().value
      if (oldestKey !== undefined) this.analyses.delete(oldestKey)
    }

    this.analyses.set(trackId, record)
  }

  public getAnalysis(trackId: string): AnalysisRecord | null {
    const record = this.analyses.get(trackId)
    if (!record) return null

    if (record.expiresAt <= Date.now()) {
      this.analyses.delete(trackId)
      return null
    }

    return record
  }

  public setAnalysisStatus(
    trackId: string,
    status: AnalysisStatus,
    profile: TrackPreAnalysisProfile | null = null,
    ttlMs: number = DEFAULT_PROFILE_TTL_MS
  ): void {
    if (status === 'pronto' && profile) {
      this.setProfile(trackId, profile, ttlMs)
      return
    }

    const now = Date.now()
    const expiresAt = now + (status === 'preparando' ? 90000 : ttlMs)
    const existing = this.analyses.get(trackId)

    const record: AnalysisRecord = {
      trackId,
      status,
      workerId: cluster.worker?.id ?? 0,
      profile: profile ?? existing?.profile ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      expiresAt
    }

    if (this.analyses.size >= MAX_ANALYSES_ENTRIES) {
      const oldestKey = this.analyses.keys().next().value
      if (oldestKey !== undefined) this.analyses.delete(oldestKey)
    }

    this.analyses.set(trackId, record)
  }

  public deleteAnalysis(trackId: string): void {
    this.analyses.delete(trackId)
  }

  public setTransition(
    transitionId: string,
    outgoingTrackId: string,
    incomingTrackId: string,
    status: TransitionStatus,
    plan: unknown = null,
    ttlMs: number = DEFAULT_TRANSITION_TTL_MS
  ): void {
    const now = Date.now()
    const record: TransitionRecord = {
      transitionId,
      outgoingTrackId,
      incomingTrackId,
      status,
      plan,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + ttlMs
    }

    if (this.transitions.size >= MAX_TRANSITION_ENTRIES) {
      const oldestKey = this.transitions.keys().next().value
      if (oldestKey !== undefined) this.transitions.delete(oldestKey)
    }

    this.transitions.set(transitionId, record)
  }

  public completeTransition(transitionId: string): void {
    const record = this.transitions.get(transitionId)
    if (!record) return

    record.status = 'concluido'
    record.updatedAt = Date.now()
  }

  public deleteTransition(transitionId: string): void {
    this.transitions.delete(transitionId)
  }

  public getTransition(transitionId: string): TransitionRecord | null {
    const record = this.transitions.get(transitionId)
    if (!record) return null

    if (record.expiresAt <= Date.now()) {
      this.transitions.delete(transitionId)
      return null
    }

    return record
  }

  public purgeExpired(): void {
    const now = Date.now()

    for (const [key, record] of this.analyses.entries()) {
      if (record.expiresAt <= now) {
        this.analyses.delete(key)
      }
    }

    const finishedCutoff = now - 3 * 60 * 1000
    for (const [key, record] of this.transitions.entries()) {
      if (
        record.expiresAt <= now ||
        ((record.status === 'concluido' || record.status === 'cancelado') &&
          record.updatedAt <= finishedCutoff)
      ) {
        this.transitions.delete(key)
      }
    }
  }

  public clear(): void {
    this.analyses.clear()
    this.transitions.clear()
  }

  public get profileCount(): number {
    let count = 0
    const now = Date.now()
    for (const record of this.analyses.values()) {
      if (record.status === 'pronto' && record.expiresAt > now) {
        count++
      }
    }
    return count
  }

  public close(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    this.analyses.clear()
    this.transitions.clear()
  }
}
