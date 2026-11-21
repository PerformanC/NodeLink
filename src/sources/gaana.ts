import { createDecipheriv } from 'node:crypto'
import { PassThrough } from 'node:stream'
import HLSHandler from '../playback/hls/HLSHandler.ts'
import { parse as parsePlaylist } from '../playback/hls/PlaylistParser.ts'
import type { GaanaSourceConfig } from '../typings/config/config.types.ts'
import type { HLSSegment } from '../typings/playback/hls.types.ts'
import type {
  GaanaLoadStreamResult,
  GaanaTrackPluginInfo
} from '../typings/sources/gaana.types.ts'
import type {
  SourceInstance,
  SourceResult,
  TrackData,
  TrackInfo,
  TrackUrlResult,
  WorkerNodeLink
} from '../typings/sources/source.types.ts'
import type {
  SourceTestCase,
  SourceTestStreamSpec,
  SourceTestVariant,
  SourceTestVariantResult,
  SourceVariantHandler
} from '../typings/sources/test.types.ts'
import type {
  BestMatchCandidate,
  TrackEncodeInput
} from '../typings/utils.types.ts'
import {
  encodeTrack,
  getBestMatch,
  http1makeRequest,
  logger
} from '../utils.ts'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const API_URL = 'https://gaana.com/apiv2'
const STREAM_URL_API = 'https://gaana.com/api/stream-url'
const CRYPTO_KEY = Buffer.from('gy1t#b@jl(b$wtme', 'utf8')
const HLS_BASE_URL = 'https://vodhlsgaana-ebw.akamaized.net/'

/**
 * Gaana source implementation.
 * @public
 */
export default class GaanaSource
  implements SourceInstance, SourceVariantHandler
{
  /**
   * Declarative test suite for validating Gaana source behavior.
   * @public
   */
  public static readonly _TESTS: SourceTestCase[] = [
    {
      id: 'gaana.track.stream',
      name: 'Gaana native audio streaming',
      input: {
        type: 'resolve',
        value: 'https://gaana.com/song/ishq-d-e-fanniyar-female'
      },
      matrix: {
        variants: [{ id: 'Standard' }]
      },
      expect: {
        result: {
          type: 'track'
        },
        metadata: {
          title: { op: 'matches', value: 'Ishq De Fanniyar' },
          author: { op: 'matches', value: 'Jyotica Tangri' },
          sourceName: { op: 'equals', value: 'gaana' }
        },
        stream: {
          required: true,
          download: 'complete',
          minBytes: 500000,
          validFormats: [{ container: 'mpegts', codec: 'aac' }],
          decodeToEnd: true
        }
      },
      forbid: {
        resultTypes: ['empty', 'error']
      }
    },
    {
      id: 'gaana.track.localized',
      name: 'Gaana localized song URL resolution',
      input: {
        type: 'resolve',
        value: 'https://gaana.com/hindi/song/ishq-d-e-fanniyar-female'
      },
      expect: {
        result: {
          type: 'track'
        },
        metadata: {
          title: { op: 'matches', value: 'Ishq De Fanniyar' },
          author: { op: 'matches', value: 'Jyotica Tangri' },
          sourceName: { op: 'equals', value: 'gaana' }
        }
      },
      forbid: {
        resultTypes: ['empty', 'error']
      }
    },
    {
      id: 'gaana.track.mobile',
      name: 'Gaana mobile song URL resolution',
      input: {
        type: 'resolve',
        value: 'https://m.gaana.com/song/ishq-d-e-fanniyar-female'
      },
      expect: {
        result: {
          type: 'track'
        },
        metadata: {
          title: { op: 'matches', value: 'Ishq De Fanniyar' },
          sourceName: { op: 'equals', value: 'gaana' }
        }
      },
      forbid: {
        resultTypes: ['empty', 'error']
      }
    },
    {
      id: 'gaana.track.popular',
      name: 'Gaana popular track resolution',
      input: {
        type: 'resolve',
        value: 'https://gaana.com/song/tum-hi-ho'
      },
      expect: {
        result: {
          type: 'track'
        },
        metadata: {
          title: { op: 'matches', value: 'Tum Hi Ho' },
          sourceName: { op: 'equals', value: 'gaana' }
        }
      },
      forbid: {
        resultTypes: ['empty', 'error']
      }
    },
    {
      id: 'gaana.album.resolve',
      name: 'Gaana album resolution',
      input: {
        type: 'resolve',
        value: 'https://gaana.com/album/fukrey-returns'
      },
      expect: {
        result: {
          type: 'playlist'
        },
        collection: {
          minItems: 5
        }
      },
      forbid: {
        resultTypes: ['empty', 'error']
      }
    },
    {
      id: 'gaana.playlist.resolve',
      name: 'Gaana playlist resolution',
      input: {
        type: 'resolve',
        value: 'https://gaana.com/playlist/gaana-dj-hindi-top-50-1'
      },
      expect: {
        result: {
          type: 'playlist'
        },
        collection: {
          minItems: 10
        }
      },
      forbid: {
        resultTypes: ['empty', 'error']
      }
    },
    {
      id: 'gaana.artist.resolve',
      name: 'Gaana artist top tracks resolution',
      input: {
        type: 'resolve',
        value: 'https://gaana.com/artist/jyotica-tangri'
      },
      expect: {
        result: {
          type: 'playlist'
        },
        collection: {
          minItems: 3
        }
      },
      forbid: {
        resultTypes: ['empty', 'error']
      }
    },
    {
      id: 'gaana.search',
      name: 'Gaana search queries (gnsearch)',
      input: {
        type: 'search',
        value: 'Ishq De Fanniyar Female',
        searchType: 'gnsearch'
      },
      expect: {
        result: {
          type: 'search'
        },
        collection: {
          minItems: 1
        }
      },
      forbid: {
        resultTypes: ['empty', 'error']
      }
    }
  ]

  /**
   * Runtime NodeLink context.
   */
  public readonly nodelink: WorkerNodeLink

  /**
   * Gaana source configuration block.
   */
  public readonly config: GaanaSourceConfig

  /**
   * Search aliases handled by this source.
   */
  public readonly searchTerms: string[]

  /**
   * URL patterns handled by this source.
   */
  public readonly patterns: RegExp[]

  /**
   * URL resolution priority.
   */
  public readonly priority: number

  /**
   * Max results returned by search.
   */
  public readonly maxSearchResults: number

  /**
   * Max playlist load size.
   */
  public readonly playlistLoadLimit: number

  /**
   * Max album load size.
   */
  public readonly albumLoadLimit: number

  /**
   * Max artist load size.
   */
  public readonly artistLoadLimit: number

  /**
   * Preferred direct stream quality.
   */
  public readonly streamQuality: string

  /**
   * Creates a Gaana source instance.
   * @param nodelink - Runtime NodeLink context.
   */
  public constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink

    const sourceConfig = this.nodelink.options.sources.gaana
    this.config = sourceConfig
    this.searchTerms = ['gnsearch', 'gaanasearch']
    this.patterns = [
      /^@?(?:https?:\/\/)?(?:(?:www|m)\.)?gaana\.com\/(?:[a-z]{2,10}\/)?(?<type>song|album|playlist|artist)\/(?<seokey>[\w-]+)\/?(?:[?#].*)?$/i
    ]
    this.priority = 70

    this.maxSearchResults =
      this.asNumber(this.nodelink.options.search.maxResults) ?? 10
    const maxAlbumPlaylistLength =
      this.asNumber(this.nodelink.options.playback.maxPlaylistLength) ?? 100
    this.playlistLoadLimit =
      this.asNumber(this.config.playlistLoadLimit) ?? maxAlbumPlaylistLength
    this.albumLoadLimit =
      this.asNumber(this.config.albumLoadLimit) ?? maxAlbumPlaylistLength
    this.artistLoadLimit =
      this.asNumber(this.config.artistLoadLimit) ?? maxAlbumPlaylistLength
    this.streamQuality = this.asString(this.config.streamQuality) || 'high'
  }

  /**
   * Initializes the source.
   * @returns False when source is disabled.
   */
  public async setup(): Promise<boolean> {
    if (this.config.enabled === false) return false
    logger('info', 'Sources', 'Loaded Gaana source.')
    return true
  }

  /**
   * Searches tracks/albums/artists/playlists in Gaana.
   * @param query - Search query.
   * @param _sourceTerm - Source alias.
   * @param searchType - Search type.
   * @returns Search result payload.
   */
  public async search(
    query: string,
    _sourceTerm?: string,
    searchType = 'track'
  ): Promise<SourceResult> {
    try {
      const params: Record<string, string | number> = {
        country: 'IN',
        page: 0,
        type: 'search',
        keyword: query
      }

      if (searchType === 'track') params.secType = 'track'
      else if (searchType === 'album') params.secType = 'album'
      else if (searchType === 'artist') params.secType = 'artist'
      else if (searchType === 'playlist') params.secType = 'playlist'

      const data = await this.getJson(
        params,
        `search/${encodeURIComponent(query)}`
      )
      const groups = this.asArrayRecords(data?.gr)
      if (groups.length === 0) return { loadType: 'empty', data: {} }

      const targetGroupName =
        searchType === 'track'
          ? 'Track'
          : searchType.charAt(0).toUpperCase() + searchType.slice(1)
      const group = groups.find(
        (item) => this.asString(item.ty) === targetGroupName
      )
      const items = this.asArrayRecords(group?.gd).slice(
        0,
        this.maxSearchResults
      )
      if (items.length === 0) return { loadType: 'empty', data: {} }

      if (searchType === 'track') {
        const trackIdentifiers = items
          .map((item) => this.asString(item.seo) || this.asString(item.id))
          .filter((item): item is string => Boolean(item))
        const tracks = await this.getTracks(trackIdentifiers)
        return tracks.length > 0
          ? { loadType: 'search', data: tracks }
          : { loadType: 'empty', data: {} }
      }

      const results = items
        .map((item) => this.mapCollectionResult(item, searchType))
        .filter(
          (
            item
          ): item is {
            encoded: string
            info: TrackInfo
            pluginInfo: Record<string, unknown>
          } => item !== null
        )
      return results.length > 0
        ? { loadType: 'search', data: results }
        : { loadType: 'empty', data: {} }
    } catch (error) {
      const message = this.getErrorMessage(error)
      logger('error', 'Gaana', `Search error: ${message}`)
      return { loadType: 'error', exception: { message, severity: 'fault' } }
    }
  }

  /**
   * Resolves Gaana links.
   * @param url - Gaana URL.
   * @returns Source result payload.
   */
  public async resolve(url: string): Promise<SourceResult> {
    const pattern = this.patterns[0]
    if (!pattern) return { loadType: 'empty', data: {} }

    const match = url.match(pattern)
    if (!match?.groups) return { loadType: 'empty', data: {} }

    const type = match.groups.type
    const seokey = match.groups.seokey
    if (!type || !seokey) return { loadType: 'empty', data: {} }

    try {
      if (type === 'song') return this.getSong(seokey)
      if (type === 'album') return this.getAlbum(seokey)
      if (type === 'playlist') return this.getPlaylist(seokey)
      if (type === 'artist') return this.getArtist(seokey)
      return { loadType: 'empty', data: {} }
    } catch (error) {
      const message = this.getErrorMessage(error)
      logger('error', 'Gaana', `Resolve error: ${message}`)
      return { loadType: 'error', exception: { message, severity: 'fault' } }
    }
  }

  /**
   * Executes a test variant for declarative test runner.
   * @param variant - Test variant definition.
   * @param track - Resolved canonical track info.
   * @param streamSpec - Optional stream validation specifications.
   * @returns Variant test execution result.
   */
  public async executeVariant(
    variant: SourceTestVariant,
    track: TrackInfo,
    streamSpec?: SourceTestStreamSpec
  ): Promise<SourceTestVariantResult> {
    const urlData = await this.getTrackUrl(track)
    if (!urlData || 'exception' in urlData || !urlData.url) {
      const errorMsg =
        urlData && 'exception' in urlData && urlData.exception?.message
          ? urlData.exception.message
          : 'Failed to resolve track streaming URL'
      return {
        variant: variant.id,
        resolved: false,
        error: errorMsg
      }
    }

    const container = 'mpegts'
    const codec = 'aac'

    if (!streamSpec?.required) {
      return {
        variant: variant.id,
        resolved: true,
        track: urlData.newTrack?.info || track,
        container,
        codec
      }
    }

    const streamResult = await this.loadStream(
      track,
      urlData.url,
      urlData.protocol,
      urlData.additionalData
    )
    if (!('stream' in streamResult)) {
      return {
        variant: variant.id,
        resolved: true,
        error: streamResult.exception?.message || 'Failed to load audio stream'
      }
    }

    return {
      variant: variant.id,
      resolved: true,
      track: urlData.newTrack?.info || track,
      stream: streamResult.stream,
      container,
      codec
    }
  }

  /**
   * Resolves playback URL for a Gaana track.
   * @param decodedTrack - Decoded track metadata.
   * @returns Direct stream or mirror fallback payload.
   */
  public async getTrackUrl(
    decodedTrack: TrackInfo
  ): Promise<
    TrackUrlResult | { exception: { message: string; severity: string } }
  > {
    try {
      const decodedTrackRecord = decodedTrack as unknown as Record<
        string,
        unknown
      >
      const pluginInfo = this.asRecord(decodedTrackRecord.pluginInfo)
      const pluginTrackId = this.asString(pluginInfo?.trackId)
      let trackId = pluginTrackId || decodedTrack.identifier

      if (trackId && !/^\d+$/.test(trackId)) {
        const songResult = await this.getSong(trackId)
        if (songResult.loadType === 'track') {
          const songData = songResult.data as {
            info: TrackInfo
            pluginInfo?: Record<string, unknown>
          }
          const numericId = this.asString(songData.pluginInfo?.trackId)
          if (numericId && /^\d+$/.test(numericId)) {
            trackId = numericId
          }
        }
      }

      if (trackId && /^\d+$/.test(trackId)) {
        const streamInfo = await this.fetchDirectStream(trackId)
        if (streamInfo) return streamInfo
      }
    } catch (error) {
      logger(
        'debug',
        'Gaana',
        `Direct stream fetch failed for ${decodedTrack.title}: ${this.getErrorMessage(error)}`
      )
    }

    logger(
      'warn',
      'Gaana',
      `Direct playback for ${decodedTrack.title} failed. Falling back to default search matching.`
    )

    if (!this.nodelink.sources) {
      return {
        exception: {
          message: 'Default source search is not available.',
          severity: 'fault'
        }
      }
    }

    const searchResult = await this.nodelink.sources.searchWithDefault(
      `${decodedTrack.title} ${decodedTrack.author}`
    )
    const tracks =
      searchResult.loadType === 'search'
        ? this.toTrackInfoArray(searchResult.data)
        : []
    const candidates: BestMatchCandidate[] = tracks.map((track) => ({
      info: {
        title: track.title,
        author: track.author,
        length: track.length,
        uri: track.uri
      }
    }))
    const bestMatch = getBestMatch(candidates, decodedTrack)
    if (!bestMatch) {
      return {
        exception: {
          message: 'No suitable alternative found in default search.',
          severity: 'fault'
        }
      }
    }

    const fallbackTrack = tracks.find(
      (track) =>
        track.title === bestMatch.info.title &&
        track.author === bestMatch.info.author &&
        track.length === bestMatch.info.length
    )
    if (!fallbackTrack) {
      return {
        exception: {
          message: 'No suitable alternative found in default search.',
          severity: 'fault'
        }
      }
    }

    const sourceManager = this.nodelink.sources
    if (!sourceManager) {
      return {
        exception: {
          message: 'Source manager is not available.',
          severity: 'fault'
        }
      }
    }

    const streamInfo = await sourceManager.getTrackUrl(fallbackTrack)
    return { newTrack: { info: fallbackTrack }, ...streamInfo }
  }

  /**
   * Opens a Gaana stream.
   * @param _track - Decoded track metadata.
   * @param url - Stream URL.
   * @param protocol - Protocol hint.
   * @param additionalData - Additional segment metadata.
   * @returns Track stream payload.
   */
  public async loadStream(
    _track: TrackInfo,
    url: string,
    protocol?: string,
    additionalData?: TrackUrlResult['additionalData']
  ): Promise<GaanaLoadStreamResult> {
    const proxy = this.getProxyConfig()
    const isHls =
      protocol === 'hls' || url.includes('.m3u8') || url.includes('/hls/')

    if (isHls) {
      const additional = this.asRecord(additionalData) || {}
      const stream = new HLSHandler(url, {
        type: 'mpegts',
        strategy: 'segmented',
        localAddress: this.nodelink.routePlanner?.getIP?.(),
        startTime: this.asNumber(additional.startTime) || 0,
        headers: this.getHeaders(),
        proxy
      })
      return { stream, type: 'mpegts' }
    }

    const additional = this.asRecord(additionalData) || {}
    const additionalSegments = this.normalizeSegments(additional.segments)
    if (additionalSegments.length > 0) {
      const stream = new PassThrough()
      let segments = additionalSegments
      const startTime = this.asNumber(additional.startTime) || 0

      if (startTime > 0) {
        let elapsed = 0
        const startIndex = segments.findIndex((segment) => {
          const duration = (segment.duration || 0) * 1000
          if (elapsed + duration > startTime) return true
          elapsed += duration
          return false
        })
        if (startIndex !== -1) {
          segments = segments.slice(startIndex)
        }
      }

      const initUrl = this.asString(additional.initUrl) || null
      void this.streamSegments(
        stream,
        initUrl,
        segments
          .map((segment) => segment.url)
          .filter((segmentUrl) => segmentUrl.length > 0)
      )

      const format = this.asString(additional.format) || 'mp4'
      let type = 'mp4'
      if (format === 'ts' || format === 'mpegts') type = 'mpegts'
      else if (format === 'aac') type = 'aac'

      return { stream, type }
    }

    const { stream, error, statusCode } = await http1makeRequest(url, {
      method: 'GET',
      streamOnly: true,
      headers: this.getHeaders(),
      proxy
    })
    if (error || statusCode !== 200 || !stream) {
      return {
        exception: {
          message: `Stream status ${statusCode || 'unknown'}: ${error || 'request failed'}`,
          severity: 'fault'
        }
      }
    }

    let type = 'mp4'
    if (url.includes('.ts')) type = 'mpegts'
    else if (url.includes('.aac')) type = 'aac'

    const passthrough = new PassThrough()
    stream.on('data', (chunk) => {
      if (!passthrough.write(chunk)) stream.pause()
    })
    passthrough.on('drain', () => {
      stream.resume()
    })
    stream.on('end', () => {
      if (!passthrough.writableEnded) {
        passthrough.emit('finishBuffering')
        passthrough.end()
      }
    })
    stream.on('error', (err) => {
      const streamError = err instanceof Error ? err : new Error(String(err))
      if (!passthrough.destroyed) passthrough.destroy(streamError)
    })

    return { stream: passthrough, type }
  }

  /**
   * Fetches and resolves a single Gaana song.
   * @param seokey - Song key.
   * @returns Track payload.
   */
  private async getSong(seokey: string): Promise<SourceResult> {
    const data = await this.getJson(
      { type: 'songDetail', seokey },
      `song/${seokey}`
    )
    const tracks = this.asArrayRecords(data?.tracks)
    const firstTrack = tracks[0]
    if (!firstTrack) return { loadType: 'empty', data: {} }

    const track = this.mapTrack(firstTrack)
    return track
      ? { loadType: 'track', data: track }
      : { loadType: 'empty', data: {} }
  }

  /**
   * Fetches and resolves a Gaana album.
   * @param seokey - Album key.
   * @returns Playlist payload.
   */
  private async getAlbum(seokey: string): Promise<SourceResult> {
    const data = await this.getJson(
      { type: 'albumDetail', seokey },
      `album/${seokey}`
    )
    const tracks = this.asArrayRecords(data?.tracks)
    if (tracks.length === 0) return { loadType: 'empty', data: {} }

    const album = this.asRecord(data?.album) || {}
    return this.buildPlaylist(
      this.asString(album.title) || 'Unknown Album',
      tracks,
      'album',
      `https://gaana.com/album/${seokey}`,
      this.extractArtwork(album),
      this.asString(
        this.asRecord(this.asArrayRecords(album.artist)[0])?.name
      ) || null
    )
  }

  /**
   * Fetches and resolves a Gaana playlist.
   * @param seokey - Playlist key.
   * @returns Playlist payload.
   */
  private async getPlaylist(seokey: string): Promise<SourceResult> {
    const data = await this.getJson(
      { type: 'playlistDetail', seokey },
      `playlist/${seokey}`
    )
    const tracks = this.asArrayRecords(data?.tracks)
    if (tracks.length === 0) return { loadType: 'empty', data: {} }

    const playlist = this.asRecord(data?.playlist) || {}
    return this.buildPlaylist(
      this.asString(playlist.title) || 'Unknown Playlist',
      tracks,
      'playlist',
      `https://gaana.com/playlist/${seokey}`,
      this.extractArtwork(playlist)
    )
  }

  /**
   * Fetches and resolves Gaana artist top tracks.
   * @param seokey - Artist key.
   * @returns Playlist payload.
   */
  private async getArtist(seokey: string): Promise<SourceResult> {
    const detail = await this.getJson(
      { type: 'artistDetail', seokey },
      `artist/${seokey}`
    )
    const artists = this.asArrayRecords(detail?.artist)
    const firstArtist = artists[0]
    if (!firstArtist) return { loadType: 'empty', data: {} }

    const artistToken = this.asString(firstArtist.artist_id)
    if (!artistToken) return { loadType: 'empty', data: {} }

    const tracksData = await this.getJson(
      {
        type: 'artistTrackList',
        id: artistToken,
        language: '',
        order: 0,
        page: 0,
        sortBy: 'popularity'
      },
      `artist/${seokey}`
    )

    const tracksArray = this.asArrayRecords(tracksData?.tracks)
    const entitiesArray = this.asArrayRecords(tracksData?.entities)
    const merged = tracksArray.length > 0 ? tracksArray : entitiesArray
    if (merged.length === 0) return { loadType: 'empty', data: {} }

    return this.buildPlaylist(
      this.asString(firstArtist.name) || 'Unknown Artist',
      merged,
      'artist',
      `https://gaana.com/artist/${seokey}`,
      this.extractArtwork(firstArtist)
    )
  }

  /**
   * Builds playlist payload from Gaana item list.
   * @param name - Playlist display name.
   * @param tracksArray - Track list.
   * @param type - Collection type.
   * @param url - Source URL.
   * @param artwork - Artwork URL.
   * @param author - Optional author label.
   * @returns Source playlist payload.
   */
  private buildPlaylist(
    name: string,
    tracksArray: Record<string, unknown>[],
    type: string,
    url: string,
    artwork: string | null,
    author?: string | null
  ): SourceResult {
    const tracks = tracksArray
      .map((item) =>
        item.track_id || item.track_title
          ? this.mapTrack(item)
          : this.mapEntityTrack(item)
      )
      .filter((item): item is TrackData => item !== null)
      .slice(0, this.getLoadLimit(type))

    const infoName = type === 'artist' ? `${name}'s Top Tracks` : name
    return {
      loadType: 'playlist',
      data: {
        info: { name: infoName, selectedTrack: 0 },
        pluginInfo: { type, url, artwork, author: author || undefined },
        tracks
      }
    }
  }

  /**
   * Maps a Gaana track object to canonical track payload.
   * @param track - Raw Gaana track object.
   * @returns Encoded track payload.
   */
  private mapTrack(track: Record<string, unknown>): TrackData | null {
    const title = this.asString(track.track_title) || this.asString(track.name)
    if (!title) return null

    const durationSeconds = this.asNumber(track.duration) ?? 0
    const duration = Math.round(durationSeconds * 1000)

    let author = 'Unknown Artist'
    if (Array.isArray(track.artist)) {
      const names = track.artist
        .map((item) => this.asString(this.asRecord(item)?.name))
        .filter((item): item is string => Boolean(item))
      if (names.length > 0) author = names.join(', ')
    } else if (track.artist && typeof track.artist === 'object') {
      author =
        this.asString(this.asRecord(track.artist)?.name) || 'Unknown Artist'
    } else if (
      typeof track.artist === 'string' &&
      track.artist.trim().length > 0
    ) {
      author = track.artist.trim()
    }

    const trackIdStr = this.asString(track.track_id)
    const seokey = this.asString(track.seokey)
    const identifier = trackIdStr || seokey || ''
    if (!identifier) return null

    const uri = seokey ? `https://gaana.com/song/${seokey}` : ''
    const artworkUrl = this.extractArtwork(track)
    const isrc = this.asString(track.isrc) || null

    const info: TrackInfo = {
      identifier,
      isSeekable: true,
      author,
      length: duration,
      isStream: false,
      position: 0,
      title,
      uri,
      artworkUrl,
      isrc,
      sourceName: 'gaana'
    }

    const artists = this.asArrayRecords(track.artist).map((art) => ({
      id: this.asString(art.artist_id) || undefined,
      name: this.asString(art.name) || undefined,
      seokey: this.asString(art.seokey) || undefined,
      artwork: this.extractArtwork(art) || undefined
    }))

    const composers = this.asArrayRecords(track.composer).map((comp) => ({
      id: this.asString(comp.composer_id) || undefined,
      name: this.asString(comp.name) || undefined,
      seokey: this.asString(comp.seokey) || undefined
    }))

    const lyricists = this.asArrayRecords(track.lyricist).map((lyr) => ({
      id: this.asString(lyr.e_id) || undefined,
      name: this.asString(lyr.name) || undefined,
      seokey: this.asString(lyr.seokey) || undefined
    }))

    const genreSet = new Set<string>()
    for (const g of this.asArrayRecords(track.gener)) {
      const gName = this.asString(g.name)
      if (gName) genreSet.add(gName)
    }
    for (const t of this.asArrayRecords(track.tags)) {
      const tName = this.asString(t.tag_name)
      if (tName) genreSet.add(tName)
    }

    const parentalWarning = this.asNumber(track.parental_warning)
    const isPremiumRaw =
      this.asNumber(track.is_premium) ?? this.asNumber(track.premium_content)
    const albumSeokey = this.asString(track.albumseokey)

    const pluginInfo: GaanaTrackPluginInfo = {
      trackId: trackIdStr || null,
      albumId: this.asString(track.album_id) || null,
      albumName: this.asString(track.album_title) || null,
      albumUrl: albumSeokey ? `https://gaana.com/album/${albumSeokey}` : null,
      artists: artists.length > 0 ? artists : undefined,
      composers: composers.length > 0 ? composers : undefined,
      lyricists: lyricists.length > 0 ? lyricists : undefined,
      genres: genreSet.size > 0 ? Array.from(genreSet) : undefined,
      language: this.asString(track.language) || null,
      releaseDate: this.asString(track.release_date) || null,
      isrc,
      label: this.asString(track.vendor_name) || null,
      playCount: this.asString(track.play_ct) || this.asNumber(track.play_ct),
      favoriteCount:
        this.asNumber(track.total_favourite_count) ??
        this.asNumber(track.favorite_count),
      explicit: parentalWarning !== null ? parentalWarning > 0 : false,
      isPremium: isPremiumRaw !== null ? isPremiumRaw > 0 : false,
      youtubeId: this.asString(track.youtube_id) || null,
      lyricsUrl: this.asString(track.lyrics_url) || null
    }

    const encodedInput: TrackEncodeInput = { ...info, details: [] }
    return {
      encoded: encodeTrack(encodedInput),
      info,
      pluginInfo
    }
  }

  /**
   * Maps Gaana entity payload to canonical track payload.
   * @param json - Raw entity payload.
   * @returns Encoded track payload.
   */
  private mapEntityTrack(json: Record<string, unknown>): TrackData | null {
    const getEntityValue = (key: string): unknown => {
      const entities = this.asArrayRecords(json.entity_info)
      return entities.find((item) => this.asString(item.key) === key)?.value
    }

    const title = this.asString(json.name) || ''
    if (!title) return null

    const durationSeconds =
      this.asNumber(getEntityValue('duration')) ??
      this.asNumber(json.duration) ??
      0
    const duration = Math.round(durationSeconds * 1000)

    const artistsRaw = getEntityValue('artist')
    let author = 'Unknown Artist'
    if (Array.isArray(artistsRaw)) {
      const names = artistsRaw
        .map((item) => this.asString(this.asRecord(item)?.name))
        .filter((item): item is string => Boolean(item))
      if (names.length > 0) author = names.join(', ')
    } else if (artistsRaw && typeof artistsRaw === 'object') {
      author =
        this.asString(this.asRecord(artistsRaw)?.name) || 'Unknown Artist'
    } else if (typeof artistsRaw === 'string' && artistsRaw.trim().length > 0) {
      author = artistsRaw.trim()
    }

    const trackIdStr =
      this.asString(json.entity_id) || this.asString(json.track_id)
    const seokey = this.asString(json.seokey)
    const identifier = trackIdStr || seokey || ''
    if (!identifier) return null

    const artworkUrl = this.extractArtwork(json)
    const isrc = this.asString(getEntityValue('isrc')) || null

    const albumRaw = getEntityValue('album')
    const firstAlbum = Array.isArray(albumRaw)
      ? this.asRecord(albumRaw[0])
      : this.asRecord(albumRaw)
    const albumName =
      this.asString(firstAlbum?.name) || this.asString(json.album_title) || null
    const albumSeokey =
      this.asString(firstAlbum?.album_seokey) ||
      this.asString(json.albumseokey) ||
      null
    const albumId =
      this.asString(firstAlbum?.album_id) ||
      this.asString(json.album_id) ||
      null

    const parentalWarning = this.asNumber(getEntityValue('parental_warning'))
    const isPremiumRaw =
      this.asNumber(getEntityValue('is_premium')) ??
      this.asNumber(json.premium_content)

    const genreSet = new Set<string>()
    for (const t of this.asArrayRecords(getEntityValue('tags'))) {
      const tName = this.asString(t.tag_name)
      if (tName) genreSet.add(tName)
    }

    const pluginInfo: GaanaTrackPluginInfo = {
      trackId: trackIdStr || null,
      albumId,
      albumName,
      albumUrl: albumSeokey ? `https://gaana.com/album/${albumSeokey}` : null,
      genres: genreSet.size > 0 ? Array.from(genreSet) : undefined,
      language:
        this.asString(json.language) ||
        this.asString(getEntityValue('secondary_language')) ||
        null,
      isrc,
      playCount:
        this.asString(getEntityValue('play_ct')) ||
        this.asNumber(getEntityValue('play_ct')),
      favoriteCount:
        this.asNumber(json.favorite_count) ??
        this.asNumber(getEntityValue('total_favourite_count')),
      explicit: parentalWarning !== null ? parentalWarning > 0 : false,
      isPremium: isPremiumRaw !== null ? isPremiumRaw > 0 : false,
      youtubeId: this.asString(getEntityValue('youtube_id')) || null,
      lyricsUrl: this.asString(getEntityValue('lyrics_url')) || null
    }

    const info: TrackInfo = {
      identifier,
      isSeekable: true,
      author,
      length: duration,
      isStream: false,
      position: 0,
      title,
      uri: seokey ? `https://gaana.com/song/${seokey}` : '',
      artworkUrl,
      isrc,
      sourceName: 'gaana'
    }

    const encodedInput: TrackEncodeInput = { ...info, details: [] }
    return {
      encoded: encodeTrack(encodedInput),
      info,
      pluginInfo
    }
  }

  /**
   * Maps non-track search entries as pseudo-track payloads.
   * @param item - Search item.
   * @param type - Search type.
   * @returns Encoded pseudo-track payload.
   */
  private mapCollectionResult(
    item: Record<string, unknown>,
    type: string
  ): TrackData | null {
    const title =
      this.asString(item.ti) || this.asString(item.name) || 'Unknown'
    const seokey = this.asString(item.seo) || ''
    const uri = `https://gaana.com/${type}/${seokey}`

    const info: TrackInfo = {
      identifier: seokey,
      isSeekable: true,
      author: this.asString(item.sti) || 'Gaana',
      length: 0,
      isStream: false,
      position: 0,
      title,
      uri,
      artworkUrl: this.extractArtwork(item),
      isrc: null,
      sourceName: 'gaana'
    }

    const encodedInput: TrackEncodeInput = { ...info, details: [] }
    return { encoded: encodeTrack(encodedInput), info, pluginInfo: { type } }
  }

  /**
   * Fetches direct stream metadata from Gaana API.
   * @param trackId - Numeric Gaana track ID.
   * @returns Track URL payload or null.
   */
  private async fetchDirectStream(
    trackId: string
  ): Promise<TrackUrlResult | null> {
    const quality = this.streamQuality || 'high'
    const params = new URLSearchParams({
      quality,
      track_id: trackId,
      stream_format: 'mp4'
    })

    const proxy = this.getProxyConfig()
    const { body, error, statusCode } = await http1makeRequest(STREAM_URL_API, {
      method: 'POST',
      headers: {
        ...this.getHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString(),
      proxy
    })

    const data = this.asRecord(body)
    const dataNode = this.asRecord(data?.data)
    const streamPath = this.asString(dataNode?.stream_path)
    if (
      error ||
      statusCode !== 200 ||
      this.asString(data?.api_status) !== 'success' ||
      !streamPath
    ) {
      return null
    }

    const hlsUrl = this.decryptStreamPath(streamPath)
    if (!hlsUrl) return null

    try {
      const manifest = await this.parseHlsManifest(hlsUrl)
      if (manifest.segments.length === 0) return null

      const firstSegment = manifest.segments[0]
      const firstSegmentUrl = firstSegment?.url || ''
      let format = 'mp4'
      if (firstSegmentUrl.includes('.m4s')) format = 'fmp4'
      else if (firstSegmentUrl.includes('.mp4')) format = 'mp4'
      else if (firstSegmentUrl.includes('.ts')) format = 'mpegts'
      else if (firstSegmentUrl.includes('.aac')) format = 'aac'

      return {
        url: hlsUrl,
        protocol: 'hls',
        format: format === 'mpegts' ? 'mpegts' : 'mp4',
        additionalData: {
          initUrl: firstSegment?.map?.uri,
          segments: manifest.segments,
          format
        }
      }
    } catch (error) {
      logger(
        'debug',
        'Gaana',
        `Manifest parsing failed: ${this.getErrorMessage(error)}. Using HLS protocol as fallback.`
      )
      return {
        url: hlsUrl,
        protocol: 'hls',
        format: 'mpegts'
      }
    }
  }

  /**
   * Decrypts Gaana HLS stream path.
   * @param encryptedData - Encrypted stream path.
   * @returns Absolute HLS URL.
   */
  private decryptStreamPath(encryptedData: string): string {
    try {
      const offset = Number.parseInt(encryptedData[0] || '', 10)
      if (Number.isNaN(offset)) return ''

      const iv = Buffer.from(
        encryptedData.substring(offset, offset + 16),
        'utf8'
      )
      const ciphertextB64 = encryptedData.substring(offset + 16)
      const ciphertext = Buffer.from(`${ciphertextB64}==`, 'base64')
      const decipher = createDecipheriv('aes-128-cbc', CRYPTO_KEY, iv)
      decipher.setAutoPadding(false)

      let decrypted = decipher.update(ciphertext)
      decrypted = Buffer.concat([decrypted, decipher.final()])

      let rawText = decrypted.toString('utf8').replace(/\0/g, '').trim()
      rawText = rawText
        .split('')
        .filter((char) => {
          const code = char.charCodeAt(0)
          return code >= 32 && code <= 126
        })
        .join('')

      if (rawText.includes('/hls/')) {
        const pathStart = rawText.indexOf('hls/')
        return HLS_BASE_URL + rawText.substring(pathStart)
      }

      return ''
    } catch {
      return ''
    }
  }

  /**
   * Parses HLS manifest and resolves best media playlist.
   * @param url - HLS URL.
   * @returns Parsed media playlist.
   */
  private async parseHlsManifest(
    url: string
  ): Promise<{ segments: HLSSegment[] }> {
    const proxy = this.getProxyConfig()
    const { body } = await http1makeRequest(url, {
      headers: this.getHeaders(),
      proxy
    })

    if (typeof body !== 'string') throw new Error('Empty manifest')

    let parsed = parsePlaylist(body, url)
    if (parsed.isMaster) {
      const bestVariant = parsed.variants[0]
      if (!bestVariant) throw new Error('No HLS variants available')

      const { body: variantText } = await http1makeRequest(bestVariant.url, {
        headers: this.getHeaders(),
        proxy
      })

      if (typeof variantText !== 'string') {
        throw new Error('Variant manifest is empty')
      }

      parsed = parsePlaylist(variantText, bestVariant.url)
      if (parsed.isMaster)
        throw new Error('Nested master playlist not supported')
    }

    return {
      segments: parsed.segments
    }
  }

  /**
   * Streams HLS segment queue into output stream.
   * @param outputStream - Output stream.
   * @param initUrl - Optional init segment URL.
   * @param segments - Segment URLs.
   */
  private async streamSegments(
    outputStream: PassThrough,
    initUrl: string | null,
    segments: string[]
  ): Promise<void> {
    const queue: string[] = []
    if (initUrl) queue.push(initUrl)
    queue.push(...segments)

    try {
      for (const segmentUrl of queue) {
        if (outputStream.destroyed) break
        await this.streamUrlChunk(outputStream, segmentUrl)
      }
    } catch (error) {
      if (!outputStream.destroyed) {
        outputStream.emit('error', error)
      }
    } finally {
      if (!outputStream.destroyed) {
        outputStream.emit('finishBuffering')
        outputStream.end()
      }
    }
  }

  /**
   * Streams one segment URL into output stream.
   * @param outputStream - Output stream.
   * @param url - Segment URL.
   * @returns True when chunk succeeded.
   */
  private async streamUrlChunk(
    outputStream: PassThrough,
    url: string
  ): Promise<boolean> {
    try {
      const proxy = this.getProxyConfig()
      const { stream, statusCode, error } = await http1makeRequest(url, {
        method: 'GET',
        streamOnly: true,
        headers: this.getHeaders(),
        proxy
      })

      if (error || statusCode !== 200 || !stream) {
        logger('warn', 'Gaana', `Segment fetch failed: ${error || statusCode}`)
        return false
      }

      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk) => {
          if (!outputStream.destroyed) {
            if (!outputStream.write(chunk)) stream.pause()
          }
        })
        outputStream.on('drain', () => {
          stream.resume()
        })
        stream.once('end', () => resolve())
        stream.once('error', reject)
      })

      return true
    } catch (error) {
      logger(
        'warn',
        'Gaana',
        `Segment stream error: ${this.getErrorMessage(error)}`
      )
      return false
    }
  }

  /**
   * Fetches one or more tracks by identifiers.
   * @param identifiers - Song identifiers.
   * @returns Track payload list.
   */
  private async getTracks(identifiers: string[]): Promise<TrackData[]> {
    if (identifiers.length === 0) return []

    const tracks = await Promise.all(
      identifiers.map(async (id) => {
        const trackResult = await this.getSong(id)
        return trackResult.loadType === 'track'
          ? this.extractTrackData(trackResult.data)
          : null
      })
    )

    return tracks.filter((item): item is TrackData => item !== null)
  }

  /**
   * Performs Gaana API request.
   * @param params - Query params.
   * @param query - Relative page query for referer.
   * @returns Parsed object payload.
   */
  private async getJson(
    params: Record<string, string | number>,
    query = ''
  ): Promise<Record<string, unknown> | null> {
    const url = `${API_URL}?${new URLSearchParams(
      Object.entries(params).map(([key, value]) => [key, String(value)]) as [
        string,
        string
      ][]
    ).toString()}`

    const proxy = this.getProxyConfig()
    const { body, statusCode, error } = await http1makeRequest(url, {
      method: 'POST',
      headers: this.getHeaders(query),
      disableBodyCompression: true,
      proxy
    })

    if (error || statusCode !== 200 || !body) return null
    if (typeof body === 'string') {
      try {
        return this.asRecord(JSON.parse(body))
      } catch {
        return null
      }
    }

    return this.asRecord(body)
  }

  /**
   * Returns source-specific headers.
   * @param query - Optional referer suffix.
   * @returns HTTP headers.
   */
  private getHeaders(query = ''): Record<string, string> {
    return {
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://gaana.com',
      Referer: `https://gaana.com/${query}`
    }
  }

  /**
   * Returns load limit by collection type.
   * @param type - Collection type.
   * @returns Max load size.
   */
  private getLoadLimit(type: string): number {
    if (type === 'album') return this.albumLoadLimit
    if (type === 'artist') return this.artistLoadLimit
    return this.playlistLoadLimit
  }

  /**
   * Gets proxy configuration.
   * @returns Proxy configuration object or null.
   */
  private getProxyConfig():
    | {
        url: string
        username?: string
        password?: string
      }
    | undefined {
    const proxy = this.asRecord(this.config.network?.proxy)
    const url = this.asString(proxy?.url)
    if (!url) return undefined

    const username = this.asString(proxy?.username) || undefined
    const password = this.asString(proxy?.password) || undefined
    return { url, username, password }
  }

  /**
   * Converts unknown search data into best-match candidates.
   * @param data - Unknown search payload.
   * @returns Candidate list.
   */
  private toTrackInfoArray(data: unknown): TrackInfo[] {
    if (!Array.isArray(data)) return []

    const tracks: TrackInfo[] = []
    for (const item of data) {
      const info = this.asRecord(this.asRecord(item)?.info)
      if (!info) continue

      const identifier = this.asString(info.identifier)
      const isSeekable = this.asBoolean(info.isSeekable)
      const author = this.asString(info.author)
      const length = this.asNumber(info.length)
      const isStream = this.asBoolean(info.isStream)
      const position = this.asNumber(info.position)
      const title = this.asString(info.title)
      const uri = this.asString(info.uri)
      const sourceName = this.asString(info.sourceName)

      if (
        identifier === null ||
        isSeekable === null ||
        author === null ||
        length === null ||
        isStream === null ||
        position === null ||
        title === null ||
        uri === null ||
        sourceName === null
      ) {
        continue
      }

      tracks.push({
        identifier,
        isSeekable,
        author,
        length,
        isStream,
        position,
        title,
        uri,
        artworkUrl: this.asString(info.artworkUrl) || null,
        isrc: this.asString(info.isrc) || null,
        sourceName
      })
    }

    return tracks
  }

  /**
   * Extracts canonical track payload from unknown object.
   * @param data - Unknown payload.
   * @returns Track payload or null.
   */
  private extractTrackData(data: unknown): {
    encoded: string
    info: TrackInfo
    pluginInfo: Record<string, unknown>
  } | null {
    const object = this.asRecord(data)
    const info = this.asRecord(object?.info)
    if (!object || !info) return null

    const identifier = this.asString(info.identifier)
    const isSeekable = this.asBoolean(info.isSeekable)
    const author = this.asString(info.author)
    const length = this.asNumber(info.length)
    const isStream = this.asBoolean(info.isStream)
    const position = this.asNumber(info.position)
    const title = this.asString(info.title)
    const uri = this.asString(info.uri)
    const sourceName = this.asString(info.sourceName)
    const encoded = this.asString(object.encoded)
    const pluginInfo = this.asRecord(object.pluginInfo)
    if (
      identifier === null ||
      isSeekable === null ||
      author === null ||
      length === null ||
      isStream === null ||
      position === null ||
      title === null ||
      uri === null ||
      sourceName === null ||
      encoded === null
    ) {
      return null
    }

    return {
      encoded,
      info: {
        identifier,
        isSeekable,
        author,
        length,
        isStream,
        position,
        title,
        uri,
        artworkUrl: this.asString(info.artworkUrl) || null,
        isrc: this.asString(info.isrc) || null,
        sourceName
      },
      pluginInfo: pluginInfo || {}
    }
  }

  /**
   * Normalizes unknown segment array payload.
   * @param value - Unknown segment payload.
   * @returns Segment list with URL and duration.
   */
  private normalizeSegments(
    value: unknown
  ): Array<{ url: string; duration: number }> {
    if (!Array.isArray(value)) return []

    const result: Array<{ url: string; duration: number }> = []
    for (const item of value) {
      const segment = this.asRecord(item)
      const segmentUrl = this.asString(segment?.url)
      if (!segmentUrl) continue

      result.push({
        url: segmentUrl,
        duration: this.asNumber(segment?.duration) ?? 0
      })
    }

    return result
  }

  /**
   * Casts unknown value to record.
   * @param value - Unknown value.
   * @returns Record or null.
   */
  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  }

  /**
   * Casts unknown value to record array.
   * @param value - Unknown value.
   * @returns Record array.
   */
  private asArrayRecords(value: unknown): Record<string, unknown>[] {
    if (!Array.isArray(value)) return []
    return value
      .map((item) => this.asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null)
  }

  /**
   * Casts unknown value to string.
   * @param value - Unknown value.
   * @returns String or null.
   */
  private asString(value: unknown): string | null {
    if (typeof value === 'string') return value
    if (typeof value === 'number' && Number.isFinite(value))
      return String(value)
    return null
  }

  /**
   * Casts unknown value to finite number.
   * @param value - Unknown value.
   * @returns Number or null.
   */
  private asNumber(value: unknown): number | null {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null
    }
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed.length === 0) return null
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) ? parsed : null
    }
    return null
  }

  /**
   * Extracts artwork URL and ensures HTTPS protocol.
   * @param record - Entity or track object.
   * @returns HTTPS artwork URL or null.
   */
  private extractArtwork(record: Record<string, unknown>): string | null {
    const raw =
      this.asString(record.artwork_large) ||
      this.asString(record.atw) ||
      this.asString(record.artwork_medium) ||
      this.asString(record.artwork_web) ||
      this.asString(record.artwork_bio) ||
      this.asString(record.artwork) ||
      this.asString(record.aw)
    if (!raw) return null
    return raw.replace(/^http:\/\//i, 'https://')
  }

  /**
   * Casts unknown value to boolean.
   * @param value - Unknown value.
   * @returns Boolean or null.
   */
  private asBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null
  }

  /**
   * Normalizes unknown errors to string.
   * @param error - Unknown error.
   * @returns Error message.
   */
  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}
