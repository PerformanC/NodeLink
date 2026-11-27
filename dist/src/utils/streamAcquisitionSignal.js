import { AsyncLocalStorage } from 'node:async_hooks';
const acquisition = new AsyncLocalStorage();
/** Inherit the analysis signal through nested source HTTP calls, without
 * changing every provider's normal playback path or sharing state between jobs. */
export function withStreamAcquisitionSignal(signal, acquire) {
    return acquisition.run(signal, acquire);
}
export function streamAcquisitionSignal(explicit) {
    const inherited = acquisition.getStore();
    if (!explicit || explicit === inherited)
        return inherited ?? explicit;
    return inherited ? AbortSignal.any([inherited, explicit]) : explicit;
}
