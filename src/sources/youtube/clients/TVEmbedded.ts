/**
 * YouTube TV Embedded Client
 *
 * Implements the YouTube TVHTML5_SIMPLY_EMBEDDED_PLAYER innertube client
 * for embedded TV player emulation. Supports video/playlist resolution with
 * OAuth-based authentication and embedded player parameters.
 *
 * @packageDocumentation
 * @module YouTubeTVEmbeddedClient
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
 * YouTube TVHTML5_SIMPLY_EMBEDDED_PLAYER innertube client.
 *
 * Emulates an embedded TV player for YouTube API requests.
 * Supports embedded player parameters and third-party embed URLs.
 *
 * @public
 */
export default class TVEmbedded extends BaseClient {
  /**
   * Creates a new TVEmbedded client instance.
   *
   * @param nodelink - NodeLink worker instance providing options and source access
   * @param oauth - OAuth manager for authenticated requests, or null if unauthenticated
   */
  constructor(nodelink: WorkerNodeLink, oauth: IOAuth | null) {
    super(nodelink, 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', oauth)
  }

  /**
   * Builds the YouTube client context for TVHTML5_SIMPLY_EMBEDDED_PLAYER innertube requests.
   *
   * @param context - General YouTube context with language, region, and visitor data
   * @returns Client context object describing this embedded TV client configuration
   */
  override getClient(context: YouTubeContext): YouTubeClientContext {
    return {
      client: {
        clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
        clientVersion: '2.0',
        userAgent:
          'Mozilla/5.0 (Linux armeabi-v7a; Android 7.1.2; Fire OS 6.0) Cobalt/22.lts.3.306369-gold (unlike Gecko) v8/8.8.278.8-jit gles Starboard/13, Amazon_ATV_mediatek8695_2019/NS6294 (Amazon, AFTMM, Wireless) com.amazon.firetv.youtube/22.3.r2.v66.0',
        hl: context.client.hl,
        gl: context.client.gl
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true },
      thirdParty: { embedUrl: 'https://www.youtube.com/tv' }
    }
  }

  /**
   * Returns player parameters for embedded TV playback.
   *
   * @returns Base64-encoded player parameters string
   */
  override getPlayerParams(): string {
    return '2AMB'
  }

  /**
   * TV Embedded client is an embedded player.
   *
   * @returns Always true for the TV Embedded client
   */
  override isEmbedded(): boolean {
    return true
  }

  /**
   * Whether this client requires OAuth authentication (REQUIRED).
   * Will check if the Oauth is configured, and return false if not.
   * This client (tvembedded) does not work anymore tho :( 
   */
  override requiresOAuth(): boolean {
    return true
  }

  /**
   * TV Embedded client requires a player script for signature deciphering.
   *
   * @returns Always true for the TV Embedded client
   */
  override requirePlayerScript(): boolean {
    return true
  }

  /**
   * Retrieves OAuth authorization headers for TV embedded authentication.
   *
   * @returns Promise resolving to authorization headers, or empty object if no OAuth
   */
  override async getAuthHeaders(): Promise<Record<string, string>> {
    if (this.oauth) {
      const accessToken = await this.oauth.getAccessToken()
      if (accessToken) {
        logger(
          'debug',
          'YouTube-TVEmbedded',
          'Successfully acquired access token for authentication.'
        )
        return {
          Authorization: `Bearer ${accessToken}`
        }
      }
    }
    logger(
      'debug',
      'YouTube-TVEmbedded',
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
            'YouTube-TVEmbedded',
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
          logger('error', 'YouTube-TVEmbedded', message)
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
            'YouTube-TVEmbedded',
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
            'YouTube-TVEmbedded',
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
      'YouTube-TVEmbedded',
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
      logger('error', 'YouTube-TVEmbedded', message)
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
