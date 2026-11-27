/** Bound the registry's wait and release late resources, without pretending that
 * a source which ignores cancellation has stopped its network request. */
export function acquireAnalysisResource<T>(
  acquire: (signal: AbortSignal) => Promise<T>,
  dispose: (value: T) => void,
  signal: AbortSignal,
  timeoutMs: number
): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null)
  const timeoutController = new AbortController()
  const acquisitionSignal = AbortSignal.any([signal, timeoutController.signal])
  return new Promise((resolve) => {
    let finished = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (value: T | null) => {
      if (finished) return
      finished = true
      if (timer) clearTimeout(timer)
      acquisitionSignal.removeEventListener('abort', abort)
      resolve(value)
    }
    const abort = () => finish(null)
    acquisitionSignal.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => timeoutController.abort(), timeoutMs)
    if (acquisitionSignal.aborted) {
      abort()
      return
    }
    Promise.resolve()
      .then(() => {
        if (finished) return null
        return acquire(acquisitionSignal)
      })
      .then(
        (value) => {
          if (value === null) return finish(null)
          if (finished) {
            try {
              dispose(value)
            } catch {}
          } else finish(value)
        },
        () => finish(null)
      )
  })
}
