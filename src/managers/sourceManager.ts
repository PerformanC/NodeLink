import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parentPort } from 'node:worker_threads'
import type {
  FeatureToggle,
  NodelinkConfig,
  SourceConfigBase,
  SourcesRegistry
} from '../typings/config/config.types.ts'
import type {
  SourceManagerLike,
  TrackFormat,
  TrackInfoExtended
} from '../typings/playback/player.types.ts'
import type {
  PlaylistData,
  SourceHealthMetricMessage,
  SourceHealthMetricPayload,
  SourceInstance,
  SourceResult,
  TrackCacheManager,
  TrackData,
  TrackInfo,
  TrackStreamResult,
  TrackUrlResult
} from '../typings/sources/source.types.ts'
import type {
  SourceTestCase,
  SourceTestMatcher
} from '../typings/sources/test.types.ts'
import { getBestMatch, logger } from '../utils.ts'

/**
 * Context object required by the SourcesManager for operation.
 * @public
 */
export interface SourcesManagerContext {
  /** Global NodeLink configuration options. */
  options: NodelinkConfig
  /** Global statistics manager for metric recording. */
  statsManager?: {
    /** Increments success counter for a specific source. */
    incrementSourceSuccess?: (source: string) => void
    /** Increments failure counter for a specific source. */
    incrementSourceFailure?: (source: string) => void
    /** Records an occurrences of a playback event. */
    incrementPlaybackEvent?: (event: string) => void
  }
  /** Global credential manager for token persistence. */
  credentialManager?: {
    /** Retrieves a stored credential. */
    get: <T = unknown>(key: string) => T | null
    /** Stores a credential with an optional TTL. */
    set: (key: string, value: unknown, ttlMs?: number) => void
  } | null
  /** Optional disk-backed track cache. */
  trackCacheManager?: TrackCacheManager | null
  /** Optional route planner for outbound IP rotation. */
  routePlanner?: {
    /** Returns an available local IP address. */
    getIP?: () => string | null | undefined
  }
  /** Opaque worker manager reference. */
  workerManager?: unknown
  /** Opaque specialized source worker manager reference. */
  sourceWorkerManager?: unknown
  /** Global plugin manager for hook execution. */
  pluginManager?: import('./pluginManager.ts').default | null
  /** Global source health and observability manager. */
  sourceHealthManager?: import('./sourceHealthManager.ts').default | null
}

/**
 * Local interface for dynamically imported source modules.
 * @internal
 */
interface SourceModule {
  /** The default class constructor for the source. */
  default?: new (
    ctx: SourcesManagerContext
  ) => SourceInstance
}

interface SourceTestProvider {
  readonly _TESTS?: readonly SourceTestCase[]
}

/**
 * Central manager for audio source providers.
 * Handles source discovery, dynamic loading, and request routing based on URL patterns or aliases.
 * @public
 */
export default class SourcesManager implements SourceManagerLike {
  /** Source instances active in the current track URL resolution chain. */
  private readonly resolvingSources = new AsyncLocalStorage<
    ReadonlySet<SourceInstance>
  >()
  /** Reverse lookup of registered source instances to their primary key. */
  private readonly instanceKeys = new WeakMap<SourceInstance, string>()
  /** The parent NodeLink instance context. */
  public nodelink: SourcesManagerContext
  /** Map of primary source instances keyed by their unique identifier. */
  public sources: Map<string, SourceInstance>
  /** Unified map of all source aliases and identifiers. */
  public sourceMap: Map<string, SourceInstance>
  /** Map of search-specific aliases (e.g., 'ytsearch'). */
  public searchAliasMap: Map<string, SourceInstance>
  /** Prioritized list of URL patterns for routing. */
  public patternMap: PatternEntry[]

  /**
   * Constructs a new SourcesManager.
   * @param nodelink - The NodeLink server/worker context.
   */
  constructor(nodelink: SourcesManagerContext) {
    this.nodelink = nodelink
    this.sources = new Map()
    this.sourceMap = new Map()
    this.searchAliasMap = new Map()
    this.patternMap = []
  }

  /**
   * Scans the sources directory and dynamically loads all enabled providers.
   * Clears existing state before loading.
   * @returns A promise resolving when loading is complete.
   * @public
   */
  public async loadFolder(): Promise<void> {
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = path.dirname(__filename)
    const sourcesDir = path.join(__dirname, '../sources')

    this.sources.clear()
    this.sourceMap.clear()
    this.searchAliasMap.clear()
    this.patternMap = []

    const processSource = async (
      name: string,
      mod: Record<string, unknown>
    ): Promise<void> => {
      const isYouTube = name === 'youtube' || name.includes('YouTube.ts')
      const sourceKey = isYouTube ? 'youtube' : name
      const sourceConfig = this.nodelink.options.sources

      const enabled = sourceConfig[sourceKey as keyof SourcesRegistry]?.enabled

      if (!enabled) return

      const importedModule = mod as SourceModule
      const Mod = importedModule.default
      if (!Mod) {
        logger(
          'warn',
          'Sources',
          `Invalid source module export for: ${sourceKey}`
        )
        return
      }
      const instance = new Mod(this.nodelink)

      if (instance.setup && (await instance.setup())) {
        this.sources.set(sourceKey, instance)
        this.sourceMap.set(sourceKey, instance)
        this.instanceKeys.set(instance, sourceKey)

        if (Array.isArray(instance.additionalsSourceName)) {
          for (const addName of instance.additionalsSourceName) {
            this.sourceMap.set(addName, instance)
          }
        }

        if (Array.isArray(instance.searchTerms)) {
          for (const term of instance.searchTerms) {
            this.searchAliasMap.set(term, instance)
          }
        }

        if (Array.isArray(instance.recommendationTerm)) {
          for (const term of instance.recommendationTerm) {
            this.searchAliasMap.set(term, instance)
          }
        }

        if (Array.isArray(instance.patterns)) {
          for (const regex of instance.patterns) {
            if (regex instanceof RegExp) {
              this.patternMap.push({
                regex,
                sourceName: sourceKey,
                priority: instance.priority || 0
              })
            }
          }
        }
        this.nodelink.sourceHealthManager?.registerSource(sourceKey)
        logger('info', 'Sources', `Loaded source: ${sourceKey}`)
      }
    }

    try {
      await fs.access(sourcesDir)

      const sources = this.nodelink.options.sources
      const enabledSourceKeys = Object.keys(sources)
        .filter((key) => {
          const config = sources[key] as
            | SourceConfigBase
            | FeatureToggle
            | undefined
          return config?.enabled
        })
        .map((key) => key.toLowerCase())

      const uniqueEnabled = Array.from(new Set(enabledSourceKeys))
      const sourceEntries = uniqueEnabled.map((sourceKey) => {
        const fileCandidates =
          sourceKey === 'youtube'
            ? [
                path.join(sourcesDir, 'youtube', 'YouTube.ts'),
                path.join(sourcesDir, 'youtube', 'YouTube.js')
              ]
            : [
                path.join(sourcesDir, `${sourceKey}.ts`),
                path.join(sourcesDir, `${sourceKey}.js`)
              ]
        return { sourceKey, fileCandidates }
      })

      await Promise.all(
        sourceEntries.map(async ({ sourceKey, fileCandidates }) => {
          let filePath: string | null = null

          for (const candidatePath of fileCandidates) {
            try {
              await fs.access(candidatePath)
              filePath = candidatePath
              break
            } catch {}
          }

          if (!filePath) {
            logger(
              'warn',
              'Sources',
              `Enabled source "${sourceKey}" has no entry file at ${fileCandidates[0]} or ${fileCandidates[1]}`
            )
            return
          }

          try {
            const fileUrl = new URL(`file://${filePath.replace(/\\/g, '/')}`)
            const mod = await import(fileUrl.href)
            await processSource(sourceKey, mod as Record<string, unknown>)
          } catch (e) {
            logger(
              'error',
              'Sources',
              `Failed to load source "${sourceKey}": ${(e as Error).message}`
            )
          }
        })
      )
    } catch (e) {
      logger(
        'error',
        'Sources',
        `Error loading sources: ${(e as Error).message}`
      )
    }

    this.patternMap.sort(
      (a: PatternEntry, b: PatternEntry) => b.priority - a.priority
    )
  }

  /** Runs one bounded, declarative source test without downloading or decoding audio. */
  public async runHealthProbe(sourceName: string): Promise<void> {
    const instance = this.sources.get(sourceName)
    if (!instance) throw new Error(`Source "${sourceName}" is not loaded`)

    const cases = (instance.constructor as SourceTestProvider)._TESTS ?? []
    const testCase = cases.find(
      (candidate) =>
        !candidate.skip &&
        !candidate.matrix &&
        !candidate.expect.stream?.required
    )
    if (!testCase)
      throw new Error(
        `Source "${sourceName}" has no lightweight declarative test`
      )

    const operation = async (): Promise<SourceResult> => {
      if (testCase.input.type === 'search') {
        if (!instance.search)
          throw new Error('Test requires unsupported search operation')
        return instance.search(
          testCase.input.value,
          sourceName,
          testCase.input.searchType
        )
      }
      if (!instance.resolve)
        throw new Error('Test requires unsupported resolve operation')
      return instance.resolve(testCase.input.value)
    }

    let timeout: NodeJS.Timeout | undefined
    const result = await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Declarative source check timed out')),
          5000
        )
        timeout.unref?.()
      })
    ]).finally(() => {
      if (timeout) clearTimeout(timeout)
    })
    if (result.loadType === 'error') throw new Error(result.exception.message)
    if (result.loadType === 'empty') throw new Error('Test returned empty')

    const expected = testCase.expect.result.type
    const actual =
      result.loadType === 'track' || result.loadType === 'episode'
        ? 'track'
        : result.loadType === 'search'
          ? 'search'
          : 'playlist'
    if (expected !== actual) {
      throw new Error(`Declarative test expected ${expected}, got ${actual}`)
    }

    const minimum = testCase.expect.collection?.minItems ?? 1
    const count =
      result.loadType === 'search'
        ? result.data.length
        : result.loadType === 'track' || result.loadType === 'episode'
          ? 1
          : (result.data as PlaylistData).tracks.length
    if (count < minimum)
      throw new Error(
        `Test returned ${count} items; expected at least ${minimum}`
      )

    const primaryTrack =
      result.loadType === 'track' || result.loadType === 'episode'
        ? result.data.info
        : result.loadType === 'search'
          ? result.data[0]?.info
          : (result.data as PlaylistData).tracks[0]?.info
    if (testCase.expect.metadata && !primaryTrack) {
      throw new Error('Test returned no track metadata to validate')
    }
    for (const [key, matcher] of Object.entries(
      testCase.expect.metadata ?? {}
    ) as [keyof TrackInfo, SourceTestMatcher][]) {
      const actual = primaryTrack?.[key]
      if (!this.matchesSourceTestValue(matcher, actual)) {
        throw new Error(
          `Test metadata assertion failed for "${key}" (got ${String(actual)})`
        )
      }
    }
  }

  private matchesSourceTestValue(
    matcher: SourceTestMatcher,
    actual: unknown
  ): boolean {
    switch (matcher.op) {
      case 'equals':
        return actual === matcher.value
      case 'not-equals':
        return actual !== matcher.value
      case 'matches':
      case 'not-matches': {
        const regex =
          matcher.value instanceof RegExp
            ? matcher.value
            : new RegExp(String(matcher.value), 'i')
        const matches = regex.test(String(actual ?? ''))
        return matcher.op === 'matches' ? matches : !matches
      }
      case 'between': {
        const value = Number(actual)
        return value >= matcher.min && value <= matcher.max
      }
      case 'at-least':
        return Number(actual) >= matcher.value
      case 'at-most':
        return Number(actual) <= matcher.value
      case 'exists': {
        const exists = actual !== undefined && actual !== null && actual !== ''
        return exists === matcher.value
      }
    }
  }

  /** Returns enabled providers with a declarative case suitable for a lightweight check. */
  public getHealthProbeSources(): string[] {
    return Array.from(this.sources.entries())
      .filter(([, instance]) =>
        (instance.constructor as SourceTestProvider)._TESTS?.some(
          (testCase) =>
            !testCase.skip &&
            !testCase.matrix &&
            !testCase.expect.stream?.required
        )
      )
      .map(([name]) => name)
  }

  /**
   * Reports an execution metric to the SourceHealthManager or forwards it via IPC.
   * @param sourceName - Source identifier.
   * @param success - Whether the call succeeded.
   * @param duration - Call duration in milliseconds.
   * @param error - Optional error message or object.
   * @param httpStatus - Optional HTTP status code.
   * @private
   */
  private _reportHealthMetric(
    sourceName: string,
    success: boolean,
    duration: number,
    error?: unknown,
    httpStatus?: number | null
  ): void {
    const healthSourceName = sourceName === 'ytmusic' ? 'youtube' : sourceName
    const healthManager = this.nodelink.sourceHealthManager
    if (healthManager) {
      if (success) {
        healthManager.recordSuccess(healthSourceName, duration)
      } else {
        healthManager.recordFailure(healthSourceName, duration, error)
      }
      return
    }

    const errorMsg =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : error
            ? String(error)
            : undefined

    const payload: SourceHealthMetricPayload = {
      sourceName: healthSourceName,
      success,
      duration,
      error: errorMsg,
      httpStatus
    }

    if (parentPort) {
      const msg: SourceHealthMetricMessage = {
        type: 'sourceHealthMetric',
        payload
      }
      parentPort.postMessage(msg)
      return
    }

    process.send?.({
      type: 'sourceHealthMetric',
      payload
    })
  }

  /**
   * Executes a source method with metric tracking and error handling.
   * @param sourceName - The identifier of the source to call.
   * @param method - The method name.
   * @param args - Arguments to pass to the method.
   * @returns A promise resolving to the SourceResult.
   * @internal
   */
  private async _instrumentedSourceCall(
    sourceName: string,
    method: 'search' | 'resolve' | 'getChapters' | 'loadStream',
    ...args: unknown[]
  ): Promise<SourceResult> {
    const instance = this.sourceMap.get(sourceName)
    if (
      !instance ||
      typeof (instance as Record<string, unknown>)[method] !== 'function'
    ) {
      this.nodelink.statsManager?.incrementSourceFailure?.(
        sourceName || 'unknown'
      )
      throw new Error(
        `Source ${sourceName} not found or does not support ${method}`
      )
    }

    const start = performance.now()

    try {
      const fn = (instance as Record<string, unknown>)[method] as
        | ((...a: unknown[]) => Promise<SourceResult>)
        | undefined
      if (!fn) {
        throw new Error(`Method ${method} not found on source ${sourceName}`)
      }
      const result = await fn.apply(instance, args)
      const duration = Math.round(performance.now() - start)

      if (result.loadType === 'search') {
        for (const track of result.data) track.userData ??= {}
      } else if (result.loadType === 'track' || result.loadType === 'episode') {
        result.data.userData ??= {}
      } else if (
        result.loadType !== 'empty' &&
        result.loadType !== 'error' &&
        'tracks' in result.data
      ) {
        for (const track of result.data.tracks) track.userData ??= {}
      }

      if (result.loadType === 'error') {
        this.nodelink.statsManager?.incrementSourceFailure?.(sourceName)
        this._reportHealthMetric(
          sourceName,
          false,
          duration,
          result.exception?.message ?? 'Source returned error loadType'
        )
      } else {
        this.nodelink.statsManager?.incrementSourceSuccess?.(sourceName)
        this._reportHealthMetric(sourceName, true, duration)
      }
      return result
    } catch (e) {
      const duration = Math.round(performance.now() - start)
      this.nodelink.statsManager?.incrementSourceFailure?.(sourceName)
      this._reportHealthMetric(sourceName, false, duration, e)
      throw e
    }
  }

  /**
   * Performs a search using a specific source or alias.
   * @param sourceTerm - The source name or alias (e.g., 'ytsearch').
   * @param query - The search query.
   * @returns A promise resolving to a SourceResult.
   * @public
   */
  public async search(
    sourceTerm: string,
    query: string
  ): Promise<SourceResult> {
    let instance = this.searchAliasMap.get(sourceTerm)
    const sourceName = sourceTerm

    if (!instance) {
      instance = this.sourceMap.get(sourceTerm)
    }

    if (!instance) {
      throw new Error(`Source or search alias not found for: ${sourceTerm}`)
    }

    let searchType = 'track'
    let searchQuery = query

    if (query.includes(':')) {
      const parts = query.split(':')
      const possibleType = (parts[0] ?? '').toLowerCase()
      const types = ['playlist', 'artist', 'album', 'channel', 'track']

      if (types.includes(possibleType)) {
        searchType = possibleType
        searchQuery = parts.slice(1).join(':')
      }
    }

    const name =
      this.instanceKeys.get(instance) ??
      instance.constructor.name.replace('Source', '').toLowerCase()
    logger(
      'debug',
      'Sources',
      `Searching on ${name} (${searchType}) for: "${searchQuery}"`
    )

    this.nodelink.pluginManager?.callHook(
      'onSearch',
      searchQuery,
      sourceName,
      searchType
    )

    return this._instrumentedSourceCall(
      name,
      'search',
      searchQuery,
      sourceName,
      searchType
    )
  }

  /**
   * Searches using the configured default source(s) until results are found.
   * @param query - The search query.
   * @returns A promise resolving to a SourceResult.
   * @public
   */
  public async searchWithDefault(query: string): Promise<SourceResult> {
    const configuredDefaultSource = this.nodelink.options.search.defaultSource
    const defaultSources = Array.isArray(configuredDefaultSource)
      ? configuredDefaultSource
      : [configuredDefaultSource]
    const activeSources = this.resolvingSources.getStore()

    for (const source of defaultSources) {
      const instance =
        activeSources &&
        (this.searchAliasMap.get(source) ?? this.sourceMap.get(source))
      if (instance && activeSources.has(instance)) continue

      try {
        const result = await this.search(source as string, query)
        if (
          result.loadType === 'search' &&
          Array.isArray(result.data) &&
          result.data.length > 0
        ) {
          return result
        }
      } catch (e) {
        logger(
          'warn',
          'Sources',
          `Default source search failed for ${source}: ${(e as Error).message}`
        )
      }
    }

    return { loadType: 'empty', data: {} }
  }

  /**
   * Performs a concurrent search across multiple sources and consolidates the results into a playlist.
   * @param query - The search query.
   * @returns A promise resolving to a SourceResult.
   * @public
   */
  public async unifiedSearch(query: string): Promise<SourceResult> {
    const searchSources = this.nodelink.options.search.unifiedSources
    logger(
      'debug',
      'Sources',
      `Performing unified search for "${query}" on [${searchSources.join(', ')}]`
    )

    const searchPromises = searchSources.map((sourceName: string) =>
      this._instrumentedSourceCall(sourceName, 'search', query).catch((e) => {
        logger(
          'warn',
          'Sources',
          `A source (${sourceName}) failed during unified search: ${(e as Error).message}`
        )
        return {
          loadType: 'error',
          exception: { message: (e as Error).message, severity: 'common' }
        } as SourceResult
      })
    )

    const results = await Promise.all(searchPromises)

    const allTracks: TrackData[] = []
    for (const result of results) {
      if (result.loadType === 'search' && Array.isArray(result.data)) {
        allTracks.push(...result.data)
      }
    }

    if (allTracks.length === 0) {
      return { loadType: 'empty', data: {} }
    }

    const playlistData: PlaylistData = {
      info: {
        name: `Search results for: ${query}`,
        selectedTrack: -1
      },
      pluginInfo: {},
      tracks: allTracks
    }

    return {
      loadType: 'playlist',
      data: playlistData
    }
  }

  /**
   * Resolves a URL to a resource using the prioritized pattern map.
   * @param url - The resource URL.
   * @returns A promise resolving to a SourceResult.
   * @public
   */
  public async resolve(url: string): Promise<SourceResult> {
    let sourceName: string | null = null

    for (const entry of this.patternMap) {
      if (entry.regex.test(url)) {
        sourceName = entry.sourceName
        break
      }
    }

    if (
      !sourceName &&
      (url.startsWith('https://') || url.startsWith('http://'))
    ) {
      sourceName = 'http'
    }

    if (!sourceName || !this.sourceMap.has(sourceName)) {
      logger('warn', 'Sources', `No source found for URL: ${url}`)
      return {
        loadType: 'error',
        exception: {
          message: 'No source found for URL',
          severity: 'fault',
          cause: 'Unknown'
        }
      }
    }

    logger('debug', 'Sources', `Resolving with ${sourceName} for: ${url}`)

    this.nodelink.pluginManager?.callHook('onResolve', url, sourceName)

    return this._instrumentedSourceCall(sourceName, 'resolve', url)
  }

  /**
   * Reloads the source definitions from the file system.
   * @returns A promise resolving when reloading is complete.
   * @public
   */
  public async reload(): Promise<void> {
    await this.loadFolder()
  }

  /**
   * Retrieves a playable URL for a specific track.
   * @param track - The normalized track metadata.
   * @param itag - Optional YouTube-specific itag override.
   * @param isRecovering - Whether this is a recovery attempt.
   * @param isUpscaling - Whether this is an upscale attempt.
   * @returns A promise resolving to the URL result.
   * @public
   */
  public async getTrackUrl(
    track: TrackInfo | TrackInfoExtended,
    itag?: number,
    isRecovering?: boolean,
    isUpscaling?: boolean
  ): Promise<
    TrackUrlResult & {
      protocol?: string
      format?: TrackFormat
      trackInfo?: TrackInfoExtended
      additionalData?: Record<string, unknown>
    }
  > {
    const instance = this.sourceMap.get(track.sourceName)
    if (!instance?.getTrackUrl) {
      throw new Error(
        `Source ${track.sourceName} not found or does not support getTrackUrl`
      )
    }
    const sourceGetTrackUrl = instance.getTrackUrl

    const activeSources = this.resolvingSources.getStore()
    if (activeSources?.has(instance)) {
      return {
        exception: {
          message: `Circular track URL resolution detected for source ${track.sourceName}.`,
          severity: 'fault'
        }
      }
    }

    const nextActiveSources = new Set(activeSources).add(instance)

    return this.resolvingSources.run(nextActiveSources, async () => {
      // ISRC Upscale: If track has ISRC and is from YouTube, try high-quality sources first.
      if (
        track.isrc &&
        !isUpscaling &&
        !isRecovering &&
        (track.sourceName === 'youtube' || track.sourceName === 'ytmusic')
      ) {
        const hqSources = ['tidal', 'qobuz', 'applemusic', 'deezer']
        for (const source of hqSources) {
          const hqSource = this.sources.get(source)
          if (!hqSource || nextActiveSources.has(hqSource)) continue

          try {
            const searchResult = await this.search(source, track.isrc)
            if (
              searchResult.loadType === 'search' &&
              Array.isArray(searchResult.data) &&
              searchResult.data.length > 0
            ) {
              const match = getBestMatch(searchResult.data, track)
              if (match) {
                logger(
                  'info',
                  'Sources',
                  `ISRC Upscale: found match for ${track.isrc} on ${source}. Using high-quality source.`
                )
                return await this.getTrackUrl(
                  match.info,
                  undefined,
                  false,
                  true
                )
              }
            }
          } catch (e) {
            logger(
              'debug',
              'Sources',
              `ISRC Upscale attempt failed for ${source}: ${(e as Error).message}`
            )
          }
        }
      }

      const trackStart = performance.now()
      try {
        const urlResult = (await sourceGetTrackUrl.call(
          instance,
          track,
          itag,
          isRecovering
        )) as TrackUrlResult & {
          protocol?: string
          format?: TrackFormat
          trackInfo?: TrackInfoExtended
          additionalData?: Record<string, unknown>
        }
        const trackDuration = Math.round(performance.now() - trackStart)
        if (urlResult.exception) {
          this._reportHealthMetric(
            track.sourceName,
            false,
            trackDuration,
            urlResult.exception.message
          )
        } else {
          this._reportHealthMetric(track.sourceName, true, trackDuration)
        }
        return urlResult
      } catch (err) {
        const trackDuration = Math.round(performance.now() - trackStart)
        this._reportHealthMetric(track.sourceName, false, trackDuration, err)
        throw err
      }
    })
  }

  /**
   * Retrieves an audio stream for a resolved track URL.
   * @param track - The track metadata.
   * @param url - The resolved stream URL.
   * @param protocol - The stream protocol.
   * @param additionalData - Optional metadata for the stream.
   * @returns A promise resolving to the stream result.
   * @public
   */
  public async getTrackStream(
    track: TrackInfo | TrackInfoExtended,
    url: string,
    protocol?: string,
    additionalData?: Record<string, unknown>
  ): Promise<
    TrackStreamResult & { type?: string; exception?: { message: string } }
  > {
    const instance = this.sourceMap.get(track.sourceName)
    if (!instance?.loadStream) {
      throw new Error(
        `Source ${track.sourceName} not found or does not support loadStream`
      )
    }
    const normalizedAdditionalData = {
      ...(additionalData ?? {})
    } as Record<string, unknown> & { startTime?: number; position?: number }

    if (
      typeof normalizedAdditionalData.startTime === 'number' &&
      typeof normalizedAdditionalData.position !== 'number'
    ) {
      normalizedAdditionalData.position = normalizedAdditionalData.startTime
    }

    if (
      typeof normalizedAdditionalData.position === 'number' &&
      typeof normalizedAdditionalData.startTime !== 'number'
    ) {
      normalizedAdditionalData.startTime = normalizedAdditionalData.position
    }

    return (await instance.loadStream(
      track,
      url,
      protocol,
      normalizedAdditionalData
    )) as TrackStreamResult & { type?: string; exception?: { message: string } }
  }

  /**
   * Retrieves chapter metadata for a track.
   * @param track - Object containing the track metadata.
   * @returns A promise resolving to an array of chapters.
   * @public
   */
  public async getChapters(track: {
    info?: TrackInfo | TrackInfoExtended
  }): Promise<unknown[]> {
    const sourceName = track.info?.sourceName
    if (!sourceName) return []

    const instance = this.sourceMap.get(sourceName)
    if (
      !instance ||
      typeof instance.getChapters !== 'function' ||
      !track.info
    ) {
      return []
    }
    return await instance.getChapters(track.info)
  }

  /**
   * Returns a list of all unique source instances.
   * @returns Array of SourceInstance.
   * @public
   */
  public getAllSources(): SourceInstance[] {
    return Array.from(this.sources.values())
  }

  /**
   * Returns a specific source instance by its name.
   * @param name - The source identifier.
   * @returns The instance or null if not found.
   * @public
   */
  public getSource(name: string): SourceInstance | null {
    return this.sourceMap.get(name) || null
  }

  /**
   * Returns the identifiers of all currently enabled sources.
   * @returns Array of source name strings.
   * @public
   */
  public getEnabledSourceNames(): string[] {
    const enabledNames: string[] = []
    const sources = this.nodelink.options.sources
    if (sources) {
      for (const sourceName in sources) {
        if (sources[sourceName as keyof SourcesRegistry]?.enabled) {
          enabledNames.push(sourceName)
        }
      }
    }
    return enabledNames
  }
}

/**
 * Entry in the prioritized pattern map used for URL-to-source routing.
 * @internal
 */
interface PatternEntry {
  /** Compiled regular expression for matching. */
  regex: RegExp
  /** Unique identifier of the source to route to. */
  sourceName: string
  /** Numeric priority used for sorting (higher values matched first). */
  priority: number
}
