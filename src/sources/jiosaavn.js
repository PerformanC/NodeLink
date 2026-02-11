import { PassThrough } from 'node:stream'
import { encodeTrack, http1makeRequest, logger, getBestMatch, } from '../utils.ts'
import { desEcbDecryptBase64ToUtf8 } from '../decrypters/des-ecb.ts'

const API_BASE = 'https://www.jiosaavn.com/api.php'
const J_BUFFER = Buffer.from('38346591')
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
  Accept: 'application/json'
}
const HTML_ENTITY_REGEX = /&(?:quot|amp);/g
const ENTITY_MAP = { '&quot;': '"', '&amp;': '&' }

export default class JioSaavnSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options.sources?.jiosaavn || {}
    this.searchTerms = ['jssearch']
    this.recommendationTerm = ['jsrec']
    this.patterns = [
      /https?:\/\/(?:www\.)?jiosaavn\.com\/(?:(?<type>album|featured|song|s\/playlist|artist)\/)(?:[^/]+\/)(?<id>[A-Za-z0-9_,-]+)/
    ]
    this.priority = 60
    this.playlistLoadLimit = this.config.playlistLoadLimit || 50
    this.artistLoadLimit = this.config.artistLoadLimit || 20
  }

  async setup() {
    if (this.config.enabled === false) return false
    logger('info', 'JioSaavn', 'JioSaavn source initialized.')
    return true
  }

  async search(query, sourceTerm) {
    if (this.recommendationTerm.includes(sourceTerm)) {
      return this.getRecommendations(query)
    }

    try {
      logger('debug', 'JioSaavn', `Searching for: ${query}`)

      const data = await this._getJson({
        __call: 'search.getResults',
        q: query,
        includeMetaTags: '1'
      })

      if (!data?.results?.length) {
        logger('debug', 'JioSaavn', 'Search returned no results.')
        return { loadType: 'empty', data: {} }
      }

      return {
        loadType: 'search',
        data: data.results.map((item) => this._parseTrack(item))
      }
    } catch (e) {
      logger('error', 'JioSaavn', `Search error: ${e.message}`)
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  async getRecommendations(query) {
    let id = query
    if (!/^[A-Za-z0-9_,-]+$/.test(query)) {
      const searchRes = await this.search(query, 'jssearch')
      if (searchRes.loadType === 'search' && searchRes.data.length > 0) {
        id = searchRes.data[0].info.identifier
      } else {
        return { loadType: 'empty', data: {} }
      }
    }

    try {
      const encodedId = encodeURIComponent(`["${id}"]`)
      let json = await this._getJson({
        __call: 'webradio.createEntityStation',
        api_version: '4',
        ctx: 'android',
        entity_id: encodedId,
        entity_type: 'queue'
      })

      if (json?.stationid) {
        const stationId = json.stationid
        json = await this._getJson({
          __call: 'webradio.getSong',
          api_version: '4',
          ctx: 'android',
          stationid: encodeURIComponent(stationId),
          k: '20'
        })

        if (json && !json.error) {
          const tracks = Object.values(json)
            .filter((item) => item && typeof item === 'object' && item.song)
            .map((item) => this._parseTrack(item.song, true))

          if (tracks.length > 0) {
            return {
              loadType: 'playlist',
              data: {
                info: { name: 'JioSaavn Recommendations', selectedTrack: 0 },
                pluginInfo: { type: 'recommendations' },
                tracks
              }
            }
          }
        }
      }

      const metadata = await this._fetchSongMetadata(id)
      if (metadata?.primary_artists_id) {
        const artistIdsJoined = metadata.primary_artists_id
        json = await this._getJson({
          __call: 'search.artistOtherTopSongs',
          api_version: '4',
          ctx: 'wap6dot0',
          artist_ids: encodeURIComponent(artistIdsJoined),
          song_id: encodeURIComponent(id),
          language: 'unknown'
        })

        if (json && Array.isArray(json) && json.length > 0) {
          const tracks = json.map((item) => this._parseTrack(item, true))
          return {
            loadType: 'playlist',
            data: {
              info: { name: 'JioSaavn Recommendations', selectedTrack: 0 },
              pluginInfo: { type: 'recommendations' },
              tracks
            }
          }
        }
      }

      return { loadType: 'empty', data: {} }
    } catch (e) {
      logger('error', 'JioSaavn', `Recommendations error: ${e.message}`)
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  async resolve(url) {
    const match = url.match(this.patterns[0])
    if (!match) return { loadType: 'empty', data: {} }

    const { type, id } = match.groups
    logger('debug', 'JioSaavn', `Resolving ${type} with ID: ${id}`)

    try {
      if (type === 'song') {
        const trackData = await this._fetchSongMetadata(id)
        if (!trackData) {
          logger(
            'error',
            'JioSaavn',
            `All resolution methods failed for song ${id}`
          )
          return { loadType: 'empty', data: {} }
        }
        return { loadType: 'track', data: this._parseTrack(trackData) }
      }

      return this._resolveList(type, id)
    } catch (e) {
      logger('error', 'JioSaavn', `Resolve error: ${e.message}`)
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  async getTrackUrl(decodedTrack) {
    try {
      logger(
        'debug',
        'JioSaavn',
        `Fetching stream for: ${decodedTrack.identifier}`
      )

      const trackData = await this._fetchSongMetadata(decodedTrack.identifier)

      if (!trackData) {
        return {
          exception: { message: 'Track metadata not found', severity: 'common' }
        }
      }

      if (!trackData.encrypted_media_url) {
        return {
          exception: {
            message: 'No encrypted_media_url found',
            severity: 'fault'
          }
        }
      }

      let playbackUrl = this._decryptUrl(trackData.encrypted_media_url)

      if (trackData['320kbps'] === 'true' || trackData['320kbps'] === true) {
        playbackUrl = playbackUrl.replace('_96.mp4', '_320.mp4')
      }

      return {
        url: playbackUrl,
        protocol: 'https',
        format: 'mp4',
        additionalData: {}
      }
    } catch (e) {
      logger(
        'warn',
        'JioSaavn',
        `Direct stream failed for ${decodedTrack.title}: ${e.message}. Falling back to YouTube.`
      )
    }

    const searchResult = await this.nodelink.sources.searchWithDefault(
      `${decodedTrack.title} ${decodedTrack.author}`
    )

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

  async loadStream(_track, url, _protocol, _additionalData) {
    const { stream, error, statusCode } = await http1makeRequest(url, {
      method: 'GET',
      streamOnly: true,
      proxy: this.config.proxy
    })

    if (error || statusCode !== 200) {
      return {
        exception: {
          message: `Failed to load stream: ${error?.message || statusCode}`,
          severity: 'fault'
        }
      }
    }

    const passthrough = new PassThrough()

    stream.on('data', (chunk) => {
      if (!passthrough.write(chunk)) stream.pause()
    })

    passthrough.on('drain', () => {
      if (!stream.destroyed) stream.resume()
    })

    stream.on('end', () => {
      if (!passthrough.writableEnded) {
        passthrough.emit('finishBuffering')
        passthrough.end()
      }
    })

    stream.on('error', (err) => {
      logger('error', 'JioSaavn', `Stream error: ${err.message}`)
      if (!passthrough.destroyed) passthrough.destroy(err)
    })

    return { stream: passthrough, type: 'mp4' }
  }

  async _getJson(params) {
    const url = new URL(API_BASE)
    url.search = new URLSearchParams({
      _format: 'json',
      _marker: '0',
      cc: 'in',
      ctx: 'web6dot0',
      ...params
    }).toString()

    const { body, error, statusCode } = await http1makeRequest(url.toString(), {
      method: 'GET',
      headers: HEADERS,
      proxy: this.config.proxy
    })

    if (error || statusCode !== 200) {
      throw new Error(`JioSaavn API request failed: ${statusCode}`)
    }

    try {
      return typeof body === 'string' ? JSON.parse(body) : body
    } catch (_e) {
      throw new Error('Failed to parse JioSaavn response')
    }
  }

  async _fetchSongMetadata(id) {
    let data = await this._getJson({ __call: 'song.getDetails', pids: id })
    if (data && (data[id] || data.songs?.[0])) {
      return data[id] || data.songs[0]
    }

    logger(
      'warn',
      'JioSaavn',
      `song.getDetails failed for ${id}. Retrying with webapi.get...`
    )

    data = await this._getJson({
      __call: 'webapi.get',
      api_version: '4',
      token: id,
      type: 'song'
    })

    return data?.songs?.[0] || null
  }

  async _resolveList(type, id) {
    const params = {
      __call: 'webapi.get',
      api_version: '4',
      token: id,
      type: type === 'featured' || type === 's/playlist' ? 'playlist' : type
    }

    if (type === 'artist') params.n_song = this.artistLoadLimit
    else params.n = this.playlistLoadLimit

    const data = await this._getJson(params)
    const list = data?.list || data?.topSongs

    if (!list?.length) return { loadType: 'empty', data: {} }

    const tracks = list.map((item) => this._parseTrack(item))
    let name = data.title || data.name || ''
    if (type === 'artist') name = `${name}'s Top Tracks`

    return {
      loadType: 'playlist',
      data: {
        info: {
          name: this._cleanString(name),
          selectedTrack: 0
        },
        tracks
      }
    }
  }

  _decryptUrl(encryptedUrl) {
    return desEcbDecryptBase64ToUtf8(encryptedUrl, J_BUFFER)
  }

  _cleanString(str) {
    if (!str) return ''
    return str.replace(HTML_ENTITY_REGEX, (tag) => ENTITY_MAP[tag])
  }

  _parseTrack(json) {
    if (!json) return null

    const id = json.id
    const title = this._cleanString(json.title || json.song)
    const uri = json.perma_url
    const duration =
      parseInt(json.more_info?.duration || json.duration || '0', 10) * 1000

    const primaryArtists = json.more_info?.artistMap?.primary_artists
    const artistList = json.more_info?.artistMap?.artists
    const metaArtist =
      Array.isArray(primaryArtists) && primaryArtists.length
        ? primaryArtists
        : Array.isArray(artistList)
          ? artistList
          : null

    let author
    if (metaArtist) {
      author = metaArtist.map((a) => a.name).join(', ')
    } else {
      author =
        json.more_info?.music ||
        json.primary_artists ||
        json.singers ||
        'Unknown Artist'
    }

    const artworkUrl = (json.image || '').replace('150x150', '500x500')

    const trackInfo = {
      identifier: String(id),
      isSeekable: true,
      author: this._cleanString(author),
      length: duration,
      isStream: false,
      position: 0,
      title,
      uri,
      artworkUrl,
      isrc: null,
      sourceName: 'jiosaavn'
    }

    return {
      encoded: encodeTrack(trackInfo),
      info: trackInfo,
      pluginInfo: {}
    }
  }
}
