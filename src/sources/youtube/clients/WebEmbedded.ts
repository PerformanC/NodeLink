import type {
  SourceResult,
  TrackData,
  TrackInfo,
  WorkerNodeLink
} from '../../../typings/sources/source.types.ts'
import type {
  ICipherManager,
  IOAuth,
  YouTubeClientContext,
  YouTubeContext
} from '../../../typings/sources/youtube.types.ts'
import type {
  Chapter,
  MacroMarkersListItemData,
  VideoRendererWithChapters,
  YouTubeNextRequestBody,
  YouTubeNextResponse,
  YouTubeSearchResponse
} from '../../../typings/sources/youtubeClient.types.ts'
import type { HttpProxyConfig } from '../../../typings/utils.types.ts'
import { logger, makeRequest } from '../../../utils.ts'
import {
  BaseClient,
  buildTrack,
  checkURLType,
  YOUTUBE_CONSTANTS
} from '../common.ts'

export default class WebEmbedded extends BaseClient {
  /**
   * Creates a new WebEmbedded client instance.
   *
   * @param nodelink - NodeLink worker instance providing options and source access
   * @param oauth - OAuth manager for authenticated requests, or null if unauthenticated
   */
  constructor(nodelink: WorkerNodeLink, oauth: IOAuth | null) {
    super(nodelink, 'WEB_EMBEDDED_PLAYER', oauth)
  }

  /**
   * Builds the YouTube client context for WEB_EMBEDDED_PLAYER innertube requests.
   *
   * @param context - General YouTube context with language, region, and visitor data
   * @returns Client context object describing this embedded player client configuration
   */
  override getClient(context: YouTubeContext): YouTubeClientContext {
    return {
      client: {
        clientName: 'WEB_EMBEDDED_PLAYER',
        clientVersion: '2.20260630.09.00',
        platform: 'DESKTOP',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36,gzip(gfe)',
        hl: context.client.hl,
        gl: context.client.gl,
        visitorData: context.client.visitorData
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true },
      thirdParty: {
        embedUrl: 'https://www.google.com/search?q=youtube',
        embeddedPlayerContext: {
          ancestorOrigins: ['https://www.google.com']
        }
      }
    }
  }

  /**
   * Returns player parameters for WEB_EMBEDDED_PLAYER playback.
   *
   * @returns Base64-encoded player parameters string
   */
  override getPlayerParams(): string | null {
    return '2AMB'
  }

  /**
   * WEB_EMBEDDED_PLAYER client requires a player script for signature deciphering.
   *
   * @returns Always true for the embedded player client
   */
  override requirePlayerScript(): boolean {
    return true
  }

  /**
   * Indicates this client operates in embedded mode.
   *
   * @returns Always true for the embedded player client
   */
  override isEmbedded(): boolean {
    return true
  }

  /**
   * Searches YouTube for tracks matching the given query.
   *
   * @param query - Search query string (e.g., song name, artist)
   * @param _type - Search type hint (unused, always returns videos)
   * @param context - YouTube context with language and region settings
   * @returns Search result with tracks or an exception
   */
  override async search(
    query: string,
    _type: string,
    context: YouTubeContext
  ): Promise<SourceResult> {
    const sourceName = 'youtube'

    const requestBody = {
      context: this.getClient(context),
      query: query,
      params: 'EgVo2aDSNQ=='
    }

    const {
      body: searchResultRaw,
      error,
      statusCode
    } = await makeRequest('https://www.youtube.com/youtubei/v1/search', {
      method: 'POST',
      headers: {
        'User-Agent': this.getClient(context).client.userAgent,
        'X-Goog-Api-Format-Version': '2'
      },
      body: requestBody,
      disableBodyCompression: true,
      proxy: this.getProxy()
    })

    const searchResult = searchResultRaw as YouTubeSearchResponse

    if (error || statusCode !== 200) {
      const message =
        error ||
        `Failed to load results from ${sourceName}. Status: ${statusCode}`
      logger('error', 'YouTube-WebEmbedded', message)
      return {
        loadType: 'error',
        exception: { message, severity: 'common', cause: 'Upstream' }
      }
    }
    if (searchResult.error) {
      logger(
        'error',
        'YouTube-WebEmbedded',
        `Error from ${sourceName} search API: ${searchResult.error.message}`
      )
      return {
        loadType: 'error',
        exception: {
          message: searchResult.error.message,
          severity: 'fault',
          cause: 'Upstream'
        }
      }
    }
    const tracks: TrackData[] = []
    const allSections = searchResult.contents?.sectionListRenderer?.contents
    const lastIdx = (allSections?.length ?? 0) - 1
    let videos = allSections?.[lastIdx]?.itemSectionRenderer?.contents

    if (!videos || videos.length === 0) {
      logger(
        'debug',
        'YouTube-WebEmbedded',
        `No matches found on ${sourceName} for: ${query}`
      )
      return { loadType: 'empty', data: {} }
    }

    const maxResults =
      (this.config.search.maxResults as number | undefined) || 10
    if (videos.length > maxResults) {
      let count = 0
      videos = videos.filter((video) => {
        const isValid = video.videoRenderer || video.compactVideoRenderer
        if (isValid && count < maxResults) {
          count++
          return true
        }
        return false
      })
    }

    for (const videoData of videos) {
      const track = await buildTrack(
        videoData,
        sourceName,
        null,
        null,
        this.config.experimental.enableHoloTracks as boolean | undefined
      )
      if (track) {
        tracks.push(track)
      }
    }

    if (tracks.length === 0) {
      logger(
        'debug',
        'YouTube-WebEmbedded',
        `No processable tracks found on ${sourceName} for: ${query}`
      )
      return { loadType: 'empty', data: {} }
    }

    return { loadType: 'search', data: tracks }
  }

  /**
   * Resolves a YouTube URL to track or playlist data.
   *
   * Supports video URLs, short URLs, and playlist URLs.
   *
   * @param url - YouTube URL to resolve
   * @param _type - URL type hint (unused)
   * @param context - YouTube context with language and region settings
   * @param cipherManager - Cipher manager for signature deciphering
   * @returns Resolved track/playlist data or an exception
   */
  override async resolve(
    url: string,
    _type: string,
    context: YouTubeContext,
    cipherManager: ICipherManager | null
  ): Promise<SourceResult> {
    const sourceName = 'youtube'
    const urlType = checkURLType(url, 'youtube')
    const apiEndpoint = this.getApiEndpoint()

    switch (urlType) {
      case YOUTUBE_CONSTANTS.VIDEO:
      case YOUTUBE_CONSTANTS.SHORTS: {
        const idPattern = /(?:v=|\/shorts\/|youtu\.be\/)([^&?]+)/
        const videoIdMatch = url.match(idPattern)
        if (!videoIdMatch?.[1]) {
          logger(
            'error',
            'youtube-webembedded',
            `Could not parse video ID from URL: ${url}`
          )
          return {
            loadType: 'error',
            exception: {
              message: 'Invalid video URL.',
              severity: 'common',
              cause: 'Input'
            }
          }
        }
        const videoId = videoIdMatch[1]

        const { body: playerResponse, statusCode } =
          await this._makePlayerRequest(videoId, context, {}, cipherManager)

        if (statusCode !== 200) {
          const message = `Failed to load video/short player data. Status: ${statusCode}`
          logger('error', 'youtube-webembedded', message)
          return {
            loadType: 'error',
            exception: { message, severity: 'common', cause: 'Upstream' }
          }
        }

        return await this._handlePlayerResponse(
          playerResponse,
          sourceName,
          videoId
        )
      }

      case YOUTUBE_CONSTANTS.PLAYLIST: {
        const playlistIdMatch = url.match(/[?&]list=([\w-]+)/)
        if (!playlistIdMatch?.[1]) {
          logger(
            'error',
            'youtube-webembedded',
            `Could not parse playlist ID from URL: ${url}`
          )
          return {
            loadType: 'error',
            exception: {
              message: 'Invalid playlist URL.',
              severity: 'common',
              cause: 'Input'
            }
          }
        }

        const playlistId = playlistIdMatch[1]
        const videoIdMatch = url.match(/[?&]v=([\w-]+)/)
        const currentVideoId = videoIdMatch?.[1] ?? null

        const requestBody: YouTubeNextRequestBody = {
          context: this.getClient(context),
          playlistId,
          contentCheckOk: true,
          racyCheckOk: true
        }
        if (playlistId.startsWith('RD') && currentVideoId) {
          requestBody.videoId = currentVideoId
        }
        const { body: playlistResponse, statusCode } = await makeRequest(
          `${apiEndpoint}/youtubei/v1/next`,
          {
            headers: {
              'User-Agent': this.getClient(context).client.userAgent
            },
            body: requestBody,
            method: 'POST',
            disableBodyCompression: true,
            proxy: this.getProxy()
          }
        )

        const plResponse = playlistResponse as YouTubeNextResponse

        if (statusCode !== 200 || plResponse?.error) {
          const errMsg =
            plResponse?.error?.message ||
            `Failed to fetch playlist. Status: ${statusCode}`
          logger(
            'error',
            'youtube-webembedded',
            `Error loading playlist ${playlistId}: ${errMsg}`
          )
          return {
            loadType: 'error',
            exception: {
              message: errMsg,
              severity: 'common',
              cause: 'Upstream'
            }
          }
        }

        return await this._handlePlaylistResponse(
          playlistId,
          currentVideoId,
          playlistResponse,
          sourceName
        )
      }

      default:
        return { loadType: 'empty', data: {} }
    }
  }

  /**
   * Retrieves a playable stream URL for a track.
   *
   * @param decodedTrack - Decoded track information with identifier
   * @param context - YouTube context with language and region settings
   * @param cipherManager - Cipher manager for signature deciphering
   * @param itag - Optional specific format itag to request
   * @param proxy - Optional proxy override for this request
   * @returns Track URL data with protocol info, or an exception
   */
  override async getTrackUrl(
    decodedTrack: TrackInfo,
    context: YouTubeContext,
    cipherManager: ICipherManager | null,
    itag?: number | string,
    proxy?: HttpProxyConfig
  ): Promise<Record<string, unknown>> {
    const sourceName = decodedTrack.sourceName || 'youtube'
    logger(
      'debug',
      'youtube-webembedded',
      `Getting stream URL for: ${decodedTrack.title} (ID: ${decodedTrack.identifier}) on ${sourceName}`
    )

    const { body: playerResponse, statusCode } = await this._makePlayerRequest(
      decodedTrack.identifier,
      context,
      {},
      cipherManager,
      proxy
    )

    if (statusCode !== 200) {
      const message = `Failed to get player data for stream. Status: ${statusCode}`
      logger('error', 'youtube-webembedded', message)
      return {
        loadType: 'error',
        exception: { message, severity: 'common', cause: 'Upstream' }
      }
    }

    return await this._extractStreamData(
      playerResponse,
      decodedTrack,
      context,
      cipherManager,
      itag
    )
  }

  /**
   * Extracts chapter information for a video from YouTube search results.
   *
   * @param trackInfo - Track information containing the video identifier and length
   * @param context - YouTube context with language and region settings
   * @returns Array of chapter objects with title, startTime, and computed duration/endTime
   */
  async getChapters(
    trackInfo: TrackInfo,
    context: YouTubeContext
  ): Promise<Chapter[]> {
    const requestBody = {
      context: this.getClient(context),
      query: trackInfo.identifier
    }

    const {
      body: searchResultRaw,
      error,
      statusCode
    } = await makeRequest('https://www.youtube.com/youtubei/v1/search', {
      method: 'POST',
      headers: {
        'User-Agent': this.getClient(context).client.userAgent
      },
      body: requestBody,
      disableBodyCompression: true,
      proxy: this.getProxy()
    })

    if (error || statusCode !== 200) {
      throw new Error(`Search failed for chapters: ${error || statusCode}`)
    }

    const searchResult = searchResultRaw as YouTubeSearchResponse
    const contents =
      searchResult.contents?.twoColumnSearchResultsRenderer?.primaryContents
        ?.sectionListRenderer?.contents

    if (!contents) return []

    let videoRenderer: VideoRendererWithChapters | null = null

    for (const section of contents) {
      if (section.itemSectionRenderer) {
        for (const item of section.itemSectionRenderer.contents ?? []) {
          if (
            item.videoRenderer &&
            (item.videoRenderer as Record<string, unknown>).videoId ===
              trackInfo.identifier
          ) {
            videoRenderer = item.videoRenderer as VideoRendererWithChapters
            break
          }
        }
      }
      if (videoRenderer) break
    }

    if (!videoRenderer) return []

    const macroMarkersCards =
      videoRenderer.expandableMetadata?.expandableMetadataRenderer
        ?.expandedContent?.horizontalCardListRenderer?.cards

    if (!macroMarkersCards) return []

    const chapters: Chapter[] = []

    for (const card of macroMarkersCards) {
      const renderer = card.macroMarkersListItemRenderer as
        | MacroMarkersListItemData
        | undefined
      if (renderer) {
        const title =
          renderer.title?.simpleText || renderer.title?.runs?.[0]?.text
        const timeStr =
          renderer.timeDescription?.simpleText ||
          renderer.timeDescription?.runs?.[0]?.text

        let thumbnails: Chapter['thumbnails'] = []
        if (renderer.thumbnail?.thumbnails) {
          thumbnails = renderer.thumbnail.thumbnails
        }

        if (title && timeStr) {
          chapters.push({
            title,
            startTime: this._parseTime(timeStr),
            thumbnails
          })
        }
      }
    }

    for (let i = 0; i < chapters.length; i++) {
      const current = chapters[i]
      if (!current) {
        continue
      }
      const next = chapters[i + 1]

      if (next) {
        current.duration = next.startTime - current.startTime
        current.endTime = next.startTime
      } else {
        current.duration = trackInfo.length - current.startTime
        current.endTime = trackInfo.length
      }
    }

    return chapters
  }

  /**
   * Parses a time string (e.g., "1:23" or "1:23:45") into milliseconds.
   *
   * @param timeStr - Time string in HH:MM:SS, MM:SS, or SS format
   * @returns Time in milliseconds
   */
  private _parseTime(timeStr: string): number {
    const parts = timeStr.split(':').map(Number)
    let ms = 0
    if (parts.length === 3) {
      ms =
        ((parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0)) * 1000
    } else if (parts.length === 2) {
      ms = ((parts[0] ?? 0) * 60 + (parts[1] ?? 0)) * 1000
    } else {
      ms = (parts[0] ?? 0) * 1000
    }
    return ms
  }
}
