/**
 * Creates an idempotent terminal handler for a PCM stream.
 *
 * Streams commonly emit `end` followed by `close`, and cancellation can
 * destroy a stream before its terminal event arrives. Both cases must produce
 * one terminal notification and one cleanup.
 */
export function createStreamFinalizer(entry, handlers) {
    let finished = false;
    return (error) => {
        if (finished || entry.cleaned)
            return;
        finished = true;
        try {
            if (entry.cancelled) {
                handlers.onCancelled();
            }
            else if (error) {
                handlers.onError(error);
            }
            else {
                handlers.onEnd();
            }
        }
        finally {
            handlers.onCleanup();
        }
    };
}
