function lazyImport(loader) {
    let promise = null;
    return () => {
        if (!promise) {
            promise = loader().then((mod) => mod.default);
        }
        return promise;
    };
}
const getRequestHandler = lazyImport(() => import('../api/index.js'));
const getPlayerManagerClass = lazyImport(() => import('../managers/playerManager.js'));
const getWorkerManagerClass = lazyImport(() => import('../managers/workerManager.js'));
const getSourceWorkerManagerClass = lazyImport(() => import('../managers/sourceWorkerManager.js'));
const getCredentialManagerClass = lazyImport(() => import('../managers/credentialManager.js'));
const getTrackCacheManagerClass = lazyImport(() => import('../managers/trackCacheManager.js'));
const getConnectionManagerClass = lazyImport(() => import('../managers/connectionManager.js'));
const getSourcesManagerClass = lazyImport(() => import('../managers/sourceManager.js'));
const getLyricsManagerClass = lazyImport(() => import('../managers/lyricsManager.js'));
const getMeaningManagerClass = lazyImport(() => import('../managers/meaningManager.js'));
export { getConnectionManagerClass, getCredentialManagerClass, getLyricsManagerClass, getMeaningManagerClass, getPlayerManagerClass, getRequestHandler, getSourcesManagerClass, getSourceWorkerManagerClass, getTrackCacheManagerClass, getWorkerManagerClass, lazyImport };
