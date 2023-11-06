import config from '../../config.js'
import utils from '../utils.js'
import searchWithDefault from './default.js'

let csrfToken = null
let authToken = null

async function setToken() {
  utils.debugLog('pandora', 5, { type: 1, message: 'Setting Pandora auth and CSRF token.' })

  const csfr = await utils.makeRequest('https://www.pandora.com', { method: 'GET', cookiesOnly: true })

  if (!csfr[1]) return utils.debugLog('pandora', 5, { type: 2, message: 'Failed to set CSRF token from Pandora.' })

  csrfToken = { raw: csfr[1], parsed: /csrftoken=([a-f0-9]{16});/.exec(csfr[1])[1] }

  const token = await utils.makeRequest('https://www.pandora.com/api/v1/auth/anonymousLogin', {
    headers: {
      'Cookie': csrfToken.raw,
      'Content-Type': 'application/json',
      'Accept': '*/*',
      'X-CsrfToken': csrfToken.parsed
    },
    method: 'POST'
  })

  if (token.errorCode == 0) return utils.debugLog('pandora', 5, { type: 2, message: 'Failed to set auth token from Pandora.' })

  authToken = token.authToken

  utils.debugLog('pandora', 5, { type: 1, message: 'Successfully set Pandora auth and CSRF token.' })
}

async function search(query) {
  return new Promise(async (resolve) => {
    utils.debugLog('search', 4, { type: 1, sourceName: 'Pandora', query })

    const body = {
      query,
      types: ['TR'],
      listener: null,
      start: 0,
      count: config.options.maxResultsLength,
      annotate: true,
      searchTime: 0,
      annotationRecipe: 'CLASS_OF_2019'
    }
   
    const data = await utils.makeRequest('https://www.pandora.com/api/v3/sod/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'Content-Length': JSON.stringify(body).length
      },
      body,
      disableBodyCompression: true
    })

    if (data.results.length == 0)
      return resolve({ loadType: 'empty', data: {} })

    const tracks = []
    let shouldStop = false

    const annotationKeys = Object.keys(data.annotations)

    if (annotationKeys.length > config.options.maxResultsLength)
      annotationKeys = annotationKeys.slice(0, config.options.maxResultsLength)

    annotationKeys.forEach(async (key, index) => {
      if (data.annotations[key].type == 'TR') {
        const search = await searchWithDefault(`${data.annotations[key].name} ${data.annotations[key].artistName}`)

        if (search.loadType == 'search') {
          const track = {
            identifier: search.data[0].info.identifier,
            isSeekable: true,
            author: data.annotations[key].artistName,
            length: search.data[0].info.length,
            isStream: false,
            position: index,
            title: data.annotations[key].name,
            uri: search.data[0].info.uri,
            artworkUrl: `https://content-images.p-cdn.com/${data.annotations[key].icon.artUrl}`,
            isrc: data.annotations[key].isrc,
            sourceName: 'pandora'
          }

          tracks.push({
            encoded: utils.encodeTrack(track),
            info: track,
            playlistInfo: {}
          })
        }
      }

      if (index == data.results.length - 1 || index == config.options.maxResultsLength - 1) {
        const new_tracks = []
        annotationKeys.forEach((key2, index2) => {
          tracks.forEach((track2, index3) => {
            if (shouldStop) return;

            if (track2.info.title == data.annotations[key2].name && track2.info.author == data.annotations[key2].artistName) {
              track2.info.position = index2
              new_tracks.push(track2)
            }

            if ((index2 == annotationKeys.length - 1) && (index3 == tracks.length - 1)) {
              utils.debugLog('search', 4, { type: 2, sourceName: 'Pandora', tracksLen: new_tracks.length, query })

              shouldStop = true

              resolve({
                loadType: 'search',
                data: new_tracks
              })
            }
          })
        })
      }
    })
  })
}

async function loadFrom(query) {
  return new Promise(async (resolve) => {
    utils.debugLog('loadtracks', 4, { type: 1, loadType: type[2], sourceName: 'Pandora', query })

    const type = /^(https:\/\/www\.pandora\.com\/)((playlist)|(station)|(podcast)|(artist))\/.+/.exec(query)

    if (!type)
      return resolve({ loadType: 'error', data: { message: 'Not a valid pandora URL.', severity: 'common', cause: 'Invalid URL' } })

    switch (type[2]) {
      case 'artist': {
        if (!csrfToken) return resolve({ loadType: 'error', data: { message: 'Pandora not avaible in current country.', severity: 'common', cause: 'Pandora avaibility' } })

        const data = await utils.makeRequest(query, { method: 'GET' })

        const body = JSON.parse(data.split('var storeData = ')[1].split('}}]};')[0] + '}}]}')

        if (/^https:\/\/www\.pandora\.com\/artist\/[^\/]+\/[^\/]+\/\w+\/[^\/]+$/.test(query)) {
          const item = body['v4/catalog/getDetails'][0].annotations[Object.keys(body['v4/catalog/getDetails'][0].annotations)[0]]
  
          const search = await searchWithDefault(`${item.name} ${item.artistName}`)
  
          if (search.loadType != 'search')
            return resolve(search)
  
          const track = {
            identifier: search.data[0].info.identifier,
            isSeekable: true,
            author: item.artistName,
            length: search.data[0].info.length,
            isStream: false,
            position: 0,
            title: item.name,
            uri: search.data[0].info.uri,
            artworkUrl: `https://content-images.p-cdn.com/${item.icon.artUrl}`,
            isrc: null,
            sourceName: 'pandora'
          }

          utils.debugLog('loadtracks', 4, { type: 2, loadType: type[2], sourceName: 'Pandora', track, query })
  
          return resolve({
            loadType: 'track',
            data: {
              encoded: utils.encodeTrack(track),
              info: track,
              playlistInfo: {}
            }
          })
        } else if (/^https:\/\/www\.pandora\.com\/artist\/[^\/]+\/[^\/]+\/\w+$/.test(query)) {
          const tracks = []
          let shouldStop = false

          const keys = Object.keys(body['v4/catalog/annotateObjects'][0]).filter((key) => key.indexOf('TR:') != -1)

          if (keys.length > config.options.maxAlbumPlaylistLength)
            keys = keys.slice(0, config.options.maxAlbumPlaylistLength)

          keys.forEach(async (key, index) => {
            const search = await searchWithDefault(`${body['v4/catalog/annotateObjects'][0][key].name} ${body['v4/catalog/annotateObjects'][0][key].artistName}`)
      
            if (search.loadType == 'search') {
              const track = {
                identifier: search.data[0].info.identifier,
                isSeekable: true,
                author: body['v4/catalog/annotateObjects'][0][key].artistName,
                length: search.data[0].info.length,
                isStream: false,
                position: 0,
                title: body['v4/catalog/annotateObjects'][0][key].name,
                uri: search.data[0].info.uri,
                artworkUrl: `https://content-images.p-cdn.com/${body['v4/catalog/annotateObjects'][0][key].icon.artUrl}`,
                isrc: body['v4/catalog/annotateObjects'][0][key].isrc,
                sourceName: 'pandora'
              }
        
              tracks.push({
                encoded: utils.encodeTrack(track),
                info: track,
                playlistInfo: {}
              })
            }
      
            if (index == keys.length - 1 || index == config.options.maxAlbumPlaylistLength - 1) {
              utils.debugLog('loadtracks', 4, { type: 2, loadType: 'album', sourceName: 'Pandora', tracksLen: tracks.length, query })

              const new_tracks = []
              keys.forEach((key2, index2) => {
                tracks.forEach((track2, index3) => {
                  if (shouldStop) return;

                  if (track2.info.title == body['v4/catalog/annotateObjects'][0][key2].name && track2.info.author == body['v4/catalog/annotateObjects'][0][key2].artistName) {
                    track2.info.position = index2
                    new_tracks.push(track2)
                  }
      
                  if ((index2 == keys.length - 1) && (index3 == tracks.length - 1)) {
                    utils.debugLog('loadtracks', 4, { type: 2, loadType: 'album', sourceName: 'Pandora', playlistName: data.name })

                    shouldStop = true

                    resolve({
                      loadType: 'album',
                      data: {
                        info: {
                          name: data.name,
                          selectedTrack: 0,
                        },
                        pluginInfo: {},
                        tracks: new_tracks,
                      }
                    })
                  }
                })
              })
            }
          })
        } else {
          const tracks = []
          let shouldStop = false

          const annotations = body['v4/catalog/getDetails'][0].annotations
          const keys = body['v4/catalog/getDetails'][0].artistDetails.topTracks

          if (keys.length > config.options.maxAlbumPlaylistLength)
            keys = keys.slice(0, config.options.maxAlbumPlaylistLength)

          keys.forEach(async (key, index) => {
            const search = await searchWithDefault(`${annotations[key].name} ${annotations[key].artistName}`)
      
            if (search.loadType == 'search') {
              const infoObj = {
                identifier: search.data[0].info.identifier,
                isSeekable: true,
                author: annotations[key].artistName,
                length: search.data[0].info.length,
                isStream: false,
                position: 0,
                title: annotations[key].name,
                uri: search.data[0].info.uri,
                artworkUrl: `https://content-images.p-cdn.com/${annotations[key].icon.artUrl}`,
                isrc: annotations[key].isrc,
                sourceName: 'pandora'
              }
        
              tracks.push({
                encoded: utils.encodeTrack(infoObj),
                info: infoObj,
                playlistInfo: {}
              })
            }
      
            if (index == keys.length - 1) {
              const new_tracks = []
              keys.forEach((key2, index2) => {
                tracks.forEach((track2, index3) => {
                  if (shouldStop) return;

                  if (track2.info.title == annotations[key2].name && track2.info.author == annotations[key2].artistName) {
                    track2.info.position = index2
                    new_tracks.push(track2)
                  }
      
                  if ((index2 == keys.length - 1) && (index3 == tracks.length - 1)) {
                    utils.debugLog('loadtracks', 4, { type: 2, loadType: 'playlist', sourceName: 'Pandora', playlistName: data.name })

                    shouldStop = true

                    resolve({
                      loadType: 'playlist',
                      data: {
                        info: {
                          name: data.name,
                          selectedTrack: 0,
                        },
                        pluginInfo: {},
                        tracks: new_tracks,
                      }
                    })
                  }
                })
              })
            }
          })
        }

        break
      }
      case 'playlist': {
        if (!csrfToken) return resolve({ loadType: 'error', data: { message: 'Pandora not avaible in current country.', severity: 'common', cause: 'Pandora avaibility' } })
        
        const playlistId = query.split('/playlist/')[1]

        const body = {
          request: {
            pandoraId: playlistId,
            playlistVersion: 0,
            offset: 0,
            limit: config.options.maxAlbumPlaylistLength,
            annotationLimit: config.options.maxAlbumPlaylistLength,
            allowedTypes: ['TR', 'AM'],
            bypassPrivacyRules: true
          }
        }

        const data = await utils.makeRequest('https://www.pandora.com/api/v7/playlists/getTracks', {
          method: 'POST',
          headers: {
            'Cookie': csrfToken.raw,
            'Content-Type': 'application/json',
            'Accept': '*/*',
            'Content-Length': JSON.stringify(body).length,
            'X-CsrfToken': csrfToken.parsed,
            'X-AuthToken': authToken
          },
          body,
          disableBodyCompression: true
        })
    
        const tracks = []
        let shouldStop = false

        const keys = Object.keys(data.annotations).filter((key) => key.indexOf('TR:') != -1)

        if (keys.length > config.options.maxAlbumPlaylistLength)
          keys = keys.slice(0, config.options.maxAlbumPlaylistLength)

        keys.forEach(async (key, index) => {
          const search = await searchWithDefault(`${data.annotations[key].name} ${data.annotations[key].artistName}`)
    
          if (search.loadType == 'search') {
            const infoObj = {
              identifier: search.data[0].info.identifier,
              isSeekable: data.annotations[key].visible,
              author: data.annotations[key].artistName,
              length: search.data[0].info.length,
              isStream: false,
              position: 0,
              title: data.annotations[key].name,
              uri: search.data[0].info.uri,
              artworkUrl: `https://content-images.p-cdn.com/${data.annotations[key].icon.artUrl}`,
              isrc: data.annotations[key].isrc,
              sourceName: 'pandora'
            }
      
            tracks.push({
              encoded: utils.encodeTrack(infoObj),
              info: infoObj,
              playlistInfo: {}
            })
          }
    
          if (index == keys.length - 1) {
            const new_tracks = []
            keys.forEach((key2, index2) => {
              tracks.forEach((track2, index3) => {
                if (shouldStop) return;

                if (track2.info.title == data.annotations[key2].name && track2.info.author == data.annotations[key2].artistName) {
                  track2.info.position = index2
                  new_tracks.push(track2)
                }
    
                if ((index2 == keys.length - 1) && (index3 == tracks.length - 1)) {
                  utils.debugLog('loadtracks', 4, { type: 2, loadType: 'playlist', sourceName: 'Pandora', playlistName: data.name })

                  shouldStop = true

                  resolve({
                    loadType: 'playlist',
                    data: {
                      info: {
                        name: data.name,
                        selectedTrack: 0,
                      },
                      pluginInfo: {},
                      tracks: new_tracks,
                    }
                  })
                }
              })
            })
          }
        })
      }

      break
    }
  })
}

export default {
  setToken,
  search,
  loadFrom
}