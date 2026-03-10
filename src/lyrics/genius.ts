import type {
  LyricsLine,
  LyricsResult,
  TrackInfo
} from '../typings/lyrics/musixmatch.types.ts'
import { logger, makeRequest } from '../utils.ts'

const CLEAN_PATTERNS = [
  /\s*\([^)]*(?:official|lyrics?|video|audio|mv|visualizer|color\s*coded|hd|4k|prod\.)[^)]*\)/gi,
  /\s*\[[^\]]*(?:official|lyrics?|video|audio|mv|visualizer|color\s*coded|hd|4k|prod\.)[^\]]*\]/gi,
  /\s*-\s*Topic$/i,
  /VEVO$/i
] as const

const GENIUS_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json, text/html;q=0.9, */*;q=0.8'
} as const

const PRELOADED_STATE_REGEX =
  /<script[^>]*>\s*window\.__PRELOADED_STATE__\s*=\s*JSON\.parse\((.+?)\);\s*<\/script>/s
const BREAK_TAG_REGEX = /<br\s*\/?>/gi
const HTML_TAG_REGEX = /<[^>]*>/g
const HTML_ENTITY_REGEX = /&(?:amp|quot|apos|lt|gt|#39|#x27);/gi

/**
 * JSON-compatible scalar or nested value used for payload narrowing.
 */
type JsonValue = JsonRecord | JsonValue[] | string | number | boolean | null

/**
 * Object-like JSON record used to safely inspect parsed payloads.
 */
interface JsonRecord {
  [key: string]: JsonValue | undefined
}

/**
 * Minimal search hit returned by Genius.
 */
interface GeniusSearchHit {
  /**
   * Relative Genius path used to fetch the song page.
   */
  path: string
}

/**
 * Minimal `songPage` payload used by this lyrics provider.
 */
interface GeniusSongPage {
  /**
   * Lyrics body container rendered by Genius.
   */
  lyricsData: {
    /**
     * HTML lyrics body rendered by Genius.
     */
    body: {
      /**
       * Raw lyrics HTML.
       */
      html: string | null
    } | null
  } | null
}

/**
 * Minimal preloaded-state payload used by this lyrics provider.
 */
interface GeniusPreloadedState {
  /**
   * Song page metadata embedded in the Genius HTML.
   */
  songPage: GeniusSongPage | null
}

/**
 * Minimal runtime shape accepted by the Genius lyrics provider.
 */
type GeniusNodeLink = object

/**
 * Removes common video and marketing fragments from titles or authors.
 *
 * @param text - Raw title or author text.
 * @returns Sanitized text used for Genius search.
 */
function cleanMetadata(text: string): string {
  let result = text

  for (const pattern of CLEAN_PATTERNS) {
    result = result.replace(pattern, '')
  }

  return result.trim()
}

/**
 * Reads a named property from a JSON record while preserving index-signature
 * compatibility with the project's strict compiler settings.
 *
 * @param record - JSON object previously narrowed by {@link getRecordFromValue}.
 * @param key - Property name to retrieve.
 * @returns Raw JSON value stored under the requested key, if present.
 */
function getRecordValue(
  record: JsonRecord | null,
  key: string
): JsonValue | undefined {
  return record?.[key]
}

/**
 * Extracts a record from a JSON-compatible value.
 *
 * @param value - Candidate JSON value.
 * @returns Record view when the value is object-like, otherwise `null`.
 */
function getRecordFromValue(value: JsonValue | undefined): JsonRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }

  return value
}

/**
 * Extracts a string from a JSON-compatible value.
 *
 * @param value - Candidate JSON value.
 * @returns String value when present, otherwise `null`.
 */
function getString(value: JsonValue | undefined): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * Extracts an array from a JSON-compatible value.
 *
 * @param value - Candidate JSON value.
 * @returns Array value when present, otherwise `null`.
 */
function getArray(value: JsonValue | undefined): JsonValue[] | null {
  return Array.isArray(value) ? value : null
}

/**
 * Converts a caught failure into a log-safe message.
 *
 * @param error - Caught runtime failure or helper error text.
 * @returns Human-readable message for logs and API errors.
 */
function getErrorMessage(error: Error | string): string {
  return error instanceof Error ? error.message : error
}

/**
 * Genius lyrics provider.
 */
export default class GeniusLyrics {
  /**
   * Runtime container passed by the lyrics manager.
   */
  public readonly nodelink: GeniusNodeLink

  /**
   * Creates a new Genius lyrics provider instance.
   *
   * @param nodelink - Runtime container passed by the lyrics manager.
   */
  public constructor(nodelink: GeniusNodeLink) {
    this.nodelink = nodelink
  }

  /**
   * Initializes the Genius lyrics provider.
   *
   * Genius does not require boot-time authentication or cache warmup.
   *
   * @returns `true` because the provider is immediately ready.
   */
  public async setup(): Promise<boolean> {
    return true
  }

  /**
   * Builds the Genius search query from the incoming track metadata.
   *
   * @param trackInfo - Minimal decoded track metadata from the player.
   * @returns Sanitized Genius search query plus the cleaned title/author.
   */
  private buildSearchQuery(trackInfo: TrackInfo): {
    query: string
    title: string
    author: string
  } {
    const title = cleanMetadata(trackInfo.title)
    const author = cleanMetadata(trackInfo.author)
    const query =
      author.length > 0 && !title.toLowerCase().startsWith(author.toLowerCase())
        ? `${title} ${author}`
        : title

    return { query, title, author }
  }

  /**
   * Extracts the first usable song hit from the Genius search payload.
   *
   * @param body - Parsed or raw HTTP body returned by the request helper.
   * @returns First song hit path when present, otherwise `null`.
   */
  private extractSearchHitPath(
    body: string | JsonValue | JsonValue[] | null | undefined
  ): string | null {
    const payload =
      typeof body === 'string' ? (JSON.parse(body) as JsonValue) : body
    const rootRecord = getRecordFromValue(payload ?? undefined)
    const responseRecord = getRecordFromValue(
      getRecordValue(rootRecord, 'response')
    )
    const sections = getArray(getRecordValue(responseRecord, 'sections'))

    if (!sections) {
      return null
    }

    for (const sectionValue of sections) {
      const sectionRecord = getRecordFromValue(sectionValue)
      const type = getString(getRecordValue(sectionRecord, 'type'))

      if (type !== 'song') {
        continue
      }

      const hits = getArray(getRecordValue(sectionRecord, 'hits'))
      if (!hits || hits.length === 0) {
        continue
      }

      const firstHit = getRecordFromValue(hits[0])
      const resultRecord = getRecordFromValue(
        getRecordValue(firstHit, 'result')
      )
      const path = getString(getRecordValue(resultRecord, 'path'))

      if (path) {
        const hit: GeniusSearchHit = { path }
        return hit.path
      }
    }

    return null
  }

  /**
   * Extracts the embedded Genius preloaded state from the song page HTML.
   *
   * The HTML stores the payload inside `JSON.parse(...)` with escaped content.
   * Executing that expression is more reliable than manually unescaping the
   * string, which is why this provider uses the same strategy as the migrated
   * Genius source.
   *
   * @param html - Raw Genius song page HTML.
   * @returns Narrowed preloaded state or `null` when the payload cannot be parsed.
   */
  private extractPreloadedState(html: string): GeniusPreloadedState | null {
    const scriptMatch = html.match(PRELOADED_STATE_REGEX)
    const jsonParseArgument = scriptMatch?.[1]

    if (!jsonParseArgument) {
      return null
    }

    try {
      const parseFunction = new Function(
        `return JSON.parse(${jsonParseArgument})`
      ) as () => JsonValue
      const payload = parseFunction()
      return this.toPreloadedState(payload)
    } catch (error) {
      const message = getErrorMessage(
        error instanceof Error ? error : String(error)
      )
      logger('debug', 'Lyrics', `Failed to parse Genius page state: ${message}`)
      return null
    }
  }

  /**
   * Narrows an arbitrary parsed value to the minimal Genius preloaded-state
   * shape used by this lyrics provider.
   *
   * @param value - Parsed payload returned from the embedded `JSON.parse(...)`.
   * @returns Narrowed Genius preloaded state or `null` when the payload shape
   * does not contain the expected lyrics HTML.
   */
  private toPreloadedState(value: JsonValue): GeniusPreloadedState | null {
    const rootRecord = getRecordFromValue(value)
    const songPageRecord = getRecordFromValue(
      getRecordValue(rootRecord, 'songPage')
    )
    const lyricsDataRecord = getRecordFromValue(
      getRecordValue(songPageRecord, 'lyricsData')
    )
    const bodyRecord = getRecordFromValue(
      getRecordValue(lyricsDataRecord, 'body')
    )
    const lyricsHtml = getString(getRecordValue(bodyRecord, 'html'))

    return {
      songPage: {
        lyricsData: {
          body: {
            html: lyricsHtml
          }
        }
      }
    }
  }

  /**
   * Decodes the limited subset of HTML entities commonly found in Genius lyrics.
   *
   * @param text - Raw HTML-stripped lyric text.
   * @returns Human-readable lyric text.
   */
  private decodeHtmlEntities(text: string): string {
    return text.replace(HTML_ENTITY_REGEX, (entity) => {
      switch (entity.toLowerCase()) {
        case '&amp;':
          return '&'
        case '&quot;':
          return '"'
        case '&apos;':
        case '&#39;':
        case '&#x27;':
          return "'"
        case '&lt;':
          return '<'
        case '&gt;':
          return '>'
        default:
          return entity
      }
    })
  }

  /**
   * Converts Genius lyrics HTML into the unified unsynced lyrics line format.
   *
   * @param lyricsHtml - Raw Genius lyrics HTML.
   * @returns Non-empty lyric lines with zeroed timing metadata.
   */
  private parseLyricsLines(lyricsHtml: string): LyricsLine[] {
    return lyricsHtml
      .replace(BREAK_TAG_REGEX, '\n')
      .replace(HTML_TAG_REGEX, '')
      .split('\n')
      .map((line) => this.decodeHtmlEntities(line).trim())
      .filter((line) => line.length > 0)
      .map(
        (text): LyricsLine => ({
          text,
          time: 0,
          duration: 0
        })
      )
  }

  /**
   * Fetches lyrics for a decoded track using Genius search plus the song page.
   *
   * The provider first searches Genius for the best song page, then extracts
   * the embedded preloaded state, and finally converts the lyrics HTML into
   * the manager's unified line structure.
   *
   * @param trackInfo - Minimal decoded track metadata from the player.
   * @returns Lyrics payload, empty result, or structured error response.
   */
  public async getLyrics(trackInfo: TrackInfo): Promise<LyricsResult> {
    const { query } = this.buildSearchQuery(trackInfo)

    logger('debug', 'Lyrics', `Searching Genius for: ${query}`)

    try {
      const searchResponse = await makeRequest(
        `https://genius.com/api/search/multi?q=${encodeURIComponent(query)}`,
        {
          method: 'GET',
          headers: { ...GENIUS_HEADERS }
        }
      )

      if (searchResponse.error) {
        throw new Error(searchResponse.error)
      }

      if (searchResponse.statusCode !== 200) {
        throw new Error(
          `Unexpected Genius search status code: ${searchResponse.statusCode}`
        )
      }

      const songPath = this.extractSearchHitPath(
        searchResponse.body as
          | string
          | JsonValue
          | JsonValue[]
          | null
          | undefined
      )

      if (!songPath) {
        return { loadType: 'empty', data: {} }
      }

      const songPageResponse = await makeRequest(
        `https://genius.com${songPath}`,
        {
          method: 'GET',
          headers: { ...GENIUS_HEADERS }
        }
      )

      if (songPageResponse.error) {
        throw new Error(songPageResponse.error)
      }

      if (songPageResponse.statusCode !== 200) {
        throw new Error(
          `Unexpected Genius page status code: ${songPageResponse.statusCode}`
        )
      }

      const songPageHtml =
        typeof songPageResponse.body === 'string' ? songPageResponse.body : ''
      const preloadedState = this.extractPreloadedState(songPageHtml)
      const lyricsHtml = preloadedState?.songPage?.lyricsData?.body?.html

      if (!lyricsHtml) {
        return { loadType: 'empty', data: {} }
      }

      const lines = this.parseLyricsLines(lyricsHtml)

      if (lines.length === 0) {
        return { loadType: 'empty', data: {} }
      }

      return {
        loadType: 'lyrics',
        data: {
          name: 'original',
          synced: false,
          lines
        }
      }
    } catch (error) {
      const message = getErrorMessage(
        error instanceof Error ? error : String(error)
      )

      logger(
        'error',
        'Lyrics',
        `Failed to fetch lyrics from Genius: ${message}`
      )

      return {
        loadType: 'error',
        data: {
          message,
          severity: 'fault'
        }
      }
    }
  }
}
