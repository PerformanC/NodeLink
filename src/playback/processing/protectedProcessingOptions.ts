/** Conservative configurable Protected-mode parameters. Defaults preserve existing behavior. */
export interface ProtectedProcessingOptions {
  targetLoudnessLufs?: number
  ceilingDbTP?: number
  lookaheadMs?: number
  releaseMs?: number
  telemetry?: boolean
}
export function protectedProcessingOptions(input?: ProtectedProcessingOptions) {
  const bounded = (
    value: unknown,
    fallback: number,
    min: number,
    max: number
  ): number =>
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
      ? value
      : fallback
  return {
    targetLoudnessLufs: bounded(input?.targetLoudnessLufs, -14, -30, -8),
    ceilingDbTP: bounded(input?.ceilingDbTP, -2.4, -12, -1),
    lookaheadMs: bounded(input?.lookaheadMs, 5, 2, 20),
    releaseMs: bounded(input?.releaseMs, 80, 20, 500),
    telemetry: input?.telemetry === true
  }
}
