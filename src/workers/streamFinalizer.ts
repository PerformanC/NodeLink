export interface StreamFinalizerEntry {
  cancelled: boolean
  cleaned: boolean
}

export interface StreamFinalizerHandlers {
  onCancelled: () => void
  onError: (error: unknown) => void
  onEnd: () => void
  onCleanup: () => void
}

/**
 * Creates an idempotent terminal handler for a PCM stream.
 *
 * Streams commonly emit `end` followed by `close`, and cancellation can
 * destroy a stream before its terminal event arrives. Both cases must produce
 * one terminal notification and one cleanup.
 */
export function createStreamFinalizer(
  entry: StreamFinalizerEntry,
  handlers: StreamFinalizerHandlers
): (error?: unknown) => void {
  let finished = false

  return (error?: unknown): void => {
    if (finished || entry.cleaned) return
    finished = true

    try {
      if (entry.cancelled) {
        handlers.onCancelled()
      } else if (error) {
        handlers.onError(error)
      } else {
        handlers.onEnd()
      }
    } finally {
      handlers.onCleanup()
    }
  }
}
