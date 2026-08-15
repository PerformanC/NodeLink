import { PassThrough, type Readable } from 'node:stream'
import HLSHandler from '../playback/hls/HLSHandler.ts'
import {
  SEARCH_TYPE_MAP,
  type SoundCloudApiPlaylist,
  type SoundCloudApiSearchItem,
  type SoundCloudApiSearchResponse,
  type SoundCloudApiTrack,
  type SoundCloudApiTranscoding,
  type SoundCloudCachedUrlResult,
  type SoundCloudNodeLinkContext,
  type SoundCloudParsedSearch,
  type SoundCloudSearchType,
  type SoundCloudStreamUrlResult
} from '../typings/sources/soundcloud.types.ts'
import type {
  SourceResult,
  TrackInfo,
  TrackUrlResult
} from '../typings/sources/source.types.ts'
import type { TrackEncodeInput } from '../typings/utils.types.ts'
import { encodeTrack, http1makeRequest, logger, makeRequest } from '../utils.ts'

const BASE_URL = 'https://api-v2.soundcloud.com'
const SOUNDCLOUD_URL = 'https://soundcloud.com'
const ASSET_PATTERN = /https:\/\/a-v2\.sndcdn\.com\/assets\/[a-zA-Z0-9-]+\.js/g
const CLIENT_ID_PATTERN =
  /(?:[?&/]?(?:client_id)[\s:=&]*"?|"data":{"id":")([A-Za-z0-9]{32})"?/
const TRACK_PATTERN =
  /^https?:\/\/(?:www\.|m\.)?soundcloud\.com\/[^/\s]+\/(?:sets\/)?[^/\s?]+(\?.*)?$/
const SEARCH_URL_PATTERN =
  /^https?:\/\/(?:www\.)?soundcloud\.com\/search(?:\/(sounds|people|albums|sets))?(?:\?|$)/
const SHORT_URL_PATTERN =
  /^https?:\/\/(?:www\.)?on\.soundcloud\.com\/[A-Za-z0-9]+\/?(?:\?.*)?$/
const BATCH_SIZE = 50
const DEFAULT_PRIORITY = 85

interface SoundCloudSourceState {
  nodelink: SoundCloudNodeLinkContext
  baseUrl: string
  searchTerms: string[]
  patterns: RegExp[]
  priority: number
  clientId: string | null
}

interface SoundCloudTrackDataResult {
  encoded: string
  info: TrackInfo
  pluginInfo: Record<string, unknown>
}

export default class SoundCloudSource implements SoundCloudSourceState {
  declare nodelink: SoundCloudNodeLinkContext
  declare baseUrl: string
  declare searchTerms: string[]
  declare patterns: RegExp[]
  declare priority: number
  declare clientId: string | null

  constructor(nodelink: SoundCloudNodeLinkContext) {
    this.nodelink = nodelink
    this.baseUrl = BASE_URL
    this.searchTerms = ['scsearch']
    this.patterns = [TRACK_PATTERN, SEARCH_URL_PATTERN, SHORT_URL_PATTERN]
    this.priority = DEFAULT_PRIORITY
    this.clientId = nodelink.options?.sources?.soundcloud?.clientId ?? null
  }

  async setup(): Promise<boolean> {
    if (this.clientId) {
      logger(
        'info',
        'Sources',
        `Loaded SoundCloud (clientId: ${this.clientId}) from config`
      )
      return true
    }

    const cachedId = this.nodelink.credentialManager.get<string>(
      'soundcloud_client_id'
    )
    if (cachedId) {
      this.clientId = cachedId
      logger(
        'info',
        'Sources',
        `Loaded SoundCloud (clientId: ${this.clientId}) from CredentialManager`
      )
      return true
    }

    try {
      const mainPage = await makeRequest(SOUNDCLOUD_URL, { method: 'GET' })

      if (!mainPage || mainPage.error) {
        this._logError('Failed to load SoundCloud main page', mainPage?.error)
        return false
      }

      let clientId: string | undefined

      if (
        typeof mainPage.body === 'string' &&
        mainPage.body.match(CLIENT_ID_PATTERN)
      ) {
        clientId = mainPage.body.match(CLIENT_ID_PATTERN)?.[1]
        logger(
          'debug',
          'Sources',
          `SoundCloud client_id (${clientId}) Found from main page`
        )
      }

      try {
        if (!clientId && typeof mainPage.body === 'string') {
          const assetMatches = [...mainPage.body.matchAll(ASSET_PATTERN)]

          if (assetMatches.length === 0) {
            logger('warn', 'Sources', 'SoundCloud asset URL not found')
            return false
          }

          clientId = await Promise.any(
            assetMatches.map(async (match) => {
              const assetUrl = match[0]
              const asset = await http1makeRequest(assetUrl)

              if (asset && !asset.error && typeof asset.body === 'string') {
                const idMatch = asset.body.match(CLIENT_ID_PATTERN)
                if (idMatch?.[1]) {
                  return idMatch[1]
                }
              }
              throw new Error('No client_id found in asset')
            })
          )
        }

        if (clientId) {
          this.clientId = clientId
          this.nodelink.credentialManager.set(
            'soundcloud_client_id',
            clientId,
            7 * 24 * 60 * 60 * 1000
          )
          logger(
            'info',
            'Sources',
            `Loaded SoundCloud (clientId: ${this.clientId})`
          )
        }

        return true
      } catch {
        logger('warn', 'Sources', 'client_id not found in any assets')
        return false
      }
    } catch (err) {
      this._logError('Setup failed', err)
      return false
    }
  }

  match(url: string): boolean {
    return this.patterns.some((p) => p.test(url))
  }

  _parseSearchIdentifier(
    rawQuery: string,
    providedType: string | null = null
  ): SoundCloudParsedSearch {
    let searchType: SoundCloudSearchType = 'tracks'
    let searchQuery = (rawQuery || '').trim()

    const scsearchMatch = searchQuery.match(/^scsearch:?/i)
    if (scsearchMatch) {
      searchQuery = searchQuery.substring(scsearchMatch[0].length)
    }

    const colonIndex = searchQuery.indexOf(':')
    if (colonIndex > 0 && colonIndex <= 12) {
      const possibleType = searchQuery.substring(0, colonIndex).toLowerCase()
      const normalizedType = SEARCH_TYPE_MAP[possibleType]

      if (normalizedType) {
        searchType = normalizedType
        searchQuery = searchQuery.substring(colonIndex + 1).trim()
        return { type: searchType, query: searchQuery }
      }
    }

    if (providedType && typeof providedType === 'string') {
      let cleanType = providedType.toLowerCase().trim()

      if (cleanType.startsWith('scsearch:')) {
        cleanType = cleanType.substring(9)
      } else if (cleanType === 'scsearch') {
        cleanType = 'tracks'
      }

      const normalizedType = SEARCH_TYPE_MAP[cleanType]
      if (normalizedType) {
        searchType = normalizedType
      }
    }

    return { type: searchType, query: searchQuery }
  }

  async search(
    query: string,
    type: string | null = null
  ): Promise<SourceResult> {
    const parsed = this._parseSearchIdentifier(query, type)
    const searchType = parsed.type
    const searchQuery = parsed.query

    if (!this._isValidString(searchQuery)) {
      return this._buildError('Invalid query')
    }

    const endpoint = this._getSearchEndpoint(searchType)

    try {
      const params = new URLSearchParams({
        q: searchQuery,
        client_id: this.clientId ?? '',
        limit: String(this.nodelink.options.search.maxResults ?? 50),
        offset: '0',
        linked_partitioning: '1'
      })

      if (searchType === 'all') {
        params.append('facet', 'model')
      }

      const req = await http1makeRequest(`${BASE_URL}${endpoint}?${params}`)

      if (req.error || req.statusCode !== 200) {
        return this._buildError(
          (req.error as { message?: string } | undefined)?.message ??
            `Status: ${req.statusCode}`
        )
      }

      const body = req.body as SoundCloudApiSearchResponse
      if (!body?.total_results && !body?.collection?.length) {
        logger(
          'debug',
          'Sources',
          `No SoundCloud results for '${searchQuery}' (type: ${searchType})`
        )
        return { loadType: 'empty', data: {} }
      }

      const collection = body?.collection ?? []
      const data = this._processSearchResults(collection, searchType)
      logger(
        'debug',
        'Sources',
        `Found ${data.length} SoundCloud results for '${searchQuery}' (type: ${searchType})`
      )

      return { loadType: 'search', data }
    } catch (err: unknown) {
      this._logError('Search failed', err)
      return this._buildError(
        err instanceof Error ? err.message : 'Unknown error'
      )
    }
  }

  _getSearchEndpoint(type: SoundCloudSearchType): string {
    switch (type) {
      case 'tracks':
        return '/search/tracks'
      case 'users':
        return '/search/users'
      case 'albums':
        return '/search/albums'
      case 'playlists':
        return '/search/playlists'
      case 'all':
        return '/search'
      default:
        return '/search/tracks'
    }
  }

  _processSearchResults(
    collection: SoundCloudApiSearchItem[],
    type: SoundCloudSearchType
  ): SoundCloudTrackDataResult[] {
    if (!Array.isArray(collection)) return []

    switch (type) {
      case 'users':
        return this._processUsers(collection)
      case 'albums':
        return this._processAlbums(collection)
      case 'playlists':
        return this._processPlaylists(collection)
      case 'all':
        return this._processAll(collection)
      default:
        return this._processTracks(collection)
    }
  }

  _processUsers(
    collection: SoundCloudApiSearchItem[]
  ): SoundCloudTrackDataResult[] {
    const max = this.nodelink.options.search.maxResults ?? 50
    const users: SoundCloudTrackDataResult[] = []

    for (let i = 0; i < collection.length && users.length < max; i++) {
      const user = collection[i]
      if (user && (user.kind === 'user' || 'username' in user)) {
        const info: TrackEncodeInput = {
          title: (user as { username?: string }).username ?? 'Unknown',
          author: 'SoundCloud',
          length: 0,
          identifier: String((user as { id?: number }).id ?? ''),
          isSeekable: false,
          isStream: false,
          uri: (user as { permalink_url?: string }).permalink_url ?? '',
          artworkUrl:
            (user as { avatar_url?: string | null }).avatar_url ?? null,
          sourceName: 'soundcloud',
          position: 0,
          isrc: null,
          details: []
        }

        users.push({
          encoded: encodeTrack(info),
          info: this._toTrackInfo(info),
          pluginInfo: {
            type: 'user',
            followers:
              (user as { followers_count?: number }).followers_count ?? 0,
            trackCount: (user as { track_count?: number }).track_count ?? 0
          }
        })
      }
    }

    return users
  }

  _processAlbums(
    collection: SoundCloudApiSearchItem[]
  ): SoundCloudTrackDataResult[] {
    const max = this.nodelink.options.search.maxResults ?? 50
    const albums: SoundCloudTrackDataResult[] = []

    for (let i = 0; i < collection.length && albums.length < max; i++) {
      const album = collection[i]
      if (album && (album.kind === 'playlist' || 'title' in album)) {
        const info: TrackEncodeInput = {
          title: (album as { title?: string }).title ?? 'Unknown',
          author:
            (album as { user?: { username?: string } }).user?.username ??
            'Unknown',
          length: 0,
          identifier: String((album as { id?: number }).id ?? ''),
          isSeekable: true,
          isStream: false,
          uri: (album as { permalink_url?: string }).permalink_url ?? '',
          artworkUrl:
            (album as { artwork_url?: string | null }).artwork_url ?? null,
          sourceName: 'soundcloud',
          position: 0,
          isrc: null,
          details: []
        }

        albums.push({
          encoded: encodeTrack(info),
          info: this._toTrackInfo(info),
          pluginInfo: {
            type: 'album',
            trackCount: (album as { track_count?: number }).track_count ?? 0
          }
        })
      }
    }

    return albums
  }

  _processPlaylists(
    collection: SoundCloudApiSearchItem[]
  ): SoundCloudTrackDataResult[] {
    const max = this.nodelink.options.search.maxResults ?? 50
    const playlists: SoundCloudTrackDataResult[] = []

    for (let i = 0; i < collection.length && playlists.length < max; i++) {
      const playlist = collection[i]
      if (playlist && (playlist.kind === 'playlist' || 'title' in playlist)) {
        const info: TrackEncodeInput = {
          title: (playlist as { title?: string }).title ?? 'Unknown',
          author:
            (playlist as { user?: { username?: string } }).user?.username ??
            'Unknown',
          length: 0,
          identifier: String((playlist as { id?: number }).id ?? ''),
          isSeekable: true,
          isStream: false,
          uri: (playlist as { permalink_url?: string }).permalink_url ?? '',
          artworkUrl:
            (playlist as { artwork_url?: string | null }).artwork_url ?? null,
          sourceName: 'soundcloud',
          position: 0,
          isrc: null,
          details: []
        }

        playlists.push({
          encoded: encodeTrack(info),
          info: this._toTrackInfo(info),
          pluginInfo: {
            type: 'playlist',
            trackCount: (playlist as { track_count?: number }).track_count ?? 0
          }
        })
      }
    }

    return playlists
  }

  _processAll(
    collection: SoundCloudApiSearchItem[]
  ): SoundCloudTrackDataResult[] {
    const max = this.nodelink.options.search.maxResults ?? 50
    const results: SoundCloudTrackDataResult[] = []

    for (let i = 0; i < collection.length && results.length < max; i++) {
      const item = collection[i]

      if (item?.kind === 'track') {
        results.push(this._buildTrack(item as SoundCloudApiTrack))
      } else if (item?.kind === 'user') {
        const info: TrackEncodeInput = {
          title: (item as { username?: string }).username ?? 'Unknown',
          author: 'SoundCloud',
          length: 0,
          identifier: String((item as { id?: number }).id ?? ''),
          isSeekable: false,
          isStream: false,
          uri: (item as { permalink_url?: string }).permalink_url ?? '',
          artworkUrl:
            (item as { avatar_url?: string | null }).avatar_url ?? null,
          sourceName: 'soundcloud',
          position: 0,
          isrc: null,
          details: []
        }

        results.push({
          encoded: encodeTrack(info),
          info: this._toTrackInfo(info),
          pluginInfo: {
            type: 'user',
            followers:
              (item as { followers_count?: number }).followers_count ?? 0,
            trackCount: (item as { track_count?: number }).track_count ?? 0
          }
        })
      } else if (item?.kind === 'playlist') {
        const info: TrackEncodeInput = {
          title: (item as { title?: string }).title ?? 'Unknown',
          author:
            (item as { user?: { username?: string } }).user?.username ??
            'Unknown',
          length: 0,
          identifier: String((item as { id?: number }).id ?? ''),
          isSeekable: true,
          isStream: false,
          uri: (item as { permalink_url?: string }).permalink_url ?? '',
          artworkUrl:
            (item as { artwork_url?: string | null }).artwork_url ?? null,
          sourceName: 'soundcloud',
          position: 0,
          isrc: null,
          details: []
        }

        results.push({
          encoded: encodeTrack(info),
          info: this._toTrackInfo(info),
          pluginInfo: {
            type: (item as { is_album?: boolean }).is_album
              ? 'album'
              : 'playlist',
            trackCount: (item as { track_count?: number }).track_count ?? 0
          }
        })
      }
    }

    return results
  }

  async _expandShortUrl(shortUrl: string): Promise<string | null> {
    const res = await http1makeRequest(shortUrl, {
      method: 'HEAD'
    })

    if (res.finalUrl && res.finalUrl !== shortUrl) {
      return res.finalUrl.split('?')[0] ?? null
    }

    if (
      (res.statusCode === 301 ||
        res.statusCode === 302 ||
        res.statusCode === 307) &&
      typeof res.headers?.location === 'string'
    ) {
      const location = res.headers.location
      const absolute = location.startsWith('http')
        ? location
        : new URL(location, shortUrl).toString()
      return absolute.split('?')[0] ?? null
    }

    return null
  }

  async resolve(url: string): Promise<SourceResult> {
    if (!this._isValidString(url)) {
      return this._buildError('Invalid URL')
    }

    if (SHORT_URL_PATTERN.test(url)) {
      try {
        const expanded = await this._expandShortUrl(url)
        if (!expanded) {
          return this._buildError('Failed to expand short URL')
        }
        url = expanded
      } catch (err: unknown) {
        this._logError('Short URL expansion failed', err)
        return this._buildError(
          err instanceof Error ? err.message : 'Unknown error'
        )
      }
    }

    const searchMatch = url.match(SEARCH_URL_PATTERN)
    if (searchMatch) {
      return this._resolveSearchUrl(
        url,
        searchMatch[1] as 'sounds' | 'people' | 'albums' | 'sets' | undefined
      )
    }

    try {
      const reqUrl = `${BASE_URL}/resolve?${new URLSearchParams({ url, client_id: this.clientId ?? '' })}`
      const req = await http1makeRequest(reqUrl)

      if (req.statusCode === 404) return { loadType: 'empty', data: {} }

      if (req.error || req.statusCode !== 200) {
        return this._buildError(
          (req.error as { message?: string } | undefined)?.message ??
            `Status: ${req.statusCode}`
        )
      }

      const body = req.body as SoundCloudApiTrack | SoundCloudApiPlaylist

      if (!body?.kind) return this._buildError('Invalid response')

      if (body.kind === 'track') {
        return {
          loadType: 'track',
          data: this._buildTrack(body as SoundCloudApiTrack)
        }
      }

      if (body.kind === 'playlist') {
        return await this._resolvePlaylist(body as SoundCloudApiPlaylist)
      }

      return { loadType: 'empty', data: {} }
    } catch (err: unknown) {
      this._logError('Resolve failed', err)
      return this._buildError(
        err instanceof Error ? err.message : 'Unknown error'
      )
    }
  }

  async _resolveSearchUrl(
    url: string,
    searchType?: 'sounds' | 'people' | 'albums' | 'sets'
  ): Promise<SourceResult> {
    try {
      const urlObj = new URL(url)
      const query = urlObj.searchParams.get('q')

      if (!query) {
        return { loadType: 'empty', data: {} }
      }

      const typeMap: Record<string, SoundCloudSearchType> = {
        sounds: 'tracks',
        people: 'users',
        albums: 'albums',
        sets: 'playlists'
      }

      const type = searchType ? typeMap[searchType] || 'all' : 'all'

      return await this.search(query, type)
    } catch (err: unknown) {
      this._logError('Search URL resolve failed', err)
      return this._buildError(
        err instanceof Error ? err.message : 'Unknown error'
      )
    }
  }

  async _resolvePlaylist(body: SoundCloudApiPlaylist): Promise<SourceResult> {
    const complete: SoundCloudApiTrack[] = []
    const ids: number[] = []

    for (const t of body.tracks ?? []) {
      if (t && 'title' in t && 'user' in t) {
        complete.push(t as SoundCloudApiTrack)
      } else if (t && 'id' in t && typeof t.id === 'number') {
        ids.push(t.id)
      }
    }

    const limit = this.nodelink.options.playback.maxPlaylistLength ?? 100
    const neededIds = ids.slice(0, Math.max(0, limit - complete.length))

    if (neededIds.length > 0) {
      const chunks: number[][] = []

      for (let i = 0; i < neededIds.length; i += BATCH_SIZE) {
        chunks.push(neededIds.slice(i, i + BATCH_SIZE))
      }

      const promises = chunks.map((chunk) => {
        const batchUrl = `${BASE_URL}/tracks?${new URLSearchParams({
          ids: chunk.join(','),
          client_id: this.clientId ?? ''
        })}`

        return http1makeRequest(batchUrl, { method: 'GET' })
          .then((res) =>
            Array.isArray(res.body) ? (res.body as SoundCloudApiTrack[]) : []
          )
          .catch((err: unknown) => {
            this._logError('Batch fetch failed', err)
            return []
          })
      })

      const results = await Promise.all(promises)
      results.forEach((batch) => {
        complete.push(...batch)
      })
    }

    const tracks = complete
      .slice(0, limit)
      .filter((t) => t.title)
      .map((t) => this._buildTrack(t))

    return {
      loadType: 'playlist',
      data: {
        info: {
          name: body.title || 'Untitled playlist',
          selectedTrack: 0
        },
        pluginInfo: {},
        tracks
      }
    }
  }

  _processTracks(
    collection: SoundCloudApiSearchItem[]
  ): SoundCloudTrackDataResult[] {
    const max = this.nodelink.options.search.maxResults ?? 50
    const tracks: SoundCloudTrackDataResult[] = []

    if (!Array.isArray(collection)) return []

    for (let i = 0; i < collection.length && tracks.length < max; i++) {
      const item = collection[i]
      if (item?.kind === 'track') {
        tracks.push(this._buildTrack(item as SoundCloudApiTrack))
      }
    }

    return tracks
  }

  _buildTrack(item: SoundCloudApiTrack): SoundCloudTrackDataResult {
    const info: TrackEncodeInput = {
      title: item.title ?? 'Unknown',
      author: item.user?.username ?? 'Unknown',
      length: item.duration ?? 0,
      identifier: String(item.id ?? ''),
      isSeekable: true,
      isStream: false,
      uri: item.permalink_url ?? '',
      artworkUrl: item.artwork_url ?? null,
      isrc: item.publisher_metadata?.isrc ?? null,
      sourceName: 'soundcloud',
      position: 0,
      details: []
    }

    return {
      encoded: encodeTrack(info),
      info: this._toTrackInfo(info),
      pluginInfo: {}
    }
  }

  _toTrackInfo(input: TrackEncodeInput): TrackInfo {
    return {
      title: input.title,
      author: input.author,
      length: input.length,
      identifier: input.identifier,
      isSeekable: input.isSeekable,
      isStream: input.isStream,
      uri: input.uri ?? '',
      artworkUrl: input.artworkUrl ?? null,
      isrc: input.isrc ?? null,
      sourceName: input.sourceName,
      position: input.position
    }
  }

  async getTrackUrl(
    info: TrackInfo,
    forceRefresh: boolean = false
  ): Promise<TrackUrlResult> {
    if (!info?.identifier) {
      return this._buildException('Invalid track info')
    }

    if (!forceRefresh) {
      const cached =
        this.nodelink.trackCacheManager.get<SoundCloudCachedUrlResult>(
          'soundcloud',
          info.identifier
        )
      if (cached) {
        const expiresMatch = cached.url.match(/expires=(\d+)/)
        const expires = expiresMatch?.[1]
          ? parseInt(expiresMatch[1], 10) * 1000
          : 0

        if (expires > Date.now() + 5000) {
          logger(
            'debug',
            'Sources',
            `Using cached SoundCloud URL for ${info.identifier}`
          )
          return cached
        }
      }
    }

    try {
      const trackUrl = `https://api.soundcloud.com/tracks/${info.identifier}`
      const reqUrl = `${BASE_URL}/resolve?${new URLSearchParams({ url: trackUrl, client_id: this.clientId ?? '' })}`
      const req = await http1makeRequest(reqUrl)

      if (req.error || req.statusCode !== 200) {
        this._logError('getTrackUrl failed', req.error)
        return this._buildException(
          (req.error as { message?: string } | undefined)?.message ??
            `Status: ${req.statusCode}`
        )
      }

      const body = req.body as SoundCloudApiTrack & {
        errors?: Array<{ error_message?: string }>
      }
      if (body?.errors?.[0]) {
        const msg = body.errors[0].error_message ?? 'Unknown error'
        this._logError('API error', new Error(msg))
        return this._buildException(msg)
      }

      const result = await this._selectTranscoding(body)
      if (result && !result.exception) {
        this.nodelink.trackCacheManager.set(
          'soundcloud',
          info.identifier,
          result,
          1000 * 60 * 15
        )
      }
      return result
    } catch (err: unknown) {
      this._logError('getTrackUrl exception', err)
      return this._buildException(
        err instanceof Error ? err.message : 'Unknown error'
      )
    }
  }

  async _selectTranscoding(
    body: SoundCloudApiTrack
  ): Promise<SoundCloudStreamUrlResult> {
    const transcodings: SoundCloudApiTranscoding[] =
      body.media?.transcodings ?? []

    if (!transcodings.length && (body.hls_aac_160_url || body.hls_aac_96_url)) {
      if (body.hls_aac_160_url) {
        transcodings.push({
          format: { protocol: 'hls', mime_type: 'audio/aac' },
          url: body.hls_aac_160_url,
          quality: 'hq'
        })
      }

      if (body.hls_aac_96_url) {
        transcodings.push({
          format: { protocol: 'hls', mime_type: 'audio/aac' },
          url: body.hls_aac_96_url,
          quality: 'sq'
        })
      }
    }

    if (transcodings.length === 0) {
      return this._buildException('No transcodings available')
    }

    const progressiveMp3 = transcodings.find(
      (t) =>
        t.format?.protocol === 'progressive' &&
        t.format?.mime_type?.includes('mpeg')
    )

    const progressiveAac = transcodings.find(
      (t) =>
        t.format?.protocol === 'progressive' &&
        t.format?.mime_type?.includes('aac')
    )

    const hlsAacHigh = transcodings.find(
      (t) =>
        t.format?.protocol === 'hls' &&
        (t.format?.mime_type?.includes('aac') ||
          t.format?.mime_type?.includes('mp4')) &&
        (t.quality === 'hq' ||
          t.preset?.includes('160') ||
          t.url?.includes('160'))
    )

    const hlsAacStandard = transcodings.find(
      (t) =>
        t.format?.protocol === 'hls' &&
        (t.format?.mime_type?.includes('aac') ||
          t.format?.mime_type?.includes('mp4'))
    )

    const anyHls = transcodings.find((t) => t.format?.protocol === 'hls')
    const anyProgressive = transcodings.find(
      (t) => t.format?.protocol === 'progressive'
    )

    const selected =
      progressiveMp3 ||
      progressiveAac ||
      hlsAacHigh ||
      hlsAacStandard ||
      anyProgressive ||
      anyHls ||
      transcodings[0]

    if (!selected?.url) {
      return this._buildException('No valid transcoding found')
    }

    if (selected.format?.mime_type?.includes('opus')) {
      logger(
        'warn',
        'Sources',
        `Using Opus codec which may cause decoder issues (track: ${body.id})`
      )
    }

    const streamAuthUrl = `${selected.url}?client_id=${this.clientId}`
    const urlReq = await http1makeRequest(streamAuthUrl, { method: 'GET' })
    let finalUrl: string | null = null

    if (urlReq.finalUrl && urlReq.finalUrl !== streamAuthUrl) {
      finalUrl = urlReq.finalUrl
    } else if (urlReq.statusCode === 302 || urlReq.statusCode === 301) {
      finalUrl =
        typeof urlReq.headers?.location === 'string'
          ? urlReq.headers.location
          : null
    } else if (
      urlReq.body &&
      typeof urlReq.body === 'object' &&
      'url' in urlReq.body &&
      urlReq.body.url
    ) {
      finalUrl = urlReq.body.url as string
    } else if (urlReq.statusCode === 200) {
      finalUrl = streamAuthUrl
    }

    if (!finalUrl) {
      return this._buildException('Failed to resolve stream URL')
    }

    if (
      finalUrl.includes('cf-preview-media.sndcdn.com') ||
      finalUrl.includes('/preview/')
    ) {
      return this._buildException('Track only has preview URL')
    }

    const mimeType = selected.format?.mime_type?.toLowerCase() ?? ''
    const protocol = selected.format?.protocol ?? 'progressive'
    let format: 'mp3' | 'm4a' | 'aac_hls' | 'opus' | 'arbitrary' = 'arbitrary'

    if (mimeType.includes('mpeg')) {
      format = 'mp3'
    } else if (mimeType.includes('aac') || mimeType.includes('mp4')) {
      if (protocol === 'hls') {
        format = 'aac_hls'
      } else {
        format = 'm4a'
      }
    } else if (mimeType.includes('opus')) {
      format = 'opus'
    }

    return {
      url: finalUrl,
      protocol,
      format,
      additionalData: { format }
    }
  }

  async loadStream(
    _track: TrackInfo,
    url: string,
    protocol?: string,
    additionalData?: { format?: string; startTime?: number }
  ): Promise<{ stream: Readable; type?: string }> {
    if (protocol === 'progressive') {
      const stream = new PassThrough()
      this._handleProgressive(url, stream)
      return { stream }
    } else if (protocol === 'hls') {
      let type = additionalData?.format

      if (type === 'aac_hls') {
        type = 'fmp4-buffered'
      } else if (type === 'mp3') {
        type = 'mp3'
      } else {
        type = 'mpegts'
      }

      const stream = new HLSHandler(url, {
        type,
        localAddress: this.nodelink.routePlanner?.getIP?.() ?? undefined,
        startTime: additionalData?.startTime || 0
      })
      return { stream, type }
    } else {
      const stream = new PassThrough()
      stream.destroy(new Error(`Unsupported protocol: ${protocol}`))
      return { stream }
    }
  }

  async _handleProgressive(url: string, stream: PassThrough): Promise<void> {
    try {
      const res = await http1makeRequest(url, {
        method: 'GET',
        streamOnly: true
      })

      if (res.error) {
        const errorMsg =
          typeof res.error === 'string' ? res.error : 'Unknown error'
        stream.destroy(new Error(`Stream load failed: ${errorMsg}`))
        return
      }

      const responseStream = res.stream
      if (!responseStream) {
        stream.destroy(new Error('No stream in response'))
        return
      }

      responseStream.on('data', (chunk: Buffer) => {
        if (!stream.write(chunk)) responseStream.pause()
      })

      stream.on('drain', () => {
        if (!('destroyed' in responseStream && responseStream.destroyed))
          responseStream.resume()
      })

      responseStream.on('end', () => {
        if (!stream.writableEnded) {
          stream.emit('finishBuffering')
          stream.end()
        }
      })

      responseStream.on('error', (err: Error) => {
        if (err.message === 'aborted') {
          logger(
            'debug',
            'Sources',
            'SoundCloud progressive stream aborted (most of the time this is harmless)'
          )

          if (!stream.writableEnded) {
            stream.emit('finishBuffering')
            stream.end()
          }

          return
        }

        logger('error', 'Sources', `Progressive stream error: ${err.message}`)
        if (!stream.destroyed) stream.destroy(err)
      })
    } catch (err: unknown) {
      this._logError('Progressive stream failed', err)
      stream.destroy(err instanceof Error ? err : new Error('Unknown error'))
    }
  }

  _isValidString(val: unknown): val is string {
    return typeof val === 'string' && val.length > 0
  }

  _logError(msg: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    logger('error', 'Sources', `${msg}: ${message}`)
  }

  _buildError(message: string): SourceResult {
    return {
      loadType: 'error',
      exception: {
        message,
        severity: 'fault',
        cause: 'Unknown'
      }
    }
  }

  _buildException(message: string): TrackUrlResult {
    return {
      exception: {
        message,
        severity: 'fault',
        cause: 'Unknown'
      }
    }
  }
}
