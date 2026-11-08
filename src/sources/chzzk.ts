import { PassThrough, type Readable } from 'node:stream'
import HLSHandler from '../playback/hls/HLSHandler.ts'
import type {
  ChzzkApiResponse,
  ChzzkChannelDetail,
  ChzzkClipDetail,
  ChzzkClipPlayInfo,
  ChzzkLiveDetail,
  ChzzkLivePlaybackJson,
  ChzzkSearchLiveItem,
  ChzzkSearchVideoItem,
  ChzzkVideoDetail
} from '../typings/sources/chzzk.types.ts'
import type {
  SourceInstance,
  SourceResult,
  TrackData,
  TrackInfo,
  TrackStreamResult,
  TrackUrlResult,
  WorkerNodeLink
} from '../typings/sources/source.types.ts'
import type { SourceTestCase } from '../typings/sources/test.types.ts'
import { encodeTrack, http1makeRequest, logger } from '../utils.ts'

const CHZZK_API_BASE = 'https://api.chzzk.naver.com'
const NEONPLAYER_API_BASE =
  'https://apis.naver.com/neonplayer/vodplay/v1/playback'

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*'
}

/**
 * Naver Chzzk (치지직) source implementation.
 *
 * Provides resolution and streaming for Chzzk live broadcasts, clips,
 * and VODs (video recordings) using Naver's API and Akamai HLS streams.
 *
 * @public
 */
export default class ChzzkSource implements SourceInstance {
  /**
   * Declarative test suite for the Chzzk source.
   * @public
   */
  public static readonly _TESTS: readonly SourceTestCase[] = [
    {
      id: 'chzzk.clip.resolve',
      name: 'Chzzk clip metadata resolution',
      input: {
        type: 'resolve',
        value: 'https://chzzk.naver.com/clips/9bFaNybNx1'
      },
      expect: {
        result: { type: 'track' },
        metadata: {
          identifier: { op: 'equals', value: '9bFaNybNx1' },
          sourceName: { op: 'equals', value: 'chzzk' }
        }
      },
      forbid: {
        resultTypes: ['empty', 'error']
      }
    },
    {
      id: 'chzzk.video.resolve',
      name: 'Chzzk video (VOD) resolution',
      input: {
        type: 'resolve',
        value: 'https://chzzk.naver.com/video/1980'
      },
      expect: {
        result: { type: 'track' },
        metadata: {
          identifier: { op: 'equals', value: '1980' },
          sourceName: { op: 'equals', value: 'chzzk' }
        }
      },
      forbid: {
        resultTypes: ['empty', 'error']
      }
    },
    {
      id: 'chzzk.search.standard',
      name: 'Chzzk search queries (chsearch)',
      input: {
        type: 'search',
        value: 'LoL',
        searchType: 'chsearch'
      },
      expect: {
        result: { type: 'search' },
        collection: { minItems: 1 }
      },
      forbid: {
        resultTypes: ['empty', 'error']
      }
    }
  ]

  /**
   * Reference to the worker context.
   * @internal
   */
  private readonly nodelink: WorkerNodeLink

  /**
   * Search prefixes recognized for Chzzk.
   * @public
   */
  public readonly searchTerms: string[] = ['chsearch', 'chzzksearch']

  /**
   * Alternate names for source routing.
   * @public
   */
  public readonly additionalsSourceName: string[] = ['chzzk']

  /**
   * URL patterns for identifying Chzzk links.
   * @public
   */
  public readonly patterns: RegExp[] = [
    /^https?:\/\/chzzk\.naver\.com\/live\/([a-fA-F0-9]+)/i,
    /^https?:\/\/chzzk\.naver\.com\/video\/(\d+)/i,
    /^https?:\/\/chzzk\.naver\.com\/clips\/([\w-]+)/i,
    /^https?:\/\/chzzk\.naver\.com\/([a-fA-F0-9]{32})(?:[/?#]|$)/i
  ]

  /**
   * Priority score for source selection.
   * @public
   */
  public readonly priority: number = 70

  /**
   * Constructs a new ChzzkSource instance.
   * @param nodelink - Worker runtime context.
   */
  constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
  }

  /**
   * Initializes the Chzzk source.
   * @returns Promise resolving to true when setup is complete.
   */
  public async setup(): Promise<boolean> {
    logger('info', 'Chzzk', 'Chzzk source initialized.')
    return true
  }

  /**
   * Resolves a Chzzk URL to track metadata.
   * @param url - The Chzzk URL.
   * @returns Promise resolving to track result.
   */
  public async resolve(url: string): Promise<SourceResult> {
    try {
      const liveMatch = url.match(
        /^https?:\/\/chzzk\.naver\.com\/live\/([a-fA-F0-9]+)/i
      )
      if (liveMatch?.[1]) {
        return await this._loadLive(liveMatch[1], url)
      }

      const videoMatch = url.match(
        /^https?:\/\/chzzk\.naver\.com\/video\/(\d+)/i
      )
      if (videoMatch?.[1]) {
        return await this._loadVideo(videoMatch[1], url)
      }

      const clipMatch = url.match(
        /^https?:\/\/chzzk\.naver\.com\/clips\/([\w-]+)/i
      )
      if (clipMatch?.[1]) {
        return await this._loadClip(clipMatch[1], url)
      }

      const channelMatch = url.match(
        /^https?:\/\/chzzk\.naver\.com\/([a-fA-F0-9]{32})(?:[/?#]|$)/i
      )
      if (channelMatch?.[1]) {
        return await this._loadChannel(channelMatch[1], url)
      }

      return { loadType: 'empty', data: {} }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      logger('error', 'Chzzk', `Failed to resolve ${url}: ${message}`)
      return {
        loadType: 'error',
        exception: { message, severity: 'fault', cause: 'Upstream' }
      }
    }
  }

  /**
   * Searches Chzzk for live streams and videos.
   * @param query - The search query.
   * @returns Promise resolving to search results.
   */
  public async search(query: string): Promise<SourceResult> {
    try {
      const tracks: TrackData[] = []
      const encodedQuery = encodeURIComponent(query)

      const [livesRes, videosRes] = await Promise.all([
        http1makeRequest(
          `${CHZZK_API_BASE}/service/v1/search/lives?keyword=${encodedQuery}&size=10`,
          { headers: DEFAULT_HEADERS }
        ),
        http1makeRequest(
          `${CHZZK_API_BASE}/service/v1/search/videos?keyword=${encodedQuery}&size=10`,
          { headers: DEFAULT_HEADERS }
        )
      ])

      if (livesRes.statusCode === 200 && livesRes.body) {
        const body = (
          typeof livesRes.body === 'string'
            ? JSON.parse(livesRes.body)
            : livesRes.body
        ) as ChzzkApiResponse<{ data?: ChzzkSearchLiveItem[] }>

        const items = body.content?.data || []
        for (const item of items) {
          const live = item.live
          const channel = item.channel
          if (!channel?.channelId || !live?.liveTitle) continue

          const track = this._buildTrack({
            identifier: channel.channelId,
            uri: `https://chzzk.naver.com/live/${channel.channelId}`,
            title: live.liveTitle,
            author: channel.channelName || 'Chzzk Streamer',
            length: 0,
            isSeekable: false,
            isStream: true,
            artworkUrl:
              live.liveImageUrl ||
              live.defaultThumbnailImageUrl ||
              channel.channelImageUrl
          })
          tracks.push(track)
        }
      }

      if (videosRes.statusCode === 200 && videosRes.body) {
        const body = (
          typeof videosRes.body === 'string'
            ? JSON.parse(videosRes.body)
            : videosRes.body
        ) as ChzzkApiResponse<{ data?: ChzzkSearchVideoItem[] }>

        const items = body.content?.data || []
        for (const item of items) {
          const video = item.video
          const channel = item.channel
          if (!video?.videoNo || !video?.videoTitle) continue

          const track = this._buildTrack({
            identifier: String(video.videoNo),
            uri: `https://chzzk.naver.com/video/${video.videoNo}`,
            title: video.videoTitle,
            author: channel?.channelName || 'Chzzk Streamer',
            length: (video.duration || 0) * 1000,
            isSeekable: true,
            isStream: false,
            artworkUrl: video.thumbnailImageUrl || channel?.channelImageUrl
          })
          tracks.push(track)
        }
      }

      return {
        loadType: 'search',
        data: tracks
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      logger('error', 'Chzzk', `Search failed for "${query}": ${message}`)
      return {
        loadType: 'error',
        exception: { message, severity: 'common', cause: 'Upstream' }
      }
    }
  }

  /**
   * Resolves the playable stream URL for a Chzzk track.
   * @param track - The track metadata.
   * @returns TrackUrlResult with stream URL and protocol.
   */
  public async getTrackUrl(track: TrackInfo): Promise<TrackUrlResult> {
    try {
      const liveMatch = track.uri.match(
        /^https?:\/\/chzzk\.naver\.com\/live\/([a-fA-F0-9]+)/i
      )
      if (liveMatch?.[1]) {
        return await this._getLiveStreamUrl(liveMatch[1])
      }

      const videoMatch = track.uri.match(
        /^https?:\/\/chzzk\.naver\.com\/video\/(\d+)/i
      )
      if (videoMatch?.[1]) {
        return await this._getVideoStreamUrl(videoMatch[1])
      }

      const clipMatch = track.uri.match(
        /^https?:\/\/chzzk\.naver\.com\/clips\/([\w-]+)/i
      )
      if (clipMatch?.[1]) {
        return await this._getClipStreamUrl(clipMatch[1])
      }

      return {
        exception: {
          message: `Unrecognized Chzzk URI: ${track.uri}`,
          severity: 'common'
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { exception: { message, severity: 'fault' } }
    }
  }

  /**
   * Streams audio data using HLSHandler or direct pass-through.
   * @param _track - Track metadata.
   * @param url - Resolved stream URL.
   * @param protocol - Stream protocol ('hls' or 'https').
   * @param additionalData - Playback start time.
   * @returns TrackStreamResult payload.
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
        type: 'aac',
        localAddress: localAddress || undefined,
        startTime: (additionalData?.startTime as number) || 0
      })

      return { stream, type: 'aac' }
    }

    const res = await http1makeRequest(url, {
      method: 'GET',
      headers: DEFAULT_HEADERS,
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

    source.on('data', (chunk: Buffer) => {
      if (!passthrough.write(chunk)) source.pause()
    })

    passthrough.on('drain', () => {
      source.resume()
    })

    source.on('end', () => {
      if (!passthrough.writableEnded) {
        passthrough.emit('finishBuffering')
        passthrough.end()
      }
    })

    source.on('error', (err) => {
      logger('error', 'Chzzk', `Underlying stream error: ${err.message}`)
      if (!passthrough.destroyed) passthrough.destroy(err)
    })

    return { stream: passthrough, type: 'mp4' }
  }

  /**
   * Loads a live stream track by channel ID.
   * @internal
   */
  private async _loadLive(
    channelId: string,
    url: string
  ): Promise<SourceResult> {
    const res = await http1makeRequest(
      `${CHZZK_API_BASE}/service/v3/channels/${channelId}/live-detail`,
      { headers: DEFAULT_HEADERS }
    )

    if (res.statusCode !== 200 || !res.body) {
      return { loadType: 'empty', data: {} }
    }

    const body = (
      typeof res.body === 'string' ? JSON.parse(res.body) : res.body
    ) as ChzzkApiResponse<ChzzkLiveDetail>

    const content = body.content
    if (!content) {
      return { loadType: 'empty', data: {} }
    }

    const track = this._buildTrack({
      identifier: channelId,
      uri: url,
      title: content.liveTitle || 'Chzzk Live',
      author: content.channel?.channelName || 'Chzzk Streamer',
      length: 0,
      isSeekable: false,
      isStream: true,
      artworkUrl:
        content.liveImageUrl ||
        content.defaultThumbnailImageUrl ||
        content.channel?.channelImageUrl
    })

    return { loadType: 'track', data: track }
  }

  /**
   * Loads a VOD track by video ID.
   * @internal
   */
  private async _loadVideo(
    videoId: string,
    url: string
  ): Promise<SourceResult> {
    const res = await http1makeRequest(
      `${CHZZK_API_BASE}/service/v3/videos/${videoId}`,
      { headers: DEFAULT_HEADERS }
    )

    if (res.statusCode !== 200 || !res.body) {
      return { loadType: 'empty', data: {} }
    }

    const body = (
      typeof res.body === 'string' ? JSON.parse(res.body) : res.body
    ) as ChzzkApiResponse<ChzzkVideoDetail>

    const content = body.content
    if (!content) {
      return { loadType: 'empty', data: {} }
    }

    const track = this._buildTrack({
      identifier: String(content.videoNo || videoId),
      uri: url,
      title: content.videoTitle || 'Chzzk Video',
      author: content.channel?.channelName || 'Chzzk Streamer',
      length: (content.duration || 0) * 1000,
      isSeekable: true,
      isStream: false,
      artworkUrl: content.thumbnailImageUrl || content.channel?.channelImageUrl
    })

    return { loadType: 'track', data: track }
  }

  /**
   * Loads a clip track by clip UID.
   * @internal
   */
  private async _loadClip(clipId: string, url: string): Promise<SourceResult> {
    const res = await http1makeRequest(
      `${CHZZK_API_BASE}/service/v1/clips/${clipId}/detail`,
      { headers: DEFAULT_HEADERS }
    )

    if (res.statusCode !== 200 || !res.body) {
      return { loadType: 'empty', data: {} }
    }

    const body = (
      typeof res.body === 'string' ? JSON.parse(res.body) : res.body
    ) as ChzzkApiResponse<ChzzkClipDetail>

    const content = body.content
    if (!content) {
      return { loadType: 'empty', data: {} }
    }

    const track = this._buildTrack({
      identifier: content.clipUID || clipId,
      uri: url,
      title: content.clipTitle || 'Chzzk Clip',
      author:
        content.channelName ||
        content.ownerChannel?.channelName ||
        'Chzzk Creator',
      length: (content.duration || 0) * 1000,
      isSeekable: true,
      isStream: false,
      artworkUrl:
        content.thumbnailImageUrl || content.ownerChannel?.channelImageUrl
    })

    return { loadType: 'track', data: track }
  }

  /**
   * Loads channel live stream if currently broadcasting.
   * @internal
   */
  private async _loadChannel(
    channelId: string,
    _url: string
  ): Promise<SourceResult> {
    const channelRes = await http1makeRequest(
      `${CHZZK_API_BASE}/service/v1/channels/${channelId}`,
      { headers: DEFAULT_HEADERS }
    )

    if (channelRes.statusCode !== 200 || !channelRes.body) {
      return { loadType: 'empty', data: {} }
    }

    const body = (
      typeof channelRes.body === 'string'
        ? JSON.parse(channelRes.body)
        : channelRes.body
    ) as ChzzkApiResponse<ChzzkChannelDetail>

    if (body.content?.openLive) {
      return await this._loadLive(
        channelId,
        `https://chzzk.naver.com/live/${channelId}`
      )
    }

    return {
      loadType: 'empty',
      data: {}
    }
  }

  /**
   * Extracts playable live stream URL for a channel.
   * @internal
   */
  private async _getLiveStreamUrl(channelId: string): Promise<TrackUrlResult> {
    const res = await http1makeRequest(
      `${CHZZK_API_BASE}/service/v3/channels/${channelId}/live-detail`,
      { headers: DEFAULT_HEADERS }
    )

    if (res.statusCode !== 200 || !res.body) {
      throw new Error(
        `Failed to fetch Chzzk live detail (status ${res.statusCode})`
      )
    }

    const body = (
      typeof res.body === 'string' ? JSON.parse(res.body) : res.body
    ) as ChzzkApiResponse<ChzzkLiveDetail>

    const content = body.content
    if (!content || content.status === 'CLOSE') {
      throw new Error('Chzzk channel is currently offline.')
    }

    const playbackRaw = content.livePlaybackJson
    if (!playbackRaw) {
      throw new Error('No live playback data returned by Chzzk.')
    }

    const playback = (
      typeof playbackRaw === 'string' ? JSON.parse(playbackRaw) : playbackRaw
    ) as ChzzkLivePlaybackJson

    const hlsMedia =
      playback.media?.find((m) => m.mediaId === 'HLS') ||
      playback.media?.find((m) => m.protocol === 'HLS') ||
      playback.media?.[0]

    if (!hlsMedia) {
      throw new Error('No HLS media streams found for Chzzk live.')
    }

    // Prefer audio-only HLS track when available for lower bandwidth consumption
    const audioTrack = hlsMedia.encodingTrack?.find(
      (t) => t.audioOnly && t.path
    )
    const streamUrl = audioTrack?.path || hlsMedia.path

    if (!streamUrl) {
      throw new Error(
        'No valid HLS playlist path found in Chzzk live playback.'
      )
    }

    return {
      url: streamUrl,
      protocol: 'hls',
      format: 'aac'
    }
  }

  /**
   * Extracts playable video stream URL for a VOD.
   * @internal
   */
  private async _getVideoStreamUrl(videoId: string): Promise<TrackUrlResult> {
    const res = await http1makeRequest(
      `${CHZZK_API_BASE}/service/v3/videos/${videoId}`,
      { headers: DEFAULT_HEADERS }
    )

    if (res.statusCode !== 200 || !res.body) {
      throw new Error(
        `Failed to fetch Chzzk video detail (status ${res.statusCode})`
      )
    }

    const body = (
      typeof res.body === 'string' ? JSON.parse(res.body) : res.body
    ) as ChzzkApiResponse<ChzzkVideoDetail>

    const content = body.content
    if (!content) {
      throw new Error('Chzzk video not found.')
    }

    if (content.liveRewindPlaybackJson) {
      const rewindPb = (
        typeof content.liveRewindPlaybackJson === 'string'
          ? JSON.parse(content.liveRewindPlaybackJson)
          : content.liveRewindPlaybackJson
      ) as ChzzkLivePlaybackJson

      const hls =
        rewindPb.media?.find((m) => m.protocol === 'HLS') || rewindPb.media?.[0]
      if (hls?.path) {
        return { url: hls.path, protocol: 'hls', format: 'aac' }
      }
    }

    if (content.videoId && content.inKey) {
      return await this._getNeonPlayerStreamUrl(content.videoId, content.inKey)
    }

    throw new Error('No playable stream found for Chzzk video.')
  }

  /**
   * Extracts playable clip stream URL.
   * @internal
   */
  private async _getClipStreamUrl(clipId: string): Promise<TrackUrlResult> {
    const res = await http1makeRequest(
      `${CHZZK_API_BASE}/service/v1/play-info/clip/${clipId}`,
      { headers: DEFAULT_HEADERS }
    )

    if (res.statusCode !== 200 || !res.body) {
      throw new Error(
        `Failed to fetch Chzzk clip play-info (status ${res.statusCode})`
      )
    }

    const body = (
      typeof res.body === 'string' ? JSON.parse(res.body) : res.body
    ) as ChzzkApiResponse<ChzzkClipPlayInfo>

    const content = body.content
    if (!content?.videoId || !content?.inKey) {
      throw new Error('Chzzk clip playback credentials not found.')
    }

    return await this._getNeonPlayerStreamUrl(content.videoId, content.inKey)
  }

  /**
   * Resolves stream URL from Naver Neonplayer playback descriptor.
   * @internal
   */
  private async _getNeonPlayerStreamUrl(
    videoId: string,
    inKey: string
  ): Promise<TrackUrlResult> {
    const neonUrl = `${NEONPLAYER_API_BASE}/${videoId}?key=${inKey}&env=real&lc=en_US&cpl=en_US`
    const res = await http1makeRequest(neonUrl, { headers: DEFAULT_HEADERS })

    if (res.statusCode !== 200 || !res.body) {
      throw new Error(`Neonplayer request failed (status ${res.statusCode})`)
    }

    const bodyStr =
      typeof res.body === 'string' ? res.body : JSON.stringify(res.body)
    const directMp4Match = bodyStr.match(
      /https?:\/\/[^"'\s,]+\.mp4\?[^"'\s,]+/i
    )
    if (directMp4Match?.[0]) {
      return {
        url: directMp4Match[0],
        protocol: 'https',
        format: 'mp4'
      }
    }

    const hlsMatch = bodyStr.match(/https?:\/\/[^"'\s,]+\.m3u8\?[^"'\s,]+/i)
    if (hlsMatch?.[0]) {
      return {
        url: hlsMatch[0],
        protocol: 'hls',
        format: 'aac'
      }
    }

    throw new Error('No direct MP4 or HLS stream found in Neonplayer playback.')
  }

  /**
   * Constructs TrackData for a resolved item.
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
    artworkUrl?: string | null
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
      sourceName: 'chzzk'
    }

    return {
      encoded: encodeTrack({ ...info, details: [] }),
      info,
      pluginInfo: {}
    }
  }
}
