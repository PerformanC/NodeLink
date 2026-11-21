import type {
  NodelinkInstanceForYouTubeLyrics,
  YouTubeCaptionResponse,
  YouTubeCaptionTrack,
  YouTubeLyricsLanguageDescriptor,
  YouTubeLyricsResult,
  YouTubeLyricsTrackInfo
} from '../typings/lyrics/youtube.types.ts'
import { logger, makeRequest } from '../utils.ts'

/**
 * Decodes common HTML entities found in YouTube caption segments.
 * @param text - Raw caption text.
 * @returns Decoded text.
 * @internal
 */
const decodeCaptionText = (text: string): string =>
  text
    .replace(/&amp;#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')

/**
 * YouTube captions lyrics provider.
 * @public
 */
export default class YouTubeLyrics {
  /**
   * Runtime NodeLink context.
   */
  public readonly nodelink: NodelinkInstanceForYouTubeLyrics

  /**
   * Creates a new YouTube lyrics provider.
   * @param nodelink - Runtime NodeLink context.
   */
  public constructor(nodelink: NodelinkInstanceForYouTubeLyrics) {
    this.nodelink = nodelink
  }

  /**
   * Initializes provider resources.
   * @returns Always true for this provider.
   */
  public async setup(): Promise<boolean> {
    return true
  }

  /**
   * Selects the preferred caption track for requested language.
   * @param captionTracks - Available caption tracks.
   * @param language - Requested target language.
   * @returns Selected caption track.
   * @internal
   */
  private _pickCaptionTrack(
    captionTracks: YouTubeCaptionTrack[],
    language?: string
  ): YouTubeCaptionTrack | null {
    let trackLang: YouTubeCaptionTrack | null = null

    if (language) {
      trackLang =
        captionTracks.find((caption) => caption.languageCode === language) ??
        null

      if (!trackLang) {
        const defaultTrack =
          captionTracks.find((caption) =>
            caption.languageCode.startsWith('en')
          ) ||
          captionTracks.find((caption) => caption.kind !== 'asr') ||
          captionTracks[0]

        if (defaultTrack?.isTranslatable) {
          trackLang = {
            ...defaultTrack,
            languageCode: language,
            baseUrl: `${defaultTrack.baseUrl}&tlang=${language}`,
            name: `${defaultTrack.name} (Translated to ${language})`
          }
        }
      }
    }

    if (!trackLang) {
      trackLang =
        captionTracks.find((caption) =>
          caption.languageCode.startsWith('en')
        ) ||
        captionTracks.find((caption) => caption.kind !== 'asr') ||
        captionTracks[0] ||
        null
    }

    return trackLang
  }

  /**
   * Loads lyrics for a track using YouTube captions.
   * @param trackInfo - Track metadata to resolve captions.
   * @param language - Optional target language code.
   * @returns Lyrics payload, empty result, or provider error.
   */
  public async getLyrics(
    trackInfo: YouTubeLyricsTrackInfo,
    language?: string
  ): Promise<YouTubeLyricsResult> {
    const resolvedTrack = await this.nodelink.sources.resolve(
      trackInfo.uri,
      trackInfo.sourceName
    )

    let captionTracks = resolvedTrack.data?.pluginInfo?.captions
    if (typeof captionTracks === 'string') {
      try {
        captionTracks = JSON.parse(captionTracks) as YouTubeCaptionTrack[]
      } catch {
        captionTracks = []
      }
    }

    if (resolvedTrack.loadType !== 'track' || !Array.isArray(captionTracks)) {
      logger(
        'debug',
        'Lyrics',
        `No captions found for ${trackInfo.title} after resolving.`
      )
      return { loadType: 'empty', data: {} }
    }

    if (captionTracks.length === 0) {
      return { loadType: 'empty', data: {} }
    }

    const langs: YouTubeLyricsLanguageDescriptor[] = captionTracks.map(
      (caption) => ({
        code: caption.languageCode,
        name: caption.name,
        isTranslatable: caption.isTranslatable
      })
    )

    const trackLang = this._pickCaptionTrack(captionTracks, language)
    if (!trackLang) return { loadType: 'empty', data: {} }

    let url = trackLang.baseUrl
    if (url.includes('fmt=')) {
      url = url.replace(/fmt=[^&]+/, 'fmt=json3')
    } else {
      url += '&fmt=json3'
    }

    const { body, error, statusCode } = await makeRequest(url, {
      method: 'GET'
    })
    if (error || statusCode !== 200) {
      logger(
        'error',
        'Lyrics',
        `Failed to fetch lyrics content from ${url}: ${error || statusCode}`
      )
      return { loadType: 'empty', data: {} }
    }

    const lyrics = body as YouTubeCaptionResponse | null | undefined
    if (!lyrics?.events) {
      logger(
        'warn',
        'Lyrics',
        `Invalid lyrics format received for ${trackInfo.title}`
      )
      return { loadType: 'empty', data: {} }
    }

    const lines = lyrics.events
      .map((event) => {
        const text = event.segs?.map((segment) => segment.utf8).join('') || ''
        const words =
          event.segs?.map((segment) => ({
            text: decodeCaptionText(segment.utf8),
            timestamp: event.tStartMs + (segment.tOffsetMs || 0),
            duration: 0
          })) || []

        return {
          text: decodeCaptionText(text),
          time: event.tStartMs,
          duration: event.dDurationMs || 0,
          words
        }
      })
      .filter((line) => line.text.trim().length > 0)

    return {
      loadType: 'lyrics',
      data: {
        name: trackLang.name,
        synced: true,
        lang: trackLang.languageCode,
        lines,
        langs
      }
    }
  }
}
