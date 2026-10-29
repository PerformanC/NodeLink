import { PassThrough, pipeline } from 'node:stream'
import { BROWSER_USER_AGENT } from '../constants.ts'
import type {
  BandcampApiSearchResponse,
  BandcampJsonLdData,
  BandcampPlaylistTrack,
  BandcampPlaylistTracklist,
  BandcampTrackBuildInput,
  BandcampTralbumData,
  BandcampTralbumTrack
} from '../typings/sources/bandcamp.types.ts'
import type {
  PlaylistData,
  SourceResult,
  TrackData,
  TrackInfo,
  TrackStreamResult,
  TrackUrlResult,
  WorkerNodeLink
} from '../typings/sources/source.types.ts'
import type {
  HttpRequestResult,
  TrackEncodeInput
} from '../typings/utils.types.ts'
import { capTotalTracks, encodeTrack, logger, makeRequest } from '../utils.ts'

const BANDCAMP_BASE_URL = 'https://bandcamp.com'
const BANDCAMP_SEARCH_API_URL = `${BANDCAMP_BASE_URL}/api/bcsearch_public_api/1/autocomplete_elastic`
export const BANDCAMP_TRACK_PATTERN =
  /^https?:\/\/([^/]+)\.bandcamp\.com\/(track|album)\/([^/?]+)/
export const BANDCAMP_PLAYLIST_PATTERN =
  /^https?:\/\/(?:www\.)?bandcamp\.com\/([^/?#]+)\/playlist\/([^/?#]+)/
const BANDCAMP_PLAYER_API_PATH = '/api/player/2/player_data_web'
const PLAYLIST_BLOB_ATTRIBUTE_REGEX = /\sdata-blob="([^"]*)"/
const PLAYLIST_PAGE_TAG_REGEX = /<[a-z][^>]*\sid="PlaylistPage"[^>]*>/i
const PLAYLIST_MAX_PAGES = 50
const DEFAULT_MAX_PLAYLIST_LENGTH = 100
const _STREAM_URL_REGEX = /https?:\/\/t4\.bcbits\.com\/stream\/[^"'\\&\s]+/
const TRALBUM_REGEX = /data-tralbum="([^"]*(?:"[^"]*)*?)"/
const JSON_LD_REGEX =
  /<script\s+type="application\/ld\+json"\s*>([\s\S]*?)<\/script>/

/**
 * Markers of Bandcamp's edge bot-challenge page. The challenge is served with
 * HTTP 200, so a status check alone cannot detect it.
 */
const CHALLENGE_PAGE_MARKERS = ['<title>Client Challenge</title>', '/_fs-ch-']
const PAGE_FETCH_MAX_ATTEMPTS = 3
const PAGE_FETCH_RETRY_DELAY_MS = 1000

/**
 * Outcome of a Bandcamp page download.
 */
type BandcampPageResult =
  | { ok: true; page: string }
  | {
      ok: false
      reason: 'challenge' | 'http' | 'unreadable'
      message: string
      statusCode?: number
      page?: string
    }

/**
 * Bandcamp source implementation.
 */
export default class BandcampSource {
  /**
   * Shared worker runtime provided by the source manager.
   */
  public readonly nodelink: WorkerNodeLink

  /**
   * Base Bandcamp URL used for search requests.
   */
  public readonly baseUrl = BANDCAMP_BASE_URL

  /**
   * URL patterns supported by this source.
   */
  public readonly patterns: RegExp[] = [
    BANDCAMP_TRACK_PATTERN,
    BANDCAMP_PLAYLIST_PATTERN
  ]

  /**
   * Search prefixes routed to this source.
   */
  public readonly searchTerms = ['bcsearch']

  /**
   * Source priority used for URL matching.
   */
  public readonly priority = 90

  /**
   * Creates a Bandcamp source bound to the worker runtime.
   *
   * @param nodelink Worker runtime shared with all sources.
   */
  public constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
  }

  /**
   * Announces the Bandcamp source during worker initialization.
   *
   * @returns `true` when the source is ready to accept requests.
   */
  public async setup(): Promise<boolean> {
    logger('info', 'Sources', 'Loaded BandCamp source.')
    return true
  }

  /**
   * Checks whether a URL matches one of the Bandcamp patterns.
   *
   * @param link Candidate URL provided by the source manager.
   * @returns `true` when the URL belongs to a supported Bandcamp page.
   */
  public isLinkMatch(link: string): boolean {
    return this.patterns.some((pattern) => pattern.test(link))
  }

  /**
   * Searches Bandcamp track results using the internal JSON search API.
   *
   * The previous HTML-scraping approach broke because `bandcamp.com/search`
   * now returns a client-challenge page that requires JavaScript.  The
   * internal autocomplete API used by the Bandcamp frontend returns
   * structured JSON and does not require authentication.
   *
   * @param query Search string received from the API or unified search flow.
   * @returns Search results, an empty payload, or a structured exception.
   */
  public async search(query: string): Promise<SourceResult> {
    try {
      const request = await makeRequest(BANDCAMP_SEARCH_API_URL, {
        method: 'POST',
        disableBodyCompression: true,
        body: {
          search_text: query,
          search_filter: 't',
          full_page: true,
          fan_id: null
        }
      })

      if (request.error || request.statusCode !== 200) {
        return {
          loadType: 'error',
          exception: {
            message:
              request.error ??
              `BandCamp search API returned status ${request.statusCode}.`,
            severity: 'fault',
            cause: 'Request Failed'
          }
        }
      }

      const response = this.getJsonBody<BandcampApiSearchResponse>(request.body)

      if (!response?.auto?.results || response.auto.results.length === 0) {
        logger(
          'debug',
          'Sources',
          `No results found on BandCamp for: "${query}"`
        )
        return { loadType: 'empty', data: {} }
      }

      const tracks: TrackData[] = []
      const maxResults = this.getMaxSearchResults()

      for (const item of response.auto.results) {
        if (tracks.length >= maxResults) break

        if (!item.name || !item.item_url_path) continue

        tracks.push(
          this.buildTrack({
            identifier: item.id != null ? String(item.id) : null,
            title: item.name,
            author: item.band_name || null,
            uri: item.item_url_path,
            artworkUrl: item.art_id
              ? this.createArtworkUrl(item.art_id)
              : (item.img ?? null)
          })
        )
      }

      if (tracks.length === 0) {
        logger(
          'warn',
          'Sources',
          'Search results found on BandCamp, but no tracks could be parsed.'
        )
        return { loadType: 'empty', data: {} }
      }

      logger(
        'debug',
        'Sources',
        `Found ${tracks.length} tracks on BandCamp for: "${query}"`
      )
      return { loadType: 'search', data: tracks }
    } catch (error) {
      return this.createSourceException(
        error instanceof Error ? error.message : 'BandCamp search failed.',
        'fault',
        'Exception'
      )
    }
  }

  /**
   * Resolves a Bandcamp track or album URL into a track or playlist payload.
   *
   * Uses `data-tralbum` as the primary metadata source and enriches with
   * JSON-LD structured data (ISRC, duration, artwork) when available.
   *
   * @param url Canonical Bandcamp URL to resolve.
   * @returns A track, playlist, empty result, or a structured exception.
   */
  public async resolve(url: string): Promise<SourceResult> {
    try {
      if (BANDCAMP_PLAYLIST_PATTERN.test(url)) {
        return await this.resolvePlaylist(url)
      }

      const pageData = await this.fetchPageData(url)
      if (!pageData) {
        logger('warn', 'Sources', `Failed to fetch BandCamp page for: ${url}`)
        return { loadType: 'empty', data: {} }
      }

      if (pageData.challenged) {
        return {
          loadType: 'error',
          exception: {
            message:
              'BandCamp served a bot challenge page instead of the track page.',
            severity: 'fault',
            cause: 'Bot Challenge'
          }
        }
      }

      const { tralbum, jsonLd } = pageData

      if (!tralbum?.trackinfo || tralbum.trackinfo.length === 0) {
        logger(
          'warn',
          'Sources',
          `No 'tralbum' data found on BandCamp for: ${url}`
        )
        return { loadType: 'empty', data: {} }
      }

      const artworkUrl =
        this.createArtworkUrl(tralbum.art_id) ??
        (typeof jsonLd?.image === 'string' ? jsonLd.image : null)
      const author =
        this.normalizeText(tralbum.artist) ??
        this.normalizeText(jsonLd?.byArtist?.name) ??
        'Unknown Artist'
      const pageIsrc = tralbum.current?.isrc ?? jsonLd?.isrcCode ?? null

      if (tralbum.trackinfo.length > 1) {
        const tracks: TrackData[] = []

        for (const item of tralbum.trackinfo) {
          const trackUrl = item.title_link
            ? this.buildAbsoluteTrackUrl(item.title_link, url)
            : null

          if (!trackUrl) continue

          tracks.push(
            this.buildTrack({
              identifier: this.getTrackIdentifier(item, trackUrl),
              isSeekable: true,
              author,
              length: this.toDurationMilliseconds(item.duration),
              isStream: false,
              title: this.normalizeText(item.title),
              uri: trackUrl,
              artworkUrl
            })
          )
        }

        if (tracks.length === 0) {
          return { loadType: 'empty', data: {} }
        }

        const playlist: PlaylistData = {
          info: {
            name:
              this.normalizeText(tralbum.current?.title) ?? 'BandCamp Playlist',
            selectedTrack: 0
          },
          pluginInfo: {} as Record<string, unknown>,
          tracks
        }

        return { loadType: 'playlist', data: playlist }
      }

      const trackData = tralbum.trackinfo[0]
      if (!trackData) {
        return { loadType: 'empty', data: {} }
      }

      const track = this.buildTrack({
        identifier: this.getTrackIdentifier(trackData, url),
        isSeekable: true,
        author,
        length:
          this.toDurationMilliseconds(trackData.duration) ??
          this.parseIsoDuration(jsonLd?.duration),
        isStream: false,
        title: this.normalizeText(trackData.title),
        uri: url,
        artworkUrl,
        isrc: pageIsrc
      })

      return { loadType: 'track', data: track }
    } catch (error) {
      return this.createSourceException(
        error instanceof Error ? error.message : 'BandCamp resolve failed.',
        'fault',
        'Exception'
      )
    }
  }

  /**
   * Extracts the direct Bandcamp MP3 stream URL from a track page.
   *
   * When possible, the stream URL is extracted directly from the
   * `data-tralbum` payload to avoid an additional HTTP round-trip.
   * Falls back to a regex scan of the full page body when the structured
   * extraction does not yield a URL.
   *
   * @param track Decoded track information produced by the source manager.
   * @returns A direct stream URL descriptor or a structured exception.
   */
  public async getTrackUrl(
    track: TrackInfo
  ): Promise<
    | (TrackUrlResult & { url: string; protocol: 'https'; format: 'mp3' })
    | SourceResult
  > {
    try {
      const result = await this.fetchPageHtml(track.uri)

      if (!result.ok) {
        const exception =
          result.reason === 'challenge'
            ? {
                message:
                  'BandCamp served a bot challenge page instead of the track page.',
                severity: 'fault' as const,
                cause: 'Bot Challenge'
              }
            : result.reason === 'unreadable'
              ? {
                  message: 'BandCamp returned an unreadable track page.',
                  severity: 'fault' as const,
                  cause: 'Invalid Response'
                }
              : {
                  message: result.message.replace(
                    'Failed to fetch BandCamp page',
                    'Failed to fetch track page'
                  ),
                  severity: 'fault' as const,
                  cause: 'Request Failed'
                }
        return { loadType: 'error', exception }
      }

      const page = result.page

      // Try extracting stream URL from the structured tralbum data first.
      const streamUrl = this.extractStreamUrlFromPage(page, track.identifier)

      if (!streamUrl) {
        return {
          loadType: 'error',
          exception: {
            message: 'No stream URL was found in the page content.',
            severity: 'fault',
            cause: 'Stream Extraction Failed'
          }
        }
      }

      return {
        url: streamUrl,
        protocol: 'https',
        format: 'mp3'
      }
    } catch (error) {
      return {
        loadType: 'error',
        exception: {
          message:
            error instanceof Error
              ? error.message
              : 'BandCamp stream extraction failed.',
          severity: 'fault',
          cause: 'Stream Extraction Failed'
        }
      }
    }
  }

  /**
   * Opens the resolved Bandcamp audio stream for playback.
   *
   * @param decodedTrack Decoded track used only for logging context.
   * @param url Direct playback URL returned by `getTrackUrl`.
   * @returns A readable stream or a structured exception.
   */
  public async loadStream(
    decodedTrack: TrackInfo,
    url: string
  ): Promise<TrackStreamResult | SourceResult> {
    logger(
      'debug',
      'Sources',
      `Loading BandCamp stream for "${decodedTrack.title}"`
    )

    try {
      const response = await makeRequest(url, {
        method: 'GET',
        streamOnly: true,
        headers: {
          Referer: decodedTrack.uri
        }
      })

      if (response.error || response.statusCode !== 200 || !response.stream) {
        return {
          loadType: 'error',
          exception: {
            message:
              response.error ??
              `BandCamp returned an invalid stream status: ${response.statusCode}`,
            severity: 'common',
            cause: 'Upstream'
          }
        }
      }

      const stream = new PassThrough()
      stream.once('close', () => {
        ;(response.stream as { destroy?: () => void }).destroy?.()
      })
      pipeline(
        response.stream,
        stream,
        (error: NodeJS.ErrnoException | null) => {
          if (error && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
            logger(
              'error',
              'Sources',
              `BandCamp stream error: ${error.message}`
            )
          }
        }
      )

      return { stream }
    } catch (error) {
      logger(
        'error',
        'Sources',
        `Failed to load BandCamp stream: ${error instanceof Error ? error.message : 'unknown error'}`
      )
      return {
        loadType: 'error',
        exception: {
          message:
            error instanceof Error
              ? error.message
              : 'Failed to load BandCamp stream.',
          severity: 'common',
          cause: 'Upstream'
        }
      }
    }
  }

  /**
   * Resolves a Bandcamp playlist page (`bandcamp.com/<fan>/playlist/<slug>`).
   *
   * The first page of tracks is embedded in the `data-blob` attribute of the
   * `#PlaylistPage` element; the remainder is loaded through the player API
   * with the opaque `nextCursor` each page returns. Collection stops at
   * `playback.maxPlaylistLength`. Stream URLs in the payload are signed and
   * expire, so only track URLs are kept; `getTrackUrl` fetches fresh ones.
   *
   * @param url Playlist URL.
   * @returns A playlist, an empty result, or a structured exception.
   */
  private async resolvePlaylist(url: string): Promise<SourceResult> {
    const pageResult = await this.fetchPageHtml(url)

    if (!pageResult.ok) {
      if (pageResult.reason === 'challenge') {
        return {
          loadType: 'error',
          exception: {
            message:
              'BandCamp served a bot challenge page instead of the playlist page.',
            severity: 'fault',
            cause: 'Bot Challenge'
          }
        }
      }

      logger('warn', 'Sources', `Failed to fetch BandCamp playlist: ${url}`)
      return { loadType: 'empty', data: {} }
    }

    const firstPage = this.parsePlaylistBlob(pageResult.page)
    if (!firstPage) {
      logger('warn', 'Sources', `No playlist data found on BandCamp: ${url}`)
      return { loadType: 'empty', data: {} }
    }

    const max = this.getMaxPlaylistLength()
    const origin = new URL(url).origin
    const collected: BandcampPlaylistTrack[] = []
    const seen = new Set<string | number>()

    const addTracks = (items?: BandcampPlaylistTrack[]): void => {
      for (const item of items ?? []) {
        if (!item?.url || item.isStreamingDisabled || seen.has(item.id)) {
          continue
        }
        seen.add(item.id)
        collected.push(item)
      }
    }

    addTracks(firstPage.tracks)

    let cursor = firstPage.nextCursor
    for (
      let page = 1;
      cursor != null && collected.length < max && page < PLAYLIST_MAX_PAGES;
      page++
    ) {
      const next = await this.fetchPlaylistPage(origin, firstPage, cursor)
      if (!next?.tracks?.length) break

      addTracks(next.tracks)

      if (next.nextCursor == null || next.nextCursor === cursor) break
      cursor = next.nextCursor
    }

    const tracks = collected.slice(0, max).map((item) =>
      this.buildTrack({
        identifier: String(item.id),
        isSeekable: true,
        author: this.normalizeText(item.artistName),
        length: this.toDurationMilliseconds(item.duration),
        isStream: false,
        title: this.normalizeText(item.title),
        uri: item.url,
        artworkUrl: this.createArtworkUrl(item.artId)
      })
    )

    if (tracks.length === 0) {
      return { loadType: 'empty', data: {} }
    }

    const total = firstPage.tracksSummary?.totalCount ?? collected.length
    if (total > tracks.length) {
      logger(
        'debug',
        'Sources',
        `BandCamp playlist has ${total} tracks; returning ${tracks.length}.`
      )
    }

    return {
      loadType: 'playlist',
      data: {
        info: {
          name: this.normalizeText(firstPage.title) ?? 'Unknown Playlist',
          selectedTrack: 0
        },
        pluginInfo: {
          type: 'playlist',
          identifier: String(firstPage.itemId),
          url: firstPage.itemUrl ?? url,
          artworkUrl: this.createArtworkUrl(firstPage.imageId),
          author: this.normalizeText(firstPage.attribution?.name),
          totalTracks: capTotalTracks(total, max)
        },
        tracks
      }
    }
  }

  /**
   * Extracts the playlist tracklist from the `data-blob` attribute of the
   * `#PlaylistPage` element. The attribute can sit on a multi-line tag, so the
   * element is located first and the first `data-blob` on the page is only a
   * fallback.
   *
   * @param page Playlist page HTML.
   * @returns The tracklist, or `null` when it is missing or malformed.
   */
  private parsePlaylistBlob(page: string): BandcampPlaylistTracklist | null {
    const tag = page.match(PLAYLIST_PAGE_TAG_REGEX)?.[0]
    const raw =
      (tag ? tag.match(PLAYLIST_BLOB_ATTRIBUTE_REGEX)?.[1] : undefined) ??
      page.match(PLAYLIST_BLOB_ATTRIBUTE_REGEX)?.[1]
    if (!raw) return null

    try {
      const blob = JSON.parse(this.decodeHtmlEntities(raw)) as {
        appData?: { tracklist?: BandcampPlaylistTracklist }
      }
      const tracklist = blob.appData?.tracklist
      return tracklist && Array.isArray(tracklist.tracks) ? tracklist : null
    } catch {
      return null
    }
  }

  /**
   * Loads a further page of playlist tracks from the player API.
   *
   * @param origin Site origin of the playlist URL.
   * @param tracklist First-page tracklist, for the item type and ID.
   * @param cursor Opaque cursor returned by the previous page.
   * @returns The next page, or `null` when the request failed.
   */
  private async fetchPlaylistPage(
    origin: string,
    tracklist: BandcampPlaylistTracklist,
    cursor: number | string
  ): Promise<BandcampPlaylistTracklist | null> {
    try {
      const response = await makeRequest(
        `${origin}${BANDCAMP_PLAYER_API_PATH}`,
        {
          method: 'POST',
          disableBodyCompression: true,
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'User-Agent': BROWSER_USER_AGENT
          },
          body: {
            item_type: tracklist.itemType,
            item_id: tracklist.itemId,
            next_cursor: cursor
          }
        }
      )

      if (response.error || response.statusCode !== 200) {
        logger(
          'warn',
          'Sources',
          `BandCamp playlist page request failed: ${response.error ?? response.statusCode}`
        )
        return null
      }

      const json = this.getJsonBody<
        BandcampPlaylistTracklist & { tracklist?: BandcampPlaylistTracklist }
      >(response.body)

      return json?.tracklist ?? json ?? null
    } catch (error) {
      logger(
        'warn',
        'Sources',
        `BandCamp playlist page request threw: ${error instanceof Error ? error.message : String(error)}`
      )
      return null
    }
  }

  private getMaxPlaylistLength(): number {
    const limit = this.nodelink.options.playback?.maxPlaylistLength

    return typeof limit === 'number' && Number.isInteger(limit) && limit > 0
      ? limit
      : DEFAULT_MAX_PLAYLIST_LENGTH
  }

  /**
   * Fetches a Bandcamp page and extracts both `data-tralbum` and JSON-LD data.
   *
   * @param url Bandcamp track or album URL.
   * @returns Parsed page metadata, `challenged: true` when Bandcamp kept
   * serving its bot-challenge page after all retries, or `null` when the
   * request failed.
   */
  public async fetchPageData(url: string): Promise<{
    tralbum: BandcampTralbumData | null
    jsonLd: BandcampJsonLdData | null
    rawPage: string
    challenged?: boolean
  } | null> {
    const result = await this.fetchPageHtml(url)

    if (!result.ok) {
      if (result.reason === 'challenge') {
        return {
          tralbum: null,
          jsonLd: null,
          rawPage: result.page ?? '',
          challenged: true
        }
      }
      return null
    }

    const tralbum = this.parseTralbumFromPage(result.page)
    const jsonLd = this.parseJsonLdFromPage(result.page)

    return { tralbum, jsonLd, rawPage: result.page }
  }

  /**
   * Downloads a Bandcamp page, detecting the edge bot-challenge page (served
   * with HTTP 200) and retrying with a short linear backoff when it, a 429, or
   * a 5xx response is received.
   *
   * @param url Bandcamp page URL.
   * @returns The page HTML, or a description of why it could not be fetched.
   */
  private async fetchPageHtml(url: string): Promise<BandcampPageResult> {
    let lastFailure: BandcampPageResult = {
      ok: false,
      reason: 'http',
      message: 'BandCamp page request was not attempted.'
    }

    for (let attempt = 1; attempt <= PAGE_FETCH_MAX_ATTEMPTS; attempt++) {
      const { body, error, statusCode, headers } = await makeRequest(url, {
        method: 'GET',
        headers: { 'User-Agent': BROWSER_USER_AGENT }
      })

      let retryable = false

      if (error || statusCode !== 200) {
        logger(
          'error',
          'Sources',
          `Failed to fetch BandCamp page: ${error ?? statusCode}`
        )
        lastFailure = {
          ok: false,
          reason: 'http',
          message: `Failed to fetch BandCamp page: ${error ?? statusCode}`,
          statusCode
        }
        retryable =
          !error &&
          statusCode !== undefined &&
          (statusCode === 429 || statusCode >= 500)
      } else {
        const page = this.getResponseText({ body })

        if (page === null) {
          return {
            ok: false,
            reason: 'unreadable',
            message: 'BandCamp returned an unreadable page.',
            statusCode
          }
        }

        if (CHALLENGE_PAGE_MARKERS.some((marker) => page.includes(marker))) {
          const servedBy = headers?.['x-served-by']
          logger(
            'warn',
            'Sources',
            `BandCamp served a bot challenge for ${url} (attempt ${attempt}/${PAGE_FETCH_MAX_ATTEMPTS}, x-served-by: ${Array.isArray(servedBy) ? servedBy.join(', ') : (servedBy ?? 'unknown')}).`
          )
          lastFailure = {
            ok: false,
            reason: 'challenge',
            message: 'BandCamp served a bot challenge page.',
            statusCode,
            page
          }
          retryable = true
        } else {
          return { ok: true, page }
        }
      }

      if (!retryable || attempt === PAGE_FETCH_MAX_ATTEMPTS) break

      await new Promise((resolve) =>
        setTimeout(resolve, PAGE_FETCH_RETRY_DELAY_MS * attempt)
      )
    }

    return lastFailure
  }

  /**
   * Converts parsed Bandcamp metadata into an encoded track payload.
   *
   * @param partialInfo Track fields collected from search or page resolution.
   * @returns An encoded track entry compatible with the source manager.
   */
  public buildTrack(partialInfo: BandcampTrackBuildInput): TrackData {
    const track: TrackEncodeInput & TrackInfo = {
      identifier:
        partialInfo.identifier?.trim() ||
        this.getIdentifierFromUrl(partialInfo.uri),
      isSeekable: partialInfo.isSeekable ?? true,
      author: partialInfo.author?.trim() || 'Unknown Artist',
      length: partialInfo.length ?? -1,
      isStream: partialInfo.isStream ?? false,
      position: 0,
      title: partialInfo.title?.trim() || 'Unknown Title',
      uri: partialInfo.uri,
      artworkUrl: partialInfo.artworkUrl,
      isrc: partialInfo.isrc ?? null,
      sourceName: 'bandcamp',
      details: []
    }

    return {
      encoded: encodeTrack(track),
      info: track,
      pluginInfo: {} as Record<string, unknown>
    }
  }

  /**
   * Derives a stable identifier from a Bandcamp URL.
   *
   * @param url Bandcamp track or album URL.
   * @returns A hostname-and-slug identifier, or the URL itself as fallback.
   */
  public getIdentifierFromUrl(url: string): string {
    const match = url.match(BANDCAMP_TRACK_PATTERN)
    return match ? `${match[1]}:${match[3]}` : url
  }

  /**
   * Parses the `data-tralbum` JSON payload from a Bandcamp page body.
   *
   * @param page Full HTML page body.
   * @returns Parsed tralbum data, or `null` when not found or invalid.
   */
  private parseTralbumFromPage(page: string): BandcampTralbumData | null {
    const match = page.match(TRALBUM_REGEX)
    if (!match?.[1]) return null

    try {
      const decoded = this.decodeHtmlEntities(match[1])
      return JSON.parse(decoded) as BandcampTralbumData
    } catch (error) {
      logger(
        'warn',
        'Sources',
        `Failed to parse BandCamp tralbum payload: ${error instanceof Error ? error.message : 'invalid JSON'}`
      )
      return null
    }
  }

  /**
   * Parses the JSON-LD `MusicRecording` block from a Bandcamp page body.
   *
   * @param page Full HTML page body.
   * @returns Parsed JSON-LD data, or `null` when not found or invalid.
   */
  private parseJsonLdFromPage(page: string): BandcampJsonLdData | null {
    const match = page.match(JSON_LD_REGEX)
    if (!match?.[1]) return null

    try {
      return JSON.parse(match[1].trim()) as BandcampJsonLdData
    } catch {
      return null
    }
  }

  /**
   * Extracts the MP3 stream URL from a Bandcamp page body.
   *
   * Tries the structured `data-tralbum` `trackinfo[].file["mp3-128"]` field
   * first, then falls back to a regex scan for a `t4.bcbits.com/stream` URL.
   */
  private extractStreamUrlFromPage(
    page: string,
    trackId?: string
  ): string | null {
    // Try structured extraction from tralbum first.
    const tralbum = this.parseTralbumFromPage(page)
    if (tralbum?.trackinfo) {
      // Find the specific track if an ID is provided, otherwise default to the first
      const trackData = trackId
        ? tralbum.trackinfo.find(
            (t) => String(t.track_id) === trackId || String(t.id) === trackId
          ) || tralbum.trackinfo[0]
        : tralbum.trackinfo[0]

      if (trackData?.file) {
        const mp3Url = trackData.file['mp3-128']
        if (mp3Url) {
          return this.decodeHtmlEntities(mp3Url)
        }
      }
    }

    // Fallback: regex scan of the full page.
    const decodedPage = this.decodeHtmlEntities(page)
    // Fix: The regex must allow `&` to capture the token parameters.
    const streamUrlMatch = decodedPage.match(
      /https?:\/\/t4\.bcbits\.com\/stream\/[^"'\s]+/
    )
    return streamUrlMatch ? streamUrlMatch[0] : null
  }

  /**
   * Converts an HTTP helper response body into UTF-8 text.
   *
   * @param response HTTP helper response containing a buffered body.
   * @returns The normalized text body, or `null` when the payload is not text-like.
   */
  private getResponseText(
    response: Pick<HttpRequestResult, 'body'>
  ): string | null {
    if (typeof response.body === 'string') {
      return response.body
    }

    if (Buffer.isBuffer(response.body)) {
      return response.body.toString('utf8')
    }

    return null
  }

  /**
   * Safely parses a JSON body from an HTTP response.
   *
   * @param body Raw response body from the HTTP helper.
   * @returns The parsed JSON object, or `null` when parsing fails.
   */
  private getJsonBody<T>(body: HttpRequestResult['body']): T | null {
    if (
      body !== null &&
      body !== undefined &&
      typeof body === 'object' &&
      !Buffer.isBuffer(body)
    ) {
      return body as T
    }

    const text = this.getResponseText({ body })
    if (text === null) return null

    try {
      return JSON.parse(text) as T
    } catch {
      return null
    }
  }

  /**
   * Decodes HTML entities commonly found in Bandcamp page attributes and
   * JSON payloads embedded in HTML.
   *
   * Handles named entities, decimal numeric entities, and hexadecimal
   * numeric entities.
   *
   * @param value Raw HTML fragment or encoded attribute value.
   * @returns A decoded string safe to use in URLs and titles.
   */
  private decodeHtmlEntities(value: string): string {
    // Single pass so an already-decoded `&` can never start a second entity
    // (`&amp;quot;` must become `&quot;`, not `"`). Code points are decoded
    // with `fromCodePoint` so characters outside the BMP (emoji) survive.
    const named: Record<string, string> = {
      quot: '"',
      apos: "'",
      lt: '<',
      gt: '>',
      nbsp: ' ',
      amp: '&'
    }

    return value.replace(
      /&(?:#x([0-9a-fA-F]+)|#(\d+)|([a-zA-Z]+));/g,
      (match, hex?: string, dec?: string, name?: string) => {
        if (name !== undefined) return named[name] ?? match

        const codePoint = hex !== undefined ? parseInt(hex, 16) : Number(dec)
        if (!Number.isInteger(codePoint) || codePoint > 0x10ffff) return match

        try {
          return String.fromCodePoint(codePoint)
        } catch {
          return match
        }
      }
    )
  }

  /**
   * Normalizes parsed HTML text into a trimmed human-readable value.
   *
   * @param value Raw string extracted from HTML or JSON payloads.
   * @returns Normalized text, or `null` when the input becomes empty.
   */
  private normalizeText(value?: string | null): string | null {
    if (!value) return null

    const normalized = this.decodeHtmlEntities(value)
      .replace(/\s+/g, ' ')
      .trim()
    return normalized ? normalized : null
  }

  /**
   * Converts Bandcamp duration values from seconds to milliseconds.
   *
   * @param durationSeconds Duration in seconds provided by Bandcamp.
   * @returns Duration in milliseconds, or `-1` when duration is missing.
   */
  private toDurationMilliseconds(durationSeconds?: number): number {
    return durationSeconds ? Math.round(durationSeconds * 1000) : -1
  }

  /**
   * Parses an ISO 8601 duration string into milliseconds.
   *
   * Handles the `P00H05M20S` format used by Bandcamp's JSON-LD.
   *
   * @param iso ISO 8601 duration string.
   * @returns Duration in milliseconds, or `-1` when parsing fails.
   */
  private parseIsoDuration(iso?: string | null): number {
    if (!iso) return -1

    const match = iso.match(
      /P(?:(\d+)D)?(?:T)?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/
    )
    if (!match) return -1

    const days = parseInt(match[1] || '0', 10)
    const hours = parseInt(match[2] || '0', 10)
    const minutes = parseInt(match[3] || '0', 10)
    const seconds = parseFloat(match[4] || '0')

    return Math.round(
      (days * 86400 + hours * 3600 + minutes * 60 + seconds) * 1000
    )
  }

  /**
   * Builds the public Bandcamp artwork URL from an `art_id` value.
   *
   * @param artId Artwork identifier exposed by `data-tralbum`.
   * @returns The public image URL or `null` when no artwork exists.
   */
  private createArtworkUrl(artId?: string | number | null): string | null {
    if (artId === undefined || artId === null || artId === '') {
      return null
    }

    return `https://f4.bcbits.com/img/a${String(artId)}_10.jpg`
  }

  /**
   * Builds an absolute Bandcamp track URL from a relative album entry link.
   *
   * @param titleLink Relative or absolute track path exposed by Bandcamp.
   * @param parentUrl Canonical album URL used as the base.
   * @returns The absolute track URL or `null` when the input is invalid.
   */
  private buildAbsoluteTrackUrl(
    titleLink: string,
    parentUrl: string
  ): string | null {
    try {
      return new URL(titleLink, parentUrl).href
    } catch {
      return null
    }
  }

  /**
   * Chooses the best stable identifier available for a Bandcamp track.
   *
   * @param track Page payload entry returned by `data-tralbum`.
   * @param fallbackUrl Fallback public URL used when no numeric identifier exists.
   * @returns A stable identifier string for the encoded payload.
   */
  private getTrackIdentifier(
    track: BandcampTralbumTrack,
    fallbackUrl: string
  ): string {
    const identifier = track.track_id ?? track.id
    return identifier !== undefined && identifier !== null && identifier !== ''
      ? String(identifier)
      : this.getIdentifierFromUrl(fallbackUrl)
  }

  /**
   * Reads and normalizes the configured maximum number of search results.
   *
   * @returns A positive integer limit used when parsing search results.
   */
  private getMaxSearchResults(): number {
    const options = this.nodelink.options
    const limit = options.search.maxResults

    return typeof limit === 'number' && Number.isInteger(limit) && limit > 0
      ? limit
      : 10
  }

  /**
   * Creates a standardized source exception payload for search and resolve flows.
   *
   * @param message Human-readable failure message.
   * @param severity Error severity used by the source pipeline.
   * @param cause Optional failure origin.
   * @returns A source result containing only exception metadata.
   */
  private createSourceException(
    message: string,
    severity: string,
    cause?: string
  ): SourceResult {
    return {
      loadType: 'error',
      exception: {
        message,
        severity,
        cause
      }
    }
  }
}
