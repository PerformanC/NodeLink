export function protectedProcessingOptions(input) {
    const bounded = (value, fallback, min, max) => typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= min &&
        value <= max
        ? value
        : fallback;
    return {
        targetLoudnessLufs: bounded(input?.targetLoudnessLufs, -14, -30, -8),
        ceilingDbTP: bounded(input?.ceilingDbTP, -2.4, -12, -1),
        lookaheadMs: bounded(input?.lookaheadMs, 5, 2, 20),
        releaseMs: bounded(input?.releaseMs, 80, 20, 500),
        telemetry: input?.telemetry === true
    };
}
