/** Bound the registry's wait and release late resources, without pretending that
 * a source which ignores cancellation has stopped its network request. */
export function acquireAnalysisResource(acquire, dispose, signal, timeoutMs) {
    if (signal.aborted)
        return Promise.resolve(null);
    const timeoutController = new AbortController();
    const acquisitionSignal = AbortSignal.any([signal, timeoutController.signal]);
    return new Promise((resolve) => {
        let finished = false;
        let timer;
        const finish = (value) => {
            if (finished)
                return;
            finished = true;
            if (timer)
                clearTimeout(timer);
            acquisitionSignal.removeEventListener('abort', abort);
            resolve(value);
        };
        const abort = () => finish(null);
        acquisitionSignal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => timeoutController.abort(), timeoutMs);
        if (acquisitionSignal.aborted) {
            abort();
            return;
        }
        Promise.resolve()
            .then(() => {
            if (finished)
                return null;
            return acquire(acquisitionSignal);
        })
            .then((value) => {
            if (value === null)
                return finish(null);
            if (finished) {
                try {
                    dispose(value);
                }
                catch { }
            }
            else
                finish(value);
        }, () => finish(null));
    });
}
