import config from '../../config.js'
import utils from '../utils.js'

async function loadFrom(url) {
  return new Promise(async (resolve) => {
    console.log(`[NodeLink]: Loading track from SoundCloud: ${url}`)

    const data = await utils.nodelink_http1makeRequest(`https://api-v2.soundcloud.com/resolve?url=${encodeURI(url)}&client_id=${config.search.sources.soundcloud.clientId}`, { method: 'GET' })

    if (data.error) {
      if (data.error.status == 400) 
        return resolve({ loadType: 'empty', data: {} })

      return resolve({ loadType: 'error', data: { message: data.error.message, severity: 'UNKNOWN', cause: 'unknown' } })
    }

    switch (data.kind) {
      case 'track': {
        const infoObj = {
          identifier: data.id.toString(),
          isSeekable: true,
          author: data.user.username,
          length: data.duration,
          isStream: false,
          position: 0,
          title: data.title,
          uri: data.permalink_url,
          artworkUrl: data.artwork_url,
          isrc: null,
          sourceName: 'soundcloud'
        }

        resolve({
          loadType: 'track',
          data: {
            encoded: utils.nodelink_encodeTrack(infoObj),
            info: infoObj,
            playlistInfo: {}
          }
        })

        break
      }
      case 'playlist': {
        const tracks = []

        data.tracks.forEach(async (track, index) => {
          const infoObj = {
            identifier: track.id.toString(),
            isSeekable: true,
            author: track.user.username,
            length: track.duration,
            isStream: false,
            position: index,
            title: track.title,
            uri: track.permalink_url,
            artworkUrl: track.artwork_url,
            isrc: null,
            sourceName: 'soundcloud'
          }

          tracks.push({
            encoded: utils.nodelink_encodeTrack(infoObj),
            info: infoObj,
            playlistInfo: {}
          })

          if (index == data.tracks.length - 1)
            resolve({
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
        })

        break
      }
    }
  })
}

async function search(query) {
  return new Promise(async (resolve) => {
    console.log(`[NodeLink]: Loading track from SoundCloud: ${query}`)

    const data = await utils.nodelink_http1makeRequest(`https://api-v2.soundcloud.com/search?q=${encodeURI(query)}&variant_ids=&facet=model&user_id=992000-167630-994991-450103&client_id=${config.search.sources.soundcloud.clientId}&limit=10&offset=0&linked_partitioning=1&app_version=1679652891&app_locale=en`, {
      method: 'GET'
    })
    
    if (data.error) {
      if (data.error.status == 400) 
        return resolve({ loadType: 'empty', data: {} })

      return resolve({ loadType: 'error', data: { message: data.error.message, severity: 'UNKNOWN', cause: 'unknown' } })
    }

    const tracks = []
    let i = 0

    data.collection.forEach(async (track, index) => {
      if (track.kind == 'track') {
        const infoObj = {
          identifier: track.id.toString(),
          isSeekable: true,
          author: track.user.username,
          length: track.duration,
          isStream: false,
          position: i++,
          title: track.title,
          uri: track.uri,
          artworkUrl: track.artwork_url,
          isrc: null,
          sourceName: 'soundcloud'
        }

        tracks.push({
          encoded: utils.nodelink_encodeTrack(infoObj),
          info: infoObj,
          pluginInfo: {}
        })
      }

      if (index == data.collection.length - 1) {
        resolve({
          loadType: 'search',
          data: tracks
        })
      }
    })
  })
}

async function retrieveStream(identifier) {
  return new Promise(async (resolve) => {
    const data = await utils.nodelink_http1makeRequest(`https://api-v2.soundcloud.com/resolve?url=https://api.soundcloud.com/tracks/${identifier}&client_id=${config.search.sources.soundcloud.clientId}`, { method: 'GET' })
      
    if (data.errors) {
      console.log(`[NodeLink]: Failed to load track: ${data.errors[0].error_message}`)

      return resolve({ status: 1, exception: { message: data.errors[0].error_message, severity: 'UNKNOWN', cause: 'unknown' } })
    }

    data.media.transcodings.forEach(async (transcoding) => {
      if (transcoding.format.protocol == 'progressive') {
        const stream = await utils.nodelink_http1makeRequest(transcoding.url + `?client_id=${config.search.sources.soundcloud.clientId}`, { method: 'GET' })

        resolve({ status: 0, url: stream.url })
      }
    })
  })
}

export default {
  loadFrom,
  search,
  retrieveStream
}