import { AsyncLocalStorage } from 'node:async_hooks'

const acquisition = new AsyncLocalStorage<AbortSignal>()

/** Inherit the analysis signal through nested source HTTP calls, without
 * changing every provider's normal playback path or sharing state between jobs. */
export function withStreamAcquisitionSignal<T>(
  signal: AbortSignal,
  acquire: () => T
): T {
  return acquisition.run(signal, acquire)
}

export function streamAcquisitionSignal(explicit?: AbortSignal): AbortSignal | undefined {
  const inherited = acquisition.getStore()
  if (!explicit || explicit === inherited) return inherited ?? explicit
  return inherited ? AbortSignal.any([inherited, explicit]) : explicit
}
