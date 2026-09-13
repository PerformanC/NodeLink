import { logger } from '../utils.ts'

export type ProxyProtocol = 'http' | 'https' | 'socks4' | 'socks5'

export interface ProxyTarget {
  id: string
  url: string
  protocol: ProxyProtocol
  type: 'forward' | 'reverse'
  username?: string
  password?: string
  host: string
  port: number
}

export interface ProxyHealthState {
  status: 'UP' | 'DOWN' | 'COOLDOWN'
  consecutiveFailures: number
  totalFailures: number
  totalSuccesses: number
  activeConnections: number
  movingAverageLatency: number
  lastFailureAt: number | null
  lastSuccessAt: number | null
  cooldownEndsAt: number | null
}

export interface ProxySnapshot {
  target: ProxyTarget
  state: ProxyHealthState
}

export type ProxyStrategy =
  | 'RoundRobin'
  | 'LeastConnections'
  | 'LowestLatency'
  | 'WeightedHealth'

export interface ProxyManagerConfig {
  enabled: boolean
  strategy: ProxyStrategy
  disabledSources: string[]
  maxConsecutiveFailures: number
  cooldownDurationMs: number
  latencyWeight: number
}

const DEFAULT_CONFIG: ProxyManagerConfig = {
  enabled: false,
  strategy: 'WeightedHealth',
  disabledSources: [],
  maxConsecutiveFailures: 3,
  cooldownDurationMs: 60 * 1000 * 5, // 5 minutes
  latencyWeight: 0.2 // EMA alpha
}

const isRecord = (val: unknown): val is Record<string, unknown> =>
  typeof val === 'object' && val !== null && !Array.isArray(val)

export default class ProxyManager {
  private readonly config: ProxyManagerConfig
  private readonly targets: Map<string, ProxyTarget>
  private readonly states: Map<string, ProxyHealthState>
  private roundRobinIndex: number = 0

  constructor(options: Record<string, unknown>) {
    this.targets = new Map()
    this.states = new Map()

    const network = isRecord(options.network) ? options.network : {}
    const rawConfig = isRecord(network.proxy) ? network.proxy : {}
    this.config = this.parseConfig(rawConfig)

    this.extractTargets(rawConfig, options)
  }

  /**
   * Evaluates if a given source is allowed to use proxies.
   */
  public isEnabledForSource(sourceName: string): boolean {
    if (!this.config.enabled) return false
    if (this.config.disabledSources.includes(sourceName.toLowerCase()))
      return false
    return this.targets.size > 0
  }

  /**
   * Selects the most optimal proxy based on the configured Load Balancing strategy.
   * Employs a Circuit Breaker pattern to avoid dead proxies.
   *
   * @param sourceName - The identifier of the requesting source (e.g. 'youtube', 'bilibili')
   * @returns A safe snapshot of the selected proxy, or `undefined` if none available.
   */
  public getBestProxy(sourceName: string): ProxySnapshot | undefined {
    if (!this.isEnabledForSource(sourceName)) return undefined

    this.processCooldowns()

    const availableIds = Array.from(this.states.entries())
      .filter(([_, state]) => state.status === 'UP')
      .map(([id]) => id)

    if (availableIds.length === 0) {
      logger(
        'warn',
        'ProxyManager',
        `No healthy proxies available for source '${sourceName}'. All proxies are DOWN or in COOLDOWN.`
      )
      return undefined
    }

    let selectedId: string | undefined

    switch (this.config.strategy) {
      case 'RoundRobin':
        selectedId = this.selectRoundRobin(availableIds)
        break
      case 'LeastConnections':
        selectedId = this.selectLeastConnections(availableIds)
        break
      case 'LowestLatency':
        selectedId = this.selectLowestLatency(availableIds)
        break
      case 'WeightedHealth':
        selectedId = this.selectWeightedHealth(availableIds)
        break
      default:
        selectedId = this.selectWeightedHealth(availableIds)
    }

    if (!selectedId) return undefined

    const state = this.states.get(selectedId)
    const target = this.targets.get(selectedId)

    if (!state || !target) return undefined

    state.activeConnections++

    return {
      target: { ...target },
      state: { ...state }
    }
  }

  /**
   * Reports the resolution of a request utilizing a proxy.
   * Updates health metrics, calculates exponential moving average latency,
   * and trips the circuit breaker if thresholds are met.
   */
  public report(
    proxyUrl: string,
    success: boolean,
    statusCode: number,
    latencyMs: number = 0
  ): void {
    const id = this.findIdByUrl(proxyUrl)
    if (!id) return

    const state = this.states.get(id)
    if (!state) return

    if (state.activeConnections > 0) {
      state.activeConnections--
    }

    if (success) {
      this.handleSuccess(state, latencyMs)
    } else {
      this.handleFailure(state, statusCode)
    }
  }

  /**
   * Allows adding dynamic proxies in runtime.
   */
  public addProxy(url: string, protocol: ProxyProtocol = 'http'): void {
    try {
      const parsed = this.parseProxyUrl(url, protocol)
      if (!this.targets.has(parsed.id)) {
        this.targets.set(parsed.id, parsed)
        this.states.set(parsed.id, this.createInitialState())
        logger(
          'info',
          'ProxyManager',
          `Dynamically added proxy: ${parsed.host}:${parsed.port}`
        )
      }
    } catch (err) {
      logger(
        'error',
        'ProxyManager',
        `Failed to add proxy ${url}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Cleans up proxy manager resources.
   */
  public destroy(): void {
    this.targets.clear()
    this.states.clear()
  }

  private handleSuccess(state: ProxyHealthState, latencyMs: number): void {
    state.totalSuccesses++
    state.consecutiveFailures = 0
    state.lastSuccessAt = Date.now()

    if (latencyMs > 0) {
      if (state.movingAverageLatency === 0) {
        state.movingAverageLatency = latencyMs
      } else {
        const alpha = this.config.latencyWeight
        state.movingAverageLatency =
          alpha * latencyMs + (1 - alpha) * state.movingAverageLatency
      }
    }

    if (state.status === 'DOWN' || state.status === 'COOLDOWN') {
      state.status = 'UP'
      state.cooldownEndsAt = null
    }
  }

  private handleFailure(state: ProxyHealthState, statusCode: number): void {
    state.totalFailures++
    state.consecutiveFailures++
    state.lastFailureAt = Date.now()

    // Status code severity analysis
    let failureWeight = 1
    if (statusCode === 403 || statusCode === 429) {
      failureWeight = 3 // Severe rate limit or ban
    } else if (statusCode >= 500) {
      failureWeight = 2 // Server side error
    }

    state.consecutiveFailures += failureWeight - 1

    if (state.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      this.tripCircuitBreaker(state)
    }
  }

  private tripCircuitBreaker(state: ProxyHealthState): void {
    state.status = 'COOLDOWN'
    state.cooldownEndsAt = Date.now() + this.config.cooldownDurationMs
    logger(
      'warn',
      'ProxyManager',
      `Circuit breaker tripped for proxy. Cooling down for ${this.config.cooldownDurationMs / 1000}s.`
    )
  }

  private processCooldowns(): void {
    const now = Date.now()
    for (const state of this.states.values()) {
      if (
        state.status === 'COOLDOWN' &&
        state.cooldownEndsAt &&
        now >= state.cooldownEndsAt
      ) {
        // Half-open state: transition back to UP to test it. If it fails once, it will trip again quickly.
        state.status = 'UP'
        state.cooldownEndsAt = null
        // We reduce consecutive failures so it gets one more chance before tripping again
        state.consecutiveFailures = Math.max(
          0,
          this.config.maxConsecutiveFailures - 1
        )
        logger(
          'info',
          'ProxyManager',
          'Proxy exited cooldown and is entering half-open state.'
        )
      }
    }
  }

  private selectRoundRobin(availableIds: string[]): string {
    if (this.roundRobinIndex >= availableIds.length) {
      this.roundRobinIndex = 0
    }
    const selected = availableIds[this.roundRobinIndex]
    this.roundRobinIndex = (this.roundRobinIndex + 1) % availableIds.length
    return selected || availableIds[0] || ''
  }

  private selectLeastConnections(availableIds: string[]): string {
    return availableIds.reduce((prevId, currId) => {
      const prevConnections = this.states.get(prevId)?.activeConnections ?? 0
      const currConnections = this.states.get(currId)?.activeConnections ?? 0
      return currConnections < prevConnections ? currId : prevId
    })
  }

  private selectLowestLatency(availableIds: string[]): string {
    return availableIds.reduce((prevId, currId) => {
      const prevLatency =
        this.states.get(prevId)?.movingAverageLatency || Infinity
      const currLatency =
        this.states.get(currId)?.movingAverageLatency || Infinity

      // If both are 0 (untested), fallback to random or first
      if (prevLatency === Infinity && currLatency === Infinity) return prevId

      return currLatency < prevLatency ? currId : prevId
    })
  }

  private selectWeightedHealth(availableIds: string[]): string {
    // Sort by a composite score: (failures * high_penalty) + (active_connections * medium_penalty) + latency
    const sorted = [...availableIds].sort((a, b) => {
      const stateA = this.states.get(a)
      const stateB = this.states.get(b)

      if (!stateA || !stateB) return 0

      const scoreA =
        stateA.consecutiveFailures * 1000 +
        stateA.activeConnections * 100 +
        (stateA.movingAverageLatency || 500)

      const scoreB =
        stateB.consecutiveFailures * 1000 +
        stateB.activeConnections * 100 +
        (stateB.movingAverageLatency || 500)

      return scoreA - scoreB
    })

    // Pick from the top 3 randomly to distribute load while still preferring healthy proxies
    const poolSize = Math.min(3, sorted.length)
    const randomIndex = Math.floor(Math.random() * poolSize)
    return sorted[randomIndex] || availableIds[0] || ''
  }

  private findIdByUrl(url: string): string | undefined {
    for (const [id, target] of this.targets.entries()) {
      if (target.url === url) return id
    }
    return undefined
  }

  private parseConfig(raw: Record<string, unknown>): ProxyManagerConfig {
    const disabledSourcesCandidate = Array.isArray(raw.disabledSources)
      ? raw.disabledSources
          .filter((s) => typeof s === 'string')
          .map((s) => (s as string).toLowerCase())
      : DEFAULT_CONFIG.disabledSources

    let strategy = DEFAULT_CONFIG.strategy
    if (typeof raw.strategy === 'string') {
      const s = raw.strategy as ProxyStrategy
      if (
        [
          'RoundRobin',
          'LeastConnections',
          'LowestLatency',
          'WeightedHealth'
        ].includes(s)
      ) {
        strategy = s
      }
    }

    return {
      enabled:
        typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_CONFIG.enabled,
      strategy,
      disabledSources: disabledSourcesCandidate,
      maxConsecutiveFailures:
        typeof raw.maxConsecutiveFailures === 'number'
          ? raw.maxConsecutiveFailures
          : DEFAULT_CONFIG.maxConsecutiveFailures,
      cooldownDurationMs:
        typeof raw.cooldownDurationMs === 'number'
          ? raw.cooldownDurationMs
          : DEFAULT_CONFIG.cooldownDurationMs,
      latencyWeight:
        typeof raw.latencyWeight === 'number'
          ? raw.latencyWeight
          : DEFAULT_CONFIG.latencyWeight
    }
  }

  private extractTargets(
    rawConfig: Record<string, unknown>,
    fullOptions: Record<string, unknown>
  ): void {
    // 1. Check global proxy object (single)
    if (typeof rawConfig.url === 'string' && rawConfig.url.length > 0) {
      try {
        const parsed = this.parseProxyUrl(
          rawConfig.url,
          (rawConfig.protocol as string) || 'http',
          rawConfig.username as string,
          rawConfig.password as string,
          rawConfig.type as string
        )
        this.targets.set(parsed.id, parsed)
      } catch (err) {
        logger(
          'error',
          'ProxyManager',
          `Invalid global proxy URL: ${getErrorMessage(err)}`
        )
      }
    }

    // 2. Check global proxy list
    if (Array.isArray(rawConfig.list)) {
      for (const item of rawConfig.list) {
        try {
          if (typeof item === 'string') {
            const parsed = this.parseProxyUrl(item)
            this.targets.set(parsed.id, parsed)
          } else if (isRecord(item) && typeof item.url === 'string') {
            const parsed = this.parseProxyUrl(
              item.url,
              item.protocol as string,
              item.username as string,
              item.password as string,
              item.type as string
            )
            this.targets.set(parsed.id, parsed)
          }
        } catch (err) {
          logger(
            'error',
            'ProxyManager',
            `Invalid proxy in list: ${getErrorMessage(err)}`
          )
        }
      }
    }

    // 3. Fallback: Migrate old YouTube proxies into the global pool if global list is empty
    if (this.targets.size === 0) {
      const sources = isRecord(fullOptions.sources) ? fullOptions.sources : {}
      const yt = isRecord(sources.youtube) ? sources.youtube : {}

      if (Array.isArray(yt.proxies)) {
        for (const item of yt.proxies) {
          try {
            if (typeof item === 'string') {
              const parsed = this.parseProxyUrl(item)
              this.targets.set(parsed.id, parsed)
            } else if (isRecord(item) && typeof item.url === 'string') {
              const parsed = this.parseProxyUrl(
                item.url,
                undefined,
                undefined,
                undefined,
                item.type as string
              )
              this.targets.set(parsed.id, parsed)
            }
          } catch (err) {
            logger(
              'error',
              'ProxyManager',
              `Invalid youtube fallback proxy: ${getErrorMessage(err)}`
            )
          }
        }
      }

      // If we inherited proxies from youtube, implicitly enable the global manager
      if (this.targets.size > 0 && typeof rawConfig.enabled !== 'boolean') {
        this.config.enabled = true
        logger(
          'info',
          'ProxyManager',
          `Automatically enabled global ProxyManager using inherited YouTube proxies. (${this.targets.size} found)`
        )
      }
    }

    for (const id of this.targets.keys()) {
      this.states.set(id, this.createInitialState())
    }
  }

  private parseProxyUrl(
    urlString: string,
    defaultProtocol = 'http',
    explicitUsername?: string,
    explicitPassword?: string,
    explicitType?: string
  ): ProxyTarget {
    let toParse = urlString
    if (!toParse.includes('://')) {
      toParse = `${defaultProtocol}://${toParse}`
    }

    const url = new URL(toParse)

    let protocol = url.protocol.replace(':', '') as ProxyProtocol
    if (!['http', 'https', 'socks4', 'socks5'].includes(protocol)) {
      protocol = 'http'
    }

    const username =
      explicitUsername ||
      (url.username ? decodeURIComponent(url.username) : undefined)
    const password =
      explicitPassword ||
      (url.password ? decodeURIComponent(url.password) : undefined)
    const host = url.hostname
    const port = url.port
      ? parseInt(url.port, 10)
      : protocol === 'https'
        ? 443
        : 80
    const typeStr = explicitType === 'reverse' ? 'reverse' : 'forward'

    const id = `${protocol}://${host}:${port}`

    return {
      id,
      url: toParse,
      protocol,
      type: typeStr as 'forward' | 'reverse',
      host,
      port,
      username,
      password
    }
  }

  private createInitialState(): ProxyHealthState {
    return {
      status: 'UP',
      consecutiveFailures: 0,
      totalFailures: 0,
      totalSuccesses: 0,
      activeConnections: 0,
      movingAverageLatency: 0,
      lastFailureAt: null,
      lastSuccessAt: null,
      cooldownEndsAt: null
    }
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
