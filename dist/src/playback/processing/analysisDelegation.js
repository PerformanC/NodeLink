import { randomUUID } from 'node:crypto';
const pending = new Map();
process.on('message', (message) => {
    if (message?.type !== 'pcmAnalysisResult' || !message.requestId)
        return;
    const entry = pending.get(message.requestId);
    if (!entry)
        return;
    clearTimeout(entry.timer);
    pending.delete(message.requestId);
    entry.resolve(message.error ? null : message.payload ?? null);
});
/** Requests one bounded analysis window from the master/source worker cluster. */
export function requestPcmAnalysis(payload, timeoutMs = 9000) {
    if (typeof process.send !== 'function' || !process.connected) {
        return Promise.resolve(null);
    }
    const requestId = randomUUID();
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            pending.delete(requestId);
            resolve(null);
        }, timeoutMs);
        timer.unref?.();
        pending.set(requestId, { resolve, timer });
        process.send?.({ type: 'pcmAnalysisRequest', requestId, payload }, (error) => {
            if (!error)
                return;
            const entry = pending.get(requestId);
            if (!entry)
                return;
            clearTimeout(entry.timer);
            pending.delete(requestId);
            entry.resolve(null);
        });
    });
}
