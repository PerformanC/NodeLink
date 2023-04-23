import config from '../../config.js'
import utils from '../utils.js'

async function loadFrom(url) {
  return new Promise(async (resolve) => {
    utils.debugLog('loadtracks', 4, { type: 1, loadType: 'track', sourceName: 'SoundCloud', query: url })

    const data = await utils.http1makeRequest(`https://api-v2.soundcloud.com/resolve?url=${encodeURI(url)}&client_id=${config.search.sources.soundcloud.clientId}`, { method: 'GET' })

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
          isrc: data.publisher_metadata.isrc,
          sourceName: 'soundcloud'
        }

        utils.debugLog('loadtracks', 4, { type: 2, loadType: 'track', sourceName: 'SoundCloud', track, query })

        return resolve({
          loadType: 'track',
          data: {
            encoded: utils.encodeTrack(track),
            info: track,
            playlistInfo: {}
          }
        })
      }
      case 'playlist': {
        const tracks = []

        const notLoaded = []

        data.tracks.forEach((item, index) => {
          if (!item.title) {
            notLoaded.push(item.id.toString())
            return
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
            isrc: item.publisher_metadata ? item.publisher_metadata.isrc : null,
            sourceName: 'soundcloud'
          }

          tracks.push({
            encoded: utils.encodeTrack(track),
            info: track,
            playlistInfo: {}
          })
        })

        if (notLoaded.length) {
          let stop = false

          while (notLoaded.length && !stop) {
            const notLoadedLimited = notLoaded.slice(0, 50)
            const data = await utils.http1makeRequest(`https://api-v2.soundcloud.com/tracks?ids=${notLoadedLimited.join('%2C')}&client_id=${config.search.sources.soundcloud.clientId}`, { method: 'GET' })

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
                encoded: utils.encodeTrack(track),
                info: track,
                playlistInfo: {}
              })
            })

            notLoaded.splice(0, 50)

            if (notLoaded.length == 0)
              stop = true
          }
        }

        utils.debugLog('loadtracks', 4, { type: 2, loadType: 'playlist', sourceName: 'SoundCloud', tracksLen: tracks.length, query: url })

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

async function search(query) {
  return new Promise(async (resolve) => {
    utils.debugLog('search', 4, { type: 1, sourceName: 'SoundCloud', query })

    const data = await utils.http1makeRequest(`https://api-v2.soundcloud.com/search?q=${encodeURI(query)}&variant_ids=&facet=model&user_id=992000-167630-994991-450103&client_id=${config.search.sources.soundcloud.clientId}&limit=10&offset=0&linked_partitioning=1&app_version=1679652891&app_locale=en`, {
      method: 'GET'
    })

    if (data.total_results == 0)
      return resolve({ loadType: 'empty', data: {} })

    const tracks = []
    let i = 0

    data.collection.forEach((item, index) => {
      if (item.kind == 'track') {
        const track = {
          identifier: item.id.toString(),
          isSeekable: true,
          author: item.user.username,
          length: item.duration,
          isStream: false,
          position: i++,
          title: item.title,
          uri: item.uri,
          artworkUrl: item.artwork_url,
          isrc: null,
          sourceName: 'soundcloud'
        }

        tracks.push({
          encoded: utils.encodeTrack(track),
          info: track,
          pluginInfo: {}
        })
      }
    })
      
    utils.debugLog('search', 4, { type: 2, sourceName: 'SoundCloud', tracksLen: tracks.length, query })

    return resolve({
      loadType: 'search',
      data: tracks
    })
  })
}

async function retrieveStream(identifier) {
  return new Promise(async (resolve) => {
    const data = await utils.http1makeRequest(`https://api-v2.soundcloud.com/resolve?url=https://api.soundcloud.com/tracks/${identifier}&client_id=${config.search.sources.soundcloud.clientId}`, { method: 'GET' })
      
    if (data.errors) {
      utils.debugLog('retrieveStream', 4, { type: 2, sourceName: 'SoundCloud', message: data.errors[0].error_message })

      return resolve({ exception: { message: data.errors[0].error_message, severity: 'UNKNOWN', cause: 'unknown' } })
    }

    data.media.transcodings.forEach(async (transcoding) => {
      if (transcoding.format.protocol == 'progressive') {
        const stream = await utils.http1makeRequest(transcoding.url + `?client_id=${config.search.sources.soundcloud.clientId}`, { method: 'GET' })

        resolve({ url: stream.url, protocol: 'https' })
      }
    })
  })
}

export default {
  loadFrom,
  search,
  retrieveStream
}