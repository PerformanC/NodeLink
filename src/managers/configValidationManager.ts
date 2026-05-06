import type { NodelinkConfig } from '../typings/config/config.types.ts'

type ValidationRule = {
  path: string
  expected: string
  value: unknown
  validate: (v: unknown) => boolean
}

type ValidationWarning = {
  path: string
  message: string
}

const KNOWN_PLACEHOLDERS = new Set([
  'your_token_here',
  'changeme',
  'change_me',
  'your-token-here',
  'insert_token_here',
  'placeholder',
  'PLACEHOLDER',
  'YOUR_TOKEN',
  'YOUR_API_KEY',
  'YOUR_CLIENT_ID',
  'YOUR_CLIENT_SECRET'
])

const VALID_AUDIO_QUALITIES = new Set(['high', 'medium', 'low', 'lowest'])
const VALID_RESAMPLING_QUALITIES = new Set([
  'best',
  'medium',
  'fastest',
  'zero',
  'linear'
])
const VALID_FADING_CURVES = new Set([
  'linear',
  'exponential',
  'sinusoidal',
  'start',
  'wash',
  'stop',
  'random',
  'baby'
])
const VALID_FADING_TYPES = new Set(['volume', 'tape', 'both', 'scratch'])
const VALID_VOICE_FORMATS = new Set(['opus', 'pcm_s16le'])
const VALID_ROUTE_STRATEGIES = new Set([
  'RotateOnBan',
  'RoundRobin',
  'LoadBalance'
])
const VALID_METRICS_AUTH_TYPES = new Set(['Bearer', 'Basic'])

export default class ConfigValidationManager {
  private warnings: ValidationWarning[] = []
  private options: NodelinkConfig

  constructor(options: NodelinkConfig) {
    this.options = options
  }

  validate(): void {
    this.warnings = []

    const allRules: ValidationRule[] = [
      ...this.validateServer(),
      ...this.validateCluster(),
      ...this.validateAudio(),
      ...this.validatePlayback(),
      ...this.validateSources(),
      ...this.validateSearch(),
      ...this.validateRoutePlanner(),
      ...this.validateRateLimit(),
      ...this.validateDosProtection(),
      ...this.validateLogging(),
      ...this.validateConnection(),
      ...this.validateVoiceReceive(),
      ...this.validateMix(),
      ...this.validateMetrics(),
      ...this.validateFilters()
    ]

    const errors: string[] = []
    for (const rule of allRules) {
      if (!rule.validate(rule.value)) {
        errors.push(
          `Configuration error:\n` +
            `- Property: ${rule.path}\n` +
            `- Received: ${JSON.stringify(rule.value)}\n` +
            `- Expected: ${rule.expected}`
        )
      }
    }

    if (this.warnings.length > 0) {
      const warningLines = this.warnings
        .map((w) => `  ⚠  ${w.path}: ${w.message}`)
        .join('\n')
      console.warn(`\n[NodeLink] Configuration warnings:\n${warningLines}\n`)
    }

    if (errors.length > 0) {
      throw new Error(`Configuration errors:\n\n${errors.join('\n\n')}`)
    }
  }

  private validateServer(): ValidationRule[] {
    const server = this.options.server

    return [
      this.nonEmptyStringRule('server.host', server?.host),
      this.intRangeRule('server.port', server?.port, 1, 65535),
      this.nonEmptyStringRule('server.password', server?.password),
      this.booleanRule('server.useBunServer', server?.useBunServer)
    ]
  }

  private validateCluster(): ValidationRule[] {
    const cluster = this.options.cluster
    if (!cluster) return []

    const workers = cluster.workers

    const rules: ValidationRule[] = [
      this.booleanRule('cluster.enabled', cluster.enabled)
    ]

    if (typeof cluster.enabled !== 'boolean') return rules

    if (cluster.enabled === false) return rules

    rules.push(
      this.nonNegativeIntRule('cluster.workers', workers),
      this.nonNegativeIntRule('cluster.minWorkers', cluster.minWorkers),
      {
        path: 'cluster.minWorkers',
        expected:
          workers === 0
            ? 'integer (auto-scaled workers, unknown value allowed)'
            : `integer <= cluster.workers (${workers})`,
        value: cluster.minWorkers,
        validate: (v: unknown) =>
          typeof v === 'number' &&
          Number.isInteger(v) &&
          Number.isInteger(workers) &&
          (workers === 0 || v <= workers)
      },
      this.positiveIntRule('cluster.commandTimeout', cluster.commandTimeout),
      this.positiveIntRule(
        'cluster.fastCommandTimeout',
        cluster.fastCommandTimeout
      ),
      this.nonNegativeIntRule('cluster.maxRetries', cluster.maxRetries)
    )

    if (cluster.hibernation) {
      rules.push(
        this.booleanRule(
          'cluster.hibernation.enabled',
          cluster.hibernation.enabled
        ),
        this.positiveIntRule(
          'cluster.hibernation.timeoutMs',
          cluster.hibernation.timeoutMs
        )
      )
    }

    const ssw = cluster.specializedSourceWorker
    if (ssw) {
      rules.push(
        this.booleanRule(
          'cluster.specializedSourceWorker.enabled',
          ssw.enabled
        ),
        this.positiveIntRule(
          'cluster.specializedSourceWorker.count',
          ssw.count
        ),
        this.positiveIntRule(
          'cluster.specializedSourceWorker.microWorkers',
          ssw.microWorkers
        ),
        this.positiveIntRule(
          'cluster.specializedSourceWorker.tasksPerWorker',
          ssw.tasksPerWorker
        ),
        this.booleanRule(
          'cluster.specializedSourceWorker.silentLogs',
          ssw.silentLogs
        )
      )
    }

    const runtime = cluster.runtime
    if (runtime) {
      rules.push(
        this.nonNegativeIntRule(
          'cluster.runtime.workerMaxOldSpaceMb',
          runtime.workerMaxOldSpaceMb
        ),
        this.nonNegativeIntRule(
          'cluster.runtime.sourceWorkerMaxOldSpaceMb',
          runtime.sourceWorkerMaxOldSpaceMb
        ),
        this.booleanRule(
          'cluster.runtime.workerExposeGc',
          runtime.workerExposeGc
        ),
        this.booleanRule(
          'cluster.runtime.sourceWorkerExposeGc',
          runtime.sourceWorkerExposeGc
        ),
        this.stringArrayRule(
          'cluster.runtime.workerExecArgv',
          runtime.workerExecArgv
        ),
        this.stringArrayRule(
          'cluster.runtime.sourceWorkerExecArgv',
          runtime.sourceWorkerExecArgv
        )
      )
    }

    const scaling = cluster.scaling
    if (scaling) {
      rules.push(
        this.positiveIntRule(
          'cluster.scaling.maxPlayersPerWorker',
          scaling.maxPlayersPerWorker
        ),
        this.positiveIntRule(
          'cluster.scaling.checkIntervalMs',
          scaling.checkIntervalMs
        ),
        this.positiveIntRule(
          'cluster.scaling.idleWorkerTimeoutMs',
          scaling.idleWorkerTimeoutMs
        ),
        this.positiveIntRule(
          'cluster.scaling.queueLengthScaleUpFactor',
          scaling.queueLengthScaleUpFactor
        ),
        this.positiveIntRule(
          'cluster.scaling.lagPenaltyLimit',
          scaling.lagPenaltyLimit
        ),
        {
          path: 'cluster.scaling.scaleUpThreshold',
          expected: 'number between 0 and 1 (exclusive)',
          value: scaling.scaleUpThreshold,
          validate: (v: unknown) => typeof v === 'number' && v > 0 && v < 1
        },
        {
          path: 'cluster.scaling.cpuPenaltyLimit',
          expected: 'number between 0 and 1 (exclusive)',
          value: scaling.cpuPenaltyLimit,
          validate: (v: unknown) => typeof v === 'number' && v > 0 && v < 1
        },
        this.floatMustBeBelow(
          'cluster.scaling.scaleDownThreshold',
          scaling.scaleDownThreshold,
          scaling.scaleUpThreshold,
          'cluster.scaling.scaleUpThreshold'
        ),
        {
          path: 'cluster.scaling.targetUtilization',
          expected: `number between scaleDownThreshold (${scaling.scaleDownThreshold}) and scaleUpThreshold (${scaling.scaleUpThreshold})`,
          value: scaling.targetUtilization,
          validate: (v: unknown) =>
            typeof scaling.scaleDownThreshold === 'number' &&
            typeof scaling.scaleUpThreshold === 'number' &&
            typeof v === 'number' &&
            v >= scaling.scaleDownThreshold &&
            v <= scaling.scaleUpThreshold
        }
      )
    }

    const endpoint = cluster.endpoint
    if (endpoint) {
      rules.push(
        this.booleanRule(
          'cluster.endpoint.patchEnabled',
          endpoint.patchEnabled
        ),
        this.booleanRule(
          'cluster.endpoint.allowExternalPatch',
          endpoint.allowExternalPatch
        ),
        this.nonEmptyStringRule('cluster.endpoint.code', endpoint.code)
      )
    }

    return rules
  }

  private validateAudio(): ValidationRule[] {
    const audio = this.options.audio

    const rules: ValidationRule[] = [
      this.booleanRule('audio.loudnessNormalizer', audio?.loudnessNormalizer),
      this.nonNegativeIntRule('audio.lookaheadMs', audio?.lookaheadMs),
      {
        path: 'audio.gateThresholdLUFS',
        expected: 'number <= 0',
        value: audio?.gateThresholdLUFS,
        validate: (v: unknown) => typeof v === 'number' && v <= 0
      },
      this.enumRule('audio.quality', audio?.quality, VALID_AUDIO_QUALITIES),
      this.enumRule(
        'audio.resamplingQuality',
        audio?.resamplingQuality,
        VALID_RESAMPLING_QUALITIES
      )
    ]

    const fading = audio?.fading
    if (fading) {
      rules.push(this.booleanRule('audio.fading.enabled', fading.enabled))

      const fadingEvents = [
        'trackStart',
        'trackEnd',
        'trackStop',
        'seek',
        'pause',
        'resume'
      ] as const
      for (const event of fadingEvents) {
        const ev = fading[event]
        if (!ev) continue
        rules.push(
          this.nonNegativeIntRule(
            `audio.fading.${event}.duration`,
            ev.duration
          ),
          this.enumRule(
            `audio.fading.${event}.curve`,
            ev.curve,
            VALID_FADING_CURVES
          ),
          this.enumRule(
            `audio.fading.${event}.type`,
            ev.type,
            VALID_FADING_TYPES
          )
        )
      }

      const ducking = fading.ducking
      if (ducking) {
        rules.push(
          this.booleanRule('audio.fading.ducking.enabled', ducking.enabled),
          this.nonNegativeIntRule(
            'audio.fading.ducking.duration',
            ducking.duration
          ),
          this.enumRule(
            'audio.fading.ducking.curve',
            ducking.curve,
            VALID_FADING_CURVES
          ),
          {
            path: 'audio.fading.ducking.targetVolume',
            expected: 'number between 0 and 1 (inclusive)',
            value: ducking.targetVolume,
            validate: (v: unknown) => typeof v === 'number' && v >= 0 && v <= 1
          }
        )
      }
    }

    return rules
  }

  private validatePlayback(): ValidationRule[] {
    const trackStuck = this.options.trackStuckThresholdMs

    return [
      this.intRangeRule(
        'playerUpdateInterval',
        this.options.playerUpdateInterval,
        250,
        60000
      ),
      this.positiveIntRule(
        'statsUpdateInterval',
        this.options.statsUpdateInterval
      ),
      this.positiveIntRule('eventTimeoutMs', this.options.eventTimeoutMs),
      this.booleanRule('enableHoloTracks', this.options.enableHoloTracks),
      this.booleanRule(
        'enableTrackStreamEndpoint',
        this.options.enableTrackStreamEndpoint
      ),
      this.booleanRule(
        'enableLoadStreamEndpoint',
        this.options.enableLoadStreamEndpoint
      ),
      this.booleanRule(
        'resolveExternalLinks',
        this.options.resolveExternalLinks
      ),
      this.booleanRule('fetchChannelInfo', this.options.fetchChannelInfo),
      {
        path: 'trackStuckThresholdMs',
        expected: 'integer >= 1000 (milliseconds)',
        value: trackStuck,
        validate: (v: unknown) =>
          typeof v === 'number' && Number.isInteger(v) && v >= 1000
      },
      this.intMustExceed(
        'zombieThresholdMs',
        this.options.zombieThresholdMs,
        trackStuck,
        'trackStuckThresholdMs'
      )
    ]
  }

  private validateSources(): ValidationRule[] {
    const sources = this.options.sources
    if (!sources) return []

    const rules: ValidationRule[] = []

    const allSources = [
      'youtube',
      'soundcloud',
      'spotify',
      'tidal',
      'applemusic',
      'audius',
      'jiosaavn',
      'eternalbox',
      'pipertts',
      'pandora',
      'yandexmusic',
      'monochrome',
      'gaana',
      'flowery',
      'lazypytts',
      'qobuz',
      'iheartradio',
      'vkmusic',
      'amazonmusic',
      'bluesky',
      'anghami',
      'rss',
      'songlink',
      'mixcloud',
      'audiomack',
      'deezer',
      'bandcamp',
      'local',
      'http',
      'vimeo',
      'telegram',
      'shazam',
      'bilibili',
      'genius',
      'pinterest',
      'google-tts',
      'instagram',
      'kwai',
      'twitch',
      'nicovideo',
      'reddit',
      'tumblr',
      'twitter',
      'lastfm',
      'letrasmus'
    ]

    for (const name of allSources) {
      const sourceConfig = (sources as Record<string, unknown>)[name] as
        | Record<string, unknown>
        | undefined
      if (sourceConfig !== undefined) {
        rules.push(
          this.booleanRule(`sources.${name}.enabled`, sourceConfig.enabled)
        )
      }
    }

    rules.push(
      ...this.validateSourceSpotify(sources.spotify),
      ...this.validateSourceAppleMusic(sources.applemusic),
      ...this.validateSourceTidal(sources.tidal),
      ...this.validateSourceAudius(sources.audius),
      ...this.validateSourceJiosaavn(sources.jiosaavn),
      ...this.validateSourceEternalbox(sources.eternalbox),
      ...this.validateSourceYoutube(sources.youtube),
      ...this.validateSourcePipertts(sources.pipertts),
      ...this.validateSourcePandora(sources.pandora),
      ...this.validateSourceQobuz(sources.qobuz),
      ...this.validateSourceLastfm(sources.lastfm),
      ...this.validateSourceBilibili(sources.bilibili),
      ...this.validateSourceYandexMusic(sources.yandexmusic),
      ...this.validateSourceGaana(sources.gaana),
      ...this.validateSourceFlowery(sources.flowery),
      ...this.validateSourceLazypytts(sources.lazypytts),
      ...this.validateSourceMonochrome(sources.monochrome)
    )

    return rules
  }

  private validateSourceSpotify(spotify: unknown): ValidationRule[] {
    if (
      typeof spotify !== 'object' ||
      spotify === null ||
      !(spotify as Record<string, unknown>).enabled
    )
      return []

    const s = spotify as Record<string, unknown>

    const rules: ValidationRule[] = [
      this.nonNegativeIntRule(
        'sources.spotify.playlistLoadLimit',
        s.playlistLoadLimit
      ),
      this.nonNegativeIntRule(
        'sources.spotify.albumLoadLimit',
        s.albumLoadLimit
      ),
      this.positiveIntRule(
        'sources.spotify.playlistPageLoadConcurrency',
        s.playlistPageLoadConcurrency
      ),
      this.positiveIntRule(
        'sources.spotify.albumPageLoadConcurrency',
        s.albumPageLoadConcurrency
      ),
      this.booleanRule('sources.spotify.allowLocalFiles', s.allowLocalFiles),
      {
        path: 'sources.spotify.clientId',
        expected: 'non-empty string when sources.spotify.clientSecret is set',
        value: s.clientId,
        validate: (v: unknown) =>
          !s.clientSecret || (typeof v === 'string' && v.trim().length > 0)
      },
      {
        path: 'sources.spotify.clientSecret',
        expected: 'non-empty string when sources.spotify.clientId is set',
        value: s.clientSecret,
        validate: (v: unknown) =>
          !s.clientId || (typeof v === 'string' && v.trim().length > 0)
      },
      this.placeholderWarningRule('sources.spotify.clientId', s.clientId),
      this.placeholderWarningRule(
        'sources.spotify.clientSecret',
        s.clientSecret
      )
    ]

    if (s.externalAuthUrl) {
      rules.push(
        this.urlRule('sources.spotify.externalAuthUrl', s.externalAuthUrl)
      )
    }

    return rules
  }

  private validateSourceAppleMusic(applemusic: unknown): ValidationRule[] {
    if (
      typeof applemusic !== 'object' ||
      applemusic === null ||
      !(applemusic as Record<string, unknown>).enabled
    )
      return []

    const a = applemusic as Record<string, unknown>

    return [
      this.nonNegativeIntRule(
        'sources.applemusic.playlistLoadLimit',
        a.playlistLoadLimit
      ),
      this.nonNegativeIntRule(
        'sources.applemusic.albumLoadLimit',
        a.albumLoadLimit
      ),
      this.positiveIntRule(
        'sources.applemusic.playlistPageLoadConcurrency',
        a.playlistPageLoadConcurrency
      ),
      this.positiveIntRule(
        'sources.applemusic.albumPageLoadConcurrency',
        a.albumPageLoadConcurrency
      ),
      this.placeholderWarningRule(
        'sources.applemusic.mediaApiToken',
        a.mediaApiToken,
        ['token_here']
      )
    ]
  }

  private validateSourceTidal(tidal: unknown): ValidationRule[] {
    if (
      typeof tidal !== 'object' ||
      tidal === null ||
      !(tidal as Record<string, unknown>).enabled
    )
      return []

    const t = tidal as Record<string, unknown>

    const rules: ValidationRule[] = [
      this.nonNegativeIntRule(
        'sources.tidal.playlistLoadLimit',
        t.playlistLoadLimit
      ),
      this.positiveIntRule(
        'sources.tidal.playlistPageLoadConcurrency',
        t.playlistPageLoadConcurrency
      )
    ]

    if (t.token !== undefined) {
      rules.push(
        {
          path: 'sources.tidal.token',
          expected: 'string (non-whitespace if provided)',
          value: t.token,
          validate: (v: unknown) =>
            typeof v === 'string' && (v === '' || v.trim().length > 0)
        },
        this.placeholderWarningRule('sources.tidal.token', t.token, [
          'token_here'
        ])
      )
    }

    return rules
  }

  private validateSourceAudius(audius: unknown): ValidationRule[] {
    if (
      typeof audius !== 'object' ||
      audius === null ||
      !(audius as Record<string, unknown>).enabled
    )
      return []

    const au = audius as Record<string, unknown>

    return [
      {
        path: 'sources.audius.appName',
        expected: 'string',
        value: au.appName,
        validate: (v: unknown) => v === undefined || typeof v === 'string'
      },
      {
        path: 'sources.audius.apiKey',
        expected: 'string',
        value: au.apiKey,
        validate: (v: unknown) => v === undefined || typeof v === 'string'
      },
      {
        path: 'sources.audius.apiSecret',
        expected: 'string',
        value: au.apiSecret,
        validate: (v: unknown) => v === undefined || typeof v === 'string'
      },
      this.nonNegativeIntRule(
        'sources.audius.playlistLoadLimit',
        au.playlistLoadLimit
      ),
      this.nonNegativeIntRule(
        'sources.audius.albumLoadLimit',
        au.albumLoadLimit
      ),
      this.placeholderWarningRule('sources.audius.apiKey', au.apiKey),
      this.placeholderWarningRule('sources.audius.apiSecret', au.apiSecret)
    ]
  }

  private validateSourceJiosaavn(jiosaavn: unknown): ValidationRule[] {
    if (
      typeof jiosaavn !== 'object' ||
      jiosaavn === null ||
      !(jiosaavn as Record<string, unknown>).enabled
    )
      return []

    const j = jiosaavn as Record<string, unknown>

    return [
      this.nonNegativeIntRule(
        'sources.jiosaavn.playlistLoadLimit',
        j.playlistLoadLimit
      ),
      this.nonNegativeIntRule(
        'sources.jiosaavn.artistLoadLimit',
        j.artistLoadLimit
      )
    ]
  }

  private validateSourceEternalbox(eternalbox: unknown): ValidationRule[] {
    if (
      typeof eternalbox !== 'object' ||
      eternalbox === null ||
      !(eternalbox as Record<string, unknown>).enabled
    )
      return []

    const e = eternalbox as Record<string, unknown>

    return [
      this.urlRule('sources.eternalbox.baseUrl', e.baseUrl),
      this.positiveIntRule('sources.eternalbox.searchResults', e.searchResults),
      this.positiveIntRule('sources.eternalbox.maxBranches', e.maxBranches),
      this.nonNegativeIntRule(
        'sources.eternalbox.cacheMaxBytes',
        e.cacheMaxBytes
      ),
      this.booleanRule('sources.eternalbox.enrichSpotify', e.enrichSpotify),
      this.booleanRule('sources.eternalbox.includeAnalysis', e.includeAnalysis),
      this.booleanRule('sources.eternalbox.eternalStream', e.eternalStream),
      this.booleanRule('sources.eternalbox.infiniteStream', e.infiniteStream),
      this.nonNegativeIntRule(
        'sources.eternalbox.maxReconnects',
        e.maxReconnects
      ),
      this.positiveIntRule(
        'sources.eternalbox.reconnectDelayMs',
        e.reconnectDelayMs
      ),
      {
        path: 'sources.eternalbox.minRandomBranchChance',
        expected: 'number between 0 and 1 (inclusive)',
        value: e.minRandomBranchChance,
        validate: (v: unknown) => typeof v === 'number' && v >= 0 && v <= 1
      },
      {
        path: 'sources.eternalbox.maxRandomBranchChance',
        expected: 'number between 0 and 1 (inclusive)',
        value: e.maxRandomBranchChance,
        validate: (v: unknown) => typeof v === 'number' && v >= 0 && v <= 1
      },
      this.floatMustNotExceed(
        'sources.eternalbox.minRandomBranchChance',
        e.minRandomBranchChance,
        e.maxRandomBranchChance,
        'sources.eternalbox.maxRandomBranchChance'
      )
    ]
  }

  private validateSourceYoutube(youtube: unknown): ValidationRule[] {
    if (typeof youtube !== 'object' || youtube === null) return []
    const y = youtube as Record<string, unknown>
    if (!y.enabled || !y.cipher) return []
    const cipher = y.cipher as Record<string, unknown>
    if (cipher.url === undefined) return []

    return [this.urlRule('sources.youtube.cipher.url', cipher.url)]
  }

  private validateSourcePipertts(pipertts: unknown): ValidationRule[] {
    if (
      typeof pipertts !== 'object' ||
      pipertts === null ||
      !(pipertts as Record<string, unknown>).enabled
    )
      return []

    const p = pipertts as Record<string, unknown>

    return [this.urlRule('sources.pipertts.url', p.url)]
  }

  private validateSourcePandora(pandora: unknown): ValidationRule[] {
    if (typeof pandora !== 'object' || pandora === null) return []
    const pa = pandora as Record<string, unknown>
    if (!pa.enabled || !pa.remoteTokenUrl) return []

    return [this.urlRule('sources.pandora.remoteTokenUrl', pa.remoteTokenUrl)]
  }

  private validateSourceQobuz(qobuz: unknown): ValidationRule[] {
    if (
      typeof qobuz !== 'object' ||
      qobuz === null ||
      !(qobuz as Record<string, unknown>).enabled
    )
      return []

    const q = qobuz as Record<string, unknown>

    return [this.placeholderWarningRule('sources.qobuz.userToken', q.userToken)]
  }

  private validateSourceLastfm(lastfm: unknown): ValidationRule[] {
    if (
      typeof lastfm !== 'object' ||
      lastfm === null ||
      !(lastfm as Record<string, unknown>).enabled
    )
      return []

    const l = lastfm as Record<string, unknown>

    return [this.placeholderWarningRule('sources.lastfm.apiKey', l.apiKey)]
  }

  private validateSourceBilibili(bilibili: unknown): ValidationRule[] {
    if (
      typeof bilibili !== 'object' ||
      bilibili === null ||
      !(bilibili as Record<string, unknown>).enabled
    )
      return []

    const b = bilibili as Record<string, unknown>

    return [
      this.placeholderWarningRule('sources.bilibili.sessdata', b.sessdata)
    ]
  }

  private validateSourceYandexMusic(yandexmusic: unknown): ValidationRule[] {
    if (
      typeof yandexmusic !== 'object' ||
      yandexmusic === null ||
      !(yandexmusic as Record<string, unknown>).enabled
    )
      return []

    const ym = yandexmusic as Record<string, unknown>

    return [
      this.nonNegativeIntRule(
        'sources.yandexmusic.artistLoadLimit',
        ym.artistLoadLimit
      ),
      this.nonNegativeIntRule(
        'sources.yandexmusic.albumLoadLimit',
        ym.albumLoadLimit
      ),
      this.nonNegativeIntRule(
        'sources.yandexmusic.playlistLoadLimit',
        ym.playlistLoadLimit
      ),
      this.placeholderWarningRule(
        'sources.yandexmusic.accessToken',
        ym.accessToken
      )
    ]
  }

  private validateSourceGaana(gaana: unknown): ValidationRule[] {
    if (
      typeof gaana !== 'object' ||
      gaana === null ||
      !(gaana as Record<string, unknown>).enabled
    )
      return []

    const g = gaana as Record<string, unknown>

    return [
      this.nonNegativeIntRule(
        'sources.gaana.playlistLoadLimit',
        g.playlistLoadLimit
      ),
      this.nonNegativeIntRule('sources.gaana.albumLoadLimit', g.albumLoadLimit),
      this.nonNegativeIntRule(
        'sources.gaana.artistLoadLimit',
        g.artistLoadLimit
      )
    ]
  }

  private validateSourceFlowery(flowery: unknown): ValidationRule[] {
    if (
      typeof flowery !== 'object' ||
      flowery === null ||
      !(flowery as Record<string, unknown>).enabled
    )
      return []

    const fl = flowery as Record<string, unknown>

    return [
      this.positiveNumberRule('sources.flowery.speed', fl.speed),
      this.nonNegativeIntRule('sources.flowery.silence', fl.silence),
      this.booleanRule('sources.flowery.translate', fl.translate),
      this.booleanRule('sources.flowery.enforceConfig', fl.enforceConfig)
    ]
  }

  private validateSourceLazypytts(lazypytts: unknown): ValidationRule[] {
    if (
      typeof lazypytts !== 'object' ||
      lazypytts === null ||
      !(lazypytts as Record<string, unknown>).enabled
    )
      return []

    const lp = lazypytts as Record<string, unknown>

    return [
      this.positiveIntRule('sources.lazypytts.maxTextLength', lp.maxTextLength),
      this.booleanRule('sources.lazypytts.enforceConfig', lp.enforceConfig)
    ]
  }

  private validateSourceMonochrome(monochrome: unknown): ValidationRule[] {
    if (
      typeof monochrome !== 'object' ||
      monochrome === null ||
      !(monochrome as Record<string, unknown>).enabled
    )
      return []

    const m = monochrome as Record<string, unknown>

    return [
      this.stringArrayRule('sources.monochrome.instances', m.instances),
      this.stringArrayRule(
        'sources.monochrome.streamingInstances',
        m.streamingInstances
      ),
      {
        path: 'sources.monochrome.quality',
        expected: 'one of [HI_RES_LOSSLESS, LOSSLESS, HIGH, LOW]',
        value: m.quality,
        validate: (v: unknown) =>
          ['HI_RES_LOSSLESS', 'LOSSLESS', 'HIGH', 'LOW'].includes(v as string)
      }
    ]
  }

  private validateSearch(): ValidationRule[] {
    const rules: ValidationRule[] = [
      this.intRangeRule(
        'maxSearchResults',
        this.options.maxSearchResults,
        1,
        100
      ),
      this.intRangeRule(
        'maxAlbumPlaylistLength',
        this.options.maxAlbumPlaylistLength,
        1,
        500
      ),
      {
        path: 'defaultSearchSource',
        expected:
          'string or non-empty string[] of enabled source names in config.sources',
        value: this.options.defaultSearchSource,
        validate: (v: unknown) => {
          const sources = this.options.sources
          if (!sources) return false
          const sourcesRecord = sources as Record<string, unknown>
          if (typeof v === 'string')
            return (
              (sourcesRecord[v] as Record<string, unknown>)?.enabled === true
            )
          if (Array.isArray(v)) {
            if (v.length === 0) return false
            return v.every(
              (name: unknown) =>
                typeof name === 'string' &&
                (sourcesRecord[name] as Record<string, unknown>)?.enabled ===
                  true
            )
          }
          return false
        }
      }
    ]

    const unified = this.options.unifiedSearchSources
    if (unified !== undefined) {
      rules.push({
        path: 'unifiedSearchSources',
        expected:
          'non-empty string[] of enabled source names in config.sources',
        value: unified,
        validate: (v: unknown) => {
          const sources = this.options.sources
          if (!sources || !Array.isArray(v) || v.length === 0) return false
          const sourcesRecord = sources as Record<string, unknown>
          return v.every(
            (name: unknown) =>
              typeof name === 'string' &&
              (sourcesRecord[name] as Record<string, unknown>)?.enabled === true
          )
        }
      })
    }

    return rules
  }

  private validateRoutePlanner(): ValidationRule[] {
    const routePlanner = this.options.routePlanner
    if (!routePlanner) return []

    const rules: ValidationRule[] = [
      this.enumRule(
        'routePlanner.strategy',
        routePlanner.strategy,
        VALID_ROUTE_STRATEGIES
      )
    ]

    if (routePlanner.bannedIpCooldown !== undefined) {
      rules.push(
        this.positiveIntRule(
          'routePlanner.bannedIpCooldown',
          routePlanner.bannedIpCooldown
        )
      )
    }

    return rules
  }

  private validateRateLimit(): ValidationRule[] {
    const rateLimit = this.options.rateLimit
    if (!rateLimit || rateLimit.enabled === false) return []

    const rules: ValidationRule[] = [
      this.booleanRule('rateLimit.enabled', rateLimit.enabled)
    ]

    type RateLimitSection = { maxRequests: number; timeWindowMs: number }

    const sections = ['global', 'perIp', 'perUserId', 'perGuildId'] as const
    let prevSection: string | null = null
    let prevCfg: RateLimitSection | null = null

    for (const section of sections) {
      const cfg = rateLimit[section] as RateLimitSection | undefined
      if (!cfg) {
        continue
      }

      rules.push(
        this.positiveIntRule(
          `rateLimit.${section}.maxRequests`,
          cfg.maxRequests
        ),
        this.positiveIntRule(
          `rateLimit.${section}.timeWindowMs`,
          cfg.timeWindowMs
        )
      )

      if (prevSection !== null && prevCfg !== null) {
        const capturedPrevSection = prevSection
        const capturedPrevCfg = prevCfg
        rules.push(
          this.intMustNotExceed(
            `rateLimit.${section}.maxRequests`,
            cfg.maxRequests,
            capturedPrevCfg.maxRequests,
            `rateLimit.${capturedPrevSection}.maxRequests`
          ),
          this.intMustNotExceed(
            `rateLimit.${section}.timeWindowMs`,
            cfg.timeWindowMs,
            capturedPrevCfg.timeWindowMs,
            `rateLimit.${capturedPrevSection}.timeWindowMs`
          )
        )
      }

      prevSection = section
      prevCfg = cfg
    }

    return rules
  }

  private validateDosProtection(): ValidationRule[] {
    const dos = this.options.dosProtection
    if (!dos) return []

    const rules: ValidationRule[] = [
      this.booleanRule('dosProtection.enabled', dos.enabled)
    ]

    if (dos.thresholds) {
      rules.push(
        this.positiveIntRule(
          'dosProtection.thresholds.burstRequests',
          dos.thresholds.burstRequests
        ),
        this.positiveIntRule(
          'dosProtection.thresholds.timeWindowMs',
          dos.thresholds.timeWindowMs
        )
      )
    }

    if (dos.mitigation) {
      rules.push(
        this.nonNegativeIntRule(
          'dosProtection.mitigation.delayMs',
          dos.mitigation.delayMs
        ),
        this.positiveIntRule(
          'dosProtection.mitigation.blockDurationMs',
          dos.mitigation.blockDurationMs
        )
      )
    }

    return rules
  }

  private validateLogging(): ValidationRule[] {
    const logging = this.options.logging
    if (!logging) return []

    const rules: ValidationRule[] = []

    if (logging.file) {
      rules.push(
        this.booleanRule('logging.file.enabled', logging.file.enabled),
        this.positiveIntRule('logging.file.ttlDays', logging.file.ttlDays)
      )

      if (logging.file.enabled) {
        rules.push(
          this.nonEmptyStringRule('logging.file.path', logging.file.path)
        )
      }
    }

    if (logging.debug) {
      const debugFields = [
        'all',
        'request',
        'session',
        'player',
        'filters',
        'sources',
        'lyrics',
        'youtube',
        'youtube-cipher',
        'sabr',
        'potoken'
      ] as const
      for (const field of debugFields) {
        if (logging.debug[field] !== undefined) {
          rules.push(
            this.booleanRule(`logging.debug.${field}`, logging.debug[field])
          )
        }
      }
    }

    return rules
  }

  private validateConnection(): ValidationRule[] {
    const connection = this.options.connection
    if (!connection) return []

    const rules: ValidationRule[] = [
      this.booleanRule('connection.logAllChecks', connection.logAllChecks),
      this.positiveIntRule('connection.interval', connection.interval),
      this.positiveIntRule('connection.timeout', connection.timeout)
    ]

    if (connection.thresholds) {
      rules.push(
        this.positiveNumberRule(
          'connection.thresholds.bad',
          connection.thresholds.bad
        ),
        this.positiveNumberRule(
          'connection.thresholds.average',
          connection.thresholds.average
        ),
        this.floatMustBeBelow(
          'connection.thresholds.bad',
          connection.thresholds.bad,
          connection.thresholds.average,
          'connection.thresholds.average'
        )
      )
    }

    return rules
  }

  private validateVoiceReceive(): ValidationRule[] {
    const voiceReceive = this.options.voiceReceive
    if (!voiceReceive) return []

    return [
      this.booleanRule('voiceReceive.enabled', voiceReceive.enabled),
      this.enumRule(
        'voiceReceive.format',
        voiceReceive.format,
        VALID_VOICE_FORMATS
      )
    ]
  }

  private validateMix(): ValidationRule[] {
    const mix = this.options.mix
    if (!mix) return []

    return [
      this.booleanRule('mix.enabled', mix.enabled),
      this.positiveIntRule('mix.maxLayersMix', mix.maxLayersMix),
      this.booleanRule('mix.autoCleanup', mix.autoCleanup),
      {
        path: 'mix.defaultVolume',
        expected: 'number between 0 and 1 (inclusive)',
        value: mix.defaultVolume,
        validate: (v: unknown) => typeof v === 'number' && v >= 0 && v <= 1
      }
    ]
  }

  private validateMetrics(): ValidationRule[] {
    const metrics = this.options.metrics
    if (!metrics) return []

    const rules: ValidationRule[] = [
      this.booleanRule('metrics.enabled', metrics.enabled)
    ]

    if (metrics.authorization) {
      rules.push(
        this.enumRule(
          'metrics.authorization.type',
          metrics.authorization.type,
          VALID_METRICS_AUTH_TYPES
        )
      )
    }

    return rules
  }

  private validateFilters(): ValidationRule[] {
    const filters = this.options.filters
    if (filters === undefined) return []

    if (filters === null || typeof filters !== 'object') {
      return [
        {
          path: 'filters',
          expected: 'object with an enabled key',
          value: filters,
          validate: () => false
        }
      ]
    }

    if (!('enabled' in filters)) {
      return [
        {
          path: 'filters.enabled',
          expected: 'object of filter flags',
          value: undefined,
          validate: () => false
        }
      ]
    }

    if (filters.enabled === null || typeof filters.enabled !== 'object') {
      return [
        {
          path: 'filters.enabled',
          expected: 'object of filter flags',
          value: filters.enabled,
          validate: () => false
        }
      ]
    }

    if (Object.keys(filters.enabled).length === 0) return []

    const filterFields = [
      'tremolo',
      'vibrato',
      'lowpass',
      'highpass',
      'rotation',
      'karaoke',
      'distortion',
      'channelMix',
      'equalizer',
      'chorus',
      'compressor',
      'echo',
      'phaser',
      'timescale'
    ] as const

    return filterFields
      .filter((f) => filters.enabled[f] !== undefined)
      .map((f) => this.booleanRule(`filters.enabled.${f}`, filters.enabled[f]))
  }

  private placeholderWarningRule(
    path: string,
    value: unknown,
    except: string[] = []
  ): ValidationRule {
    return {
      path,
      expected: 'non-placeholder value',
      value,
      validate: (v: unknown) => {
        if (
          typeof v === 'string' &&
          KNOWN_PLACEHOLDERS.has(v) &&
          !except.includes(v)
        ) {
          this.warnings.push({
            path,
            message: `Value "${v}" looks like an unfilled placeholder. The source may fail to authenticate at runtime.`
          })
        }
        return true
      }
    }
  }

  private nonNegativeIntRule(path: string, value: unknown): ValidationRule {
    return {
      path,
      expected: 'integer >= 0',
      value,
      validate: (v: unknown) =>
        typeof v === 'number' && Number.isInteger(v) && v >= 0
    }
  }

  private positiveIntRule(path: string, value: unknown): ValidationRule {
    return {
      path,
      expected: 'integer > 0',
      value,
      validate: (v: unknown) =>
        typeof v === 'number' && Number.isInteger(v) && v > 0
    }
  }

  private intRangeRule(
    path: string,
    value: unknown,
    min: number,
    max: number
  ): ValidationRule {
    return {
      path,
      expected: `integer between ${min} and ${max}`,
      value,
      validate: (v: unknown) =>
        typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
    }
  }

  private booleanRule(path: string, value: unknown): ValidationRule {
    return {
      path,
      expected: 'boolean',
      value,
      validate: (v: unknown) => typeof v === 'boolean'
    }
  }

  private nonEmptyStringRule(path: string, value: unknown): ValidationRule {
    return {
      path,
      expected: 'non-empty string',
      value,
      validate: (v: unknown) => typeof v === 'string' && v.trim().length > 0
    }
  }

  private enumRule(
    path: string,
    value: unknown,
    allowed: Set<string>
  ): ValidationRule {
    const label = [...allowed].join(', ')
    return {
      path,
      expected: `one of [${label}]`,
      value,
      validate: (v: unknown) => allowed.has(v as string)
    }
  }

  private urlRule(path: string, value: unknown): ValidationRule {
    return {
      path,
      expected: 'valid http or https URL (e.g. https://example.com)',
      value,
      validate: (v: unknown) => {
        if (typeof v !== 'string' || v.trim().length === 0) return false
        if (v !== v.trim()) {
          this.warnings.push({
            path,
            message: `URL value has leading or trailing whitespace. This may cause issues at runtime.`
          })
        }
        try {
          const url = new URL(v.trim())
          return url.protocol === 'http:' || url.protocol === 'https:'
        } catch {
          return false
        }
      }
    }
  }

  private intMustExceed(
    path: string,
    value: unknown,
    dependency: unknown,
    dependencyPath: string
  ): ValidationRule {
    return {
      path,
      expected: `integer > ${dependencyPath} (${dependency})`,
      value,
      validate: (v: unknown) =>
        typeof v === 'number' &&
        Number.isInteger(v) &&
        typeof dependency === 'number' &&
        Number.isInteger(dependency) &&
        v > dependency
    }
  }

  private intMustNotExceed(
    path: string,
    value: unknown,
    dependency: unknown,
    dependencyPath: string
  ): ValidationRule {
    return {
      path,
      expected: `integer <= ${dependencyPath} (${dependency})`,
      value,
      validate: (v: unknown) =>
        typeof v === 'number' &&
        Number.isInteger(v) &&
        typeof dependency === 'number' &&
        Number.isInteger(dependency) &&
        v <= dependency
    }
  }

  private floatMustNotExceed(
    path: string,
    value: unknown,
    dependency: unknown,
    dependencyPath: string
  ): ValidationRule {
    return {
      path,
      expected: `number <= ${dependencyPath} (${dependency})`,
      value,
      validate: (v: unknown) =>
        typeof v === 'number' &&
        typeof dependency === 'number' &&
        v <= dependency
    }
  }

  private floatMustBeBelow(
    path: string,
    value: unknown,
    dependency: unknown,
    dependencyPath: string
  ): ValidationRule {
    return {
      path,
      expected: `number < ${dependencyPath} (${dependency})`,
      value,
      validate: (v: unknown) =>
        typeof v === 'number' &&
        typeof dependency === 'number' &&
        v < dependency
    }
  }

  private positiveNumberRule(path: string, value: unknown): ValidationRule {
    return {
      path,
      expected: 'number > 0',
      value,
      validate: (v: unknown) => typeof v === 'number' && v > 0
    }
  }

  private stringArrayRule(path: string, value: unknown): ValidationRule {
    return {
      path,
      expected: 'array of strings',
      value,
      validate: (v: unknown) =>
        Array.isArray(v) && v.every((item) => typeof item === 'string')
    }
  }
}
