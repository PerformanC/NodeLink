import utils from '../utils.js'
import searchWithDefault from './default.js'

async function loadFrom(query, track) {
  return new Promise(async (resolve) => {
    let endpoint

    switch (track[1]) {
      case 'track': 
        endpoint = `track/${track[2]}`
        break
      case 'playlist': 
        endpoint = `playlist/${track[2]}`
        break
      case 'album': 
        endpoint = `album/${track[2]}`
        break
      default:
        return resolve({ loadType: 'NO_MATCHES', playlistInfo: {}, tracks: [] })
    }

    console.log(`[NodeLink]: Loading track from Deezer: ${endpoint}`)

    const data = await utils.nodelink_makeRequest(`https://api.deezer.com/${endpoint}`, { method: 'GET' })

    if (data.error) {
      if (data.error.status == 400) 
        return resolve({ loadType: 'NO_MATCHES', playlistInfo: {}, tracks: [], exception: null })

      return resolve({ loadType: 'LOAD_FAILED', playlistInfo: {}, tracks: [], exception: { message: data.error.message, severity: 'UNKNOWN' } })
    }

    switch (track[1]) {
      case 'track': {
        const search = await searchWithDefault(`"${data.title} ${data.artist.name}"`)

        if (search.loadType == 'LOAD_FAILED')
          return resolve(search)

        const infoObj = {
          identifier: search.tracks[0].info.identifier,
          isSeekable: true,
          author: data.artist.name,
          length: search.tracks[0].info.length,
          isStream: false,
          position: 0,
          title: data.title,
          uri: data.link,
          artworkUrl: data.album.cover_xl,
          isrc: null,
          sourceName: 'deezer'
        }

        resolve({
          loadType: 'TRACK_LOADED',
          playlistInfo: null,
          tracks: [{
            encoded: utils.nodelink_encodeTrack(infoObj),
            info: infoObj
          }],
          exception: null
        })

        break
      }
      case 'album':
      case 'playlist': {
        const tracks = []

        data.tracks.data.forEach(async (track, index) => {
          const search = await searchWithDefault(`"${track.title} ${track.artist.name}"`)

          if (search.loadType == 'LOAD_FAILED')
            return resolve(search)

          const infoObj = {
            identifier: search.tracks[0].info.identifier,
            isSeekable: true,
            author: track.artist.name,
            length: search.tracks[0].info.length,
            isStream: false,
            position: index,
            title: track.title,
            uri: track.link,
            artworkUrl: track[1] == 'album' ? data.cover_xl : data.picture_xl,
            isrc: null,
            sourceName: 'deezer'
          }

          tracks.push({
            encoded: utils.nodelink_encodeTrack(infoObj),
            info: infoObj
          })

          if (index == data.tracks.data.length) 
            resolve({
              loadType: 'PLAYLIST_LOADED',
              playlistInfo: {
                name: data.title,
                selectedTrack: 0,
              },
              tracks,
              exception: null
            })
        })

        break
      }
    }
  })
}

export default loadFrom