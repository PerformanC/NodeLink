/** Dedicated, source-cluster micro-worker for bounded AutoMix PCM analysis. */
import { parentPort } from 'node:worker_threads'
import { inspectTrackOutroQuick } from '../playback/processing/MusicalAnalyzer.ts'

interface AnalysisTask {
  id: string
  socketPath: string
  payload: {
    pcmBase64: string
    sampleRate?: number
    trackId?: string
    windowStartMs?: number
    trackLengthMs?: number
  }
}

parentPort?.on('message', (task: AnalysisTask) => {
  try {
    const {
      pcmBase64,
      sampleRate = 48000,
      trackId = '',
      windowStartMs = 0,
      trackLengthMs = 0
    } = task.payload
    const pcm = Buffer.from(pcmBase64, 'base64')
    if (pcm.length > 5 * 1024 * 1024) {
      throw new Error('PCM analysis window exceeds 5 MiB')
    }
    const result = inspectTrackOutroQuick(
      pcm,
      sampleRate,
      trackId,
      windowStartMs,
      trackLengthMs
    )
    parentPort?.postMessage({
      type: 'analysisResult',
      id: task.id,
      socketPath: task.socketPath,
      result: JSON.stringify(result)
    })
  } catch (error) {
    parentPort?.postMessage({
      type: 'analysisResult',
      id: task.id,
      socketPath: task.socketPath,
      error: error instanceof Error ? error.message : String(error)
    })
  }
})
