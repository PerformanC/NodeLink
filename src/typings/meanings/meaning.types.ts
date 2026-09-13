import type { NodelinkConfig } from '../config/config.types.ts'

/**
 * Minimal track info used by meaning providers.
 * @public
 */
export interface MeaningTrackInfo {
  sourceName?: string
  title?: string
  author?: string
  length?: number
  uri?: string | null
}

/**
 * Minimal decoded track payload accepted by the meaning manager.
 * @public
 */
export interface DecodedMeaningTrack {
  info?: MeaningTrackInfo
}

/**
 * Translation payload returned by meaning providers.
 * @public
 */
export interface MeaningTranslation {
  language: {
    source: string
    target: string
  }
  title: string | null
  description: string | null
  paragraphs: string[]
}

/**
 * Additional metadata attached to a meaning payload.
 * @public
 */
export interface MeaningMetaData {
  id: string | number | null
  localeId: string | number | null
  origin: string | number | null
  submittedBy: string | null
  reviewedBy: string | null
}

/**
 * Song metadata attached to a meaning payload.
 * @public
 */
export interface MeaningSongData {
  title: string | null
  artist: string | null
  youtubeId: string | null
  letrasId: string | number | null
  artworkUrl: string | null
}

/**
 * Meaning payload returned by providers.
 * @public
 */
export interface MeaningData {
  title: string | null
  description: string | null
  paragraphs: string[]
  translation: MeaningTranslation | null
  url: string
  type: 'track' | 'artist'
  meaningMeta: MeaningMetaData
  song: MeaningSongData
  provider?: string
  [key: string]: unknown
}

/**
 * Error payload returned by providers.
 * @public
 */
export interface MeaningErrorData {
  message: string
  severity: string
  [key: string]: unknown
}

/**
 * Unified meaning load result.
 * @public
 */
export type MeaningLoadResult =
  | { loadType: 'meaning'; data: MeaningData }
  | { loadType: 'empty'; data: Record<string, never> }
  | { loadType: 'error'; data: MeaningErrorData }

/**
 * Runtime interface for a meaning source module.
 * @public
 */
export interface MeaningSourceInstance {
  priority?: number
  setup: () => Promise<boolean>
  getMeaning: (
    trackInfo: MeaningTrackInfo,
    language?: string
  ) => Promise<MeaningLoadResult>
}

/**
 * Minimal context required by MeaningManager.
 * @public
 */
export interface MeaningManagerContext {
  options: NodelinkConfig
}

/**
 * Constructor signature for meaning providers.
 * @public
 */
export type MeaningSourceConstructor = new (
  nodelink: MeaningManagerContext
) => MeaningSourceInstance
