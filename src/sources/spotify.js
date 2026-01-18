import {
  encodeTrack,
  getBestMatch,
  http1makeRequest,
  logger
} from '../utils.js'

const SPOTIFY_API_BASE_URL = 'https://api.spotify.com/v1'
const SPOTIFY_CLIENT_API_URL = 'https://spclient.wg.spotify.com'
const SPOTIFY_INTERNAL_API_URL =
  'https://api-partner.spotify.com/pathfinder/v2/query'
const TOKEN_REFRESH_MARGIN = 300000
const BATCH_SIZE_DEFAULT = 5

const QUERIES = {
  getTrack: {
    name: 'getTrack',
    hash: '612585ae06ba435ad26369870deaae23b5c8800a256cd8a57e08eddc25a37294'
  },
  getAlbum: {
    name: 'getAlbum',
    hash: 'b9bfabef66ed756e5e13f68a942deb60bd4125ec1f1be8cc42769dc0259b4b10'
  },
  getPlaylist: {
    name: 'fetchPlaylist',
    hash: 'bb67e0af06e8d6f52b531f97468ee4acd44cd0f82b988e15c2ea47b1148efc77'
  },
  getArtist: {
    name: 'queryArtistOverview',
    hash: '35648a112beb1794e39ab931365f6ae4a8d45e65396d641eeda94e4003d41497'
  },
  searchDesktop: {
    name: 'searchDesktop',
    hash: 'fcad5a3e0d5af727fb76966f06971c19cfa2275e6ff7671196753e008611873c'
  }
}

export default class SpotifySource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options
    this.searchTerms = ['spsearch']
    this.recommendationTerm = ['sprec']
    this.patterns = [
      /https?:\/\/(?:open\.)?spotify\.com\/(?:intl-[a-zA-Z]{2}\/)?(track|album|playlist|artist|episode|show)\/([a-zA-Z0-9]+)/
    ]
    this.priority = 95
    this.accessToken = null
    this.tokenExpiry = null
    this.clientId = null
    this.clientSecret = null
    this.resolveEndpoint = null
    this.playlistLoadLimit = 0
    this.playlistPageLoadConcurrency = BATCH_SIZE_DEFAULT
    this.albumLoadLimit = 0
    this.albumPageLoadConcurrency = BATCH_SIZE_DEFAULT
    this.market = 'US'
    this.tokenInitialized = false
    this.allowExplicit = true
  }

  async setup() {
    this.accessToken = this.nodelink.credentialManager.get(
      'spotify_access_token'
    )

    this.clientId = this.config.sources.spotify?.clientId
    this.clientSecret = this.config.sources.spotify?.clientSecret
    this.resolveEndpoint =
      this.config.sources.spotify?.resolveEndpoint || null
    this.playlistLoadLimit = this.config.sources.spotify?.playlistLoadLimit ?? 0
    this.playlistPageLoadConcurrency =
      this.config.sources.spotify?.playlistPageLoadConcurrency ??
      BATCH_SIZE_DEFAULT
    this.albumLoadLimit = this.config.sources.spotify?.albumLoadLimit ?? 0
    this.albumPageLoadConcurrency =
      this.config.sources.spotify?.albumPageLoadConcurrency ??
      BATCH_SIZE_DEFAULT
    this.market = this.config.sources.spotify?.market || 'US'
    this.allowExplicit = this.config.sources.spotify?.allowExplicit ?? true

    logger(
      'info',
      'Spotify',
      `Resolve endpoint configured: ${this.resolveEndpoint}`
    )

    const hasOfficialConfig =
      this.config.sources.spotify?.clientId &&
      this.config.sources.spotify?.clientSecret

    if (this.accessToken && hasOfficialConfig) {
      this.tokenInitialized = true
      return true
    }

    try {
      if (!this.clientId || !this.clientSecret) {
        logger(
          'warn',
          'Spotify',
          'Client ID/Secret not provided. Disabling source.'
        )
        return false
      }

      const success = await this._refreshToken()
      if (success) {
        logger('info', 'Spotify', 'Token initialized successfully.')
      }
      return success
    } catch (e) {
      logger(
        'error',
        'Spotify',
        `Error initializing Spotify token: ${e.message}`
      )
      return false
    }
  }

  _formatLimit(limit, multiplier) {
    return limit === 0 ? 'unlimited' : `${limit * multiplier} tracks max`
  }

  _isTokenValid() {
    return (
      this.tokenExpiry && Date.now() < this.tokenExpiry - TOKEN_REFRESH_MARGIN
    )
  }

  async _refreshToken() {
    if (!this.clientId || !this.clientSecret) {
      return false
    }

    try {
      const auth = Buffer.from(
        `${this.clientId}:${this.clientSecret}`
      ).toString('base64')

      const {
        body: tokenData,
        error,
        statusCode
      } = await http1makeRequest('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials',
        disableBodyCompression: true
      })

      if (!error && statusCode === 200) {
        this.accessToken = tokenData.access_token
        this.tokenExpiry = Date.now() + tokenData.expires_in * 1000
        this.nodelink.credentialManager.set(
          'spotify_access_token',
          this.accessToken,
          tokenData.expires_in * 1000
        )
        this.tokenInitialized = true
        return true
      } else {
        logger('error', 'Spotify', `Failed to refresh token: ${statusCode}`)
        return false
      }
    } catch (e) {
      logger('error', 'Spotify', `Token refresh failed: ${e.message}`)
      return false
    }
  }

  async _apiRequest(path, useAnonymousToken = false) {
    if (!this.tokenInitialized || !this._isTokenValid()) {
      await this.setup()
    }

    try {
      const url = path.startsWith('http')
        ? path
        : `${SPOTIFY_API_BASE_URL}${path}`

      // For autogenerated playlists it needs to use an anonymous token.
      const token = this.accessToken

      const { body, statusCode, headers } = await http1makeRequest(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        }
      })

      if (statusCode === 429) {
        const retryAfter = headers['retry-after']
          ? parseInt(headers['retry-after'], 10)
          : 5
        logger(
          'warn',
          'Spotify',
          `Rate limited. Retrying after ${retryAfter} seconds.`
        )
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000))
        return this._apiRequest(path)
      }

      if (statusCode === 401) {
        this.tokenInitialized = false
        return this._apiRequest(path)
      }

      if (statusCode !== 200) {
        logger('error', 'Spotify', `API error: ${statusCode}`)
        return null
      }

      return body
    } catch (e) {
      logger('error', 'Spotify', `Error in Spotify apiRequest: ${e.message}`)
      return null
    }
  }

  async _resolvePlaylistViaEndpoint(playlistUrl) {
    try {
      const encodedUrl = encodeURIComponent(playlistUrl)

      // Use /playlist/full endpoint which returns all tracks with pagination handled server-side
      const url = `${this.resolveEndpoint}/playlist/full?url=${encodedUrl}`

      const { body, statusCode, error } = await http1makeRequest(url, {
        headers: { Accept: 'application/json' },
        disableBodyCompression: true
      })

      if (error) {
        logger('error', 'Spotify', `Error from endpoint: ${error}`)
        return null
      }

      if (statusCode === 400) {
        logger(
          'warn',
          'Spotify',
          `Bad request (400) from endpoint - playlist may not be accessible`
        )
        return null
      }

      if (statusCode !== 200) {
        logger(
          'warn',
          'Spotify',
          `Failed to resolve playlist via endpoint: ${statusCode}`
        )
        if (body) {
          // We just ignore the body for 400 errors as they are expected for private playlists.
        }
        return null
      }

      if (!body) {
        logger('warn', 'Spotify', 'Empty response body from endpoint')
        return null
      }

      // We check if the track list exists in the response.
      if (!body.tracks || !body.tracks.items) {
        logger('warn', 'Spotify', `Invalid response structure from endpoint`)
        return null
      }

      const tracks = []
      const totalItems = body.tracks.items.length

      for (const item of body.tracks.items) {
        const trackData = item.track
        if (!trackData || !trackData.id) {
          continue
        }

        const isExplicit = trackData.explicit || false
        let trackUri = trackData.external_urls?.spotify || ''
        if (trackUri) {
          trackUri += `${trackUri.includes('?') ? '&' : '?'}explicit=${isExplicit}`
        }

        const trackInfo = {
          identifier: trackData.id,
          isSeekable: true,
          author: trackData.artists?.map((a) => a.name).join(', ') || 'Unknown',
          length: trackData.duration_ms || 0,
          isStream: false,
          position: 0,
          title: trackData.name || 'Unknown Track',
          uri: trackUri,
          artworkUrl: trackData.album?.images?.[0]?.url || null,
          isrc: trackData.external_ids?.isrc || null,
          sourceName: 'spotify'
        }

        tracks.push({
          encoded: encodeTrack(trackInfo),
          info: trackInfo,
          pluginInfo: {}
        })
      }

      logger(
        'info',
        'Spotify',
        `Successfully processed ${tracks.length} tracks from endpoint`
      )

      return {
        loadType: 'playlist',
        data: {
          info: {
            name: body.name || 'Spotify Playlist',
            selectedTrack: 0
          },
          tracks
        }
      }
    } catch (e) {
      logger(
        'error',
        'Spotify',
        `Error resolving playlist via endpoint: ${e.message}`
      )
      logger('error', 'Spotify', `Stack trace: ${e.stack}`)
      return null
    }
  }

  async _resolveAutogeneratedPlaylist(playlistUrl) {
    try {
      const encodedUrl = encodeURIComponent(playlistUrl)

      // Use regular /playlist endpoint for autogenerated playlists
      const url = `${this.resolveEndpoint}/playlist?url=${encodedUrl}`

      const { body, statusCode, error } = await http1makeRequest(url, {
        headers: { Accept: 'application/json' },
        disableBodyCompression: true
      })

      if (error) {
        logger('error', 'Spotify', `Error from endpoint: ${error}`)
        return null
      }

      if (statusCode !== 200) {
        logger(
          'warn',
          'Spotify',
          `Failed to resolve autogenerated playlist via endpoint: ${statusCode}`
        )
        if (body) {
          logger('warn', 'Spotify', `Response body: ${JSON.stringify(body)}`)
        }
        return null
      }

      if (!body) {
        logger('warn', 'Spotify', 'Empty response body from endpoint')
        return null
      }

      // We expect tracks to exist in the response.
      if (!body.tracks || !body.tracks.items) {
        logger('warn', 'Spotify', `Invalid response structure from endpoint`)
        return null
      }

      const tracks = []
      const totalItems = body.tracks.items.length

      for (const item of body.tracks.items) {
        const trackData = item.track
        if (!trackData || !trackData.id) {
          continue
        }

        const isExplicit = trackData.explicit || false
        let trackUri = trackData.external_urls?.spotify || ''
        if (trackUri) {
          trackUri += `${trackUri.includes('?') ? '&' : '?'}explicit=${isExplicit}`
        }

        const trackInfo = {
          identifier: trackData.id,
          isSeekable: true,
          author: trackData.artists?.map((a) => a.name).join(', ') || 'Unknown',
          length: trackData.duration_ms || 0,
          isStream: false,
          position: 0,
          title: trackData.name || 'Unknown Track',
          uri: trackUri,
          artworkUrl: trackData.album?.images?.[0]?.url || null,
          isrc: trackData.external_ids?.isrc || null,
          sourceName: 'spotify'
        }

        tracks.push({
          encoded: encodeTrack(trackInfo),
          info: trackInfo,
          pluginInfo: {}
        })
      }

      logger(
        'info',
        'Spotify',
        `Successfully processed ${tracks.length} tracks from autogenerated playlist`
      )

      return {
        loadType: 'playlist',
        data: {
          info: {
            name: body.name || 'Spotify Playlist',
            selectedTrack: 0
          },
          tracks
        }
      }
    } catch (e) {
      logger(
        'error',
        'Spotify',
        `Error resolving autogenerated playlist: ${e.message}`
      )
      return null
    }
  }

  _buildTrack(item, artworkUrl = null) {
    if (!item?.id) return null

    const isExplicit = item.explicit || false
    let trackUri = item.external_urls?.spotify || ''
    if (trackUri) {
      trackUri += `${trackUri.includes('?') ? '&' : '?'}explicit=${isExplicit}`
    }

    const trackInfo = {
      identifier: item.id,
      isSeekable: true,
      author: item.artists?.map((a) => a.name).join(', ') || 'Unknown',
      length: item.duration_ms,
      isStream: false,
      position: 0,
      title: item.name,
      uri: trackUri,
      artworkUrl: artworkUrl || item.album?.images?.[0]?.url || null,
      isrc: item.external_ids?.isrc || null,
      sourceName: 'spotify'
    }

    return {
      encoded: encodeTrack(trackInfo),
      info: trackInfo,
      pluginInfo: {}
    }
  }

  async _fetchPaginatedData(baseUrl, totalItems, limit, maxPages, concurrency) {
    const allItems = []
    let pagesToFetch = Math.ceil(totalItems / limit)

    if (maxPages > 0) {
      pagesToFetch = Math.min(pagesToFetch, maxPages)
    }

    const promises = []
    for (let i = 1; i < pagesToFetch; i++) {
      const offset = i * limit
      promises.push(
        this._apiRequest(`${baseUrl}&offset=${offset}&limit=${limit}`)
      )
    }

    if (promises.length === 0) return allItems

    const batchSize = concurrency
    for (let i = 0; i < promises.length; i += batchSize) {
      const batch = promises.slice(i, i + batchSize)
      let attempts = 0
      while (attempts < 3) {
        try {
          const results = await Promise.all(batch)
          for (const page of results) {
            if (page?.items) {
              allItems.push(...page.items)
            }
          }
          break
        } catch (e) {
          attempts++
          if (attempts >= 3) {
            logger(
              'warn',
              'Spotify',
              `Failed to fetch a batch of pages after 3 attempts: ${e.message}`
            )
          } else {
            await new Promise((r) => setTimeout(r, 1500))
          }
        }
      }
    }

    return allItems
  }

  async search(query, sourceTerm, searchType = 'track') {
    if (this.recommendationTerm.includes(sourceTerm)) {
      return this.getRecommendations(query)
    }

    try {
      const limit = this.config.maxSearchResults || 10

      const typeMap = {
        track: 'track',
        album: 'album',
        playlist: 'playlist',
        artist: 'artist'
      }
      const spotifyType = typeMap[searchType] || 'track'

      const data = await this._apiRequest(
        `/search?q=${encodeURIComponent(query)}&type=${spotifyType}&limit=${limit}&market=${this.market}`
      )

      if (!data || data.error) {
        return {
          exception: {
            message: data?.error?.message || 'Search failed on Spotify.',
            severity: 'common'
          }
        }
      }

      const results = this._processOfficialSearchResults(data, spotifyType)
      return results.length === 0
        ? { loadType: 'empty', data: {} }
        : { loadType: 'search', data: results }
    } catch (e) {
      return {
        exception: { message: e.message, severity: 'fault' }
      }
    }
  }

  async getRecommendations(query) {
    try {
      if (query.startsWith('mix:') || !query.includes('=')) {
        let seedType = 'track'
        let seed = query

        if (query.startsWith('mix:')) {
          const mixMatch = query.match(
            /^mix:(track|artist|album|isrc):([^:]+)$/
          )
          if (mixMatch) {
            seedType = mixMatch[1]
            seed = mixMatch[2]
          }
        }

        if (
          seedType === 'isrc' ||
          (seedType === 'track' &&
            (seed.includes(' ') || !/^[a-zA-Z0-9]{22}$/.test(seed)))
        ) {
          const searchResult = await this.search(
            seedType === 'isrc' ? `isrc:${seed}` : seed,
            'spsearch',
            'track'
          )
          if (
            searchResult.loadType === 'search' &&
            searchResult.data.length > 0
          ) {
            seed = searchResult.data[0].info.identifier
            seedType = 'track'
          } else {
            return { loadType: 'empty', data: {} }
          }
        }

        const { body: rjson, statusCode } = await http1makeRequest(
          `${SPOTIFY_CLIENT_API_URL}/inspiredby-mix/v2/seed_to_playlist/spotify:${seedType}:${seed}?response-format=json`,
          {
            headers: { Authorization: `Bearer ${this.accessToken}` },
            disableBodyCompression: true
          }
        )

        if (statusCode === 200 && rjson?.mediaItems?.length > 0) {
          const playlistId = rjson.mediaItems[0].uri.split(':')[2]
          return this._resolvePlaylist(playlistId)
        }

        if (query.startsWith('mix:')) return { loadType: 'empty', data: {} }
      }

      const data = await this._apiRequest(
        `/recommendations?${query.includes('=') ? query : `seed_tracks=${query}`}`
      )
      if (!data || !data.tracks || data.tracks.length === 0) {
        return { loadType: 'empty', data: {} }
      }

      const tracks = data.tracks
        .map((item) => this._buildTrack(item))
        .filter(Boolean)
      return {
        loadType: 'playlist',
        data: {
          info: { name: 'Spotify Recommendations', selectedTrack: 0 },
          pluginInfo: { type: 'recommendations' },
          tracks
        }
      }
    } catch (e) {
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  _processOfficialSearchResults(data, spotifyType) {
    const results = []

    if (spotifyType === 'track' && data.tracks?.items) {
      for (const item of data.tracks.items) {
        const track = this._buildTrack(item)
        if (track) results.push(track)
      }
    } else if (spotifyType === 'album' && data.albums?.items) {
      for (const item of data.albums.items) {
        if (!item) continue
        const info = {
          title: item.name,
          author: item.artists.map((a) => a.name).join(', '),
          length: 0,
          identifier: item.id,
          isSeekable: true,
          isStream: false,
          uri:
            item.external_urls?.spotify ||
            `https://open.spotify.com/album/${item.id}`,
          artworkUrl: item.images?.[0]?.url || null,
          isrc: null,
          sourceName: 'spotify',
          position: 0
        }
        results.push({
          encoded: encodeTrack(info),
          info,
          pluginInfo: { type: 'album' }
        })
      }
    } else if (spotifyType === 'playlist' && data.playlists?.items) {
      for (const item of data.playlists.items) {
        if (!item) continue
        const info = {
          title: item.name,
          author: item.owner?.display_name || 'Unknown',
          length: 0,
          identifier: item.id,
          isSeekable: true,
          isStream: false,
          uri:
            item.external_urls?.spotify ||
            `https://open.spotify.com/playlist/${item.id}`,
          artworkUrl: item.images?.[0]?.url || null,
          isrc: null,
          sourceName: 'spotify',
          position: 0
        }
        results.push({
          encoded: encodeTrack(info),
          info,
          pluginInfo: { type: 'playlist' }
        })
      }
    } else if (spotifyType === 'artist' && data.artists?.items) {
      for (const item of data.artists.items) {
        if (!item) continue
        const info = {
          title: item.name,
          author: 'Spotify',
          length: 0,
          identifier: item.id,
          isSeekable: false,
          isStream: false,
          uri:
            item.external_urls?.spotify ||
            `https://open.spotify.com/artist/${item.id}`,
          artworkUrl: item.images?.[0]?.url || null,
          isrc: null,
          sourceName: 'spotify',
          position: 0
        }
        results.push({
          encoded: encodeTrack(info),
          info,
          pluginInfo: { type: 'artist' }
        })
      }
    }

    return results
  }

  async resolve(url) {
    try {
      const match = url.match(this.patterns[0])
      if (!match) return { loadType: 'empty', data: {} }

      const [, type, id] = match

      switch (type) {
        case 'track':
          return await this._resolveTrack(id)
        case 'album':
          return await this._resolveAlbum(id)
        case 'playlist':
          return await this._resolvePlaylist(id)
        case 'artist':
          return await this._resolveArtist(id)
        case 'episode':
        case 'show':
          return {
            exception: {
              message: 'This source does not support episodes or shows.',
              severity: 'common'
            }
          }
        default:
          return { loadType: 'empty', data: {} }
      }
    } catch (e) {
      return {
        exception: { message: e.message, severity: 'fault' }
      }
    }
  }

  async _resolveTrack(id) {
    const data = await this._apiRequest(`/tracks/${id}?market=${this.market}`)
    if (!data) {
      return {
        exception: { message: 'Track not found.', severity: 'common' }
      }
    }
    return { loadType: 'track', data: this._buildTrack(data) }
  }

  async _resolveAlbum(id) {
    const albumData = await this._apiRequest(
      `/albums/${id}?market=${this.market}`
    )
    if (!albumData) {
      return {
        exception: { message: 'Album not found.', severity: 'common' }
      }
    }

    const allItems = []
    if (albumData.tracks?.items) {
      allItems.push(...albumData.tracks.items)
    }

    const totalTracks = albumData.tracks.total
    const additionalItems = await this._fetchPaginatedData(
      `/albums/${id}/tracks?market=${this.market}`,
      totalTracks,
      50,
      this.albumLoadLimit,
      this.albumPageLoadConcurrency
    )

    allItems.push(...additionalItems)

    const tracks = allItems
      .map((item) => {
        if (!item?.id) return null
        return this._buildTrack(
          { ...item, album: { images: albumData.images } },
          albumData.images?.[0]?.url
        )
      })
      .filter(Boolean)

    logger(
      'info',
      'Spotify',
      `Loaded ${tracks.length} of ${totalTracks} tracks from album "${albumData.name}".`
    )

    return {
      loadType: 'playlist',
      data: {
        info: { name: albumData.name, selectedTrack: 0 },
        tracks
      }
    }
  }

  async _resolvePlaylist(id) {
    // Autogenerated playlists on Spotify have IDs that start with '37i9dQZ'
    const isAutogenerated = id.startsWith('37i9dQZ')

    // For the autogenerated playlists we use the /playlist endpoint
    if (this.resolveEndpoint && isAutogenerated) {
      logger(
        'info',
        'Spotify',
        `Attempting to use resolveEndpoint for autogenerated playlist ${id}`
      )
      const playlistUrl = `https://open.spotify.com/playlist/${id}`
      const result = await this._resolveAutogeneratedPlaylist(playlistUrl)
      if (result) {
        logger(
          'info',
          'Spotify',
          `Loaded ${result.data.tracks.length} tracks from autogenerated playlist via resolveEndpoint.`
        )
        return result
      }
      logger(
        'warn',
        'Spotify',
        `Failed to load autogenerated playlist via resolveEndpoint`
      )
      return {
        exception: {
          message: 'Autogenerated playlist not accessible.',
          severity: 'common'
        }
      }
    }

    // For regular playlists we use the /playlist/full endpoint.
    if (this.resolveEndpoint && !isAutogenerated) {
      logger(
        'info',
        'Spotify',
        `Attempting to use resolveEndpoint for playlist ${id}`
      )
      const playlistUrl = `https://open.spotify.com/playlist/${id}`
      const result = await this._resolvePlaylistViaEndpoint(playlistUrl)
      if (result) {
        logger(
          'info',
          'Spotify',
          `Loaded ${result.data.tracks.length} tracks from playlist "${result.data.info.name}" via resolveEndpoint.`
        )
        return result
      }
      logger(
        'warn',
        'Spotify',
        `Failed to load playlist via resolveEndpoint, falling back to API`
      )
    } else if (!isAutogenerated) {
      logger(
        'warn',
        'Spotify',
        `resolveEndpoint is not configured, using regular API`
      )
    }

    // We will fallback to this if the resolveEndpoint is not configured or fails.
    const fields =
      'name,tracks(items(track(id,name,artists,duration_ms,external_urls,external_ids,explicit,album(images))),total)'
    const playlistData = await this._apiRequest(
      `/playlists/${id}?fields=${fields}&market=${this.market}`,
      isAutogenerated
    )
    if (!playlistData) {
      return {
        exception: { message: 'Playlist not found.', severity: 'common' }
      }
    }

    const allItems = []
    if (playlistData.tracks?.items) {
      allItems.push(...playlistData.tracks.items)
    }

    const totalTracks = playlistData.tracks.total
    const additionalFields =
      'items(track(id,name,artists,duration_ms,external_urls,external_ids,explicit,album(images)))'
    const additionalItems = await this._fetchPaginatedData(
      `/playlists/${id}/tracks?fields=${additionalFields}&market=${this.market}`,
      totalTracks,
      100,
      this.playlistLoadLimit,
      this.playlistPageLoadConcurrency
    )

    allItems.push(...additionalItems)

    const tracks = allItems
      .map((item) => {
        const track = item.track || item
        return this._buildTrack(track)
      })
      .filter(Boolean)

    logger(
      'info',
      'Spotify',
      `Loaded ${tracks.length} of ${totalTracks} tracks from playlist "${playlistData.name}" via API.`
    )

    return {
      loadType: 'playlist',
      data: {
        info: { name: playlistData.name, selectedTrack: 0 },
        tracks
      }
    }
  }

  async _resolveArtist(id) {
    const artist = await this._apiRequest(`/artists/${id}`)
    if (!artist) {
      return {
        exception: { message: 'Artist not found.', severity: 'common' }
      }
    }

    const topTracks = await this._apiRequest(
      `/artists/${id}/top-tracks?market=${this.market}`
    )
    if (!topTracks?.tracks) {
      return {
        exception: {
          message: 'Failed to get artist top tracks.',
          severity: 'common'
        }
      }
    }

    const tracks = topTracks.tracks
      .map((item) => this._buildTrack(item, artist.images?.[0]?.url))
      .filter(Boolean)

    return {
      loadType: 'playlist',
      data: {
        info: { name: `${artist.name}'s Top Tracks`, selectedTrack: 0 },
        tracks
      }
    }
  }

  async getTrackUrl(decodedTrack) {
    if (!decodedTrack.isrc && this.accessToken) {
      try {
        const trackData = await this._apiRequest(
          `/tracks/${decodedTrack.identifier}?market=${this.market}`
        )
        if (trackData?.external_ids?.isrc) {
          decodedTrack.isrc = trackData.external_ids.isrc
        }
      } catch (e) {
        // Ignore errors fetching ISRC
      }
    }

    let isExplicit = false
    if (decodedTrack.uri) {
      try {
        const url = new URL(decodedTrack.uri)
        isExplicit = url.searchParams.get('explicit') === 'true'
      } catch (_e) {
        // Ignore malformed URI
      }
    }

    const searchQuery = this._buildSearchQuery(decodedTrack, isExplicit)

    try {
      let searchResult
      if (decodedTrack.isrc) {
        searchResult = await this.nodelink.sources.search(
          'youtube',
          `"${decodedTrack.isrc}"`,
          'ytmsearch'
        )
        if (
          searchResult.loadType !== 'search' ||
          searchResult.data.length === 0
        ) {
          searchResult = await this.nodelink.sources.search(
            'youtube',
            searchQuery,
            'ytmsearch'
          )
        }
      } else {
        searchResult = await this.nodelink.sources.search(
          'youtube',
          searchQuery,
          'ytmsearch'
        )
      }

      if (
        searchResult.loadType !== 'search' ||
        searchResult.data.length === 0
      ) {
        searchResult =
          await this.nodelink.sources.searchWithDefault(searchQuery)
      }

      if (
        searchResult.loadType !== 'search' ||
        searchResult.data.length === 0
      ) {
        return {
          exception: {
            message: 'No alternative stream found via default search.',
            severity: 'fault'
          }
        }
      }

      const bestMatch = getBestMatch(searchResult.data, decodedTrack, {
        allowExplicit: this.allowExplicit
      })

      if (!bestMatch) {
        return {
          exception: {
            message: 'No suitable alternative stream found after filtering.',
            severity: 'fault'
          }
        }
      }

      const streamInfo = await this.nodelink.sources.getTrackUrl(bestMatch.info)
      return { newTrack: bestMatch, ...streamInfo }
    } catch (e) {
      logger(
        'warn',
        'Spotify',
        `Search for "${searchQuery}" failed: ${e.message}`
      )
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  _buildSearchQuery(track, isExplicit) {
    let searchQuery = `${track.title} ${track.author}`
    if (isExplicit) {
      searchQuery += this.allowExplicit ? ' lyrical video' : ' clean version'
    }
    return searchQuery
  }
}
