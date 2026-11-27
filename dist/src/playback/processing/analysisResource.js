/** Bound the registry's wait and release late resources, without pretending that
 * a source which ignores cancellation has stopped its network request. */
export function acquireAnalysisResource(acquire, dispose, signal, timeoutMs) {
    if (signal.aborted)
        return Promise.resolve(null);
    return new Promise((resolve) => {
        let finished = false;
        let timer;
        const finish = (value) => {
            if (finished)
                return;
            finished = true;
            if (timer)
                clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            resolve(value);
        };
        const abort = () => finish(null);
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(abort, timeoutMs);
        if (signal.aborted) {
            abort();
            return;
        }
        Promise.resolve().then(() => {
            if (finished)
                return null;
            return acquire();
        }).then((value) => {
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
