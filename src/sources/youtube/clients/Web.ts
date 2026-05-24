/**
 * YouTube Web Client
 *
 * Implements the YouTube WEB innertube client for desktop browser emulation.
 * This client supports full search, resolve, track URL resolution with SABR
 * protocol, and chapter extraction.
 *
 * Requires a player script for signature deciphering and uses the PoToken
 * manager for bot-detection bypass.
 *
 * @packageDocumentation
 * @module YouTubeWebClient
 */

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
  PoTokenManager,
  YouTubeNextRequestBody,
  YouTubeNextResponse,
  YouTubePlayerRequestBody,
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
import { poTokenManager } from '../sabr/potoken.ts'

/**
 * YouTube WEB innertube client.
 *
 * Emulates a desktop Chrome browser for YouTube API requests.
 * Supports search, resolve, playlist, track URL (with SABR), and chapters.
 *
 * @public
 */
export default class Web extends BaseClient {
  /** PoToken manager for generating proof-of-origin tokens */
  private poTokenManager: PoTokenManager

  /**
   * Creates a new Web client instance.
   *
   * @param nodelink - NodeLink worker instance providing options and source access
   * @param oauth - OAuth manager for authenticated requests, or null if unauthenticated
   */
  constructor(nodelink: WorkerNodeLink, oauth: IOAuth | null) {
    super(nodelink, 'WEB', oauth)
    this.poTokenManager = poTokenManager as unknown as PoTokenManager
  }

  /**
   * Builds the YouTube client context for WEB innertube requests.
   *
   * @param context - General YouTube context with language, region, and visitor data
   * @returns Client context object describing this WEB client configuration
   */
  override getClient(context: YouTubeContext): YouTubeClientContext {
    return {
      client: {
        clientName: 'WEB',
        clientVersion: '2.20260114.01.00',
        platform: 'DESKTOP',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
        hl: context.client.hl,
        gl: context.client.gl
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true }
    }
  }

  /**
   * WEB client requires a player script for signature deciphering.
   *
   * @returns Always true for the WEB client
   */
  override requirePlayerScript(): boolean {
    return true
  }

  /**
   * Searches YouTube for tracks matching the given query.
   *
   * @param query - Search query string (e.g., song name, artist)
   * @param _type - Search type hint (unused by WEB client, always returns videos)
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
      params: 'EgIQAQ%3D%3D'
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
      logger('error', 'YouTube-Web', message)
      return {
        loadType: 'error',
        exception: { message, severity: 'common', cause: 'Upstream' }
      }
    }
    if (searchResult.error) {
      logger(
        'error',
        'YouTube-Web',
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
        'YouTube-Web',
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
        'YouTube-Web',
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
            'youtube-web',
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
          logger('error', 'youtube-web', message)
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
            'youtube-web',
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
            'youtube-web',
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
   * Retrieves a playable stream URL for a track using SABR protocol when possible.
   *
   * Generates a PoToken, makes a player request with it, and checks for
   * SABR streaming URLs. Falls back to the base class implementation
   * if SABR is unavailable.
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
    if (this.oauth?.getAccessToken) {
      await this.oauth.getAccessToken()
    }

    const { poToken, visitorData } = await this.poTokenManager.generate(
      decodedTrack.identifier
    )

    if (poToken) {
      const client = this.getClient(context)
      client.client.visitorData = visitorData

      let signatureTimestamp: string | null = null
      try {
        const playerScript = await cipherManager?.getCachedPlayerScript()
        if (cipherManager && playerScript) {
          signatureTimestamp = await cipherManager.getTimestamp(
            playerScript.url
          )
        }
      } catch (e: unknown) {
        logger(
          'warn',
          'YouTube-Web',
          `Failed to get STS: ${e instanceof Error ? e.message : String(e)}`
        )
      }

      const requestBody: YouTubePlayerRequestBody = {
        context: client,
        videoId: decodedTrack.identifier,
        contentCheckOk: true,
        racyCheckOk: true,
        serviceIntegrityDimensions: { poToken }
      }

      if (signatureTimestamp) {
        requestBody.playbackContext = {
          contentPlaybackContext: {
            signatureTimestamp
          }
        }
      }

      try {
        const { body: playerResponseRaw } = await makeRequest(
          'https://youtubei.googleapis.com/youtubei/v1/player?prettyPrint=false',
          {
            method: 'POST',
            headers: {
              'User-Agent': client.client.userAgent,
              'X-Goog-Visitor-Id': visitorData,
              'X-Youtube-Client-Name': '1',
              'X-Youtube-Client-Version': client.client.clientVersion ?? '',
              Origin: 'https://www.youtube.com',
              Referer: `https://www.youtube.com/watch?v=${decodedTrack.identifier}`
            },
            body: requestBody,
            disableBodyCompression: true,
            proxy: proxy || this.getProxy()
          }
        )

        const playerResponse = playerResponseRaw as Record<string, unknown>
        const streamingData = (playerResponse.streamingData ||
          playerResponse.streaming_data) as Record<string, unknown> | undefined
        const serverAbrUrl =
          streamingData?.serverAbrStreamingUrl ||
          streamingData?.server_abr_streaming_url
        const mediaCommonConfig = (
          playerResponse.playerConfig as Record<string, unknown> | undefined
        )?.mediaCommonConfig as Record<string, unknown> | undefined
        const ustreamerConfig = (
          mediaCommonConfig?.mediaUstreamerRequestConfig as
            | Record<string, unknown>
            | undefined
        )?.videoPlaybackUstreamerConfig as string | undefined

        if (serverAbrUrl) {
          const playerScript = await cipherManager?.getCachedPlayerScript()

          let resolvedUrl = serverAbrUrl as string
          if (cipherManager && playerScript) {
            try {
              resolvedUrl = await cipherManager.resolveUrl(
                serverAbrUrl as string,
                null,
                null,
                null,
                playerScript,
                context
              )
            } catch (e: unknown) {
              logger(
                'warn',
                'YouTube-Web',
                `Failed to resolve SABR URL via cipher server: ${e instanceof Error ? e.message : String(e)}`
              )
            }
          }

          const formats = [
            ...((streamingData?.formats as unknown[]) || []),
            ...((streamingData?.adaptiveFormats as unknown[]) ||
              (streamingData?.adaptive_formats as unknown[]) ||
              [])
          ].map((f: unknown) => {
            const fmt = f as Record<string, unknown>
            const audioTrack = fmt.audioTrack as
              | Record<string, unknown>
              | undefined
            return {
              itag: fmt.itag,
              lastModified: fmt.lastModified || fmt.last_modified_ms,
              xtags: fmt.xtags,
              width: fmt.width,
              height: fmt.height,
              mimeType: fmt.mimeType || fmt.mime_type,
              audioQuality: fmt.audioQuality || fmt.audio_quality,
              bitrate: fmt.bitrate,
              averageBitrate: fmt.averageBitrate || fmt.average_bitrate,
              quality: fmt.quality,
              qualityLabel: fmt.qualityLabel || fmt.quality_label,
              audioTrackId: audioTrack?.id,
              approxDurationMs: fmt.approxDurationMs || fmt.approx_duration_ms,
              contentLength: fmt.contentLength || fmt.content_length,
              isDrc: !!fmt.isDrc
            }
          })

          return {
            protocol: 'sabr',
            url: resolvedUrl,
            additionalData: {
              serverAbrStreamingUrl: resolvedUrl,
              videoPlaybackUstreamerConfig: ustreamerConfig,
              poToken,
              visitorData,
              clientInfo: {
                clientName: 1,
                clientVersion: client.client.clientVersion
              },
              formats,
              accessToken: null,
              userAgent: client.client.userAgent
            }
          }
        }
      } catch (_e: unknown) {
        // SABR attempt failed, fall through to base implementation
      }
    }

    return super.getTrackUrl(decodedTrack, context, cipherManager, itag)
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

    let videoRenderer: Record<string, unknown> | null = null

    for (const section of contents) {
      if (section.itemSectionRenderer) {
        for (const item of section.itemSectionRenderer.contents ?? []) {
          if (
            item.videoRenderer &&
            (item.videoRenderer as Record<string, unknown>).videoId ===
              trackInfo.identifier
          ) {
            videoRenderer = item.videoRenderer as Record<string, unknown>
            break
          }
        }
      }
      if (videoRenderer) break
    }

    if (!videoRenderer) return []

    const expandableMetadata = videoRenderer.expandableMetadata as
      | Record<string, unknown>
      | undefined
    const expandableRenderer = expandableMetadata?.expandableMetadataRenderer as
      | Record<string, unknown>
      | undefined
    const expandedContent = expandableRenderer?.expandedContent as
      | Record<string, unknown>
      | undefined
    const horizontalCards = expandedContent?.horizontalCardListRenderer as
      | Record<string, unknown>
      | undefined
    const macroMarkersCards = horizontalCards?.cards as unknown[] | undefined

    if (!macroMarkersCards) return []

    const chapters: Chapter[] = []

    for (const card of macroMarkersCards) {
      const cardObj = card as Record<string, unknown>
      const renderer = cardObj.macroMarkersListItemRenderer as
        | Record<string, unknown>
        | undefined
      if (renderer) {
        const titleObj = renderer.title as Record<string, unknown> | undefined
        const title =
          (titleObj?.simpleText as string | undefined) ||
          (titleObj?.runs as Array<{ text: string }> | undefined)?.[0]?.text
        const timeObj = renderer.timeDescription as
          | Record<string, unknown>
          | undefined
        const timeStr =
          (timeObj?.simpleText as string | undefined) ||
          (timeObj?.runs as Array<{ text: string }> | undefined)?.[0]?.text

        let thumbnails: Chapter['thumbnails'] = []
        const thumbObj = renderer.thumbnail as
          | Record<string, unknown>
          | undefined
        if (thumbObj?.thumbnails) {
          thumbnails = thumbObj.thumbnails as Chapter['thumbnails']
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
