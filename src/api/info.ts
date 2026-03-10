import process from 'node:process'
import type {
  ApiNodelinkServer,
  ApiRequest,
  ApiResponse,
  ApiRouteModule,
  ApiSendResponse
} from '../typings/api/api.types.ts'
import type { GitInfo, SemverInfo } from '../typings/utils.types.ts'
import { getVersion } from '../utils.ts'

/**
 * Boolean flag registry describing which audio filters are enabled.
 *
 * Keys are filter identifiers and values indicate whether the filter is
 * currently exposed by the running NodeLink instance.
 */
interface InfoFilterFlags {
  [filterName: string]: boolean | undefined
}

/**
 * Minimal plugin metadata consumed by the info endpoint.
 */
interface InfoPluginMeta {
  /**
   * Plugin semantic version declared by its manifest.
   */
  version?: string

  /**
   * Plugin author string exposed by its manifest.
   */
  author?: string
}

/**
 * Loaded plugin entry shape serialized by the info endpoint.
 */
interface InfoLoadedPlugin {
  /**
   * Registered plugin name.
   */
  name: string

  /**
   * Resolved plugin installation path.
   */
  path: string

  /**
   * Optional metadata resolved from the plugin package manifest.
   */
  meta?: InfoPluginMeta
}

/**
 * Minimal plugin manager contract required by the info endpoint.
 */
interface InfoPluginManager {
  /**
   * Loaded plugin registry keyed by plugin name.
   */
  loadedPlugins: Map<string, InfoLoadedPlugin>
}

/**
 * Minimal source manager contract required by the info endpoint.
 */
interface InfoSourceManager {
  /**
   * Registered source instances keyed by source name.
   */
  sources: Map<string, object>
}

/**
 * Additional runtime fields required by the info endpoint.
 *
 * The shared API router type is intentionally smaller than the full NodeLink
 * runtime, so this route narrows the runtime shape locally.
 */
interface InfoRouteRuntime extends ApiNodelinkServer {
  /**
   * Current NodeLink semantic version string.
   */
  version: string

  /**
   * Git metadata for the running build.
   */
  gitInfo: GitInfo

  /**
   * In-memory cache of enabled source manager names.
   */
  supportedSourcesCache: string[] | null

  /**
   * Retrieves enabled source names from a worker process when cluster mode is
   * active.
   *
   * @returns Promise resolving to the list of enabled source identifiers.
   */
  getSourcesFromWorker: () => Promise<string[]>

  /**
   * Playback worker manager instance when cluster mode is enabled.
   */
  workerManager: object | null

  /**
   * Source manager instance when running in single-process mode.
   */
  sources: InfoSourceManager | null

  /**
   * Plugin manager instance used to enumerate loaded plugins.
   */
  pluginManager: InfoPluginManager | null

  /**
   * Configuration extended with optional filter flags.
   */
  options: ApiNodelinkServer['options'] & {
    filters?: {
      enabled?: InfoFilterFlags
    }
  }
}

/**
 * Serialized plugin payload returned by the info endpoint.
 */
interface InfoPluginResponse {
  /**
   * Plugin name.
   */
  name: string

  /**
   * Plugin semantic version or fallback value when unavailable.
   */
  version: string

  /**
   * Plugin author or `null` when not declared.
   */
  author: string | null

  /**
   * Plugin installation path or `null` when unavailable.
   */
  path: string | null
}

/**
 * Response payload emitted by the info endpoint.
 */
interface InfoResponse {
  /**
   * Version metadata for the current NodeLink process.
   */
  version: SemverInfo & {
    /**
     * Original semantic version string.
     */
    semver: string
  }

  /**
   * Commit timestamp in milliseconds since epoch.
   */
  buildTime: number

  /**
   * Git metadata for the running build.
   */
  git: GitInfo

  /**
   * Active Node.js runtime version string.
   */
  node: string

  /**
   * Voice dependency metadata bundled with NodeLink.
   */
  voice: {
    /**
     * Voice package name.
     */
    name: string

    /**
     * Voice package version or source reference.
     */
    version: string
  }

  /**
   * Indicates that the server is a NodeLink instance.
   */
  isNodelink: true

  /**
   * Enabled source manager identifiers.
   */
  sourceManagers: string[]

  /**
   * Enabled audio filter identifiers.
   */
  filters: string[]

  /**
   * Loaded plugin metadata list.
   */
  plugins: InfoPluginResponse[]
}

/**
 * Creates a strongly typed runtime view for the info endpoint.
 *
 * The route depends on fields that are present on the concrete NodeLink
 * runtime but omitted from the smaller router-facing interface. This helper
 * validates the required fields before exposing the richer contract.
 *
 * @param nodelink - Router-facing runtime instance.
 * @returns A strongly typed info runtime when all required fields are present;
 * otherwise `null`.
 */
function getInfoRuntime(nodelink: ApiNodelinkServer): InfoRouteRuntime | null {
  const runtime = nodelink as Partial<InfoRouteRuntime>

  if (typeof runtime.version !== 'string') {
    return null
  }

  if (
    !runtime.gitInfo ||
    typeof runtime.gitInfo.branch !== 'string' ||
    typeof runtime.gitInfo.commit !== 'string' ||
    typeof runtime.gitInfo.commitTime !== 'number'
  ) {
    return null
  }

  if (typeof runtime.getSourcesFromWorker !== 'function') {
    return null
  }

  if (!('supportedSourcesCache' in runtime)) {
    return null
  }

  if (!('workerManager' in runtime)) {
    return null
  }

  if (!('sources' in runtime)) {
    return null
  }

  if (!('pluginManager' in runtime)) {
    return null
  }

  return runtime as InfoRouteRuntime
}

/**
 * Normalizes the parsed semantic version object returned by `getVersion`.
 *
 * The shared utility currently returns a broad union even when the caller
 * explicitly requests the object form, so this helper provides a precise
 * `SemverInfo` result for route serialization.
 *
 * @returns Parsed semantic version object, or a zeroed fallback when parsing
 * fails.
 */
function getParsedSemver(): SemverInfo {
  const version = getVersion('object')

  if (version && typeof version !== 'string') {
    return version
  }

  return {
    major: 0,
    minor: 0,
    patch: 0,
    prerelease: [],
    build: []
  }
}

/**
 * Extracts the names of filters enabled in configuration.
 *
 * @param enabledFilters - Filter flag registry from configuration.
 * @returns Alphabetically stable list of enabled filter identifiers based on
 * insertion order from the configuration object.
 */
function getEnabledFilterNames(
  enabledFilters: InfoFilterFlags | undefined
): string[] {
  if (!enabledFilters) {
    return []
  }

  return Object.keys(enabledFilters).filter(
    (filterName) => enabledFilters[filterName] === true
  )
}

/**
 * Resolves the list of source manager identifiers exposed by the runtime.
 *
 * In cluster mode the information is fetched from a worker and cached on the
 * runtime. In single-process mode the names are read directly from the local
 * source manager registry.
 *
 * @param nodelink - Strongly typed info runtime.
 * @returns Promise resolving to the list of enabled source manager names.
 */
async function getSourceManagers(
  nodelink: InfoRouteRuntime
): Promise<string[]> {
  if (nodelink.workerManager) {
    if (nodelink.supportedSourcesCache) {
      return nodelink.supportedSourcesCache
    }

    const sourceManagers = await nodelink.getSourcesFromWorker()
    nodelink.supportedSourcesCache = sourceManagers
    return sourceManagers
  }

  if (!nodelink.sources) {
    return []
  }

  return Array.from(nodelink.sources.sources.keys())
}

/**
 * Serializes loaded plugin metadata for the info response payload.
 *
 * @param pluginManager - Plugin manager instance, when available.
 * @returns Stable array containing the public metadata for each loaded plugin.
 */
function getPlugins(
  pluginManager: InfoPluginManager | null
): InfoPluginResponse[] {
  if (!pluginManager) {
    return []
  }

  return Array.from(pluginManager.loadedPlugins.values()).map((plugin) => ({
    name: plugin.name,
    version: plugin.meta?.version ?? '0.0.0',
    author: plugin.meta?.author ?? null,
    path: plugin.path || null
  }))
}

/**
 * Builds the full payload returned by the info endpoint.
 *
 * @param nodelink - Strongly typed info runtime.
 * @returns Promise resolving to the serialized info payload.
 */
async function buildInfoResponse(
  nodelink: InfoRouteRuntime
): Promise<InfoResponse> {
  return {
    version: {
      semver: nodelink.version,
      ...getParsedSemver()
    },
    buildTime: nodelink.gitInfo.commitTime,
    git: nodelink.gitInfo,
    node: process.version,
    voice: {
      name: '@performanc/voice',
      version: 'github:PerformanC/voice'
    },
    isNodelink: true,
    sourceManagers: await getSourceManagers(nodelink),
    filters: getEnabledFilterNames(nodelink.options.filters?.enabled),
    plugins: getPlugins(nodelink.pluginManager)
  }
}

/**
 * Handles requests for the public server information endpoint.
 *
 * The endpoint returns build metadata, runtime version information, enabled
 * filters, active source managers, and the list of loaded plugins.
 *
 * @param nodelink - Router-facing NodeLink runtime.
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @param sendResponse - Helper responsible for JSON serialization and headers.
 * @returns Promise that resolves once the payload has been written.
 */
async function handler(
  nodelink: ApiNodelinkServer,
  req: ApiRequest,
  res: ApiResponse,
  sendResponse: ApiSendResponse
): Promise<void> {
  const runtime = getInfoRuntime(nodelink)

  if (!runtime) {
    sendResponse(
      req,
      res,
      {
        timestamp: Date.now(),
        status: 500,
        error: 'Internal Server Error',
        message: 'Info runtime contract is incomplete.',
        path: req.url ?? '/v4/info'
      },
      500
    )
    return
  }

  const response = await buildInfoResponse(runtime)
  sendResponse(req, res, response, 200)
}

/**
 * Route module definition for the server information endpoint.
 */
const infoRoute: ApiRouteModule = {
  handler
}

export default infoRoute
