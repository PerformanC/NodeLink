import type {
  LyricsData,
  LyricsLine as ProviderLyricsLine
} from '../managers/lyricsManager.ts'
import type { LyricsLine } from '../typings/playback/player.types.ts'
import { readLyricsTimestamp } from './lyricsTiming.ts'

/** Only emit timed events when every line has an actual provider timestamp. */
export function hasCompleteLyricsTiming(data: {
  synced?: boolean
  lines?: ReadonlyArray<{ time?: unknown }>
}): boolean {
  return (
    data.synced === true &&
    !!data.lines?.length &&
    data.lines.every((line) => readLyricsTimestamp(line.time) !== undefined)
  )
}

/** Build the existing event payload while retaining provider timing and annotations. */
export function buildPlaybackLyrics(
  data: Omit<LyricsData, 'lines'> & {
    lines?: Array<Omit<ProviderLyricsLine, 'duration'> & { duration?: number }>
  }
): LyricsLine[] {
  const lines = (data.lines ?? []).map((line) => ({
    timestamp: readLyricsTimestamp(line.time) ?? 0,
    duration:
      typeof line.duration === 'number' &&
      Number.isFinite(line.duration) &&
      line.duration > 0
        ? line.duration
        : 0,
    line: line.text,
    words: line.words ?? [],
    plugin: {
      ...(line.kind ? { kind: line.kind } : {}),
      ...(line.section ? { section: line.section } : {}),
      ...(line.agent ? { agent: line.agent } : {}),
      ...(line.isBackground === true ? { isBackground: true } : {}),
      ...(line.alternatives?.length ? { alternatives: line.alternatives } : {})
    }
  }))
  if (!hasCompleteLyricsTiming(data)) return lines
  return lines.sort((a, b) => a.timestamp - b.timestamp)
}

/** All simultaneous active lines, including the most recent unknown-length primary line. */
export function activeLyricsIndices(
  lines: LyricsLine[],
  position: number
): number[] {
  const active: number[] = []
  let latestPrimary = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line || line.timestamp > position) break
    if (line.plugin.isBackground !== true) latestPrimary = i
    if (line.duration > 0 && position < line.timestamp + line.duration)
      active.push(i)
  }
  const primary = lines[latestPrimary]
  if (primary && primary.duration === 0 && !active.includes(latestPrimary))
    active.push(latestPrimary)
  return active.sort((a, b) => a - b)
}

/** Next expiration of a line that is currently active. */
export function nextLyricsExpiry(
  lines: LyricsLine[],
  position: number
): number | undefined {
  let next = Infinity
  for (const index of activeLyricsIndices(lines, position)) {
    const line = lines[index]
    if (!line || line.duration <= 0) continue
    const end = line.timestamp + line.duration
    if (Number.isFinite(end) && end > position) next = Math.min(next, end)
  }
  return Number.isFinite(next) ? next : undefined
}
