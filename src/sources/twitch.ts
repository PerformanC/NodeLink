import { PassThrough, type Readable } from 'node:stream'
import HLSHandler from '../playback/hls/HLSHandler.ts'
import type {
  SourceInstance,
  SourceResult,
  TrackData,
  TrackInfo,
  TrackStreamResult,
  TrackUrlResult,
  WorkerNodeLink
} from '../typings/sources/source.types.ts'
import type {
  TwitchClipNode,
  TwitchGraphQLOperation,
  TwitchGraphQLResponse,
  TwitchPlaybackAccessToken,
  TwitchVodNode
} from '../typings/sources/twitch.types.ts'
import { encodeTrack, http1makeRequest, logger } from '../utils.ts'

/**
 * Base URL for the Twitch GraphQL API.
 * @internal
 */
const TWITCH_GQL_URL = 'https://gql.twitch.tv/gql'

/**
 * Base URL for the Twitch Usher API (HLS playlists).
 * @internal
 */
const TWITCH_USHER_URL = 'https://usher.ttvnw.net'

/**
 * Twitch source implementation.
 * Integrates with Twitch's GraphQL and Usher APIs to resolve streams, VODs, and clips.
 * @public
 */
export default class TwitchSource implements SourceInstance {
  /**
   * The NodeLink worker context.
   * @internal
   */
  private readonly nodelink: WorkerNodeLink

  /**
   * Regular expression patterns for identifying Twitch URLs.
   * Matches clips, videos (VODs), and channel URLs.
   * @public
   */
  public readonly patterns = [
    /^https?:\/\/(?:www\.|go\.|m\.)?twitch\.tv\/(?:[\w_]+\/clip\/([\w%-_]+)|videos\/(\d+)|([\w_]+))/i
  ]

  /**
   * Priority score for source selection.
   * @public
   */
  public readonly priority = 70

  /**
   * Client ID used for API requests.
   * Prime Client ID extracted from the public site.
   * @internal
   */
  private clientId = 'kimne78kx3ncx6brgo4mv6wki5h1ko'

  /**
   * Unique device ID for session tracking.
   * @internal
   */
  private deviceId: string | null = null

  /**
   * Constructs a new TwitchSource instance.
   * @param nodelink - The worker context.
   */
  constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
  }

  /**
   * Performs source-level initialization.
   * Attempts to load cached IDs or extract them from the Twitch landing page.
   * @returns A promise resolving to true if initialization succeeded.
   * @public
   */
  public async setup(): Promise<boolean> {
    const cm = this.nodelink.credentialManager
    if (!cm) return false

    const cachedId = cm.get<string>('twitch_client_id')
    const cachedDevice = cm.get<string>('twitch_device_id')

    if (cachedId && cachedDevice) {
      this.clientId = cachedId
      this.deviceId = cachedDevice
      logger(
        'info',
        'Twitch',
        'Successfully loaded parameters from CredentialManager.'
      )
      return true
    }

    try {
      const res = await http1makeRequest('https://www.twitch.tv/', {
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/111.0',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
        }
      })

      if (res.error || res.statusCode !== 200) {
        throw new Error(
          `Twitch page fetch failed: ${res.error || res.statusCode}`
        )
      }

      const body =
        typeof res.body === 'string' ? res.body : JSON.stringify(res.body)

      // Extract Client ID from script tags
      const clientIdMatch = body.match(/clientId="(\w+)"/)
      if (clientIdMatch?.[1]) {
        this.clientId = clientIdMatch[1]
      } else {
        logger(
          'warn',
          'Twitch',
          'Could not extract dynamic Client-ID, using fallback.'
        )
      }

      // Extract Device ID from set-cookie
      const setCookie = res.headers?.['set-cookie']
      if (setCookie) {
        const cookies = (
          Array.isArray(setCookie) ? setCookie : [setCookie]
        ).map(String)
        const uniqueId = cookies.find((c) => c.includes('unique_id='))
        if (uniqueId) {
          const match = uniqueId.match(/unique_id=([^;]+);/)
          if (match?.[1]) this.deviceId = match[1]
        }
      }

      if (!this.deviceId) {
        logger(
          'warn',
          'Twitch',
          'Could not extract unique device ID from cookies.'
        )
      }

      // Persist identified parameters
      cm.set('twitch_client_id', this.clientId, 7 * 24 * 60 * 60 * 1000)
      if (this.deviceId) {
        cm.set('twitch_device_id', this.deviceId, 7 * 24 * 60 * 60 * 1000)
      }

      logger(
        'info',
        'Twitch',
        `Twitch source primed. Client ID: ${this.clientId}`
      )
      return true
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger('error', 'Twitch', `Failed to bootstrap Twitch source: ${message}`)
      return false
    }
  }

  /**
   * Executes a GraphQL request against Twitch's internal API.
   * @param payload - The GQL operation payload.
   * @returns A promise resolving to the response body.
   * @internal
   */
  private async _gqlRequest(
    payload: TwitchGraphQLOperation | TwitchGraphQLOperation[]
  ): Promise<TwitchGraphQLResponse | TwitchGraphQLResponse[]> {
    const headers: Record<string, string> = {
      'Client-ID': this.clientId,
      'Content-Type': 'application/json'
    }
    if (this.deviceId) headers['X-Device-ID'] = this.deviceId

    const res = await http1makeRequest(TWITCH_GQL_URL, {
      method: 'POST',
      headers,
      body: payload as unknown as Record<string, unknown>,
      disableBodyCompression: true
    })

    if (res.error || res.statusCode !== 200) {
      throw new Error(
        `Twitch GraphQL request failed: ${res.error || res.statusCode}`
      )
    }

    return res.body as TwitchGraphQLResponse | TwitchGraphQLResponse[]
  }

  /**
   * Resolves a Twitch URL into a track.
   * Detects if the URL is for a clip, VOD, or live channel.
   *
   * @param url - The absolute Twitch URL.
   * @returns Resolution result payload.
   * @public
   */
  public async resolve(url: string): Promise<SourceResult> {
    const pattern = this.patterns[0]
    const match = pattern?.exec(url)
    if (!match) return { loadType: 'empty', data: {} }

    const [, clipSlug, vodId, channelName] = match

    if (clipSlug) return await this._loadClip(clipSlug, url)
    if (vodId) return await this._loadVod(vodId, url)
    if (channelName) return await this._loadChannel(channelName, url)

    return { loadType: 'empty', data: {} }
  }

  /**
   * Fetches metadata for a Twitch clip.
   * @internal
   */
  private async _fetchClipMetadata(
    slug: string
  ): Promise<TwitchClipNode | null> {
    const payload: TwitchGraphQLOperation = {
      operationName: 'ClipsView',
      query: `query ClipsView($slug: ID!) {
        clip(slug: $slug) {
          id
          slug
          title
          broadcaster {
            id
            displayName
            login
          }
          videoQualities {
            quality
            sourceURL
          }
          thumbnailURL
          durationSeconds
        }
      }`,
      variables: { slug },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash:
            '0d6d8d951d3b5305a3f2a0f2661b8a6a6d25dc042b155d8df8586905f0a0f435'
        }
      }
    }

    const res = (await this._gqlRequest(payload)) as TwitchGraphQLResponse
    return res.data?.clip || null
  }

  /**
   * Resolves a Twitch clip by its slug.
   * @internal
   */
  private async _loadClip(
    slug: string,
    originalUrl: string
  ): Promise<SourceResult> {
    try {
      const data = await this._fetchClipMetadata(slug)
      if (!data) {
        return {
          loadType: 'error',
          exception: { message: 'Clip not found.', severity: 'common' }
        }
      }

      const track = this._buildTrack({
        identifier: data.slug,
        uri: originalUrl,
        title: data.title || 'Twitch Clip',
        author: data.broadcaster?.displayName || 'Unknown',
        length: Math.floor(data.durationSeconds * 1000),
        isSeekable: true,
        isStream: false,
        artworkUrl: data.thumbnailURL
      })

      return { loadType: 'track', data: track }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return { loadType: 'error', exception: { message, severity: 'fault' } }
    }
  }

  /**
   * Fetches metadata for a Twitch VOD.
   * @internal
   */
  private async _fetchVodMetadata(
    vodId: string
  ): Promise<TwitchVodNode | null> {
    const payload: TwitchGraphQLOperation = {
      operationName: 'VideoMetadata',
      variables: { videoID: vodId, channelLogin: '' },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash:
            '226edb3e692509f727fd56821f5653c05740242c82b0388883e0c0e75dcbf687'
        }
      }
    }

    const res = (await this._gqlRequest(payload)) as TwitchGraphQLResponse
    return res.data?.video || null
  }

  /**
   * Resolves a Twitch VOD by its identifier.
   * @internal
   */
  private async _loadVod(
    vodId: string,
    originalUrl: string
  ): Promise<SourceResult> {
    try {
      const data = await this._fetchVodMetadata(vodId)
      if (!data) {
        return {
          loadType: 'error',
          exception: { message: 'VOD not found.', severity: 'common' }
        }
      }

      const artworkUrl = data.previewThumbnailURL
        ?.replace('{width}', '640')
        .replace('{height}', '360')

      const track = this._buildTrack({
        identifier: vodId,
        uri: originalUrl,
        title: data.title || 'Twitch VOD',
        author: data.owner?.displayName || 'Unknown',
        length: Math.floor(data.lengthSeconds * 1000),
        isSeekable: true,
        isStream: false,
        artworkUrl
      })

      return { loadType: 'track', data: track }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return { loadType: 'error', exception: { message, severity: 'fault' } }
    }
  }

  /**
   * Resolves a Twitch channel into a live stream track.
   * @internal
   */
  private async _loadChannel(
    channelName: string,
    originalUrl: string
  ): Promise<SourceResult> {
    try {
      const payload: TwitchGraphQLOperation = {
        operationName: 'StreamMetadata',
        variables: { channelLogin: channelName.toLowerCase() },
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash:
              '1c719a40e481453e5c48d9bb585d971b8b372f8ebb105b17076722264dfa5b3e'
          }
        }
      }

      const res = (await this._gqlRequest(payload)) as TwitchGraphQLResponse
      const stream = res.data?.user?.stream

      if (stream?.type !== 'live') {
        return {
          loadType: 'error',
          exception: {
            message: 'Channel is not currently live.',
            severity: 'common'
          }
        }
      }

      const track = this._buildTrack({
        identifier: channelName.toLowerCase(),
        uri: originalUrl,
        title: res.data?.user?.lastBroadcast?.title || 'Twitch Live Stream',
        author: channelName,
        length: 0,
        isSeekable: false,
        isStream: true,
        artworkUrl: `https://static-cdn.jtvnw.net/previews-ttv/live_user_${channelName.toLowerCase()}-640x360.jpg`
      })

      return { loadType: 'track', data: track }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return { loadType: 'error', exception: { message, severity: 'fault' } }
    }
  }

  /**
   * Resolves a playable URL for a Twitch track.
   * Identifies if the track is a clip, VOD, or live stream and delegates to appropriate stream fetchers.
   *
   * @param track - Metadata of the track.
   * @returns A promise resolving to the playable stream result.
   * @public
   */
  public async getTrackUrl(track: TrackInfo): Promise<TrackUrlResult> {
    const pattern = this.patterns[0]
    const match = pattern?.exec(track.uri)
    if (!match) {
      return {
        exception: {
          message: 'Invalid Twitch URI provided.',
          severity: 'common'
        }
      }
    }

    const [, clipSlug, vodId, channelName] = match

    if (clipSlug) return await this._getClipStreamUrl(clipSlug)
    if (vodId) return await this._getVodStreamUrl(vodId)
    if (channelName) return await this._getLiveStreamUrl(channelName)

    return {
      exception: {
        message: 'Could not identify Twitch resource type.',
        severity: 'fault'
      }
    }
  }

  /**
   * Obtains a playback access token for a live channel.
   * @internal
   */
  private async _fetchLiveAccessToken(
    channel: string
  ): Promise<TwitchPlaybackAccessToken | null> {
    const payload: TwitchGraphQLOperation = {
      operationName: 'PlaybackAccessToken_Template',
      query: `query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!, $platform: String!) {
        streamPlaybackAccessToken(channelName: $login, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) {
          value
          signature
          authorization {
            isForbidden
            forbiddenReasonCode
          }
          __typename
        }
      }`,
      variables: {
        isLive: true,
        login: channel.toLowerCase(),
        isVod: false,
        vodID: '',
        playerType: 'site',
        platform: 'web'
      }
    }

    const res = (await this._gqlRequest(payload)) as TwitchGraphQLResponse
    return res.data?.streamPlaybackAccessToken || null
  }

  /**
   * Resolves the HLS stream URL for a live channel.
   * @internal
   */
  private async _getLiveStreamUrl(
    channelName: string
  ): Promise<TrackUrlResult> {
    try {
      const token = await this._fetchLiveAccessToken(channelName)
      if (!token)
        throw new Error('Failed to obtain live playback access token.')

      const params = new URLSearchParams({
        player_type: 'site',
        token: token.value,
        sig: token.signature,
        allow_source: 'true',
        allow_audio_only: 'true'
      })

      const hlsUrl = `${TWITCH_USHER_URL}/api/channel/hls/${channelName.toLowerCase()}.m3u8?${params.toString()}`
      const res = await http1makeRequest(hlsUrl)

      if (res.error || res.statusCode !== 200 || typeof res.body !== 'string') {
        throw new Error(
          `Failed to fetch HLS master playlist: ${res.error || res.statusCode}`
        )
      }

      const stream = this._parseM3U8(res.body)
      if (!stream)
        throw new Error('No compatible variants found in HLS playlist.')

      return {
        url: stream.url,
        protocol: 'hls',
        format: 'mpegts'
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return { exception: { message, severity: 'fault' } }
    }
  }

  /**
   * Obtains a playback access token for a clip.
   * @internal
   */
  private async _fetchClipAccessToken(
    slug: string
  ): Promise<TwitchPlaybackAccessToken | null> {
    const payload: TwitchGraphQLOperation = {
      operationName: 'ClipAccessToken',
      query: `query ClipAccessToken($slug: ID!, $params: PlaybackAccessTokenParams!) {
        clip(slug: $slug) {
          playbackAccessToken(params: $params) {
            value
            signature
          }
        }
      }`,
      variables: {
        slug,
        params: {
          platform: 'web',
          playerBackend: 'mediaplayer',
          playerType: 'embed'
        }
      }
    }

    const res = (await this._gqlRequest(payload)) as TwitchGraphQLResponse
    return res.data?.clip?.playbackAccessToken || null
  }

  /**
   * Resolves the direct MP4 stream URL for a clip.
   * @internal
   */
  private async _getClipStreamUrl(slug: string): Promise<TrackUrlResult> {
    try {
      const meta = await this._fetchClipMetadata(slug)
      if (!meta?.videoQualities?.length) {
        throw new Error('Clip metadata lookup failed.')
      }

      // Select highest quality variant
      const best = meta.videoQualities.sort(
        (a, b) =>
          Number.parseInt(b.quality, 10) - Number.parseInt(a.quality, 10)
      )[0]

      if (!best) throw new Error('No playable qualities identified for clip.')

      const token = await this._fetchClipAccessToken(slug)
      if (!token)
        throw new Error('Failed to obtain clip playback access token.')

      const params = new URLSearchParams({
        token: token.value,
        sig: token.signature
      })

      return {
        url: `${best.sourceURL}?${params.toString()}`,
        protocol: 'https',
        format: 'mp4'
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return { exception: { message, severity: 'fault' } }
    }
  }

  /**
   * Obtains a playback access token for a VOD.
   * @internal
   */
  private async _fetchVodAccessToken(
    vodId: string
  ): Promise<TwitchPlaybackAccessToken | null> {
    const payload: TwitchGraphQLOperation = {
      operationName: 'PlaybackAccessToken_Template',
      query: `query PlaybackAccessToken_Template($isVod: Boolean!, $vodID: ID!, $playerType: String!, $platform: String!) {
        videoPlaybackAccessToken(id: $vodID, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) {
          value
          signature
        }
      }`,
      variables: {
        isVod: true,
        vodID: vodId,
        playerType: 'site',
        platform: 'web'
      }
    }

    const res = (await this._gqlRequest(payload)) as TwitchGraphQLResponse
    return res.data?.videoPlaybackAccessToken || null
  }

  /**
   * Resolves the HLS stream URL for a VOD.
   * @internal
   */
  private async _getVodStreamUrl(vodId: string): Promise<TrackUrlResult> {
    try {
      const token = await this._fetchVodAccessToken(vodId)
      if (!token) throw new Error('Failed to obtain VOD playback access token.')

      const params = new URLSearchParams({
        player_type: 'html5',
        token: token.value,
        sig: token.signature,
        allow_source: 'true',
        allow_audio_only: 'true'
      })

      const vodUrl = `${TWITCH_USHER_URL}/vod/${vodId}.m3u8?${params.toString()}`
      return {
        url: vodUrl,
        protocol: 'hls',
        format: 'mpegts'
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return { exception: { message, severity: 'fault' } }
    }
  }

  /**
   * Basic M3U8 parser to select the highest bandwidth variant or audio-only variant.
   * @param data - Raw M3U8 content.
   * @returns Selected stream URL or null.
   * @internal
   */
  private _parseM3U8(data: string): { url: string } | null {
    const lines = data.split('\n')
    let bestBandwidth = 0
    let bestUrl: string | null = null

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]?.trim()
      if (line?.startsWith('#EXT-X-STREAM-INF:')) {
        const match = line.match(/BANDWIDTH=(\d+)/)
        const bwStr = match?.[1]
        if (bwStr) {
          const bw = Number.parseInt(bwStr, 10)
          if (bw > bestBandwidth) {
            bestBandwidth = bw
            bestUrl = lines[i + 1] ?? null
          }
        }
      }
    }

    if (bestUrl) return { url: bestUrl }

    // Fallback to audio-only if no stream-inf found (unlikely for Twitch Usher)
    for (const line of lines) {
      if (line.startsWith('#EXT-X-MEDIA:') && line.includes('TYPE=AUDIO')) {
        const match = line.match(/URI="([^"]+)"/)
        if (match?.[1]) return { url: match[1] }
      }
    }

    return null
  }

  /**
   * Finalizes stream loading using either HLSHandler or direct pass-through.
   *
   * @param _track - Track metadata.
   * @param url - Resolved URL.
   * @param protocol - Resolution protocol ('hls' or other).
   * @param additionalData - Optional payload containing playback start time.
   * @returns TrackStreamResult payload.
   * @public
   */
  public async loadStream(
    _track: TrackInfo,
    url: string,
    protocol?: string,
    additionalData?: Record<string, unknown>
  ): Promise<TrackStreamResult> {
    if (protocol === 'hls') {
      const localAddress = this.nodelink.routePlanner?.getIP
        ? this.nodelink.routePlanner.getIP()
        : undefined
      const stream = new HLSHandler(url, {
        type: 'mpegts',
        localAddress: localAddress || undefined,
        startTime: (additionalData?.startTime as number) || 0
      })

      return { stream, type: 'mpegts' }
    }

    const res = await http1makeRequest(url, {
      method: 'GET',
      streamOnly: true
    })

    if (res.error || res.statusCode !== 200 || !res.stream) {
      return {
        exception: {
          message: `Direct stream fetch failed: ${res.error || res.statusCode}`,
          severity: 'fault'
        }
      }
    }

    const passthrough = new PassThrough()
    const source = res.stream as Readable

    source.pipe(passthrough)

    source.on('end', () => {
      if (!passthrough.writableEnded) {
        passthrough.emit('finishBuffering')
        passthrough.end()
      }
    })

    source.on('error', (err) => {
      logger('error', 'Twitch', `Underlying stream error: ${err.message}`)
      if (!passthrough.destroyed) passthrough.destroy(err)
    })

    const contentTypeRaw = res.headers?.['content-type']
    const contentType = Array.isArray(contentTypeRaw)
      ? contentTypeRaw[0]
      : typeof contentTypeRaw === 'string'
        ? contentTypeRaw
        : 'video/mp4'

    return { stream: passthrough, type: contentType || 'video/mp4' }
  }

  /**
   * Search is currently not supported for the Twitch source.
   * @returns Exception result.
   * @public
   */
  public async search(_query: string): Promise<SourceResult> {
    return {
      loadType: 'error',
      exception: {
        message: 'Twitch source does not support catalog search.',
        severity: 'common'
      }
    }
  }

  /**
   * Normalizes internal Twitch metadata into a standardized NodeLink TrackData object.
   * @param partial - Intermediate metadata object.
   * @returns Built TrackData.
   * @internal
   */
  private _buildTrack(partial: {
    identifier: string
    uri: string
    title: string
    author: string
    length: number
    isSeekable: boolean
    isStream: boolean
    artworkUrl?: string
  }): TrackData {
    const info: TrackInfo = {
      identifier: partial.identifier,
      isSeekable: partial.isSeekable,
      author: partial.author,
      length: partial.length,
      isStream: partial.isStream,
      position: 0,
      title: partial.title,
      uri: partial.uri,
      artworkUrl: partial.artworkUrl || null,
      isrc: null,
      sourceName: 'twitch'
    }

    return {
      encoded: encodeTrack({ ...info, details: [] }),
      info,
      pluginInfo: {}
    }
  }
}
