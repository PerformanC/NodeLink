/**
 * YouTube WEB_REMIX client.
 *
 * Targets the YouTube Music web surface for search and playlist resolution
 * while intentionally delegating direct stream extraction to other clients.
 *
 * @packageDocumentation
 * @module YouTubeWebRemixClient
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
  YouTubeNextResponse,
  YouTubeSearchResponse,
  YouTubeSearchTabContent
} from '../../../typings/sources/youtubeClient.types.ts'
import { logger, makeRequest } from '../../../utils.ts'
import {
  BaseClient,
  buildTrack,
  checkURLType,
  YOUTUBE_CONSTANTS
} from '../common.ts'

/**
 * YouTube Music (WEB_REMIX) client implementation.
 *
 * Uses the YouTube Music innertube API to search for tracks,
 * resolve playlist URLs, and provide track metadata. This client
 * does not provide direct stream URLs.
 *
 * @public
 */
export default class WebRemix extends BaseClient {
  /**
   * @param nodelink - NodeLink worker instance providing options, sources, and logging
   * @param oauth - OAuth manager for authenticated requests, or null if unauthenticated
   */
  constructor(nodelink: WorkerNodeLink, oauth: IOAuth | null) {
    super(nodelink, 'WEB_REMIX', oauth)
  }

  /**
   * Returns the YouTube Music client context for innertube requests.
   *
   * This is only used for getting the videoDetails, no playback.
   * @param context - General YouTube context with language, region, and visitor data
   * @returns Client context configured for WEB_REMIX
   */
  override getClient(context: YouTubeContext): YouTubeClientContext {
    return {
      client: {
        clientName: 'WEB_REMIX',
        clientVersion: '1.20260721.00.00',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) YouTubeMusic/3.12.0 Chrome/148.0.7778.271 Electron/42.5.0 Safari/537.36',
        hl: context.client.hl,
        gl: context.client.gl,
        applicationState: 'ACTIVE'
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true }
    }
  }

  /**
   * Whether this client requires a player script for signature deciphering.
   * @returns false — WEB_REMIX does not need cipher resolution
   */
  override requirePlayerScript(): boolean {
    return false
  }

  /**
   * Searches YouTube Music for tracks, playlists, albums, or artists.
   * @param query - Search query string
   * @param type - Search type ('track', 'playlist', 'album', 'artist')
   * @param context - YouTube context with language and region settings
   * @returns Search results with matched tracks or an exception
   */
  override async search(
    query: string,
    type: string,
    context: YouTubeContext
  ): Promise<SourceResult> {
    const sourceName = 'ytmusic'

    let params = 'EgWKAQIIAWoQEAQQAxAJEAUQChAQEBUQEQ%3D%3D' // Default (Tracks)
    if (type === 'playlist') params = 'EgeKAQQoAEABahAQBBADEAkQBRAKEBAQFRAR'
    if (type === 'album') params = 'EgWKAQIYAWoQEAQQAxAJEAUQChAQEBUQEQ%3D%3D'
    if (type === 'artist') params = 'EgWKAQIgAWoQEAQQAxAJEAUQChAQEBUQEQ%3D%3D'

    const requestBody = {
      context: this.getClient(context),
      query: query,
      params
    }

    const {
      body: searchResultRaw,
      error,
      statusCode
    } = await makeRequest(
      'https://music.youtube.com/youtubei/v1/search?prettyPrint=false',
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

    if (error || statusCode !== 200) {
      const message =
        error ||
        `Failed to load results from ${sourceName}. Status: ${statusCode}`
      logger('error', 'YouTube-Music', message)
      return {
        loadType: 'error',
        exception: { message, severity: 'common', cause: 'Upstream' }
      }
    }

    const searchResult = searchResultRaw as YouTubeSearchResponse

    if (searchResult.error) {
      logger(
        'error',
        'YouTube-Music',
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

    const tabContent: YouTubeSearchTabContent | undefined =
      searchResult.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer
        ?.content

    const _loggedVideoData = false
    const tracks: TrackData[] = []
    let videos: unknown[] | null = null

    const findShelf = (
      contents: unknown[] | null | undefined
    ): unknown[] | null => {
      if (!Array.isArray(contents)) return null
      for (const section of contents) {
        const sec = section as Record<string, unknown>
        if (sec.musicShelfRenderer) {
          return (sec.musicShelfRenderer as Record<string, unknown>).contents as
            | unknown[]
            | null
        }
      }
      return null
    }

    if (tabContent?.sectionListRenderer) {
      videos = findShelf(tabContent.sectionListRenderer.contents)
    }

    if (
      !videos &&
      tabContent?.musicSplitViewRenderer?.mainContent?.sectionListRenderer
    ) {
      videos = findShelf(
        tabContent.musicSplitViewRenderer.mainContent.sectionListRenderer
          .contents
      )
    }

    if (!videos || videos.length === 0) {
      logger(
        'debug',
        'YouTube-Music',
        `No matches found on ${sourceName} for: ${query}`
      )
      return { loadType: 'empty', data: {} }
    }

    for (const video of videos) {
      const v = video as Record<string, unknown>
      const renderer =
        v.musicResponsiveListItemRenderer ||
        v.musicTwoColumnItemRenderer ||
        (v.videoId ? v : null)
      if (!renderer) {
        continue
      }

      const track = await buildTrack(
        video as Parameters<typeof buildTrack>[0],
        'ytmusic',
        'ytmusic',
        searchResult as Record<string, unknown>
      )
      if (track) {
        tracks.push(track)
      }
    }

    return { loadType: 'search', data: tracks }
  }

  /**
   * Resolves a YouTube Music URL to track or playlist data.
   * @param url - YouTube or YouTube Music URL
   * @param _type - Source type override (unused)
   * @param context - YouTube context with language and region settings
   * @param cipherManager - Cipher manager instance (unused for WEB_REMIX)
   * @returns Resolved track or playlist data, or an exception
   */
  override async resolve(
    url: string,
    _type: string,
    context: YouTubeContext,
    cipherManager: ICipherManager | null
  ): Promise<SourceResult> {
    const sourceName = 'ytmusic'
    const urlType = checkURLType(url, sourceName)
    const _apiEndpoint = this.getApiEndpoint()

    switch (urlType) {
      case YOUTUBE_CONSTANTS.VIDEO:
      case YOUTUBE_CONSTANTS.SHORTS: {
        const idPattern = /(?:v=|\/shorts\/|youtu\.be\/)([^&?]+)/
        const videoIdMatch = url.match(idPattern)
        if (!videoIdMatch?.[1]) {
          logger(
            'error',
            'YouTube-Music',
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
          logger('error', 'YouTube-Music', message)
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
        const listIdMatch = url.match(/[?&]list=([\w-]+)/)
        if (!listIdMatch?.[1]) {
          return { loadType: 'empty', data: {} }
        }
        const playlistId = listIdMatch[1]

        const body = {
          context: this.getClient(context),
          playlistId,
          enablePersistentPlaylistPanel: true,
          isAudioOnly: true
        }

        const { body: resRaw, statusCode } = await makeRequest(
          'https://music.youtube.com/youtubei/v1/next',
          {
            method: 'POST',
            body,
            headers: {
              'User-Agent': this.getClient(context).client.userAgent,
              'X-Goog-Api-Format-Version': '2'
            },
            disableBodyCompression: true,
            proxy: this.getProxy()
          }
        )

        if (statusCode !== 200 || !resRaw) {
          return { loadType: 'empty', data: {} }
        }

        const res = resRaw as YouTubeNextResponse

        return await this._handlePlaylistResponse(
          playlistId,
          null,
          res,
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
   * WEB_REMIX does not provide direct track URLs.
   * @param _decodedTrack - Decoded track information (unused)
   * @param _context - YouTube context (unused)
   * @param _cipherManager - Cipher manager instance (unused)
   * @returns Exception indicating this client cannot resolve stream URLs
   */
  override async getTrackUrl(
    _decodedTrack: TrackInfo,
    _context: YouTubeContext,
    _cipherManager: ICipherManager | null
  ): Promise<Record<string, unknown>> {
    return {
      loadType: 'error',
      exception: {
        message: 'WebRemix client does not provide direct track URLs.',
        severity: 'common'
      }
    }
  }
}
