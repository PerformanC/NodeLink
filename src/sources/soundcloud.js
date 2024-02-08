import { PassThrough } from 'node:stream'

import config from '../../config.js'
import { debugLog, encodeTrack, http1makeRequest } from '../utils.js'
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
  return new Promise(async (resolve) => {
    let { body: data } = await http1makeRequest(`https://api-v2.soundcloud.com/resolve?url=${encodeURI(url)}&client_id=${sourceInfo.clientId}`, { method: 'GET' })

    if (typeof data !== 'object') {
      debugLog('loadtracks', 4, { type: 3, loadType: 'unknown', sourceName: 'Soundcloud', query: url, message: 'Invalid response from SoundCloud.' })

      return resolve({ loadType: 'error', data: { message: 'Invalid response from SoundCloud.', severity: 'common', cause: 'Unknown' } })
    }

    debugLog('loadtracks', 4, { type: 1, loadType: data.kind || 'unknown', sourceName: 'SoundCloud', query: url })

    if (Object.keys(data).length === 0) {
      debugLog('loadtracks', 4, { type: 3, loadType: data.kind || 'unknown', sourceName: 'Soundcloud', query: url, message: 'No matches found.' })

      return resolve({ loadType: 'empty', data: {} })
    }

    switch (data.kind) {
      case 'track': {
        const track = {
          identifier: data.id.toString(),
          isSeekable: true,
          author: data.user.username,
          length: data.duration,
          isStream: false,
          position: 0,
          title: data.title,
          uri: data.permalink_url,
          artworkUrl: data.artwork_url,
          isrc: data.publisher_metadata ? data.publisher_metadata.isrc : null,
          sourceName: 'soundcloud'
        }

        debugLog('loadtracks', 4, { type: 2, loadType: 'track', sourceName: 'SoundCloud', track, query: url })

        return resolve({
          loadType: 'track',
          data: {
            encoded: encodeTrack(track),
            info: track,
            playlistInfo: {}
          }
        })
      }
      case 'playlist': {
        const tracks = []
        const notLoaded = []

        if (data.tracks.length > config.options.maxAlbumPlaylistLength)
          data.tracks = data.tracks.slice(0, config.options.maxAlbumPlaylistLength)

        data.tracks.forEach((item, index) => {
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
            position: index,
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

            data.forEach((item, index) => {
              const track = {
                identifier: item.id.toString(),
                isSeekable: true,
                author: item.user.username,
                length: item.duration,
                isStream: false,
                position: index,
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

        return resolve({
          loadType: 'playlist',
          data: {
            info: {
              name: data.title,
              selectedTrack: 0,
            },
            pluginInfo: {},
            tracks,
          }
        })
      }
      case 'user': {
        debugLog('loadtracks', 4, { type: 2, loadType: 'artist', sourceName: 'SoundCloud', playlistName: data.full_name })

        return resolve({ loadType: 'empty', data: {} })
      }
    }
  })
}

async function search(query, shouldLog) {
  if (shouldLog) debugLog('search', 4, { type: 1, sourceName: 'SoundCloud', query })

  const req = await http1makeRequest(`https://api-v2.soundcloud.com/search?q=${encodeURI(query)}&variant_ids=&facet=model&user_id=992000-167630-994991-450103&client_id=${sourceInfo.clientId}&limit=${config.options.maxResultsLength}&offset=0&linked_partitioning=1&app_version=1679652891&app_locale=en`, {
    method: 'GET'
  })

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

  if (data.body.total_results === 0) {
    return {
      loadType: 'empty',
      data: {}
    }
  }

  const tracks = []
  let index = 0

  data.body.collection.forEach((item, i) => {
    if (tracks.length > config.options.maxSearchResults) return
    if (item.kind !== 'track') return;

    const track = {
      identifier: item.id.toString(),
      isSeekable: true,
      author: item.user.username,
      length: item.duration,
      isStream: false,
      position: index++,
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

    if (req.body.errors) {
      debugLog('retrieveStream', 4, { type: 2, sourceName: 'SoundCloud', query: title, message: req.body.errors[0].error_message })

      return {
        exception: {
          message: req.body.errors[0].error_message,
          severity: 'fault',
          cause: 'Unknown'
        }
      }
    }

    const oggOpus = req.body.media.transcodings.find((transcoding) => transcoding.format.mime_type === 'audio/ogg; codecs="opus"')
    const transcoding = oggOpus || req.body.media.transcodings[0]

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

async function loadStream(title, url, protocol) {
  return new Promise(async (resolve) => {
    const stream = new PassThrough()

    if (protocol === 'hls') {
      const streamHlsRedirect = await http1makeRequest(url, { method: 'GET' })
      const streamHls = await http1makeRequest(streamHlsRedirect.body.url, { method: 'GET' })
      const streams = streamHls.body.split('\n').filter((line) => line.startsWith('https://'))

      let i = 0

      async function loadNext() {
        const res = await http1makeRequest(streams[i], { method: 'GET', streamOnly: true })

        res.stream.on('data', (chunk) => stream.write(chunk))
        res.stream.on('end', () => {
          i++

          if (i < streams.length) loadNext()
          else stream.end()
        })
        res.stream.on('error', (error) => {
          debugLog('retrieveStream', 4, { type: 2, sourceName: 'SoundCloud', query: title, message: error.message })
  
          resolve({ status: 1, exception: { message: error.message, severity: 'fault', cause: 'Unknown' } })
        })
      }

      const res = await http1makeRequest(streams[i], { method: 'GET', streamOnly: true })

      res.stream.on('data', (chunk) => stream.write(chunk))
      res.stream.on('end', () => {
        i++

        if (i < streams.length) loadNext()
        else stream.end()
      })
      res.stream.on('error', (error) => {
        debugLog('retrieveStream', 4, { type: 2, sourceName: 'SoundCloud', query: title, message: error.message })

        resolve({ status: 1, exception: { message: error.message, severity: 'fault', cause: 'Unknown' } })
      })

      res.stream.once('readable', () => resolve(stream))
    } else {
      const res = await http1makeRequest(url, { method: 'GET', streamOnly: true })

      res.stream.on('data', (chunk) => stream.write(chunk))
      res.stream.on('end', () => stream.end())
      res.stream.on('error', (error) => {
        debugLog('retrieveStream', 4, { type: 2, sourceName: 'SoundCloud', query: title, message: error.message })

        resolve({ status: 1, exception: { message: error.message, severity: 'fault', cause: 'Unknown' } })
      })

      res.stream.once('readable', () => resolve(stream))
    }
  })
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
  loadStream,
  loadFilters
}