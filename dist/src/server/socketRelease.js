const pendingReleases = new WeakMap();
/**
 * Registers a capacity release to run once when the socket goes away.
 * The TCP 'close' event is only a fallback: PWSL strips every socket
 * listener when a WebSocket closes, so upgraded sockets must also be
 * bound with bindWebSocketRelease.
 * @param socket - TCP socket holding the capacity.
 * @param release - Callback that returns the capacity.
 * @public
 */
export function trackSocketRelease(socket, release) {
    const releases = pendingReleases.get(socket);
    if (releases) {
        releases.push(release);
        return;
    }
    pendingReleases.set(socket, [release]);
    socket.once('close', () => releaseSocket(socket));
}
/**
 * Runs and clears every pending release for the socket. Idempotent.
 * @param socket - TCP socket holding the capacity.
 * @public
 */
export function releaseSocket(socket) {
    const releases = pendingReleases.get(socket);
    if (!releases)
        return;
    pendingReleases.delete(socket);
    for (const release of releases) {
        release();
    }
}
/**
 * Releases the socket's capacity when its WebSocket ends. PWSL emits 'close'
 * for peer-initiated and transport closes, but its destroy() (used for
 * protocol errors and server-side teardown) does not, so it is wrapped too.
 * @param ws - WebSocket connection created by the upgrade.
 * @param socket - Underlying TCP socket.
 * @public
 */
export function bindWebSocketRelease(ws, socket) {
    ws.once('close', () => releaseSocket(socket));
    const destroy = ws.destroy;
    if (typeof destroy !== 'function')
        return;
    ws.destroy = function () {
        releaseSocket(socket);
        return destroy.call(this);
    };
}
