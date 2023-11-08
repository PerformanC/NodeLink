import { PassThrough } from 'node:stream'

import config from '../../config.js'
import { debugLog, encodeTrack, http1makeRequest } from '../utils.js'

async function loadFrom(url) {
  return new Promise(async (resolve) => {
    debugLog('loadtracks', 4, { type: 1, loadType: 'track', sourceName: 'SoundCloud', query: url })

    const data = await http1makeRequest(`https://api-v2.soundcloud.com/resolve?url=${encodeURI(url)}&client_id=${config.search.sources.soundcloud.clientId}`, { method: 'GET' })

    if (JSON.stringify(data) == '{}')
      return resolve({ loadType: 'empty', data: {} })

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

        data.tracks.forEach((item, index) => {
          if (tracks.length > config.options.maxAlbumPlaylistLength) return;

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

          while (notLoaded.length && !stop) {
            if (tracks.length > config.options.maxAlbumPlaylistLength) return;

            const notLoadedLimited = notLoaded.slice(0, 50)
            const data = await http1makeRequest(`https://api-v2.soundcloud.com/tracks?ids=${notLoadedLimited.join('%2C')}&client_id=${config.search.sources.soundcloud.clientId}`, { method: 'GET' })

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

            if (notLoaded.length == 0)
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
    }
  })
}

async function search(query, shouldLog) {
  return new Promise(async (resolve) => {
    if (shouldLog) debugLog('search', 4, { type: 1, sourceName: 'SoundCloud', query })

    const data = await http1makeRequest(`https://api-v2.soundcloud.com/search?q=${encodeURI(query)}&variant_ids=&facet=model&user_id=992000-167630-994991-450103&client_id=${config.search.sources.soundcloud.clientId}&limit=10&offset=0&linked_partitioning=1&app_version=1679652891&app_locale=en`, {
      method: 'GET'
    })

    if (data.total_results == 0)
      return resolve({ loadType: 'empty', data: {} })

    const tracks = []
    let index = 0

    data.collection.forEach((item, i) => {
      if (tracks.length > config.options.maxSearchResults) return
      if (item.kind != 'track') return;

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

    if (shouldLog) debugLog('search', 4, { type: 2, sourceName: 'SoundCloud', tracksLen: tracks.length, query })

    resolve({
      loadType: 'search',
      data: tracks
    })
  })
}

async function retrieveStream(identifier, title) {
  return new Promise(async (resolve) => {
    const data = await http1makeRequest(`https://api-v2.soundcloud.com/resolve?url=https://api.soundcloud.com/tracks/${identifier}&client_id=${config.search.sources.soundcloud.clientId}`, { method: 'GET' })
      
    if (data.errors) {
      debugLog('retrieveStream', 4, { type: 2, sourceName: 'SoundCloud', query: title, message: data.errors[0].error_message })

      return resolve({ exception: { message: data.errors[0].error_message, severity: 'fault', cause: 'Unknown' } })
    }

    // let oggOpus = null
    // data.media.transcodings.forEach(async (transcoding) => {
    //   if (transcoding.format.mime_type == 'audio/ogg; codecs="opus"') {
    //     opus = transcoding
    //   }
    // })
    const transcoding = data.media.transcodings[0]

    // if (!oggOpus) {
      resolve({ url: transcoding.url + `?client_id=${config.search.sources.soundcloud.clientId}`, protocol: 'https', type: 'opus' })
    // }
  })
}

async function loadHls(url) {
  const streamHlsRedirect = await http1makeRequest(url, { method: 'GET' })
  const streamHls = await http1makeRequest(streamHlsRedirect.url, { method: 'GET' })
  const streams = []
  
  streamHls.split('\n').forEach((line) => {
    if (!line.startsWith('https://')) return;

    streams.push(line)
  })

  const stream = new PassThrough()
  let i = 0

  function next() {
    http1makeRequest(streams[i], { streamOnly: true }).then((res) => {
      res.on('data', (chunk) => stream.write(chunk))
      res.on('end', () => {
        i++
        if (i < streams.length) next()
      })
    })
  }

  http1makeRequest(streams[i], { streamOnly: true }).then((res) => {
    res.on('data', (chunk) => stream.write(chunk))
    res.on('end', () => {
      i++
      if (i < streams.length) next()
    })
  })

  return stream
}

export default {
  loadFrom,
  search,
  retrieveStream,
  loadHls
}