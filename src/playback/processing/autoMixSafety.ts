import type { TemporalFeaturePoint } from '../../typings/playback/progressiveAnalysis.types.ts'
import type { TrackPreAnalysisProfile } from './MusicalAnalyzer.ts'

/** IDs are only unique within a source and may have multiple audio renditions. */
export function autoMixTrackKey(track: {
  info: {
    sourceName: string
    identifier: string
    length?: number
    audioTrackId?: string
  }
  audioTrackId?: string
}): string {
  return JSON.stringify([
    track.info.sourceName,
    track.info.identifier,
    track.audioTrackId ?? track.info.audioTrackId ?? null,
    track.info.length ?? null
  ])
}

/** Only a contiguous, observed silent tail is eligible for shortening playback. */
export function trailingSilenceStart(
  points: readonly TemporalFeaturePoint[],
  minimumMs = 800
): number | null {
  const last = points.at(-1)
  if (!last?.isSilence) return null
  let start = last.timestampMs
  for (let i = points.length - 2; i >= 0; i--) {
    const point = points[i]
    if (
      !point?.isSilence ||
      start - point.timestampMs > 40 ||
      start <= point.timestampMs
    )
      break
    start = point.timestampMs
  }
  if (last.timestampMs - start + 20 < minimumMs) return null
  // Entirely silent/undecodable windows do not prove a natural ending.
  if (!points.some((point) => point.timestampMs < start && !point.isSilence))
    return null
  return start
}

/** A heuristic decay or an incomplete analysis must never replace the actual track end. */
export function safeAutoMixEnd(
  total: number,
  profile: TrackPreAnalysisProfile | null,
  explicitEnd: boolean
): number {
  if (explicitEnd || !Number.isFinite(total) || total <= 0) return total
  const outro = profile?.outroProfile
  if (
    !outro ||
    profile?.analysisVersion !== 3 ||
    !Number.isFinite(outro.analysisConfidence) ||
    outro.analysisConfidence < 0.75
  )
    return total
  const end = outro.naturalOutroPointMs
  if (!Number.isFinite(end) || end <= 0 || end >= total || total - end > 15000)
    return total
  if (
    outro.analyzedWindowStartMs > end ||
    outro.analyzedWindowEndMs < total - 1000
  )
    return total
  if (
    typeof outro.sourceEndRms !== 'number' ||
    !Number.isFinite(outro.sourceEndRms) ||
    outro.sourceEndRms > 0.004
  )
    return total
  return end
}
