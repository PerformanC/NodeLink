import type {
  SourceResult,
  TrackInfo,
  TrackUrlResult,
  WorkerNodeLink
} from '../typings/sources/source.types.ts'
import type {
  HttpResponseHeaders,
  TrackEncodeInput
} from '../typings/utils.types.ts'
import { encodeTrack, http1makeRequest, logger } from '../utils.ts'

const RSS_PATTERN = /https?:\/\/.+(\.rss|\.rrs)(\?.*)?$/i
const PODCAST_RSS_PATTERN = /https?:\/\/.+\/podcast\/rss(\?.*)?$/i

/**
 * Source-specific plugin payload attached to RSS episode tracks.
 */
interface RssTrackPluginInfo {
  [x: string]: unknown
  /**
   * MIME type declared by the enclosure tag when available.
   */
  enclosureType: string | null

  /**
   * Episode page URL extracted from the RSS item.
   */
  itemUrl: string

  /**
   * RSS feed URL that produced the episode.
   */
  feedUrl: string
}

/**
 * Track payload compatible with the shared encoder.
 */
interface RssTrackInfo extends TrackEncodeInput {
  [x: string]: unknown
  /**
   * Whether the generated track can be seeked.
   */
  isSeekable: boolean

  /**
   * Direct enclosure URL extracted from the feed item.
   */
  uri: string

  /**
   * Episode artwork URL when available.
   */
  artworkUrl: string | null

  /**
   * RSS feeds do not expose ISRC values in this source path.
   */
  isrc: null
}

/**
 * Encoded RSS track payload returned by the source manager.
 */
interface RssTrackData {
  /**
   * Base64-encoded Lavalink-compatible track payload.
   */
  encoded: string

  /**
   * Human-readable track information.
   */
  info: RssTrackInfo

  /**
   * RSS-specific metadata for the resolved item.
   */
  pluginInfo: RssTrackPluginInfo
}

/**
 * Playlist payload returned when the RSS feed contains multiple playable
 * episodes.
 */
interface RssPlaylistData {
  /**
   * Playlist metadata block expected by the source manager.
   */
  info: {
    /**
     * Feed title used as the playlist name.
     */
    name: string

    /**
     * Default selected track index.
     */
    selectedTrack: number
  }

  /**
   * RSS-specific playlist metadata.
   */
  pluginInfo: {
    /**
     * Feed URL used to resolve the playlist.
     */
    feedUrl: string
  }

  /**
   * Episode list extracted from the feed.
   */
  tracks: RssTrackData[]
}

/**
 * RSS source implementation.
 */
export default class RssSource {
  /**
   * Runtime worker context used by the source implementation.
   */
  public readonly nodelink: WorkerNodeLink

  /**
   * URL patterns supported by this source.
   */
  public readonly patterns: RegExp[]

  /**
   * Match priority used by the source manager.
   */
  public readonly priority: number

  /**
   * Creates a new RSS source wrapper.
   *
   * @param nodelink - Worker runtime used by the source implementation.
   */
  public constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
    this.patterns = [RSS_PATTERN, PODCAST_RSS_PATTERN]
    this.priority = 50
  }

  /**
   * Initializes the source.
   *
   * @returns `true` once the source has been registered.
   */
  public async setup(): Promise<boolean> {
    return true
  }

  /**
   * Resolves an RSS feed into a playlist of playable enclosure items.
   *
   * @param url - Candidate RSS feed URL.
   * @returns Playlist payload, an empty result when the URL does not return a
   * valid RSS feed, or an error payload when parsing fails unexpectedly.
   */
  public async resolve(url: string): Promise<SourceResult> {
    try {
      const { body, statusCode, headers } = await http1makeRequest(url)
      if (statusCode !== 200 || typeof body !== 'string') {
        return { loadType: 'empty', data: {} }
      }

      const contentType = this.getContentType(headers)
      if (!contentType.includes('xml') && !body.includes('<rss')) {
        return { loadType: 'empty', data: {} }
      }

      const channelXml = this.extractFirstTag(body, 'channel') ?? ''
      const channelTitle =
        this.extractTagText(channelXml, 'title') ?? 'RSS Feed'
      const channelImage =
        this.extractTagAttribute(channelXml, 'itunes:image', 'href') ??
        this.extractTagText(
          this.extractFirstTag(channelXml, 'image') ?? '',
          'url'
        ) ??
        null

      const items = this.extractItems(body)
      if (items.length === 0) {
        return { loadType: 'empty', data: {} }
      }

      const tracks: RssTrackData[] = []

      for (const itemXml of items) {
        const title = this.extractTagText(itemXml, 'title') ?? 'Untitled'
        const author =
          this.extractTagText(itemXml, 'itunes:author') ??
          this.extractTagText(itemXml, 'dc:creator') ??
          this.extractTagText(channelXml, 'itunes:author') ??
          this.extractTagText(channelXml, 'author') ??
          'Unknown Artist'
        const enclosureTag = this.extractEnclosureTag(itemXml)
        const enclosureUrl = this.extractAttribute(enclosureTag, 'url')
        const enclosureType = this.extractAttribute(enclosureTag, 'type')
        const itemUrl =
          this.extractTagText(itemXml, 'link') ?? enclosureUrl ?? url
        const guid = this.extractTagText(itemXml, 'guid') ?? itemUrl
        const durationText = this.extractTagText(itemXml, 'itunes:duration')
        const artwork =
          this.extractTagAttribute(itemXml, 'itunes:image', 'href') ??
          channelImage

        if (!enclosureUrl) {
          continue
        }

        const trackInfo: RssTrackInfo = {
          identifier: guid,
          isSeekable: true,
          author: author.trim() || 'Unknown Artist',
          length: this.parseDurationMs(durationText),
          isStream: false,
          position: 0,
          title: title.trim() || 'Untitled',
          uri: enclosureUrl,
          artworkUrl: artwork,
          isrc: null,
          sourceName: 'rss',
          details: []
        }

        tracks.push({
          encoded: encodeTrack(trackInfo),
          info: trackInfo,
          pluginInfo: {
            enclosureType,
            itemUrl,
            feedUrl: url
          }
        })
      }

      if (tracks.length === 0) {
        return { loadType: 'empty', data: {} }
      }

      const playlistData: RssPlaylistData = {
        info: { name: channelTitle, selectedTrack: 0 },
        pluginInfo: { feedUrl: url },
        tracks
      }

      return {
        loadType: 'playlist',
        data: playlistData
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'RSS resolution failed.'
      logger('error', 'RSS', `Resolve failed: ${message}`)
      return {
        loadType: 'error',
        exception: { message, severity: 'fault' }
      }
    }
  }

  /**
   * Resolves the direct enclosure URL for an RSS episode.
   *
   * @param track - Decoded RSS track information.
   * @returns Direct HTTP or HTTPS URL descriptor, or an exception payload when
   * the enclosure URL is missing.
   */
  public async getTrackUrl(
    track: TrackInfo
  ): Promise<TrackUrlResult | SourceResult> {
    const url = track.uri
    if (!url) {
      return {
        loadType: 'error',
        exception: {
          message: 'Missing enclosure URL.',
          severity: 'common'
        }
      }
    }

    return {
      url,
      protocol: url.startsWith('https://') ? 'https' : 'http',
      format: this.guessFormatFromUrl(url)
    }
  }

  /**
   * Extracts RSS item payloads from a feed XML string.
   *
   * @param xml - RSS feed XML.
   * @returns Raw inner XML for each `<item>` entry.
   */
  private extractItems(xml: string): string[] {
    const items: string[] = []
    const itemExpression = /<item\b[^>]*>([\s\S]*?)<\/item>/gi
    let match: RegExpExecArray | null

    do {
      match = itemExpression.exec(xml)
      if (match?.[1]) {
        items.push(match[1])
      }
    } while (match !== null)

    return items
  }

  /**
   * Extracts the inner XML of the first matching tag.
   *
   * @param xml - XML fragment to inspect.
   * @param tag - Tag name to extract.
   * @returns Inner XML content, or `null` when the tag is not present.
   */
  private extractFirstTag(xml: string, tag: string): string | null {
    const tagExpression = this.buildTagRegex(tag)
    const match = tagExpression.exec(xml)
    return match?.[1] ?? null
  }

  /**
   * Extracts plain text from the first matching XML tag.
   *
   * @param xml - XML fragment to inspect.
   * @param tag - Tag name to extract.
   * @returns Trimmed plain-text tag content, or `null` when the tag is
   * missing.
   */
  private extractTagText(xml: string, tag: string): string | null {
    const content = this.extractFirstTag(xml, tag)
    if (!content) {
      return null
    }

    const cdataMatch = content.match(/<!\[CDATA\[([\s\S]*?)\]\]>/i)
    if (cdataMatch?.[1]) {
      return cdataMatch[1].trim()
    }

    return content.replace(/<[^>]+>/g, '').trim()
  }

  /**
   * Extracts an attribute value from the first matching tag instance.
   *
   * @param xml - XML fragment to inspect.
   * @param tag - Tag name to locate.
   * @param attribute - Attribute name to read.
   * @returns Attribute value, or `null` when the tag or attribute is missing.
   */
  private extractTagAttribute(
    xml: string,
    tag: string,
    attribute: string
  ): string | null {
    const tagExpression = new RegExp(`<${this.escape(tag)}\\b[^>]*>`, 'i')
    const match = tagExpression.exec(xml)
    if (!match?.[0]) {
      return null
    }

    return this.extractAttribute(match[0], attribute)
  }

  /**
   * Extracts an attribute value from a tag string.
   *
   * @param tag - Raw XML tag string.
   * @param attribute - Attribute name to read.
   * @returns Attribute value, or `null` when the attribute is missing.
   */
  private extractAttribute(tag: string, attribute: string): string | null {
    const attributeExpression = new RegExp(
      `${this.escape(attribute)}=(["'])([^"']+)\\1`,
      'i'
    )
    const match = attributeExpression.exec(tag)
    return match?.[2] ?? null
  }

  /**
   * Builds a regex that captures the inner XML of a tag.
   *
   * @param tag - Tag name to capture.
   * @returns Compiled regular expression for the tag.
   */
  private buildTagRegex(tag: string): RegExp {
    return new RegExp(
      `<${this.escape(tag)}\\b[^>]*>([\\s\\S]*?)<\\/${this.escape(tag)}>`,
      'i'
    )
  }

  /**
   * Extracts the first `<enclosure>` tag from an RSS item.
   *
   * @param xml - RSS item XML.
   * @returns Raw `<enclosure>` tag string, or an empty string when not found.
   */
  private extractEnclosureTag(xml: string): string {
    const match = xml.match(/<enclosure\b[^>]*\/?>/i)
    return match?.[0] ?? ''
  }

  /**
   * Escapes a literal string for regex construction.
   *
   * @param value - Raw string that should be treated literally.
   * @returns Regex-escaped string.
   */
  private escape(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  /**
   * Parses an RSS duration string into milliseconds.
   *
   * Supports plain seconds as well as `mm:ss` and `hh:mm:ss`.
   *
   * @param text - Raw duration text.
   * @returns Duration in milliseconds, or `0` when parsing fails.
   */
  private parseDurationMs(text: string | null): number {
    if (!text) {
      return 0
    }

    const trimmed = text.trim()
    if (/^\d+$/.test(trimmed)) {
      return Number.parseInt(trimmed, 10) * 1000
    }

    const parts = trimmed.split(':').map((part) => Number.parseInt(part, 10))
    if (parts.some((part) => Number.isNaN(part))) {
      return 0
    }

    const [first, second, third] = parts
    if (
      parts.length === 3 &&
      first !== undefined &&
      second !== undefined &&
      third !== undefined
    ) {
      return (first * 3600 + second * 60 + third) * 1000
    }

    if (parts.length === 2 && first !== undefined && second !== undefined) {
      return (first * 60 + second) * 1000
    }

    return 0
  }

  /**
   * Guesses the audio container from an enclosure URL.
   *
   * @param url - Direct enclosure URL.
   * @returns Best-effort format hint used by the playback pipeline.
   */
  private guessFormatFromUrl(url: string): string {
    const [lower] = url.toLowerCase().split('?')
    if (!lower) {
      return 'mp3'
    }

    if (lower.endsWith('.m4a') || lower.endsWith('.aac')) {
      return 'm4a'
    }

    if (lower.endsWith('.ogg') || lower.endsWith('.oga')) {
      return 'ogg'
    }

    if (lower.endsWith('.wav')) {
      return 'wav'
    }

    if (lower.endsWith('.m3u8')) {
      return 'm3u8'
    }

    return 'mp3'
  }

  /**
   * Normalizes the response content-type header into a lowercase string.
   *
   * @param headers - HTTP headers returned by the request helper.
   * @returns Lowercase content type string, or an empty string when missing.
   */
  private getContentType(headers: HttpResponseHeaders | undefined): string {
    const value = headers?.['content-type']
    if (Array.isArray(value)) {
      return String(value[0] ?? '').toLowerCase()
    }

    return String(value ?? '').toLowerCase()
  }
}
