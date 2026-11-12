import { randomUUID } from 'node:crypto'
import type { TrackPreAnalysisProfile } from './MusicalAnalyzer.ts'

interface AnalysisRequest {
  type: 'pcmAnalysisRequest'
  requestId: string
  payload: Record<string, unknown>
}

interface AnalysisResponse {
  type?: string
  requestId?: string
  payload?: TrackPreAnalysisProfile | null
  error?: string
}

const pending = new Map<
  string,
  { resolve: (value: TrackPreAnalysisProfile | null) => void; timer: NodeJS.Timeout }
>()

process.on('message', (message: AnalysisResponse) => {
  if (message?.type !== 'pcmAnalysisResult' || !message.requestId) return
  const entry = pending.get(message.requestId)
  if (!entry) return
  clearTimeout(entry.timer)
  pending.delete(message.requestId)
  entry.resolve(message.error ? null : message.payload ?? null)
})

/** Requests one bounded analysis window from the master/source worker cluster. */
export function requestPcmAnalysis(
  payload: Record<string, unknown>,
  timeoutMs = 9000
): Promise<TrackPreAnalysisProfile | null> {
  if (typeof process.send !== 'function' || !process.connected) {
    return Promise.resolve(null)
  }
  const requestId = randomUUID()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      resolve(null)
    }, timeoutMs)
    timer.unref?.()
    pending.set(requestId, { resolve, timer })
    process.send?.({ type: 'pcmAnalysisRequest', requestId, payload } satisfies AnalysisRequest, (error) => {
      if (!error) return
      const entry = pending.get(requestId)
      if (!entry) return
      clearTimeout(entry.timer)
      pending.delete(requestId)
      entry.resolve(null)
    })
  })
}
