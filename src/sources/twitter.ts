import { PassThrough } from 'node:stream'
import HLSHandler from '../playback/hls/HLSHandler.ts'
import type {
  SourceResult,
  TrackInfo,
  TrackStreamResult,
  TrackUrlResult,
  WorkerNodeLink
} from '../typings/sources/source.types.ts'
import type {
  HttpRequestResult,
  TrackEncodeInput
} from '../typings/utils.types.ts'
import { encodeTrack, http1makeRequest, logger } from '../utils.ts'

const TWITTER_AUTH_BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
const TWITTER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const TWITTER_PATTERN =
  /https?:\/\/(?:(?:www|m(?:obile)?)\.)?(?:twitter|x)\.com\/(?:[^/]+)\/status\/(\d+)/i
const TWITTER_TOKEN_TTL_MS = 1000 * 60 * 60 * 3
const TWITTER_TRACK_CACHE_TTL_MS = 1000 * 60 * 60 * 2

/**
 * JSON-compatible scalar or nested value used for payload narrowing.
 */
type JsonValue = JsonRecord | JsonValue[] | string | number | boolean | null

/**
 * Object-like JSON record used to safely inspect HTTP payloads.
 */
interface JsonRecord {
  [key: string]: JsonValue | undefined
}

/**
 * Runtime options consumed by the Twitter source.
 */
interface TwitterRuntimeOptions {
  /**
   * Global maximum search-result limit used by several sources.
   */
  maxSearchResults?: number
}

/**
 * Track-specific plugin metadata attached to Twitter tracks.
 */
interface TwitterTrackPluginInfo {
  /**
   * Direct media URL extracted from Twitter.
   */
  directUrl: string

  /**
   * Whether the direct media URL points to an HLS playlist.
   */
  isHLS: boolean
}

/**
 * Payload accepted by the shared encoder.
 */
interface TwitterTrackInfo extends TrackEncodeInput {
  /**
   * Whether the generated track can be seeked.
   */
  isSeekable: boolean

  /**
   * Canonical Twitter or X URL.
   */
  uri: string

  /**
   * Artwork URL when available.
   */
  artworkUrl: string | null

  /**
   * Twitter does not expose ISRC values in this source path.
   */
  isrc: null
}

/**
 * Encoded Twitter track payload returned to callers.
 */
interface TwitterTrackData {
  /**
   * Base64-encoded Lavalink-compatible track payload.
   */
  encoded: string

  /**
   * Human-readable track information.
   */
  info: TwitterTrackInfo

  /**
   * Twitter-specific stream metadata.
   */
  pluginInfo: TwitterTrackPluginInfo
}

/**
 * Direct playback URL descriptor cached by the Twitter source.
 */
interface TwitterTrackUrlSuccess extends TrackUrlResult {
  /**
   * Direct Twitter media URL.
   */
  url: string

  /**
   * Transport protocol used for playback.
   */
  protocol: 'hls' | 'https'

  /**
   * Returned media format.
   */
  format: 'm3u8' | 'mp4'
}

/**
 * Additional playback data accepted by the Twitter stream loader.
 */
interface TwitterAdditionalData {
  /**
   * Start time in milliseconds for HLS playback.
   */
  startTime?: number
}

/**
 * Minimal cache-manager contract used by the Twitter source.
 */
interface TwitterTrackCacheManager {
  /**
   * Retrieves a cached value by source and identifier.
   *
   * @param source Source name.
   * @param identifier Track identifier.
   * @returns Cached value or `null`.
   */
  get: <T>(source: string, identifier: string) => T | null

  /**
   * Stores a cached value with a TTL.
   *
   * @param source Source name.
   * @param identifier Track identifier.
   * @param value Cached payload.
   * @param ttlMs Time to live in milliseconds.
   */
  set: <T>(source: string, identifier: string, value: T, ttlMs?: number) => void
}

/**
 * Normalized media variant returned by Twitter or syndication fallbacks.
 */
interface TwitterVariant {
  /**
   * MIME type returned by the upstream payload.
   */
  contentType: string | null

  /**
   * Variant bitrate when available.
   */
  bitrate: number | null

  /**
   * Direct media URL for the variant.
   */
  url: string | null
}

/**
 * Normalized track data extracted from Twitter responses before encoding.
 */
interface TwitterResolvedTrackInput {
  /**
   * Stable tweet identifier.
   */
  identifier: string

  /**
   * Human-readable author name.
   */
  author: string

  /**
   * Media duration in milliseconds.
   */
  length: number

  /**
   * Human-readable content title.
   */
  title: string

  /**
   * Canonical tweet URL.
   */
  uri: string

  /**
   * Artwork URL when available.
   */
  artworkUrl: string | null

  /**
   * Direct Twitter media URL.
   */
  directUrl: string
}

/**
 * Exception payload returned by Twitter operations.
 */
interface TwitterExceptionResult {
  /**
   * Structured source exception metadata.
   */
  exception: {
    /**
     * Human-readable failure reason.
     */
    message: string

    /**
     * Error severity used by the source pipeline.
     */
    severity: string
  }
}

/**
 * Twitter/X source implementation.
 */
export default class TwitterSource {
  /**
   * Runtime worker context used by the source implementation.
   */
  public readonly nodelink: WorkerNodeLink

  /**
   * URL patterns supported by this source.
   */
  public readonly patterns: RegExp[]

  /**
   * Match priority used by the source manager.
   */
  public readonly priority: number

  /**
   * Current guest token used for Twitter GraphQL endpoints.
   */
  public guestToken: string | null

  /**
   * Expiration timestamp for the current guest token.
   */
  public tokenExpiry: number

  /**
   * Creates a new Twitter source wrapper.
   *
   * @param nodelink Worker runtime used by the source implementation.
   */
  public constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
    this.patterns = [TWITTER_PATTERN]
    this.priority = 70
    this.guestToken = null
    this.tokenExpiry = 0
  }

  /**
   * Initializes the guest token required by the Twitter GraphQL endpoints.
   *
   * @returns `true` when the source is ready to accept requests.
   */
  public async setup(): Promise<boolean> {
    await this.refreshGuestToken()
    logger('info', 'Sources', 'Loaded Twitter (X) source.')
    return true
  }

  /**
   * Searches Twitter for recent tweets containing playable video media.
   *
   * @param query Search query.
   * @returns Search results, an empty payload, or a structured exception.
   */
  public async search(query: string): Promise<SourceResult> {
    try {
      const features: JsonRecord = {
        responsive_web_graphql_timeline_navigation_enabled: true
      }
      const variables: JsonRecord = {
        rawQuery: `${query} filter:videos`,
        count: this.getMaxSearchResults(),
        querySource: 'typed_query',
        product: 'Latest'
      }
      const { body } = await this.callGraphQL(
        'gk_S_vsh_PyInisUnZun6Q/SearchTimeline',
        variables,
        features
      )

      const payload = this.parseJsonBody(body)
      if (!payload) {
        return { loadType: 'empty', data: {} }
      }

      const instructions = this.getSearchInstructions(payload)
      const tracks: TwitterTrackData[] = []

      for (const instruction of instructions) {
        const type = this.getString(instruction, 'type')
        if (type !== 'TimelineAddEntries') {
          continue
        }

        const entries = this.getArray(instruction, 'entries')
        for (const entryValue of entries) {
          const entry = this.getRecordFromValue(entryValue)
          if (!entry) {
            continue
          }

          const itemContent = this.getNestedRecord(entry, [
            'content',
            'itemContent',
            'tweet_results',
            'result'
          ])
          if (!itemContent) {
            continue
          }

          const tweetResult = this.unwrapTweetResult(itemContent)
          if (!tweetResult) {
            continue
          }

          const identifier = this.getTweetIdentifier(tweetResult)
          const trackInput = identifier
            ? this.extractTrackInputFromGraphql(
                tweetResult,
                `https://twitter.com/i/status/${identifier}`
              )
            : null

          if (!trackInput) {
            continue
          }

          tracks.push(this.buildTrack(trackInput))
          if (tracks.length >= this.getMaxSearchResults()) {
            return { loadType: 'search', data: tracks }
          }
        }
      }

      return tracks.length > 0
        ? { loadType: 'search', data: tracks }
        : { loadType: 'empty', data: {} }
    } catch (error) {
      logger(
        'error',
        'Twitter',
        `Search failed: ${error instanceof Error ? error.message : String(error)}`
      )
      return { loadType: 'empty', data: {} }
    }
  }

  /**
   * Resolves a tweet URL into a playable track using the GraphQL tweet lookup
   * and, when necessary, the public syndication fallback.
   *
   * @param url Public Twitter or X status URL.
   * @returns A track, an empty payload, or a structured exception.
   */
  public async resolve(url: string): Promise<SourceResult> {
    const match = url.match(TWITTER_PATTERN)
    const identifier = match?.[1]
    if (!identifier) {
      return { loadType: 'empty', data: {} }
    }

    try {
      const features: JsonRecord = {
        creator_subscriptions_tweet_preview_api_enabled: true,
        responsive_web_graphql_timeline_navigation_enabled: true,
        longform_notetweets_inline_media_enabled: true,
        tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true
      }
      const variables: JsonRecord = {
        tweetId: identifier,
        withCommunity: false,
        includePromotedContent: false,
        withVoice: true
      }

      const graphResponse = await this.callGraphQL(
        '2ICDjqPd81tulZcYrtpTuQ/TweetResultByRestId',
        variables,
        features
      )
      const graphPayload = this.parseJsonBody(graphResponse.body)

      if (graphPayload) {
        const resultRecord = this.getNestedRecord(graphPayload, [
          'data',
          'tweetResult',
          'result'
        ])
        const tweetResult = this.unwrapTweetResult(resultRecord)
        const graphTrack = tweetResult
          ? this.extractTrackInputFromGraphql(tweetResult, url)
          : null

        if (graphTrack) {
          return { loadType: 'track', data: this.buildTrack(graphTrack) }
        }
      }

      const syndicationToken = this.generateSyndicationToken(identifier)
      const syndicationResponse = await http1makeRequest(
        `https://cdn.syndication.twimg.com/tweet-result?id=${identifier}&token=${syndicationToken}&lang=en`,
        {
          headers: { 'User-Agent': 'Googlebot' }
        }
      )
      const syndicationPayload = this.parseJsonBody(syndicationResponse.body)
      const syndicationTrack = syndicationPayload
        ? this.extractTrackInputFromSyndication(
            identifier,
            syndicationPayload,
            url
          )
        : null

      if (syndicationTrack) {
        return { loadType: 'track', data: this.buildTrack(syndicationTrack) }
      }
    } catch (error) {
      logger(
        'error',
        'Twitter',
        `Resolution failed for ${identifier}: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    return { loadType: 'empty', data: {} }
  }

  /**
   * Resolves a direct playback URL for a Twitter track. The result is cached so
   * repeated playback requests do not need to resolve the tweet again.
   *
   * @param track Decoded Twitter track information.
   * @param _itag Unused itag placeholder kept for source-manager compatibility.
   * @param forceRefresh Whether to bypass the cache.
   * @returns Direct playback URL metadata or a structured exception.
   */
  public async getTrackUrl(
    track: TrackInfo & { pluginInfo?: Partial<TwitterTrackPluginInfo> },
    _itag?: number,
    forceRefresh: boolean = false
  ): Promise<TwitterTrackUrlSuccess | TwitterExceptionResult> {
    const cacheManager = this.nodelink.trackCacheManager as
      | TwitterTrackCacheManager
      | undefined

    if (!forceRefresh && cacheManager) {
      const cached = cacheManager.get<TwitterTrackUrlSuccess>(
        'twitter',
        track.identifier
      )
      if (cached) {
        return cached
      }
    }

    if (track.pluginInfo?.directUrl) {
      const resolved = this.createTrackUrlResult(
        track.pluginInfo.directUrl,
        track.pluginInfo.isHLS === true
      )
      cacheManager?.set(
        'twitter',
        track.identifier,
        resolved,
        TWITTER_TRACK_CACHE_TTL_MS
      )
      return resolved
    }

    const resolvedTrack = await this.resolve(track.uri)
    const trackData = this.extractTrackFromResult(resolvedTrack)

    if (!trackData) {
      return {
        exception: {
          message: 'Failed to extract Twitter media URL',
          severity: 'fault'
        }
      }
    }

    const resolved = this.createTrackUrlResult(
      trackData.pluginInfo.directUrl,
      trackData.pluginInfo.isHLS
    )
    cacheManager?.set(
      'twitter',
      track.identifier,
      resolved,
      TWITTER_TRACK_CACHE_TTL_MS
    )
    return resolved
  }

  /**
   * Loads a Twitter media stream. HLS playback is delegated to the HLS handler;
   * direct MP4 playback is proxied through a `PassThrough` stream.
   *
   * @param _decodedTrack Decoded Twitter track information.
   * @param url Resolved playback URL.
   * @param _protocol Optional protocol hint.
   * @param additionalData Optional playback modifiers.
   * @returns A readable stream or a structured exception.
   */
  public async loadStream(
    _decodedTrack: TrackInfo,
    url: string,
    _protocol?: string,
    additionalData?: TwitterAdditionalData
  ): Promise<TrackStreamResult | TwitterExceptionResult> {
    try {
      const streamHeaders: Record<string, string> = {
        'User-Agent': TWITTER_USER_AGENT,
        Referer: 'https://twitter.com/'
      }
      const localAddress = this.nodelink.routePlanner?.getIP?.() ?? null

      if (url.includes('.m3u8')) {
        const stream = new HLSHandler(url, {
          type: 'fmp4',
          strategy: 'segmented',
          headers: streamHeaders,
          localAddress,
          startTime: additionalData?.startTime ?? 0
        })

        return { stream, type: 'fmp4' }
      }

      const response = await http1makeRequest(url, {
        method: 'GET',
        headers: streamHeaders,
        streamOnly: true
      })

      if (response.error || !response.stream) {
        throw new Error(response.error ?? 'Failed to get Twitter media stream')
      }

      const stream = new PassThrough()
      let finished = false

      const finish = (): void => {
        if (finished) {
          return
        }

        finished = true
        if (!stream.writableEnded) {
          stream.emit('finishBuffering')
          stream.end()
        }
      }

      response.stream.on('data', (chunk) => {
        if (!stream.destroyed) {
          stream.write(chunk)
        }
      })

      response.stream.on('end', finish)
      response.stream.on('close', finish)
      response.stream.on('error', (error) => {
        logger('error', 'Twitter', `External stream error: ${error.message}`)
        if (!stream.destroyed) {
          stream.destroy(error)
        }
      })

      return { stream, type: 'video/mp4' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger('error', 'Twitter', `Failed to load stream: ${message}`)
      return { exception: { message, severity: 'fault' } }
    }
  }

  /**
   * Activates or refreshes the Twitter guest token required by GraphQL calls.
   *
   * @returns `true` when a guest token was obtained.
   */
  private async refreshGuestToken(): Promise<boolean> {
    try {
      const response = await http1makeRequest(
        'https://api.twitter.com/1.1/guest/activate.json',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${TWITTER_AUTH_BEARER}`,
            'User-Agent': TWITTER_USER_AGENT
          }
        }
      )

      const payload = this.parseJsonBody(response.body)
      const guestToken = payload ? this.getString(payload, 'guest_token') : null

      if (response.statusCode === 200 && guestToken) {
        this.guestToken = guestToken
        this.tokenExpiry = Date.now() + TWITTER_TOKEN_TTL_MS
        return true
      }
    } catch (error) {
      logger(
        'error',
        'Twitter',
        `Guest token activation failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    return false
  }

  /**
   * Builds the public syndication token used by Twitter's fallback endpoint.
   *
   * @param identifier Stable tweet identifier.
   * @returns Deterministic syndication token.
   */
  private generateSyndicationToken(identifier: string): string {
    return ((Number(identifier) / 1e15) * Math.PI)
      .toString(36)
      .replace(/[0.]/g, '')
  }

  /**
   * Executes a Twitter GraphQL request with the current guest token.
   *
   * @param operation GraphQL operation identifier.
   * @param variables GraphQL variables payload.
   * @param features GraphQL features payload.
   * @returns Raw HTTP response from the GraphQL endpoint.
   */
  private async callGraphQL(
    operation: string,
    variables: JsonRecord,
    features: JsonRecord
  ): Promise<HttpRequestResult> {
    if (!this.guestToken || Date.now() > this.tokenExpiry) {
      await this.refreshGuestToken()
    }

    const url =
      `https://twitter.com/i/api/graphql/${operation}?variables=${encodeURIComponent(JSON.stringify(variables))}` +
      `&features=${encodeURIComponent(JSON.stringify(features))}`

    return http1makeRequest(url, {
      headers: {
        Authorization: `Bearer ${TWITTER_AUTH_BEARER}`,
        'x-guest-token': this.guestToken ?? '',
        'x-twitter-active-user': 'yes',
        'x-twitter-client-language': 'en',
        'User-Agent': TWITTER_USER_AGENT,
        Referer: 'https://twitter.com/'
      }
    })
  }

  /**
   * Reads the configured maximum number of search results.
   *
   * @returns A positive integer limit used by Twitter search.
   */
  private getMaxSearchResults(): number {
    const options = this.nodelink.options as TwitterRuntimeOptions
    const limit = options.maxSearchResults

    return typeof limit === 'number' && Number.isInteger(limit) && limit > 0
      ? limit
      : 10
  }

  /**
   * Extracts search instructions from a Twitter search GraphQL payload.
   *
   * @param payload Parsed GraphQL payload.
   * @returns Timeline instruction records.
   */
  private getSearchInstructions(payload: JsonRecord): JsonRecord[] {
    const timeline = this.getNestedRecord(payload, [
      'data',
      'search_by_raw_query',
      'search_timeline',
      'timeline'
    ])
    const instructions = timeline ? this.getArray(timeline, 'instructions') : []

    return instructions
      .map((value) => this.getRecordFromValue(value))
      .filter((record): record is JsonRecord => record !== null)
  }

  /**
   * Unwraps the Twitter tweet-result payload, accounting for
   * `TweetWithVisibilityResults`.
   *
   * @param value Raw tweet-result record.
   * @returns Unwrapped tweet record or `null`.
   */
  private unwrapTweetResult(value?: JsonRecord | null): JsonRecord | null {
    if (!value) {
      return null
    }

    const typename = this.getString(value, '__typename')
    if (typename === 'TweetWithVisibilityResults') {
      return this.getRecord(value, 'tweet')
    }

    return value
  }

  /**
   * Extracts the tweet identifier from a GraphQL tweet result.
   *
   * @param result Unwrapped tweet result.
   * @returns Stable tweet identifier or `null`.
   */
  private getTweetIdentifier(result: JsonRecord): string | null {
    const legacy = this.getRecord(result, 'legacy')
    return legacy ? this.getString(legacy, 'id_str') : null
  }

  /**
   * Extracts normalized track fields from a GraphQL tweet result.
   *
   * @param result Unwrapped tweet result.
   * @param url Canonical tweet URL.
   * @returns Normalized track fields or `null` when no playable media exists.
   */
  private extractTrackInputFromGraphql(
    result: JsonRecord,
    url: string
  ): TwitterResolvedTrackInput | null {
    const legacy = this.getRecord(result, 'legacy')
    if (!legacy) {
      return null
    }

    const identifier = this.getString(legacy, 'id_str')
    const text = this.getString(legacy, 'full_text')
    const media = this.findMediaRecord(
      this.getNestedRecord(legacy, ['extended_entities'])
    )

    if (!identifier || !media) {
      return null
    }

    const videoInfo = this.getRecord(media, 'video_info')
    const variants = videoInfo ? this.getVariants(videoInfo, 'variants') : []
    const bestVariant = this.selectBestVariant(variants)

    if (!bestVariant?.url) {
      return null
    }

    const authorName =
      this.getString(
        this.getNestedRecord(result, [
          'core',
          'user_results',
          'result',
          'legacy'
        ]) ?? {},
        'name'
      ) ?? 'Twitter User'

    return {
      identifier,
      author: authorName,
      length: videoInfo
        ? (this.getNumber(videoInfo, 'duration_millis') ?? 0)
        : 0,
      title: this.normalizeTitle(text),
      uri: url,
      artworkUrl: this.getString(media, 'media_url_https'),
      directUrl: bestVariant.url
    }
  }

  /**
   * Extracts normalized track fields from the public syndication fallback.
   *
   * @param identifier Stable tweet identifier.
   * @param payload Parsed syndication payload.
   * @param url Canonical tweet URL.
   * @returns Normalized track fields or `null` when no playable media exists.
   */
  private extractTrackInputFromSyndication(
    identifier: string,
    payload: JsonRecord,
    url: string
  ): TwitterResolvedTrackInput | null {
    const media =
      this.getRecord(payload, 'video') ??
      this.getRecordFromValue(this.getArray(payload, 'mediaDetails')[0])
    if (!media) {
      return null
    }

    const variants = this.getVariants(media, 'variants')
    const bestVariant = this.selectBestVariant(variants)
    if (!bestVariant?.url) {
      return null
    }

    const user = this.getRecord(payload, 'user')
    const authorName = user ? this.getString(user, 'name') : null

    return {
      identifier,
      author: authorName ?? 'Twitter User',
      length: this.getNumber(media, 'durationMs') ?? 0,
      title: this.normalizeTitle(this.getString(payload, 'text')),
      uri: url,
      artworkUrl: this.getString(media, 'poster'),
      directUrl: bestVariant.url
    }
  }

  /**
   * Builds an encoded Twitter track from normalized track fields.
   *
   * @param input Normalized Twitter track fields.
   * @returns Encoded Twitter track payload.
   */
  private buildTrack(input: TwitterResolvedTrackInput): TwitterTrackData {
    const isHLS = input.directUrl.includes('.m3u8')
    const info: TwitterTrackInfo = {
      identifier: input.identifier,
      isSeekable: true,
      author: input.author,
      length: input.length,
      isStream: isHLS,
      position: 0,
      title: input.title,
      uri: input.uri,
      artworkUrl: input.artworkUrl,
      isrc: null,
      sourceName: 'twitter',
      details: []
    }

    return {
      encoded: encodeTrack(info),
      info,
      pluginInfo: {
        directUrl: input.directUrl,
        isHLS
      }
    }
  }

  /**
   * Extracts a Twitter track payload from a source result.
   *
   * @param result Source result returned by `resolve`.
   * @returns Encoded Twitter track payload or `null`.
   */
  private extractTrackFromResult(
    result: SourceResult
  ): TwitterTrackData | null {
    const resultData = result.data as JsonValue | TwitterTrackData | undefined

    if (result.loadType === 'track' && this.isTrackData(resultData)) {
      return resultData
    }

    return null
  }

  /**
   * Creates the direct playback URL descriptor returned by `getTrackUrl`.
   *
   * @param url Direct media URL.
   * @param isHLS Whether the media URL points to an HLS playlist.
   * @returns Track URL descriptor.
   */
  private createTrackUrlResult(
    url: string,
    isHLS: boolean
  ): TwitterTrackUrlSuccess {
    return {
      url,
      protocol: isHLS ? 'hls' : 'https',
      format: isHLS ? 'm3u8' : 'mp4'
    }
  }

  /**
   * Finds the first playable video or animated-gif media entry in a Twitter
   * media container.
   *
   * @param record Media container record.
   * @returns Playable media record or `null`.
   */
  private findMediaRecord(record: JsonRecord | null): JsonRecord | null {
    if (!record) {
      return null
    }

    const mediaEntries = this.getArray(record, 'media')
    for (const mediaValue of mediaEntries) {
      const media = this.getRecordFromValue(mediaValue)
      if (!media) {
        continue
      }

      const type = this.getString(media, 'type')
      if (type === 'video' || type === 'animated_gif') {
        return media
      }
    }

    return null
  }

  /**
   * Extracts media variants from a record field.
   *
   * @param record Source record.
   * @param key Field containing the variant array.
   * @returns Normalized media variants.
   */
  private getVariants(record: JsonRecord, key: string): TwitterVariant[] {
    return this.getArray(record, key)
      .map((value) => this.getRecordFromValue(value))
      .filter((variant): variant is JsonRecord => variant !== null)
      .map((variant) => {
        const rawUrl =
          this.getString(variant, 'url') ?? this.getString(variant, 'src')
        const contentType =
          this.getString(variant, 'content_type') ??
          this.getString(variant, 'type')

        return {
          contentType,
          bitrate:
            this.getNumber(variant, 'bitrate') ??
            this.estimateVariantBitrate(rawUrl),
          url: rawUrl
        }
      })
  }

  /**
   * Chooses the best playable media variant by preferring MP4 variants with the
   * highest bitrate and falling back to the first HLS playlist when necessary.
   *
   * @param variants Normalized media variants.
   * @returns The best playable variant or `null`.
   */
  private selectBestVariant(variants: TwitterVariant[]): TwitterVariant | null {
    const mp4Variants = variants
      .filter((variant) => variant.contentType === 'video/mp4' && !!variant.url)
      .sort((left, right) => (right.bitrate ?? 0) - (left.bitrate ?? 0))

    if (mp4Variants.length > 0) {
      return mp4Variants[0] ?? null
    }

    return (
      variants.find(
        (variant) =>
          variant.contentType === 'application/x-mpegURL' && !!variant.url
      ) ?? null
    )
  }

  /**
   * Estimates a bitrate from the `WIDTHxHEIGHT` segment embedded in some
   * Twitter MP4 URLs.
   *
   * @param url Variant URL.
   * @returns Estimated bitrate or `null`.
   */
  private estimateVariantBitrate(url: string | null): number | null {
    if (!url) {
      return null
    }

    const match = url.match(/\/(\d+)x(\d+)\//)
    if (!match?.[1] || !match?.[2]) {
      return null
    }

    return Number.parseInt(match[1], 10) * Number.parseInt(match[2], 10)
  }

  /**
   * Removes trailing Twitter short links from tweet text so the resulting title
   * is more readable.
   *
   * @param text Raw tweet text.
   * @returns Normalized title.
   */
  private normalizeTitle(text: string | null): string {
    const value = text?.split('https://t.co')[0]?.trim()
    return value || 'Twitter Content'
  }

  /**
   * Parses a JSON-capable response body into a record.
   *
   * @param body Raw HTTP response body.
   * @returns A JSON record or `null` when the payload is not object-like.
   */
  private parseJsonBody(body: HttpRequestResult['body']): JsonRecord | null {
    if (
      body &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      !Buffer.isBuffer(body)
    ) {
      return body as JsonRecord
    }

    const textBody = this.getTextBody({ body })
    if (!textBody) {
      return null
    }

    try {
      const parsed = JSON.parse(textBody)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as JsonRecord)
        : null
    } catch {
      return null
    }
  }

  /**
   * Reads a nested record property from a JSON record.
   *
   * @param record Source record.
   * @param key Property name to read.
   * @returns The nested record or `null` when the property is not an object.
   */
  private getRecord(record: JsonRecord, key: string): JsonRecord | null {
    return this.getRecordFromValue(record[key])
  }

  /**
   * Follows a sequence of nested object keys and returns the final record.
   *
   * @param record Root record.
   * @param path Nested key path.
   * @returns Final nested record or `null`.
   */
  private getNestedRecord(
    record: JsonRecord | null,
    path: string[]
  ): JsonRecord | null {
    let current = record

    for (const key of path) {
      if (!current) {
        return null
      }

      current = this.getRecord(current, key)
    }

    return current
  }

  /**
   * Converts a JSON value into a record when possible.
   *
   * @param value Candidate JSON value.
   * @returns The record representation or `null`.
   */
  private getRecordFromValue(value?: JsonValue): JsonRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as JsonRecord)
      : null
  }

  /**
   * Reads an arbitrary property value from a JSON record.
   *
   * @param record Source record.
   * @param key Property name to read.
   * @returns The property value or `undefined` when absent.
   */
  private getValue(record: JsonRecord, key: string): JsonValue | undefined {
    return record[key]
  }

  /**
   * Reads an array property from a JSON record.
   *
   * @param record Source record.
   * @param key Property name to read.
   * @returns The nested array or an empty array when the property is not an array.
   */
  private getArray(record: JsonRecord, key: string): JsonValue[] {
    const value = this.getValue(record, key)
    return Array.isArray(value) ? value : []
  }

  /**
   * Reads a string-like field from a JSON record.
   *
   * @param record Source record.
   * @param key Property name to read.
   * @returns The normalized string value or `null`.
   */
  private getString(record: JsonRecord, key: string): string | null {
    const value = this.getValue(record, key)

    if (typeof value === 'string') {
      return value
    }

    if (typeof value === 'number') {
      return String(value)
    }

    return null
  }

  /**
   * Reads a numeric field from a JSON record.
   *
   * @param record Source record.
   * @param key Property name to read.
   * @returns The numeric value or `null`.
   */
  private getNumber(record: JsonRecord, key: string): number | null {
    const value = this.getValue(record, key)
    return typeof value === 'number' ? value : null
  }

  /**
   * Extracts a text body from an HTTP response payload.
   *
   * @param response HTTP response payload.
   * @returns A UTF-8 string when the body is text-like, otherwise `null`.
   */
  private getTextBody(
    response: Pick<HttpRequestResult, 'body'>
  ): string | null {
    if (typeof response.body === 'string') {
      return response.body
    }

    if (Buffer.isBuffer(response.body)) {
      return response.body.toString('utf8')
    }

    return response.body !== undefined && response.body !== null
      ? String(response.body)
      : null
  }

  /**
   * Checks whether an arbitrary value is a valid encoded Twitter track payload.
   *
   * @param value Candidate value returned by delegated source calls.
   * @returns `true` when the value is a usable Twitter track payload.
   */
  private isTrackData(
    value: JsonValue | TwitterTrackData | undefined
  ): value is TwitterTrackData {
    const record = this.getRecordFromValue(value as JsonValue)
    if (!record) {
      return false
    }

    const encoded = this.getValue(record, 'encoded')
    const info = this.getRecord(record, 'info')
    const pluginInfo = this.getRecord(record, 'pluginInfo')
    const title = info ? this.getValue(info, 'title') : undefined
    const author = info ? this.getValue(info, 'author') : undefined
    const uri = info ? this.getValue(info, 'uri') : undefined
    const directUrl = pluginInfo
      ? this.getValue(pluginInfo, 'directUrl')
      : undefined
    const isHLS = pluginInfo ? this.getValue(pluginInfo, 'isHLS') : undefined

    return (
      typeof encoded === 'string' &&
      !!info &&
      typeof title === 'string' &&
      typeof author === 'string' &&
      typeof uri === 'string' &&
      !!pluginInfo &&
      typeof directUrl === 'string' &&
      typeof isHLS === 'boolean'
    )
  }
}
