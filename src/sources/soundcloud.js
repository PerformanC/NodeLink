import config from '../../config.js'
import utils from '../utils.js'

async function loadFrom(url) {
  return new Promise(async (resolve) => {
    console.log(`[NodeLink:sources]: Loading track from SoundCloud: ${url}`)

    const data = await utils.http1makeRequest(`https://api-v2.soundcloud.com/resolve?url=${encodeURI(url)}&client_id=${config.search.sources.soundcloud.clientId}`, { method: 'GET' })

    if (JSON.stringify(data) == '{}')
      return resolve({ loadType: 'empty', data: {} })

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
            encoded: utils.encodeTrack(infoObj),
            info: infoObj,
            playlistInfo: {}
          }
        })

        break
      }
      case 'playlist': {
        const tracks = []

        utils.forEach(data.tracks, async (track, index) => {
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
            encoded: utils.encodeTrack(infoObj),
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
    console.log(`[NodeLink:sources]: Searching track on SoundCloud: ${query}`)

    const data = await utils.http1makeRequest(`https://api-v2.soundcloud.com/search?q=${encodeURI(query)}&variant_ids=&facet=model&user_id=992000-167630-994991-450103&client_id=${config.search.sources.soundcloud.clientId}&limit=10&offset=0&linked_partitioning=1&app_version=1679652891&app_locale=en`, {
      method: 'GET'
    })

    if (data.total_results == 0)
      return resolve({ loadType: 'empty', data: {} })

    const tracks = []
    let i = 0

    utils.forEach(data.collection, async (track, index) => {
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
          encoded: utils.encodeTrack(infoObj),
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
    const data = await utils.http1makeRequest(`https://api-v2.soundcloud.com/resolve?url=https://api.soundcloud.com/tracks/${identifier}&client_id=${config.search.sources.soundcloud.clientId}`, { method: 'GET' })
      
    if (data.errors) {
      console.log(`[NodeLink:sources]: Failed to load track: ${data.errors[0].error_message}`)

      return resolve({ status: 1, exception: { message: data.errors[0].error_message, severity: 'UNKNOWN', cause: 'unknown' } })
    }

    utils.forEach(data.media.transcodings, async (transcoding) => {
      if (transcoding.format.protocol == 'progressive') {
        const stream = await utils.http1makeRequest(transcoding.url + `?client_id=${config.search.sources.soundcloud.clientId}`, { method: 'GET' })

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