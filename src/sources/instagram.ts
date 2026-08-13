import { PassThrough } from 'node:stream'
import { URLSearchParams } from 'node:url'

import type {
  InstagramApiConfig,
  InstagramCachedConfig,
  InstagramDecodedTrack,
  InstagramFetchResult,
  InstagramLoadStreamResult,
  InstagramMirrorCandidateInfo,
  InstagramMirrorResult,
  InstagramNodeLinkContext,
  InstagramOgFetchResult,
  InstagramParsedOgMetadata,
  InstagramRawTrackData,
  InstagramTrackData,
  InstagramUrlInfo
} from '../typings/sources/instagram.types.ts'
import type {
  SourceResult,
  TrackInfo,
  TrackUrlResult
} from '../typings/sources/source.types.ts'
import type {
  BestMatchCandidate,
  BestMatchTrackInfo,
  TrackEncodeInput
} from '../typings/utils.types.ts'
import {
  encodeTrack,
  getBestMatch,
  http1makeRequest,
  logger,
  makeRequest
} from '../utils.ts'

/**
 * Instagram source implementation.
 *
 * Supports resolving Instagram posts, reels, and audio pages into
 * playable tracks. Post/reel URLs are resolved via the Instagram
 * GraphQL API, while audio pages use a combination of OG metadata
 * extraction, authenticated audio API calls, and mirror track
 * resolution on other sources.
 */
export default class InstagramSource {
  /**
   * Runtime worker context used by the source implementation.
   */
  public readonly nodelink: InstagramNodeLinkContext

  /**
   * URL patterns supported by this source.
   *
   * @remarks
   * - Index 0: Audio page (`/reels/audio/:id`)
   * - Index 1: Standard post (`/p/:shortcode`)
   * - Index 2: Reel/short-video (`/reel/:shortcode` or `/reels/:shortcode`)
   */
  public readonly patterns: RegExp[]

  /**
   * Match priority used by the source manager.
   */
  public readonly priority: number

  /**
   * Internal API configuration state.
   *
   * Stores CSRF tokens, app IDs, and GraphQL document IDs
   * required to authenticate requests against the Instagram API.
   */
  public apiConfig: InstagramApiConfig

  /**
   * Creates a new Instagram source wrapper.
   *
   * @param nodelink - Worker runtime used by the source implementation.
   */
  public constructor(nodelink: InstagramNodeLinkContext) {
    this.nodelink = nodelink
    this.patterns = [
      /^https?:\/\/(?:www\.)?instagram\.com\/reels\/audio\/(\d+)/,
      /^https?:\/\/(?:www\.)?instagram\.com\/p\/([\w-]+)/,
      /^https?:\/\/(?:www\.)?instagram\.com\/(?:reels?|reel)\/([\w-]+)/
    ]
    this.priority = 70

    this.apiConfig = {
      apiUrl: 'https://www.instagram.com/api/graphql',
      audioApiUrl: 'https://www.instagram.com/api/v1/clips/music/',
      csrfToken: null,
      igAppId: null,
      fbLsd: null,
      docId_post: '10015901848480474',
      jazoest: '2957'
    }
  }

  /**
   * Initializes the Instagram source by fetching API parameters.
   *
   * Attempts to load cached configuration from the CredentialManager
   * first, then falls back to scraping the Instagram homepage for
   * CSRF tokens, app IDs, and LSD tokens.
   *
   * @returns `true` when the source is ready to use, `false` when
   * initialization fails and the source should be considered unavailable.
   */
  public async setup(): Promise<boolean> {
    logger('info', 'Sources', 'Checking Instagram API parameters...')

    const cachedConfig =
      this.nodelink.credentialManager.get<InstagramCachedConfig>(
        'instagram_api_config'
      )
    if (cachedConfig) {
      this.apiConfig = { ...this.apiConfig, ...cachedConfig }
      logger(
        'info',
        'Sources',
        'Loaded Instagram parameters from CredentialManager.'
      )
      return true
    }

    try {
      const response = await makeRequest('https://www.instagram.com/', {
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
        }
      })

      const body = response.body

      if (typeof body !== 'string' || response.statusCode !== 200) {
        throw new Error(
          `Failed to fetch Instagram homepage (Status: ${response.statusCode})`
        )
      }

      const csrfToken = body.match(/"csrf_token":"(.*?)"/)?.[1]
      const igAppId = body.match(/"appId":"(.*?)"/)?.[1]
      const fbLsd =
        body.match(/"LSD",\[\],{"token":"(.*?)"},/)?.[1] ||
        body.match(/name="lsd" value="(.*?)"/)?.[1]
      const docIdPost = body.match(/"PostPage",\[\],"(\d+)",/)?.[1]

      if (!csrfToken || !igAppId || !fbLsd) {
        logger(
          'error',
          'Sources',
          'Could not fetch all required Instagram parameters (CSRF, AppID, LSD). Source will be unavailable.'
        )
        return false
      }

      this.apiConfig.csrfToken = csrfToken
      this.apiConfig.igAppId = igAppId
      this.apiConfig.fbLsd = fbLsd
      if (docIdPost) this.apiConfig.docId_post = docIdPost

      this.nodelink.credentialManager.set<InstagramCachedConfig>(
        'instagram_api_config',
        {
          csrfToken: this.apiConfig.csrfToken,
          igAppId: this.apiConfig.igAppId,
          fbLsd: this.apiConfig.fbLsd,
          docId_post: this.apiConfig.docId_post
        },
        24 * 60 * 60 * 1000
      )

      logger('info', 'Sources', 'Loaded Instagram source.')
      return true
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e)
      logger(
        'error',
        'Sources',
        `Instagram setup failed: ${message}. Source will be unavailable.`
      )
      return false
    }
  }

  /**
   * Tests whether a URL matches any of the supported Instagram patterns.
   *
   * @param link - Candidate URL to test.
   * @returns `true` when the URL matches a supported Instagram pattern.
   */
  public isLinkMatch(link: string): boolean {
    return this.patterns.some((pattern) => pattern.test(link))
  }

  /**
   * Decodes common HTML entities in a string.
   *
   * @param value - String potentially containing HTML entities.
   * @returns Decoded and trimmed string, or the original falsy value.
   */
  private _decodeHtmlEntities(value: string | null | undefined): string {
    if (!value) return value as string

    return value
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
        String.fromCodePoint(Number.parseInt(hex, 16))
      )
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
      .replace(/&/g, '&')
      .replace(/&#39;/g, "'")
      .replace(/"/g, '"')
      .replace(/</g, '<')
      .replace(/>/g, '>')
      .replace(/'/g, "'")
      .replace(/&nbsp;/g, ' ')
      .trim()
  }

  /**
   * Extracts the content attribute from a `<meta>` tag matching a given property.
   *
   * @param html - Raw HTML string to search.
   * @param property - OG/meta property name (e.g., `'og:title'`).
   * @returns Decoded content value, or `null` when the tag is not found.
   */
  private _extractMetaContent(html: string, property: string): string | null {
    if (!html || !property) return null

    const patterns = [
      new RegExp(
        `<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`,
        'i'
      ),
      new RegExp(
        `<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`,
        'i'
      )
    ]

    for (const pattern of patterns) {
      const match = html.match(pattern)
      if (match?.[1]) {
        return this._decodeHtmlEntities(match[1])
      }
    }

    return null
  }

  /**
   * Parses OG title and description to extract audio metadata.
   *
   * Handles both the `Author | Title` format and the
   * `Listen to ... on Instagram and watch reels using ... audio` format.
   *
   * @param ogTitle - OG title string from the audio page.
   * @param ogDescription - OG description string from the audio page.
   * @returns Parsed author, title, and search query.
   */
  private _parseAudioOgMetadata(
    ogTitle: string | null,
    ogDescription: string | null
  ): InstagramParsedOgMetadata {
    const normalizedOgTitle = (ogTitle || '')
      .replace(/\s+on Instagram$/i, '')
      .trim()

    let author: string | null = null
    let title: string | null = null

    if (normalizedOgTitle.includes(' | ')) {
      const [parsedAuthor, ...titleParts] = normalizedOgTitle.split(' | ')
      author = parsedAuthor?.trim() || null
      title = titleParts.join(' | ').trim() || null
    }

    if ((!author || !title) && ogDescription) {
      const descMatch = ogDescription.match(
        /Listen to (.+?) on Instagram and watch reels using (.+?) audio/i
      )
      if (descMatch) {
        author ||= descMatch[1]?.trim() || null
        title ||= descMatch[2]?.trim() || null
      }
    }

    const normalizedTitle = title || normalizedOgTitle || 'Instagram Audio'
    const searchQuery = [author, title].filter(Boolean).join(' ').trim()

    return {
      author: author || 'User Unknown',
      title: normalizedTitle,
      searchQuery: searchQuery || normalizedTitle
    }
  }

  /**
   * Normalizes text for mirror candidate comparison.
   *
   * Converts to lowercase, strips special characters, and collapses whitespace.
   *
   * @param value - Raw text to normalize.
   * @returns Normalized text suitable for token comparison.
   */
  private _normalizeMirrorText(value: string | null | undefined): string {
    return String(value || '')
      .toLowerCase()
      .replace(/[|()[\]{}]/g, ' ')
      .replace(/feat\.?/g, ' ')
      .replace(/ft\.?/g, ' ')
      .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  /**
   * Tokenizes normalized text for mirror candidate matching.
   *
   * Filters out common stop words like 'official', 'audio', 'video', etc.
   *
   * @param value - Raw text to tokenize.
   * @returns Array of meaningful tokens.
   */
  private _tokenizeMirrorText(value: string | null | undefined): string[] {
    const ignored = new Set([
      'official',
      'audio',
      'video',
      'lyrics',
      'lyric',
      'prod',
      'version',
      'music'
    ])

    return this._normalizeMirrorText(value)
      .split(' ')
      .filter((token) => token.length > 1 && !ignored.has(token))
  }

  /**
   * Determines whether a search result candidate is an acceptable mirror
   * for the original Instagram audio track.
   *
   * Uses token-based matching: at least 50% of title tokens must match,
   * and at least one author token must match (when available).
   *
   * @param original - Original Instagram track metadata.
   * @param candidateInfo - Candidate track info from a search result.
   * @returns `true` when the candidate is an acceptable mirror.
   */
  private _isMirrorCandidateAcceptable(
    original: BestMatchTrackInfo,
    candidateInfo: InstagramMirrorCandidateInfo | undefined | null
  ): boolean {
    if (!candidateInfo) return false

    const candidateText = this._normalizeMirrorText(
      `${candidateInfo.title || ''} ${candidateInfo.author || ''}`
    )
    const titleTokens = this._tokenizeMirrorText(original.title)
    const authorTokens =
      original.author && original.author !== 'User Unknown'
        ? this._tokenizeMirrorText(original.author)
        : []

    if (titleTokens.length > 0) {
      const titleMatches = titleTokens.filter((token) =>
        candidateText.includes(token)
      ).length
      const minimumTitleMatches = Math.max(
        1,
        Math.ceil(titleTokens.length * 0.5)
      )

      if (titleMatches < minimumTitleMatches) {
        return false
      }
    }

    if (authorTokens.length === 0) {
      return true
    }

    const authorMatches = authorTokens.filter((token) =>
      candidateText.includes(token)
    ).length

    return authorMatches > 0
  }

  /**
   * Fetches audio metadata from an Instagram audio page using OG meta tags.
   *
   * Serves as a lightweight fallback before attempting the authenticated
   * audio API endpoint.
   *
   * @param audioId - Instagram audio cluster ID.
   * @returns Fetch result containing parsed OG metadata or an error.
   */
  private async _fetchAudioOgMetadata(
    audioId: string
  ): Promise<InstagramOgFetchResult> {
    if (!audioId) {
      return {
        data: null,
        exception: { message: 'Audio ID not provided', severity: 'common' }
      }
    }

    const pageUrl = `https://www.instagram.com/reels/audio/${audioId}/`

    let response = null
    try {
      response = await makeRequest(pageUrl, {
        method: 'GET',
        headers: {
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'User-Agent': 'facebookexternalhit/1.1'
        },
        disableBodyCompression: true
      })
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e)
      return {
        data: null,
        exception: {
          message: `Failed to fetch Instagram audio page: ${message}`,
          severity: 'fault'
        }
      }
    }

    const body = response?.body
    if (response?.statusCode !== 200 || typeof body !== 'string') {
      return {
        data: null,
        exception: {
          message: `Failed to fetch Instagram audio page. Status: ${response?.statusCode}`,
          severity: 'common'
        }
      }
    }

    const ogTitle = this._extractMetaContent(body, 'og:title')
    const ogDescription = this._extractMetaContent(body, 'og:description')
    const ogImage = this._extractMetaContent(body, 'og:image')

    if (!ogTitle && !ogDescription) {
      return {
        data: null,
        exception: {
          message: 'Instagram audio metadata not found in page HTML.',
          severity: 'common'
        }
      }
    }

    const parsed = this._parseAudioOgMetadata(ogTitle, ogDescription)

    return {
      data: {
        videoUrl: '',
        author: parsed.author || 'User Unknown',
        title: parsed.title || 'Instagram Audio',
        thumbnail: ogImage || '',
        length: -1,
        isStream: false,
        isSeekable: true,
        description: ogDescription || '',
        searchQuery: parsed.searchQuery
      } as InstagramRawTrackData & { searchQuery: string },
      exception: null
    }
  }

  /**
   * Attempts to find a playable mirror track on other sources.
   *
   * Generates multiple search queries from the decoded track metadata,
   * searches using the default source, and applies token-based
   * candidate filtering to find the best match.
   *
   * @param decodedTrack - Original Instagram track metadata.
   * @param preferredQuery - Optional pre-constructed search query to try first.
   * @returns Mirror resolution result with the matched track, or an exception.
   */
  private async _resolveAudioMirrorTrack(
    decodedTrack: BestMatchTrackInfo,
    preferredQuery: string | null = null
  ): Promise<InstagramMirrorResult> {
    const queries = [
      preferredQuery || '',
      `${decodedTrack.author || ''} - ${decodedTrack.title || ''}`.trim(),
      `"${decodedTrack.title || ''}" ${decodedTrack.author || ''}`.trim(),
      `${decodedTrack.title || ''} ${decodedTrack.author || ''}`.trim(),
      `${decodedTrack.author || ''} ${decodedTrack.title || ''}`.trim(),
      decodedTrack.title || '',
      decodedTrack.author || ''
    ].filter(Boolean)

    const triedQueries = new Set<string>()

    for (const query of queries) {
      if (triedQueries.has(query)) continue
      triedQueries.add(query)

      let searchResult: SourceResult
      try {
        searchResult = await this.nodelink.sources.searchWithDefault(query)
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e)
        logger(
          'debug',
          'Sources',
          `Instagram audio mirror lookup failed on search for "${query}": ${message}`
        )
        continue
      }

      if (
        searchResult.loadType !== 'search' ||
        !Array.isArray(searchResult.data) ||
        searchResult.data.length === 0
      ) {
        continue
      }

      const acceptableMatches = searchResult.data.filter((candidate) =>
        this._isMirrorCandidateAcceptable(decodedTrack, candidate?.info)
      )

      if (acceptableMatches.length === 0) {
        logger(
          'debug',
          'Sources',
          `Rejected low-confidence mirror candidates for "${query}".`
        )
        continue
      }

      const bestMatch =
        getBestMatch(acceptableMatches as BestMatchCandidate[], decodedTrack) ||
        acceptableMatches[0]

      if (!bestMatch?.info) continue

      const streamInfo = await this.nodelink.sources.getTrackUrl(
        bestMatch.info as TrackInfo
      )
      if (!streamInfo?.exception) {
        return {
          newTrack: bestMatch as BestMatchCandidate & { info: TrackInfo },
          ...streamInfo
        } as InstagramMirrorResult
      }
    }

    return {
      exception: {
        message: 'No playable mirror found for Instagram audio.',
        severity: 'fault'
      }
    }
  }

  /**
   * Extracts the content type and identifier from an Instagram URL.
   *
   * @param url - Candidate Instagram URL.
   * @returns Parsed URL info with content type, identifier, and optional path segment.
   */
  private _extractInfo(url: string): InstagramUrlInfo {
    if (!url) {
      return {
        id: null,
        error: 'Instagram URL not provided',
        type: null
      }
    }
    for (const [index, pattern] of this.patterns.entries()) {
      const match = url.match(pattern)
      if (match?.[1]) {
        if (index === 0) {
          return { id: match[1], error: null, type: 'audio' }
        }

        let pathSegment: 'p' | 'reel' = 'p'
        if (url.includes('/reel/') || url.includes('/reels/')) {
          pathSegment = 'reel'
        }
        return {
          id: match[1],
          error: null,
          type: 'post',
          pathSegment: pathSegment
        }
      }
    }
    return {
      id: null,
      error: 'Instagram post/reel/audio ID not found in URL',
      type: null
    }
  }

  /**
   * Converts a numeric Instagram media ID to a base62 shortcode.
   *
   * @param mediaId - Numeric media ID (may contain an underscore suffix).
   * @returns Base62 shortcode, or `null` when conversion fails.
   */
  private _getShortcodeFromMediaId(
    mediaId: string | number | bigint
  ): string | null {
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    let shortcode = ''
    let idStr = String(mediaId)
    if (idStr.includes('_')) {
      idStr = idStr.substring(0, idStr.indexOf('_'))
    }
    try {
      let mediaIdBigInt = BigInt(idStr)
      if (mediaIdBigInt <= 0) return null
      while (mediaIdBigInt > 0) {
        const remainder = mediaIdBigInt % BigInt(64)
        mediaIdBigInt = (mediaIdBigInt - remainder) / BigInt(64)
        shortcode = alphabet.charAt(Number(remainder)) + shortcode
      }
      return shortcode
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e)
      logger(
        'debug',
        'Sources',
        `Could not convert Instagram mediaId "${mediaId}" to shortcode: ${message}`
      )
      return null
    }
  }

  /**
   * Encodes the GraphQL request body for a post query.
   *
   * @param shortcode - Instagram post shortcode.
   * @returns URL-encoded form body string.
   */
  private _encodePostRequestData(shortcode: string): string {
    const variables = JSON.stringify({
      shortcode: shortcode,
      fetch_comment_count: 'null',
      fetch_related_profile_media_count: 'null',
      parent_comment_count: 'null',
      child_comment_count: 'null',
      fetch_like_count: 'null',
      fetch_tagged_user_count: 'null',
      fetch_preview_comment_count: 'null',
      has_threaded_comments: 'false',
      hoisted_comment_id: 'null',
      hoisted_reply_id: 'null'
    })

    const requestData: Record<string, string> = {
      av: '0',
      __user: '0',
      __a: '1',
      __req: '3',
      dpr: '1',
      __ccg: 'UNKNOWN',
      lsd: this.apiConfig.fbLsd ?? '',
      jazoest: this.apiConfig.jazoest,
      doc_id: this.apiConfig.docId_post,
      variables: variables,
      fb_api_req_friendly_name: 'PolarisPostActionLoadPostQueryQuery',
      fb_api_caller_class: 'RelayModern'
    }

    const params = new URLSearchParams()
    for (const key in requestData) {
      const value = requestData[key]
      if (value !== undefined) {
        params.append(key, value)
      }
    }
    return params.toString()
  }

  /**
   * Fetches audio information from the authenticated Instagram audio API.
   *
   * Supports both original sound info and music info payloads.
   *
   * @param audioId - Instagram audio cluster ID.
   * @returns Fetch result containing audio stream URL and metadata, or an error.
   */
  private async _fetchFromAudioAPI(
    audioId: string
  ): Promise<InstagramFetchResult> {
    if (!audioId) {
      return {
        data: null,
        exception: { message: 'Audio ID not provided', severity: 'common' }
      }
    }

    const headers: Record<string, string> = {
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-FB-Friendly-Name': 'PolarisClipsAudioRoute',
      'X-CSRFToken': this.apiConfig.csrfToken ?? '',
      'X-IG-App-ID': this.apiConfig.igAppId ?? '',
      'X-FB-LSD': this.apiConfig.fbLsd ?? '',
      'X-ASBD-ID': '129477',
      'Sec-Fetch-Site': 'same-origin',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
      Origin: 'https://www.instagram.com',
      Referer: `https://www.instagram.com/reels/audio/${audioId}/`
    }

    const body = new URLSearchParams({
      audio_cluster_id: audioId,
      lsd: this.apiConfig.fbLsd ?? '',
      jazoest: this.apiConfig.jazoest,
      __user: '0',
      __a: '1'
    }).toString()

    let response = null
    try {
      response = await http1makeRequest(this.apiConfig.audioApiUrl, {
        method: 'POST',
        headers: headers,
        body: body,
        disableBodyCompression: true
      })
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e)
      logger(
        'error',
        'Sources',
        `Internal error during Instagram Audio API request for audioId ${audioId}: ${message}`
      )
      return {
        data: null,
        exception: {
          message: `Internal error during Audio API request: ${message}`,
          severity: 'fault'
        }
      }
    }

    if (response.error || response.statusCode !== 200) {
      const errorMsg =
        response.error ||
        `Audio API request failed with code ${response.statusCode}`
      return {
        data: null,
        exception: {
          message: String(errorMsg),
          severity: 'fault',
          cause: `Status: ${response.statusCode}`
        }
      }
    }

    let responseData: unknown = response.body
    if (typeof responseData === 'string') {
      let bodyStr = responseData
      if (bodyStr.startsWith('for (;;);')) {
        bodyStr = bodyStr.substring('for (;;);'.length)
      }
      try {
        responseData = JSON.parse(bodyStr)
      } catch (_e) {
        return {
          data: null,
          exception: {
            message: 'Invalid JSON response from Audio API',
            severity: 'fault'
          }
        }
      }
    }

    if (!responseData) {
      return {
        data: null,
        exception: {
          message: 'Invalid data structure in Audio API JSON response',
          severity: 'fault'
        }
      }
    }

    const data = responseData as Record<string, unknown>
    let payload: Record<string, unknown> | null = null
    if (data.payload) {
      payload = data.payload as Record<string, unknown>
    } else if (data.metadata) {
      payload = data
    } else {
      return {
        data: null,
        exception: {
          message:
            'Invalid data structure in Audio API JSON response (no payload or metadata)',
          severity: 'fault'
        }
      }
    }

    const metadata = payload.metadata as Record<string, unknown> | undefined
    let audioInfo = metadata?.original_sound_info as
      | Record<string, unknown>
      | undefined
    let infoSource = 'original_sound_info'

    if (!audioInfo) {
      audioInfo = metadata?.music_info as Record<string, unknown> | undefined
      infoSource = 'music_info'
    }

    if (!audioInfo) {
      const items = payload?.items as
        | {
            media?: {
              clips_metadata?: { music_info?: Record<string, unknown> }
            }
          }[]
        | undefined
      audioInfo = items?.[0]?.media?.clips_metadata?.music_info
      infoSource = 'music_info'
    }

    if (!audioInfo) {
      return {
        data: null,
        exception: {
          message: 'Audio information not found in API response.',
          severity: 'common'
        }
      }
    }

    let audioUrl: string | null = null
    let artist: string | null = null
    let title: string | null = null
    let duration: number | null = null
    let thumbnail: string | null = null

    if (infoSource === 'original_sound_info') {
      audioUrl = (audioInfo.progressive_download_url as string) || null
      const igArtist = audioInfo.ig_artist as
        | Record<string, unknown>
        | undefined
      artist = (igArtist?.username as string) || 'User Unknown'
      title = (audioInfo.original_audio_title as string) || 'Instagram Audio'
      duration = (audioInfo.duration_in_ms as number) || 0
      thumbnail = (igArtist?.profile_pic_url as string) || ''
    } else {
      const musicAsset = audioInfo.music_asset_info as
        | Record<string, unknown>
        | undefined
      const musicConsumption = audioInfo.music_consumption_info as
        | Record<string, unknown>
        | undefined

      audioUrl =
        (musicAsset?.fast_start_progressive_download_url as string) ||
        (audioInfo.progressive_download_url as string) ||
        null
      // there is no difference between fast_start and progressive, but fast_start always appears first so.
      if (!audioUrl && musicConsumption?.dash_manifest) {
        const urlMatch = String(musicConsumption.dash_manifest).match(
          /<BaseURL>(.*?)<\/BaseURL>/
        )
        if (urlMatch?.[1]) {
          audioUrl = urlMatch[1].replace(/&amp;/g, '&')
        }
      }

      if (!audioUrl) {
        audioUrl = (audioInfo.progressive_download_url as string) || null
      }

      artist =
        (musicAsset?.display_artist as string) ||
        (musicAsset?.artist_name as string) ||
        'User Unknown'
      title = (musicAsset?.title as string) || 'Instagram Audio'
      duration = (musicAsset?.duration_in_ms as number) || 0
      // cover_artwork_uri gives better quality i see.
      thumbnail =
        (musicAsset?.cover_artwork_uri as string) ||
        (audioInfo.cover_artwork_thumbnail_uri as string) ||
        ''
    }

    if (!audioUrl) {
      return {
        data: null,
        exception: {
          message: 'Audio download URL not found in API response.',
          severity: 'common'
        }
      }
    }

    return {
      data: {
        videoUrl: audioUrl,
        author: artist,
        length: duration,
        thumbnail: thumbnail,
        title: title,
        isStream: false,
        isSeekable: true
      },
      exception: null
    }
  }

  /**
   * Fetches a video from Instagram's logged-out clips query.
   *
   * @param postId - Instagram shortcode for the video.
   * @returns Video data when found, otherwise `null`.
   */
  private async _fetchFromClipsQuery(
    postId: string
  ): Promise<InstagramFetchResult | null> {
    try {
      const alphabet =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
      let mediaId = 0n
      for (const character of postId) {
        mediaId = mediaId * 64n + BigInt(alphabet.indexOf(character))
      }

      const variables = JSON.stringify({
        data: {
          chaining_mode: 'same_author',
          clips_media_id: mediaId.toString()
        },
        __relay_internal__pv__PolarisReelsRecoDebugOverlayEnabledrelayprovider: false,
        __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false
      })
      const query = new URLSearchParams({
        doc_id: '27695069083459414',
        variables
      })
      const response = await makeRequest(
        `https://www.instagram.com/graphql/query/?${query.toString()}`,
        { method: 'GET' }
      )
      if (response.error || response.statusCode !== 200) return null

      const responseData =
        typeof response.body === 'string'
          ? (JSON.parse(response.body) as Record<string, unknown>)
          : (response.body as Record<string, unknown>)
      const edges = (
        (responseData.data as Record<string, unknown> | undefined)
          ?.xdt_api__v1__clips__clips_on_logged_out_connection_v2 as
          | Record<string, unknown>
          | undefined
      )?.edges as
        | Array<{ node: { media?: Record<string, unknown> } }>
        | undefined
      const media = edges
        ?.map((edge) => edge.node.media)
        .find((item) => item?.code === postId)
      if (media?.media_type !== 2) return null

      const videoVersions = media.video_versions as
        | Array<Record<string, unknown>>
        | undefined
      const videoUrl = videoVersions?.find(
        (version) => typeof version.url === 'string'
      )?.url as string | undefined
      if (!videoUrl) return null

      const user = media.user as Record<string, unknown> | undefined
      const caption = media.caption as Record<string, unknown> | undefined
      const imageVersions = media.image_versions2 as
        | Record<string, unknown>
        | undefined
      const imageCandidates = imageVersions?.candidates as
        | Array<Record<string, unknown>>
        | undefined
      const manifest = media.video_dash_manifest as string | undefined
      const manifestDuration = manifest?.match(
        /mediaPresentationDuration="PT([\d.]+)S"/
      )?.[1]

      return {
        data: {
          videoUrl,
          author: (user?.username as string) || 'User Unknown',
          length: Math.round(Number(manifestDuration || 0) * 1000),
          thumbnail:
            (imageCandidates?.find(
              (candidate) => typeof candidate.url === 'string'
            )?.url as string | undefined) || '',
          title: (caption?.text as string) || 'Instagram Video',
          isStream: false,
          isSeekable: true
        },
        exception: null
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e)
      logger(
        'debug',
        'Sources',
        `Instagram clips query failed for ${postId}: ${message}`
      )
      return null
    }
  }

  /**
   * Fetches post/reel media information from the Instagram GraphQL API.
   *
   * Handles both single video posts and carousel posts with video children.
   *
   * @param postId - Instagram shortcode for the post.
   * @param pathSegment - URL path segment used in the Referer header (`'p'` or `'reel'`).
   * @returns Fetch result containing video stream URL and metadata, or an error.
   */
  private async _fetchFromGraphQL(
    postId: string,
    pathSegment?: string
  ): Promise<InstagramFetchResult> {
    if (!postId) {
      return {
        data: null,
        exception: { message: 'Post ID not provided', severity: 'common' }
      }
    }

    // this no longer works btw...
    // only is working from clips, but there are ways to do it on /embed/ too.
    const headers: Record<string, string> = {
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-FB-Friendly-Name': 'PolarisPostActionLoadPostQueryQuery',
      'X-CSRFToken': this.apiConfig.csrfToken ?? '',
      'X-IG-App-ID': this.apiConfig.igAppId ?? '',
      'X-FB-LSD': this.apiConfig.fbLsd ?? '',
      'X-ASBD-ID': '129477',
      'Sec-Fetch-Site': 'same-origin',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
      Origin: 'https://www.instagram.com',
      Referer: `https://www.instagram.com/${pathSegment || 'p'}/${postId}/`
    }

    const encodedData = this._encodePostRequestData(postId)

    let response = null
    try {
      response = await http1makeRequest(this.apiConfig.apiUrl, {
        method: 'POST',
        headers: headers,
        body: encodedData,
        disableBodyCompression: true
      })
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e)
      logger(
        'error',
        'Sources',
        `Internal error during Instagram GraphQL request for postId ${postId}: ${message}`
      )
      return {
        data: null,
        exception: {
          message: `Internal error during GraphQL request: ${message}`,
          severity: 'fault'
        }
      }
    }

    if (response.error || response.statusCode !== 200) {
      const errorMsg =
        response.error ||
        `GraphQL request failed with code ${response.statusCode}`
      return {
        data: null,
        exception: {
          message: String(errorMsg),
          severity: 'fault',
          cause: `Status: ${response.statusCode}`
        }
      }
    }

    let responseData: unknown = response.body
    if (typeof responseData === 'string') {
      try {
        responseData = JSON.parse(responseData)
      } catch (_e) {
        return {
          data: null,
          exception: {
            message: 'Invalid JSON response from GraphQL',
            severity: 'fault'
          }
        }
      }
    }

    const data = responseData as Record<string, unknown> | null
    if (!data?.data) {
      return {
        data: null,
        exception: {
          message: 'Invalid data structure in GraphQL JSON response',
          severity: 'fault'
        }
      }
    }

    const media = (data.data as Record<string, unknown>)
      .xdt_shortcode_media as Record<string, unknown> | null

    if (media === null) {
      return {
        data: null,
        exception: {
          message: 'Media not found or unavailable (private/deleted?).',
          severity: 'common'
        }
      }
    }

    let videoNode: Record<string, unknown> | null = null

    if (media.is_video) {
      videoNode = media
    } else if (
      media.__typename === 'XDTGraphSidecar' &&
      media.edge_sidecar_to_children
    ) {
      const edges = (media.edge_sidecar_to_children as Record<string, unknown>)
        .edges as Array<{ node: Record<string, unknown> }> | undefined
      const videoEdge = edges?.find((edge) => edge.node.is_video)
      if (videoEdge) {
        videoNode = videoEdge.node
      }
    }

    if (!videoNode) {
      return {
        data: null,
        exception: {
          message: 'This post does not contain a video.',
          severity: 'common'
        }
      }
    }

    const videoUrl = videoNode.video_url as string | undefined
    if (!videoUrl) {
      return {
        data: null,
        exception: {
          message: 'Video URL not found in API response.',
          severity: 'common'
        }
      }
    }

    const captionEdges = (
      media.edge_media_to_caption as Record<string, unknown> | undefined
    )?.edges as Array<{ node: Record<string, unknown> }> | undefined
    const title = (captionEdges?.[0]?.node?.text as string) || 'Instagram Video'
    const owner = media.owner as Record<string, unknown> | undefined

    return {
      data: {
        videoUrl: videoUrl,
        author: (owner?.username as string) || 'User Unknown',
        length: ((videoNode.video_duration as number) || 0) * 1000,
        thumbnail:
          (videoNode.display_url as string) ||
          (media.display_url as string) ||
          '',
        title: title,
        isStream: false,
        isSeekable: true
      },
      exception: null
    }
  }

  /**
   * Resolves an Instagram URL into a single playable track.
   *
   * For post/reel URLs, fetches from the GraphQL API. For audio URLs,
   * tries OG metadata first, then falls back to the authenticated
   * audio API.
   *
   * @param queryUrl - Candidate Instagram URL.
   * @returns Track result payload, empty result, or error result.
   */
  public async resolve(queryUrl: string): Promise<SourceResult> {
    const urlInfo = this._extractInfo(queryUrl)
    if (urlInfo.error || !urlInfo.id) {
      return {
        loadType: 'error',
        exception: {
          message: urlInfo.error ?? 'Instagram URL not provided',
          severity: 'common',
          cause: 'URLParsing'
        }
      }
    }

    const contentId = urlInfo.id
    const { type, pathSegment } = urlInfo

    let trackData: InstagramRawTrackData | null = null
    let fetchError: InstagramFetchResult['exception'] = null

    if (type === 'post') {
      const clipsResult = await this._fetchFromClipsQuery(contentId)
      ;({ data: trackData, exception: fetchError } =
        clipsResult ?? (await this._fetchFromGraphQL(contentId, pathSegment)))
    } else if (type === 'audio') {
      ;({ data: trackData, exception: fetchError } =
        await this._fetchFromAudioAPI(contentId))

      if (fetchError) {
        logger(
          'debug',
          'Sources',
          `Instagram audio API fallback triggered for ${contentId}: ${fetchError.message}`
        )
        ;({ data: trackData, exception: fetchError } =
          await this._fetchAudioOgMetadata(contentId))
      }
    } else {
      return {
        loadType: 'error',
        exception: {
          message: 'Unknown URL type',
          severity: 'fault',
          cause: 'URLParsing'
        }
      }
    }

    if (fetchError) {
      if (fetchError.message?.includes('Media not found')) {
        return { loadType: 'empty', data: {} }
      }
      return {
        loadType: 'error',
        exception: { ...fetchError, cause: 'APIRequest' }
      }
    }

    if (!trackData) {
      return {
        loadType: 'error',
        exception: {
          message: 'Could not retrieve track data.',
          severity: 'fault',
          cause: 'APIRequest'
        }
      }
    }

    const track = this.buildTrack(trackData, queryUrl, contentId)
    return { loadType: 'track', data: track }
  }

  /**
   * Builds an encoded Instagram track payload from raw track data.
   *
   * @param trackData - Raw track data from API or OG metadata.
   * @param queryUrl - Original Instagram URL.
   * @param contentId - Extracted content identifier.
   * @returns Complete encoded track payload.
   */
  public buildTrack(
    trackData: InstagramRawTrackData,
    queryUrl: string,
    contentId: string
  ): InstagramTrackData {
    const trackInfo: TrackInfo = {
      identifier: contentId,
      title: trackData.title || 'Instagram Content',
      author: trackData.author,
      length: trackData.length || -1,
      sourceName: 'instagram',
      artworkUrl: trackData.thumbnail || null,
      uri: queryUrl,
      isStream: trackData.isStream,
      isSeekable: !trackData.isStream,
      position: 0,
      isrc: null
    }

    return {
      encoded: encodeTrack({
        ...trackInfo,
        details: []
      } satisfies TrackEncodeInput),
      info: trackInfo,
      pluginInfo: {
        description: trackData.description || null
      }
    }
  }

  /**
   * Resolves the direct playable URL for an Instagram track.
   *
   * For post URLs, re-fetches from the GraphQL API. For audio URLs,
   * attempts mirror track resolution first, then falls back to
   * the authenticated audio API.
   *
   * @param track - Decoded Instagram track information.
   * @returns Direct media URL descriptor or an exception payload.
   */
  public async getTrackUrl(
    track: InstagramDecodedTrack
  ): Promise<TrackUrlResult | SourceResult> {
    const urlInfo = this._extractInfo(track.uri)
    if (urlInfo.error || !urlInfo.id) {
      return {
        exception: {
          message: urlInfo.error ?? 'Instagram URL not provided',
          severity: 'common',
          cause: 'URLParsing'
        }
      }
    }

    const contentId = urlInfo.id
    const { type, pathSegment } = urlInfo

    let trackData: InstagramRawTrackData | null = null
    let fetchError: InstagramFetchResult['exception'] = null

    if (type === 'post') {
      const clipsResult = await this._fetchFromClipsQuery(contentId)
      ;({ data: trackData, exception: fetchError } =
        clipsResult ?? (await this._fetchFromGraphQL(contentId, pathSegment)))
    } else if (type === 'audio') {
      ;({ data: trackData, exception: fetchError } =
        await this._fetchFromAudioAPI(contentId))

      if (!trackData) {
        let mirrorTrack: BestMatchTrackInfo = track
        let preferredQuery: string | null = null

        if (
          !track.title ||
          track.title === 'Instagram Audio' ||
          track.author === 'User Unknown'
        ) {
          const ogMetadata = await this._fetchAudioOgMetadata(contentId)
          if (!ogMetadata.exception && ogMetadata.data) {
            mirrorTrack = {
              title: ogMetadata.data.title || track.title,
              author: ogMetadata.data.author || track.author,
              length: track.length,
              uri: track.uri
            }
            preferredQuery =
              (
                ogMetadata.data as InstagramRawTrackData & {
                  searchQuery?: string
                }
              ).searchQuery || null
          }
        }

        const mirrorResult = await this._resolveAudioMirrorTrack(
          mirrorTrack,
          preferredQuery
        )
        if (!mirrorResult?.exception) {
          return mirrorResult as TrackUrlResult
        }

        logger(
          'warn',
          'Sources',
          `Instagram audio mirror failed for ${contentId}: ${mirrorResult.exception.message}.`
        )
        return {
          exception: {
            message: 'Audio API request failed',
            severity: 'common'
          }
        }
      }
    } else {
      return {
        exception: {
          message: 'Unknown URL type',
          severity: 'fault',
          cause: 'URLParsing'
        }
      }
    }

    if (fetchError || !trackData?.videoUrl) {
      const errorMessage =
        fetchError?.message || 'Could not retrieve video/audio stream URL.'
      return {
        exception: {
          message: errorMessage,
          severity: 'fault',
          cause: 'StreamLink'
        }
      }
    }

    return {
      url: trackData.videoUrl,
      protocol: trackData.videoUrl.startsWith('https:') ? 'https' : 'http',
      format: 'mp4'
    }
  }

  /**
   * Opens a media stream from a direct Instagram media URL.
   *
   * @param decodedTrack - Decoded track metadata being played.
   * @param url - Direct media URL returned by `getTrackUrl`.
   * @param _protocol - Unused protocol hint.
   * @param _additionalData - Unused additional data.
   * @returns Playable stream payload or an exception payload.
   */
  public async loadStream(
    decodedTrack: InstagramDecodedTrack,
    url: string,
    _protocol?: string,
    _additionalData?: Record<string, unknown>
  ): Promise<InstagramLoadStreamResult> {
    try {
      const response = await http1makeRequest(url, {
        method: 'GET',
        streamOnly: true,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Linux; Android 11; SAMSUNG SM-G973U) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/14.2 Chrome/87.0.4280.141 Mobile Safari/537.36',
          Referer: decodedTrack.uri || 'https://www.instagram.com/'
        },
        disableBodyCompression: true
      })

      if (response.error || !response.stream) {
        throw new Error(
          response.error || 'Failed to get stream, no stream object returned.'
        )
      }
      const stream = new PassThrough()
      response.stream.on('data', (chunk: Buffer) => {
        stream.write(chunk)
      })
      response.stream.on('end', () => {
        stream.end()
        stream.emit('finishBuffering')
      })
      response.stream.on('error', (err: Error) => {
        stream.destroy(err)
      })
      return { stream, type: 'video/mp4' }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        exception: {
          message,
          severity: 'fault',
          cause: 'StreamLoadFailed'
        }
      }
    }
  }

  /**
   * Searches Instagram by URL or numeric media ID.
   *
   * Text search is not supported; only direct URL and numeric ID
   * lookups are handled.
   *
   * @param query - Search query (Instagram URL or numeric media ID).
   * @param _type - Unused search type parameter.
   * @returns Track result, or error when no results are found.
   */
  public async search(query: string, _type?: string): Promise<SourceResult> {
    if (this.isLinkMatch(query)) {
      return this.resolve(query)
    }

    if (/^\d{15,}(_\d+)?$/.test(query)) {
      const shortcode = this._getShortcodeFromMediaId(query)
      if (shortcode) {
        const url = `https://www.instagram.com/p/${shortcode}/`
        return this.resolve(url)
      }
    }

    return {
      loadType: 'error',
      exception: {
        message: 'No results found for the query.',
        severity: 'common',
        cause: 'NoResults'
      }
    }
  }
}
