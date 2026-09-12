import { PassThrough } from 'node:stream'
import type {
  SourceResult,
  TrackInfo,
  TrackStreamResult,
  TrackUrlResult,
  WorkerNodeLink
} from '../typings/sources/source.types.ts'
import type { TrackEncodeInput } from '../typings/utils.types.ts'
import { encodeTrack, logger, makeRequest } from '../utils.ts'

const VOICES_URL = 'https://lazypy.ro/tts/assets/js/voices.json'
const REQUEST_URL = 'https://lazypy.ro/tts/request_tts.php'
const DEFAULT_SERVICE = 'Cerence'
const DEFAULT_VOICE = 'Luciana'
const DEFAULT_MAX_TEXT_LENGTH = 3000
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * LazyPy TTS source implementation.
 * @public
 */
export default class LazyPyTtsSource {
  /**
   * Runtime NodeLink context.
   */
  public readonly nodelink: WorkerNodeLink & {
    sources: NonNullable<WorkerNodeLink['sources']>
  }

  /**
   * LazyPy source config block.
   */
  public readonly config: Record<string, unknown>

  /**
   * Search aliases.
   */
  public readonly searchTerms: string[]

  /**
   * URL patterns.
   */
  public readonly patterns: RegExp[]

  /**
   * Source priority.
   */
  public readonly priority: number

  /**
   * Voice services cache.
   */
  public readonly services: Map<
    string,
    {
      key: string
      name: string
      charLimit: number | null
      countBytes: boolean
      voices: Map<string, { id: string; name: string }>
      defaultVoice: { id: string; name: string } | null
    }
  >

  /**
   * Creates a LazyPy TTS source.
   * @param nodelink - Runtime NodeLink context.
   */
  public constructor(
    nodelink: WorkerNodeLink & {
      sources: NonNullable<WorkerNodeLink['sources']>
    }
  ) {
    this.nodelink = nodelink
    const sourceConfig = this.nodelink.options.sources?.lazypytts
    this.config =
      sourceConfig && typeof sourceConfig === 'object'
        ? (sourceConfig as unknown as Record<string, unknown>)
        : {}
    this.searchTerms = ['lazypytts', 'lazytts']
    this.patterns = [/^lazypytts:/i, /^lazytts:/i]
    this.priority = 50
    this.services = new Map()
  }

  /**
   * Initializes source and loads voices metadata.
   * @returns False when source is disabled.
   */
  public async setup(): Promise<boolean> {
    if (this.config.enabled === false) {
      logger('debug', 'LazyPy', 'LazyPy TTS source is disabled.')
      return false
    }

    await this._fetchVoices()
    logger('info', 'Sources', 'Loaded LazyPy TTS source.')
    return true
  }

  /**
   * Fetches and caches available voices.
   * @returns Promise resolved when fetch/caching flow finishes.
   */
  private async _fetchVoices(): Promise<void> {
    try {
      const cached =
        this.nodelink.credentialManager?.get<Record<string, unknown>>(
          'lazypytts_voices'
        ) || null
      const cachedRecord = this.asRecord(cached)
      if (cachedRecord && this.asRecord(cachedRecord.services)) {
        this._applyVoiceCache(cachedRecord)
        logger(
          'debug',
          'LazyPy',
          `Loaded ${this.asNumber(cachedRecord.totalVoices) || 0} LazyPy voices from CredentialManager.`
        )
        return
      }

      const { body, error, statusCode } = await makeRequest(VOICES_URL, {
        method: 'GET'
      })

      const bodyObject = this.asRecord(body)
      if (error || statusCode !== 200 || !bodyObject) {
        logger(
          'error',
          'LazyPy',
          `Failed to fetch LazyPy voices: ${error || `Status ${statusCode}`}`
        )
        return
      }

      const summary = this._ingestVoices(bodyObject)
      this.nodelink.credentialManager?.set(
        'lazypytts_voices',
        summary.cache,
        CACHE_TTL_MS
      )
      logger(
        'debug',
        'LazyPy',
        `Fetched ${summary.totalVoices} LazyPy voices across ${summary.serviceCount} services.`
      )
    } catch (error) {
      logger(
        'error',
        'LazyPy',
        `Exception fetching LazyPy voices: ${this.getErrorMessage(error)}`
      )
    }
  }

  /**
   * Applies cached voices payload.
   * @param cache - Cached voice payload.
   */
  private _applyVoiceCache(cache: Record<string, unknown>): void {
    this.services.clear()
    const services = this.asRecord(cache.services) || {}
    for (const [key, serviceValue] of Object.entries(services)) {
      const service = this.asRecord(serviceValue)
      if (!service) continue
      const voicesRecord = this.asRecord(service.voices) || {}
      const voices = new Map(
        Object.entries(voicesRecord)
          .map(([voiceKey, voicePayload]) => {
            const voice = this.asRecord(voicePayload)
            const id = this.asString(voice?.id)
            const name = this.asString(voice?.name)
            return id && name ? [voiceKey, { id, name }] : null
          })
          .filter(
            (entry): entry is [string, { id: string; name: string }] =>
              entry !== null
          )
      )
      const defaultVoiceRecord = this.asRecord(service.defaultVoice)
      const defaultVoiceId = this.asString(defaultVoiceRecord?.id)
      const defaultVoiceName = this.asString(defaultVoiceRecord?.name)
      this.services.set(key, {
        key,
        name: this.asString(service.name) || key,
        charLimit: this.asNumber(service.charLimit),
        countBytes: this.asBoolean(service.countBytes) ?? false,
        voices,
        defaultVoice:
          defaultVoiceId && defaultVoiceName
            ? { id: defaultVoiceId, name: defaultVoiceName }
            : null
      })
    }
  }

  /**
   * Ingests remote voices payload into in-memory cache.
   * @param data - Voice payload.
   * @returns Cache summary object.
   */
  private _ingestVoices(data: Record<string, unknown>): {
    totalVoices: number
    serviceCount: number
    cache: Record<string, unknown>
  } {
    this.services.clear()
    let totalVoices = 0

    for (const [serviceName, serviceDataRaw] of Object.entries(data)) {
      const serviceData = this.asRecord(serviceDataRaw)
      const voicesRaw = serviceData ? serviceData.voices : null
      if (!serviceData || !Array.isArray(voicesRaw)) continue

      const serviceKey = this._normalizeKey(serviceName)
      if (!serviceKey) continue

      const voices = new Map()
      let defaultVoice = null

      for (const voiceRaw of voicesRaw) {
        const voice = this.asRecord(voiceRaw)
        if (!voice) continue

        const voiceId = String(voice.vid ?? voice.id ?? voice.name ?? '').trim()
        const voiceName = String(voice.name ?? voice.vid ?? voiceId).trim()
        if (!voiceId && !voiceName) continue

        const payload = { id: voiceId || voiceName, name: voiceName || voiceId }
        const nameKey = this._normalizeKey(voiceName || voiceId)
        if (nameKey) voices.set(nameKey, payload)

        const idKey = this._normalizeKey(voiceId)
        if (idKey && !voices.has(idKey)) voices.set(idKey, payload)

        if (!defaultVoice) defaultVoice = payload
        totalVoices += 1
      }

      this.services.set(serviceKey, {
        key: serviceKey,
        name: serviceName,
        charLimit: this.asNumber(serviceData.charLimit),
        countBytes: this.asBoolean(serviceData.countBytes) ?? false,
        voices,
        defaultVoice
      })
    }

    const cache = {
      services: Object.fromEntries(
        Array.from(this.services.entries()).map(([key, service]) => [
          key,
          {
            name: service.name,
            charLimit: service.charLimit,
            countBytes: service.countBytes,
            voices: Object.fromEntries(service.voices),
            defaultVoice: service.defaultVoice
          }
        ])
      ),
      totalVoices
    }

    return { totalVoices, serviceCount: this.services.size, cache }
  }

  /**
   * Normalizes user-facing keys.
   * @param value - Raw key.
   * @returns Normalized key.
   */
  private _normalizeKey(value: unknown): string {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
  }

  /**
   * Decodes URL-encoded input safely.
   * @param value - Raw input.
   * @returns Decoded string.
   */
  private _safeDecode(value: unknown): string {
    if (!value) return ''
    try {
      return decodeURIComponent(String(value))
    } catch {
      return String(value)
    }
  }

  /**
   * Looks up a service by name.
   * @param name - Service name.
   * @returns Service payload or null.
   */
  private _getService(name: unknown): {
    key: string
    name: string
    charLimit: number | null
    countBytes: boolean
    voices: Map<string, { id: string; name: string }>
    defaultVoice: { id: string; name: string } | null
  } | null {
    const key = this._normalizeKey(name)
    if (!key) return null
    return this.services.get(key) || null
  }

  /**
   * Returns first available service.
   * @returns Service payload or null.
   */
  private _getFirstService(): {
    key: string
    name: string
    charLimit: number | null
    countBytes: boolean
    voices: Map<string, { id: string; name: string }>
    defaultVoice: { id: string; name: string } | null
  } | null {
    return this.services.values().next().value || null
  }

  /**
   * Finds first service containing requested voice.
   * @param voiceName - Voice name.
   * @returns Matching service/voice pair or null.
   */
  private _findServiceForVoice(voiceName: unknown): {
    service: {
      key: string
      name: string
      charLimit: number | null
      countBytes: boolean
      voices: Map<string, { id: string; name: string }>
      defaultVoice: { id: string; name: string } | null
    }
    voice: { id: string; name: string }
  } | null {
    const voiceKey = this._normalizeKey(voiceName)
    if (!voiceKey) return null

    const preferred = this._getService(this.config.service)
    if (preferred) {
      const voice = preferred.voices.get(voiceKey)
      if (voice) return { service: preferred, voice }
    }

    for (const service of this.services.values()) {
      const voice = service.voices.get(voiceKey)
      if (voice) return { service, voice }
    }

    return null
  }

  /**
   * Parses query-string style TTS command.
   * @param raw - Raw command text.
   * @returns Parsed input object or null.
   */
  private _parseQueryString(
    raw: string
  ): { service: string; voice: string; text: string } | null {
    if (!raw.includes('=')) return null
    const params = new URLSearchParams(raw)
    if (!params.has('text')) return null

    return {
      service: params.get('service') || params.get('svc') || '',
      voice:
        params.get('voice') ||
        params.get('voice_id') ||
        params.get('voiceId') ||
        '',
      text: params.get('text') || ''
    }
  }

  /**
   * Parses colon style TTS command.
   * @param raw - Raw command text.
   * @returns Parsed input object.
   */
  private _parseColonInput(raw: string): {
    service?: string
    voice?: string
    text: string
  } {
    const parts = raw.split(':')
    if (parts.length >= 3 && this._getService(parts[0])) {
      return {
        service: parts[0],
        voice: parts[1],
        text: parts.slice(2).join(':')
      }
    }

    if (parts.length >= 2) {
      return {
        voice: parts[0],
        text: parts.slice(1).join(':')
      }
    }

    return { text: raw }
  }

  /**
   * Parses user input into service/voice/text components.
   * @param query - Raw input query.
   * @returns Parsed input object.
   */
  private _parseInput(query: unknown): {
    service: string
    voice: string
    text: string
  } {
    let raw = String(query || '').trim()
    if (!raw) return { service: '', voice: '', text: '' }

    raw = raw.replace(/^lazypytts:/i, '').replace(/^lazytts:/i, '')
    const parsed = this._parseQueryString(raw) || this._parseColonInput(raw)

    return {
      service: this._safeDecode(parsed.service),
      voice: this._safeDecode(parsed.voice),
      text: this._safeDecode(parsed.text)
    }
  }

  /**
   * Resolves final service/voice request.
   * @param parsed - Parsed input payload.
   * @returns Resolved request payload.
   */
  private _resolveRequest(parsed: {
    service?: string
    voice?: string
    text: string
  }): {
    text: string
    serviceName: string
    voiceId: string
    voiceLabel: string
    service: {
      key: string
      name: string
      charLimit: number | null
      countBytes: boolean
      voices: Map<string, { id: string; name: string }>
      defaultVoice: { id: string; name: string } | null
    } | null
  } {
    const configService = this.asString(this.config.service) || DEFAULT_SERVICE
    const configVoice = this.asString(this.config.voice) || DEFAULT_VOICE
    const enforceConfig = this.config.enforceConfig === true
    const text = (parsed.text || '').trim()

    let serviceName = enforceConfig ? configService : parsed.service
    const voiceName = enforceConfig ? configVoice : parsed.voice
    let service = serviceName ? this._getService(serviceName) : null
    let voice = null

    if (!enforceConfig && !service && voiceName) {
      const found = this._findServiceForVoice(voiceName)
      if (found) {
        service = found.service
        serviceName = found.service.name
        voice = found.voice
      }
    }

    if (!service) {
      const fallback =
        this._getService(configService) || this._getFirstService()
      if (fallback) {
        service = fallback
        serviceName = fallback.name
      }
    }

    if (!voice && service) {
      if (voiceName) {
        voice = service.voices.get(this._normalizeKey(voiceName))
      }
      if (!voice && !enforceConfig && configVoice) {
        voice = service.voices.get(this._normalizeKey(configVoice))
      }
      if (!voice && service.defaultVoice) {
        voice = service.defaultVoice
      }
    }

    const resolvedVoice = voice?.name || voiceName || configVoice
    return {
      text,
      serviceName: serviceName || configService,
      voiceId: voice?.id || resolvedVoice,
      voiceLabel: resolvedVoice,
      service
    }
  }

  /**
   * Returns max text length for selected service.
   * @param service - Selected service payload.
   * @returns Max text length.
   */
  private _getMaxTextLength(
    service: {
      charLimit: number | null
    } | null
  ): number {
    const configLimit =
      Number.isFinite(this.config.maxTextLength) &&
      Number(this.config.maxTextLength) > 0
        ? Number(this.config.maxTextLength)
        : DEFAULT_MAX_TEXT_LENGTH
    const serviceLimit =
      service?.charLimit && service.charLimit > 0 ? service.charLimit : null
    return serviceLimit ? Math.min(serviceLimit, configLimit) : configLimit
  }

  /**
   * Validates text length against limits.
   * @param text - Input text.
   * @param service - Selected service payload.
   * @returns Validation payload when overflow happens.
   */
  private _validateTextLength(
    text: string,
    service: { charLimit: number | null; countBytes: boolean } | null
  ): { length: number; maxLength: number; countBytes: boolean } | null {
    const maxLength = this._getMaxTextLength(service)
    const countBytes = service?.countBytes ?? false
    const length = countBytes ? Buffer.byteLength(text) : text.length
    if (length > maxLength) {
      return { length, maxLength, countBytes }
    }
    return null
  }

  /**
   * Searches LazyPy TTS using colon syntax for voice (and optional service).
   * @param {string} query - Text or structured query to synthesize.
   * @example lazypytts:Luciana:hello world
   * @example lazypytts:Cerence:Luciana:hello world
   * @example lazytts:Luciana:hello world
   */
  public async search(query: string): Promise<SourceResult> {
    if (!query) return { loadType: 'empty', data: {} }

    try {
      const parsed = this._parseInput(query)
      const resolved = this._resolveRequest(parsed)

      if (!resolved.text) return { loadType: 'empty', data: {} }

      const lengthCheck = this._validateTextLength(
        resolved.text,
        resolved.service
      )
      if (lengthCheck) {
        const unit = lengthCheck.countBytes ? 'bytes' : 'characters'
        return {
          loadType: 'error',
          exception: {
            message: `Text too long for LazyPy TTS (${resolved.serviceName}). Max ${lengthCheck.maxLength} ${unit}.`,
            severity: 'fault',
            cause: 'BadRequest'
          }
        }
      }

      const track = this.buildTrack(resolved)
      return { loadType: 'track', data: track }
    } catch (error) {
      const message = this.getErrorMessage(error)
      return {
        loadType: 'error',
        exception: { message, severity: 'fault', cause: 'Exception' }
      }
    }
  }

  /**
   * Resolves lazytts commands.
   * @param query - TTS query.
   * @returns Source result payload.
   */
  public async resolve(query: string): Promise<SourceResult> {
    return this.search(query)
  }

  /**
   * Builds encoded track payload for TTS request.
   * @param param0 - Resolved TTS request payload.
   * @returns Encoded track payload.
   */
  public buildTrack({
    text,
    serviceName,
    voiceId,
    voiceLabel
  }: {
    text: string
    serviceName: string
    voiceId: string
    voiceLabel: string
  }): {
    encoded: string
    info: TrackInfo
    pluginInfo: Record<string, unknown>
  } {
    const query = new URLSearchParams({
      service: String(serviceName),
      voice: String(voiceId),
      text: String(text)
    }).toString()
    const titleText = text.length > 50 ? `${text.substring(0, 47)}...` : text

    const track: TrackInfo = {
      identifier: `lazypytts:${query}`,
      isSeekable: true,
      author: 'LazyPy TTS',
      length: -1,
      isStream: false,
      position: 0,
      title: `TTS (${voiceLabel}): ${titleText}`,
      uri: `lazypytts:${query}`,
      artworkUrl: null,
      isrc: null,
      sourceName: 'lazypytts'
    }

    const encodedInput: TrackEncodeInput = { ...track, details: [] }
    return {
      encoded: encodeTrack(encodedInput),
      info: track,
      pluginInfo: {} as Record<string, unknown>
    }
  }

  /**
   * Returns stream URL descriptor for generated TTS track.
   * @param track - Decoded track info.
   * @returns Track URL result payload.
   */
  public async getTrackUrl(track: TrackInfo): Promise<TrackUrlResult> {
    return {
      url: track.uri,
      protocol: 'lazypytts',
      format: 'mp3'
    }
  }

  /**
   * Loads synthesized TTS stream.
   * @param decodedTrack - Decoded track metadata.
   * @param url - lazypytts URI.
   * @returns Stream result payload or exception payload.
   */
  public async loadStream(
    decodedTrack: TrackInfo,
    url: string,
    _protocol?: string,
    _additionalData?: Record<string, unknown>
  ): Promise<
    | (TrackStreamResult & { type?: string; exception?: { message: string } })
    | { exception: { message: string; severity: string; cause?: string } }
  > {
    logger(
      'debug',
      'Sources',
      `Loading LazyPy TTS stream for "${decodedTrack.title}"`
    )

    try {
      const parsed = this._parseInput(url)
      const resolved = this._resolveRequest(parsed)

      if (!resolved.text) {
        return {
          exception: {
            message: 'LazyPy TTS text is empty.',
            severity: 'fault',
            cause: 'BadRequest'
          }
        }
      }

      const lengthCheck = this._validateTextLength(
        resolved.text,
        resolved.service
      )
      if (lengthCheck) {
        const unit = lengthCheck.countBytes ? 'bytes' : 'characters'
        return {
          exception: {
            message: `Text too long for LazyPy TTS (${resolved.serviceName}). Max ${lengthCheck.maxLength} ${unit}.`,
            severity: 'fault',
            cause: 'BadRequest'
          }
        }
      }

      const body = new URLSearchParams({
        service: resolved.serviceName,
        voice: resolved.voiceId,
        text: resolved.text
      }).toString()

      const {
        body: responseBody,
        error,
        statusCode
      } = await makeRequest(REQUEST_URL, {
        method: 'POST',
        body,
        disableBodyCompression: true,
        headers: {
          Accept: '*/*',
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'https://lazypy.ro',
          Referer: 'https://lazypy.ro/tts/',
          'User-Agent': 'NodeLink/LazyPyTTS'
        }
      })

      if (error || statusCode !== 200 || !responseBody) {
        throw new Error(error || `LazyPy TTS returned status ${statusCode}`)
      }

      const payload =
        typeof responseBody === 'string'
          ? this.asRecord(JSON.parse(responseBody))
          : this.asRecord(responseBody)

      if (!payload?.success || !this.asString(payload.audio_url)) {
        throw new Error(
          this.asString(payload?.error_msg) || 'LazyPy TTS request failed.'
        )
      }

      const audioUrl = this.asString(payload.audio_url)
      if (!audioUrl) throw new Error('Audio URL is missing in the payload.')
      const audioResponse = await makeRequest(audioUrl, {
        method: 'GET',
        streamOnly: true,
        headers: {
          Accept: '*/*',
          'User-Agent': 'NodeLink/LazyPyTTS'
        }
      })

      if (audioResponse.error || !audioResponse.stream) {
        throw (
          new Error(audioResponse.error || 'Failed to get audio stream.') ||
          new Error('Failed to get stream, no stream object returned.')
        )
      }

      const stream = new PassThrough()

      audioResponse.stream.on('data', (chunk) => {
        stream.write(chunk)
      })

      audioResponse.stream.on('end', () => {
        stream.emit('finishBuffering')
        stream.end()
      })

      audioResponse.stream.on('close', () => {
        if (!stream.destroyed) stream.end()
      })

      audioResponse.stream.on('error', (err) => {
        logger('error', 'Sources', `LazyPy TTS stream error: ${err.message}`)
        if (!stream.destroyed) stream.destroy(err)
      })

      return { stream }
    } catch (error) {
      const message = this.getErrorMessage(error)
      logger('error', 'Sources', `Failed to load LazyPy TTS stream: ${message}`)
      return {
        exception: {
          message,
          severity: 'common',
          cause: 'Upstream'
        }
      }
    }
  }

  /**
   * Casts unknown value to object record.
   * @param value - Unknown value.
   * @returns Object record or null.
   */
  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  }

  /**
   * Casts unknown value to string.
   * @param value - Unknown value.
   * @returns String or null.
   */
  private asString(value: unknown): string | null {
    return typeof value === 'string' ? value : null
  }

  /**
   * Casts unknown value to number.
   * @param value - Unknown value.
   * @returns Number or null.
   */
  private asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }

  /**
   * Casts unknown value to boolean.
   * @param value - Unknown value.
   * @returns Boolean or null.
   */
  private asBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null
  }

  /**
   * Normalizes unknown errors to strings.
   * @param error - Unknown error value.
   * @returns Error message string.
   */
  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}
