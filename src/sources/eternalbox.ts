import { PassThrough, type Readable } from 'node:stream'
import * as MP4Box from 'mp4box'
import type { EternalboxSourceConfig } from '../typings/config/config.types.ts'
import type {
  EternalboxAnalysis,
  EternalboxCacheEntry,
  EternalboxPayload,
  EternalboxQuantum,
  EternalboxSegment
} from '../typings/sources/eternalbox.types.ts'
import type {
  SourceInstance,
  SourceResult,
  TrackData,
  TrackInfo,
  TrackStreamResult,
  TrackUrlResult,
  WorkerNodeLink
} from '../typings/sources/source.types.ts'
import { encodeTrack, http1makeRequest, logger } from '../utils.ts'

/**
 * Common sampling rates for AAC audio.
 * @internal
 */
const SAMPLE_RATES = Object.freeze([
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
  8000, 7350
])

/**
 * Creates an ADTS header for a single AAC frame.
 * @internal
 */
const _createAdtsHeader = (
  sampleLength: number,
  profile: number,
  samplingIndex: number,
  channelCount: number
): Buffer => {
  const frameLength = sampleLength + 7
  const profileIndex = profile - 1

  return Buffer.from([
    0xff,
    0xf1,
    ((profileIndex & 0x03) << 6) |
      ((samplingIndex & 0x0f) << 2) |
      ((channelCount & 0x04) >> 2),
    ((channelCount & 0x03) << 6) | ((frameLength & 0x1800) >> 11),
    (frameLength & 0x7f8) >> 3,
    ((frameLength & 0x7) << 5) | 0x1f,
    0xfc
  ])
}

/**
 * Internal interface for graph edges between beats.
 * @internal
 */
interface QuantumEdge {
  src: QuantumInternal
  dest: QuantumInternal
  distance: number
  deleted?: boolean
}

/**
 * Internal interface for bar quantum objects.
 * @internal
 */
interface BarInternal extends EternalboxQuantum {
  which: number
  prev: BarInternal | null
  next: BarInternal | null
  children: QuantumInternal[]
}

/**
 * Internal interface for beat quantum objects during algorithmic processing.
 * @internal
 */
interface QuantumInternal extends EternalboxQuantum {
  which: number
  prev: QuantumInternal | null
  next: QuantumInternal | null
  indexInParent: number
  parent: BarInternal | null
  overlappingSegments: EternalboxSegment[]
  oseg: EternalboxSegment | null
  all_neighbors: QuantumEdge[]
  neighbors: QuantumEdge[]
  reach: number
}

/**
 * Eternalbox source implementation.
 * Integrates with Eternalbox mirrors for "Infinite Loop" playback.
 * Parses MP4 containers into ADTS frames and applies beat-matching algorithms for seamless jumping.
 * @public
 */
export default class EternalboxSource implements SourceInstance {
  /**
   * The NodeLink worker context.
   * @internal
   */
  private readonly nodelink: WorkerNodeLink

  /**
   * Eternalbox specific configuration.
   * @internal
   */
  private readonly config: EternalboxSourceConfig

  /**
   * Base URL for API requests.
   * @internal
   */
  private readonly baseUrl: string

  /**
   * Search term prefixes recognized by this source.
   * @public
   */
  public readonly searchTerms = ['eternalbox', 'ebox', 'jukebox']

  /**
   * Priority score for source selection.
   * @public
   */
  public readonly priority = 60

  /**
   * Internal cache for analysis and audio frames.
   * @internal
   */
  private readonly cache = new Map<
    string,
    EternalboxCacheEntry | { analysis: EternalboxAnalysis }
  >()

  /**
   * Current cumulative size of the cache in bytes.
   * @internal
   */
  private cacheSizeBytes = 0

  /**
   * Maximum allowed size for the cumulative cache.
   * @internal
   */
  private readonly cacheMaxBytes: number

  /**
   * Regular expression patterns for identifying Eternalbox URLs and IDs.
   * @public
   */
  public readonly patterns: RegExp[]

  /**
   * Constructs a new EternalboxSource instance.
   * @param nodelink - The worker context.
   */
  constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
    this.config = (nodelink.options.sources?.eternalbox || {
      enabled: false,
      baseUrl: 'https://eternalboxmirror.xyz'
    }) as EternalboxSourceConfig

    this.baseUrl = this.config.baseUrl || 'https://eternalboxmirror.xyz'
    this.cacheMaxBytes = this.config.cacheMaxBytes ?? 20 * 1024 * 1024

    const mirrors = [
      'eternalboxmirror\\.xyz',
      'eternalbox\\.floriegl\\.tech',
      'eternal\\.floriegl\\.tech',
      'forever\\.reheated\\.org',
      'jukebox\\.justdavi\\.dev',
      'eternalbox\\.dev'
    ].join('|')

    this.patterns = [
      new RegExp(
        `https?:\\/\\/(?:www\\.)?(?:${mirrors})\\/jukebox_go\\.html\\?id=([A-Za-z0-9]+)`,
        'i'
      ),
      new RegExp(
        `https?:\\/\\/(?:www\\.)?(?:${mirrors})\\/api\\/analysis\\/analyse\\/([A-Za-z0-9]+)`,
        'i'
      ),
      new RegExp(
        `https?:\\/\\/(?:www\\.)?(?:${mirrors})\\/api\\/audio\\/jukebox\\/([A-Za-z0-9]+)`,
        'i'
      ),
      new RegExp(
        `https?:\\/\\/(?:www\\.)?(?:${mirrors})\\/api\\/audio\\/jukebox\\/([A-Za-z0-9]+)\\/location`,
        'i'
      )
    ]
  }

  /**
   * Performs source-level initialization.
   * @returns A promise resolving to true.
   * @public
   */
  public async setup(): Promise<boolean> {
    logger('info', 'Sources', 'Loaded Eternalbox source.')
    return true
  }

  /**
   * Executes a search on Eternalbox mirrors.
   * @param query - The search query or ID.
   * @returns A promise resolving to the search result payload.
   * @public
   */
  public async search(query: string): Promise<SourceResult> {
    if (!query) return { loadType: 'empty', data: {} }

    if (this._looksLikeId(query)) {
      return this.resolve(this._buildJukeboxUrl(query))
    }

    const limit =
      this.config.searchResults ||
      (this.nodelink.options.search.maxResults as number) ||
      10
    const url = `${this.baseUrl}/api/analysis/search?query=${encodeURIComponent(query)}&results=${limit}`

    try {
      const res = await http1makeRequest(url, {
        headers: this._buildApiHeaders()
      })
      if (res.statusCode !== 200) return { loadType: 'empty', data: {} }

      const items = this._extractItems(res.body)
      if (!items.length) return { loadType: 'empty', data: {} }

      const tracks = items
        .map((item) => this._buildTrackFromItem(item))
        .filter((t: TrackData | null): t is TrackData => t !== null)

      if (!tracks.length) return { loadType: 'empty', data: {} }
      return { loadType: 'search', data: tracks }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger('error', 'Eternalbox', `Search failed: ${message}`)
      return { loadType: 'error', exception: { message, severity: 'fault' } }
    }
  }

  /**
   * Resolves an Eternalbox URL or identifier into a track.
   * Fetches analysis data and optional Spotify enrichment.
   * @param url - The absolute Eternalbox URL.
   * @returns A promise resolving to the resolution result.
   * @public
   */
  public async resolve(url: string): Promise<SourceResult> {
    const id = this._extractId(url)
    if (!id) return { loadType: 'empty', data: {} }

    const baseUrl = this._extractBaseUrl(url)

    try {
      const [analysisPayload, ogAudioSource] = await Promise.all([
        this._fetchAnalysis(id, baseUrl),
        this._fetchOgAudioSource(id, baseUrl)
      ])
      if (!analysisPayload?.info) return { loadType: 'empty', data: {} }

      const spotifyData =
        analysisPayload.info.service === 'SPOTIFY'
          ? await this._fetchSpotifyInfo(analysisPayload.info.id || id)
          : null

      const trackData = this._buildTrack(
        analysisPayload,
        id,
        ogAudioSource,
        spotifyData,
        baseUrl
      )

      if (this._isEternalEnabled() && analysisPayload.analysis) {
        this._primeAnalysisCache(id, analysisPayload.analysis)
      }

      return { loadType: 'track', data: trackData }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger('error', 'Eternalbox', `Resolve failed: ${message}`)
      return { loadType: 'error', exception: { message, severity: 'fault' } }
    }
  }

  /**
   * Resolves a playable URL for an Eternalbox track.
   * @param track - Metadata of the track.
   * @returns A promise resolving to the playable URL payload.
   * @public
   */
  public async getTrackUrl(track: TrackInfo): Promise<TrackUrlResult> {
    const id = track.identifier || this._extractId(track.uri)
    if (!id) {
      return {
        exception: {
          message: 'Missing Eternalbox id for stream URL.',
          severity: 'common'
        }
      }
    }

    const baseUrl = this._extractBaseUrl(track.uri)

    return {
      url: this._buildStreamUrl(id, baseUrl),
      protocol: 'https',
      format: 'm4a',
      additionalData: { headers: this._buildStreamHeaders(id, baseUrl) }
    }
  }

  /**
   * Loads the audio stream, optionally applying the "Eternal" algorithm for infinite playback.
   * @public
   */
  public async loadStream(
    _decodedTrack: TrackInfo,
    url: string,
    _protocol?: string,
    additionalData?: Record<string, unknown>
  ): Promise<TrackStreamResult> {
    try {
      const id = this._extractId(url)
      const baseUrl = this._extractBaseUrl(url)
      const headers = {
        ...this._buildStreamHeaders(id || '', baseUrl),
        ...((additionalData?.headers as Record<string, string>) || {})
      }

      if (this._isEternalEnabled() && id) {
        const eternal = await this._getOrCreateEternalCache(id, headers)
        if (eternal?.stream) {
          return { stream: eternal.stream, type: eternal.type }
        }
      }

      const out = new PassThrough()
      let stopped = false
      let currentStream: Readable | null = null
      let reconnects = 0
      let lastHeaders: Record<string, string> | null = null
      const maxReconnects = this.config.maxReconnects ?? 0
      const reconnectDelayMs = this.config.reconnectDelayMs ?? 1000
      const allowInfinite = maxReconnects === 0

      const cleanupCurrent = () => {
        if (currentStream && !currentStream.destroyed) currentStream.destroy()
        currentStream = null
      }

      const scheduleReconnect = () => {
        if (stopped) return
        if (!allowInfinite && reconnects >= maxReconnects) {
          out.end()
          return
        }
        reconnects += 1
        setTimeout(() => {
          startRequest().catch((err) => {
            logger('error', 'Eternalbox', `Reconnect failed: ${err.message}`)
            scheduleReconnect()
          })
        }, reconnectDelayMs)
      }

      const startRequest = async () => {
        if (stopped) return
        const response = await http1makeRequest(url, {
          method: 'GET',
          streamOnly: true,
          headers
        })

        if (
          !response.stream ||
          (response.statusCode && response.statusCode >= 400)
        ) {
          throw new Error(
            `Stream request failed with status ${response.statusCode}`
          )
        }

        lastHeaders = (response.headers as Record<string, string>) || null
        currentStream = response.stream as Readable
        currentStream.pipe(out, { end: false })
        currentStream.on('end', () => {
          cleanupCurrent()
          scheduleReconnect()
        })
        currentStream.on('error', (err) => {
          logger('error', 'Eternalbox', `Stream error: ${err.message}`)
          cleanupCurrent()
          scheduleReconnect()
        })
      }

      out.on('close', () => {
        stopped = true
        cleanupCurrent()
      })
      out.on('error', () => {
        stopped = true
        cleanupCurrent()
      })

      startRequest().catch((err) => {
        logger('error', 'Eternalbox', `Failed to load stream: ${err.message}`)
        scheduleReconnect()
      })

      const contentType =
        lastHeaders?.['content-type'] || 'audio/mp4; codecs="mp4a.40.2"'
      return { stream: out, type: contentType }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger('error', 'Eternalbox', `Failed to load stream: ${message}`)
      return { exception: { message, severity: 'common' } }
    }
  }

  /**
   * Internal helper to extract result items from various API response formats.
   * @internal
   */
  private _extractItems(body: unknown): Record<string, unknown>[] {
    if (Array.isArray(body)) return body as Record<string, unknown>[]
    const b = body as Record<string, unknown> | null
    if (!b) return []
    if (Array.isArray(b.results)) return b.results as Record<string, unknown>[]
    if (Array.isArray(b.data)) return b.data as Record<string, unknown>[]
    if (Array.isArray(b.tracks)) return b.tracks as Record<string, unknown>[]
    if (Array.isArray(b.items)) return b.items as Record<string, unknown>[]

    const resultsObj = b.results as Record<string, unknown> | undefined
    if (Array.isArray(resultsObj?.items))
      return resultsObj.items as Record<string, unknown>[]
    if (Array.isArray(resultsObj?.data))
      return resultsObj.data as Record<string, unknown>[]

    return []
  }

  /**
   * Builds standardized TrackData from an API item.
   * @internal
   */
  private _buildTrackFromItem(item: Record<string, unknown>): TrackData | null {
    const info = (item.info || item.track || item) as EternalboxPayload['info']
    const id = (info.id || item.id) as string | undefined
    if (!id) return null
    return this._buildTrack({ info } as EternalboxPayload, id)
  }

  /**
   * Fetches full audio analysis for a track.
   * @internal
   */
  private async _fetchAnalysis(
    id: string,
    baseUrl = this.baseUrl
  ): Promise<EternalboxPayload | null> {
    const url = `${baseUrl}/api/analysis/analyse/${id}`
    const res = await http1makeRequest(url, {
      headers: this._buildApiHeaders()
    })
    if (res.statusCode !== 200) return null
    return res.body as EternalboxPayload
  }

  /**
   * Constructs a TrackData object from multiple sources.
   * @internal
   */
  private _buildTrack(
    payload: EternalboxPayload,
    id: string,
    ogAudioSource: string | null = null,
    spotifyData: Record<string, unknown> | null = null,
    baseUrl = this.baseUrl
  ): TrackData {
    const info = payload.info || {}
    const analysis = payload.analysis || null
    const spotifyTitle = spotifyData?.name as string | null
    const spotifyArtistsArr = spotifyData?.artists as
      | Array<{ name: string }>
      | undefined
    const spotifyArtists = Array.isArray(spotifyArtistsArr)
      ? spotifyArtistsArr
          .map((a) => a?.name)
          .filter(Boolean)
          .join(', ')
      : null

    const title = spotifyTitle || info.title || info.name || 'Unknown'
    const author = spotifyArtists || info.artist || info.author || 'Unknown'
    const duration = Number.parseInt(
      String(info.duration ?? info.length ?? -1),
      10
    )
    const summarySeconds = Number.parseFloat(
      String(analysis?.audio_summary?.duration ?? NaN)
    )
    const summaryMs = Number.isFinite(summarySeconds)
      ? Math.round(summarySeconds * 1000)
      : -1
    const length =
      Number.isFinite(duration) && duration > 0 ? duration : summaryMs
    const infiniteStream = this.config.infiniteStream ?? true
    const isStream = Boolean(infiniteStream)

    const spotifyAlbum = spotifyData?.album as
      | { images?: Array<{ url: string }> }
      | undefined
    const spotifyExternalIds = spotifyData?.external_ids as
      | { isrc?: string }
      | undefined

    const track: TrackInfo = {
      identifier: id,
      isSeekable: !isStream,
      author,
      length: isStream ? -1 : length,
      isStream,
      position: 0,
      title,
      uri: info.url || this._buildJukeboxUrl(id, baseUrl),
      artworkUrl:
        spotifyAlbum?.images?.[0]?.url || info.artwork || info.image || null,
      isrc: spotifyExternalIds?.isrc || info.isrc || null,
      sourceName: 'eternalbox'
    }

    const pluginInfo: Record<string, unknown> = {
      service: info.service || null,
      sourceUrl: info.url || null,
      analysisUrl: `${baseUrl}/api/analysis/analyse/${id}`,
      streamUrl: this._buildStreamUrl(id, baseUrl),
      ogAudioSourceUrl: `${baseUrl}/api/audio/jukebox/${id}/location`,
      ogAudioSource
    }

    if (this.config.includeAnalysisSummary ?? true) {
      pluginInfo.analysisSummary = this._buildAnalysisSummary(analysis, length)
    }

    if (spotifyData) {
      const spotifyUrls = spotifyData.external_urls as
        | { spotify?: string }
        | undefined
      pluginInfo.spotify = {
        id: spotifyData.id || id,
        url: spotifyUrls?.spotify || info.url || null,
        isrc: spotifyExternalIds?.isrc || null,
        artworkUrl: spotifyAlbum?.images?.[0]?.url || null,
        durationMs: spotifyData.duration_ms || null,
        previewUrl: spotifyData.preview_url || null
      }
    }

    if ((this.config.includeAnalysis ?? true) && analysis) {
      pluginInfo.analysis = analysis
    }

    return {
      encoded: encodeTrack({ ...track, details: [] }),
      info: track,
      pluginInfo
    }
  }

  /**
   * Extracts the Eternalbox ID from a URL or string.
   * @internal
   */
  private _extractId(input: string | undefined): string | null {
    if (!input || typeof input !== 'string') return null
    if (input.startsWith('eternalbox:'))
      return input.slice('eternalbox:'.length)
    if (input.startsWith('ebox:')) return input.slice('ebox:'.length)

    try {
      const url = new URL(input)
      const idFromQuery = url.searchParams.get('id')
      if (idFromQuery) return idFromQuery

      const match =
        url.pathname.match(/\/analyse\/([A-Za-z0-9]+)/i) ||
        url.pathname.match(/\/jukebox\/([A-Za-z0-9]+)/i)
      if (match?.[1]) return match[1]
    } catch {
      // ignore
    }
    return null
  }

  /**
   * Extracts the origin base URL from an input URL.
   * @internal
   */
  private _extractBaseUrl(input: string | undefined): string {
    try {
      if (typeof input !== 'string') return this.baseUrl
      const url = new URL(input)
      if (url.protocol.startsWith('http')) return url.origin
    } catch {
      // ignore
    }
    return this.baseUrl
  }

  /**
   * Validates if a string looks like an Eternalbox ID.
   * @internal
   */
  private _looksLikeId(value: string): boolean {
    return /^[A-Za-z0-9]{10,40}$/.test(value)
  }

  /**
   * Builds a full Jukebox web URL.
   * @internal
   */
  private _buildJukeboxUrl(id: string, baseUrl = this.baseUrl): string {
    return `${baseUrl}/jukebox_go.html?id=${id}`
  }

  /**
   * Builds a stream endpoint URL.
   * @internal
   */
  private _buildStreamUrl(id: string, baseUrl = this.baseUrl): string {
    return `${baseUrl}/api/audio/jukebox/${id}`
  }

  /**
   * Builds default API headers.
   * @internal
   */
  private _buildApiHeaders(): Record<string, string> {
    return { Accept: 'application/json' }
  }

  /**
   * Builds stream request headers.
   * @internal
   */
  private _buildStreamHeaders(
    id: string,
    baseUrl = this.baseUrl
  ): Record<string, string> {
    return {
      Accept: '*/*',
      Referer: this._buildJukeboxUrl(id, baseUrl),
      Origin: baseUrl,
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    }
  }

  /**
   * Fetches the original audio source location if redirected.
   * @internal
   */
  private async _fetchOgAudioSource(
    id: string,
    baseUrl = this.baseUrl
  ): Promise<string | null> {
    const url = `${baseUrl}/api/audio/jukebox/${id}/location`
    try {
      const res = await http1makeRequest(url, {
        headers: this._buildApiHeaders()
      })
      if (res.statusCode !== 200) return null
      return (res.body as { url?: string })?.url || null
    } catch {
      return null
    }
  }

  /**
   * Fetches track metadata from Spotify for enrichment.
   * @internal
   */
  private async _fetchSpotifyInfo(
    id: string
  ): Promise<Record<string, unknown> | null> {
    if (!this.config.enrichSpotify) return null
    const spotify = this.nodelink.sources?.getSource('spotify') as
      | (SourceInstance & {
          _apiRequest: (p: string) => Promise<Record<string, unknown>>
          accessToken: string | null
        })
      | undefined
    if (!spotify || typeof spotify._apiRequest !== 'function') return null

    try {
      await spotify.setup?.()
      if (!spotify.accessToken) return null
      return await spotify._apiRequest(`/tracks/${id}`)
    } catch {
      return null
    }
  }

  /**
   * Builds a summary of the audio analysis components.
   * @internal
   */
  private _buildAnalysisSummary(
    analysis: EternalboxAnalysis | null,
    length: number
  ): Record<string, number | null> {
    if (!analysis)
      return {
        durationMs: length > 0 ? length : null,
        beats: null,
        bars: null,
        sections: null,
        tatums: null,
        segments: null
      }
    return {
      durationMs: length > 0 ? length : null,
      beats: analysis.beats?.length || null,
      bars: analysis.bars?.length || null,
      sections: analysis.sections?.length || null,
      tatums: analysis.tatums?.length || null,
      segments: analysis.segments?.length || null
    }
  }

  /**
   * Checks if the Eternal algorithm is enabled in configuration.
   * @internal
   */
  private _isEternalEnabled(): boolean {
    return this.config.eternalStream ?? true
  }

  /**
   * Primes the internal cache with analysis data.
   * @internal
   */
  private _primeAnalysisCache(id: string, analysis: EternalboxAnalysis): void {
    const existing = this.cache.get(id)
    if (existing && 'analysis' in existing) return
    this.cache.set(id, { analysis })
  }

  /**
   * Clears all internal caches.
   * @internal
   */
  private _clearCache(): void {
    this.cache.clear()
    this.cacheSizeBytes = 0
  }

  /**
   * Gets or initializes an Eternal cache entry for a track.
   * Performs audio parsing and algorithmic graph building on first run.
   * @internal
   */
  private async _getOrCreateEternalCache(
    id: string,
    headers: Record<string, string>
  ): Promise<{ stream: Readable; type: string } | null> {
    const cached = this.cache.get(id)
    if (cached && 'streamReady' in cached && cached.streamReady) {
      return {
        stream: this._createEternalStream(cached, id),
        type: 'audio/aac'
      }
    }

    let analysis = cached && 'analysis' in cached ? cached.analysis : null
    if (!analysis) {
      const payload = await this._fetchAnalysis(id)
      analysis = payload?.analysis || null
    }
    if (!analysis?.beats?.length || !analysis?.segments?.length) return null

    const audioBuffer = await this._fetchAudioBufferWithLimit(id, headers)
    if (!audioBuffer) return null

    const parsed = this._parseMp4ToAdtsFrames(audioBuffer)
    if (!parsed?.frames?.length) return null

    const beatFrames = this._buildBeatFrameMap(
      analysis.beats,
      parsed.frameStarts,
      parsed.frameEnds
    )
    const neighborData = this._buildBeatNeighbors(
      analysis.beats,
      analysis.segments,
      analysis.bars
    )

    const entry: EternalboxCacheEntry = {
      analysis,
      frames: parsed.frames,
      frameStarts: parsed.frameStarts,
      frameEnds: parsed.frameEnds,
      beatFrames,
      beatNeighbors: neighborData.neighbors,
      lastBranchPoint: neighborData.lastBranchPoint,
      streamReady: true,
      sizeBytes: parsed.totalBytes
    }

    if (entry.sizeBytes > this.cacheMaxBytes) return null
    if (this.cacheSizeBytes + entry.sizeBytes > this.cacheMaxBytes)
      this._clearCache()

    this.cache.set(id, entry)
    this.cacheSizeBytes += entry.sizeBytes

    return { stream: this._createEternalStream(entry, id), type: 'audio/aac' }
  }

  /**
   * Fetches the full audio resource into a buffer, respecting size limits.
   * @internal
   */
  private async _fetchAudioBufferWithLimit(
    id: string,
    headers: Record<string, string>
  ): Promise<Buffer | null> {
    const url = this._buildStreamUrl(id)
    try {
      const res = await http1makeRequest(url, {
        method: 'GET',
        streamOnly: true,
        headers
      })
      if (!res.stream || (res.statusCode && res.statusCode >= 400)) return null

      return await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []
        let total = 0
        const stream = res.stream as Readable

        stream.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total > this.cacheMaxBytes) {
            stream.destroy(new Error('Cache limit exceeded'))
            reject(new Error('Cache limit exceeded'))
            return
          }
          chunks.push(chunk)
        })
        stream.on('end', () => resolve(Buffer.concat(chunks)))
        stream.on('error', (err) => reject(err))
      }).catch((err) => {
        logger('error', 'Eternalbox', `Cache download failed: ${err.message}`)
        return null
      })
    } catch {
      return null
    }
  }

  /**
   * Parses an MP4 buffer into individual ADTS-wrapped AAC frames.
   * @internal
   */
  private _parseMp4ToAdtsFrames(buffer: Buffer): {
    frames: Buffer[]
    frameStarts: number[]
    frameEnds: number[]
    totalBytes: number
  } {
    const mp4boxFile = MP4Box.createFile()
    const frames: Buffer[] = []
    const frameStarts: number[] = []
    const frameEnds: number[] = []
    let audioConfig: {
      profile: number
      samplingIndex: number
      channelCount: number
    } | null = null
    let timescale: number | null = null
    let totalBytes = 0

    mp4boxFile.onReady = (info: MP4Box.Movie) => {
      const audioTrack = info.tracks.find((t) => t.codec?.startsWith('mp4a'))
      if (!audioTrack?.timescale || !audioTrack.audio) return
      timescale = audioTrack.timescale
      audioConfig = this._getAudioConfig(audioTrack)
      mp4boxFile.setExtractionOptions(audioTrack.id, null, { nbSamples: 1 })
      mp4boxFile.start()
    }

    mp4boxFile.onSamples = (
      _id: number,
      _user: unknown,
      samples: MP4Box.Sample[]
    ) => {
      if (!audioConfig || !timescale) return
      for (const sample of samples) {
        if (!sample?.data) continue
        const sampleData = Buffer.from(sample.data)
        const adts = _createAdtsHeader(
          sampleData.byteLength,
          audioConfig.profile,
          audioConfig.samplingIndex,
          audioConfig.channelCount
        )
        const frame = Buffer.concat([adts, sampleData])
        frames.push(frame)
        totalBytes += frame.length
        frameStarts.push(sample.dts / timescale)
        frameEnds.push((sample.dts + sample.duration) / timescale)
      }
    }

    const arrayBuffer = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    ) as ArrayBuffer & { fileStart: number }
    arrayBuffer.fileStart = 0
    mp4boxFile.appendBuffer(arrayBuffer)
    mp4boxFile.flush()

    return { frames, frameStarts, frameEnds, totalBytes }
  }

  /**
   * Extracts AAC configuration from a track metadata node.
   * @internal
   */
  private _getAudioConfig(track: MP4Box.Track): {
    profile: number
    samplingIndex: number
    channelCount: number
  } {
    if (!track.audio) throw new Error('Missing audio metadata in track.')
    const samplingIndex = SAMPLE_RATES.indexOf(track.audio.sample_rate)
    if (samplingIndex === -1)
      throw new Error('Unsupported sample rate for ADTS.')

    let profile = 2
    if (track.codec) {
      const parts = track.codec.split('.')
      if (parts.length >= 3) {
        const valStr = parts[2]
        if (valStr) {
          const val = Number.parseInt(valStr, 10)
          if (Number.isFinite(val) && val > 0) profile = val
        }
      }
    }
    return {
      samplingIndex,
      channelCount: track.audio.channel_count,
      profile
    }
  }

  /**
   * Maps analysis beats to physical audio frame indices.
   * @internal
   */
  private _buildBeatFrameMap(
    beats: EternalboxQuantum[],
    frameStarts: number[],
    frameEnds: number[]
  ): Array<{ startFrame: number; endFrame: number }> {
    return beats.map((beat) => {
      const startIdx = this._findFrameIndex(frameStarts, beat.start)
      const endIdx = this._findFrameIndex(frameEnds, beat.start + beat.duration)
      return { startFrame: startIdx, endFrame: Math.max(startIdx, endIdx) }
    })
  }

  /**
   * Binary search for the closest frame index for a timestamp.
   * @internal
   */
  private _findFrameIndex(frameTimes: number[], target: number): number {
    let low = 0
    let high = frameTimes.length - 1
    let result = frameTimes.length - 1
    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      const val = frameTimes[mid]
      if (val !== undefined && val >= target) {
        result = mid
        high = mid - 1
      } else low = mid + 1
    }
    return result
  }

  /**
   * High-level algorithmic entry point for building the beat branching graph.
   * @internal
   */
  private _buildBeatNeighbors(
    beats: EternalboxQuantum[],
    segments: EternalboxSegment[],
    bars: EternalboxQuantum[]
  ): { neighbors: number[][]; lastBranchPoint: number } {
    const maxNeighbors = this.config.maxBranches ?? 4
    const maxThreshold = this.config.maxBranchThreshold ?? 80
    const startT = this.config.branchThresholdStart ?? 10
    const stepT = this.config.branchThresholdStep ?? 5
    const divisor = this.config.branchTargetDivisor ?? 6

    const segmentsToUse =
      (this.config.useFilteredSegments ?? true)
        ? this._filterSegments(segments)
        : segments
    const quanta = this._buildBeatQuanta(beats, segmentsToUse, bars, segments)
    this._precalculateNeighbors(quanta, maxNeighbors, maxThreshold)

    let threshold = startT
    const target = Math.floor(quanta.length / divisor)
    for (threshold = startT; threshold < maxThreshold; threshold += stepT) {
      const count = this._collectNeighbors(quanta, threshold)
      if (count >= target) break
    }

    if (this.config.addLastEdge ?? true) {
      const longest = this._longestBackwardBranch(quanta)
      this._insertBestBackwardBranch(quanta, threshold, longest < 50 ? 65 : 55)
    }

    this._calculateReachability(quanta)
    const lastBranchPoint = this._findBestLastBeat(quanta)
    this._filterBranches(quanta, lastBranchPoint)
    if (this.config.removeSequentialBranches ?? true)
      this._filterSequential(quanta, lastBranchPoint)

    return {
      neighbors: quanta.map((q) => q.neighbors.map((n) => n.dest.which)),
      lastBranchPoint
    }
  }

  /**
   * Prepares the graph nodes from analysis components.
   * @internal
   */
  private _buildBeatQuanta(
    beats: EternalboxQuantum[],
    segments: EternalboxSegment[],
    bars: EternalboxQuantum[],
    rawSegments: EternalboxSegment[]
  ): QuantumInternal[] {
    const quanta: QuantumInternal[] = beats.map((beat, index) => ({
      ...beat,
      which: index,
      prev: null,
      next: null,
      indexInParent: 0,
      parent: null,
      overlappingSegments: [],
      oseg: null,
      all_neighbors: [],
      neighbors: [],
      reach: 0
    }))

    for (let i = 0; i < quanta.length; i++) {
      const q = quanta[i]
      if (q) {
        q.prev = i > 0 ? (quanta[i - 1] ?? null) : null
        q.next = i < quanta.length - 1 ? (quanta[i + 1] ?? null) : null
      }
    }

    const barNodes: BarInternal[] = bars.map((bar, index) => ({
      ...bar,
      which: index,
      children: [] as QuantumInternal[],
      prev: null,
      next: null
    }))
    for (let i = 0; i < barNodes.length; i++) {
      const b = barNodes[i]
      if (b) {
        b.prev = i > 0 ? (barNodes[i - 1] ?? null) : null
        b.next = i < barNodes.length - 1 ? (barNodes[i + 1] ?? null) : null
      }
    }

    if (barNodes.length > 0) {
      let bIdx = 0
      for (const q of quanta) {
        while (bIdx < barNodes.length - 1) {
          const bar = barNodes[bIdx]
          if (bar && q.start >= bar.start + bar.duration) bIdx++
          else break
        }
        const parent = barNodes[bIdx]
        if (parent) {
          q.parent = parent
          q.indexInParent = parent.children.length
          parent.children.push(q)
        }
      }
    }

    for (let i = 0; i < segments.length; i++) {
      const s = segments[i]
      if (s) s.which = i
    }
    for (let i = 0; i < rawSegments.length; i++) {
      const s = rawSegments[i]
      if (s) s.which = s.which ?? i
    }

    let sIdx = 0
    let fIdx = 0
    for (const q of quanta) {
      while (fIdx < rawSegments.length) {
        const seg = rawSegments[fIdx]
        if (seg && seg.start < q.start) fIdx++
        else break
      }
      if (fIdx < rawSegments.length) q.oseg = rawSegments[fIdx] ?? null
      while (sIdx < segments.length) {
        const seg = segments[sIdx]
        if (seg && seg.start + seg.duration <= q.start) sIdx++
        else break
      }
      let cursor = sIdx
      while (cursor < segments.length) {
        const seg = segments[cursor]
        if (seg && seg.start < q.start + q.duration) {
          q.overlappingSegments.push(seg)
          cursor++
        } else break
      }
    }
    return quanta
  }

  /**
   * Pre-calculates similarity distances between all beats.
   * @internal
   */
  private _precalculateNeighbors(
    quanta: QuantumInternal[],
    max: number,
    maxT: number
  ): void {
    for (const q of quanta) {
      const edges: QuantumEdge[] = []
      if (!q.overlappingSegments.length) continue
      for (const q2 of quanta) {
        if (q2.which === q.which) continue
        let sum = 0
        for (let j = 0; j < q.overlappingSegments.length; j++) {
          const s1 = q.overlappingSegments[j]
          if (!s1) continue
          let dist = 100
          if (j < q2.overlappingSegments.length) {
            const s2 = q2.overlappingSegments[j]
            if (s2)
              dist = s1.which === s2.which ? 100 : this._getSegDistance(s1, s2)
          }
          sum += dist
        }
        const pDist = q.indexInParent === q2.indexInParent ? 0 : 100
        const total = sum / q.overlappingSegments.length + pDist
        if (total < maxT) edges.push({ src: q, dest: q2, distance: total })
      }
      edges.sort((a, b) => a.distance - b.distance)
      q.all_neighbors = edges.slice(0, max)
    }
  }

  /**
   * Selects neighbors based on current threshold and algorithmic constraints.
   * @internal
   */
  private _collectNeighbors(
    quanta: QuantumInternal[],
    threshold: number
  ): number {
    let count = 0
    const minLong = Math.floor(quanta.length / 5)
    for (const q of quanta) {
      q.neighbors = q.all_neighbors.filter((n) => {
        if (this.config.justBackwards && n.dest.which > q.which) return false
        if (
          this.config.justLongBranches &&
          Math.abs(n.dest.which - q.which) < minLong
        )
          return false
        return n.distance <= threshold
      })
      if (q.neighbors.length > 0) count++
    }
    return count
  }

  /**
   * Euclidean distance between two feature vectors.
   * @internal
   */
  private _getSegDistance(
    s1: EternalboxSegment,
    s2: EternalboxSegment
  ): number {
    const tW = this.config.timbreWeight ?? 1
    const pW = this.config.pitchWeight ?? 10
    const lSW = this.config.loudStartWeight ?? 1
    const lMW = this.config.loudMaxWeight ?? 1
    const dW = this.config.durationWeight ?? 100
    const cW = this.config.confidenceWeight ?? 1

    const timbre = this._euclidean(s1.timbre, s2.timbre)
    const pitch = this._euclidean(s1.pitches, s2.pitches)
    const lStart = Math.abs(s1.loudness_start - s2.loudness_start)
    const lMax = Math.abs(s1.loudness_max - s2.loudness_max)
    const duration = Math.abs(s1.duration - s2.duration)
    const confidence = Math.abs(s1.confidence - s2.confidence)

    return (
      timbre * tW +
      pitch * pW +
      lStart * lSW +
      lMax * lMW +
      duration * dW +
      confidence * cW
    )
  }

  private _euclidean(a: number[], b: number[]): number {
    if (!a || !b) return 100
    let sum = 0
    for (let i = 0; i < a.length; i++) {
      const valA = a[i] ?? 0
      const valB = b[i] ?? 0
      const delta = valB - valA
      sum += delta * delta
    }
    return Math.sqrt(sum)
  }

  /**
   * Measures the longest backward branch in the current graph.
   * @internal
   */
  private _longestBackwardBranch(quanta: QuantumInternal[]): number {
    let longest = 0
    for (const q of quanta) {
      for (const n of q.neighbors) {
        const delta = q.which - n.dest.which
        if (delta > longest) longest = delta
      }
    }
    return (longest * 100) / quanta.length
  }

  /**
   * Forces the insertion of a high-quality backward branch if none exist.
   * @internal
   */
  private _insertBestBackwardBranch(
    quanta: QuantumInternal[],
    t: number,
    maxT: number
  ): void {
    const branches: { percent: number; q: QuantumInternal; n: QuantumEdge }[] =
      []
    for (const q of quanta) {
      for (const n of q.all_neighbors) {
        const delta = q.which - n.dest.which
        if (delta > 0 && n.distance < maxT)
          branches.push({ percent: (delta * 100) / quanta.length, q, n })
      }
    }
    if (!branches.length) return
    branches.sort((a, b) => b.percent - a.percent)
    const best = branches[0]
    if (best && best.n.distance > t) best.q.neighbors.push(best.n)
  }

  /**
   * Iteratively calculates reachability for graph nodes.
   * @internal
   */
  private _calculateReachability(quanta: QuantumInternal[]): void {
    for (const q of quanta) q.reach = quanta.length - q.which
    for (let iter = 0; iter < 1000; iter++) {
      let changedTotal = 0
      for (let i = 0; i < quanta.length; i++) {
        const q = quanta[i]
        if (!q) continue
        const old = q.reach
        for (const n of q.neighbors)
          if (n.dest.reach > q.reach) q.reach = n.dest.reach
        if (i < quanta.length - 1) {
          const next = quanta[i + 1]
          if (next && next.reach > q.reach) q.reach = next.reach
        }
        if (q.reach !== old) {
          changedTotal++
          for (let j = 0; j < q.which; j++) {
            const prev = quanta[j]
            if (prev && prev.reach < q.reach) prev.reach = q.reach
          }
        }
      }
      if (changedTotal === 0) break
    }
  }

  /**
   * Finds the latest beat from which the entire song remains reachable.
   * @internal
   */
  private _findBestLastBeat(quanta: QuantumInternal[]): number {
    let longest = 0
    let longestReach = 0
    for (let i = quanta.length - 1; i >= 0; i--) {
      const q = quanta[i]
      if (!q) continue
      const reach = ((q.reach - (quanta.length - i)) * 100) / quanta.length
      if (reach > longestReach && q.neighbors.length > 0) {
        longestReach = reach
        longest = i
        if (reach >= 50) break
      }
    }
    return longest
  }

  private _filterBranches(quanta: QuantumInternal[], last: number): void {
    for (let i = 0; i < last; i++) {
      const q = quanta[i]
      if (q) q.neighbors = q.neighbors.filter((n) => n.dest.which < last)
    }
  }

  private _filterSequential(quanta: QuantumInternal[], last: number): void {
    for (let i = quanta.length - 1; i >= 1; i--) {
      const q = quanta[i]
      if (!q) continue
      q.neighbors = q.neighbors.filter((n) => {
        if (q.which === last || !q.prev) return true
        const dist = q.which - n.dest.which
        const qPrev = q.prev
        return !qPrev.neighbors.some(
          (on) => qPrev.which - on.dest.which === dist
        )
      })
    }
  }

  /**
   * Filters segments to merge similar consecutive ones.
   * @internal
   */
  private _filterSegments(segments: EternalboxSegment[]): EternalboxSegment[] {
    if (!segments.length) return []
    const first = segments[0]
    if (!first) return []
    const filtered = [first]
    for (let i = 1; i < segments.length; i++) {
      const s = segments[i]
      const last = filtered[filtered.length - 1]
      if (
        s &&
        last &&
        this._timbralDistance(s, last) < 1 &&
        (s.confidence ?? 1) < 0.3
      ) {
        filtered[filtered.length - 1] = {
          ...last,
          duration: last.duration + s.duration
        }
      } else if (s) filtered.push(s)
    }
    return filtered
  }

  private _timbralDistance(
    s1: EternalboxSegment,
    s2: EternalboxSegment
  ): number {
    const a = s1.timbre || []
    const b = s2.timbre || []
    let sum = 0
    for (let i = 0; i < 3; i++) {
      const valA = a[i] ?? 0
      const valB = b[i] ?? 0
      const delta = valB - valA
      sum += delta * delta
    }
    return Math.sqrt(sum)
  }

  /**
   * Creates an active PassThrough stream that pumps frames according to the branching graph.
   * @internal
   */
  private _createEternalStream(
    entry: EternalboxCacheEntry,
    id: string
  ): Readable {
    const {
      frames,
      beatFrames,
      beatNeighbors: neighbors,
      lastBranchPoint
    } = entry
    const minC = this.config.minRandomBranchChance ?? 0.18
    const maxC = this.config.maxRandomBranchChance ?? 0.5
    const deltaC = this.config.randomBranchChanceDelta ?? 0.018

    let curBeat = 0
    const firstBeat = beatFrames[0]
    let curFrame = firstBeat?.startFrame ?? 0
    let endFrame = firstBeat?.endFrame ?? frames.length - 1
    let stopped = false
    let paused = false
    let chance = minC
    const offsets = new Array(neighbors.length).fill(0)

    const stream = new PassThrough()

    const chooseNext = (): number => {
      let next = curBeat + 1
      if (next >= beatFrames.length) {
        stream.emit('eternalboxJump', {
          id,
          fromBeat: curBeat,
          toBeat: 0,
          type: 'loop'
        })
        next = 0
      }
      const list = neighbors[next] || []
      if (!list.length) return next

      if (next === lastBranchPoint) {
        chance = minC
        return this._selectNext(list, offsets, next, id, stream)
      }

      chance = Math.min(maxC, chance + deltaC)
      if (Math.random() < chance) {
        chance = minC
        return this._selectNext(list, offsets, next, id, stream)
      }
      return next
    }

    const pump = () => {
      if (stopped || paused) return
      while (true) {
        while (curFrame <= endFrame) {
          const frame = frames[curFrame]
          if (frame && !stream.write(frame)) {
            paused = true
            stream.once('drain', () => {
              paused = false
              setImmediate(pump)
            })
            return
          }
          curFrame++
        }
        const next = chooseNext()
        curBeat = next
        const nextBeat = beatFrames[curBeat]
        curFrame = nextBeat?.startFrame ?? 0
        endFrame = nextBeat?.endFrame ?? frames.length - 1
      }
    }

    stream.on('close', () => {
      stopped = true
    })
    stream.on('finish', () => {
      stopped = true
    })
    setImmediate(pump)
    return stream
  }

  private _selectNext(
    list: number[],
    offsets: number[],
    beat: number,
    id: string,
    stream: PassThrough
  ): number {
    const off = (offsets[beat] ?? 0) as number
    const next = list[off % list.length] ?? beat
    offsets[beat] = (off + 1) % list.length
    stream.emit('eternalboxJump', {
      id,
      fromBeat: beat,
      toBeat: next,
      type: 'jump'
    })
    return next
  }
}
