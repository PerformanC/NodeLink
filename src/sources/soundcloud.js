import { PassThrough } from 'node:stream'
import {
  encodeTrack,
  http1makeRequest,
  loadHLS,
  logger,
  makeRequest
} from '../utils.js'

export default class {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.baseUrl = 'https://api-v2.soundcloud.com'
    this.searchTerms = ['scsearch']
    this.patterns = [
      /^https?:\/\/(www\.)?soundcloud\.com\/[^/\s]+\/[^/\s]+$/,
      /^https?:\/\/m\.soundcloud\.com\/[^/\s]+\/[^/\s]+$/,
      /^https?:\/\/(www\.)?soundcloud\.com\/[^/\s]+\/sets\/[^/\s]+$/,
      /^https?:\/\/m\.soundcloud\.com\/[^/\s]+\/sets\/[^/\s]+$/
    ]

    this.clientId = this.nodelink.options?.sources?.clientId ?? null
  }

  async setup() {
    if (this.clientId) return true
    try {
      const mainPageRequest = await makeRequest('https://soundcloud.com', {
        method: 'GET'
      })
      if (!mainPageRequest) {
        logger('error', 'Sources', 'Failed to load SoundCloud main page')
        return false
      }
      if (mainPageRequest.error) {
        logger(
          'error',
          'Sources',
          `Failed to fetch SoundCloud clientId: ${mainPageRequest.error.message}`
        )
        return false
      }
      const assetIdMatch = mainPageRequest.body.match(
        /https:\/\/a-v2.sndcdn.com\/assets\/([a-zA-Z0-9-]+).js/gs
      )
      if (!assetIdMatch || !assetIdMatch[5]) {
        logger(
          'warn',
          'Sources',
          'SoundCloud asset script URL not found at expected index. Source setup failed.'
        )
        return false
      }
      const assetId = assetIdMatch[5]

      const assetRequest = await http1makeRequest(assetId)
      if (!assetRequest) {
        logger(
          'error',
          'Sources',
          'Failed to load SoundCloud asset. Source setup failed.'
        )
        return false
      }
      if (assetRequest.error) {
        logger(
          'error',
          'Sources',
          `Failed to fetch SoundCloud assets: ${assetRequest.error.message}. Source setup failed.`
        )
        return false
      }

      const clientIdMatch = assetRequest.body.match(
        /client_id=([a-zA-Z0-9]{32})/
      )
      if (!clientIdMatch || !clientIdMatch[1]) {
        logger(
          'warn',
          'Sources',
          'SoundCloud client_id not found in asset script. Source setup failed.'
        )
        return false
      }
      const clientId = clientIdMatch[1]
      if (!clientId) {
        logger(
          'error',
          'Sources',
          'Failed to fetch SoundCloud clientId. Source setup failed.'
        )
        return false
      }
      logger(
        'info',
        'Sources',
        `Loaded SoundCloud source (clientId: ${clientId})`
      )
      this.clientId = clientId
    } catch (err) {
      logger(
        'error',
        'Sources',
        `Error setting up SoundCloud source: ${err.message}`
      )
      return false
    }
    return true
  }

  match() {}

  async search(query) {
    const req = await http1makeRequest(
      `https://api-v2.soundcloud.com/search?q=${encodeURI(query)}&variant_ids=&facet=model&user_id=992000-167630-994991-450103&client_id=${this.clientId}&limit=${this.nodelink.options.maxSearchResults}&offset=0&linked_partitioning=1&app_version=1679652891&app_locale=en`
    )
    if (req.error || req.statusCode !== 200) {
      return {
        loadType: 'error',
        data: {
          message: req.error
            ? req.error.message
            : `SoundCloud returned invalid status code: ${req.statusCode}`,
          severity: 'fault',
          cause: 'Unknown'
        }
      }
    }
    const { body } = req
    if (body.total_results === 0) {
      logger(
        'debug',
        'Sources',
        `No results found on SoundCloud for: "${query}"`
      )
      return {
        loadType: 'empty',
        data: {}
      }
    }

    const tracks = []
    if (body.collection > this.nodelink.options.maxSearchResults)
      body.collection = body.collection.filter(
        (item, index) =>
          index < this.nodelink.options.maxSearchResults ||
          item.kind === 'track'
      )
    for (const item of body.collection) {
      if (item.kind !== 'track') continue
      const track = this._buildTrack(item)
      tracks.push(track)
    }

    logger(
      'debug',
      'Sources',
      `Found ${tracks.length} tracks on SoundCloud for "${query}"`
    )
    return {
      loadType: 'search',
      data: tracks
    }
  }

  async resolve(url) {
    const request = await http1makeRequest(
      `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(url)}&client_id=${this.clientId}`
    )

    if (request.statusCode === 404) return { loadType: 'empty', data: {} }

    if (request.error || request.statusCode !== 200) {
      return {
        loadType: 'error',
        data: {
          message:
            request.error?.message ||
            `Invalid status code: ${request.statusCode}`,
          severity: 'fault',
          cause: 'Unknown'
        }
      }
    }

    const { body } = request
    if (!body || typeof body !== 'object') {
      return {
        loadType: 'error',
        data: {
          message: 'Invalid SoundCloud response',
          severity: 'fault',
          cause: 'Unknown'
        }
      }
    }

    if (body.kind === 'track') {
      return {
        loadType: 'track',
        data: this._buildTrack(body)
      }
    }

    if (body.kind === 'playlist') {
      const trackIds = []
      const completeTracks = []

      for (const t of body.tracks) {
        if (t?.title && t.user) {
          completeTracks.push(t)
        } else if (t?.id) {
          trackIds.push(t.id)
        }
      }

      while (trackIds.length) {
        const batch = trackIds.splice(0, 50)
        const res = await http1makeRequest(
          `https://api-v2.soundcloud.com/tracks?ids=${batch.join('%2C')}&client_id=${this.clientId}`,
          {
            method: 'GET'
          }
        )

        if (Array.isArray(res.body)) {
          completeTracks.push(...res.body)
        } else {
          break
        }
      }

      if (completeTracks.length > this.nodelink.options.maxAlbumPlaylistLength)
        completeTracks.length = this.nodelink.options.maxAlbumPlaylistLength

      const tracks = completeTracks.map((item) => this._buildTrack(item))

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

    return { loadType: 'empty', data: {} }
  }

  _buildTrack(item) {
    const info = {
      title: item.title,
      author: item.user.username,
      length: item.duration,
      identifier: item.id.toString(),
      isSeekable: true,
      isStream: false,
      uri: item.permalink_url,
      artworkUrl: item.artwork_url || null,
      isrc: item.publisher_metadata?.isrc || null,
      sourceName: 'soundcloud',
      position: 0
    }

    return {
      encoded: encodeTrack(info),
      info,
      pluginInfo: {}
    }
  }

  async getTrackUrl(info) {
    const req = await http1makeRequest(
      `https://api-v2.soundcloud.com/resolve?url=https://api.soundcloud.com/tracks/${info.identifier}&client_id=${this.clientId}`
    )
    const body = req.body
    if (req.error || req.statusCode !== 200) {
      logger(
        'error',
        'Sources',
        `SoundCloud getTrackUrl error: ${req.error?.message}`
      )
      return {
        exception: {
          message:
            req.error?.message ||
            `SoundCloud returned invalid status code: ${req.statusCode}`,
          severity: 'fault',
          cause: 'Unknown'
        }
      }
    }
    if (body.errors) {
      logger(
        'error',
        'Sources',
        `SoundCloud getTrackUrl error: ${body.errors[0].error_message}`
      )
      return {
        exception: {
          message: body.errors[0].error_message,
          severity: 'fault',
          cause: 'Unknown'
        }
      }
    }

    const mp3Transcoding = body.media.transcodings.find(
      (transcoding) =>
        transcoding.format.protocol === 'progressive' &&
        transcoding.format.mime_type === 'audio/mpeg'
    )

    const oggOpus = body.media.transcodings.find(
      (transcoding) =>
        transcoding.format.protocol === 'hls' &&
        transcoding.format.mime_type === 'audio/ogg; codecs="opus"'
    )

    const transcoding = mp3Transcoding || oggOpus || body.media.transcodings[0]

    if (!transcoding) {
      return {
        exception: {
          message: 'No valid transcoding found',
          severity: 'fault',
          cause: 'Unknown'
        }
      }
    }

    let url = `${transcoding.url}?client_id=${this.clientId}`

    if (transcoding.format.protocol === 'hls') {
      const urlReq = await http1makeRequest(url)
      if (urlReq.body?.url) {
        url = urlReq.body.url
      } else {
        return {
          exception: {
            message: 'Failed to resolve HLS stream URL',
            severity: 'fault',
            cause: 'Unknown'
          }
        }
      }
    } else if (transcoding.format.protocol === 'progressive') {
      const urlReq = await http1makeRequest(url)
      if (urlReq.body?.url) {
        url = urlReq.body.url
      } else {
        return {
          exception: {
            message: 'Failed to resolve progressive stream URL',
            severity: 'fault',
            cause: 'Unknown'
          }
        }
      }
    }

    let format = 'arbitrary'
    if (transcoding.format.mime_type) {
      const mimeType = transcoding.format.mime_type.toLowerCase()
      if (mimeType.includes('mpeg')) {
        format = 'mp3'
      } else if (mimeType.includes('opus')) {
        format = 'opus'
      } else if (mimeType.includes('aac')) {
        format = 'aac'
      }
    }

    return {
      url,
      protocol: transcoding.format.protocol,
      format
    }
  }

  async loadStream(track, url, protocol, additionalData) {
    const stream = new PassThrough()

    if (protocol === 'progressive') {
      try {
        const response = await http1makeRequest(url, {
          method: 'GET',
          streamOnly: true
        })

        if (response.error) {
          stream.destroy(new Error(`Failed to load stream: ${response.error.message}`))
          return { stream }
        }

        response.stream.pipe(stream)

        response.stream.on('error', (err) => {
          logger('error', 'Sources', `Progressive stream error: ${err.message}`)
          if (!stream.destroyed) {
            stream.destroy(err)
          }
        })

        response.stream.on('end', () => {
          stream.emit('finishBuffering')
        })
      } catch (err) {
        logger('error', 'Sources', `Failed to load progressive stream: ${err.message}`)
        stream.destroy(err)
      }
    } else if (protocol === 'hls') {
      loadHLS(url, stream, false, true).catch((err) => {
        logger('error', 'Sources', `HLS stream error: ${err.message}`)
        if (!stream.destroyed) {
          stream.destroy(err)
        }
      })
    } else {
      stream.destroy(new Error(`Unsupported protocol: ${protocol}`))
    }

    return { stream }
  }
}
