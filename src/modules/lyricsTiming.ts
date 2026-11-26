import type { LyricsData, LyricsLoadResult } from '../managers/lyricsManager.ts'

/** Timing coverage describes supplied spans, not an inferred syllable or word boundary. */
export interface LyricsTiming {
  granularity: 'none' | 'line' | 'token'
  totalLines: number
  timedLines: number
  tokenTimedLines: number
}

export function readLyricsTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value))) return undefined
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

export function summarizeLyricsTiming(data: LyricsData): LyricsTiming {
  const lines = (data.lines ?? []).filter((line) => line.kind !== 'instrumental' && line.text.trim())
  let timedLines = 0
  let tokenTimedLines = 0
  if (data.synced === true) {
    for (const line of lines) {
      if (readLyricsTimestamp(line.time) === undefined) continue
      timedLines++
      if (line.words?.some((word) =>
        typeof word.text === 'string' && word.text.trim() &&
        readLyricsTimestamp(word.timestamp ?? word.time) !== undefined
      )) tokenTimedLines++
    }
  }
  return {
    granularity: tokenTimedLines ? 'token' : timedLines ? 'line' : 'none',
    totalLines: lines.length,
    timedLines,
    tokenTimedLines
  }
}

export function getLyricsQualityTier(result: LyricsLoadResult): number {
  if (result.loadType !== 'lyrics') return 0
  const timing = summarizeLyricsTiming(result.data)
  if (timing.granularity === 'token') return 3
  if (timing.granularity === 'line') return 2
  return timing.totalLines ? 1 : 0
}

/** Only derive intro/outro from reliable timed vocal intervals. */
export function enrichTemporalMetadata(data: LyricsData, trackLengthMs?: number): void {
  data.timing = summarizeLyricsTiming(data)
  if (data.synced !== true) return
  let firstStart = Infinity
  let lastEnd = 0
  let hasUnknownDuration = false
  for (const line of data.lines ?? []) {
    if (line.kind === 'instrumental' || !line.text.trim()) continue
    const start = readLyricsTimestamp(line.time)
    if (start === undefined) {
      hasUnknownDuration = true
      continue
    }
    firstStart = Math.min(firstStart, start)
    if (!Number.isFinite(line.duration) || line.duration <= 0) {
      hasUnknownDuration = true
      continue
    }
    lastEnd = Math.max(lastEnd, start + line.duration)
  }
  const length = readLyricsTimestamp(trackLengthMs)
  if (Number.isFinite(firstStart) && firstStart > 0 &&
      (length === undefined || firstStart < length) && data.introEndMs === undefined) {
    data.introEndMs = firstStart
  }
  if (!hasUnknownDuration && lastEnd > 0 && length !== undefined &&
      lastEnd < length && data.outroStartMs === undefined) {
    data.outroStartMs = lastEnd
  }
}
