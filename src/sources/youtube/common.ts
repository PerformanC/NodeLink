/**
 * YouTube Source Common Utilities
 * Provides shared types, utilities, and helpers for YouTube data processing.
 *
 * @packageDocumentation
 * @module YouTubeSourceCommon
 */
import type {
  SourceResult,
  TrackData,
  TrackInfo,
  WorkerNodeLink
} from '../../typings/sources/source.types.ts'
import {
  type AudioFormat,
  type AudioTrack,
  type CaptionTrack,
  type ExternalLinks,
  type ICachedPlayerScript,
  type ICipherManager,
  type IOAuth,
  type MakeRequestFn,
  type PublishedAtInfo,
  type VideoQuality,
  YOUTUBE_CONSTANTS,
  type YOUTUBE_CONSTANTS_TYPE,
  type YouTubeChannelInfo,
  type YouTubeClientContext,
  type YouTubeContext,
  type YouTubePlayerResponse,
  type YouTubeRenderer,
  type YouTubeText,
  type YouTubeTextRun,
  type YouTubeThumbnail
} from '../../typings/sources/youtube.types.ts'
import type {
  HttpProxyConfig,
  HttpRequestResult,
  TrackEncodeInput
} from '../../typings/utils.types.ts'
import { encodeTrack, logger, makeRequest } from '../../utils.ts'

export {
  type AudioFormat,
  type AudioTrack,
  type CaptionTrack,
  type ExternalLinks,
  type ICachedPlayerScript,
  type ICipherManager,
  type IOAuth,
  type MakeRequestFn,
  type PublishedAtInfo,
  type VideoQuality,
  YOUTUBE_CONSTANTS,
  type YOUTUBE_CONSTANTS_TYPE,
  type YouTubeChannelInfo,
  type YouTubeClientContext,
  type YouTubeContext,
  type YouTubePlayerResponse,
  type YouTubeRenderer,
  type YouTubeText,
  type YouTubeTextRun,
  type YouTubeThumbnail
}

/**
 * Fallback strings used when metadata cannot be retrieved from YouTube.
 * These ensure track objects always have meaningful title/author values.
 *
 * @internal
 */
const FALLBACK_TITLE = 'Unknown Title'
const FALLBACK_AUTHOR = 'Unknown Artist'

/**
 * Regular expressions for parsing YouTube URLs and extracting IDs.
 * Each pattern handles a specific URL format used by YouTube.
 *
 * @internal
 */
const URL_PATTERNS = {
  /** Standard YouTube watch URL (www.youtube.com/watch?v=xxx) */
  video: /^https?:\/\/(?:music\.)?(?:www\.)?youtube\.com\/watch\?v=[\w-]+/,

  /** YouTube Music watch URL (music.youtube.com/watch?v=xxx) */
  musicVideo: /^https?:\/\/music\.youtube\.com\/watch\?v=[\w-]+/,

  /** YouTube playlist URL (www.youtube.com/playlist?list=xxx) */
  playlist:
    /^https?:\/\/(?:music\.)?(?:www\.)?youtube\.com\/playlist\?list=[\w-]+/,

  /** Short YouTube link (youtu.be/xxx) */
  shortUrl: /^https?:\/\/youtu\.be\/[\w-]+/,

  /** YouTube Shorts URL (www.youtube.com/shorts/xxx) */
  shorts: /^https?:\/\/(?:www\.)?youtube\.com\/shorts\/[\w-]+/,

  /** Playlist parameter check (matches any URL with list= param) */
  listParam: /[?&]list=/,

  /** Extracts video ID from various YouTube URL formats */
  videoId: /(?:v=|shorts\/|youtu\.be\/)([^&?]+)/,

  /** Extracts playlist ID from YouTube URL */
  playlistId: /[?&]list=([\w-]+)/,

  /** Extracts video ID from v= parameter specifically */
  videoIdParam: /[?&]v=([\w-]+)/
}

/**
 * Multipliers for converting time units to milliseconds.
 * Used for parsing YouTube's relative time strings (e.g., "2 years ago").
 *
 * @internal
 */
const TIME_UNIT_MULTIPLIERS = {
  year: 365.25 * 24 * 60 * 60 * 1000,
  month: 30.44 * 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  hour: 60 * 60 * 1000,
  minute: 60 * 1000,
  second: 1000
}

/**
 * Regex for parsing human-readable time strings.
 * Matches patterns like "2 years ago", "3 months ago", "1 week ago", etc.
 *
 * @internal
 */
const TIME_UNIT_REGEX = /(\d+)\s*(year|month|week|day|hour|minute|second)/gi
export function formatDuration(ms: number | undefined): {
  ms: number
  formatted: string
  hms: string
} {
  if (!ms || ms === 0) return { ms: 0, formatted: '🔴 LIVE', hms: '🔴 LIVE' }
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const s = seconds % 60
  const m = minutes % 60
  const formatted =
    hours > 0
      ? `${hours}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`
  const hms = `${hours}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`
  return { ms, formatted, hms }
}

/**
 * Formats a large number into a compact string (e.g. 1.5M).
 * @param num - Number to format
 * @returns Formatted string
 * @public
 */
export function formatNumber(num: number): string {
  if (!num || Number.isNaN(num)) return '0'
  if (num >= 1000000000) return `${(num / 1000000000).toFixed(1)}B`
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`
  return String(num)
}

/**
 * Safely converts a value to a string with a fallback.
 * @internal
 */
function safeString(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback
  return String(value)
}

/**
 * Builds a human readable relative time string from units.
 * @internal
 */
function _buildReadableTime(units: PublishedAtInfo['ago']): string {
  if (units.years > 0)
    return `${units.years} year${units.years > 1 ? 's' : ''} ago`
  if (units.months > 0)
    return `${units.months} month${units.months > 1 ? 's' : ''} ago`
  if (units.weeks > 0)
    return `${units.weeks} week${units.weeks > 1 ? 's' : ''} ago`
  if (units.days > 0) return `${units.days} day${units.days > 1 ? 's' : ''} ago`
  if (units.hours > 0)
    return `${units.hours} hour${units.hours > 1 ? 's' : ''} ago`
  if (units.minutes > 0)
    return `${units.minutes} minute${units.minutes > 1 ? 's' : ''} ago`
  if (units.seconds > 0)
    return `${units.seconds} second${units.seconds > 1 ? 's' : ''} ago`
  return 'just now'
}

/**
 * Builds PublishedAtInfo from a timestamp.
 * @internal
 */
function _buildPublishedAtFromTimestamp(
  timestamp: number,
  originalText: string
): PublishedAtInfo {
  const diff = Date.now() - timestamp
  const diffAbs = Math.abs(diff)
  const resultUnits = {
    years: 0,
    months: 0,
    weeks: 0,
    days: 0,
    hours: 0,
    minutes: 0,
    seconds: 0
  }

  if (diffAbs >= TIME_UNIT_MULTIPLIERS.year) {
    resultUnits.years = Math.floor(diffAbs / TIME_UNIT_MULTIPLIERS.year)
  } else if (diffAbs >= TIME_UNIT_MULTIPLIERS.month) {
    resultUnits.months = Math.floor(diffAbs / TIME_UNIT_MULTIPLIERS.month)
  } else if (diffAbs >= TIME_UNIT_MULTIPLIERS.week) {
    resultUnits.weeks = Math.floor(diffAbs / TIME_UNIT_MULTIPLIERS.week)
  } else if (diffAbs >= TIME_UNIT_MULTIPLIERS.day) {
    resultUnits.days = Math.floor(diffAbs / TIME_UNIT_MULTIPLIERS.day)
  } else if (diffAbs >= TIME_UNIT_MULTIPLIERS.hour) {
    resultUnits.hours = Math.floor(diffAbs / TIME_UNIT_MULTIPLIERS.hour)
  } else if (diffAbs >= TIME_UNIT_MULTIPLIERS.minute) {
    resultUnits.minutes = Math.floor(diffAbs / TIME_UNIT_MULTIPLIERS.minute)
  } else {
    resultUnits.seconds = Math.floor(diffAbs / TIME_UNIT_MULTIPLIERS.second)
  }

  return {
    original: originalText,
    timestamp: Math.floor(timestamp),
    date: new Date(timestamp).toISOString(),
    readable: _buildReadableTime(resultUnits),
    compact: `${resultUnits.years}y ${resultUnits.months}mo ${resultUnits.weeks}w ${resultUnits.days}d ${resultUnits.hours}h ${resultUnits.minutes}m ${resultUnits.seconds}s`,
    ago: resultUnits
  }
}

/**
 * Parses a YouTube publication date string into structured info.
 * @param publishedText - Text like "2 years ago" or a date string
 * @returns Structured publication info or null
 * @public
 */
export function parsePublishedAt(
  publishedText: string | undefined | null
): PublishedAtInfo | null {
  if (!publishedText) return null

  const date = new Date(publishedText)

  if (!Number.isNaN(date.getTime())) {
    return _buildPublishedAtFromTimestamp(date.getTime(), publishedText)
  }

  const text = publishedText.toLowerCase()
  const units = {
    years: 0,
    months: 0,
    weeks: 0,
    days: 0,
    hours: 0,
    minutes: 0,
    seconds: 0
  }

  const regex = new RegExp(TIME_UNIT_REGEX.source, TIME_UNIT_REGEX.flags)

  for (const match of text.matchAll(regex)) {
    const valueStr = match[1]
    const unitStr = match[2]
    if (!valueStr || !unitStr) continue

    const value = parseInt(valueStr, 10)
    const unit = unitStr.toLowerCase()

    if (unit.startsWith('year')) units.years = value
    else if (unit.startsWith('month')) units.months = value
    else if (unit.startsWith('week')) units.weeks = value
    else if (unit.startsWith('day')) units.days = value
    else if (unit.startsWith('hour')) units.hours = value
    else if (unit.startsWith('minute')) units.minutes = value
    else if (unit.startsWith('second')) units.seconds = value
  }

  const msAgo =
    units.years * TIME_UNIT_MULTIPLIERS.year +
    units.months * TIME_UNIT_MULTIPLIERS.month +
    units.weeks * TIME_UNIT_MULTIPLIERS.week +
    units.days * TIME_UNIT_MULTIPLIERS.day +
    units.hours * TIME_UNIT_MULTIPLIERS.hour +
    units.minutes * TIME_UNIT_MULTIPLIERS.minute +
    units.seconds * TIME_UNIT_MULTIPLIERS.second

  const timestamp = Date.now() - msAgo

  return {
    original: publishedText,
    timestamp: Math.floor(timestamp),
    date: new Date(timestamp).toISOString(),
    readable: _buildReadableTime(units),
    compact: `${units.years}y ${units.months}mo ${units.weeks}w ${units.days}d ${units.hours}h ${units.minutes}m ${units.seconds}s`,
    ago: units
  }
}

/**
 * Gets a value from an object using multiple possible dot-notation paths.
 * @internal
 */
function getItemValue<T = unknown>(
  obj: unknown,
  paths: string[],
  defaultValue: T | null = null
): T | null {
  if (!obj || typeof obj !== 'object') return defaultValue
  for (const path of paths) {
    const value = path
      .split('.')
      .reduce<unknown>(
        (o, k) => (o as Record<string, unknown> | null)?.[k],
        obj
      )
    if (value !== undefined && value !== null) return value as T
  }
  return defaultValue
}

/**
 * Concatenates text from a YouTube runs array.
 * @internal
 */
function getRunsText(runsArray: YouTubeTextRun[] | undefined): string | null {
  if (Array.isArray(runsArray) && runsArray.length > 0) {
    return runsArray.map((run) => run.text || '').join('')
  }
  return null
}

/**
 * Extracts basic title/author metadata from a YouTube player response.
 * @internal
 */
function extractMetadataFromResponse(
  fullApiResponse: Record<string, unknown>
): {
  title: string | null
  author: string | null
} {
  const metadata: { title: string | null; author: string | null } = {
    title: null,
    author: null
  }

  const vd = fullApiResponse.videoDetails as Record<string, unknown> | undefined
  if (vd) {
    if (typeof vd.title === 'string' && vd.title !== 'undefined')
      metadata.title = vd.title
    if (typeof vd.author === 'string' && vd.author !== 'undefined')
      metadata.author = vd.author
  }
  if (metadata.title && metadata.author) return metadata

  const microRoot = fullApiResponse.microformat as
    | Record<string, unknown>
    | undefined
  const mf = microRoot?.playerMicroformatRenderer as
    | Record<string, unknown>
    | undefined
  if (mf) {
    const titleObj = mf.title as YouTubeText | string | undefined
    const title =
      typeof titleObj === 'string'
        ? titleObj
        : getRunsText(titleObj?.runs) || titleObj?.simpleText
    if (title && !metadata.title) metadata.title = title
    if (typeof mf.ownerChannelName === 'string' && !metadata.author)
      metadata.author = mf.ownerChannelName
  }

  return metadata
}

/**
 * Fetches metadata for a video via oEmbed.
 * @internal
 */
async function fetchOEmbedMetadata(
  videoId: string,
  makeRequestFn: MakeRequestFn
): Promise<{
  title: string | null
  author: string | null
  thumbnail_url: string | null
} | null> {
  try {
    const { body, statusCode } = await makeRequestFn(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      {
        method: 'GET',
        maxRedirects: 5
      }
    )

    if (statusCode === 200 && body && typeof body === 'object') {
      const b = body as Record<string, unknown>
      return {
        title: (b.title as string | undefined) || null,
        author: (b.author_name as string | undefined) || null,
        thumbnail_url: (b.thumbnail_url as string | undefined) || null
      }
    }
  } catch (e: unknown) {
    logger(
      'debug',
      'fetchOEmbedMetadata',
      `Failed to fetch oEmbed data: ${e instanceof Error ? e.message : String(e)}`
    )
  }
  return null
}

/**
 * Extracts the video title from various possible locations in a YouTube response.
 * Checks multiple sources in priority order: fullApiResponse, renderer title, and fallback locations.
 *
 * @param renderer - YouTube item renderer with title data
 * @param fullApiResponse - Full API response for metadata lookup
 * @param _videoId - Video ID (unused, reserved for future use)
 * @param _makeRequestFn - Optional makeRequest function (unused, reserved for future use)
 * @returns The extracted title string, or `null` if not found
 *
 * @example
 * ```typescript
 * const title = extractTitle(renderer, response, videoId);
 * // Returns: "Never Gonna Give You Up" or null
 * ```
 *
 * @internal
 */
function extractTitle(
  renderer: YouTubeRenderer | undefined,
  fullApiResponse: Record<string, unknown> | null,
  _videoId: string,
  _makeRequestFn: MakeRequestFn | null = null
): string | null {
  if (fullApiResponse) {
    const metadata = extractMetadataFromResponse(fullApiResponse)
    if (metadata.title) {
      return metadata.title
    }
  }

  if (typeof renderer?.title === 'string' && renderer.title !== 'undefined') {
    return renderer.title
  }

  const title =
    getRunsText((renderer?.title as YouTubeText | undefined)?.runs) ||
    getItemValue<string>(fullApiResponse, [
      'videoDetails.endscreen.endscreenRenderer.elements.1.endscreenElementRenderer.title.simpleText'
    ]) ||
    getItemValue<string>(renderer, ['title.simpleText'])

  if (title && title !== 'undefined') {
    return title
  }

  return null
}

/**
 * Extracts the video author/channel name from various possible locations in a YouTube response.
 * Checks multiple sources in priority order: fullApiResponse, direct author field, and textual runs.
 *
 * @param renderer - YouTube item renderer with author data
 * @param fullApiResponse - Full API response for metadata lookup
 * @param _videoId - Video ID (unused, reserved for future use)
 * @param _makeRequestFn - Optional makeRequest function (unused, reserved for future use)
 * @returns The extracted author string, or `null` if not found
 *
 * @example
 * ```typescript
 * const author = extractAuthor(renderer, response, videoId);
 * // Returns: "RickAstley" or null
 * ```
 *
 * @internal
 */
function extractAuthor(
  renderer: YouTubeRenderer | undefined,
  fullApiResponse: Record<string, unknown> | null,
  _videoId: string,
  _makeRequestFn: MakeRequestFn | null = null
): string | null {
  if (fullApiResponse) {
    const metadata = extractMetadataFromResponse(fullApiResponse)
    if (metadata.author) {
      return metadata.author
    }
  }

  if (renderer?.author && renderer.author !== 'undefined') {
    return renderer.author
  }

  const author =
    getRunsText(
      getItemValue<YouTubeTextRun[]>(renderer, [
        'longBylineText.runs',
        'shortBylineText.runs',
        'ownerText.runs'
      ]) ?? undefined
    ) || getItemValue<string>(fullApiResponse, ['videoDetails.author'])

  if (author && author !== 'undefined') {
    return author
  }

  return null
}

/**
 * Extracts the best thumbnail URL from a renderer or video ID.
 * @internal
 */
function extractThumbnail(
  renderer: YouTubeRenderer | undefined,
  videoId: string | null
): string | null {
  let resultUrl: string | null = null

  const musicThumbnails = renderer?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails
  const regularThumbnails = renderer?.thumbnail?.thumbnails

  if (Array.isArray(musicThumbnails) && musicThumbnails.length > 0) {
    const firstThumb = musicThumbnails[0]
    if (firstThumb?.url) {
      resultUrl = firstThumb.url.replace(/=.*/, '=w1000-h1000')
    }
  } else if (Array.isArray(regularThumbnails) && regularThumbnails.length > 0) {
    const lastThumb = regularThumbnails[regularThumbnails.length - 1]
    const url = lastThumb?.url
    if (url?.includes('maxresdefault')) {
      resultUrl = url
    }
  }

  if (!resultUrl && videoId) {
    resultUrl = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`
  }

  return resultUrl
}

/**
 * Fetches detailed channel information from YouTube.
 * @param channelId - YouTube channel ID
 * @param makeRequestFn - HTTP request utility
 * @param context - YouTube API context
 * @returns Detailed channel info or null
 * @public
 */
export async function fetchChannelInfo(
  channelId: string | undefined,
  makeRequestFn: MakeRequestFn,
  context: YouTubeContext | undefined
): Promise<YouTubeChannelInfo | null> {
  if (!channelId) return null

  try {
    const { body: channelResponseRaw, statusCode } = await makeRequestFn(
      'https://www.youtube.com/youtubei/v1/browse',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: {
          context: {
            client: {
              clientName: 'WEB',
              clientVersion: '2.20251030.01.00',
              platform: 'DESKTOP',
              userAgent:
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
              hl: context?.client?.hl || 'en',
              gl: context?.client?.gl || 'US'
            }
          },
          browseId: channelId
        },
        disableBodyCompression: true
      }
    )

    if (
      statusCode !== 200 ||
      !channelResponseRaw ||
      typeof channelResponseRaw !== 'object'
    ) {
      logger(
        'warn',
        'fetchChannelInfo',
        `Bad status code or empty response: ${statusCode}`
      )
      return null
    }

    const channelResponse = channelResponseRaw as Record<string, unknown>

    const headerRoot = channelResponse.header as
      | Record<string, unknown>
      | undefined
    const pageHeader = headerRoot?.pageHeaderRenderer as
      | Record<string, unknown>
      | undefined
    const pageHeaderContent = pageHeader?.content as
      | Record<string, unknown>
      | undefined
    const header = pageHeaderContent?.pageHeaderViewModel as
      | Record<string, unknown>
      | undefined

    if (!header) {
      logger('warn', 'fetchChannelInfo', 'No pageHeaderViewModel found')
      return null
    }

    const channelInfo: YouTubeChannelInfo = {
      icon: null,
      banner: null,
      subscribers: null,
      verified: false,
      description: null,
      links: []
    }

    const imageRoot = header.image as Record<string, unknown> | undefined
    const decoratedAvatar = imageRoot?.decoratedAvatarViewModel as
      | Record<string, unknown>
      | undefined
    const avatar = decoratedAvatar?.avatar as
      | Record<string, unknown>
      | undefined
    const avatarViewModel = avatar?.avatarViewModel as
      | Record<string, unknown>
      | undefined
    const avatarImage = avatarViewModel?.image as
      | Record<string, unknown>
      | undefined
    const avatarSources = avatarImage?.sources as YouTubeThumbnail[] | undefined

    channelInfo.icon =
      Array.isArray(avatarSources) && avatarSources.length > 0
        ? avatarSources[avatarSources.length - 1]?.url?.split('=')[0] || null
        : null

    const bannerRoot = header.banner as Record<string, unknown> | undefined
    const bannerViewModel = bannerRoot?.imageBannerViewModel as
      | Record<string, unknown>
      | undefined
    const bannerImage = bannerViewModel?.image as
      | Record<string, unknown>
      | undefined
    const bannerSources = bannerImage?.sources as YouTubeThumbnail[] | undefined

    channelInfo.banner =
      Array.isArray(bannerSources) && bannerSources.length > 0
        ? bannerSources[bannerSources.length - 1]?.url?.split('=')[0] || null
        : null

    const titleRoot = header.title as Record<string, unknown> | undefined
    const dynamicText = titleRoot?.dynamicTextViewModel as
      | Record<string, unknown>
      | undefined
    const rendererCtx = dynamicText?.rendererContext as
      | Record<string, unknown>
      | undefined
    const accessibilityCtx = rendererCtx?.accessibilityContext as
      | Record<string, unknown>
      | undefined
    const accessibilityLabel = accessibilityCtx?.label as string | undefined

    channelInfo.verified = !!accessibilityLabel?.includes('Verified')

    const metadataRoot = header.metadata as Record<string, unknown> | undefined
    const contentMetadata = metadataRoot?.contentMetadataViewModel as
      | Record<string, unknown>
      | undefined
    const metadataRows = contentMetadata?.metadataRows as unknown[] | undefined

    if (Array.isArray(metadataRows)) {
      for (const rowRaw of metadataRows) {
        const row = rowRaw as Record<string, unknown>
        const parts = row.metadataParts as unknown[] | undefined
        if (Array.isArray(parts)) {
          for (const partRaw of parts) {
            const part = partRaw as Record<string, unknown>
            const partTextObj = part.text as
              | Record<string, unknown>
              | string
              | undefined
            const text = (
              typeof partTextObj === 'object'
                ? (partTextObj?.content as string | undefined)
                : partTextObj
            ) as string | undefined

            if (typeof text === 'string') {
              const lowerText = text.toLowerCase()

              if (lowerText.includes('subscriber')) {
                const numStrMatch = lowerText.match(/([\d.,]+)\s*([kmb])?/i)

                if (numStrMatch) {
                  const matchedVal = numStrMatch[1]
                  if (matchedVal) {
                    let count = parseFloat(matchedVal.replace(/,/g, ''))

                    const multiplier = numStrMatch[2]?.toLowerCase()

                    if (multiplier === 'k') count *= 1000
                    else if (multiplier === 'm') count *= 1000000
                    else if (multiplier === 'b') count *= 1000000000

                    channelInfo.subscribers = {
                      original: text,

                      count: Math.floor(count),

                      formatted: formatNumber(Math.floor(count))
                    }
                  }
                } else {
                  channelInfo.subscribers = {
                    original: text,

                    count: null,

                    formatted: text
                  }
                }
              } else if (lowerText.includes('video')) {
                const match = lowerText.match(/(\d+(?:,\d+)*)\s*video/i)

                if (match) {
                  const matchedVal = match[1]
                  if (matchedVal) {
                    const count = parseInt(matchedVal.replace(/,/g, ''), 10)

                    channelInfo.videoCount = {
                      original: text,

                      count,

                      formatted: formatNumber(count)
                    }
                  }
                } else {
                  channelInfo.videoCount = {
                    original: text,

                    count: null,

                    formatted: text
                  }
                }
              }
            }
          }
        }
      }
    }

    const descRoot = header.description as Record<string, unknown> | undefined
    const descPreview = descRoot?.descriptionPreviewViewModel as
      | Record<string, unknown>
      | undefined
    const descContent = descPreview?.description as
      | Record<string, unknown>
      | undefined
    channelInfo.description =
      (descContent?.content as string | undefined) || null

    const attributionRoot = header.attribution as
      | Record<string, unknown>
      | undefined
    const attribution = attributionRoot?.attributionViewModel as
      | Record<string, unknown>
      | undefined
    const attributionText = attribution?.text as
      | Record<string, unknown>
      | undefined
    const mainLink = attributionText?.content as string | undefined

    if (mainLink && !mainLink.includes('and') && !mainLink.includes('more')) {
      channelInfo.links.push(mainLink)
    }

    const resultsRoot = channelResponse.contents as
      | Record<string, unknown>
      | undefined
    const singleColumn = resultsRoot?.singleColumnBrowseResultsRenderer as
      | Record<string, unknown>
      | undefined
    const tabs = singleColumn?.tabs as unknown[] | undefined

    if (Array.isArray(tabs)) {
      for (const tabRaw of tabs) {
        const tab = tabRaw as Record<string, unknown>
        const tabRenderer = tab.tabRenderer as
          | Record<string, unknown>
          | undefined
        const tabContent = tabRenderer?.content as
          | Record<string, unknown>
          | undefined
        const sectionList = tabContent?.sectionListRenderer as
          | Record<string, unknown>
          | undefined
        const contents = sectionList?.contents as unknown[] | undefined

        if (Array.isArray(contents)) {
          for (const sectionRaw of contents) {
            const section = sectionRaw as Record<string, unknown>
            const itemSection = section.itemSectionRenderer as
              | Record<string, unknown>
              | undefined
            const items = itemSection?.contents as YouTubeRenderer[] | undefined

            if (Array.isArray(items)) {
              for (const item of items) {
                const channelVideoPlayer = item.channelVideoPlayerRenderer

                if (channelVideoPlayer?.videoId) {
                  channelInfo.featuredVideo = {
                    id: channelVideoPlayer.videoId,

                    url: `https://www.youtube.com/watch?v=${channelVideoPlayer.videoId}`,

                    title:
                      (channelVideoPlayer.title?.runs?.[0]?.text as
                        | string
                        | undefined) || null,

                    description:
                      (channelVideoPlayer.description?.runs?.[0]?.text as
                        | string
                        | undefined) || null
                  }

                  break
                }
              }
            }

            if (channelInfo.featuredVideo) break
          }
        }

        if (channelInfo.featuredVideo) break
      }
    }

    return channelInfo
  } catch (e: unknown) {
    logger(
      'error',
      'fetchChannelInfo',
      `Failed to fetch channel info: ${e instanceof Error ? e.message : String(e)}`
    )
    if (e instanceof Error) logger('error', 'fetchChannelInfo', e.stack ?? '')
    return null
  }
}

/**
 * Resolves short URLs in external links to their final destinations.
 * @internal
 */
async function resolveExternalLinks(
  externalLinks: ExternalLinks,
  makeRequestFn: MakeRequestFn
): Promise<ExternalLinks | null> {
  if (!externalLinks) return null

  const resolved = { ...externalLinks }

  if (
    resolved.spotify &&
    (resolved.spotify.includes('smarturl.it') ||
      resolved.spotify.includes('ffm.to'))
  ) {
    try {
      const response = await makeRequestFn(resolved.spotify, {
        method: 'GET',
        maxRedirects: 5
      })

      const finalUrl = response.finalUrl
      if (finalUrl?.includes('spotify.com')) {
        resolved.spotify = finalUrl

        const match = finalUrl.match(
          /spotify\.com\/(album|track|artist|playlist)\/([a-zA-Z0-9]+)/
        )
        if (match) {
          resolved.spotifyId = {
            type: match[1] as string,
            id: match[2] as string
          }
        }
      }
    } catch (_e) {}
  }

  if (
    resolved.appleMusic &&
    (resolved.appleMusic.includes('smarturl.it') ||
      resolved.appleMusic.includes('apple'))
  ) {
    try {
      const response = await makeRequestFn(resolved.appleMusic, {
        method: 'GET',
        maxRedirects: 5
      })
      const finalUrl = response.finalUrl
      if (finalUrl?.includes('music.apple.com')) {
        resolved.appleMusic = finalUrl
      }
    } catch (_e) {}
  }

  return resolved
}

/**
 * Extracts links to other platforms from a video description.
 * @param description - Video description text
 * @returns Object with categorized links or null
 * @public
 */
export function extractExternalLinks(
  description: string | undefined | null
): ExternalLinks | null {
  if (!description) return null

  const links: ExternalLinks = {
    spotify: null,
    appleMusic: null,
    soundcloud: null,
    bandcamp: null,
    deezer: null,
    tidal: null,
    amazonMusic: null,
    youtubeMusic: null,
    website: null,
    other: []
  }

  const urlRegex = /(https?:\/\/[^\s]+)/gi
  const matches = description.match(urlRegex) || []

  const linkMatchers: Array<{ key: keyof ExternalLinks; patterns: string[] }> =
    [
      { key: 'spotify', patterns: ['spotify.com', 'open.spotify.com'] },
      {
        key: 'appleMusic',
        patterns: ['apple.com', 'itunes.apple.com', 'music.apple.com']
      },
      { key: 'soundcloud', patterns: ['soundcloud.com'] },
      { key: 'bandcamp', patterns: ['bandcamp.com'] },
      { key: 'deezer', patterns: ['deezer.com'] },
      { key: 'tidal', patterns: ['tidal.com'] },
      { key: 'amazonMusic', patterns: ['amazon.com/music', 'music.amazon'] },
      { key: 'youtubeMusic', patterns: ['music.youtube.com'] }
    ]

  for (let url of matches) {
    url = url.replace(/[,;)]$/, '')

    let matched = false
    for (const matcher of linkMatchers) {
      if (matcher.patterns.some((pattern) => url.includes(pattern))) {
        ;(links as Record<string, unknown>)[matcher.key] = url
        matched = true
        break
      }
    }

    if (!matched && !url.includes('youtube.com') && !url.includes('youtu.be')) {
      if (
        !links.website &&
        (url.includes('.com') ||
          url.includes('.net') ||
          url.includes('.org') ||
          url.includes('.io'))
      ) {
        links.website = url
      } else {
        links.other?.push(url)
      }
    }
  }

  if (links.other?.length === 0) delete links.other

  const hasLinks = Object.values(links).some(
    (v) => v !== null && (!Array.isArray(v) || v.length > 0)
  )
  return hasLinks ? links : null
}

/**
 * Extracts available video qualities from streaming data.
 * @internal
 */
function extractVideoQualities(
  streamingData: Record<string, unknown>
): VideoQuality[] {
  if (!streamingData) return []

  const allFormats = [
    ...((streamingData.formats as unknown[] | undefined) || []),
    ...((streamingData.adaptiveFormats as unknown[] | undefined) || [])
  ]

  const qualityMap = new Map<string, VideoQuality>()

  for (const formatRaw of allFormats) {
    const format = formatRaw as Record<string, unknown>
    if (
      format.qualityLabel &&
      format.bitrate &&
      (format.mimeType as string | undefined)?.startsWith('video/')
    ) {
      const quality = format.qualityLabel as string

      const existingQuality = qualityMap.get(quality)
      if (
        !qualityMap.has(quality) ||
        (format.bitrate as number) > (existingQuality?.bitrate ?? 0)
      ) {
        const mimeType = format.mimeType as string
        const codecMatch = mimeType.match(/codecs="([^"]+)"/)
        const codec =
          (codecMatch?.[1] as string | undefined)?.split('.')[0] || 'unknown'

        qualityMap.set(quality, {
          quality,
          bitrate: format.bitrate as number,
          fps: (format.fps as number | undefined) ?? null,
          mimeType: (format.mimeType as string | undefined) ?? null,
          width: (format.width as number | undefined) ?? null,
          height: (format.height as number | undefined) ?? null,
          codec,
          itag: format.itag as number,
          container:
            (format.mimeType as string | undefined)
              ?.split(';')[0]
              ?.split('/')[1] ?? null,
          averageBitrate: (format.averageBitrate as number | undefined) ?? null,
          contentLength:
            (format.contentLength as string | number | undefined) ?? null
        })
      }
    }
  }

  return Array.from(qualityMap.values()).sort((a, b) => {
    const resA = Number.parseInt(a.quality, 10) || 0
    const resB = Number.parseInt(b.quality, 10) || 0
    return resA - resB
  })
}

/**
 * Extracts available audio formats from streaming data.
 * @internal
 */
function extractAudioFormats(
  streamingData: Record<string, unknown>
): AudioFormat[] {
  if (!streamingData) return []

  const allFormats = [
    ...((streamingData.formats as unknown[] | undefined) || []),
    ...((streamingData.adaptiveFormats as unknown[] | undefined) || [])
  ]

  const qualityMap = new Map<string, AudioFormat>()

  for (const formatRaw of allFormats) {
    const format = formatRaw as Record<string, unknown>
    if (
      (format.mimeType as string | undefined)?.startsWith('audio/') &&
      format.bitrate
    ) {
      const audioQuality =
        (format.audioQuality as string | undefined) || 'UNKNOWN'

      const existingAudioQuality = qualityMap.get(audioQuality)
      if (
        !qualityMap.has(audioQuality) ||
        (format.bitrate as number) > (existingAudioQuality?.bitrate ?? 0)
      ) {
        const mimeType = format.mimeType as string
        const codecMatch = mimeType.match(/codecs="([^"]+)"/)
        const codec = (codecMatch?.[1] as string | undefined) || 'unknown'

        qualityMap.set(audioQuality, {
          itag: format.itag as number,
          mimeType: format.mimeType as string,
          bitrate: format.bitrate as number,
          averageBitrate: (format.averageBitrate as number | undefined) ?? null,
          audioQuality: (format.audioQuality as string | undefined) ?? null,
          audioSampleRate:
            (format.audioSampleRate as string | undefined) ?? null,
          audioChannels: (format.audioChannels as number | undefined) ?? null,
          codec,
          container:
            (format.mimeType as string | undefined)
              ?.split(';')[0]
              ?.split('/')[1] ?? null,
          contentLength:
            (format.contentLength as string | number | undefined) ?? null,
          loudnessDb: (format.loudnessDb as number | undefined) ?? null
        })
      }
    }
  }

  return Array.from(qualityMap.values()).sort((a, b) => b.bitrate - a.bitrate)
}

/**
 * Extracts available audio tracks from streaming data.
 * @internal
 */
function extractAudioTracks(
  streamingData: Record<string, unknown>
): AudioTrack[] {
  if (!streamingData) return []

  const allFormats = [
    ...((streamingData.formats as unknown[] | undefined) || []),
    ...((streamingData.adaptiveFormats as unknown[] | undefined) || [])
  ]

  const tracksMap = new Map<string, AudioTrack>()

  for (const formatRaw of allFormats) {
    const format = formatRaw as Record<string, unknown>
    const audioTrack = format.audioTrack as Record<string, unknown> | undefined
    if (audioTrack) {
      const id = audioTrack.id as string
      if (!tracksMap.has(id)) {
        tracksMap.set(id, {
          id: audioTrack.id as string,
          name: audioTrack.displayName as string,
          isDefault: !!audioTrack.audioIsDefault,
          isAutoDubbed: !!audioTrack.isAutoDubbed
        })
      }
    }
  }

  return Array.from(tracksMap.values())
}

/**
 * Extracts caption tracks from YouTube captions data.
 * @internal
 */
function extractCaptions(
  captionsData: Record<string, unknown>
): CaptionTrack[] {
  const captionsRoot = captionsData?.playerCaptionsTracklistRenderer as
    | Record<string, unknown>
    | undefined
  const captionTracks = captionsRoot?.captionTracks as unknown[] | undefined
  if (!captionTracks) return []

  return captionTracks.map((cRaw: unknown) => {
    const c = cRaw as Record<string, unknown>
    return {
      languageCode: c.languageCode as string,
      name: (c.name as YouTubeText | undefined)?.simpleText,
      isTranslatable: !!c.isTranslatable,
      baseUrl: c.baseUrl as string,
      kind: c.kind as string | undefined
    }
  })
}

/**
 * Parses track duration and stream status from text/seconds.
 * @internal
 */
function parseLengthAndStream(
  lengthText: string | undefined | null,
  lengthSeconds: string | number | undefined | null,
  isLive: boolean | undefined | null
): { lengthMs: number; isStream: boolean } {
  if (isLive) {
    return { lengthMs: -1, isStream: true }
  }

  let lengthMs = 0
  let isStream = true

  if (lengthText && /[:\d]+/.test(lengthText)) {
    const parts = lengthText.split(':').map(Number)
    lengthMs = (parts.reduce((acc, val) => acc * 60 + val, 0) || 0) * 1000
    isStream = !Number.isFinite(lengthMs) || lengthMs <= 0
  } else if (lengthSeconds) {
    lengthMs = Number.parseInt(String(lengthSeconds), 10) * 1000
    isStream = false
  }
  return { lengthMs, isStream }
}

/**
 * Identifies the type of renderer from YouTube item data.
 * @internal
 */
function getRendererFromItemData(
  itemData: YouTubeRenderer | null,
  itemType: string
): YouTubeRenderer | null {
  if (!itemData) return null

  if (itemType === 'ytmusic') {
    const data = getItemValue<YouTubeRenderer>(itemData, [
      'musicResponsiveListItemRenderer',
      'playlistPanelVideoRenderer',
      'musicTwoColumnItemRenderer'
    ])
    if (data) return { ...data, _type: 'track' }
  }

  const rendererTypes = [
    { key: 'videoRenderer', type: 'track' },
    { key: 'compactVideoRenderer', type: 'track' },
    { key: 'playlistRenderer', type: 'playlist' },
    { key: 'compactPlaylistRenderer', type: 'playlist' },
    { key: 'channelRenderer', type: 'channel' },
    { key: 'playlistPanelVideoRenderer', type: 'track' },
    { key: 'playlistVideoRenderer', type: 'track' },
    { key: 'gridVideoRenderer', type: 'track' }
  ]

  for (const r of rendererTypes) {
    const renderer = itemData[r.key] as YouTubeRenderer | undefined
    if (renderer) {
      return { ...renderer, _type: r.type }
    }
  }

  if (itemData.elementRenderer) {
    const model = getItemValue<Record<string, unknown>>(
      itemData.elementRenderer,
      ['newElement.type.componentType.model']
    )
    const data =
      ((model?.compactChannelModel as Record<string, unknown> | undefined)
        ?.compactChannelData as YouTubeRenderer | undefined) ||
      ((model?.compactPlaylistModel as Record<string, unknown> | undefined)
        ?.compactPlaylistData as YouTubeRenderer | undefined)

    if (data) {
      return {
        ...data,
        _type: model?.compactChannelModel ? 'channel' : 'playlist'
      }
    }
  }

  return itemData.videoId ? { ...itemData, _type: 'track' } : null
}

/**
 * Configuration for track building.
 */
export interface TrackBuildOptions {
  resolveExternalLinks?: boolean
  fetchChannelInfo?: boolean
  maxAlbumPlaylistLength?: number
  enableHoloTracks?: boolean
  search: {
    maxResults?: number
    resolveExternalLinks?: boolean
    fetchChannelInfo?: boolean
  }
}

/**
 * Extended TrackData for YouTube source.
 */
export interface YouTubeTrackData extends TrackData {
  info: Required<NonNullable<TrackData['info']>>
  userData?: unknown
}

/**
 * Builds a standard track object from YouTube API item data.
 * @param itemData - Raw YouTube API item data
 * @param itemType - Item source type ('youtube' or 'ytmusic')
 * @param sourceNameOverride - Optional source name override
 * @param fullApiResponse - Full API response for extra metadata
 * @param enableHolo - Whether to build an extended "holo" track
 * @param config - Build configuration
 * @param makeRequestFn - Optional makeRequest override
 * @returns Built track data or null
 * @public
 */
export async function buildTrack(
  itemData: YouTubeRenderer | null,
  itemType: string,
  sourceNameOverride: string | null = null,
  fullApiResponse: Record<string, unknown> | null = null,
  enableHolo = false,
  config: TrackBuildOptions = { search: {} },
  makeRequestFn: MakeRequestFn | null = null
): Promise<YouTubeTrackData | null> {
  if (!itemData) {
    logger('warn', 'buildTrack', 'itemData is null or undefined')
    return null
  }

  const renderer = getRendererFromItemData(itemData, itemType)

  if (renderer?._type === 'channel') {
    const ch = renderer.channelRenderer || renderer
    const channelId =
      ch.channelId ||
      getItemValue<string>(ch, [
        'onTap.innertubeCommand.browseEndpoint.browseId'
      ]) ||
      getItemValue<string>(ch, [
        'endpoint.innertubeCommand.browseEndpoint.browseId'
      ])
    const title =
      (ch.attributedTitle as { content: string } | undefined)?.content ||
      (typeof ch.title === 'string'
        ? ch.title
        : getRunsText((ch.title as YouTubeText | undefined)?.runs) ||
          (ch.title as YouTubeText | undefined)?.simpleText) ||
      getRunsText((ch.displayName as YouTubeText | undefined)?.runs) ||
      FALLBACK_TITLE

    if (!channelId) return null

    const trackInfo: Required<NonNullable<TrackData['info']>> = {
      identifier: channelId,
      isSeekable: false,
      author: title,
      length: 0,
      isStream: false,
      position: 0,
      title,
      uri: `https://www.youtube.com/channel/${channelId}`,
      artworkUrl: extractThumbnail(ch, null) || null,
      isrc: null,
      sourceName: sourceNameOverride || 'youtube'
    }

    return {
      encoded: encodeTrack({ ...trackInfo, details: [] } as TrackEncodeInput),
      info: trackInfo,
      pluginInfo: {
        type: 'channel_result',
        videoCount: String(
          getRunsText((ch.videoCountText as YouTubeText | undefined)?.runs) ||
            (ch.videoCount as string | number | undefined) ||
            '0'
        ),
        subscriberCount: String(
          getRunsText(
            (ch.subscriberCountText as YouTubeText | undefined)?.runs
          ) ||
            (ch.subscriberCount as string | number | undefined) ||
            '0'
        ),
        handle: String(ch.handle ?? '')
      }
    }
  }

  if (renderer?._type === 'playlist') {
    const pl = renderer
    const playlistId = pl.playlistId
    const title =
      (pl.attributedTitle as { content: string } | undefined)?.content ||
      (typeof pl.title === 'string'
        ? pl.title
        : getRunsText((pl.title as YouTubeText | undefined)?.runs) ||
          (pl.title as YouTubeText | undefined)?.simpleText) ||
      FALLBACK_TITLE
    const author =
      (typeof pl.authorName === 'string'
        ? pl.authorName
        : getRunsText((pl.longBylineText as YouTubeText | undefined)?.runs) ||
          getRunsText((pl.shortBylineText as YouTubeText | undefined)?.runs)) ||
      FALLBACK_AUTHOR
    const videoCount =
      getRunsText((pl.videoCountText as YouTubeText | undefined)?.runs) ||
      (pl.videoCount as string | number | undefined) ||
      '0'

    if (!playlistId) return null

    const trackInfo: Required<NonNullable<TrackData['info']>> = {
      identifier: playlistId,
      isSeekable: false,
      author,
      length: 0,
      isStream: false,
      position: 0,
      title,
      uri: `https://www.youtube.com/playlist?list=${playlistId}`,
      artworkUrl: extractThumbnail(pl, null) || null,
      isrc: null,
      sourceName: sourceNameOverride || 'youtube'
    }

    return {
      encoded: encodeTrack({ ...trackInfo, details: [] } as TrackEncodeInput),
      info: trackInfo,
      pluginInfo: {
        type: 'playlist_result',
        videoCount: String(videoCount)
      }
    }
  }

  const videoId =
    getItemValue<string>(renderer, [
      'playlistItemData.videoId',
      'navigationEndpoint.watchEndpoint.videoId',
      'videoId'
    ]) ||
    itemData.videoId ||
    renderer?.videoId

  if (!videoId) {
    logger('warn', 'buildTrack', 'Could not extract videoId from item data')
    return null
  }

  let title = FALLBACK_TITLE
  let author = FALLBACK_AUTHOR
  let lengthMs = 0
  let isStream = true
  let artworkUrl: string | null = null
  let uri = ''
  const requestFn = makeRequestFn || makeRequest

  if (itemType === 'ytmusic') {
    title = safeString(
      getRunsText(
        getItemValue<YouTubeTextRun[]>(renderer, ['title.runs']) ?? undefined
      ) ||
        getItemValue<string>(renderer, ['title.simpleText']) ||
        renderer?.title,
      FALLBACK_TITLE
    )

    if (title === FALLBACK_TITLE && Array.isArray(renderer?.flexColumns)) {
      const firstCol = renderer?.flexColumns?.[0]
      title = safeString(
        getRunsText(
          firstCol?.musicResponsiveListItemFlexColumnRenderer?.text?.runs
        ),
        FALLBACK_TITLE
      )
    }

    const subtitleRuns = getItemValue<YouTubeTextRun[]>(renderer, [
      'subtitle.runs'
    ])
    const longBylineRuns = getItemValue<YouTubeTextRun[]>(renderer, [
      'longBylineText.runs'
    ])
    const shortBylineRuns = getItemValue<YouTubeTextRun[]>(renderer, [
      'shortBylineText.runs'
    ])

    if (Array.isArray(subtitleRuns) && subtitleRuns.length > 0) {
      author = safeString(subtitleRuns[0]?.text, FALLBACK_AUTHOR)
    } else if (Array.isArray(longBylineRuns) && longBylineRuns.length > 0) {
      author = safeString(longBylineRuns[0]?.text, FALLBACK_AUTHOR)
    } else if (Array.isArray(shortBylineRuns) && shortBylineRuns.length > 0) {
      author = safeString(shortBylineRuns[0]?.text, FALLBACK_AUTHOR)
    } else {
      author = safeString(renderer?.author, FALLBACK_AUTHOR)
    }

    if (author === FALLBACK_AUTHOR && Array.isArray(renderer?.flexColumns)) {
      const secondCol = renderer?.flexColumns?.[1]
      author = safeString(
        secondCol?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]
          ?.text,
        FALLBACK_AUTHOR
      )
    }

    let lengthText: string | null = null
    if (Array.isArray(subtitleRuns)) {
      const lengthRun = subtitleRuns.find(
        (run) => run.text && /^\d{1,2}:\d{2}(:\d{2})?$/.test(run.text)
      )
      lengthText = lengthRun?.text || null
    }

    if (!lengthText) {
      lengthText =
        getItemValue<string>(renderer, ['lengthText.simpleText']) ||
        getRunsText(
          getItemValue<YouTubeTextRun[]>(renderer, ['lengthText.runs']) ??
            undefined
        )
    }

    if (!lengthText && Array.isArray(renderer?.flexColumns)) {
      for (const column of renderer?.flexColumns || []) {
        const textObj = column.musicResponsiveListItemFlexColumnRenderer?.text
        if (Array.isArray(textObj?.runs)) {
          const found = textObj.runs.find(
            (run) => run.text && /^\d{1,2}:\d{2}(:\d{2})?$/.test(run.text)
          )
          if (found) {
            lengthText = found.text
            break
          }
        }
      }
    }

    const parsed = parseLengthAndStream(
      lengthText,
      itemData.lengthSeconds as string | number | undefined,
      itemData.isLive as boolean | undefined
    )
    lengthMs = parsed.lengthMs
    isStream = parsed.isStream

    artworkUrl = extractThumbnail(renderer || undefined, videoId)
    uri = `https://music.youtube.com/watch?v=${videoId}`
  } else {
    const extractedTitle = extractTitle(
      renderer || undefined,
      fullApiResponse,
      videoId,
      requestFn
    )
    const extractedAuthor = extractAuthor(
      renderer || undefined,
      fullApiResponse,
      videoId,
      requestFn
    )

    let oEmbedData: Awaited<ReturnType<typeof fetchOEmbedMetadata>> | null =
      null
    const shouldFetchOEmbed =
      !!fullApiResponse && (extractedTitle === null || extractedAuthor === null)

    if (shouldFetchOEmbed) {
      try {
        oEmbedData = await fetchOEmbedMetadata(videoId, requestFn)
        if (oEmbedData) {
          logger(
            'debug',
            'buildTrack',
            `Got metadata from oEmbed: title="${safeString(oEmbedData.title, FALLBACK_TITLE)}", author="${safeString(oEmbedData.author, FALLBACK_AUTHOR)}"`
          )
        }
      } catch (e: unknown) {
        logger(
          'warn',
          'buildTrack',
          `Failed to fetch oEmbed metadata: ${e instanceof Error ? e.message : String(e)}`
        )
      }
    }

    title = safeString(oEmbedData?.title ?? extractedTitle, FALLBACK_TITLE)
    author = safeString(oEmbedData?.author ?? extractedAuthor, FALLBACK_AUTHOR)

    if (oEmbedData?.thumbnail_url && !artworkUrl) {
      artworkUrl = oEmbedData.thumbnail_url
      if (artworkUrl.includes('hqdefault.jpg')) {
        artworkUrl = artworkUrl.replace('hqdefault.jpg', 'mqdefault.jpg')
      }
    }

    const lengthText =
      getItemValue<string>(renderer, ['lengthText.simpleText']) ||
      getRunsText((renderer?.lengthText as YouTubeText | undefined)?.runs)

    const parsed = parseLengthAndStream(
      lengthText,
      renderer?.lengthSeconds as string | number | undefined,
      renderer?.isLive as boolean | undefined
    )
    lengthMs = parsed.lengthMs
    isStream = parsed.isStream

    artworkUrl = artworkUrl || extractThumbnail(renderer || undefined, videoId)
    uri = `https://www.youtube.com/watch?v=${videoId}`
  }

  let sourceName = sourceNameOverride
  if (!sourceName) {
    if (uri.includes('music.youtube.com')) {
      sourceName = 'ytmusic'
    } else {
      sourceName = 'youtube'
    }
  }

  const trackInfo: Required<NonNullable<TrackData['info']>> = {
    identifier: videoId,
    isSeekable: !isStream,
    author,
    length: lengthMs,
    isStream,
    position: 0,
    title,
    uri,
    artworkUrl: artworkUrl || null,
    isrc: null,
    sourceName
  }

  trackInfo.title = safeString(trackInfo.title, FALLBACK_TITLE)
  trackInfo.author = safeString(trackInfo.author, FALLBACK_AUTHOR)
  trackInfo.identifier = safeString(trackInfo.identifier, '')
  trackInfo.uri = safeString(trackInfo.uri, '')
  trackInfo.sourceName = safeString(trackInfo.sourceName, 'youtube')

  if (!trackInfo.identifier) {
    logger('warn', 'buildTrack', 'Track identifier is empty after processing')
    return null
  }

  const streamingData = fullApiResponse?.streamingData as
    | Record<string, unknown>
    | undefined
  const audioFormats = streamingData ? extractAudioFormats(streamingData) : []

  const audioTracks = streamingData ? extractAudioTracks(streamingData) : []

  const basicTrack: YouTubeTrackData = {
    encoded: encodeTrack({ ...trackInfo, details: [] } as TrackEncodeInput),
    info: trackInfo,
    pluginInfo: {
      captions: JSON.stringify(
        extractCaptions(
          (fullApiResponse?.captions as Record<string, unknown>) ?? {}
        )
      ),
      audioFormats: JSON.stringify(audioFormats),
      audioTracks: JSON.stringify(audioTracks)
    }
  }

  if (enableHolo) {
    return await buildHoloTrack(
      trackInfo,
      itemData,
      itemType,
      fullApiResponse,
      config,
      requestFn
    )
  }

  return basicTrack
}

/**
 * Builds an extended "holo" track object with rich metadata.
 * @param trackInfo - Basic track information
 * @param itemData - Raw YouTube API item data
 * @param itemType - Item source type ('youtube' or 'ytmusic')
 * @param fullApiResponse - Full API response for extra metadata
 * @param config - Build configuration
 * @param makeRequestFn - HTTP request utility
 * @returns Built holo track data
 * @public
 */
export async function buildHoloTrack(
  trackInfo: Required<NonNullable<TrackData['info']>>,
  itemData: YouTubeRenderer | null,
  itemType: string,
  fullApiResponse: Record<string, unknown> | null = null,
  config: TrackBuildOptions = { search: {} },
  makeRequestFn: MakeRequestFn | null = null
): Promise<YouTubeTrackData> {
  const duration = formatDuration(trackInfo.length)
  const sourceName = trackInfo.sourceName
  const sourceUrl =
    sourceName === 'ytmusic'
      ? 'https://music.youtube.com'
      : 'https://www.youtube.com'

  const renderer = getRendererFromItemData(itemData, itemType)

  const channelData: Record<string, unknown> = {
    name: trackInfo.author,
    id: null,
    url: null,
    icon: null,
    banner: null,
    subscribers: null,
    verified: false,
    description: null,
    videoCount: null,
    featuredVideo: null,
    links: []
  }

  let thumbnails: Record<string, string | null> = {}
  let viewCount: number | null = null
  let _badges: string[] = []
  let accessibilityLabel: string | undefined =
    `${trackInfo.title} by ${trackInfo.author}`
  let publishedAt: PublishedAtInfo | null = null
  let keywords: string[] = []
  let description: string | null = null
  let isLive = false
  let category: string | null = null
  let likeCount: number | null = null

  const videoDetails = fullApiResponse?.videoDetails as
    | Record<string, unknown>
    | undefined
  if (videoDetails) {
    viewCount = videoDetails.viewCount
      ? Number.parseInt(videoDetails.viewCount as string, 10)
      : null
    keywords = (videoDetails.keywords as string[]) || []
    description = (videoDetails.shortDescription as string) || null
    isLive = (videoDetails.isLiveContent as boolean) || false

    accessibilityLabel = `${trackInfo.title} by ${(videoDetails.author as string | undefined) || trackInfo.author}`

    channelData.name =
      (videoDetails.author as string | undefined) || trackInfo.author
    channelData.id = (videoDetails.channelId as string) || null
    channelData.url = videoDetails.channelId
      ? `https://www.youtube.com/channel/${videoDetails.channelId}`
      : null

    const vdThumbRoot = videoDetails.thumbnail as
      | Record<string, unknown>
      | undefined
    const vdThumbnails = vdThumbRoot?.thumbnails as
      | YouTubeThumbnail[]
      | undefined
    if (vdThumbnails) {
      thumbnails = {
        default: vdThumbnails[0]?.url?.split('?')[0] || null,
        medium:
          vdThumbnails[1]?.url?.split('?')[0] ||
          vdThumbnails[0]?.url?.split('?')[0] ||
          null,
        high: vdThumbnails[vdThumbnails.length - 1]?.url?.split('?')[0] || null
      }
    }
    const rawPublishedAt = videoDetails.publishDate as string | undefined
    if (rawPublishedAt) {
      publishedAt = parsePublishedAt(rawPublishedAt)
    }
  }

  const microRoot = fullApiResponse?.microformat as
    | Record<string, unknown>
    | undefined
  const micro = microRoot?.playerMicroformatRenderer as
    | Record<string, unknown>
    | undefined
  if (micro) {
    publishedAt =
      publishedAt ||
      (micro.publishDate
        ? parsePublishedAt(micro.publishDate as string)
        : null) ||
      (micro.uploadDate ? parsePublishedAt(micro.uploadDate as string) : null)
    category = category || (micro.category as string) || null
    likeCount =
      likeCount ||
      (micro.likeCount ? Number.parseInt(micro.likeCount as string, 10) : null)
  }

  if (renderer) {
    const thumbArray =
      renderer.thumbnail?.thumbnails ||
      renderer.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
      []
    thumbnails = {
      default: thumbArray[0]?.url?.split('?')[0] || null,
      medium:
        thumbArray[1]?.url?.split('?')[0] ||
        thumbArray[0]?.url?.split('?')[0] ||
        null,
      high: thumbArray[thumbArray.length - 1]?.url?.split('?')[0] || null
    }

    const viewCountText =
      getRunsText(
        getItemValue<YouTubeTextRun[]>(renderer, [
          'viewCountText.runs',
          'shortViewCountText.runs'
        ]) ?? undefined
      ) ||
      getItemValue<string>(renderer, [
        'viewCountText.simpleText',
        'shortViewCountText.simpleText'
      ])
    if (viewCountText && !viewCount) {
      const match = viewCountText.match(/[\d,]+/)
      if (match) viewCount = Number.parseInt(match[0].replace(/,/g, ''), 10)
    }

    const rendererPublishedAt =
      getRunsText(
        getItemValue<YouTubeTextRun[]>(renderer, ['publishedTimeText.runs']) ??
          undefined
      ) || getItemValue<string>(renderer, ['publishedTimeText.simpleText'])

    if (rendererPublishedAt && !publishedAt) {
      publishedAt = parsePublishedAt(rendererPublishedAt)
    }

    const rendererAccessibility = getItemValue<string>(renderer, [
      'accessibility.accessibilityData.label',
      'title.accessibility.accessibilityData.label'
    ])

    accessibilityLabel =
      accessibilityLabel || rendererAccessibility || undefined

    const ownerBadges = (renderer.ownerBadges as unknown[] | undefined) || []
    _badges = ownerBadges
      .map((b) =>
        getItemValue<string>(b, [
          'metadataBadgeRenderer.tooltip',
          'metadataBadgeRenderer.label'
        ])
      )
      .filter((b): b is string => !!b)

    if (!channelData.id) {
      const channelName =
        getRunsText(
          getItemValue<YouTubeTextRun[]>(renderer, [
            'longBylineText.runs',
            'shortBylineText.runs',
            'ownerText.runs'
          ]) ?? undefined
        ) || trackInfo.author
      const channelUrl = getItemValue<string>(renderer, [
        'longBylineText.runs.0.navigationEndpoint.browseEndpoint.canonicalBaseUrl',
        'shortBylineText.runs.0.navigationEndpoint.browseEndpoint.canonicalBaseUrl',
        'ownerText.runs.0.navigationEndpoint.browseEndpoint.canonicalBaseUrl'
      ])
      const channelIdFromRenderer = getItemValue<string>(renderer, [
        'longBylineText.runs.0.navigationEndpoint.browseEndpoint.browseId',
        'shortBylineText.runs.0.navigationEndpoint.browseEndpoint.browseId',
        'ownerText.runs.0.navigationEndpoint.browseEndpoint.browseId'
      ])

      channelData.name = channelName
      channelData.id = channelIdFromRenderer || null
      channelData.url = channelUrl
        ? `https://www.youtube.com${channelUrl}`
        : null
    }
  }

  accessibilityLabel =
    accessibilityLabel ||
    `${trackInfo.title} by ${(channelData.name as string | undefined) || trackInfo.author}`

  if (config.search.fetchChannelInfo && channelData.id && makeRequestFn) {
    try {
      const channelInfo = await fetchChannelInfo(
        channelData.id as string,
        makeRequestFn,
        fullApiResponse?.responseContext as YouTubeContext | undefined
      )
      if (channelInfo) {
        channelData.icon = channelInfo.icon
        channelData.banner = channelInfo.banner
        channelData.subscribers = channelInfo.subscribers
        channelData.verified = channelInfo.verified
        channelData.description = channelInfo.description
        channelData.videoCount = channelInfo.videoCount
        channelData.featuredVideo = channelInfo.featuredVideo || null
        if (channelInfo.links && channelInfo.links.length > 0) {
          channelData.links = channelInfo.links
        }
      }
    } catch (e: unknown) {
      logger(
        'warn',
        'buildHoloTrack',
        `Failed to fetch channel info: ${e instanceof Error ? e.message : String(e)}`
      )
    }
  }

  thumbnails.default = thumbnails.default || trackInfo.artworkUrl || null
  thumbnails.medium = thumbnails.medium || trackInfo.artworkUrl || null
  thumbnails.high = thumbnails.high || trackInfo.artworkUrl || null

  let externalLinks = extractExternalLinks(description)

  if (config.search.resolveExternalLinks && externalLinks && makeRequestFn) {
    try {
      externalLinks = await resolveExternalLinks(externalLinks, makeRequestFn)
    } catch (e: unknown) {
      logger(
        'warn',
        'buildHoloTrack',
        `Failed to resolve external links: ${e instanceof Error ? e.message : String(e)}`
      )
    }
  }

  const streamingData = fullApiResponse?.streamingData as
    | Record<string, unknown>
    | undefined
  const videoQualities = streamingData
    ? extractVideoQualities(streamingData)
    : []

  const audioFormats = streamingData ? extractAudioFormats(streamingData) : []

  const audioTracks = streamingData ? extractAudioTracks(streamingData) : []

  const captions = extractCaptions(
    (fullApiResponse?.captions as Record<string, unknown>) ?? {}
  )

  const pluginInfo: Record<string, string | number | boolean> = {
    type: 'holo',
    accessibility: accessibilityLabel ?? '',
    description: description || '',
    isSeekable: trackInfo.isSeekable,
    isLive,
    isExplicit: false,
    duration: duration.formatted,
    sourceName: sourceName,
    sourceUrl: sourceUrl,
    internalId: trackInfo.identifier,
    isrc: trackInfo.isrc || '',
    views: viewCount || 0,
    likes: likeCount || 0,
    category: category || '',
    publishedAt: publishedAt?.date || '',
    thumbnailDefault: thumbnails.default || '',
    thumbnailMedium: thumbnails.medium || '',
    thumbnailHigh: thumbnails.high || '',
    channelName: (channelData.name as string | undefined) || '',
    channelId: (channelData.id as string | undefined) || '',
    channelUrl: (channelData.url as string | undefined) || '',
    channelVerified: !!channelData.verified
  }

  const result: YouTubeTrackData = {
    encoded: encodeTrack({ ...trackInfo, details: [] } as TrackEncodeInput),
    info: trackInfo,
    pluginInfo: {
      ...pluginInfo,
      keywords: JSON.stringify(keywords),
      externalLinks: JSON.stringify(externalLinks),
      videoQualities: JSON.stringify(videoQualities),
      audioFormats: JSON.stringify(audioFormats),
      audioTracks: JSON.stringify(audioTracks),
      captions: JSON.stringify(captions),
      channel: JSON.stringify(channelData)
    }
  }

  return result
}

/**
 * Checks the type of a YouTube URL.
 * @param url - URL to check
 * @param type - Source type ('youtube' or 'ytmusic')
 * @returns YOUTUBE_CONSTANTS identifier
 * @public
 */
export function checkURLType(
  url: string,
  type: string
): YOUTUBE_CONSTANTS_TYPE {
  const isMusicSource = type === 'ytmusic'

  if (URL_PATTERNS.listParam.test(url)) {
    return YOUTUBE_CONSTANTS.PLAYLIST
  }

  if (isMusicSource) {
    if (URL_PATTERNS.musicVideo.test(url)) {
      return YOUTUBE_CONSTANTS.VIDEO
    }
  } else {
    if (URL_PATTERNS.video.test(url)) {
      return YOUTUBE_CONSTANTS.VIDEO
    }
    if (URL_PATTERNS.shorts.test(url)) {
      return YOUTUBE_CONSTANTS.SHORTS
    }
    if (URL_PATTERNS.shortUrl.test(url)) {
      return YOUTUBE_CONSTANTS.VIDEO
    }
  }

  return YOUTUBE_CONSTANTS.UNKNOWN
}

/**
 * Fetches encryptedHostFlags for a video by inspecting the embed page.
 * @param videoId - YouTube video ID
 * @returns encryptedHostFlags string or null
 * @public
 */
export async function fetchEncryptedHostFlags(
  videoId: string
): Promise<string | null> {
  try {
    const embedUrl = `https://www.youtube.com/embed/${videoId}`

    const { body, statusCode, error }: HttpRequestResult = await makeRequest(
      embedUrl,
      {
        method: 'GET',
        headers: {
          Referer: 'https://www.google.com',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      }
    )

    if (error || statusCode !== 200 || !body || typeof body !== 'string') {
      logger(
        'warn',
        'fetchEncryptedHostFlags',
        `Failed to fetch embed page: ${statusCode} - ${error ?? 'Unknown error'}`
      )
      return null
    }
    const match = body.match(/"encryptedHostFlags":"([^"]+)"/)

    if (match?.[1]) {
      logger(
        'debug',
        'fetchEncryptedHostFlags',
        `Successfully extracted encryptedHostFlags for ${videoId}`
      )
      return match[1]
    }

    logger(
      'debug',
      'fetchEncryptedHostFlags',
      'encryptedHostFlags not found in embed page'
    )
    return null
  } catch (e: unknown) {
    logger(
      'error',
      'fetchEncryptedHostFlags',
      `Error fetching encryptedHostFlags: ${e instanceof Error ? e.message : String(e)}`
    )
    return null
  }
}

/**
 * Base class for YouTube clients.
 * Handles common request logic and response processing.
 * @public
 */
export abstract class BaseClient {
  nodelink: WorkerNodeLink
  config: WorkerNodeLink['options']
  name: string
  oauth: IOAuth | null

  /**
   * @param nodelink - NodeLink worker instance
   * @param name - Client name (e.g. 'ANDROID', 'WEB')
   * @param oauth - OAuth manager instance
   */
  constructor(nodelink: WorkerNodeLink, name: string, oauth: IOAuth | null) {
    this.nodelink = nodelink
    this.config = nodelink.options
    this.name = name
    this.oauth = oauth
  }

  /**
   * Returns a proxy configuration if available.
   * @param _rotate - Whether to rotate the proxy
   */
  getProxy(_rotate = false): HttpProxyConfig | undefined {
    return undefined
  }

  /**
   * Returns the client-specific context for innertube requests.
   * @param context - General YouTube context
   */
  abstract getClient(context: YouTubeContext): YouTubeClientContext

  /**
   * Whether this client requires a player script for signature deciphering.
   */
  requirePlayerScript(): boolean {
    return false
  }

  /**
   * Returns the base API endpoint for this client.
   */
  getApiEndpoint(): string {
    return 'https://youtubei.googleapis.com'
  }

  /**
   * Returns additional player parameters for this client.
   */
  getPlayerParams(): string | null {
    return null
  }

  /**
   * Whether this client is an embedded player.
   */
  isEmbedded(): boolean {
    return false
  }

  /**
   * Retrieves OAuth authorization headers.
   */
  async getAuthHeaders(): Promise<Record<string, string>> {
    return this.oauth?.getAuthHeaders() ?? {}
  }

  /**
   * Searches for tracks using this client.
   * @param _query - Search query
   * @param _type - Search type
   * @param _context - YouTube context
   */
  async search(
    _query: string,
    _type: string,
    _context: YouTubeContext
  ): Promise<SourceResult> {
    return { loadType: 'search', data: [] }
  }

  /**
   * Performs an innertube player request.
   * @internal
   */
  async _makePlayerRequest(
    videoId: string,
    context: YouTubeContext,
    headers: Record<string, string>,
    cipherManager: ICipherManager | null,
    proxy?: HttpProxyConfig
  ): Promise<HttpRequestResult> {
    const apiEndpoint = this.getApiEndpoint()
    const requestBody: Record<string, unknown> = {
      context: this.getClient(context),
      videoId: videoId,
      contentCheckOk: true,
      attestationRequest: { omitBotguardData: true },
      racyCheckOk: true
    }

    const playerParams = this.getPlayerParams()
    if (playerParams) {
      requestBody.params = playerParams
    }

    if (this.isEmbedded()) {
      const encryptedHostFlags = await fetchEncryptedHostFlags(videoId)
      if (encryptedHostFlags) {
        const playbackContext =
          (requestBody.playbackContext as
            | Record<string, unknown>
            | undefined) || {}
        playbackContext.contentPlaybackContext =
          (playbackContext.contentPlaybackContext as
            | Record<string, unknown>
            | undefined) || {}
        ;(
          playbackContext.contentPlaybackContext as Record<string, unknown>
        ).encryptedHostFlags = encryptedHostFlags
        requestBody.playbackContext = playbackContext
      }
      if (context.client.clientName === 'WEB_EMBEDDED_PLAYER') {
        requestBody.serializedThirdPartyEmbedConfig = {
          hideInfoBar: true,
          disableRelatedVideos: true
        }
      }
    }

    if (this.requirePlayerScript() && cipherManager) {
      try {
        const playerScript = await cipherManager.getCachedPlayerScript()
        if (playerScript?.url) {
          const signatureTimestamp = await cipherManager.getTimestamp(
            playerScript.url
          )
          const playbackContext =
            (requestBody.playbackContext as
              | Record<string, unknown>
              | undefined) || {}
          playbackContext.contentPlaybackContext =
            (playbackContext.contentPlaybackContext as
              | Record<string, unknown>
              | undefined) || {}
          ;(
            playbackContext.contentPlaybackContext as Record<string, unknown>
          ).signatureTimestamp = signatureTimestamp
          requestBody.playbackContext = playbackContext
        }
      } catch (e: unknown) {
        logger(
          'warn',
          `youtube-${this.name}`,
          `Failed to get signature timestamp: ${e instanceof Error ? e.message : String(e)}`
        )
      }
    }

    const clientCtx = this.getClient(context)
    const response: HttpRequestResult = await makeRequest(
      `${apiEndpoint}/youtubei/v1/player?prettyPrint=false`,
      {
        method: 'POST',
        headers: {
          'User-Agent': clientCtx.client.userAgent,
          ...(clientCtx.client.visitorData
            ? {
                'X-Goog-Visitor-Id': clientCtx.client.visitorData
              }
            : {}),
          ...(this.isEmbedded() ? { Referer: 'https://www.youtube.com' } : {}),
          ...headers
        },
        body: requestBody,
        disableBodyCompression: true,
        proxy: proxy || this.getProxy()
      }
    )

    if (response.statusCode !== 200) {
      const message = `Failed to get player data. Status: ${response.statusCode}`
      logger('error', `youtube-${this.name}`, message)
      return { ...response, error: message }
    }

    return response
  }

  /**
   * Performs an innertube next request (for playlists/recommendations).
   * TVHTML5 now requires this to fetch title and author after fetching the /player endpoint. Tho, oEmbed is preferred.
   * @internal
   */
  async _makeNextRequest(
    videoId: string,
    context: YouTubeContext,
    headers: Record<string, string>,
    proxy?: HttpProxyConfig
  ): Promise<HttpRequestResult> {
    const apiEndpoint = this.getApiEndpoint()
    const requestBody = {
      context: this.getClient(context),
      videoId: videoId
    }

    const clientCtx = this.getClient(context)
    const response: HttpRequestResult = await makeRequest(
      `${apiEndpoint}/youtubei/v1/next?prettyPrint=false`,
      {
        method: 'POST',
        headers: {
          'User-Agent': clientCtx.client.userAgent,
          ...(clientCtx.client.visitorData
            ? {
                'X-Goog-Visitor-Id': clientCtx.client.visitorData
              }
            : {}),
          ...headers
        },
        body: requestBody,
        disableBodyCompression: true,
        proxy: proxy || this.getProxy()
      }
    )

    return response
  }

  /**
   * Handles an innertube player response and converts it to SourceResult.
   * @internal
   */
  async _handlePlayerResponse(
    playerResponseRaw: unknown,
    sourceName: string,
    videoId: string,
    _context?: YouTubeContext
  ): Promise<SourceResult> {
    if (!playerResponseRaw || typeof playerResponseRaw !== 'object') {
      logger(
        'error',
        `youtube-${this.name}`,
        `Null or invalid player response for ${videoId}`
      )
      return { loadType: 'empty', data: {} }
    }

    const playerResponse = playerResponseRaw as YouTubePlayerResponse

    if (playerResponse.error) {
      logger(
        'error',
        `youtube-${this.name}`,
        `API error for video/short ${videoId}: ${playerResponse.error.message}`
      )
      return {
        loadType: 'error',
        exception: {
          message: playerResponse.error.message,
          severity: 'fault',
          cause: 'Upstream'
        }
      }
    }

    const videoDetails = playerResponse.videoDetails
    const playabilityStatus = playerResponse.playabilityStatus?.status

    if (
      playabilityStatus &&
      playabilityStatus !== 'OK' &&
      playerResponse.microformat?.microformatDataRenderer.appName !==
        'YouTube Music'
    ) {
      const message =
        playerResponse.playabilityStatus?.reason || 'Video not playable.'
      logger(
        'warn',
        `youtube-${this.name}`,
        `Video/short ${videoId} not playable: ${message}`
      )
      return {
        loadType: 'error',
        exception: {
          message,
          severity: 'common',
          cause: 'UpstreamPlayability'
        }
      }
    }

    if (!videoDetails?.videoId) {
      logger(
        'error',
        `youtube-${this.name}`,
        `Missing videoDetails for ${videoId}`
      )
      return {
        loadType: 'error',
        exception: {
          message: 'No video details in response.',
          severity: 'fault',
          cause: 'NoVideoDetails'
        }
      }
    }

    const track = await buildTrack(
      videoDetails as YouTubeRenderer,
      sourceName,
      null,
      playerResponse as Record<string, unknown>,
      !!this.config.experimental.enableHoloTracks,
      {
        resolveExternalLinks: !!this.config.search.resolveExternalLinks,
        fetchChannelInfo: !!this.config.search.fetchChannelInfo,
        search: {}
      }
    )

    if (!track) {
      logger(
        'error',
        `youtube-${this.name}`,
        `Failed to build track for ${videoId}`
      )
      return {
        loadType: 'error',
        exception: {
          message: 'Failed to process video data.',
          severity: 'fault',
          cause: 'TrackBuildFailed'
        }
      }
    }

    return { loadType: 'track', data: track }
  }

  /**
   * Handles an innertube next response for playlists.
   * @internal
   */
  async _handlePlaylistResponse(
    playlistId: string,
    currentVideoId: string | null,
    playlistResponseRaw: unknown,
    sourceName: string,
    _context?: YouTubeContext
  ): Promise<SourceResult> {
    if (!playlistResponseRaw || typeof playlistResponseRaw !== 'object') {
      return { loadType: 'empty', data: {} }
    }

    const playlistResponse = playlistResponseRaw as Record<string, unknown>

    if (playlistResponse.error) {
      const error = playlistResponse.error as Record<string, unknown>
      const errMsg =
        (error.message as string | undefined) || 'Failed to fetch playlist.'
      logger(
        'error',
        `youtube-${this.name}`,
        `Error loading playlist ${playlistId}: ${errMsg}`
      )
      return {
        loadType: 'error',
        exception: { message: errMsg, severity: 'common', cause: 'Upstream' }
      }
    }

    const contentsRoot =
      ((playlistResponse.contents as Record<string, unknown> | undefined)
        ?.singleColumnWatchNextResults as
        | Record<string, unknown>
        | undefined) ||
      ((playlistResponse.contents as Record<string, unknown> | undefined)
        ?.singleColumnMusicWatchNextResultsRenderer as
        | Record<string, unknown>
        | undefined)

    let playlistContent: unknown[] | null = null

    const playlist = contentsRoot?.playlist as
      | Record<string, unknown>
      | undefined
    const plData = playlist?.playlist as Record<string, unknown> | undefined
    if (plData?.contents) {
      playlistContent = plData.contents as unknown[]
    } else {
      const tabbedRenderer = contentsRoot?.tabbedRenderer as
        | Record<string, unknown>
        | undefined
      const watchNext = tabbedRenderer?.watchNextTabbedResultsRenderer as
        | Record<string, unknown>
        | undefined
      const tabs = watchNext?.tabs as Record<string, unknown>[] | undefined
      const tabRenderer = tabs?.[0]?.tabRenderer as
        | Record<string, unknown>
        | undefined
      const musicQueue = tabRenderer?.content as
        | Record<string, unknown>
        | undefined
      const mqRenderer = musicQueue?.musicQueueRenderer as
        | Record<string, unknown>
        | undefined

      if (mqRenderer) {
        const plPanel = mqRenderer.content as
          | Record<string, unknown>
          | undefined
        const panelRenderer = plPanel?.playlistPanelRenderer as
          | Record<string, unknown>
          | undefined
        playlistContent =
          (panelRenderer?.contents as unknown[] | undefined) ||
          (mqRenderer.contents as unknown[] | undefined) ||
          null
      }
    }

    if (!playlistContent || playlistContent.length === 0) {
      logger(
        'info',
        `youtube-${this.name}`,
        `Playlist ${playlistId} is empty or inaccessible.`
      )
      return { loadType: 'empty', data: {} }
    }

    const tracks: YouTubeTrackData[] = []
    let selectedTrack = 0
    const maxLength =
      (this.config.playback?.maxPlaylistLength as number | undefined) || 100

    if (sourceName === 'ytmusic') {
      playlistContent = playlistContent.filter((item) =>
        getItemValue(item, ['playlistPanelVideoRenderer.videoId'])
      )
    }

    let continuation = getItemValue<string>(playlistResponse, [
      'contents.singleColumnMusicWatchNextResultsRenderer.tabbedRenderer.watchNextTabbedResultsRenderer.tabs.0.tabRenderer.content.musicQueueRenderer.content.playlistPanelRenderer.continuations.0.nextContinuationData.continuation'
    ])
    const seenContinuations = new Set<string>()

    while (
      sourceName === 'ytmusic' &&
      _context &&
      continuation &&
      !seenContinuations.has(continuation) &&
      playlistContent.length < maxLength
    ) {
      seenContinuations.add(continuation)
      const client = this.getClient(_context)
      const { body, statusCode } = await makeRequest(
        'https://music.youtube.com/youtubei/v1/next',
        {
          method: 'POST',
          headers: {
            'User-Agent': client.client.userAgent,
            'X-Goog-Api-Format-Version': '2'
          },
          body: { context: client, continuation },
          disableBodyCompression: true,
          proxy: this.getProxy()
        }
      )
      if (statusCode !== 200 || !body) break

      const page = getItemValue<Record<string, unknown>>(body, [
        'continuationContents.playlistPanelContinuation'
      ])
      const items = (page?.contents as unknown[] | undefined)?.filter((item) =>
        getItemValue(item, ['playlistPanelVideoRenderer.videoId'])
      )
      if (!items?.length) break

      playlistContent.push(
        ...items.slice(0, maxLength - playlistContent.length)
      )
      continuation = getItemValue<string>(page, [
        'continuations.0.nextContinuationData.continuation'
      ])
    }

    for (let i = 0; i < Math.min(playlistContent.length, maxLength); i++) {
      const item = playlistContent[i] as YouTubeRenderer
      try {
        const track = await buildTrack(
          item,
          sourceName || 'youtube',
          null,
          null,
          !!this.config.experimental.enableHoloTracks,
          {
            fetchChannelInfo: false,
            resolveExternalLinks: false,
            search: {}
          }
        )
        if (track) {
          tracks.push(track as YouTubeTrackData)
          if (currentVideoId && track.info.identifier === currentVideoId) {
            selectedTrack = i
          }
        }
      } catch (err: unknown) {
        logger(
          'warn',
          `youtube-${this.name}`,
          `Failed to build track: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }

    if (tracks.length === 0) {
      logger(
        'info',
        `youtube-${this.name}`,
        `No valid tracks parsed from playlist ${playlistId}.`
      )
      return { loadType: 'empty', data: {} }
    }

    let playlistTitle = 'Unknown Playlist'
    if (plData?.title) {
      playlistTitle = plData.title as string
    } else {
      const tabbedRenderer = contentsRoot?.tabbedRenderer as
        | Record<string, unknown>
        | undefined
      const watchNext = tabbedRenderer?.watchNextTabbedResultsRenderer as
        | Record<string, unknown>
        | undefined
      const tabs = watchNext?.tabs as Record<string, unknown>[] | undefined
      const tabRenderer = tabs?.[0]?.tabRenderer as
        | Record<string, unknown>
        | undefined
      const musicQueue = tabRenderer?.content as
        | Record<string, unknown>
        | undefined
      const mqRenderer = musicQueue?.musicQueueRenderer as
        | Record<string, unknown>
        | undefined
      const headerRoot = mqRenderer?.header as
        | Record<string, unknown>
        | undefined
      const mqHeader = headerRoot?.musicQueueHeaderRenderer as
        | Record<string, unknown>
        | undefined
      const subtitle = mqHeader?.subtitle as YouTubeText | undefined

      if (subtitle?.runs?.[0]?.text) {
        playlistTitle = subtitle.runs[0].text
      }
    }

    return {
      loadType: 'playlist',
      data: {
        info: { name: playlistTitle, selectedTrack },
        pluginInfo: {},
        tracks
      }
    }
  }

  /**
   * Handles an innertube browse response for playlists.
   * @internal
   */
  async _handleBrowsePlaylistResponse(
    playlistId: string,
    browseResponseRaw: unknown,
    sourceName: string,
    _context?: YouTubeContext
  ): Promise<SourceResult> {
    if (!browseResponseRaw || typeof browseResponseRaw !== 'object') {
      return { loadType: 'empty', data: {} }
    }

    const browseResponse = browseResponseRaw as Record<string, unknown>

    if (browseResponse.error) {
      const error = browseResponse.error as Record<string, unknown>
      const errMsg =
        (error.message as string | undefined) || 'Failed to browse playlist.'
      logger(
        'error',
        `youtube-${this.name}`,
        `Error browsing playlist ${playlistId}: ${errMsg}`
      )
      return {
        loadType: 'error',
        exception: { message: errMsg, severity: 'common', cause: 'Upstream' }
      }
    }

    const contents = browseResponse.contents as
      | Record<string, unknown>
      | undefined
    const singleColumn = contents?.singleColumnBrowseResultsRenderer as
      | Record<string, unknown>
      | undefined
    const tabs = singleColumn?.tabs as Record<string, unknown>[] | undefined
    const tabRenderer = tabs?.[0]?.tabRenderer as
      | Record<string, unknown>
      | undefined
    const tabContent = tabRenderer?.content as
      | Record<string, unknown>
      | undefined
    const sectionList = tabContent?.sectionListRenderer as
      | Record<string, unknown>
      | undefined
    const sectionContents = sectionList?.contents as
      | Record<string, unknown>[]
      | undefined
    const section = sectionContents?.[0]
    const shelf =
      (section?.musicPlaylistShelfRenderer as
        | Record<string, unknown>
        | undefined) ||
      (section?.playlistVideoListRenderer as
        | Record<string, unknown>
        | undefined)

    const shelfContentsCheck = shelf?.contents as unknown[] | undefined
    if (!shelf || !shelfContentsCheck || shelfContentsCheck.length === 0) {
      logger(
        'info',
        `youtube-${this.name}`,
        `Browse playlist ${playlistId} is empty or inaccessible.`
      )
      return { loadType: 'empty', data: {} }
    }

    const maxLength =
      (this.config.playback?.maxPlaylistLength as number | undefined) || 100
    const shelfContents = shelfContentsCheck.filter(
      (item) => !getItemValue(item, ['messageRenderer'])
    )
    let continuation = getItemValue<string>(shelf, [
      'continuations.0.nextContinuationData.continuation'
    ])
    const seenContinuations = new Set<string>()

    while (
      this.name === 'ANDROID' &&
      _context &&
      continuation &&
      !seenContinuations.has(continuation) &&
      shelfContents.length < maxLength
    ) {
      seenContinuations.add(continuation)
      const client = this.getClient(_context)
      const { body, statusCode } = await makeRequest(
        `${this.getApiEndpoint()}/youtubei/v1/browse`,
        {
          method: 'POST',
          headers: {
            'User-Agent': client.client.userAgent,
            'X-YouTube-Client-Name': '3',
            'X-YouTube-Client-Version': client.client.clientVersion ?? ''
          },
          body: { context: client, continuation },
          disableBodyCompression: true,
          proxy: this.getProxy()
        }
      )
      if (statusCode !== 200 || !body) break

      const page = getItemValue<Record<string, unknown>>(body, [
        'continuationContents.playlistVideoListContinuation'
      ])
      const items = page?.contents as unknown[] | undefined
      if (!items?.length) break

      shelfContents.push(...items.slice(0, maxLength - shelfContents.length))
      continuation = getItemValue<string>(page, [
        'continuations.0.nextContinuationData.continuation'
      ])
    }

    const tracks: YouTubeTrackData[] = []

    for (let i = 0; i < Math.min(shelfContents.length, maxLength); i++) {
      const item = shelfContents[i] as YouTubeRenderer
      try {
        const track = await buildTrack(
          item,
          sourceName || 'ytmusic',
          sourceName,
          browseResponse,
          !!this.config.experimental.enableHoloTracks,
          {
            fetchChannelInfo: false,
            resolveExternalLinks: false,
            search: {}
          }
        )
        if (track) {
          tracks.push(track as YouTubeTrackData)
        }
      } catch (err: unknown) {
        logger(
          'warn',
          `youtube-${this.name}`,
          `Failed to build track: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }

    if (tracks.length === 0) {
      logger(
        'info',
        `youtube-${this.name}`,
        `No valid tracks parsed from browse playlist ${playlistId}.`
      )
      return { loadType: 'empty', data: {} }
    }

    let playlistTitle = 'Unknown Playlist'
    const headerRoot = browseResponse.header as
      | Record<string, unknown>
      | undefined
    const pageHeader = headerRoot?.pageHeaderRenderer as
      | Record<string, unknown>
      | undefined
    const musicDetail = headerRoot?.musicDetailHeaderRenderer as
      | Record<string, unknown>
      | undefined
    const musicTitle = musicDetail?.title as YouTubeText | undefined

    if (typeof pageHeader?.pageTitle === 'string') {
      playlistTitle = pageHeader.pageTitle
    } else if (musicTitle?.runs?.[0]?.text) {
      playlistTitle = musicTitle.runs[0].text
    } else {
      const editableHeaderRoot =
        headerRoot?.musicEditablePlaylistDetailHeaderRenderer as
          | Record<string, unknown>
          | undefined
      const editableHeader = editableHeaderRoot?.header as
        | Record<string, unknown>
        | undefined
      const editableMusicDetail = editableHeader?.musicDetailHeaderRenderer as
        | Record<string, unknown>
        | undefined
      const editableMusicTitle = editableMusicDetail?.title as
        | YouTubeText
        | undefined
      if (editableMusicTitle?.runs?.[0]?.text) {
        playlistTitle = editableMusicTitle.runs[0].text
      }
    }

    return {
      loadType: 'playlist',
      data: {
        info: { name: playlistTitle, selectedTrack: 0 },
        pluginInfo: {},
        tracks
      }
    }
  }

  /**
   * Extracts streaming metadata from a player response.
   * @internal
   */
  async _extractStreamData(
    playerResponseRaw: unknown,
    decodedTrack: TrackInfo,
    context: YouTubeContext,
    cipherManager: ICipherManager | null,
    itag?: number | string
  ): Promise<Record<string, unknown>> {
    const playerResponse = playerResponseRaw as YouTubePlayerResponse
    const streamingData = playerResponse.streamingData

    if (!streamingData) {
      logger(
        'error',
        `youtube-${this.name}`,
        `No streaming data found for ${decodedTrack.identifier}`
      )
      return {
        loadType: 'error',
        exception: {
          message: 'No streaming data available.',
          severity: 'common',
          cause: 'UpstreamNoStream'
        }
      }
    }

    const ytConfig =
      (
        this.config.sources as
          | Record<string, Record<string, unknown>>
          | undefined
      )?.youtube || {}
    const targetItag = ytConfig.targetItag as number | undefined
    const allowItag = (ytConfig.allowItag as number[] | undefined) || []
    let targetItags: number[] = []

    if (itag) {
      targetItags = [Number(itag)]
    } else if (targetItag) {
      targetItags = [Number(targetItag)]
    } else {
      const qualityPriority = this._getQualityPriority()
      const audioConfig = this.config.playback?.audio as
        | Record<string, unknown>
        | undefined
      const audioQuality =
        (audioConfig?.quality as string | undefined) || 'high'

      targetItags =
        (qualityPriority as Record<string, number[]>)[audioQuality] || []

      if (allowItag.length > 0) {
        targetItags = [...new Set([...targetItags, ...allowItag])]
      }
    }

    const allFormats = [
      ...((streamingData.adaptiveFormats as unknown[] | undefined) || []),
      ...((streamingData.formats as unknown[] | undefined) || [])
    ]

    let formats = allFormats.map((fRaw) => {
      const f = fRaw as Record<string, unknown>
      return {
        itag: f.itag as number,
        mimeType: f.mimeType as string | undefined,
        qualityLabel: f.qualityLabel as string | undefined,
        bitrate: f.bitrate as number | undefined,
        audioQuality: f.audioQuality as string | undefined,
        url: f.url as string | undefined,
        signatureCipher: f.signatureCipher as string | undefined,
        audioTrack: f.audioTrack as Record<string, unknown> | undefined
      }
    })

    const dt = decodedTrack as unknown as Record<string, unknown>
    if (dt.audioTrackId) {
      const requestedFormats = formats.filter(
        (f) => f.audioTrack && f.audioTrack.id === dt.audioTrackId
      )

      if (requestedFormats.length > 0) {
        logger(
          'debug',
          `youtube-${this.name}`,
          `Found requested audio track: ${dt.audioTrackId}`
        )
        formats = requestedFormats
      } else {
        const hasAudioTracks = formats.some((f) => f.audioTrack)
        if (hasAudioTracks) {
          logger(
            'warn',
            `youtube-${this.name}`,
            `Requested audio track ${dt.audioTrackId} not found in client ${this.name}.`
          )
          return {
            loadType: 'error',
            exception: {
              message: 'Requested audio track not available in this client.',
              severity: 'common',
              cause: 'AudioTrackNotFound'
            }
          }
        }
      }
    } else {
      const defaultFormats = formats.filter((f) => f.audioTrack?.audioIsDefault)

      if (defaultFormats.length > 0) {
        logger('debug', `youtube-${this.name}`, 'Using default audio track.')
        formats = defaultFormats
      }
    }

    const _attemptCipherResolution = async (
      formatToResolve: {
        url?: string
        signatureCipher?: string
        itag: number
        [key: string]: unknown
      },
      playerScript: ICachedPlayerScript | null,
      ctx: YouTubeContext
    ) => {
      let currentStreamUrl = formatToResolve.url
      let currentEncryptedSignature: string | null = null
      let currentNParam: string | null = null
      let currentSignatureKey: string | null = null

      if (formatToResolve.signatureCipher) {
        const cipher = new URLSearchParams(formatToResolve.signatureCipher)
        currentStreamUrl = cipher.get('url') || undefined
        currentEncryptedSignature = cipher.get('s')
        currentSignatureKey = cipher.get('sp') || 'sig'
        currentNParam = cipher.get('n')
      }

      if (!playerScript) {
        if (currentEncryptedSignature) {
          return null
        }
        if (currentStreamUrl) {
          formatToResolve.url = currentStreamUrl
          return formatToResolve
        }
        return null
      }

      if (currentStreamUrl && cipherManager) {
        try {
          const decipheredUrl = await cipherManager.resolveUrl(
            currentStreamUrl,
            currentEncryptedSignature,
            currentNParam,
            currentSignatureKey,
            playerScript,
            ctx
          )
          formatToResolve.url = decipheredUrl
          return formatToResolve
        } catch (e: unknown) {
          logger(
            'warn',
            `youtube-${this.name}`,
            `Failed to resolve format URL for itag ${formatToResolve.itag}: ${e instanceof Error ? e.message : String(e)}`
          )
        }
      }
      return null
    }

    interface ResolvedFormat {
      itag: number
      mimeType?: string
      url?: string
      [key: string]: unknown
    }

    let resolvedFormat: ResolvedFormat | null = null
    const playerScript =
      this.requirePlayerScript() && cipherManager
        ? await cipherManager.getCachedPlayerScript()
        : null

    if (this.requirePlayerScript() && !playerScript) {
      logger(
        'error',
        `youtube-${this.name}`,
        'Failed to obtain player script for deciphering. Cannot extract stream data.'
      )
      return {
        loadType: 'error',
        exception: {
          message: 'Failed to obtain player script for deciphering.',
          severity: 'fault',
          cause: 'Internal'
        }
      }
    }

    logger(
      'debug',
      `youtube-${this.name}`,
      `Initial target itags (from config/quality priority): ${targetItags.join(', ')}`
    )

    const opusAudioCandidates = formats
      .filter(
        (format) =>
          targetItags.includes(format.itag) &&
          (format.mimeType as string | undefined)?.startsWith('audio/')
      )
      .sort((a, b) => targetItags.indexOf(a.itag) - targetItags.indexOf(b.itag))

    logger(
      'debug',
      `youtube-${this.name}`,
      `Opus audio-only candidates: ${opusAudioCandidates.map((f) => f.itag).join(', ')}`
    )

    for (const formatRaw of opusAudioCandidates) {
      const format = formatRaw as {
        url?: string
        signatureCipher?: string
        itag: number
      }
      resolvedFormat = await _attemptCipherResolution(
        format,
        playerScript,
        context
      )
      if (resolvedFormat) {
        logger(
          'debug',
          `youtube-${this.name}`,
          `Resolved format: itag ${resolvedFormat.itag}, mimeType ${resolvedFormat.mimeType}`
        )
        break
      }
    }

    if (!resolvedFormat) {
      logger(
        'debug',
        `youtube-${this.name}`,
        'Opus audio-only failed. Attempting fallback to itag 18.'
      )
      const itag18FormatRaw = formats.find((format) => format.itag === 18)

      if (itag18FormatRaw) {
        const itag18Format = itag18FormatRaw as {
          url?: string
          signatureCipher?: string
          itag: number
        }
        resolvedFormat = await _attemptCipherResolution(
          itag18Format,
          playerScript,
          context
        )
        if (resolvedFormat) {
          logger(
            'debug',
            `youtube-${this.name}`,
            `Resolved format from itag 18 fallback: itag ${resolvedFormat.itag}, mimeType ${resolvedFormat.mimeType}`
          )
        } else {
          logger(
            'debug',
            `youtube-${this.name}`,
            'Itag 18 found but could not be resolved.'
          )
        }
      } else {
        logger(
          'debug',
          `youtube-${this.name}`,
          'Itag 18 not found in available formats.'
        )
      }
    }

    if (!resolvedFormat && !streamingData.hlsManifestUrl) {
      logger(
        'debug',
        `youtube-${this.name}`,
        'No suitable stream found after all fallbacks, and no HLS manifest URL.'
      )
      return {
        loadType: 'error',
        exception: {
          message: 'No suitable audio stream found after all fallbacks.',
          severity: 'common',
          cause: 'Upstream'
        },
        formats
      }
    }

    if (!resolvedFormat && streamingData.hlsManifestUrl) {
      logger(
        'debug',
        `youtube-${this.name}`,
        'No suitable stream found after all fallbacks, but HLS manifest URL is available. Proceeding with HLS.'
      )
    } else {
      logger(
        'debug',
        `youtube-${this.name}`,
        `Final resolved format: itag ${resolvedFormat?.itag}, mimeType ${resolvedFormat?.mimeType}`
      )
    }

    const directUrl =
      resolvedFormat?.url && !decodedTrack.isStream
        ? resolvedFormat.url
        : undefined

    if (!directUrl && !streamingData.hlsManifestUrl) {
      logger(
        'debug',
        `youtube-${this.name}`,
        'No direct URL resolved and no HLS manifest. Returning error.'
      )
      return {
        loadType: 'error',
        exception: {
          message: 'No suitable audio stream found.',

          severity: 'common',

          cause: 'Upstream'
        },

        formats
      }
    }

    const resolveFormatStr = (mimeType: string | undefined) => {
      if (!mimeType) return null

      const lowerMime = mimeType.toLowerCase()

      if (lowerMime.includes('opus')) {
        return 'webm/opus'
      }

      if (lowerMime.includes('mp4')) {
        return 'mp4'
      }

      if (lowerMime.includes('mp3')) {
        return 'mp3'
      }

      if (lowerMime.includes('aac')) {
        return 'aac'
      }

      if (decodedTrack.isStream) {
        return 'mpegts'
      }

      return null
    }

    return {
      url: directUrl,

      protocol: directUrl ? 'http' : null,

      format: resolveFormatStr(resolvedFormat?.mimeType as string | undefined),

      itag: resolvedFormat?.itag,

      hlsUrl: (streamingData.hlsManifestUrl as string | undefined) || null,

      formats
    }
  }

  /**
   * Returns a map of quality names to itag priorities.
   * @internal
   */
  _getQualityPriority(): Record<string, number[]> {
    return {
      high: [251, 250, 140],
      medium: [250, 140],
      low: [249, 250, 140],
      lowest: [249, 139]
    }
  }

  /**
   * Resolves a URL to track/playlist data.
   * @param url - YouTube URL
   * @param _type - Source type override
   * @param context - YouTube context
   * @param cipherManager - Cipher manager instance
   */
  async resolve(
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
        const idPattern = /(?:v=|shorts\/|youtu\.be\/)([^&?]+)/
        const videoIdMatch = url.match(idPattern)
        if (!videoIdMatch?.[1]) {
          logger(
            'error',
            `youtube-${this.name}`,
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

        const headers = this.oauth ? await this.oauth.getAuthHeaders() : {}
        const playerResult = await this._makePlayerRequest(
          videoId,
          context,
          headers,
          cipherManager
        )

        if (playerResult.statusCode !== 200 || !playerResult.body) {
          const message = `Failed to load video/short player data. Status: ${playerResult.statusCode}`
          logger('error', `youtube-${this.name}`, message)
          return {
            loadType: 'error',
            exception: {
              message: message,
              severity: 'common',
              cause: 'Upstream'
            }
          }
        }

        return await this._handlePlayerResponse(
          playerResult.body,
          sourceName,
          videoId,
          context
        )
      }

      case YOUTUBE_CONSTANTS.PLAYLIST: {
        const playlistIdMatch = url.match(/[?&]list=([\w-]+)/)
        if (!playlistIdMatch?.[1]) {
          logger(
            'error',
            `youtube-${this.name}`,
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

        const headers = this.oauth ? await this.oauth.getAuthHeaders() : {}
        const playlistResponse = await makeRequest(
          `${apiEndpoint}/youtubei/v1/next`,
          {
            headers: {
              'User-Agent': this.getClient(context).client.userAgent,
              ...headers
            },
            body: {
              context: { client: this.getClient(context) },
              playlistId,
              contentCheckOk: true,
              racyCheckOk: true
            },
            method: 'POST',
            disableBodyCompression: true,
            proxy: this.getProxy()
          }
        )

        const plBody = playlistResponse.body as
          | Record<string, unknown>
          | undefined
        if (playlistResponse.statusCode !== 200 || plBody?.error) {
          const error = plBody?.error as Record<string, unknown> | undefined
          const errMsg =
            (error?.message as string | undefined) ||
            `Failed to fetch playlist. Status: ${playlistResponse.statusCode}`
          logger(
            'error',
            `youtube-${this.name}`,
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
          plBody ?? {},
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
   * @param decodedTrack - Decoded track information
   * @param context - YouTube context
   * @param cipherManager - Cipher manager instance
   * @param itag - Optional specific itag to request
   * @param proxy - Optional proxy override
   */
  async getTrackUrl(
    decodedTrack: TrackInfo,
    context: YouTubeContext,
    cipherManager: ICipherManager | null,
    itag?: number | string,
    proxy?: HttpProxyConfig
  ): Promise<Record<string, unknown>> {
    const headers = this.oauth ? await this.oauth.getAuthHeaders() : {}
    const playerResult = await this._makePlayerRequest(
      decodedTrack.identifier,
      context,
      headers,
      cipherManager,
      proxy
    )

    if (playerResult.statusCode !== 200 || !playerResult.body) {
      const message = `Failed to get player data for stream. Status: ${playerResult.statusCode}`
      logger('error', `youtube-${this.name}`, message)
      return {
        loadType: 'error',
        exception: { message, severity: 'common', cause: 'Upstream' }
      }
    }

    return await this._extractStreamData(
      playerResult.body,
      decodedTrack,
      context,
      cipherManager,
      itag
    )
  }

  /**
   * Fetches the initial visitor data by making a GET request to YouTube.
   * This is used to initialize the session context.
   *
   * @returns The extracted visitor data string, or null if it could not be found.
   */
  async getVisitorData(): Promise<string | null> {
    try {
      const response = await makeRequest('https://www.youtube.com', {
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        proxy: this.getProxy()
      })

      if (response.statusCode !== 200 || !response.body) {
        return null
      }

      const body = response.body as string
      const match = body.match(/ytcfg\.set\((\{.*?\})\);/)
      if (match?.[1]) {
        try {
          const ytcfg = JSON.parse(match[1])
          if (ytcfg.VISITOR_DATA) {
            return ytcfg.VISITOR_DATA as string
          }
        } catch {
          // Fallback to regex if JSON parse fails
        }
      }

      const visitorDataMatch = body.match(/"visitorData":"([^"]+)"/)
      return visitorDataMatch?.[1] || null
    } catch (err) {
      logger(
        'debug',
        `youtube-${this.name}`,
        `Failed to fetch visitor data: ${err instanceof Error ? err.message : String(err)}`
      )
      return null
    }
  }
}
