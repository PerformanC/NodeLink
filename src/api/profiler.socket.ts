import type http from 'node:http'
import { URL } from 'node:url'

import type { ApiNodelinkServer } from '../typings/api/api.types.ts'
import type { SessionSocket } from '../typings/index.types.ts'

type ProfilerApiModule = typeof import('./profiler.ts')

interface ProfilerRealtimeStore {
  snapshots: Array<Record<string, unknown>>
  lastAllocTop: object | null
  updatedAt: number
}

interface SocketRequestWithHeaders {
  url?: string
  headers: {
    host?: string | string[]
    [key: string]: string | string[] | undefined
  }
}

const PROFILER_HISTORY_MAX = 240
let profilerApiPromise: Promise<ProfilerApiModule> | null = null

/* INFO: Lazy loads profiler API module to avoid unnecessary startup overhead */
async function _getProfilerApi(): Promise<ProfilerApiModule> {
  if (!profilerApiPromise) {
    profilerApiPromise = import('./profiler.ts')
  }
  return profilerApiPromise
}

/* INFO: Maintains in-memory circular history buffer of recent profiler snapshots */
const realtimeStore: ProfilerRealtimeStore = {
  snapshots: [],
  lastAllocTop: null,
  updatedAt: Date.now()
}

function getProfilerRealtimeStore(): ProfilerRealtimeStore {
  return realtimeStore
}

async function attachProfilerSocket(
  nodelink: ApiNodelinkServer,
  socket: SessionSocket,
  request: http.IncomingMessage | SocketRequestWithHeaders
): Promise<void> {
  let streamTimer: NodeJS.Timeout | null = null
  let allocTimer: NodeJS.Timeout | null = null
  let isRunning = true
  let tickInFlight = false
  let allocInFlight = false
  let lastAllocAt = 0
  let lastAllocReport: object | null = realtimeStore.lastAllocTop

  const prevProcessMetrics = new Map<
    string,
    {
      time: number
      heapUsed: number
      rss: number
      oldUsed?: number
      playersCount?: number
    }
  >()

  const host = Array.isArray(request.headers.host)
    ? request.headers.host[0]
    : (request.headers.host ?? 'localhost')

  const url = new URL(request.url || '/v4/profiler/socket', `http://${host}`)

  const clamp = (val: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, val))

  const intervalMs = clamp(
    Number(url.searchParams.get('intervalMs')) || 2000,
    700,
    15000
  )
  const allocDurationMs = clamp(
    Number(url.searchParams.get('allocDurationMs')) || 3000,
    1000,
    15000
  )
  const allocEveryRaw = Number(url.searchParams.get('allocEveryMs')) || 0
  const allocEveryMs =
    allocEveryRaw > 0 ? clamp(Math.floor(allocEveryRaw), 5000, 120000) : 0

  const queryScope = url.searchParams.get('scope') || 'all'
  const filterPayload = { scope: queryScope }

  const cleanup = (): void => {
    isRunning = false
    if (streamTimer) clearInterval(streamTimer)
    if (allocTimer) clearInterval(allocTimer)
    streamTimer = null
    allocTimer = null
  }

  const sendJson = (data: Record<string, unknown>): void => {
    if (!isRunning) return
    try {
      socket.send(JSON.stringify(data))
    } catch {
      cleanup()
    }
  }

  const sampleAllocations = async (): Promise<void> => {
    if (!isRunning || allocInFlight) return
    const now = Date.now()
    if (lastAllocReport && now - lastAllocAt < allocEveryMs) return

    allocInFlight = true
    try {
      const profilerApi = await _getProfilerApi()
      lastAllocReport = await profilerApi.collectAllocationTopSites(nodelink, {
        ...filterPayload,
        durationMs: allocDurationMs,
        name: 'ws-alloc'
      })
      lastAllocAt = Date.now()
      realtimeStore.lastAllocTop = lastAllocReport
      realtimeStore.updatedAt = lastAllocAt
    } catch (error) {
      lastAllocReport = {
        action: 'allocTop',
        failed: true,
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now()
      }
      lastAllocAt = Date.now()
      realtimeStore.lastAllocTop = lastAllocReport
      realtimeStore.updatedAt = lastAllocAt
    } finally {
      allocInFlight = false
    }
  }

  const captureSnapshotTick = async (): Promise<void> => {
    if (!isRunning || tickInFlight) return
    tickInFlight = true

    try {
      const profilerApi = await _getProfilerApi()
      const snapshot = await profilerApi.collectActionSnapshot(
        nodelink,
        'status',
        filterPayload
      )
      const warnings = profilerApi.detectAnomalies(snapshot, prevProcessMetrics)

      sendJson({
        op: 'profilerSnapshot',
        timestamp: Date.now(),
        snapshot,
        warnings,
        allocTop: lastAllocReport
      })

      realtimeStore.snapshots.push({
        timestamp: Date.now(),
        snapshot,
        warnings,
        allocTop: lastAllocReport
      })

      if (realtimeStore.snapshots.length > PROFILER_HISTORY_MAX) {
        realtimeStore.snapshots.shift()
      }
      realtimeStore.updatedAt = Date.now()
    } catch (error) {
      sendJson({
        op: 'profilerError',
        timestamp: Date.now(),
        error: error instanceof Error ? error.message : String(error)
      })
    } finally {
      tickInFlight = false
    }
  }

  socket.on('close', cleanup)
  socket.on('error', cleanup)

  sendJson({
    op: 'profilerReady',
    timestamp: Date.now(),
    intervalMs,
    allocEveryMs,
    allocDurationMs
  })

  sendJson({
    op: 'profilerBootstrap',
    timestamp: Date.now(),
    history: realtimeStore.snapshots,
    lastAllocTop: realtimeStore.lastAllocTop,
    updatedAt: realtimeStore.updatedAt
  })

  if (allocEveryMs > 0) void sampleAllocations()
  await captureSnapshotTick()

  streamTimer = setInterval(() => {
    void captureSnapshotTick()
  }, intervalMs)

  if (allocEveryMs > 0) {
    allocTimer = setInterval(() => {
      void sampleAllocations()
    }, allocEveryMs)
  }
}

export {
  attachProfilerSocket,
  getProfilerRealtimeStore,
  type SocketRequestWithHeaders
}
