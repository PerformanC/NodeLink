import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import { PassThrough } from 'node:stream'
import BlowfishCBC from '../decrypters/blowfish-cbc.ts'
import {
  encodeTrack,
  http1makeRequest,
  logger,
  getBestMatch,
  makeRequest
} from '../utils.ts'

const IV = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7])
const ISRC_REGEX = /^(?:isrc:)?([A-Z]{2}-?[A-Z0-9]{3}-?\d{2}-?\d{5})$/i

export default class DeezerSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options
    this.searchTerms = ['dzsearch']
    this.recommendationTerm = ['dzrec']
    this.patterns = [
      /^https?:\/\/(?:www\.)?deezer\.com\/(?:[a-z]+(?:-[a-z]+)?\/)?(track|album|playlist|artist)\/(\d+)(?:\?.*)?$/,
      /^https?:\/\/link\.deezer\.com\/s\/([a-zA-Z0-9]+)/
    ]
    this.priority = 80

    this.cookie = null
    this.csrfToken = null
    this.licenseToken = null
  }

  async setup() {
    logger('info', 'Sources', 'Initializing Deezer source...')

    const cachedCsrf = this.nodelink.credentialManager.get('deezer_csrf_token')
    const cachedLicense = this.nodelink.credentialManager.get(
      'deezer_license_token'
    )
    const cachedCookie = this.nodelink.credentialManager.get('deezer_cookie')

    if (cachedCsrf && cachedLicense && cachedCookie) {
      this.csrfToken = cachedCsrf
      this.licenseToken = cachedLicense
      this.cookie = cachedCookie
      logger(
        'info',
        'Sources',
        'Loaded Deezer credentials from CredentialManager.'
      )
      return true
    }

    try {
      let initialCookie = ''
      const arl = this.config.sources?.deezer?.arl

      if (typeof arl === 'string' && arl.length > 0) {
        initialCookie = `arl=${arl}`
      }

      const userDataRes = await makeRequest(
        'https://www.deezer.com/ajax/gw-light.php?method=deezer.getUserData&input=3&api_version=1.0&api_token=',
        {
          method: 'GET',
          getCookies: true,
          headers: {
            Cookie: initialCookie
          }
        }
      )

      if (userDataRes.error || !userDataRes.body?.results) {
        throw new Error(
          `Failed to fetch user data: ${userDataRes.error?.message || 'Invalid response.'}`
        )
      }

      const responseCookies =
        userDataRes.headers['set-cookie']?.join('; ') || ''
      this.cookie = initialCookie
        ? `${initialCookie}; ${responseCookies}`
        : responseCookies

      this.csrfToken = userDataRes.body.results.checkForm
      this.licenseToken = userDataRes.body.results.USER.OPTIONS.license_token

      this.nodelink.credentialManager.set(
        'deezer_csrf_token',
        this.csrfToken,
        24 * 60 * 60 * 1000
      )
      this.nodelink.credentialManager.set(
        'deezer_license_token',
        this.licenseToken,
        24 * 60 * 60 * 1000
      )
      this.nodelink.credentialManager.set(
        'deezer_cookie',
        this.cookie,
        24 * 60 * 60 * 1000
      )

      if (!this.csrfToken || !this.licenseToken) {
        throw new Error('CSRF Token or License Token not found in response.')
      }

      logger('info', 'Sources', 'Deezer source setup successfully.')
      return true
    } catch (e) {
      logger('error', 'Sources', `Failed to setup Deezer source: ${e.message}`)
      return false
    }
  }

  async search(query, sourceTerm, searchType = 'track') {
    if (this.recommendationTerm.includes(sourceTerm)) {
      return this.getRecommendations(query)
    }

    const isrc = this._extractIsrc(query)
    if (isrc) {
      logger('debug', 'Sources', `Deezer ISRC search: ${isrc}`)

      const track = await this._fetchTrackByIsrc(isrc).catch((e) => {
        return { __error: e }
      })

      if (!track || track.__error) {
        return { loadType: 'empty', data: {} }
      }

      return { loadType: 'search', data: [this.buildTrack(track)] }
    }

    logger('debug', 'Sources', `Searching Deezer for: "${query}" (type: ${searchType})`)

    const typeMap = {
      track: 'track',
      album: 'album',
      playlist: 'playlist',
      artist: 'artist'
    }

    const apiType = typeMap[searchType] || 'track'
    const { body, error } = await makeRequest(
      `https://api.deezer.com/2.0/search/${apiType}?q=${encodeURIComponent(query)}`,
      { method: 'GET' }
    )

    if (error || body.error) {
      return {
        exception: {
          message: error?.message || body.error.message,
          severity: 'common'
        }
      }
    }

    if (body.total === 0) {
      return { loadType: 'empty', data: {} }
    }

    const results = []
    const items = body.data.slice(0, this.config.maxSearchResults || 10)

    if (searchType === 'track') {
      for (const item of items) {
        if (item.type === 'track' && item.readable !== false) {
          results.push(this.buildTrack(item))
        }
      }
    } 
    else if (searchType === 'album') {
      for (const album of items) {
        if (!album?.id) continue

        const info = {
          title: album.title || 'Unknown Album',
          author: album.artist?.name || 'Unknown Artist',
          length: 0,
          identifier: album.id.toString(),
          isSeekable: true,
          isStream: false,
          uri: album.link || `https://www.deezer.com/album/${album.id}`,
          artworkUrl: album.cover_xl || album.cover_big || album.cover_medium || null,
          isrc: null,
          sourceName: 'deezer',
          position: 0
        }
        results.push({
          encoded: encodeTrack(info),
          info,
          pluginInfo: {
            type: 'album',
            trackCount: album.nb_tracks || null
          }
        })
      }
    } 
    else if (searchType === 'playlist') {
      for (const playlist of items) {
        if (!playlist?.id) continue

        const info = {
          title: playlist.title || 'Unknown Playlist',
          author: playlist.user?.name || playlist.creator?.name || 'Deezer',
          length: 0,
          identifier: playlist.id.toString(),
          isSeekable: true,
          isStream: false,
          uri: playlist.link || `https://www.deezer.com/playlist/${playlist.id}`,
          artworkUrl: playlist.picture_xl || playlist.picture_big || playlist.picture_medium || null,
          isrc: null,
          sourceName: 'deezer',
          position: 0
        }
        results.push({
          encoded: encodeTrack(info),
          info,
          pluginInfo: {
            type: 'playlist',
            trackCount: playlist.nb_tracks || null
          }
        })
      }
    } 
    else if (searchType === 'artist') {
      for (const artist of items) {
        if (!artist?.id) continue

        const info = {
          title: artist.name || 'Unknown Artist',
          author: 'Deezer',
          length: 0,
          identifier: artist.id.toString(),
          isSeekable: false,
          isStream: false,
          uri: artist.link || `https://www.deezer.com/artist/${artist.id}`,
          artworkUrl: artist.picture_xl || artist.picture_big || artist.picture_medium || null,
          isrc: null,
          sourceName: 'deezer',
          position: 0
        }
        results.push({
          encoded: encodeTrack(info),
          info,
          pluginInfo: { type: 'artist' }
        })
      }
    }

    return { loadType: 'search', data: results }
  }

  async getRecommendations(query) {
    try {
      let method = 'song.getSearchTrackMix'
      let payload = { sng_id: query, start_with_input_track: 'true' }

      if (query.startsWith('artist=')) {
        method = 'song.getSmartRadio'
        payload = { art_id: query.split('=')[1] }
      } else if (query.startsWith('track=')) {
        payload.sng_id = query.split('=')[1]
      } else if (!/^\d+$/.test(query)) {
        const searchRes = await this.search(query, 'dzsearch')
        if (searchRes.loadType === 'search' && searchRes.data.length > 0) {
          payload.sng_id = searchRes.data[0].info.identifier
        } else {
          return { loadType: 'empty', data: {} }
        }
      }

      const { body: result, error } = await makeRequest(
        `https://www.deezer.com/ajax/gw-light.php?method=${method}&input=3&api_version=1.0&api_token=${this.csrfToken}`,
        {
          method: 'POST',
          headers: { Cookie: this.cookie },
          body: payload,
          disableBodyCompression: true
        }
      )

      if (error || !result?.results?.data) {
        return { loadType: 'empty', data: {} }
      }

      const tracks = result.results.data.map((item) => {
        const trackInfo = {
          identifier: item.SNG_ID.toString(),
          isSeekable: true,
          author: item.ART_NAME,
          length: item.DURATION * 1000,
          isStream: false,
          position: 0,
          title: item.SNG_TITLE,
          uri: `https://www.deezer.com/track/${item.SNG_ID}`,
          artworkUrl: `https://e-cdns-images.dzcdn.net/images/cover/${item.ALB_PICTURE}/1000x1000-000000-80-0-0.jpg`,
          isrc: item.ISRC || null,
          sourceName: 'deezer'
        }
        return {
          encoded: encodeTrack(trackInfo),
          info: trackInfo,
          pluginInfo: {}
        }
      })

      return {
        loadType: 'playlist',
        data: {
          info: { name: 'Deezer Recommendations', selectedTrack: 0 },
          pluginInfo: { type: 'recommendations' },
          tracks
        }
      }
    } catch (e) {
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  async resolve(url) {
    if (url.includes('link.deezer.com')) {
      const res = await http1makeRequest(url, { method: 'GET' })
      const match = res.body.match(/\/(track|album|playlist|artist)\/(\d+)/)
      if (match) {
        const [, type, id] = match
        return await this.resolve(`https://www.deezer.com/${type}/${id}`)
      }
      return { loadType: 'empty', data: {} }
    }

    const pattern = this.patterns[0]
    const match = url.match(pattern)
    if (!match) return { loadType: 'empty', data: {} }

    const [, type, id] = match
    logger(
      'debug',
      'Sources',
      `Resolving Deezer URL of type '${type}' with ID '${id}'`
    )

    const { body, error } = await makeRequest(
      `https://api.deezer.com/2.0/${type}/${id}`,
      {
        method: 'GET'
      }
    )

    if (error || body.error) {
      if (body.error?.code === 800) return { loadType: 'empty', data: {} }
      return {
        exception: {
          message: error?.message || body.error.message,
          severity: 'fault'
        }
      }
    }

    switch (type) {
      case 'track': {
        const track = this.buildTrack(body)
        return { loadType: 'track', data: track }
      }
      // forced album to load as a playlist, because the code is not loading album types, but playlist loadType works.
      case 'album':
      case 'playlist': {
        const playlistData = body
        const tracklistUrl = `${playlistData.tracklist}?limit=${this.config.maxAlbumPlaylistLength || 1000}`
        const tracksRes = await makeRequest(tracklistUrl, { method: 'GET' })

        if (tracksRes.error || !tracksRes.body?.data) {
          return {
            exception: {
              message: 'Could not fetch playlist tracks.',
              severity: 'common'
            }
          }
        }

        const tracks = []
        for (const item of tracksRes.body.data) {
          tracks.push(
            this.buildTrack(
              item,
              playlistData.cover_xl || playlistData.picture_xl
            )
          )
        }

        return {
          loadType: 'playlist',
          data: {
            info: {
              name: playlistData.title,
              selectedTrack: 0
            },
            pluginInfo: {},
            tracks
          }
        }
      }
      case 'artist': {
        const artistData = body
        const topTracksRes = await makeRequest(
          `https://api.deezer.com/2.0/artist/${id}/top?limit=${this.config.maxAlbumPlaylistLength || 25}`
        )

        if (topTracksRes.error || topTracksRes.body.error) {
          return {
            exception: {
              message:
                topTracksRes.error?.message || topTracksRes.body.error.message,
              severity: 'common'
            }
          }
        }

        const tracks = topTracksRes.body.data.map((item) => {
          if (!item.album) item.album = {}
          item.album.cover_xl = artistData.picture_xl
          return this.buildTrack(item)
        })

        return {
          loadType: 'artist',
          data: {
            info: {
              name: `${artistData.name}'s Top Tracks`,
              selectedTrack: 0
            },
            pluginInfo: {},
            tracks
          }
        }
      }
      default:
        return { loadType: 'empty', data: {} }
    }
  }

  buildTrack(item, artworkUrl = null) {
    const albumName = item.album?.title || null
    const albumId = item.album?.id || null
    const artistId = item.artist?.id || null
    const albumUrl = albumId ? `https://www.deezer.com/album/${albumId}` : null
    const artistUrl = artistId ? `https://www.deezer.com/artist/${artistId}` : null
    const artistArtworkUrl = item.artist?.picture_xl || null
    const previewUrl = item.preview || null

    const trackInfo = {
      identifier: item.id.toString(),
      isSeekable: true,
      author: item.artist?.name || 'Unknown',
      length: item.duration * 1000,
      isStream: false,
      position: 0,
      title: item.title || 'Unknown',
      uri: item.link || `https://www.deezer.com/track/${item.id}`,
      artworkUrl: artworkUrl || item.album?.cover_xl || null,
      isrc: item.isrc || null,
      sourceName: 'deezer'
    }

    const pluginInfo = {}
    if (albumName) pluginInfo.albumName = albumName
    if (albumUrl) pluginInfo.albumUrl = albumUrl
    if (artistUrl) pluginInfo.artistUrl = artistUrl
    if (artistArtworkUrl) pluginInfo.artistArtworkUrl = artistArtworkUrl
    if (previewUrl) pluginInfo.previewUrl = previewUrl

    return {
      encoded: encodeTrack(trackInfo),
      info: trackInfo,
      pluginInfo
    }
  }

  _extractIsrc(input) {
    if (!input || typeof input !== 'string') return null
    const m = input.trim().match(ISRC_REGEX)
    return m ? m[1].replace(/-/g, '').toUpperCase() : null
  }

  async _fetchTrackByIsrc(isrc) {
    const { body, error } = await makeRequest(
      `https://api.deezer.com/2.0/track/isrc:${isrc}`,
      { method: 'GET' }
    )

    if (error || body?.error) {
      if (body?.error?.code === 800) return null
      throw new Error(
        error?.message ||
          body?.error?.message ||
          'Failed to fetch track by ISRC'
      )
    }
    return body
  }

  async getTrackUrl(decodedTrack, itag, forceRefresh = false) {
    if (!forceRefresh) {
      const cached = this.nodelink.trackCacheManager.get(
        'deezer',
        decodedTrack.identifier
      )
      if (cached) return cached
    }

    if (this.licenseToken) {
      try {
        const { body: trackData } = await makeRequest(
          `https://www.deezer.com/ajax/gw-light.php?method=song.getListData&input=3&api_version=1.0&api_token=${this.csrfToken}`,
          {
            method: 'POST',
            headers: { Cookie: this.cookie },
            body: { sng_ids: [decodedTrack.identifier] },
            disableBodyCompression: true
          }
        )
        if (trackData.error && trackData.error.length > 0) {
          throw new Error(Object.values(trackData.error).join('; '))
        }

        if (
          trackData.results &&
          trackData.results.data &&
          trackData.results.data.length > 0
        ) {
          const trackInfo = trackData.results.data[0]

          const { body: streamData } = await makeRequest(
            'https://media.deezer.com/v1/get_url',
            {
              method: 'POST',
              body: {
                license_token: this.licenseToken,
                media: [
                  {
                    type: 'FULL',
                    formats: [
                      { cipher: 'BF_CBC_STRIPE', format: 'FLAC' },
                      { cipher: 'BF_CBC_STRIPE', format: 'MP3_256' },
                      { cipher: 'BF_CBC_STRIPE', format: 'MP3_128' },
                      { cipher: 'BF_CBC_STRIPE', format: 'MP3_MISC' }
                    ]
                  }
                ],
                track_tokens: [trackInfo.TRACK_TOKEN]
              },
              disableBodyCompression: true
            }
          )

          if (
            streamData.data &&
            streamData.data[0] &&
            streamData.data[0].media &&
            streamData.data[0].media.length > 0 &&
            streamData.data[0].media[0].sources &&
            streamData.data[0].media[0].sources.length > 0
          ) {
            const streamInfo = streamData.data[0].media[0]
            const result = {
              url: streamInfo.sources[0].url,
              protocol: 'https',
              format: streamInfo.format.startsWith('MP3') ? 'mp3' : 'flac',
              additionalData: trackInfo
            }
            this.nodelink.trackCacheManager.set(
              'deezer',
              decodedTrack.identifier,
              result,
              1000 * 60 * 60 * 4
            )
            return result
          }
        }
      } catch (e) {
        logger(
          'warn',
          'Deezer',
          `Direct stream failed for ${decodedTrack.title}: ${e.message}. Falling back to YouTube.`
        )
      }
    }

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
          `${decodedTrack.title} ${decodedTrack.author}`,
          'ytmsearch'
        )
      }
    }

    if (
      !searchResult ||
      searchResult.loadType !== 'search' ||
      searchResult.data.length === 0
    ) {
      searchResult = await this.nodelink.sources.searchWithDefault(
        `${decodedTrack.title} ${decodedTrack.author}`
      )
    }

    const bestMatch = getBestMatch(searchResult.data, decodedTrack)
    if (!bestMatch)
      return {
        exception: {
          message: 'No suitable alternative found.',
          severity: 'fault'
        }
      }

    const streamInfo = await this.nodelink.sources.getTrackUrl(bestMatch.info)
    return { newTrack: bestMatch, ...streamInfo }
  }

  loadStream(decodedTrack, url, _format, additionalData) {
    return new Promise(async (resolve) => {
      try {
        const outputStream = new PassThrough()
        const trackKey = this._calculateKey(additionalData.SNG_ID)
        const bufferSize = 2048
        let buf = Buffer.alloc(0)

        let i = 0
        const headers = {}

        if (
          additionalData.startTime !== undefined &&
          additionalData.FILESIZE &&
          additionalData.DURATION
        ) {
          const durationMs = Number(additionalData.DURATION) * 1000
          const fileSize = Number(additionalData.FILESIZE)

          if (durationMs > 0 && fileSize > 0) {
            const byteRate = fileSize / durationMs
            const rawOffset = additionalData.startTime * byteRate
            const chunkIndex = Math.floor(rawOffset / bufferSize)
            const byteOffset = chunkIndex * bufferSize

            if (byteOffset > 0) {
              headers.Range = `bytes=${byteOffset}-`
            }
            i = chunkIndex
          }
        }

        const res = await makeRequest(url, {
          method: 'GET',
          streamOnly: true,
          headers
        })

        if (res.error || (res.statusCode !== 200 && res.statusCode !== 206)) {
          const error =
            res.error ||
            new Error(`Request failed with status ${res.statusCode}`)
          logger(
            'error',
            'Sources',
            `Error fetching Deezer stream: ${error.message}`
          )
          return resolve({
            exception: {
              message: error.message,
              severity: 'fault',
              cause: 'Upstream'
            }
          })
        }

        if (res.statusCode === 200) {
          i = 0
        }

        const blowfish = new BlowfishCBC(trackKey)
        blowfish.setIv(IV)

        res.stream.on('data', (chunk) => {
          buf = Buffer.concat([buf, chunk])

          while (buf.length >= bufferSize) {
            const bufferSized = buf.subarray(0, bufferSize)

            if (i % 3 === 0) {
              blowfish.setIv(IV)
              outputStream.push(Buffer.from(blowfish.decode(bufferSized)))
            } else {
              outputStream.push(bufferSized)
            }
            i++
            buf = buf.subarray(bufferSize)
          }
        })

        res.stream.on('end', () => {
          if (buf.length > 0) {
            outputStream.push(buf)
          }
          outputStream.emit('finishBuffering')
          outputStream.end()
        })

        res.stream.on('error', (error) => {
          logger(
            'error',
            'Sources',
            `Error in Deezer source stream for track ${decodedTrack.title}: ${error.message}`
          )
          if (!outputStream.destroyed) {
            outputStream.destroy(error)
          }
        })

        resolve({ stream: outputStream })
      } catch (e) {
        logger(
          'error',
          'Sources',
          `Failed to load Deezer stream for ${decodedTrack.identifier}: ${e.message}`
        )
        resolve({ exception: { message: e.message, severity: 'fault' } })
      }
    })
  }

  _calculateKey(songId) {
    const key = this.config.sources?.deezer?.decryptionKey

    if (typeof key !== 'string' || key.length !== 16) {
      throw new Error(
        'A valid 16-character Deezer decryptionKey is not provided in the configuration.'
      )
    }

    const songIdHash = crypto
      .createHash('md5')
      .update(songId.toString(), 'ascii')
      .digest('hex')
    const trackKey = Buffer.alloc(16)

    for (let i = 0; i < 16; i++) {
      trackKey[i] =
        songIdHash.charCodeAt(i) ^
        songIdHash.charCodeAt(i + 16) ^
        key.charCodeAt(i)
    }

    return trackKey
  }
}
