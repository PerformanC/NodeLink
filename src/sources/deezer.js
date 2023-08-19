import config from '../../config.js'
import utils from '../utils.js'
import searchWithDefault from './default.js'

async function loadFrom(query, type) {
  return new Promise(async (resolve) => {
    let endpoint

    switch (type[1]) {
      case 'track':
        endpoint = `track/${type[2]}`
        break
      case 'playlist':
        endpoint = `playlist/${type[2]}`
        break
      case 'album':
        endpoint = `album/${type[2]}`
        break
      default:
        return resolve({ loadType: 'empty', data: {} })
    }

    utils.debugLog('loadtracks', 4, { type: 1, loadType: type[1], sourceName: 'Deezer', query })

    const data = await utils.makeRequest(`https://api.deezer.com/2.0/${endpoint}`, { method: 'GET' })

    if (data.error) {
      if (data.error.code == 800) 
        return resolve({ loadType: 'empty', data: {} })

      return resolve({ loadType: 'error', data: { message: data.error.message, severity: 'fault', cause: 'Unknown' } })
    }

    switch (type[1]) {
      case 'track': {
        const search = await searchWithDefault(`"${data.title} ${data.artist.name}"`)

        if (search.loadType != 'search')
          return resolve(search)

        const track = {
          identifier: search.data[0].info.identifier,
          isSeekable: true,
          author: data.artist.name,
          length: search.data[0].info.length,
          isStream: false,
          position: 0,
          title: data.title,
          uri: data.link,
          artworkUrl: data.album.cover_xl,
          isrc: data.isrc,
          sourceName: 'deezer'
        }

        utils.debugLog('loadtracks', 4, { type: 2, loadType: 'track', sourceName: 'Deezer', track, query })

        resolve({
          loadType: 'track',
          data: {
            encoded: utils.encodeTrack(track),
            info: track,
            pluginInfo: {}
          }
        })

        break
      }
      case 'album':
      case 'playlist': {
        const tracks = []
        let index = 0

        data.tracks.data.forEach(async (item) => {
          const search = await searchWithDefault(`"${item.title} ${item.artist.name}"`)

          if (search.loadType != 'search')
            return resolve(search)

          const track = {
            identifier: search.data[0].info.identifier,
            isSeekable: true,
            author: item.artist.name,
            length: search.data[0].info.length,
            isStream: false,
            position: index,
            title: item.title,
            uri: item.link,
            artworkUrl: type[1] == 'album' ? data.cover_xl : data.picture_xl,
            isrc: null,
            sourceName: 'deezer'
          }

          tracks.push({
            encoded: utils.encodeTrack(track),
            info: track,
            pluginInfo: {}
          })

          if (index == data.tracks.data.length - 1 || index == config.options.maxAlbumPlaylistLength - 1) {
            const new_tracks = []
            data.tracks.data.forEach((item2, index2) => {
              tracks.forEach((track2, index3) => {
                if (track2.info.title == item2.title && track2.info.author == item2.artist.name) {
                  track2.info.position = index2
                  new_tracks.push(track2)
                }

                utils.debugLog('loadtracks', 4, { type: 2, loadType: type[1], sourceName: 'Deezer', track, query })

                if ((index2 == data.tracks.data.length - 1) && (index3 == tracks.length - 1))
                  resolve({
                    loadType: type[1],
                    data: {
                      info: {
                        name: data.title,
                        selectedTrack: 0
                      },
                      pluginInfo: {},
                      tracks: new_tracks
                    }
                  })
              })
            })
          }

          index++
        })

        break
      }
    }
  })
}

export default loadFrom