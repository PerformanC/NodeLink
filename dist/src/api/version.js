/**
 * Checks whether the runtime instance exposes a serializable `version` field.
 *
 * This guard keeps the handler fully typed without widening the route to
 * `any`-style access. The endpoint depends on a string version because it
 * writes the value directly as plain text to the HTTP response body.
 *
 * @param nodelink - Runtime instance received by the API router.
 * @returns `true` when the runtime contains a string `version` property that
 * can be safely written to the response.
 */
function hasVersionField(nodelink) {
    return 'version' in nodelink && typeof nodelink.version === 'string';
}
/**
 * Handles `GET /version` requests.
 *
 * The route responds with the running NodeLink semantic version as plain text.
 * A defensive runtime check is kept in place so the implementation remains
 * valid even if the shared API server contract is narrower than the concrete
 * runtime passed by the bootstrap layer.
 *
 * @param nodelink - NodeLink runtime used by the API router.
 * @param _req - Incoming HTTP request. The endpoint does not inspect it.
 * @param res - HTTP response object used to write the plain-text payload.
 * @returns Nothing. The function terminates by writing the response directly.
 */
function handler(nodelink, _req, res) {
    if (!hasVersionField(nodelink)) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('unknown');
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(nodelink.version);
}
/**
 * Route module definition for the public version endpoint.
 *
 * The router defaults the method list to `GET`, so only the handler needs to
 * be declared here.
 */
const versionRoute = {
    handler
};
export default versionRoute;
