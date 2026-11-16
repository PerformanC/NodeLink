import type { TrackInfo } from '../sources/source.types.ts'
import type { LyricsLine } from './musixmatch.types.ts'

/**
 * Caption track metadata extracted from YouTube pluginInfo.
 * @public
 */
export interface YouTubeCaptionTrack {
  /**
   * Caption language code (for example: `en`, `pt-BR`).
   */
  languageCode: string

  /**
   * Human-readable caption language name.
   */
  name: string

  /**
   * Whether this caption track can be translated by YouTube.
   */
  isTranslatable?: boolean

  /**
   * Caption endpoint base URL.
   */
  baseUrl: string

  /**
   * Optional caption kind (for example: `asr`).
   */
  kind?: string
}

/**
 * Language descriptor returned with YouTube lyrics response.
 * @public
 */
export interface YouTubeLyricsLanguageDescriptor {
  /**
   * Language code.
   */
  code: string

  /**
   * Display language name.
   */
  name: string

  /**
   * Whether translation is supported.
   */
  isTranslatable?: boolean
}

/**
 * Word-level timing entry for YouTube captions.
 * @public
 */
export interface YouTubeCaptionWord {
  /**
   * Word text.
   */
  text: string

  /**
   * Word start timestamp in milliseconds.
   */
  timestamp: number

  /**
   * Word duration in milliseconds.
   */
  duration: number
}

/**
 * Line payload used by YouTube lyrics provider.
 * @public
 */
export interface YouTubeLyricsLine extends LyricsLine {
  /**
   * Optional word-level timing details.
   */
  words?: YouTubeCaptionWord[]
}

/**
 * JSON3 caption segment payload.
 * @public
 */
export interface YouTubeCaptionSegment {
  /**
   * Segment text.
   */
  utf8: string

  /**
   * Segment offset from event start in milliseconds.
   */
  tOffsetMs?: number
}

/**
 * JSON3 caption event payload.
 * @public
 */
export interface YouTubeCaptionEvent {
  /**
   * Event start timestamp in milliseconds.
   */
  tStartMs: number

  /**
   * Event duration in milliseconds.
   */
  dDurationMs?: number

  /**
   * Segment list composing event text.
   */
  segs?: YouTubeCaptionSegment[]
}

/**
 * JSON3 caption response payload.
 * @public
 */
export interface YouTubeCaptionResponse {
  /**
   * Caption events list.
   */
  events?: YouTubeCaptionEvent[]
}

/**
 * Resolved track payload shape used by YouTube lyrics provider.
 * @public
 */
export interface YouTubeResolvedTrack {
  /**
   * Resolve result type.
   */
  loadType?: string

  /**
   * Resolved data payload.
   */
  data?: {
    /**
     * Plugin metadata payload.
     */
    pluginInfo?: {
      /**
       * Available caption tracks.
       */
      captions?: YouTubeCaptionTrack[] | string
    }
  }
}

/**
 * Track info accepted by YouTube lyrics provider.
 * @public
 */
export type YouTubeLyricsTrackInfo = Pick<
  TrackInfo,
  'uri' | 'sourceName' | 'title'
>

/**
 * Minimal source manager shape required by YouTube lyrics provider.
 * @public
 */
export interface YouTubeLyricsSourceManager {
  /**
   * Resolves a track URI into source-specific metadata.
   */
  resolve: (uri: string, sourceName?: string) => Promise<YouTubeResolvedTrack>
}

/**
 * Minimal NodeLink context shape required by YouTube lyrics provider.
 * @public
 */
export interface NodelinkInstanceForYouTubeLyrics {
  /**
   * Source manager accessor.
   */
  sources: YouTubeLyricsSourceManager
}

/**
 * Success payload for YouTube lyrics provider.
 * @public
 */
export interface YouTubeLyricsData {
  /**
   * Caption track display name.
   */
  name: string

  /**
   * YouTube captions are always synced in this provider.
   */
  synced: true

  /**
   * Selected caption language code.
   */
  lang: string

  /**
   * Parsed lyrics lines.
   */
  lines: YouTubeLyricsLine[]

  /**
   * Available caption languages.
   */
  langs: YouTubeLyricsLanguageDescriptor[]

  /**
   * Optional provider identifier injected by LyricsManager.
   */
  provider?: string
}

/**
 * Unified result returned by YouTube lyrics provider.
 * @public
 */
export type YouTubeLyricsResult =
  | { loadType: 'lyrics'; data: YouTubeLyricsData }
  | { loadType: 'empty'; data: Record<string, never> }
  | { loadType: 'error'; data: { message: string; severity: string } }
