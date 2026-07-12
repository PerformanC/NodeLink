/**
 * YouTube TV Client
 *
 * Implements the YouTube TVHTML5 innertube client for smart TV and
 * Chromecast emulation. Supports video/playlist resolution with
 * OAuth-based authentication for TV devices.
 *
 * @packageDocumentation
 * @module YouTubeTVClient
 */

import type {
  SourceResult,
  TrackInfo,
  WorkerNodeLink
} from '../../../typings/sources/source.types.ts'
import type {
  ICipherManager,
  IOAuth,
  YouTubeClientContext,
  YouTubeContext
} from '../../../typings/sources/youtube.types.ts'
import type { HttpProxyConfig } from '../../../typings/utils.types.ts'
import { logger, makeRequest } from '../../../utils.ts'
import { BaseClient, checkURLType, YOUTUBE_CONSTANTS } from '../common.ts'

/**
 * YouTube TVHTML5 innertube client.
 *
 * Emulates a smart TV device for YouTube API requests.
 * Requires a player script for signature deciphering.
 *
 * @public
 */
export default class TV extends BaseClient {
  /**
   * Creates a new TV client instance.
   *
   * @param nodelink - NodeLink worker instance providing options and source access
   * @param oauth - OAuth manager for authenticated requests, or null if unauthenticated
   */
  constructor(nodelink: WorkerNodeLink, oauth: IOAuth | null) {
    super(nodelink, 'TVHTML5', oauth)
  }

  /**
   * Builds the YouTube client context for TVHTML5 innertube requests.
   *
   * @param context - General YouTube context with language, region, and visitor data
   * @returns Client context object describing this TVHTML5 client configuration
   */
  override getClient(context: YouTubeContext): YouTubeClientContext {
    const utc = -Math.floor(new Date().getTimezoneOffset())
    return {
      client: {
        clientName: 'TVHTML5',
        clientVersion: '7.20260708.13.02',
        userAgent:
          'Mozilla/5.0 (SMART-TV; Linux; Tizen 8.0) Cobalt/Version (unlike Gecko) v8/11.4.233.17-gold Starboard/16, Tizen;Samsung;KantM_2024;8.0/2300.0 (Samsung, QN90D_98, Wired',
        hl: context.client.hl,
        gl: context.client.gl
      },
      user: {
        lockedSafetyMode: false
      },
      request: {
        useSsl: true
      },
      adSignalsInfo: {
        params: [
          { key: 'dt', value: Date.now().toString() },
          { key: 'u_tz', value: `${utc}` }
        ]
      }
    } as unknown as YouTubeClientContext
  }

  /**
   * TV client requires a player script for signature deciphering.
   *
   * @returns Always true for the TV client
   */
  override requirePlayerScript(): boolean {
    return true
  }

  /**
   * Retrieves OAuth authorization headers for TV device authentication.
   *
   * @returns Promise resolving to authorization headers, or empty object if no OAuth
   */
  override async getAuthHeaders(): Promise<Record<string, string>> {
    if (this.oauth) {
      const accessToken = await this.oauth.getAccessToken()
      if (accessToken) {
        logger(
          'debug',
          'YouTube-TV',
          'Successfully acquired access token for authentication.'
        )
        return {
          Authorization: `Bearer ${accessToken}`
        }
      }
    }
    logger(
      'debug',
      'YouTube-TV',
      'No access token available. Proceeding without authentication.'
    )
    return {} as Record<string, string>
  }

  /**
   * Resolves a YouTube URL to track or playlist data.
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
            'YouTube-TV',
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

        const headers = await this.getAuthHeaders()
        const { body: playerResponse, statusCode } =
          await this._makePlayerRequest(
            videoId,
            context,
            headers,
            cipherManager
          )

        if (statusCode !== 200) {
          const message = `Failed to load video/short player data. Status: ${statusCode}`
          logger('error', 'YouTube-TV', message)
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
            'YouTube-TV',
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

        const requestBody: Record<string, unknown> = {
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
            headers: { 'User-Agent': this.getClient(context).client.userAgent },
            body: requestBody,
            method: 'POST',
            disableBodyCompression: true,
            proxy: this.getProxy()
          }
        )

        if (statusCode !== 200) {
          const errMsg = `Failed to fetch playlist. Status: ${statusCode}`
          logger(
            'error',
            'YouTube-TV',
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
          sourceName,
          context
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
      'YouTube-TV',
      `Getting stream URL for: ${decodedTrack.title} (ID: ${decodedTrack.identifier}) on ${sourceName}`
    )

    const headers = await this.getAuthHeaders()
    const { body: playerResponse, statusCode } = await this._makePlayerRequest(
      decodedTrack.identifier,
      context,
      headers,
      cipherManager,
      proxy
    )

    if (statusCode !== 200) {
      const message = `Failed to get player data for stream. Status: ${statusCode}`
      logger('error', 'YouTube-TV', message)
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
}
