function lazyImport<T>(
  loader: () => Promise<{ default: T }>
): () => Promise<T> {
  let promise: Promise<T> | null = null
  return () => {
    if (!promise) {
      promise = loader().then((mod) => mod.default)
    }
    return promise
  }
}

const getRequestHandler = lazyImport(() => import('../api/index.ts'))
const getPlayerManagerClass = lazyImport(
  () => import('../managers/playerManager.ts')
)
const getWorkerManagerClass = lazyImport(
  () => import('../managers/workerManager.ts')
)
const getSourceWorkerManagerClass = lazyImport(
  () => import('../managers/sourceWorkerManager.ts')
)
const getCredentialManagerClass = lazyImport(
  () => import('../managers/credentialManager.ts')
)
const getTrackCacheManagerClass = lazyImport(
  () => import('../managers/trackCacheManager.ts')
)
const getConnectionManagerClass = lazyImport(
  () => import('../managers/connectionManager.ts')
)
const getSourcesManagerClass = lazyImport(
  () => import('../managers/sourceManager.ts')
)
const getLyricsManagerClass = lazyImport(
  () => import('../managers/lyricsManager.ts')
)
const getMeaningManagerClass = lazyImport(
  () => import('../managers/meaningManager.ts')
)

export {
  getConnectionManagerClass,
  getCredentialManagerClass,
  getLyricsManagerClass,
  getMeaningManagerClass,
  getPlayerManagerClass,
  getRequestHandler,
  getSourcesManagerClass,
  getSourceWorkerManagerClass,
  getTrackCacheManagerClass,
  getWorkerManagerClass,
  lazyImport
}
