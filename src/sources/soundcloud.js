import { PassThrough } from 'node:stream'

import config from '../../config.js'
import { debugLog, encodeTrack, http1makeRequest, loadHLS } from '../utils.js'
import searchWithDefault from './default.js'
import sources from '../sources.js'

const sourceInfo = {
  clientId: null
}

async function init() {
  if (config.search.sources.soundcloud.clientId !== 'AUTOMATIC') {
    sourceInfo.clientId = config.search.sources.soundcloud.clientId

    return;
  }

  debugLog('soundcloud', 5, { type: 1, message: 'clientId not provided. Fetching clientId...' })

  const { body: mainpage } = await http1makeRequest('https://soundcloud.com', {
    method: 'GET'
  }).catch(() => {
    debugLog('soundcloud', 5, { type: 2, message: 'Failed to fetch clientId.' })
  })

  const assetId = mainpage.match(/https:\/\/a-v2.sndcdn.com\/assets\/([a-zA-Z0-9-]+).js/gs)[5]

  const { body: data } = await http1makeRequest(assetId, {
    method: 'GET'
  }).catch(() => {
    debugLog('soundcloud', 5, { type: 2, message: 'Failed to fetch clientId.' })
  })

  const clientId = data.match(/client_id=([a-zA-Z0-9]{32})/)[1]

  if (!clientId) {
    debugLog('soundcloud', 5, { type: 2, message: 'Failed to fetch clientId.' })

    return;
  }

  sourceInfo.clientId = clientId

  debugLog('soundcloud', 5, { type: 1, message: 'Successfully fetched clientId.' })
}

async function loadFrom(url) {
  let req = await http1makeRequest(`https://api-v2.soundcloud.com/resolve?url=${encodeURI(url)}&client_id=${sourceInfo.clientId}`, { method: 'GET' })

  if (req.error || req.statusCode !== 200) {
    const errorMessage = req.error ? req.error.message : `SoundCloud returned invalid status code: ${req.statusCode}`

    debugLog('loadtracks', 4, { type: 2, loadType: 'unknown', sourceName: 'Soundcloud', query: url, message: errorMessage })

    return {
      loadType: 'error',
      data: {
        message: errorMessage,
        severity: 'fault',
        cause: 'Unknown'
      }
    }
  }

  const body = req.body

  if (typeof body !== 'object') {
    debugLog('loadtracks', 4, { type: 3, loadType: 'unknown', sourceName: 'Soundcloud', query: url, message: 'Invalid response from SoundCloud.' })

    return {
      loadType: 'error',
      data: {
        message: 'Invalid response from SoundCloud.',
        severity: 'common',
        cause: 'Unknown'
      }
    }
  }

  debugLog('loadtracks', 4, { type: 1, loadType: body.kind || 'unknown', sourceName: 'SoundCloud', query: url })

  if (Object.keys(body).length === 0) {
    debugLog('loadtracks', 4, { type: 3, loadType: body.kind || 'unknown', sourceName: 'Soundcloud', query: url, message: 'No matches found.' })

    return {
      loadType: 'empty',
      data: {}
    }
  }

  switch (body.kind) {
    case 'track': {
      const track = {
        identifier: body.id.toString(),
        isSeekable: true,
        author: body.user.username,
        length: body.duration,
        isStream: false,
        position: 0,
        title: body.title,
        uri: body.permalink_url,
        artworkUrl: body.artwork_url,
        isrc: body.publisher_metadata ? body.publisher_metadata.isrc : null,
        sourceName: 'soundcloud'
      }

      debugLog('loadtracks', 4, { type: 2, loadType: 'track', sourceName: 'SoundCloud', track, query: url })

      return {
        loadType: 'track',
        data: {
          encoded: encodeTrack(track),
          info: track,
          playlistInfo: {}
        }
      }
    }
    case 'playlist': {
      const tracks = []
      const notLoaded = []

      if (body.tracks.length > config.options.maxAlbumPlaylistLength)
        data.tracks = body.tracks.slice(0, config.options.maxAlbumPlaylistLength)

      body.tracks.forEach((item) => {
        if (!item.title) {
          notLoaded.push(item.id.toString())

          return;
        }

        const track = {
          identifier: item.id.toString(),
          isSeekable: true,
          author: item.user.username,
          length: item.duration,
          isStream: false,
          position: 0,
          title: item.title,
          uri: item.permalink_url,
          artworkUrl: item.artwork_url,
          isrc: item.publisher_metadata?.isrc,
          sourceName: 'soundcloud'
        }

        tracks.push({
          encoded: encodeTrack(track),
          info: track,
          playlistInfo: {}
        })
      })

      if (notLoaded.length) {
        let stop = false

        while ((notLoaded.length && !stop) && (tracks.length > config.options.maxAlbumPlaylistLength)) {
          const notLoadedLimited = notLoaded.slice(0, 50)
          data = await http1makeRequest(`https://api-v2.soundcloud.com/tracks?ids=${notLoadedLimited.join('%2C')}&client_id=${sourceInfo.clientId}`, { method: 'GET' })
          data = data.body

          data.forEach((item) => {
            const track = {
              identifier: item.id.toString(),
              isSeekable: true,
              author: item.user.username,
              length: item.duration,
              isStream: false,
              position: 0,
              title: item.title,
              uri: item.permalink_url,
              artworkUrl: item.artwork_url,
              isrc: item.publisher_metadata ? item.publisher_metadata.isrc : null,
              sourceName: 'soundcloud'
            }

            tracks.push({
              encoded: encodeTrack(track),
              info: track,
              playlistInfo: {}
            })
          })

          notLoaded.splice(0, 50)

          if (notLoaded.length === 0)
            stop = true
        }
      }

      debugLog('loadtracks', 4, { type: 2, loadType: 'playlist', sourceName: 'SoundCloud', playlistName: data.title })

      return {
        loadType: 'playlist',
        data: {
          info: {
            name: data.title,
            selectedTrack: 0,
          },
          pluginInfo: {},
          tracks,
        }
      }
    }
    case 'user': {
      debugLog('loadtracks', 4, { type: 2, loadType: 'artist', sourceName: 'SoundCloud', playlistName: data.full_name })

      return {
        loadType: 'empty',
        data: {}
      }
    }
  }
}

async function search(query, shouldLog) {
  if (shouldLog) debugLog('search', 4, { type: 1, sourceName: 'SoundCloud', query })

  const req = await http1makeRequest(`https://api-v2.soundcloud.com/search?q=${encodeURI(query)}&variant_ids=&facet=model&user_id=992000-167630-994991-450103&client_id=${sourceInfo.clientId}&limit=${config.options.maxResultsLength}&offset=0&linked_partitioning=1&app_version=1679652891&app_locale=en`, { method: 'GET' })
  const body = req.body

  if (req.error || req.statusCode !== 200) {
    const errorMessage = req.error ? req.error.message : `SoundCloud returned invalid status code: ${req.statusCode}`

    debugLog('search', 4, { type: 2, sourceName: 'SoundCloud', query, message: errorMessage })

    return {
      exception: {
        message: errorMessage,
        severity: 'fault',
        cause: 'Unknown'
      }
    }
  }

  if (body.total_results === 0) {
    debugLog('search', 4, { type: 2, sourceName: 'SoundCloud', query, message: 'No matches found.' })

    return {
      loadType: 'empty',
      data: {}
    }
  }

  const tracks = []

  if (body.collection.length > config.options.maxSearchResults)
    body.collection = body.collection.filter((item, i) => i < config.options.maxSearchResults || item.kind === 'track')

  body.collection.forEach((item) => {
    if (item.kind !== 'track') return;
    
    const track = {
      identifier: item.id.toString(),
      isSeekable: true,
      author: item.user.username,
      length: item.duration,
      isStream: false,
      position: 0,
      title: item.title,
      uri: item.uri,
      artworkUrl: item.artwork_url,
      isrc: null,
      sourceName: 'soundcloud'
    }

    tracks.push({
      encoded: encodeTrack(track),
      info: track,
      pluginInfo: {}
    })
  })

  if (shouldLog)
    debugLog('search', 4, { type: 2, sourceName: 'SoundCloud', tracksLen: tracks.length, query })

  return {
    loadType: 'search',
    data: tracks
  }
}

async function retrieveStream(identifier, title) {
  const req = await http1makeRequest(`https://api-v2.soundcloud.com/resolve?url=https://api.soundcloud.com/tracks/${identifier}&client_id=${sourceInfo.clientId}`, { method: 'GET' })
  const body = req.body

  if (req.error || req.statusCode !== 200) {
    const errorMessage = req.error ? req.error.message : `SoundCloud returned invalid status code: ${req.statusCode}`

    debugLog('retrieveStream', 4, { type: 2, sourceName: 'SoundCloud', query: title, message: errorMessage })

    return {
      exception: {
        message: errorMessage,
        severity: 'fault',
        cause: 'Unknown'
      }
    }
  }

  if (body.errors) {
    debugLog('retrieveStream', 4, { type: 2, sourceName: 'SoundCloud', query: title, message: body.errors[0].error_message })

    return {
      exception: {
        message: body.errors[0].error_message,
        severity: 'fault',
        cause: 'Unknown'
      }
    }
  }

  const oggOpus = body.media.transcodings.find((transcoding) => transcoding.format.mime_type === 'audio/ogg; codecs="opus"')
  const transcoding = oggOpus || body.media.transcodings[0]

  if (transcoding.snipped && config.search.sources.soundcloud.fallbackIfSnipped) {
    debugLog('retrieveStream', 4, { type: 2, sourceName: 'SoundCloud', query: title, message: `Track is snipped, falling back to: ${config.search.fallbackSearchSource}.` })

    const search = await searchWithDefault(title, true)

    if (search.loadType === 'search') {
      const urlInfo = await sources.getTrackURL(search.data[0].info)

      return {
        url: urlInfo.url,
        protocol: urlInfo.protocol,
        format: urlInfo.format,
        additionalData: true
      }
    }
  }

  return {
    url: `${transcoding.url}?client_id=${sourceInfo.clientId}`,
    protocol: transcoding.format.protocol,
    format: oggOpus ? 'ogg/opus' : 'arbitrary'
  }
}

async function loadHLSStream(url) {
  const streamHlsRedirect = await http1makeRequest(url, { method: 'GET' })

  const stream = new PassThrough()
  await loadHLS(streamHlsRedirect.body.url, stream, false, true)

  return stream
}

async function loadFilters(url, protocol) {
  if (protocol === 'hls') {
    const streamHlsRedirect = await http1makeRequest(url, { method: 'GET' })

    return streamHlsRedirect.body.url
  } else {
    return url
  }
}

export default {
  init,
  loadFrom,
  search,
  retrieveStream,
  loadHLSStream,
  loadFilters
}
