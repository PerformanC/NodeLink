import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { alignLyrics } from '../modules/lyricsAligner.ts'
import type { NodelinkConfig } from '../typings/config/config.types.ts'
import type { SourceResult } from '../typings/sources/source.types.ts'
import { logger } from '../utils.ts'

/**
 * Minimal decoded track payload accepted by {@link LyricsManager.loadLyrics}.
 * @public
 */
export interface DecodedTrack {
  /** Parsed track info block. */
  info?: TrackInfoLike
}

/**
 * Minimal track information required by lyrics providers.
 * @public
 */
export interface TrackInfoLike {
  /** Track source key (e.g. youtube, spotify). */
  sourceName?: string
  /** Track URL used for source re-resolution. */
  uri?: string
  /** Human-readable track title. */
  title?: string
}

/**
 * Unified line structure used by lyrics payloads.
 * @public
 */
export interface LyricsLine {
  /** Line text. */
  text: string
  /** Line start time in milliseconds. */
  time: number
  /** Line duration in milliseconds. */
  duration: number
  /** Optional per-word timing information. */
  words?: Array<Record<string, unknown>>
}

/**
 * Success payload for lyrics responses.
 * @public
 */
export interface LyricsData {
  /** Display name for the lyrics source/variant. */
  name?: string
  /** Whether lines include timing information. */
  synced?: boolean
  /** Lyrics lines. */
  lines?: LyricsLine[]
  /** Provider that produced the final payload. */
  provider?: string
}

/**
 * Error payload for lyrics responses.
 * @public
 */
export interface LyricsErrorData {
  /** Human-readable error message. */
  message: string
  /** Error severity bucket. */
  severity: string
}

/**
 * Result returned by lyrics providers and manager operations.
 * @public
 */
export type LyricsLoadResult =
  | { loadType: 'lyrics'; data: LyricsData }
  | { loadType: 'empty'; data: Record<string, never> }
  | { loadType: 'error'; data: LyricsErrorData }

/**
 * Minimal NodeLink context required by this manager.
 * @public
 */
export interface LyricsManagerContext {
  /** Server options. */
  options: NodelinkConfig
  /** Source manager accessor. */
  sources?: {
    /** Re-resolves a track URI into reliable source metadata. */
    resolve: (uri: string) => Promise<SourceResult>
  } | null
}

/**
 * Runtime instance shape for a lyrics provider.
 * @public
 */
export interface LyricsSourceInstance {
  /** Initializes the source instance. */
  setup: () => Promise<boolean>
  /** Fetches lyrics for a track. */
  getLyrics: (
    trackInfo: TrackInfoLike,
    language?: string
  ) => Promise<LyricsLoadResult>
}

/**
 * Constructor signature for dynamically imported lyrics providers.
 * @public
 */
type LyricsSourceConstructor = new (
  nodelink: LyricsManagerContext
) => LyricsSourceInstance

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const isTrackInfoLike = (value: unknown): value is TrackInfoLike =>
  typeof value === 'object' && value !== null

const getTrackInfoFromResolve = (
  result: SourceResult,
  fallback: TrackInfoLike
): TrackInfoLike => {
  if (result.loadType === 'error') return fallback

  const data = result.data
  if (!isTrackInfoLike(data)) return fallback

  const maybeInfo = (data as { info?: unknown }).info
  if (isTrackInfoLike(maybeInfo)) return maybeInfo

  return data as TrackInfoLike
}

const isLyricsSourceEnabled = (
  lyricsConfig: Record<string, unknown> | undefined,
  sourceName: string
): boolean => {
  const sourceConfig = lyricsConfig?.[sourceName]
  if (typeof sourceConfig !== 'object' || sourceConfig === null) return false

  const enabled = (sourceConfig as { enabled?: unknown }).enabled
  return enabled === true
}

export default class LyricsManager {
  nodelink: LyricsManagerContext
  lyricsSources: Map<string, LyricsSourceInstance>

  constructor(nodelink: LyricsManagerContext) {
    this.nodelink = nodelink
    this.lyricsSources = new Map()
  }

  async loadFolder(): Promise<void> {
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = path.dirname(__filename)
    const lyricsDir = path.join(__dirname, '../lyrics')

    this.lyricsSources.clear()

    try {
      await fs.access(lyricsDir)
      const files = await fs.readdir(lyricsDir)
      const jsFiles = files.filter(
        (f) => f.endsWith('.js') || f.endsWith('.ts')
      )
      const toLoad = jsFiles.filter((f) => {
        const name = path.basename(f, path.extname(f))
        return isLyricsSourceEnabled(this.nodelink.options?.lyrics, name)
      })

      await Promise.all(
        toLoad.map(async (file) => {
          const name = path.basename(file, path.extname(file))
          const filePath = path.join(lyricsDir, file)
          const fileUrl = new URL(`file://${filePath.replace(/\\/g, '/')}`)
          const importedModule = (await import(fileUrl.href)) as {
            default?: LyricsSourceConstructor
          }
          const Mod = importedModule.default

          if (typeof Mod !== 'function') {
            logger(
              'warn',
              'Lyrics',
              `Invalid lyrics source module export for: ${name}`
            )
            return
          }

          const instance = new Mod(this.nodelink)
          if (await instance.setup()) {
            this.lyricsSources.set(name, instance)
            logger('info', 'Lyrics', `Loaded lyrics source: ${name}`)
          } else {
            logger(
              'error',
              'Lyrics',
              `Failed setup for lyrics source: ${name}; source not available.`
            )
          }
        })
      )
    } catch {
      logger(
        'info',
        'Lyrics',
        `Lyrics directory not found, creating at: ${lyricsDir}`
      )
      await fs.mkdir(lyricsDir, { recursive: true })
    }
  }

  async loadLyrics(
    decodedTrack: DecodedTrack | null | undefined,
    language?: string,
    skipTrackSource = false
  ): Promise<LyricsLoadResult> {
    if (!decodedTrack?.info?.sourceName || !decodedTrack.info?.uri) {
      logger(
        'warn',
        'Lyrics',
        'Invalid track object provided to loadLyrics',
        decodedTrack
      )
      return {
        loadType: 'error',
        data: { message: 'Invalid track object provided.', severity: 'common' }
      }
    }

    logger(
      'debug',
      'Lyrics',
      `Loading lyrics for track: ${decodedTrack.info.title}`
    )

    if (!this.nodelink.sources?.resolve) {
      logger(
        'warn',
        'Lyrics',
        'Source manager is unavailable for lyrics loading'
      )
      return {
        loadType: 'error',
        data: {
          message: 'Source manager is unavailable.',
          severity: 'fault'
        }
      }
    }

    const reliableTrackData = await this.nodelink.sources.resolve(
      decodedTrack.info.uri
    )

    if (reliableTrackData.loadType !== 'track') {
      logger(
        'warn',
        'Lyrics',
        `Could not re-fetch track information for ${decodedTrack.info.title}`
      )
      return {
        loadType: 'error',
        data: {
          message:
            'Could not re-fetch track information before loading lyrics.',
          severity: 'fault'
        }
      }
    }

    const trackInfo = getTrackInfoFromResolve(
      reliableTrackData,
      decodedTrack.info
    )
    const sourceName = trackInfo.sourceName
    const lyricsSource = sourceName
      ? this.lyricsSources.get(sourceName)
      : undefined
    const isYouTube = sourceName === 'youtube' || sourceName === 'ytmusic'

    let youtubeCaptions: LyricsLoadResult | null = null

    if (lyricsSource && !skipTrackSource) {
      if (isYouTube) {
        try {
          const result = await lyricsSource.getLyrics(trackInfo, language)
          if (result && result.loadType === 'lyrics') {
            youtubeCaptions = result
          }
        } catch (e) {
          logger(
            'warn',
            'Lyrics',
            `Failed to fetch YouTube captions for alignment: ${getErrorMessage(e)}`
          )
        }
      } else {
        const lyrics = await lyricsSource.getLyrics(trackInfo, language)
        if (lyrics && lyrics.loadType !== 'empty') {
          if (lyrics.loadType === 'lyrics') {
            lyrics.data.provider = sourceName
          }
          return lyrics
        }
      }
    }

    const sources = new Set([
      ...(this.nodelink.options.lyrics?.preferredSources ?? []),
      ...this.lyricsSources.keys()
    ])
    for (const name of sources) {
      const source = this.lyricsSources.get(name)
      if (!source || name === sourceName) continue

      logger(
        'debug',
        'Lyrics',
        `Trying lyrics source ${name} for ${trackInfo?.title || 'Unknown Title'}.`
      )
      const lyrics = await source.getLyrics(trackInfo, language)

      if (lyrics && lyrics.loadType !== 'empty') {
        if (
          isYouTube &&
          youtubeCaptions?.loadType === 'lyrics' &&
          lyrics.loadType === 'lyrics' &&
          lyrics.data.synced &&
          Array.isArray(lyrics.data.lines) &&
          Array.isArray(youtubeCaptions.data.lines)
        ) {
          try {
            logger(
              'debug',
              'Lyrics',
              `Aligning ${name} lyrics with YouTube timing...`
            )
            const alignedLines = alignLyrics(
              lyrics.data.lines,
              youtubeCaptions.data
            )
            lyrics.data.lines = alignedLines
          } catch (alignErr) {
            logger(
              'warn',
              'Lyrics',
              `Failed to align lyrics: ${getErrorMessage(alignErr)}`
            )
          }
        }

        if (lyrics.loadType === 'lyrics') {
          lyrics.data.provider = name
        }
        return lyrics
      }
    }

    if (isYouTube && youtubeCaptions?.loadType === 'lyrics') {
      youtubeCaptions.data.provider = sourceName
      return youtubeCaptions
    }

    logger(
      'debug',
      'Lyrics',
      `No lyrics found for ${trackInfo?.title || 'Unknown Track'}`
    )
    return { loadType: 'empty', data: {} }
  }
}
