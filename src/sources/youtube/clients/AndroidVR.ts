/**
 * YouTube Android VR Client
 *
 * Implements the YouTube ANDROID_VR innertube client for Oculus/Meta Quest
 * virtual reality headset emulation. Provides search, resolve, and track URL
 * resolution without requiring player script deciphering.
 *
 * @packageDocumentation
 * @module YouTubeAndroidVRClient
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
import type { YouTubeSearchResponse } from '../../../typings/sources/youtubeClient.types.ts'
import type { HttpProxyConfig } from '../../../typings/utils.types.ts'
import { logger, makeRequest } from '../../../utils.ts'
import {
  BaseClient,
  buildTrack,
  checkURLType,
  YOUTUBE_CONSTANTS
} from '../common.ts'

/**
 * YouTube ANDROID_VR innertube client.
 *
 * Emulates an Oculus Quest VR headset for YouTube API requests.
 * Does not require player script for signature deciphering.
 *
 * @public
 */
export default class AndroidVR extends BaseClient {
  /**
   * Creates a new AndroidVR client instance.
   *
   * @param nodelink - NodeLink worker instance providing options and source access
   * @param oauth - OAuth manager for authenticated requests, or null if unauthenticated
   */
  constructor(nodelink: WorkerNodeLink, oauth: IOAuth | null) {
    super(nodelink, 'ANDROID_VR', oauth)
  }

  /**
   * Builds the YouTube client context for ANDROID_VR innertube requests.
   *
   * @param context - General YouTube context with language, region, and visitor data
   * @returns Client context object describing this ANDROID_VR client configuration
   */
  override getClient(context: YouTubeContext): YouTubeClientContext {
    return {
      client: {
        clientName: 'ANDROID_VR',
        clientVersion: '1.65.10',
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/39.3.0.11.46.766180192 Chrome/136.0.7103.177 VR Safari/537.36,gzip(gfe);GoogleHypersonic',
        deviceMake: 'Google',
        osName: 'Android',
        osVersion: '15',
        androidSdkVersion: '35',
        hl: context.client.hl,
        gl: context.client.gl,
        visitorData: context.client.visitorData
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true }
    }
  }

  /**
   * ANDROID_VR client does not require a player script.
   *
   * @returns Always false for the ANDROID_VR client
   */
  override requirePlayerScript(): boolean {
    return false
  }

  /**
   * Searches YouTube for tracks matching the given query.
   *
   * @param query - Search query string (e.g., song name, artist)
   * @param _type - Search type hint (unused by ANDROID_VR client)
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

    try {
      const {
        body: searchResultRaw,
        error,
        statusCode
      } = await makeRequest(
        'https://youtubei.googleapis.com/youtubei/v1/search',
        {
          method: 'POST',
          headers: {
            'User-Agent': this.getClient(context).client.userAgent,
            'X-Goog-Api-Format-Version': '2'
          },
          body: requestBody,
          disableBodyCompression: true,
          proxy: this.getProxy()
        }
      )

      const searchResult = searchResultRaw as YouTubeSearchResponse

      if (error || statusCode !== 200) {
        const message =
          error ||
          `Failed to load results from ${sourceName}. Status: ${statusCode}`
        logger('error', 'YouTube-AndroidVR', message)
        return {
          loadType: 'error',
          exception: { message, severity: 'common', cause: 'Upstream' }
        }
      }

      if (!searchResult) {
        logger(
          'debug',
          'YouTube-AndroidVR',
          `Empty search result for '${query}'.`
        )
        return { loadType: 'empty', data: {} }
      }

      if (searchResult.error) {
        logger(
          'error',
          'YouTube-AndroidVR',
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
          'YouTube-AndroidVR',
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
          'YouTube-AndroidVR',
          `No processable tracks found on ${sourceName} for: ${query}`
        )
        return { loadType: 'empty', data: {} }
      }

      return { loadType: 'search', data: tracks }
    } catch (e: unknown) {
      logger(
        'error',
        'YouTube-AndroidVR',
        `Exception during search for '${query}': ${e instanceof Error ? e.message : String(e)}`
      )
      return {
        loadType: 'error',
        exception: {
          message: e instanceof Error ? e.message : String(e),
          severity: 'fault',
          cause: 'Exception'
        }
      }
    }
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
    const apiEndpoint = 'https://youtubei.googleapis.com'

    switch (urlType) {
      case YOUTUBE_CONSTANTS.VIDEO:
      case YOUTUBE_CONSTANTS.SHORTS: {
        const idPattern = /(?:v=|\/shorts\/|youtu\.be\/)([^&?]+)/
        const videoIdMatch = url.match(idPattern)
        if (!videoIdMatch?.[1]) {
          logger(
            'error',
            'YouTube-AndroidVR',
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
          logger('error', 'YouTube-AndroidVR', message)
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
            'YouTube-AndroidVR',
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
            'YouTube-AndroidVR',
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
      'YouTube-AndroidVR',
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
      logger('error', 'YouTube-AndroidVR', message)
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
