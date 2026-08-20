/**
 * YouTube WEB_PARENT_TOOLS client.
 *
 * Uses the parent-tools web client variant for player requests that still need
 * standard WEB-style cipher handling but different client headers.
 *
 * @packageDocumentation
 * @module YouTubeWebParentToolsClient
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
import type { YouTubePlayerRequestBody } from '../../../typings/sources/youtubeClient.types.ts'
import type {
  HttpProxyConfig,
  HttpRequestResult
} from '../../../typings/utils.types.ts'
import { makeRequest } from '../../../utils.ts'
import { BaseClient, checkURLType, YOUTUBE_CONSTANTS } from '../common.ts'

export default class WebParentTools extends BaseClient {
  /**
   * Creates a new WebParentTools client instance.
   * @param nodelink - NodeLink worker instance
   * @param oauth - OAuth manager instance, or null if unauthenticated
   */
  constructor(nodelink: WorkerNodeLink, oauth: IOAuth | null) {
    super(nodelink, 'WEB_PARENT_TOOLS', oauth)
  }

  /**
   * Returns the client-specific context for innertube requests.
   * @param context - General YouTube context containing locale and visitor data
   * @returns The YouTubeClientContext for the WEB_PARENT_TOOLS client
   */
  override getClient(context: YouTubeContext): YouTubeClientContext {
    return {
      client: {
        clientName: 'WEB_PARENT_TOOLS',
        clientVersion: '1.20220918',
        hl: context.client.hl,
        gl: context.client.gl,
        visitorData: context.client.visitorData,
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36,gzip(gfe)'
      },
      thirdParty: {
        embedUrl: 'https://www.youtube.com/'
      }
    }
  }

  /**
   * Returns player parameters for WEB_PARENT_TOOLS playback.
   *
   * @returns Base64-encoded player parameters string
   */
  override getPlayerParams(): string | null {
    return '2AMB'
  }

  /**
   * Whether this client requires a player script for signature deciphering.
   * @returns true, as WEB_PARENT_TOOLS needs the player script
   */
  override requirePlayerScript(): boolean {
    return true
  }

  /**
   * Resolves a YouTube URL to track or playlist data.
   * @param url - The YouTube URL to resolve
   * @param _type - The type hint (unused in this client)
   * @param context - YouTube context for API requests
   * @param cipherManager - Cipher manager for signature deciphering, or null
   * @returns A SourceResult containing track/playlist data or an exception
   */
  override async resolve(
    url: string,
    _type: string,
    context: YouTubeContext,
    cipherManager: ICipherManager | null
  ): Promise<SourceResult> {
    const sourceName = 'youtube'
    const urlType = checkURLType(url, 'youtube')

    switch (urlType) {
      case YOUTUBE_CONSTANTS.VIDEO:
      case YOUTUBE_CONSTANTS.SHORTS: {
        const idPattern = /(?:v=|\/shorts\/|youtu\.be\/)([^&?]+)/
        const videoIdMatch = url.match(idPattern)
        if (!videoIdMatch?.[1]) {
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
          return {
            loadType: 'error',
            exception: {
              message: `Failed to load video data. Status: ${statusCode}`,
              severity: 'common',
              cause: 'Upstream'
            }
          }
        }

        return await this._handlePlayerResponse(
          playerResponse,
          sourceName,
          videoId
        )
      }

      default:
        return { loadType: 'empty', data: {} }
    }
  }

  /**
   * Resolves a playable stream URL for a decoded track.
   * @param decodedTrack - Decoded track information containing the video identifier
   * @param context - YouTube context for API requests
   * @param cipherManager - Cipher manager for signature deciphering, or null
   * @param itag - Optional specific format itag to request
   * @param proxy - Optional proxy configuration for the request
   * @returns A record containing stream data or an exception
   */
  override async getTrackUrl(
    decodedTrack: TrackInfo,
    context: YouTubeContext,
    cipherManager: ICipherManager | null,
    itag?: number | string,
    proxy?: HttpProxyConfig
  ): Promise<Record<string, unknown>> {
    const { body: playerResponse, statusCode } = await this._makePlayerRequest(
      decodedTrack.identifier,
      context,
      {},
      cipherManager,
      proxy
    )

    if (statusCode !== 200) {
      return {
        loadType: 'error',
        exception: {
          message: `Failed to get player data. Status: ${statusCode}`,
          severity: 'common',
          cause: 'Upstream'
        }
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
   * Performs an innertube player request for the WEB_PARENT_TOOLS client.
   * @param videoId - The YouTube video identifier
   * @param context - YouTube context for the request
   * @param headers - Additional HTTP headers to include
   * @param cipherManager - Cipher manager for signature timestamps, or null
   * @param proxy - Optional proxy configuration for the request
   * @returns The HTTP request result containing the player response
   */
  override async _makePlayerRequest(
    videoId: string,
    context: YouTubeContext,
    headers: Record<string, string>,
    cipherManager: ICipherManager | null,
    proxy?: HttpProxyConfig
  ): Promise<HttpRequestResult> {
    const requestBody: YouTubePlayerRequestBody = {
      context: this.getClient(context),
      videoId: videoId,
      contentCheckOk: true,
      racyCheckOk: true
    }

    if (this.requirePlayerScript() && cipherManager) {
      const playerScript = await cipherManager.getCachedPlayerScript()
      if (playerScript?.url) {
        const signatureTimestamp = await cipherManager.getTimestamp(
          playerScript.url
        )
        const body = requestBody as Record<string, unknown>
        body.playbackContext = {
          contentPlaybackContext: {
            signatureTimestamp
          }
        }
      }
    }

    const response = await makeRequest(
      'https://www.youtube.com/youtubei/v1/player',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': this.getClient(context).client.userAgent,
          'X-YouTube-Client-Name': '88',
          'X-YouTube-Client-Version': '1.20220918',
          'X-Goog-Visitor-Id': context.client.visitorData ?? '',
          Origin: 'https://www.youtube.com',
          Referer: 'https://www.youtube.com/',
          ...headers
        },
        body: requestBody,
        disableBodyCompression: true,
        proxy: proxy || this.getProxy()
      }
    )

    return response
  }
}
